import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  IMAGERY_DEFAULTS,
  eligibleKeywords,
  keywordStats,
  listImagery,
  readImagery,
  rebuildImagery,
  scoreOf,
  writeImagery,
} from "../lib/imagery.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-imagery-test-"));
after(() => rm(ROOT, { recursive: true, force: true }));

function kw(term, keyness = 6) {
  return { term, keyness, levels: [2] };
}

function mem(uid, overrides = {}) {
  return {
    uid,
    keywords: [],
    hitCount: 0,
    immortal: false,
    date: "2026-11-22",
    ...overrides,
  };
}

function fakeRegistry(memories) {
  return { list: () => memories };
}

async function newHome(name) {
  const home = path.join(ROOT, name);
  await rm(home, { recursive: true, force: true });
  return home;
}

/* ------------------------------------------------------------------ */
/* 打分                                                                */
/* ------------------------------------------------------------------ */

test("keyness 取最大、hitSum 累加、immortalBonus 生效", () => {
  const registry = fakeRegistry([
    mem("i-1", { keywords: [kw("HDM", 6)], hitCount: 4, immortal: true }),
    mem("i-2", { keywords: [kw("HDM", 10)], hitCount: 3 }),
    mem("i-3", { keywords: [kw("HDM", 2)], hitCount: 2 }),
  ]);

  const [row] = keywordStats(registry);
  assert.equal(row.term, "HDM");
  assert.equal(row.keyness, 10);
  assert.equal(row.hitSum, 9);
  assert.equal(row.immortal, 1);
  assert.equal(row.memories, 3);
  assert.deepEqual(row.uids, ["i-1", "i-2", "i-3"]);
  // (9 + 3×1) × 1 × (0.5 + 10/10) = 18
  assert.equal(row.score, 18);
  assert.equal(scoreOf({ hitSum: 9, immortal: 1, keyness: 10 }), 18);
  assert.equal(scoreOf({ hitSum: 9, immortal: 1, keyness: 10 }, { threshold: 15 }).score, undefined);
});

test("keywordStats 按分数降序；eligibleKeywords 只留达标词", () => {
  const registry = fakeRegistry([
    mem("e-1", { keywords: [kw("HDM", 10)], hitCount: 10, immortal: true }),
    mem("e-2", { keywords: [kw("HDM", 10), kw("白屏", 8)], hitCount: 2 }),
    mem("e-3", { keywords: [kw("冷词", 3)], hitCount: 0 }),
  ]);
  const rows = keywordStats(registry);
  assert.deepEqual(rows.map((row) => row.term), ["HDM", "白屏", "冷词"]);
  // HDM：(12+3)×1.5=22.5；白屏：2×1.3=2.6；冷词：0
  assert.equal(rows[0].score, 22.5);
  assert.equal(rows[0].memories, 2);
  assert.deepEqual(eligibleKeywords(registry, { threshold: 15 }).map((row) => row.term), ["HDM"]);
});

test("单条记忆撑起的词不算达标：分数够也要求 ≥2 条记忆", async () => {
  const registry = fakeRegistry([
    mem("s-1", { keywords: [kw("孤词", 9)], hitCount: 10, immortal: true }),
    mem("s-2", { keywords: [kw("共词", 9)], hitCount: 10, immortal: true }),
    mem("s-3", { keywords: [kw("共词", 9)], hitCount: 0 }),
  ]);
  const rows = keywordStats(registry);
  const solo = rows.find((row) => row.term === "孤词");
  assert.ok(solo.score >= 15, "孤词分数本身够门槛");
  assert.equal(solo.memories, 1);
  assert.deepEqual(eligibleKeywords(registry, { threshold: 15 }).map((row) => row.term), ["共词"]);

  const home = await newHome("solo");
  await assert.rejects(
    writeImagery(home, registry, { term: "孤词", meaning: "只有一个记忆撑起" }),
    /只出现在 1 条记忆里，少于 2 条/,
  );
  await assert.rejects(stat(path.join(home, "Imagery")), /ENOENT/);
});

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

test("未达门槛拒绝写入，且不产生文件或索引", async () => {
  const home = await newHome("low");
  const registry = fakeRegistry([mem("l-1", { keywords: [kw("冷词", 3)], hitCount: 1 })]);
  await assert.rejects(
    writeImagery(home, registry, { term: "冷词", meaning: "不该写进去" }),
    /未达门槛 15/,
  );
  await assert.rejects(stat(path.join(home, "Imagery")), /ENOENT/);
});

test("达标写入：模板三段、经历与索引追加、释义不覆盖", async () => {
  const home = await newHome("write");
  const registry = fakeRegistry([
    mem("w-1", { keywords: [kw("HDM", 10)], hitCount: 10, immortal: true }),
    mem("w-2", { keywords: [kw("HDM", 10)], hitCount: 4 }),
  ]);

  const first = await writeImagery(home, registry, {
    term: "HDM",
    meaning: "第一版释义",
    uids: ["w-1"],
    note: "首次建条目",
  });
  assert.equal(first.created, true);
  assert.equal(first.score, 25.5); // (14 + 3×1) × (0.5 + 10/10)
  assert.match(first.file, /^Imagery\/.+\.md$/);

  const file = path.join(home, first.file);
  let text = await readFile(file, "utf8");
  assert.match(text, /^# 意象：HDM$/m);
  assert.match(text, /## 释义\n第一版释义/);
  assert.match(text, /- \d{4}-\d{2}-\d{2} w-1：首次建条目/);
  assert.match(text, /## 记忆索引\n- w-1/);
  assert.doesNotMatch(text, /（待写）|（暂无）/);

  const second = await writeImagery(home, registry, { term: "hdm", meaning: "第二版释义", uids: ["w-1", "w-2"] });
  assert.equal(second.created, false);
  assert.equal(second.file, first.file, "同一关键词复用同一个文件");
  text = await readFile(file, "utf8");
  assert.match(text, /第一版释义/);
  assert.match(text, /第二版释义/);
  assert.equal((text.match(/## 记忆索引/g) ?? []).length, 1);
  assert.equal((text.match(/- w-1/g) ?? []).length, 1, "同一 uid 不重复进索引");
  assert.match(text, /- w-2/);

  const listed = await listImagery(home);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].term, "HDM");
});

test("多条 uid 时备注逐条区分：notes 优先、缺省用事件名、单条才用共用 note", async () => {
  const home = await newHome("notes");
  const registry = fakeRegistry([
    mem("n-1", { keywords: [kw("意象", 10)], hitCount: 10, immortal: true, event: "第一条事件" }),
    mem("n-2", { keywords: [kw("意象", 10)], hitCount: 10, immortal: true, event: "第二条事件", date: "2026-11-01" }),
  ]);

  const res = await writeImagery(home, registry, {
    term: "意象",
    uids: ["n-1", "n-2"],
    note: "共用的一句",
    notes: { "n-1": "专属备注" },
  });
  const text = await readFile(path.join(home, res.file), "utf8");
  assert.match(text, /- \d{4}-\d{2}-\d{2} n-1：专属备注/);
  assert.match(text, /- 2026-11-01 n-2：第二条事件/, "日期取记忆自己的 date");
  assert.doesNotMatch(text, /共用的一句/, "多条时不共用同一句备注");

  const notes = text
    .split("\n")
    .filter((line) => line.startsWith("- ") && line.includes("："))
    .map((line) => line.split("：").slice(1).join("："));
  assert.equal(new Set(notes).size, notes.length, "经历备注不重复");
});

test("read 截断、list 按分数降序、未建条目报错", async () => {
  const home = await newHome("read");
  const registry = fakeRegistry([
    mem("r-1", { keywords: [kw("甲", 10)], hitCount: 10, immortal: true }),
    mem("r-2", { keywords: [kw("乙", 8)], hitCount: 10, immortal: true }),
    mem("r-3", { keywords: [kw("乙", 8)], hitCount: 0 }),
    mem("r-4", { keywords: [kw("甲", 10)], hitCount: 0 }),
  ]);
  await writeImagery(home, registry, { term: "乙", meaning: "乙的释义" });
  await writeImagery(home, registry, { term: "甲", meaning: "甲".repeat(400) });

  const listed = await listImagery(home);
  assert.deepEqual(listed.map((row) => row.term), ["甲", "乙"]);

  const read = await readImagery(home, "甲", 200);
  assert.equal(read.truncated, true);
  assert.equal(read.text.length, 200);

  await assert.rejects(readImagery(home, "不存在"), /没有「不存在」的意象条目/);
  await assert.rejects(readImagery(home, ""), /需要 term/);
});

test("索引可从 md 重建；目录不存在时返回 0", async () => {
  const home = await newHome("rebuild");
  const registry = fakeRegistry([
    mem("b-1", { keywords: [kw("HDM", 10)], hitCount: 10, immortal: true }),
    mem("b-2", { keywords: [kw("HDM", 10)], hitCount: 0 }),
  ]);
  await writeImagery(home, registry, { term: "HDM", meaning: "释义" });
  await rm(path.join(home, "index"), { recursive: true, force: true });

  assert.deepEqual(await listImagery(home), []);
  assert.equal(await rebuildImagery(home, registry), 1);
  const listed = await listImagery(home);
  assert.equal(listed[0].term, "HDM");
  assert.equal(listed[0].score, 19.5, "重建时按当前记忆重算分数");

  const empty = await newHome("rebuild-empty");
  assert.equal(await rebuildImagery(empty, registry), 0);
});

test("默认阈值 15 与默认权重", () => {
  assert.equal(IMAGERY_DEFAULTS.threshold, 15);
  assert.equal(IMAGERY_DEFAULTS.immortalBonus, 3);
  assert.equal(IMAGERY_DEFAULTS.keynessWeight, 0.5);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { relatedMemories } from "../lib/associations.js";
import { buildAutoRecall, buildPreStepDecision, buildVocab, REMEMBER_INSTRUCTION } from "../lib/injection.js";
import { resolveSnapshotLevel } from "../lib/memory.js";
import { normalizeKeywords, recall } from "../lib/recall.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-recall-test-"));
after(() => rm(ROOT, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function kw(term, level = 2, keyness = 6) {
  return { term, keyness, levels: [level] };
}

function mem(uid, overrides = {}) {
  return {
    uid,
    label: `2_mem_${uid}`,
    folder: path.join(ROOT, "mem", uid),
    defaultLevel: 2,
    snapshots: [2],
    date: "2026-11-07",
    seq: 1,
    keywords: [],
    people: [],
    sessionId: "sess-1",
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    hitCount: 0,
    lastHitAt: null,
    immortal: false,
    immortalReason: null,
    forget: { d2: null, d5: null },
    relatedUids: [],
    ...overrides,
  };
}

function fakeRegistry(memories = []) {
  const map = new Map(memories.map((memory) => [memory.uid, memory]));
  return {
    memories: map,
    bumpHitsCalls: 0,
    get: (uid) => map.get(uid),
    list: () => [...map.values()],
    // 新形状：lookup 只返回命中 uid 集合（档位不再由 lookup 决定）。
    lookup(terms) {
      const wanted = new Set(normalizeKeywords(terms));
      const hits = new Set();
      for (const memory of map.values()) {
        for (const keyword of memory.keywords ?? []) {
          const term = typeof keyword === "string" ? keyword : keyword.term;
          const normalized = normalizeKeywords([term])[0];
          if (normalized && wanted.has(normalized)) {
            hits.add(memory.uid);
            break;
          }
        }
      }
      return hits;
    },
    async bumpHits(entries, now) {
      this.bumpHitsCalls += 1;
      const counts = new Map();
      for (const item of entries) {
        const uid = typeof item === "string" ? item : item?.uid;
        const delta = typeof item === "string" ? 1 : Number(item?.delta ?? 1);
        const memory = map.get(uid);
        if (!memory) continue;
        memory.hitCount = Math.round(Math.min(10, (memory.hitCount ?? 0) + delta) * 100) / 100;
        memory.lastHitAt = now ?? NOW;
        counts.set(uid, memory.hitCount);
      }
      return counts;
    },
    async bumpHit(uid, now, delta = 1) {
      const memory = map.get(uid);
      if (!memory) return undefined;
      memory.hitCount = Math.round(Math.min(10, (memory.hitCount ?? 0) + delta) * 100) / 100;
      memory.lastHitAt = now ?? NOW;
      return memory;
    },
  };
}

function baseConfig({ recall = {}, association = {}, homeDir, ...rest } = {}) {
  return {
    homeDir: homeDir ?? path.join(ROOT, "home"),
    recall: { levelBias: 1, usageBoost: 1, recencyBoost: 2, pinnedBoost: 3, ...recall },
    association: {
      enabled: true,
      triggerCount: 3,
      minLevel: 1,
      maxItems: 3,
      maxChars: 1500,
      ...association,
    },
    ...rest,
  };
}

async function writeSnapshot(meta, level, body) {
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, `level${level}.txt`), body, "utf8");
}

/* ------------------------------------------------------------------ */
/* normalizeKeywords                                                    */
/* ------------------------------------------------------------------ */

test("normalizeKeywords：NFKC/小写/拆分/去首尾标点/去重/32 上限", () => {
  assert.deepEqual(normalizeKeywords(["  用户, 项目Ａ 、调试；报错\n修复  "]), [
    "用户",
    "项目a",
    "调试",
    "报错",
    "修复",
  ]);
  assert.deepEqual(normalizeKeywords(["“插件”", "#记忆#", "（重要）"]), ["插件", "记忆", "重要"]);
  assert.deepEqual(normalizeKeywords(["ＨＤＭ", "ＡＢＣ"]), ["hdm", "abc"]);
  assert.deepEqual(normalizeKeywords(["C++"]), ["c++"]);
  assert.deepEqual(normalizeKeywords(["a".repeat(40)]), ["a".repeat(32)]);
  assert.deepEqual(normalizeKeywords(["用户", "用户", "  ", "，,、;；"]), ["用户"]);
  assert.deepEqual(normalizeKeywords([]), []);
  assert.deepEqual(normalizeKeywords(null), []);
  assert.deepEqual(normalizeKeywords("插件，调试"), ["插件", "调试"]);
});

test("recall：本轮批量 bumpHits 只调用一次（N 行不落 N 次盘）", async () => {
  const a = mem("p-a", { keywords: [kw("庚")] });
  const b = mem("p-b", { keywords: [kw("庚")], date: "2026-11-06" });
  const registry = fakeRegistry([a, b]);
  const result = await recall({ registry, config: baseConfig(), keywords: ["庚"], now: NOW, topK: 5 });

  assert.equal(result.matches.length, 2);
  assert.equal(registry.bumpHitsCalls, 1, "两行命中只应批量 bump 一次");
  assert.deepEqual(
    result.matches.map((row) => row.hitCount),
    [1.2, 1.2],
  );
  assert.equal(registry.get("p-a").hitCount, 1.2);
  assert.equal(registry.get("p-b").hitCount, 1.2);
});

test("recall：registry 没有 bumpHits 时逐条 bumpHit 回退", async () => {
  const { bumpHits, ...legacy } = fakeRegistry([mem("l-a", { keywords: [kw("辛")] })]);
  assert.equal(typeof bumpHits, "function");
  const result = await recall({ registry: legacy, config: baseConfig(), keywords: ["辛"], now: NOW });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].hitCount, 1.2);
  assert.equal(legacy.get("l-a").hitCount, 1.2);
});

test("recall：hitCount 按 Σ(命中词 keyness)×0.2 加权，不是固定 +1", async () => {
  const a = mem("w-a", { keywords: [kw("甲", 2, 5), kw("乙", 2, 6), kw("丙", 2, 9)] });
  const registry = fakeRegistry([a]);
  const result = await recall({ registry, config: baseConfig(), keywords: ["甲", "乙"], now: NOW });
  // 命中 5 + 6 = 11 → 11 × 0.2 = 2.2；同记忆只累加一次，不按命中词个数各加一遍。
  assert.equal(result.matches[0].hitCount, 2.2);
  assert.equal(registry.get("w-a").hitCount, 2.2);
});

test("recall：命中人物关键词时附人物档案摘录（USER 优先）", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hdm-recall-home-"));
  await mkdir(path.join(home, "characters"), { recursive: true });
  await writeFile(
    path.join(home, "characters", "USER.md"),
    "# USER 档案\n\n## 基本\n用户是单人协作伙伴。偏好简洁。\n",
    "utf8",
  );
  const registry = fakeRegistry([mem("c-a", { keywords: [kw("用户")], people: ["用户"] })]);
  const result = await recall({
    registry,
    home,
    config: baseConfig({ homeDir: home }),
    keywords: ["用户"],
    now: NOW,
  });
  const row = result.matches[0];
  assert.equal(row.characters.length, 1);
  assert.equal(row.characters[0].name, "USER");
  assert.match(row.characters[0].excerpt, /单人协作伙伴/);
});

test("REMEMBER_INSTRUCTION：要求同轮更新 IAM 与人物档案", () => {
  assert.match(REMEMBER_INSTRUCTION, /hdm_iam_update/);
  assert.match(REMEMBER_INSTRUCTION, /hdm_character_update/);
});

test("buildAutoRecall：命中人物的注入行附「人物：USER」摘录", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hdm-recall-ar-"));
  await mkdir(path.join(home, "characters"), { recursive: true });
  await writeFile(
    path.join(home, "characters", "USER.md"),
    "# USER 档案\n\n## 基本\n用户是单人协作伙伴。偏好简洁。\n",
    "utf8",
  );
  const memory = mem("ar-a", { keywords: [kw("用户")], people: ["用户"] });
  await writeSnapshot(memory, 2, "## 摘要\n用户在改 HDM 注入。\n\n## 细节\n- 一条。\n");
  const registry = fakeRegistry([memory]);
  const state = {
    sessions: {},
    getSession(id) {
      return (this.sessions[id] ??= { recalledUids: [] });
    },
    async updateSession(id, patch) {
      this.sessions[id] = { ...this.getSession(id), ...patch };
    },
  };
  const text = await buildAutoRecall({
    home,
    config: { autoRecall: { enabled: true, topK: 2, minScore: 1, maxChars: 600 }, characters: { snippetChars: 200 } },
    registry,
    state,
    sessionId: "s-ar",
    text: "用户那边还有什么",
  });
  assert.match(text, /可能相关的记忆/);
  assert.match(text, /人物：USER（.*单人协作伙伴/);
});

test("resolveSnapshotLevel：距离最近、同距取高、fallback 标记", () => {
  // 每项：[snapshots, requested, 期望 level, 期望 fallback]
  const cases = [
    [[2], 2, 2, false],
    [[2], 1, 2, true],
    [[2], 0, 2, true],
    [[1, 2], 0, 1, true],
    [[1, 2], 1, 1, false],
    [[1, 2], 2, 2, false],
    [[0, 1, 2], 1, 1, false],
    [[0, 1, 2], 0, 0, false],
    [[0], 2, 0, true],
    [[0], 1, 0, true],
    [[0, 2], 1, 2, true], // 同距取高
    [[0, 2], 2, 2, false],
  ];
  for (const [snapshots, requested, level, fallback] of cases) {
    const resolved = resolveSnapshotLevel({ uid: "u-test", snapshots, defaultLevel: 2 }, requested);
    assert.deepEqual(
      resolved,
      { level, fallback },
      `snapshots=${JSON.stringify(snapshots)} requested=${requested}`,
    );
  }
});

test("resolveSnapshotLevel：auto/undefined 用 defaultLevel；非法等级与空快照抛错", () => {
  const meta = { uid: "u-auto", snapshots: [0, 1, 2], defaultLevel: 0 };
  assert.deepEqual(resolveSnapshotLevel(meta, "auto"), { level: 0, fallback: false });
  assert.deepEqual(resolveSnapshotLevel(meta), { level: 0, fallback: false });
  assert.deepEqual(resolveSnapshotLevel(meta, null), { level: 0, fallback: false });

  assert.throws(() => resolveSnapshotLevel(meta, "x"), /非法快照等级/);
  assert.throws(() => resolveSnapshotLevel(meta, 1.5), /非法快照等级/);
  assert.throws(() => resolveSnapshotLevel({ uid: "u-empty", snapshots: [], defaultLevel: 2 }), /没有可用快照/);
  assert.throws(() => resolveSnapshotLevel(null, 1), /readSnapshot 需要 meta/);
});

/* ------------------------------------------------------------------ */
/* recall 基础                                                         */
/* ------------------------------------------------------------------ */

test("recall：候选、权重、排序、topK、views/higherLevels、bumpHit", async () => {
  const a = mem("r-a", { keywords: [kw("用户")], date: "2026-11-07", updatedAt: NOW });
  const b = mem("r-b", {
    keywords: [kw("用户"), kw("调试")],
    date: "2026-11-06",
    defaultLevel: 1,
    snapshots: [2, 1],
    updatedAt: NOW - 2 * DAY,
  });
  const registry = fakeRegistry([a, b]);
  const result = await recall({ registry, config: baseConfig(), keywords: ["用户"], now: NOW, topK: 2 });

  assert.equal(result.viewFallback, false);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.associations, []);
  assert.equal(result.associationTruncated, false);

  const [first, second] = result.matches;
  assert.equal(first.uid, "r-a");
  assert.equal(first.weight, 3); // matched 1 + level 2 * levelBias 1
  assert.equal(first.level, 2);
  assert.equal(first.defaultLevel, 2);
  assert.equal(first.path, `${a.folder}/level2.txt`);
  assert.deepEqual(first.views, { 2: `${a.folder}/level2.txt` });
  assert.deepEqual(first.higherLevels, []);
  assert.deepEqual(first.matchedKeywords, ["用户"]);
  assert.equal(first.hitCount, 1.2); // bump 后（keyness 6 × 0.2）
  assert.equal(first.immortal, false);

  assert.equal(second.uid, "r-b");
  assert.equal(second.weight, 2); // matched 1 + level 1
  assert.equal(second.level, 1);
  assert.deepEqual(second.higherLevels, [{ level: 2, path: `${b.folder}/level2.txt` }]);
  assert.deepEqual(second.views, { 1: `${b.folder}/level1.txt`, 2: `${b.folder}/level2.txt` });
  assert.deepEqual(second.matchedKeywords, ["用户"]);

  assert.equal(registry.get("r-a").hitCount, 1.2);
  assert.equal(registry.get("r-b").hitCount, 1.2);
});

test("recall：view=auto 用 defaultLevel；显式档缺失回退并标记 viewFallback", async () => {
  const fresh = mem("v-fresh", { keywords: [kw("甲")], snapshots: [2], defaultLevel: 2 });
  const aged = mem("v-aged", {
    keywords: [kw("甲")],
    snapshots: [2, 1, 0],
    defaultLevel: 0,
    date: "2026-10-01",
    label: "0_2026-10-01_001_甲",
  });
  const registry = fakeRegistry([fresh, aged]);
  const config = baseConfig();
  const byUid = (result, uid) => result.matches.find((row) => row.uid === uid);

  let result = await recall({ registry, config, keywords: ["甲"], now: NOW, topK: 5 });
  assert.equal(byUid(result, "v-fresh").level, 2);
  assert.equal(byUid(result, "v-aged").level, 0);
  assert.equal(result.viewFallback, false);

  result = await recall({ registry, config, keywords: ["甲"], view: 1, now: NOW, topK: 5 });
  assert.equal(byUid(result, "v-fresh").level, 2); // [2] 没有 1 → 回退到 2
  assert.equal(byUid(result, "v-aged").level, 1);
  assert.equal(result.viewFallback, true);

  result = await recall({ registry, config, keywords: ["甲"], view: 2, now: NOW, topK: 5 });
  assert.equal(byUid(result, "v-aged").level, 2);
  assert.equal(result.viewFallback, false);

  result = await recall({ registry, config, keywords: ["甲"], view: 0, now: NOW, topK: 5 });
  assert.equal(byUid(result, "v-aged").level, 0);
  assert.equal(byUid(result, "v-fresh").level, 2); // 回退
  assert.equal(result.viewFallback, true);
});

test("recall：boost none/usage/recency/pinned", async () => {
  async function run(boost, overrides = {}) {
    const memory = mem("b-main", { keywords: [kw("乙")], updatedAt: NOW, ...overrides });
    const registry = fakeRegistry([memory]);
    const result = await recall({ registry, config: baseConfig(), keywords: ["乙"], boost, now: NOW });
    return result.matches[0];
  }

  assert.equal((await run("none")).weight, 3); // 1 + 2
  assert.equal((await run("usage", { hitCount: 2 })).weight, 5); // + 2 * usageBoost
  assert.equal((await run("pinned", { immortal: true })).weight, 6); // + pinnedBoost 3
  assert.equal((await run("recency", { updatedAt: NOW - 15 * DAY })).weight, 4); // + 2 * 0.5
  assert.equal((await run("recency", { updatedAt: NOW - 40 * DAY })).weight, 3); // 加成 0
  assert.equal((await run("unknown-mode")).weight, 3); // 未知 boost → none
});

test("recall：同权重按 level 升序、日期降序、uid 升序", async () => {
  const memories = [
    mem("s-a", {
      keywords: [kw("丙"), kw("丁")],
      defaultLevel: 1,
      snapshots: [2, 1],
      date: "2026-10-01",
    }), // matched 2（丙、丁）+ level 1 = 3
    mem("s-b", { keywords: [kw("丙")], date: "2026-11-07" }), // matched 1 + level 2 = 3
    mem("s-c", { keywords: [kw("丙")], date: "2026-11-05" }),
    mem("s-d", { keywords: [kw("丙")], date: "2026-11-05" }),
  ];
  const result = await recall({
    registry: fakeRegistry(memories),
    config: baseConfig(),
    keywords: ["丙", "丁"],
    now: NOW,
    topK: 10,
  });
  assert.deepEqual(
    result.matches.map((row) => row.uid),
    ["s-a", "s-b", "s-c", "s-d"],
  );
});

test("recall：sameDayOf 返回同日/同事件记忆（含所有快照视图）", async () => {
  const target = mem("d-target", { keywords: [kw("戊")], date: "2026-11-07", eventKey: "evt-1" });
  const sameDay = mem("d-day", { date: "2026-11-07" });
  const sameEvent = mem("d-event", { date: "2026-11-07", eventKey: "evt-1" });
  const otherEvent = mem("d-other-event", { date: "2026-11-07", eventKey: "evt-2" });
  const otherDay = mem("d-other-day", { date: "2026-11-06" });
  const registry = fakeRegistry([target, sameDay, sameEvent, otherEvent, otherDay]);

  const result = await recall({
    registry,
    config: baseConfig(),
    keywords: ["戊"],
    sameDayOf: "d-target",
    now: NOW,
    topK: 1,
  });

  const uids = result.matches.map((row) => row.uid);
  assert.equal(uids[0], "d-target");
  assert.ok(uids.includes("d-day"));
  assert.ok(uids.includes("d-event"));
  assert.ok(!uids.includes("d-other-event"));
  assert.ok(!uids.includes("d-other-day"));
  assert.deepEqual(result.sameDay.map((row) => row.uid).sort(), ["d-day", "d-event", "d-target"]);
  assert.equal(result.matches.length, 3); // 同日项不受 topK=1 限制
});

test("recall：无命中返回空结构", async () => {
  const result = await recall({
    registry: fakeRegistry([mem("n-a", { keywords: [kw("己")] })]),
    config: baseConfig(),
    keywords: ["不存在"],
    now: NOW,
  });
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.associations, []);
  assert.equal(result.associationTruncated, false);
  assert.equal(result.viewFallback, false);
  assert.deepEqual(result.sameDay, []);
});

/* ------------------------------------------------------------------ */
/* 联想                                                                 */
/* ------------------------------------------------------------------ */

async function associationWorld(prefix) {
  const home = path.join(ROOT, `home-${prefix}`);
  await mkdir(path.join(home, "diary"), { recursive: true });
  await writeFile(path.join(home, "diary", "2026-11-07.txt"), "2026-11-07 的日记", "utf8");

  const main = mem(`${prefix}-main`, {
    date: "2026-11-07",
    keywords: [kw("用户"), kw("项目A"), kw("调试")],
    people: ["用户", "小林"],
    relatedUids: [`${prefix}-related`],
    hitCount: 3,
    eventKey: "evt-1",
  });
  const related = mem(`${prefix}-related`, { date: "2026-11-05", defaultLevel: 1, snapshots: [2, 1] });
  const person = mem(`${prefix}-person`, { date: "2026-11-04", people: ["小林"] });
  const sameDay = mem(`${prefix}-same-day`, {
    date: "2026-11-07",
    defaultLevel: 1,
    snapshots: [2, 1],
  });
  const keyword = mem(`${prefix}-keyword`, {
    date: "2026-11-03",
    keywords: [kw("项目A"), kw("调试"), kw("用户")],
    defaultLevel: 1,
    snapshots: [2, 1],
  });
  const queryOnly = mem(`${prefix}-query-only`, { date: "2026-11-02", keywords: [kw("用户")] });
  const unrelated = mem(`${prefix}-unrelated`, { date: "2026-11-01" });

  const registry = fakeRegistry([main, related, person, sameDay, keyword, queryOnly, unrelated]);
  await writeSnapshot(related, 1, "## 摘要\n关联的旧记忆");
  await writeSnapshot(person, 2, "## 摘要\n人物相关记忆");
  await writeSnapshot(sameDay, 1, "## 摘要\n同日记忆");
  await writeSnapshot(keyword, 1, "## 摘要\n关键词重叠");
  await writeSnapshot(queryOnly, 2, "## 摘要\n只有查询词");
  await writeSnapshot(unrelated, 2, "## 摘要\n无关记忆");

  return { main, related, person, sameDay, keyword, home, registry };
}

test("联想：hitCount 超阈值触发（原因/排序/去重/预算）", async () => {
  const world = await associationWorld("a1");
  const result = await recall({
    registry: world.registry,
    config: baseConfig({ homeDir: world.home, association: { maxItems: 5 } }),
    keywords: ["用户"],
    now: NOW,
    topK: 1,
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].uid, "a1-main");
  assert.equal(result.matches[0].hitCount, 4.2); // 3 → 加权 bump 4.2 > triggerCount 3
  assert.equal(result.associationTruncated, false);

  const uids = result.associations.map((item) => item.uid);
  assert.deepEqual(uids, ["a1-related", "a1-keyword", "a1-same-day", "a1-person"]);

  const byUid = (uid) => result.associations.find((item) => item.uid === uid);
  const sameDay = byUid("a1-same-day");
  assert.match(sameDay.reason, /同日：2026-11-07/);
  assert.doesNotMatch(sameDay.reason, /同日日记/); // 同日日记 +1 已删除（最弱、最噪的一条）
  assert.doesNotMatch(sameDay.reason, /时间衰减/); // 1 天内的记忆不写衰减说明
  assert.equal(sameDay.level, 1);
  assert.equal(sameDay.path, `${world.sameDay.folder}/level1.txt`);
  assert.equal(sameDay.gist, "同日记忆");
  assert.equal(sameDay.chars, "同日记忆".length);

  const related = byUid("a1-related");
  assert.match(related.reason, /关联记忆/);
  assert.equal(related.gist, "关联的旧记忆");

  const person = byUid("a1-person");
  assert.match(person.reason, /共同人物：小林/);
  assert.equal(person.level, 2);
  assert.equal(person.chars, "人物相关记忆".length);

  const keyword = byUid("a1-keyword");
  assert.match(keyword.reason, /共同关键词/);
  assert.match(keyword.reason, /项目a/);
  assert.match(keyword.reason, /调试/);
  assert.doesNotMatch(keyword.reason, /用户/); // 查询词不算“非查询关键词”

  // 只共享查询词 / 无任何关系的记忆不进入联想
  assert.ok(!uids.includes("a1-query-only"));
  assert.ok(!uids.includes("a1-unrelated"));
});

test("联想：未超 triggerCount 不触发；includeAssociations/enabled 可关闭", async () => {
  const world = await associationWorld("a2");

  world.main.hitCount = 1; // 加权 bump 1.2 → 2.2，不超过 3
  let result = await recall({
    registry: world.registry,
    config: baseConfig({ homeDir: world.home }),
    keywords: ["用户"],
    now: NOW,
    topK: 1,
  });
  assert.equal(result.matches[0].hitCount, 2.2);
  assert.deepEqual(result.associations, []);
  assert.equal(result.associationTruncated, false);

  world.main.hitCount = 5; // 触发，但 includeAssociations=false
  result = await recall({
    registry: world.registry,
    config: baseConfig({ homeDir: world.home }),
    keywords: ["用户"],
    now: NOW,
    topK: 1,
    includeAssociations: false,
  });
  assert.deepEqual(result.associations, []);

  world.main.hitCount = 5; // 触发，但 association.enabled=false
  result = await recall({
    registry: world.registry,
    config: baseConfig({ homeDir: world.home, association: { enabled: false } }),
    keywords: ["用户"],
    now: NOW,
    topK: 1,
  });
  assert.deepEqual(result.associations, []);
});

test("联想：maxItems 截断并标记 truncated", async () => {
  const world = await associationWorld("a3");
  const result = await recall({
    registry: world.registry,
    config: baseConfig({ homeDir: world.home, association: { maxItems: 2 } }),
    keywords: ["用户"],
    now: NOW,
    topK: 1,
  });
  assert.equal(result.associations.length, 2);
  assert.deepEqual(
    result.associations.map((item) => item.uid),
    ["a3-related", "a3-keyword"],
  );
  assert.equal(result.associationTruncated, true);
});

test("联想：摘要总字数超预算时只给路径并 truncated", async () => {
  const main = mem("budget-main", {
    keywords: [kw("用户")],
    relatedUids: ["budget-one", "budget-two"],
    hitCount: 5,
  });
  const one = mem("budget-one", { date: "2026-11-05", defaultLevel: 1, snapshots: [2, 1] });
  const two = mem("budget-two", { date: "2026-11-04", defaultLevel: 1, snapshots: [2, 1] });
  const registry = fakeRegistry([main, one, two]);
  await writeSnapshot(one, 1, `## 摘要\n${"x".repeat(10)}`);
  await writeSnapshot(two, 1, `## 摘要\n${"y".repeat(10)}`);

  const result = await relatedMemories({
    registry,
    config: baseConfig({ association: { maxChars: 12, maxItems: 5 } }),
    rows: [{ uid: "budget-main", hitCount: 6 }],
    now: NOW,
    queryTerms: ["用户"],
  });

  assert.equal(result.associations.length, 2);
  assert.equal(result.associations[0].uid, "budget-one");
  assert.equal(result.associations[0].gist, "x".repeat(10));
  assert.equal(result.associations[0].chars, 10);
  assert.equal(result.associations[1].uid, "budget-two");
  assert.equal(result.associations[1].gist, "");
  assert.equal(result.associations[1].chars, 0);
  assert.match(result.associations[1].reason, /关联记忆/);
  assert.equal(result.truncated, true);
});

test("联想：只取 level ≥ minLevel 的快照", async () => {
  const main = mem("level-main", { keywords: [kw("用户")], relatedUids: ["level-old"], hitCount: 5 });
  const old = mem("level-old", {
    date: "2026-11-05",
    defaultLevel: 0,
    snapshots: [0],
    label: "0_mem_level-old",
  });
  const registry = fakeRegistry([main, old]);
  await writeSnapshot(old, 0, "## 摘要\n只剩 gist 的旧记忆");

  let result = await relatedMemories({
    registry,
    config: baseConfig({ association: { minLevel: 1 } }),
    rows: [{ uid: "level-main", hitCount: 6 }],
    now: NOW,
    queryTerms: ["用户"],
  });
  assert.deepEqual(result.associations, []);

  result = await relatedMemories({
    registry,
    config: baseConfig({ association: { minLevel: 0 } }),
    rows: [{ uid: "level-main", hitCount: 6 }],
    now: NOW,
    queryTerms: ["用户"],
  });
  assert.equal(result.associations.length, 1);
  assert.equal(result.associations[0].level, 0);
  assert.equal(result.associations[0].path, `${old.folder}/level0.txt`);
});

test("联想：按 uid 去重、双向 relatedUids 只计一次", async () => {
  const mainA = mem("dedupe-main-a", { keywords: [kw("用户")], hitCount: 5 });
  const mainB = mem("dedupe-main-b", { keywords: [kw("用户")], hitCount: 5, date: "2026-11-06" });
  const candidate = mem("dedupe-cand", {
    date: "2026-11-05",
    defaultLevel: 1,
    snapshots: [2, 1],
    relatedUids: ["dedupe-main-a", "dedupe-main-b"],
  });
  mainA.relatedUids = ["dedupe-cand"];
  const registry = fakeRegistry([mainA, mainB, candidate]);
  await writeSnapshot(candidate, 1, "## 摘要\n双向关联");

  const result = await relatedMemories({
    registry,
    config: baseConfig(),
    rows: [
      { uid: "dedupe-main-a", hitCount: 6 },
      { uid: "dedupe-main-b", hitCount: 6 },
    ],
    now: NOW,
    queryTerms: ["用户"],
  });
  assert.equal(result.associations.length, 1);
  assert.equal(result.associations[0].uid, "dedupe-cand");
  assert.equal((result.associations[0].reason.match(/关联记忆/g) ?? []).length, 1);
  assert.equal(result.truncated, false);
});

/* ------------------------------------------------------------------ */
/* 召回噪音治理：时间衰减 / 泛词 / 词表新近加权 / stale 提醒            */
/* ------------------------------------------------------------------ */

test("联想：时间衰减——60 天前的旧记忆排在 1 天前之后", async () => {
  const main = mem("t-main", { keywords: [kw("用户")], hitCount: 5 });
  const fresh = mem("t-fresh", {
    date: "2026-11-06",
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    defaultLevel: 1,
    snapshots: [2, 1],
    relatedUids: ["t-main"],
  });
  const old = mem("t-old", {
    date: "2026-09-08",
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 60 * DAY,
    defaultLevel: 1,
    snapshots: [2, 1],
    relatedUids: ["t-main"],
  });
  const registry = fakeRegistry([main, fresh, old]);
  await writeSnapshot(fresh, 1, "## 摘要\n一天前的记忆");
  await writeSnapshot(old, 1, "## 摘要\n六十天前的记忆");

  const result = await relatedMemories({
    registry,
    config: baseConfig({ association: { maxItems: 5 } }),
    rows: [{ uid: "t-main", hitCount: 6 }],
    now: NOW,
    queryTerms: ["用户"],
  });

  // 两条都是「关联记忆 +3」，唯一差别是时间：旧记忆衰减到 0.2 后被压到后面。
  assert.deepEqual(
    result.associations.map((item) => item.uid),
    ["t-fresh", "t-old"],
  );
  const freshItem = result.associations[0];
  assert.match(freshItem.reason, /关联记忆/);
  assert.doesNotMatch(freshItem.reason, /时间衰减/); // 1 天衰减 0.97 ≥ 0.9，不写说明
  assert.equal(freshItem.gist, "一天前的记忆");
  assert.equal(freshItem.chars, "一天前的记忆".length);

  const oldItem = result.associations[1];
  assert.match(oldItem.reason, /关联记忆/);
  assert.match(oldItem.reason, /时间衰减：×0\.2（60 天前）/);
  assert.equal(oldItem.gist, "六十天前的记忆");
  assert.equal(oldItem.chars, "六十天前的记忆".length);
});

test("联想：领域泛词只进 reason 不加分", async () => {
  const main = mem("g-main", { keywords: [kw("用户"), kw("HDM"), kw("白屏")], hitCount: 5 });
  const genericOnly = mem("g-generic", {
    date: "2026-11-06",
    keywords: [kw("HDM")],
    defaultLevel: 1,
    snapshots: [2, 1],
  });
  const rareOnly = mem("g-rare", {
    date: "2026-11-05",
    keywords: [kw("白屏")],
    defaultLevel: 1,
    snapshots: [2, 1],
  });
  // 把库撑到 9 条：HDM 出现在 8/9 的记忆里（> 30% → 泛词），白屏只在 2/9（不是泛词）。
  const fillers = Array.from({ length: 6 }, (_, i) =>
    mem(`g-filler-${i}`, { date: "2026-10-30", keywords: [kw("HDM")] }),
  );
  const registry = fakeRegistry([main, genericOnly, rareOnly, ...fillers]);
  await writeSnapshot(genericOnly, 1, "## 摘要\n只有泛词");
  await writeSnapshot(rareOnly, 1, "## 摘要\n稀有词重叠");

  const result = await relatedMemories({
    registry,
    config: baseConfig({ association: { maxItems: 5 } }),
    rows: [{ uid: "g-main", hitCount: 6 }],
    now: NOW,
    queryTerms: ["用户"],
  });

  // 只有泛词的那条：reason 里仍能看到 HDM，但不加分 → score=0，根本不进联想。
  const uids = result.associations.map((item) => item.uid);
  assert.deepEqual(uids, ["g-rare"]);
  assert.ok(!uids.includes("g-generic"));
  assert.match(result.associations[0].reason, /共同关键词：白屏/);
  assert.equal(result.associations[0].gist, "稀有词重叠");
});

test("词表：新近加权让今天的词排到老记忆的高分词之前，泛词被过滤", () => {
  const oldHigh = mem("v-old", {
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 60 * DAY,
    keywords: [kw("旧主题", 2, 10), kw("HDM")],
  });
  const fresh = mem("v-fresh", {
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    keywords: [kw("提示词改造", 2, 6)],
  });
  const fillers = Array.from({ length: 6 }, (_, i) => mem(`v-filler-${i}`, { keywords: [kw("HDM")] }));
  const registry = fakeRegistry([oldHigh, fresh, ...fillers]);

  const terms = buildVocab(registry, 400, NOW).split("、");
  // 老记忆 keyness 10 但衰减到 0.25（2.75 分）；今天的词 keyness 6、衰减 0.97（6.77 分）。
  assert.equal(terms[0], "提示词改造");
  assert.ok(terms.includes("旧主题"));
  // HDM 出现在 7/8 的记忆里（> 30%），不进词表候选。
  assert.ok(!terms.includes("HDM"));
});

function preStepConfig() {
  return {
    homeDir: path.join(ROOT, "nudge-home"),
    timeZone: "Asia/Shanghai",
    save: { threshold: 0.5, step: 0.15, maxPerSession: 4 },
    nudge: { enabled: true, everyUserTurns: 6, maxPerSession: 2, staleMinutes: 45 },
    autoRecall: { enabled: false, level: 0, vocabChars: 0 },
    iam: { inject: false, anchorEveryTurns: 6 },
    handoff: { enabled: false },
  };
}

/** 最小会话状态替身：buildPreStepDecision 只读写这几个字段。 */
function fakeNudgeState(seed) {
  const session = { iamInjected: true, pendingContextReinject: false, ...seed };
  return {
    getSession: () => session,
    updateSession: async (_id, patch) => Object.assign(session, patch),
  };
}

async function runNudgeStep(seed) {
  const text = "继续把插件收尾";
  const agent = { session: { id: "nudge-session", header: { id: "nudge-session", origin: "user" } } };
  const decision = {
    kind: "enter",
    messages: [{ id: "u-1", role: "user", content: [{ type: "text", text }], source: { kind: "user" } }],
  };
  const result = await buildPreStepDecision({
    ctx: {},
    home: path.join(ROOT, "nudge-home"),
    config: preStepConfig(),
    registry: fakeRegistry([]),
    state: fakeNudgeState(seed),
    agent,
    decision,
    now: NOW,
    step: 1,
    turn: 1,
  });
  return result.messages
    .filter((m) => m.source?.kind === "plugin:hdm")
    .flatMap((m) => m.content.map((b) => b.text))
    .join("\n");
}

test("保存提醒：距上次保存 60 分钟且已积累 3 个回合触发；刚存过不触发", async () => {
  const stale = await runNudgeStep({ lastMemoryToolAt: NOW - 60 * 60000, userTurnsSinceMemory: 3 });
  assert.match(stale, /已持续多轮且尚未保存/);
  assert.match(stale, /hdm_save/);
  assert.match(stale, /hdm_iam_update/); // 两轮调研都指出这两个工具从没被调用过
  assert.match(stale, /hdm_character_update/);

  const fresh = await runNudgeStep({ lastMemoryToolAt: NOW - 2 * 60000, userTurnsSinceMemory: 3 });
  assert.doesNotMatch(fresh, /已持续多轮且尚未保存/);
});

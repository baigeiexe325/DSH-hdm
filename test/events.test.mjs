// 事件索引单元测试：lib/events.js（slug / 追加 / 幂等 / 分档 / 读取 / 重建）。
// 运行：node --test test/events.test.mjs
// 全部使用 os.tmpdir() 下的临时 home，绝不触碰真实 ~/dsh-HDM。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  EVENT_DEFAULTS,
  appendEventLine,
  eventFileName,
  eventsForUid,
  eventsIndexFile,
  listEvents,
  loadEventIndex,
  readEvent,
  rebuildEvents,
  eventSlug,
} from "../lib/events.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-events-test-"));
after(() => rm(ROOT, { recursive: true, force: true }));

let seq = 0;
async function makeHome() {
  seq += 1;
  return mkdtemp(path.join(ROOT, `home-${seq}-`));
}

async function readIndex(home) {
  return JSON.parse(await readFile(eventsIndexFile(home), "utf8"));
}

function fakeRegistry(memories) {
  return { list: () => memories };
}

/* ------------------------------------------------------------------ */
/* 1. slug / 文件名                                                     */
/* ------------------------------------------------------------------ */

test("eventSlug：大小写、首尾空白、非法字符、下划线、中文、空值", () => {
  assert.equal(eventSlug("维护 HDM 插件"), "维护-hdm-插件");
  assert.equal(eventSlug("  维护 HDM 插件  "), "维护-hdm-插件");
  assert.equal(eventSlug("HDM_Vocab"), "hdm-vocab");
  assert.equal(eventSlug("a/b:c*d?e\"f<g>h|i\\j"), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(eventSlug("多   个\t空白"), "多-个-空白");
  assert.equal(eventSlug("中文事件"), "中文事件");
  assert.equal(eventSlug(""), "");
  assert.equal(eventSlug("   "), "");
  assert.equal(eventSlug(null), "");
  assert.equal(eventSlug(undefined), "");
  assert.ok(!eventSlug("下_划_线").includes("_"), "slug 不能留下划线");
  // 事件名宽泛：`维护插件` 与 `维护插件1` 是两个不同事件。
  assert.notEqual(eventSlug("维护插件"), eventSlug("维护插件1"));
});

test("eventFileName 保留空格、去掉 Windows 非法字符并补 .txt", () => {
  assert.equal(eventFileName("维护 HDM 插件"), "维护 HDM 插件.txt");
  assert.equal(eventFileName("a/b:c*d?e"), "a-b-c-d-e.txt");
  assert.equal(eventFileName("  "), "");
});

/* ------------------------------------------------------------------ */
/* 2. 新建档案                                                          */
/* ------------------------------------------------------------------ */

test("appendEventLine 新建档案：标题、正文行、相关记忆与索引字段齐全", async () => {
  const home = await makeHome();
  const now = Date.parse("2026-11-28T10:00:00+08:00");
  const result = await appendEventLine(home, {
    term: "维护 HDM 插件",
    date: "2026-11-28",
    line: "修复记忆编号关键词漂移，重建词库",
    uid: "m-20261128-001",
    sessionId: "session-abc",
    now,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.created, true);
  assert.equal(result.appended, true);
  assert.equal(result.file, "Events/维护 HDM 插件.txt");

  const text = await readFile(path.join(home, result.file), "utf8");
  assert.ok(text.startsWith("# 事件：维护 HDM 插件\n"), text);
  assert.ok(text.includes("- 2026-11-28 修复记忆编号关键词漂移，重建词库\n"), text);
  assert.ok(text.includes("\n## 相关记忆\n- m-20261128-001\n"), text);
  assert.ok(!text.includes("（待写）"), "不留占位行");

  const index = await readIndex(home);
  assert.equal(index.version, 1);
  assert.equal(typeof index.updatedAt, "number");
  const entry = index.entries["维护-hdm-插件"];
  assert.ok(entry, "索引键是 slug");
  assert.equal(entry.term, "维护 HDM 插件");
  assert.deepEqual(entry.files, ["Events/维护 HDM 插件.txt"]);
  assert.deepEqual(entry.uids, ["m-20261128-001"]);
  assert.deepEqual(entry.sessions, ["session-abc"]);
  assert.equal(entry.createdAt, now);
  assert.ok(entry.updatedAt >= now);
});

/* ------------------------------------------------------------------ */
/* 3. 第二次追加                                                        */
/* ------------------------------------------------------------------ */

test("同事件第二次追加：同一文件、行数 +1、uid 去重、updatedAt 变大", async () => {
  const home = await makeHome();
  const first = await appendEventLine(home, {
    term: "维护 HDM 插件",
    date: "2026-11-28",
    line: "第一条",
    uid: "m-20261128-001",
    now: Date.parse("2026-11-28T10:00:00+08:00"),
  });
  const before = await readIndex(home);
  const second = await appendEventLine(home, {
    term: "维护 HDM 插件",
    date: "2026-11-28",
    line: "第二条",
    uid: "m-20261128-001",
    now: Date.parse("2026-11-29T10:00:00+08:00"),
  });

  assert.equal(second.file, first.file, "同一事件写同一份档案");
  assert.equal(second.created, false);
  const text = await readFile(path.join(home, second.file), "utf8");
  const body = text.slice(0, text.indexOf("## 相关记忆"));
  assert.equal(body.match(/^- /gm)?.length, 2, "正文行数 +1（相关记忆段不算）");
  assert.equal(text.match(/^- m-20261128-001$/gm)?.length, 1, "相关记忆 uid 去重");

  const entry = (await readIndex(home)).entries["维护-hdm-插件"];
  assert.ok(entry.updatedAt > before.entries["维护-hdm-插件"].updatedAt);
  assert.deepEqual(entry.uids, ["m-20261128-001"]);
  assert.equal(entry.files.length, 1);
});

/* ------------------------------------------------------------------ */
/* 4. 幂等                                                              */
/* ------------------------------------------------------------------ */

test("同一 uid + date + line 重复调用不重复追加", async () => {
  const home = await makeHome();
  const input = {
    term: "和用户聊天",
    date: "2026-11-28",
    line: "聊了哲学与日常生活",
    uid: "m-20261128-002",
    now: Date.parse("2026-11-28T10:00:00+08:00"),
  };
  const first = await appendEventLine(home, input);
  const text = await readFile(path.join(home, first.file), "utf8");
  const again = await appendEventLine(home, { ...input, now: Date.parse("2026-11-28T11:00:00+08:00") });

  assert.equal(again.ok, true);
  assert.equal(again.appended, false, "重复内容不再追加");
  assert.equal(await readFile(path.join(home, first.file), "utf8"), text, "文件逐字未变");
});

/* ------------------------------------------------------------------ */
/* 5. 超限开第二档案                                                    */
/* ------------------------------------------------------------------ */

test("超过 maxLines 自动开第二档案：xxx1.txt，索引 files 长度 2", async () => {
  const home = await makeHome();
  let last;
  for (let i = 1; i <= 5; i += 1) {
    last = await appendEventLine(home, {
      term: "维护插件",
      date: "2026-11-28",
      line: `第 ${i} 条`,
      uid: `m-20261128-00${i}`,
      maxLines: 3,
      now: Date.parse(`2026-11-28T1${i}:00:00+08:00`),
    });
  }

  assert.equal(last.file, "Events/维护插件1.txt");
  const entry = (await readIndex(home)).entries["维护插件"];
  assert.equal(entry.files.length, 2);
  assert.deepEqual(entry.files, ["Events/维护插件.txt", "Events/维护插件1.txt"]);

  const firstText = await readFile(path.join(home, "Events", "维护插件.txt"), "utf8");
  const secondText = await readFile(path.join(home, "Events", "维护插件1.txt"), "utf8");
  for (const i of [1, 2, 3]) assert.ok(firstText.includes(`- 2026-11-28 第 ${i} 条\n`), firstText);
  for (const i of [4, 5]) assert.ok(secondText.includes(`- 2026-11-28 第 ${i} 条\n`), secondText);
  // 每份档案都带自己的标题与相关记忆段。
  assert.ok(firstText.startsWith("# 事件：维护插件\n"));
  assert.ok(secondText.startsWith("# 事件：维护插件\n"));
  assert.ok(secondText.includes("## 相关记忆"));
});

/* ------------------------------------------------------------------ */
/* 6. readEvent 截断与未命中                                             */
/* ------------------------------------------------------------------ */

test("readEvent 返回全文并按 maxChars 截断；未命中抛中文错误", async () => {
  const home = await makeHome();
  const longLine = "很长的一句话".repeat(80);
  await appendEventLine(home, {
    term: "生成审视报告",
    date: "2026-11-28",
    line: longLine,
    uid: "m-20261128-010",
    now: Date.parse("2026-11-28T10:00:00+08:00"),
  });

  const full = await readEvent(home, "生成审视报告");
  assert.equal(full.truncated, false);
  assert.ok(full.text.includes("生成审视报告"));
  assert.ok(full.text.length > 400);
  assert.equal(full.entry.term, "生成审视报告");

  const cut = await readEvent(home, "生成审视报告", 200);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 200);

  // term 大小写与 slug 归一后也能读到。
  const loose = await readEvent(home, " 生成审视报告 ");
  assert.equal(loose.entry.term, "生成审视报告");

  await assert.rejects(() => readEvent(home, "不存在的事件"), /没有「不存在的事件」的事件档案/);
  assert.deepEqual(await eventsForUid(home, "m-20261128-010"), [full.entry]);
  assert.equal((await listEvents(home)).length, 1);
});

/* ------------------------------------------------------------------ */
/* 7. rebuildEvents                                                     */
/* ------------------------------------------------------------------ */

test("rebuildEvents：索引丢失后从 Events/*.txt + registry.meta.event 重建", async () => {
  const home = await makeHome();
  await appendEventLine(home, {
    term: "维护 HDM 插件",
    date: "2026-11-22",
    line: "修复漂移",
    uid: "m-20261122-005",
    now: Date.parse("2026-11-22T10:00:00+08:00"),
  });
  await appendEventLine(home, {
    term: "维护 HDM 插件",
    date: "2026-11-28",
    line: "落地事件索引",
    uid: "m-20261128-001",
    now: Date.parse("2026-11-28T10:00:00+08:00"),
  });

  // 索引可丢：删掉后只剩 Events/*.txt 与 registry 元数据。
  await rm(eventsIndexFile(home), { force: true });
  assert.equal((await loadEventIndex(home)).size, 0);

  const registry = fakeRegistry([
    { uid: "m-20261122-005", event: "维护 HDM 插件" },
    { uid: "m-20261128-001", event: "维护 HDM 插件" },
    // 档案被删的事件也能只凭 meta.event 恢复关联。
    { uid: "m-20261129-002", event: "和用户聊天" },
    // 空串 / 非字符串跳过，不造无名事件。
    { uid: "m-20261129-003", event: "" },
    { uid: "m-20261129-004", event: null },
    { uid: "m-20261129-005", event: 42 },
  ]);
  const count = await rebuildEvents(home, registry);
  assert.equal(count, 2);

  const entries = await loadEventIndex(home);
  const maintained = entries.get(eventSlug("维护 HDM 插件"));
  assert.ok(maintained);
  assert.deepEqual(maintained.files, ["Events/维护 HDM 插件.txt"]);
  assert.deepEqual(maintained.uids, ["m-20261122-005", "m-20261128-001"]);

  const chat = entries.get(eventSlug("和用户聊天"));
  assert.ok(chat, "只有 meta.event 的事件也要建条目");
  assert.deepEqual(chat.files, []);
  assert.deepEqual(chat.uids, ["m-20261129-002"]);

  // 重建是幂等的：再跑一次条数与 uid 不变。
  assert.equal(await rebuildEvents(home, registry), 2);
  assert.deepEqual((await loadEventIndex(home)).get(eventSlug("维护 HDM 插件")).uids, [
    "m-20261122-005",
    "m-20261128-001",
  ]);
});

/* ------------------------------------------------------------------ */
/* 8. 失败不抛                                                          */
/* ------------------------------------------------------------------ */

test("索引缺失或损坏时 loadEventIndex 返回空 Map，不抛错", async () => {
  const missing = await makeHome();
  const empty = await loadEventIndex(missing);
  assert.ok(empty instanceof Map);
  assert.equal(empty.size, 0);

  const corrupt = await makeHome();
  await mkdir(path.join(corrupt, "index"), { recursive: true });
  await writeFile(eventsIndexFile(corrupt), "{ 这不是 JSON", "utf8");
  const broken = await loadEventIndex(corrupt);
  assert.ok(broken instanceof Map);
  assert.equal(broken.size, 0);

  // 事件表能忍受条目字段缺失：只保留 term 合法的部分。
  await writeFile(
    eventsIndexFile(corrupt),
    JSON.stringify({ version: 1, entries: { "维护-hdm-插件": { term: "维护 HDM 插件" }, bad: { term: "" } } }),
    "utf8",
  );
  const partial = await loadEventIndex(corrupt);
  assert.equal(partial.size, 1);
  assert.deepEqual(partial.get("维护-hdm-插件").files, []);

  // 空 term 直接返回失败，不建目录、不写索引。
  const rejected = await appendEventLine(corrupt, { term: "   ", line: "x" });
  assert.deepEqual(rejected, { ok: false, reason: "empty-term" });
  assert.equal(await stat(path.join(corrupt, "Events")).catch(() => null), null);
});

test("EVENT_DEFAULTS 是只读默认值", () => {
  assert.equal(EVENT_DEFAULTS.maxLines, 400);
  assert.equal(EVENT_DEFAULTS.maxReadChars, 6000);
  assert.equal(EVENT_DEFAULTS.enabled, true);
  assert.ok(Object.isFrozen(EVENT_DEFAULTS));
});

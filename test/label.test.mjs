// 0.4.0「单会话多记忆单元 + 文件夹命名新格式」：解析、编号、会话判据、迁移。
// 运行：node --test test/label.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../lib/config.js";
import { saveConversationMemory } from "../lib/conversation.js";
import { buildMemoryLabel, createMemory, labelTermsOf } from "../lib/memory.js";
import { applyLabelMigration, planLabelMigration } from "../lib/migrate-label.js";
import { eventSlug, parseMemoryFolderName, sessionSlug } from "../lib/paths.js";
import { Registry } from "../lib/registry.js";
import { StateStore } from "../lib/state.js";

const TERMS = ["记忆单元", "文件夹", "命名", "会话", "序列", "事件", "迁移", "解析", "关键词", "回归"];

async function makeHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-label-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return home;
}

async function exists(target) {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

function input(overrides = {}) {
  return {
    summary: "用户要求把记忆文件夹名改成带会话与事件的新格式，并让同一会话能按事件分单元。",
    details: ["旧格式只有日期与全局序号"],
    quotes: [],
    keywords: TERMS,
    people: [],
    source: "observed",
    importance: 3,
    ...overrides,
  };
}

test("label: 新旧两种文件夹名都能解析，字段正确", () => {
  assert.deepEqual(parseMemoryFolderName("2_2026-11-07_a1b2c3d4_01_维护插件_记忆单元_文件夹"), {
    level: 2,
    date: "2026-11-07",
    session: "a1b2c3d4",
    serial: 1,
    event: "维护插件",
    keywords: ["记忆单元", "文件夹"],
    format: "new",
  });

  const legacy = parseMemoryFolderName("2_2026-11-07_001_用户_项目A");
  assert.equal(legacy.format, "legacy");
  assert.equal(legacy.seq, 1);
  assert.deepEqual(legacy.keywords, ["用户", "项目A"]);
  assert.equal(legacy.session, undefined);

  assert.equal(parseMemoryFolderName("bad-name"), null);
  assert.equal(parseMemoryFolderName("3_2026-11-07_a1b2c3d4_01_事件"), null);
  assert.equal(parseMemoryFolderName("2_2026-02-30_a1b2c3d4_01_事件"), null);
  assert.equal(parseMemoryFolderName("2_2026-11-07_a1b2c3d4_00_事件"), null, "serial 00 不是合法新格式");
});

test("label: session8 与 event slug 的归一规则", () => {
  // 先剥 `session-` 前缀、再丢非 [a-z0-9]、最后取 8 位：DSH 的 sessionId 一律带这个前缀，
  // 若先取 8 位再过滤，所有会话都会塌成同一个 `session`。
  assert.equal(sessionSlug("ABCD-1234-xyz"), "abcd1234", "过滤后再取 8 位");
  assert.equal(sessionSlug("session-931104ee-2725-44af"), "931104ee", "剥掉 session- 前缀");
  assert.equal(sessionSlug("session-3461df3b-b72c"), "3461df3b", "不同会话给出不同段");
  assert.equal(sessionSlug("session-"), "unknown");
  assert.equal(sessionSlug("!!!"), "unknown");
  assert.equal(sessionSlug(""), "unknown");
  assert.equal(sessionSlug(undefined), "unknown");

  assert.equal(eventSlug("  维护  插件 "), "维护-插件");
  assert.equal(eventSlug("HDM_Label_迁移"), "hdm-label-迁移");
  assert.equal(eventSlug("a/b:c*d"), "a-b-c-d");
  assert.equal(eventSlug(""), "未分类事件");
  assert.equal(eventSlug(undefined), "未分类事件");
  assert.doesNotMatch(eventSlug("带_下划线的 事件"), /_/);
});

test("label: buildMemoryLabel 段序、两位 serial、超长时少取整词", () => {
  const terms = labelTermsOf(TERMS.map((term, index) => ({ term, keyness: 100 - index })));
  const label = buildMemoryLabel({
    date: "2026-11-07",
    session: "a1b2c3d4",
    serial: 3,
    event: "维护插件",
    level: 2,
    terms,
  });
  const segments = label.split("_");
  assert.equal(segments[0], "2");
  assert.equal(segments[1], "2026-11-07");
  assert.equal(segments[2], "a1b2c3d4");
  assert.equal(segments[3], "03", "serial 两位定长");
  assert.equal(segments[4], "维护插件");
  assert.deepEqual(segments.slice(5), terms, "关键词段整词、按 keyness 降序");
  assert.doesNotMatch(segments[4], /_/);

  const longTerms = Array.from({ length: 12 }, (_, index) => `很长的关键词${index}`.padEnd(32, "字"));
  const limited = buildMemoryLabel({
    date: "2026-11-07",
    session: "a1b2c3d4",
    serial: 1,
    event: "维护插件",
    terms: longTerms,
    maxChars: 120,
  });
  assert.ok(Array.from(limited).length <= 120, `总长应受上限约束，实际 ${limited.length}`);
  assert.ok(longTerms.every((term) => !limited.includes(term.slice(0, 8)) || limited.includes(term)), "整词要么全进要么不进");
});

test("label: serial 超过 99 抛错（构造 100 条 meta，不建目录）", async (t) => {
  const home = await makeHome(t);
  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const stub = {
    list: () =>
      Array.from({ length: 99 }, (_, index) => ({
        uid: `m-20261107-${String(index + 1).padStart(3, "0")}`,
        date: "2026-11-07",
        sessionId: "sess-full",
        serial: index + 1,
      })),
    get: () => undefined,
    lookup: () => new Set(),
    upsert: async () => undefined,
  };
  await assert.rejects(
    () =>
      createMemory({
        registry: stub,
        config,
        home,
        input: input({ event: "维护插件" }),
        session: { id: "sess-full" },
        now: Date.UTC(2026, 10, 7, 14, 0, 0),
      }),
    /同一会话记忆单元超过 99 个，请拆分会话/,
  );
  assert.throws(
    () => buildMemoryLabel({ date: "2026-11-07", session: "s", serial: 100, event: "x", terms: ["a"] }),
    /同一会话记忆单元超过 99 个，请拆分会话/,
  );
});

test("label: 同会话同事件并入同一单元，不同事件新建且 serial 递增", async (t) => {
  const home = await makeHome(t);
  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "multi-session", cwd: home };
  const now = Date.UTC(2026, 10, 7, 4, 0, 0); // 上海 12:00

  const first = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: input({ event: "维护插件" }),
    now,
  });
  const again = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: input({ event: "维护插件", summary: "用户又补了一条同一件事的细节，应继续并入同一单元。" }),
    now: now + 1000,
  });
  assert.equal(again.merged, true, "同事件应追加");
  assert.equal(again.meta.uid, first.meta.uid, "同事件 uid 不变");
  assert.equal(again.meta.defaultLevel, first.meta.defaultLevel, "级别不变");

  const other = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: input({ event: "和用户聊天" }),
    now: now + 2000,
  });
  assert.equal(other.merged, false, "不同事件应新建单元");
  assert.notEqual(other.meta.uid, first.meta.uid);
  assert.equal(other.meta.label.split("_")[3], "02", "同会话第二个单元 serial=02");
  assert.equal(parseMemoryFolderName(other.meta.label).format, "new");
  assert.equal((await readdir(path.join(home, "memory", "2026-11-07"))).length, 2);
});

test("label: 同事件跨天也追加（不再用 3 小时窗口）", async (t) => {
  const home = await makeHome(t);
  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "cross-day", cwd: home };
  const now = Date.UTC(2026, 10, 7, 4, 0, 0);

  const first = await saveConversationMemory({ registry, config, home, state, session, input: input({ event: "维护插件" }), now });
  const nextDay = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: input({ event: "维护插件" }),
    now: now + 30 * 3600_000,
  });
  assert.equal(nextDay.merged, true, "同事件跨天仍追加");
  assert.equal(nextDay.meta.uid, first.meta.uid);
});

test("label: 事件缺失回退时间窗（同天追加，不新建）", async (t) => {
  const home = await makeHome(t);
  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "no-event", cwd: home };
  const now = Date.UTC(2026, 10, 7, 4, 0, 0);

  const first = await saveConversationMemory({ registry, config, home, state, session, input: input(), now });
  const second = await saveConversationMemory({ registry, config, home, state, session, input: input(), now: now + 1000 });
  assert.equal(second.merged, true, "无事件时沿用同天追加");
  assert.equal(second.meta.uid, first.meta.uid);
  assert.equal(second.meta.label.split("_")[4], "未分类事件");
});

test("migrate: plan 按 (date, session) 排 serial，dryRun 不写盘，apply 后名与 meta 一致", async (t) => {
  const home = await makeHome(t);
  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  await mkdir(path.join(home, "memory"), { recursive: true });

  const date = "2026-11-07";
  const rows = [
    { seq: 1, sessionId: "sess-a1111", event: "维护插件", createdAt: 2000 },
    { seq: 2, sessionId: "sess-a1111", event: "和用户聊天", createdAt: 1000 },
    { seq: 3, sessionId: "sess-b2222", event: "迁移", createdAt: 1500 },
  ];
  const made = [];
  for (const row of rows) {
    const label = `2_${date}_${String(row.seq).padStart(3, "0")}_用户`;
    const folder = path.join(home, "memory", date, label);
    await mkdir(folder, { recursive: true });
    const meta = {
      uid: `m-${date.replace(/-/g, "")}-${String(row.seq).padStart(3, "0")}`,
      label,
      folder,
      date,
      seq: row.seq,
      defaultLevel: 2,
      snapshots: [2],
      keywords: [{ term: "用户", keyness: 5, levels: [2] }],
      people: [],
      sessionId: row.sessionId,
      event: row.event,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      hitCount: 0,
      forget: { d2: null, d5: null },
    };
    await writeFile(path.join(folder, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await registry.upsert(meta);
    made.push(meta);
  }

  const plan = planLabelMigration(home, registry);
  assert.equal(plan.length, 3);
  const byUid = Object.fromEntries(plan.map((row) => [row.uid, row]));
  assert.equal(byUid[made[0].uid].serial, 2, "同会话按 createdAt 升序：晚的排 02");
  assert.equal(byUid[made[1].uid].serial, 1, "同会话按 createdAt 升序：早的排 01");
  assert.equal(byUid[made[2].uid].serial, 1, "另一会话从 01 起");
  assert.equal(byUid[made[1].uid].session, "sessa111");
  assert.equal(byUid[made[1].uid].to.split("_")[3], "01");

  const dry = await applyLabelMigration(home, registry, { dryRun: true });
  assert.equal(dry.planned.length, 3);
  assert.equal(dry.renamed.length, 0);
  for (const meta of made) assert.equal(await exists(meta.folder), true, "dryRun 不得改文件夹");

  const applied = await applyLabelMigration(home, registry, { dryRun: false });
  assert.equal(applied.renamed.length, 3);
  assert.deepEqual(applied.warnings, []);
  for (const row of applied.renamed) {
    const after = registry.get(row.uid);
    assert.equal(after.uid, row.uid, "uid 不变");
    assert.equal(after.label, row.to, "meta.label 与新文件夹名一致");
    assert.equal(path.basename(after.folder), row.to);
    assert.equal(await exists(after.folder), true);
    assert.equal(await exists(path.join(home, "memory", date, row.from)), false, "旧文件夹已改名");
    const onDisk = JSON.parse(await readFile(path.join(after.folder, "meta.json"), "utf8"));
    assert.equal(onDisk.label, row.to);
    assert.equal(onDisk.serial, row.serial);
  }

  const after = planLabelMigration(home, registry);
  assert.equal(after.length, 0, "迁移过的单元不再进计划");
  const names = await readdir(path.join(home, "memory", date));
  assert.equal(names.length, 3);
  for (const name of names) assert.equal(parseMemoryFolderName(name).format, "new");
});

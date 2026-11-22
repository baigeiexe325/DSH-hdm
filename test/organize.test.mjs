// 主动记忆整理单元测试：lib/organize.js（repairOne / cleanupTemp / organizeMemories / formatOrganizeReport）。
// 运行：node --test test/organize.test.mjs
// 所有用例都使用 os.tmpdir() 下的临时 home，绝不触碰真实 ~/.dsh-hdm。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatOrganizeReport, organizeMemories } from "../lib/organize.js";
import { localDate } from "../lib/paths.js";
import { Registry } from "../lib/registry.js";

const CONFIG = { timeZone: "Asia/Shanghai", forget: { days: [2, 5] } };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const temps = [];

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-organize-"));
  temps.push(home);
  return home;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function pad3(seq) {
  return String(seq).padStart(3, "0");
}

function termList(count) {
  return Array.from({ length: count }, (_, index) => `主题${String(index + 1).padStart(2, "0")}`);
}

// 与 memory.createMemory 的初始形态一致：lastHitAt / forget 用 null 表示“从未命中/尚未遗忘”。
// repairOne 用 finiteOrNull 判断，null 必须保持 null，不能被 Number(null) === 0 误改。
const CLEAN_KEYWORDS = [
  { term: "调试", keyness: 9, levels: [2] },
  { term: "插件", keyness: 7, levels: [2] },
  { term: "记忆", keyness: 5, levels: [2] },
  { term: "目录", keyness: 3, levels: [2] },
  { term: "索引", keyness: 1, levels: [2] },
];

async function writeMemory(home, spec = {}) {
  const {
    date = "2026-06-01",
    seq = 1,
    label,
    levels = [2],
    snapshots = [2],
    defaultLevel = 2,
    keywords = CLEAN_KEYWORDS,
    people = ["用户"],
    hitCount = 0,
    lastHitAt = null,
    forget = { d2: null, d5: null },
    extra = {},
  } = spec;
  const memoryLabel = label ?? `2_${date}_${pad3(seq)}_用户`;
  const folder = path.join(home, "memory", date, memoryLabel);
  await mkdir(folder, { recursive: true });
  for (const level of levels) {
    await writeFile(path.join(folder, `level${level}.txt`), `## 摘要\nlevel${level} 正文\n`, "utf8");
  }
  const meta = {
    uid: `m-${date.replace(/-/g, "")}-${pad3(seq)}`,
    label: memoryLabel,
    folder,
    defaultLevel,
    snapshots,
    date,
    seq,
    keywords,
    people,
    sessionId: "sess-organize",
    createdAt: 1,
    updatedAt: 1,
    hitCount,
    lastHitAt,
    immortal: false,
    immortalReason: null,
    forget,
    relatedUids: [],
    ...extra,
  };
  await writeFile(path.join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return { folder, label: memoryLabel, meta };
}

async function readMeta(folder) {
  return JSON.parse(await readFile(path.join(folder, "meta.json"), "utf8"));
}

async function writeTemp(dir, name, ageMs) {
  const file = path.join(dir, name);
  await writeFile(file, "stale temp\n", "utf8");
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
  return file;
}

test.after(async () => {
  for (const home of temps) await rm(home, { recursive: true, force: true });
});

// 1) 正常记忆：meta / 文件夹 / 快照 / 关键词一致时不做任何修复，索引数量正确。

test("organize: 元数据与快照一致时 repaired 为空，indexCount 正确", async () => {
  const home = await makeHome();
  const fixture = await writeMemory(home);
  const registry = new Registry(home);

  const report = await organizeMemories({ home, config: CONFIG, registry });

  assert.equal(report.dryRun, false);
  assert.equal(report.memories, 1);
  assert.equal(report.dateFolders, 1);
  assert.deepEqual(report.repaired, [], "一致记忆不应产生修复");
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.removedTemp, []);
  assert.equal(report.indexCount, 1, "索引应重建出 1 条记忆");

  // 身份/快照字段原样保留
  assert.deepEqual(await readMeta(fixture.folder), fixture.meta);
  const index = JSON.parse(await readFile(path.join(home, "index", "memories.json"), "utf8"));
  assert.equal(Object.keys(index.memories).length, 1);
  assert.ok(index.memories[fixture.meta.uid], "索引里应有该 uid");
});

// 2) meta.json 漂移：快照、默认层级、文件夹前缀、关键词、人称、命中数全部修复。

test("organize: 修复 meta.json 漂移（快照/层级/文件夹前缀/关键词/人称/命中数）", async () => {
  const home = await makeHome();
  const date = "2026-07-15";
  const seq = 2;
  const oldLabel = `2_${date}_002_漂移`;
  const newLabel = `1_${date}_002_漂移`;
  const keywords = [
    { term: "调试", keyness: 100, levels: [2] },
    { term: " 调试 ", keyness: 60, levels: [0] }, // 重复 term + 非法 level 0
    { term: "快照", keyness: 90, levels: [3] }, // 非法 level 3
    { term: "   ", keyness: 999, levels: [2] }, // 空 term
    ...termList(12).map((term, index) => ({ term, keyness: 80 - index * 5, levels: [2] })),
  ];
  const fixture = await writeMemory(home, {
    date,
    seq,
    label: oldLabel,
    levels: [1, 2],
    snapshots: [2], // 漂移：磁盘上已有 level1 + level2
    defaultLevel: 2,
    keywords,
    people: ["用户", " 用户 ", "助手", "", "用户"],
    hitCount: 42,
    forget: { d2: null, d5: null },
  });
  const registry = new Registry(home);

  const report = await organizeMemories({ home, config: CONFIG, registry });
  const newFolder = path.join(home, "memory", date, newLabel);

  assert.equal(report.repaired.length, 1);
  assert.ok(await exists(newFolder), "文件夹前缀应从 2_ 改为 1_");
  assert.equal(await exists(fixture.folder), false, "旧前缀文件夹应已改名");

  const changes = new Set(report.repaired[0].changes);
  for (const key of ["folder", "defaultLevel", "snapshots", "keywords", "people", "hitCount"]) {
    assert.ok(changes.has(key), `修复项应包含 ${key}`);
  }
  assert.equal(report.repaired[0].folder, newFolder);

  const meta = await readMeta(newFolder);
  assert.equal(meta.defaultLevel, 1);
  assert.deepEqual(meta.snapshots, [1, 2]);
  assert.equal(meta.label, newLabel);
  assert.equal(meta.folder, newFolder);

  // 关键词：去重、去空、过滤非法 level、截断到 12 个、按 keyness 降序
  const expectedTerms = ["调试", "快照", ...termList(10)];
  assert.equal(meta.keywords.length, 12);
  assert.deepEqual(meta.keywords.map((keyword) => keyword.term), expectedTerms);
  assert.deepEqual(meta.keywords[0], { term: "调试", keyness: 100, levels: [2] });
  assert.deepEqual(meta.keywords[1], { term: "快照", keyness: 90, levels: [1] });
  assert.deepEqual(meta.keywords[2], { term: "主题01", keyness: 80, levels: [2] });

  // 人称去重、hitCount 夹到上限 30
  assert.deepEqual(meta.people, ["用户", "助手"]);
  assert.equal(meta.hitCount, 30);

  assert.equal(report.indexCount, 1, "修复后重建索引仍应找到这条记忆");
});

// 3) dryRun：只报告不写入。

test("organize: dryRun 不写 meta、不改文件夹名、不重建索引", async () => {
  const home = await makeHome();
  const date = "2026-09-10";
  const fixture = await writeMemory(home, {
    date,
    seq: 3,
    label: `2_${date}_003_预览`,
    levels: [1, 2],
    snapshots: [2],
    defaultLevel: 2,
    extra: { uid: "m-19990101-003" }, // uid 与 date/seq 推导值不一致 -> 产生 warning
  });
  const stale = await writeTemp(path.join(home, "memory", date), "stale.tmp", 2 * HOUR_MS);
  const registry = new Registry(home);

  const report = await organizeMemories({ home, config: CONFIG, registry, dryRun: true });

  assert.equal(report.dryRun, true);
  // dryRun 不写索引，因此不返回 indexCount（schema 声明 integer，返回 null 会被宿主校验拒绝）。
  assert.equal(Object.hasOwn(report, "indexCount"), false, "dryRun 不返回 indexCount");
  assert.ok(report.repaired.length > 0, "预览也应报告待修复项");
  assert.ok(report.repaired[0].changes.includes("folder"));
  assert.ok(report.warnings.length > 0, "预览也应报告警告");
  assert.ok(report.warnings.some((warning) => /uid/.test(warning)));
  assert.deepEqual(report.removedTemp, [], "dryRun 不清理临时文件");

  // 未写入：原文件夹仍在、meta 未变、新前缀文件夹不存在、索引目录不存在。
  assert.ok(await exists(fixture.folder));
  assert.deepEqual(await readMeta(fixture.folder), fixture.meta);
  assert.equal(await exists(path.join(home, "memory", date, `1_${date}_003_预览`)), false);
  assert.equal(await exists(path.join(home, "index")), false);
  assert.ok(await exists(stale), "dryRun 不应删除过期临时文件");
});

// 4) 孤立文件夹（没有 meta.json）：警告里带路径，但目录不删除。

test("organize: 孤立文件夹给出警告且不删除目录", async () => {
  const home = await makeHome();
  const orphan = path.join(home, "memory", "2026-08-01", "2_2026-08-01_001_孤儿");
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, "level2.txt"), "## 摘要\n孤儿正文\n", "utf8");

  const report = await organizeMemories({ home, config: CONFIG, registry: new Registry(home) });

  assert.ok(
    report.warnings.some((warning) => warning.includes(orphan)),
    `警告应包含孤立文件夹路径：${JSON.stringify(report.warnings)}`,
  );
  assert.deepEqual(report.repaired, []);
  assert.equal(report.memories, 1);
  assert.equal(report.indexCount, 0);
  assert.ok(await exists(orphan), "孤立文件夹不能被删除");
  assert.ok(await exists(path.join(orphan, "level2.txt")), "快照正文不能被删除");
});

// 5) 临时文件清理：mtime 超过 1 小时的 .tmp 删除，新 .tmp 保留。

test("organize: 清理超过 1 小时的 .tmp，保留较新的 .tmp", async () => {
  const home = await makeHome();
  const dayDir = path.join(home, "memory", "2026-10-05");
  await mkdir(dayDir, { recursive: true });
  const stale = await writeTemp(dayDir, ".meta.json.stale.tmp", 2 * HOUR_MS);
  const fresh = path.join(dayDir, ".meta.json.fresh.tmp");
  await writeFile(fresh, "fresh temp\n", "utf8");

  const report = await organizeMemories({ home, config: CONFIG, registry: new Registry(home) });

  assert.equal(await exists(stale), false, "超过 1 小时的临时文件应删除");
  assert.ok(await exists(fresh), "1 小时内的临时文件应保留");
  assert.equal(report.removedTemp.length, 1);
  assert.equal(report.removedTemp[0], stale);
});

// 6) formatOrganizeReport：记忆数、修复数、索引、清理、定时维护（日记/遗忘）行。

test("formatOrganizeReport: 输出记忆数/修复数/索引/清理/定时维护行", async () => {
  const home = await makeHome();
  const date = "2026-05-20";
  const fixture = await writeMemory(home, {
    date,
    label: `2_${date}_001_格式`,
    levels: [1, 2],
    snapshots: [2],
    defaultLevel: 2,
  });
  await writeTemp(path.dirname(fixture.folder), "old.tmp", 2 * HOUR_MS);

  const report = await organizeMemories({ home, config: CONFIG, registry: new Registry(home) });
  const text = formatOrganizeReport(report);

  assert.match(text, /^HDM 记忆整理完成$/m);
  assert.match(text, /记忆单元: 1 个（日期文件夹 1 个）/);
  assert.match(text, /修复: 1 条/);
  assert.match(text, /^索引: 已重建 1 条记忆$/m);
  assert.match(text, /清理临时文件: 1 个/);
  assert.match(text, /定时维护: 日记待生成 \d+ 天，遗忘待处理 \d+ 条/);
  assert.ok(text.includes("folder"), "应列出被修复的字段");

  // 预览模式文案
  const preview = formatOrganizeReport({ ...report, dryRun: true, repaired: [], removedTemp: [], indexCount: null });
  assert.match(preview, /HDM 记忆整理（预览，不写入）/);
  assert.match(preview, /修复: 无（元数据与快照一致）/);
  assert.match(preview, /索引: 预览模式未写入/);
  assert.match(preview, /清理临时文件: 0 个/);
  assert.match(preview, /定时维护: 日记待生成 0 天/);
});

// 7) 报告字段：diaryPending / forgetDue 必须存在且类型稳定。

test("organize: 报告包含 diaryPending 与 forgetDue", async () => {
  const now = Date.now();
  const yesterday = localDate(now - DAY_MS);
  const home = await makeHome();
  await writeMemory(home, { date: yesterday, seq: 1 });

  const report = await organizeMemories({ home, config: CONFIG, registry: new Registry(home), now });

  assert.ok(Object.hasOwn(report, "diaryPending"));
  assert.ok(Object.hasOwn(report, "forgetDue"));
  assert.ok(Array.isArray(report.diaryPending));
  assert.deepEqual(report.diaryPending, [yesterday], "昨天有记忆且没有日记 -> 待生成");
  assert.equal(typeof report.forgetDue, "number");
  assert.ok(Number.isInteger(report.forgetDue));
  assert.equal(report.forgetDue, 0, "仅 1 天前的记忆尚未到遗忘天数");
  assert.deepEqual(report.repaired, []);

  const text = formatOrganizeReport(report);
  assert.match(text, /定时维护: 日记待生成 1 天，遗忘待处理 0 条/);
});

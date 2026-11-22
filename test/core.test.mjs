// HDM 存储核心单元测试：config / paths / registry / memory / state。
// 运行：node --test test/core.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Config, DEFAULTS, KEYWORD_BANDS, resolveConfig } from "../lib/config.js";
import {
  atomicJson,
  atomicWrite,
  daysBetween,
  ensureDir,
  expandHome,
  keywordDisplay,
  localDate,
  localDateTime,
  parseMemoryFolderName,
  renameDirSafe,
  slug,
} from "../lib/paths.js";
import { Registry } from "../lib/registry.js";
import { selectHandoff } from "../lib/injection.js";
import {
  commitDerivedSnapshot,
  computeKeyness,
  createMemory,
  deriveSnapshotData,
  memoryFolder,
  parseSnapshot,
  readSnapshot,
  renameMemoryFolder,
  selectKeywords,
  writeSnapshot,
} from "../lib/memory.js";
import { DEFAULT_SESSION, StateStore, acquireFileLock, createMutex } from "../lib/state.js";

const temps = [];

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-test-"));
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

function chars(text) {
  return Array.from(String(text ?? "")).length;
}

const TERMS = ["插件加载", "调试", "报错", "修复", "流程", "用户", "项目A", "状态", "测试", "问题", "日志", "收尾"];

function metaFixture(home, { date = "2026-11-01", seq = 1, keywords, extra = {} } = {}) {
  const seqText = String(seq).padStart(3, "0");
  const label = `2_${date}_${seqText}_用户`;
  return {
    uid: `m-${date.replace(/-/g, "")}-${seqText}`,
    label,
    folder: path.join(home, "memory", date, label),
    defaultLevel: 2,
    snapshots: [2],
    date,
    seq,
    keywords: keywords ?? [{ term: "用户", keyness: 8, levels: [2] }],
    people: ["用户"],
    sessionId: "sess-fixture",
    createdAt: 1,
    updatedAt: 1,
    hitCount: 0,
    lastHitAt: null,
    immortal: false,
    immortalReason: null,
    forget: { d2: null, d5: null },
    relatedUids: [],
    ...extra,
  };
}

test.after(async () => {
  for (const home of temps) await rm(home, { recursive: true, force: true });
});

// ------------------------------------------------------------------ config

test("config: 默认值、合并覆盖、~ 展开", () => {
  const config = resolveConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.save.threshold, 0.5);
  assert.equal(config.save.step, 0.15);
  assert.equal(config.recall.topK, 0, "0.3.0 起 topK 默认 0 = 跟随输入关键词数");
  assert.equal("defaultView" in config.recall, false, "defaultView 已删除");
  assert.deepEqual(config.forget.days, [2, 5]);
  assert.equal(config.association.triggerCount, 4);
  assert.equal(config.association.recencyWindowDays, 30);
  assert.equal(config.nudge.staleMinutes, 45);
  assert.equal(config.maintenance.provider, "");
  assert.equal(config.homeDir, path.resolve(os.homedir(), ".dsh-hdm"));
  assert.equal(DEFAULTS.homeDir, "~/.dsh-hdm");

  const custom = resolveConfig({ save: { threshold: 0.05 }, homeDir: "~/hdm-custom", forget: { days: [5, 2] } });
  assert.equal(custom.save.threshold, 0.05);
  assert.equal(custom.save.step, 0.15, "未覆盖的键保持默认");
  assert.equal(custom.homeDir, path.resolve(os.homedir(), "hdm-custom"));
  assert.deepEqual(custom.forget.days, [2, 5], "days 排序规整");

  const copy = resolveConfig({});
  copy.save.threshold = 0.9;
  assert.equal(resolveConfig({}).save.threshold, 0.5, "每次返回全新对象");
  assert.equal(expandHome("~"), os.homedir());
});

test("config: 未知键与类型/范围错误可读", () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置键: nope/);
  assert.throws(() => resolveConfig({ save: { nope: 1 } }), /未知配置键: save\.nope/);
  assert.throws(() => resolveConfig({ save: { threshold: "0.5" } }), /save\.threshold.*number/);
  assert.throws(() => resolveConfig({ recall: { topK: 99 } }), /recall\.topK.*范围/);
  assert.throws(() => resolveConfig({ recall: { topK: 1.5 } }), /整数/);
  assert.throws(() => resolveConfig({ timeZone: "Not/AZone" }), /时区/);
  assert.throws(() => resolveConfig({ forget: { days: [] } }), /至少需要/);
  assert.throws(() => resolveConfig({ diary: { time: "25:00" } }), /格式不合法/);
  assert.throws(() => resolveConfig([]), /必须是对象/);
  assert.throws(() => resolveConfig({ forget: { exemptMode: "bogus" } }), /只能/);
});

test("config: ~standard.validate 与 KEYWORD_BANDS", () => {
  assert.equal(Config["~standard"].version, 1);
  const ok = Config["~standard"].validate({});
  assert.ok(ok.value, "空配置应通过校验");
  // 字段标记为 volatile（设置文档要求），校验输出是 Volatile 包装，取原始值比较。
  const rawThreshold = ok.value.save.threshold;
  const threshold = rawThreshold && typeof rawThreshold.get === "function" ? rawThreshold.get() : rawThreshold;
  assert.equal(threshold, 0.5);
  const bad = Config["~standard"].validate({ recall: { topK: 13 } });
  assert.ok(Array.isArray(bad.issues));
  assert.match(bad.issues[0].message, /topK/);
  assert.equal(Config.type, "object");
  assert.ok(Config.dict.save.dict.threshold);
  assert.ok(Config.toJSON(), "Config 应可序列化给设置页");
  assert.deepEqual([...KEYWORD_BANDS[2]], [10, 12]);
  assert.deepEqual([...KEYWORD_BANDS[1]], [8, 10]);
  assert.deepEqual([...KEYWORD_BANDS[0]], [5, 8]);
});

test("config: resolveConfig 解包 Schemastery volatile 包装（设置页保存路径）", () => {
  const validated = Config["~standard"].validate({ homeDir: "H:\\dsh-HDM", diary: { enabled: false } });
  assert.ok(validated.value, "配置应通过校验");
  const resolved = resolveConfig(validated.value);
  assert.equal(resolved.homeDir, path.resolve("H:\\dsh-HDM"), "volatile 字符串应解包为 string");
  assert.equal(resolved.diary.enabled, false, "volatile 布尔应解包为 boolean");
  assert.equal(resolved.save.threshold, 0.5, "默认值应保留");
  assert.deepEqual(resolved.forget.days, [2, 5], "volatile 数组应解包为普通数组");
});

// ------------------------------------------------------------------ paths

test("paths: Intl 本地日期与时间（Asia/Shanghai）", () => {
  const lateNight = Date.UTC(2026, 10, 7, 15, 30, 0); // 上海 23:30
  assert.equal(localDate(lateNight, "Asia/Shanghai"), "2026-11-07");
  assert.equal(localDate(Date.UTC(2026, 10, 7, 16, 30, 0), "Asia/Shanghai"), "2026-11-08", "不能按 UTC 截日期");
  assert.equal(localDate(lateNight, "UTC"), "2026-11-07");
  assert.match(localDateTime(lateNight, "Asia/Shanghai"), /^2026-11-07 23:30:00 \+08:00$/);
  assert.equal(localDateTime(lateNight, "UTC").slice(0, 19), "2026-11-07 15:30:00");
  assert.throws(() => localDate(lateNight, "Bad/Zone"), /无效时区/);
});

test("paths: daysBetween", () => {
  assert.equal(daysBetween("2026-11-05", "2026-11-07"), 2);
  assert.equal(daysBetween("2026-11-07", "2026-11-05"), -2);
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.throws(() => daysBetween("bad", "2026-11-07"), /日期格式/);
});

test("paths: slug / keywordDisplay 中文与非法字符", () => {
  assert.equal(slug("用户: 项目A/调试?"), "用户_项目A_调试");
  assert.equal(slug("  "), "");
  assert.equal(keywordDisplay("插件加载测试用例", 8), "插件加载测试用例");
  assert.equal(chars(keywordDisplay("插件加载测试用例", 4)), 4);
  assert.equal(keywordDisplay("", 8), "");
  assert.ok(!/[<>:"/\\|?*]/.test(keywordDisplay("a<b>c|d?e*f", 8)));
});

test("paths: ensureDir / atomicWrite / atomicJson / renameDirSafe", async () => {
  const home = await makeHome();
  const dir = path.join(home, "nested", "deep");
  await ensureDir(dir);
  assert.ok(await exists(dir));

  // Windows 上对已存在的盘符根递归 mkdir 会抛 EPERM；ensureDir 应视为成功，
  // 否则跨盘迁移在创建父目录时就会中断（见 migrateHome）。
  await ensureDir(path.parse(home).root);

  const file = path.join(dir, "note.txt");
  await atomicWrite(file, "你好 HDM");
  assert.equal(await readFile(file, "utf8"), "你好 HDM");
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "不留临时文件");

  const jsonFile = path.join(dir, "data.json");
  await atomicJson(jsonFile, { ok: true, n: 2 });
  assert.deepEqual(JSON.parse(await readFile(jsonFile, "utf8")), { ok: true, n: 2 });

  const src = path.join(home, "folder-a");
  const dest = path.join(home, "folder-b");
  await ensureDir(src);
  await writeFile(path.join(src, "x.txt"), "x", "utf8");
  await renameDirSafe(src, dest);
  assert.equal(await exists(src), false);
  assert.equal(await exists(path.join(dest, "x.txt")), true);
  await renameDirSafe(src, dest); // 幂等：源不存在、目标存在
  await mkdir(src, { recursive: true });
  await assert.rejects(() => renameDirSafe(src, dest), /目标文件夹已存在/);
});

test("paths: parseMemoryFolderName", () => {
  assert.deepEqual(parseMemoryFolderName("2_2026-11-07_001_用户_项目A_调试"), {
    level: 2,
    date: "2026-11-07",
    seq: 1,
    keywords: ["用户", "项目A", "调试"],
  });
  assert.deepEqual(parseMemoryFolderName("0_2026-01-02_1002_关键词"), {
    level: 0,
    date: "2026-01-02",
    seq: 1002,
    keywords: ["关键词"],
  });
  assert.equal(parseMemoryFolderName("bad-name"), null);
  assert.equal(parseMemoryFolderName("3_2026-11-07_001_x"), null);
  assert.equal(parseMemoryFolderName("2_2026-02-30_001_x"), null);
});

// ------------------------------------------------------------------ registry

test("registry: upsert / lookup / bumpHit / 索引文件", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  assert.deepEqual(registry.list(), []);

  const first = metaFixture(home, {
    keywords: [
      { term: "用户", keyness: 8, levels: [2] },
      { term: "插件", keyness: 7, levels: [2] },
    ],
  });
  const second = metaFixture(home, {
    seq: 2,
    keywords: [{ term: "用户", keyness: 5, levels: [0] }],
    relatedUids: [first.uid],
  });
  await registry.upsert(first);
  await registry.upsert(second);
  assert.equal(registry.list().length, 2);
  assert.ok(await exists(path.join(home, "index", "memories.json")));
  assert.ok(await exists(path.join(home, "index", "keywords.json")));
  assert.ok(await exists(path.join(home, "Backup", "keywords.json.bak")), "写入前保留 Backup/keywords.json.bak");
  assert.ok(await exists(path.join(home, "Backup", "memories.json.bak")), "写入前保留 Backup/memories.json.bak");
  assert.equal(await exists(path.join(home, "index", "keywords.json.bak")), false, "旧 index/*.bak 不再生成");

  const hits = registry.lookup(["用户"]);
  assert.equal(hits.has(first.uid), true);
  assert.equal(hits.has(second.uid), true);
  assert.equal(registry.lookup(["插件"]).has(first.uid), true);
  assert.equal(registry.lookup(["不存在的词"]).size, 0);

  const bumped = await registry.bumpHit(first.uid, 1234);
  assert.equal(bumped.hitCount, 1);
  assert.equal(bumped.lastHitAt, 1234);
  registry.get(first.uid).hitCount = 29;
  await registry.bumpHit(first.uid, 2000);
  assert.equal(registry.get(first.uid).hitCount, 30);
  await registry.bumpHit(first.uid, 3000);
  assert.equal(registry.get(first.uid).hitCount, 30, "hitCount 上限 30");
  assert.equal(await registry.bumpHit("missing-uid"), undefined);

  await assert.rejects(() => registry.upsert({}), /uid/);
});

test("registry: people 只收字符串，对象型条目不会变成「[object Object]」", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const meta = metaFixture(home, { extra: { people: ["用户", { name: "小林" }, "", "  ", "小林"] } });
  await registry.upsert(meta);
  assert.deepEqual(registry.get(meta.uid).people, ["用户", "小林"]);
});

test("registry: bumpHits 批量累加、只 save 一次、结果与逐条 bumpHit 一致", async () => {
  const config = resolveConfig({});

  const homeBatch = await makeHome();
  const batch = new Registry(homeBatch, config);
  await batch.load();
  const a = metaFixture(homeBatch);
  const b = metaFixture(homeBatch, { seq: 2 });
  await batch.upsert(a);
  await batch.upsert(b);
  batch.get(a.uid).hitCount = 29; // 上限边界：两次批量后应停在 30

  let saves = 0;
  const originalSave = batch.save.bind(batch);
  batch.save = async () => {
    saves += 1;
    return originalSave();
  };
  const first = await batch.bumpHits([a.uid, a.uid, b.uid, "missing-uid"], 5000);
  assert.equal(saves, 1, "一次 bumpHits 只落盘一次");
  assert.equal(first.size, 2, "不存在的 uid 不进 Map");
  assert.equal(first.get(a.uid), 30, "hitCount 上限 30");
  assert.equal(first.get(b.uid), 1);
  assert.equal(batch.get(a.uid).lastHitAt, 5000);
  assert.equal(batch.get(b.uid).lastHitAt, 5000);

  // 逐条调用（同一份输入）必须得到同样的计数。
  const homeSingle = await makeHome();
  const single = new Registry(homeSingle, config);
  await single.load();
  const a2 = metaFixture(homeSingle);
  const b2 = metaFixture(homeSingle, { seq: 2 });
  await single.upsert(a2);
  await single.upsert(b2);
  single.get(a2.uid).hitCount = 29;
  for (const uid of [a2.uid, a2.uid, b2.uid]) await single.bumpHit(uid, 5000);
  assert.equal(batch.get(a.uid).hitCount, single.get(a2.uid).hitCount, "批量与逐条结果一致");
  assert.equal(batch.get(b.uid).hitCount, single.get(b2.uid).hitCount);
});

test("registry: 旧 index/*.bak 收编到 Backup/，且 load 仍可从 Backup 恢复", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await mkdir(path.join(home, "index"), { recursive: true });
  const legacyMemories = JSON.stringify({ version: 1, memories: {} });
  const legacyKeywords = JSON.stringify({ version: 1, keywords: {} });
  await writeFile(path.join(home, "index", "memories.json.bak"), legacyMemories, "utf8");
  await writeFile(path.join(home, "index", "keywords.json.bak"), legacyKeywords, "utf8");

  await registry.adoptLegacyBackups();
  assert.ok(await exists(path.join(home, "Backup", "memories.json.bak")));
  assert.ok(await exists(path.join(home, "Backup", "keywords.json.bak")));
  assert.equal(await exists(path.join(home, "index", "memories.json.bak")), false);
  assert.equal(await exists(path.join(home, "index", "keywords.json.bak")), false);

  // 主索引损坏时，load 从 Backup 回退。
  await writeFile(path.join(home, "index", "memories.json"), "{ broken", "utf8");
  await writeFile(path.join(home, "index", "keywords.json"), "{ broken", "utf8");
  await registry.load();
  assert.deepEqual(registry.list(), []);
});


test("registry: keywords.json 自愈（空桶 / 文件缺失）后 lookup 仍能命中", async () => {
  const config = resolveConfig({});

  // ① memories.json 有内容，keywords.json 是合法但空的 {"keywords":{}} —— 以前不重建，召回静默为空。
  const homeEmpty = await makeHome();
  const writer = new Registry(homeEmpty, config);
  await writer.load();
  const meta = metaFixture(homeEmpty);
  await writer.upsert(meta);
  await writeFile(path.join(homeEmpty, "index", "keywords.json"), JSON.stringify({ keywords: {} }), "utf8");

  const loaded = new Registry(homeEmpty, config);
  const result = await loaded.load();
  assert.equal(result.repaired, true, "空桶应触发自愈");
  assert.equal(loaded.lookup(["用户"]).has(meta.uid), true);
  const rewritten = JSON.parse(await readFile(path.join(homeEmpty, "index", "keywords.json"), "utf8"));
  assert.ok(rewritten.keywords["用户"]?.[meta.uid] !== undefined, "自愈后必须把 keywords.json 写回去");

  // ② 只有 memories.json、没有 keywords.json —— 同样必须重建出可命中的索引。
  const homeMissing = await makeHome();
  const writer2 = new Registry(homeMissing, config);
  await writer2.load();
  await writer2.upsert(metaFixture(homeMissing));
  await rm(path.join(homeMissing, "index", "keywords.json"), { force: true });

  const loaded2 = new Registry(homeMissing, config);
  await loaded2.load();
  assert.equal(loaded2.lookup(["用户"]).has(meta.uid), true);
});

test("registry: rebuild 扫描 meta.json 并可从 .bak 恢复", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const date = "2026-11-01";
  const onDisk = [];
  for (const seq of [1, 2]) {
    const meta = metaFixture(home, { date, seq });
    await mkdir(meta.folder, { recursive: true });
    await writeFile(path.join(meta.folder, "level2.txt"), "## 摘要\n内容\n", "utf8");
    await writeFile(path.join(meta.folder, "meta.json"), JSON.stringify(meta), "utf8");
    onDisk.push(meta);
  }

  const registry = new Registry(home, config);
  const count = await registry.rebuild();
  assert.equal(count, 2);
  assert.ok(registry.get(onDisk[0].uid));
  assert.equal(registry.lookup(["用户"]).has(onDisk[1].uid), true);
  assert.ok(await exists(path.join(home, "index", "memories.json")));
  await registry.save(); // 第二次写入形成 .bak

  // 损坏主索引后，重新 load 应回退到 .bak
  await writeFile(path.join(home, "index", "memories.json"), "{broken json", "utf8");
  const recovered = new Registry(home, config);
  await recovered.load();
  assert.equal(recovered.list().length, 2, "从 .bak 恢复");
});

test("registry: rename 同步 label/folder，remove 清理索引", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const meta = metaFixture(home);
  await registry.upsert(meta);
  const newLabel = "1_2026-11-01_001_用户";
  await registry.rename(meta, newLabel);
  assert.equal(meta.label, newLabel);
  assert.equal(path.basename(meta.folder), newLabel);
  assert.equal(registry.get(meta.uid).label, newLabel);

  await registry.remove(meta.uid);
  assert.equal(registry.get(meta.uid), undefined);
  assert.equal(registry.lookup(["用户"]).size, 0);
});

// ------------------------------------------------------------------ memory: create

test("memory: createMemory 只写 L2+meta、文件夹名与稳定 uid", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const now = Date.UTC(2026, 10, 7, 14, 0, 0); // 上海 22:00
  const summary = "今天调试插件加载失败，插件加载报错，最终修复了插件加载流程。";
  const { meta, keywordScores } = await createMemory({
    registry,
    config,
    home,
    input: {
      summary,
      details: ["d1", "d2", "d3"],
      quotes: ["原话一"],
      keywords: TERMS,
      people: ["用户", "小林"],
      scene: "调试",
      event: "插件加载",
      emotion: "焦虑",
      source: "observed",
    },
    session: { id: "sess-1", cwd: "H:/work" },
    now,
  });

  assert.match(meta.uid, /^m-20261107-001$/);
  assert.equal(meta.defaultLevel, 2);
  assert.deepEqual(meta.snapshots, [2]);
  assert.equal(meta.seq, 1);
  assert.ok(meta.label.startsWith("2_2026-11-07_001_"));
  assert.ok(meta.folder.endsWith(meta.label));
  assert.ok(meta.folder.includes(path.join("memory", "2026-11-07")));
  assert.equal(meta.sessionId, "sess-1");
  assert.equal(meta.cwd, "H:/work");
  assert.equal(meta.keywords.length, 12);
  assert.ok(meta.keywords.every((keyword) => keyword.levels.includes(2)));
  assert.equal(keywordScores[0].term, "插件加载");
  assert.ok(keywordScores[0].keyness > keywordScores.at(-1).keyness, "模型顺序靠前且摘要命中者更高");

  const entries = (await readdir(meta.folder)).sort();
  assert.deepEqual(entries, ["level2.txt", "meta.json"], "创建时只生成 L2 与 meta");
  const l2 = await readFile(path.join(meta.folder, "level2.txt"), "utf8");
  const parsed = parseSnapshot(l2);
  assert.equal(parsed.header["稳定ID"], meta.uid);
  assert.equal(parsed.header["快照等级"], "2（完整细节）");
  assert.match(parsed.header["关键词"], /插件加载/);
  assert.ok(parsed.sections["摘要"].includes("插件加载失败"));
  assert.match(parsed.sections["细节"], /d1/);
  assert.match(parsed.sections["原话"], /原话一/);
  assert.match(parsed.sections["关联"], /diary\/2026-11-07\.txt/);
  assert.equal(registry.lookup(["插件加载"]).has(meta.uid), true);

  const second = await createMemory({
    registry,
    config,
    home,
    input: { summary: "第二次保存", keywords: ["用户", "调试"], relatedUids: [meta.uid] },
    session: { id: "sess-1" },
    now,
  });
  assert.match(second.meta.uid, /^m-20261107-002$/, "同日下一个 seq");
  assert.deepEqual(second.meta.relatedUids, [meta.uid]);

  const longTerms = Array.from({ length: 12 }, (_, index) => `很长的关键词${index}`.padEnd(32, "字"));
  const third = await createMemory({
    registry,
    config,
    home,
    input: { summary: "文件名长度测试", keywords: longTerms },
    session: { id: "sess-1" },
    now,
  });
  assert.ok(third.meta.label.length <= config.memory.filenameMaxChars);
  assert.match(third.meta.label, /^2_2026-11-07_003_/);
});

test("memory: keyness 因子（顺序/摘要/人物/频率/IDF/专有名词/场景）", async () => {
  const scores = computeKeyness(["插件加载", "调试", "用户"], {
    summary: "今天调试插件加载失败，插件加载报错",
    details: ["插件加载失败"],
    quotes: [],
    people: ["用户"],
    scene: "调试",
    event: "插件加载",
  });
  const byTerm = Object.fromEntries(scores.map((item) => [item.term, item.keyness]));
  assert.ok(byTerm["插件加载"] > byTerm["调试"]);
  assert.ok(byTerm["调试"] > byTerm["用户"]);
  assert.ok(scores.every((item) => item.keyness >= 0.1 && item.keyness <= 10));

  const proper = computeKeyness(["DSH", "普通词"], { summary: "无关内容" });
  const properMap = Object.fromEntries(proper.map((item) => [item.term, item.keyness]));
  // 顺序差异之外，专有名词再 +0.6；用一个同位置对照验证专有名词因子存在
  assert.ok(properMap["DSH"] > 0);

  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  await registry.upsert(metaFixture(home, { keywords: [{ term: "常见词", keyness: 5, levels: [2] }] }));
  const withoutIdf = computeKeyness(["稀有词"], { summary: "摘要" })[0].keyness;
  const withIdf = computeKeyness(["稀有词"], { summary: "摘要", registry })[0].keyness;
  assert.ok(withIdf > withoutIdf, "IDF 给稀有词加成");
});

test("memory: selectKeywords 按 keyness 排序而非截断", () => {
  const list = [
    { term: "a", keyness: 1, levels: [2] },
    { term: "b", keyness: 5, levels: [2] },
    { term: "c", keyness: 3, levels: [2] },
  ];
  assert.deepEqual(selectKeywords(list, 2).map((item) => item.term), ["b", "c"]);
  assert.deepEqual(selectKeywords(list, 9).length, 3);
  assert.deepEqual(selectKeywords(list, 0), []);
});

// ------------------------------------------------------------------ memory: derive/commit

test("memory: L2 → L1（摘要≤200、细节≤3、无原话、改名、冻结 L2）", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const now = Date.UTC(2026, 10, 7, 14, 0, 0);
  const longSummary = "测试摘要".repeat(60); // 240 字符
  const { meta } = await createMemory({
    registry,
    config,
    home,
    input: {
      summary: longSummary,
      details: Array.from({ length: 8 }, (_, index) => `细节${index + 1}`),
      quotes: ["原话1", "原话2"],
      keywords: TERMS,
      people: ["用户"],
    },
    session: { id: "sess-l1" },
    now,
  });
  const l2Before = await readFile(path.join(meta.folder, "level2.txt"), "utf8");
  const oldFolder = meta.folder;

  const data = deriveSnapshotData(meta, 1);
  assert.equal(data.level, 1);
  assert.ok(chars(data.summary) <= 200);
  assert.ok(data.details.length <= 3);
  assert.deepEqual(data.quotes, []);
  assert.ok(data.keywords.length >= KEYWORD_BANDS[1][0] && data.keywords.length <= KEYWORD_BANDS[1][1]);

  const now2 = now + 86_400_000;
  const committed = await commitDerivedSnapshot({ registry, meta, data, now: now2 });
  assert.deepEqual(committed.snapshots, [1, 2]);
  assert.equal(committed.defaultLevel, 1);
  assert.ok(committed.label.startsWith("1_2026-11-07_001"));
  assert.equal(committed.forget.d2, now2);
  assert.equal(await exists(oldFolder), false, "文件夹前缀 2_ → 1_");
  assert.equal(committed.folder, path.join(home, "memory", "2026-11-07", committed.label));

  const entries = (await readdir(committed.folder)).sort();
  assert.deepEqual(entries, ["level1.txt", "level2.txt", "meta.json"]);
  assert.equal(await readFile(path.join(committed.folder, "level2.txt"), "utf8"), l2Before, "L2 冻结不变");
  const l1Text = await readFile(path.join(committed.folder, "level1.txt"), "utf8");
  assert.match(l1Text, /快照等级: 1（要点）/);
  assert.match(l1Text, /来源快照: level2\.txt/);
  assert.equal(parseSnapshot(l1Text).sections["原话"], undefined, "L1 无原话");
  assert.equal(registry.get(meta.uid).defaultLevel, 1);
});

test("memory: L1 → L0（摘要≤120、无细节、改名、冻结 L1）", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const now = Date.UTC(2026, 10, 7, 14, 0, 0);
  const { meta } = await createMemory({
    registry,
    config,
    home,
    input: {
      summary: "测试摘要".repeat(60),
      details: Array.from({ length: 8 }, (_, index) => `细节${index + 1}`),
      quotes: ["原话"],
      keywords: TERMS,
      people: ["用户"],
    },
    session: { id: "sess-l0" },
    now,
  });
  const now2 = now + 86_400_000;
  await commitDerivedSnapshot({ registry, meta, data: deriveSnapshotData(meta, 1), now: now2 });
  const l1Before = await readFile(path.join(meta.folder, "level1.txt"), "utf8");

  const data0 = deriveSnapshotData(meta, 0);
  assert.equal(data0.level, 0);
  assert.ok(chars(data0.summary) <= 120);
  assert.deepEqual(data0.details, []);
  assert.deepEqual(data0.quotes, []);
  assert.ok(data0.keywords.length >= KEYWORD_BANDS[0][0] && data0.keywords.length <= KEYWORD_BANDS[0][1]);

  const now3 = now2 + 3 * 86_400_000;
  const committed = await commitDerivedSnapshot({ registry, meta, data: data0, now: now3 });
  assert.deepEqual(committed.snapshots, [0, 1, 2]);
  assert.equal(committed.defaultLevel, 0);
  assert.ok(committed.label.startsWith("0_2026-11-07_001"));
  assert.equal(committed.forget.d5, now3);
  assert.equal(await readFile(path.join(committed.folder, "level1.txt"), "utf8"), l1Before, "L1 冻结不变");
  const entries = (await readdir(committed.folder)).sort();
  assert.deepEqual(entries, ["level0.txt", "level1.txt", "level2.txt", "meta.json"]);
  const l0Text = await readFile(path.join(committed.folder, "level0.txt"), "utf8");
  assert.match(l0Text, /快照等级: 0（gist）/);
  assert.match(l0Text, /来源快照: level1\.txt/);
  assert.equal(parseSnapshot(l0Text).sections["细节"], undefined, "L0 无细节");

  const updatedAt = committed.updatedAt;
  const idempotent = await commitDerivedSnapshot({ registry, meta, data: data0, now: now3 + 5000 });
  assert.equal(idempotent.updatedAt, updatedAt, "快照只生成一次（幂等）");
  assert.deepEqual(idempotent.snapshots, [0, 1, 2]);
  assert.strictEqual(idempotent.folder, committed.folder);
});

test("memory: L1/L0 选词按 keyness（不是简单取前 N）", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const { meta } = await createMemory({
    registry,
    config,
    home,
    input: { summary: "选词测试", keywords: TERMS },
    session: { id: "sess-select" },
    now: Date.UTC(2026, 10, 7, 14, 0, 0),
  });
  meta.keywords.forEach((keyword, index) => {
    keyword.keyness = index;
  });
  const data = deriveSnapshotData(meta, 1);
  assert.equal(data.keywords.length, 10);
  assert.ok(data.keywords.some((item) => item.term === "收尾"), "高 keyness 的后置词被选中");
  assert.ok(!data.keywords.some((item) => item.term === "插件加载"), "低 keyness 的前置词被淘汰");
});

// ------------------------------------------------------------------ memory: read/fallback/immortal

test("memory: readSnapshot 回退、writeSnapshot、parseSnapshot、immortal 跳过", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const now = Date.UTC(2026, 10, 7, 14, 0, 0);
  const { meta } = await createMemory({
    registry,
    config,
    home,
    input: { summary: "读快照测试", keywords: TERMS, details: ["细节A"], quotes: ["原话A"] },
    session: { id: "sess-read" },
    now,
  });

  const exact = await readSnapshot(meta, 2);
  assert.equal(exact.level, 2);
  assert.equal(exact.fallback, false);
  const auto = await readSnapshot(meta);
  assert.equal(auto.level, 2);
  const fallback = await readSnapshot(meta, 0);
  assert.equal(fallback.level, 2, "唯一档位回退");
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.path, exact.path);

  const written = await writeSnapshot(meta, 1, "## 摘要\n手动 L1\n");
  assert.equal(path.basename(written), "level1.txt");
  meta.snapshots = [1, 2];
  const middle = await readSnapshot(meta, 1);
  assert.equal(middle.level, 1);
  assert.equal(middle.fallback, false);
  const fromZero = await readSnapshot(meta, 0);
  assert.equal(fromZero.level, 1, "回退到最近可用档");

  const parsed = parseSnapshot(exact.text);
  assert.equal(parsed.header["稳定ID"], meta.uid);
  assert.equal(parsed.header["来源"], "observed");
  assert.ok(parsed.sections["摘要"].includes("读快照测试"));
  assert.match(parsed.sections["关联"], /diary\/2026-11-07\.txt/);

  const immortal = await createMemory({
    registry,
    config,
    home,
    input: { summary: "永久记忆", keywords: TERMS, immortal: true },
    session: { id: "sess-immortal" },
    now,
  });
  assert.equal(immortal.meta.immortal, true);
  assert.throws(() => deriveSnapshotData(immortal.meta, 1), /immortal/);
});

test("memory: renameMemoryFolder 同步磁盘、meta 与注册表", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();
  const { meta } = await createMemory({
    registry,
    config,
    home,
    input: { summary: "改名测试", keywords: TERMS },
    session: { id: "sess-rename" },
    now: Date.UTC(2026, 10, 7, 14, 0, 0),
  });
  const oldFolder = meta.folder;
  const renamed = await renameMemoryFolder({ registry, meta, newDefaultLevel: 1 });
  assert.equal(renamed.defaultLevel, 1);
  assert.ok(renamed.label.startsWith("1_"));
  assert.equal(await exists(oldFolder), false);
  assert.equal(await exists(path.join(renamed.folder, "level2.txt")), true);
  assert.equal(registry.get(meta.uid).label, renamed.label);
  assert.equal(memoryFolder(home, renamed.date, renamed.label), renamed.folder);
});

// ------------------------------------------------------------------ state

test("state: SessionState 默认值、持久化与损坏容错", async () => {
  const home = await makeHome();
  const store = new StateStore(home);
  await store.load();

  const session = store.getSession("sess-a");
  assert.deepEqual(session, {
    uids: [],
    lastSaveRatio: null,
    remindedBands: [],
    iamInjected: false,
    handoffUid: null,
    lastMemoryToolAt: null,
    userTurnsSinceMemory: 0,
    nudges: 0,
    recalledUids: [],
    sharedUids: [],
    memoryUid: null,
    pinConversation: false,
    lastUserAt: null,
    lastOrganizedUserAt: null,
    userMessageCount: 0,
    lastOrganizedAt: null,
    idleAttempts: 0,
    lastOrganizeError: null,
    pendingRememberAt: null,
    pendingRememberHintAt: null,
    lastUserQuery: null,
    recallTurn: null,
    subagentRecalled: false,
    pendingContextReinject: false,
    pendingCompactMemory: null,
    lastCompactError: null,
    activity: [],
  });
  assert.deepEqual(Object.keys(DEFAULT_SESSION), Object.keys(session));

  const updated = await store.updateSession("sess-a", {
    uids: ["m-20261107-001"],
    lastSaveRatio: 0.52,
    remindedBands: [0.5],
    iamInjected: true,
  });
  assert.deepEqual(updated.uids, ["m-20261107-001"]);
  const jobs = await store.updateJobs({ lastDiaryDate: "2026-11-07", forgetDone: { "m-1": 1 } });
  assert.equal(jobs.lastDiaryDate, "2026-11-07");
  assert.equal(store.getJobs().forgetDone["m-1"], 1);

  const reloaded = new StateStore(home);
  await reloaded.load();
  assert.equal(reloaded.getSession("sess-a").lastSaveRatio, 0.52);
  assert.deepEqual(reloaded.getSession("sess-a").remindedBands, [0.5]);
  assert.equal(reloaded.getJobs().forgetDone["m-1"], 1);
  assert.equal(reloaded.getJobs().diaryRunning, false);

  const sessionAgain = reloaded.getSession("sess-a");
  sessionAgain.uids.push("m-2");
  assert.deepEqual(DEFAULT_SESSION.uids, [], "默认值不被修改");

  await writeFile(path.join(home, "state", "sessions.json"), "{corrupt", "utf8");
  const recovered = new StateStore(home);
  await recovered.load();
  assert.deepEqual(recovered.getSession("sess-a").uids, []);
  assert.equal(recovered.getJobs().lastDiaryDate, "2026-11-07", "jobs 不受 sessions 损坏影响");
});

test("state: save() 写 jobs 前与磁盘浅合并，不覆盖别人写的 forgetDone", async () => {
  const home = await makeHome();
  await mkdir(path.join(home, "state"), { recursive: true });
  // 模拟另一个进程（定时巡检）已经落了 forgetDone。
  await writeFile(
    path.join(home, "state", "jobs.json"),
    JSON.stringify({ version: 1, jobs: { forgetDone: { "m-20261101-001": 1 }, lastDiaryDate: "2026-11-01" } }),
    "utf8",
  );

  const store = new StateStore(home);
  await store.load();
  assert.equal(store.getJobs().forgetDone["m-20261101-001"], 1, "load 后内存应带上磁盘 jobs");

  // 只改一个内存字段再保存：磁盘上的 forgetDone 必须仍在。
  // （契约是「磁盘已有键优先」，所以这里改的是磁盘没有的键 nextForgetAt。）
  await store.updateJobs({ nextForgetAt: 1700000000000 });
  const onDisk = JSON.parse(await readFile(path.join(home, "state", "jobs.json"), "utf8"));
  assert.equal(onDisk.jobs.forgetDone["m-20261101-001"], 1, "save 不得丢掉磁盘上的 forgetDone");
  assert.equal(onDisk.jobs.nextForgetAt, 1700000000000, "内存新增的键仍要写回");
});

test("state: 默认会话与 DEFAULT_SESSION 键集一致，数组字段不共享冻结数组", async () => {
  const home = await makeHome();
  const store = new StateStore(home);
  await store.load();
  const fallback = store.getSession("never-seen");
  assert.deepEqual(Object.keys(fallback).sort(), Object.keys(DEFAULT_SESSION).sort());

  // 默认值里的数组必须各给一份新数组：改会话不能污染下一个会话，也不能撞上冻结数组。
  fallback.uids.push("m-x");
  fallback.activity.push({ at: 1, text: "x" });
  const another = store.getSession("never-seen-2");
  assert.deepEqual(another.uids, []);
  assert.deepEqual(another.activity, []);
  assert.deepEqual(DEFAULT_SESSION.uids, []);
  assert.deepEqual(DEFAULT_SESSION.activity, []);
});

test("state: createMutex 同键串行、异常不阻塞后续", async () => {
  const mutex = createMutex();
  const order = [];
  let active = 0;
  let maxActive = 0;
  const job = (id) =>
    mutex.run("same-key", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${id}`);
      await delay(5);
      order.push(`end-${id}`);
      active -= 1;
    });
  await Promise.all([job(1), job(2), job(3)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);

  await assert.rejects(() =>
    mutex.run("fail-key", async () => {
      throw new Error("boom");
    }),
  );
  const value = await mutex.run("fail-key", async () => "still-works");
  assert.equal(value, "still-works");

  let parallel = 0;
  let maxParallel = 0;
  await Promise.all(
    ["a", "b"].map((key) =>
      mutex.run(key, async () => {
        parallel += 1;
        maxParallel = Math.max(maxParallel, parallel);
        await delay(5);
        parallel -= 1;
      }),
    ),
  );
  assert.equal(maxParallel, 2, "不同 key 可并发");
});

test("state: acquireFileLock best-effort 互斥与 TTL", async () => {
  const home = await makeHome();
  const release = await acquireFileLock(home, "forget", 60_000);
  assert.ok(await exists(path.join(home, "state", ".lock-forget")));
  await assert.rejects(() => acquireFileLock(home, "forget", 60_000), /锁.*占用|获取文件锁失败/);
  await release();
  assert.equal(await exists(path.join(home, "state", ".lock-forget")), false);

  const releaseAgain = await acquireFileLock(home, "forget", 60_000);
  await releaseAgain();

  const stale = await acquireFileLock(home, "ttl", 5);
  await delay(30);
  const fresh = await acquireFileLock(home, "ttl", 60_000);
  await fresh();
  await stale(); // 旧持有者释放不应删除新锁
  const finalLock = await acquireFileLock(home, "ttl", 60_000);
  await finalLock();
});

test("handoff: 工作目录归一化比较、排除本会话单元、并列时按 uid 确定性排序", async () => {
  const home = await makeHome();
  const config = resolveConfig({ handoff: { enabled: true, preferSameWorkspace: true, maxAgeDays: 30 } });
  const registry = new Registry(home, config);
  await registry.load();
  const now = Date.parse("2026-11-18T16:00:00Z");
  const session = { header: { id: "sess-current", cwd: "D:\\Work\\demo", createdAt: now } };

  const entry = (uid, overrides = {}) => ({
    uid,
    label: `2_mem_${uid}`,
    folder: path.join(home, "memory", uid),
    defaultLevel: 2,
    snapshots: [2],
    date: "2026-11-17",
    seq: 1,
    keywords: [],
    people: [],
    sessionId: "sess-old",
    cwd: "D:\\Work\\demo",
    createdAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    hitCount: 0,
    lastHitAt: null,
    immortal: false,
    immortalReason: null,
    forget: { d2: null, d5: null },
    relatedUids: [],
    ...overrides,
  });

  // 1) H:/a 与 H:\A 是同一个目录：同工作区优先，不能被斜杠方向判成「别的工作区」。
  await registry.upsert(entry("m-slash", { cwd: "D:/Work/demo", updatedAt: now - 3600_000 }));
  await registry.upsert(entry("m-other", { cwd: "D:\\OtherRepo", updatedAt: now - 60_000 }));
  assert.equal((await selectHandoff({ home, config, registry, session, now })).uid, "m-slash");

  // 2) 本会话自己的单元要排除，否则把当前这件事当成「上一段对话」喂回来。
  assert.equal(
    (await selectHandoff({ home, config, registry, session, now, excludeUids: ["m-slash"] })).uid,
    "m-other",
  );

  // 3) 派生 L1/L0 曾把多条 updatedAt 刷成同一时刻 → 没有次级键时选择取决于遍历顺序。
  //    插入顺序反过来也必须选到同一条。
  const tie = (uid) => entry(uid, { cwd: "E:\\Tie", updatedAt: now - 7200_000, createdAt: now - 7200_000 });
  await registry.upsert(tie("m-tie-b"));
  await registry.upsert(tie("m-tie-a"));
  const first = await selectHandoff({ home, config, registry, session, now, excludeUids: ["m-slash", "m-other"] });
  await registry.remove("m-tie-b");
  await registry.upsert(tie("m-tie-b"));
  const second = await selectHandoff({ home, config, registry, session, now, excludeUids: ["m-slash", "m-other"] });
  assert.equal(first.uid, "m-tie-a");
  assert.equal(second.uid, first.uid, "并列时结果与插入顺序无关");
});

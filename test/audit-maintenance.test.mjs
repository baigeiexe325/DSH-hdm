// HDM 检修回归测试（维护子智能体新增，覆盖 A/B/D/E/F 组契约与本次修复）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWrite, ensureDir } from "../lib/paths.js";
import { migrateHome } from "../lib/migrate.js";
import { StateStore } from "../lib/state.js";
import { Registry } from "../lib/registry.js";
import { createMemory, commitDerivedSnapshot, deriveSnapshotData, parseSnapshot } from "../lib/memory.js";
import { Config, DEFAULTS, KEYWORD_BANDS, resolveConfig } from "../lib/config.js";
import { createTools } from "../lib/tools.js";
import { registerTriggers } from "../lib/triggers.js";
import { streamText } from "../lib/llm.js";
import { idleWindowMs, shouldOrganize } from "../lib/idle.js";
import { organizeMemories } from "../lib/organize.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

async function newHome(prefix = "hdm-audit-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanup(home) {
  await rm(home, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ B: schema */

function collectSchemaIssues(node, trail, issues) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectSchemaIssues(item, `${trail}[${index}]`, issues));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, "required")) {
    if (node.required === false) issues.push(`${trail}.required=false`);
    else if (Array.isArray(node.required)) {
      const properties = node.properties ?? {};
      for (const key of node.required) {
        if (!(key in properties)) issues.push(`${trail}.required(${key}) 不在 properties`);
      }
    }
  }
  for (const [key, value] of Object.entries(node)) collectSchemaIssues(value, `${trail}.${key}`, issues);
}

function assertObjectSchema(node, trail) {
  assert.equal(node?.type, "object", `${trail} 必须编译成 type:"object"`);
  assert.ok(node.properties && Object.keys(node.properties).length > 0, `${trail}.properties 不能为空`);
}

test("B: hdm_* 工具 parameters/output.schema 形状合法（无 required:false、output 顶层无 required）", () => {
  const tools = createTools({
    ctx: { logger: { warn() {}, info() {}, error() {} } },
    home: os.tmpdir(),
    config: { characters: { enabled: false, maxChars: 12000 }, recall: { topK: 3 } },
    registry: {},
    state: {},
  });
  assert.ok(tools.length >= 6, "应注册 6 个 hdm_* 工具");
  for (const tool of tools) {
    // 0.4.0 起除 hdm_* 还有一个按需求命名的 `reconception`（档案调取），同样要求 schema 合规。
    assert.match(tool.name, /^(hdm_|reconception$)/);
    assertObjectSchema(tool.parameters, `${tool.name}.parameters`);
    assertObjectSchema(tool.output.schema, `${tool.name}.output.schema`);
    assert.equal(tool.output.schema.required, undefined, `${tool.name} output.schema 顶层不得有 required`);
    const issues = [];
    collectSchemaIssues(tool.parameters, `${tool.name}.parameters`, issues);
    collectSchemaIssues(tool.output.schema, `${tool.name}.output.schema`, issues);
    assert.deepEqual(issues, [], `${tool.name} schema 违规: ${issues.join("; ")}`);
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
  }
});

test("B: execute 返回的每个字段都在 output.schema.properties 中声明", async () => {
  const home = await newHome();
  try {
    const config = resolveConfig({ homeDir: home });
    const registry = new Registry(home, config);
    await registry.load();
    const state = new StateStore(home);
    await state.load();
    const tools = new Map(
      createTools({ ctx: { logger: { warn() {}, info() {}, error() {} } }, home, config, registry, state }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const exec = { agent: { session: { header: { id: "s-audit", cwd: home, createdAt: Date.now() } } } };
    const seen = new Set();
    const verify = (name, value) => {
      const schema = tools.get(name).output.schema;
      for (const [key, field] of Object.entries(value)) {
        if (field === undefined) continue;
        assert.ok(schema.properties[key] !== undefined, `${name} 返回了 schema 未声明的字段: ${key}`);
        seen.add(`${name}.${key}`);
      }
      const rendered = tools.get(name).output.render({}, value);
      assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} 的 render 必须产出文本块`);
      assert.equal(rendered[0].type, "text");
    };

    const saved = await tools.get("hdm_save").execute(
      {
        summary: "检修测试摘要：十个字符以上",
        details: ["细节一"],
        keywords: ["检修", "回归", "测试", "快照", "索引", "迁移", "原子写", "超时", "窗口", "报告"],
        importance: 3,
      },
      exec,
    );
    verify("hdm_save", saved);
    assert.equal(typeof saved.merged, "boolean");

    const recalled = await tools.get("hdm_recall").execute({ keywords: ["检修"] }, exec);
    verify("hdm_recall", recalled);
    assert.ok(Array.isArray(recalled.sameDay));

    const read = await tools.get("hdm_read").execute({ uid: saved.uid }, exec);
    verify("hdm_read", read);
    assert.equal(read.ok, true);

    // append 必须显式指定固定节：无 section 会落到「记忆索引」节并被 syncIamIndex 覆盖（0.3.2 起拒绝）。
    const iam = await tools
      .get("hdm_iam_update")
      .execute({ content: "- 检修记录一条", mode: "append", section: "自我叙事" }, exec);
    verify("hdm_iam_update", iam);
    assert.equal(iam.ok, true);

    const character = await tools.get("hdm_character_update").execute({ name: "小明", notes: "参与检修" }, exec);
    verify("hdm_character_update", character);
    assert.equal(character.ok, true);

    const organized = await tools.get("hdm_organize").execute({ dryRun: true }, exec);
    verify("hdm_organize", organized);
    assert.equal(organized.dryRun, true);
    assert.ok(organized.memories >= 1);

    assert.ok(seen.size > 20, `实际校验字段过少: ${seen.size}`);
  } finally {
    await cleanup(home);
  }
});

test("B: 工具卡片 kind 与动作一致：只读动作不标 edit", () => {
  const tools = new Map(
    createTools({
      ctx: { logger: { warn() {}, info() {}, error() {} } },
      home: os.tmpdir(),
      config: { characters: { enabled: false, maxChars: 12000 }, recall: { topK: 3 } },
      registry: {},
      state: {},
    }).map((tool) => [tool.name, tool]),
  );
  const backup = tools.get("hdm_backup");
  assert.equal(backup.presentCall({ action: "status" }).kind, "read", "action=status 只读");
  assert.equal(backup.presentCall({}).kind, "read", "action 缺省按 status 处理");
  assert.equal(backup.presentCall({ action: "snapshot" }).kind, "edit");
  assert.equal(backup.presentCall({ action: "restore" }).kind, "edit");

  const organize = tools.get("hdm_organize");
  assert.equal(organize.presentCall({ dryRun: true }).kind, "read", "dryRun=true 只扫描不落盘");
  assert.equal(organize.presentCall({ dryRun: false }).kind, "edit");
  assert.equal(organize.presentCall({}).kind, "edit", "缺省 dryRun=false 会写盘");
});

/* ------------------------------------------------------------------ A: client */

test("A: client 半只注册一次、id 等于包名、顶层无副作用、不 require 服务端模块", async () => {
  const root = path.join(import.meta.dirname, "..");
  const source = await readFile(path.join(root, "lib", "client.js"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  assert.equal((source.match(/__ModuleLoader__\.load\(/g) ?? []).length, 1, "一个 bundle 只能注册一次");
  const loadIndex = source.indexOf("__ModuleLoader__.load");
  assert.ok(loadIndex >= 0, "缺少 __ModuleLoader__.load 注册");
  const head = source.slice(loadIndex, loadIndex + 200);
  const idMatch = /id:\s*["']([^"']+)["']/.exec(head);
  assert.ok(idMatch, "load({ id }) 缺少 id");
  assert.equal(idMatch[1], pkg.name, "factory id 必须等于 package.json name");

  const prefix = source.slice(0, loadIndex);
  assert.doesNotMatch(prefix, /document\.|createElement|\.style\b/, "脚本执行期不得触碰 DOM");

  assert.doesNotMatch(source, /require\(\s*["'](?:node:|fs["']|path["']|os["']|@deepseek-ai\/)/, "不得 require 服务端模块");
  assert.doesNotMatch(source, /require\(\s*["']dsh-hdm["']\)/, "不得自引用 require");
});

/* ------------------------------------------------------------------ F: config */

test("F: 配置叶子 volatile，数组只标数组本身，resolveConfig 解包 volatile 包装", () => {
  const leaves = [];
  const walk = (schema, trail) => {
    if (schema?.dict) {
      for (const [key, child] of Object.entries(schema.dict)) walk(child, `${trail}.${key}`);
      return;
    }
    assert.ok(schema, `${trail} 缺失`);
    assert.equal(schema.meta?.volatile, true, `${trail} 必须是 volatile 叶子`);
    if (schema.type === "array") {
      assert.notEqual(schema.inner?.meta?.volatile, true, `${trail} 数组元素不得标 volatile`);
      leaves.push(`${trail}[]`);
      return;
    }
    leaves.push(trail);
  };
  for (const [key, value] of Object.entries(Config.dict)) walk(value, key);
  assert.ok(leaves.length >= 50, `配置叶子数量异常: ${leaves.length}`);

  const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
  const resolved = resolveConfig({
    save: { threshold: { get: () => 0.7, [VOLATILE_WRITE]: () => undefined } },
    forget: { days: { get: () => [5, 2], [VOLATILE_WRITE]: () => undefined } },
  });
  assert.equal(resolved.save.threshold, 0.7, "volatile 叶子必须解包成普通值");
  assert.deepEqual(resolved.forget.days, [2, 5], "数组解包后仍走排序校验");

  // README 文档值抽样：防止默认值被抄错一个数量级。
  assert.equal(DEFAULTS.save.threshold, 0.5);
  assert.equal(DEFAULTS.save.step, 0.15);
  assert.equal(DEFAULTS.save.maxPerSession, 4);
  assert.equal(DEFAULTS.recall.topK, 0, "0.3.0 起 0 = 跟随输入关键词数");
  assert.equal(DEFAULTS.handoff.maxChars, 2000);
  assert.equal(DEFAULTS.autoRecall.minScore, 2);
  assert.equal(DEFAULTS.iam.maxChars, 6000);
  assert.equal(DEFAULTS.diary.time, "23:30");
  assert.deepEqual(DEFAULTS.forget.days, [2, 5]);
  assert.equal(DEFAULTS.association.maxChars, 1500);
  assert.equal(DEFAULTS.characters.maxChars, 12000);
  assert.equal(DEFAULTS.idle.idleMinutes, 180);
  assert.equal(DEFAULTS.idle.maxIdleMinutes, 720);
  // v2.1：预算可配；输入上限与日记字数上限按用户要求保持原值（不要被“调大预算”顺手抬走）。
  assert.equal(DEFAULTS.maintenance.maxTokens, 100000);
  assert.equal(DEFAULTS.maintenance.timeoutSeconds, 600);
  assert.equal(DEFAULTS.diary.maxChars, 8000);
  assert.equal(DEFAULTS.diary.inputMaxChars, 12000);
  assert.equal(DEFAULTS.idle.maxInputChars, 12000);
  assert.deepEqual(KEYWORD_BANDS[2], [10, 12]);
  assert.deepEqual(KEYWORD_BANDS[1], [8, 10]);
  assert.deepEqual(KEYWORD_BANDS[0], [5, 8]);
});

/* ------------------------------------------------------------------ D: async */

test("D: 空闲窗口按分钟换算成毫秒，179/180/719/720 边界正确", () => {
  const config = resolveConfig({});
  const { minMs, maxMs } = idleWindowMs(config);
  assert.equal(minMs, 180 * MINUTE, "idleMinutes 是分钟，必须 ×60000");
  assert.equal(maxMs, 720 * MINUTE, "maxIdleMinutes 是分钟，必须 ×60000");

  const session = { lastOrganizedAt: null };
  const activityAt = Date.UTC(2026, 10, 8, 2, 0, 0);
  const entry = { lastAt: activityAt, count: 3, messages: [{ at: activityAt - 1000, text: "你好" }] };
  assert.equal(shouldOrganize({ config, session, entry, now: activityAt + 179 * MINUTE }).reason, "too-recent");
  assert.equal(shouldOrganize({ config, session, entry, now: activityAt + 180 * MINUTE }).ok, true);
  assert.equal(shouldOrganize({ config, session, entry, now: activityAt + 719 * MINUTE }).ok, true);
  assert.equal(shouldOrganize({ config, session, entry, now: activityAt + 720 * MINUTE }).reason, "too-stale");
});

test("D: streamText 默认带 AbortSignal 超时，并合并调用方 signal", async () => {
  const requests = [];
  const ctx = {
    llm: {
      stream(request) {
        requests.push(request);
        return (async function* stream() {
          yield { textDelta: "ok" };
        })();
      },
    },
  };
  const model = { provider: "p", model: "m" };
  assert.equal(await streamText(ctx, model, { system: "s", messages: [], maxMs: 30_000 }), "ok");
  assert.ok(requests[0].signal instanceof AbortSignal, "未传 signal 时也必须带默认超时边界");

  const controller = new AbortController();
  await streamText(ctx, model, { messages: [], signal: controller.signal, maxMs: 30_000 });
  const merged = requests[1].signal;
  assert.ok(merged instanceof AbortSignal);
  controller.abort();
  assert.equal(merged.aborted, true, "调用方 abort 必须传递到底层流");
});

/* ------------------------------------------------------------------ E: writes */

test("E: atomicWrite 写成功且不留 .tmp，rename 失败后也清理临时文件", async () => {
  const home = await newHome();
  try {
    const file = path.join(home, "note.txt");
    await atomicWrite(file, "你好 HDM");
    assert.equal(await readFile(file, "utf8"), "你好 HDM");
    assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp")), []);

    const blocked = path.join(home, "blocked");
    await mkdir(blocked);
    await assert.rejects(() => atomicWrite(blocked, "x"));
    assert.ok((await stat(blocked)).isDirectory(), "目标目录不能被文件覆盖");
    assert.deepEqual(
      (await readdir(home)).filter((name) => name.endsWith(".tmp")),
      [],
      "失败后不得残留 .tmp",
    );
  } finally {
    await cleanup(home);
  }
});

test("E: migrateHome 目标位置已有文件时必须报错且不删除该文件", async () => {
  const root = await newHome();
  try {
    const from = path.join(root, "old-home");
    await mkdir(from, { recursive: true });
    await writeFile(path.join(from, "IAM.md"), "old", "utf8");
    const to = path.join(root, "new-home");
    await writeFile(to, "keep-me", "utf8");

    await assert.rejects(() => migrateHome(from, to));
    assert.equal(await readFile(to, "utf8"), "keep-me", "已有文件不得被 rm -rf 掉");
    assert.equal(await readFile(path.join(from, "IAM.md"), "utf8"), "old", "源目录保持完整");
  } finally {
    await cleanup(root);
  }
});

test("E: organize 清理 characters/ 下过期 .tmp，保留新 .tmp", async () => {
  const home = await newHome();
  try {
    await ensureDir(path.join(home, "characters"));
    const stale = path.join(home, "characters", ".USER.md.stale.tmp");
    const fresh = path.join(home, "characters", ".USER.md.fresh.tmp");
    await writeFile(stale, "x", "utf8");
    await writeFile(fresh, "x", "utf8");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const registry = { list: () => [], rebuild: async () => 0 };
    const report = await organizeMemories({
      home,
      config: resolveConfig({ homeDir: home, diary: { enabled: false } }),
      registry,
    });
    assert.ok(report.removedTemp.includes(stale), "characters/ 下的过期 .tmp 应被清理");
    const names = await readdir(path.join(home, "characters"));
    assert.ok(names.includes(path.basename(fresh)), "较新的 .tmp 必须保留");
    assert.ok(!names.includes(path.basename(stale)));
  } finally {
    await cleanup(home);
  }
});

/* --------------------------------------------------- memory label / state null */

test("memory: 派生快照头的「记忆编号」等于改名后的 label，关键词档位不越界", async () => {
  const home = await newHome();
  try {
    const config = resolveConfig({ homeDir: home });
    const registry = new Registry(home, config);
    await registry.load();
    const now = Date.UTC(2026, 10, 8, 2, 0, 0);
    const { meta } = await createMemory({
      registry,
      config,
      home,
      input: {
        summary: "检修测试摘要：十个字符以上",
        details: ["细节一"],
        quotes: ["原话一"],
        keywords: ["检修", "回归", "快照", "索引", "迁移", "原子写", "超时", "窗口", "报告", "边界"],
      },
      session: { id: "s-label" },
      now,
    });
    assert.ok(meta.label.startsWith("2_"), "初始文件夹后缀 2_");

    const l1 = deriveSnapshotData(meta, 1);
    assert.ok(l1.keywords.length >= KEYWORD_BANDS[1][0] && l1.keywords.length <= KEYWORD_BANDS[1][1]);
    await commitDerivedSnapshot({ registry, meta, data: l1, now: now + DAY });
    assert.ok(meta.label.startsWith("1_"));
    const l1Text = parseSnapshot(await readFile(path.join(meta.folder, "level1.txt"), "utf8"));
    assert.equal(l1Text.header["记忆编号"], meta.label, "L1 头必须是改名后的 1_ label");

    const l0 = deriveSnapshotData(meta, 0);
    assert.ok(l0.keywords.length >= KEYWORD_BANDS[0][0] && l0.keywords.length <= KEYWORD_BANDS[0][1]);
    await commitDerivedSnapshot({ registry, meta, data: l0, now: now + 5 * DAY });
    assert.ok(meta.label.startsWith("0_"));
    const l0Text = parseSnapshot(await readFile(path.join(meta.folder, "level0.txt"), "utf8"));
    assert.equal(l0Text.header["记忆编号"], meta.label, "L0 头必须是改名后的 0_ label");
  } finally {
    await cleanup(home);
  }
});

test("state: 可空字段的 null 不会被 normalizeSession 改成 0", async () => {
  const home = await newHome();
  try {
    await ensureDir(path.join(home, "state"));
    await writeFile(
      path.join(home, "state", "sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: {
          s1: {
            lastSaveRatio: null,
            lastMemoryToolAt: null,
            lastUserAt: null,
            lastOrganizedAt: null,
            idleAttempts: null,
            lastOrganizeError: null,
          },
        },
      }),
      "utf8",
    );
    const store = new StateStore(home);
    await store.load();
    const session = store.getSession("s1");
    assert.equal(session.lastSaveRatio, null);
    assert.equal(session.lastMemoryToolAt, null);
    assert.equal(session.lastUserAt, null);
    assert.equal(session.lastOrganizedAt, null);
    assert.equal(session.idleAttempts, 0, "idleAttempts 缺省仍为 0");
    assert.equal(session.lastOrganizeError, null);

    const writer = new StateStore(home);
    await writer.updateSession("s2", { lastSaveRatio: 0 });
    assert.equal(writer.getSession("s2").lastSaveRatio, 0, "显式写入 0 必须保留 0");
  } finally {
    await cleanup(home);
  }
});

/* --------------------------------------------------- triggers: 单套心跳 */

// registerTriggers 会注册两套 15 分钟间隔：startDiaryTimer 自己一套，兜底心跳一套。
// 这里抓出心跳回调，用注入的 runDiaryTask 计数，验证日记定时器已注册时心跳不再重复跑日记。
function captureHeartbeat() {
  let heartbeat = null;
  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    timer: {
      interval(fn) {
        heartbeat = fn;
        return () => {};
      },
    },
  };
  return { ctx, heartbeat: () => heartbeat };
}

test("P3-8：日记定时器已注册时心跳不再重复调 runDiary", async () => {
  const home = await newHome();
  const { ctx, heartbeat } = captureHeartbeat();
  const calls = [];
  const dispose = registerTriggers({
    ctx,
    home,
    config: resolveConfig({ homeDir: home, backup: { enabled: false }, forget: { enabled: false }, idle: { enabled: false } }),
    registry: { list: () => [] },
    state: {},
    runDiaryTask: async () => {
      calls.push("diary");
    },
  });
  try {
    assert.equal(typeof heartbeat(), "function", "兜底心跳仍要注册");
    await heartbeat()();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(calls, [], "startDiaryTimer 已返回函数，心跳不得再跑 runDiary");
  } finally {
    dispose();
    await cleanup(home);
  }
});

test("P3-8：日记定时器未注册时心跳兜底调 runDiary", async () => {
  const home = await newHome();
  const { ctx, heartbeat } = captureHeartbeat();
  const calls = [];
  // 没有 home → startDiaryTimer 返回 null（未注册），只有心跳这一套能跑日记。
  const dispose = registerTriggers({
    ctx,
    home: "",
    config: resolveConfig({ homeDir: home, backup: { enabled: false }, diary: { enabled: false }, forget: { enabled: false }, idle: { enabled: false } }),
    registry: { list: () => [] },
    state: {},
    runDiaryTask: async () => {
      calls.push("diary");
    },
  });
  try {
    await heartbeat()();
    assert.deepEqual(calls, ["diary"], "未注册日记定时器时心跳必须兜底");
  } finally {
    dispose();
    await cleanup(home);
  }
});

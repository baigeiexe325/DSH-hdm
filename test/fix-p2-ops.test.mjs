// P2 运维组回归测试：配置未知键、相同文本去重、hdm_save characters、/hdm-forget 后台化、迁移非空目标。
// 运行：node --test test/fix-p2-ops.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { apply } from "../lib/index.js";
import { resolveConfig } from "../lib/config.js";
import { noteUserActivity, pendingActivity, resetActivity } from "../lib/idle.js";
import { scheduleForgetPass, waitForBackgroundForget } from "../lib/forget.js";
import { migrateHome, readPointer, writePointer } from "../lib/migrate.js";
import { StateStore } from "../lib/state.js";
import { localDate } from "../lib/paths.js";

const DAY = 86_400_000;
const temps = [];

async function tmp(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** 每个用例独立指针文件，避免污染真实主目录。 */
async function usePointer() {
  const file = path.join(await tmp("hdm-p2-pointer-"), "pointer.json");
  process.env.HDM_HOME_POINTER = file;
  return file;
}

/** apply() 需要的最小宿主 ctx：注册表收集、可注入 commands 等服务、日志分桶。 */
function makeEnv() {
  const tools = new Map();
  const commands = new Map();
  const logs = { info: [], warn: [], error: [] };
  const record = (bucket) => (line) => bucket.push(String(line));
  const handlers = new Map();
  const sctxExtra = {};
  const base = {
    logger: { info: record(logs.info), warn: record(logs.warn), error: record(logs.error), debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    inject(names, callback) {
      callback({
        ...sctxExtra,
        ...base,
        provide() {},
        effect: base.effect,
        commands: {
          register(command) {
            commands.set(command.name, command);
            return () => {};
          },
        },
        skills: {
          register() {
            return () => {};
          },
        },
        systemPrompt: {
          section() {
            return () => {};
          },
        },
        typert: {
          register() {
            return () => {};
          },
        },
      });
    },
    timer: {
      interval() {
        return () => {};
      },
    },
    tokenMeter: { contextPressure: () => null },
    get() {
      return undefined;
    },
  };
  return { ctx: base, tools, commands, logs, handlers };
}

/** 关闭会额外写盘的定时任务，只保留被测能力。 */
function quietConfig(homeDir, extra = {}) {
  return {
    homeDir,
    diary: { enabled: false },
    forget: { enabled: false },
    idle: { enabled: false },
    backup: { enabled: false },
    ...extra,
  };
}

test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- P2-1 配置 */

test("P2-1: resolveConfig 未知键告警后丢弃，其余配置生效；类型/范围错误仍抛错", () => {
  const warns = [];
  const config = resolveConfig(
    {
      homeDir: os.tmpdir(),
      recall: { noSuchKey: 99, topK: 3 },
      mystery: 1,
    },
    { logger: { warn: (line) => warns.push(String(line)) } },
  );
  assert.deepEqual([...config.unknownKeys].sort(), ["mystery", "recall.noSuchKey"]);
  assert.equal("noSuchKey" in config.recall, false, "未知键必须被丢弃");
  assert.equal(config.recall.recencyWindowDays, 30, "recall.recencyWindowDays 是合法键，不该被丢弃");
  assert.equal(config.recall.topK, 3, "同一节里的合法键照常生效");
  assert.equal(config.save.threshold, 0.5, "其余配置保持默认");
  assert.equal(warns.length, 2, "每个未知键一条 warn");
  assert.ok(warns.some((line) => /recall\.noSuchKey.*不存在，已忽略/.test(line)), JSON.stringify(warns));

  // 真正的非法值（类型/范围）不能被吞成 warn：apply() 据此拒绝加载。
  assert.throws(() => resolveConfig({ save: { threshold: "0.5" } }), /save\.threshold.*number/);
  assert.throws(() => resolveConfig({ recall: { topK: 99 } }), /recall\.topK.*范围/);
  assert.throws(() => resolveConfig({ timeZone: "Not/AZone" }), /时区/);
});

test("P2-1: 未知键不再让整个插件消失，/hdm 列出已忽略键；非法值仍拒绝加载", async () => {
  await usePointer();
  const home = await tmp("hdm-p2-home-");
  const env = makeEnv();
  await apply(env.ctx, quietConfig(home, { recall: { noSuchKey: 99 }, mystery: 1 }));

  assert.ok(env.tools.size >= 6, `未知键不应阻止工具注册，实际 ${env.tools.size}`);
  assert.ok(env.commands.has("hdm"), "命令照常注册，用户有自救入口");
  assert.ok(env.logs.warn.some((line) => /recall\.noSuchKey.*不存在，已忽略/.test(line)), JSON.stringify(env.logs.warn));

  const status = await env.commands.get("hdm").handler({ rawInput: "" });
  assert.match(status.text, /已忽略的配置键：.*recall\.noSuchKey/);

  // 非法值仍走拒绝加载（不是 warn）。
  const badHome = await tmp("hdm-p2-home-");
  const badEnv = makeEnv();
  await apply(badEnv.ctx, quietConfig(badHome, { diary: { enabled: false, time: "25:99" } }));
  assert.equal(badEnv.tools.size, 0, "非法值应拒绝注册任何工具");
  assert.ok(badEnv.logs.error.some((line) => /invalid config.*diary\.time/.test(line)), JSON.stringify(badEnv.logs.error));
});

/* --------------------------------------------------------------- P2-2 去重 */

test("P2-2: 连续相同文本（含 total 增长）不推水位线，不同文本正常计", () => {
  const home = path.join(os.tmpdir(), `hdm-p2-idle-${process.pid}`);
  resetActivity(home);
  try {
    const first = noteUserActivity({ home, sessionId: "s", text: "继续", now: 1000, total: 1 });
    assert.equal(first.duplicate, undefined);
    assert.equal(first.count, 1);
    // 同一文本、total 还涨了（真实第二条「继续」）：仍按重复处理，不推水位、不计数。
    const again = noteUserActivity({ home, sessionId: "s", text: "继续", now: 2000, total: 2 });
    assert.equal(again.duplicate, true);
    assert.equal(pendingActivity({ home, sessionId: "s" }).lastAt, 1000, "重复不得推进水位线");
    assert.equal(pendingActivity({ home, sessionId: "s" }).count, 1, "重复不得增加条数");
    // 不同文本照常入队。
    const next = noteUserActivity({ home, sessionId: "s", text: "换个话题", now: 3000, total: 3 });
    assert.notEqual(next.duplicate, true);
    assert.equal(pendingActivity({ home, sessionId: "s" }).lastAt, 3000);
    // 来源不同不算重复（文本 + 来源 才是去重键）。
    const otherSource = noteUserActivity({ home, sessionId: "s", text: "换个话题", now: 4000, total: 4, source: "plugin" });
    assert.notEqual(otherSource.duplicate, true);
  } finally {
    resetActivity(home);
  }
});

test("P2-2: pre-step 连续相同文本不推 lastUserAt", async () => {
  await usePointer();
  const home = await tmp("hdm-p2-prestep-");
  const env = makeEnv();
  await apply(env.ctx, quietConfig(home));
  const handler = env.handlers.get("agent/pre-step")[0];
  const session = { id: "s-dup-pre", subagent: false, ownEvents: () => [] };
  const payload = {
    agent: { id: "s-dup-pre", session },
    step: 1,
    turn: 1,
    decision: { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "继续" }] }] },
  };
  const next = async () => payload.decision;
  await handler(payload, next);
  const first = JSON.parse(await readFile(path.join(home, "state", "sessions.json"), "utf8")).sessions["s-dup-pre"];
  assert.ok(first.lastUserAt > 0, "第一次发言应记录水位");
  assert.equal(first.activity.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 8));
  await handler(payload, next);
  const second = JSON.parse(await readFile(path.join(home, "state", "sessions.json"), "utf8")).sessions["s-dup-pre"];
  assert.equal(second.lastUserAt, first.lastUserAt, "相同文本连续重复不得推进水位线");
  assert.equal(second.userMessageCount, first.userMessageCount, "条数不涨");
  assert.equal(second.activity.length, 1, "活动环不重复追加");
});

/* ------------------------------------------------------------- P2-3 characters */

test("P2-3: hdm_save 只传 characters 也会写人物档案（notes/section/confidence）", async () => {
  await usePointer();
  const home = await tmp("hdm-p2-char-");
  const env = makeEnv();
  await apply(env.ctx, quietConfig(home));
  const tool = env.tools.get("hdm_save");
  const exec = { agent: { session: { header: { id: "s-char", cwd: home, createdAt: Date.now() } } } };

  const saved = await tool.execute(
    {
      summary: "检修测试：只传 characters 也要写进人物档案",
      keywords: ["人物", "档案", "characters", "去重", "上限", "顺序", "测试", "保存", "回归", "配置"],
      characters: [{ name: "小明", notes: "偏好先跑测试再报结论", section: "偏好与语气", confidence: 0.9 }],
    },
    exec,
  );
  assert.equal(saved.ok, true);
  // characters 里的姓名要并入 people：meta.people 必须带上「小明」。
  const meta = JSON.parse(await readFile(path.join(saved.folder, "meta.json"), "utf8"));
  assert.deepEqual(meta.people, ["小明"], "characters 姓名应并入 people");
  const profile = await readFile(path.join(home, "characters", "小明.md"), "utf8");
  assert.match(profile, /偏好先跑测试再报结论/, "notes 必须写入档案");
  assert.match(profile, /## 偏好与语气/, "section 必须写入档案");
  assert.match(profile, /置信度: 0\.9/, "confidence 必须写入档案");

  // name 缺失：跳过并 warn，不阻断保存。
  const warnBefore = env.logs.warn.length;
  const noName = await tool.execute(
    {
      summary: "检修测试：characters 缺少 name 时跳过并告警",
      keywords: ["缺陷", "姓名", "跳过", "告警", "保存", "人物", "档案", "回归", "测试", "配置"],
      characters: [{ notes: "没有姓名" }],
    },
    exec,
  );
  assert.equal(noName.ok, true);
  assert.ok(env.logs.warn.slice(warnBefore).some((line) => /characters 条目缺少 name/.test(line)), JSON.stringify(env.logs.warn));
});

/* ------------------------------------------------------------- P2-4 后台遗忘 */

test("P2-4: scheduleForgetPass 立即返回并后台完成，结果写进 jobs", async () => {
  await usePointer();
  const home = await tmp("hdm-p2-forget-");
  const folder = path.join(home, "memory", "2026-11-26", "2_2026-11-26_s_01_x_k");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "level2.txt"), "## 摘要\n旧摘要\n", "utf8");
  const meta = {
    uid: "m-p2-bg-001",
    date: localDate(Date.now() - 2 * DAY),
    label: "2_2026-11-26_s_01_x_k",
    folder,
    defaultLevel: 2,
    snapshots: [2],
    hitCount: 0,
  };
  const registry = {
    list: () => [meta],
    upsert: async () => {},
  };
  const state = new StateStore(home);
  await state.load();
  const memory = {
    async readSnapshot() {
      return { level: 2, text: "## 摘要\n旧摘要\n" };
    },
    deriveSnapshotData() {
      return { level: 1, summary: "压缩后的摘要", details: [], quotes: [], keywords: [] };
    },
    async commitDerivedSnapshot({ meta: target }) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      target.snapshots = [...(target.snapshots ?? []), 1];
      return target;
    },
  };

  const scheduled = scheduleForgetPass({
    ctx: { logger: { warn() {}, info() {} } },
    home,
    config: { forget: { enabled: true, days: [2, 5], respectImmortal: true }, timeZone: "Asia/Shanghai" },
    registry,
    state,
    memory,
    target: "all",
    now: Date.now(),
  });
  assert.equal(scheduled.queued, true);
  assert.equal(state.getJobs().lastForget, undefined, "命令返回时后台巡检还没跑完（未 await）");
  const concurrent = scheduleForgetPass({ home, config: { forget: { enabled: true } }, registry, state, memory, target: "all" });
  assert.equal(concurrent.queued, false, "已有后台巡检时不得再排一个");
  assert.equal(concurrent.reason, "running");

  await scheduled.task;
  const jobs = state.getJobs();
  assert.ok(jobs.lastForgetAt > 0, "jobs 应记录最近一次遗忘时间");
  assert.equal(jobs.lastForget.processed, 1);
  assert.equal(jobs.lastForget.ok, 1);
  assert.equal(jobs.lastForget.target, "all");
});

test("P2-4: /hdm-forget 命令立即返回「已排入后台」，/hdm 显示最近一次遗忘", async () => {
  await usePointer();
  const home = await tmp("hdm-p2-forget-cmd-");
  const env = makeEnv();
  await apply(env.ctx, quietConfig(home, { forget: { enabled: true, checkHours: 6 } }));

  const result = await env.commands.get("hdm-forget").handler({ rawInput: "due" });
  assert.equal(result.kind, "success");
  assert.match(result.text, /已排入后台/);
  assert.doesNotMatch(result.text, /遗忘巡检完成/, "不再假装巡检已完成");

  await waitForBackgroundForget();
  const status = await env.commands.get("hdm").handler({ rawInput: "" });
  assert.match(status.text, /最近遗忘: .*处理 \d+ 条，成功 \d+ 条/);
});

/* --------------------------------------------------------------- P2-5 迁移 */

test("P2-5: 迁移目标非空时拒绝，旧库 meta.folder 与目标文件都不动", async () => {
  await usePointer();
  const oldHome = await tmp("hdm-p2-mig-old-");
  const memFolder = path.join(oldHome, "memory", "2026-11-01", "2_2026-11-01_s_01_x_k");
  await mkdir(memFolder, { recursive: true });
  const metaFile = path.join(memFolder, "meta.json");
  await writeFile(metaFile, JSON.stringify({ uid: "m-mig-001", folder: memFolder }, null, 2), "utf8");
  await writeFile(path.join(oldHome, "IAM.md"), "# IAM\n旧库\n", "utf8");

  const target = await tmp("hdm-p2-mig-target-");
  await writeFile(path.join(target, "IAM.md"), "目标旧文件（较旧/半截）\n", "utf8");

  const before = JSON.parse(await readFile(metaFile, "utf8"));
  const result = await migrateHome(oldHome, target);
  assert.equal(result.migrated, false);
  assert.equal(result.mode, "target-not-empty");
  assert.equal(JSON.parse(await readFile(metaFile, "utf8")).folder, before.folder, "meta.folder 必须保持旧库路径");
  assert.equal(await readFile(path.join(target, "IAM.md"), "utf8"), "目标旧文件（较旧/半截）\n", "目标旧文件不得被覆盖");
  assert.equal(await readFile(path.join(oldHome, "IAM.md"), "utf8"), "# IAM\n旧库\n", "旧库必须完好");

  // apply 侧：指针指向旧库、homeDir 指向非空目标 → 打印清晰原因、不迁移、指针不变。
  const pointer = await usePointer();
  await writePointer(oldHome, pointer);
  const env = makeEnv();
  await apply(env.ctx, quietConfig(target));
  assert.ok(
    env.logs.error.some((line) => /拒绝迁移母文件夹：目标目录 .* 非空/.test(line)),
    JSON.stringify(env.logs.error),
  );
  assert.equal(path.resolve((await readPointer(pointer)).homeDir), path.resolve(oldHome), "指针必须仍指向旧库");
  // 拒绝迁移 ≠ 插件消失：本次回退到旧库继续跑，否则用户只会看到「HDM 没了」。
  assert.ok(env.tools.size > 0, "迁移被拒时仍应注册工具，只是 home 回退到旧库");
  assert.ok(
    env.logs.warn.some((line) => /本次会话使用旧库运行/.test(line)),
    JSON.stringify(env.logs.warn),
  );
  assert.equal(await readFile(path.join(target, "IAM.md"), "utf8"), "目标旧文件（较旧/半截）\n", "目标内容保持原样");
});

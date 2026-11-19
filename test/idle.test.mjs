// 空闲对话自动整理：窗口门槛、去重、解析、同一编码续写与重开 L2。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfig } from "../lib/config.js";
import {
  activityToPersist,
  idleWindowMs,
  startIdleOrganizeTimer,
  noteUserActivity,
  organizeSession,
  parseOrganizeOutput,
  pendingActivity,
  readMaintenanceLog,
  resetActivity,
  seedFromSession,
  seedRingsFromState,
  shouldOrganize,
} from "../lib/idle.js";
import { resolveMaintenanceModel, streamText } from "../lib/llm.js";
import { Registry } from "../lib/registry.js";
import { StateStore } from "../lib/state.js";

const MINUTE = 60_000;

const MEMORY_JSON = JSON.stringify({
  summary: "用户要求把 HDM 的空闲整理改成可在面板调整，并保留同一编码续写。",
  details: ["窗口默认 180 分钟到 12 小时", "没有新增用户发言就不重复整理"],
  keywords: ["HDM", "空闲整理", "面板", "同一编码", "窗口", "维护模型", "提示词", "去重", "日志", "测试"],
  people: [],
  scene: "H:\\DSH WorkZone",
  event: "HDM 空闲整理",
  emotion: "",
  importance: 3,
});

// 追加记忆专用：关键词与首次完全不重叠，用来验证「新词能进 top-12」。
const APPEND_JSON = JSON.stringify({
  summary: "用户又补了预算与超时要求：维护调用的 token 预算要可配，超时必须能覆盖长输出。",
  details: ["预算与超时都要进设置面板", "超时不够会让长输出直接失败"],
  keywords: ["预算", "超时", "降级", "关键词", "追加", "快照", "摘要", "排序", "权重", "设置"],
  people: [],
  scene: "H:\\\\DSH WorkZone",
  event: "HDM 预算与超时",
  emotion: "",
  importance: 3,
});

async function makeEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-idle-"));
  const config = resolveConfig({ homeDir: home, maintenance: { provider: "test", model: "test-1" } });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  return { home, config, registry, state };
}

function fakeCtx(reply = MEMORY_JSON) {
  const calls = [];
  return {
    calls,
    logger: { warn() {}, info() {}, error() {} },
    llm: {
      async stream(request) {
        calls.push(request);
        if (typeof reply === "function") return reply(request);
        return reply;
      },
    },
  };
}

async function cleanup(home) {
  resetActivity(home);
  // tick 触发的是 void runIdleScan：断言通过时它可能还在写 state/index。
  // Windows 上立刻删会拿到 ENOTEMPTY/EBUSY，重试比加 sleep 稳。
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test("idleWindowMs：默认 [180min, 720min)，非法值有兜底", () => {
  const config = resolveConfig({});
  const { minMs, maxMs } = idleWindowMs(config);
  assert.equal(minMs, 180 * MINUTE);
  assert.equal(maxMs, 720 * MINUTE);
  const broken = idleWindowMs({ idle: { idleMinutes: 0, maxIdleMinutes: 0 } });
  assert.equal(broken.minMs, 180 * MINUTE);
  assert.equal(broken.maxMs, 720 * MINUTE, "非法值回落到默认窗口，而不是塌成 min+1");
  const inverted = idleWindowMs({ idle: { idleMinutes: 600, maxIdleMinutes: 300 } });
  assert.equal(inverted.maxMs, 601 * MINUTE, "上限小于下限时退化为下限+1 分钟");
});

test("shouldOrganize：窗口边界 179/180/719/720 分钟", () => {
  const config = resolveConfig({});
  const session = { lastOrganizedAt: null };
  const activityAt = Date.UTC(2026, 10, 8, 2, 0, 0);
  const entry = { lastAt: activityAt, count: 3, messages: [{ at: activityAt - 1000, text: "你好" }] };
  const at = (minutes) => ({ config, session, entry, now: activityAt + minutes * MINUTE });

  assert.equal(shouldOrganize(at(179)).reason, "too-recent");
  assert.equal(shouldOrganize(at(180)).ok, true);
  assert.equal(shouldOrganize(at(719)).ok, true);
  assert.equal(shouldOrganize(at(720)).reason, "too-stale");
  assert.equal(shouldOrganize({ ...at(200), force: true }).ok, true);
});

test("shouldOrganize：禁用 / 消息过少 / 无新增 / 最小间隔", () => {
  const config = resolveConfig({ idle: { minUserMessages: 2, minIntervalMinutes: 60 } });
  const activityAt = Date.UTC(2026, 10, 8, 2, 0, 0);
  const now = activityAt + 200 * MINUTE;
  const entry = { lastAt: activityAt, count: 2, messages: [{ at: activityAt - 5000, text: "早" }] };

  assert.equal(shouldOrganize({ config, session: { lastOrganizedAt: activityAt }, entry, now }).reason, "no-new-dialogue");
  assert.equal(shouldOrganize({ config, session: {}, entry: { ...entry, count: 1 }, now }).reason, "too-few-messages");
  assert.equal(
    shouldOrganize({ config: resolveConfig({ idle: { enabled: false } }), session: {}, entry, now }).reason,
    "disabled",
  );
  assert.equal(
    shouldOrganize({
      config,
      session: { lastOrganizedAt: now - 10 * MINUTE },
      entry: { ...entry, messages: [...entry.messages, { at: now - 5 * MINUTE, text: "刚说的" }] },
      now,
    }).reason,
    "min-interval",
  );
  assert.equal(shouldOrganize({ config, session: {}, entry: null, now }).reason, "no-activity");
});

test("noteUserActivity：按权威条数去重，seedFromSession 回填", () => {
  const home = path.join(os.tmpdir(), "hdm-idle-note");
  resetActivity(home);
  noteUserActivity({ home, sessionId: "s", text: "第一条", now: 1000, total: 1 });
  const dup = noteUserActivity({ home, sessionId: "s", text: "第一条", now: 1001, total: 1 });
  assert.equal(dup.duplicate, true);
  noteUserActivity({ home, sessionId: "s", text: "第二条", now: 2000, total: 2 });
  assert.deepEqual(pendingActivity({ home, sessionId: "s" }), {
    lastAt: 2000,
    count: 2,
    messages: 2,
    lastMessage: { at: 2000, text: "第二条" },
  });

  resetActivity(home);
  const session = {
    ownEvents: () => [
      { type: "user/message", at: 100, data: { source: { kind: "user" }, content: [{ type: "text", text: "事件一" }] } },
      { type: "user/message", at: 200, data: { source: { kind: "plugin:hdm" }, content: [{ type: "text", text: "注入" }] } },
      { type: "user/message", at: 300, data: { source: { kind: "user" }, content: [{ type: "text", text: "事件二" }] } },
    ],
  };
  const seeded = seedFromSession({ home, sessionId: "s2", session });
  assert.deepEqual(seeded, { total: 2, lastAt: 300 });
  assert.equal(pendingActivity({ home, sessionId: "s2" }).count, 2);
  resetActivity(home);
});

test("parseOrganizeOutput：skip / 合法 JSON / 代码块 / 非法输出", () => {
  assert.deepEqual(parseOrganizeOutput('{"skip":true,"reason":"重复"}'), { skip: true, reason: "重复" });
  const ok = parseOrganizeOutput(`\`\`\`json\n${MEMORY_JSON}\n\`\`\``);
  assert.equal(ok.skip, false);
  assert.equal(ok.input.keywords.length, 10);
  assert.throws(() => parseOrganizeOutput("不是 json"), /JSON/);
  assert.throws(() => parseOrganizeOutput('{"summary":"太短","keywords":[]}'), /summary|keyword/);
});

test("organizeSession：调用预算与超时全部来自配置", async () => {
  const env = await makeEnv();
  const ctx = fakeCtx();
  try {
    const now = Date.UTC(2026, 10, 8, 7, 0, 0);
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "budget", text: "预算要可配", now: now - 60_000, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "budget", text: "默认十万 token", now: now - 30_000, total: 2 });

    const config = resolveConfig({
      homeDir: env.home,
      maintenance: { provider: "test", model: "test-1", maxTokens: 12345, timeoutSeconds: 90 },
    });
    const result = await organizeSession({ ...env, ctx, config, sessionId: "budget", force: true, now });
    assert.equal(result.ok, true);
    assert.equal(ctx.calls.length, 1);
    // 传的是配置值，不是硬编码；用 12345 避免把 100000 写死进断言。
    assert.equal(ctx.calls[0].maxTokens, 12345);
    assert.ok(ctx.calls[0].signal, "配置超时必须以 AbortSignal 传给宿主，否则 10 万 token 会先超时失败");
  } finally {
    await cleanup(env.home);
  }
});

test("organizeSession：首次新建并固定，无新增跳过，再整理并入同一编码，派生后标记待重派生", async () => {
  const env = await makeEnv();
  // 第一次新建用 MEMORY_JSON，追加时换一组完全不同的关键词，专门盯 top-12 的排序。
  const ctx = fakeCtx((request, index) => (index === 0 ? MEMORY_JSON : APPEND_JSON));
  try {
    const now = Date.UTC(2026, 10, 8, 6, 0, 0);
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "s1", text: "把空闲整理做成可配置的", now: now - 60_000, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "s1", text: "窗口默认 3 小时到 12 小时", now: now - 30_000, total: 2 });

    // 1) 首次整理：新建单元 + pin + 日志
    const first = await organizeSession({ ...env, ctx, sessionId: "s1", force: true, now });
    assert.equal(first.ok, true);
    assert.equal(first.merged, false);
    const uid = first.uid;
    assert.ok(env.registry.get(uid));
    assert.equal(env.state.getSession("s1").memoryUid, uid);
    assert.equal(env.state.getSession("s1").pinConversation, true);
    assert.equal(env.state.getSession("s1").lastOrganizedAt, now);
    const log1 = await readMaintenanceLog(env.home, 10);
    assert.equal(log1.length, 1);
    assert.equal(log1[0].result, "ok");
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0].system, /严格 JSON|JSON/);

    // 2) 没有新增用户发言：不整理
    const second = await organizeSession({ ...env, ctx, sessionId: "s1", force: true, now: now + 5 * MINUTE });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "no-new-dialogue");
    assert.equal(ctx.calls.length, 1);

    // 3) 有新发言：并入同一个 uid
    noteUserActivity({ home: env.home, sessionId: "s1", text: "再加一个扫描间隔", now: now + 9 * MINUTE, total: 3 });
    const third = await organizeSession({ ...env, ctx, sessionId: "s1", force: true, now: now + 10 * MINUTE });
    assert.equal(third.ok, true);
    assert.equal(third.merged, true);
    assert.equal(third.uid, uid);

    // 4) 已派生 L1：下一次整理只打「待重派生」标记，派生档与默认档都保留
    const meta = env.registry.get(uid);
    meta.snapshots = [2, 1];
    meta.defaultLevel = 1;
    meta.forget = { ...(meta.forget ?? {}), d2: "2026-11-09T00:00:00.000Z" };
    await env.registry.upsert(meta);
    noteUserActivity({ home: env.home, sessionId: "s1", text: "重开 L2 后再追加", now: now + 19 * MINUTE, total: 4 });
    const fourth = await organizeSession({ ...env, ctx, sessionId: "s1", force: true, now: now + 20 * MINUTE });
    assert.equal(fourth.ok, true);
    assert.equal(fourth.uid, uid);

    const after = env.registry.get(uid);
    assert.ok(after.snapshots.includes(1), "派生档 L1 保留，不再删除重开 L2");
    assert.equal(after.defaultLevel, 1, "派生档默认档不重置");
    assert.equal(after.needsRederive, 1, "改打 needsRederive 标记，由遗忘巡检重派发");
    assert.equal(after.forget.d2, null);
    assert.ok(!after.reopenCount, "不再重开 L2，reopenCount 不应增长");
    const text = await readFile(path.join(after.folder, "level2.txt"), "utf8");
    assert.doesNotMatch(text, /追加记忆 #/, "同日追加应原地改写，不再新增说明段");
    assert.match(text, /## 摘要/, "应保留单文档结构");
    assert.equal((text.match(/## 摘要/g) || []).length, 1, "同一单元只能有一个 ## 摘要");
  } finally {
    await cleanup(env.home);
  }
});

test("organizeSession：无可用维护模型时推进水位线，同一批增量只尝试一次", async () => {
  const env = await makeEnv();
  // 没有配置维护模型、ctx 也拿不到默认模型 → resolveMaintenanceModel 返回 null。
  const ctx = { logger: { warn() {}, info() {}, error() {} }, get: () => undefined };
  const config = resolveConfig({ homeDir: env.home });
  try {
    const now = Date.UTC(2026, 10, 8, 6, 0, 0);
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "nm1", text: "没模型也要留痕", now: now - 60_000, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "nm1", text: "第二次扫描不能再重试", now: now - 30_000, total: 2 });

    const first = await organizeSession({ ...env, ctx, config, sessionId: "nm1", force: true, now });
    assert.equal(first.ok, false);
    assert.equal(first.reason, "no-model");
    // 水位线必须推进到已消费的最后一条发言之后，否则每次扫描都重试同一批增量。
    assert.equal(env.state.getSession("nm1").lastOrganizedAt, now);
    assert.equal(env.state.getSession("nm1").lastOrganizeError, "没有可用的维护模型");
    const rows = await readMaintenanceLog(env.home, 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "no-model");

    const second = await organizeSession({ ...env, ctx, config, sessionId: "nm1", force: true, now: now + MINUTE });
    assert.equal(second.reason, "no-new-dialogue", "同一批增量不应重复烧模型");
    assert.equal((await readMaintenanceLog(env.home, 5)).length, 1, "第二次不应再写 no-model 日志");
  } finally {
    await cleanup(env.home);
  }
});

test("startIdleOrganizeTimer：宿主 timer 的 tick 会整理窗口内的会话，dispose 后停止", async () => {
  const env = await makeEnv();
  const ctx = fakeCtx();
  let tick = null;
  let disposed = false;
  const hostCtx = {
    ...ctx,
    timer: {
      interval(fn) {
        tick = fn;
        return () => {
          disposed = true;
        };
      },
    },
  };
  try {
    const activityAt = Date.now() - 200 * MINUTE;
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "t1", text: "定时器第一条", now: activityAt, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "t1", text: "定时器第二条", now: activityAt + 1000, total: 2 });

    const stop = startIdleOrganizeTimer({
      ctx: hostCtx,
      home: env.home,
      config: env.config,
      registry: env.registry,
      state: env.state,
    });
    assert.equal(typeof tick, "function", "通过 ctx.timer.interval 注册了 tick");

    tick();
    // tick 内部是 void runIdleScan(...)：轮询等它落盘，而不是靠固定 sleep 猜时间。
    for (let i = 0; i < 60 && env.registry.list().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(env.registry.list().length, 1, "tick 应整理出一条记忆");
    // 日志最后写：等到它出现，说明这次扫描已经收尾，清理不会和写盘撞车。
    for (let i = 0; i < 60 && (await readMaintenanceLog(env.home, 5)).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(env.state.getSession("t1").pinConversation, true);

    stop();
    assert.equal(disposed, true, "dispose 会调用宿主 timer 的清理函数");
  } finally {
    resetActivity(env.home);
    await cleanup(env.home);
  }
});

test("维护模型解析：根 ctx 只能通过 ctx.get 拿服务时也要找到模型并可流式调用", async () => {
  const calls = [];
  const root = {
    // 真实插件只声明 inject:["tools"]，llm / agentDefaultModel 只能这样取。
    get(name) {
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p1", model: "m1" }) };
      if (name === "llm") {
        return {
          async stream(request) {
            calls.push(request);
            return "模型输出";
          },
        };
      }
      return undefined;
    },
  };
  const model = await resolveMaintenanceModel(root, {});
  assert.deepEqual(model, { provider: "p1", model: "m1" });
  assert.equal(await streamText(root, model, { system: "s", messages: [] }), "模型输出");
  assert.equal(calls.length, 1);

  // 会话 header 优先于默认选择；配置又优先于会话。
  const session = { requestHeader: async () => ({ config: { provider: "p2", model: "m2" } }) };
  assert.deepEqual(await resolveMaintenanceModel(root, {}, { session }), { provider: "p2", model: "m2" });
  assert.deepEqual(
    await resolveMaintenanceModel(root, { maintenance: { provider: "cfg", model: "cfg-1" } }, { session }),
    { provider: "cfg", model: "cfg-1" },
  );
});

test("organizeSession：预算耗尽与模型失败都留痕且不重试", async () => {
  const env = await makeEnv();
  try {
    const now = Date.UTC(2026, 10, 8, 6, 0, 0);
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "b1", text: "预算测试一", now, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "b1", text: "预算测试二", now: now + 1, total: 2 });
    const ctx = fakeCtx(() => {
      throw new Error("模型挂了");
    });
    const failed = await organizeSession({ ...env, ctx, sessionId: "b1", force: true, now });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "error");
    assert.equal(env.state.getSession("b1").idleAttempts, 1);
    assert.match(env.state.getSession("b1").lastOrganizeError, /模型挂了/);
    const rows = await readMaintenanceLog(env.home, 5);
    assert.equal(rows[0].result, "fail");

    // 失败后水位线已推进：同一批增量不会被再次提交给模型
    const again = await organizeSession({ ...env, ctx, sessionId: "b1", force: true, now: now + MINUTE });
    assert.equal(again.reason, "no-new-dialogue");

    // 每日预算：窗口内的第二次整理被预算挡下
    const limited = resolveConfig({
      homeDir: env.home,
      maintenance: { provider: "test", model: "test-1" },
      idle: { maxRunsPerDay: 1 },
    });
    const base = now + 300 * MINUTE;
    const runAt = base + 200 * MINUTE;
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "b2", text: "预算一", now: base, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "b2", text: "预算二", now: base + 1, total: 2 });
    await organizeSession({ ...env, ctx: fakeCtx(), config: limited, registry: env.registry, state: env.state, sessionId: "b2", now: runAt });
    resetActivity(env.home);
    noteUserActivity({ home: env.home, sessionId: "b3", text: "预算三", now: base, total: 1 });
    noteUserActivity({ home: env.home, sessionId: "b3", text: "预算四", now: base + 1, total: 2 });
    const blocked = await organizeSession({ ...env, ctx: fakeCtx(), config: limited, registry: env.registry, state: env.state, sessionId: "b3", now: runAt });
    assert.equal(blocked.reason, "daily-budget");
  } finally {
    await cleanup(env.home);
  }
});

test("seedRingsFromState：reload 后从持久化活动环捞回旧会话；activityToPersist 截断", async () => {
  const env = await makeEnv();
  try {
    const now = Date.now();
    const at = now - 200 * MINUTE; // 200 分钟前发言 → 落在 [180,720) 窗口内
    await env.state.updateSession("sess-old", {
      lastUserAt: at,
      userMessageCount: 3,
      activity: [
        { at: at - 1000, text: "第一句" },
        { at, text: "第二句" },
      ],
    });
    // 模拟 reload：内存环里没有这个会话
    resetActivity(env.home);
    assert.equal(pendingActivity({ home: env.home, sessionId: "sess-old" }), null);

    const seeded = seedRingsFromState({ home: env.home, state: env.state });
    assert.ok(seeded >= 1, "应从持久化活动环回灌");
    const entry = pendingActivity({ home: env.home, sessionId: "sess-old" });
    assert.ok(entry, "回灌后可见");
    assert.equal(entry.lastAt, at, "水位取最后一条发言时间");
    assert.equal(entry.count, 3, "条数取持久化的 userMessageCount");

    // 回灌后 shouldOrganize 才会把它当候选，而不是「没被看到」
    const decision = shouldOrganize({
      config: env.config,
      session: env.state.getSession("sess-old"),
      entry: { ...entry, messages: [{ at, text: "第二句" }] },
      now,
    });
    assert.equal(decision.ok, true, JSON.stringify(decision));

    // 落盘环有上限：超长文本被截断、条数被裁剪
    const long = "x".repeat(2000);
    const persisted = activityToPersist({ messages: Array.from({ length: 30 }, (_, i) => ({ at: i, text: long })) });
    assert.equal(persisted.length, 20, "落盘只保留 20 条");
    assert.equal(persisted[0].text.length, 800, "单条截断到 800 字");
  } finally {
    await cleanup(env.home);
  }
});

test("noteUserActivity：条数未涨但内容不同必须入队（pre-step 的 total 是旧值）", () => {
  const home = path.join(os.tmpdir(), "hdm-idle-stale-total");
  resetActivity(home);
  // 真实场景：pre-step 时当前消息还没落到会话事件里，priorUserCount 返回的是上一轮的条数。
  noteUserActivity({ home, sessionId: "s", text: "第一句", now: 1000, total: 5 });
  const second = noteUserActivity({ home, sessionId: "s", text: "第二句", now: 2000, total: 5 });
  assert.notEqual(second.duplicate, true, "条数没涨但文本不同，不是重复");
  assert.equal(second.lastAt, 2000, "水位必须推进");
  const third = noteUserActivity({ home, sessionId: "s", text: "第三句", now: 3000, total: 5 });
  assert.notEqual(third.duplicate, true);
  assert.equal(third.count, 7, "计数按 max(count+1, expected) 推进");
  // 完全相同的文本 + 条数没涨 → 才算重复
  const dup = noteUserActivity({ home, sessionId: "s", text: "第三句", now: 4000, total: 5 });
  assert.equal(dup.duplicate, true);
  assert.equal(pendingActivity({ home, sessionId: "s" }).lastAt, 3000, "重复时不推进水位");
  resetActivity(home);
});

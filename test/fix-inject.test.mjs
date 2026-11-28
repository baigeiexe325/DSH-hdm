// 注入/共享/检索记账三处的回归测试（对应 docs/review/injection.md、recall.md、ops.md 的 P1）。
// 全程临时目录 + fake ctx/state，不碰真实母文件夹。
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { apply } from "../lib/index.js";
import { buildAutoRecall, buildPreStepDecision } from "../lib/injection.js";
import { readPointer, writePointer } from "../lib/migrate.js";
import { takeSharingQueue } from "../lib/sharing.js";
import { registerTriggers } from "../lib/triggers.js";

process.env.HDM_HOME_POINTER = path.join(os.tmpdir(), `hdm-fix-inject-pointer-${process.pid}.json`);

const ROOT = await mkdtemp(path.join(os.tmpdir(), "hdm-fix-inject-"));
const NOW = Date.parse("2026-11-28T12:00:00Z");

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(process.env.HDM_HOME_POINTER, { force: true });
});

/* ------------------------------------------------------------------ */
/* 两套提醒：nudges 与 saveReminders 各自计数、同轮互斥                  */
/* ------------------------------------------------------------------ */

function preStepConfig({ nudge, save } = {}) {
  return {
    autoRecall: { enabled: false, level: 0, vocabChars: 0 },
    iam: { inject: false, anchorEveryTurns: 0, maxChars: 6000 },
    handoff: { enabled: false },
    characters: { injectOnRecall: false },
    events: { enabled: false },
    sharing: { enabled: false, level: 0 },
    save: save ?? { threshold: 0.5, step: 0.15, maxPerSession: 4 },
    nudge: nudge ?? { enabled: false, everyUserTurns: 1, staleMinutes: 0, maxPerSession: 1 },
  };
}

function fakeNudgeState(seed = {}) {
  const session = { iamInjected: true, pendingContextReinject: false, uids: [], ...seed };
  return {
    session,
    getSession: () => session,
    updateSession: async (_id, patch) => Object.assign(session, patch),
  };
}

async function runUserStep({ config, state, ratio }) {
  const ctx = {
    tokenMeter: {
      contextPressure: () => (ratio == null ? null : { pressureTokens: ratio, contextWindow: 1 }),
    },
  };
  const out = await buildPreStepDecision({
    ctx,
    home: path.join(ROOT, "nudge-home"),
    config,
    registry: { list: () => [], get: () => null },
    state,
    agent: { session: { id: "s-nudge", header: { id: "s-nudge", origin: "user" } } },
    decision: {
      kind: "enter",
      messages: [{ id: "u-1", role: "user", content: [{ type: "text", text: "继续" }], source: { kind: "user" } }],
    },
    now: NOW,
    step: 1,
    turn: 1,
  });
  return out.messages
    .filter((m) => m.source?.kind === "plugin:hdm")
    .flatMap((m) => m.content.map((block) => block.text))
    .join("\n");
}

test("提醒：save 压力提醒吃满自己的预算后，nudge 仍能按自己的上限触发一次", async () => {
  const state = fakeNudgeState();
  const saveOnly = preStepConfig(); // nudge 关闭，只跑 save 压力提醒
  assert.match(await runUserStep({ config: saveOnly, state, ratio: 0.6 }), /上下文已达阈值/);
  assert.match(await runUserStep({ config: saveOnly, state, ratio: 0.8 }), /上下文已达阈值/);
  assert.equal(state.session.saveReminders, 2, "save 提醒记在自己的计数器上");
  assert.equal(state.session.nudges, 0);

  const withNudge = preStepConfig({ nudge: { enabled: true, everyUserTurns: 1, staleMinutes: 0, maxPerSession: 1 } });
  const text = await runUserStep({ config: withNudge, state, ratio: 0.99 });
  assert.match(text, /已持续多轮且尚未保存/, "save 提醒不该吃掉 nudge 的 maxPerSession");
  assert.equal(state.session.nudges, 1);
});

test("提醒：同一轮 nudge 与 save 压力提醒互斥，只插一条", async () => {
  const state = fakeNudgeState({ userTurnsSinceMemory: 5 });
  const config = preStepConfig({ nudge: { enabled: true, everyUserTurns: 1, staleMinutes: 0, maxPerSession: 5 } });
  const text = await runUserStep({ config, state, ratio: 0.9 });
  const hits = [/已持续多轮且尚未保存/, /上下文已达阈值/].filter((re) => re.test(text)).length;
  assert.equal(hits, 1, `同一轮只应有一条提醒：${text}`);
});

test("提醒：旧状态文件只有 nudges 时按 nudge 计数读，不占 save 预算", async () => {
  const state = fakeNudgeState({ nudges: 2, userTurnsSinceMemory: 5, remindedBands: [] });
  const config = preStepConfig({ nudge: { enabled: true, everyUserTurns: 1, staleMinutes: 0, maxPerSession: 2 } });
  const text = await runUserStep({ config, state, ratio: 0.6 });
  assert.doesNotMatch(text, /已持续多轮且尚未保存/, "nudges 已到 nudge 上限");
  assert.match(text, /上下文已达阈值/, "save 计数不该被旧 nudges 占掉");
});

/* ------------------------------------------------------------------ */
/* recalledUids 与 hitCount：只记真正进入上下文的条目                    */
/* ------------------------------------------------------------------ */

function kw(term, keyness = 6) {
  return { term, keyness, levels: [2] };
}

function mem(uid, overrides = {}) {
  return {
    uid,
    label: `2_${uid}`,
    folder: path.join(ROOT, "mem", uid),
    defaultLevel: 2,
    snapshots: [2],
    date: "2026-11-28",
    keywords: [],
    people: [],
    sessionId: "s",
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    hitCount: 0,
    ...overrides,
  };
}

function fakeRecallRegistry(memories = []) {
  const map = new Map(memories.map((memory) => [memory.uid, memory]));
  return {
    map,
    bumpHitsCalls: 0,
    get: (uid) => map.get(uid),
    list: () => [...map.values()],
    lookup(terms) {
      const wanted = new Set(terms.map((term) => String(term).toLowerCase()));
      const hits = new Set();
      for (const memory of map.values()) {
        for (const keyword of memory.keywords ?? []) {
          if (wanted.has(String(keyword.term ?? keyword).toLowerCase())) {
            hits.add(memory.uid);
            break;
          }
        }
      }
      return hits;
    },
    async bumpHits(entries) {
      this.bumpHitsCalls += 1;
      const counts = new Map();
      for (const entry of entries) {
        const memory = map.get(entry?.uid);
        if (!memory) continue;
        memory.hitCount = Math.round((memory.hitCount + Number(entry?.delta ?? 1)) * 100) / 100;
        counts.set(entry.uid, memory.hitCount);
      }
      return counts;
    },
    async bumpHit(uid, _now, delta = 1) {
      const memory = map.get(uid);
      if (!memory) return undefined;
      memory.hitCount = Math.round((memory.hitCount + delta) * 100) / 100;
      return memory;
    },
  };
}

function fakeAutoState(seed = {}) {
  const session = { recalledUids: [], ...seed };
  return {
    session,
    getSession: () => session,
    updateSession: async (_id, patch) => Object.assign(session, patch),
  };
}

function autoConfig(overrides = {}) {
  return { autoRecall: { enabled: true, topK: 5, minScore: 1, maxChars: 200, ...overrides } };
}

test("recalledUids：只记实际进入注入上下文的 uid，超预算的不算看过", async () => {
  const short = mem("a-short", { keywords: [kw("插件")], gist: "短的结论" });
  const long = mem("z-long", { keywords: [kw("插件")], gist: "很长的结论".repeat(60) });
  const registry = fakeRecallRegistry([short, long]);
  const state = fakeAutoState();
  const text = await buildAutoRecall({
    home: "",
    config: autoConfig({ maxChars: 200 }),
    registry,
    state,
    sessionId: "s-auto",
    text: "插件",
    now: NOW,
  });
  assert.match(text, /a-short/);
  assert.doesNotMatch(text, /z-long/);
  assert.deepEqual(state.session.recalledUids, ["a-short"], "只有真正注入的 uid 才算看过");
});

test("recalledUids：首条就超预算时整体不注入，也不记任何 uid", async () => {
  const one = mem("a-one", { keywords: [kw("插件")], gist: "短的结论" });
  const registry = fakeRecallRegistry([one]);
  const state = fakeAutoState();
  const text = await buildAutoRecall({
    home: "",
    config: autoConfig({ maxChars: 10 }),
    registry,
    state,
    sessionId: "s-tiny",
    text: "插件",
    now: NOW,
  });
  assert.equal(text, "");
  assert.deepEqual(state.session.recalledUids, []);
  assert.equal(one.hitCount, 0, "没进上下文就不该累加 hitCount");
});

test("hitCount：minScore 过滤掉的候选不累加", async () => {
  const one = mem("h-one", { keywords: [kw("插件")], gist: "命中" });
  const registry = fakeRecallRegistry([one]);
  const state = fakeAutoState();
  const text = await buildAutoRecall({
    home: "",
    config: autoConfig({ minScore: 999, maxChars: 600 }),
    registry,
    state,
    sessionId: "s-high-score",
    text: "插件",
    now: NOW,
  });
  assert.equal(text, "");
  assert.equal(one.hitCount, 0);
  assert.equal(registry.bumpHitsCalls, 0, "过滤前不该先记账");
});

test("hitCount：正常注入只给进入上下文的条目累加", async () => {
  const short = mem("a-short", { keywords: [kw("插件")], gist: "短" });
  const long = mem("z-long", { keywords: [kw("插件")], gist: "长".repeat(300) });
  const registry = fakeRecallRegistry([short, long]);
  const state = fakeAutoState();
  await buildAutoRecall({
    home: "",
    config: autoConfig({ maxChars: 200 }),
    registry,
    state,
    sessionId: "s-partial",
    text: "插件",
    now: NOW,
  });
  assert.equal(short.hitCount, 1.2, "keyness 6 × 0.2");
  assert.equal(long.hitCount, 0, "没进上下文的条目不该涨");
});

/* ------------------------------------------------------------------ */
/* 共享队列：单条超预算不能无界回队                                      */
/* ------------------------------------------------------------------ */

test("共享队列：单条超 budget 的 gist 截断投递，不会永久卡在 rest", () => {
  const longGist = "很长的总结".repeat(40); // 200 字 + uid 前缀，超过 maxChars 200
  let session = {
    sharingQueue: [{ uid: "m-long", gist: longGist, level: 2, fromSession: "other", at: 1 }],
  };
  const seen = [];
  let delivered = 0;
  for (let round = 0; round < 3; round += 1) {
    const taken = takeSharingQueue(session, { maxItems: 2, maxChars: 200, seen });
    assert.deepEqual(taken.rest, [], `第 ${round + 1} 轮不应再回队`);
    if (taken.lines.length) {
      delivered += 1;
      seen.push(...taken.uids);
      assert.ok(Array.from(taken.lines[0]).length <= 200, "截断到预算内");
      assert.match(taken.lines[0], /…$/, "截断末尾要有省略号");
    }
    session = { sharingQueue: taken.rest };
  }
  assert.equal(delivered, 1, "截断投递一次后队列清空");
});

test("共享队列：截断按码点，不切坏 emoji", () => {
  const taken = takeSharingQueue(
    { sharingQueue: [{ uid: "m-emoji", gist: "😀".repeat(300), level: 2 }] },
    { maxItems: 1, maxChars: 40, seen: [] },
  );
  const line = taken.lines[0];
  assert.ok(line, "应投递一条截断行");
  assert.ok(Array.from(line).length <= 40);
  assert.ok(line.endsWith("…"));
  assert.ok(line.includes("😀"), "emoji 应完整保留");
  assert.ok(!/[\uD800-\uDFFF]/u.test(line), "不应留下孤立代理对");
});

/* ------------------------------------------------------------------ */
/* 兜底心跳 unref / 临时目录闸门                                        */
/* ------------------------------------------------------------------ */

test("triggers：无 ctx.timer 时兜底心跳会 unref，dispose 能清掉定时器", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-fix-trigger-"));
  const config = resolveConfig({
    homeDir: home,
    diary: { enabled: false },
    forget: { enabled: false },
    idle: { enabled: false },
    backup: { enabled: false },
  });
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const fakeId = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  let cleared = null;
  globalThis.setInterval = () => fakeId;
  globalThis.clearInterval = (id) => { cleared = id; };
  try {
    const dispose = registerTriggers({ ctx: { logger: { warn() {} } }, home, config, registry: { list: () => [] }, state: {} });
    assert.equal(fakeId.unrefCalls, 1, "兜底 setInterval 必须 unref");
    dispose();
    assert.equal(cleared, fakeId, "dispose 必须清理兜底定时器");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    await rm(home, { recursive: true, force: true });
  }
});

test("临时目录闸门：拒绝迁移时终止初始化，不建库、不注册工具/命令", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "hdm-fix-gate-"));
  const fakeRealHome = path.join(os.homedir(), `hdm-fix-gate-${process.pid}-${Date.now()}`);
  const tools = new Map();
  const commands = new Map();
  const errors = [];
  try {
    await writePointer(fakeRealHome);
    const ctx = {
      logger: { info() {}, warn() {}, error: (line) => errors.push(String(line)), debug() {} },
      tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
      effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
      on() { return () => {}; },
      timer: { interval() { return () => {}; } },
      tokenMeter: { contextPressure() { return null; } },
      commands: { register() { return () => {}; } },
      inject(_names, callback) {
        callback({
          provide() {},
          typert: { register() { return () => {}; } },
          effect: (fn) => fn(),
          commands: { register(command) { commands.set(command.name, command); return () => {}; } },
          skills: { register() { return () => {}; } },
          systemPrompt: { section() { return () => {}; } },
        });
      },
      get() { return undefined; },
    };
    await apply(ctx, { homeDir: target });

    const pointer = await readPointer();
    assert.equal(path.resolve(pointer.homeDir), path.resolve(fakeRealHome), "指针仍指向旧库");
    assert.ok(errors.some((line) => /拒绝把母文件夹迁入临时目录/.test(line)), "应记录拒迁错误");
    assert.equal(tools.size, 0, "闸门拒绝时不注册工具");
    assert.equal(commands.size, 0, "闸门拒绝时不注册命令");
    await assert.rejects(stat(path.join(target, "IAM.md")), "不应在临时 home 上建库");
  } finally {
    await writePointer(path.join(os.tmpdir(), `hdm-fix-inject-pointer-${process.pid}.json`));
    await rm(target, { recursive: true, force: true });
  }
});

// P2 注入·共享·gist 组回归：gistEnabled 生效、共享 active/stale 预算不互挤、
// 召回与共享共用「已见过」账、step/turn 缺失 fail-closed、文本按码点截断。
// 全程临时目录 + fake ctx/state，不碰真实母文件夹。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { runGistPass } from "../lib/gist.js";
import { buildAutoRecall, buildHandoffText, buildPreStepDecision } from "../lib/injection.js";
import { buildSharingText, resetBusySessions, seenUidsOf, takeSharingQueue, touchSession } from "../lib/sharing.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-fix-p2-"));
const NOW = Date.parse("2026-11-28T12:00:00Z");
const MINUTE = 60 * 1000;

after(async () => {
  resetBusySessions();
  await rm(ROOT, { recursive: true, force: true });
});

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
    sessionId: "s",
    createdAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    keywords: [],
    people: [],
    hitCount: 0,
    ...overrides,
  };
}

async function writeSnapshot(meta, text) {
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, `level${meta.defaultLevel}.txt`), text, "utf8");
}

function fakeRegistry(memories = []) {
  const map = new Map(memories.map((memory) => [memory.uid, memory]));
  return {
    map,
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
      const counts = new Map();
      for (const entry of entries) {
        const memory = map.get(entry?.uid);
        if (!memory) continue;
        memory.hitCount += Number(entry?.delta ?? 1);
        counts.set(entry.uid, memory.hitCount);
      }
      return counts;
    },
  };
}

function fakeState(seed = {}) {
  const sessions = new Map(Object.entries(seed));
  const getSession = (id) => {
    if (!sessions.has(id)) sessions.set(id, { recalledUids: [], sharedUids: [] });
    return sessions.get(id);
  };
  return {
    sessions,
    getSession,
    updateSession: async (id, patch) => Object.assign(getSession(id), patch),
  };
}

function autoConfig(overrides = {}) {
  return { autoRecall: { enabled: true, topK: 5, minScore: 0, maxChars: 600, ...overrides } };
}

/** 孤立代理对：emoji 被切掉一半时出现。 */
function hasLoneSurrogate(text) {
  const s = String(text ?? "");
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/* ------------------------------------------------------------------ */
/* 1. gistEnabled=false：不注入 gist（回退摘要）、巡检不处理任何记忆      */
/* ------------------------------------------------------------------ */

test("gistEnabled=false：自动召回不用 meta.gist，退回摘要前段并标「已关闭」", async () => {
  const meta = mem("g-off", { keywords: [kw("插件")], gist: "GIST 正文不该出现" });
  await writeSnapshot(meta, "## 摘要\n① 摘要前段可注入。② 中间。③ 结论。\n");
  const registry = fakeRegistry([meta]);
  const state = fakeState({ "s-off": {} });

  const text = await buildAutoRecall({
    home: ROOT,
    config: autoConfig({ gistEnabled: false }),
    registry,
    state,
    sessionId: "s-off",
    text: "插件",
    now: NOW,
  });
  assert.ok(!text.includes("GIST 正文不该出现"), `不该出现 gist 正文：${text}`);
  assert.match(text, /① 摘要前段可注入/);
  assert.match(text, /gist 已关闭/);
  assert.equal(meta.gist, "GIST 正文不该出现", "gist 字段不该被删");
});

test("gistEnabled=false：runGistPass 直接跳过，不写 gist 也不烧模型", async () => {
  const folder = path.join(ROOT, "gist-off");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "level2.txt"), "## 摘要\n① 用户要求加 gist。② 细节。③ 下一步：跑测试。\n", "utf8");
  const meta = { uid: "m-gist-off", folder, snapshots: [2], defaultLevel: 2, updatedAt: 1000 };
  const registry = { list: () => [meta], upsert: async () => meta };

  const result = await runGistPass({
    ctx: {},
    home: ROOT,
    config: { autoRecall: { enabled: true, level: 1, gistEnabled: false } },
    registry,
    now: 5000,
  });
  assert.deepEqual(result.processed, []);
  assert.equal(meta.gist, undefined, "关闭时不该派生 gist");
});

/* ------------------------------------------------------------------ */
/* 2. 共享 active + stale 同时超预算：各用各的预算，active 不被挤掉      */
/* ------------------------------------------------------------------ */

test("共享：active 吃 maxChars、stale 吃 staleChars，stale 再长也挤不掉 active 行", async () => {
  resetBusySessions();
  const active = mem("m-active-01", { sessionId: "a", keywords: [] });
  await writeSnapshot(active, `## 摘要\n${"活跃会话的结论。".repeat(30)}\n`);
  const stale = Array.from({ length: 6 }, (_, i) =>
    mem(`m-stale-${i}`, {
      sessionId: "b",
      createdAt: NOW - (120 + i) * MINUTE,
      updatedAt: NOW - (120 + i) * MINUTE,
    }),
  );
  for (const meta of stale) await writeSnapshot(meta, "## 摘要\n旧会话不该出现摘要。\n");
  touchSession("a", NOW);

  const registry = fakeRegistry([active, ...stale]);
  const state = fakeState({
    a: { lastUserAt: NOW - 2 * MINUTE },
    b: { lastUserAt: NOW - 3 * 60 * MINUTE },
  });
  const result = await buildSharingText({
    registry,
    state,
    sessionId: "self",
    config: { sharing: { enabled: true, level: 2, maxChars: 200, staleChars: 30 } },
    now: NOW,
  });

  const staleHeader = "旧会话（自行 hdm_read 取正文）：";
  const [activePart, stalePart = ""] = result.text.split(staleHeader);
  assert.match(activePart, /m-active-01/, `旧预算不该砍掉 active 行：${result.text}`);
  assert.ok(Array.from(activePart).length <= 200, "active 块不超自己的预算");
  assert.ok(Array.from(staleHeader + stalePart).length <= 30, "stale 块不超自己的预算");
  assert.ok(!result.text.includes("旧会话不该出现摘要"), "旧会话仍只给 uid");
});

/* ------------------------------------------------------------------ */
/* 3. 召回与共享共用一本「已见过」账：同一 uid 一会话只注入一次           */
/* ------------------------------------------------------------------ */

test("去重：先被自动召回的记忆再进共享队列，第二次注入被跳过", async () => {
  const meta = mem("m-dup", { keywords: [kw("插件")], gist: "第一次注入的结论" });
  const registry = fakeRegistry([meta]);
  const state = fakeState({ "s-dup": {} });

  const auto = await buildAutoRecall({
    home: ROOT,
    config: autoConfig(),
    registry,
    state,
    sessionId: "s-dup",
    text: "插件",
    now: NOW,
  });
  assert.match(auto, /m-dup/);
  const ss = state.getSession("s-dup");
  assert.deepEqual(ss.recalledUids, ["m-dup"]);

  const taken = takeSharingQueue(
    { sharingQueue: [{ uid: "m-dup", gist: "第二次不该出现", level: 2 }] },
    { maxItems: 2, maxChars: 200, seen: seenUidsOf(ss) },
  );
  assert.equal(taken.lines.length, 0, "已召回过的 uid 不再进共享");
  assert.equal(taken.dropped, 1);

  const shared = await buildSharingText({
    registry,
    state,
    sessionId: "s-dup",
    config: { sharing: { enabled: true, level: 1 } },
    now: NOW,
  });
  assert.ok(!shared.text.includes("m-dup"), "共享段同样跳过已召回的 uid");
});

test("去重：先被共享的记忆不再被自动召回", async () => {
  const meta = mem("m-shared-first", { keywords: [kw("插件")], gist: "已经通过共享给过" });
  const registry = fakeRegistry([meta]);
  const state = fakeState({ "s-shared": { sharedUids: ["m-shared-first"] } });
  const text = await buildAutoRecall({
    home: ROOT,
    config: autoConfig(),
    registry,
    state,
    sessionId: "s-shared",
    text: "插件",
    now: NOW,
  });
  assert.equal(text, "");
  assert.equal((state.getSession("s-shared").recalledUids ?? []).length, 0, "没注入就不记 uid");
});

/* ------------------------------------------------------------------ */
/* 4. 无 step/turn：续步不召回（fail-closed），warn 只记一次              */
/* ------------------------------------------------------------------ */

function stepEnv() {
  const memory = mem("m-plan", { keywords: [kw("插件")], gist: "方案决策点的记忆" });
  const registry = fakeRegistry([memory]);
  const state = fakeState({
    "s-step": { iamInjected: true, pendingContextReinject: false, uids: [], lastUserQuery: "插件方案" },
  });
  let warns = 0;
  const ctx = { logger: { warn: () => { warns += 1; } } };
  const config = {
    autoRecall: { enabled: true, level: 2, vocabChars: 0, topK: 2, minScore: 0, maxChars: 600 },
    iam: { inject: false, anchorEveryTurns: 0 },
    handoff: { enabled: false },
    characters: { injectOnRecall: false },
    events: { enabled: false },
    sharing: { enabled: false, level: 0 },
    save: { threshold: 1, step: 0.15, maxPerSession: 1 },
    nudge: { enabled: false },
  };
  // 上一步是工具调用：source 不是 user，否则 isRealUser 会把这个续步误判成用户回合。
  const messages = [
    {
      id: "a-1",
      role: "assistant",
      content: [{ type: "tool-call", name: "ops_bash", arguments: "{}" }],
      source: { kind: "assistant" },
    },
  ];
  const run = async (extra) => {
    const decision = await buildPreStepDecision({
      ctx,
      home: ROOT,
      config,
      registry,
      state,
      agent: { session: { id: "s-step", header: { id: "s-step", origin: "user" } } },
      decision: { kind: "enter", messages },
      now: NOW,
      ...extra,
    });
    return decision.messages
      .filter((m) => m.source?.kind === "plugin:hdm")
      .flatMap((m) => m.content.map((block) => block.text))
      .join("\n");
  };
  return { run, warns: () => warns, state };
}

test("step/turn 缺失：续步不召回，且 warn 只在首步记一次", async () => {
  const env = stepEnv();
  assert.equal(await env.run({ step: 2 }), "", "缺 turn 时不召回");
  assert.equal((env.state.getSession("s-step").recalledUids ?? []).length, 0, "没注入就不记 uid");
  assert.equal(env.warns(), 1, "缺 turn 首步 warn 一次");

  assert.equal(await env.run({ turn: 1 }), "", "缺 step 时同样不召回");
  assert.equal(env.warns(), 1, "后续缺失步不再刷 warn");
});

test("step/turn 齐全：同一轮只召回一次", async () => {
  const env = stepEnv();
  const first = await env.run({ step: 2, turn: 1 });
  assert.match(first, /m-plan/, "齐全时应正常召回");
  assert.deepEqual(env.state.getSession("s-step").recalledUids, ["m-plan"]);

  const again = await env.run({ step: 3, turn: 1 });
  assert.equal(again, "", "同一 turn 的续步不再召回");
  assert.equal(env.warns(), 0);
});

/* ------------------------------------------------------------------ */
/* 5. 截断按码点：中文/emoji 不出现半个字符                              */
/* ------------------------------------------------------------------ */

test("截断：handoff / 共享摘要 / gist 兜底都不切坏 emoji", async () => {
  const emojiSummary = `## 摘要\n${"😀".repeat(60)}\n`;
  const meta = mem("m-emoji", { label: "2_m-emoji", date: "2026-11-28", keywords: [] });
  await writeSnapshot(meta, emojiSummary);

  const handoff = await buildHandoffText(meta, { handoff: { enabled: true, maxChars: 20 } });
  assert.ok(Array.from(handoff).length <= 20, "handoff 不超预算");
  assert.ok(!hasLoneSurrogate(handoff), "handoff 不出现孤立代理对");

  resetBusySessions();
  const state = fakeState({ a: { lastUserAt: NOW - MINUTE }, b: { lastUserAt: NOW - 3 * 60 * MINUTE } });
  touchSession("a", NOW);
  const sharing = await buildSharingText({
    registry: fakeRegistry([meta]),
    state,
    sessionId: "self",
    config: { sharing: { enabled: true, level: 2, maxChars: 80, staleChars: 60 } },
    now: NOW,
  });
  assert.ok(!hasLoneSurrogate(sharing.text), "共享段不出现孤立代理对");
  assert.ok(Array.from(sharing.text.split("旧会话")[0]).length <= 80, "active 块按码点计不超预算");
});

// T4 maintenance unit tests: LLM resolution/streaming, diary due/run/chunk/fallback,
// sequential forget (day2/day5/catch-up), exemptions, lock and timers.
// Uses fake registry/memory/ctx and temp dirs: no dependency on T1/T3 modules.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { maintenanceLimits, resolveMaintenanceModel, streamText } from "../lib/llm.js";
import { dueDiaryDates, runDiary, startDiaryTimer } from "../lib/diary.js";
import { isExempt, runForgetPass, startForgetTimer } from "../lib/forget.js";

const TZ = "Asia/Shanghai";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function merge(base, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      merge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function config(overrides = {}) {
  return merge({
    timeZone: TZ,
    maintenance: {},
    diary: {
      enabled: true,
      time: "23:30",
      catchUpDays: 7,
      maxChars: 8000,
      inputMaxChars: 12000,
    },
    forget: {
      enabled: true,
      days: [2, 5],
      checkHours: 6,
      exemptMode: "tiered",
      exemptRecallCount: 3,
      exemptWindowDays: 14,
      autoImmortalRecallCount: 6,
      autoImmortalWindowDays: 30,
      immortalImportance: 5,
      respectImmortal: true,
    },
  }, overrides);
}

function todayLocal() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dateFromToday(delta) {
  const [year, month, day] = todayLocal().split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + delta * DAY_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

async function tempHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-t4-"));
  t.after(async () => {
    // 定时器立即补跑可能仍在写文件，清理时重试避免 ENOTEMPTY 偶发。
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return home;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function makeRegistry(memories) {
  const map = new Map(memories.map((meta) => [meta.uid, meta]));
  return {
    list: () => [...map.values()],
    get: (uid) => map.get(uid),
    async upsert(meta) { map.set(meta.uid, meta); },
    async remove(uid) { map.delete(uid); },
  };
}

function makeMeta(home, { uid, date, level = 2, snapshots, ...rest } = {}) {
  const label = `${level}_${date}_001_测试`;
  return {
    uid,
    label,
    folder: path.join(home, "memory", date, label),
    defaultLevel: level,
    snapshots: snapshots || [level],
    date,
    seq: 1,
    keywords: [
      { term: "测试", keyness: 6, levels: [level] },
      { term: "维护", keyness: 5, levels: [level] },
    ],
    people: [],
    sessionId: "session-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hitCount: 0,
    lastHitAt: null,
    immortal: false,
    immortalReason: null,
    forget: { d2: null, d5: null },
    relatedUids: [],
    ...rest,
  };
}

function makeMemory({ texts = new Map(), delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async readSnapshot(meta, level) {
      const key = `${meta.uid}:${level}`;
      const text = texts.has(key) ? texts.get(key) : (texts.get(meta.uid) ?? "");
      return { level, path: path.join(meta.folder, `level${level}.txt`), text, fallback: false };
    },
    deriveSnapshotData(meta, targetLevel, opts = {}) {
      // 复刻 memory.js 的 immortal 闸门：只有 opts.force 才允许压缩永久豁免记忆。
      if (meta.immortal && !opts.force) throw new Error("immortal 记忆不生成派生快照");
      calls.push({ op: "derive", uid: meta.uid, level: targetLevel, opts });
      return {
        level: targetLevel,
        summary: opts.llmSummary ?? `摘要L${targetLevel}-${meta.uid}`,
        details: targetLevel === 1 ? (opts.llmDetails ?? ["要点A", "要点B", "要点C"]) : [],
        quotes: [],
        keywords: (meta.keywords || []).slice(0, targetLevel === 1 ? 8 : 5),
      };
    },
    async commitDerivedSnapshot({ registry, meta, data, now }, options = {}) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const overwrite = options.overwrite === true;
      calls.push({ op: "commit", uid: meta.uid, level: data.level, overwrite, summary: data.summary });
      // 复刻真实实现：目标档已存在时默认幂等成功、不覆盖；只有 overwrite:true 才重写。
      const existsAlready = (meta.snapshots || []).includes(data.level);
      if (existsAlready && !overwrite) return meta;
      if (!existsAlready) {
        meta.snapshots = [...new Set([...(meta.snapshots || []), data.level])].sort((a, b) => a - b);
      }
      meta.defaultLevel = data.level;
      meta.updatedAt = now;
      await mkdir(meta.folder, { recursive: true });
      const text = [
        `快照等级: ${data.level}`,
        "## 摘要",
        data.summary,
        "## 细节",
        ...(data.details || []),
      ].join("\n");
      await writeFile(path.join(meta.folder, `level${data.level}.txt`), text, "utf8");
      await registry.upsert(meta);
      return meta;
    },
  };
}

function makeCtx({ replies = ["模型输出"], throwOnCall = -1, selection = { provider: "p", model: "m" } } = {}) {
  const calls = [];
  return {
    calls,
    agentDefaultModel: { currentSelection: () => selection },
    agents: { list: () => [] },
    llm: {
      stream: async (request) => {
        calls.push(request);
        const index = calls.length - 1;
        if (index === throwOnCall) throw new Error("llm down");
        const reply = typeof replies === "function"
          ? replies(request, index)
          : (replies[index] ?? replies[replies.length - 1]);
        return (async function* stream() {
          yield { type: "text-delta", textDelta: reply };
        })();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// llm
// ---------------------------------------------------------------------------

test("resolveMaintenanceModel: config override wins", async () => {
  const got = await resolveMaintenanceModel(
    { agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } },
    { maintenance: { provider: "cfg", model: "cfg-model" } },
  );
  assert.deepEqual(got, { provider: "cfg", model: "cfg-model" });
});

test("resolveMaintenanceModel: falls back to agent default selection", async () => {
  const got = await resolveMaintenanceModel(
    { agentDefaultModel: { currentSelection: () => ({ providerId: "dp", modelId: "dm" }) } },
    { maintenance: {} },
  );
  assert.deepEqual(got, { provider: "dp", model: "dm" });
});

test("resolveMaintenanceModel: falls back to first live agent header config", async () => {
  const ctx = {
    agentDefaultModel: { currentSelection: () => null },
    agents: {
      list: () => [
        { live: false, session: { requestHeader: async () => ({ config: { provider: "dead", model: "dead-m" } }) } },
        { live: true, session: { requestHeader: () => ({ config: { provider: "live", model: "live-m" } }) } },
      ],
    },
  };
  assert.deepEqual(await resolveMaintenanceModel(ctx, { maintenance: {} }), { provider: "live", model: "live-m" });
});

test("resolveMaintenanceModel: returns null when nothing is available", async () => {
  assert.equal(await resolveMaintenanceModel({}, { maintenance: {} }), null);
});

test("streamText: collects text deltas and forwards request options", async () => {
  const requests = [];
  const ctx = {
    llm: {
      stream: (request) => {
        requests.push(request);
        return (async function* stream() {
          yield { type: "text-delta", textDelta: "你" };
          yield { type: "text-delta", text: "好" };
          yield { type: "finish" };
        })();
      },
    },
  };
  const text = await streamText(ctx, { provider: "p", model: "m" }, {
    system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 123,
  });
  assert.equal(text, "你好");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "p");
  assert.equal(requests[0].model, "m");
  assert.equal(requests[0].system, "sys");
  assert.equal(requests[0].maxTokens, 123);
});

test("streamText: accepts plain string and fullStream results", async () => {
  assert.equal(await streamText({ llm: { stream: async () => "纯文本" } }, { provider: "p", model: "m" }), "纯文本");
  const ctx = {
    llm: {
      stream: async () => ({
        fullStream: (async function* stream() {
          yield { type: "text-delta", textDelta: "流" };
        })(),
      }),
    },
  };
  assert.equal(await streamText(ctx, { provider: "p", model: "m" }), "流");
});

test("streamText: throws on empty or failed streams", async () => {
  await assert.rejects(
    streamText({ llm: { stream: async () => (async function* stream() {})() } }, { provider: "p", model: "m" }),
    /empty/,
  );
  await assert.rejects(
    streamText({ llm: { stream: async () => { throw new Error("network"); } } }, { provider: "p", model: "m" }),
    /network/,
  );
  await assert.rejects(streamText({}, { provider: "p", model: "m" }), /unavailable/);
});

test("streamText: reads host StreamChunk shape and reports finish failures", async () => {
  // 宿主 ctx.llm.stream 的 text-delta 只带 text；内容块只在 block-end 出现。
  const blockEndOnly = {
    llm: {
      stream: async () => (async function* stream() {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "整块文本" } };
        yield { type: "finish", reason: { kind: "stop" } };
      })(),
    },
  };
  assert.equal(await streamText(blockEndOnly, { provider: "p", model: "m" }), "整块文本");

  const failed = {
    llm: {
      stream: async () => (async function* stream() {
        yield { type: "finish", reason: { kind: "error", failure: { code: "rate-limit", message: "429 too many requests" } } };
      })(),
    },
  };
  await assert.rejects(
    streamText(failed, { provider: "p", model: "m" }),
    /429 too many requests/,
  );
});

test("streamText: wraps string contents into text blocks", async () => {
  let sent = null;
  const ctx = { llm: { stream: async (request) => { sent = request; return "ok"; } } };
  await streamText(ctx, { provider: "p", model: "m" }, { messages: [{ role: "user", content: "你好" }] });
  assert.deepEqual(sent.messages, [{ role: "user", content: [{ type: "text", text: "你好" }] }]);
});

test("streamText: sends the lowest reasoning effort so thinking cannot eat maxTokens", async () => {
  let sent = null;
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "high" }] } }),
    stream: async (request) => { sent = request; return "ok"; },
  };
  await streamText({ llm }, { provider: "p", model: "m" }, { messages: [] });
  assert.equal(sent.reasoningEffort, "low");

  // 模型没有 reasoning 信息时不传该字段，避免适配器拒绝。
  const plain = { resolveModelInfo: async () => ({}), stream: async (r) => { sent = r; return "ok"; } };
  await streamText({ llm: plain }, { provider: "p", model: "m" }, { messages: [] });
  assert.equal(sent.reasoningEffort, undefined);

  // 解析抛错也不能中断调用。
  const broken = { resolveModelInfo: async () => { throw new Error("boom"); }, stream: async (r) => { sent = r; return "ok"; } };
  assert.equal(await streamText({ llm: broken }, { provider: "p", model: "m" }), "ok");
  assert.equal(sent.reasoningEffort, undefined);
});

test("maintenanceLimits: 默认 10 万 token / 600 秒，非法值回退", () => {
  assert.deepEqual(maintenanceLimits({ maintenance: {} }), { maxTokens: 100000, timeoutMs: 600_000 });
  assert.deepEqual(maintenanceLimits(undefined), { maxTokens: 100000, timeoutMs: 600_000 });
  assert.deepEqual(
    maintenanceLimits({ maintenance: { maxTokens: 12345, timeoutSeconds: 90 } }),
    { maxTokens: 12345, timeoutMs: 90_000 },
  );

  for (const bad of [0, -1, Number.NaN, "abc", null, undefined]) {
    const got = maintenanceLimits({ maintenance: { maxTokens: bad, timeoutSeconds: bad } });
    assert.equal(got.maxTokens, 100000, `maxTokens 非法值 ${String(bad)} 应回退`);
    assert.equal(got.timeoutMs, 600_000, `timeoutSeconds 非法值 ${String(bad)} 应回退`);
  }

  // 超范围要收敛到上限，避免填错一个数量级把单次调用拖成天价。
  assert.deepEqual(
    maintenanceLimits({ maintenance: { maxTokens: 9_999_999, timeoutSeconds: 99_999 } }),
    { maxTokens: 1_000_000, timeoutMs: 3_600_000 },
  );
});

test("runDiary: 正文预算来自配置，不再是 maxChars/2 公式", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-20261107-001", date: "2026-11-07" });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level2.txt"), "素材正文\\n", "utf8");
  const registry = makeRegistry([meta]);

  const ctx = makeCtx({ replies: ["日记正文"] });
  const result = await runDiary({
    ctx,
    home,
    config: config({ maintenance: { maxTokens: 12345, timeoutSeconds: 90 } }),
    registry,
    date: "2026-11-07",
  });
  assert.equal(result.ok, true);
  assert.equal(ctx.calls[0].maxTokens, 12345, "日记正文必须用配置预算");
});

// ---------------------------------------------------------------------------
// diary
// ---------------------------------------------------------------------------

test("dueDiaryDates: today needs diary.time, catch-up covers earlier days", async (t) => {
  const home = await tempHome(t);
  const registry = makeRegistry([
    makeMeta(home, { uid: "m-20261107-001", date: "2026-11-07" }),
    makeMeta(home, { uid: "m-20261106-001", date: "2026-11-06" }),
    makeMeta(home, { uid: "m-20261028-001", date: "2026-10-28" }),
  ]);
  const cfg = config();

  const beforeTime = Date.parse("2026-11-07T20:00:00+08:00");
  assert.deepEqual(await dueDiaryDates({ home, config: cfg, registry, now: beforeTime }), ["2026-11-06"]);

  const afterTime = Date.parse("2026-11-07T23:40:00+08:00");
  assert.deepEqual(await dueDiaryDates({ home, config: cfg, registry, now: afterTime }), ["2026-11-06", "2026-11-07"]);
});

test("dueDiaryDates: skips existing diaries, empty days and disabled config", async (t) => {
  const home = await tempHome(t);
  const registry = makeRegistry([makeMeta(home, { uid: "m-20261106-001", date: "2026-11-06" })]);
  const now = Date.parse("2026-11-07T23:40:00+08:00");

  await mkdir(path.join(home, "diary"), { recursive: true });
  await writeFile(path.join(home, "diary", "2026-11-06.txt"), "已有日记", "utf8");
  assert.deepEqual(await dueDiaryDates({ home, config: config(), registry, now }), []);

  assert.deepEqual(await dueDiaryDates({ home, config: config({ diary: { enabled: false } }), registry, now }), []);
});

test("runDiary: writes the LLM diary and is idempotent unless forced", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-20261107-001", date: "2026-11-07" });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level2.txt"), "记忆编号: 1\n## 摘要\n今天调试插件。\n", "utf8");
  const registry = makeRegistry([meta]);

  const ctx = makeCtx({ replies: ["今天完成了维护模块。"] });
  const first = await runDiary({ ctx, home, config: config(), registry, date: "2026-11-07" });
  assert.equal(first.ok, true);
  assert.equal(first.fallback, false);
  const file = path.join(home, "diary", "2026-11-07.txt");
  assert.match(await readFile(file, "utf8"), /今天完成了维护模块/);
  assert.equal(ctx.calls.length, 1);

  const second = await runDiary({ ctx: makeCtx({ throwOnCall: 0 }), home, config: config(), registry, date: "2026-11-07" });
  assert.equal(second.ok, true);
  assert.equal(second.path, file);

  const forced = await runDiary({
    ctx: makeCtx({ replies: ["重写的日记。"] }), home, config: config(), registry, date: "2026-11-07", force: true,
  });
  assert.equal(forced.ok, true);
  assert.match(await readFile(file, "utf8"), /重写的日记/);
});

test("runDiary: reads the default snapshot level", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, {
    uid: "m-20261107-001", date: "2026-11-07", level: 1, snapshots: [1, 2], defaultLevel: 1,
  });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level1.txt"), "L1正文标记\n", "utf8");
  await writeFile(path.join(meta.folder, "level2.txt"), "L2正文标记\n", "utf8");
  const registry = makeRegistry([meta]);

  const ctx = makeCtx({ replies: ["默认档日记"] });
  const result = await runDiary({ ctx, home, config: config(), registry, date: "2026-11-07" });
  assert.equal(result.ok, true);
  const prompt = ctx.calls[0].messages[0].content;
  const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
  assert.match(promptText, /L1正文标记/);
  assert.doesNotMatch(promptText, /L2正文标记/);
});

test("runDiary: chunks oversized input (map-reduce) and honors maxChars", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-20261107-001", date: "2026-11-07" });
  const longText = "记忆片段".repeat(500); // 2000 chars
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level2.txt"), longText, "utf8");
  const registry = makeRegistry([meta]);

  const ctx = makeCtx({
    replies: (request) => (request.system.includes("压缩") ? "块摘要" : "总日记正文"),
  });
  const result = await runDiary({
    ctx, home, config: config({ diary: { inputMaxChars: 300, maxChars: 500 } }), registry, date: "2026-11-07",
  });
  assert.equal(result.ok, true);
  assert.ok(ctx.calls.length > 2, `expected chunk summaries + final, got ${ctx.calls.length} calls`);
  const text = await readFile(path.join(home, "diary", "2026-11-07.txt"), "utf8");
  assert.match(text, /总日记正文/);
  assert.ok(text.length <= 501, `diary length ${text.length} exceeds maxChars`);
});

test("runDiary: writes deterministic fallback when the model fails", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-20261107-001", date: "2026-11-07" });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(
    path.join(meta.folder, "level2.txt"),
    "## 摘要\n今天修复了插件加载。\n\n关键词: 测试, 维护\n",
    "utf8",
  );
  const registry = makeRegistry([meta]);

  const result = await runDiary({
    ctx: makeCtx({ throwOnCall: 0 }), home, config: config(), registry, date: "2026-11-07",
  });
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.ok(result.error);
  const text = await readFile(path.join(home, "diary", "2026-11-07.txt"), "utf8");
  assert.match(text, /m-20261107-001/);
  assert.match(text, /测试/);
  assert.match(text, /维护/);
  assert.match(text, /今天修复了插件加载/);
});

test("runDiary: 当天没有记忆时写一篇「今天没有需要记录的更新」", async (t) => {
  const home = await tempHome(t);
  const result = await runDiary({
    ctx: makeCtx(), home, config: config(), registry: makeRegistry([]), date: "2026-11-07",
  });
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  const text = await readFile(path.join(home, "diary", "2026-11-07.txt"), "utf8");
  assert.match(text, /2026-11-07 日记/);
  assert.match(text, /今天没有需要记录的更新/);
});

test("startDiaryTimer: catches up on start and stops cleanly", async (t) => {
  const home = await tempHome(t);
  const date = todayLocal();
  const meta = makeMeta(home, { uid: "m-today-001", date });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level2.txt"), "## 摘要\n今天的记忆。\n", "utf8");
  const registry = makeRegistry([meta]);

  const stop = startDiaryTimer({
    ctx: makeCtx({ replies: ["定时日记"] }),
    home,
    config: config({ diary: { time: "00:00" } }),
    registry,
  });
  t.after(stop);
  const file = path.join(home, "diary", `${date}.txt`);
  assert.equal(await waitFor(() => exists(file)), true);
  stop();
  assert.match(await readFile(file, "utf8"), /定时日记/);
});

// ---------------------------------------------------------------------------
// forget exemptions
// ---------------------------------------------------------------------------

test("isExempt: tiered delay, auto immortal, importance, manual immortal", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const base = config();
  const meta = (over = {}) => ({
    hitCount: 0, lastHitAt: null, immortal: false, importance: 0, ...over,
  });

  assert.deepEqual(isExempt(meta(), base, now), { exempt: false, immortal: false, reason: "none" });

  const delayed = isExempt(meta({ hitCount: 4, lastHitAt: now - 2 * DAY_MS }), base, now);
  assert.equal(delayed.exempt, true);
  assert.equal(delayed.immortal, false);
  assert.equal(delayed.reason, "delay");

  assert.equal(isExempt(meta({ hitCount: 4, lastHitAt: now - 20 * DAY_MS }), base, now).exempt, false);

  const recall = isExempt(meta({ hitCount: 6, lastHitAt: now - 5 * DAY_MS }), base, now);
  assert.equal(recall.immortal, true);
  assert.equal(recall.reason, "recall");
  assert.equal(isExempt(meta({ hitCount: 6, lastHitAt: now - 40 * DAY_MS }), base, now).exempt, false);

  assert.equal(isExempt(meta({ importance: 5 }), base, now).reason, "importance");
  assert.equal(isExempt(meta({ immortal: true }), base, now).reason, "immortal");

  const noRespect = config({ forget: { respectImmortal: false } });
  assert.deepEqual(
    isExempt(meta({ immortal: true }), noRespect, now),
    { exempt: false, immortal: true, reason: "immortal-overridden" },
  );

  const skip = config({ forget: { exemptMode: "skip" } });
  assert.equal(isExempt(meta({ hitCount: 1, lastHitAt: now - DAY_MS }), skip, now).reason, "delay");

  const delayOnly = config({ forget: { exemptMode: "delay" } });
  assert.equal(isExempt(meta({ hitCount: 6, lastHitAt: now - DAY_MS }), delayOnly, now).exempt, false);
});

// ---------------------------------------------------------------------------
// forget passes
// ---------------------------------------------------------------------------

test("runForgetPass: day 1 memories stay untouched", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-day1-001", date: dateFromToday(-1) });
  const memory = makeMemory();
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now: Date.now(),
  });
  assert.deepEqual(result.processed, []);
  assert.deepEqual(meta.snapshots, [2]);
  assert.equal(await exists(path.join(meta.folder, "level1.txt")), false);
});

test("runForgetPass: day 2 derives L1 and records forget.d2 + jobs", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const meta = makeMeta(home, { uid: "m-day2-001", date: dateFromToday(-2) });
  const memory = makeMemory();
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now,
  });

  assert.deepEqual(result.processed, [{ uid: "m-day2-001", level: 1, ok: true }]);
  assert.deepEqual(meta.snapshots, [1, 2]);
  assert.equal(meta.defaultLevel, 1);
  assert.equal(meta.forget.d2, now);
  assert.equal(meta.forget.d5, null);
  assert.match(await readFile(path.join(meta.folder, "level1.txt"), "utf8"), /摘要L1/);

  const payload = JSON.parse(await readFile(path.join(home, "state", "jobs.json"), "utf8"));
  // 与 StateStore 同一层结构，否则下一次 sessions.json 保存会把顶层字段抹掉
  assert.equal(payload.version, 1);
  const jobs = payload.jobs;
  assert.equal(jobs.lastForgetAt, now);
  assert.equal(jobs.forgetDone["m-day2-001"].d2, now);
});

test("runForgetPass: day 5 derives L0 from L1", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const meta = makeMeta(home, {
    uid: "m-day5-001",
    date: dateFromToday(-5),
    level: 1,
    snapshots: [1, 2],
    defaultLevel: 1,
    forget: { d2: now - 3 * DAY_MS, d5: null },
  });
  const memory = makeMemory({ texts: new Map([["m-day5-001:1", "L1 快照正文"]]) });
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now,
  });

  assert.deepEqual(result.processed, [{ uid: "m-day5-001", level: 0, ok: true }]);
  assert.equal(meta.defaultLevel, 0);
  assert.ok(meta.snapshots.includes(0));
  assert.equal(meta.forget.d5, now);
  assert.match(await readFile(path.join(meta.folder, "level0.txt"), "utf8"), /摘要L0/);
});

test("runForgetPass: stalled memories catch up L1 then L0 in order", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-stalled-001", date: dateFromToday(-6) });
  const memory = makeMemory();
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now: Date.now(),
  });

  assert.deepEqual(result.processed.map((item) => item.level), [1, 0]);
  assert.deepEqual(meta.snapshots, [0, 1, 2]);
  assert.deepEqual(
    memory.calls.filter((call) => call.op === "commit").map((call) => call.level),
    [1, 0],
  );
});

test("runForgetPass: second sweep is idempotent", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-idem-001", date: dateFromToday(-2) });
  const memory = makeMemory();
  const run = () => runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now: Date.now(),
  });

  // Recreate the registry each run to model reloading from disk (meta keeps forget state).
  const first = await run();
  const second = await run();
  assert.equal(first.processed.length, 1);
  assert.deepEqual(second.processed, []);
});

test("runForgetPass: immortal and auto-immortal memories are skipped", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const manual = makeMeta(home, { uid: "m-immortal-001", date: dateFromToday(-3), immortal: true });
  const auto = makeMeta(home, {
    uid: "m-auto-001", date: dateFromToday(-3), hitCount: 6, lastHitAt: now - DAY_MS,
  });
  const registry = makeRegistry([manual, auto]);
  const memory = makeMemory();

  const result = await runForgetPass({ home, config: config(), registry, memory, now });
  assert.deepEqual(result.processed, []);
  assert.equal(await exists(path.join(manual.folder, "level1.txt")), false);
  assert.equal(await exists(path.join(auto.folder, "level1.txt")), false);
  assert.equal(auto.immortal, true);
  assert.equal(auto.immortalReason, "auto: recall count");
});

test("runForgetPass: importance promotes immortal without compressing", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-importance-001", date: dateFromToday(-3), importance: 5 });
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory: makeMemory(), now: Date.now(),
  });
  assert.deepEqual(result.processed, []);
  assert.equal(meta.immortal, true);
  assert.equal(meta.immortalReason, "auto: importance");
});

test("runForgetPass: respectImmortal=false overrides immortal", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-respect-001", date: dateFromToday(-2), immortal: true });
  const result = await runForgetPass({
    home,
    config: config({ forget: { respectImmortal: false } }),
    registry: makeRegistry([meta]),
    memory: makeMemory(),
    now: Date.now(),
  });
  assert.deepEqual(result.processed, [{ uid: "m-respect-001", level: 1, ok: true }]);
  assert.deepEqual(meta.snapshots, [1, 2]);
});

test("runForgetPass: delay exemption is skipped on due, overridable by uid", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const meta = makeMeta(home, {
    uid: "m-delay-001", date: dateFromToday(-2), hitCount: 4, lastHitAt: now - 2 * DAY_MS,
  });
  const registry = makeRegistry([meta]);
  const memory = makeMemory();

  const due = await runForgetPass({ home, config: config(), registry, memory, now });
  assert.deepEqual(due.processed, []);
  assert.equal(await exists(path.join(meta.folder, "level1.txt")), false);

  const manual = await runForgetPass({ home, config: config(), registry, memory, target: "m-delay-001", now });
  assert.deepEqual(manual.processed, [{ uid: "m-delay-001", level: 1, ok: true }]);
});

test("runForgetPass: target all processes only age-due memories", async (t) => {
  const home = await tempHome(t);
  const old = makeMeta(home, { uid: "m-all-old", date: dateFromToday(-3) });
  const fresh = makeMeta(home, { uid: "m-all-fresh", date: dateFromToday(-1) });
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([old, fresh]), memory: makeMemory(),
    target: "all", now: Date.now(),
  });
  assert.deepEqual(result.processed.map((item) => item.uid), ["m-all-old"]);
  assert.deepEqual(fresh.snapshots, [2]);
});

test("runForgetPass: optional LLM compression feeds the snapshot", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-llm-001", date: dateFromToday(-2) });
  const memory = makeMemory({ texts: new Map([["m-llm-001:2", "L2 完整正文"]]) });
  const ctx = makeCtx({ replies: ['{"summary":"模型摘要","details":["模型要点"]}'] });

  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, ctx, now: Date.now(),
  });
  assert.deepEqual(result.processed, [{ uid: "m-llm-001", level: 1, ok: true }]);
  const text = await readFile(path.join(meta.folder, "level1.txt"), "utf8");
  assert.match(text, /模型摘要/);
  assert.match(text, /模型要点/);
  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0].system, /记忆压缩器/);
  const derived = memory.calls.find((call) => call.op === "derive");
  assert.equal(derived.opts.llmSummary, "模型摘要");
});

test("runForgetPass: LLM failure falls back to deterministic derivation", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-llm-fail-001", date: dateFromToday(-2) });
  const memory = makeMemory({ texts: new Map([["m-llm-fail-001:2", "L2 正文"]]) });
  const ctx = makeCtx({ throwOnCall: 0 });

  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, ctx, now: Date.now(),
  });
  assert.deepEqual(result.processed, [{ uid: "m-llm-fail-001", level: 1, ok: true }]);
  assert.match(await readFile(path.join(meta.folder, "level1.txt"), "utf8"), /摘要L1/);
});

test("runForgetPass: lock makes concurrent passes serialize", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-lock-001", date: dateFromToday(-2) });
  const registry = makeRegistry([meta]);
  const memory = makeMemory({ delayMs: 60 });
  const run = () => runForgetPass({ home, config: config(), registry, memory, now: Date.now() });

  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.processed.length + second.processed.length, 1);
});

test("startForgetTimer: catches up on start and stops cleanly", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-timer-001", date: dateFromToday(-2) });
  const registry = makeRegistry([meta]);
  const stop = startForgetTimer({
    home,
    config: config({ forget: { checkHours: 6 } }),
    registry,
    memory: makeMemory(),
  });
  t.after(stop);
  const file = path.join(meta.folder, "level1.txt");
  assert.equal(await waitFor(() => exists(file)), true);
  stop();
  assert.equal(meta.defaultLevel, 1);
});

test("jobs.json: 经 updateJobs 落盘后，StateStore.save 不会抹掉 forget 的 d2 标记", async (t) => {
  const { StateStore } = await import("../lib/state.js");
  const home = await tempHome(t);
  const now = Date.now();

  // 先建 StateStore、load 一份还没有 forgetDone 的旧 jobs（内存 jobs 是旧值）。
  const store = new StateStore(home);
  await store.load();
  assert.deepEqual(store.getJobs().forgetDone, {});

  const meta = makeMeta(home, { uid: "m-day2-777", date: dateFromToday(-2) });
  await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory: makeMemory(), now, state: store,
  });

  // forget 走 updateJobs 写进同一份内存 jobs，磁盘同步落盘
  assert.equal(store.getJobs().lastForgetAt, now, "forget 通过 updateJobs 更新内存水位");
  assert.equal(store.getJobs().forgetDone["m-day2-777"].d2, now, "内存里有 d2 标记");

  // 日常会话更新触发 StateStore.save（会整份写回内存 jobs）
  await store.updateSession("s-jobs-shared", { nudges: 1 });
  const payload = JSON.parse(await readFile(path.join(home, "state", "jobs.json"), "utf8"));
  assert.equal(payload.jobs.forgetDone["m-day2-777"].d2, now, "StateStore.save 不能抹掉 forget 的标记");
  assert.equal(payload.jobs.lastForgetAt, now);

  // 反向：StateStore 写入的字段也不能被 forget 下一次记录抹掉
  await store.updateJobs({ lastDiaryDate: "2026-11-08" });
  const second = makeMeta(home, { uid: "m-day2-778", date: dateFromToday(-2) });
  await runForgetPass({
    home, config: config(), registry: makeRegistry([second]), memory: makeMemory(), now: now + 1000, state: store,
  });
  const after = JSON.parse(await readFile(path.join(home, "state", "jobs.json"), "utf8"));
  assert.equal(after.jobs.lastDiaryDate, "2026-11-08", "forget 记录不能抹掉 StateStore 的日记水位");
  assert.equal(after.jobs.forgetDone["m-day2-777"].d2, now, "旧标记仍然保留");
  assert.equal(after.jobs.forgetDone["m-day2-778"].d2, now + 1000);
});

test("runForgetPass: 传 state 时只走 updateJobs，不直写 jobs.json", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const patches = [];
  const state = {
    getJobs: () => ({ forgetDone: { "m-old": { d2: 1 } } }),
    async updateJobs(patch) { patches.push(patch); },
  };
  const meta = makeMeta(home, { uid: "m-state-001", date: dateFromToday(-2) });
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory: makeMemory(), now, state,
  });
  assert.deepEqual(result.processed, [{ uid: "m-state-001", level: 1, ok: true }]);
  assert.equal(patches.length, 1, "state.updateJobs 必须被调用");
  assert.equal(patches[0].lastForgetAt, now);
  assert.deepEqual(patches[0].forgetDone, {
    "m-old": { d2: 1 },
    "m-state-001": { d2: now },
  }, "合并旧 forgetDone，而不是整份覆盖");
  assert.equal(await exists(path.join(home, "state", "jobs.json")), false, "有 state 时 forget 不该自己写 jobs.json");
});

test("runForgetPass: needsRederive=1 重写 L1/L0 后清空标记", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const meta = makeMeta(home, {
    uid: "m-rederive-001",
    date: dateFromToday(-6),
    level: 0,
    snapshots: [0, 1, 2],
    defaultLevel: 0,
    needsRederive: 1,
    forget: { d2: now - 4 * DAY_MS, d5: now - DAY_MS },
  });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level2.txt"), "L2 旧正文", "utf8");
  await writeFile(path.join(meta.folder, "level1.txt"), "L1 旧正文", "utf8");
  await writeFile(path.join(meta.folder, "level0.txt"), "L0 旧正文", "utf8");
  const memory = makeMemory({
    texts: new Map([
      ["m-rederive-001:2", "L2 新正文"],
      ["m-rederive-001:1", "L1 新正文"],
    ]),
  });
  const registry = makeRegistry([meta]);
  const ctx = makeCtx({
    replies: ['{"summary":"刷新后的L1","details":["新要点"]}', '{"summary":"刷新后的L0","details":[]}'],
  });

  const first = await runForgetPass({ home, config: config(), registry, memory, ctx, now });
  assert.deepEqual(first.processed.map((item) => item.level), [1, 0], "needsRederive=1 应刷新 L1 再刷新 L0");
  assert.ok(first.processed.every((item) => item.ok));
  const commits = memory.calls.filter((call) => call.op === "commit");
  assert.deepEqual(commits.map((call) => call.overwrite), [true, true], "重派生必须传 overwrite:true");
  assert.match(await readFile(path.join(meta.folder, "level1.txt"), "utf8"), /刷新后的L1/);
  assert.match(await readFile(path.join(meta.folder, "level0.txt"), "utf8"), /刷新后的L0/);
  assert.equal(meta.needsRederive, null, "两档都刷新完成后清空 needsRederive");

  const stored = JSON.parse(await readFile(path.join(meta.folder, "meta.json"), "utf8"));
  assert.equal(stored.needsRederive, null, "清空后的标记要写回 meta.json");

  // 同一轮不会无限重复派发：第二轮 needsRederive 为空且不再派生。
  const second = await runForgetPass({ home, config: config(), registry, memory, now });
  assert.deepEqual(second.processed, []);
  assert.equal(memory.calls.filter((call) => call.op === "commit").length, 2);
});

test("runForgetPass: needsRederive=0 只刷新 L0", async (t) => {
  const home = await tempHome(t);
  const now = Date.now();
  const meta = makeMeta(home, {
    uid: "m-rederive-0",
    date: dateFromToday(-6),
    level: 1,
    snapshots: [0, 1, 2],
    defaultLevel: 1,
    needsRederive: 0,
    forget: { d2: now - 4 * DAY_MS, d5: now - DAY_MS },
  });
  await mkdir(meta.folder, { recursive: true });
  await writeFile(path.join(meta.folder, "level1.txt"), "L1 正文", "utf8");
  await writeFile(path.join(meta.folder, "level0.txt"), "L0 旧正文", "utf8");
  const memory = makeMemory({ texts: new Map([["m-rederive-0:1", "L1 正文"]]) });

  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now,
  });
  assert.deepEqual(result.processed, [{ uid: "m-rederive-0", level: 0, ok: true }]);
  assert.equal(meta.needsRederive, null);
  assert.match(await readFile(path.join(meta.folder, "level0.txt"), "utf8"), /摘要L0/);
});

test("runForgetPass: respectImmortal 默认 true 时 immortal 不派生", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-respect-default-001", date: dateFromToday(-3), immortal: true });
  const memory = makeMemory();
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now: Date.now(),
  });
  assert.deepEqual(result.processed, []);
  assert.equal(await exists(path.join(meta.folder, "level1.txt")), false);
  assert.equal(memory.calls.length, 0, "immortal 记忆不应进入派生");
});

test("runForgetPass: 非法日期不崩溃且不派生", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-bad-date-001", date: "bad-date" });
  const memory = makeMemory();
  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now: Date.now(),
  });
  assert.deepEqual(result.processed, []);
  assert.deepEqual(meta.snapshots, [2]);
  assert.equal(memory.calls.length, 0);
});

test("runForgetPass: 已存在的未过期锁让本轮跳过", async (t) => {
  const home = await tempHome(t);
  const meta = makeMeta(home, { uid: "m-lock-busy", date: dateFromToday(-2) });
  const memory = makeMemory();
  const lockFile = path.join(home, "state", ".lock-forget");
  await mkdir(path.dirname(lockFile), { recursive: true });
  await writeFile(lockFile, JSON.stringify({
    pid: 123, token: "other", at: Date.now(), expiresAt: Date.now() + 60_000,
  }), "utf8");

  const result = await runForgetPass({
    home, config: config(), registry: makeRegistry([meta]), memory, now: Date.now(),
  });
  assert.deepEqual(result.processed, []);
  assert.equal(memory.calls.length, 0);
  assert.equal(await exists(path.join(meta.folder, "level1.txt")), false);
  assert.equal(await exists(lockFile), true, "别人的锁不能被抢走");
});

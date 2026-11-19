// 空闲对话自动整理：监听活跃时长落在 [idleMinutes, maxIdleMinutes) 的会话，
// 把「上次整理之后新增的用户发言」交给维护模型提炼成一条记忆，
// 并固定到本会话的记忆单元（同一编码续写；无新增不重复整理）。
// 纯 ESM；只使用 Node 内置模块与包内模块。

import fs from "node:fs/promises";
import path from "node:path";

import { pinSessionUnit, saveConversationMemory } from "./conversation.js";
import { maintenanceLimits, resolveMaintenanceModel, streamText } from "./llm.js";
import { readSnapshot } from "./memory.js";
import { ensureDir, localDate } from "./paths.js";
import { loadPrompt } from "./prompts.js";
import { acquireFileLock } from "./state.js";

const MINUTE = 60_000;
const RING_MAX_MESSAGES = 40;
const RING_MAX_MESSAGE_CHARS = 2000;
// 落盘的活动环比内存环小：sessions.json 每轮真实发言都会重写，体积要可控。
const SESSION_ACTIVITY_MAX = 20;
const SESSION_ACTIVITY_MAX_CHARS = 800;
const TARGET_SUMMARY_MAX = 300;
const LOG_FILE = "maintenance.jsonl";

// 进程内活跃水位线：只记用户真实发言。进程重启后自然丢失，因此整理只覆盖本进程内活跃过的会话。
const rings = new Map();

function ringKey(home, sessionId) {
  return `${path.resolve(home ?? ".")}|${sessionId}`;
}

/** 日志里的会话短 id：去掉 `session-` 前缀再截 8 位，否则每条日志都是 "session-"。 */
function shortSessionId(id) {
  const text = String(id ?? "");
  return (text.startsWith("session-") ? text.slice("session-".length) : text).slice(0, 8);
}

function clip(text, max) {  const value = String(text ?? "");
  if (value.length <= max) return value;
  return max <= 1 ? "…" : `${value.slice(0, max - 1)}…`;
}

/**
 * 记录一条真实用户发言（由 pre-step 钩子在确认 source.kind==="user" 后调用）。
 * `total` 是会话里真实用户消息的权威条数（来自 session 事件），用来去重：
 * 同一个回合可能多次进入 pre-step，条数没涨就不再重复入队。
 */
export function noteUserActivity({ home, sessionId, text, now = Date.now(), total = null }) {
  const id = String(sessionId ?? "").trim();
  if (!id) return null;
  const body = String(text ?? "").trim();
  if (!body) return null;
  const clipped = clip(body, RING_MAX_MESSAGE_CHARS);
  const key = ringKey(home, id);
  const entry = rings.get(key) ?? { lastAt: null, count: 0, messages: [] };
  const expected = Number.isFinite(Number(total)) ? Number(total) : entry.count + 1;
  // 条数没涨时不能直接判重：pre-step 跑在用户消息落到会话事件之前，`total` 往往还是旧值，
  // 只看条数会把这一轮之后的所有发言永久当成重复（lastUserAt 冻住，空闲判定失真）。
  // 因此条数没涨时再看内容：同一条文本才算重复。
  if (expected <= entry.count) {
    const last = entry.messages[entry.messages.length - 1];
    if (last?.text === clipped) return { lastAt: entry.lastAt, count: entry.count, duplicate: true };
  }
  entry.count = Math.max(entry.count + 1, expected);
  entry.lastAt = now;
  entry.messages.push({ at: now, text: clipped });
  if (entry.messages.length > RING_MAX_MESSAGES) {
    entry.messages.splice(0, entry.messages.length - RING_MAX_MESSAGES);
  }
  rings.set(key, entry);
  return { lastAt: entry.lastAt, count: entry.count };
}

/** 读取某会话的进程内活跃水位线（测试与状态展示用）。 */export function pendingActivity({ home, sessionId }) {
  const entry = rings.get(ringKey(home, String(sessionId ?? "").trim()));
  if (!entry) return null;
  return {
    lastAt: entry.lastAt,
    count: entry.count,
    messages: entry.messages.length,
    // 供 pre-step 落盘用：调用方拿不到 ring 内部数组，这里回传最后一条。
    lastMessage: entry.messages[entry.messages.length - 1] ?? null,
  };
}

/**
 * 把持久化的活动环回灌进进程内 ring。插件 reload 会清空 rings，若不回灌，
 * 重载前活跃、之后沉默的会话就永远不在扫描名单里（不是「窗口不满足」，是「没被看到」）。
 * 返回回灌的会话数。内存里已有更新的记录时不覆盖（内存比磁盘新）。
 */
export function seedRingsFromState({ home, state, now = Date.now() }) {
  const prefix = `${path.resolve(home ?? ".")}|`;
  let seeded = 0;
  for (const [sessionId, session] of state?.sessions ?? []) {
    const id = String(sessionId ?? "").trim();
    if (!id) continue;
    const messages = Array.isArray(session?.activity) ? session.activity : [];
    if (!messages.length) continue;
    const key = `${prefix}${id}`;
    const existing = rings.get(key);
    const lastAt = Number(messages[messages.length - 1]?.at ?? 0);
    if (existing && Number(existing.lastAt ?? 0) >= lastAt) continue;
    rings.set(key, {
      lastAt,
      count: Math.max(Number(session?.userMessageCount ?? 0) || 0, messages.length),
      messages: messages
        .filter((message) => message && typeof message.text === "string" && message.text.trim())
        .map((message) => ({ at: Number(message.at) || now, text: clip(message.text, RING_MAX_MESSAGE_CHARS) }))
        .slice(-RING_MAX_MESSAGES),
    });
    seeded += 1;
  }
  return seeded;
}

/** 生成要落盘的活动环（截断到落盘上限），供 pre-step 写回会话状态。 */
export function activityToPersist(entry) {
  const messages = Array.isArray(entry?.messages) ? entry.messages : [];
  return messages
    .slice(-SESSION_ACTIVITY_MAX)
    .map((message) => ({ at: Number(message.at) || 0, text: clip(message.text ?? "", SESSION_ACTIVITY_MAX_CHARS) }));
}

function messageText(data) {
  const content = Array.isArray(data?.content) ? data.content : Array.isArray(data?.message?.content) ? data.message.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 从会话事件回填水位线：`/hdm-remember` 在进程刚重启、ring 为空时用它把
 * 本会话已发生的真实用户发言补进来（只读，不写状态）。
 */
export function seedFromSession({ home, sessionId, session, now = Date.now() }) {
  const events = typeof session?.ownEvents === "function" ? session.ownEvents() : session?.events ?? [];
  let total = 0;
  let lastAt = null;
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const data = event.data ?? {};
    if (data.source?.kind !== "user") continue;
    total += 1;
    const at = Number(event.at ?? event.time ?? event.ts ?? event.createdAt ?? 0) || now;
    const text = messageText(data);
    if (text) noteUserActivity({ home, sessionId, text, now: at, total });
    if (!lastAt || at > lastAt) lastAt = at;
  }
  return { total, lastAt };
}

/** 清空进程内水位线（测试用；不影响已落盘的记忆）。 */
export function resetActivity(home, sessionId) {
  if (sessionId === undefined) {
    for (const key of [...rings.keys()]) {
      if (key.startsWith(`${path.resolve(home ?? ".")}|`)) rings.delete(key);
    }
    return;
  }
  rings.delete(ringKey(home, String(sessionId).trim()));
}

function activeSessions(home) {
  const prefix = `${path.resolve(home ?? ".")}|`;
  return [...rings.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/** 空闲窗口 [minMs, maxMs)：低于下限太新，达到上限视为陈旧不再整理。 */
export function idleWindowMs(config) {
  const idle = config?.idle ?? {};
  const minMinutes = Number(idle.idleMinutes ?? 180);
  const maxMinutes = Number(idle.maxIdleMinutes ?? 720);
  const minMs = (Number.isFinite(minMinutes) && minMinutes > 0 ? minMinutes : 180) * MINUTE;
  const rawMax = (Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes : 720) * MINUTE;
  return { minMs, maxMs: rawMax > minMs ? rawMax : minMs + MINUTE };
}

function newSince(entry, session) {
  const watermark = Number(session?.lastOrganizedAt ?? 0);
  return (entry?.messages ?? []).filter((message) => message.at > watermark);
}

/**
 * 判断一个会话当前是否该整理。返回 `{ok:true}` 或 `{ok:false, reason}`；
 * reason 是稳定短码，供日志与 `/hdm` 状态展示。
 */
export function shouldOrganize({ config, session, entry, now = Date.now(), force = false }) {
  const idle = config?.idle ?? {};
  if (!entry || !entry.count) return { ok: false, reason: "no-activity" };
  if (!force) {
    if (idle.enabled === false) return { ok: false, reason: "disabled" };
    const minUserMessages = Number(idle.minUserMessages ?? 2);
    if (entry.count < (Number.isFinite(minUserMessages) ? minUserMessages : 2)) {
      return { ok: false, reason: "too-few-messages" };
    }
  }
  const fresh = newSince(entry, session);
  if (!fresh.length) return { ok: false, reason: "no-new-dialogue" };
  if (force) return { ok: true, fresh };

  const { minMs, maxMs } = idleWindowMs(config);
  const idleFor = now - Number(entry.lastAt ?? now);
  if (idleFor < minMs) return { ok: false, reason: "too-recent" };
  if (idleFor >= maxMs) return { ok: false, reason: "too-stale" };

  const lastOrganizedAt = Number(session?.lastOrganizedAt ?? 0);
  if (lastOrganizedAt) {
    const minInterval = Number(idle.minIntervalMinutes ?? 60);
    const gap = (Number.isFinite(minInterval) ? minInterval : 60) * MINUTE;
    if (now - lastOrganizedAt < gap) return { ok: false, reason: "min-interval" };
  }
  return { ok: true, fresh };
}

function logPath(home) {
  return path.join(path.resolve(home), "state", "logs", LOG_FILE);
}

async function appendLog(home, entry) {
  const file = logPath(home);
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** 读最近 N 条维护日志（新→旧）。坏行跳过，不抛错。 */
export async function readMaintenanceLog(home, limit = 10) {
  let text = "";
  try {
    text = await fs.readFile(logPath(home), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 忽略损坏行
    }
  }
  return rows;
}

/** 今日已消耗的整理次数（只有真正调用过模型的 ok/skip 才计入预算）。 */
export async function todayRunCount(home, now = Date.now(), timeZone = "Asia/Shanghai") {
  const date = localDate(now, timeZone);
  const rows = await readMaintenanceLog(home, 500);
  return rows.filter((row) => row?.date === date && (row.result === "ok" || row.result === "skip")).length;
}

function stripFence(raw) {
  const text = String(raw ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}

/** 从模型输出里解析整理结果；不合法就抛错（由上层记为失败）。 */
export function parseOrganizeOutput(raw) {
  const text = stripFence(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("整理输出不是 JSON 对象");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`整理输出 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("整理输出必须是对象");
  if (parsed.skip === true) {
    return { skip: true, reason: clip(parsed.reason ?? "模型判定无需记忆", 120) };
  }
  const summary = String(parsed.summary ?? "").trim();
  if (summary.length < 10) throw new Error("整理输出 summary 少于 10 字");
  const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .map((term) => String(term ?? "").trim())
    .filter(Boolean)
    .slice(0, 12);
  if (keywords.length < 6) throw new Error(`整理输出 keywords 过少（${keywords.length}）`);
  return {
    skip: false,
    input: {
      summary: clip(summary, 1200),
      keywords,
      details: (Array.isArray(parsed.details) ? parsed.details : [])
        .map((item) => clip(item, 500))
        .filter(Boolean)
        .slice(0, 8),
      quotes: (Array.isArray(parsed.quotes) ? parsed.quotes : [])
        .map((item) => clip(item, 300))
        .filter(Boolean)
        .slice(0, 5),
      people: (Array.isArray(parsed.people) ? parsed.people : []).map((item) => clip(item, 40)).filter(Boolean).slice(0, 10),
      scene: clip(parsed.scene ?? "", 200),
      event: clip(parsed.event ?? "", 200),
      emotion: clip(parsed.emotion ?? "", 100),
      importance: Number.isFinite(Number(parsed.importance)) ? Math.min(5, Math.max(1, Math.round(Number(parsed.importance)))) : 3,
      source: "generated",
    },
  };
}

function summaryOf(text) {
  const match = /##\s*摘要\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(String(text ?? ""));
  return clip((match ? match[1] : String(text ?? "")).replace(/\s+/g, " ").trim(), TARGET_SUMMARY_MAX);
}

async function targetContext({ registry, session }) {
  const uid = session?.memoryUid ?? null;
  if (!uid) return { uid: null, text: "" };
  const meta = registry?.get?.(uid);
  if (!meta) return { uid, text: "" };
  try {
    const snapshot = await readSnapshot(meta, 2);
    return { uid, text: summaryOf(snapshot?.text) };
  } catch {
    return { uid, text: "" };
  }
}

function buildUserMessage({ targetText, incremental }) {
  return [
    "<已有记忆>",
    targetText || "（本会话还没有记忆单元）",
    "</已有记忆>",
    "",
    "<对话增量>",
    incremental,
    "</对话增量>",
  ].join("\n");
}

function failureMessage(error) {
  return clip(error instanceof Error ? error.message : String(error), 300);
}

/**
 * 整理单个会话。所有门槛都在这里判定；调用方只管遍历会话。
 * 返回 `{ok:true, uid, merged, chars}` 或 `{ok:false, reason, error?}`。
 */
export async function organizeSession({
  ctx,
  home,
  config,
  registry,
  state,
  sessionId,
  force = false,
  now = Date.now(),
  liveSession = null,
}) {
  const id = String(sessionId ?? "").trim();
  if (!id || !home) return { ok: false, reason: "invalid" };
  const entry = rings.get(ringKey(home, id)) ?? null;
  const session = state.getSession(id);
  const decision = shouldOrganize({ config, session, entry, now, force });
  if (!decision.ok) return decision;

  const idle = config?.idle ?? {};
  const maxInput = Number(idle.maxInputChars ?? 12000);
  const incremental = clip(
    decision.fresh.map((message) => `用户：${message.text}`).join("\n\n"),
    Number.isFinite(maxInput) && maxInput > 0 ? maxInput : 12000,
  );
  if (!incremental.trim()) return { ok: false, reason: "no-new-dialogue" };

  const timeZone = config?.timeZone ?? "Asia/Shanghai";
  const date = localDate(now, timeZone);
  const budget = Number(idle.maxRunsPerDay ?? 12);
  if (!force && Number.isFinite(budget) && budget > 0) {
    const used = await todayRunCount(home, now, timeZone);
    if (used >= budget) return { ok: false, reason: "daily-budget" };
  }

  const release = await acquireFileLock(home, `idle:${id}`, 120_000);
  try {
    // 水位线推进到「已消费的最后一条发言」之后：成功、跳过、失败都不重放同一批增量。
    const watermark = Math.max(now, Number(entry.lastAt ?? 0));
    const model = await resolveMaintenanceModel(ctx, config, { session: liveSession }).catch(() => null);
    if (!model) {
      await state.updateSession(id, {
        lastOrganizedAt: watermark,
        lastOrganizeError: "没有可用的维护模型",
      });
      await appendLog(home, {
        at: now,
        date,
        session: shortSessionId(id),
        result: "fail",
        reason: "no-model",
        inputChars: incremental.length,
      });
      return { ok: false, reason: "no-model" };
    }

    const target = await targetContext({ registry, session });
    const system = loadPrompt("idle-organize", config?.promptLang ?? "zh");
    let output;
    try {
      const limits = maintenanceLimits(config);
      const raw = await streamText(ctx, model, {
        system,
        messages: [{ role: "user", content: buildUserMessage({ targetText: target.text, incremental }) }],
        maxTokens: limits.maxTokens,
        maxMs: limits.timeoutMs,
      });
      output = parseOrganizeOutput(raw);
      if (output.skip) {
        await state.updateSession(id, {
          lastOrganizedUserAt: entry.lastAt ?? now,
          userMessageCount: entry.count,
          lastOrganizedAt: watermark,
          lastOrganizeError: null,
        });
        await appendLog(home, {
          at: now,
          date,
          session: shortSessionId(id),
          uid: target.uid,
          result: "skip",
          reason: output.reason,
          inputChars: incremental.length,
          outputChars: 0,
        });
        return { ok: false, reason: "skip", skipReason: output.reason };
      }

      const saved = await saveConversationMemory({
        registry,
        config,
        home,
        state,
        session: { id, cwd: session?.cwd ?? undefined },
        input: output.input,
        now,
        pin: true,
      });
      await pinSessionUnit(state, id, saved.unitUid);
      await state.updateSession(id, {
        lastOrganizedUserAt: entry.lastAt ?? now,
        userMessageCount: entry.count,
        lastOrganizedAt: watermark,
        lastOrganizeError: null,
      });
      await appendLog(home, {
        at: now,
        date,
        session: shortSessionId(id),
        uid: saved.unitUid,
        result: "ok",
        merged: saved.merged === true,
        model: `${model.provider}:${model.model}`,
        inputChars: incremental.length,
        outputChars: output.input.summary.length,
      });
      return { ok: true, uid: saved.unitUid, merged: saved.merged === true, chars: incremental.length };
    } catch (error) {
      // 失败不重试：把水位线推进到 now，避免同一批增量反复烧 token；错误留痕在 state 与日志里。
      const message = failureMessage(error);
      await state.updateSession(id, {
        lastOrganizedUserAt: entry.lastAt ?? now,
        userMessageCount: entry.count,
        lastOrganizedAt: watermark,
        idleAttempts: Number(session?.idleAttempts ?? 0) + 1,
        lastOrganizeError: message,
      });
      await appendLog(home, {
        at: now,
        date,
        session: shortSessionId(id),
        result: "fail",
        reason: message,
        inputChars: incremental.length,
      });
      ctx?.logger?.warn?.(`[hdm] 空闲整理失败 ${shortSessionId(id)}: ${message}`);
      return { ok: false, reason: "error", error: message };
    }
  } finally {
    await release().catch(() => undefined);
  }
}

/** 扫一遍所有活跃会话（`/hdm-idle` 与定时器共用）。串行执行，避免并发打满模型配额。 */
export async function runIdleScan({ ctx, home, config, registry, state, force = false, now = Date.now(), only = null, liveSession = null }) {
  const ids = only ? [String(only)] : activeSessions(home);
  const results = [];
  for (const id of ids) {
    try {
      const session = liveSession && String(liveSession.id ?? "") === id ? liveSession : null;
      results.push({
        sessionId: id,
        ...(await organizeSession({ ctx, home, config, registry, state, sessionId: id, force, now, liveSession: session })),
      });
    } catch (error) {
      results.push({ sessionId: id, ok: false, reason: "error", error: failureMessage(error) });
    }
  }
  return results;
}

/**
 * 注册空闲整理定时器；返回 dispose。
 * 优先用宿主的 `ctx.timer.interval`（可随插件卸载清理）；没有时退回 unref 过的
 * 原生定时器——绝不能因为一个后台整理器把 Node 事件循环钉住（测试会直接挂死）。
 */
export function startIdleOrganizeTimer({ ctx, home, config, registry, state }) {
  const idle = config?.idle ?? {};
  if (idle.enabled === false) return () => undefined;
  const checkMinutes = Number(idle.checkMinutes ?? 15);
  const period = (Number.isFinite(checkMinutes) && checkMinutes > 0 ? checkMinutes : 15) * MINUTE;

  let running = false;
  let disposed = false;
  const tick = () => {
    if (disposed || running) return;
    running = true;
    void runIdleScan({ ctx, home, config, registry, state })
      .catch((error) => ctx?.logger?.warn?.(`[hdm] idle scan failed: ${failureMessage(error)}`))
      .finally(() => {
        running = false;
      });
  };

  if (typeof ctx?.timer?.interval === "function") {
    const first = setTimeout(tick, MINUTE);
    first.unref?.();
    const dispose = ctx.timer.interval(tick, period);
    return () => {
      disposed = true;
      clearTimeout(first);
      if (typeof dispose === "function") dispose();
    };
  }

  const first = setTimeout(tick, MINUTE);
  const timer = setInterval(tick, period);
  first.unref?.();
  timer.unref?.();
  return () => {
    disposed = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** 面板与 `/hdm` 状态用的维护信息：生效模型、来源、最近运行、今日预算、空闲窗口。 */
export async function maintenanceInfo({ ctx, home, config, now = Date.now(), session = null }) {
  const timeZone = config?.timeZone ?? "Asia/Shanghai";
  const idle = config?.idle ?? {};
  const configured = Boolean(config?.maintenance?.provider && config?.maintenance?.model);
  const model = await resolveMaintenanceModel(ctx, config, { session }).catch(() => null);
  const runs = await readMaintenanceLog(home, 10);
  const used = await todayRunCount(home, now, timeZone);
  const budget = Number(idle.maxRunsPerDay ?? 12);
  const { minMs, maxMs } = idleWindowMs(config);
  return {
    model,
    source: configured ? "config" : model ? "auto" : "none",
    runs,
    today: { date: localDate(now, timeZone), used, budget: Number.isFinite(budget) && budget > 0 ? budget : 0 },
    idle: {
      enabled: idle.enabled !== false,
      minMinutes: Math.round(minMs / MINUTE),
      maxMinutes: Math.round(maxMs / MINUTE),
      checkMinutes: Number(idle.checkMinutes ?? 15),
      minIntervalMinutes: Number(idle.minIntervalMinutes ?? 60),
      maxRunsPerDay: Number.isFinite(budget) ? budget : 12,
    },
  };
}

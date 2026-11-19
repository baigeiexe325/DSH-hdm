// 压缩前记忆：上下文压缩（`/compact`）动手前，先用维护模型把这段对话存成一条记忆；
// 压缩完成后由下一步（agent/pre-step）把这条记忆与 IAM 一起交回给模型。
// 纯 ESM；只使用 Node 内置模块与包内模块。

import { pinSessionUnit, saveConversationMemory } from "./conversation.js";
import { parseOrganizeOutput } from "./idle.js";
import { maintenanceLimits, resolveMaintenanceModel, streamText } from "./llm.js";
import { readSnapshot } from "./memory.js";
import { loadPrompt } from "./prompts.js";

// 按会话记录进行中的压缩前记忆：后一次压缩覆盖前一次的 promise，并 abort 前一个模型调用，
// 否则前一个 summarize 仍会跑完并落盘，连续压缩就会写两条重复记忆。
const inflight = new Map();

const ROLE_LABEL = { user: "用户", assistant: "助手" };

function clip(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return max <= 1 ? "…" : `${value.slice(0, max - 1)}…`;
}

function blockText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * 把会话当前消息面拍成压缩前的对话文本。
 * 跳过 `plugin:*` 来源的消息——那是 HDM 自己注入的，回流进摘要只会自我复读。
 */
export function compactionTranscript(session, maxChars = 20000) {
  let messages = [];
  try {
    messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : [];
  } catch {
    return "";
  }
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const kind = message?.source?.kind;
    if (typeof kind === "string" && kind.startsWith("plugin:")) continue;
    const text = blockText(message);
    if (!text) continue;
    lines.push(`${ROLE_LABEL[role]}：${text}`);
  }
  const joined = lines.join("\n\n");
  const limit = Math.max(200, Number(maxChars) || 20000);
  if (joined.length <= limit) return joined;
  // 压缩前最要紧的是最近的决定与约束，超长时保留尾部。
  return `…（前文省略）\n${joined.slice(-(limit - 8))}`;
}

/** 最近一次「### 摘要」之后的内容：优先取最后一个追加段，没有追加段就取主摘要。 */
function lastSummary(text) {
  const sections = String(text ?? "").split(/^## /m);
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const body = sections[i];
    const match = body.match(/###?\s*摘要\s*\n([\s\S]*?)(?:\n###?\s|$)/);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

/**
 * 近期去重：本会话刚写过记忆就不要再总结一遍。
 * 判据是单元的 `updatedAt`（对话活动时间，派生快照不会刷新它），窗口由 `compaction.dedupeMinutes` 控制。
 * 只扫本会话自己的单元：别的会话的记忆再新也和这次压缩无关。
 */
function recentUnit({ registry, state, sessionId, now, minutes }) {
  if (!(Number(minutes) > 0)) return null;
  const windowMs = Number(minutes) * 60000;
  const ss = sessionId ? state.getSession(sessionId) : null;
  const uids = [...new Set([ss?.memoryUid, ...(ss?.uids ?? [])].filter(Boolean).map(String))];
  let best = null;
  for (const uid of uids) {
    const meta = registry.get(uid);
    if (!meta) continue;
    const at = Number(meta.updatedAt ?? meta.createdAt ?? 0);
    const ageMs = now - at;
    if (!(ageMs >= 0) || ageMs > windowMs) continue;
    if (!best || ageMs < best.ageMs) best = { meta, ageMs };
  }
  return best;
}

async function summarize({ ctx, home, config, registry, state, session, sessionId, transcript, now, signal }) {
  const startedAt = Date.now();
  const model = await resolveMaintenanceModel(ctx, config, { session: session ?? null }).catch(() => null);
  if (!model) throw new Error("没有可用的维护模型");
  const system = loadPrompt("compact", config?.promptLang ?? "zh");
  const limits = maintenanceLimits(config);
  const raw = await streamText(ctx, model, {
    system,
    messages: [{ role: "user", content: transcript }],
    maxTokens: limits.maxTokens,
    // 调用方 signal 由 streamText 与超时合并；被后一次压缩取代时整条流尽快结束。
    signal,
    maxMs: limits.timeoutMs,
  });
  const output = parseOrganizeOutput(raw);
  if (output.skip) return { ok: false, skipped: true, reason: output.reason };
  // 已被后一次压缩取代：绝不落盘，否则连续压缩会写两条重复记忆。
  if (signal?.aborted) return { ok: false, aborted: true, reason: "superseded" };
  const saved = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session: { id: sessionId, cwd: session?.header?.cwd },
    input: output.input,
    now,
    pin: true,
  });
  await pinSessionUnit(state, sessionId, saved.unitUid);
  const meta = typeof registry?.get === "function" ? registry.get(saved.unitUid) : null;
  return {
    ok: true,
    uid: saved.unitUid,
    summary: output.input.summary,
    path: meta?.folder ?? null,
    appendCount: Number(meta?.appendCount ?? 1),
    merged: saved.merged === true,
    wroteAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    deduped: false,
  };
}

function failureText(error) {
  return clip(error instanceof Error ? error.message : String(error ?? "unknown"), 300);
}

/**
 * `compaction/start`：同步拍下压缩前对话，随后用维护模型落一条记忆。
 * 返回进行中的 promise（没有可做的事时为 null），调用方不必等。
 */
export function noteCompactionStart({ ctx, home, config, registry, state, session, now = Date.now() }) {
  const sessionId = String(session?.id ?? "").trim();
  if (!sessionId) return null;
  // 取消上一次仍在跑的总结，再登记新的：settle 只等最新一次，旧的那条若继续跑就会重复落盘。
  inflight.get(sessionId)?.controller?.abort();
  inflight.delete(sessionId);
  if (config?.compaction?.memorize === false) return null;
  // 子代理的日志最终汇入父会话，单独存一条只会制造重复记忆。
  if (session?.header?.origin === "subagent") return null;
  const transcript = compactionTranscript(session, config?.compaction?.maxChars);
  if (!transcript.trim()) return null;

  // 刚刚手动存过（`hdm_save`）就别再总结一遍：同一次工作存两遍既费 token 又污染记忆。
  // 命中时仍然交回那条记忆，只是标记为「未重复写入」，让模型知道没有新落盘。
  const recent = recentUnit({ registry, state, sessionId, now, minutes: config?.compaction?.dedupeMinutes });
  if (recent) {
    const promise = (async () => {
      const snapshot = await readSnapshot(recent.meta, recent.meta.defaultLevel).catch(() => null);
      return {
        ok: true,
        uid: recent.meta.uid,
        summary: lastSummary(snapshot?.text),
        path: recent.meta.folder ?? null,
        appendCount: Number(recent.meta.appendCount ?? 1),
        merged: false,
        wroteAt: Number(recent.meta.updatedAt ?? now),
        elapsedMs: 0,
        ageMs: recent.ageMs,
        deduped: true,
      };
    })();
    inflight.set(sessionId, { promise, controller: null });
    return promise;
  }

  const controller = new AbortController();
  const promise = summarize({
    ctx,
    home,
    config,
    registry,
    state,
    session,
    sessionId,
    transcript,
    now,
    signal: controller.signal,
  }).catch((error) =>
    // 被取代时 streamText 可能因 abort 抛错：对外统一成 aborted，而不是一条普通失败。
    controller.signal.aborted
      ? { ok: false, aborted: true, reason: "superseded" }
      : { ok: false, error: failureText(error) },
  );
  inflight.set(sessionId, { promise, controller });
  return promise;
}

/** 压缩结束：按 waitMs 等记忆落盘，然后登记「下一步重注入 + 交回记忆」。 */
export async function settleCompaction({ config, state, session }) {
  const sessionId = String(session?.id ?? "").trim();
  if (!sessionId) return { ok: false, reason: "no-session" };
  const slot = inflight.get(sessionId);
  const pending = slot?.promise ?? null;
  inflight.delete(sessionId);

  let result = null;
  if (pending) {
    const waitMs = Math.max(1000, Number(config?.compaction?.waitMs) || 20000);
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), waitMs);
      // 不为了一个可选步骤拖住宿主进程退出。
      timer.unref?.();
    });
    result = await Promise.race([pending, timedOut]);
    if (timer) clearTimeout(timer);
  }

  if (result?.ok) {
    await state.updateSession(sessionId, {
      pendingContextReinject: true,
      pendingCompactMemory: {
        uid: result.uid,
        summary: result.summary,
        path: result.path,
        appendCount: result.appendCount ?? 1,
        merged: result.merged === true,
        deduped: result.deduped === true,
        wroteAt: result.wroteAt ?? null,
        elapsedMs: result.elapsedMs ?? null,
        ageMs: result.ageMs ?? null,
      },
      lastCompactError: null,
    });
    return result;
  }

  const reason = result?.timedOut ? "压缩前记忆超时" : result?.reason ?? result?.error ?? "没有进行中的压缩前记忆";
  await state.updateSession(sessionId, {
    pendingContextReinject: true,
    // 这次没写成：清掉上一次没被消费的记忆，否则旧记忆会被下一步当成「本轮压缩前已保存」重复注入。
    pendingCompactMemory: null,
    lastCompactError: clip(reason, 300),
  });
  return { ok: false, reason, error: result?.error ?? null };
}

/** 仅供测试与诊断：当前是否有进行中的压缩前记忆。 */
export function pendingCompactionCount() {
  return inflight.size;
}

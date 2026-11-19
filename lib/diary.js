// HDM diary: one narrative per day built from that day's default snapshots.
// Map-reduce over chunks (> inputMaxChars), LLM generated, deterministic fallback on failure.
// Kept dependency-free (node:* + ./llm.js + ./paths.js) so it runs before T1 storage lands.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./paths.js";
import { buildIamContext } from "./iam.js";
import { hasLlmStream, maintenanceLimits, modelDiagnostics, resolveMaintenanceModel, streamText } from "./llm.js";
import { loadPrompt } from "./prompts.js";

const CHECK_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DIARY_TIME = "23:30";
const DEFAULT_TZ = "Asia/Shanghai";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateParts(now, timeZone) {
  const date = new Date(now);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || DEFAULT_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value;
    return {
      date: `${value("year")}-${value("month")}-${value("day")}`,
      hour: Number(value("hour")),
      minute: Number(value("minute")),
    };
  } catch {
    return {
      date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
}

export function localDate(now = Date.now(), timeZone = DEFAULT_TZ) {
  return dateParts(now, timeZone).date;
}

function addDays(date, delta) {
  const [year, month, day] = String(date).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + delta * DAY_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function clip(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return max <= 1 ? "…" : `${value.slice(0, max - 1)}…`;
}

function summaryOf(text) {
  const match = /##\s*摘要\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(String(text || ""));
  return clip((match ? match[1] : String(text || "")).trim().replace(/\s+/g, " "), 160);
}

function keywordsOf(text) {
  const match = /关键词[：:]\s*(.+)/.exec(String(text || ""));
  return match ? match[1].split(/[,，、;；]/).map((term) => term.trim()).filter(Boolean) : [];
}

function chunkByLength(blocks, limit) {
  const size = Math.max(200, limit);
  const chunks = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const block of blocks) {
    const text = String(block ?? "");
    for (let start = 0; start < text.length; start += size) {
      const piece = text.slice(start, start + size);
      if (current && current.length + piece.length + 2 > size) flush();
      current += (current ? "\n\n" : "") + piece;
    }
  }
  flush();
  return chunks;
}

async function readDefaultSnapshot(home, meta) {
  const folder = meta?.folder || path.join(home, "memory", String(meta?.date || ""), String(meta?.label || ""));
  const levels = [...new Set([
    Number(meta?.defaultLevel),
    ...(Array.isArray(meta?.snapshots) ? meta.snapshots.map(Number) : []),
  ].filter((level) => Number.isInteger(level) && level >= 0))];
  for (const level of levels) {
    try {
      return await readFile(path.join(folder, `level${level}.txt`), "utf8");
    } catch {
      // try the next available snapshot
    }
  }
  return null;
}

function fallbackDiary(day, snapshots, maxChars, reason = "") {
  const summaries = snapshots.map(({ text }) => summaryOf(text)).filter(Boolean);
  const keywordCounts = new Map();
  for (const { meta, text } of snapshots) {
    for (const keyword of meta?.keywords || []) {
      const term = typeof keyword === "string" ? keyword : keyword?.term;
      if (term) keywordCounts.set(term, (keywordCounts.get(term) || 0) + 1);
    }
    for (const term of keywordsOf(text)) keywordCounts.set(term, (keywordCounts.get(term) || 0) + 1);
  }
  const topKeywords = [...keywordCounts.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]), "zh"))
    .slice(0, 12)
    .map(([term]) => term);

  const lines = [
    `# ${day} 日记`,
    "",
    // 兜底时把原因写进文件：定时器里的失败此前完全无声，用户只能看到一篇「拼接味」的日记。
    ...(reason ? ["## ⚠️ 生成失败", reason, "", "以下为确定性摘要拼接（兜底内容）。", ""] : []),
    "## 摘要",
    summaries.length
      ? clip(summaries.join(" "), Math.min(maxChars, 1200))
      : `${day} 共记录 ${snapshots.length} 条记忆。`,
    "",
    "## 关键词",
    topKeywords.join("、") || "（无）",
    "",
    "## 记忆编号",
    ...snapshots.map(({ meta }) => `- ${meta?.uid || "?"} ${meta?.label || ""}`.trim()),
  ];
  return clip(lines.join("\n"), maxChars);
}

// 日记写作提示词来自 prompts/zh/diary.md（loadPrompt("diary")）；缺失时回退到这段内联文案，
// 不让一个缺文件把整篇日记拖成确定性兜底。
const DIARY_WRITER_FALLBACK = "你是 HDM 的日记写作者，风格克制、具体，像真实日记。";

async function diarySystemPrompt(home, config) {
  let prompt = DIARY_WRITER_FALLBACK;
  try {
    prompt = loadPrompt("diary", config?.promptLang ?? "zh");
  } catch {
    prompt = DIARY_WRITER_FALLBACK;
  }
  const iam = home ? await buildIamContext(home, 2000).catch(() => "") : "";
  return iam ? `${iam}\n\n${prompt}` : prompt;
}

async function composeDiary({ ctx, home, config, model, day, snapshots, inputMax, maxChars }) {
  const limits = maintenanceLimits(config);
  const blocks = snapshots.map(({ meta, text }) => {
    const id = meta?.uid || meta?.label || "memory";
    return `记忆 ${id}（${meta?.label || meta?.date || ""}）\n${text}`;
  });
  const chunks = chunkByLength(blocks, inputMax);
  const summaries = [];

  for (const chunk of chunks) {
    if (chunks.length === 1) {
      summaries.push(chunk);
      continue;
    }
    const summary = await streamText(ctx, model, {
      maxTokens: limits.maxTokens,
      maxMs: limits.timeoutMs,
      system: "你在压缩日记素材。只输出中文摘要，不超过 300 字，保留人物、事件、结果、情绪，不要编造。",
      messages: [{ role: "user", content: chunk }],
    });
    summaries.push(clip(summary, 300));
  }

  const prompt = [
    `日期：${day}`,
    `请把下面 ${snapshots.length} 条记忆素材写成一篇中文日记。`,
    `要求：第一人称、按时间或主题组织；约 ${Math.max(200, Math.floor(maxChars * 0.6))} 字以内；只写素材中有的内容。`,
    "不要输出提示词、JSON 或额外说明。",
    "",
    summaries.join("\n\n"),
  ].join("\n");

  const text = await streamText(ctx, model, {
    maxTokens: limits.maxTokens,
    maxMs: limits.timeoutMs,
    system: await diarySystemPrompt(home, config),
    messages: [{ role: "user", content: prompt }],
  });
  return clip(text, maxChars);
}

/** Dates inside the catch-up window that have memories but no diary yet. */
export async function dueDiaryDates({ home, config, registry, now = Date.now() } = {}) {
  const diary = config?.diary;
  if (!home || diary?.enabled === false) return [];
  const zone = config?.timeZone || DEFAULT_TZ;
  const { date: today, hour, minute } = dateParts(now, zone);
  const dueAt = parseClock(diary?.time || DEFAULT_DIARY_TIME) ?? (23 * 60 + 30);
  const span = Math.max(1, Math.min(366, Number(diary?.catchUpDays) || 7));

  const memoryDates = new Set((registry?.list?.() || []).map((meta) => meta?.date).filter(Boolean));
  const dates = [];
  for (let back = span - 1; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    if (!memoryDates.has(date)) continue;
    if (date === today && hour * 60 + minute < dueAt) continue;
    if (await exists(path.join(home, "diary", `${date}.txt`))) continue;
    dates.push(date);
  }
  return dates;
}

/** Generate (or with force regenerate) one day's diary. Idempotent unless force. */
export async function runDiary({ ctx, home, config, registry, date, force = false, now = Date.now() } = {}) {
  if (!home) return { ok: false, path: null, fallback: false, error: "home required" };
  const diary = config?.diary || {};
  if (diary.enabled === false && !force) {
    return { ok: false, path: null, fallback: false, error: "diary disabled" };
  }
  const day = date || localDate(now, config?.timeZone);
  const file = path.join(home, "diary", `${day}.txt`);
  if (!force && await exists(file)) return { ok: true, path: file, fallback: false };

  const memories = (registry?.list?.() || []).filter((meta) => meta && meta.date === day);
  // 当天没有记忆不是错误：写一篇「今天没有需要记录的更新」的日记。
  // 之前这里直接 return "no memories"，定时器静默失败，用户只能看到日记一直不生成。
  if (!memories.length) {
    const text = [`# ${day} 日记`, "", "## 摘要", "今天没有需要记录的更新。", "", "## 关键词", "（无）", "", "## 记忆编号", "（无）"].join("\n");
    await atomicWrite(file, `${text.trim()}\n`);
    return { ok: true, path: file, fallback: false, empty: true };
  }

  const snapshots = [];
  for (const meta of memories) {
    const text = await readDefaultSnapshot(home, meta);
    if (text) snapshots.push({ meta, text });
  }
  if (!snapshots.length) return { ok: false, path: null, fallback: false, error: "no snapshot text" };

  const maxChars = Math.max(500, Number(diary.maxChars) || 8000);
  const inputMax = Math.max(500, Number(diary.inputMaxChars) || 12000);
  let model = null;
  try {
    model = await resolveMaintenanceModel(ctx, config);
  } catch {
    model = null;
  }
  const llmReady = !!model && hasLlmStream(ctx);

  try {
    if (!llmReady) throw new Error(`no maintenance model（${modelDiagnostics(ctx)}）`);
    const text = await composeDiary({ ctx, home, config, model, day, snapshots, inputMax, maxChars });
    await atomicWrite(file, `${text.trim()}\n`);
    return { ok: true, path: file, fallback: false };
  } catch (error) {
    const reason = String(error?.message || error);
    const text = fallbackDiary(day, snapshots, maxChars, reason);
    await atomicWrite(file, `${text.trim()}\n`);
    return { ok: false, path: file, fallback: true, error: reason };
  }
}

/** Check every 15 minutes; start with one catch-up sweep. Returns a stop function, or null when not registered. */
export function startDiaryTimer({ ctx, home, config, registry } = {}) {
  // null 表示「没注册」：调用方（triggers.js）据此决定心跳要不要兜底，不能和「已注册的空操作」混淆。
  if (!home || config?.diary?.enabled === false) return null;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const dates = await dueDiaryDates({ home, config, registry, now: Date.now() });
      for (const date of dates) {
        if (stopped) break;
        try {
          await runDiary({ ctx, home, config, registry, date, now: Date.now() });
        } catch (error) {
          ctx?.logger?.warn?.(`hdm diary ${date} failed: ${error?.message || error}`);
        }
      }
    } catch (error) {
      ctx?.logger?.warn?.(`hdm diary tick failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  };

  const runTick = () => {
    // tick 自身已兜底 try/catch；这里再挂 catch，避免任何漏网拒绝成为未处理拒绝。
    tick().catch((error) => ctx?.logger?.warn?.(`hdm diary tick failed: ${error?.message || error}`));
  };
  const timer = setInterval(runTick, CHECK_MS);
  if (typeof timer.unref === "function") timer.unref();
  runTick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// L2 派生 gist：给尚未派生 L1 的记忆生成一条短梗概，供自动召回直接注入。
//
// 为什么单独一个文件：forget.js 已经管 L2→L1→L0 的年龄派生、豁免、锁与 jobs 幂等，
// 把 gist 塞进去会让那条链更难读；gist 只是「注入用的摘要缓存」，成败都不该影响遗忘。
//
// 规则（见 README「自动召回的 gist」）：
// - 只对 `snapshots` 里没有 L1/L0 的记忆生成（「已派生 L1 的记忆不管」）——L1 本身就是要点，够用。
// - 存 `gist.txt`（单段纯文本，≤ maxChars）+ meta.gist；meta.gistAt 判断新旧。
// - 优先用维护模型压缩；模型不可用/失败时退回确定性摘要（首点 + 末点），绝不写空 gist。
// - 召回时只读 `meta.gist`，不再对 L2 做 120 字硬截断（那会砍掉最关键的结论/遗留）。

import { promises as fs } from "node:fs";
import path from "node:path";
import { hasLlmStream, maintenanceLimits, resolveMaintenanceModel, streamText } from "./llm.js";
import { acquireFileLock } from "./state.js";

const DEFAULT_CHARS = 120;
const DEFAULT_REFRESH_MINUTES = 30;
const LOCK_TTL_MS = 10 * 60 * 1000;
const GIST_FILE = "gist.txt";

/** 还停在 L2 的记忆才需要 gist；已派生 L1/L0 的跳过。 */
export function needsGist(meta) {
  if (!meta || meta.immortal) return false;
  const snapshots = Array.isArray(meta.snapshots) ? meta.snapshots.map(Number) : [];
  if (snapshots.some((level) => level === 1 || level === 0)) return false;
  return snapshots.includes(2) || snapshots.length === 0;
}

/** 每点一句话的摘要里取「首点 + 末点」：首点=谁做了什么，末点=结论/决定/遗留。 */
export function deterministicGist(summary, maxChars = DEFAULT_CHARS) {
  const text = String(summary ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const points = text.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/u).map((part) => part.trim()).filter(Boolean);
  const picked = points.length > 1 ? `${points[0]}${points[points.length - 1]}` : text;
  const chars = Array.from(picked);
  return chars.length <= maxChars ? picked : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function parseSummary(snapshotText) {
  const match = String(snapshotText ?? "").match(/##\s*摘要\s*\n([\s\S]*?)(?:\n##\s|$)/);
  return (match?.[1] ?? "").trim();
}

async function readLevel2(home, meta) {
  try {
    return await fs.readFile(path.join(meta.folder, "level2.txt"), "utf8");
  } catch {
    return "";
  }
}

async function writeGist(meta, text, now) {
  const file = path.join(meta.folder, GIST_FILE);
  await fs.writeFile(file, `${text}\n`, "utf8");
  meta.gist = text;
  meta.gistAt = now;
  await fs.writeFile(path.join(meta.folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return file;
}

async function llmGist({ ctx, config, text, maxChars }) {
  if (!hasLlmStream(ctx)) return "";
  try {
    const model = await resolveMaintenanceModel(ctx, config);
    if (!model) return "";
    const limits = maintenanceLimits(config);
    const out = await streamText(ctx, model, {
      system: [
        "你在压缩一条长期记忆的摘要。输出只有一句到两句纯文本，不用 markdown、不加项目符号、不要引号。",
        `最多 ${maxChars} 字。必须保留：谁做了什么、结论或决定、未完成或待确认的事。`,
        "省略过程、报错原文、路径清单。",
      ].join("\n"),
      messages: [{ role: "user", content: text.slice(0, 12000) }],
      maxTokens: Math.min(600, limits.maxTokens ?? 600),
    });
    return String(out ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * 为符合条件的一条记忆生成/刷新 gist。返回 {uid, ok, wrote, error?}。
 * 外部不传 registry 时只写文件与 meta.json，由调用方决定是否 upsert 到内存索引。
 */
export async function ensureGistFor({ ctx, home, config, meta, now = Date.now(), force = false } = {}) {
  if (!meta?.folder || !needsGist(meta)) return { uid: meta?.uid ?? "", ok: true, wrote: false };
  const maxChars = Number(config?.autoRecall?.gistChars) > 0
    ? Number(config.autoRecall.gistChars)
    : DEFAULT_CHARS;
  const fresh = !force && Number(meta.gistAt) >= Number(meta.updatedAt ?? 0) && String(meta.gist ?? "").trim();
  if (fresh) return { uid: meta.uid, ok: true, wrote: false };

  const snapshotText = await readLevel2(home, meta);
  if (!snapshotText) return { uid: meta.uid, ok: false, wrote: false, error: "missing level2" };
  const summary = parseSummary(snapshotText);
  const llm = await llmGist({ ctx, config, text: snapshotText, maxChars });
  const text = (llm || deterministicGist(summary, maxChars)).slice(0, maxChars);
  if (!text) return { uid: meta.uid, ok: false, wrote: false, error: "empty gist" };
  await writeGist(meta, text, now);
  return { uid: meta.uid, ok: true, wrote: true, gist: text };
}

/** 一轮巡检：扫全部记忆，只处理还停在 L2 的。 */
export async function runGistPass({ ctx, home, config, registry, now = Date.now(), force = false } = {}) {
  if (!home) return { processed: [] };
  if (config?.autoRecall?.enabled === false) return { processed: [] };
  // 档位 0 不自动召回，gist 没有消费者，不必烧维护模型。
  const level = Number(config?.autoRecall?.level ?? 1);
  if (!(level >= 1)) return { processed: [] };

  const release = await acquireFileLock(home, "gist", LOCK_TTL_MS).catch(() => null);
  if (!release) return { processed: [] };
  const processed = [];
  try {
    const listed = await registry?.list?.() ?? [];
    for (const meta of listed) {
      if (!needsGist(meta)) continue;
      try {
        const result = await ensureGistFor({ ctx, home, config, meta, now, force });
        if (result.wrote && typeof registry?.upsert === "function") await registry.upsert(meta);
        if (result.wrote || !result.ok) processed.push(result);
      } catch (error) {
        processed.push({ uid: meta.uid, ok: false, wrote: false, error: String(error?.message || error) });
      }
    }
  } finally {
    await release();
  }
  return { processed };
}

/** 每 gistRefreshMinutes 巡检一次（默认 30 分钟）；首轮延迟一个间隔，避免启动即烧模型。 */
export function startGistTimer({ ctx, home, config, registry } = {}) {
  if (!home || config?.autoRecall?.enabled === false) return () => {};
  const raw = Number(config?.autoRecall?.gistRefreshMinutes ?? DEFAULT_REFRESH_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_MINUTES;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runGistPass({ ctx, home, config, registry });
    } catch (error) {
      ctx?.logger?.warn?.(`[hdm] gist pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const GIST_DEFAULTS = Object.freeze({
  chars: DEFAULT_CHARS,
  refreshMinutes: DEFAULT_REFRESH_MINUTES,
  file: GIST_FILE,
});

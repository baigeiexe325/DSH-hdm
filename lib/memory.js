// HDM 记忆单元：创建、快照读写、keyness、顺序派生快照。
// 纯 ESM；只使用 Node 内置模块。

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  atomicWrite,
  ensureDir,
  eventSlug,
  localDate,
  localDateTime,
  parseMemoryFolderName,
  renameDirSafe,
  sessionSlug,
  slug,
} from "./paths.js";
import { KEYWORD_BANDS } from "./config.js";
import { acquireFileLock, createMutex } from "./state.js";

const LEVEL_DESCRIPTION = { 2: "完整细节", 1: "要点", 0: "gist" };
const MAX_DETAILS = { 2: 8, 1: 3, 0: 0 };
const MAX_QUOTES = { 2: 5, 1: 0, 0: 0 };
const SUMMARY_MAX = { 2: 1200, 1: 200, 0: 120 };

function charLength(text) {
  return Array.from(String(text ?? "")).length;
}

function truncateChars(text, max, suffix = "…") {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= max) return chars.join("");
  if (max <= 0) return "";
  return chars.slice(0, Math.max(0, max - suffix.length)).join("") + suffix;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** meta.gist 的字符上限：联想（associations.js）直接取用，不用再读快照文件。 */
const GIST_MAX = 120;

/**
 * meta.gist：当前摘要的截断版（≤120 字）。
 * 建单元、追加、派生成功后都要刷新，否则 associations.js 读到的永远是旧 gist。
 */
export function gistOf(summary, max = GIST_MAX) {
  return truncateChars(oneLine(summary), max);
}

function shortSessionId(sessionId) {
  const text = String(sessionId ?? "").trim();
  return text ? text.slice(0, 8) : "unknown";
}

function padSeq(seq) {
  return seq <= 999 ? String(seq).padStart(3, "0") : String(seq);
}

function normalizeSource(source) {
  const value = String(source ?? "").trim();
  return ["observed", "told", "inferred", "generated"].includes(value) ? value : "observed";
}

function uniqueStrings(values, limit = Infinity) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** 记忆文件夹绝对路径。 */
export function memoryFolder(home, date, label) {
  return path.join(home, "memory", String(date), String(label));
}

function replaceLevelPrefix(label, level) {
  const text = String(label ?? "");
  return /^[0-2]_/.test(text) ? `${level}_${text.slice(2)}` : `${level}_${text}`;
}

/** 记忆编号里单个词的最大长度：整词更可读，超过就不放进编号（避免 mergeSna 这类碎片）。 */
const LABEL_TERM_MAX = 24;
/** 记忆编号最多用几个词。 */
const LABEL_TERM_COUNT = 8;

/**
 * 关键词按 keyness 降序（同分保持原顺序）；入参缺 keyness 时分数记 0。
 * @param {Array<{term?: string, keyness?: number}>} keywords
 * @returns {string[]}
 */
export function rankKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .map((keyword, index) => ({
      term: String((keyword && typeof keyword === "object" ? keyword.term : keyword) ?? "").trim(),
      keyness: Number(keyword?.keyness ?? 0),
      index,
    }))
    .filter((item) => item.term)
    .sort((a, b) => {
      const diff = (Number.isFinite(b.keyness) ? b.keyness : 0) - (Number.isFinite(a.keyness) ? a.keyness : 0);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((item) => item.term);
}

/**
 * 记忆编号用的显示词：按 keyness 降序整词取，不截断单词。
 * 记忆编号必须由「当前关键词」算出，否则追加后编号会一直停在首次保存那批词上。
 * @param {Array<{term?: string, keyness?: number}>} keywords
 * @returns {string[]}
 */
export function labelTermsOf(keywords) {
  const out = [];
  for (const term of rankKeywords(keywords)) {
    const display = slug(term).replace(/_/g, "-");
    if (!display || Array.from(display).length > LABEL_TERM_MAX) continue;
    if (out.some((item) => item.toLowerCase() === display.toLowerCase())) continue;
    out.push(display);
    if (out.length >= LABEL_TERM_COUNT) break;
  }
  return out.length ? out : ["记忆"];
}

/** 记忆编号前缀：新格式 `<level>_<date>_<session8>_<serial2>_<event>`，缺 serial 时回落旧 `<level>_<date>_<seq>`。 */
export function memoryLabelPrefix({ date, seq, level = 2, session, serial, event } = {}) {
  const serialNumber = Number(serial ?? 0);
  if (Number.isInteger(serialNumber) && serialNumber > 0) {
    if (serialNumber > 99) throw new Error("HDM: 同一会话记忆单元超过 99 个，请拆分会话");
    return `${Number(level)}_${String(date)}_${sessionSlug(session)}_${String(serialNumber).padStart(2, "0")}_${eventSlug(event)}`;
  }
  // 缺 session/serial 的调用方（如 organize 的旧签名）仍要能算出编号，这里回退旧格式。
  return `${Number(level)}_${String(date)}_${padSeq(Number(seq) || 1)}`;
}

/**
 * 由当前关键词算出记忆编号。放不下时整词少取，不切碎单词。
 * 段序：`<level>_<date>_<session8>_<serial2>_<event>_<kw1..kw8>`。
 * @param {{date: string, level?: number, session?: string, serial?: number, event?: string, seq?: number, terms: string[], maxChars?: number}} spec
 */
export function buildMemoryLabel({ date, level = 2, session, serial, event, seq, terms, maxChars = 180 }) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : 180;
  const prefix = memoryLabelPrefix({ date, level, session, serial, event, seq });
  const out = [prefix];
  for (const term of Array.isArray(terms) ? terms : []) {
    const next = `${out.join("_")}_${term}`;
    if (next.length > limit) break;
    out.push(term);
  }
  return out.join("_");
}

/** 按当前关键词算出的期望编号（不落盘，只用于比对/修复）。 */
export function expectedMemoryLabel(meta, maxChars = 180) {
  const keywords = Array.isArray(meta?.keywords) ? meta.keywords : [];
  // 编号里的 serial 一旦写进 meta 就以它为准；旧单元没这个字段时看当前 label 是不是新格式，
  // 否则追加会把它改回旧格式（新格式单元被 organize/追加反复翻转）。
  const parsed = parseMemoryFolderName(meta?.label);
  const serial = Number(meta?.serial ?? (parsed?.format === "new" ? parsed.serial : 0));
  return buildMemoryLabel({
    date: meta?.date,
    level: Number(meta?.defaultLevel ?? 2),
    session: meta?.session ?? meta?.sessionId,
    serial,
    event: meta?.event ?? parsed?.event,
    seq: meta?.seq,
    terms: labelTermsOf(keywords),
    maxChars,
  });
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把快照头部的「记忆编号:」行改写成新 label；头部没有这一行就原样返回（不碰正文）。
 * @returns {{text: string, changed: boolean}}
 */
export function rewriteSnapshotLabel(text, previousLabel, nextLabel) {
  const source = String(text ?? "");
  if (!previousLabel || !nextLabel || previousLabel === nextLabel) return { text: source, changed: false };
  const pattern = new RegExp(`^记忆编号:\\s*${escapeRegExp(previousLabel)}\\s*$`, "m");
  if (!pattern.test(source)) return { text: source, changed: false };
  return { text: source.replace(pattern, `记忆编号: ${nextLabel}`), changed: true };
}

/**
 * 让记忆编号跟当前关键词对齐：改文件夹名 + 同步 meta.label/folder + 各快照头部「记忆编号」。
 * 编号没变、没有词、改名失败都不抛错（返回 changed/reason 由调用方决定怎么记录）。
 * @returns {Promise<{changed: boolean, label: string, folder: string, reason?: string}>}
 */
export async function relabelMemoryUnit(meta, maxChars = 180) {
  if (!meta?.uid) throw new Error("relabelMemoryUnit 需要带 uid 的 meta");
  const previousLabel = String(meta.label ?? "");
  const nextLabel = expectedMemoryLabel(meta, maxChars);
  const keep = (reason) => ({
    changed: false,
    label: previousLabel,
    folder: String(meta.folder ?? ""),
    reason,
  });
  if (!previousLabel) return keep("missing-label");
  if (nextLabel === previousLabel) return keep("unchanged");

  const previousFolder = String(meta.folder ?? "");
  if (!previousFolder) return keep("missing-folder");
  const nextFolder = path.join(path.dirname(previousFolder), nextLabel);
  try {
    await renameDirSafe(previousFolder, nextFolder);
  } catch (error) {
    return keep(`rename-failed: ${error?.message ?? error}`);
  }

  meta.label = nextLabel;
  meta.folder = nextFolder;
  const levels = Array.isArray(meta.snapshots) ? meta.snapshots.map(Number) : [2];
  for (const level of levels) {
    const file = path.join(nextFolder, `level${level}.txt`);
    try {
      const text = await fs.readFile(file, "utf8");
      const rewritten = rewriteSnapshotLabel(text, previousLabel, nextLabel);
      if (rewritten.changed) await atomicWrite(file, rewritten.text);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    await atomicJson(path.join(nextFolder, "meta.json"), meta);
  } catch {
    // meta.json 由后续 writeSnapshot 流程重写；这里失败不阻断追加。
  }
  return { changed: true, label: nextLabel, folder: nextFolder };
}

async function nextSeq({ registry, home, date }) {
  let max = 0;
  if (registry && typeof registry.list === "function") {
    for (const meta of registry.list()) {
      if (meta.date === date) max = Math.max(max, Number(meta.seq) || 0);
    }
  }
  try {
    const entries = await fs.readdir(path.join(home, "memory", date));
    for (const entry of entries) {
      const parsed = parseMemoryFolderName(entry);
      // 新格式没有 seq，目录扫描只能贡献旧格式；新格式单元的 seq 由 registry 汇总。
      if (parsed?.format === "legacy" && parsed.date === date) max = Math.max(max, parsed.seq);
      if (parsed?.format !== "new") continue;
      // registry 未 load（进程刚起/索引被删）时也要能从磁盘 meta.json 续上 seq，
      // 否则新单元会从 001 重新分配，和已有单元撞同一个 uid。
      try {
        const meta = JSON.parse(await fs.readFile(path.join(home, "memory", date, entry, "meta.json"), "utf8"));
        const seq = Number(meta?.seq);
        if (Number.isInteger(seq) && seq > 0) max = Math.max(max, seq);
        const match = /^m-(\d{8})-(\d+)$/.exec(String(meta?.uid ?? ""));
        if (match && match[1] === date.replace(/-/g, "")) max = Math.max(max, Number(match[2]));
      } catch {
        // 没有可读 meta：跳过
      }
    }
  } catch {
    // 目录还不存在
  }
  return max + 1;
}

/** 同一 (date, session8) 内的序号：取已有最大值 +1，上限 99。 */
async function nextSerial({ registry, home, date, session }) {
  let max = 0;
  if (registry && typeof registry.list === "function") {
    for (const meta of registry.list()) {
      if (meta.date !== date || sessionSlug(meta.sessionId) !== session) continue;
      max = Math.max(max, Number(meta.serial) || 0);
    }
  }
  try {
    const entries = await fs.readdir(path.join(home, "memory", date));
    for (const entry of entries) {
      const parsed = parseMemoryFolderName(entry);
      if (parsed?.format === "new" && parsed.date === date && parsed.session === session) {
        max = Math.max(max, parsed.serial);
      }
    }
  } catch {
    // 目录还不存在
  }
  const next = max + 1;
  if (next > 99) throw new Error("HDM: 同一会话记忆单元超过 99 个，请拆分会话");
  return next;
}

async function pathExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** uid 分配用的进程序列：不同 sessionId 的保存也必须排在一条队里。 */
const uidMutex = createMutex();

/**
 * 把「读 max seq → 分配 uid → 占目录 → 写快照」包成临界区。
 * conversation.js 的保存互斥键带 sessionId，挡不住两个会话并发保存；这里按 home+date 排队，
 * 再叠 state/ 下的文件锁兜跨进程（同一台机器的两个窗口/进程共享一个母文件夹）。
 * 拿不到锁直接抛错：序号如果在锁外继续分配，就会重演重复 uid、registry 后写覆盖先写。
 */
async function withUidLock(home, date, fn) {
  const key = `uid:${path.resolve(home)}:${date}`;
  return uidMutex.run(key, async () => {
    let release;
    try {
      release = await acquireFileLock(home, `uid:${date}`, 30_000, 20);
    } catch (error) {
      throw new Error(
        `HDM: 获取记忆序号分配锁失败（${date}），请稍后重试：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------- keyness

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 计算关键词 keyness。因子：模型顺序、摘要命中、人物、出现频率、IDF、专有名词、场景/事件。
 * @param {string[]} keywords 模型给出的关键词（重要性降序）
 * @param {object} ctx
 * @returns {Array<{term: string, keyness: number, levels: number[]}>}
 */
export function computeKeyness(keywords, ctx = {}) {
  const terms = uniqueStrings(keywords, 32);
  const n = terms.length;
  const summary = String(ctx.summary ?? "");
  const details = Array.isArray(ctx.details) ? ctx.details.map(String) : [];
  const quotes = Array.isArray(ctx.quotes) ? ctx.quotes.map(String) : [];
  const people = Array.isArray(ctx.people) ? ctx.people.map(String) : [];
  const scene = String(ctx.scene ?? "");
  const event = String(ctx.event ?? "");
  const body = [summary, ...details, ...quotes, scene, event].join("\n").toLowerCase();
  const summaryLower = summary.toLowerCase();
  const sceneLower = scene.toLowerCase();
  const eventLower = event.toLowerCase();
  const registry = ctx.registry;
  let totalDocs = 0;
  try {
    if (registry && typeof registry.list === "function") totalDocs = registry.list().length;
  } catch {
    totalDocs = 0;
  }

  return terms.map((term, index) => {
    const lower = term.toLowerCase();
    // 模型顺序：2..0
    const orderScore = n <= 1 ? 2 : 2 * (1 - index / (n - 1));
    let score = 3 + orderScore;
    if (summaryLower.includes(lower)) score += 1.5;

    const personHit = people.some((person) => {
      const name = person.toLowerCase();
      return name && (name.includes(lower) || lower.includes(name));
    });
    if (personHit) score += 1;

    const count = countOccurrences(body, lower);
    if (count > 0) score += Math.min(2, 0.5 * count);

    if (registry && totalDocs > 0) {
      let documentFrequency = 0;
      try {
        documentFrequency = registry.lookup([term]).size;
      } catch {
        documentFrequency = 0;
      }
      // 越稀有、越有区分度：df=0 时约 +0.6*ln(N+1)
      score += 0.6 * Math.log((totalDocs + 1) / (documentFrequency + 1));
    }

    // 专有名词：拉丁字母/大写/数字开头或含数字
    if (/[A-Za-z]/.test(term) && (/^[A-Za-z]/.test(term) || /[A-Z]/.test(term) || /\d/.test(term))) {
      score += 0.6;
    }

    if (sceneLower.includes(lower)) score += 0.4;
    if (eventLower.includes(lower)) score += 0.4;

    const keyness = Math.round(Math.min(10, Math.max(0.1, score)) * 100) / 100;
    return { term, keyness, levels: [] };
  });
}

/** 按 keyness 降序选词（同分保持原顺序），不是简单取前 N。 */
export function selectKeywords(keywords, count) {
  const list = (Array.isArray(keywords) ? keywords : []).map((keyword, index) => ({ keyword, index }));
  list.sort((a, b) => {
    const diff = Number(b.keyword?.keyness ?? 0) - Number(a.keyword?.keyness ?? 0);
    return diff !== 0 ? diff : a.index - b.index;
  });
  const limit = Math.max(0, Math.min(list.length, Math.floor(Number(count) || 0)));
  return list.slice(0, limit).map((item) => item.keyword);
}

// ---------------------------------------------------------------- snapshot text

function headerValue(text) {
  return oneLine(text).replace(/[|]/g, "/");
}

export function buildSnapshotText({
  meta,
  level,
  now,
  timeZone,
  sourceLevel = null,
  summary,
  details,
  quotes,
  keywords,
  scene,
  event,
  emotion,
  source,
  sourceHeader = {},
}) {
  const people = (meta.people ?? []).join(", ") || sourceHeader["人物"] || "无";
  const keywordText = (keywords ?? []).map((keyword) => keyword.term).join(", ") || "无";
  const lines = [
    `记忆编号: ${meta.label}`,
    `稳定ID: ${meta.uid}`,
    `快照等级: ${level}（${LEVEL_DESCRIPTION[level]}）`,
    `日期: ${meta.date}`,
    `时间: ${headerValue(sourceHeader["时间"]) || localDateTime(now, timeZone)}`,
    `会话: ${shortSessionId(meta.sessionId)}`,
    `来源: ${headerValue(source ?? sourceHeader["来源"]) || "observed"}`,
    `人物: ${headerValue(people)}`,
    `场景: ${headerValue(scene ?? sourceHeader["场景"]) || "无"}`,
    `事件: ${headerValue(event ?? sourceHeader["事件"]) || "无"}`,
    `情绪: ${headerValue(emotion ?? sourceHeader["情绪"]) || "无"}`,
    `关键词: ${headerValue(keywordText)}`,
    `生成时间: ${localDateTime(now, timeZone)}`,
  ];
  if (sourceLevel !== null && sourceLevel !== undefined) lines.push(`来源快照: level${sourceLevel}.txt`);
  const chunks = [lines.join("\n"), ""];
  const safeSummary = oneLine(summary) || "（无摘要）";
  chunks.push("## 摘要", safeSummary, "");
  const detailItems = (details ?? []).map((item) => oneLine(item)).filter(Boolean);
  if (detailItems.length) chunks.push("## 细节", ...detailItems.map((item) => `- ${item}`), "");
  const quoteItems = (quotes ?? []).map((item) => String(item ?? "").trim()).filter(Boolean);
  if (quoteItems.length) chunks.push("## 原话", ...quoteItems.map((item) => `> ${oneLine(item)}`), "");
  const related = (meta.relatedUids ?? []).filter(Boolean);
  const relatedLines = ["## 关联"];
  if (related.length) relatedLines.push(`- 记忆: ${related.join(", ")}`);
  relatedLines.push(`- 日记: diary/${meta.date}.txt`);
  chunks.push(relatedLines.join("\n"), "");
  return chunks.join("\n");
}

/** 解析快照文本：键值行头 + `##` 段落。 */
export function parseSnapshot(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const header = {};
  const sections = {};
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current !== null) sections[current] = buffer.join("\n").trim();
  };
  for (const line of lines) {
    const heading = /^\s*##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].trim();
      buffer = [];
      continue;
    }
    if (current === null) {
      if (!line.trim()) continue;
      const match = /^\s*([^:：]+)[:：]\s*(.*)$/.exec(line);
      if (match) header[match[1].trim()] = match[2].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return { header, sections };
}

// ---------------------------------------------------------------- append merge

/** 摘要要点编号：最多 10 点，超过只保留前 10。 */
const SUMMARY_POINTS = "①②③④⑤⑥⑦⑧⑨⑩";
const CIRCLED = /[\u2460-\u2473]/;

function stripCircled(text) {
  return String(text ?? "")
    .replace(/^[\u2460-\u2473\s]+/, "")
    .replace(/[\u2460-\u2473\s]+$/, "")
    .trim();
}

/** 把一段摘要拆成「点」：有 ①…⑩ 就按编号拆（编号在行首或行内都算），没有就整段算 1 点。 */
function splitSummaryPoints(text) {
  const raw = String(text ?? "");
  if (!CIRCLED.test(raw)) {
    const single = stripCircled(oneLine(raw));
    return single ? [single] : [];
  }
  return raw
    .split(/(?=[\u2460-\u2473])/)
    .map((part) => stripCircled(oneLine(part)))
    .filter(Boolean);
}

/** 去重用的归一化：去掉编号与首尾标点、小写、空白折叠。 */
function normalizePoint(text) {
  const plain = String(text ?? "")
    .replace(/[\u2460-\u2473]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return plain
    .replace(/^[\p{P}\p{S}\s]+/u, "")
    .replace(/[\p{P}\p{S}\s]+$/u, "");
}

/** 新点在前、旧点在后，归一化去重，最多 10 点。 */
function mergeSummaryPoints(freshPoints, oldPoints) {
  const out = [];
  const seen = new Set();
  for (const point of [...freshPoints, ...oldPoints]) {
    const key = normalizePoint(point);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(point);
    if (out.length >= SUMMARY_POINTS.length) break;
  }
  return out;
}

/** 按归一化文本去重（保持先后顺序），最多 limit 条。 */
function uniqueByNormalize(values, limit) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = normalizePoint(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/** 旧式「## 追加记忆 #N」块：按 ### 摘要 / ### 细节 / ### 原话 拆开。 */
function parseLegacyAppendBlock(block) {
  const out = { summary: [], details: [], quotes: [] };
  let current = null;
  for (const line of String(block ?? "").split(/\r?\n/)) {
    const heading = /^\s*###\s+(摘要|细节|原话)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      continue;
    }
    if (current === null) continue;
    if (current === "摘要") {
      const text = oneLine(line);
      if (text) out.summary.push(text);
    } else if (current === "细节") {
      const text = line.replace(/^\s*[-*]\s*/, "").trim();
      if (text) out.details.push(text);
    } else {
      const text = line.replace(/^\s*>\s*/, "").trim();
      if (text) out.quotes.push(text);
    }
  }
  return out;
}

/** 取「细节」段落的条目（去掉列表符号）。 */
function detailLinesOf(section) {
  return String(section ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

/** 取「原话」段落的条目（去掉引用符号）。 */
function quoteLinesOf(section) {
  return String(section ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*>\s*/, "").trim())
    .filter(Boolean);
}

/** 早期快照的段标题（单井号），新格式用 `##`。 */
const LEGACY_SECTIONS = ["摘要", "细节", "原话", "场景", "事件", "人物", "关键词", "说明"];

/**
 * 把早期格式快照（`# 摘要` / `# 细节` / `## 追加记忆 #N`）升级成当前键值头格式。
 *
 * 为什么必须升级：`parseSnapshot` 只认 `##`，早期文件的基础段会被当成「无段落」，
 * 追加时旧内容会被静默丢掉。升级后文件带 `记忆编号:` 行，可据此判定已升级（幂等）。
 *
 * @returns {{ text: string, upgraded: boolean }}
 */
export function upgradeLegacySnapshotText({
  text,
  meta,
  level = 2,
  now = Date.now(),
  timeZone = "Asia/Shanghai",
  keywords = [],
} = {}) {
  const source = String(text ?? "");
  if (!source.trim()) return { text: source, upgraded: false };
  if (/^记忆编号:/m.test(source)) return { text: source, upgraded: false };

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  // 顶层段：`# 标题` 换段。`## 追加记忆 #N` 不是普通正文：它必须单独立段交给
  // parseLegacyAppendBlock，否则会连同块内的 `### 摘要 / ### 细节 / ### 原话` 一起留在
  // 上一段（通常是 `# 原话`）里，整块被当成引用吞掉。
  const sections = [];
  let current = null;
  for (const line of lines) {
    const append = /^##\s+(追加记忆\s*#?\d+.*)$/.exec(line.trim());
    if (append) {
      current = { title: append[1].trim(), body: [] };
      sections.push(current);
      continue;
    }
    const top = /^#\s+([^\s#].*?)\s*$/.exec(line);
    if (top) {
      current = { title: top[1].trim(), body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  if (!sections.length) return { text: source, upgraded: false };

  const byTitle = new Map();
  const appendBlocks = [];
  for (const section of sections) {
    const body = section.body.join("\n");
    if (section.title.startsWith("追加记忆")) {
      appendBlocks.push(body);
      continue;
    }
    if (!LEGACY_SECTIONS.includes(section.title)) continue;
    if (!byTitle.has(section.title)) byTitle.set(section.title, []);
    byTitle.get(section.title).push(body);
  }

  const summaryPoints = [];
  const details = [];
  const quotes = [];
  for (const title of ["摘要", "细节", "原话", "说明"]) {
    for (const body of byTitle.get(title) ?? []) {
      if (title === "摘要") summaryPoints.push(...splitSummaryPoints(body));
      else if (title === "细节") details.push(...detailLinesOf(body));
      else if (title === "原话") quotes.push(...quoteLinesOf(body));
      // 「说明」是旧数据的事故备注：没有对应字段，折进细节，避免丢信息也不污染摘要。
      else for (const note of detailLinesOf(body)) details.push(`（说明）${note}`);
    }
  }
  for (const block of appendBlocks) {
    const legacy = parseLegacyAppendBlock(block);
    for (const line of legacy.summary) summaryPoints.push(...splitSummaryPoints(line));
    details.push(...legacy.details);
    quotes.push(...legacy.quotes);
  }

  // 迁移不套 L2 的摘要/细节上限：那会把 009 这类长记忆的正文裁掉一半。
  // 只做去重与编号；压缩留给 L1/L0 派生档（它们本来就会重写）。
  const points = uniqueByNormalize(summaryPoints, SUMMARY_POINTS.length);
  let summary = points.map((point, index) => `${SUMMARY_POINTS[index] ?? ""}${point}`).join("");
  if (!summary) return { text: source, upgraded: false };

  const firstText = (title) => (byTitle.get(title) ?? []).map((body) => oneLine(body)).find(Boolean) ?? "";
  const upgradedText = buildSnapshotText({
    meta,
    level,
    now,
    timeZone,
    sourceLevel: null,
    summary,
    details: uniqueByNormalize(details),
    quotes: uniqueByNormalize(quotes),
    keywords: (Array.isArray(keywords) ? keywords : []).filter((keyword) => String(keyword?.term ?? "").trim()),
    scene: firstText("场景"),
    event: firstText("事件"),
    emotion: "",
    source: "observed",
  });
  return { text: upgradedText, upgraded: true };
}

/**
 * 追加时的原地合并：解析现有快照，把新输入并进同一份摘要/细节/原话，不生成「追加记忆」段。
 * 兼容存量数据：旧式「## 追加记忆 #N」块里的 ### 摘要/细节/原话 会被拆出来，按原顺序并入。
 * @returns {{ text: string, summary: string, details: string[], quotes: string[] }}
 */
export function mergeSnapshotForAppend({
  currentText,
  meta,
  input = {},
  now = Date.now(),
  timeZone = "Asia/Shanghai",
  keywords = [],
} = {}) {
  const parsed = parseSnapshot(currentText);
  const sections = parsed.sections ?? {};
  const header = parsed.header ?? {};

  // 旧内容来源：正常段落 -> 旧式「追加记忆 #N」块（按文档顺序）。
  const oldSummaryPoints = [];
  const oldDetails = [];
  const oldQuotes = [];
  for (const [key, body] of Object.entries(sections)) {
    if (/^追加记忆 #\d+/.test(key)) {
      const legacy = parseLegacyAppendBlock(body);
      for (const line of legacy.summary) oldSummaryPoints.push(...splitSummaryPoints(line));
      oldDetails.push(...legacy.details);
      oldQuotes.push(...legacy.quotes);
      continue;
    }
    if (key === "摘要") oldSummaryPoints.push(...splitSummaryPoints(body));
    else if (key === "细节") oldDetails.push(...detailLinesOf(body));
    else if (key === "原话") oldQuotes.push(...quoteLinesOf(body));
  }

  // 摘要：新点在前、旧点在后，去重后重新编号；单行拼接，不换行。
  let points = mergeSummaryPoints(splitSummaryPoints(oneLine(input.summary)), oldSummaryPoints);
  const renderPoints = () => points.map((point, index) => `${SUMMARY_POINTS[index]}${point}`).join("");
  let summary = renderPoints();
  let dropped = false;
  // 超长从尾部（最旧的点）整点丢弃；已丢过就要给「…」留一个字符位。
  while (charLength(summary) + (dropped ? 1 : 0) > SUMMARY_MAX[2] && points.length > 1) {
    points = points.slice(0, -1);
    dropped = true;
    summary = renderPoints();
  }
  if (charLength(summary) > SUMMARY_MAX[2]) summary = truncateChars(summary, SUMMARY_MAX[2]);
  else if (dropped) summary = `${summary}…`;

  const freshDetails = (Array.isArray(input.details) ? input.details : []).map((item) => oneLine(item)).filter(Boolean);
  const details = uniqueByNormalize([...freshDetails, ...oldDetails], MAX_DETAILS[2]);
  const freshQuotes = (Array.isArray(input.quotes) ? input.quotes : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const quotes = uniqueByNormalize([...freshQuotes, ...oldQuotes], MAX_QUOTES[2]);

  // 头部：本次有值就用本次，否则沿用旧 header（"无" 视为空）；时间由 sourceHeader 沿用首次保存时间。
  const pickHeader = (fresh, key) => {
    const own = oneLine(fresh);
    if (own) return own;
    const previous = oneLine(header[key]);
    return previous && previous !== "无" ? previous : "";
  };
  const scene = pickHeader(input.scene, "场景");
  const event = pickHeader(input.event, "事件");
  const emotion = pickHeader(input.emotion, "情绪");
  const keywordItems = (Array.isArray(keywords) ? keywords : [])
    .map((keyword) => ({
      term: String(keyword && typeof keyword === "object" ? (keyword.term ?? "") : (keyword ?? "")).trim(),
    }))
    .filter((keyword) => keyword.term);

  const text = buildSnapshotText({
    meta,
    level: 2,
    now,
    timeZone,
    sourceLevel: null,
    summary,
    details,
    quotes,
    keywords: keywordItems,
    scene,
    event,
    emotion,
    source: header["来源"],
    sourceHeader: header,
  });
  return { text, summary, details, quotes };
}

// ---------------------------------------------------------------- create

/**
 * 创建记忆单元：只写 level2.txt + meta.json（不生成 L1/L0）。
 * @returns {Promise<{meta: object, keywordScores: Array}>}
 */
export async function createMemory({ registry, config, home, input = {}, session = {}, now = Date.now() }) {
  const cfg = config ?? {};
  const homeDir = path.resolve(home ?? cfg.homeDir ?? ".");
  const timeZone = cfg.timeZone ?? "Asia/Shanghai";
  const date = localDate(now, timeZone);
  const summary = oneLine(input.summary);
  if (!summary) throw new Error("摘要（summary）不能为空");

  const maxKeywordLen = Number(cfg.memory?.maxKeywordLen ?? 32);
  const terms = [];
  for (const rawKeyword of Array.isArray(input.keywords) ? input.keywords : []) {
    let term = String(rawKeyword ?? "").trim();
    if (!term) continue;
    const chars = Array.from(term);
    if (chars.length > maxKeywordLen) term = chars.slice(0, maxKeywordLen).join("");
    if (terms.some((item) => item.toLowerCase() === term.toLowerCase())) continue;
    terms.push(term);
  }
  if (!terms.length) throw new Error("至少需要一个关键词（keywords）");

  const details = (Array.isArray(input.details) ? input.details : [])
    .map((item) => oneLine(item))
    .filter(Boolean)
    .slice(0, MAX_DETAILS[2]);
  const quotes = (Array.isArray(input.quotes) ? input.quotes : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_QUOTES[2]);
  const people = uniqueStrings(input.people, 10);
  const scene = oneLine(input.scene);
  const event = oneLine(input.event);
  const emotion = oneLine(input.emotion);

  const keywordScores = computeKeyness(terms, {
    summary,
    details,
    quotes,
    people,
    scene,
    event,
    registry,
  });

  const sessionId = String(session?.sessionId ?? session?.id ?? (typeof session === "string" ? session : "")).trim();
  const session8 = sessionSlug(sessionId);
  const cwd = session?.cwd ?? input.cwd ?? null;
  const source = normalizeSource(input.source);
  const immortal = input.immortal === true;
  const relatedUids = uniqueStrings(input.relatedUids);
  const importance = Number.isFinite(Number(input.importance)) ? Number(input.importance) : 3;
  const maxChars = Number(cfg.memory?.filenameMaxChars ?? 180);

  // 记忆编号由「当前关键词」按 keyness 整词生成，与快照里的「关键词:」同源，
  // 追加时会重算（relabelMemoryUnit），不会冻结在首次保存那批词上。
  const labelTerms = labelTermsOf(keywordScores);

  // uid 只由 date+seq 决定：两个不同会话并发保存会拿到同一个 uid，registry 后写覆盖先写。
  // 「读 max seq → 分配 → 占目录 → 写快照」整段都在与 sessionId 无关的锁内完成，
  // 等待者重新分配的 nextSeq 才能看到刚占用的序号（meta.json 已落盘）。
  const meta = await withUidLock(homeDir, date, async () => {
    let seq = await nextSeq({ registry, home: homeDir, date });
    const serial = await nextSerial({ registry, home: homeDir, date, session: session8 });
    let label = "";
    let folder = "";
    let uid = "";
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const seqText = padSeq(seq);
      label = buildMemoryLabel({ date, session: session8, serial, event, level: 2, terms: labelTerms, maxChars });
      folder = memoryFolder(homeDir, date, label);
      uid = `m-${date.replace(/-/g, "")}-${seqText}`;
      const uidTaken = registry && typeof registry.get === "function" ? Boolean(registry.get(uid)) : false;
      if (!uidTaken && !(await pathExists(folder))) break;
      seq += 1;
      if (attempt === 15) throw new Error(`无法分配记忆序号（冲突过多）: ${date}`);
    }

    const created = {
      uid,
      label,
      folder,
      defaultLevel: 2,
      snapshots: [2],
      date,
      seq: Number(seq),
      serial,
      keywords: keywordScores.map((keyword) => ({ term: keyword.term, keyness: keyword.keyness, levels: [2] })),
      people,
      sessionId,
      cwd,
      createdAt: Number(now),
      updatedAt: Number(now),
      hitCount: 0,
      lastHitAt: null,
      immortal,
      immortalReason: immortal ? (input.immortalReason ?? null) : null,
      forget: { d2: null, d5: null },
      relatedUids,
      importance,
      source,
      scene,
      event,
      emotion,
      gist: gistOf(summary),
    };

    const text = buildSnapshotText({
      meta: created,
      level: 2,
      now,
      timeZone,
      summary,
      details,
      quotes,
      keywords: created.keywords,
      scene,
      event,
      emotion,
      source,
    });
    await ensureDir(folder);
    await atomicWrite(path.join(folder, "level2.txt"), text);
    await atomicJson(path.join(folder, "meta.json"), created);
    return created;
  });
  if (registry && typeof registry.upsert === "function") await registry.upsert(meta);
  return {
    meta,
    keywordScores: meta.keywords.map((keyword) => ({ ...keyword, levels: [...keyword.levels] })),
  };
}

// ---------------------------------------------------------------- read/write

/** 快照网格：meta.snapshots 里的合法档位（去重）；一个都没有即抛错。 */
function snapshotGrid(meta) {
  const snapshots = (Array.isArray(meta.snapshots) ? meta.snapshots : [])
    .map(Number)
    .filter((value) => value === 0 || value === 1 || value === 2);
  if (!snapshots.length) throw new Error(`记忆没有可用快照: ${meta.uid}`);
  return [...new Set(snapshots)];
}

/** 解析请求档：null/undefined/"auto" 取 defaultLevel；非整数抛错（文案与历史一致）。 */
function requestedLevel(meta, level) {
  const requested =
    level === undefined || level === null || level === "auto" ? Number(meta.defaultLevel) : Number(level);
  if (!Number.isInteger(requested)) throw new Error(`非法快照等级: ${String(level)}`);
  return requested;
}

/** 候选档位排序：距离最近优先，同距离取更高档（信息更多）。 */
function candidatesByDistance(grid, requested) {
  return [...grid].sort((a, b) => {
    const da = Math.abs(a - requested);
    const db = Math.abs(b - requested);
    if (da !== db) return da - db;
    return b - a;
  });
}

/**
 * 快照档位回退（纯函数、同步）：请求档存在则原样返回，否则取距离最近的可用档。
 * readSnapshot 与 recall 共用这一套语义，避免两处各写一份、将来漂移。
 * @returns {{level: number, fallback: boolean}} fallback=true 表示发生了回退
 */
export function resolveSnapshotLevel(meta, requested) {
  if (!meta) throw new Error("readSnapshot 需要 meta");
  const want = requestedLevel(meta, requested);
  const level = candidatesByDistance(snapshotGrid(meta), want)[0];
  return { level, fallback: level !== want };
}

/** 读取任意快照；请求档不存在时回退到最近的可用档。 */
export async function readSnapshot(meta, level) {
  if (!meta) throw new Error("readSnapshot 需要 meta");
  const want = requestedLevel(meta, level);
  const candidates = candidatesByDistance(snapshotGrid(meta), want);
  for (const actual of candidates) {
    const file = path.join(meta.folder, `level${actual}.txt`);
    try {
      const text = await fs.readFile(file, "utf8");
      return { level: actual, path: file, text, fallback: actual !== want };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`快照文件缺失: ${meta.uid}（已尝试 ${candidates.join(", ")}）`);
}

/** 写指定快照文件；返回文件路径。 */
export async function writeSnapshot(meta, level, content) {
  const value = Number(level);
  if (value !== 0 && value !== 1 && value !== 2) throw new Error(`非法快照等级: ${level}`);
  if (!meta?.folder) throw new Error("writeSnapshot 需要 meta.folder");
  const file = path.join(meta.folder, `level${value}.txt`);
  await ensureDir(meta.folder);
  await atomicWrite(file, String(content ?? ""));
  return file;
}

// ---------------------------------------------------------------- derive/commit

function summaryOfSnapshot(parsed) {
  return String(parsed?.sections?.["摘要"] ?? "").trim();
}

function detailsOfSnapshot(parsed) {
  const section = String(parsed?.sections?.["细节"] ?? "");
  return section
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function keywordsOfMeta(meta) {
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
  if (keywords.length) {
    return keywords
      .filter((keyword) => String(keyword?.term ?? "").trim())
      .map((keyword) => ({
        term: String(keyword.term).trim(),
        keyness: Number.isFinite(Number(keyword.keyness)) ? Number(keyword.keyness) : 0,
        levels: Array.isArray(keyword.levels) ? keyword.levels.map(Number).filter((v) => v === 0 || v === 1 || v === 2) : [],
      }));
  }
  return [];
}

/** 只保留 levels 含指定档位的关键词；没有 levels 字段（旧数据）视为全部通过。 */
function keywordsOfLevel(keywords, level) {
  return keywords.filter((keyword) => {
    const levels = Array.isArray(keyword.levels) ? keyword.levels : [];
    return !levels.length || levels.includes(level);
  });
}

function compressSummary(text, maxChars) {
  const clean = oneLine(text);
  if (!clean) return "（无摘要）";
  if (charLength(clean) <= maxChars) return clean;
  const sentences = clean.split(/(?<=[。！？!?；;])/).map((sentence) => sentence.trim()).filter(Boolean);
  let out = "";
  for (const sentence of sentences) {
    if (charLength(`${out}${sentence}`) > maxChars) break;
    out += sentence;
  }
  if (out) return out;
  return truncateChars(clean, maxChars);
}

function keywordCount(previousCount, band) {
  const [min, max] = band;
  if (previousCount <= min) return previousCount;
  const ratio = band === KEYWORD_BANDS[1] ? 0.85 : 0.8;
  const shrunk = Math.round(previousCount * ratio);
  return Math.max(min, Math.min(max, Math.min(previousCount, shrunk)));
}

function withLevel(levels, level) {
  const out = new Set(Array.isArray(levels) ? levels.map(Number) : []);
  out.add(level);
  return [...out].filter((value) => value === 0 || value === 1 || value === 2).sort((a, b) => a - b);
}

/**
 * 确定性派生：目标档 1 从 2，0 从 1。旧快照只读不重写。
 * opts.llmSummary / opts.llmDetails 可传入模型压缩结果；缺省用确定性规则。
 */
export function deriveSnapshotData(meta, targetLevel, opts = {}) {
  if (!meta) throw new Error("deriveSnapshotData 需要 meta");
  const target = Number(targetLevel);
  if (target !== 0 && target !== 1) throw new Error(`派生快照等级只能是 0 或 1，实际为 ${String(targetLevel)}`);
  if (meta.immortal && !opts.force) throw new Error("immortal 记忆不生成派生快照");
  const sourceLevel = target + 1;
  const snapshots = (Array.isArray(meta.snapshots) ? meta.snapshots : []).map(Number);
  if (!snapshots.includes(sourceLevel)) {
    throw new Error(`无法派生 L${target}：缺少来源快照 L${sourceLevel}（${meta.uid}）`);
  }

  let sourceText = typeof opts.sourceText === "string" ? opts.sourceText : null;
  if (sourceText === null) {
    const sourcePath = path.join(meta.folder, `level${sourceLevel}.txt`);
    try {
      sourceText = fsSync.readFileSync(sourcePath, "utf8");
    } catch {
      throw new Error(`无法读取来源快照: ${sourcePath}`);
    }
  }
  const parsed = parseSnapshot(sourceText);
  const maxSummary = SUMMARY_MAX[target];
  const llmSummary = typeof opts.llmSummary === "string" ? oneLine(opts.llmSummary) : "";
  const summary = truncateChars(llmSummary || compressSummary(summaryOfSnapshot(parsed), maxSummary), maxSummary);

  let details = [];
  if (target === 1) {
    const fromLlm = Array.isArray(opts.llmDetails) ? opts.llmDetails : null;
    const rawDetails = fromLlm ?? detailsOfSnapshot(parsed);
    details = rawDetails
      .map((item) => truncateChars(oneLine(item), 500))
      .filter(Boolean)
      .slice(0, MAX_DETAILS[1]);
  }

  const allKeywords = keywordsOfMeta(meta);
  const band = KEYWORD_BANDS[target];
  // L0 只从「L1 真正入选过」的关键词里收：否则 L0 可能挑到从未进 L1 的词，
  // gist 的关键词集合就不是 L1 集合的子集，越读越偏。
  // 旧数据的 keywords 可能没有 levels（空数组），此时不过滤；过滤后为空也退回全量，避免 L0 无关键词。
  const pool = target === 0 ? keywordsOfLevel(allKeywords, 1) : allKeywords;
  const source = pool.length ? pool : allKeywords;
  const selected = selectKeywords(source, keywordCount(source.length, band));
  const keywords = selected.map((keyword) => ({
    term: keyword.term,
    keyness: keyword.keyness,
    levels: withLevel(keyword.levels, target),
  }));

  return {
    level: target,
    summary,
    details,
    quotes: [],
    keywords,
  };
}

function mergeKeywordLevels(existing, fresh, target) {
  const map = new Map();
  for (const keyword of Array.isArray(existing) ? existing : []) {
    const term = String(keyword?.term ?? "").trim();
    if (!term) continue;
    map.set(term, {
      term,
      keyness: Number.isFinite(Number(keyword.keyness)) ? Number(keyword.keyness) : 0,
      levels: [...new Set((Array.isArray(keyword.levels) ? keyword.levels : [])
        .map(Number)
        .filter((value) => value === 0 || value === 1 || value === 2))].sort((a, b) => a - b),
    });
  }
  for (const keyword of Array.isArray(fresh) ? fresh : []) {
    const term = String(keyword?.term ?? "").trim();
    if (!term) continue;
    const current = map.get(term);
    const freshLevels = (Array.isArray(keyword.levels) ? keyword.levels : [])
      .map(Number)
      .filter((value) => value === 0 || value === 1 || value === 2);
    // 只合并本次真正派生出的词；档位取并集，不强行补 target。
    // 未入选的词完全不动——否则「L0 没选中的词也标了 0 档」，元数据就不再反映真实档位。
    const merged = [...new Set([...(current?.levels ?? []), ...freshLevels])].sort((a, b) => a - b);
    map.set(term, {
      term,
      keyness: Number.isFinite(Number(keyword.keyness)) ? Number(keyword.keyness) : (current?.keyness ?? 0),
      levels: merged.length ? merged : [target],
    });
  }
  return [...map.values()];
}

/**
 * 写新快照、更新 meta（snapshots/defaultLevel/forget/关键词档位）、
 * 重命名文件夹 `2_→1_` / `1_→0_`、更新注册表。旧快照保持冻结。
 *
 * options.overwrite === true：目标档已存在时允许重写（追加记忆后按需刷新派生档）；
 * 否则保持原语义——每个快照只生成一次，已存在即幂等短路。
 */
export async function commitDerivedSnapshot({ registry, meta, data, now = Date.now() }, options = {}) {
  if (!meta) throw new Error("commitDerivedSnapshot 需要 meta");
  if (!data) throw new Error("commitDerivedSnapshot 需要派生数据");
  const target = Number(data.level);
  if (target !== 0 && target !== 1) throw new Error(`只接受派生 L1/L0，实际为 ${String(data.level)}`);
  const snapshots = (Array.isArray(meta.snapshots) ? meta.snapshots : []).map(Number);
  const overwrite = options?.overwrite === true;
  if (snapshots.includes(target) && !overwrite) {
    // 幂等短路：顺带修复上一轮可能失败的文件夹改名（前缀与 defaultLevel 不一致）。
    const desiredPrefix = `${Number(meta.defaultLevel)}_`;
    if (/^[0-2]_/.test(String(meta.label ?? "")) && !String(meta.label).startsWith(desiredPrefix)) {
      const repairedLabel = replaceLevelPrefix(meta.label, Number(meta.defaultLevel));
      const repairedFolder = path.join(path.dirname(meta.folder), repairedLabel);
      try {
        await renameDirSafe(meta.folder, repairedFolder);
        meta.label = repairedLabel;
        meta.folder = repairedFolder;
        if (registry && typeof registry.upsert === "function") await registry.upsert(meta);
      } catch {
        // 仍失败则保留旧名，等待下一轮
      }
    }
    return meta;
  }
  const sourceLevel = target + 1;
  if (!snapshots.includes(sourceLevel)) {
    throw new Error(`无法提交 L${target}：缺少来源快照 L${sourceLevel}（${meta.uid}）`);
  }

  const timeZone = registry?.config?.timeZone ?? "Asia/Shanghai";
  const source = await readSnapshot(meta, sourceLevel);
  const sourceParsed = parseSnapshot(source.text);
  let scene = meta.scene ?? sourceParsed.header["场景"];
  let event = meta.event ?? sourceParsed.header["事件"];
  let emotion = meta.emotion ?? sourceParsed.header["情绪"];
  if (scene === "无") scene = "";
  if (event === "无") event = "";
  if (emotion === "无") emotion = "";
  const summary = truncateChars(oneLine(data.summary), SUMMARY_MAX[target]);
  const details = (Array.isArray(data.details) ? data.details : [])
    .map((item) => truncateChars(oneLine(item), 500))
    .filter(Boolean)
    .slice(0, MAX_DETAILS[target]);
  const keywords = Array.isArray(data.keywords) ? data.keywords : keywordsOfMeta(meta);
  // 快照头里的「记忆编号」必须是改名后的新 label（2_→1_ / 1_→0_），否则每条派生档都差一档。
  const newLabel = replaceLevelPrefix(meta.label, target);
  const text = buildSnapshotText({
    meta: { ...meta, label: newLabel },
    level: target,
    now,
    timeZone,
    sourceLevel,
    summary,
    details,
    quotes: [],
    keywords,
    scene,
    event,
    emotion,
    source: meta.source ?? sourceParsed.header["来源"] ?? "observed",
    sourceHeader: sourceParsed.header,
  });
  await writeSnapshot(meta, target, text);

  meta.snapshots = [...new Set([...snapshots, target])].sort((a, b) => a - b);
  meta.defaultLevel = target;
  meta.keywords = mergeKeywordLevels(meta.keywords, keywords, target);
  // gist 对齐到该档摘要（associations.js 直接读 meta.gist，不再回读快照文件）。
  meta.gist = gistOf(summary);
  meta.forget = { ...(meta.forget ?? { d2: null, d5: null }) };
  if (target === 1) meta.forget.d2 = Number(now);
  else meta.forget.d5 = Number(now);
  // 派生 L1/L0 是系统维护动作，不是对话活动：这里**不能**刷新 updatedAt。
  // 刷新会让旧单元的「最后活动时间」变成今天，于是 handoff 把它当成最近对话，
  // 跨天保存也会误判成「3 小时内还有对话」而追加进旧日期单元（日记 no memories 的根因之一）。

  // 先写文件，再改名；改名失败保留旧标签，下一轮修复（文件仍在旧文件夹中）。
  if (newLabel !== meta.label) {
    const newFolder = path.join(path.dirname(meta.folder), newLabel);
    try {
      await renameDirSafe(meta.folder, newFolder);
      meta.label = newLabel;
      meta.folder = newFolder;
    } catch {
      // 保留旧名：meta.folder 仍有效，索引/注册表照常更新。
    }
  }

  if (registry && typeof registry.upsert === "function") await registry.upsert(meta);
  return meta;
}

/** 手动重命名记忆文件夹（修复用）：改前缀、更新 meta 与注册表。 */
export async function renameMemoryFolder({ registry, meta, newDefaultLevel }) {
  if (!meta) throw new Error("renameMemoryFolder 需要 meta");
  const level = Number(newDefaultLevel);
  if (level !== 0 && level !== 1 && level !== 2) throw new Error(`非法快照等级: ${String(newDefaultLevel)}`);
  const newLabel = replaceLevelPrefix(meta.label, level);
  if (newLabel !== meta.label) {
    const newFolder = path.join(path.dirname(meta.folder), newLabel);
    await renameDirSafe(meta.folder, newFolder);
    meta.label = newLabel;
    meta.folder = newFolder;
  }
  meta.defaultLevel = level;
  meta.updatedAt = Date.now();
  if (registry && typeof registry.upsert === "function") await registry.upsert(meta);
  return meta;
}

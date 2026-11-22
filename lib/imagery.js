/**
 * Imagery 意象层（0.3.0 更新 2）：以关键词为线索的经历记忆。
 *
 * 与 memory/（按时间）互补：一个关键词一个 md，记「这个词对我意味着什么」与相关经历。
 * 只有关键词的记忆质量分达 threshold 才允许建条目；只追加不覆盖；索引 index/imagery.json。
 * 纯 ESM，仅依赖 Node 内置模块与 paths.js。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, atomicWrite, ensureDir, slug } from "./paths.js";

export const IMAGERY_DEFAULTS = Object.freeze({
  enabled: true,
  // 真实库校准：threshold=15 但单条记忆就能过线（hitCount 饱和到 10），故要求至少 2 条记忆。
  threshold: 15,
  minMemories: 2,
  hitFactor: 1,
  immortalBonus: 3,
  keynessWeight: 0.5,
  injectOnRecall: true,
  maxItems: 2,
  maxReadChars: 6000,
  maxExperience: 20,
});

const INDEX_VERSION = 1;
const MEANING_HEADING = "## 释义";
const EXPERIENCE_HEADING = "## 经历";
const INDEX_HEADING = "## 记忆索引";

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  return Math.round(finite(value) * 10) / 10;
}

export function imageryDir(home) {
  return path.join(path.resolve(home), "Imagery");
}

export function imageryIndexFile(home) {
  return path.join(path.resolve(home), "index", "imagery.json");
}

/**
 * 关键词记忆质量分：`(ΣhitCount + immortalBonus×immortal数) × hitFactor × (keynessWeight + keyness/10)`。
 * keyness 取该词在各记忆中的最大值；命中累计只算「含这个词的记忆」的 hitCount。
 */
export function scoreOf(stats, options = {}) {
  const thresholdless = { ...IMAGERY_DEFAULTS, ...options };
  return round1(
    (finite(stats.hitSum) + thresholdless.immortalBonus * finite(stats.immortal)) *
      thresholdless.hitFactor *
      (thresholdless.keynessWeight + finite(stats.keyness) / 10),
  );
}

/**
 * 全库按关键词汇总：term(原样) / keyness(最大值) / hitSum / immortal / memories / dates / uids。
 * @returns {Array<{key:string, term:string, keyness:number, hitSum:number, immortal:number, memories:number, score:number, uids:string[]}>}
 */
export function keywordStats(registry, options = {}) {
  const byKey = new Map();
  for (const meta of registry?.list?.() ?? []) {
    const hits = finite(meta.hitCount);
    for (const keyword of meta.keywords ?? []) {
      const term = typeof keyword === "string" ? keyword : keyword?.term;
      if (typeof term !== "string" || !term.trim()) continue;
      const key = term.trim().toLowerCase();
      const row =
        byKey.get(key) ??
        { key, term: term.trim(), keyness: 0, hitSum: 0, immortal: 0, memories: 0, uids: [] };
      row.keyness = Math.max(row.keyness, finite(keyword?.keyness));
      row.hitSum += hits;
      if (meta.immortal === true) row.immortal += 1;
      row.memories += 1;
      if (typeof meta.uid === "string" && !row.uids.includes(meta.uid)) row.uids.push(meta.uid);
      byKey.set(key, row);
    }
  }
  const rows = [...byKey.values()].map((row) => ({
    ...row,
    hitSum: round1(row.hitSum),
    score: scoreOf(row, options),
  }));
  rows.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return rows;
}

/** 分数达标且至少有 minMemories 条记忆承载的关键词（降序）；`limit` 默认 5。 */
export function eligibleKeywords(registry, options = {}, limit = 5) {
  const threshold = finite(options.threshold, IMAGERY_DEFAULTS.threshold);
  const minMemories = Math.max(1, Math.trunc(finite(options.minMemories, IMAGERY_DEFAULTS.minMemories)));
  return keywordStats(registry, options)
    .filter((row) => row.score >= threshold && row.memories >= minMemories)
    .slice(0, Math.max(0, Math.trunc(limit)));
}

function normalizeIndex(payload) {
  const raw = payload && typeof payload === "object" ? (payload.entries ?? payload) : null;
  const entries = new Map();
  if (!raw || typeof raw !== "object") return entries;
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== "object") continue;
    const term = String(value.term ?? "").trim();
    const file = String(value.file ?? "").trim();
    if (!term || !file) continue;
    entries.set(term.toLowerCase(), {
      term,
      file,
      score: finite(value.score),
      memories: finite(value.memories),
      hitSum: finite(value.hitSum),
      immortal: finite(value.immortal),
      keyness: finite(value.keyness),
      updatedAt: finite(value.updatedAt),
    });
  }
  return entries;
}

export async function loadImageryIndex(home) {
  try {
    const text = await fs.readFile(imageryIndexFile(home), "utf8");
    return normalizeIndex(JSON.parse(text));
  } catch {
    return new Map();
  }
}

async function saveImageryIndex(home, entries) {
  const out = {};
  for (const [key, value] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out[key] = value;
  await atomicJson(imageryIndexFile(home), { version: INDEX_VERSION, updatedAt: Date.now(), entries: out });
}

function template({ term, score, threshold, stats }) {
  const line = `> 关键词线索记忆；只追加，不覆盖。分数 ${score} / 阈值 ${threshold}（记忆 ${stats.memories} 条，命中累计 ${stats.hitSum}，豁免 ${stats.immortal}）。`;
  return [
    `# 意象：${term}`,
    "",
    line,
    "",
    MEANING_HEADING,
    "（待写）",
    "",
    EXPERIENCE_HEADING,
    "（待写）",
    "",
    INDEX_HEADING,
    "（暂无）",
    "",
  ].join("\n");
}

/** uid → 事件名与日期，用于给「经历」逐条生成不同备注（没有时退回给写入日）。 */
function metaMapOf(registry) {
  const map = new Map();
  for (const meta of registry?.list?.() ?? []) {
    const uid = typeof meta?.uid === "string" ? meta.uid : "";
    if (!uid) continue;
    const event = typeof meta?.event === "string" ? meta.event.trim().slice(0, 120) : "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(meta?.date ?? "")) ? String(meta.date) : "";
    if (event || date) map.set(uid, { event, date });
  }
  return map;
}

/** 在 `## 经历` 段末尾追加一行（段缺失时补在文件末尾；占位行「（待写）」先替换掉）。 */
function appendExperience(text, line) {
  const body = String(text ?? "").replace(/## 经历\n（待写）\n?/, "## 经历\n");
  const at = body.indexOf(EXPERIENCE_HEADING);
  if (at < 0) return `${body.replace(/\s+$/, "")}\n\n${EXPERIENCE_HEADING}\n${line}\n`;
  const rest = body.slice(at);
  const nextHeading = rest.slice(EXPERIENCE_HEADING.length).search(/^##\s/m);
  const cut = nextHeading < 0 ? body.length : at + EXPERIENCE_HEADING.length + nextHeading;
  const before = body.slice(0, cut).replace(/\s+$/, "");
  return nextHeading < 0 ? `${before}\n${line}\n` : `${before}\n${line}\n\n${body.slice(cut)}`;
}

/** 在 `## 记忆索引` 段追加 uid（已存在则不重复；占位行「（暂无）」先替换掉）。 */
function appendIndexUid(text, uid) {
  const body = String(text ?? "").replace(/## 记忆索引\n（暂无）\n?/, "## 记忆索引\n");
  const at = body.indexOf(INDEX_HEADING);
  if (at < 0) return `${body.replace(/\s+$/, "")}\n\n${INDEX_HEADING}\n- ${uid}\n`;
  const rest = body.slice(at);
  const nextHeading = rest.slice(INDEX_HEADING.length).search(/^##\s/m);
  const cut = nextHeading < 0 ? body.length : at + INDEX_HEADING.length + nextHeading;
  const section = body.slice(at, cut);
  if (section.includes(`- ${uid}`)) return body;
  const before = body.slice(0, cut).replace(/\s+$/, "");
  const tail = nextHeading < 0 ? "" : body.slice(cut);
  return tail ? `${before}\n- ${uid}\n\n${tail}` : `${before}\n- ${uid}\n`;
}

/**
 * 写一条意象：先校验分数达标，再落文件、最后落索引（顺序保证索引不指向不存在的文件）。
 * @returns {Promise<{ok:true, term:string, file:string, score:number, created:boolean}>}
 */
export async function writeImagery(home, registry, input = {}, options = {}) {
  const opts = { ...IMAGERY_DEFAULTS, ...options };
  const termText = String(input.term ?? "").trim();
  if (!termText) throw new Error("HDM: 意象需要 term。");
  const stats = keywordStats(registry, opts).find((row) => row.key === termText.toLowerCase());
  if (!stats) throw new Error(`HDM: 关键词「${termText}」不在记忆库里。`);
  if (stats.score < opts.threshold) {
    throw new Error(`HDM: 关键词「${termText}」分数 ${stats.score} 未达门槛 ${opts.threshold}，暂不能写意象。`);
  }
  const minMemories = Math.max(1, Math.trunc(finite(opts.minMemories, IMAGERY_DEFAULTS.minMemories)));
  if (stats.memories < minMemories) {
    throw new Error(
      `HDM: 关键词「${termText}」只出现在 ${stats.memories} 条记忆里，少于 ${minMemories} 条，单条记忆撑起的词不建意象。`,
    );
  }

  const entries = await loadImageryIndex(home);
  const existing = entries.get(termText.toLowerCase());
  const dir = imageryDir(home);
  await ensureDir(dir);
  const relative = existing?.file ?? path.join("Imagery", `${slug(termText)}.md`).replace(/\\/g, "/");
  const file = path.join(home, relative);
  const created = !existing;
  const meaning = String(input.meaning ?? "").trim().slice(0, 300);
  const note = String(input.note ?? "").trim().slice(0, 300);
  const uids = (Array.isArray(input.uids) ? input.uids : [])
    .map((uid) => String(uid ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);

  let text;
  if (created) {
    text = template({ term: stats.term, score: stats.score, threshold: opts.threshold, stats });
    if (meaning) text = text.replace("## 释义\n（待写）", `## 释义\n${meaning}`);
  } else {
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      text = template({ term: stats.term, score: stats.score, threshold: opts.threshold, stats });
    }
    if (meaning) {
      // 只追加，不覆盖旧释义：新释义另起一行，保留历史。
      text = text.includes("## 释义\n（待写）")
        ? text.replace("## 释义\n（待写）", `## 释义\n${meaning}`)
        : text.replace(/(## 释义\n)/, `$1${meaning}\n`);
    }
  }

  const stamp = new Date(finite(input.now, Date.now())).toISOString().slice(0, 10);
  // 备注逐条区分：notes[uid] > 单条时的 note > 该记忆的事件名；日期优先用记忆自己的日期。
  const perUid = input.notes && typeof input.notes === "object" ? input.notes : {};
  const metas = metaMapOf(registry);
  // 经历按记忆日期正序，读起来是一条时间线（同日保留传入顺序）。
  const ordered = [...uids].sort((a, b) => String(metas.get(a)?.date ?? "").localeCompare(String(metas.get(b)?.date ?? "")));
  const noteOf = (uid) =>
    String(perUid[uid] ?? "").trim().slice(0, 300) ||
    (ordered.length === 1 ? note : "") ||
    String(metas.get(uid)?.event ?? "").trim();
  const lines = ordered.map((uid) => {
    const own = noteOf(uid);
    const day = metas.get(uid)?.date || stamp;
    return `- ${day} ${uid}${own ? `：${own}` : ""}`;
  });
  for (const line of lines) text = appendExperience(text, line);
  for (const uid of ordered) text = appendIndexUid(text, uid);

  await atomicWrite(file, text);
  entries.set(stats.term.toLowerCase(), {
    term: stats.term,
    file: relative,
    score: stats.score,
    memories: stats.memories,
    hitSum: stats.hitSum,
    immortal: stats.immortal,
    keyness: stats.keyness,
    updatedAt: finite(input.now, Date.now()),
  });
  await saveImageryIndex(home, entries);
  return { ok: true, term: stats.term, file: relative, score: stats.score, created };
}

export async function listImagery(home) {
  const entries = await loadImageryIndex(home);
  return [...entries.values()].sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
}

export async function readImagery(home, term, maxChars = IMAGERY_DEFAULTS.maxReadChars) {
  const key = String(term ?? "").trim().toLowerCase();
  if (!key) throw new Error("HDM: 意象需要 term。");
  const entries = await loadImageryIndex(home);
  const entry = entries.get(key);
  if (!entry) throw new Error(`HDM: 没有「${term}」的意象条目。`);
  const text = await fs.readFile(path.join(home, entry.file), "utf8");
  const limit = Math.max(200, Math.trunc(finite(maxChars, IMAGERY_DEFAULTS.maxReadChars)));
  return { entry, text: text.slice(0, limit), truncated: text.length > limit };
}

/** 扫 Imagery/*.md 重建索引（md 是权威，索引可丢）。 */
export async function rebuildImagery(home, registry, options = {}) {
  const opts = { ...IMAGERY_DEFAULTS, ...options };
  const dir = imageryDir(home);
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    files = [];
  }
  const stats = new Map(keywordStats(registry, opts).map((row) => [row.key, row]));
  const entries = new Map();
  for (const name of files.sort()) {
    let text = "";
    try {
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const match = text.match(/^#\s*意象：(.+)$/m);
    const term = (match?.[1] ?? path.basename(name, path.extname(name))).trim();
    if (!term) continue;
    const row = stats.get(term.toLowerCase());
    entries.set(term.toLowerCase(), {
      term,
      file: `Imagery/${name}`,
      score: row?.score ?? 0,
      memories: row?.memories ?? 0,
      hitSum: row?.hitSum ?? 0,
      immortal: row?.immortal ?? 0,
      keyness: row?.keyness ?? 0,
      updatedAt: Date.now(),
    });
  }
  await saveImageryIndex(home, entries);
  return entries.size;
}

/** recall 命中行附带用：把命中关键词里已建意象的条目挑出来（最多 maxItems 条）。 */
export async function imageryRefs(home, terms, maxItems = IMAGERY_DEFAULTS.maxItems) {
  const keys = (Array.isArray(terms) ? terms : []).map((term) => String(term ?? "").trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return [];
  const entries = await loadImageryIndex(home);
  const out = [];
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry || out.some((ref) => ref.term.toLowerCase() === entry.term.toLowerCase())) continue;
    out.push({ term: entry.term, file: entry.file, score: entry.score });
    if (out.length >= Math.max(0, Math.trunc(finite(maxItems, IMAGERY_DEFAULTS.maxItems)))) break;
  }
  return out;
}

export default {
  IMAGERY_DEFAULTS,
  imageryDir,
  imageryIndexFile,
  keywordStats,
  scoreOf,
  eligibleKeywords,
  loadImageryIndex,
  writeImagery,
  listImagery,
  readImagery,
  rebuildImagery,
  imageryRefs,
};

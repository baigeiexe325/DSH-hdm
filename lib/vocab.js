/**
 * HDM 记忆词表与词面模糊匹配（0.3.0）。
 *
 * 三件事，注入与检索共用同一份口径：
 * - buildKeywordTable：全库关键词按 keyness × 时间衰减聚合后从高到低排；
 * - matchWindowTerms：模型给的关键词与词表词条做三级匹配（精确 / 包含 / 编辑距离）；
 * - vocabText：按词数上限与字数预算拼成一行给模型看。
 *
 * 纯 ESM，只依赖 associations.js 的 normalizeTerm / genericTermsOf。
 */
import { genericTermsOf, normalizeTerm } from "./associations.js";

export const VOCAB_DEFAULTS = Object.freeze({
  /** 默认向模型展示的词数。 */
  topN: 50,
  /** 检索粗查的窗口宽度（每窗多少个词）。 */
  windowSize: 50,
  /** 粗查最多扫到第几个词；还没凑够就先返回空再细找。 */
  maxWindowEnd: 250,
  /** 每进一个窗口，检索条数期望乘这个系数（向下取整，最低 1）。 */
  expectDecay: 0.8,
  /** 时间衰减下限：再老的记忆也保留 1/4 权重。 */
  decayFloor: 0.25,
  /** 时间衰减窗口（天）：线性降到下限。 */
  decayWindowDays: 30,
  /** 包含匹配时较短一侧的最少字数（单字太容易扩散）。 */
  minOverlapChars: 2,
  /** 编辑距离放宽只对拉丁词生效，且两侧都不短于这个长度。 */
  editMinChars: 4,
  /** 允许的编辑距离。 */
  editDistance: 1,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const LATIN_RE = /^[a-z0-9][a-z0-9 ._+\-]*$/i;

function decayOf(meta, timestamp) {
  const stamp = Number(meta.updatedAt ?? meta.createdAt ?? 0);
  if (!Number.isFinite(stamp) || stamp <= 0) return VOCAB_DEFAULTS.decayFloor;
  const ageDays = Math.max(0, (timestamp - stamp) / DAY_MS);
  return Math.max(VOCAB_DEFAULTS.decayFloor, 1 - ageDays / VOCAB_DEFAULTS.decayWindowDays);
}

/**
 * 全库关键词排名：同一个词跨记忆累加 (keyness + 1) × 时间衰减。
 * 领域泛词（在 >30% 记忆里出现）不参与——它们几乎每条记忆都有，占掉词位却不定位任何一条。
 * @param {object} registry 形状同 Registry：list()
 * @param {{now?:number, limit?:number}} [options]
 * @returns {Array<{term:string, score:number}>}
 */
export function buildKeywordTable(registry, { now = Date.now(), limit = VOCAB_DEFAULTS.maxWindowEnd } = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const generic = genericTermsOf(registry);
  // 按归一化键聚合：`HDM` / `hdm` 是同一个词，各占一个词位会把词表稀释掉。
  // 展示时保留**首次出现**的原始写法，调用方的 [{term, score}] 形状不变。
  const scores = new Map();
  for (const meta of registry.list()) {
    const decay = decayOf(meta, timestamp);
    for (const keyword of meta.keywords ?? []) {
      const term = typeof keyword === "string" ? keyword : keyword?.term;
      if (typeof term !== "string" || !term.trim()) continue;
      const key = normalizeTerm(term) || term.trim();
      if (generic.has(key)) continue;
      const weight = Number(keyword?.keyness ?? meta.importance ?? 1) + 1;
      const contribution = (Number.isFinite(weight) ? weight : 1) * decay;
      const row = scores.get(key);
      if (row) row.score += contribution;
      else scores.set(key, { term: term.trim(), score: contribution });
    }
  }
  const rows = [...scores.values()].sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return rows.slice(0, Math.max(0, Math.trunc(limit))).map(({ term, score }) => ({ term, score }));
}

/** 按词数上限与字数预算（term + "、" 各占位 3）拼成一行；预算 0 表示不注入。 */
export function vocabText(table, maxChars) {
  const budget = Number(maxChars);
  if (!(budget > 0)) return "";
  const picked = [];
  let chars = 0;
  for (const { term } of Array.isArray(table) ? table : []) {
    if (chars + term.length + 3 > budget) break;
    picked.push(term);
    chars += term.length + 3;
  }
  return picked.join("、");
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > VOCAB_DEFAULTS.editDistance) return VOCAB_DEFAULTS.editDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** 三级匹配：3=同词，2=一方包含另一方（较短侧 ≥2 字），1=拉丁词编辑距离 ≤1。 */
function matchScore(query, term) {
  if (query === term) return 3;
  const shorter = query.length <= term.length ? query : term;
  const longer = shorter === query ? term : query;
  if (shorter.length >= VOCAB_DEFAULTS.minOverlapChars && longer.includes(shorter)) return 2;
  if (
    LATIN_RE.test(query) &&
    LATIN_RE.test(term) &&
    query.length >= VOCAB_DEFAULTS.editMinChars &&
    term.length >= VOCAB_DEFAULTS.editMinChars &&
    editDistance(query, term) <= VOCAB_DEFAULTS.editDistance
  ) {
    return 1;
  }
  return 0;
}

/**
 * 在词表 [start, end) 窗口内找与查询词匹配的词条，按匹配等级降序、词表原序稳定排序。
 * @param {string[]} queryTerms 已归一化的查询词
 * @param {Array<{term:string, score:number}>} table
 * @returns {Array<{term:string, match:"exact"|"contains"|"near", score:number, rank:number}>}
 */
export function matchWindowTerms(queryTerms, table, { start = 0, end = table.length } = {}) {
  const queries = (Array.isArray(queryTerms) ? queryTerms : []).map(normalizeTerm).filter(Boolean);
  if (!queries.length) return [];
  const from = Math.max(0, Math.trunc(start));
  const to = Math.min(table.length, Math.max(from, Math.trunc(end)));
  const hits = [];
  for (let rank = from; rank < to; rank += 1) {
    const term = table[rank].term;
    const key = normalizeTerm(term);
    if (!key) continue;
    let best = 0;
    for (const query of queries) {
      const score = matchScore(query, key);
      if (score > best) best = score;
      if (best === 3) break;
    }
    if (!best) continue;
    hits.push({ term, match: best === 3 ? "exact" : best === 2 ? "contains" : "near", score: best, rank });
  }
  hits.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return hits;
}

export default { VOCAB_DEFAULTS, buildKeywordTable, vocabText, matchWindowTerms };

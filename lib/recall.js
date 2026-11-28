/**
 * HDM 记忆调取（PLAN.md §5.3 / §6，interfaces.md `lib/recall.js`）。
 *
 * 纯 ESM，仅依赖 Node 内置模块；不 import T1 的 config/registry 等模块，
 * 便于用 fake registry 单测。registry 只要求 `get/list/lookup/bumpHit` 形状。
 */
import { genericTermsOf, normalizeTerm, relatedMemories } from "./associations.js";
import { buildCharacterSnippet, characterPath as characterPathOf, loadAliases } from "./characters.js";
import { resolveSnapshotLevel } from "./memory.js";
import { imageryRefs } from "./imagery.js";
import { VOCAB_DEFAULTS, buildKeywordTable, matchWindowTerms } from "./vocab.js";

/** 单个关键词长度上限（字符/code point）。 */
export const MAX_KEYWORD_CHARS = 32;

/** 自动召回/检索的 hitCount 增量 = Σ(命中词 keyness) × 该系数（hdm_read 仍固定 +1）。 */
export const HIT_DELTA_PER_KEYNESS = 0.2;

export const RECALL_DEFAULTS = Object.freeze({
  // 0 = 跟随输入关键词数（0.3.0）：模型给几个词就期望找回几条。
  topK: 0,
  levelBias: 1,
  usageBoost: 1,
  recencyBoost: 2,
  recencyWindowDays: 30,
  pinnedBoost: 3,
  // 泛词（HDM、IAM 这类占库 >30% 的词）命中时按这个系数折算，避免「提一句 HDM」就把无关记忆全拉进来。
  // 单独命中仍然可以召回，只是累计权重可能够不到 minScore，由分数门槛统一裁决。
  genericWeight: 0.3,
});

const MAX_TOP_K = 12;
const MAX_HIT_COUNT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SPLIT_RE = /[，,、;；\s]+/u;
const LEADING_PUNCT_RE = /^[\p{P}\p{Z}]+/u;
const TRAILING_PUNCT_RE = /[\p{P}\p{Z}]+$/u;
const BOOST_MODES = new Set(["none", "usage", "recency", "pinned"]);

/* ------------------------------------------------------------------ */
/* 关键词归一化                                                         */
/* ------------------------------------------------------------------ */

function stripEdgePunctuation(text) {
  return text.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "");
}

/**
 * 归一化用户/模型给出的关键词：
 * NFKC → lowercase → 按 `[，,、;；\s]+` 拆分 → 去首尾标点 → 单关键词 ≤32 → 去重。
 * @param {string[]|string|null|undefined} input
 * @returns {string[]}
 */
export function normalizeKeywords(input) {
  const list = Array.isArray(input) ? input : input == null ? [] : [input];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (item == null) continue;
    const text = String(item).normalize("NFKC").toLowerCase();
    for (const rawPart of text.split(SPLIT_RE)) {
      let term = stripEdgePunctuation(rawPart);
      if (!term) continue;
      const chars = Array.from(term);
      if (chars.length > MAX_KEYWORD_CHARS) term = chars.slice(0, MAX_KEYWORD_CHARS).join("");
      if (!term || seen.has(term)) continue;
      seen.add(term);
      result.push(term);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* config / registry 兼容辅助（调用方可能传 resolveConfig 结果或扁平对象） */
/* ------------------------------------------------------------------ */

function configGet(config, key, fallback) {
  if (!config || typeof config !== "object") return fallback;
  let cursor = config;
  for (const part of key.split(".")) {
    if (cursor && typeof cursor === "object" && part in cursor) cursor = cursor[part];
    else {
      cursor = undefined;
      break;
    }
  }
  if (cursor !== undefined) return cursor;
  return key in config ? config[key] : fallback;
}

function configNumber(config, key, fallback) {
  const value = Number(configGet(config, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** hitCount 是加权浮点：夹 0~MAX_HIT_COUNT 并保留两位小数（与 registry.clampHitCount 同口径）。 */
function clampHit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(MAX_HIT_COUNT, n)) * 100) / 100;
}

function getMemory(registry, uid) {
  if (!registry || typeof uid !== "string" || !uid) return null;
  if (typeof registry.get === "function") {
    const meta = registry.get(uid);
    if (meta && typeof meta === "object") return meta;
  }
  if (registry.memories instanceof Map) {
    const meta = registry.memories.get(uid);
    if (meta) return meta;
  }
  if (registry.memories && typeof registry.memories === "object" && registry.memories[uid]) {
    return registry.memories[uid];
  }
  if (registry instanceof Map) return registry.get(uid) ?? null;
  const direct = registry[uid];
  if (direct && typeof direct === "object" && direct.uid === uid) return direct;
  return null;
}

function listMemories(registry) {
  if (!registry) return [];
  if (typeof registry.list === "function") {
    const list = registry.list();
    if (Array.isArray(list)) return list.filter((meta) => meta && typeof meta === "object");
  }
  if (registry.memories instanceof Map) return [...registry.memories.values()];
  if (registry.memories && typeof registry.memories === "object") return Object.values(registry.memories);
  if (registry instanceof Map) return [...registry.values()];
  return Object.values(registry).filter(
    (value) => value && typeof value === "object" && typeof value.uid === "string",
  );
}

/**
 * 人物名候选：people 字段里出现查询词的记忆也算命中。
 * 人物名通常不是关键词，只走关键词倒排就会「搜人名搜不到」；这里只把它们加进候选，
 * 不写进 matchedKeywords、不加权重（权重公式只奖励关键词命中），避免「用户」这类泛称把排序搅乱。
 * 给了 home 才读 `characters/_aliases.json`：查询词与 people 都先归一到规范名再等值比较（与
 * charactersFor 同口径，泛称不扩散）；不给 home 或别名表读不到时退回字面匹配。
 * @returns {Promise<Map<string, string>>} uid -> 被命中的人物名
 */
async function personCandidates(registry, terms, home = "") {
  const out = new Map();
  const wanted = new Set((Array.isArray(terms) ? terms : []).map((term) => normalizeKeywords([term])[0]).filter(Boolean));
  if (!wanted.size) return out;
  let aliases = null;
  if (home) {
    try {
      aliases = await loadAliases(home);
    } catch {
      aliases = null;
    }
  }
  // 查询词已被 normalizeKeywords 小写化，而 _aliases.json 的键保留原始写法（`Lin`），
  // 只按原样查会漏掉拉丁别名；这里补一份小写键索引，原键仍然优先。
  const lowerAliases = aliases ? new Map(Object.entries(aliases).map(([key, value]) => [key.toLowerCase(), value])) : null;
  const canonical = (name) => {
    const raw = String(name ?? "").trim();
    if (!aliases) return raw;
    return aliases[raw] ?? aliases[raw.toLowerCase()] ?? lowerAliases.get(raw.toLowerCase()) ?? raw;
  };
  // 规范名归一后再比一次：别名与正名（如「我」↔USER）要能互相命中。
  const wantedNames = new Set(wanted);
  for (const term of [...wanted]) {
    const name = normalizeKeywords([canonical(term)])[0];
    if (name) wantedNames.add(name);
  }
  for (const meta of listMemories(registry)) {
    const people = Array.isArray(meta.people) ? meta.people : [];
    for (const person of people) {
      if (typeof person !== "string" || !person.trim()) continue;
      const key = normalizeKeywords([person])[0];
      const name = normalizeKeywords([canonical(person)])[0];
      if (!key || !(wantedNames.has(key) || (name && wantedNames.has(name)))) continue;
      if (!out.has(meta.uid)) out.set(meta.uid, person.trim());
      break;
    }
  }
  return out;
}

function lookupCandidates(registry, terms) {
  if (!registry || typeof registry.lookup !== "function") return new Map();
  let raw;
  try {
    raw = registry.lookup(terms);
  } catch {
    return new Map();
  }
  if (raw instanceof Set) {
    // 新形状：registry.lookup 只用来判命中，不再返回档位（等级由 row.defaultLevel 决定）。
    const map = new Map();
    for (const item of raw) {
      if (typeof item === "string") map.set(item, 0);
      else if (Array.isArray(item)) map.set(String(item[0]), item[1]);
    }
    return map;
  }
  if (raw instanceof Map) return raw;
  if (Array.isArray(raw)) {
    const map = new Map();
    for (const item of raw) {
      if (Array.isArray(item)) map.set(String(item[0]), item[1]);
      else if (typeof item === "string") map.set(item, 0);
    }
    return map;
  }
  if (raw && typeof raw === "object") return new Map(Object.entries(raw));
  return new Map();
}

/* ------------------------------------------------------------------ */
/* 快照 / 等级 / 路径                                                   */
/* ------------------------------------------------------------------ */

function defaultLevelOf(meta) {
  const level = Number(meta.defaultLevel);
  return level === 0 || level === 1 || level === 2 ? level : 2;
}

function snapshotsOf(meta) {
  const raw = Array.isArray(meta.snapshots) ? meta.snapshots : [];
  const levels = [...new Set(raw.map(Number).filter((l) => l === 0 || l === 1 || l === 2))].sort(
    (a, b) => a - b,
  );
  return levels.length ? levels : [defaultLevelOf(meta)];
}

function snapshotPath(meta, level) {
  const folder = typeof meta.folder === "string" && meta.folder ? meta.folder : "";
  return folder ? `${folder}/level${level}.txt` : `level${level}.txt`;
}

/**
 * 请求档不存在时回退：委托 memory.resolveSnapshotLevel（距离最近、同距取高），
 * 与 readSnapshot 共用同一套语义。meta 没有可用快照时退回本地推断，保持旧行为。
 * @returns {{level:number, fallback:boolean}}
 */
function resolveLevel(meta, requested) {
  try {
    const resolved = resolveSnapshotLevel(meta, requested);
    if (resolved && Number.isInteger(resolved.level)) return resolved;
  } catch {
    // snapshots 缺失/非法时用下方本地推断兜底
  }
  const levels = snapshotsOf(meta);
  if (levels.includes(requested)) return { level: requested, fallback: false };
  const atLeast = levels.find((level) => level >= requested);
  const level = atLeast !== undefined ? atLeast : levels[levels.length - 1];
  return { level, fallback: level !== requested };
}

/* ------------------------------------------------------------------ */
/* 匹配 / boost / 行构建                                                */
/* ------------------------------------------------------------------ */

function matchedTerms(meta, querySet) {
  if (!querySet.size) return [];
  const matched = [];
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
  for (const keyword of keywords) {
    const term = typeof keyword === "string" ? keyword : keyword && keyword.term;
    if (typeof term !== "string" || !term) continue;
    const normalized = normalizeKeywords([term])[0];
    if (!normalized || !querySet.has(normalized) || matched.includes(normalized)) continue;
    matched.push(normalized);
  }
  return matched;
}

/** 本次命中的关键词 keyness 之和（缺 keyness 的词按 1 算，避免老数据完全不加权）。 */
function matchedKeynessSum(meta, matched) {
  if (!matched.length) return 0;
  const byTerm = new Map();
  for (const keyword of Array.isArray(meta.keywords) ? meta.keywords : []) {
    const term = typeof keyword === "string" ? keyword : keyword && keyword.term;
    const normalized = normalizeKeywords([term])[0];
    if (!normalized) continue;
    const value = finiteNumber(keyword && keyword.keyness, 0);
    byTerm.set(normalized, value > 0 ? value : 1);
  }
  return matched.reduce((sum, term) => sum + (byTerm.get(term) ?? 0), 0);
}

/** 本行本轮应加的 hitCount 增量：Σ(命中词 keyness) × 0.2，下限 0.2、上限 MAX_HIT_COUNT（30）、保留两位小数。 */
function hitDeltaOf(meta, matched) {
  const sum = matchedKeynessSum(meta, matched);
  if (!(sum > 0)) return 0.2;
  return Math.round(Math.min(MAX_HIT_COUNT, Math.max(0.2, sum * HIT_DELTA_PER_KEYNESS)) * 100) / 100;
}

/**
 * 人物关键词命中时同一步给出档案摘录：meta.people 与查询词按别名/正名归一后等值匹配。
 * 只读、失败静默；每人一段（≤ characters.maxChars 由调用方 config 决定）。
 */
async function charactersFor(home, config, meta, querySet, query) {
  if (!home) return [];
  const people = Array.isArray(meta.people) ? meta.people.filter((name) => typeof name === "string" && name.trim()) : [];
  if (!people.length) return [];
  let aliases;
  try {
    aliases = await loadAliases(home);
  } catch {
    aliases = {};
  }
  const canonical = (name) => {
    const raw = String(name ?? "").trim();
    return aliases[raw] ?? aliases[raw.toLowerCase()] ?? raw;
  };
  const terms = new Set([...querySet, ...query.map((term) => canonical(term).toLowerCase())]);
  const hits = people.filter((name) => {
    const key = canonical(name).toLowerCase();
    return terms.has(key) || terms.has(name.toLowerCase());
  });
  const maxChars = Number(config?.characters?.snippetChars) > 0 ? Number(config.characters.snippetChars) : 200;
  const out = [];
  for (const name of [...new Set(hits.map(canonical))].slice(0, 2)) {
    try {
      const snippet = await buildCharacterSnippet(home, name, maxChars);
      // 档案为空壳（只有模板标题）时 excerpt 为空：仍带上 path 与名字，
      // 让上层能输出「命中人物，先读档案」的提醒，而不是当作没命中。
      if (snippet) out.push(snippet);
      else out.push({ name: name.toUpperCase() === "USER" ? "USER" : name, path: characterPathOf(home, name), excerpt: "" });
    } catch {
      // 档案缺失/读失败不影响检索
    }
  }
  return out;
}

function boostOf(meta, mode, config, now) {
  switch (mode) {
    case "usage": {
      const perHit = configNumber(config, "recall.usageBoost", RECALL_DEFAULTS.usageBoost);
      return clampHit(meta.hitCount) * perHit;
    }
    case "recency": {
      const maxBoost = configNumber(config, "recall.recencyBoost", RECALL_DEFAULTS.recencyBoost);
      const windowDays = Math.max(
        1,
        configNumber(config, "recall.recencyWindowDays", RECALL_DEFAULTS.recencyWindowDays),
      );
      const timestamp = Number.isFinite(Number(meta.updatedAt))
        ? Number(meta.updatedAt)
        : Number(meta.createdAt);
      if (!Number.isFinite(timestamp)) return 0;
      const ageDays = Math.max(0, (now - timestamp) / DAY_MS);
      const ratio = Math.max(0, Math.min(1, 1 - ageDays / windowDays));
      return maxBoost * ratio;
    }
    case "pinned":
      return meta.immortal === true
        ? configNumber(config, "recall.pinnedBoost", RECALL_DEFAULTS.pinnedBoost)
        : 0;
    case "none":
    default:
      return 0;
  }
}

function buildRow(meta, querySet, explicitView, boostMode, config, now, generic = null) {
  const defaultLevel = defaultLevelOf(meta);
  const requested = explicitView === null ? defaultLevel : explicitView;
  const { level, fallback } = resolveLevel(meta, requested);
  const matched = matchedTerms(meta, querySet);
  const levelBias = configNumber(config, "recall.levelBias", RECALL_DEFAULTS.levelBias);
  // 命中分：普通词计 1，泛词按 genericWeight 折算（默认 0.3）。
  // 这样「只命中 HDM」的记忆还能进候选，但累计权重往往够不到 minScore，也就是仍然不会注入。
  const genericWeight = configNumber(config, "recall.genericWeight", RECALL_DEFAULTS.genericWeight);
  const genericHit = generic
    ? matched.filter((term) => generic.has(normalizeTerm(term))).length
    : 0;
  const plainHit = matched.length - genericHit;
  const matchScore = plainHit + genericHit * genericWeight;
  const weight = matchScore + level * levelBias + boostOf(meta, boostMode, config, now);
  const views = {};
  for (const snapshotLevel of snapshotsOf(meta)) views[snapshotLevel] = snapshotPath(meta, snapshotLevel);
  return {
    uid: meta.uid,
    label: meta.label,
    defaultLevel,
    level,
    path: snapshotPath(meta, level),
    views,
    higherLevels: snapshotsOf(meta)
      .filter((snapshotLevel) => snapshotLevel > level)
      .map((snapshotLevel) => ({ level: snapshotLevel, path: snapshotPath(meta, snapshotLevel) })),
    weight,
    matchScore,
    genericHits: genericHit,
    matchedKeywords: matched,
    hitCount: clampHit(meta.hitCount),
    characters: [],
    imagery: [],
    immortal: meta.immortal === true,
    // 内部字段，出参前用 toPublicRow 去掉
    _fallback: fallback,
    _date: typeof meta.date === "string" ? meta.date : "",
    _hitDelta: hitDeltaOf(meta, matched),
  };
}

function compareRows(a, b) {
  if (b.weight !== a.weight) return b.weight - a.weight;
  if (a.level !== b.level) return a.level - b.level;
  if (a._date !== b._date) return a._date < b._date ? 1 : -1;
  if (a.uid === b.uid) return 0;
  return a.uid < b.uid ? -1 : 1;
}

function toPublicRow(row) {
  return {
    uid: row.uid,
    label: row.label,
    defaultLevel: row.defaultLevel,
    level: row.level,
    path: row.path,
    views: row.views,
    higherLevels: row.higherLevels,
    weight: row.weight,
    matchedKeywords: row.matchedKeywords,
    hitCount: row.hitCount,
    // 本行本轮应加的命中增量：调用方 bumpHits:false 时用它只给真正展示的条目记账。
    hitDelta: row._hitDelta ?? 0,
    characters: row.characters ?? [],
    imagery: row.imagery ?? [],
    immortal: row.immortal,
  };
}

async function bumpHitAndRead(registry, uid, now, current, delta = 1) {
  if (registry && typeof registry.bumpHit === "function") {
    try {
      const meta = await registry.bumpHit(uid, now, delta);
      if (meta && Number.isFinite(Number(meta.hitCount))) return Number(meta.hitCount);
    } catch {
      // 命中计数失败不影响检索结果
    }
  }
  const meta = getMemory(registry, uid);
  if (meta && Number.isFinite(Number(meta.hitCount))) return Number(meta.hitCount);
  return current;
}

/** 批量 bump 的返回值归一：Map<uid, number|{hitCount}> / object / Array 都吃。 */
function hitCountOf(value) {
  const n = Number(value && typeof value === "object" ? value.hitCount : value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 批量累加命中计数：每行的增量是 Σ(命中词 keyness)×0.2（见 hitDeltaOf），不是固定 +1。
 * registry.bumpHits 存在就一次调用（N 行只落盘一次），否则/失败时回退逐条 bumpHit。
 * 返回 Map<uid, hitCount>（缺失的 uid 不出现在 Map 里）。
 * @param {Array<{uid:string, _hitDelta?:number}>} rows
 */
async function bumpHitsAndRead(registry, rows, now) {
  const entries = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const uid = String(row?.uid ?? "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const delta = Number(row?._hitDelta);
    entries.push({ uid, delta: Number.isFinite(delta) ? delta : 1 });
  }
  const counts = new Map();
  if (!entries.length) return counts;
  if (registry && typeof registry.bumpHits === "function") {
    try {
      const raw = await registry.bumpHits(entries, now);
      const pairs =
        raw instanceof Map ? [...raw] : Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw) : [];
      for (const pair of pairs) {
        if (!Array.isArray(pair)) continue;
        const uid = String(pair[0] ?? "");
        const count = hitCountOf(pair[1]);
        if (uid && count !== null) counts.set(uid, count);
      }
      if (counts.size) {
        // 批量结果里没出现的单元：只读当前值，不再 bump 一次（避免重复累加）。
        for (const { uid } of entries) {
          if (counts.has(uid)) continue;
          const meta = getMemory(registry, uid);
          if (meta && Number.isFinite(Number(meta.hitCount))) counts.set(uid, Number(meta.hitCount));
        }
        return counts;
      }
    } catch {
      // 批量失败 → 走下方逐条回退
    }
  }
  for (const { uid, delta } of entries) {
    const current = clampHit(getMemory(registry, uid)?.hitCount);
    counts.set(uid, await bumpHitAndRead(registry, uid, now, current, delta));
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* sameDayOf                                                            */
/* ------------------------------------------------------------------ */

function eventKeysOf(meta) {
  const keys = [];
  for (const value of [meta.eventKey, meta.event]) {
    if (typeof value !== "string") continue;
    const key = value.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 同一天、同一 eventKey 的记忆 uid 集合。
 * 规则：日期必须相同；两边都有 eventKey 时必须相同；任一方无 eventKey 时只看日期。
 */
function collectSameDayUids(registry, target) {
  const uids = new Set([target.uid]);
  const date = typeof target.date === "string" ? target.date : "";
  const targetKeys = eventKeysOf(target);
  for (const meta of listMemories(registry)) {
    if (!meta || typeof meta.uid !== "string" || meta.uid === target.uid) continue;
    const metaDate = typeof meta.date === "string" ? meta.date : "";
    if (metaDate !== date) continue;
    const keys = eventKeysOf(meta);
    if (targetKeys.length && keys.length && !keys.some((key) => targetKeys.includes(key))) continue;
    uids.add(meta.uid);
  }
  return uids;
}

/* ------------------------------------------------------------------ */
/* 0.3.0：词表窗口粗查                                                */
/* ------------------------------------------------------------------ */

/** 检索条数期望：显式 topK 优先；0/未给 = 输入关键词数。两者都夹在 1..MAX_TOP_K。 */
function resolveExpected(value, queryCount) {
  const n = Math.trunc(Number(value));
  const desired = Number.isFinite(n) && n > 0 ? n : Math.max(1, queryCount);
  return Math.max(1, Math.min(MAX_TOP_K, desired));
}

/**
 * 按「keyness × 时间衰减」排序的词表分窗粗查：
 * 第 1 窗是前 50 个词，没凑够期望条数就进 50~100 并降低期望，一直循环到第 250 个词。
 * 窗口内用词面模糊匹配（精确/包含/编辑距离）把输入词扩到词表词条，再取命中记忆。
 * @returns {{uids:Set<string>, terms:string[], windows:number, expected:number}}
 */
function scanVocabWindows(registry, query, table, expected) {
  const uids = new Set();
  const terms = [];
  const seen = new Set();
  let windows = 0;
  let aim = Math.max(1, Math.trunc(expected) || 1);
  const maxEnd = Math.min(table.length, VOCAB_DEFAULTS.maxWindowEnd);
  for (let start = 0; start < maxEnd; start += VOCAB_DEFAULTS.windowSize) {
    const end = Math.min(start + VOCAB_DEFAULTS.windowSize, maxEnd);
    windows += 1;
    for (const hit of matchWindowTerms(query, table, { start, end })) {
      if (!seen.has(hit.term)) {
        seen.add(hit.term);
        terms.push(hit.term);
      }
      for (const uid of lookupCandidates(registry, [hit.term]).keys()) uids.add(uid);
    }
    if (uids.size >= aim) break;
    // 找不齐才进下一窗：窗口越深词越浅，期望也随之降低（最低 1）。
    aim = Math.max(1, Math.floor(aim * VOCAB_DEFAULTS.expectDecay));
  }
  return { uids, terms, windows, expected: aim };
}

/* ------------------------------------------------------------------ */
/* recall                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} options.registry  Registry 形状：get/list/lookup/bumpHit
 * @param {object} [options.config]  resolveConfig 结果（recall.* / association.*）
 * @param {string} [options.home] 母文件夹路径；给了才挂人物档案摘录
 * @param {string[]|string} options.keywords
 * @param {number} [options.topK=0] 返回条数；0=跟随输入关键词数（上限 12）
 * @param {"auto"|0|1|2} [options.view="auto"]
 * @param {string|null} [options.sameDayOf]
 * @param {"none"|"usage"|"recency"|"pinned"} [options.boost="none"]
 * @param {boolean} [options.includeAssociations=true]
 * @param {boolean} [options.bumpHits=true] 是否在本轮直接累加 hitCount；调用方要先过滤再记账时传 false，用每行 hitDelta 自行 bump
 * @param {number} [options.now]
 */
export async function recall({
  registry,
  config = {},
  home = "",
  keywords,
  topK = RECALL_DEFAULTS.topK,
  view = "auto",
  sameDayOf = null,
  boost = "none",
  includeAssociations = true,
  bumpHits = true,
  now,
} = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const query = normalizeKeywords(keywords);
  const querySet = new Set(query);
  const boostMode = BOOST_MODES.has(boost) ? boost : "none";

  let requestedView = null;
  if (view !== "auto" && view !== undefined && view !== null && view !== "") {
    const candidate = Number(view);
    if (candidate === 0 || candidate === 1 || candidate === 2) requestedView = candidate;
  }
  const explicitView = requestedView !== null;

  const target = sameDayOf ? getMemory(registry, sameDayOf) : null;
  const sameDayUids = target ? collectSameDayUids(registry, target) : new Set();

  // 0.3.0 检索顺序：词表前 50 → 逐窗扩到 250（每窗降低条数期望）→ 不够再精确倒排细找。
  // 粗查决定候选与优先顺序，细找保证精确命中不丢；两条来源按 uid 合并后统一算权重。
  const table = buildKeywordTable(registry, { now: timestamp, limit: VOCAB_DEFAULTS.maxWindowEnd });
  const expected = resolveExpected(topK, query.length);
  const coarse = scanVocabWindows(registry, query, table, expected);
  const exact = lookupCandidates(registry, query);
  // 人物名按字面命中（含别名）补进候选：people 不是关键词，不补就会出现「用人物名搜不到」。
  const people = await personCandidates(registry, query, home);
  const candidateUids = new Set([...coarse.uids, ...exact.keys(), ...people.keys()]);

  // 模糊命中的词条一并计入权重（这才体现「扩窗」找到的相关性）；不改变原公式。
  const expandedSet = new Set(querySet);
  const fuzzyTerms = [];
  for (const term of coarse.terms) {
    const key = normalizeKeywords([term])[0];
    if (!key) continue;
    expandedSet.add(key);
    if (!querySet.has(key)) fuzzyTerms.push(key);
  }

  const keywordRows = [];
  // 泛词集合只算一次：buildRow 逐条用，重复算会随候选数放大成 O(n²)。
  const generic = genericTermsOf(registry);
  for (const uid of candidateUids) {
    if (typeof uid !== "string" || !uid) continue;
    const meta = getMemory(registry, uid);
    if (!meta) continue;
    keywordRows.push(buildRow(meta, expandedSet, requestedView, boostMode, config, timestamp, generic));
  }
  keywordRows.sort(compareRows);
  const limit = expected;
  const selected = keywordRows.slice(0, limit);
  const selectedUids = new Set(selected.map((row) => row.uid));
  const searchStage = candidateUids.size === 0 ? "empty" : fuzzyTerms.length ? "coarse" : "fine";

  // sameDayOf 命中的记忆/快照全部返回（不参与 topK 竞争，保证“所有同日/同事件”都出现）。
  const extraRows = [];
  for (const uid of sameDayUids) {
    if (selectedUids.has(uid)) continue;
    const meta = getMemory(registry, uid);
    if (!meta) continue;
    extraRows.push(buildRow(meta, querySet, requestedView, boostMode, config, timestamp, generic));
  }
  extraRows.sort(compareRows);

  const allRows = [...selected, ...extraRows];
  // 人物关键词命中时同一步附档案摘录（USER 优先）；无 home、未开启或读失败静默跳过。
  if (home && config?.characters?.injectOnRecall !== false) {
    for (const row of allRows) {
      row.characters = await charactersFor(home, config, getMemory(registry, row.uid), querySet, query).catch(() => []);
    }
  }
  // 意象层：命中行带已建意象的关键词附条目路径（只给路径，正文由 hdm_imagery read 自取）。
  if (home && config?.imagery?.injectOnRecall !== false) {
    const maxItems = Math.max(1, Math.trunc(Number(config?.imagery?.maxItems ?? 2)));
    for (const row of allRows) {
      row.imagery = await imageryRefs(home, row.matchedKeywords ?? [], maxItems).catch(() => []);
    }
  }
  // hitCount 按 Σ(命中词 keyness)×0.2 加权累加（上限 30）；返回的 hitCount 是本轮 bump 后的值。
  // 默认在这里批量一次落盘（hdm_recall 会把全部 matches 展示给模型）；调用方还会再过滤时传
  // bumpHits:false，改用每行 hitDelta 只对真正进入上下文的条目记账（注入层 buildAutoRecall）。
  const bumped = bumpHits === false ? new Map() : await bumpHitsAndRead(registry, allRows, timestamp);
  for (const row of allRows) {
    const count = bumped.get(row.uid);
    if (Number.isFinite(count)) row.hitCount = count;
  }

  const viewFallback = explicitView && allRows.some((row) => row._fallback);

  let associations = [];
  let associationTruncated = false;
  const associationsEnabled =
    includeAssociations !== false && configGet(config, "association.enabled", true) !== false;
  if (associationsEnabled) {
    // 兜底值必须与 associations.js 的 ASSOCIATION_DEFAULTS.triggerCount 一致（当前 4）；
    // 写死旧值 3 会让「配置缺失时」回退到更吵的旧门槛。
    const triggerCount = configNumber(config, "association.triggerCount", 4);
    if (allRows.some((row) => row.hitCount > triggerCount)) {
      const related = await relatedMemories({
        registry,
        config,
        rows: allRows,
        now: timestamp,
        queryTerms: query,
      });
      associations = related.associations;
      associationTruncated = related.truncated;
    }
  }

  const matches = allRows.map(toPublicRow);
  return {
    matches,
    associations,
    associationTruncated,
    viewFallback,
    sameDay: matches.filter((row) => sameDayUids.has(row.uid)),
    search: {
      stage: searchStage,
      expected,
      aim: coarse.expected,
      windows: coarse.windows,
      terms: coarse.terms.length,
      fuzzyTerms: fuzzyTerms.length,
    },
  };
}

export default recall;

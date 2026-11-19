/**
 * HDM 记忆调取（PLAN.md §5.3 / §6，interfaces.md `lib/recall.js`）。
 *
 * 纯 ESM，仅依赖 Node 内置模块；不 import T1 的 config/registry 等模块，
 * 便于用 fake registry 单测。registry 只要求 `get/list/lookup/bumpHit` 形状。
 */
import { relatedMemories } from "./associations.js";
import { resolveSnapshotLevel } from "./memory.js";

/** 单个关键词长度上限（字符/code point）。 */
export const MAX_KEYWORD_CHARS = 32;

export const RECALL_DEFAULTS = Object.freeze({
  topK: 3,
  levelBias: 1,
  usageBoost: 1,
  recencyBoost: 2,
  recencyWindowDays: 30,
  pinnedBoost: 3,
});

const MAX_TOP_K = 10;
const MAX_HIT_COUNT = 10;
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

function clampInt(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function boostOf(meta, mode, config, now) {
  switch (mode) {
    case "usage": {
      const perHit = configNumber(config, "recall.usageBoost", RECALL_DEFAULTS.usageBoost);
      return clampInt(finiteNumber(meta.hitCount, 0), 0, 0, MAX_HIT_COUNT) * perHit;
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

function buildRow(meta, querySet, explicitView, boostMode, config, now) {
  const defaultLevel = defaultLevelOf(meta);
  const requested = explicitView === null ? defaultLevel : explicitView;
  const { level, fallback } = resolveLevel(meta, requested);
  const matched = matchedTerms(meta, querySet);
  const levelBias = configNumber(config, "recall.levelBias", RECALL_DEFAULTS.levelBias);
  const weight = matched.length + level * levelBias + boostOf(meta, boostMode, config, now);
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
    matchedKeywords: matched,
    hitCount: clampInt(finiteNumber(meta.hitCount, 0), 0, 0, MAX_HIT_COUNT),
    immortal: meta.immortal === true,
    // 内部字段，出参前用 toPublicRow 去掉
    _fallback: fallback,
    _date: typeof meta.date === "string" ? meta.date : "",
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
    immortal: row.immortal,
  };
}

async function bumpHitAndRead(registry, uid, now, current) {
  if (registry && typeof registry.bumpHit === "function") {
    try {
      const meta = await registry.bumpHit(uid, now);
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
 * 批量 +1 命中计数：registry.bumpHits 存在就一次调用（N 行只落盘一次），
 * 否则/失败时回退逐条 bumpHit。返回 Map<uid, hitCount>（缺失的 uid 不出现在 Map 里）。
 */
async function bumpHitsAndRead(registry, uids, now) {
  const list = [...new Set((Array.isArray(uids) ? uids : []).map((uid) => String(uid ?? "")).filter(Boolean))];
  const counts = new Map();
  if (!list.length) return counts;
  if (registry && typeof registry.bumpHits === "function") {
    try {
      const raw = await registry.bumpHits(list, now);
      const pairs =
        raw instanceof Map ? [...raw] : Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw) : [];
      for (const pair of pairs) {
        if (!Array.isArray(pair)) continue;
        const uid = String(pair[0] ?? "");
        const count = hitCountOf(pair[1]);
        if (uid && count !== null) counts.set(uid, count);
      }
      if (counts.size) {
        // 批量结果里没出现的单元：只读当前值，不再 bump 一次（避免重复 +1）。
        for (const uid of list) {
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
  for (const uid of list) {
    const current = clampInt(finiteNumber(getMemory(registry, uid)?.hitCount, 0), 0, 0, MAX_HIT_COUNT);
    counts.set(uid, await bumpHitAndRead(registry, uid, now, current));
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
/* recall                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} options.registry  Registry 形状：get/list/lookup/bumpHit
 * @param {object} [options.config]  resolveConfig 结果（recall.* / association.*）
 * @param {string[]|string} options.keywords
 * @param {number} [options.topK=3]
 * @param {"auto"|0|1|2} [options.view="auto"]
 * @param {string|null} [options.sameDayOf]
 * @param {"none"|"usage"|"recency"|"pinned"} [options.boost="none"]
 * @param {boolean} [options.includeAssociations=true]
 * @param {number} [options.now]
 */
export async function recall({
  registry,
  config = {},
  keywords,
  topK = RECALL_DEFAULTS.topK,
  view = "auto",
  sameDayOf = null,
  boost = "none",
  includeAssociations = true,
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

  const candidates = lookupCandidates(registry, query);
  const target = sameDayOf ? getMemory(registry, sameDayOf) : null;
  const sameDayUids = target ? collectSameDayUids(registry, target) : new Set();

  const keywordRows = [];
  for (const uid of candidates.keys()) {
    if (typeof uid !== "string" || !uid) continue;
    const meta = getMemory(registry, uid);
    if (!meta) continue;
    keywordRows.push(buildRow(meta, querySet, requestedView, boostMode, config, timestamp));
  }
  keywordRows.sort(compareRows);
  const limit = clampInt(topK, RECALL_DEFAULTS.topK, 1, MAX_TOP_K);
  const selected = keywordRows.slice(0, limit);
  const selectedUids = new Set(selected.map((row) => row.uid));

  // sameDayOf 命中的记忆/快照全部返回（不参与 topK 竞争，保证“所有同日/同事件”都出现）。
  const extraRows = [];
  for (const uid of sameDayUids) {
    if (selectedUids.has(uid)) continue;
    const meta = getMemory(registry, uid);
    if (!meta) continue;
    extraRows.push(buildRow(meta, querySet, requestedView, boostMode, config, timestamp));
  }
  extraRows.sort(compareRows);

  const allRows = [...selected, ...extraRows];
  // hitCount 在 recall 时 +1（上限 10）；返回的 hitCount 是本轮 bump 后的值。
  // 批量一次落盘（registry.bumpHits），没有该能力时逐个回退。
  const bumped = await bumpHitsAndRead(registry, allRows.map((row) => row.uid), timestamp);
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
  };
}

export default recall;

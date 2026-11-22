/**
 * HDM 回忆联想（PLAN.md §5.3 / §6，interfaces.md `lib/associations.js`）。
 *
 * 主召回结果中某条 `hitCount > config.association.triggerCount` 时，
 * 从全库找相关记忆：relatedUids +3、共享人物每人 +1、同日/同事件 +1、
 * 共享非查询关键词每个 +1（领域泛词只进 reason 不加分）。
 * 累加完再乘时间衰减（越老分越低，保底 0.2）——同一天做过两件无关的事、
 * 或者沾一个泛词就被硬拉进来的噪音，靠这两条压下去。
 * 只取 level ≥ minLevel、最多 maxItems 条、所有摘要累计字数 < maxChars；
 * 超预算的条目只给 path（gist 为空）并置 truncated。按 uid 去重，每条带 reason。
 *
 * 纯 ESM，仅用 Node 内置模块；不 import T1 文件。
 */
import { readFile } from "node:fs/promises";

export const ASSOCIATION_DEFAULTS = Object.freeze({
  triggerCount: 4,
  minLevel: 1,
  maxItems: 3,
  maxChars: 1500,
  recencyWindowDays: 30,
});

const MAX_HIT_COUNT = 30;
const LEADING_PUNCT_RE = /^[\p{P}\p{Z}]+/u;
const TRAILING_PUNCT_RE = /[\p{P}\p{Z}]+$/u;
const SUMMARY_RE = /^##[ \t]*摘要[ \t]*$/m;
const NEXT_SECTION_RE = /^##[ \t]/m;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
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

function normalizePerson(value) {
  return typeof value === "string" ? value.normalize("NFKC").toLowerCase().trim() : "";
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

function eventKeysOf(meta) {
  const keys = [];
  for (const value of [meta.eventKey, meta.event]) {
    if (typeof value !== "string") continue;
    const key = value.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function keywordTermsOf(meta) {
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
  const terms = [];
  for (const keyword of keywords) {
    const term = typeof keyword === "string" ? keyword : keyword && keyword.term;
    if (typeof term === "string" && term.trim()) terms.push(term);
  }
  return terms;
}

/* ------------------------------------------------------------------ */
/* 摘要读取 / 领域泛词                                                   */
/* ------------------------------------------------------------------ */

function extractGist(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  const match = SUMMARY_RE.exec(text);
  if (!match) return text.trim();
  const rest = text.slice(match.index + match[0].length);
  const next = NEXT_SECTION_RE.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** 词条归一化（NFKC/小写/去首尾标点）：联想计分与词表过滤共用同一口径。 */
export function normalizeTerm(value) {
  if (typeof value !== "string") return "";
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(LEADING_PUNCT_RE, "")
    .replace(TRAILING_PUNCT_RE, "");
}

/**
 * 领域泛词：在超过 30% 的记忆里都出现过的词（库 ≥ 4 条时生效）。
 * 「HDM」「备份」「母文件夹」这类词几乎人人都有，本身不携带区分度；
 * 如果按共享关键词 +1，一条只沾了泛词的无关记忆就会被硬拉进联想。
 * 返回归一化后的词集合；记忆太少时不判定（几条记忆的 30% 没有统计意义）。
 */
export function genericTermsOf(registry) {
  const memories = listMemories(registry);
  const total = memories.length;
  const generic = new Set();
  if (total < 4) return generic;
  const df = new Map();
  for (const meta of memories) {
    const seen = new Set();
    for (const term of keywordTermsOf(meta)) {
      const normalized = normalizeTerm(term);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      df.set(normalized, (df.get(normalized) ?? 0) + 1);
    }
  }
  for (const [term, count] of df) {
    if (count / total > 0.3) generic.add(term);
  }
  return generic;
}

/* ------------------------------------------------------------------ */
/* 关联打分                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} options.registry
 * @param {object} [options.config]
 * @param {Array<{uid:string, hitCount?:number, matchedKeywords?:string[]}>} options.rows 主召回结果
 * @param {number} [options.now]
 * @param {string[]} [options.queryTerms] 归一化后的查询词（用于排除“非查询关键词”）
 */
export async function relatedMemories({ registry, config = {}, rows = [], now, queryTerms } = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const enabled = configGet(config, "association.enabled", true) !== false;
  const triggerCount = configNumber(
    config,
    "association.triggerCount",
    ASSOCIATION_DEFAULTS.triggerCount,
  );
  const rowList = Array.isArray(rows) ? rows : [];
  if (!enabled || !rowList.some((row) => Number(row && row.hitCount) > triggerCount)) {
    return { associations: [], truncated: false };
  }

  const mainMetas = [];
  for (const row of rowList) {
    const meta = row && typeof row.uid === "string" ? getMemory(registry, row.uid) : null;
    if (meta) mainMetas.push(meta);
  }
  if (!mainMetas.length) return { associations: [], truncated: false };

  // 查询词：优先用 recall 传入的归一化结果，否则用主结果的 matchedKeywords 推导。
  const querySet = new Set();
  const rawQuery = Array.isArray(queryTerms)
    ? queryTerms
    : rowList.flatMap((row) => (Array.isArray(row && row.matchedKeywords) ? row.matchedKeywords : []));
  for (const term of rawQuery) {
    const normalized = normalizeTerm(term);
    if (normalized) querySet.add(normalized);
  }

  const mainUids = new Set();
  const mainDates = new Set();
  const mainPeople = new Set();
  const mainEventKeys = new Set();
  const mainKeywords = new Set();
  const relatedByMain = new Set();
  for (const meta of mainMetas) {
    mainUids.add(meta.uid);
    if (typeof meta.date === "string" && meta.date) mainDates.add(meta.date);
    for (const person of Array.isArray(meta.people) ? meta.people : []) {
      const key = normalizePerson(person);
      if (key) mainPeople.add(key);
    }
    for (const key of eventKeysOf(meta)) mainEventKeys.add(key);
    for (const term of keywordTermsOf(meta)) {
      const normalized = normalizeTerm(term);
      if (normalized && !querySet.has(normalized)) mainKeywords.add(normalized);
    }
    for (const uid of Array.isArray(meta.relatedUids) ? meta.relatedUids : []) {
      if (typeof uid === "string" && uid) relatedByMain.add(uid);
    }
  }

  const minLevel = clampInt(
    configNumber(config, "association.minLevel", ASSOCIATION_DEFAULTS.minLevel),
    ASSOCIATION_DEFAULTS.minLevel,
    0,
    2,
  );
  const maxItems = clampInt(
    configNumber(config, "association.maxItems", ASSOCIATION_DEFAULTS.maxItems),
    ASSOCIATION_DEFAULTS.maxItems,
    1,
    10,
  );
  const maxChars = clampInt(
    configNumber(config, "association.maxChars", ASSOCIATION_DEFAULTS.maxChars),
    ASSOCIATION_DEFAULTS.maxChars,
    1,
    100000,
  );
  const recencyWindowDays = clampInt(
    configNumber(config, "association.recencyWindowDays", ASSOCIATION_DEFAULTS.recencyWindowDays),
    ASSOCIATION_DEFAULTS.recencyWindowDays,
    1,
    3650,
  );
  // 领域泛词：共享它们不加分（仍在 reason 里展示，方便排查“为什么被联想”）。
  const genericTerms = genericTermsOf(registry);

  const candidates = new Map();
  for (const meta of listMemories(registry)) {
    if (!meta || typeof meta.uid !== "string" || !meta.uid) continue;
    if (mainUids.has(meta.uid) || candidates.has(meta.uid)) continue;
    candidates.set(meta.uid, meta);
  }

  const scored = [];
  for (const meta of candidates.values()) {
    const eligibleLevels = snapshotsOf(meta).filter((level) => level >= minLevel);
    if (!eligibleLevels.length) continue;
    const level = eligibleLevels[0];

    const reasons = [];
    let score = 0;

    // 1) relatedUids 双向关联 +3（显式关联是真实信号，保留满权重）
    let related = relatedByMain.has(meta.uid);
    if (!related && Array.isArray(meta.relatedUids)) {
      related = meta.relatedUids.some((uid) => mainUids.has(uid));
    }
    if (related) {
      score += 3;
      reasons.push("关联记忆");
    }

    // 2) 共享人物，每人 +1（人只有一个（用户）时所有记忆都会得分，满权重等于没有区分度）
    const sharedPeople = [];
    const seenPeople = new Set();
    for (const person of Array.isArray(meta.people) ? meta.people : []) {
      const key = normalizePerson(person);
      if (!key || !mainPeople.has(key) || seenPeople.has(key)) continue;
      seenPeople.add(key);
      sharedPeople.push(String(person).trim());
      score += 1;
    }
    if (sharedPeople.length) reasons.push(`共同人物：${sharedPeople.slice(0, 3).join("、")}`);

    // 3) 同日 / 同事件 +1（同一天做过两件无关的事很常见，不能当成强相关）
    const sameDate = typeof meta.date === "string" && mainDates.has(meta.date);
    const candidateEventKeys = eventKeysOf(meta);
    const sharedEventKey = candidateEventKeys.find((key) => mainEventKeys.has(key)) ?? null;
    if (sameDate || sharedEventKey) {
      score += 1;
      if (sameDate) reasons.push(`同日：${meta.date}`);
      else reasons.push(`同事件：${sharedEventKey}`);
    }

    // 4) 共享非查询关键词，每个 +1；泛词只进 reason 不加分
    const sharedKeywords = [];
    for (const term of keywordTermsOf(meta)) {
      const normalized = normalizeTerm(term);
      if (!normalized || querySet.has(normalized) || !mainKeywords.has(normalized)) continue;
      if (sharedKeywords.includes(normalized)) continue;
      sharedKeywords.push(normalized);
      if (!genericTerms.has(normalized)) score += 1;
    }
    if (sharedKeywords.length) reasons.push(`共同关键词：${sharedKeywords.slice(0, 4).join("、")}`);

    if (score <= 0 || !reasons.length) continue;

    // 5) 时间衰减：昨天/上周的记忆不该和今天的一样容易入选。
    //    0.2 保底——跨月项目仍可能相关，不该被衰减彻底归零。
    const stamp = Number(meta.updatedAt ?? meta.createdAt ?? 0);
    const hasStamp = Number.isFinite(stamp) && stamp > 0;
    const ageDays = hasStamp ? Math.max(0, (timestamp - stamp) / 86400000) : 0;
    const decay = hasStamp ? Math.max(0.2, 1 - ageDays / recencyWindowDays) : 0.2;
    score *= decay;
    // 衰减说明只在明显降权时写（decay ≥ 0.9 时不占字数）。
    if (hasStamp && decay < 0.9) {
      reasons.push(`时间衰减：×${decay.toFixed(1)}（${Math.round(ageDays)} 天前）`);
    }

    // 不按绝对分剪枝：衰减已经把老记忆压到后面，硬剪会把「跨月但仍相关」的候选丢光
    // （60 天前的同主题记忆应当出现，只是排在近期之后）。排序 + maxItems 已经足够。
    scored.push({ meta, level, score, reason: reasons.join("；") });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dateA = typeof a.meta.date === "string" ? a.meta.date : "";
    const dateB = typeof b.meta.date === "string" ? b.meta.date : "";
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return a.meta.uid < b.meta.uid ? -1 : a.meta.uid > b.meta.uid ? 1 : 0;
  });

  const selected = scored.slice(0, maxItems);
  let truncated = scored.length > selected.length;
  const textCache = new Map();
  const associations = [];
  let usedChars = 0;
  for (const item of selected) {
    const snapshotFile = snapshotPath(item.meta, item.level);
    let gist = "";
    if (typeof item.meta.gist === "string" && item.meta.gist.trim()) {
      gist = item.meta.gist.trim();
    } else {
      let text = textCache.get(snapshotFile);
      if (text === undefined) {
        try {
          text = await readFile(snapshotFile, "utf8");
        } catch {
          text = "";
        }
        textCache.set(snapshotFile, text);
      }
      gist = extractGist(text);
    }
    if (!gist) continue; // 读不到快照内容就不给空联想
    let kept = "";
    let chars = 0;
    if (usedChars + gist.length < maxChars) {
      kept = gist;
      chars = gist.length;
      usedChars += gist.length;
    } else {
      truncated = true;
    }
    associations.push({
      uid: item.meta.uid,
      label: item.meta.label,
      level: item.level,
      path: snapshotFile,
      gist: kept,
      reason: item.reason,
      chars,
    });
  }

  return { associations, truncated };
}

export default relatedMemories;

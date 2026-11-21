// HDM 记忆索引（index/memories.json + index/keywords.json）。
// 纯 ESM；索引写入前先备份 .bak，再原子替换。可从 memory/**/meta.json 重建。

import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, ensureDir, parseMemoryFolderName } from "./paths.js";

const INDEX_VERSION = 1;
const MAX_HIT_COUNT = 10;

/** hitCount 是加权浮点（自动召回按 Σ keyness×0.2 累加，hdm_read 固定 +1）；夹 0~10 并保留两位小数。 */
function clampHitCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(MAX_HIT_COUNT, n)) * 100) / 100;
}

/**
 * bumpHits 入参归一：字符串/数字 → delta=1；{uid,delta} / [uid,delta] / Map<uid,delta> 都吃。
 * @returns {Array<{uid:string, delta:number}>}
 */
function normalizeBumpEntries(input) {
  const out = [];
  const push = (uid, delta) => {
    const key = String(uid ?? "").trim();
    if (!key) return;
    const step = Number(delta);
    out.push({ uid: key, delta: Number.isFinite(step) ? step : 1 });
  };
  if (input instanceof Map) {
    for (const [uid, delta] of input) push(uid, delta);
    return out;
  }
  if (!Array.isArray(input)) return out;
  for (const item of input) {
    if (Array.isArray(item)) push(item[0], item[1]);
    else if (item && typeof item === "object") push(item.uid, item.delta ?? item.hitDelta);
    else push(item, 1);
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function termKey(term) {
  return String(term ?? "").trim().toLowerCase();
}

function normalizeLevels(levels, fallback = []) {
  const out = [];
  for (const value of Array.isArray(levels) ? levels : fallback) {
    const level = Number(value);
    if ((level === 0 || level === 1 || level === 2) && !out.includes(level)) out.push(level);
  }
  out.sort((a, b) => a - b);
  return out;
}

function normalizeSnapshots(meta) {
  const levels = normalizeLevels(meta?.snapshots);
  if (levels.length) return levels;
  const fallback = Number(meta?.defaultLevel);
  return [fallback === 0 || fallback === 1 || fallback === 2 ? fallback : 2];
}

/** null / 空串保持 null；其余转数字，非法值也回 null（避免 Number(null)===0 的假值）。 */
function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMeta(input) {  if (!isPlainObject(input)) throw new Error("记忆元数据必须是对象");
  const meta = { ...input };
  meta.uid = String(meta.uid ?? "").trim();
  if (!meta.uid) throw new Error("记忆元数据缺少 uid");
  meta.folder = String(meta.folder ?? "").trim();
  meta.label = String(meta.label ?? (meta.folder ? path.basename(meta.folder) : "")).trim();
  meta.date = String(meta.date ?? "").trim();
  meta.seq = Number.isFinite(Number(meta.seq)) ? Number(meta.seq) : 0;
  meta.defaultLevel = [0, 1, 2].includes(Number(meta.defaultLevel)) ? Number(meta.defaultLevel) : 2;
  meta.snapshots = normalizeSnapshots(meta);
  meta.keywords = (Array.isArray(meta.keywords) ? meta.keywords : [])
    .filter((keyword) => keyword && String(keyword.term ?? "").trim())
    .map((keyword) => ({
      term: String(keyword.term).trim(),
      keyness: Number.isFinite(Number(keyword.keyness)) ? Number(keyword.keyness) : 0,
      levels: normalizeLevels(keyword.levels, [meta.defaultLevel]),
    }));
  meta.people = (Array.isArray(meta.people) ? meta.people : []).map((person) => String(person).trim()).filter(Boolean);
  meta.sessionId = String(meta.sessionId ?? "").trim();
  meta.hitCount = clampHitCount(meta.hitCount);
  meta.lastHitAt = nullableNumber(meta.lastHitAt);
  meta.immortal = meta.immortal === true;
  meta.immortalReason = meta.immortalReason ?? null;
  meta.createdAt = Number.isFinite(Number(meta.createdAt)) ? Number(meta.createdAt) : 0;
  meta.updatedAt = Number.isFinite(Number(meta.updatedAt)) ? Number(meta.updatedAt) : meta.createdAt;
  const forget = isPlainObject(meta.forget) ? meta.forget : {};
  meta.forget = {
    // null 必须保持 null：Number(null) === 0 会被当成「已到期」，让 isDerived 永远为真。
    d2: nullableNumber(forget.d2),
    d5: nullableNumber(forget.d5),
  };
  meta.relatedUids = (Array.isArray(meta.relatedUids) ? meta.relatedUids : []).map((uid) => String(uid).trim()).filter(Boolean);
  return meta;
}

async function readJson(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readJsonWithBak(file, backupFile) {
  const primary = await readJson(file);
  if (primary !== null) return primary;
  const backup = backupFile ? await readJson(backupFile) : null;
  if (backup !== null) return backup;
  return readJson(`${file}.bak`);
}

async function backupAndWrite(file, backupFile, value) {
  if (backupFile) {
    try {
      await ensureDir(path.dirname(backupFile));
      await fs.copyFile(file, backupFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // 备份失败不阻塞主索引原子写；主文件仍可恢复，必要时从 meta.json 重建。
      }
    }
  }
  await atomicJson(file, value);
}

async function findMetaFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === "meta.json") files.push(full);
    }
  }
  files.sort();
  return files;
}

async function detectSnapshots(folder, defaultLevel) {
  const levels = [];
  for (const level of [2, 1, 0]) {
    try {
      await fs.access(path.join(folder, `level${level}.txt`));
      levels.push(level);
    } catch {
      // 缺失即该档不存在
    }
  }
  if (!levels.length) levels.push([0, 1, 2].includes(Number(defaultLevel)) ? Number(defaultLevel) : 2);
  levels.sort((a, b) => a - b);
  return levels;
}

function uidFrom(date, seq) {
  const digits = String(date).replace(/-/g, "");
  const padded = seq <= 999 ? String(seq).padStart(3, "0") : String(seq);
  return `m-${digits}-${padded}`;
}

/** 记忆注册表：内存 Map + index/*.json 持久化。 */
export class Registry {
  constructor(home, config = {}) {
    if (!home) throw new Error("Registry 需要母文件夹路径");
    this.home = path.resolve(home);
    this.config = config ?? {};
    this.indexDir = path.join(this.home, "index");
    this.memoriesFile = path.join(this.indexDir, "memories.json");
    this.keywordsFile = path.join(this.indexDir, "keywords.json");
    // 备份统一放在母文件夹下的 Backup/，不再散落在 index/ 里。
    this.backupDir = path.join(this.home, "Backup");
    this.memoriesBackupFile = path.join(this.backupDir, "memories.json.bak");
    this.keywordsBackupFile = path.join(this.backupDir, "keywords.json.bak");
    this.memories = new Map();
    this.keywords = new Map();
  }

  /** 把旧的 index/*.bak 收编到 Backup/；目标已存在则保留目标。 */
  async adoptLegacyBackups() {
    await ensureDir(this.backupDir);
    const pairs = [
      [`${this.memoriesFile}.bak`, this.memoriesBackupFile],
      [`${this.keywordsFile}.bak`, this.keywordsBackupFile],
    ];
    for (const [legacy, target] of pairs) {
      try {
        await fs.access(legacy);
        await fs.access(target);
        continue;
      } catch {
        // 任一侧缺失时继续尝试收编
      }
      try {
        await fs.rename(legacy, target);
      } catch {
        await fs.copyFile(legacy, target).catch(() => undefined);
      }
    }
  }

  /** 读 index/memories.json + index/keywords.json（损坏时回退 Backup/ 或旧 .bak）。
   * 读完校验两个索引是否对得上；不健康就重建关键词倒排并立即落盘，返回 { repaired }。 */
  async load() {
    this.memories.clear();
    this.keywords.clear();
    const memoriesPayload = await readJsonWithBak(this.memoriesFile, this.memoriesBackupFile);
    const rawMemories = isPlainObject(memoriesPayload) ? (memoriesPayload.memories ?? memoriesPayload) : null;
    if (isPlainObject(rawMemories)) {
      for (const meta of Object.values(rawMemories)) {
        if (!isPlainObject(meta)) continue;
        try {
          const normalized = normalizeMeta(meta);
          this.memories.set(normalized.uid, normalized);
        } catch {
          // 跳过损坏条目
        }
      }
    }
    const keywordsPayload = await readJsonWithBak(this.keywordsFile, this.keywordsBackupFile);
    const rawKeywords = isPlainObject(keywordsPayload) ? (keywordsPayload.keywords ?? keywordsPayload) : null;
    let repaired = false;
    if (isPlainObject(rawKeywords)) {
      for (const [term, entries] of Object.entries(rawKeywords)) {
        const key = termKey(term);
        if (!key || !isPlainObject(entries)) continue;
        const bucket = new Map();
        for (const [uid, level] of Object.entries(entries)) {
          const value = Number(level);
          if (Number.isInteger(value) && value >= 0 && value <= 2) bucket.set(uid, value);
        }
        if (bucket.size) this.keywords.set(key, bucket);
      }
    } else {
      this.reindexKeywords();
      repaired = true;
    }
    // 双写非原子：memories 先落盘、keywords 后落盘，中间崩溃会留下合法但空/缺桶的 keywords.json。
    if (!this.indexHealthy()) {
      this.reindexKeywords();
      repaired = true;
    }
    if (repaired) {
      await backupAndWrite(this.keywordsFile, this.keywordsBackupFile, {
        version: INDEX_VERSION,
        updatedAt: Date.now(),
        keywords: this.keywordsSnapshot(),
      });
    }
    return { repaired };
  }

  /** 索引健康检查：memories 非空却无关键词桶；任一 meta 的关键词缺桶或缺 uid；桶里有不存在的 uid。 */
  indexHealthy() {
    if (this.memories.size && !this.keywords.size) return false;
    for (const meta of this.memories.values()) {
      for (const keyword of meta.keywords ?? []) {
        const key = termKey(keyword.term);
        if (!key) continue;
        if (!this.keywords.get(key)?.has(meta.uid)) return false;
      }
    }
    for (const bucket of this.keywords.values()) {
      for (const uid of bucket.keys()) {
        if (!this.memories.has(uid)) return false;
      }
    }
    return true;
  }

  /** 关键词倒排的可序列化快照（save() 与自愈重写共用）。 */
  keywordsSnapshot() {
    const keywords = {};
    for (const term of [...this.keywords.keys()].sort()) {
      const bucket = this.keywords.get(term);
      const entries = {};
      for (const uid of [...bucket.keys()].sort()) entries[uid] = bucket.get(uid);
      keywords[term] = entries;
    }
    return keywords;
  }

  /** 从内存中的 meta 重建关键词倒排（不落盘）。 */
  reindexKeywords() {
    this.keywords.clear();
    for (const meta of this.memories.values()) this.addKeywordLevels(meta);
  }

  /** 原子写两个索引：先备份 .bak，再替换。 */
  async save() {
    await ensureDir(this.indexDir);
    const memories = {};
    for (const uid of [...this.memories.keys()].sort()) memories[uid] = this.memories.get(uid);
    await backupAndWrite(this.memoriesFile, this.memoriesBackupFile, { version: INDEX_VERSION, updatedAt: Date.now(), memories });
    await backupAndWrite(this.keywordsFile, this.keywordsBackupFile, {
      version: INDEX_VERSION,
      updatedAt: Date.now(),
      keywords: this.keywordsSnapshot(),
    });
  }

  // 扫描 memory 目录下所有 meta.json，重建两个索引；返回记忆数量。
  async rebuild() {
    this.memories.clear();
    this.keywords.clear();
    const files = await findMetaFiles(path.join(this.home, "memory"));
    for (const file of files) {
      let raw;
      try {
        raw = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        continue;
      }
      if (!isPlainObject(raw)) continue;
      const folder = path.dirname(file);
      const label = path.basename(folder);
      const parsed = parseMemoryFolderName(label);
      const date = String(raw.date ?? parsed?.date ?? path.basename(path.dirname(folder))).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const seq = Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : parsed?.seq ?? 0;
      if (!Number.isInteger(seq) || seq <= 0) continue;
      let meta;
      try {
        meta = normalizeMeta({
          ...raw,
          uid: raw.uid || parsedUid(date, seq),
          label,
          folder,
          date,
          seq,
          defaultLevel: raw.defaultLevel ?? parsed?.level ?? 2,
          sessionId: raw.sessionId ?? "",
        });
      } catch {
        continue;
      }
      if (!Array.isArray(raw.snapshots) || !raw.snapshots.length) {
        meta.snapshots = await detectSnapshots(folder, meta.defaultLevel);
      }
      this.memories.set(meta.uid, meta);
    }
    this.reindexKeywords();
    await this.save();
    return this.memories.size;
  }

  get(uid) {
    return this.memories.get(String(uid ?? "").trim());
  }

  list() {
    return [...this.memories.values()];
  }

  async upsert(meta) {
    const normalized = normalizeMeta(meta);
    const existing = this.memories.get(normalized.uid);
    if (existing) this.removeKeywordLevels(existing);
    this.memories.set(normalized.uid, normalized);
    this.addKeywordLevels(normalized);
    await this.save();
    return normalized;
  }

  async remove(uid) {
    const key = String(uid ?? "").trim();
    const existing = this.memories.get(key);
    if (!existing) return;
    this.removeKeywordLevels(existing);
    this.memories.delete(key);
    await this.save();
  }

  /**
   * 关键词检索：命中的 uid 集合（去重，不区分等级）。
   * @param {string[]} terms
   * @returns {Set<string>}
   */
  lookup(terms) {
    const hits = new Set();
    if (!Array.isArray(terms)) return hits;
    for (const term of terms) {
      const key = termKey(term);
      if (!key) continue;
      const bucket = this.keywords.get(key);
      if (!bucket) continue;
      for (const uid of bucket.keys()) hits.add(uid);
    }
    return hits;
  }

  /**
   * 批量累加命中：一次遍历更新所有存在的 meta，只落盘一次。
   * 入参兼容 `string[]`（每条 +1）、`[{uid,delta}]`、`[uid,delta]`、`Map<uid,delta>`。
   * @param {Array<string|{uid:string,delta?:number}>|Map<string, number>} uids
   * @param {number} now
   * @returns {Promise<Map<string, number>>} uid -> 更新后的 hitCount（不存在的 uid 不进 Map）
   */
  async bumpHits(uids, now = Date.now()) {
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const hits = new Map();
    for (const { uid, delta } of normalizeBumpEntries(uids)) {
      const meta = this.get(uid);
      if (!meta) continue;
      meta.hitCount = clampHitCount((Number(meta.hitCount) || 0) + delta);
      meta.lastHitAt = at;
      hits.set(meta.uid, meta.hitCount);
    }
    if (hits.size) await this.save();
    return hits;
  }

  /** 单条命中：内部转调 bumpHits，保持「返回 meta / undefined」的既有语义；delta 默认 +1。 */
  async bumpHit(uid, now = Date.now(), delta = 1) {
    const meta = this.get(uid);
    if (!meta) return undefined;
    await this.bumpHits([{ uid: meta.uid, delta }], now);
    return meta;
  }

  async addKeyword(term, uid, level) {
    const key = termKey(term);
    const value = Number(level);
    if (!key) throw new Error("关键词不能为空");
    if (!Number.isInteger(value) || value < 0 || value > 2) throw new Error(`非法快照等级: ${level}`);
    const id = String(uid ?? "").trim();
    if (!id) throw new Error("addKeyword 需要 uid");
    const bucket = this.keywords.get(key) ?? new Map();
    bucket.set(id, Math.max(bucket.get(id) ?? -1, value));
    this.keywords.set(key, bucket);
    const meta = this.memories.get(id);
    if (meta) {
      const keyword = meta.keywords.find((item) => termKey(item.term) === key);
      if (keyword) {
        if (!keyword.levels.includes(value)) {
          keyword.levels = [...keyword.levels, value].sort((a, b) => a - b);
        }
      } else {
        meta.keywords.push({ term: String(term).trim(), keyness: 0, levels: [value] });
      }
    }
    await this.save();
  }

  async removeKeyword(term, uid) {
    const key = termKey(term);
    const id = String(uid ?? "").trim();
    const bucket = this.keywords.get(key);
    if (bucket) {
      bucket.delete(id);
      if (!bucket.size) this.keywords.delete(key);
    }
    const meta = this.memories.get(id);
    if (meta) {
      meta.keywords = meta.keywords.filter((item) => termKey(item.term) !== key);
    }
    await this.save();
  }

  /**
   * 重命名记忆标签/文件夹（实际磁盘 rename 由 memory.renameMemoryFolder 负责）；
   * 这里同步注册表中的 label/folder。
   */
  async rename(meta, newLabel) {
    if (!meta || !meta.uid) throw new Error("rename 需要带 uid 的 meta");
    const label = String(newLabel ?? "").trim();
    if (!label) throw new Error("新标签不能为空");
    const oldFolder = String(meta.folder ?? (this.memories.get(meta.uid)?.folder ?? "")).trim();
    const folder = oldFolder ? path.join(path.dirname(oldFolder), label) : oldFolder;
    const stored = this.memories.get(meta.uid);
    const target = stored ?? normalizeMeta(meta);
    target.label = label;
    target.folder = folder;
    meta.label = label;
    if (folder) meta.folder = folder;
    this.memories.set(target.uid, target);
    await this.save();
  }

  addKeywordLevels(meta) {
    if (!meta) return;
    for (const keyword of meta.keywords ?? []) {
      const key = termKey(keyword.term);
      if (!key) continue;
      const levels = normalizeLevels(keyword.levels, [meta.defaultLevel]);
      const bucket = this.keywords.get(key) ?? new Map();
      let highest = bucket.get(meta.uid);
      for (const level of levels) {
        if (highest === undefined || level > highest) highest = level;
      }
      if (highest !== undefined) bucket.set(meta.uid, highest);
      this.keywords.set(key, bucket);
    }
  }

  removeKeywordLevels(meta) {
    if (!meta) return;
    for (const keyword of meta.keywords ?? []) {
      const key = termKey(keyword.term);
      const bucket = this.keywords.get(key);
      if (!bucket) continue;
      bucket.delete(meta.uid);
      if (!bucket.size) this.keywords.delete(key);
    }
  }
}

function parsedUid(date, seq) {
  return uidFrom(date, seq);
}

// 主动记忆整理：扫描 memory/**/meta.json，修复元数据漂移、清理临时文件、重建索引。
// 纯 ESM；只读扫描 + 幂等修复，不删除记忆、不覆盖快照正文。

import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  atomicWrite,
  daysBetween,
  localDate,
  parseMemoryFolderName,
  renameDirSafe,
} from "./paths.js";
import { dueDiaryDates } from "./diary.js";
import { syncIamIndex } from "./iam.js";
import { buildMemoryLabel, labelTermsOf, upgradeLegacySnapshotText } from "./memory.js";
import { rebuildImagery } from "./imagery.js";

const MAX_KEYWORDS = 12;
const MIN_KEYWORDS = 5;
const MAX_HIT_COUNT = 10;
const TEMP_TTL_MS = 60 * 60 * 1000;

function termKey(term) {
  return String(term ?? "").trim().toLowerCase();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** null/undefined 保持 null；其余仅接受有限数字，避免 Number(null) === 0 的假修复。 */
function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function listMemoryFolders(home) {
  const memoryRoot = path.join(home, "memory");
  const days = [];
  const folders = [];
  let dayNames = [];
  try {
    dayNames = await fs.readdir(memoryRoot);
  } catch {
    return { days, folders };
  }
  for (const day of dayNames.sort()) {
    const dayDir = path.join(memoryRoot, day);
    let stat;
    try {
      stat = await fs.stat(dayDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    days.push(day);
    let names = [];
    try {
      names = await fs.readdir(dayDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const folder = path.join(dayDir, name);
      let child;
      try {
        child = await fs.stat(folder);
      } catch {
        continue;
      }
      if (child.isDirectory()) folders.push({ day, name, folder });
    }
  }
  return { days, folders };
}

async function snapshotLevels(folder) {
  const levels = [];
  for (const level of [2, 1, 0]) {
    if (await exists(path.join(folder, `level${level}.txt`))) levels.push(level);
  }
  return levels.sort((left, right) => left - right);
}

function uidFor(date, seq) {
  const digits = String(date).replace(/-/g, "");
  return `m-${digits}-${String(seq).padStart(3, "0")}`;
}

function normalizeKeywords(list, snapshots, defaultLevel) {
  const byKey = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item)) continue;
    const term = String(item.term ?? "").trim();
    const key = termKey(term);
    if (!key) continue;
    const keynessRaw = Number(item.keyness);
    const keyness = Number.isFinite(keynessRaw) ? keynessRaw : 0;
    const levels = (Array.isArray(item.levels) ? item.levels : [])
      .map(Number)
      .filter((level) => snapshots.includes(level));
    const previous = byKey.get(key);
    if (previous) {
      previous.keyness = Math.max(previous.keyness, keyness);
      previous.levels = [...new Set([...previous.levels, ...levels])].sort((left, right) => left - right);
      continue;
    }
    byKey.set(key, {
      term,
      keyness,
      levels: levels.length ? levels : [defaultLevel],
    });
  }
  // 保留写入时的“重要性降序”顺序；keyness 只作为元数据，不重新排序。
  return [...byKey.values()]
    .map((item) => ({
      term: item.term,
      keyness: item.keyness,
      levels: item.levels.length ? item.levels : [defaultLevel],
    }))
    .slice(0, MAX_KEYWORDS);
}

function normalizePeople(list) {
  const seen = new Set();
  const out = [];
  for (const person of Array.isArray(list) ? list : []) {
    const text = String(person ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function changedPaths(before, after, prefix = "") {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const a = before?.[key];
    const b = after?.[key];
    const label = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(a) && isPlainObject(b)) {
      out.push(...changedPaths(a, b, label));
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(label);
  }
  return out;
}

/** 文件夹改名后，把各快照头部的「记忆编号:」行改成新 label（没有该行就跳过，不碰正文）。 */
async function rewriteSnapshotHeaders(folder, snapshots, label) {
  let changed = false;
  for (const level of snapshots) {
    const file = path.join(folder, `level${level}.txt`);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const lines = text.split("\n");
    const index = lines.findIndex((line) => /^记忆编号:/.test(line));
    if (index === -1) continue;
    const next = `记忆编号: ${label}`;
    if (lines[index] === next) continue;
    lines[index] = next;
    await atomicWrite(file, lines.join("\n"));
    changed = true;
  }
  return changed;
}

/** 早期单井号格式的快照升级成当前键值头格式；返回是否升级过。 */
async function upgradeLegacySnapshots(folder, snapshots, meta, now, config) {
  let changed = false;
  for (const level of snapshots) {
    const file = path.join(folder, `level${level}.txt`);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const upgraded = upgradeLegacySnapshotText({
      text,
      meta,
      level,
      now,
      timeZone: config?.timeZone ?? "Asia/Shanghai",
      keywords: Array.isArray(meta?.keywords) ? meta.keywords : [],
    });
    if (!upgraded.upgraded) continue;
    await atomicWrite(file, upgraded.text);
    changed = true;
  }
  return changed;
}

/** 扫描并修复一条记忆；返回变更字段列表（dryRun 时只报告）。 */
async function repairOne({ home, config, entry, dryRun, now }) {
  const metaFile = path.join(entry.folder, "meta.json");
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(metaFile, "utf8"));
  } catch (error) {
    return { warning: `无法读取 meta.json: ${entry.folder}（${error?.code ?? error?.message ?? error}）` };
  }
  if (!isPlainObject(raw)) return { warning: `meta.json 不是对象: ${entry.folder}` };

  const parsed = parseMemoryFolderName(entry.name) ?? {};
  const snapshots = await snapshotLevels(entry.folder);
  if (!snapshots.length) {
    return { warning: `没有 level0/1/2.txt 快照: ${entry.folder}` };
  }
  const defaultLevel = snapshots[0];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? ""))
    ? String(raw.date)
    : parsed.date ?? entry.day;
  const seq = Number.isInteger(Number(raw.seq)) && Number(raw.seq) > 0 ? Number(raw.seq) : parsed.seq ?? 0;
  const expectedUid = uidFor(date, seq || 1);
  const warnings = [];
  if (!raw.uid) {
    warnings.push(`${entry.name}: 缺少 uid，已补 ${expectedUid}`);
  } else if (String(raw.uid) !== expectedUid) {
    warnings.push(`${entry.name}: uid ${raw.uid} 与日期/序号推导值 ${expectedUid} 不一致（保留原 uid）`);
  }

  const keywords = normalizeKeywords(raw.keywords, snapshots, defaultLevel);
  // 文件夹前缀必须等于 defaultLevel（0/1/2）；追加过的单元还要让编号跟当前关键词对齐。
  // 编号只在创建时生成、追加时只改关键词的话，编号会永远停在首次保存那批词上。
  let folder = entry.folder;
  let label = entry.name;
  let desiredLabel = `${defaultLevel}_${entry.name.replace(/^[0-2]_/, "")}`;
  if (Number(raw.appendCount) > 1) {
    desiredLabel = buildMemoryLabel({
      date,
      seq: seq || 1,
      level: defaultLevel,
      terms: labelTermsOf(keywords),
      maxChars: Number(config?.memory?.filenameMaxChars ?? 180),
    });
  }
  if (desiredLabel !== entry.name) {
    const repairedFolder = path.join(path.dirname(entry.folder), desiredLabel);
    if (!dryRun) {
      try {
        await renameDirSafe(entry.folder, repairedFolder);
        folder = repairedFolder;
        label = desiredLabel;
      } catch (error) {
        warnings.push(`${entry.name}: 文件夹改名失败（${error?.message ?? error}）`);
      }
    } else {
      folder = repairedFolder;
      label = desiredLabel;
    }
  }
  // 头部编号是另一条独立漂移线：档位改名（2_→1_→0_）只改写新派生的那一档，
  // 旧快照头会一直留着生成时的等级。这里按最终 label 统一对齐，没该行的文件跳过。
  let headerRepaired = false;
  if (!dryRun && label === path.basename(folder)) {
    try {
      headerRepaired = await rewriteSnapshotHeaders(folder, snapshots, label);
    } catch (error) {
      warnings.push(`${entry.name}: 快照头部编号改写失败（${error?.message ?? error}）`);
    }
  }

  const forget = isPlainObject(raw.forget) ? raw.forget : {};
  const createdAt = finiteOrNull(raw.createdAt);
  const updatedAt = finiteOrNull(raw.updatedAt);
  const fallbackTime = updatedAt ?? createdAt ?? now;
  const existingD2 = finiteOrNull(forget.d2);
  const existingD5 = finiteOrNull(forget.d5);
  const next = {
    ...raw,
    uid: String(raw.uid || expectedUid),
    label,
    folder,
    defaultLevel,
    snapshots,
    date,
    seq: seq || 1,
    keywords,
    people: normalizePeople(raw.people),
    sessionId: String(raw.sessionId ?? "").trim(),
    createdAt: createdAt ?? 0,
    updatedAt: updatedAt ?? fallbackTime,
    hitCount: Math.round(Math.max(0, Math.min(MAX_HIT_COUNT, Number(raw.hitCount) || 0)) * 100) / 100,
    lastHitAt: finiteOrNull(raw.lastHitAt),
    immortal: raw.immortal === true,
    immortalReason: raw.immortalReason ?? null,
    forget: {
      d2: existingD2 ?? (snapshots.includes(1) ? fallbackTime : null),
      d5: existingD5 ?? (snapshots.includes(0) ? fallbackTime : null),
    },
    relatedUids: (Array.isArray(raw.relatedUids) ? raw.relatedUids : [])
      .map((uid) => String(uid).trim())
      .filter(Boolean),
  };

  const changes = [];
  if (folder !== entry.folder) changes.push("folder");
  if (headerRepaired) changes.push("snapshots");
  // 早期格式快照（`# 摘要` 单井号、`## 追加记忆`）：parseSnapshot 只认 `##`，
  // 不升级的话这类文件一旦被追加，旧正文会被当成「无段落」静默丢掉。
  let legacyUpgraded = false;
  if (!dryRun) {
    legacyUpgraded = await upgradeLegacySnapshots(folder, snapshots, next, now, config).catch((error) => {
      warnings.push(`${entry.name}: 早期格式快照升级失败（${error?.message ?? error}）`);
      return false;
    });
    if (legacyUpgraded) changes.push("snapshots");
  }
  for (const key of changedPaths(raw, next)) if (!changes.includes(key)) changes.push(key);
  if (next.keywords.length < MIN_KEYWORDS) {
    warnings.push(`${entry.name}: 关键词只有 ${next.keywords.length} 个（建议至少 ${MIN_KEYWORDS} 个）`);
  }

  if (!dryRun && changes.length) {
    await atomicJson(path.join(folder, "meta.json"), next);
  }
  return { changed: changes, warnings, folder, label, uid: next.uid };
}

async function cleanupTemp(home, now) {
  const roots = ["memory", "diary", "index", "state", "characters"];
  const removed = [];
  const stack = roots.map((name) => path.join(home, name));
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
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs < TEMP_TTL_MS) continue;
        await fs.rm(full, { force: true });
        removed.push(full);
      } catch {
        // 被占用/已删除：下一轮再试
      }
    }
  }
  return removed;
}

/**
 * 待遗忘条数：与 forget.js 的 desiredLevels 同口径，避免 `/hdm` 与 `hdm_organize` 报出虚高的待办数。
 * 跳过 immortal；needsRederive 优先（1 → 欠 L1，已有 L0 才连 L0；0 → 欠 L0）；
 * 否则按天数与 d2/d5 派生标记判断。L1/L0 两个独立计数，一条记忆可能同时欠两档。
 */
function forgetDueCount(registry, config, now) {
  const zone = config?.timeZone || "Asia/Shanghai";
  const today = localDate(now, zone);
  const rules = config?.forget || {};
  const days = Array.isArray(rules.days) && rules.days.length
    ? rules.days.map(Number).sort((left, right) => left - right)
    : [2, 5];
  const day2 = Number(days[0] ?? 2);
  const day5 = Number(days[1] ?? 5);
  const respectImmortal = rules.respectImmortal !== false;
  let due = 0;
  for (const meta of registry?.list?.() ?? []) {
    if (respectImmortal && meta?.immortal === true) continue;
    let age = Number.NaN;
    try {
      age = daysBetween(meta?.date, today);
    } catch {
      age = Number.NaN;
    }
    const snapshots = Array.isArray(meta?.snapshots) ? meta.snapshots.map(Number) : [];
    const hasL1 = snapshots.includes(1);
    const hasL0 = snapshots.includes(0);
    const forget = meta?.forget || {};
    const rederive = meta?.needsRederive;
    let owesL1 = false;
    let owesL0 = false;
    if (rederive === 1) {
      owesL1 = true;
      // L0 是从 L1 派生的：没有 L0 的单元只需刷新 L1。
      owesL0 = hasL0;
    } else if (rederive === 0 && hasL1) {
      owesL0 = true;
    } else if (Number.isFinite(age)) {
      owesL1 = age >= day2 && !hasL1 && !forget.d2;
      owesL0 = age >= day5 && !hasL0 && !forget.d5 && (hasL1 || owesL1);
    }
    if (owesL1) due += 1;
    if (owesL0) due += 1;
  }
  return due;
}

/**
 * 主动整理 HDM：修复 meta.json 漂移、清理 1 小时以上的原子写临时文件、重建索引。
 * @param {object} options
 * @param {string} options.home 母文件夹
 * @param {object} options.config 已解析配置
 * @param {object} options.registry Registry 实例
 * @param {boolean} [options.dryRun] 只扫描不写入
 * @param {number} [options.now]
 * @returns {Promise<object>} 整理报告
 */
export async function organizeMemories({ home, config, registry, dryRun = false, now = Date.now() } = {}) {
  if (!home) throw new Error("organizeMemories 需要 home");
  const { days, folders } = await listMemoryFolders(home);
  const repaired = [];
  const warnings = [];
  for (const entry of folders) {
    const result = await repairOne({ home, config, entry, dryRun, now });
    if (result.warning) warnings.push(result.warning);
    if (result.warnings?.length) warnings.push(...result.warnings);
    if (result.changed?.length) {
      repaired.push({ uid: result.uid ?? entry.name, folder: result.folder ?? entry.folder, changes: result.changed });
    }
  }
  const removedTemp = dryRun ? [] : await cleanupTemp(home, now);
  // 先重建索引，再统计待办：dueDiaryDates / forgetDueCount 都读 registry，
  // 顺序反了会拿到 rebuild 之前的空注册表（日记待生成恒为 0）。
  let indexCount;
  let imageryCount;
  if (!dryRun && registry?.rebuild) {
    indexCount = await registry.rebuild();
    await syncIamIndex(home, registry).catch(() => undefined);
    // Imagery 以 md 为权威，索引用同一份注册表分数重建。
    imageryCount = await rebuildImagery(home, registry, config?.imagery).catch(() => undefined);
  }
  const diaryPending = await dueDiaryDates({ home, config, registry, now }).catch(() => []);
  const forgetDue = forgetDueCount(registry, config, now);
  const report = {
    dryRun,
    dateFolders: days.length,
    memories: folders.length,
    repaired,
    warnings,
    removedTemp,
    diaryPending,
    forgetDue,
  };
  // dryRun 时不写索引，因此**不返回** indexCount 键：output.schema 声明它是 integer，
  // 返回 null 会被宿主的 schema 校验拒绝（真机上 hdm_organize dryRun 直接报 invalid output）。
  if (indexCount !== undefined) report.indexCount = indexCount;
  if (imageryCount !== undefined) report.imageryCount = imageryCount;
  return report;
}

/** 把整理报告渲染成人类可读文本。 */
export function formatOrganizeReport(report) {
  const lines = [];
  lines.push(report.dryRun ? "HDM 记忆整理（预览，不写入）" : "HDM 记忆整理完成");
  lines.push(`记忆单元: ${report.memories} 个（日期文件夹 ${report.dateFolders} 个）`);
  if (report.repaired.length) {
    lines.push(`修复: ${report.repaired.length} 条`);
    for (const item of report.repaired.slice(0, 12)) {
      lines.push(`- ${item.folder}：${item.changes.join(", ")}`);
    }
  } else {
    lines.push("修复: 无（元数据与快照一致）");
  }
  if (report.dryRun) lines.push("索引: 预览模式未写入");
  else lines.push(`索引: 已重建 ${report.indexCount ?? 0} 条记忆`);
  if (report.imageryCount !== undefined) lines.push(`意象层: 已重建 ${report.imageryCount ?? 0} 条`);
  lines.push(`清理临时文件: ${report.removedTemp.length} 个`);
  lines.push(`定时维护: 日记待生成 ${report.diaryPending.length} 天，遗忘待处理 ${report.forgetDue} 条`);
  if (report.warnings.length) {
    lines.push(`警告: ${report.warnings.length} 条`);
    for (const warning of report.warnings.slice(0, 12)) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

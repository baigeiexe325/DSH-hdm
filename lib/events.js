/**
 * 事件索引（0.4.0）：与关键词倒排完全分开的「事件档案」层。
 *
 * 一条事件 = 一段跨天跨会话的经历（例：维护 HDM 插件），不是精确标题：
 * - 事件名宽泛：`维护插件` 可包含维护/更新 HDM 插件、更新 LOT 等插件；`和用户聊天` 可包含聊哲学、聊日常生活。
 * - `维护 HDM 插件` 与 `生成一份 HDM 的审视报告` 是不同事件（slug 不同）。
 * - 序号只由本模块在超过 maxLines 时生成，调用方不得自带序号；
 *   `维护插件` 与 `维护插件1` 视为不同事件。
 *
 * 数据形态：<home>/Events/<事件名>.txt 是权威，<home>/index/events.json 可丢可重建。
 * 纯 ESM；只用 node: 内置模块与 paths.js。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, atomicWrite, ensureDir, localDate } from "./paths.js";
import { acquireFileLock } from "./state.js";

export const EVENT_DEFAULTS = Object.freeze({
  enabled: true,
  maxLines: 400,
  maxReadChars: 6000,
});

const INDEX_VERSION = 1;
// 事件追加的锁 TTL：只覆盖「读索引 → 写文件 → 写索引」这一小段，取短值；
// 进程被杀后锁很快过期，不会长期占死一个事件的写入。
const EVENT_LOCK_TTL_MS = 30_000;
const TITLE = "# 事件：";
const RELATED_HEADING = "## 相关记忆";
// 单个 slug 上限：够长以保持事件可区分，又不至于撞 Windows 路径长度上限。
const MAX_SLUG = 200;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 调用方明确给的时间戳；没给或解析不了返回 NaN（区别于「取当前时间」兜底）。 */
function explicitStamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

/**
 * 档案文件名 → { base, volume }：`维护插件.txt` → base=维护插件、volume=0（第 1 卷）；
 * `维护插件10.txt` → volume=10。纯数字文件名（如 `2026.txt`）整名当 base，不把日期误当卷号。
 */
function splitVolumeName(name) {
  const stem = path.basename(String(name ?? "")).replace(/\.txt$/i, "");
  const match = /^(.*?)(\d+)$/.exec(stem);
  if (!match || !match[1]) return { base: stem, volume: 0 };
  return { base: match[1], volume: Number(match[2]) };
}

/**
 * 事件档案排序：先按事件名，再按卷号数字。
 * 这是读（readEvent 拼接）、写（appendEventLine 选末卷）、重建（rebuildEvents）三处共用的唯一排序口径，
 * 避免字典序把 `维护插件10.txt` 排到 `维护插件2.txt` 前面。
 */
export function compareEventFiles(a, b) {
  const left = splitVolumeName(a);
  const right = splitVolumeName(b);
  if (left.base !== right.base) return left.base.localeCompare(right.base, "zh-Hans-CN");
  if (left.volume !== right.volume) return left.volume - right.volume;
  return String(a).localeCompare(String(b), "zh-Hans-CN");
}

/** 文件头里的事件名；旧档案没有 `# 事件：` 行时返回空串（按文件名归属，不能丢）。 */
function headerTermOf(text) {
  const match = /^#\s*事件：(.+)$/m.exec(String(text ?? ""));
  return match ? match[1].trim() : "";
}

/** 目标文件是否属于该事件；无头的旧档案不因缺头另起一份。 */
function belongsToEvent(text, slug) {
  const header = headerTermOf(text);
  return !header || eventSlug(header) === slug;
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 事件键：小写、去首尾空白、非法字符与空白折叠成 `-`。
 * 下划线必须一起换掉：它是记忆文件夹名的分隔符，留着会被 parseMemoryFolderName 误切；
 * 中文原样保留，不转拼音（事件名是给人看的）。
 */
export function eventSlug(term) {
  if (term === undefined || term === null) return "";
  let value = String(term).normalize("NFC").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/[\u0000-\u001f\u007f\\/:*?"<>|_]+/g, "-");
  value = value.replace(/\s+/g, "-");
  value = value.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return value.slice(0, MAX_SLUG);
}

/** 事件档案文件名：`维护 HDM 插件` → `维护 HDM 插件.txt`；保留空格，只换 Windows 不允许的字符。 */
export function eventFileName(term) {
  const text = String(term ?? "").normalize("NFC").trim();
  if (!text) return "";
  const safe = text
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    // Windows 不接受结尾的点和空格，去掉免得建不出文件。
    .replace(/[. ]+$/, "");
  return safe ? `${safe}.txt` : "";
}

export function eventsDir(home) {
  return path.join(path.resolve(home), "Events");
}

export function eventsIndexFile(home) {
  return path.join(path.resolve(home), "index", "events.json");
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const term = String(value.term ?? "").trim();
  const slug = eventSlug(term);
  if (!term || !slug) return null;
  return {
    term,
    files: uniqueStrings(value.files).map((file) => file.replace(/\\/g, "/")),
    uids: uniqueStrings(value.uids),
    sessions: uniqueStrings(value.sessions),
    createdAt: finite(value.createdAt, 0),
    updatedAt: finite(value.updatedAt, 0),
  };
}

function normalizeIndex(payload) {
  const raw = payload && typeof payload === "object" ? (payload.entries ?? payload) : null;
  const entries = new Map();
  if (!raw || typeof raw !== "object") return entries;
  for (const value of Object.values(raw)) {
    const entry = normalizeEntry(value);
    if (!entry) continue;
    // 键按 term 重算，索引里键漂移也不影响命中。
    entries.set(eventSlug(entry.term), entry);
  }
  return entries;
}

/** 读事件表；缺失/损坏时返回空 Map（索引可丢，正文才是权威）。 */
export async function loadEventIndex(home) {
  try {
    return normalizeIndex(JSON.parse(await fs.readFile(eventsIndexFile(home), "utf8")));
  } catch {
    return new Map();
  }
}

async function saveEventIndex(home, entries, warnings = []) {
  const out = {};
  for (const key of [...entries.keys()].sort()) out[key] = entries.get(key);
  await atomicJson(eventsIndexFile(home), {
    version: INDEX_VERSION,
    updatedAt: Date.now(),
    entries: out,
    // 重建时的归属冲突等提示：不阻断，但也不静默（hdm_organize 回执之外还能从索引里查）。
    ...(warnings.length ? { warnings } : {}),
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** 正文行数：`## 相关记忆` 之前以 `- ` 开头的行（uid 行不算行数，否则档案提前分裂）。 */
function contentLineCount(text) {
  const body = String(text ?? "");
  const at = body.indexOf(RELATED_HEADING);
  const head = at < 0 ? body : body.slice(0, at);
  return head.split("\n").filter((line) => /^-\s/.test(line)).length;
}

/** 取「## 相关记忆」段里的 uid 行。 */
function relatedUidsOf(text) {
  const body = String(text ?? "");
  const at = body.indexOf(RELATED_HEADING);
  if (at < 0) return [];
  const rest = body.slice(at + RELATED_HEADING.length);
  const next = rest.search(/^##\s/m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const out = [];
  for (const line of section.split("\n")) {
    const match = /^-\s+(\S+)/.exec(line.trim());
    if (match) out.push(match[1]);
  }
  return uniqueStrings(out);
}

/** 在正文段末尾插一行；`## 相关记忆` 段始终保持在最后。 */
function appendContentLine(text, line) {
  const body = String(text ?? "");
  const at = body.indexOf(RELATED_HEADING);
  const insert = (head, tail) => {
    const before = head.replace(/\s+$/, "");
    if (!before) return `${line}\n${tail ? `\n${tail}` : ""}`;
    // 标题后空一行，正文行之间不空行。
    const sep = /(^|\n)-\s[^\n]*$/.test(before) ? "\n" : "\n\n";
    return `${before}${sep}${line}\n${tail ? `\n${tail}` : ""}`;
  };
  return at < 0 ? insert(body, "") : insert(body.slice(0, at), body.slice(at));
}

/** 在「## 相关记忆」段追加 uid；已存在则不重复。 */
function appendRelatedUid(text, uid) {
  if (!uid) return text;
  const body = String(text ?? "");
  if (body.includes(`- ${uid}`)) return body;
  const at = body.indexOf(RELATED_HEADING);
  if (at < 0) return `${body.replace(/\s+$/, "")}\n\n${RELATED_HEADING}\n- ${uid}\n`;
  const rest = body.slice(at + RELATED_HEADING.length);
  const next = rest.search(/^##\s/m);
  const cut = next < 0 ? body.length : at + RELATED_HEADING.length + next;
  const before = body.slice(0, cut).replace(/\s+$/, "");
  const tail = body.slice(cut);
  return tail ? `${before}\n- ${uid}\n\n${tail}` : `${before}\n- ${uid}\n`;
}

function headerText(term) {
  return `${TITLE}${term}\n`;
}

/** 超限后的下一个空档文件名：<term>1.txt、<term>2.txt…（只在本模块内生成序号）。 */
async function nextCapacityFile(home, term) {
  const base = eventFileName(term).replace(/\.txt$/i, "") || eventSlug(term);
  let n = 1;
  while (n < 10000) {
    const rel = `Events/${base}${n}.txt`;
    if (!(await exists(path.join(home, rel)))) return rel;
    n += 1;
  }
  throw new Error(`HDM: 事件「${term}」的档案序号已用尽。`);
}

/**
 * 拿事件锁：acquireFileLock 自身只重试 4 次（约 200ms），并发 save 同一事件时可能不够。
 * 这里再包一层短重试，重试用尽才抛明确错误——丢一条正文比让整次 save 失败更糟。
 */
async function acquireEventLock(home, slug, termText) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await acquireFileLock(home, `events:${slug}`, EVENT_LOCK_TTL_MS);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(`HDM: 事件「${termText}」正被其他写入占用（${detail}）；本次未追加，请稍后重试。`);
}

/**
 * 往事件档案追加一条正文，并维护索引与「相关记忆」段。
 * 幂等：同一 uid + 同一 date + 同一 line 已存在时不再追加（save 重试不会写两次）。
 * @returns {Promise<{ok:boolean, term?:string, file?:string, created?:boolean, appended?:boolean, reason?:string}>}
 */
export async function appendEventLine(home, input = {}) {
  const termText = String(input.term ?? "").trim();
  const slug = eventSlug(termText);
  if (!slug) return { ok: false, reason: "empty-term" };

  const rawLine = String(input.line ?? "").trim().replace(/^-\s+/, "");
  if (!rawLine) return { ok: false, reason: "empty-line" };

  // 事件行标「这件事发生的那天」：优先用快照时刻（调用方传入的 now / snapshotTime），
  // 不用记忆单元的创建日 meta.date——跨天归并同一事件时，第三天的事不该永远标成第一天。
  // 实在读不到时间才退回 input.date，并记 warning：不丢旧调用方的日期，但不再静默错标。
  const timeZone = typeof input.timeZone === "string" && input.timeZone.trim() ? input.timeZone.trim() : undefined;
  const providedNow = explicitStamp(input.now);
  const snapshotAt = explicitStamp(input.snapshotTime ?? input.snapshotAt ?? input.time);
  const occurredAt = Number.isFinite(snapshotAt) ? snapshotAt : providedNow;
  const nowMs = Number.isFinite(providedNow) ? providedNow : Number.isFinite(occurredAt) ? occurredAt : Date.now();
  const warnings = [];
  let date;
  if (Number.isFinite(occurredAt)) {
    date = localDate(occurredAt, timeZone);
  } else if (typeof input.date === "string" && input.date.trim()) {
    date = input.date.trim();
    warnings.push(`没有拿到保存时间，事件行沿用了记忆单元日期 ${date}。`);
  } else {
    date = localDate(nowMs, timeZone);
  }
  // 调用方通常传纯一句话；万一已经带了日期，不再叠加。
  const content = /^\d{4}-\d{2}-\d{2}/.test(rawLine) ? rawLine : `${date} ${rawLine}`;
  const stampLine = `- ${content}`;
  const uid = String(input.uid ?? "").trim();
  const sessionId = String(input.sessionId ?? "").trim();
  const maxLines = Math.max(1, Math.trunc(finite(input.maxLines, EVENT_DEFAULTS.maxLines)));

  // 读索引 → 读文件 → 写文件 → 写索引四步必须串行：并发 save 同一事件时，
  // 每个调用都基于自己读到的旧文本整文件覆盖，后写者会盖掉先写者的正文与 uid。
  // 锁按 slug 粒度，不同事件互不阻塞；拿不到锁抛明确错误，由调用方决定如何回执。
  const release = await acquireEventLock(home, slug, termText);
  try {
    return await appendEventLineLocked(home, { termText, slug, stampLine, uid, sessionId, maxLines, nowMs, warnings });
  } finally {
    await release();
  }
}

/** appendEventLine 的临界区：调用前必须已持有 `events:<slug>` 文件锁。 */
async function appendEventLineLocked(home, { termText, slug, stampLine, uid, sessionId, maxLines, nowMs, warnings = [] }) {
  await ensureDir(eventsDir(home));
  const entries = await loadEventIndex(home);
  const previous = entries.get(slug) ?? null;

  const fileTexts = [];
  for (const rel of previous?.files ?? []) fileTexts.push({ rel, text: await readText(path.join(home, rel)) });

  // 幂等检查扫全部档案：同一条记忆重试时命中即返回，索引与文件都不动。
  if (uid) {
    for (const { rel, text } of fileTexts) {
      if (text.includes(`${stampLine}\n`) && text.includes(`- ${uid}\n`)) {
        return { ok: true, term: previous.term, file: rel, created: false, appended: false };
      }
    }
  }

  // 续写目标 = 卷号最大的那份（不是索引数组末位：旧索引/字典序会把 `xxx10` 排到 `xxx2` 前）。
  let target = "";
  let targetText = "";
  if (fileTexts.length) {
    const ordered = [...fileTexts].sort((a, b) => compareEventFiles(a.rel, b.rel));
    target = ordered[ordered.length - 1].rel;
    targetText = ordered[ordered.length - 1].text;
  }
  let created = false;
  if (!target) {
    // 索引丢了但档案还在：沿用同名的第一份，不另起一份。
    const baseRel = `Events/${eventFileName(termText)}`;
    target = baseRel;
    targetText = await readText(path.join(home, baseRel));
    created = !(await exists(path.join(home, baseRel)));
  }
  // P2-2：目标文件的文件头属于别的事件（事件名与分卷名撞车）时绝不往里写，
  // 顺延到下一个空卷另起一份，并留下 warning——两份档案各自完整，重建后两个事件都还在。
  if (targetText.trim() && !belongsToEvent(targetText, slug)) {
    const owner = headerTermOf(targetText);
    const next = await nextCapacityFile(home, termText);
    warnings.push(
      `Events/${path.basename(target)} 的档案属于「${owner}」，没有写入「${termText}」；已改用 ${next}。`,
    );
    target = next;
    targetText = "";
    created = true;
  }
  // 满卷（含索引丢失后又满的情况）另起一卷，不把正文压在超限文件里。
  if (!created && contentLineCount(targetText) >= maxLines) {
    target = await nextCapacityFile(home, termText);
    targetText = "";
    created = true;
  }
  // 索引还记着、文件却被删了：写回去也算新开档案。
  if (!created && !(await exists(path.join(home, target)))) created = true;

  // 文件缺失或被删空：先补标题，保证档案自己说得清是哪个事件。
  const base = targetText.trim() ? targetText : headerText(previous?.term ?? termText);
  let next = appendContentLine(base, stampLine);
  next = appendRelatedUid(next, uid);

  const files = uniqueStrings([...(previous?.files ?? []), target]);
  const entry = {
    term: previous?.term ?? termText,
    files,
    uids: uniqueStrings([...(previous?.uids ?? []), uid]),
    sessions: uniqueStrings([...(previous?.sessions ?? []), sessionId]),
    createdAt: previous?.createdAt || nowMs,
    // 同一毫秒内连写也要让 updatedAt 变化，列表排序与测试才稳定。
    updatedAt: Math.max(nowMs, finite(previous?.updatedAt) + 1),
  };

  await atomicWrite(path.join(home, target), next);
  entries.set(slug, entry);
  await saveEventIndex(home, entries, warnings);
  const result = { ok: true, term: entry.term, file: target, created, appended: true };
  return warnings.length ? { ...result, warnings } : result;
}

/** 某个 uid 关联的事件条目（save 回执 / reconception 用），按 updatedAt 降序。 */
export async function eventsForUid(home, uid) {
  const key = String(uid ?? "").trim();
  if (!key) return [];
  const entries = await loadEventIndex(home);
  return [...entries.values()]
    .filter((entry) => entry.uids.includes(key))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listEvents(home) {
  const entries = await loadEventIndex(home);
  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.term.localeCompare(b.term));
}

export async function readEvent(home, term, maxChars = EVENT_DEFAULTS.maxReadChars) {
  const slug = eventSlug(term);
  const label = String(term ?? "").trim();
  if (!slug) throw new Error("HDM: 事件需要 term。");
  const entries = await loadEventIndex(home);
  const entry = entries.get(slug);
  if (!entry) throw new Error(`HDM: 没有「${label}」的事件档案。`);

  const parts = [];
  // 拼接顺序与写/重建同一口径：按卷号数字，而不是索引里碰巧的数组顺序。
  for (const rel of [...entry.files].sort(compareEventFiles)) {
    const text = await readText(path.join(home, rel));
    // 读时同样以文件头为准：索引里混进别的事件的档案也不展示。
    if (text.trim() && belongsToEvent(text, slug)) parts.push(text.replace(/\s+$/, ""));
  }
  const full = parts.join("\n\n");
  const limit = Math.max(200, Math.trunc(finite(maxChars, EVENT_DEFAULTS.maxReadChars)));
  return { entry, text: full.slice(0, limit), truncated: full.length > limit };
}

/**
 * 扫 Events/*.txt 重建索引：档案是权威，索引可丢。
 * 同时把 registry 里每条记忆的 meta.event 补进对应事件的 uids——
 * 即使档案被删，也能只凭记忆元数据恢复「这条记忆属于哪个事件」。
 * @returns {Promise<number>} 重建后的事件条数
 */
export async function rebuildEvents(home, registry) {
  const dir = eventsDir(home);
  const nowMs = Date.now();
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith(".txt")).sort(compareEventFiles);
  } catch {
    names = [];
  }

  const bySlug = new Map();
  const warnings = [];
  const seen = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const text = await readText(file);
    // 归属以文件头为准；没有 `# 事件：` 的旧档案退回文件名，不能丢。
    const term = (headerTermOf(text) || path.basename(name, path.extname(name))).trim();
    const slug = eventSlug(term);
    if (!slug) continue;
    seen.push({ name, term, slug });
    const info = await fs.stat(file).catch(() => null);
    const mtime = info?.mtimeMs ?? nowMs;
    const entry = bySlug.get(slug) ?? {
      term,
      files: [],
      uids: [],
      sessions: [],
      createdAt: mtime,
      updatedAt: mtime,
    };
    const rel = `Events/${name}`;
    if (!entry.files.includes(rel)) entry.files.push(rel);
    for (const uid of relatedUidsOf(text)) if (!entry.uids.includes(uid)) entry.uids.push(uid);
    entry.createdAt = Math.min(entry.createdAt, mtime);
    entry.updatedAt = Math.max(entry.updatedAt, mtime);
    bySlug.set(slug, entry);
  }

  // 同名卷撞车：文件头归属 A，但文件名按卷号规则像是另一个已存在事件的卷。
  // 两个事件都保留（各归各的 index 条目），不合并、不覆盖，只记 warning。
  for (const { name, term, slug } of seen) {
    const { base, volume } = splitVolumeName(name);
    const implied = eventSlug(base);
    if (volume > 0 && implied && implied !== slug && bySlug.has(implied)) {
      warnings.push(
        `Events/${name} 的文件头是「${term}」，文件名却像「${base}」的第 ${volume} 卷；已按文件头归属，两个事件都保留。`,
      );
    }
  }

  for (const meta of registry?.list?.() ?? []) {
    // 事件名是可选元数据：空串/非字符串都跳过，别造出无名事件。
    const event = typeof meta?.event === "string" ? meta.event.trim() : "";
    if (!event) continue;
    const slug = eventSlug(event);
    if (!slug) continue;
    const entry = bySlug.get(slug) ?? {
      term: event,
      files: [],
      uids: [],
      sessions: [],
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    const uid = typeof meta?.uid === "string" ? meta.uid.trim() : "";
    if (uid && !entry.uids.includes(uid)) entry.uids.push(uid);
    bySlug.set(slug, entry);
  }

  await saveEventIndex(home, bySlug, warnings);
  return bySlug.size;
}

export default {
  EVENT_DEFAULTS,
  eventSlug,
  eventFileName,
  compareEventFiles,
  eventsDir,
  eventsIndexFile,
  loadEventIndex,
  appendEventLine,
  eventsForUid,
  listEvents,
  readEvent,
  rebuildEvents,
};

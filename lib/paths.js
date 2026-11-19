// HDM 路径与通用文件工具。
// 纯 ESM；只使用 Node 内置模块。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === "number" && Number.isFinite(now)) return new Date(now);
  if (typeof now === "string" && now.trim()) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (now === undefined || now === null) return new Date();
  throw new Error(`无效的时间值: ${String(now)}`);
}

function assertTimeZone(timeZone) {
  const tz = typeof timeZone === "string" && timeZone.trim() ? timeZone.trim() : DEFAULT_TIME_ZONE;
  try {
    // 触发一次格式化，非法时区会抛 RangeError。
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
  } catch {
    throw new Error(`无效时区: ${tz}`);
  }
  return tz;
}

function dateParts(now, timeZone, options) {
  const tz = assertTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options });
  return formatter.formatToParts(toDate(now));
}

function partValue(parts, type) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/** 展开 `~`、`${HOME}`、`$HOME` 为用户主目录。 */
export function expandHome(input) {
  if (typeof input !== "string") throw new Error("路径必须是字符串");
  const trimmed = input.trim();
  if (!trimmed) throw new Error("路径不能为空");
  const home = os.homedir();
  let value = trimmed
    .replace(/\$\{HOME\}/gi, home)
    .replace(/\$HOME(?=[\\/]|$)/g, home);
  if (value === "~") value = home;
  else if (/^~[\\/]/.test(value)) value = path.join(home, value.slice(2));
  return value;
}

/** 本地日期 YYYY-MM-DD（默认 Asia/Shanghai）。 */
export function localDate(now, timeZone = DEFAULT_TIME_ZONE) {
  const parts = dateParts(now, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  const day = partValue(parts, "day");
  if (!year || !month || !day) throw new Error("无法计算本地日期");
  return `${year}-${month}-${day}`;
}

/** 本地时间 YYYY-MM-DD HH:mm:ss +08:00（默认 Asia/Shanghai）。 */
export function localDateTime(now, timeZone = DEFAULT_TIME_ZONE) {
  const parts = dateParts(now, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  const day = partValue(parts, "day");
  const hour = partValue(parts, "hour").padStart(2, "0");
  const minute = partValue(parts, "minute").padStart(2, "0");
  const second = partValue(parts, "second").padStart(2, "0");
  const offset = offsetText(partValue(parts, "timeZoneName"));
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${offset}`;
}

function offsetText(name) {
  if (!name || name === "GMT" || name === "UTC") return "+00:00";
  let match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!match) match = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!match) {
    const numeric = /^([+-])(\d{2}):(\d{2})$/.exec(name);
    if (numeric) return `${numeric[1]}${numeric[2]}:${numeric[3]}`;
    return "+00:00";
  }
  const sign = match[1];
  const hours = String(Number(match[2])).padStart(2, "0");
  const minutes = String(Number(match[3] ?? "0")).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function parseDateText(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`日期格式应为 YYYY-MM-DD: ${text || "(空)"}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`无效日期: ${text}`);
  }
  return stamp;
}

/** dateB - dateA 的天数差（按 YYYY-MM-DD 本地日期）。 */
export function daysBetween(dateA, dateB) {
  return Math.round((parseDateText(dateB) - parseDateText(dateA)) / DAY_MS);
}

/** 文件名安全段：保留中文，非法字符/空白折叠为下划线。 */
export function slug(input) {
  if (input === undefined || input === null) return "";
  let value = String(input).normalize("NFC");
  value = value.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_");
  value = value.replace(/\s+/g, "_");
  value = value.replace(/_+/g, "_");
  value = value.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  return value;
}

/** 关键词在文件夹名里的显示形式：≤ max 字符、保留中文、不含分隔符下划线。 */
export function keywordDisplay(term, max = 8) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 8;
  let value = slug(term).replace(/_/g, "-");
  const chars = Array.from(value);
  if (chars.length > limit) value = chars.slice(0, limit).join("");
  value = value.replace(/[-.]+$/, "");
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    // Windows 上对已存在的盘符根（如 H:\）调用递归 mkdir 会抛 EPERM。
    // 只要目标确实是目录，就视为成功，便于跨盘迁移时安全地创建父目录。
    if (error?.code !== "EPERM" && error?.code !== "EEXIST" && error?.code !== "EACCES") throw error;
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) throw error;
  }
}

async function renameWithRetry(source, target) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES", "EXDEV"].includes(error?.code)) throw error;
      await delay(20 * (attempt + 1));
    }
  }
  throw lastError ?? new Error(`重命名失败: ${source} -> ${target}`);
}

/** 原子写文本文件：同目录临时文件 + rename。 */
export async function atomicWrite(file, text) {
  const target = path.resolve(file);
  await ensureDir(path.dirname(target));
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(String(text ?? ""), "utf8");
      // Windows 上 rename 前必须把内容刷到磁盘，否则断电/崩溃后会留下空文件。
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 原子写 JSON（2 空格缩进、末尾换行）。 */
export async function atomicJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 重命名文件夹；目标已存在且源不存在时视为已完成（可重试的幂等语义）。 */
export async function renameDirSafe(src, dest) {
  const source = path.resolve(src);
  const target = path.resolve(dest);
  if (source === target) return;
  await ensureDir(path.dirname(target));

  let sourceExists = false;
  let targetExists = false;
  try {
    await fs.stat(source);
    sourceExists = true;
  } catch {
    sourceExists = false;
  }
  try {
    await fs.stat(target);
    targetExists = true;
  } catch {
    targetExists = false;
  }

  if (!sourceExists && targetExists) return;
  if (!sourceExists) throw new Error(`源文件夹不存在: ${source}`);
  if (targetExists) throw new Error(`目标文件夹已存在: ${target}`);

  await renameWithRetry(source, target);
}

/** 解析记忆文件夹名 `<level>_<YYYY-MM-DD>_<seq>_<kw...>`。 */
export function parseMemoryFolderName(name) {
  const text = String(name ?? "").trim();
  const match = /^([0-2])_(\d{4}-\d{2}-\d{2})_(\d{3,4})(?:_(.+))?$/.exec(text);
  if (!match) return null;
  const level = Number(match[1]);
  const date = match[2];
  const seq = Number(match[3]);
  try {
    parseDateText(date);
  } catch {
    return null;
  }
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const keywords = match[4] ? match[4].split("_").filter(Boolean) : [];
  return { level, date, seq, keywords };
}

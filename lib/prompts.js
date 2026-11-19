// HDM 提示词加载与工具文案解析。
// 纯 ESM；只使用 Node 内置模块。路径基于 import.meta.url，不依赖 cwd。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url)); // lib/ 的上一级 = 包根
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");
const TOOL_TEXT_FILE = path.join(PROMPTS_DIR, "zh", "tools.md");
const KEY_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

let toolTextCache = null; // { entries, mtimeMs }；mtimeMs=0 表示上次 stat 失败，不命中缓存

/** 读取 prompts/<lang>/<name>.md；文件缺失时抛 Error。 */
export function loadPrompt(name, lang = "zh") {
  const safeLang = typeof lang === "string" && lang.trim() ? lang.trim() : "zh";
  const safeName = String(name ?? "").trim();
  const rel = `prompts/${safeLang}/${safeName}.md`;
  const file = path.join(PROMPTS_DIR, safeLang, `${safeName}.md`);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    const reason = error?.code ?? error?.message ?? "读取失败";
    throw new Error(`缺少提示词文件: ${rel}（${reason}）`);
  }
}

// 解析 tools.md：键值行以首个 ASCII 冒号+空格分隔；行首两空格为续行；# 起头为注释。
function parseToolText() {
  let text = "";
  try {
    text = fs.readFileSync(TOOL_TEXT_FILE, "utf8");
  } catch {
    return new Map();
  }

  const entries = new Map();
  let currentKey = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith("#")) {
      currentKey = null;
      continue;
    }
    if (/^ {2}\S/.test(raw) && currentKey) {
      entries.set(currentKey, `${entries.get(currentKey)}\n${raw.slice(2).trimEnd()}`);
      continue;
    }
    const index = raw.indexOf(": ");
    const key = index > 0 ? raw.slice(0, index).trim() : "";
    if (!KEY_PATTERN.test(key)) {
      currentKey = null;
      continue;
    }
    currentKey = key;
    entries.set(key, raw.slice(index + 2).trimEnd());
  }
  return entries;
}

/** 取 tools.md 中某个键的文案；键不存在或文件缺失时返回空串，不抛错。缓存按 mtime 失效。 */
export function getToolText(key) {
  if (typeof key !== "string" || !key) return "";
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(TOOL_TEXT_FILE).mtimeMs;
  } catch {
    mtimeMs = 0; // stat 失败（文件缺失）：不缓存负结果，下次继续重试读盘
  }
  if (!(toolTextCache && toolTextCache.mtimeMs === mtimeMs && mtimeMs !== 0)) {
    toolTextCache = { entries: parseToolText(), mtimeMs };
  }
  return toolTextCache.entries.get(key) ?? "";
}

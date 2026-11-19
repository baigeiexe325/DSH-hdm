// HDM 静态系统提示词 section（hdm:guide）正文。
// 纯 ESM；同步读取，路径基于 import.meta.url，不依赖 cwd。
// 缓存按文件 mtime 失效：改完 prompts/zh/system-guide.md，下一次读取即生效，不用重启。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url)); // lib/ 的上一级 = 包根
const GUIDE_FILE = path.join(PACKAGE_ROOT, "prompts", "zh", "system-guide.md");

// 提示词文件缺失时的安全兜底（非空，保持工具铁律）。
const FALLBACK_GUIDE = [
  "## HDM 长期记忆",
  "",
  "你有跨会话长期记忆，存在用户的「母文件夹」，会自动注入。",
  "- 值得跨会话记住的事实、偏好、决定、关系变化用 `hdm_save`；`summary` 与 `keywords` 必填，缺失直接报错。",
  "- 回忆过去对话、旧项目用 `hdm_recall`；`keywords` 必填且 1~12 个。",
  "- 需要原话或细节用 `hdm_read`；`uid` 必填。",
  "- 长期身份、目标、关系变化用 `hdm_iam_update`（`content` 必填）；人物信息用 `hdm_character_update`（`name`、`notes` 必填）。",
  "- 寒暄、临时状态、密钥等凭证不要存；新旧冲突写“待确认”，不静默覆盖。",
].join("\n");

let cachedGuide = null; // { text, mtimeMs }；mtimeMs=0 表示上次 stat 失败，不命中缓存

/** 返回 system-guide.md 正文；文件缺失时返回内置中文短文本。同步、按 mtime 失效的缓存。 */
export function getGuideText() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(GUIDE_FILE).mtimeMs;
  } catch {
    mtimeMs = 0; // stat 失败（文件缺失）：不缓存负结果，下次继续重试读盘
  }
  if (cachedGuide && cachedGuide.mtimeMs === mtimeMs && mtimeMs !== 0) return cachedGuide.text;
  try {
    const text = fs.readFileSync(GUIDE_FILE, "utf8").trim();
    cachedGuide = { text: text || FALLBACK_GUIDE, mtimeMs };
    return cachedGuide.text;
  } catch {
    cachedGuide = { text: FALLBACK_GUIDE, mtimeMs: 0 };
    return FALLBACK_GUIDE;
  }
}

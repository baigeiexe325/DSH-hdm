// HDM 运行时技能注册（hdm-memory）。
// 纯 ESM；同步读取，路径基于 import.meta.url，不依赖 cwd。
// 缓存按文件 mtime 失效：改完 prompts/zh/skill.md，下一次读取即生效，不用重启。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url)); // lib/ 的上一级 = 包根
const SKILL_FILE = path.join(PACKAGE_ROOT, "prompts", "zh", "skill.md");

const NAME = "hdm-memory";
const DESCRIPTION =
  "HDM 跨会话长期记忆：保存值得记住的事实、偏好与决定，按关键词调取过去对话与旧项目，维护 IAM 与人物档案。";
const WHEN_TO_USE =
  "当用户提到过去对话/旧项目、要求「记住」「以后都这样」「永远记住」，或需要更新长期身份、关系与目标时使用；命中「回忆/记住/整理记忆」类任务时加载。";

// 技能正文缺失时的安全兜底（非空，保留工具铁律与写入边界）。
const FALLBACK_CONTENT = [
  "# hdm-memory · 长期记忆技能",
  "",
  "## 速查",
  "",
  "- 记住/以后都这样：`hdm_save`（`summary` 与 `keywords` 必填，关键词 10~12 个降序）。",
  "- 永远记住/最重要：`hdm_save` + `immortal:true`。",
  "- 回忆过去：`hdm_recall`（`keywords` 必填，1~12 个）；细节用 `view:2` 或 `hdm_read`（`uid` 必填）。",
  "- 偏好/身份/关系：`hdm_character_update`（`name`、`notes` 必填），USER 优先。",
  "- 长期目标/自我变化：`hdm_iam_update`（`content` 必填）。",
  "",
  "## 禁止事项",
  "",
  "- 不手工编辑 `index/`、`state/`、快照文件；不删除、不改写已有快照。",
  "- 不存密钥、证件号、银行卡等凭证；冲突写“待确认”，不静默覆盖。",
].join("\n");

let cachedRegistration = null; // { registration, mtimeMs }；mtimeMs=0 表示上次 stat 失败，不命中缓存

/** 返回 hdm-memory 技能注册对象；正文读 prompts/zh/skill.md。同步、按 mtime 失效的缓存。 */
export function getSkillRegistration() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(SKILL_FILE).mtimeMs;
  } catch {
    mtimeMs = 0; // stat 失败（文件缺失）：不缓存负结果，下次继续重试读盘
  }
  // 文件未变时返回同一对象引用；只有 mtime 变化才重建 registration。
  if (cachedRegistration && cachedRegistration.mtimeMs === mtimeMs && mtimeMs !== 0) {
    return cachedRegistration.registration;
  }
  let content = "";
  try {
    content = fs.readFileSync(SKILL_FILE, "utf8").trim();
  } catch {
    content = "";
  }
  const registration = {
    name: NAME,
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    source: "runtime",
    content: content || FALLBACK_CONTENT,
    invocation: { modelInvocable: true, userInvocable: false },
  };
  cachedRegistration = { registration, mtimeMs };
  return registration;
}

// ── reconception（0.4.0）：档案调取技能 ──────────────────────────────
const RECONCEPTION_FILE = path.join(PACKAGE_ROOT, "prompts", "zh", "reconception.md");
const RECONCEPTION_NAME = "reconception";
const RECONCEPTION_DESCRIPTION =
  "HDM 档案调取：按「事件 / 人物 / 关键词」三类档案回看成文记录（事件档案、人物档案、关键词档案），与 hdm_recall 检索记忆单元分工。";
const RECONCEPTION_WHEN_TO_USE =
  "当想知道「这类事以前发生过吗」「这个人的偏好是什么」「这个词对我意味着什么」时使用；先 index 看档案与关联 uid，再 read 读正文。";

// 技能正文缺失时的安全兜底（非空，保留调取顺序与只读铁律）。
const RECONCEPTION_FALLBACK_CONTENT = [
  "# reconception · 档案调取技能",
  "",
  "## 速查",
  "",
  "- 这类事以前发生过吗：`reconception({ kind: \"event\" })`（term 可空，直接列事件表）。",
  "- 某人的偏好/关系：`reconception({ kind: \"character\", term: \"用户\" })`，先用 index 再 read。",
  "- 某个词意味着什么：`reconception({ kind: \"keyword\", term: \"母文件夹\" })`。",
  "- 要记忆单元的原话与细节：`hdm_recall` + `hdm_read`，不是这个工具。",
  "",
  "## 铁律",
  "",
  "- 只读：reconception 不写任何文件。",
  "- 档案正文不当摘要引用；命中为空就换词或换 kind，不要编造。",
].join("\n");

let cachedReconceptionRegistration = null; // { registration, mtimeMs }；mtimeMs=0 表示上次 stat 失败，不命中缓存

/** 返回 reconception 技能注册对象；正文读 prompts/zh/reconception.md。同步、按 mtime 失效的缓存。 */
export function getReconceptionSkillRegistration() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(RECONCEPTION_FILE).mtimeMs;
  } catch {
    mtimeMs = 0; // stat 失败（文件缺失）：不缓存负结果，下次继续重试读盘
  }
  if (cachedReconceptionRegistration && cachedReconceptionRegistration.mtimeMs === mtimeMs && mtimeMs !== 0) {
    return cachedReconceptionRegistration.registration;
  }
  let content = "";
  try {
    content = fs.readFileSync(RECONCEPTION_FILE, "utf8").trim();
  } catch {
    content = "";
  }
  const registration = {
    name: RECONCEPTION_NAME,
    description: RECONCEPTION_DESCRIPTION,
    whenToUse: RECONCEPTION_WHEN_TO_USE,
    source: "runtime",
    content: content || RECONCEPTION_FALLBACK_CONTENT,
    invocation: { modelInvocable: true, userInvocable: false },
  };
  cachedReconceptionRegistration = { registration, mtimeMs };
  return registration;
}

// 汇总 HDM 全部提示词：prompts/zh/*.md 全文 + lib/*.js 内联提示词 + 档案模板。
// 用法：node tools/collect-prompts.mjs > /tmp/prompts.json（或由 docx 脚本直接 import）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS = path.join(ROOT, "prompts", "zh");
const LIB = path.join(ROOT, "lib");

/** 每个 md 的用途与加载位置（人工维护，新增 md 时补一行）。 */
const MD_META = {
  "system-guide": { title: "系统行为指南（静态 section）", where: "lib/guide.js → getGuideText()", when: "每次请求都注入（systemPrompt section，order 131）" },
  "tools": { title: "工具文案（键值行）", where: "lib/prompts.js → getToolText()", when: "工具注册时取 description/param/out 文案" },
  "skill": { title: "hdm-memory 技能正文", where: "lib/skill.js → getSkillRegistration()", when: "模型或用户加载 hdm-memory 技能时" },
  "reconception": { title: "reconception 技能正文", where: "lib/skill.js → getReconceptionSkillRegistration()", when: "模型加载 reconception 技能时" },
  "diary": { title: "日记写作者提示词", where: "lib/diary.js → diarySystemPrompt()", when: "每日 23:30 日记生成或 /hdm-diary" },
  "compact": { title: "压缩前记忆提示词", where: "lib/compact.js", when: "上下文压缩前存记忆" },
  "idle-organize": { title: "空闲整理提示词", where: "lib/idle.js", when: "空闲会话自动整理" },
  "profile-compact": { title: "IAM 与人物档案压缩提示词", where: "lib/profile-compact.js", when: "每 6 小时档案压缩" },
};

/** JS 内联提示词：人工选点，避免把错误文案/日志当成提示词。 */
function jsInlinePrompts() {
  const out = [];
  const add = (file, locate, title, when, text) => {
    const body = String(text ?? "").trim();
    if (body) out.push({ file: `lib/${file}`, locate, title, when, text: body });
  };

  const injection = fs.readFileSync(path.join(LIB, "injection.js"), "utf8");
  // REMEMBER_INSTRUCTION 常量：从 `export const REMEMBER_INSTRUCTION = [` 到 `].join("\n");`
  const rememberMatch = /export const REMEMBER_INSTRUCTION = \[([\s\S]*?)\]\.join\("\\n"\);/.exec(injection);
  if (rememberMatch) {
    const lines = [...rememberMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    add("injection.js", "REMEMBER_INSTRUCTION", "强制记忆指令", "/hdm-remember 后注入", lines.join("\n"));
  }
  const hooks = [
    ["记忆词表", "首轮与自动召回", /`===== 记忆词表 =====\\n([^`]*)`/],
    ["事件档案", "首轮", /`===== 事件档案 =====\\n([^`]*)`/],
  ];
  for (const [title, when, re] of hooks) {
    const m = re.exec(injection);
    if (m) add("injection.js", `pushSections → ${title} 段`, `${title}注入段前缀`, when, m[1].replace(/\\n/g, "\n"));
  }
  const nudge = /"(上下文已达阈值。[^"]*)"/.exec(injection);
  if (nudge) add("injection.js", "50% 保存提醒", "保存提醒文案", "上下文约 50% 时", nudge[1]);

  const gist = fs.readFileSync(path.join(LIB, "gist.js"), "utf8");
  const gistSystem = /system: \[([\s\S]*?)\]\.join\("\\n"\)/.exec(gist);
  if (gistSystem) {
    const lines = [...gistSystem[1].matchAll(/(?:"([^"]*)"|`([^`]*)`)/g)].map((m) => m[1] ?? m[2]);
    add("gist.js", "llmGist → system", "L2 派生 gist 提示词", "后台 gist 巡检", lines.join("\n"));
  }

  const diary = fs.readFileSync(path.join(LIB, "diary.js"), "utf8");
  const diaryFallback = /const DIARY_WRITER_FALLBACK = "([^"]*)"/.exec(diary);
  if (diaryFallback) add("diary.js", "DIARY_WRITER_FALLBACK", "日记提示词兜底", "diary.md 缺失时", diaryFallback[1]);
  const diaryCondense = /system: "([^"]*)"[^}]*压/.exec(diary) || /你在压缩日记素材[^"]*/.exec(diary);
  if (diaryCondense) add("diary.js", "压缩日记素材 → system", "日记素材压缩提示词", "素材过长时先压缩", diaryCondense[1] ?? diaryCondense[0]);

  const iam = fs.readFileSync(path.join(LIB, "iam.js"), "utf8");
  for (const key of ["IAM_TEMPLATE", "IAM_BLANK_TEMPLATE"]) {
    const m = new RegExp(`export const ${key} = \`([\\s\\S]*?)\`;`).exec(iam);
    if (m) add("iam.js", key, key === "IAM_TEMPLATE" ? "IAM 模板" : "IAM 空白模板", "首次安装 / 设置页生成", m[1]);
  }

  const chars = fs.readFileSync(path.join(LIB, "characters.js"), "utf8");
  const rule = /export const CHARACTER_WRITING_RULE =([\s\S]*?);\n/.exec(chars);
  if (rule) add("characters.js", "CHARACTER_WRITING_RULE", "人物档案写作规则", "写人物档案时", rule[1].replace(/^\s*=?\s*/, "").replace(/^"|"$/g, ""));
  const userTpl = /export const USER_TEMPLATE = `([\s\S]*?)`;/.exec(chars);
  if (userTpl) add("characters.js", "USER_TEMPLATE", "USER 档案模板", "首次安装", userTpl[1]);

  const skill = fs.readFileSync(path.join(LIB, "skill.js"), "utf8");
  for (const key of ["DESCRIPTION", "WHEN_TO_USE"]) {
    const m = new RegExp(`const ${key} =\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s").exec(skill);
    if (m) add("skill.js", key, `hdm-memory 技能 ${key}`, "技能注册", JSON.parse(`"${m[1]}"`));
  }
  const fb = /const FALLBACK_CONTENT = \[([\s\S]*?)\]\.join\("\\n"\)/.exec(skill);
  if (fb) {
    const lines = [...fb[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    add("skill.js", "FALLBACK_CONTENT", "hdm-memory 技能兜底正文", "skill.md 缺失时", lines.join("\n"));
  }
  return out;
}

const mdPrompts = fs
  .readdirSync(PROMPTS)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((file) => {
    const name = file.replace(/\.md$/, "");
    const bytes = fs.statSync(path.join(PROMPTS, file)).size;
    return {
      name,
      file: `prompts/zh/${file}`,
      bytes,
      ...(MD_META[name] ?? { title: name, where: "（未登记）", when: "（未登记）" }),
      text: fs.readFileSync(path.join(PROMPTS, file), "utf8").trim(),
    };
  });

const result = {
  generatedAt: new Date().toISOString(),
  version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  md: mdPrompts,
  js: jsInlinePrompts(),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

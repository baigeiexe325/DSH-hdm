// HDM 提示词与静态 section / 技能注册测试。
// 运行：node --test test/prompts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getGuideText } from "../lib/guide.js";
import { getSkillRegistration } from "../lib/skill.js";
import { loadPrompt, getToolText } from "../lib/prompts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPTS = path.join(ROOT, "prompts", "zh");

const PROMPT_FILES = [
  "system-guide",
  "tools",
  "skill",
  "diary",
  "compact",
  "idle-organize",
];

const PLACEHOLDER = /TODO|占位|待补|FIXME|XXX/;

const REQUIRED_TOOL_KEYS = [
  "hdm_save.description",
  "hdm_save.param.summary",
  "hdm_save.param.keywords",
  "hdm_recall.description",
  "hdm_recall.param.keywords",
  "hdm_read.description",
  "hdm_read.param.uid",
  "hdm_character_update.description",
  "hdm_character_update.param.name",
  "hdm_character_update.param.notes",
  "hdm_iam_update.description",
  "hdm_iam_update.param.content",
  "hdm_imagery.description",
  "hdm_imagery.param.action",
  "hdm_imagery.param.term",
  "hdm_imagery.param.notes",
];

function readFile(name) {
  return fs.readFileSync(path.join(PROMPTS, `${name}.md`), "utf8");
}

function byteSize(name) {
  return fs.statSync(path.join(PROMPTS, `${name}.md`)).size;
}

test("prompts/zh 下 6 个提示词文件齐备且非空", () => {
  const missing = PROMPT_FILES.filter((name) => {
    const file = path.join(PROMPTS, `${name}.md`);
    return !fs.existsSync(file) || !fs.statSync(file).isFile() || byteSize(name) === 0;
  });
  assert.deepEqual(missing, []);
  assert.equal(PROMPT_FILES.length, 6);
});

// forget / nudge / handoff 三份提示词已删除（正文不再从文件加载），目录里只该剩这 6 份。
test("prompts/zh 目录里恰好 6 个 .md 文件", () => {
  const files = fs.readdirSync(PROMPTS).filter((file) => file.endsWith(".md")).sort();
  assert.deepEqual(files, ["compact.md", "diary.md", "idle-organize.md", "skill.md", "system-guide.md", "tools.md"]);
});

// 0.2.0 起 system-guide 增加「同一编码与空闲整理」一节（约 450 字节），skill 增加 9.5 一节；
// 2026-11-19 补 IAM 写法要求（skill §5 三条 + guide §四 一行），预算再上调一次。
// 2026-11-21 补「何时更新 IAM / 人物」触发清单（guide 5 类 + skill 3 条），上限同步上调。
// 但上限仍设：静态 section 每次请求都进系统提示，膨胀要有人拦。
test("system-guide.md 2500~6800 字节，skill.md 3000~6800 字节", () => {
  const guide = byteSize("system-guide");
  const skill = byteSize("skill");
  assert.ok(guide >= 2500 && guide <= 6800, `system-guide.md 字节数越界: ${guide}`);
  assert.ok(skill >= 3000 && skill <= 6800, `skill.md 字节数越界: ${skill}`);
});

test("system-guide.md 含总览/工具/写作准则等必需小节", () => {
  const text = readFile("system-guide");
  for (const section of ["记忆系统总览", "工具", "写作准则", "顺序快照", "keyness", "immortal", "联想", "注入"]) {
    assert.ok(text.includes(section), `system-guide.md 缺少「${section}」`);
  }
});

test("tools.md 含 5 个工具的 description 与必填参数键", () => {
  const text = readFile("tools");
  for (const key of REQUIRED_TOOL_KEYS) {
    assert.match(text, new RegExp(`^${key}: `, "m"), `tools.md 缺少键行 ${key}`);
    assert.notEqual(getToolText(key), "", `getToolText("${key}") 为空`);
  }
  for (const tool of ["hdm_save", "hdm_recall", "hdm_read", "hdm_character_update", "hdm_iam_update", "hdm_imagery"]) {
    assert.ok(getToolText(`${tool}.description`).length > 0, `${tool} 缺少 description`);
  }
});

test("提示词不含 TODO / 占位 / 待补 等占位符", () => {
  for (const name of PROMPT_FILES) {
    assert.doesNotMatch(readFile(name), PLACEHOLDER, `${name}.md 含未完成占位符`);
  }
});

test("getGuideText() 返回 guide 正文且带缓存", () => {
  const text = getGuideText();
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  assert.match(text, /记忆系统总览/);
  assert.match(text, /写作准则/);
  assert.equal(text, readFile("system-guide").trim());
  assert.equal(getGuideText(), text);
});

test("getSkillRegistration() 符合注册契约且正文来自 skill.md", () => {
  const registration = getSkillRegistration();
  assert.equal(registration.name, "hdm-memory");
  assert.equal(registration.source, "runtime");
  assert.deepEqual(registration.invocation, { modelInvocable: true, userInvocable: false });
  assert.ok(typeof registration.description === "string" && registration.description.length > 0);
  assert.ok(typeof registration.whenToUse === "string" && registration.whenToUse.length > 0);
  assert.ok(registration.content.length > 1000);
  assert.equal(registration.content, readFile("skill").trim());
  assert.equal(getSkillRegistration(), registration);
});

// IAM 写法要求必须写进 skill：各节沿用记忆写法，「当前目标」末点写下一步，新增「我是怎样的人」。
test("skill.md 写清 IAM 写法（含当前目标与我是怎样的人）", () => {
  const text = readFile("skill");
  assert.match(text, /我是怎样的人/);
  assert.match(text, /当前目标/);
  assert.match(text, /末点写下一步/);
  assert.match(text, /①②③/);
});

// 让模型更倾向更新 IAM：触发清单必须写进静态 guide 与 skill，不能只靠工具描述。
test("提示词含「何时更新 IAM / 人物」触发清单与保存后自查", () => {
  const guide = readFile("system-guide");
  assert.match(guide, /何时更新 IAM/);
  assert.match(guide, /每次 `hdm_save` 后自查一次/);
  const skill = readFile("skill");
  assert.match(skill, /自查一次 IAM\/人物/);
  assert.match(skill, /replace_section/);
});

test("getToolText() 解析键值行（含续行），缺失键/非法入参返回空串", () => {
  const description = getToolText("hdm_save.description");
  assert.match(description, /保存一条跨会话记忆/);
  assert.match(description, /一次事件一条/); // 续行已并入
  assert.match(getToolText("hdm_save.param.summary"), /必填/);
  assert.match(getToolText("hdm_recall.param.keywords"), /必填/);
  assert.equal(getToolText("hdm_save.param.not_exists"), "");
  assert.equal(getToolText(""), "");
  assert.equal(getToolText(undefined), "");
});

test("loadPrompt() 读 prompts/zh/<name>.md，缺失时抛 Error", () => {
  const diary = loadPrompt("diary");
  assert.ok(diary.length > 0);
  assert.equal(diary, readFile("diary").trim());
  assert.equal(loadPrompt("diary", "zh"), diary);
  assert.throws(() => loadPrompt("no-such-prompt"), /缺少提示词文件/);
  assert.throws(() => loadPrompt("diary", "no-such-lang"), /缺少提示词文件/);
});

// diary.md 是重写稿：角色以注入的 IAM 为准，而不是旧版「像真实日记」的内联文案。
test("diary.md 是新稿：讲日记写作并以注入的 IAM 为准", () => {
  const text = loadPrompt("diary");
  assert.match(text, /日记/);
  assert.match(text, /IAM/);
});

// 防回退：日记写作必须走 loadPrompt("diary")，不能退回内联 system prompt。
test("lib/diary.js 用 loadPrompt(\"diary\") 取提示词，正文不再写死内联文案", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib", "diary.js"), "utf8");
  assert.match(source, /loadPrompt\(\s*["']diary["']/);
  assert.match(source, /buildIamContext\(/);
});

// 热更新：guide 缓存按 mtime 失效。断言方式是「统计读盘次数」——不改 prompts/ 内容时，
// 值相同无法区分新旧缓存，只有读盘次数能证明缓存确实失效了。
test("getGuideText() 按 mtime 热更新（改 mtime 后重读盘，内容不变）", () => {
  const file = path.join(PROMPTS, "system-guide.md");
  const before = fs.statSync(file);
  const text = getGuideText();
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(file)) reads += 1;
    return originalRead.call(this, target, ...rest);
  };
  try {
    getGuideText(); // mtime 未变：命中缓存，不读盘
    assert.equal(reads, 0);
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    const updated = getGuideText();
    assert.equal(reads, 1, "mtime 变了却没重新读盘");
    assert.equal(updated, text); // 内容没改，值仍相等
    assert.equal(updated, originalRead.call(fs, file, "utf8").trim()); // 读的是磁盘当前内容
  } finally {
    fs.readFileSync = originalRead;
    fs.utimesSync(file, before.atime, before.mtime); // 恢复 mtime，避免污染后续用例
  }
  assert.equal(getGuideText(), readFile("system-guide").trim());
});

// 热更新：skill 未变时返回同一对象引用（test 里断言的契约），mtime 变了才重建新对象。
test("getSkillRegistration() 按 mtime 重建对象（未变时引用相等）", () => {
  const file = path.join(PROMPTS, "skill.md");
  const before = fs.statSync(file);
  const registration = getSkillRegistration();
  try {
    assert.equal(getSkillRegistration(), registration); // 未变：同一引用
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    const rebuilt = getSkillRegistration();
    assert.notEqual(rebuilt, registration, "mtime 变了却没重建对象");
    assert.equal(rebuilt.content, readFile("skill").trim());
  } finally {
    fs.utimesSync(file, before.atime, before.mtime); // 恢复 mtime，避免污染后续用例
  }
  const restored = getSkillRegistration();
  assert.equal(restored.content, readFile("skill").trim());
  assert.equal(getSkillRegistration(), restored); // 恢复后回到缓存命中
});

// 热更新：tools.md 的解析缓存同样按 mtime 失效（getToolText 会重新 parse）。
test("getToolText() 按 mtime 热更新（改 mtime 后重新解析 tools.md）", () => {
  const file = path.join(PROMPTS, "tools.md");
  const before = fs.statSync(file);
  getToolText("hdm_save.description"); // 先填充缓存
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(file)) reads += 1;
    return originalRead.call(this, target, ...rest);
  };
  try {
    getToolText("hdm_save.description"); // mtime 未变：命中缓存，不读盘
    assert.equal(reads, 0);
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    assert.equal(getToolText("hdm_save.description"), getToolText("hdm_save.description"));
    assert.equal(reads, 1, "mtime 变了却没重新解析 tools.md");
  } finally {
    fs.readFileSync = originalRead;
    fs.utimesSync(file, before.atime, before.mtime); // 恢复 mtime，避免污染后续用例
  }
  assert.match(getToolText("hdm_save.description"), /保存一条跨会话记忆/);
});

// 防回退：三个缓存都必须按 mtime 失效，不能退回「进程内只读一次」的纯模块级缓存，
// 否则用户改完 prompts/zh/*.md 又得重启 DSH 才生效。
test("guide/skill/prompts 的缓存按 mtime 失效（源码含 statSync + mtimeMs）", () => {
  for (const name of ["guide", "skill", "prompts"]) {
    const source = fs.readFileSync(path.join(ROOT, "lib", `${name}.js`), "utf8");
    assert.match(source, /statSync\(/, `${name}.js 缺少 statSync（mtime 比对）`);
    assert.match(source, /mtimeMs/, `${name}.js 缺少 mtimeMs 缓存字段`);
  }
});

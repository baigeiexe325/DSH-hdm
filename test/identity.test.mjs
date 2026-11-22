import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IAM_TEMPLATE,
  IAM_BLANK_TEMPLATE,
  REQUIRED_SECTIONS,
  extractSections,
  ensureIam,
  buildIamContext,
  buildIamAnchor,
  updateIam,
  renderMemoryIndex,
  syncIamIndex,
  lintIamContent,
} from "../lib/iam.js";
import {
  CHARACTER_SECTIONS,
  CHARACTER_WRITING_RULE,
  USER_TEMPLATE,
  ensureUserProfile,
  slugPerson,
  loadAliases,
  updateCharacter,
  applySaveCharacters,
  buildCharacterSnippet,
} from "../lib/characters.js";

// 直接复用 lib 的固定标题清单，避免测试与实现各写一份而漂移。
const REQUIRED = [...REQUIRED_SECTIONS];

async function freshHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hdm-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function read(file) {
  return fs.readFile(file, "utf8");
}

test("IAM_TEMPLATE 含全部固定标题，ensureIam 幂等创建", async (t) => {
  const home = await freshHome(t);
  assert.deepEqual(REQUIRED.filter((title) => !(title in extractSections(IAM_TEMPLATE))), []);

  const first = await ensureIam(home);
  assert.equal(await read(path.join(home, "IAM.md")), first);
  assert.deepEqual(REQUIRED.filter((title) => !(title in extractSections(first))), []);

  await fs.writeFile(path.join(home, "IAM.md"), `${first}\n手工追加的一行。\n`, "utf8");
  const second = await ensureIam(home);
  assert.match(second, /手工追加的一行。/);
  assert.equal(second, await read(path.join(home, "IAM.md")));
});

test("「我是怎样的人」紧跟「我是谁」，模板/空白模板/固定标题三处一致", () => {
  const order = Object.keys(extractSections(IAM_TEMPLATE)).filter((title) => REQUIRED.includes(title));
  assert.deepEqual(order, REQUIRED, "IAM_TEMPLATE 的固定标题顺序与 REQUIRED_SECTIONS 一致");
  assert.equal(order.indexOf("我是怎样的人"), order.indexOf("我是谁") + 1, "新节紧跟「我是谁」");

  const blank = Object.keys(extractSections(IAM_BLANK_TEMPLATE));
  assert.deepEqual(REQUIRED.filter((title) => !blank.includes(title)), [], "IAM_Blank 缺固定标题");
  assert.equal(blank.indexOf("我是怎样的人"), blank.indexOf("我是谁") + 1, "空白模板里新节也紧跟「我是谁」");

  // 写作标准落进模板顶部，读 IAM 即见，不只依赖 skill 注入。
  assert.match(IAM_TEMPLATE, /①②③/);
  // 0.3.1：IAM 不再有「当前目标」节，模板/固定标题/空白模板三处都不该出现。
  assert.ok(!REQUIRED.includes("当前目标"));
  assert.ok(!("当前目标" in extractSections(IAM_TEMPLATE)));
  assert.ok(!("当前目标" in extractSections(IAM_BLANK_TEMPLATE)));
});

test("旧 IAM 缺节时补在「我是谁」之后，而不是追加到文件末尾", async (t) => {
  const home = await freshHome(t);
  const file = path.join(home, "IAM.md");
  const old = `# IAM

## 我是谁
旧的我。

## 人生阶段
阶段。

## 重要关系
关系。

## 长期主题与价值
价值。

## 自我叙事
叙事。

## 记忆索引
索引。
`;
  await fs.writeFile(file, old, "utf8");
  const written = await updateIam(home, { content: "保持不变。", mode: "append", section: "我是谁" }, 10000);
  assert.equal(written.ok, true);

  const text = await read(file);
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  assert.deepEqual(headings, REQUIRED);
  assert.equal(headings.indexOf("我是怎样的人"), headings.indexOf("我是谁") + 1);
  assert.match(text, /## 我是怎样的人\n（待补充）/);
  assert.match(text, /保持不变。/);
});

test("buildIamContext 按 maxChars 截断", async (t) => {
  const home = await freshHome(t);
  await ensureIam(home);
  const full = await read(path.join(home, "IAM.md"));
  const context = await buildIamContext(home, 80);
  assert.ok(context.length <= 80);
  assert.equal(context, full.slice(0, 80));
  assert.equal(await buildIamContext(home, 10000), full);
});

test("buildIamAnchor 每节 1~2 句且不超过 anchorMaxChars", async (t) => {
  const home = await freshHome(t);
  const content = `# IAM

## 我是谁
我是小林，一名开发者。喜欢做工具。第三句不应出现。

## 我是怎样的人
先勘察再动手。结论要有运行证据。

## 人生阶段
2026 年开始做插件。2026 年人生阶段第二句不出现。

## 重要关系
用户是长期伙伴。朋友很多。

## 长期主题与价值
长期主题是记忆。价值是诚实。

## 自我叙事
我在构建长期记忆。

## 记忆索引
记忆索引待建。索引第二句。索引第三句不出现。
`;
  const written = await updateIam(home, { mode: "rewrite", content }, 10000);
  assert.equal(written.ok, true);

  const anchor = await buildIamAnchor(home, { iam: { anchorMaxChars: 400, anchorIncludeUserTone: false } });
  assert.ok(anchor.length <= 400);
  // 锚点取「首句 + 末句」：节尾追加的新事实必须进锚点，中间句不进。
  assert.match(anchor, /我是谁：我是小林，一名开发者。第三句不应出现。/);
  assert.match(anchor, /我是怎样的人：先勘察再动手。结论要有运行证据。/);
  assert.match(anchor, /重要关系：用户是长期伙伴。朋友很多。/);
  assert.ok(!anchor.includes("喜欢做工具"));
  assert.ok(!anchor.includes("索引第二句"));

  const short = await buildIamAnchor(home, { iam: { anchorMaxChars: 30, anchorIncludeUserTone: false } });
  assert.ok(short.length <= 30);
});

test("buildIamAnchor 解析失败时回退前 400 字", async (t) => {
  const home = await freshHome(t);
  const raw = "没有固定标题的自我描述。".repeat(60);
  await fs.writeFile(path.join(home, "IAM.md"), raw, "utf8");

  const anchor = await buildIamAnchor(home, { iam: { anchorMaxChars: 400, anchorIncludeUserTone: false } });
  assert.equal(anchor, raw.slice(0, 400));
  assert.ok(anchor.length <= 400);

  const tiny = await buildIamAnchor(home, { iam: { anchorMaxChars: 50, anchorIncludeUserTone: false } });
  assert.ok(tiny.length <= 50);
});

test("updateIam 支持 append / replace_section / rewrite 并保留必需标题", async (t) => {
  const home = await freshHome(t);
  const file = path.join(home, "IAM.md");
  await ensureIam(home);

  const appended = await updateIam(home, { content: "先写测试，再动手。", mode: "append", section: "自我叙事" }, 10000);
  assert.equal(appended.ok, true);
  let text = await read(file);
  assert.match(text, /先写测试，再动手。/);
  assert.match(text, /我是谁/);

  const replaced = await updateIam(home, { content: "改完后先跑测试，再报结论。", mode: "replace_section", section: "自我叙事" }, 10000);
  assert.equal(replaced.ok, true);
  text = await read(file);
  assert.match(text, /改完后先跑测试，再报结论。/);
  assert.doesNotMatch(text, /先写测试，再动手。/);
  for (const title of REQUIRED) assert.ok(text.includes(`## ${title}`), `缺少标题 ${title}`);

  const rewritten = await updateIam(home, { content: "# 新 IAM\n\n## 我是谁\n重写后的自我。\n", mode: "rewrite" }, 10000);
  assert.equal(rewritten.ok, true);
  text = await read(file);
  assert.match(text, /重写后的自我。/);
  for (const title of REQUIRED) assert.ok(text.includes(`## ${title}`), `rewrite 后缺少标题 ${title}`);
});

test("updateIam 超过 maxChars 拒绝且不写文件", async (t) => {
  const home = await freshHome(t);
  const file = path.join(home, "IAM.md");
  await ensureIam(home);
  const before = await read(file);
  const limit = before.length + 10;

  const result = await updateIam(home, { content: "很".repeat(500), mode: "append" }, limit);
  assert.equal(result.ok, false);
  assert.match(result.error, /超过上限/);
  assert.equal(result.mode, "append");
  assert.equal(await read(file), before);

  const badMode = await updateIam(home, { content: "x", mode: "nope" }, 10000);
  assert.equal(badMode.ok, false);
  assert.match(badMode.error, /append/);
});

test("人物档案框架固定四节，写作要求写进模板头（与意象同源）", async () => {
  assert.deepEqual([...CHARACTER_SECTIONS], ["基本", "偏好与语气", "关系与互动", "待确认 / 矛盾"]);
  assert.match(CHARACTER_WRITING_RULE, /一句一事实/);
  assert.match(CHARACTER_WRITING_RULE, /只追加不覆盖/);
  // 模板头带写作要求：新建档案时模型就看到约束，不必回头查 skill。
  assert.match(USER_TEMPLATE, /写作要求：一句一事实/);
  assert.match(USER_TEMPLATE, /不写百科与评价/);
});

test("USER_TEMPLATE / ensureUserProfile 创建且幂等", async (t) => {
  const home = await freshHome(t);
  assert.match(USER_TEMPLATE, /## 待确认 \/ 矛盾/);
  assert.match(USER_TEMPLATE, /## 基本/);

  const first = await ensureUserProfile(home);
  const file = path.join(home, "characters", "USER.md");
  assert.equal(await read(file), first);

  await fs.writeFile(file, `${first}\n- 手工改动\n`, "utf8");
  const second = await ensureUserProfile(home);
  assert.match(second, /手工改动/);
  assert.equal(second, await read(file));
});

test("slugPerson 保留中文并去掉路径非法字符", () => {
  assert.equal(slugPerson("小林"), "小林");
  assert.equal(slugPerson(" 小林 "), "小林");
  assert.equal(slugPerson("小/林"), "小_林");
  assert.equal(slugPerson("a:b*c?"), "a_b_c");
  assert.equal(slugPerson(".."), "未命名");
  assert.equal(slugPerson(""), "未命名");
  const dangerous = slugPerson("../../etc/passwd");
  assert.ok(!dangerous.includes("/") && !dangerous.includes("\\"));
});

test("loadAliases 默认映射与自定义别名", async (t) => {
  const home = await freshHome(t);
  const defaults = await loadAliases(home);
  for (const alias of ["我", "用户", "你", "user", "me"]) {
    assert.equal(defaults[alias], "USER", `别名 ${alias} 应映射到 USER`);
  }

  await fs.mkdir(path.join(home, "characters"), { recursive: true });
  await fs.writeFile(
    path.join(home, "characters", "_aliases.json"),
    JSON.stringify({ "小林": "小林", Lin: "小林", USER: ["老板", "我"] }),
    "utf8",
  );
  const aliases = await loadAliases(home);
  assert.equal(aliases.Lin, "小林");
  assert.equal(aliases["老板"], "USER");
  assert.equal(aliases["我"], "USER");
  assert.equal(aliases["小林"], "小林");
});

test("updateCharacter 只追加、带日期/证据/置信度，USER 优先级 0", async (t) => {
  const home = await freshHome(t);
  const userResult = await updateCharacter(
    home,
    { name: "我", notes: "喜欢安静的界面。", evidenceUid: "m-20261107-001", confidence: 0.9 },
    12000,
  );
  assert.equal(userResult.ok, true);
  assert.equal(userResult.priority, 0);
  assert.equal(userResult.path, path.join(home, "characters", "USER.md"));

  const userFile = await read(userResult.path);
  assert.match(userFile, /喜欢安静的界面。/);
  assert.match(userFile, /\[\d{4}-\d{2}-\d{2}\]/);
  assert.match(userFile, /m-20261107-001/);
  assert.match(userFile, /置信度: 0\.9/);

  const otherResult = await updateCharacter(home, { name: "小林", notes: "是搭档。", evidenceUid: "m-20261107-002" }, 12000);
  assert.equal(otherResult.ok, true);
  assert.equal(otherResult.priority, 1);
  assert.equal(otherResult.path, path.join(home, "characters", "小林.md"));

  await updateCharacter(home, { name: "小林", notes: "喜欢咖啡。" }, 12000);
  const otherFile = await read(otherResult.path);
  assert.match(otherFile, /是搭档。/);
  assert.match(otherFile, /喜欢咖啡。/);
});

test("updateCharacter 超 maxChars 拒绝且不覆盖旧内容", async (t) => {
  const home = await freshHome(t);
  const user = await ensureUserProfile(home);
  const file = path.join(home, "characters", "USER.md");
  const limit = user.length + 20;

  const result = await updateCharacter(home, { name: "用户", notes: "很".repeat(200), evidenceUid: "m-20261107-003" }, limit);
  assert.equal(result.ok, false);
  assert.match(result.error, /超过上限/);
  assert.equal(await read(file), user);
});

test("updateCharacter 冲突写入“待确认 / 矛盾”", async (t) => {
  const home = await freshHome(t);
  const file = path.join(home, "characters", "USER.md");
  await updateCharacter(home, { name: "我", notes: "喜欢猫。" }, 12000);
  await updateCharacter(home, { name: "我", notes: "不喜欢猫。" }, 12000);

  const text = await read(file);
  assert.match(text, /## 待确认 \/ 矛盾/);
  assert.match(text, /⚠️ 冲突：不喜欢猫。/);
});

test("updateCharacter 写入别名并可通过别名解析", async (t) => {
  const home = await freshHome(t);
  const result = await updateCharacter(home, { name: "小林", notes: "同事。", aliases: ["Lin", "小林老师"] }, 12000);
  assert.equal(result.ok, true);

  const aliases = await loadAliases(home);
  assert.equal(aliases.Lin, "小林");
  assert.equal(aliases["小林老师"], "小林");

  const viaAlias = await updateCharacter(home, { name: "我", notes: "用别名写入。", aliases: ["本人"] }, 12000);
  assert.equal(viaAlias.path, path.join(home, "characters", "USER.md"));
  assert.match(await read(viaAlias.path), /用别名写入。/);
});

test("applySaveCharacters 先写 USER 再写其他人", async (t) => {
  const home = await freshHome(t);
  const results = await applySaveCharacters(
    home,
    [
      { name: "小林", notes: "同事。", confidence: 0.7 },
      { name: "用户", notes: "本人。", confidence: 0.95 },
    ],
    "m-20261107-009",
    12000,
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].name, "USER");
  assert.equal(results[1].name, "小林");
  assert.equal(results[0].ok, true);

  const userText = await read(results[0].path);
  assert.match(userText, /本人。/);
  assert.match(userText, /m-20261107-009/);
  assert.match(await read(results[1].path), /同事。/);

  const aliased = await applySaveCharacters(home, [{ name: "我", notes: "本人二。" }], "m-20261107-010", 12000);
  assert.equal(aliased.length, 1);
  assert.equal(aliased[0].name, "USER");
});

function fakeRegistry(count) {
  const list = Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 10)).padStart(2, "0");
    return {
      uid: `m-202611${day}-${String(index + 1).padStart(3, "0")}`,
      date: `2026-11-${day}`,
      seq: index + 1,
      label: `2_2026-11-${day}_${String(index + 1).padStart(3, "0")}_主题${index}_摘要`,
      event: `事件${index}`,
    };
  });
  return { list: () => list };
}

test("renderMemoryIndex 只保留统计 + 最近 12 条，记忆上千条也不膨胀", () => {
  const index = renderMemoryIndex(fakeRegistry(1200));
  assert.match(index, /共 1200 条/);
  assert.match(index, /最近 12 条/);
  assert.match(index, /index\/memories\.json/);
  assert.equal(index.split("\n").filter((line) => line.trim().startsWith("- m-")).length, 12);
  assert.ok(index.length < 2000, `索引摘要过长: ${index.length}`);
  assert.equal(renderMemoryIndex({ list: () => [] }), "（暂无记忆；完整清单见 index/memories.json）");
});

test("syncIamIndex 替换记忆索引小节并幂等，保留其他章节", async (t) => {
  const home = await freshHome(t);
  const long = Array.from({ length: 200 }, (_, index) => `- m-20261101-${index} 很长的旧索引行`).join("\n");
  await fs.writeFile(
    path.join(home, "IAM.md"),
    `# IAM\n\n## 我是谁\n保持不变。\n\n## 记忆索引\n${long}\n`,
    "utf8",
  );

  const changed = await syncIamIndex(home, fakeRegistry(300));
  assert.equal(changed, true);
  const text = await read(path.join(home, "IAM.md"));
  assert.match(text, /保持不变。/);
  assert.match(text, /共 300 条/);
  assert.doesNotMatch(text, /很长的旧索引行/);
  const indexSection = extractSections(text)["记忆索引"];
  assert.ok(indexSection.length < 2000, `记忆索引小节过长: ${indexSection.length}`);

  assert.equal(await syncIamIndex(home, fakeRegistry(300)), false, "第二次同步不应再写文件");
  assert.equal(await read(path.join(home, "IAM.md")), text);
});


test("updateCharacter 章节别名归一到模板标题，不再长出重复章节", async (t) => {
  const home = await freshHome(t);
  await ensureUserProfile(home);
  const file = path.join(home, "characters", "USER.md");

  // 模型常写的三种别名：偏好 / 基本信息 / 与我的关系
  await updateCharacter(home, { name: "用户", notes: "喜欢先看结论。", section: "偏好", evidenceUid: "m-1" }, 12000);
  const basic = await updateCharacter(home, { name: "用户", notes: "Windows 11 用户。", section: "基本信息", evidenceUid: "m-2" }, 12000);
  assert.equal(basic.section, "基本", "基本信息归一到 基本");
  const relation = await updateCharacter(home, { name: "用户", notes: "长期委托我维护插件。", section: "与我的关系", evidenceUid: "m-3" }, 12000);
  assert.equal(relation.section, "关系与互动", "与我的关系归一到 关系与互动");

  const text = await read(file);
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(
    headings,
    ["基本", "偏好与语气", "关系与互动", "待确认 / 矛盾", "记忆索引"],
    "章节与模板一致，没有新增别名章节",
  );
  assert.match(text, /喜欢先看结论。/);
  assert.match(text, /Windows 11 用户。/);

  // 仍可显式新建非模板章节
  const custom = await updateCharacter(home, { name: "用户", notes: "记一笔。", section: "工作习惯", evidenceUid: "m-4" }, 12000);
  assert.equal(custom.section, "工作习惯");
  assert.match(await read(file), /^## 工作习惯$/m);
});

test("buildCharacterSnippet：USER 取基本前两句，别名解析，缺文件返回 null", async (t) => {
  const home = await freshHome(t);
  await updateCharacter(home, { name: "用户", notes: "用户是单人协作伙伴。偏好简洁。第三句不取。" }, 12000);
  const user = await buildCharacterSnippet(home, "用户", 200);
  assert.equal(user.name, "USER");
  assert.match(user.excerpt, /单人协作伙伴/);
  assert.ok(!user.excerpt.includes("第三句不取"));
  assert.ok(user.excerpt.length <= 200);

  assert.equal(await buildCharacterSnippet(home, "不存在的人", 200), null);
  assert.equal(await buildCharacterSnippet("", "用户", 200), null);
});

test("buildIamAnchor 预算不足时不漏节（实机 400 字回归）", async (t) => {
  const home = await freshHome(t);
  const long = "这一节写得较长，用来撑预算，还要再占一些字符。";
  // 人生阶段每点必须带年份（lintIamContent 的确定性规则），其余节用同一段长文本撑预算。
  const bodyOf = (title) =>
    title === "人生阶段" ? `2026 年${long}2026 年末句在这里。` : `${long}末句在这里。`;
  const content = `# IAM\n\n${REQUIRED.map((title) => `## ${title}\n${bodyOf(title)}`).join("\n\n")}\n`;
  const written = await updateIam(home, { mode: "rewrite", content }, 10000);
  assert.equal(written.ok, true);

  const anchor = await buildIamAnchor(home, { iam: { anchorMaxChars: 200, anchorIncludeUserTone: false } });
  assert.ok(anchor.length <= 400);
  for (const title of REQUIRED) assert.ok(anchor.includes(`${title}：`), `锚点漏掉「${title}」`);
});

test("lintIamContent：拒绝运行细节/事件回忆/长括号解释，放行纯结论", () => {
  // 这两种正是实机 IAM 串味的写法：把报错处理与机制细节写进了「我是怎样的人」。
  assert.ok(
    lintIamContent("我是怎样的人", "⑨ 工具报参数错就修参数本身，绝不用占位值凑数绕过校验（曾用 a1~j10 当关键词，污染标签与词表）。").length > 0,
  );
  assert.ok(
    lintIamContent("我是怎样的人", "⑩ 改共享记忆库的索引前先确认有没有别的会话在写：运行中插件的 registry 是启动时载入的内存副本。").length > 0,
  );
  assert.ok(lintIamContent("我是怎样的人", "① 先勘察再动手，改前读现状、跑测试基线。② 结论要有运行证据。").length === 0);
});

test("updateIam：硬性拦截串味写入，记忆索引拒手写，合规内容照常写入", async (t) => {
  const home = await freshHome(t);
  await ensureIam(home);

  const bad = await updateIam(home, { content: "改索引前先确认别的会话没在写（曾用 a1~j10 占位）。", mode: "append", section: "我是怎样的人" }, 10000);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /IAM 写入被拒/);

  const index = await updateIam(home, { content: "手写索引。", mode: "replace_section", section: "记忆索引" }, 10000);
  assert.equal(index.ok, false);
  assert.match(index.error, /自动维护/);

  const noYear = await updateIam(home, { content: "① 做了一些插件。", mode: "replace_section", section: "人生阶段" }, 10000);
  assert.equal(noYear.ok, false);
  assert.match(noYear.error, /缺少时间/);

  const good = await updateIam(home, { content: "① 先勘察再动手。② 结论要有运行证据。", mode: "replace_section", section: "我是怎样的人" }, 10000);
  assert.equal(good.ok, true);
  assert.match(await read(path.join(home, "IAM.md")), /先勘察再动手/);
});

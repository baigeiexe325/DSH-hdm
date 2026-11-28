// reconception（0.4.0）测试：三类档案的 index / read、只读、截断、工具注册。
// 运行：node --test test/reconception.test.mjs
// 全部使用 os.tmpdir() 下的临时 home，绝不触碰真实 ~/dsh-HDM。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import { RECONCEPTION_DEFAULTS, reconcept, reconceptionKinds } from "../lib/reconception.js";
import { createTools } from "../lib/tools.js";
import { getReconceptionSkillRegistration, getSkillRegistration } from "../lib/skill.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-reconception-test-"));
after(() => rm(ROOT, { recursive: true, force: true }));

// 事件正文刻意写长（>300 字），截断测试才有意义。
const EVENT_TEXT = [
  "# 事件：维护插件",
  "",
  "- 2026-11-20 维护 HDM 插件：拆分 tools.js，新增 reconception 工具与技能。",
  "- 2026-11-21 更新 LOT 插件：修沙箱 ACL 与工作区写入权限，补 diagnostic 命令与自检脚本。",
  "- 2026-11-22 维护 HDM 插件：为 0.4.0 补事件档案层，写 Events/ 与 index/events.json，事件名按一类事命名。",
  "- 2026-11-23 更新 HDM 提示词：把档案调取写进系统提示，补 tools.md 的键行与技能正文。",
  "- 2026-11-24 维护 LOT 插件：仓库示例补 README 与测试，跑通 node --test 与打包检查。",
  "",
  "## 相关记忆",
  "- m-20261120-001",
  "- m-20261121-002",
  "",
].join("\n");

const CHAT_EVENT_TEXT = [
  "# 事件：和用户聊天",
  "",
  "- 2026-11-19 和用户聊哲学：讨论记忆与自我的边界。",
  "",
  "## 相关记忆",
  "- m-20261119-001",
  "",
].join("\n");

const USER_TEXT = [
  "# USER 档案",
  "",
  "> 用户本人档案，优先级 0；只追加、不覆盖。",
  "",
  "## 基本",
  "- [2026-11-21] 用户是 HDM 的共同作者，常驻 Windows。（证据: m-20261121-001；置信度: 0.9）",
  "- [2026-11-22] 用户偏好直接给结论、少铺陈。（证据: m-20261122-001；置信度: 0.8）",
  "",
  "## 偏好与语气",
  "- [2026-11-22] 用户说话克制，讨厌空话。（证据: m-20261122-001；置信度: 0.8）",
  "",
  "## 关系与互动",
  "- [2026-11-21] 与用户是长期一对一协作关系。（证据: m-20261121-001；置信度: 0.9）",
  "",
  "## 待确认 / 矛盾",
  "（暂无）",
  "",
  "## 记忆索引",
  "（暂无）",
  "",
].join("\n");

const XIAOLIN_TEXT = [
  "# 小林 档案",
  "",
  "## 基本",
  "- [2026-11-20] 小林负责 LOT 插件的沙箱部分。（证据: m-20261120-002；置信度: 0.7）",
  "",
  "## 待确认 / 矛盾",
  "（暂无）",
  "",
].join("\n");

const IMAGERY_TEXT = [
  "# 意象：母文件夹",
  "",
  "> 关键词线索记忆；只追加，不覆盖。",
  "",
  "## 释义",
  "母文件夹是 HDM 的全部：IAM、memory/、characters/、diary/、Imagery/ 与 state/ 都长在它下面。",
  "",
  "## 经历",
  "- 2026-11-21 m-20261121-001：用户回补 11 月 18 至 19 日记忆。",
  "",
  "## 记忆索引",
  "- m-20261121-001",
  "",
].join("\n");

async function write(rel, text) {
  const full = path.join(ROOT, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, text, "utf8");
}

await write("Events/维护插件.txt", EVENT_TEXT);
await write("Events/和用户聊天.txt", CHAT_EVENT_TEXT);
await write(
  "index/events.json",
  `${JSON.stringify(
    {
      version: 1,
      updatedAt: 1,
      entries: {
        维护插件: {
          term: "维护插件",
          files: ["Events/维护插件.txt"],
          uids: ["m-20261120-001", "m-20261121-002"],
          sessions: ["s-1"],
          createdAt: 1,
          updatedAt: 2,
        },
        和用户聊天: {
          term: "和用户聊天",
          files: ["Events/和用户聊天.txt"],
          uids: ["m-20261119-001"],
          sessions: ["s-2"],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    },
    null,
    2,
  )}\n`,
);
await write("characters/USER.md", USER_TEXT);
await write("characters/小林.md", XIAOLIN_TEXT);
await write("characters/_aliases.json", `${JSON.stringify({ 阿林: "小林" }, null, 2)}\n`);
await write("Imagery/母文件夹.md", IMAGERY_TEXT);
await write(
  "index/imagery.json",
  `${JSON.stringify(
    {
      version: 1,
      updatedAt: 1,
      entries: {
        母文件夹: {
          term: "母文件夹",
          file: "Imagery/母文件夹.md",
          score: 21.5,
          memories: 2,
          hitSum: 5,
          immortal: 0,
          keyness: 9,
          updatedAt: 1,
        },
      },
    },
    null,
    2,
  )}\n`,
);

/* ------------------------------------------------------------------ */
/* 1. event index                                                      */
/* ------------------------------------------------------------------ */

test("event index：term 为空列出事件表（按 updatedAt 降序）", async () => {
  const result = await reconcept({ home: ROOT, kind: "event" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "event");
  assert.equal(result.mode, "index");
  assert.equal(result.term, "");
  assert.deepEqual(result.matches.map((m) => m.title), ["维护插件", "和用户聊天"]);
  assert.deepEqual(result.matches[0], {
    file: "Events/维护插件.txt",
    uids: ["m-20261120-001", "m-20261121-002"],
    chars: Buffer.byteLength(EVENT_TEXT, "utf8"),
    title: "维护插件",
  });
  assert.deepEqual(result.relatedUids, ["m-20261120-001", "m-20261121-002", "m-20261119-001"]);
  assert.equal(result.text, undefined);
});

test("event index：term=维护插件 命中并带 uids；宽泛词也命中", async () => {
  const exact = await reconcept({ home: ROOT, kind: "event", term: "维护插件" });
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0].title, "维护插件");
  assert.deepEqual(exact.matches[0].uids, ["m-20261120-001", "m-20261121-002"]);

  const broad = await reconcept({ home: ROOT, kind: "event", term: "维护" });
  assert.deepEqual(broad.matches.map((m) => m.title), ["维护插件"]);

  const none = await reconcept({ home: ROOT, kind: "event", term: "不存在的事件" });
  assert.deepEqual(none.matches, []);
  assert.deepEqual(none.relatedUids, []);
});

/* ------------------------------------------------------------------ */
/* 2. event read                                                       */
/* ------------------------------------------------------------------ */

test("event read：返回正文；未命中返回 matches:[] 且不抛", async () => {
  const result = await reconcept({ home: ROOT, kind: "event", term: "维护插件", mode: "read" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "read");
  assert.equal(result.term, "维护插件");
  assert.equal(result.truncated, false);
  assert.match(result.text, /# 事件：维护插件/);
  assert.match(result.text, /reconception 工具与技能/);
  assert.deepEqual(result.matches, [
    {
      file: "Events/维护插件.txt",
      uids: ["m-20261120-001", "m-20261121-002"],
      chars: result.text.length,
      title: "维护插件",
    },
  ]);
  assert.deepEqual(result.relatedUids, ["m-20261120-001", "m-20261121-002"]);

  const missing = await reconcept({ home: ROOT, kind: "event", term: "没有这份档案", mode: "read" });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.matches, []);
  assert.deepEqual(missing.relatedUids, []);
  assert.equal(missing.text, undefined);
});

/* ------------------------------------------------------------------ */
/* 3. character index / read                                           */
/* ------------------------------------------------------------------ */

test("character index：USER 命中、别名命中、不存在为空", async () => {
  const user = await reconcept({ home: ROOT, kind: "character", term: "用户" });
  assert.deepEqual(
    user.matches.map((m) => m.file),
    ["characters/USER.md"],
  );
  assert.equal(user.matches[0].title, "USER");
  assert.deepEqual(user.matches[0].uids, []);

  // 默认别名「我」→ USER
  const me = await reconcept({ home: ROOT, kind: "character", term: "我" });
  assert.deepEqual(
    me.matches.map((m) => m.file),
    ["characters/USER.md"],
  );

  // 自定义别名「阿林」→ 小林
  const alias = await reconcept({ home: ROOT, kind: "character", term: "阿林" });
  assert.deepEqual(
    alias.matches.map((m) => m.file),
    ["characters/小林.md"],
  );
  assert.equal(alias.matches[0].title, "小林");

  // term 为空必须报错，不给「全部人物」这种隐式返回。
  await assert.rejects(() => reconcept({ home: ROOT, kind: "character" }), /需要 term/);

  const none = await reconcept({ home: ROOT, kind: "character", term: "不存在的人" });
  assert.deepEqual(none.matches, []);
});

test("character read：USER 摘录含基本段；别名可读；不存在返回空", async () => {
  const user = await reconcept({ home: ROOT, kind: "character", term: "用户", mode: "read" });
  assert.equal(user.term, "USER");
  assert.match(user.text, /共同作者/);
  assert.equal(user.truncated, false);
  assert.deepEqual(user.matches, [
    { file: "characters/USER.md", uids: [], chars: user.text.length, title: "USER" },
  ]);

  const alias = await reconcept({ home: ROOT, kind: "character", term: "阿林", mode: "read" });
  assert.equal(alias.term, "小林");
  assert.match(alias.text, /沙箱部分/);
  assert.equal(alias.matches[0].file, "characters/小林.md");

  const missing = await reconcept({ home: ROOT, kind: "character", term: "不存在的人", mode: "read" });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.matches, []);
  assert.equal(missing.text, undefined);
});

/* ------------------------------------------------------------------ */
/* 4. keyword index / read                                             */
/* ------------------------------------------------------------------ */

test("keyword index：按包含匹配并带档案里的关联 uid", async () => {
  const result = await reconcept({ home: ROOT, kind: "keyword", term: "母文件夹" });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0], {
    file: "Imagery/母文件夹.md",
    uids: ["m-20261121-001"],
    chars: IMAGERY_TEXT.length,
    title: "母文件夹",
  });
  assert.deepEqual(result.relatedUids, ["m-20261121-001"]);

  const partial = await reconcept({ home: ROOT, kind: "keyword", term: "母" });
  assert.deepEqual(
    partial.matches.map((m) => m.title),
    ["母文件夹"],
  );

  const none = await reconcept({ home: ROOT, kind: "keyword", term: "冷词" });
  assert.deepEqual(none.matches, []);
});

test("keyword read：返回正文；未命中返回空", async () => {
  const result = await reconcept({ home: ROOT, kind: "keyword", term: "母文件夹", mode: "read" });
  assert.equal(result.term, "母文件夹");
  assert.match(result.text, /母文件夹是 HDM 的全部/);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.matches, [
    { file: "Imagery/母文件夹.md", uids: ["m-20261121-001"], chars: result.text.length, title: "母文件夹" },
  ]);

  const missing = await reconcept({ home: ROOT, kind: "keyword", term: "冷词", mode: "read" });
  assert.deepEqual(missing.matches, []);
  assert.equal(missing.text, undefined);
});

/* ------------------------------------------------------------------ */
/* 5. 只读                                                             */
/* ------------------------------------------------------------------ */

async function snapshot(home) {
  const out = {};
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(home, full).replace(/\\/g, "/");
        const info = await stat(full);
        out[rel] = { mtimeMs: info.mtimeMs, text: await readFile(full, "utf8") };
      }
    }
  }
  await walk(home);
  return out;
}

test("只读：全部 index/read 前后文件内容与 mtime 不变", async () => {
  const termOf = { event: "维护插件", character: "用户", keyword: "母文件夹" };
  const before = await snapshot(ROOT);
  await reconcept({ home: ROOT, kind: "event" }); // term 为空只允许 event
  for (const kind of reconceptionKinds()) {
    await reconcept({ home: ROOT, kind, term: termOf[kind] });
    await reconcept({ home: ROOT, kind, term: termOf[kind], mode: "read" });
  }
  await reconcept({ home: ROOT, kind: "event", term: "不存在", mode: "read" });
  await reconcept({ home: ROOT, kind: "character", term: "不存在的人" });
  const after = await snapshot(ROOT);
  assert.deepEqual(after, before);
});

/* ------------------------------------------------------------------ */
/* 6. 截断                                                             */
/* ------------------------------------------------------------------ */

test("maxReadChars:100 时 truncated:true（正文压到 200 字上限）", async () => {
  assert.ok(EVENT_TEXT.length > 200, "fixture 事件正文要够长");
  const result = await reconcept({ home: ROOT, kind: "event", term: "维护插件", mode: "read", maxReadChars: 100 });
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 200);
  assert.equal(result.matches[0].chars, 200);
});

/* ------------------------------------------------------------------ */
/* 7. 参数校验                                                         */
/* ------------------------------------------------------------------ */

test("kind=character/keyword 无 term 抛「需要 term」；未知 kind/mode 也报错", async () => {
  await assert.rejects(() => reconcept({ home: ROOT, kind: "character" }), /需要 term/);
  await assert.rejects(() => reconcept({ home: ROOT, kind: "keyword" }), /需要 term/);
  await assert.rejects(() => reconcept({ home: ROOT, kind: "event", mode: "read" }), /需要 term/);
  await assert.rejects(() => reconcept({ home: ROOT, kind: "event", term: "x", mode: "wat" }), /未知的 reconception mode/);
  await assert.rejects(() => reconcept({ home: ROOT, kind: "wat" }), /未知的 reconception kind/);
  assert.deepEqual(reconceptionKinds(), ["event", "character", "keyword"]);
  assert.equal(RECONCEPTION_DEFAULTS.maxReadChars, 6000);
  assert.equal(RECONCEPTION_DEFAULTS.maxIndexItems, 20);
});

/* ------------------------------------------------------------------ */
/* 8. 工具注册                                                         */
/* ------------------------------------------------------------------ */

test("tools.js 注册了 reconception（kind 必填、enum 三类）", async () => {
  const tools = createTools({
    ctx: { logger: { warn() {}, error() {} } },
    home: ROOT,
    config: {},
    registry: { list: () => [] },
    state: { getSession: () => null, updateSession: async () => {} },
  });
  const tool = tools.find((item) => item.name === "reconception");
  assert.ok(tool, "没有注册 reconception 工具");
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["kind"]);
  assert.deepEqual(tool.parameters.properties.kind.enum, ["event", "character", "keyword"]);
  assert.deepEqual(tool.parameters.properties.mode.enum, ["index", "read"]);
  for (const key of ["ok", "kind", "term", "mode", "matches", "text", "truncated", "relatedUids"]) {
    assert.ok(tool.output.schema.properties[key], `output.schema 缺少 ${key}`);
  }

  // execute 走默认 config（没有 reconception 段）也不能炸。
  const indexed = await tool.execute({ kind: "event" });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.matches.length, 2);
  assert.match(String(tool.output.render({ kind: "event" }, indexed)[0].text), /维护插件  uids=2  Events\/维护插件\.txt/);

  const read = await tool.execute({ kind: "event", term: "维护插件", mode: "read" });
  assert.match(String(tool.output.render({ kind: "event" }, read)[0].text), /# 事件：维护插件/);

  const empty = tool.output.render({ kind: "keyword", term: "冷词" }, { ok: true, matches: [] });
  assert.match(String(empty[0].text), /没有匹配/);
});

/* ------------------------------------------------------------------ */
/* 9. 技能注册                                                         */
/* ------------------------------------------------------------------ */

test("getReconceptionSkillRegistration() 注册 reconception 且正文来自 reconception.md", async () => {
  const registration = getReconceptionSkillRegistration();
  assert.equal(registration.name, "reconception");
  assert.equal(registration.source, "runtime");
  assert.deepEqual(registration.invocation, { modelInvocable: true, userInvocable: false });
  const promptFile = fileURLToPath(new URL("../prompts/zh/reconception.md", import.meta.url));
  assert.equal(registration.content, (await readFile(promptFile, "utf8")).trim());
  assert.match(registration.content, /档案调取/);
  assert.match(registration.content, /hdm_recall/);
  assert.equal(getReconceptionSkillRegistration(), registration);
  // 原有 hdm-memory 技能行为不变。
  assert.equal(getSkillRegistration().name, "hdm-memory");
});

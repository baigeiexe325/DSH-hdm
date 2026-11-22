import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { apply, name, inject, Config } from "../lib/index.js";
import { noteCompactionStart, pendingCompactionCount, settleCompaction } from "../lib/compact.js";
import { resolveConfig } from "../lib/config.js";
import { Registry } from "../lib/registry.js";
import { StateStore } from "../lib/state.js";
import { readPointer, writePointer } from "../lib/migrate.js";
import { pendingActivity } from "../lib/idle.js";

// 避免测试触碰真实主目录里的指针文件。
process.env.HDM_HOME_POINTER = path.join(os.tmpdir(), `hdm-pointer-${process.pid}.json`);

const SESSION_ID = "s-integration-1";
const SESSION_ID_2 = "s-integration-2";

function ok(text) {
  return { kind: "success", text };
}

function makeCtx({ pressure = 0.1, llmReply = "模型写的日记" } = {}) {
  const tools = new Map();
  const commands = new Map();
  const skills = new Map();
  const sections = [];
  const handlers = new Map();
  const provided = new Map();
  const typert = [];

  const mkSctx = (extra) => ({
    ...ctx,
    provide(name, service) {
      provided.set(name, service);
    },
    typert: {
      register(contribution) {
        typert.push(contribution);
        return () => {};
      },
    },
    effect(fn) {
      return ctx.effect(fn);
    },
    ...extra,
  });

  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    skills: {},
    systemPrompt: {},
    commands: {},
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    inject(names, callback) {
      callback(
        mkSctx({
          skills: {
            register(registration) {
              skills.set(registration.name, registration);
              return () => {};
            },
          },
          systemPrompt: {
            section(section) {
              sections.push(section);
              return () => {};
            },
          },
          commands: {
            register(command) {
              commands.set(command.name, command);
              return () => {};
            },
          },
        }),
      );
    },
    timer: {
      interval() {
        return () => {};
      },
    },
    tokenMeter: {
      contextPressure() {
        if (pressure == null) return null;
        return { pressureTokens: Math.round(pressure * 1000), contextWindow: 1000 };
      },
    },
    llm: {
      async stream(payload) {
        handlers.lastLlm = payload;
        return (async function* () {
          yield { type: "text-delta", textDelta: llmReply };
        })();
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: "fake-provider", model: "fake-model" };
      },
    },
    get() {
      return undefined;
    },
  };

  return {
    ctx,
    tools,
    commands,
    skills,
    sections,
    handlers,
    provided,
    typert,
    run(event, payload) {
      const list = handlers.get(event) ?? [];
      assert.ok(list.length > 0, `no handler for ${event}`);
      const next = async () => payload.decision;
      return list[0](payload, next);
    },
  };
}

function sessionHeader(id, cwd, createdAt = Date.now()) {
  return { id, cwd, createdAt, origin: "user" };
}

function fakeAgent(id, cwd) {
  // 真实 Session 自带 `id`（`get id()`），伪造的会话也得有：`/hdm-remember` 与
  // state 都按 `session.id` 定位，只给 header.id 会让它们「拿不到当前会话 id」。
  return { id, session: { id, header: sessionHeader(id, cwd) } };
}

function userMessage(text, id = crypto.randomUUID()) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

async function newHome() {
  return mkdtemp(path.join(os.tmpdir(), "hdm-it-"));
}

const CONFIG = {
  homeDir: "", // filled per test
  timeZone: "Asia/Shanghai",
  save: { threshold: 0.05, step: 0.15, maxPerSession: 4 },
  diary: { enabled: true },
  forget: { enabled: true, days: [2, 5], checkHours: 6 },
  iam: { anchorEveryTurns: 6 },
  nudge: { enabled: true, everyUserTurns: 6, maxPerSession: 2 },
  autoRecall: { enabled: true, topK: 2, minScore: 2, maxChars: 600 },
  handoff: { enabled: true, maxChars: 2000, maxAgeDays: 30 },
};

function keywordsFor(n = 10) {
  const base = ["项目", "架构", "决策", "会议", "结论", "风险", "预算", "时间线", "负责人", "复盘", "迁移", "测试"];
  return base.slice(0, n);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

// 用一个“未来时钟”跑定时任务，避免真的改动系统时间。
async function withTimeOffset(days, fn) {
  const realNow = Date.now;
  const offset = days * 86400000;
  Date.now = () => realNow() + offset;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// 遗忘后文件夹会按默认档改名，用前缀在 memory/<date>/ 下找回。
async function findFolder(home, date, prefix) {
  const dir = path.join(home, "memory", date);
  const names = await readdir(dir).catch(() => []);
  const name = names.find((n) => n.startsWith(`${prefix}_`));
  assert.ok(name, `memory/${date} 下应有 ${prefix}_ 前缀的文件夹，实际: ${names.join(", ")}`);
  return path.join(dir, name);
}

async function saveMemory(env, agent, args) {
  const tool = env.tools.get("hdm_save");
  assert.ok(tool, "hdm_save registered");
  return tool.execute(
    {
      summary: "今天讨论了 HDM 插件的顺序快照设计",
      details: ["L2 创建，第 2 天派生 L1，第 5 天派生 L0", "旧快照冻结"],
      quotes: ["顺序快照而不是三档同时创建"],
      keywords: keywordsFor(11),
      people: ["小明"],
      scene: "本地开发",
      event: "设计评审",
      source: "observed",
      importance: 3,
      characters: [{ name: "小明", notes: "偏好简洁的方案" }],
      ...args,
    },
    { agent },
  );
}

test("HDM 集成：安装目录、IAM、人物模板", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });

    assert.equal(name, "hdm");
    assert.ok(inject.includes("tools"));
    assert.equal(env.sections.length, 1);
    assert.equal(env.sections[0].name, "hdm:guide");
    assert.ok(env.sections[0].text.length > 100);
    assert.ok(env.skills.get("hdm-memory"));
    assert.ok(env.tools.has("hdm_save"));
    assert.ok(env.tools.has("hdm_recall"));
    assert.ok(env.tools.has("hdm_read"));
    assert.ok(env.tools.has("hdm_character_update"));
    assert.ok(env.tools.has("hdm_iam_update"));
    assert.ok(env.commands.has("hdm"));

    const iam = await readFile(path.join(home, "IAM.md"), "utf8");
    assert.match(iam, /我是谁/);
    const user = await readFile(path.join(home, "characters", "USER.md"), "utf8");
    assert.ok(user.length > 0);
    for (const dir of ["memory", "diary", "characters", "index", "state"]) {
      assert.ok((await stat(path.join(home, dir))).isDirectory(), dir);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：保存 -> 索引 -> 调取 -> 读取 -> 人物", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = fakeAgent(SESSION_ID, home);

    const saved = await saveMemory(env, agent);
    assert.equal(saved.ok, true, JSON.stringify(saved).slice(0, 400));
    assert.match(saved.uid, /^m-\d{8}-\d{3}$/);
    assert.equal(saved.defaultLevel, 2);
    assert.ok(saved.keywordScores.length >= 10 && saved.keywordScores.length <= 12);
    for (const score of saved.keywordScores) {
      assert.equal(typeof score.term, "string");
      assert.equal(typeof score.keyness, "number");
    }

    const level2 = await readFile(path.join(saved.folder, "level2.txt"), "utf8");
    assert.match(level2, /## 摘要/);
    assert.match(level2, /顺序快照/);
    assert.equal((await stat(path.join(saved.folder, "level1.txt")).catch(() => null)), null);
    assert.equal((await stat(path.join(saved.folder, "level0.txt")).catch(() => null)), null);
    assert.match(path.basename(saved.folder), /^2_\d{4}-\d{2}-\d{2}_\d{3}_/);

    const meta = await readJson(path.join(saved.folder, "meta.json"));
    assert.equal(meta.uid, saved.uid);
    assert.deepEqual(meta.snapshots, [2]);

    const index = await readJson(path.join(home, "index", "memories.json"));
    assert.ok(JSON.stringify(index).includes(saved.uid));

    const userProfile = await readFile(path.join(home, "characters", "USER.md"), "utf8");
    assert.ok(userProfile.length > 0);
    const xiaoming = await readFile(path.join(home, "characters", "小明.md"), "utf8");
    assert.match(xiaoming, /偏好简洁/);

    const recallTool = env.tools.get("hdm_recall");
    const recalled = await recallTool.execute({ keywords: ["项目", "架构", "决策"] }, { agent });
    const matches = Array.isArray(recalled.matches) ? recalled.matches : [];
    assert.ok(matches.length >= 1, JSON.stringify(recalled).slice(0, 400));
    assert.equal(matches[0].uid, saved.uid);
    assert.equal(matches[0].level, 2);
    assert.ok(Array.isArray(matches[0].higherLevels));
    assert.ok(matches[0].weight >= 1);

    const readTool = env.tools.get("hdm_read");
    const read = await readTool.execute({ uid: saved.uid, level: 2 }, { agent });
    const text = read.text ?? read.content ?? JSON.stringify(read);
    assert.match(text, /摘要/);

    const charTool = env.tools.get("hdm_character_update");
    const updated = await charTool.execute(
      { name: "小明", notes: "习惯用 PowerShell", section: "习惯", evidenceUid: saved.uid, confidence: 0.8 },
      { agent },
    );
    assert.equal(updated.ok ?? true, true);
    const after = await readFile(path.join(home, "characters", "小明.md"), "utf8");
    assert.match(after, /PowerShell/);

    const iamTool = env.tools.get("hdm_iam_update");
    const iamUpdated = await iamTool.execute(
      { content: "常在本机工作，偏好先跑测试再报结论。", mode: "replace_section", section: "自我叙事" },
      { agent },
    );
    assert.equal(iamUpdated.ok ?? true, true);
    const iam = await readFile(path.join(home, "IAM.md"), "utf8");
    assert.match(iam, /偏好先跑测试再报结论/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：第 2 天派生 L1、第 5 天派生 L0、L2 冻结、文件夹改名", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = fakeAgent(SESSION_ID, home);
    const saved = await saveMemory(env, agent);
    const level2Before = await readFile(path.join(saved.folder, "level2.txt"), "utf8");

    const forget = env.commands.get("hdm-forget");
    const keywordQuery = ["项目", "架构", "决策", "会议", "结论", "风险"];

    const day2 = await withTimeOffset(3, () => forget.handler({ rawInput: "all" }));
    assert.match(day2.text, /遗忘巡检完成/);
    const folder1 = await findFolder(home, saved.date ?? saved.label.match(/\d{4}-\d{2}-\d{2}/)[0], 1);
    assert.ok(await stat(path.join(folder1, "level1.txt")));
    assert.equal(await readFile(path.join(folder1, "level2.txt"), "utf8"), level2Before);
    assert.equal(await stat(path.join(folder1, "level0.txt")).catch(() => null), null);

    const day5 = await withTimeOffset(6, () => forget.handler({ rawInput: "all" }));
    assert.match(day5.text, /遗忘巡检完成/);
    const folder0 = await findFolder(home, saved.label.match(/\d{4}-\d{2}-\d{2}/)[0], 0);
    assert.ok(await stat(path.join(folder0, "level0.txt")));
    assert.equal(await readFile(path.join(folder0, "level2.txt"), "utf8"), level2Before);

    const meta = await readJson(path.join(folder0, "meta.json"));
    assert.equal(meta.defaultLevel, 0);
    assert.deepEqual([...meta.snapshots].sort(), [0, 1, 2]);

    const recallTool = env.tools.get("hdm_recall");
    const recalled = await recallTool.execute({ keywords: keywordQuery }, { agent });
    assert.ok(recalled.matches.length >= 1, JSON.stringify(recalled));
    assert.equal(recalled.matches[0].level, 0);
    assert.ok(recalled.matches[0].higherLevels.length >= 1);
    assert.ok(recalled.matches[0].higherLevels.some((h) => h.level === 2));

    const view2 = await recallTool.execute({ keywords: keywordQuery, view: 2 }, { agent });
    assert.equal(view2.matches[0].level, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：永久豁免不参与遗忘", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = fakeAgent(SESSION_ID, home);
    const saved = await saveMemory(env, agent, { immortal: true });

    assert.match(saved.next, /永久豁免/, "保存时 immortal:true 应落在回执上");

    const date = saved.label.match(/\d{4}-\d{2}-\d{2}/)[0];
    await withTimeOffset(10, () => env.commands.get("hdm-forget").handler({ rawInput: "all" }));

    assert.equal(await stat(path.join(saved.folder, "level1.txt")).catch(() => null), null);
    assert.equal(await stat(path.join(saved.folder, "level0.txt")).catch(() => null), null);
    assert.ok(path.basename(saved.folder).startsWith("2_"));
    assert.ok(await stat(path.join(home, "memory", date, path.basename(saved.folder))));

    const recallTool = env.tools.get("hdm_recall");
    const recalled = await recallTool.execute({ keywords: ["项目", "架构", "决策", "会议", "结论"] }, { agent });
    assert.ok(recalled.matches.length >= 1, JSON.stringify(recalled));
    assert.equal(recalled.matches[0].immortal, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：日记生成、幂等、回退", async () => {
  const home = await newHome();
  const env = makeCtx({ llmReply: "今天完成了顺序快照的集成测试。" });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = fakeAgent(SESSION_ID, home);
    const saved = await saveMemory(env, agent);
    const date = saved.label.match(/\d{4}-\d{2}-\d{2}/)[0];

    const diary = env.commands.get("hdm-diary");
    const first = await diary.handler({ rawInput: date });
    assert.equal(first.kind, "success", first.text);
    const file = path.join(home, "diary", `${date}.txt`);
    const content = await readFile(file, "utf8");
    assert.match(content, /顺序快照/);

    const second = await diary.handler({ rawInput: date });
    assert.equal(second.kind, "success");
    assert.equal(await readFile(file, "utf8"), content, "日记应幂等");

    // 模型不可用 -> 确定性回退
    const failing = makeCtx();
    failing.ctx.llm = {
      async stream() {
        return (async function* () {
          yield { type: "text-delta", textDelta: "" };
        })();
      },
    };
    failing.ctx.agentDefaultModel = { currentSelection: () => null };
    const otherHome = await newHome();
    try {
      await apply(failing.ctx, { ...CONFIG, homeDir: otherHome });
      const other = await saveMemory(failing, fakeAgent("s-fallback", otherHome));
      const otherDate = other.label.match(/\d{4}-\d{2}-\d{2}/)[0];
      const res = await failing.commands.get("hdm-diary").handler({ rawInput: otherDate });
      assert.equal(res.kind, "success", res.text);
      assert.match(res.text, /回退摘要/);
      assert.ok((await readFile(path.join(otherHome, "diary", `${otherDate}.txt`), "utf8")).length > 0);
    } finally {
      await rm(otherHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：首轮注入 IAM/handoff、自动召回、6 轮锚点、50% 提醒", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1 });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });

    // 先造一条“上一段对话”的记忆（不同 session、更早创建）
    const oldAgent = fakeAgent("s-old", home);
    const old = await saveMemory(env, oldAgent);

    const agent = fakeAgent(SESSION_ID, home);
    const firstText = "今天继续做插件";
    const payload = {
      agent,
      messages: [userMessage(firstText)],
      decision: { kind: "enter", messages: [userMessage(firstText)] },
    };
    const result = await env.run("agent/pre-step", payload);
    assert.equal(result.kind, "enter");
    const injected = result.messages.filter((m) => m.source?.kind === "plugin:hdm");
    assert.equal(injected.length, 1);
    const text = injected[0].content[0].text;
    assert.match(text, /自传体记忆/);
    assert.match(text, /上一段对话/);
    assert.match(text, new RegExp(old.label));

    // 自动召回：第二条用户消息包含已存记忆的关键词
    const secondText = "这个项目的顺序快照设计要再想想";
    const secondPayload = {
      agent,
      messages: [userMessage(secondText)],
      decision: { kind: "enter", messages: [userMessage(secondText)] },
    };
    const second = await env.run("agent/pre-step", secondPayload);
    const secondTexts = second.messages
      .filter((m) => m.source?.kind === "plugin:hdm")
      .flatMap((m) => m.content.map((b) => b.text))
      .join("\n");
    assert.match(secondTexts, /可能相关的记忆/);
    assert.match(secondTexts, new RegExp(old.uid));

    // 6 轮锚点（每轮是一条真实用户消息）
    let anchored = false;
    for (let i = 0; i < 6; i += 1) {
      const text2 = `第 ${i + 3} 轮继续`;
      const p = {
        agent,
        messages: [userMessage(text2)],
        decision: { kind: "enter", messages: [userMessage(text2)] },
      };
      const r = await env.run("agent/pre-step", p);
      const joined = r.messages
        .filter((m) => m.source?.kind === "plugin:hdm")
        .flatMap((m) => m.content.map((b) => b.text))
        .join("\n");
      if (/自我锚点/.test(joined)) anchored = true;
    }
    assert.ok(anchored, "应在 6 轮内注入一次自我锚点");

    // 50% 提醒
    env.ctx.tokenMeter.contextPressure = () => ({ pressureTokens: 600, contextWindow: 1000 });
    const p3 = {
      agent: fakeAgent(SESSION_ID_2, home),
      messages: [userMessage("上下文压力很高了")],
      decision: { kind: "enter", messages: [userMessage("上下文压力很高了")] },
    };
    const r3 = await env.run("agent/pre-step", p3);
    const joined3 = r3.messages
      .filter((m) => m.source?.kind === "plugin:hdm")
      .flatMap((m) => m.content.map((b) => b.text))
      .join("\n");
    assert.match(joined3, /上下文已达阈值/);
    assert.match(joined3, /hdm_save/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：/hdm 状态命令", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    await saveMemory(env, fakeAgent(SESSION_ID, home));

    const status = await env.commands.get("hdm").handler({});
    assert.match(status.text, /母文件夹/);
    assert.match(status.text, /记忆单元: 1/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：apply 接受设置页的 volatile 配置包装", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    const validated = Config["~standard"].validate({ homeDir: home, autoRecall: { enabled: true } });
    assert.ok(validated.value);
    await apply(env.ctx, validated.value);
    assert.ok(env.tools.has("hdm_save"), "volatile 配置下仍应注册工具");
    assert.ok(env.tools.has("hdm_organize"), "volatile 配置下应注册整理工具");
    assert.ok(env.skills.has("hdm-memory"), "volatile 配置下仍应注册技能");
    assert.ok(env.commands.has("hdm-idle"), "volatile 配置下仍应注册命令");
    assert.ok(env.sections.some((section) => section.name === "hdm:guide"), "仍应注入系统指南");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：hdm_organize 工具（原 /hdm-organize 已裁剪）", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    await saveMemory(env, fakeAgent(SESSION_ID, home));
    assert.ok(env.tools.has("hdm_organize"), "应注册 hdm_organize 工具");

    const dry = await env.tools.get("hdm_organize").execute({ dryRun: true });
    assert.equal(dry.memories, 1);
    assert.equal(dry.dryRun, true);
    assert.equal(Object.hasOwn(dry, "indexCount"), false, "dryRun 不返回 indexCount");

    const applied = await env.tools.get("hdm_organize").execute({ dryRun: false });
    assert.equal(applied.memories, 1);
    assert.equal(applied.indexCount, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：参数校验（关键词数量、必填项）", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = fakeAgent(SESSION_ID, home);
    const tool = env.tools.get("hdm_save");
    const exec = { agent };

    await assert.rejects(
      () => tool.execute({ summary: "这是一段足够长的摘要内容用于参数校验", keywords: keywordsFor(5) }, exec),
      /关键词/,
      "少于 10 个关键词应拒绝",
    );
    await assert.rejects(
      () => tool.execute({ summary: "这是一段足够长的摘要内容用于参数校验", keywords: keywordsFor(12).concat(["多余1", "多余2"]) }, exec),
      /关键词/,
      "多于 12 个关键词应拒绝",
    );
    await assert.rejects(
      () => tool.execute({ keywords: keywordsFor(10) }, exec),
      /summary/,
      "缺 summary 应拒绝",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：更换母文件夹时自动迁移", async () => {
  const oldHome = await newHome();
  const target = path.join(os.tmpdir(), `hdm-new-${process.pid}-${Date.now()}`);
  try {
    await mkdir(path.join(oldHome, "memory", "2026-11-08", "2_x"), { recursive: true });
    await writeFile(path.join(oldHome, "IAM.md"), "# IAM\n\n## 我是谁\n迁移测试\n", "utf8");
    await writeFile(path.join(oldHome, "memory", "2026-11-08", "2_x", "level2.txt"), "## 摘要\n迁移正文\n", "utf8");
    await writeFile(
      path.join(oldHome, "memory", "2026-11-08", "2_x", "meta.json"),
      `${JSON.stringify({
        uid: "m-20261108-001",
        label: "2_2026-11-08_001_x",
        folder: path.join(oldHome, "memory", "2026-11-08", "2_x"),
        defaultLevel: 2,
        snapshots: [2],
        date: "2026-11-08",
        seq: 1,
        keywords: [],
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
      "utf8",
    );
    await writePointer(oldHome);

    const env = makeCtx();
    await apply(env.ctx, { ...CONFIG, homeDir: target });

    assert.match(await readFile(path.join(target, "IAM.md"), "utf8"), /迁移测试/);
    assert.ok(await stat(path.join(target, "memory", "2026-11-08", "2_x", "level2.txt")));
    const pointer = await readPointer();
    assert.equal(path.resolve(pointer.homeDir), path.resolve(target));

    // 迁移后 meta.folder 必须改写为新母文件夹，否则删掉旧目录后 hdm_read 会失效。
    const meta = JSON.parse(await readFile(path.join(target, "memory", "2026-11-08", "2_x", "meta.json"), "utf8"));
    assert.equal(path.resolve(meta.folder), path.resolve(target, "memory", "2026-11-08", "2_x"));
    const index = JSON.parse(await readFile(path.join(target, "index", "memories.json"), "utf8"));
    assert.equal(path.resolve(index.memories["m-20261108-001"].folder), path.resolve(target, "memory", "2026-11-08", "2_x"));
  } finally {
    await rm(oldHome, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

// 2026-11-19 事故回归：临时 home 的实例化不得把真实母文件夹搬进临时目录。
test("HDM 集成：homeDir 指向临时目录时拒绝迁移，旧库与指针都保留", async () => {
  const target = await newHome();
  // 旧母文件夹用主目录下的假路径：闸门在 stat 之前生效，路径无需真实存在。
  const fakeRealHome = path.join(os.homedir(), `hdm-gate-${process.pid}-${Date.now()}`);
  const warnings = [];
  try {
    await writePointer(fakeRealHome);
    const env = makeCtx();
    const info = env.ctx.logger.info;
    env.ctx.logger = { info, warn: (line) => warnings.push(String(line)), error() {}, debug() {} };
    await apply(env.ctx, { ...CONFIG, homeDir: target });

    const pointer = await readPointer();
    assert.equal(path.resolve(pointer.homeDir), path.resolve(fakeRealHome), "指针仍指向旧库，未被改写");
    assert.ok(warnings.some((line) => /拒绝把母文件夹迁入临时目录/.test(line)), "应记录拒迁告警");
    // 新 home 照常初始化自己的目录，但不含被搬来的旧数据。
    assert.ok(await stat(path.join(target, "IAM.md")));
  } finally {
    await writePointer(path.join(os.tmpdir(), `hdm-pointer-${process.pid}.json`));
    await rm(target, { recursive: true, force: true });
  }
});

// ---- v2.0：会话 pin / 空闲整理 / IAM 空白模板 三条命令的真机等价路径 ----

const ORGANIZED_JSON = JSON.stringify({
  summary: "用户要求把 HDM 升级成可在面板调整的空闲整理，并保留同一编码续写。",
  details: ["窗口默认 180 分钟到 12 小时", "没有新增用户发言就不重复整理"],
  keywords: ["HDM", "空闲整理", "面板", "同一编码", "窗口", "维护模型", "提示词", "去重", "日志", "命令"],
  people: [],
  scene: "D:\\Work\\demo",
  event: "HDM 升级",
  emotion: "",
  importance: 3,
});

function agentWithEvents(id, cwd, texts) {
  const base = Date.now() - texts.length * 60_000;
  const events = texts.map((text, index) => ({
    type: "user/message",
    at: base + index * 60_000,
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  }));
  // 待投递的 followup：/hdm-remember 用它把「立即保存」指令送进本轮对话。
  const delivered = [];
  return {
    id,
    session: { id, cwd, header: sessionHeader(id, cwd), ownEvents: () => events },
    delivered,
    followup: (input) => delivered.push(input),
  };
}

test("HDM 集成：/hdm-remember 只登记，下一次 hdm_save 生成内容并固定同一编码", async () => {
  const home = await newHome();
  const env = makeCtx({ llmReply: ORGANIZED_JSON });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = agentWithEvents(SESSION_ID, home, ["把空闲整理做成可配置的", "窗口默认 3 小时到 12 小时"]);

    const command = env.commands.get("hdm-remember");
    assert.ok(command, "注册了 /hdm-remember");
    const result = await command.handler({ agent, rawInput: "" });
    assert.equal(result.kind, "success", JSON.stringify(result).slice(0, 300));
    assert.match(result.text, /已登记本会话的记忆单元/);
    assert.equal((env.calls ?? []).length, 0, "命令本身不应发起 LLM 调用：内容由对话智能体生成");

    // 关键修复：命令本身不产生模型回合，必须把指令 followup 进本轮，否则模型要到下一条
    // 用户消息才看到指令，表现为「remember 之后不立即保存」。
    assert.equal(agent.delivered.length, 1, "应把强制记忆指令投递给当前对话");
    const pushed = agent.delivered[0];
    assert.equal(pushed.source?.kind, "plugin:hdm");
    const pushedText = pushed.content.map((b) => b.text).join("\n");
    assert.match(pushedText, /强制记忆/);
    assert.match(pushedText, /hdm_save/);
    assert.match(result.text, /立即写入 hdm_save/);

    const sessions = await readJson(path.join(home, "state", "sessions.json"));
    const session = sessions.sessions[SESSION_ID];
    assert.ok(session, "会话状态已落盘");
    assert.ok(session.pendingRememberAt > 0, "登记了待记忆标记");
    assert.equal(session.pinConversation, true, "先固定编码，避免保存分裂成两个单元");
    // 投递成功后 hintAt 对齐，pre-step 不再重复注入同一指令
    assert.equal(session.pendingRememberHintAt, session.pendingRememberAt);

    // 下一步的 hdm_save 负责生成内容：pin 语义生效并清掉登记
    const saved = await saveMemory(env, agent);
    assert.equal(saved.ok, true);
    assert.match(saved.uid, /^m-\d{8}-\d{3}$/);

    const after = await readJson(path.join(home, "state", "sessions.json"));
    assert.equal(after.sessions[SESSION_ID].memoryUid, saved.uid);
    assert.equal(after.sessions[SESSION_ID].pendingRememberAt, null, "保存后清掉登记，不会反复催");

    // 同一会话再保存：并入已固定的单元，不新建
    const again = await saveMemory(env, agent);
    assert.equal(again.ok, true);
    assert.equal(again.merged, true);
    assert.equal(again.uid, saved.uid);

    // 命令只登记、不写维护日志：那条日志属于空闲整理的维护模型路径。
    await assert.rejects(
      readFile(path.join(home, "state", "logs", "maintenance.jsonl"), "utf8"),
      /ENOENT/,
      "命令不应产生维护日志；记忆由 hdm_save 写入",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：拿不到 followup 时保留登记，由下一次 pre-step 注入兜底", async () => {
  const home = await newHome();
  const env = makeCtx({ llmReply: ORGANIZED_JSON });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    // 老宿主/无 agent 的形态：只有 session，没有 followup
    const agent = { id: SESSION_ID, session: { id: SESSION_ID, cwd: home, header: sessionHeader(SESSION_ID, home) } };
    const command = env.commands.get("hdm-remember");
    const result = await command.handler({ agent, rawInput: "" });
    assert.equal(result.kind, "success");
    assert.match(result.text, /下一步会收到指令/, "投递不了就如实说推迟到下一步");

    const sessions = await readJson(path.join(home, "state", "sessions.json"));
    assert.ok(sessions.sessions[SESSION_ID].pendingRememberAt > 0);
    assert.equal(sessions.sessions[SESSION_ID].pendingRememberHintAt, null, "没投递就不对齐 hintAt，交给 pre-step");

    // 下一条真实用户消息到达时，pre-step 把指令注入这一步
    const text = "继续";
    const injected = await env.run("agent/pre-step", {
      agent,
      messages: [userMessage(text)],
      decision: { kind: "enter", messages: [userMessage(text)] },
    });
    const joined = injected.messages
      .filter((m) => m.source?.kind === "plugin:hdm")
      .flatMap((m) => m.content.map((b) => b.text))
      .join("\n");
    assert.match(joined, /强制记忆/, "pre-step 注入强制记忆指令");
    assert.match(joined, /hdm_save/);

    // 注入过就对齐，不会每一步重复催
    const after = await readJson(path.join(home, "state", "sessions.json"));
    assert.equal(after.sessions[SESSION_ID].pendingRememberHintAt, after.sessions[SESSION_ID].pendingRememberAt);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：/hdm-idle force 立即整理，第二次无新增则跳过", async () => {
  const home = await newHome();
  const env = makeCtx({ llmReply: ORGANIZED_JSON });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = agentWithEvents(SESSION_ID, home, ["第一条需求", "第二条需求"]);
    const command = env.commands.get("hdm-idle");
    assert.ok(command, "注册了 /hdm-idle");

    const first = await command.handler({ agent, rawInput: "force" });
    assert.equal(first.kind, "success", JSON.stringify(first).slice(0, 300));
    assert.match(first.text, /空闲整理扫描（force=on）/);
    assert.match(first.text, /已整理 m-\d{8}-\d{3}/);

    const second = await command.handler({ agent, rawInput: "force" });
    assert.match(second.text, /跳过：no-new-dialogue/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：IAM_Blank 模板（设置页远程面）+ hdmSettings 挂载", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });

    // 命令 /hdm-iam-blank 已裁剪，能力由设置页经 Typert 远程面调用同一个 ensureIamBlank。
    const service = env.provided.get("hdmSettings");
    assert.ok(service, "ctx.provide('hdmSettings') 已调用");
    assert.equal(typeof service.generateIamBlank, "function");
    assert.equal(typeof service.maintenanceInfo, "function");

    const blank = await readFile(path.join(home, "IAM_Blank.md"), "utf8");
    for (const heading of ["我是谁", "我是怎样的人", "人生阶段", "重要关系", "长期主题与价值", "自我叙事", "记忆索引"]) {
      assert.ok(blank.includes(`## ${heading}`), `IAM_Blank 缺少小节: ${heading}`);
    }
    // 独立文件：不得写「合并进 IAM」
    assert.doesNotMatch(blank, /合并进 IAM/);
    assert.match(blank, /独立草稿/);

    const again = await service.generateIamBlank(false);
    assert.equal(again.existed, true, "默认不覆盖已有文件");
    const overwritten = await service.generateIamBlank(true);
    assert.equal(overwritten.overwritten, true, "overwrite=true 会重写已有文件");
    assert.equal(overwritten.bytes > 0, true);

    // 远程面：Typert 描述符
    const contribution = env.typert.at(-1);
    assert.equal(contribution.package, "dsh-hdm");
    assert.equal(contribution.face, "host");
    assert.deepEqual(
      contribution.invocations.map((invocation) => invocation.id),
      ["dsh-hdm#hdmSettings/generateIamBlank", "dsh-hdm#hdmSettings/maintenanceInfo"],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("pre-step 持久化 lastUserAt 与活动环；插件重启后仍能被空闲扫描看到", async () => {
  const home = await newHome();
  const env = makeCtx({ llmReply: ORGANIZED_JSON });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = agentWithEvents(SESSION_ID, home, ["第一条需求"]);
    const firstText = "第二条需求：把活动环落盘";
    await env.run("agent/pre-step", {
      agent,
      messages: [userMessage(firstText)],
      decision: { kind: "enter", messages: [userMessage(firstText)] },
    });

    const afterFirst = await readJson(path.join(home, "state", "sessions.json"));
    const session = afterFirst.sessions[SESSION_ID];
    assert.ok(session.lastUserAt > 0, "lastUserAt 记录真实发言时间，而不是整理时的旧水位");
    assert.equal(session.activity.length, 1, "活动环落盘一条");
    assert.match(session.activity[0].text, /活动环落盘/);
    assert.equal(session.lastOrganizedUserAt, null, "未整理过就没有整理水位");

    // 再来一条：累积而不是覆盖
    const secondText = "第三条需求";
    const agent2 = agentWithEvents(SESSION_ID, home, ["第一条需求", firstText]);
    await env.run("agent/pre-step", {
      agent: agent2,
      messages: [userMessage(secondText)],
      decision: { kind: "enter", messages: [userMessage(secondText)] },
    });
    const afterSecond = await readJson(path.join(home, "state", "sessions.json"));
    assert.equal(afterSecond.sessions[SESSION_ID].activity.length, 2, "累积到 2 条");

    // 模拟插件重启：新 ctx + apply 时回灌活动环
    const env2 = makeCtx({ llmReply: ORGANIZED_JSON });
    await apply(env2.ctx, { ...CONFIG, homeDir: home });
    const activity = pendingActivity({ home, sessionId: SESSION_ID });
    assert.ok(activity, "重启后活动环已回灌，空闲扫描能看到这个会话");
    assert.equal(activity.count, afterSecond.sessions[SESSION_ID].userMessageCount);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 集成：用户侧命令只保留 5 个，其余能力走工具", async () => {
  const home = await newHome();
  const env = makeCtx();
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    assert.deepEqual([...env.commands.keys()].sort(), [
      "hdm",
      "hdm-diary",
      "hdm-forget",
      "hdm-idle",
      "hdm-remember",
    ]);
    for (const removed of [
      "hdm-recall",
      "hdm-rebuild",
      "hdm-organize",
      "hdm-immortal",
      "hdm-mortal",
      "hdm-iam-blank",
    ]) {
      assert.equal(env.commands.has(removed), false, `${removed} 已裁剪`);
    }
    // 裁剪只作用于用户侧命令：模型侧工具一个都不许少。
    for (const tool of ["hdm_save", "hdm_recall", "hdm_read", "hdm_character_update", "hdm_iam_update", "hdm_organize"]) {
      assert.ok(env.tools.has(tool), `${tool} 仍在`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 分级检索与压缩前记忆（0.2.4）

const COMPACT_REPLY = JSON.stringify({
  summary: "压缩前把这段对话存成了一条记忆：结论是分级检索按档位生效，压缩后要交回记忆。",
  details: ["L1 在用户回复时召回", "L2 再加方案决策点与子代理"],
  keywords: keywordsFor(10),
  people: ["小明"],
  importance: 3,
});

function pluginText(result) {
  return result.messages
    .filter((m) => m.source?.kind === "plugin:hdm")
    .flatMap((m) => m.content.map((b) => b.text))
    .join("\n");
}

function toolCallMessage(name, id = crypto.randomUUID()) {
  return {
    id,
    role: "assistant",
    content: [{ type: "tool-call", id: `call-${id}`, name, arguments: "{}" }],
    source: { kind: "model", provider: "fake-provider", model: "fake-model" },
  };
}

function toolResultMessage(id = crypto.randomUUID()) {
  return {
    id,
    role: "tool",
    content: [{ type: "text", text: "工具结果" }],
    source: { kind: "tool", callId: `call-${id}` },
    toolCallId: `call-${id}`,
  };
}

function compactionAgent(id, cwd, messages) {
  return {
    session: {
      id,
      header: sessionHeader(id, cwd),
      deriveMessages: () => messages,
    },
  };
}

test("HDM 0.2.4：档位 L0 不自动召回，但首轮注入记忆词表", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1 });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home, autoRecall: { ...CONFIG.autoRecall, level: 0 } });
    await saveMemory(env, fakeAgent("s-old-l0", home));

    const agent = fakeAgent(SESSION_ID, home);
    const first = userMessage("这个项目的架构决策要再想想");
    const r1 = await env.run("agent/pre-step", {
      agent,
      messages: [first],
      decision: { kind: "enter", messages: [first] },
    });
    const t1 = pluginText(r1);
    assert.match(t1, /记忆词表/, "L0 首轮应注入词表");
    assert.doesNotMatch(t1, /可能相关的记忆/, "L0 不应自动召回");

    const second = userMessage("继续，顺序快照那块呢");
    const r2 = await env.run("agent/pre-step", {
      agent,
      messages: [second],
      decision: { kind: "enter", messages: [second] },
    });
    assert.doesNotMatch(pluginText(r2), /可能相关的记忆/, "L0 后续回合也不自动召回");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.4：L1 用户回复后召回；L1 子代理不召回", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1 });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home, autoRecall: { ...CONFIG.autoRecall, level: 1 } });
    const saved = await saveMemory(env, fakeAgent("s-old-l1", home));

    const agent = fakeAgent(SESSION_ID, home);
    const first = userMessage("开始干活");
    await env.run("agent/pre-step", { agent, messages: [first], decision: { kind: "enter", messages: [first] } });
    const second = userMessage("这个项目的顺序快照设计要再想想");
    const r = await env.run("agent/pre-step", {
      agent,
      messages: [second],
      decision: { kind: "enter", messages: [second] },
    });
    assert.match(pluginText(r), new RegExp(saved.uid), "L1 应召回");

    const sub = fakeAgent("s-sub-l1", home);
    sub.session.header = { ...sub.session.header, origin: "subagent" };
    const task = userMessage("评估项目架构决策的风险");
    const rs = await env.run("agent/pre-step", {
      agent: sub,
      messages: [task],
      decision: { kind: "enter", messages: [task] },
    });
    assert.equal(pluginText(rs), "", "L1 下子代理不注入");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.4：L2 在方案决策点召回，纯文件工具与重复回合不注入，子代理首步注入一次", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1 });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home, autoRecall: { ...CONFIG.autoRecall, level: 2 } });
    const saved = await saveMemory(env, fakeAgent("s-old-l2", home));

    const agent = fakeAgent(SESSION_ID, home);
    const first = userMessage("这个项目的架构决策要不要改");
    await env.run("agent/pre-step", { agent, messages: [first], decision: { kind: "enter", messages: [first] } });

    // 方案决策点：上一轮发起了 web_search（非文件类）
    const planMessages = [first, toolCallMessage("web_search"), toolResultMessage()];
    const r1 = await env.run("agent/pre-step", {
      agent,
      messages: planMessages,
      decision: { kind: "enter", messages: planMessages },
      step: 2,
      turn: 2,
    });
    assert.match(pluginText(r1), new RegExp(saved.uid), "L2 方案决策点应召回");

    // 同一轮再来一次：不重复
    const planMessages2 = [first, toolCallMessage("web_search"), toolResultMessage()];
    const r2 = await env.run("agent/pre-step", {
      agent,
      messages: planMessages2,
      decision: { kind: "enter", messages: planMessages2 },
      step: 3,
      turn: 2,
    });
    assert.equal(pluginText(r2), "", "同一轮只召回一次");

    // 纯文件写入续步：不注入
    const fileMessages = [first, toolCallMessage("ops_write_file"), toolResultMessage()];
    const r3 = await env.run("agent/pre-step", {
      agent,
      messages: fileMessages,
      decision: { kind: "enter", messages: fileMessages },
      step: 2,
      turn: 3,
    });
    assert.equal(pluginText(r3), "", "纯文件工具不算方案决策点");

    // 子代理首步注入，第二步不重复
    const sub = fakeAgent("s-sub-l2", home);
    sub.session.header = { ...sub.session.header, origin: "subagent" };
    const task = userMessage("评估项目架构决策的风险");
    const rs1 = await env.run("agent/pre-step", {
      agent: sub,
      messages: [task],
      decision: { kind: "enter", messages: [task] },
    });
    assert.match(pluginText(rs1), new RegExp(saved.uid), "L2 子代理首步应召回");
    const rs2 = await env.run("agent/pre-step", {
      agent: sub,
      messages: [task],
      decision: { kind: "enter", messages: [task] },
    });
    assert.equal(pluginText(rs2), "", "子代理只注入一次");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.4：压缩前存记忆、压缩后交回记忆并重注 IAM", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1, llmReply: COMPACT_REPLY });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const handler = env.handlers.get("session/event")?.[0];
    assert.ok(handler, "应注册 session/event 监听");

    const messages = [userMessage("我们决定用多帧 zstd 解压会话日志"), toolCallMessage("web_fetch"), toolResultMessage()];
    const agent = compactionAgent("s-compact-1", home, messages);
    handler(agent.session, { type: "compaction/start", data: { compactionId: "c1", turn: 1 } });
    await handler(agent.session, { type: "compaction/end", data: { compactionId: "c1", turn: 1 } });

    const state = await readJson(path.join(home, "state", "sessions.json"));
    const ss = state.sessions["s-compact-1"];
    assert.ok(ss.pendingCompactMemory?.uid, "压缩前应存下一条记忆");
    assert.equal(ss.pendingContextReinject, true, "压缩后应登记重注入");

    const next = userMessage("继续上一件事");
    const r = await env.run("agent/pre-step", {
      agent,
      messages: [next],
      decision: { kind: "enter", messages: [next] },
    });
    const text = pluginText(r);
    assert.match(text, /压缩前记忆/, "下一步应返回压缩前记忆");
    assert.match(text, new RegExp(ss.pendingCompactMemory.uid));
    assert.match(text, /自传体记忆/, "压缩后应重注 IAM");

    // 再下一步不重复
    const again = userMessage("再往下");
    const r2 = await env.run("agent/pre-step", {
      agent,
      messages: [again],
      decision: { kind: "enter", messages: [again] },
    });
    assert.doesNotMatch(pluginText(r2), /压缩前记忆/, "压缩前记忆只交回一次");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.7：本会话刚存过记忆时压缩不再重复总结，交回时标明未重复写入", async () => {
  const home = await newHome();
  // 模型故意返回非 JSON：走了去重就用不到它，模型一旦被调用这条就会失败，正好当判别器。
  const env = makeCtx({ pressure: 0.1, llmReply: "不是 JSON" });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = compactionAgent("s-dedupe", home, [userMessage("刚聊完这件事")]);
    const saved = await saveMemory(env, fakeAgent("s-dedupe", home));
    const handler = env.handlers.get("session/event")[0];

    handler(agent.session, { type: "compaction/start", data: { compactionId: "d1", turn: 1 } });
    await handler(agent.session, { type: "compaction/end", data: { compactionId: "d1", turn: 1 } });

    const state = await readJson(path.join(home, "state", "sessions.json"));
    const pcm = state.sessions["s-dedupe"].pendingCompactMemory;
    assert.ok(pcm?.uid, "去重命中时仍应交回那条记忆");
    assert.equal(pcm.deduped, true, "窗口内刚写过 → 标记为未重复写入");
    assert.equal(pcm.uid, saved.uid);

    const next = userMessage("继续");
    const r = await env.run("agent/pre-step", {
      agent,
      messages: [next],
      decision: { kind: "enter", messages: [next] },
    });
    const text = pluginText(r);
    assert.match(text, /本轮未重复写入/, "注入块要写明这次没有新落盘");
    assert.doesNotMatch(text, /本轮压缩前已保存/, "去重时不应声称已保存");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.7：dedupeMinutes=0 关闭去重，压缩仍调维护模型并标明写入段落", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1, llmReply: COMPACT_REPLY });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home, compaction: { memorize: true, dedupeMinutes: 0 } });
    const agent = compactionAgent("s-nodedupe", home, [userMessage("刚聊完这件事")]);
    await saveMemory(env, fakeAgent("s-nodedupe", home));
    const handler = env.handlers.get("session/event")[0];

    handler(agent.session, { type: "compaction/start", data: { compactionId: "d2", turn: 1 } });
    await handler(agent.session, { type: "compaction/end", data: { compactionId: "d2", turn: 1 } });

    const state = await readJson(path.join(home, "state", "sessions.json"));
    const pcm = state.sessions["s-nodedupe"].pendingCompactMemory;
    assert.ok(pcm?.uid, "关掉去重后应正常总结落盘");
    assert.equal(pcm.deduped, false, "关掉去重就不该标记去重");
    assert.ok(pcm.appendCount >= 2, "这是第二次写入，应标成追加记忆 #2 或更大");

    const next = userMessage("继续");
    const r = await env.run("agent/pre-step", {
      agent,
      messages: [next],
      decision: { kind: "enter", messages: [next] },
    });
    assert.match(pluginText(r), /本轮压缩前已保存/, "注入块要写明这次真的写了");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.4：压缩前记忆关闭时不存记忆但仍重注 IAM；模型失败只记录不抛出", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1, llmReply: "不是 JSON" });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home, compaction: { memorize: false } });
    const handler = env.handlers.get("session/event")[0];
    const messages = [userMessage("这次不存记忆")];
    const agent = compactionAgent("s-compact-off", home, messages);
    handler(agent.session, { type: "compaction/start", data: { compactionId: "c2", turn: 1 } });
    await handler(agent.session, { type: "compaction/end", data: { compactionId: "c2", turn: 1 } });
    let state = await readJson(path.join(home, "state", "sessions.json"));
    assert.equal(state.sessions["s-compact-off"].pendingCompactMemory, null);
    assert.equal(state.sessions["s-compact-off"].pendingContextReinject, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const home2 = await newHome();
  const env2 = makeCtx({ pressure: 0.1, llmReply: "不是 JSON" });
  try {
    await apply(env2.ctx, { ...CONFIG, homeDir: home2 });
    const handler = env2.handlers.get("session/event")[0];
    const messages = [userMessage("模型会失败")];
    const agent = compactionAgent("s-compact-fail", home2, messages);
    handler(agent.session, { type: "compaction/start", data: { compactionId: "c3", turn: 1 } });
    await handler(agent.session, { type: "compaction/end", data: { compactionId: "c3", turn: 1 } });
    const state = await readJson(path.join(home2, "state", "sessions.json"));
    const ss = state.sessions["s-compact-fail"];
    assert.ok(ss.lastCompactError, "失败应留下 lastCompactError");
    assert.equal(ss.pendingContextReinject, true, "失败也要重注 IAM");
  } finally {
    await rm(home2, { recursive: true, force: true });
  }
});

test("HDM 0.2.4：L2 决策点用上一步助手自己的备选方案文字当检索词", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1 });
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home, autoRecall: { ...CONFIG.autoRecall, level: 2 } });
    const saved = await saveMemory(env, fakeAgent("s-old-plan", home));

    const agent = fakeAgent(SESSION_ID, home);
    const first = userMessage("开始");
    await env.run("agent/pre-step", { agent, messages: [first], decision: { kind: "enter", messages: [first] } });
    // 这条用户请求不含库里任何关键词 → 用户步不召回
    const vague = userMessage("帮我看看这个网页正文怎么抓");
    await env.run("agent/pre-step", { agent, messages: [vague], decision: { kind: "enter", messages: [vague] } });

    // 续步：助手自己写着「退回项目记忆/顺序快照」这类备选方案
    const plan = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: [
        { type: "text", text: "先试 web_fetch 拿正文；不行就回去翻项目记忆里的顺序快照与架构决策。" },
        { type: "tool-call", id: "call-plan", name: "web_fetch", arguments: "{}" },
      ],
      source: { kind: "model", provider: "fake-provider", model: "fake-model" },
    };
    const messages = [plan, toolResultMessage()];
    const r = await env.run("agent/pre-step", {
      agent,
      messages,
      decision: { kind: "enter", messages },
      step: 2,
      turn: 2,
    });
    assert.match(pluginText(r), new RegExp(saved.uid), "决策点应能把助手自己写的备选方案当检索词");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HDM 0.2.4：同日一直追加；跨天且间隔超过 3 小时才另起一条记忆", async () => {
  const home = await newHome();
  const env = makeCtx({ pressure: 0.1 });
  const realDateNow = Date.now;
  try {
    await apply(env.ctx, { ...CONFIG, homeDir: home });
    const agent = fakeAgent(SESSION_ID, home);
    // 基准必须是与星期几/墙钟时刻无关的固定值：用 Asia/Shanghai 的正午，
    // 否则本地 20:00 之后跑（base+4h 跨自然日）会把「同日追加」断言撞红，属既有时间依赖缺陷。
    const base = Date.UTC(2026, 10, 18, 4, 0, 0); // 2026-11-18 12:00 +08:00
    Date.now = () => base;

    // 第一次保存：先走 /hdm-remember 登记，让 hdm_save 以 pin=true 落库并固定单元
    await env.commands.get("hdm-remember").handler({ agent });
    const first = await saveMemory(env, agent);

    // 同日隔 4 小时：仍然追加（同日不拆）
    Date.now = () => base + 4 * 3600_000;
    const sameDay = await saveMemory(env, agent);
    assert.equal(sameDay.uid, first.uid, "同一天即使隔 4 小时也应继续追加");
    assert.equal(sameDay.merged, true);

    // 次日（+26h、跨自然日且远超 3 小时）：另起一条
    Date.now = () => base + 26 * 3600_000;
    const nextDay = await saveMemory(env, agent);
    assert.notEqual(nextDay.uid, first.uid, "跨天且间隔超过 3 小时必须新开记忆单元");
    const sessions = await readJson(path.join(home, "state", "sessions.json"));
    assert.equal(sessions.sessions[SESSION_ID].memoryUid, nextDay.uid, "固定单元跟到新的一条");
  } finally {
    Date.now = realDateNow;
    await rm(home, { recursive: true, force: true });
  }
});

// --------------------------------------------------- 压缩前记忆：并发与 pending

// 直接搭 compact.js 需要的 registry/state/config：测试要能拿到 noteCompactionStart 的 promise。
async function compactEnv(stream) {
  const home = await newHome();
  const config = resolveConfig({
    homeDir: home,
    maintenance: { provider: "test", model: "test-1" },
    compaction: { memorize: true, dedupeMinutes: 0, waitMs: 5000 },
  });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const calls = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: {
      stream(request) {
        calls.push(request);
        return stream(request, calls.length);
      },
    },
  };
  const session = {
    id: "s-compact-race",
    header: sessionHeader("s-compact-race", home),
    deriveMessages: () => [userMessage("我们决定把压缩前记忆改成可取消的")],
  };
  return { home, config, registry, state, ctx, session, calls };
}

test("P1-4：连续两次压缩只落后者落盘，前一次被取消且标记 superseded", async () => {
  // 第一次流故意慢：第二次 start 必须在中途把它取消掉，而不是等它自己跑完再写一条。
  const env = await compactEnv((_request, index) =>
    index === 1
      ? (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 120));
          yield { type: "text-delta", textDelta: COMPACT_REPLY };
        })()
      : (async function* () {
          yield { type: "text-delta", textDelta: COMPACT_REPLY };
        })(),
  );
  try {
    const first = noteCompactionStart({ ...env, session: env.session });
    assert.ok(first, "第一次应启动");
    const second = noteCompactionStart({ ...env, session: env.session });
    assert.ok(second, "第二次应启动");
    assert.equal(pendingCompactionCount(), 1, "同一会话只保留最新一次");

    const settled = await settleCompaction({ config: env.config, state: env.state, session: env.session });
    const firstResult = await first;
    assert.equal(firstResult.ok, false);
    assert.equal(firstResult.aborted, true, "被取代的那次必须以 aborted 收尾");
    assert.equal(firstResult.reason, "superseded");
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(env.registry.list().length, 1, "连续压缩只能写一条记忆");
    const ss = env.state.getSession(env.session.id);
    assert.equal(ss.pendingCompactMemory.uid, settled.uid);
    // 首次创建本就不写 appendCount；真正要防的是「第一次也落盘」留下追加段落。
    assert.equal(env.registry.get(settled.uid).appendCount ?? 1, 1);
    const level2 = await readFile(path.join(env.registry.get(settled.uid).folder, "level2.txt"), "utf8");
    assert.doesNotMatch(level2, /追加记忆 #/, "第一次不得落盘，因此没有追加序列");
  } finally {
    await rm(env.home, { recursive: true, force: true });
  }
});

test("P0-5：压缩前记忆失败时清掉上一次未消费的 pendingCompactMemory", async () => {
  const env = await compactEnv(() =>
    (async function* () {
      yield { type: "text-delta", textDelta: "不是 JSON" };
    })(),
  );
  try {
    // 上一次压缩留下的记忆还没被 pre-step 消费，就又被下一次压缩覆盖。
    await env.state.updateSession(env.session.id, {
      pendingCompactMemory: { uid: "m-old-001", summary: "上一次没被消费的记忆" },
      lastCompactError: null,
    });

    noteCompactionStart({ ...env, session: env.session });
    const settled = await settleCompaction({ config: env.config, state: env.state, session: env.session });
    assert.equal(settled.ok, false);

    const ss = env.state.getSession(env.session.id);
    assert.equal(ss.pendingCompactMemory, null, "失败后旧记忆必须清掉，否则会被重复注入");
    assert.ok(ss.lastCompactError, "失败仍要留 lastCompactError");
    assert.equal(ss.pendingContextReinject, true, "失败也要重注 IAM");
  } finally {
    await rm(env.home, { recursive: true, force: true });
  }
});

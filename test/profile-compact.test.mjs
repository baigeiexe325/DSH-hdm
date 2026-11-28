// IAM 与人物档案的定期压缩：间隔判定、lint 闸门、写盘前备份、模型不可用降级、定时器不立即跑。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CHARACTER_SECTIONS, characterPath } from "../lib/characters.js";
import {
  compactOneProfile,
  runProfileCompactPass,
  shouldCompactProfiles,
  startProfileCompactTimer,
} from "../lib/profile-compact.js";
import { StateStore } from "../lib/state.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 28, 8, 0, 0);

const IAM_LONG = `# IAM（自传体记忆）

> 我是谁、从哪来、要去哪。由 hdm_iam_update 维护；固定标题不得删除。

## 我是谁
①我是 HDM 长期记忆插件的助手，负责把用户的事实记准。
②我在 DeepSeek Harness 里工作，能力都来自宿主。
③我说话克制，先给结论再给依据。

## 我是怎样的人
①回答先给结论，再补一句为什么。
②不确定就说不确定，不编造事实。
③写代码只改必要的地方，不留无用抽象。

## 人生阶段
①2025 年 开始维护 HDM 的记忆格式与提示词。
②2026 年 加入 IAM 与人物档案的定期压缩。

## 重要关系
①用户是长期协作对象，负责产品判断与验收。

## 长期主题与价值
①把事实记准。
②把结构做薄。
③把回滚做稳。

## 自我叙事
①习惯用分点写事实，一句一条。
②遇到问题先复现再改。

## 记忆索引
（暂无）
`;

const IAM_SHORT = `# IAM（自传体记忆）

> 我是谁、从哪来、要去哪。由 hdm_iam_update 维护；固定标题不得删除。

## 我是谁
①HDM 长期记忆插件助手，负责把用户的事实记准。
②在 DeepSeek Harness 里工作。

## 我是怎样的人
①回答先给结论，再补依据。
②不确定就说不确定。
③只改必要的地方。

## 人生阶段
①2025 年 开始维护 HDM 记忆格式与提示词。
②2026 年 加入档案定期压缩。

## 重要关系
①用户是长期协作对象。

## 长期主题与价值
①把事实记准。

## 自我叙事
①用分点写事实，一句一条。

## 记忆索引
（暂无）
`;

const USER_LONG = `# USER 档案

> 用户本人档案，优先级 0；只追加、不覆盖；冲突写入「待确认 / 矛盾」。

## 基本
- [2026-11-20] 用户在 Windows 上使用 HDM，母文件夹放在 H 盘。（证据: m-20261120-001；置信度: 0.9）
- [2026-11-21] 用户负责产品判断与验收，会逐条核对助手给出的结论。（证据: m-20261121-003；置信度: 0.8）

## 偏好与语气
- [2026-11-20] 用户偏好结论先行，不喜欢铺陈背景。（证据: m-20261120-002；置信度: 0.8）

## 关系与互动
- [2026-11-21] 用户与助手长期协作，习惯直接指出错误。（证据: m-20261121-001；置信度: 0.8）

## 待确认 / 矛盾
（暂无）

## 记忆索引
（暂无）
`;

const USER_SHORT = `# USER 档案

> 用户本人档案，优先级 0；只追加、不覆盖；冲突写入「待确认 / 矛盾」。

## 基本
- [2026-11-20] 用户在 Windows 上使用 HDM。（证据: m-20261120-001；置信度: 0.9）
- [2026-11-21] 用户负责产品判断与验收。（证据: m-20261121-003；置信度: 0.8）

## 偏好与语气
- [2026-11-20] 用户偏好结论先行。（证据: m-20261120-002；置信度: 0.8）

## 关系与互动
- [2026-11-21] 用户与助手长期协作。（证据: m-20261121-001；置信度: 0.8）

## 待确认 / 矛盾
（暂无）

## 记忆索引
（暂无）
`;

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hdm-profile-"));
  const home = path.join(root, "home");
  await mkdir(path.join(home, "characters"), { recursive: true });
  await mkdir(path.join(home, "state"), { recursive: true });
  return { root, home };
}

async function writeIam(home, text = IAM_LONG) {
  await writeFile(path.join(home, "IAM.md"), text, "utf8");
}

async function writeUser(home, text = USER_LONG) {
  await writeFile(characterPath(home, "USER"), text, "utf8");
}

async function cleanup(root) {
  // Windows 上立刻删可能拿到 EBUSY/ENOTEMPTY，重试比加长 sleep 稳。
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

function fakeCtx() {
  return { logger: { warn() {}, info() {}, error() {} } };
}

function fakeState(jobs = {}) {
  const store = { ...jobs };
  return {
    getJobs: () => store,
    async updateJobs(patch) {
      Object.assign(store, patch);
      return store;
    },
  };
}

function failingSnapshotCalls() {
  const calls = [];
  const snapshot = async (options) => {
    calls.push(options);
    return { ok: true, skipped: true };
  };
  return { calls, snapshot };
}

test("shouldCompactProfiles：开关关闭 / 未到间隔 / 到点", () => {
  const home = path.join(os.tmpdir(), "hdm-profile-should-compact");

  const disabled = shouldCompactProfiles({
    home,
    state: fakeState({}),
    config: { profileCompact: { enabled: false } },
    now: NOW,
  });
  assert.equal(disabled.due, false);
  assert.equal(disabled.reason, "disabled");

  const recent = NOW - 5 * HOUR;
  const early = shouldCompactProfiles({
    home,
    state: fakeState({ lastProfileCompactAt: recent }),
    config: {},
    now: NOW,
  });
  assert.equal(early.due, false);
  assert.equal(early.reason, "interval");
  assert.equal(early.intervalMinutes, 360);
  assert.ok(early.nextAt > NOW);

  const due = shouldCompactProfiles({
    home,
    state: fakeState({ lastProfileCompactAt: NOW - 6 * HOUR }),
    config: {},
    now: NOW,
  });
  assert.equal(due.due, true);
  assert.equal(due.reason, "due");

  // minIntervalMinutes 是间隔下限：hours 配小也压不到 120 分钟以下。
  const floored = shouldCompactProfiles({
    home,
    state: fakeState({ lastProfileCompactAt: NOW - 90 * 60_000 }),
    config: { profileCompact: { hours: 1, minIntervalMinutes: 120 } },
    now: NOW,
  });
  assert.equal(floored.due, false);
  assert.equal(floored.intervalMinutes, 120);
});

test("compactOneProfile：模型返回压缩文本 → 备份被调用、文件被替换", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeIam(home);
    const { calls, snapshot } = failingSnapshotCalls();
    const result = await compactOneProfile({
      ctx: fakeCtx(),
      home,
      config: {},
      target: { kind: "iam" },
      now: NOW,
      generate: async () => IAM_SHORT,
      snapshot,
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, "iam");
    assert.ok(result.charsAfter < result.charsBefore);
    // 写盘统一补一个换行，压缩文本本身末尾已有换行，故等于常量。
    assert.equal(await readFile(path.join(home, "IAM.md"), "utf8"), IAM_SHORT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].home, home);
    assert.equal(calls[0].reason, "profile-compact");
  } finally {
    await cleanup(root);
  }
});

test("compactOneProfile：真实 snapshotIfChanged 在写盘前产生一个备份版本", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeIam(home);
    const backupDir = path.join(root, "backups");
    const result = await compactOneProfile({
      ctx: fakeCtx(),
      home,
      config: { backup: { dir: backupDir } },
      target: { kind: "iam" },
      now: NOW,
      generate: async () => IAM_SHORT,
    });

    assert.equal(result.ok, true);
    assert.equal(result.backup?.ok, true);
    const versions = (await readdir(backupDir)).filter((name) => name.startsWith("v-"));
    assert.equal(versions.length, 1);
    const backedUp = await readFile(path.join(backupDir, versions[0], "IAM.md"), "utf8");
    assert.equal(backedUp, IAM_LONG, "备份必须是压缩前的原文");
  } finally {
    await cleanup(root);
  }
});

test("lint 失败：缺节或串味 → ok:false/reason:lint，文件一字未变且不备份", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeIam(home);

    const missingSection = IAM_SHORT.replace(
      "## 人生阶段\n①2025 年 开始维护 HDM 记忆格式与提示词。\n②2026 年 加入档案定期压缩。\n\n",
      "",
    );
    const { calls, snapshot } = failingSnapshotCalls();
    const missing = await compactOneProfile({
      ctx: fakeCtx(),
      home,
      config: {},
      target: { kind: "iam" },
      now: NOW,
      generate: async () => missingSection,
      snapshot,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "lint");
    assert.ok(missing.errors.some((error) => error.includes("人生阶段")));
    assert.equal(await readFile(path.join(home, "IAM.md"), "utf8"), IAM_LONG);

    // 串味：把本机路径写进「我是谁」，lint 必须拦下。
    const smelly = IAM_SHORT.replace(
      "①HDM 长期记忆插件助手，负责把用户的事实记准。",
      "①HDM 长期记忆插件助手，读写 C:\\temp\\x 里的档案。",
    );
    const crossed = await compactOneProfile({
      ctx: fakeCtx(),
      home,
      config: {},
      target: { kind: "iam" },
      now: NOW,
      generate: async () => smelly,
      snapshot,
    });
    assert.equal(crossed.ok, false);
    assert.equal(crossed.reason, "lint");
    assert.ok(crossed.errors.some((error) => error.includes("本机路径")));
    assert.equal(await readFile(path.join(home, "IAM.md"), "utf8"), IAM_LONG);
    assert.equal(calls.length, 0, "校验失败不得备份，更不得写盘");
  } finally {
    await cleanup(root);
  }
});

test("模型不可用：runProfileCompactPass 不抛错，记 failed，不写时间戳", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeIam(home);
    await writeUser(home);
    const state = fakeState({});
    const result = await runProfileCompactPass({
      ctx: fakeCtx(),
      home,
      config: {},
      state,
      now: NOW,
    });

    assert.equal(result.compacted.length, 0);
    assert.ok(result.failed.length >= 1);
    assert.equal(result.failed[0].reason, "model");
    assert.match(result.failed[0].error, /维护模型/);
    assert.equal(await readFile(path.join(home, "IAM.md"), "utf8"), IAM_LONG);
    assert.equal(state.getJobs().lastProfileCompactAt, undefined);
    assert.match(state.getJobs().lastProfileCompactError, /model/);
  } finally {
    await cleanup(root);
  }
});

test("runProfileCompactPass：压 IAM + USER 并写 jobs.lastProfileCompactAt，间隔内再跑会跳过", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeIam(home);
    await writeUser(home);
    const state = new StateStore(home);
    await state.load();
    let calls = 0;
    const generate = async ({ target }) => {
      calls += 1;
      return target.kind === "iam" ? IAM_SHORT : USER_SHORT;
    };
    const snapshot = async () => ({ ok: true, skipped: true });

    const result = await runProfileCompactPass({
      ctx: fakeCtx(),
      home,
      config: {},
      state,
      now: NOW,
      generate,
      snapshot,
    });

    assert.equal(result.failed.length, 0);
    assert.deepEqual(
      result.compacted.map((row) => row.name).sort(),
      ["IAM", "USER"],
    );
    assert.equal(state.getJobs().lastProfileCompactAt, NOW);
    const raw = JSON.parse(await readFile(path.join(home, "state", "jobs.json"), "utf8"));
    assert.equal(raw.jobs.lastProfileCompactAt, NOW);

    // 间隔内（默认 6 小时）再跑：整轮跳过，不再调模型。
    const before = calls;
    const second = await runProfileCompactPass({
      ctx: fakeCtx(),
      home,
      config: {},
      state,
      now: NOW + 60_000,
      generate,
      snapshot,
    });
    assert.equal(second.compacted.length, 0);
    assert.equal(second.skipped[0].reason, "interval");
    assert.equal(calls, before);
  } finally {
    await cleanup(root);
  }
});

test("人物档案压缩后节标题仍在 CHARACTER_SECTIONS 内；新节一律拒绝", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeUser(home);
    const target = { kind: "character", name: "USER" };
    const ok = await compactOneProfile({
      ctx: fakeCtx(),
      home,
      config: {},
      target,
      now: NOW,
      generate: async () => USER_SHORT,
      snapshot: async () => ({ ok: true, skipped: true }),
    });
    assert.equal(ok.ok, true);
    const text = await readFile(characterPath(home, "USER"), "utf8");
    const titles = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
    assert.deepEqual(titles, [...CHARACTER_SECTIONS, "记忆索引"]);
    for (const title of titles) {
      assert.ok(CHARACTER_SECTIONS.includes(title) || title === "记忆索引", `非法节：${title}`);
    }

    // 模型自造「偏好」节：不在固定节内，必须拦下且不改文件。
    const bad = await compactOneProfile({
      ctx: fakeCtx(),
      home,
      config: {},
      target,
      now: NOW,
      generate: async () => "## 偏好\n- [2026-11-20] 用户偏好结论先行。\n",
      snapshot: async () => ({ ok: true, skipped: true }),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "lint");
    assert.ok(bad.errors.some((error) => error.includes("偏好")));
    assert.equal(await readFile(characterPath(home, "USER"), "utf8"), USER_SHORT);
  } finally {
    await cleanup(root);
  }
});

test("startProfileCompactTimer：首轮不立即跑、开关关闭返回空 disposer", async () => {
  const { root, home } = await makeEnv();
  try {
    await writeIam(home);
    let calls = 0;
    const dispose = startProfileCompactTimer({
      ctx: fakeCtx(),
      home,
      config: { profileCompact: { hours: 6 } },
      state: fakeState({}),
      generate: async () => {
        calls += 1;
        return IAM_SHORT;
      },
    });
    assert.equal(typeof dispose, "function");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls, 0, "首轮延迟 5 分钟，启动时不应调用模型");
    dispose();

    const disabled = startProfileCompactTimer({
      home,
      config: { profileCompact: { enabled: false } },
    });
    assert.equal(typeof disabled, "function");
    disabled();
  } finally {
    await cleanup(root);
  }
});

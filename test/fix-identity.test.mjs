// 身份·档案·事件层的并发与兜底修复：事件锁、IAM 拒绝无节 append、USER 别名保护、压缩空节与 CAS。
// 运行：node --test test/fix-identity.test.mjs
// 全部使用 os.tmpdir() 下的临时 home，绝不触碰真实 ~/dsh-HDM。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { characterPath, loadAliases, updateCharacter } from "../lib/characters.js";
import { appendEventLine, eventsIndexFile, loadEventIndex } from "../lib/events.js";
import { ensureIam, extractSections, updateIam } from "../lib/iam.js";
import { compactOneProfile } from "../lib/profile-compact.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-fix-identity-"));
after(() => rm(ROOT, { recursive: true, force: true }));

let seq = 0;
async function makeHome() {
  seq += 1;
  return mkdtemp(path.join(ROOT, `home-${seq}-`));
}

const read = (file) => readFile(file, "utf8");

/** 各节都有正文的最小 IAM：压缩校验要求固定节非空，测试不能用模板占位。 */
const IAM_FULL = `# IAM

## 我是谁
① 我是长期记忆插件助手。

## 我是怎样的人
① 先复现再改。

## 人生阶段
① 2025 年开始维护 HDM。

## 重要关系
① 用户是长期协作对象。

## 长期主题与价值
① 把事实记准。

## 自我叙事
① 习惯分点写事实。

## 记忆索引
（待补充）
`;

/* 1. P0-2 事件档案并发追加：锁必须让 8 条全部落盘（文件正文 + 索引 uid）。 */
test("事件档案并发 append 8 条：文件 8 行、索引 8 个 uid", async () => {
  const home = await makeHome();
  const now = Date.parse("2026-11-28T10:00:00+08:00");
  const jobs = [];
  for (let i = 1; i <= 8; i += 1) {
    jobs.push(
      appendEventLine(home, {
        term: "并发事件",
        date: "2026-11-28",
        line: `并发第 ${i} 条`,
        uid: `m-20261128-10${i}`,
        now,
      }),
    );
  }
  const results = await Promise.all(jobs);
  assert.equal(results.every((row) => row.ok), true);

  const text = await read(path.join(home, "Events", "并发事件.txt"));
  const lines = text.split("\n").filter((line) => /^- 2026-11-28 并发第 \d+ 条$/.test(line));
  assert.equal(lines.length, 8, `正文行数应为 8，实际 ${lines.length}`);
  for (let i = 1; i <= 8; i += 1) assert.ok(lines.some((line) => line.endsWith(`并发第 ${i} 条`)), `缺第 ${i} 条`);

  const uidLines = text.split("\n").filter((line) => /^- m-20261128-10\d$/.test(line));
  assert.equal(uidLines.length, 8, "「相关记忆」段应保留 8 个 uid");

  const entry = (await loadEventIndex(home)).get("并发事件");
  assert.equal(entry.uids.length, 8, `索引 uids 应为 8，实际 ${entry.uids.length}`);
  const saved = JSON.parse(await read(eventsIndexFile(home)));
  assert.equal(saved.entries["并发事件"].uids.length, 8);
});

/* 2. P0-3 IAM append 不带 section：直接拒绝且不写盘；带 section 仍成功。 */
test("updateIam：append 无 section 被拒且文件不变，带 section 仍成功", async () => {
  const home = await makeHome();
  await ensureIam(home);
  const file = path.join(home, "IAM.md");
  const before = await read(file);

  const rejected = await updateIam(home, { content: "① 我长期在 Windows 上工作。", mode: "append" }, 10000);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /section/);
  assert.match(rejected.error, /我是谁/);
  assert.equal(await read(file), before);

  const written = await updateIam(home, { content: "① 我长期在 Windows 上工作。", mode: "append", section: "我是谁" }, 10000);
  assert.equal(written.ok, true);
  const after = await read(file);
  assert.match(extractSections(after)["我是谁"], /① 我长期在 Windows 上工作。/);
  // 写入不得落进「记忆索引」：下一次 syncIamIndex 会整节覆盖它。
  assert.equal(extractSections(after)["记忆索引"], "（待补充）");

  // 超长 append 仍先报超限（保持旧回执文案）。
  const tooLong = await updateIam(home, { content: "很".repeat(500), mode: "append" }, before.length + 10);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /超过上限/);
});

/* 3. P1-1 事件人物别名不能劫持 USER：写「用户」必须落到 USER.md。 */
test("别名不能把 USER 同义键映射给别人：name「用户」仍写 USER.md", async () => {
  const home = await makeHome();
  const first = await updateCharacter(home, { name: "小林", notes: "负责沙箱部分。", aliases: ["用户"] }, 12000);
  assert.equal(first.ok, true);
  assert.deepEqual(first.rejectedAliases, ["用户"]);

  const second = await updateCharacter(home, { name: "用户", notes: "我是用户本人。", evidenceUid: "m-1" }, 12000);
  assert.equal(second.path, path.join(home, "characters", "USER.md"));
  assert.equal(second.priority, 0);
  assert.match(await read(second.path), /我是用户本人。/);
  assert.ok(!(await read(characterPath(home, "小林"))).includes("我是用户本人"), "USER 的事实不得写进小林.md");

  const aliases = await loadAliases(home);
  for (const key of ["我", "用户", "你", "user", "me"]) assert.equal(aliases[key], "USER", `别名 ${key} 应指向 USER`);

  // 磁盘上历史写坏的映射同样被忽略，默认映射优先。
  await writeFile(path.join(home, "characters", "_aliases.json"), JSON.stringify({ 用户: "小林", 老板: "USER" }), "utf8");
  const healed = await loadAliases(home);
  assert.equal(healed["用户"], "USER");
  assert.equal(healed["老板"], "USER");
});

/* 4. P1-2 压缩把 IAM 某节写空：校验必须拦下，不落盘。 */
test("profile-compact：模型把 IAM 某节清空 → 落盘被拒", async () => {
  const home = await makeHome();
  const file = path.join(home, "IAM.md");
  await writeFile(file, IAM_FULL, "utf8");
  const before = await read(file);
  const emptied = IAM_FULL.replace("## 人生阶段\n① 2025 年开始维护 HDM。\n", "## 人生阶段\n（待补充）\n");

  const result = await compactOneProfile({
    ctx: { logger: { warn() {} } },
    home,
    config: {},
    target: { kind: "iam" },
    now: Date.now(),
    generate: async () => emptied,
    snapshot: async () => ({ ok: true, skipped: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lint");
  assert.ok(result.errors.some((error) => error.includes("人生阶段")), JSON.stringify(result.errors));
  assert.equal(await read(file), before, "校验失败不得写盘");
});

/* 5. P1-3 压缩期间写入：CAS 放弃本轮，期间的更新必须保留。 */
test("profile-compact：压缩期间 updateIam → 放弃本轮，更新保留", async () => {
  const home = await makeHome();
  const file = path.join(home, "IAM.md");
  await writeFile(file, IAM_FULL, "utf8");
  const before = await read(file);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const compacting = compactOneProfile({
    ctx: { logger: { warn() {} } },
    home,
    config: {},
    target: { kind: "iam" },
    now: Date.now(),
    snapshot: async () => ({ ok: true, skipped: true }),
    generate: async () => {
      entered();
      await gate;
      // 压缩稿基于「读档时」的内容：各节仍有正文，只是更短。
      return before.replace("① 我是长期记忆插件助手。", "① 长期记忆插件助手。");
    },
  });
  await started;

  const updated = await updateIam(home, { mode: "append", section: "重要关系", content: "② 用户负责验收。" }, 10000);
  assert.equal(updated.ok, true);
  release();

  const result = await compacting;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "changed");

  const after = await read(file);
  assert.match(after, /用户负责验收。/, "压缩期间的更新必须保留");
  assert.match(after, /① 我是长期记忆插件助手。/, "压缩不得用旧快照覆盖");
});

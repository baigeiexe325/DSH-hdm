// 母文件夹迁移与指针：迁移失败不得写指针（旧目录仍是权威），指针本身原子写。
// 运行：node --test test/migrate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { apply } from "../lib/index.js";
import { migrateHome, readPointer, writePointer } from "../lib/migrate.js";

const temps = [];

async function tmp(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** 每个用例独立的指针文件，避免污染真实主目录。 */
async function usePointer() {
  const file = path.join(await tmp("hdm-mig-pointer-"), "pointer.json");
  process.env.HDM_HOME_POINTER = file;
  return file;
}

/** apply() 需要的最小宿主 ctx：只记录日志，不注册真实服务。 */
function makeCtx() {
  const logs = { info: [], warn: [], error: [] };
  const record = (bucket) => (message) => bucket.push(String(message));
  return {
    logs,
    ctx: {
      logger: { info: record(logs.info), warn: record(logs.warn), error: record(logs.error), debug() {} },
      tools: { register: () => () => {} },
      effect(fn) {
        const dispose = fn();
        return typeof dispose === "function" ? dispose : () => {};
      },
      on() {
        return () => {};
      },
      // apply() 会注册兜底心跳：没有 timer 服务时 triggers 退回真实 setInterval，测试进程不退出。
      timer: {
        interval() {
          return () => {};
        },
      },
      get() {
        return undefined;
      },
    },
  };
}

function config({ homeDir, backupDir }) {
  return {
    homeDir,
    diary: { enabled: false },
    forget: { enabled: false },
    idle: { enabled: false },
    backup: { enabled: true, dir: backupDir, keep: 5 },
  };
}

/** 跑一次 apply 并立即释放它注册的 disposers，避免定时器/监听泄漏到下一个用例。 */
async function runApply(ctx, cfg) {
  const dispose = await apply(ctx, cfg);
  if (typeof dispose === "function") dispose();
}

test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

test("writePointer: 原子写、可被 readPointer 解析、不残留临时文件", async () => {
  const file = await usePointer();
  const home = path.join(await tmp("hdm-mig-home-"), "home");

  await writePointer(home);
  const pointer = await readPointer(file);
  assert.equal(path.resolve(pointer.homeDir), path.resolve(home));
  assert.ok(Number.isFinite(Number(pointer.updatedAt)), "应带 updatedAt");

  const leftovers = (await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "原子写不得残留 .tmp");

  // 覆盖写同样原子：内容换新且仍可解析。
  const other = path.join(await tmp("hdm-mig-home-"), "home");
  await writePointer(other, file);
  assert.equal(path.resolve((await readPointer(file)).homeDir), path.resolve(other));
});

test("迁移成功才写指针：指针改为新母文件夹", async () => {
  const file = await usePointer();
  const oldHome = await tmp("hdm-mig-old-");
  await writeFile(path.join(oldHome, "IAM.md"), "# IAM\n\n## 我是谁\n迁移测试\n", "utf8");
  await writePointer(oldHome);

  const target = path.join(await tmp("hdm-mig-target-"), "home");
  const { ctx, logs } = makeCtx();
  await runApply(ctx, config({ homeDir: target, backupDir: await tmp("hdm-mig-bk-") }));

  assert.match(await readFile(path.join(target, "IAM.md"), "utf8"), /迁移测试/);
  assert.equal(path.resolve((await readPointer(file)).homeDir), path.resolve(target));
  assert.ok(logs.info.some((line) => /母文件夹已迁移/.test(line)), "应记录迁移日志");
});

test("迁移抛错时不写指针：旧目录仍是权威，下次启动重试", async () => {
  const file = await usePointer();
  const oldHome = await tmp("hdm-mig-old-");
  await writeFile(path.join(oldHome, "IAM.md"), "# IAM\n\n## 我是谁\n旧目录内容\n", "utf8");
  await writePointer(oldHome);
  const before = JSON.parse(await readFile(file, "utf8"));

  // 让目标父级是普通文件：migrateHome 的 isEmptyDir 会抛 ENOTDIR，迁移必然失败。
  const blocker = path.join(await tmp("hdm-mig-block-"), "not-a-dir");
  await writeFile(blocker, "x", "utf8");
  const target = path.join(blocker, "home");
  await new Promise((resolve) => setTimeout(resolve, 10)); // 让「重写过指针」的 updatedAt 必然不同

  const { ctx, logs } = makeCtx();
  await runApply(ctx, config({ homeDir: target, backupDir: await tmp("hdm-mig-bk-") }));

  const after = JSON.parse(await readFile(file, "utf8"));
  assert.equal(path.resolve(after.homeDir), path.resolve(oldHome), "指针必须仍指向旧目录");
  assert.equal(after.updatedAt, before.updatedAt, "迁移失败不得重写指针");
  assert.ok(
    logs.warn.some((line) => /旧目录.*仍是权威.*下次启动会重试迁移/.test(line)),
    `warn 文案应说明旧目录仍是权威，实际: ${JSON.stringify(logs.warn)}`,
  );
  assert.equal(await readFile(path.join(oldHome, "IAM.md"), "utf8"), "# IAM\n\n## 我是谁\n旧目录内容\n", "旧目录数据必须完好");
});

test("指针已指向当前 home：无需迁移，指针保持有效", async () => {
  const file = await usePointer();
  const home = await tmp("hdm-mig-home-");
  await writeFile(path.join(home, "IAM.md"), "# IAM\n", "utf8");
  await writePointer(home);

  const { ctx, logs } = makeCtx();
  await runApply(ctx, config({ homeDir: home, backupDir: await tmp("hdm-mig-bk-") }));

  assert.equal(path.resolve((await readPointer(file)).homeDir), path.resolve(home));
  assert.ok(!logs.warn.some((line) => /迁移失败/.test(line)), "同目录不应报迁移失败");
  assert.ok(!logs.info.some((line) => /母文件夹已迁移/.test(line)), "同目录不应触发迁移");
});

test("migrateHome 目标父级不可写时抛错，源目录不被删除", async () => {
  const root = await tmp("hdm-mig-raw-");
  const from = path.join(root, "old-home");
  await mkdir(from, { recursive: true });
  await writeFile(path.join(from, "IAM.md"), "old", "utf8");
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "x", "utf8");

  await assert.rejects(() => migrateHome(from, path.join(blocker, "home")));
  assert.equal(await readFile(path.join(from, "IAM.md"), "utf8"), "old", "源目录必须完整");
});

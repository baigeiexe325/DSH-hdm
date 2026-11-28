// 存储层修复回归：并发 uid / 索引缺失自愈 / 多实例 sessions 合并 / 重复 uid 告警。
// 运行：node --test test/fix-storage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../lib/config.js";
import { createMemory } from "../lib/memory.js";
import { Registry } from "../lib/registry.js";
import { StateStore } from "../lib/state.js";

const temps = [];

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-fix-"));
  temps.push(home);
  return home;
}

test.after(async () => {
  for (const home of temps) await rm(home, { recursive: true, force: true });
});

// 上海时间 2026-11-28 18:00
const NOW = Date.UTC(2026, 10, 28, 10, 0, 0);

const input = (i) => ({
  summary: `并发保存测试第 ${i} 条，内容要够长才能通过校验。`,
  keywords: ["并发", "测试", `会话${i}`, "保存", "冲突", "序号", "注册表", "目录", "竞态", "检查", "验证"],
});

test("memory: 两个会话并发 createMemory 不撞 uid，registry 与磁盘各 2 条", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const registry = new Registry(home, config);
  await registry.load();

  const [a, b] = await Promise.all([
    createMemory({ registry, config, home, input: input(1), session: { sessionId: "session-aaaa1111" }, now: NOW }),
    createMemory({ registry, config, home, input: input(2), session: { sessionId: "session-bbbb2222" }, now: NOW + 1 }),
  ]);

  assert.notEqual(a.meta.uid, b.meta.uid, "不同会话并发保存必须拿到不同 uid");
  assert.notEqual(a.meta.folder, b.meta.folder, "文件夹也不能相同");
  assert.equal(registry.list().length, 2, "registry 两条都在（后写不覆盖先写）");
  const day = await readdir(path.join(home, "memory", "2026-11-28"));
  assert.equal(day.length, 2, "磁盘两个记忆文件夹都在");
  for (const result of [a, b]) {
    assert.ok(await stat(path.join(result.meta.folder, "level2.txt")));
    assert.ok(await stat(path.join(result.meta.folder, "meta.json")));
  }

  // registry 未 load（进程刚起 / 索引被删）时，seq 必须从磁盘 meta.json 续上。
  const fresh = new Registry(home, config);
  const c = await createMemory({
    registry: fresh,
    config,
    home,
    input: input(3),
    session: { sessionId: "session-cccc3333" },
    now: NOW + 2,
  });
  assert.equal(c.meta.uid, "m-20261128-003", "空 registry 也要按磁盘已有单元续 seq");
});

test("registry: index 缺失但 memory/ 有 meta.json 时 load 自动重建并可检索", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const label = "2_2026-11-28_aaaa1111_01_事件_检索词";
  const folder = path.join(home, "memory", "2026-11-28", label);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "level2.txt"), "## 摘要\n内容\n", "utf8");
  await writeFile(
    path.join(folder, "meta.json"),
    JSON.stringify({
      uid: "m-20261128-001",
      label,
      folder,
      date: "2026-11-28",
      seq: 1,
      serial: 1,
      defaultLevel: 2,
      snapshots: [2],
      keywords: [{ term: "检索词", keyness: 5, levels: [2] }],
      people: [],
      sessionId: "session-aaaa1111",
      createdAt: 1000,
      updatedAt: 1000,
    }),
    "utf8",
  );

  const registry = new Registry(home, config);
  const loaded = await registry.load();
  assert.equal(loaded.rebuilt, true, "应走 rebuild 而不是静默空库");
  assert.equal(registry.list().length, 1);
  assert.ok(registry.lookup(["检索词"]).has("m-20261128-001"), "重建后 keywords 可查");
  const keywords = JSON.parse(await readFile(path.join(home, "index", "keywords.json"), "utf8"));
  assert.ok(keywords.keywords["检索词"]?.["m-20261128-001"] !== undefined, "倒排已写回磁盘");
});

test("state: 两个 StateStore 实例各写一个会话，磁盘两份都在", async () => {
  const home = await makeHome();
  const a = new StateStore(home);
  const b = new StateStore(home);
  await a.load();
  await b.load();

  await a.updateSession("s-a", { userMessageCount: 1 });
  await b.updateSession("s-b", { userMessageCount: 2 });
  // 先写者再写一次，也不能用旧快照把 s-b 挤掉。
  await a.updateSession("s-a", { userMessageCount: 3 });

  const c = new StateStore(home);
  await c.load();
  assert.deepEqual([...c.sessions.keys()].sort(), ["s-a", "s-b"]);
  assert.equal(c.getSession("s-a").userMessageCount, 3);
  assert.equal(c.getSession("s-b").userMessageCount, 2);
});

test("registry: rebuild 遇重复 uid 记 warning，不静默丢一条", async () => {
  const home = await makeHome();
  const config = resolveConfig({});
  const day = path.join(home, "memory", "2026-11-28");
  for (const label of ["2_2026-11-28_aaaa1111_01_事件A_甲_乙", "2_2026-11-28_bbbb2222_01_事件B_丙_丁"]) {
    const folder = path.join(day, label);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "level2.txt"), "## 摘要\n内容\n", "utf8");
    await writeFile(
      path.join(folder, "meta.json"),
      JSON.stringify({
        uid: "m-20261128-001",
        label,
        folder,
        date: "2026-11-28",
        seq: 1,
        serial: 1,
        defaultLevel: 2,
        snapshots: [2],
        keywords: [{ term: "词", keyness: 5, levels: [2] }],
        people: [],
        sessionId: "session-aaaa1111",
        createdAt: 1,
        updatedAt: 1,
      }),
      "utf8",
    );
  }

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const registry = new Registry(home, config);
    const count = await registry.rebuild();
    assert.equal(count, 1);
    assert.equal(registry.rebuildWarnings.length, 1, "重复 uid 要留诊断");
    assert.match(warnings.join("\n"), /重复 uid/, "必须 warn，不能静默覆盖");
  } finally {
    console.warn = original;
  }
});

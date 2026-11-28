// P2 事件档案回归测试：分卷数字排序、事件名撞分卷名、reconception index/read 同口径、跨天日期。
// 运行：node --test test/fix-p2-events.test.mjs
// 全部使用 os.tmpdir() 下的临时 home，绝不触碰真实 ~/dsh-HDM。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { appendEventLine, compareEventFiles, eventsIndexFile, loadEventIndex, readEvent, rebuildEvents, eventSlug } from "../lib/events.js";
import { reconcept } from "../lib/reconception.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-fix-p2-events-"));
after(() => rm(ROOT, { recursive: true, force: true }));

let seq = 0;
async function makeHome() {
  seq += 1;
  return mkdtemp(path.join(ROOT, `home-${seq}-`));
}

async function readIndex(home) {
  return JSON.parse(await readFile(eventsIndexFile(home), "utf8"));
}

/** 从事件正文里按出现顺序取「第 N 条」的 N。 */
function lineNumbers(text) {
  return [...text.matchAll(/^- \d{4}-\d{2}-\d{2} 第 (\d+) 条$/gm)].map((m) => Number(m[1]));
}

/* ------------------------------------------------------------------ */
/* 1. P2-1：12 个分卷按卷号数字排序，readEvent 拼接不乱序                */
/* ------------------------------------------------------------------ */

test("12 个分卷：文件名排序 2 < 10，readEvent 拼接顺序与重建后的 files 一致", async () => {
  const home = await makeHome();
  const dir = path.join(home, "Events");
  await mkdir(dir, { recursive: true });
  // 旧命名：无后缀是第 1 份，之后 xxx1.txt…xxx11.txt，共 12 份。
  const names = ["维护插件.txt", ...Array.from({ length: 11 }, (_, i) => `维护插件${i + 1}.txt`)];
  for (let i = 0; i < names.length; i += 1) {
    await writeFile(
      path.join(dir, names[i]),
      `# 事件：维护插件\n\n- 2026-11-20 第 ${i + 1} 条\n\n## 相关记忆\n- m-2026112${i}-001\n`,
      "utf8",
    );
  }

  // 索引是历史脏数据：按字典序记录，xxx10/xxx11 排在 xxx2 前面。
  await mkdir(path.join(home, "index"), { recursive: true });
  const lexicographic = [...names].sort();
  await writeFile(
    eventsIndexFile(home),
    JSON.stringify({
      version: 1,
      updatedAt: 1,
      entries: { 维护插件: { term: "维护插件", files: lexicographic.map((name) => `Events/${name}`), uids: [] } },
    }),
    "utf8",
  );

  // 读：即使索引顺序是字典序，也按卷号拼接。
  assert.deepEqual(lineNumbers((await readEvent(home, "维护插件")).text), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(compareEventFiles("Events/维护插件2.txt", "Events/维护插件10.txt") < 0, "卷 2 必须排在卷 10 前");

  // 重建：files 按卷号数字排，2 在 10 前。
  assert.equal(await rebuildEvents(home, { list: () => [] }), 1);
  const entry = (await loadEventIndex(home)).get(eventSlug("维护插件"));
  assert.deepEqual(
    entry.files,
    names.map((name) => `Events/${name}`),
  );
  assert.deepEqual(lineNumbers((await readEvent(home, "维护插件")).text), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

/* ------------------------------------------------------------------ */
/* 2. P2-2：事件名撞分卷名，不混写、不丢事件，冲突进 warning             */
/* ------------------------------------------------------------------ */

test("事件「维护插件」占着维护插件1.txt 时，事件「维护插件1」另起文件；重建后两事件都在", async () => {
  const home = await makeHome();
  const now = Date.parse("2026-11-28T10:00:00+08:00");
  for (let i = 1; i <= 2; i += 1) {
    await appendEventLine(home, {
      term: "维护插件",
      line: `第 ${i} 条`,
      uid: `m-20261128-00${i}`,
      maxLines: 1,
      now,
    });
  }
  const occupied = await readFile(path.join(home, "Events", "维护插件1.txt"), "utf8");
  assert.ok(occupied.startsWith("# 事件：维护插件\n"), occupied);

  const collided = await appendEventLine(home, {
    term: "维护插件1",
    line: "独立事件的一条",
    uid: "m-20261128-003",
    maxLines: 1,
    now,
  });
  assert.equal(collided.ok, true);
  assert.notEqual(collided.file, "Events/维护插件1.txt", "不能写进别的事件的分卷");
  assert.equal(collided.created, true);
  assert.ok(collided.warnings?.length, "撞名要留 warning");

  // 被撞的那份逐字未变；两个事件各自读到自己的正文。
  assert.equal(await readFile(path.join(home, "Events", "维护插件1.txt"), "utf8"), occupied);
  assert.ok(!(await readEvent(home, "维护插件")).text.includes("独立事件的一条"));
  assert.match((await readEvent(home, "维护插件1")).text, /^# 事件：维护插件1\n/);
  assert.match((await readEvent(home, "维护插件1")).text, /独立事件的一条/);

  // 重建：两条事件都在，文件名与文件头归属不一致时记 warning。
  await rm(eventsIndexFile(home), { force: true });
  assert.equal(await rebuildEvents(home, { list: () => [] }), 2);
  const rebuilt = await loadEventIndex(home);
  assert.equal(rebuilt.get(eventSlug("维护插件1")).files.length, 1);
  const warnings = (await readIndex(home)).warnings ?? [];
  assert.ok(warnings.some((row) => row.includes("维护插件")), JSON.stringify(warnings));
});

/* ------------------------------------------------------------------ */
/* 3. P2-3：index 命中的 term 拿去 read 必须能读到（宽泛/大小写/空格）   */
/* ------------------------------------------------------------------ */

test("reconception：index 的宽泛 term 用同口径 read 能读到，含大小写与空格变体", async () => {
  const home = await makeHome();
  await appendEventLine(home, {
    term: "维护 HDM 插件",
    line: "落地事件索引",
    uid: "m-20261128-010",
    now: Date.parse("2026-11-28T10:00:00+08:00"),
  });

  for (const term of ["维护", "维护 hdm 插件", "维护  HDM   插件", "维护-HDM-插件"]) {
    const index = await reconcept({ home, kind: "event", term });
    assert.equal(index.matches.length, 1, `index 应命中：${term}`);
    assert.equal(index.matches[0].title, "维护 HDM 插件");

    const read = await reconcept({ home, kind: "event", term, mode: "read" });
    assert.equal(read.matches.length, 1, `read 应命中：${term}`);
    assert.equal(read.term, "维护 HDM 插件");
    assert.match(read.text, /落地事件索引/);
  }

  // 用 index 回执里的 title 去 read 也必须能读到。
  const index = await reconcept({ home, kind: "event", term: "维护" });
  const read = await reconcept({ home, kind: "event", term: index.matches[0].title, mode: "read" });
  assert.ok(read.text.includes("落地事件索引"));

  const missing = await reconcept({ home, kind: "event", term: "不存在", mode: "read" });
  assert.deepEqual(missing.matches, []);
});

/* ------------------------------------------------------------------ */
/* 4. P2-4：跨天追加同一事件，行日期取当天而不是记忆单元创建日           */
/* ------------------------------------------------------------------ */

test("跨天追加：第二天的行日期是当天；读不到时间才退回 meta.date 并记 warning", async () => {
  const home = await makeHome();
  const first = await appendEventLine(home, {
    term: "跨天事件",
    date: "2026-11-20",
    line: "第一天的事",
    uid: "m-20261120-001",
    now: Date.parse("2026-11-20T10:00:00+08:00"),
  });
  // 同一事件跨天追加：调用方仍传旧的 meta.date，但 now 已是三天后。
  await appendEventLine(home, {
    term: "跨天事件",
    date: "2026-11-20",
    line: "第三天的事",
    uid: "m-20261120-001",
    now: Date.parse("2026-11-22T10:00:00+08:00"),
  });

  const text = await readFile(path.join(home, first.file), "utf8");
  assert.ok(text.includes("- 2026-11-20 第一天的事\n"), text);
  assert.ok(text.includes("- 2026-11-22 第三天的事\n"), "第二天（新日期）的事不能标成 11-20");
  assert.ok(!text.includes("- 2026-11-20 第三天的事\n"), "历史行与错标日期都不能出现");

  // 没给任何时间时才退回 meta.date，并留 warning。
  const fallback = await appendEventLine(home, {
    term: "跨天事件",
    date: "2026-11-20",
    line: "补写的一条",
    uid: "m-20261120-001",
  });
  assert.ok(fallback.warnings?.some((row) => row.includes("2026-11-20")), JSON.stringify(fallback.warnings));
  assert.ok((await readFile(path.join(home, first.file), "utf8")).includes("- 2026-11-20 补写的一条\n"));
});

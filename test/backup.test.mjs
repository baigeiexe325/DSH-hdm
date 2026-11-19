// 版本快照：母文件夹之外保存，每一版都能原样恢复（2026-11-08 母文件夹事故的回归测试）。
// 核心用例：把母文件夹整个删掉，再从快照恢复 IAM / 人物档案 / 记忆 / 日记。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { list, resolveBackupRoot, restore, snapshot, verify } from "../lib/backup.js";

const PAYLOAD = ["IAM.md", "characters", "memory", "diary", "IAM_Blank.md"];

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 造一个最小母文件夹：四类数据各一份。 */
async function makeHome() {
  const home = await tmp("hdm-bk-home-");
  await fs.mkdir(path.join(home, "memory", "2026-11-08", "2_2026-11-08_001_demo"), { recursive: true });
  await fs.mkdir(path.join(home, "diary"), { recursive: true });
  await fs.mkdir(path.join(home, "characters"), { recursive: true });
  await fs.mkdir(path.join(home, "index"), { recursive: true });
  await fs.writeFile(path.join(home, "IAM.md"), "# IAM\n\n## 我是谁\n测试身份\n", "utf8");
  await fs.writeFile(path.join(home, "IAM_Blank.md"), "# 空白模板\n", "utf8");
  await fs.writeFile(path.join(home, "characters", "USER.md"), "# USER 档案\n\n## 偏好与语气\n喜欢简洁\n", "utf8");
  const folder = path.join(home, "memory", "2026-11-08", "2_2026-11-08_001_demo");
  await fs.writeFile(path.join(folder, "level2.txt"), "# 摘要\n第一条记忆\n", "utf8");
  await fs.writeFile(path.join(folder, "meta.json"), `${JSON.stringify({ uid: "m-20261108-001", folder }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(home, "diary", "2026-11-08.txt"), "# 2026-11-08 日记\n\n## 摘要\n今天的事\n", "utf8");
  await fs.writeFile(path.join(home, "index", "memories.json"), "{}\n", "utf8");
  return home;
}

async function readAll(home) {
  const out = {};
  for (const item of PAYLOAD) {
    const full = path.join(home, item);
    const info = await fs.stat(full).catch(() => null);
    if (!info) continue;
    if (info.isFile()) {
      out[item] = await fs.readFile(full, "utf8");
      continue;
    }
    const stack = [""];
    while (stack.length) {
      const rel = stack.pop();
      const dir = rel ? path.join(full, rel) : full;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) stack.push(childRel);
        else out[`${item}/${childRel}`] = await fs.readFile(path.join(dir, entry.name), "utf8");
      }
    }
  }
  return out;
}

function cfg(dir, keep = 20) {
  return { backup: { enabled: true, dir, keep } };
}

test("快照写在母文件夹之外，且内容与母文件夹一致", async () => {
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  try {
    const result = await snapshot({ home, config: cfg(dir), reason: "test" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.skipped, false);
    const inside = path.relative(home, result.dir);
    assert.ok(inside.startsWith("..") || path.isAbsolute(inside), "快照目录必须在母文件夹之外");

    const manifest = JSON.parse(await fs.readFile(path.join(result.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.counts.memories, 1);
    assert.equal(manifest.counts.diary, 1);
    assert.equal(manifest.counts.characters, 1);
    assert.equal(await fs.readFile(path.join(result.dir, "IAM.md"), "utf8"), "# IAM\n\n## 我是谁\n测试身份\n");
    assert.equal(await fs.readFile(path.join(result.dir, "memory", "2026-11-08", "2_2026-11-08_001_demo", "level2.txt"), "utf8"), "# 摘要\n第一条记忆\n");

    const check = await verify({ dir: result.dir, manifest });
    assert.equal(check.ok, true, check.problems.join("；"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("母文件夹被整个删掉后，仍能恢复到保存时的样子（事故回归）", async () => {
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  const before = await readAll(home);
  try {
    const snap = await snapshot({ home, config: cfg(dir), reason: "before-incident" });
    assert.equal(snap.ok, true);

    // 模拟事故：整目录 rm -rf，连 Back-to-back 的 index/state 一起没了。
    await fs.rm(home, { recursive: true, force: true });
    assert.equal(await fs.stat(home).catch(() => null), null, "母文件夹确实被删除");

    const result = await restore({ home, config: cfg(dir) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exact, true, "恢复后 digest 必须与快照一致");
    assert.deepEqual(result.restored, { memories: 1, diary: 1, characters: 1 });

    const after = await readAll(home);
    assert.deepEqual(after, before, "IAM/人物/记忆/日记必须与保存时逐字相同");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("内容没变时跳过，不留重复版本", async () => {
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  try {
    const first = await snapshot({ home, config: cfg(dir) });
    const second = await snapshot({ home, config: cfg(dir) });
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(second.version, first.version);
    assert.equal((await list({ home, config: cfg(dir) })).total, 1);

    // 只改日记正文 → 必须产生新版本
    await fs.writeFile(path.join(home, "diary", "2026-11-08.txt"), "改过的日记\n", "utf8");
    const third = await snapshot({ home, config: cfg(dir) });
    assert.equal(third.skipped, false);
    assert.notEqual(third.version, first.version);
    assert.equal((await list({ home, config: cfg(dir) })).total, 2);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("可以恢复到历史某一版，不是只有最新版", async () => {
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  try {
    const v1 = await snapshot({ home, config: cfg(dir), reason: "v1" });
    const oldIam = await fs.readFile(path.join(home, "IAM.md"), "utf8");
    await fs.writeFile(path.join(home, "IAM.md"), "# IAM\n\n## 我是谁\n改坏的身份\n", "utf8");
    await fs.writeFile(path.join(home, "diary", "2026-11-08.txt"), "改坏的日记\n", "utf8");
    const v2 = await snapshot({ home, config: cfg(dir), reason: "v2" });
    assert.notEqual(v2.version, v1.version);

    const back = await restore({ home, config: cfg(dir), version: v1.version });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(back.version, v1.version);
    assert.equal(await fs.readFile(path.join(home, "IAM.md"), "utf8"), oldIam);
    assert.match(await fs.readFile(path.join(home, "diary", "2026-11-08.txt"), "utf8"), /今天的事/);
    // 恢复前会自动拍一版 pre-restore，所以总版本数增加了
    assert.ok(back.rollbackVersion, "应有 pre-restore 回滚点");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("快照被篡改时拒绝恢复，且不动母文件夹", async () => {
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  try {
    const snap = await snapshot({ home, config: cfg(dir) });
    await fs.writeFile(path.join(home, "diary", "2026-11-08.txt"), "当前新日记\n", "utf8");
    const current = await fs.readFile(path.join(home, "diary", "2026-11-08.txt"), "utf8");

    await fs.writeFile(path.join(snap.dir, "IAM.md"), "被篡改的内容\n", "utf8");
    const result = await restore({ home, config: cfg(dir) });
    assert.equal(result.ok, false);
    assert.match(result.error, /校验失败/);
    assert.equal(await fs.readFile(path.join(home, "diary", "2026-11-08.txt"), "utf8"), current, "母文件夹必须原封不动");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("keep 生效：只保留最近 N 版，最新版永不删除", async () => {
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  try {
    const versions = [];
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(home, "IAM.md"), `# IAM\n第 ${i} 版\n`, "utf8");
      versions.push((await snapshot({ home, config: cfg(dir, 2) })).version);
    }
    const listed = await list({ home, config: cfg(dir, 2) });
    assert.equal(listed.total, 2);
    assert.equal(listed.versions[0].version, versions[4], "最新的那版必须在");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("恢复最旧一版时 pre-restore 快照不会把它剪掉（keep 0/1/2、仅一版）", async () => {
  for (const keep of [0, 1, 2]) {
    const home = await makeHome();
    const dir = await tmp("hdm-bk-root-");
    try {
      // 造版阶段用大 keep，确保三版同时存在；恢复阶段才用待测 keep。
      const v1 = await snapshot({ home, config: cfg(dir, 20), reason: "v1" });
      const v1Iam = await fs.readFile(path.join(v1.dir, "IAM.md"), "utf8");
      await fs.writeFile(path.join(home, "IAM.md"), "# IAM\\n第 2 版\\n", "utf8");
      await snapshot({ home, config: cfg(dir, 20), reason: "v2" });
      await fs.writeFile(path.join(home, "IAM.md"), "# IAM\\n第 3 版\\n", "utf8");
      const v3 = await snapshot({ home, config: cfg(dir, 20), reason: "v3" });
      assert.equal((await list({ home, config: cfg(dir, 20) })).total, 3);

      const result = await restore({ home, config: cfg(dir, keep), version: v1.version });
      assert.equal(result.ok, true, `keep=${keep}: ${JSON.stringify(result)}`);
      assert.equal(result.exact, true, `keep=${keep}: 恢复后 digest 必须与目标版一致`);
      assert.equal(await fs.readFile(path.join(home, "IAM.md"), "utf8"), v1Iam, `keep=${keep}: 内容应为 v1`);
      assert.ok(!result.pruned.includes(v1.version), `keep=${keep}: 目标版本不能被回收`);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  // 只存在目标一版时也必须能恢复。
  const home = await makeHome();
  const dir = await tmp("hdm-bk-root-");
  try {
    const only = await snapshot({ home, config: cfg(dir, 1), reason: "only" });
    await fs.writeFile(path.join(home, "IAM.md"), "# IAM\\n改坏了\\n", "utf8");
    const result = await restore({ home, config: cfg(dir, 1), version: only.version });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exact, true);
    assert.match(await fs.readFile(path.join(home, "IAM.md"), "utf8"), /测试身份/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("backup.dir 落在母文件夹内时回退到母文件夹之外并给出 warning", async () => {
  const home = await makeHome();
  try {
    const result = resolveBackupRoot({ home, config: cfg(path.join(home, "Backup")) });
    assert.equal(result.source, "fallback");
    assert.match(result.warning, /母文件夹内部/);
    const rel = path.relative(home, result.root);
    assert.ok(rel.startsWith("..") || path.isAbsolute(rel), "回退目录必须在母文件夹之外");
    // 默认目录也在母文件夹之外
    const def = resolveBackupRoot({ home, config: { backup: { dir: "" } } });
    assert.ok(path.relative(home, def.root).startsWith(".."), "默认快照根在母文件夹之外");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

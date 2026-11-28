// 母文件夹之外的版本化快照：每一版都能原样恢复到保存时的那一刻。
// 设计要点（2026-11-08 事故后重做）：
//   1) 快照根目录默认 ~/.dsh-hdm-backups/<母文件夹名>，落在母文件夹之外——
//      母文件夹被整目录删除时快照仍在（旧的 Backup/*.bak 就在 home 里，跟着一起没了）。
//   2) 一版 = 一个目录 + manifest.json（每个文件的 sha256/字节数 + 内容摘要）。
//      恢复前先校验哈希，校验通过才动母文件夹；动手前再给当前状态拍一版 pre-restore。
//   3) 覆盖范围是用户可见的数据：IAM.md / IAM_Blank.md / characters/ / memory/ / diary/ / Imagery/ / Events/。
//      index/ 不复制（它由 memory/**/meta.json、Imagery/*.md 与 Events/*.txt 重建），state/ 属于会话本地状态，不进快照。
// 纯 ESM；同步/异步文件 API 均用 node:fs/promises。

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 进快照的数据项（文件或目录，相对母文件夹）。顺序固定，便于 digest 稳定。 */
export const PAYLOAD = Object.freeze(["IAM.md", "IAM_Blank.md", "characters", "memory", "diary", "Imagery", "Events"]);

/** 恢复时会被替换的数据项 = 与 PAYLOAD 相同；index/ state/ 不碰。 */
export const RESTORE_TARGETS = PAYLOAD;

const TMP_SUFFIX = /\.(tmp|part|swp)$/i;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function oneSlash(rel) {
  return rel.split(path.sep).join("/");
}

function slugOf(home) {
  return path.resolve(home).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "hdm";
}

/**
 * 解析快照根。配置为空 → `<主目录>/.dsh-hdm-backups/<母文件夹 slug>`。
 * 配置落在母文件夹内部是无效的（会随母文件夹一起被删），回退默认并给出 warning。
 */
export function resolveBackupRoot({ home, config }) {
  const fallback = path.join(os.homedir(), ".dsh-hdm-backups", slugOf(home));
  const configured = String(config?.backup?.dir ?? "").trim();
  if (!configured) return { root: fallback, warning: null, source: "default" };
  const resolved = path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
  const homeResolved = path.resolve(home);
  const relative = path.relative(homeResolved, resolved);
  const insideHome = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (insideHome) {
    return {
      root: fallback,
      warning: `backup.dir（${resolved}）在母文件夹内部，会随母文件夹一起丢失，已回退到 ${fallback}`,
      source: "fallback",
    };
  }
  return { root: resolved, warning: null, source: "config" };
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/** 递归收集一个目录下的普通文件（相对该目录）。 */
async function walk(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (TMP_SUFFIX.test(entry.name)) continue;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/** 列出当前母文件夹的数据项与实际文件 + 哈希。 */
export async function captureState({ home }) {
  const files = [];
  for (const item of PAYLOAD) {
    const full = path.join(home, item);
    const info = await statOrNull(full);
    if (!info) continue;
    if (info.isFile()) {
      const bytes = await fs.readFile(full);
      files.push({ rel: oneSlash(item), bytes: bytes.length, sha256: sha256(bytes) });
    } else if (info.isDirectory()) {
      for (const rel of await walk(full)) {
        const child = path.join(full, rel);
        const bytes = await fs.readFile(child);
        files.push({ rel: oneSlash(path.join(item, rel)), bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  return { files, digest: digestOf(files) };
}

/** 内容摘要：只由「路径 + 内容哈希」决定，改时间戳不影响。 */
export function digestOf(files) {
  const text = files
    .map((file) => `${file.rel}:${file.sha256}`)
    .sort()
    .join("\n");
  return sha256(Buffer.from(text, "utf8"));
}

function countsOf(files) {
  const counts = { memories: 0, diary: 0, characters: 0 };
  for (const file of files) {
    if (/^memory\/.*\/meta\.json$/.test(file.rel)) counts.memories += 1;
    else if (/^diary\/.*\.txt$/.test(file.rel)) counts.diary += 1;
    else if (/^characters\/.*\.md$/.test(file.rel)) counts.characters += 1;
  }
  return counts;
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function listVersionDirs(root) {
  let names = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!/^v-/.test(name)) continue;
    const dir = path.join(root, name);
    const info = await statOrNull(dir);
    if (!info?.isDirectory()) continue;
    const manifest = await readJsonOrNull(path.join(dir, "manifest.json"));
    rows.push({ version: name, dir, manifest, mtime: manifest?.createdAt ?? info.mtimeMs });
  }
  return rows.sort((a, b) => Number(b.mtime) - Number(a.mtime));
}

function versionName(now) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `v-${iso}-${Math.random().toString(36).slice(2, 6)}`;
}

async function copyInto(snapshotDir, home, files) {
  for (const file of files) {
    const from = path.join(home, file.rel);
    const to = path.join(snapshotDir, file.rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

/**
 * 拍一版快照。
 * - 内容与最新一版完全一致时跳过，返回 { ok:true, skipped:true, version }。
 * - prune=false 时跳过回收（恢复流程用：先拍 pre-restore，拷回成功后再回收，避免删掉正在恢复的版本）。
 * - pruneProtect 中的版本在这次回收里永不删除。
 * - 返回 { ok, version, dir, counts, bytes, files, digest, pruned }。
 */
export async function snapshot({
  home,
  config,
  reason = "manual",
  now = Date.now(),
  force = false,
  prune: shouldPrune = true,
  pruneProtect = [],
}) {
  const { root, warning } = resolveBackupRoot({ home, config });
  const keep = Math.max(1, Number(config?.backup?.keep ?? 20));
  const state = await captureState({ home });
  const versions = await listVersionDirs(root);
  const latest = versions[0];
  if (!force && latest?.manifest?.digest === state.digest) {
    return {
      ok: true,
      skipped: true,
      version: latest.version,
      dir: latest.dir,
      root,
      warning,
      reason: latest.manifest?.reason ?? null,
      counts: latest.manifest?.counts ?? countsOf(state.files),
      createdAt: latest.manifest?.createdAt ?? latest.mtime,
    };
  }

  const version = versionName(now);
  const dir = path.join(root, version);
  await fs.mkdir(dir, { recursive: true });
  try {
    await copyInto(dir, home, state.files);
    const manifest = {
      version,
      createdAt: now,
      home: path.resolve(home),
      reason: String(reason),
      digest: state.digest,
      bytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
      counts: countsOf(state.files),
      files: state.files,
    };
    await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error), root, warning };
  }

  const pruned = shouldPrune ? await prune({ root, keep, newest: version, protect: pruneProtect }) : [];
  return {
    ok: true,
    skipped: false,
    version,
    dir,
    root,
    warning,
    reason: String(reason),
    counts: countsOf(state.files),
    bytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
    files: state.files.length,
    pruned,
  };
}

/** 只保留最近 keep 版；最新的那版永远不删，protect 里的版本也不删。 */
export async function prune({ root, keep, newest, protect = [] }) {
  const versions = await listVersionDirs(root);
  const protectedNames = new Set(Array.isArray(protect) ? protect.map(String) : []);
  const removed = [];
  for (const row of versions.slice(keep)) {
    if (row.version === newest) continue;
    if (protectedNames.has(row.version)) continue;
    if (await statOrNull(row.dir)) {
      await fs.rm(row.dir, { recursive: true, force: true }).catch(() => undefined);
      removed.push(row.version);
    }
  }
  return removed;
}

/** 列出所有版本（新的在前）。 */
export async function list({ home, config }) {
  const { root, warning } = resolveBackupRoot({ home, config });
  const versions = await listVersionDirs(root);
  return {
    root,
    warning,
    total: versions.length,
    versions: versions.map((row) => ({
      version: row.version,
      createdAt: row.manifest?.createdAt ?? row.mtime,
      reason: row.manifest?.reason ?? "unknown",
      digest: row.manifest?.digest ?? null,
      bytes: row.manifest?.bytes ?? null,
      counts: row.manifest?.counts ?? null,
      files: row.manifest?.files?.length ?? null,
    })),
  };
}

/** 校验一版快照：manifest 存在、文件齐全、每个文件哈希一致。 */
export async function verify({ dir, manifest }) {
  const problems = [];
  if (!manifest) return { ok: false, problems: ["manifest.json 缺失或损坏"] };
  for (const file of manifest.files ?? []) {
    const full = path.join(dir, file.rel);
    let bytes;
    try {
      bytes = await fs.readFile(full);
    } catch {
      problems.push(`缺少文件 ${file.rel}`);
      continue;
    }
    if (bytes.length !== file.bytes) problems.push(`${file.rel} 字节数不符（${bytes.length} != ${file.bytes}）`);
    else if (sha256(bytes) !== file.sha256) problems.push(`${file.rel} 内容哈希不符`);
  }
  if (digestOf(manifest.files ?? []) !== manifest.digest) problems.push("内容摘要与 manifest 不一致");
  return { ok: problems.length === 0, problems };
}

async function copyOut(snapshotDir, home, files) {
  for (const file of files) {
    const from = path.join(snapshotDir, file.rel);
    const to = path.join(home, file.rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

/**
 * 恢复到某一版。顺序刻意如此：
 *   ① 找到并校验该版 → ② 给当前状态拍 pre-restore 版（失败可回滚）→ ③ 清空数据项 → ④ 拷回 → ⑤ 复核。
 * index/ 与 state/ 不在这里处理，调用方恢复后重建索引。
 */
export async function restore({ home, config, version, now = Date.now() }) {
  const { root, warning } = resolveBackupRoot({ home, config });
  const versions = await listVersionDirs(root);
  if (!versions.length) return { ok: false, error: `没有任何快照版本（${root}）`, root, warning };
  const target = version ? versions.find((row) => row.version === version) : versions[0];
  if (!target) return { ok: false, error: `找不到版本 ${version}`, root, warning };

  const check = await verify(target);
  if (!check.ok) {
    return { ok: false, error: `快照校验失败，未改动母文件夹：${check.problems.join("；")}`, root, warning, problems: check.problems };
  }

  // 快照拍完先不回收：若 keep 已满且正在恢复最旧一版，立刻 prune 会把 target.dir 删掉。
  const rollback = await snapshot({
    home,
    config,
    reason: `pre-restore:${target.version}`,
    now,
    force: true,
    prune: false,
  });
  if (!rollback.ok) {
    return { ok: false, error: `恢复前的当前状态快照失败，未改动母文件夹：${rollback.error}`, root, warning };
  }

  try {
    for (const item of RESTORE_TARGETS) {
      await fs.rm(path.join(home, item), { recursive: true, force: true });
    }
    await copyOut(target.dir, home, target.manifest.files ?? []);
  } catch (error) {
    // 拷回途中失败：尽力用 pre-restore 版回滚，并把错误如实返回。
    let rolledBack = false;
    if (!rollback.skipped) {
      try {
        for (const item of RESTORE_TARGETS) await fs.rm(path.join(home, item), { recursive: true, force: true });
        await copyOut(rollback.dir, home, rollback.manifest?.files ?? (await listVersionDirs(root))[0]?.manifest?.files ?? []);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }
    return {
      ok: false,
      error: `恢复失败：${error instanceof Error ? error.message : String(error)}`,
      rolledBack,
      root,
      warning,
    };
  }

  // 拷贝成功后再回收；target 与 rollback 都在 protect 里，避免把刚恢复的版本或回滚点删掉。
  const keep = Math.max(1, Number(config?.backup?.keep ?? 20));
  const pruned = await prune({
    root,
    keep,
    newest: rollback.version,
    protect: [target.version, rollback.version],
  });

  const after = await captureState({ home });
  const exact = after.digest === target.manifest.digest;
  return {
    ok: exact,
    version: target.version,
    createdAt: target.manifest.createdAt,
    restored: target.manifest.counts,
    bytes: target.manifest.bytes,
    digest: after.digest,
    expectedDigest: target.manifest.digest,
    exact,
    rollbackVersion: rollback.skipped ? null : rollback.version,
    pruned,
    root,
    warning,
    error: exact ? null : "恢复后内容与快照不一致（可能有并发写入）",
  };
}

/** 写入路径上的自动快照：绝不抛错、绝不阻断主流程。 */
export async function snapshotIfChanged({ home, config, reason, now = Date.now() }) {
  if (config?.backup?.enabled === false) return { ok: true, skipped: true, disabled: true };
  try {
    return await snapshot({ home, config, reason, now });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

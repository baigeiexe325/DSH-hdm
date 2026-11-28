// 母文件夹切换与自动迁移。
// 指针文件放在用户主目录（不随 homeDir 变化），用于在配置改变后找回旧母文件夹。

import { cp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicJson, ensureDir } from "./paths.js";

export const POINTER_FILE = path.join(os.homedir(), ".dsh-hdm.home.json");

// 测试可用 HDM_HOME_POINTER 指向临时文件，避免污染真实主目录。
export function pointerFile() {
  return process.env.HDM_HOME_POINTER || POINTER_FILE;
}

export async function readPointer(file = pointerFile()) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function writePointer(home, file = pointerFile()) {
  // 原子写：先写临时文件再 rename，崩溃时不会留下半截指针把下次启动指到错误目录。
  await atomicJson(file, { homeDir: home, updatedAt: Date.now() });
}

async function isEmptyDir(dir) {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    // 不存在 = 空（走 rename）；其它错误必须抛出，否则 migrateHome 会把目标处已有文件 rm -rf。
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

/**
 * 迁移后重写每条记忆 meta.json 里的绝对 folder 路径；
 * 否则 registry 仍指向旧母文件夹，删除旧目录后 hdm_read 会失效。
 * @returns {Promise<number>} 重写条数
 */
export async function rewriteMetaFolders(root) {
  let rewritten = 0;
  const stack = [path.join(root, "memory")];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name !== "meta.json") continue;
      try {
        const meta = JSON.parse(await readFile(full, "utf8"));
        const folder = path.dirname(full);
        if (meta && typeof meta === "object" && meta.folder !== folder) {
          meta.folder = folder;
          await atomicJson(full, meta);
          rewritten += 1;
        }
      } catch {
        // 单条 meta 损坏不阻塞整体迁移；索引重建会跳过它。
      }
    }
  }
  return rewritten;
}

/**
 * 把旧母文件夹的内容迁移到新位置：
 * - 目标为空/不存在：优先 rename（同盘秒移），跨盘回退为递归复制（旧目录保留）。
 * - 目标已有内容：拒绝迁移（`mode: "target-not-empty"`）。以前是 cp force:false 合并，
 *   同名文件被静默保留、meta.folder 却改指新目录，用户看到的是「数据像是丢了」。
 * 迁移成功后重写 meta.json 里的绝对 folder 路径。
 */
export async function migrateHome(from, to) {
  if (!from || !to || path.resolve(from) === path.resolve(to)) return { migrated: false, mode: "same" };
  const fromStat = await stat(from).catch(() => null);
  if (!fromStat?.isDirectory()) return { migrated: false, mode: "missing" };

  // 只检查目标目录自身：它不存在或为空才迁移；父级目录由下面 ensureDir 创建，不算「非空目标」。
  if (!(await isEmptyDir(to))) return { migrated: false, mode: "target-not-empty" };

  // Windows 上目录刚被扫过/占用时 rmdir 会报 ENOTEMPTY/EBUSY；fs.rm 自带重试能吃掉这类瞬时竞态。
  await rm(to, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await ensureDir(path.dirname(to));
  let mode;
  try {
    await rename(from, to);
    mode = "move";
  } catch {
    await cp(from, to, { recursive: true });
    mode = "copy";
    // 跨盘复制成功后删除旧目录，保持“迁移”而不是“复制”语义；
    // 删除失败则保留旧目录（数据仍在目标，安全）。
    await rm(from, { recursive: true, force: true }).catch(() => undefined);
  }
  const rewritten = await rewriteMetaFolders(to);
  return { migrated: true, mode, rewritten };
}

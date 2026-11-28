// 存量记忆的文件夹名迁移：旧 `<level>_<date>_<seq>_<kw...>` → 新 `<level>_<date>_<session8>_<serial2>_<event>_<kw...>`。
// serial 只在同一 (date, session8) 内按 createdAt 升序分配，保证每个会话的单元 01.. 连续且稳定。
// 纯 ESM；只使用 Node 内置模块与包内模块。

import path from "node:path";

import { snapshotIfChanged } from "./backup.js";
import { buildMemoryLabel, labelTermsOf } from "./memory.js";
import { atomicJson, eventSlug, parseMemoryFolderName, renameDirSafe, sessionSlug } from "./paths.js";

const MAX_SERIAL = 99;

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : "";
}

/** 计算迁移计划（不写盘）：只处理还是旧格式的单元，已经是新格式的跳过。 */
export function planLabelMigration(home, registry) {
  const metas = typeof registry?.list === "function" ? registry.list() : [];
  const maxChars = Number(registry?.config?.memory?.filenameMaxChars ?? 180);
  const groups = new Map();
  for (const meta of metas) {
    if (!meta?.uid || !meta?.folder) continue;
    if (parseMemoryFolderName(path.basename(meta.folder))?.format === "new") continue;
    const date = isoDate(meta.date);
    if (!date) continue;
    const session = sessionSlug(meta.sessionId);
    const key = `${date}\u0000${session}`;
    const rows = groups.get(key) ?? [];
    rows.push({ meta, date, session });
    groups.set(key, rows);
  }

  const plan = [];
  for (const rows of groups.values()) {
    rows.sort(
      (a, b) =>
        (Number(a.meta.createdAt) || 0) - (Number(b.meta.createdAt) || 0) ||
        String(a.meta.uid).localeCompare(String(b.meta.uid)),
    );
    rows.forEach((row, index) => {
      const serial = index + 1;
      // 超过 99 的会话不再迁移：新格式装不下，留下旧名交给人工拆会话。
      if (serial > MAX_SERIAL) return;
      const from = path.basename(row.meta.folder);
      const to = buildMemoryLabel({
        date: row.date,
        session: row.session,
        serial,
        event: row.meta.event,
        level: Number(row.meta.defaultLevel ?? 2),
        terms: labelTermsOf(row.meta.keywords),
        maxChars,
      });
      if (to === from) return;
      plan.push({ uid: String(row.meta.uid), from, to, session: row.session, serial, event: eventSlug(row.meta.event) });
    });
  }
  return plan;
}

/** 执行迁移；dryRun 只返回计划。失败保留旧名并收集 warning，不中断其余条目。 */
export async function applyLabelMigration(home, registry, { dryRun = false } = {}) {
  const planned = planLabelMigration(home, registry);
  const warnings = [];
  const renamed = [];
  if (dryRun) return { ok: true, dryRun: true, planned, renamed, warnings };

  // 调用方负责正式备份；这里仍拍一版内容快照，迁移中途失败还能按版本恢复。
  const snapshot = await snapshotIfChanged({ home, config: registry?.config, reason: "pre-label-migration" });
  if (snapshot?.ok === false) warnings.push(`迁移前快照失败：${snapshot.error ?? "unknown"}`);

  for (const row of planned) {
    const meta = registry.get(row.uid);
    if (!meta?.folder) {
      warnings.push(`${row.uid}: 注册表里找不到该单元，跳过`);
      continue;
    }
    const target = path.join(path.dirname(String(meta.folder)), row.to);
    try {
      await renameDirSafe(meta.folder, target);
    } catch (error) {
      warnings.push(`${row.from}: 文件夹改名失败（${error?.message ?? error}）`);
      continue;
    }
    meta.label = row.to;
    meta.folder = target;
    meta.serial = row.serial;
    try {
      await atomicJson(path.join(target, "meta.json"), meta);
    } catch (error) {
      warnings.push(`${row.to}: meta.json 写入失败（${error?.message ?? error}）`);
    }
    await registry.upsert(meta);
    renamed.push(row);
  }
  return { ok: true, dryRun: false, planned, renamed, warnings, snapshot };
}

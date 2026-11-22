// 会话记忆单元：把「本轮对话」固定到一个 uid（pin）。
// 本会话后续保存/整理都并入同一 uid；已派生 L1/L0 时只打 needsRederive 标记，不删派生档。
// 追加是原地改写：新输入并进同一份摘要/细节/原话，不再生成「## 追加记忆 #N」段落，
// 保证同一编码下的记忆始终是一个单文档（一个 ## 摘要 / ## 细节 / ## 原话）。
// 纯 ESM；只使用 Node 内置模块与包内模块。

import fs from "node:fs/promises";
import path from "node:path";

import { KEYWORD_BANDS } from "./config.js";
import {
  computeKeyness,
  createMemory,
  gistOf,
  mergeSnapshotForAppend,
  readSnapshot,
  relabelMemoryUnit,
  writeSnapshot,
} from "./memory.js";
import { atomicJson, localDate, renameDirSafe } from "./paths.js";
import { createMutex } from "./state.js";

const APPEND_LIMIT = 24000;
const mutex = createMutex();

/**
 * 固定单元什么时候还能继续追加：
 * - **同一天**：永远追加（哪怕中间隔了 10 小时，仍是同一天的连续对话）。
 * - **跨天**：只有距上次写入不超过 `save.gapHours`（默认 3 小时）才继续追加；
 *   超过就另起一条新记忆。
 * 为什么跨天要拆：一条记忆的 `date` 是它创建那天，跨天 append 会让「当天的记忆」
 * 永远是 0 条，日记直接报 no memories；旧单元也会被越写越长。
 */
function sameSession(meta, now, config) {
  if (!meta) return false;
  const today = localDate(now, config?.timeZone);
  if (String(meta.date ?? "") === today) return true;

  const lastAt = Number(meta.updatedAt ?? meta.createdAt ?? 0);
  if (!Number.isFinite(lastAt) || lastAt <= 0) return false;
  const hours = Number(config?.save?.gapHours ?? 3);
  const gapMs = (Number.isFinite(hours) && hours > 0 ? hours : 3) * 3600_000;
  return now - lastAt <= gapMs;
}

function isAppendableOnce(meta) {
  return Boolean(
    meta &&
      Array.isArray(meta.snapshots) &&
      meta.snapshots.length === 1 &&
      Number(meta.snapshots[0]) === 2 &&
      meta.forget?.d2 == null,
  );
}

/** 该单元是否已有派生的 L1/L0（或已留下派生标记）。 */
export function isDerived(meta) {
  const snapshots = Array.isArray(meta?.snapshots) ? meta.snapshots.map(Number) : [];
  return snapshots.some((level) => level === 1 || level === 0) || meta?.forget?.d2 != null || meta?.forget?.d5 != null;
}

/**
 * 重开 L2：删除派生档、清空派生标记、文件夹前缀改回 2_。
 * 已不再用于同日追加（那会反复删掉已派生的 L1/L0），保留给手动修复/诊断使用。
 */
export async function reopenToL2({ registry, meta, now = Date.now() }) {
  const folder = meta.folder;
  for (const level of [0, 1]) {
    await fs.rm(path.join(folder, `level${level}.txt`), { force: true }).catch(() => undefined);
  }
  const snapshots = Array.isArray(meta.snapshots) ? meta.snapshots.map(Number) : [];
  const hadDerived = snapshots.some((level) => level === 1 || level === 0);
  meta.snapshots = [2];
  meta.defaultLevel = 2;
  meta.forget = { ...(meta.forget ?? {}), d2: null, d5: null };
  meta.keywords = (Array.isArray(meta.keywords) ? meta.keywords : []).map((keyword) => ({
    ...keyword,
    levels: [2],
  }));
  if (hadDerived) {
    meta.reopenedAt = now;
    meta.reopenCount = (meta.reopenCount ?? 0) + 1;
  }
  meta.updatedAt = now;

  const label = String(meta.label ?? "");
  const fixedLabel = /^[0-2]_/.test(label) ? `2_${label.slice(2)}` : label;
  if (fixedLabel && fixedLabel !== label) {
    const fixedFolder = path.join(path.dirname(folder), fixedLabel);
    try {
      await renameDirSafe(folder, fixedFolder);
      meta.label = fixedLabel;
      meta.folder = fixedFolder;
    } catch {
      // 改名失败时保留旧名与旧 folder，organize.js 会修复前缀漂移。
    }
  }
  if (registry && typeof registry.upsert === "function") await registry.upsert(meta);
  return meta;
}

/**
 * 已派生的单元再被追加时，不删派生档，只打「需要重派生」标记：
 * 清掉 forget.d2/d5，置 needsRederive=1（数值 = 最高需要刷新的档），
 * 保留 snapshots / defaultLevel / 文件夹前缀。真正重写由遗忘巡检（forget.js）消费该标记完成。
 */
export async function markNeedsRederive({ registry, meta, now = Date.now() }) {
  meta.forget = { ...(meta.forget ?? {}), d2: null, d5: null };
  meta.needsRederive = 1;
  meta.updatedAt = now;
  if (registry && typeof registry.upsert === "function") await registry.upsert(meta);
  if (meta.folder) await atomicJson(path.join(meta.folder, "meta.json"), meta);
  return meta;
}

async function appendToUnit({ registry, config, meta, input, now, pinned }) {
  // 派生档不再删除：只标记待刷新，避免同一天反复保存把 L1/L0 反复删掉重建。
  if (pinned && isDerived(meta)) await markNeedsRederive({ registry, meta, now });
  const snapshot = await readSnapshot(meta, 2);

  // 顺序即权重：computeKeyness 按位置给「模型顺序」加成，所以本次输入必须排在旧词之前，
  // 否则追加的新关键词永远挤不进 top-12（旧词一直占着前面的位置）。
  const combinedTerms = [
    ...new Set([...input.keywords, ...(meta.keywords ?? []).map((keyword) => keyword.term ?? keyword)]),
  ];
  const people = [...new Set([...(meta.people ?? []), ...(input.people ?? [])])];
  const keywordScores = computeKeyness(combinedTerms, {
    summary: input.summary,
    details: input.details ?? [],
    quotes: input.quotes ?? [],
    people,
    scene: input.scene,
    event: input.event,
    registry,
  })
    // computeKeyness 只给 term/keyness，levels 是空的；必须补上 L2，否则 registry.addKeywordLevels
    // 拿不到任何等级 → 关键词索引桶为空 → hdm_recall 完全召不回这条记忆。新建路径在 memory.js 里补了，追加路径原先漏了。
    .map((keyword) => ({ ...keyword, levels: [2] }))
    .slice(0, KEYWORD_BANDS[2][1]);

  // 追加是原地改写：新输入并进同一份摘要/细节/原话（不新增「追加记忆 #N」段落）。
  // people 先落到 meta 上，合并时 buildSnapshotText 才能写出本次的人物。
  meta.people = people;
  meta.keywords = keywordScores;
  // 记忆编号（文件夹名）必须由「当前关键词」重算：只更新 meta.keywords 不改名，
  // 编号会永远停在首次保存那批词上（出现「mergeSna」「死配置」这类既不在关键词、
  // 也不是整词的历史残留）。改名在写快照之前做，L2 头部才会写上新编号。
  // 改名失败（目标已占用等）不阻断追加：编号留在旧名，由 hdm_organize 兜底修复。
  await relabelMemoryUnit(meta, Number(config?.memory?.filenameMaxChars ?? 180)).catch(() => undefined);
  const merged = mergeSnapshotForAppend({
    currentText: snapshot.text,
    meta,
    input,
    now,
    timeZone: config?.timeZone ?? "Asia/Shanghai",
    keywords: keywordScores,
  });
  const text = merged.text;
  if (text.length > APPEND_LIMIT) {
    throw new Error("HDM: 追加后记忆文件过大；请用新记忆单元（解除本会话固定单元后重试）。");
  }

  meta.appendCount = (meta.appendCount ?? 1) + 1;
  meta.updatedAt = now;
  // gist 跟合并后的摘要走：不刷新的话联想永远读到建单元那天的旧摘要。
  meta.gist = gistOf(merged.summary);
  await writeSnapshot(meta, 2, text);
  // meta.json 是 rebuild 的唯一来源：追加只写 level2.txt 会让重建（hdm_organize）后丢掉本次追加的
  // 关键词、appendCount 与 updatedAt。createMemory 会写它，追加路径必须对齐。
  await atomicJson(path.join(meta.folder, "meta.json"), meta);
  await registry.upsert(meta);
  return { meta, keywordScores, merged: true };
}

/**
 * 保存一条会话记忆。
 * - `pin` 为 true（强制记忆/自动整理）：命中会话固定单元就并入，没有则新建并回填。
 * - `pin` 为 false（普通 hdm_save）：保持旧行为——同一会话在 L2 未派生时追加，否则新建；
 *   但若该会话已有固定单元（pinConversation），仍然并入该单元。
 */
export async function saveConversationMemory({
  registry,
  config,
  home,
  state,
  session,
  input,
  now = Date.now(),
  pin = false,
}) {
  const sessionId = typeof session?.id === "string" && session.id ? session.id : null;
  const key = `save:${path.resolve(home ?? ".")}:${sessionId ?? "anon"}`;
  return mutex.run(key, async () => {
    const ss = sessionId ? state.getSession(sessionId) : null;
    const pinnedUid = ss?.memoryUid ?? null;
    const pinned = pinnedUid ? registry.get(pinnedUid) : undefined;
    const lastUid = ss?.uids?.length ? ss.uids[ss.uids.length - 1] : null;
    const last = lastUid ? registry.get(lastUid) : undefined;

    if (pinned && sameSession(pinned, now, config)) {
      const result = await appendToUnit({ registry, config, meta: pinned, input, now, pinned: true });
      return { ...result, unitUid: pinned.uid };
    }

    if (last && last.uid !== pinned?.uid && sameSession(last, now, config) && isAppendableOnce(last)) {
      const result = await appendToUnit({ registry, config, meta: last, input, now, pinned: false });
      if (sessionId) {
        const patch = { uids: [...new Set([...(ss.uids ?? []), result.meta.uid])] };
        // `pin` 分支也要固定：否则「第一次保存恰好可追加」会把 /hdm-remember 的固定意图吞掉。
        if (pin) {
          patch.memoryUid = result.meta.uid;
          patch.pinConversation = true;
        }
        await state.updateSession(sessionId, patch);
      }
      return { ...result, unitUid: last.uid };
    }

    const created = await createMemory({ registry, config, home, input, session, now });
    if (sessionId) {
      const patch = { uids: [...new Set([...(ss.uids ?? []), created.meta.uid])] };
      if (pin || ss?.pinConversation) {
        patch.memoryUid = created.meta.uid;
        patch.pinConversation = true;
      }
      await state.updateSession(sessionId, patch);
    }
    return { ...created, merged: false, unitUid: created.meta.uid };
  });
}

/** 让会话固定到某个单元（`/hdm-remember` 与自动整理成功后调用）。 */
export async function pinSessionUnit(state, sessionId, uid) {
  if (!sessionId || !uid) return null;
  const ss = state.getSession(sessionId);
  const uids = [...new Set([...(ss.uids ?? []), String(uid)])];
  return state.updateSession(sessionId, { uids, memoryUid: String(uid), pinConversation: true });
}

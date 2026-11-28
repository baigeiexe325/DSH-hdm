// HDM sequential snapshot forgetting: day2 L2->L1, day5 L1->L0, old snapshots frozen.
// Exemption tiers (delay / auto immortal), manual targets, LLM compression with deterministic
// fallback, a shared file lock (state.js) and jobs.json idempotency. Standalone: node:* +
// ./llm.js + ./paths.js + ./state.js; memory.js is loaded lazily and can be injected (`memory`)
// so maintenance works before T1 lands.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, daysBetween, localDate } from "./paths.js";
import { acquireFileLock } from "./state.js";
import { hasLlmStream, maintenanceLimits, resolveMaintenanceModel, streamText } from "./llm.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FORGET_DAYS = [2, 5];
const DEFAULT_TZ = "Asia/Shanghai";

function clip(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : max <= 1 ? "…" : `${value.slice(0, max - 1)}…`;
}

function exempt(reason) {
  return {
    exempt: true,
    immortal: reason === "immortal" || reason === "importance" || reason === "recall",
    reason,
  };
}

/**
 * Exemption decision for one memory. Tiered mode: delay (3~5 hits within 14d),
 * auto immortal (>=6 hits within 30d), importance >= immortalImportance, or meta.immortal.
 */
export function isExempt(meta, config, now = Date.now()) {
  const rules = config?.forget || {};
  const hits = Math.max(0, Number(meta?.hitCount) || 0);
  const lastHitAt = Number.isFinite(Number(meta?.lastHitAt)) ? Number(meta.lastHitAt) : null;
  const recent = (days) => lastHitAt != null && now - lastHitAt >= 0 && now - lastHitAt <= days * DAY_MS;
  const respectImmortal = rules.respectImmortal !== false;

  if (meta?.immortal) {
    return respectImmortal
      ? exempt("immortal")
      : { exempt: false, immortal: true, reason: "immortal-overridden" };
  }

  const importance = Number(meta?.importance) || 0;
  const immortalImportance = Number(rules.immortalImportance ?? 5);
  if (immortalImportance > 0 && importance >= immortalImportance) return exempt("importance");

  const mode = String(rules.exemptMode || "tiered").toLowerCase();
  const immortalCount = Number(rules.autoImmortalRecallCount ?? 6);
  const immortalWindow = Number(rules.autoImmortalWindowDays ?? 30);
  const delayCount = Number(rules.exemptRecallCount ?? 3);
  const delayWindow = Number(rules.exemptWindowDays ?? 14);

  if (mode === "tiered" && hits >= immortalCount && recent(immortalWindow)) return exempt("recall");
  if ((mode === "tiered" || mode === "delay")
    && hits >= delayCount && hits < immortalCount && recent(delayWindow)) return exempt("delay");
  if (mode === "skip" && hits >= 1 && recent(delayWindow)) return exempt("delay");

  return { exempt: false, immortal: false, reason: "none" };
}

async function loadMemoryModule() {
  try {
    return await import("./memory.js");
  } catch {
    return null;
  }
}

/**
 * 纯函数：算出本轮要写入 jobs 的字段（lastForgetAt + 本轮结果 + 成功项的 d2/d5 标记）。
 * `lastForget` 供 `/hdm` 展示最近一次巡检的时间与结果（手动命令改后台执行后，用户只能从这里看）。
 */
function buildJobsPatch(processed, now, currentForgetDone, extra = {}) {
  const forgetDone = currentForgetDone && typeof currentForgetDone === "object" && !Array.isArray(currentForgetDone)
    ? { ...currentForgetDone }
    : {};
  for (const item of processed) {
    if (!item.ok) continue;
    const done = forgetDone[item.uid] && typeof forgetDone[item.uid] === "object"
      ? { ...forgetDone[item.uid] }
      : {};
    if (item.level === 1) done.d2 = now;
    if (item.level === 0) done.d5 = now;
    forgetDone[item.uid] = done;
  }
  const okCount = processed.filter((item) => item.ok).length;
  return {
    lastForgetAt: now,
    lastForget: {
      at: now,
      target: extra.target ?? "due",
      processed: processed.length,
      ok: okCount,
      failed: processed.length - okCount,
      skipped: extra.skipped === true,
      reason: extra.reason ?? null,
    },
    forgetDone,
  };
}

/** 读 state/jobs.json 的 jobs 层；旧文件把字段写在顶层时兼容读取。 */
async function readJobsFile(home) {
  const file = path.join(home, "state", "jobs.json");
  let payload = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    payload = {};
  }
  const nested = payload.jobs;
  const jobs = nested && typeof nested === "object" && !Array.isArray(nested) ? { ...nested } : { ...payload };
  delete jobs.version;
  delete jobs.updatedAt;
  delete jobs.jobs;
  return jobs;
}

/** 独立调用（测试/脚本）：直写 jobs.json，保留文件里其它字段。 */
async function recordJobs(home, jobs, patch) {
  // 与 StateStore 统一成同一层结构：{ version, updatedAt, jobs: {...} }。
  // 否则 StateStore 下一次 save() 用内存 jobs 覆盖文件时，d2/d5 标记会被抹掉。
  const merged = { ...jobs, ...patch };
  await atomicWrite(
    path.join(home, "state", "jobs.json"),
    `${JSON.stringify({ version: 1, updatedAt: patch.lastForgetAt, jobs: merged }, null, 2)}\n`,
  );
}

/**
 * 落盘本轮 jobs：有 StateStore 时走 updateJobs（同一份内存 jobs，之后 save() 不会回写旧值），
 * 没有 StateStore（测试/独立调用）时保留直写文件的行为。
 */
async function persistJobs({ state, home, processed, now, extra }) {
  if (state && typeof state.updateJobs === "function") {
    const jobs = typeof state.getJobs === "function" ? state.getJobs() : null;
    await state.updateJobs(buildJobsPatch(processed, now, jobs?.forgetDone, extra));
    return;
  }
  const jobs = await readJobsFile(home);
  await recordJobs(home, jobs, buildJobsPatch(processed, now, jobs.forgetDone, extra));
}

async function persistMeta({ registry, meta }) {
  if (!meta) return;
  if (typeof registry?.upsert === "function") {
    try {
      await registry.upsert(meta);
    } catch {
      // index update is best effort; the meta.json write below is the source of truth
    }
  }
  if (!meta.folder) return;
  try {
    const info = await stat(meta.folder);
    if (!info.isDirectory()) return;
    await atomicWrite(path.join(meta.folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // folder renamed/missing: next pass repairs via meta.json on disk
  }
}

async function promoteImmortal({ registry, meta, reason }) {
  if (meta.immortal) return;
  if (!["importance", "recall"].includes(reason)) return;
  meta.immortal = true;
  meta.immortalReason = reason === "importance" ? "auto: importance" : "auto: recall count";
  await persistMeta({ registry, meta });
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(raw);
  } catch {
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function summarizeWithLlm({ ctx, config, model, targetLevel, text }) {
  const summaryLimit = targetLevel === 1 ? 200 : 120;
  const detailLimit = targetLevel === 1 ? 3 : 0;
  const system = [
    "你是记忆压缩器。把输入快照压缩成 JSON，只输出 JSON，不要解释，不要编造。",
    `格式：{"summary":"不超过${summaryLimit}字的中文摘要","details":[${detailLimit ? `最多${detailLimit}条要点` : ""}]}`,
    detailLimit ? "" : "details 必须为空数组。",
  ].join("\n");
  const limits = maintenanceLimits(config);
  const raw = await streamText(ctx, model, {
    maxTokens: limits.maxTokens,
    maxMs: limits.timeoutMs,
    system,
    messages: [{ role: "user", content: text }],
  });
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("forget: invalid llm json");
  }
  const details = Array.isArray(parsed.details)
    ? parsed.details
      .filter((detail) => typeof detail === "string" || typeof detail === "number")
      .map(String)
      .slice(0, detailLimit)
      .map((detail) => clip(detail, 300))
    : [];
  return { summary: clip(parsed.summary.trim(), summaryLimit), details };
}

async function readSnapshotText(home, meta, level, memory) {
  if (typeof memory?.readSnapshot === "function") {
    const snapshot = await memory.readSnapshot(meta, level);
    if (snapshot && typeof snapshot.text === "string" && snapshot.text) return snapshot.text;
  }
  const folder = meta?.folder || path.join(home, "memory", String(meta?.date || ""), String(meta?.label || ""));
  return readFile(path.join(folder, `level${level}.txt`), "utf8");
}

async function deriveLevel({ ctx, config, memory, meta, level, home, force }) {
  const sourceLevel = level === 1 ? 2 : 1;
  let text = "";
  try {
    text = await readSnapshotText(home, meta, sourceLevel, memory);
  } catch {
    text = "";
  }

  let llm = null;
  if (text && hasLlmStream(ctx)) {
    try {
      const model = await resolveMaintenanceModel(ctx, config);
      if (model) llm = await summarizeWithLlm({ ctx, config, model, targetLevel: level, text });
    } catch {
      llm = null;
    }
  }

  const opts = {};
  // force 只表示「允许压缩 immortal 记忆」，与重派生的 overwrite 语义无关。
  if (force === true) opts.force = true;
  if (llm?.summary) opts.llmSummary = llm.summary;
  if (Array.isArray(llm?.details)) opts.llmDetails = llm.details;
  const data = memory.deriveSnapshotData(meta, level, opts);

  // Guarantee the model result is used even if a memory module ignores opts.
  if (llm) {
    data.summary = clip(llm.summary, level === 1 ? 200 : 120);
    if (level === 1) data.details = llm.details.slice(0, 3).map((detail) => clip(detail, 300));
    else data.details = [];
    data.quotes = [];
  }
  return data;
}

/**
 * 本轮要派的档位。needsRederive 优先于年龄判定：
 * 1 = 刷新 L1（已有 L0 时连 L0 一起），0 = 只刷新 L0。
 * 返回 { level, overwrite }，overwrite 表示目标档已存在、需要覆盖重写。
 */
function desiredLevels(meta, forgetDays, age) {
  const day2 = Number(forgetDays[0] ?? DEFAULT_FORGET_DAYS[0]);
  const day5 = Number(forgetDays[1] ?? DEFAULT_FORGET_DAYS[1]);
  const snapshots = Array.isArray(meta?.snapshots) ? meta.snapshots.map(Number) : [];
  const levels = [];
  const hasL1 = snapshots.includes(1);
  const hasL0 = snapshots.includes(0);
  const forget = meta?.forget || {};
  const rederive = meta?.needsRederive;

  if (rederive === 1) {
    levels.push({ level: 1, overwrite: hasL1 });
    // L0 是从 L1 派生的，L1 变了就必须跟着刷新。
    if (hasL0) levels.push({ level: 0, overwrite: true });
    return levels;
  }
  if (rederive === 0 && hasL1) return [{ level: 0, overwrite: hasL0 }];

  if (!Number.isFinite(age)) return levels;
  if (age >= day2 && !hasL1 && !forget.d2) levels.push({ level: 1, overwrite: false });
  if (age >= day5 && !hasL0 && !forget.d5 && (hasL1 || levels.some((item) => item.level === 1))) {
    levels.push({ level: 0, overwrite: false });
  }
  return levels;
}

async function processMemory({ ctx, home, config, registry, memory, today, rules, forgetDays, target, now, meta }) {
  const processed = [];
  const explicit = target !== "due";
  const respectful = rules.respectImmortal !== false;
  // 关掉 respectImmortal 时允许压缩 immortal：需要 force 才能过 memory.js 的闸门。
  const force = rules.respectImmortal === false;
  // paths.daysBetween 遇到非法日期会抛错；巡检不能因此整轮失败，收敛成 NaN（坏日期不派生）。
  let age = Number.NaN;
  try {
    age = daysBetween(meta?.date, today);
  } catch {
    age = Number.NaN;
  }
  const decision = isExempt(meta, config, now);

  if (decision.reason === "importance" || decision.reason === "recall") {
    await promoteImmortal({ registry, meta, reason: decision.reason });
  }
  if (respectful && (decision.immortal || (decision.exempt && !explicit))) return processed;

  const rederive = meta?.needsRederive;
  const plan = desiredLevels(meta, forgetDays, age);
  const wantsL0 = plan.some((item) => item.level === 0);
  let current = meta;
  for (const { level, overwrite } of plan) {
    try {
      const data = await deriveLevel({ ctx, config, memory, meta: current, level, home, force });
      // 常规派生不传 options；重派生才带 overwrite:true 覆盖已有档。
      const committed = await memory.commitDerivedSnapshot(
        { registry, meta: current, data, now },
        overwrite ? { overwrite: true } : undefined,
      );
      const next = committed || current;
      next.forget = next.forget && typeof next.forget === "object" ? next.forget : { d2: null, d5: null };
      if (level === 1) next.forget.d2 = now;
      if (level === 0) next.forget.d5 = now;
      if (rederive === 0 || rederive === 1) {
        // L0 是链尾：刷完就清空；L1 刷完但还有 L0 待刷时降为 0，等下一轮（或本轮）收尾。
        next.needsRederive = level === 0 ? null : (wantsL0 ? 0 : null);
      }
      await persistMeta({ registry, meta: next });
      current = next;
      processed.push({ uid: current.uid || meta.uid, level, ok: true });
    } catch (error) {
      processed.push({
        uid: current.uid || meta.uid,
        level,
        ok: false,
        error: String(error?.message || error),
      });
      break;
    }
  }
  return processed;
}

function selectMemories(memories, target) {
  if (!target || target === "due" || target === "all") return memories;
  const wanted = String(target);
  return memories.filter((meta) => meta?.uid === wanted);
}

/**
 * One forgetting sweep. target: "due" (scheduled), "all" (manual sweep), or a uid (manual).
 * Returns the level transitions actually attempted.
 */
export async function runForgetPass({
  ctx,
  home,
  config,
  registry,
  target = "due",
  now = Date.now(),
  memory,
  state,
  // 手动触发（含后台执行的 `/hdm-forget`）：0 条也写 lastForget，供 `/hdm` 展示。
  recordEmpty = false,
} = {}) {
  if (!home || config?.forget?.enabled === false) return { processed: [] };
  const memoryModule = memory || await loadMemoryModule();
  // 与 state.js 共用一套文件锁（锁文件名仍是 `.lock-forget`）；拿不到锁就本轮跳过。
  const release = await acquireFileLock(home, "forget", LOCK_TTL_MS).catch(() => null);
  // 锁被定时巡检/上一轮后台任务占用：明确告诉调用方本轮跳过，而不是假装「处理 0 条」。
  if (!release) return { processed: [], skipped: true, reason: "locked" };

  const processed = [];
  try {
    const zone = config?.timeZone || DEFAULT_TZ;
    // 非法时区回退默认时区；巡检不应因配置写错而整轮失败。
    let today;
    try {
      today = localDate(now, zone);
    } catch {
      today = localDate(now);
    }
    const rules = config?.forget || {};
    const forgetDays = Array.isArray(rules.days) && rules.days.length
      ? rules.days.map(Number).sort((left, right) => left - right)
      : DEFAULT_FORGET_DAYS;
    const listed = await registry?.list?.();
    const memories = Array.isArray(listed) ? listed : [];

    for (const meta of selectMemories(memories, target)) {
      if (!meta) continue;
      if (!memoryModule) {
        processed.push({ uid: meta.uid, level: 0, ok: false, error: "memory module unavailable" });
        continue;
      }
      try {
        const result = await processMemory({
          ctx, home, config, registry, memory: memoryModule,
          today, rules, forgetDays, target, now, meta,
        });
        processed.push(...result);
      } catch (error) {
        processed.push({ uid: meta.uid, level: 0, ok: false, error: String(error?.message || error) });
      }
    }

    // 手动命令（后台执行）即便本轮 0 条也记一次 lastForgetAt/lastForget：`/hdm` 的「最近遗忘」要有时间与结果。
    // 定时巡检 0 条时不写盘，避免在没有任何变更时反复重写 jobs.json（也与旧行为一致）。
    if (processed.length || recordEmpty) await persistJobs({ state, home, processed, now, extra: { target, recordEmpty } });
  } finally {
    await release();
  }
  return { processed };
}

// 进程内单实例：同一个母文件夹连点 `/hdm-forget` 只排一次后台巡检（跨进程仍靠上面的文件锁互斥）。
const backgroundForget = new Map();

function forgetKey(home) {
  return path.resolve(home ?? ".");
}

/**
 * 手动 `/hdm-forget` 用：排一次后台巡检并立即返回，不阻塞命令。
 * `now` 在入队时固定：测试用「未来时钟」时，后台任务仍按入队时刻算记忆年龄。
 * @returns {{queued: true, task: Promise<object>} | {queued: false, reason: string}}
 */
export function scheduleForgetPass(options = {}) {
  const { ctx, home, config } = options;
  if (!home || config?.forget?.enabled === false) return { queued: false, reason: "disabled" };
  const key = forgetKey(home);
  if (backgroundForget.has(key)) return { queued: false, reason: "running" };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const task = runForgetPass({ ...options, now, recordEmpty: true })
    .catch((error) => {
      ctx?.logger?.warn?.(`[hdm] 后台遗忘巡检失败: ${error instanceof Error ? error.message : String(error)}`);
      return { processed: [], skipped: true, reason: "error" };
    })
    .finally(() => {
      if (backgroundForget.get(key) === task) backgroundForget.delete(key);
    });
  backgroundForget.set(key, task);
  task
    .then((result) => {
      const okCount = (result?.processed ?? []).filter((item) => item.ok).length;
      ctx?.logger?.info?.(
        `[hdm] 后台遗忘巡检完成：处理 ${result?.processed?.length ?? 0} 条，成功 ${okCount} 条${
          result?.skipped ? `（跳过：${result.reason ?? "locked"}）` : ""
        }`,
      );
    })
    .catch(() => undefined);
  return { queued: true, task };
}

/** 测试/关停用：等后台巡检跑完（给 home 只等那一个文件夹，省略则等全部）。 */
export function waitForBackgroundForget(home) {
  if (home === undefined) {
    const pending = [...backgroundForget.values()];
    return pending.length ? Promise.all(pending) : Promise.resolve([]);
  }
  return backgroundForget.get(forgetKey(home)) ?? Promise.resolve({ processed: [] });
}

/** Scheduled check every forget.checkHours; start with one catch-up sweep. */
export function startForgetTimer({ ctx, home, config, registry, memory, state } = {}) {
  if (!home || config?.forget?.enabled === false) return () => {};
  const hoursRaw = Number(config?.forget?.checkHours ?? 6);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 6;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runForgetPass({ ctx, home, config, registry, memory, state, target: "due", now: Date.now() });
    } catch (error) {
      ctx?.logger?.warn?.(`hdm forget tick failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  };

  const runTick = () => {
    // tick 自身已兜底 try/catch；这里再挂 catch，避免任何漏网拒绝成为未处理拒绝。
    tick().catch((error) => ctx?.logger?.warn?.(`hdm forget tick failed: ${error?.message || error}`));
  };
  const timer = setInterval(runTick, hours * 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  runTick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

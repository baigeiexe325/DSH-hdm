// IAM 与人物档案的定期压缩：每 6 小时用维护模型把 IAM.md / characters/*.md 写短一点。
//
// 为什么单独一个文件：gist/forget 管的是记忆快照，IAM 与人物档案是「长期身份与关系」，
// 压缩原则（同义替换、同方面合并、保留全部节）与快照摘要完全不同，混进 gist 会互相牵制。
//
// 规则（见 prompts/zh/profile-compact.md）：
// - 只压缩、不改事实：标题与节结构必须完全保留，日期前缀与证据/置信度标注必须保留；
// - 校验不过（缺节、串味、变长）就整轮放弃，绝不写盘；
// - 写盘前 snapshotIfChanged 先备份，与其它写入路径一致。

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHARACTER_SECTIONS, characterPath } from "./characters.js";
import { PLACEHOLDER_RE, REQUIRED_SECTIONS, extractSections, lintIamDocument } from "./iam.js";
import { hasLlmStream, maintenanceLimits, resolveMaintenanceModel, streamText } from "./llm.js";
import { atomicWrite } from "./paths.js";
import { loadPrompt } from "./prompts.js";
import { acquireFileLock } from "./state.js";
import { snapshotIfChanged } from "./backup.js";

const LOCK_TTL_MS = 10 * 60 * 1000;
// 一轮最多处理 6 个档案（IAM + USER + 4 个其它人物）：控制单次维护的模型调用量与时长。
const MAX_TARGETS = 6;
// 首轮延迟 5 分钟：启动瞬间 gist/遗忘/索引重建都在抢维护模型，先错开；
// 又不能等满一个间隔——进程经常重启，等满间隔等于永远不跑。
const FIRST_DELAY_MS = 5 * 60 * 1000;
// 人物档案模板自带「记忆索引」，不在固定四节里，但压缩时必须原样保留。
const CHARACTER_EXTRA_SECTIONS = Object.freeze(["记忆索引"]);

export const PROFILE_COMPACT_DEFAULTS = Object.freeze({
  enabled: true,
  hours: 6,
  maxChars: 4000,
  maxTokens: 4000,
  minIntervalMinutes: 60,
});

/** 配置段可能不存在（config.js 的 C 阶段才加），统一按默认值兜底。 */
function sectionOf(config) {
  const raw = config?.profileCompact;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 压缩间隔（分钟）：hours 换算后不低于 minIntervalMinutes，避免配得过小反复烧模型。 */
function compactIntervalMinutes(config) {
  const section = sectionOf(config);
  const hours = positiveNumber(section.hours, PROFILE_COMPACT_DEFAULTS.hours);
  const floor = positiveNumber(section.minIntervalMinutes, PROFILE_COMPACT_DEFAULTS.minIntervalMinutes);
  return Math.max(hours * 60, floor);
}

/**
 * 读 jobs 层。优先 StateStore 的内存副本，其次旧 API，最后直接读 state/jobs.json。
 * 与 forget.js 的 readJobsFile 同构：兼容 `{ jobs: {...} }` 与字段平铺的旧文件。
 */
function jobsOf({ state, home }) {
  try {
    if (typeof state?.getJobs === "function") {
      const jobs = state.getJobs();
      if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) return jobs;
    }
  } catch {
    // 读不到就走文件
  }
  try {
    if (typeof state?.readJobs === "function") {
      const jobs = state.readJobs();
      // readJobs 若返回 Promise 就无法同步取，退回文件。
      if (jobs && typeof jobs === "object" && typeof jobs.then !== "function") return jobs;
    }
  } catch {
    // 读不到就走文件
  }
  try {
    const payload = JSON.parse(readFileSync(path.join(home, "state", "jobs.json"), "utf8"));
    const nested = payload && typeof payload === "object" ? payload.jobs : null;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
  } catch {
    // 没有 jobs.json 视为从未压缩
  }
  return {};
}

/**
 * 是否到压缩时间。
 * @returns {{ due:boolean, reason:string, lastAt:number|null, nextAt:number|null, intervalMinutes:number }}
 */
export function shouldCompactProfiles({ home, state, config, now = Date.now() } = {}) {
  const section = sectionOf(config);
  const intervalMinutes = compactIntervalMinutes(config);
  const base = { lastAt: null, nextAt: null, intervalMinutes };
  if (section.enabled === false) return { due: false, reason: "disabled", ...base };

  const jobs = home ? jobsOf({ state, home }) : {};
  const lastAt = Number(jobs?.lastProfileCompactAt);
  base.lastAt = Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null;
  const intervalMs = intervalMinutes * 60 * 1000;
  if (base.lastAt != null) {
    base.nextAt = base.lastAt + intervalMs;
    if (now - base.lastAt < intervalMs) return { due: false, reason: "interval", ...base };
  }
  return { due: true, reason: "due", ...base };
}

/** 带层级的标题列表：level 1 是文档标题，level ≥ 2 才是节。 */
function headingList(text) {
  const src = String(text ?? "");
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  const rows = [];
  let match;
  while ((match = re.exec(src))) {
    rows.push({ level: match[1].length, title: match[2].trim(), start: match.index, bodyStart: re.lastIndex });
  }
  return rows;
}

/** 拆成 { title, body }，body 为到下一个标题前的正文。 */
function sectionEntries(text) {
  const src = String(text ?? "");
  const rows = headingList(src);
  return rows.map((row, index) => {
    const end = index + 1 < rows.length ? rows[index + 1].start : src.length;
    return { level: row.level, title: row.title, body: src.slice(row.bodyStart, end).trim() };
  });
}

/**
 * IAM 校验：固定节一个不少且正文非空（整行占位等于空），再逐节过 lintIamContent
 * （点数/字数/路径/串味/年份）。lintIamContent 对空正文返回空数组，所以空节必须自己拦。
 */
function validateIam(after, before) {
  const errors = [];
  const sections = extractSections(after);
  const beforeSections = extractSections(before);
  const missing = REQUIRED_SECTIONS.filter((title) => !Object.prototype.hasOwnProperty.call(sections, title));
  if (missing.length) errors.push(`缺少固定节：${missing.join("、")}`);
  for (const title of REQUIRED_SECTIONS) {
    // 「记忆索引」由 syncIamIndex 整节维护：压缩不该要求它有正文，也不该替它补内容。
    if (title === "记忆索引" || missing.includes(title)) continue;
    if (iamBodyHasContent(sections[title])) continue;
    // 压缩前有点数、压缩后为 0：等于静默删事实，和缺节一样必须拦。
    const hadContent = iamBodyHasContent(beforeSections[title]);
    errors.push(`§${title}：正文为空或只剩占位${hadContent ? "（压缩前有正文）" : ""}`);
  }
  errors.push(...lintIamDocument(after));
  return [...new Set(errors)];
}

/** 节正文是否有实际内容：整行占位（（待补充）/（暂无））不算。 */
function iamBodyHasContent(body) {
  const lines = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  return lines.some((line) => !PLACEHOLDER_RE.test(line));
}

/**
 * 人物档案校验：节标题必须在固定四节（外加模板自带的「记忆索引」）内且非空；
 * 原来有的节不能在压缩后消失，否则就是把节结构改了。
 */
function validateCharacter(before, after) {
  const errors = [];
  const allowed = new Set([...CHARACTER_SECTIONS, ...CHARACTER_EXTRA_SECTIONS]);
  const afterSections = sectionEntries(after).filter((row) => row.level >= 2);
  if (!afterSections.length) errors.push("没有任何节");
  for (const row of afterSections) {
    if (!allowed.has(row.title)) {
      errors.push(`§${row.title}：不属于固定节（${CHARACTER_SECTIONS.join(" / ")}）`);
      continue;
    }
    if (!row.body) errors.push(`§${row.title}：节内容为空`);
  }
  const beforeTitles = new Set(
    sectionEntries(before).filter((row) => row.level >= 2).map((row) => row.title),
  );
  for (const title of beforeTitles) {
    if (!allowed.has(title)) continue;
    if (!afterSections.some((row) => row.title === title)) errors.push(`§${title}：压缩后丢失`);
  }
  return [...new Set(errors)];
}

/** 模型偶尔无视「不要围栏」，剥掉首尾代码围栏再校验。 */
function unwrapFence(text) {
  return String(text ?? "")
    .replace(/^\s*```[^\n]*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

async function defaultGenerate({ ctx, config, target, text }) {
  // 没有维护模型时抛错，让 runProfileCompactPass 记 failed，而不是静默跳过后假装成功。
  if (!hasLlmStream(ctx)) throw new Error("维护模型不可用（ctx 没有 llm.stream）");
  const model = await resolveMaintenanceModel(ctx, config);
  if (!model) throw new Error("没有可用的维护模型");
  const limits = maintenanceLimits(config);
  const section = sectionOf(config);
  const maxChars = positiveNumber(section.maxChars, PROFILE_COMPACT_DEFAULTS.maxChars);
  const maxTokens = positiveNumber(section.maxTokens, PROFILE_COMPACT_DEFAULTS.maxTokens);
  const label = target?.kind === "iam" ? "IAM 自传体记忆" : `人物档案（${target?.name ?? "USER"}）`;
  return streamText(ctx, model, {
    system: loadPrompt("profile-compact", config?.promptLang ?? "zh"),
    messages: [
      {
        role: "user",
        content: `档案类型：${label}\n压缩后总长不超过 ${maxChars} 字，优先压到原文一半以内。\n\n${text}`,
      },
    ],
    maxTokens: Math.min(maxTokens, limits.maxTokens),
    maxMs: limits.timeoutMs,
  });
}

/**
 * 压缩一个档案。返回 { ok, kind, name, path, charsBefore, charsAfter, backup } 或
 * { ok:false, reason, errors?, error? }；reason ∈ lint/longer/model/empty-output/missing/empty/unchanged/changed。
 * generate/snapshot 可注入，测试不必真调 LLM 与备份。
 */
export async function compactOneProfile({
  ctx,
  home,
  config,
  target,
  now = Date.now(),
  generate = defaultGenerate,
  snapshot = snapshotIfChanged,
} = {}) {
  const kind = target?.kind === "character" ? "character" : "iam";
  const name = kind === "iam" ? "IAM" : String(target?.name ?? "USER");
  const file = target?.path || (kind === "iam" ? path.join(home, "IAM.md") : characterPath(home, name));
  const base = { kind, name, path: file };
  if (!home || !file) return { ok: false, reason: "missing", ...base };

  let before = "";
  try {
    before = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, reason: "missing", ...base };
  }
  if (!String(before).trim()) return { ok: false, reason: "empty", ...base };

  let raw;
  try {
    raw = await generate({ ctx, config, target: { kind, name, path: file }, text: before, now });
  } catch (error) {
    return { ok: false, reason: "model", error: error instanceof Error ? error.message : String(error), ...base };
  }

  const body = unwrapFence(raw);
  if (!body) return { ok: false, reason: "empty-output", ...base };

  const errors = kind === "iam" ? validateIam(body, before) : validateCharacter(before, body);
  if (errors.length) return { ok: false, reason: "lint", errors, ...base };

  const original = String(before).trim();
  const charsBefore = original.length;
  const charsAfter = body.length;
  // 「总长只减不增」：变长就说明模型在改写而不是压缩，宁可放弃这一轮。
  if (charsAfter > charsBefore) return { ok: false, reason: "longer", charsBefore, charsAfter, ...base };
  if (body === original) return { ok: false, reason: "unchanged", ...base };

  // 备份在写盘前：快照抓的是压缩前的版本，回滚才有意义；备份失败不阻断压缩。
  let backup = null;
  try {
    backup = await snapshot({ home, config, reason: "profile-compact" });
  } catch (error) {
    backup = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // CAS：模型生成期间 hdm_iam_update / hdm_character_update 可能已经改过档案。
  // 直接写回会用旧快照盖掉这些更新，所以写盘前重读比对，不一致就放弃本轮（不落盘）。
  let current = null;
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, reason: "changed", ...base };
  }
  if (current !== before) return { ok: false, reason: "changed", ...base };

  await atomicWrite(file, `${body}\n`);
  return { ok: true, charsBefore, charsAfter, backup, ...base };
}

/** 本轮目标：IAM、USER 必做；其它人物按文件大小降序补到 MAX_TARGETS。 */
async function collectTargets(home) {
  const targets = [
    { kind: "iam", name: "IAM", path: path.join(home, "IAM.md") },
    { kind: "character", name: "USER", path: characterPath(home, "USER") },
  ];
  const dir = path.join(home, "characters");
  let names = [];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && entry.name.toLowerCase() !== "user.md")
      .map((entry) => entry.name);
  } catch {
    names = [];
  }
  const others = [];
  for (const fileName of names) {
    const full = path.join(dir, fileName);
    const info = await fs.stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    others.push({ name: fileName.replace(/\.md$/i, ""), path: full, size: info.size });
  }
  others.sort((left, right) => right.size - left.size);
  for (const row of others.slice(0, Math.max(0, MAX_TARGETS - targets.length))) {
    targets.push({ kind: "character", name: row.name, path: row.path });
  }
  return targets;
}

/** 落盘 jobs：有 StateStore 走 updateJobs（同一份内存 jobs，之后 save() 不会回写旧值）。 */
async function persistCompactJobs({ state, home, patch }) {
  if (!patch || !Object.keys(patch).length) return;
  if (state && typeof state.updateJobs === "function") {
    await state.updateJobs(patch);
    return;
  }
  const file = path.join(home, "state", "jobs.json");
  let jobs = {};
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    const nested = payload && typeof payload === "object" ? payload.jobs : null;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) jobs = nested;
    else if (payload && typeof payload === "object" && !Array.isArray(payload)) jobs = payload;
  } catch {
    jobs = {};
  }
  await atomicWrite(
    file,
    `${JSON.stringify({ version: 1, updatedAt: patch.lastProfileCompactAt ?? Date.now(), jobs: { ...jobs, ...patch } }, null, 2)}\n`,
  );
}

/**
 * 一轮压缩：IAM + USER（+ 其它人物）。interval 未到且非 force 时整轮跳过；
 * 拿不到文件锁也跳过（另一个进程正在压）。返回 { compacted, failed, skipped }。
 */
export async function runProfileCompactPass({
  ctx,
  home,
  config,
  state,
  now = Date.now(),
  force = false,
  generate,
  snapshot,
} = {}) {
  const result = { compacted: [], failed: [], skipped: [] };
  if (!home) return result;

  const decision = shouldCompactProfiles({ home, state, config, now });
  if (!force && !decision.due) {
    result.skipped.push({ kind: "all", name: "*", reason: decision.reason });
    return result;
  }

  const release = await acquireFileLock(home, "profile-compact", LOCK_TTL_MS).catch(() => null);
  if (!release) {
    result.skipped.push({ kind: "all", name: "*", reason: "locked" });
    return result;
  }

  try {
    for (const target of await collectTargets(home)) {
      let one;
      try {
        one = await compactOneProfile({ ctx, home, config, target, now, generate, snapshot });
      } catch (error) {
        result.failed.push({
          kind: target.kind,
          name: target.name,
          reason: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const row = { kind: one.kind, name: one.name };
      if (one.ok) {
        result.compacted.push({ ...row, path: one.path, charsBefore: one.charsBefore, charsAfter: one.charsAfter });
      } else if (["missing", "empty", "unchanged", "changed"].includes(one.reason)) {
        result.skipped.push({ ...row, reason: one.reason });
      } else {
        result.failed.push({ ...row, reason: one.reason, errors: one.errors, error: one.error });
      }
    }

    // 只有真的压成功才记时间戳，模型整天不可用时下个 tick 还能重试；
    // 全失败只留一条错误，供 /hdm 诊断。
    const patch = {};
    if (result.compacted.length) {
      patch.lastProfileCompactAt = now;
      patch.lastProfileCompactError = null;
    } else if (result.failed.length) {
      const first = result.failed[0];
      patch.lastProfileCompactError = `${first.name}: ${first.reason}`.slice(0, 300);
    }
    await persistCompactJobs({ state, home, patch });
  } finally {
    await release();
  }
  return result;
}

/**
 * 每 config.profileCompact.hours 小时跑一轮（默认 6）。
 * 首轮延迟 5 分钟而非立即跑：避开启动期 gist/遗忘/索引的模型争用，也不至于等满 6 小时。
 */
export function startProfileCompactTimer({ ctx, home, config, state, generate } = {}) {
  if (!home) return () => {};
  const section = sectionOf(config);
  if (section.enabled === false) return () => {};
  const hours = positiveNumber(section.hours, PROFILE_COMPACT_DEFAULTS.hours);
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runProfileCompactPass({ ctx, home, config, state, now: Date.now(), generate });
    } catch (error) {
      ctx?.logger?.warn?.(`[hdm] profile compact pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  // 再挂一层 catch，避免任何漏网拒绝成为未处理拒绝。
  const runTick = () => {
    tick().catch((error) => ctx?.logger?.warn?.(`[hdm] profile compact pass failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  const first = setTimeout(runTick, Math.min(FIRST_DELAY_MS, hours * 60 * 60 * 1000));
  first.unref?.();
  const timer = setInterval(runTick, hours * 60 * 60 * 1000);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

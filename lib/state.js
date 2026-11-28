// HDM 会话/任务状态（state/sessions.json、state/jobs.json）+ 进程内互斥与 best-effort 文件锁。
// 纯 ESM；只使用 Node 内置模块。

import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, ensureDir, slug } from "./paths.js";

/** 锁文件创建后的保护期：这段时间内即使内容读不出，也视为「持有者正在写」，不回收。 */
const LOCK_CREATE_GRACE_MS = 2_000;

/** 会话状态默认值。 */
export const DEFAULT_SESSION = Object.freeze({
  uids: Object.freeze([]),
  lastSaveRatio: null,
  remindedBands: Object.freeze([]),
  iamInjected: false,
  handoffUid: null,
  lastMemoryToolAt: null,
  userTurnsSinceMemory: 0,
  nudges: 0,
  recalledUids: Object.freeze([]),
  // 跨会话共享已注入过的记忆 uid（去重，最新 200）。
  sharedUids: Object.freeze([]),
  // 其它会话 save 后压好的一句 gist，等本会话「上一步已思考完」时再插入。
  // 上一步是工具调用时只置 pendingSharing，条目留在队列等下一轮（按 uid 去重，最新 maxQueue 条）。
  sharingQueue: Object.freeze([]),
  pendingSharing: false,
  sharingDeliveredAt: null,
  // 会话级记忆单元（pin）：本会话固定占用一个 uid，后续记忆都并入它。
  memoryUid: null,
  pinConversation: false,
  // 真实用户发言水位线：lastUserAt 是最后一条真实发言的时间，userMessageCount 是条数。
  // lastOrganizedUserAt 是最近一次空闲整理时消费到的水位（整理前的时间戳），两者不可混用。
  lastUserAt: null,
  lastOrganizedUserAt: null,
  userMessageCount: 0,
  lastOrganizedAt: null,
  idleAttempts: 0,
  lastOrganizeError: null,
  // 有界活跃环：持久化最近的真实用户发言，供进程重启后仍能整理旧会话。
  activity: Object.freeze([]),
  // `/hdm-remember` 登记：命令只登记，内容由对话智能体在下一步生成并 pin。
  pendingRememberAt: null,
  pendingRememberHintAt: null,
  // 分级检索：lastUserQuery 是最近一条真实用户发言（L2 续步拿它当检索词），
  // recallTurn 记住本轮已自动召回过，避免同轮重复注入。
  lastUserQuery: null,
  recallTurn: null,
  subagentRecalled: false,
  // 压缩：pendingContextReinject 由 compaction/end 置位，下一步重注入 IAM/handoff；
  // pendingCompactMemory 携带压缩前刚写入的那条记忆，供下一步一并返回。
  pendingContextReinject: false,
  pendingCompactMemory: null,
  lastCompactError: null,
});

/** 新建会话状态：从 DEFAULT_SESSION 深拷贝，数组字段各给一份新数组（不共享冻结数组）。 */
function defaultSession() {
  const session = { ...DEFAULT_SESSION };
  for (const [key, value] of Object.entries(DEFAULT_SESSION)) {
    if (Array.isArray(value)) session[key] = [...value];
  }
  return session;
}

function defaultJobs() {
  return {
    lastDiaryDate: null,
    forgetDone: {},
    nextForgetAt: null,
    diaryRunning: false,
    forgetRunning: false,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 可空数值：null/undefined/空串保持 null，避免 Number(null) === 0 把「没有」写成 0。 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSession(input) {
  const session = defaultSession();
  if (!isPlainObject(input)) return session;
  session.uids = Array.isArray(input.uids) ? input.uids.map(String) : [];
  session.lastSaveRatio = numberOrNull(input.lastSaveRatio);
  session.remindedBands = Array.isArray(input.remindedBands)
    ? input.remindedBands.map(Number).filter((value) => Number.isFinite(value))
    : [];
  session.iamInjected = input.iamInjected === true;
  session.handoffUid = input.handoffUid == null ? null : String(input.handoffUid);
  session.lastMemoryToolAt = numberOrNull(input.lastMemoryToolAt);
  session.userTurnsSinceMemory = Number.isFinite(Number(input.userTurnsSinceMemory))
    ? Number(input.userTurnsSinceMemory)
    : 0;
  session.nudges = Number.isFinite(Number(input.nudges)) ? Number(input.nudges) : 0;
  session.recalledUids = Array.isArray(input.recalledUids) ? input.recalledUids.map(String) : [];
  session.sharedUids = Array.isArray(input.sharedUids) ? input.sharedUids.map(String).slice(-200) : [];
  session.sharingQueue = Array.isArray(input.sharingQueue)
    ? input.sharingQueue
        .filter((item) => item && typeof item === "object" && String(item.uid ?? "").trim())
        .map((item) => ({
          uid: String(item.uid).trim(),
          gist: String(item.gist ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
          level: [0, 1, 2].includes(Number(item.level)) ? Number(item.level) : 2,
          fromSession: item.fromSession == null ? null : String(item.fromSession),
          at: numberOrNull(item.at),
        }))
        .slice(-200)
    : [];
  session.pendingSharing = input.pendingSharing === true;
  session.sharingDeliveredAt = numberOrNull(input.sharingDeliveredAt);
  session.memoryUid = input.memoryUid == null || !String(input.memoryUid).trim() ? null : String(input.memoryUid).trim();
  session.pinConversation = input.pinConversation === true;
  session.lastUserAt = numberOrNull(input.lastUserAt);
  session.lastOrganizedUserAt = numberOrNull(input.lastOrganizedUserAt);
  session.activity = Array.isArray(input.activity)
    ? input.activity
        .filter((item) => item && typeof item === "object" && Number.isFinite(Number(item.at)))
        .map((item) => ({ at: Number(item.at), text: String(item.text ?? "").slice(0, 800) }))
        .slice(-20)
    : [];
  session.userMessageCount = Number.isFinite(Number(input.userMessageCount))
    ? Math.max(0, Math.trunc(Number(input.userMessageCount)))
    : 0;
  session.lastOrganizedAt = numberOrNull(input.lastOrganizedAt);
  session.idleAttempts = Number.isFinite(Number(input.idleAttempts)) ? Math.max(0, Math.trunc(Number(input.idleAttempts))) : 0;
  session.lastOrganizeError = input.lastOrganizeError == null ? null : String(input.lastOrganizeError);
  session.pendingRememberAt = numberOrNull(input.pendingRememberAt);
  session.pendingRememberHintAt = numberOrNull(input.pendingRememberHintAt);
  session.lastUserQuery = input.lastUserQuery == null ? null : String(input.lastUserQuery).slice(0, 500);
  session.recallTurn = numberOrNull(input.recallTurn);
  session.subagentRecalled = input.subagentRecalled === true;
  session.pendingContextReinject = input.pendingContextReinject === true;
  session.pendingCompactMemory =
    input.pendingCompactMemory && typeof input.pendingCompactMemory === "object"
      ? {
          uid: input.pendingCompactMemory.uid == null ? null : String(input.pendingCompactMemory.uid),
          summary: String(input.pendingCompactMemory.summary ?? "").slice(0, 1200),
          path: input.pendingCompactMemory.path == null ? null : String(input.pendingCompactMemory.path),
          // 压缩后到下一步之间可能重载插件：这几个字段决定「已保存 / 追加 #N / 未重复写入」的措辞。
          appendCount: numberOrNull(input.pendingCompactMemory.appendCount),
          merged: input.pendingCompactMemory.merged === true,
          deduped: input.pendingCompactMemory.deduped === true,
          wroteAt: numberOrNull(input.pendingCompactMemory.wroteAt),
          ageMs: numberOrNull(input.pendingCompactMemory.ageMs),
        }
      : null;
  session.lastCompactError = input.lastCompactError == null ? null : String(input.lastCompactError).slice(0, 300);
  return session;
}

async function readJson(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 会话/任务状态存储；每次保存均原子写两个文件。 */
export class StateStore {
  constructor(home) {
    if (!home) throw new Error("StateStore 需要母文件夹路径");
    this.home = path.resolve(home);
    this.stateDir = path.join(this.home, "state");
    this.sessionsFile = path.join(this.stateDir, "sessions.json");
    this.jobsFile = path.join(this.stateDir, "jobs.json");
    this.sessions = new Map();
    this.jobs = defaultJobs();
    // 本进程通过 updateJobs 改过的键：save() 与磁盘合并后要重新压回，避免本地改动被磁盘旧值吃掉。
    this.jobsPatch = {};
    // 上次 load/save 时的会话序列化快照：save() 用它判断「本实例改过哪些会话」，
    // 没改过的会话以磁盘为准（别的进程可能刚更新过），改过的用内存值。
    this.sessionsSnapshot = new Map();
  }

  async load() {
    this.sessions.clear();
    this.sessionsSnapshot = new Map();
    this.jobs = defaultJobs();
    this.jobsPatch = {};
    const sessionsPayload = await readJson(this.sessionsFile);
    const rawSessions = isPlainObject(sessionsPayload) ? (sessionsPayload.sessions ?? sessionsPayload) : null;
    if (isPlainObject(rawSessions)) {
      for (const [sessionId, state] of Object.entries(rawSessions)) {
        const id = String(sessionId ?? "").trim();
        if (id) this.sessions.set(id, normalizeSession(state));
      }
    }
    for (const [sessionId, session] of this.sessions) this.sessionsSnapshot.set(sessionId, JSON.stringify(session));
    const jobsPayload = await readJson(this.jobsFile);
    const rawJobs = isPlainObject(jobsPayload) ? (jobsPayload.jobs ?? jobsPayload) : null;
    if (isPlainObject(rawJobs)) this.jobs = { ...defaultJobs(), ...rawJobs };
  }

  /** 原子写 sessions.json / jobs.json。 */
  async save() {
    await ensureDir(this.stateDir);
    // 同一母文件夹可能有多个 StateStore 实例（两个窗口/进程共享 home）：写盘前先重读磁盘做浅合并。
    // 本实例 load/save 之后没动过的会话以磁盘为准（别人可能刚写），动过的用内存值；
    // 否则后写的实例会拿自己内存里的旧快照整文件覆盖，丢掉 `s-a` 这类只会话。
    const diskPayload = await readJson(this.sessionsFile);
    const diskSessions = isPlainObject(diskPayload) ? (diskPayload.sessions ?? diskPayload) : null;
    const merged = new Map();
    if (isPlainObject(diskSessions)) {
      for (const [sessionId, state] of Object.entries(diskSessions)) {
        const id = String(sessionId ?? "").trim();
        if (id && isPlainObject(state)) merged.set(id, state);
      }
    }
    for (const [sessionId, state] of this.sessions) {
      const changed = this.sessionsSnapshot.get(sessionId) !== JSON.stringify(state);
      if (changed || !merged.has(sessionId)) merged.set(sessionId, state);
    }
    const sessions = {};
    for (const sessionId of [...merged.keys()].sort()) sessions[sessionId] = merged.get(sessionId);
    await atomicJson(this.sessionsFile, { version: 1, updatedAt: Date.now(), sessions });
    this.sessionsSnapshot = new Map([...this.sessions].map(([id, state]) => [id, JSON.stringify(state)]));
    // jobs.json 可能被另一个进程（定时巡检 / 另一个会话）改过：写之前重读磁盘并与内存浅合并，
    // 磁盘已有键优先，避免把别人刚写的 forgetDone 覆盖回旧值；读不到就按内存写。
    // 本进程 updateJobs 刚改过的键（jobsPatch）在合并后重新压回去——否则本地改动永远写不进磁盘。
    const jobsPayload = await readJson(this.jobsFile);
    const diskJobs = isPlainObject(jobsPayload) ? (jobsPayload.jobs ?? jobsPayload) : null;
    this.jobs = { ...this.jobs, ...(isPlainObject(diskJobs) ? diskJobs : {}), ...this.jobsPatch };
    this.jobsPatch = {};
    await atomicJson(this.jobsFile, { version: 1, updatedAt: Date.now(), jobs: this.jobs });
  }

  getSession(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (!id) throw new Error("sessionId 不能为空");
    let session = this.sessions.get(id);
    if (!session) {
      session = defaultSession();
      this.sessions.set(id, session);
    }
    return session;
  }

  async updateSession(sessionId, patch = {}) {
    const session = this.getSession(sessionId);
    if (!isPlainObject(patch)) throw new Error("updateSession 的 patch 必须是对象");
    for (const [key, value] of Object.entries(patch)) {
      session[key] = Array.isArray(value) ? [...value] : value;
    }
    await this.save();
    return session;
  }

  getJobs() {
    return this.jobs;
  }

  async updateJobs(patch = {}) {
    if (!isPlainObject(patch)) throw new Error("updateJobs 的 patch 必须是对象");
    this.jobs = { ...this.jobs, ...patch };
    this.jobsPatch = { ...this.jobsPatch, ...patch };
    await this.save();
    return this.jobs;
  }
}

/** 进程内按键串行互斥；失败不会阻断后续任务。 */
export function createMutex() {
  const tails = new Map();
  return {
    run(key, fn) {
      if (typeof fn !== "function") throw new TypeError("mutex.run 需要函数");
      const name = String(key ?? "");
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(() => fn());
      tails.set(
        name,
        run.then(
          () => {},
          () => {},
        ),
      );
      return run;
    },
  };
}

/**
 * best-effort 文件锁：`state/.lock-<key>`，`wx` 原子创建；过期锁可抢占。
 * attempts 是抢锁重试次数（默认 4，约 180ms）；临界区较长时可由调用方放大。
 * 返回 release 函数（异步，幂等）。
 */
export async function acquireFileLock(home, key, ttlMs = 60_000, attempts = 4) {
  if (!home) throw new Error("acquireFileLock 需要母文件夹路径");
  const stateDir = path.join(path.resolve(home), "state");
  await ensureDir(stateDir);
  const safeKey = slug(key) || "lock";
  const file = path.join(stateDir, `.lock-${safeKey}`);
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : 60_000;
  const maxAttempts = Number.isInteger(Number(attempts)) && Number(attempts) > 0 ? Number(attempts) : 4;
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const now = Date.now();
    try {
      const handle = await fs.open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: now, expiresAt: now + ttl }));
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const raw = JSON.parse(await fs.readFile(file, "utf8"));
          if (raw && raw.token === token) await fs.rm(file, { force: true });
        } catch {
          await fs.rm(file, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8"));
        stale = !raw || !Number.isFinite(Number(raw.expiresAt)) || Number(raw.expiresAt) <= Date.now();
      } catch (readError) {
        // 锁文件存在但读不出/解析不了：可能是持有者刚用 `wx` 创建、还没写入 token 的窗口期。
        // 这里若直接当过期锁删掉，两个调用会同时进临界区（并发 append 8 条丢 1 条就是这么来的）。
        // 只有确实很旧才回收，否则老老实实等下一轮。
        if (readError?.code === "ENOENT") {
          stale = false; // 锁刚被释放，下一轮 wx 直接抢
        } else {
          try {
            const info = await fs.stat(file);
            stale = Date.now() - info.mtimeMs > LOCK_CREATE_GRACE_MS;
          } catch {
            stale = false; // stat 也失败（多半已被删），交给下一轮决定
          }
        }
      }
      if (stale) {
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt === maxAttempts - 1) throw new Error(`获取文件锁失败（已被占用）: ${key}`);
      await delay(Math.min(30 * (attempt + 1), 200));
    }
  }
  throw new Error(`获取文件锁失败: ${key}`);
}

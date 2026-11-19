import { randomUUID } from "node:crypto";
import { genericTermsOf, normalizeTerm } from "./associations.js";
import { readSnapshot } from "./memory.js";
import { buildIamAnchor, buildIamContext } from "./iam.js";
import { recall } from "./recall.js";
import { pressureRatio } from "./triggers.js";

export const REMEMBER_INSTRUCTION = [
  "===== 强制记忆 =====",
  "用户刚执行了 /hdm-remember。请在本轮调用 hdm_save，把这段对话里值得跨会话保留的内容写成一条记忆：",
  "summary 写清谁做了什么、结论与原因；details 按重要性 3~8 条；keywords 10~12 个按重要性降序。",
  "本会话已固定到该单元，本次保存会落在同一个编码下；内容确实没有可保留的记录时简短说明原因即可。",
].join("\n");

// ponytail: 用工具名判断「这一步是不是在选方案」是启发式——宿主没有暴露「方案决策」事件。
// 纯文件读写不算选方案（对应「文件写入不算」）；换成宿主事件时改这里一处即可。
const FILE_TOOL_RE = /(write|edit|read|replace|stat|diff|copy|move|remove|glob|grep|inspect)/i;

function pluginMessage(text, marker) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin:hdm", form: "snapshot", marker },
  };
}

function isRealUser(message) {
  const kind = message?.source?.kind;
  return kind === "user" || kind === undefined;
}

function userText(messages) {
  return messages
    .filter(isRealUser)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function priorUserCount(session) {
  try {
    const events = typeof session?.ownEvents === "function" ? session.ownEvents() : session?.events ?? [];
    let n = 0;
    for (const event of events) {
      if (event?.type !== "user/message") continue;
      if (event.data?.source?.kind !== "user") continue;
      n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

function sectionSummary(text) {
  const match = String(text ?? "").match(/##\s*摘要\s*\n([\s\S]*?)(?:\n##\s|$)/);
  return (match?.[1] ?? "").trim();
}

function oneLine(text, max) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

/** 检索档位：0=只给词表，1=用户回复时召回，2=加方案决策点与子代理。非法值退回 1。 */
function recallLevel(config) {
  const raw = Number(config?.autoRecall?.level);
  return Number.isFinite(raw) ? Math.min(2, Math.max(0, Math.trunc(raw))) : 1;
}

/** 上一条 assistant 消息里「非纯文件类」的工具调用名；
 *  `text` 是这条消息自己的文字（模型常在这里写「先试 A，不行换 B」），一并返回供检索。 */
function planningToolCalls(messages) {
  const lastAssistant = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === "assistant");
  if (!lastAssistant) return { tools: [], text: "" };
  const blocks = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
  const tools = blocks
    .filter((block) => block?.type === "tool-call" && typeof block.name === "string")
    .map((block) => block.name)
    .filter((name) => !FILE_TOOL_RE.test(name));
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return { tools, text };
}

/**
 * 记忆词表：把库里所有关键词按 keyness 汇总后取 top，给模型当检索词候选。
 * 两个修正（见调研结论）：
 * - 新近加权：每条记忆的分值乘时间衰减，否则老记忆的高分泛词永远霸占前几位，
 *   今天刚产生的词（如「提示词改造」「分点写法」）根本挤不进词表；
 * - 泛词过滤：与联想计分同口径（df/total > 30% 且库 ≥ 4 条）的词不进入候选。
 *   保留 1~2 个泛词当领域锚点意义不大——它们本来就会被模型从上下文里看到，
 *   占掉一个词位反而挤掉真正能定位记忆的词。
 * ponytail: 每次注入都全量扫一遍记忆（O(记忆数×关键词数)），几千条以内够用；再大就建持久词表。
 */
export function buildVocab(registry, maxChars, now = Date.now()) {
  const budget = Number(maxChars);
  if (!(budget > 0)) return "";
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const generic = genericTermsOf(registry);
  const scores = new Map();
  for (const meta of registry.list()) {
    const stamp = Number(meta.updatedAt ?? meta.createdAt ?? 0);
    const hasStamp = Number.isFinite(stamp) && stamp > 0;
    const ageDays = hasStamp ? Math.max(0, (timestamp - stamp) / 86400000) : 0;
    const decay = hasStamp ? Math.max(0.25, 1 - ageDays / 30) : 0.25;
    for (const keyword of meta.keywords ?? []) {
      const term = typeof keyword === "string" ? keyword : keyword?.term;
      if (typeof term !== "string" || !term.trim()) continue;
      if (generic.has(normalizeTerm(term))) continue;
      const weight = Number(keyword?.keyness ?? meta.importance ?? 1) + 1;
      const contribution = (Number.isFinite(weight) ? weight : 1) * decay;
      scores.set(term, (scores.get(term) ?? 0) + contribution);
    }
  }
  if (!scores.size) return "";
  const terms = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([term]) => term);
  const picked = [];
  let chars = 0;
  for (const term of terms) {
    if (chars + term.length + 3 > budget) break;
    picked.push(term);
    chars += term.length + 3;
  }
  return picked.length ? picked.join("、") : "";
}

/** 比较工作目录：Windows 大小写与斜杠方向都不敏感（H:/a 与 H:\A 是同一个目录）。 */
function sameWorkspace(a, b) {
  if (!a || !b) return false;
  const norm = (value) => String(value).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export async function selectHandoff({ home, config, registry, session, now, excludeUids = [] }) {
  if (!config.handoff?.enabled) return null;
  const header = session?.header ?? {};
  const currentId = header.id;
  const createdAt = Number(header.createdAt ?? now);
  const maxAge = Number(config.handoff.maxAgeDays ?? 30) * 86400000;
  const cwd = header.cwd;
  // 「上一段对话」必须是别的对话：本会话自己的单元（固定单元及其追加过的单元）排除掉，
  // 否则会把当前这件事的记忆当成上一段对话再喂回来。
  const excluded = new Set((Array.isArray(excludeUids) ? excludeUids : []).map(String));

  const candidates = registry
    .list()
    .filter((meta) => meta && meta.sessionId !== currentId && !excluded.has(String(meta.uid)))
    .filter((meta) => Number(meta.createdAt ?? 0) < createdAt)
    .filter((meta) => now - Number(meta.createdAt ?? 0) <= maxAge)
    .filter((meta) => meta.status !== "archived");

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (config.handoff.preferSameWorkspace && cwd) {
      const aSame = sameWorkspace(a.cwd, cwd) ? 1 : 0;
      const bSame = sameWorkspace(b.cwd, cwd) ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;
    }
    // 派生 L1/L0 曾批量刷新 updatedAt → 同一时刻会有多条并列，没有次级键时顺序取决于
    // 注册表的遍历顺序（等于随机）。用 createdAt、再 uid 兜底，保证同一份索引永远选同一条。
    return (
      Number(b.updatedAt ?? b.createdAt ?? 0) - Number(a.updatedAt ?? a.createdAt ?? 0) ||
      Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0) ||
      String(a.uid).localeCompare(String(b.uid))
    );
  });

  return candidates[0];
}

export async function buildHandoffText(meta, config) {
  if (!meta) return "";
  const snapshot = await readSnapshot(meta, meta.defaultLevel).catch(() => null);
  const summary = oneLine(snapshot ? sectionSummary(snapshot.text) : "", 600);
  const keywords = (meta.keywords ?? []).map((k) => k.term ?? k).slice(0, 12).join(", ");
  const lines = [
    "【上一段对话的记忆】",
    `记忆编号: ${meta.label}`,
    `时间: ${meta.date}（L${meta.defaultLevel}${meta.immortal ? "，永久豁免" : ""}）`,
  ];
  if (summary) lines.push(`摘要: ${summary}`);
  if (keywords) lines.push(`关键词: ${keywords}`);
  if (snapshot?.path) lines.push(`全文: ${snapshot.path}`);
  return lines.join("\n").slice(0, config.handoff.maxChars);
}

function matchTerms(registry, text) {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized) return [];
  const terms = new Map();
  for (const meta of registry.list()) {
    for (const keyword of meta.keywords ?? []) {
      const term = keyword.term ?? keyword;
      if (typeof term !== "string" || term.length < 2) continue;
      if (!normalized.includes(term.toLowerCase())) continue;
      const level = Math.max(...(keyword.levels ?? [meta.defaultLevel]), meta.defaultLevel ?? 0);
      terms.set(term, Math.max(terms.get(term) ?? 0, level));
    }
  }
  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 12)
    .map(([term]) => term);
}

export async function buildAutoRecall({ home, config, registry, state, sessionId, text }) {
  if (!config.autoRecall?.enabled) return "";
  const terms = matchTerms(registry, text);
  if (!terms.length) return "";
  const result = await recall({
    registry,
    config,
    keywords: terms,
    topK: config.autoRecall.topK,
    view: "auto",
    boost: "none",
    includeAssociations: false,
  }).catch(() => null);
  if (!result?.matches?.length) return "";

  const ss = state.getSession(sessionId);
  const seen = new Set(ss.recalledUids ?? []);
  const picked = result.matches.filter((m) => !seen.has(m.uid) && m.weight >= config.autoRecall.minScore);
  if (!picked.length) return "";

  const lines = ["可能相关的记忆（仅供参考）："];
  let chars = 0;
  for (const match of picked) {
    const snapshot = await readSnapshot(registry.get(match.uid), match.level).catch(() => null);
    const summary = oneLine(snapshot ? sectionSummary(snapshot.text) : "", 120);
    const line = `- ${match.uid}（L${match.level}）${summary ? `：${summary}` : ""}\n  ${match.path}`;
    if (chars + line.length > config.autoRecall.maxChars) break;
    chars += line.length;
    lines.push(line);
  }
  if (lines.length === 1) return "";
  ss.recalledUids = [...new Set([...(ss.recalledUids ?? []), ...picked.map((m) => m.uid)])].slice(-200);
  await state.updateSession(sessionId, { recalledUids: ss.recalledUids }).catch(() => undefined);
  return lines.join("\n").slice(0, config.autoRecall.maxChars);
}

export async function buildPreStepDecision({ ctx, home, config, registry, state, agent, decision, now, step, turn }) {
  if (decision?.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
  const session = agent?.session;
  const header = session?.header;
  if (!header?.id) return decision;

  const sessionId = header.id;
  const ss = state.getSession(sessionId);
  const realUsers = decision.messages.filter(isRealUser);
  const level = recallLevel(config);
  const autoRecallOn = config.autoRecall?.enabled === true;
  const stepNumber = Number(step ?? 0);
  const firstTurn = !ss.iamInjected || ss.pendingContextReinject === true;
  const isSubagent = header.origin === "subagent" || Boolean(header.parentSession);

  // 子代理：只召回，不注入 IAM/handoff——它的上下文由父会话的任务描述决定。
  if (isSubagent) {
    const allowed = autoRecallOn && level >= 2 && config.autoRecall?.subagent !== false;
    if (!allowed || ss.subagentRecalled === true) return decision;
    const text = userText(decision.messages) || String(ss.lastUserQuery ?? "");
    ss.subagentRecalled = true;
    const auto = text.trim()
      ? await buildAutoRecall({ home, config, registry, state, sessionId, text }).catch(() => "")
      : "";
    await state.updateSession(sessionId, { subagentRecalled: true }).catch(() => undefined);
    if (!auto) return decision;
    const messages = [...decision.messages];
    messages.splice(messages.length, 0, pluginMessage(auto, "hint"));
    return { ...decision, messages };
  }

  const userStep = realUsers.length > 0;
  // 方案决策点：同一轮内的续步，且上一步发起了非纯文件类工具 → 模型正要决定怎么做。
  const planning = level >= 2 && !userStep && stepNumber > 1 ? planningToolCalls(decision.messages) : { tools: [], text: "" };
  const decisionStep = planning.tools.length > 0 && Number(ss.recallTurn ?? -1) !== Number(turn ?? -2);
  // 压缩后即使没有新用户消息也要把记忆与 IAM 交回去。
  if (!firstTurn && !userStep && !decisionStep) return decision;

  const sections = [];

  if (firstTurn) {
    const fromCompaction = ss.pendingContextReinject === true;
    if (config.iam?.inject && (!fromCompaction || config.iam?.fullReinjectAfterCompaction !== false)) {
      const iam = await buildIamContext(home, config.iam.maxChars).catch(() => "");
      if (iam.trim()) sections.push(`===== 自传体记忆 =====\n${iam.trim()}`);
    }
    if (!fromCompaction || config.handoff?.reinjectAfterCompaction !== false) {
      const handoff = await selectHandoff({
        home,
        config,
        registry,
        session,
        now,
        excludeUids: [...(ss.uids ?? []), ss.memoryUid].filter(Boolean),
      }).catch(() => null);
      if (handoff) {
        const text = await buildHandoffText(handoff, config).catch(() => "");
        if (text) sections.push(`===== 上一段对话 =====\n${text}`);
        ss.handoffUid = handoff.uid;
      }
    }
    if (ss.pendingCompactMemory) {
      const memory = ss.pendingCompactMemory;
      const stamp = (at) =>
        new Date(Number(at)).toLocaleString("zh-CN", { timeZone: config?.timeZone ?? "Asia/Shanghai", hour12: false });
      // 用户看不到后台钩子在写记忆，这一行就是唯一的可见凭据：写没写、写进哪一段、什么时候写的。
      const lines = ["===== 压缩前记忆 ====="];
      if (memory.deduped) {
        const minutes = Math.max(1, Math.round(Number(memory.ageMs ?? 0) / 60000));
        lines.push(`【本轮未重复写入】${minutes} 分钟前刚存过这段工作，直接沿用那条记忆，没有再次总结。`);
      } else {
        // 追加已改为原地改写：同一记忆单元的正文被合并更新，不再有「追加记忆 #N」段落。
        const which = Number(memory.appendCount ?? 1) > 1
          ? `并入同一记忆（第 ${memory.appendCount} 次合并）`
          : "新建记忆单元";
        const took = Number(memory.elapsedMs) > 0 ? `，耗时 ${(Number(memory.elapsedMs) / 1000).toFixed(1)}s` : "";
        lines.push(`【本轮压缩前已保存】写入 ${which}（${memory.wroteAt ? stamp(memory.wroteAt) : "刚刚"}${took}）`);
      }
      lines.push("上下文压缩前存下的一条记忆（已落盘，需要细节可 hdm_read）：");
      if (memory.uid) lines.push(`记忆编号: ${memory.uid}`);
      if (memory.summary) lines.push(`摘要: ${oneLine(memory.summary, 800)}`);
      if (memory.path) lines.push(`全文: ${memory.path}`);
      sections.push(lines.join("\n"));
      ss.pendingCompactMemory = null;
    }
    if (autoRecallOn && level >= 0) {
      const vocab = buildVocab(registry, config.autoRecall?.vocabChars ?? 0, now);
      if (vocab) {
        sections.push(
          `===== 记忆词表 =====\n检索过去对话时优先用这些词做 hdm_recall 的 keywords：${vocab}`,
        );
      }
    }
    ss.iamInjected = true;
    ss.pendingContextReinject = false;
    ss.turnsSinceAnchor = 0;
  } else {
    if (config.iam?.anchorEveryTurns > 0) {
      ss.turnsSinceAnchor = (ss.turnsSinceAnchor ?? 0) + 1;
      if (ss.turnsSinceAnchor >= config.iam.anchorEveryTurns) {
        const anchor = await buildIamAnchor(home, config).catch(() => "");
        if (anchor.trim()) sections.push(`===== 自我锚点 =====\n${anchor.trim()}`);
        ss.turnsSinceAnchor = 0;
      }
    }

    if (userStep) {
      const text = userText(decision.messages);
      ss.lastUserQuery = oneLine(text, 500);
      if (autoRecallOn && level >= 1) {
        const auto = await buildAutoRecall({ home, config, registry, state, sessionId, text }).catch(() => "");
        if (auto) sections.push(auto);
      }
    } else if (decisionStep) {
      // 方案决策点：最近一次用户请求 + 上一步的工具名 + 上一步自己的文字（常写着备选方案）。
      const text = [String(ss.lastUserQuery ?? ""), ...planning.tools, oneLine(planning.text, 400)]
        .join(" ")
        .trim();
      ss.recallTurn = Number(turn ?? 0);
      if (text) {
        const auto = await buildAutoRecall({ home, config, registry, state, sessionId, text }).catch(() => "");
        if (auto) sections.push(auto);
      }
    }
  }

  // `/hdm-remember`：命令只登记，内容由对话智能体生成，所以这里把指令送到模型这一步。
  // 用 hintAt 去重：同一个登记值只提示一次，避免每一步都重复催。
  if (ss.pendingRememberAt != null && ss.pendingRememberHintAt !== ss.pendingRememberAt) {
    sections.push(REMEMBER_INSTRUCTION);
    ss.pendingRememberHintAt = ss.pendingRememberAt;
  }

  if (config.nudge?.enabled && userStep && !firstTurn) {
    ss.userTurnsSinceMemory = (ss.userTurnsSinceMemory ?? 0) + 1;
    // 只看「回合数」会漏掉长时间连续工作：存完一批后接着干 40 分钟，回合数可能没涨多少，
    // 那 40 分钟的内容就永远不会落盘。所以再加一条「距上次保存 ≥ staleMinutes」的判据。
    const rawStale = Number(config.nudge?.staleMinutes ?? 45);
    const staleMinutes = Number.isFinite(rawStale) ? Math.max(0, rawStale) : 45;
    const stamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const lastSavedAt = Number(ss.lastMemoryToolAt);
    const stale =
      staleMinutes > 0 &&
      Number.isFinite(lastSavedAt) &&
      lastSavedAt > 0 &&
      stamp - lastSavedAt >= staleMinutes * 60000 &&
      ss.userTurnsSinceMemory >= 3;
    if (
      (ss.userTurnsSinceMemory >= config.nudge.everyUserTurns || stale) &&
      (ss.nudges ?? 0) < config.nudge.maxPerSession
    ) {
      sections.push(
        "提示：本段对话已持续多轮且尚未保存。如其中有值得跨会话保留的内容，可调用 hdm_save；需要回忆过去可用 hdm_recall。" +
          "若本段涉及长期目标、身份或关系变化，接着用 hdm_iam_update；涉及人物偏好用 hdm_character_update。",
      );
      ss.nudges = (ss.nudges ?? 0) + 1;
      ss.userTurnsSinceMemory = 0;
    }
  }

  if (userStep) {
    const ratio = pressureRatio(ctx, session);
    if (ratio != null && ratio >= config.save.threshold) {
      const band = Math.round(ratio * 100) / 100;
      const bands = ss.remindedBands ?? [];
      const already = bands.some((b) => Math.abs(b - band) < 0.02);
      const nearLast = ss.lastSaveRatio != null && ratio - ss.lastSaveRatio < config.save.step;
      if (!already && !nearLast && (ss.nudges ?? 0) < config.save.maxPerSession) {
        sections.push(
          "上下文已达阈值。请调用 hdm_save 保存本段记忆：先写完整摘要/细节/原话；keywords 按重要性从高到低提供 10~12 个（系统会重算 keyness）；涉及目标/关系/人物时顺带更新 IAM 与人物档案。",
        );
        bands.push(band);
        ss.remindedBands = bands.slice(-8);
        ss.nudges = (ss.nudges ?? 0) + 1;
      }
    }

    // 检测到新保存：记录压力，供下一次提醒阈值使用
    if ((ss.uids?.length ?? 0) > (ss.lastUidCount ?? 0)) {
      ss.lastSaveRatio = ratio ?? ss.lastSaveRatio ?? null;
      ss.lastUidCount = ss.uids.length;
    }
  }

  await state
    .updateSession(sessionId, {
      iamInjected: ss.iamInjected,
      handoffUid: ss.handoffUid ?? null,
      pendingContextReinject: ss.pendingContextReinject ?? false,
      pendingCompactMemory: ss.pendingCompactMemory ?? null,
      turnsSinceAnchor: ss.turnsSinceAnchor ?? 0,
      userTurnsSinceMemory: ss.userTurnsSinceMemory ?? 0,
      nudges: ss.nudges ?? 0,
      remindedBands: ss.remindedBands ?? [],
      lastSaveRatio: ss.lastSaveRatio ?? null,
      lastUidCount: ss.lastUidCount ?? 0,
      recalledUids: ss.recalledUids ?? [],
      lastUserQuery: ss.lastUserQuery ?? null,
      recallTurn: ss.recallTurn ?? null,
      subagentRecalled: ss.subagentRecalled === true,
      pendingRememberAt: ss.pendingRememberAt ?? null,
      pendingRememberHintAt: ss.pendingRememberHintAt ?? null,
    })
    .catch(() => undefined);

  if (!sections.length) return decision;

  const message = pluginMessage(sections.join("\n\n"), firstTurn ? "context" : "hint");
  const index = realUsers.length ? decision.messages.lastIndexOf(realUsers[realUsers.length - 1]) : decision.messages.length;
  const messages = [...decision.messages];
  messages.splice(index < 0 ? messages.length : index, 0, message);
  return { ...decision, messages };
}

export function buildPluginMessage(text, marker = "hint") {
  return pluginMessage(text, marker);
}

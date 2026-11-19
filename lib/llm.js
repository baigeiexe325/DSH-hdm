// HDM maintenance LLM helpers: resolve the background model and stream a plain text answer.
// Only node:* (none needed here) and in-scope modules. Failures throw; callers fall back.

function isAsyncIterable(value) {
  return !!value && typeof value[Symbol.asyncIterator] === "function";
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return [...value.values()];
  if (typeof value[Symbol.iterator] === "function") return [...value];
  return [];
}

async function selectionToModel(value) {
  const selected = await value;
  if (!selected || typeof selected !== "object") return null;
  const provider = selected.provider ?? selected.providerId ?? selected.providerID;
  const model = selected.model ?? selected.modelId ?? selected.modelID;
  return provider && model ? { provider: String(provider), model: String(model) } : null;
}

/**
 * 后台调用的输出预算与超时，四个维护入口（空闲整理/日记正文/日记分块/遗忘压缩）共用。
 * 预算只是上限：宿主会按模型上下文窗口向下钳制（clampMaxTokensToContext），填大了不会报错。
 * @param {object} [config] 解析后的 HDM 配置
 * @returns {{ maxTokens: number, timeoutMs: number }}
 */
export function maintenanceLimits(config) {
  const section = config?.maintenance ?? {};
  const tokens = Number(section.maxTokens);
  const seconds = Number(section.timeoutSeconds);
  return {
    maxTokens: Number.isFinite(tokens) && tokens >= 1 ? Math.min(1_000_000, Math.round(tokens)) : 100_000,
    timeoutMs: Number.isFinite(seconds) && seconds >= 1 ? Math.min(3_600, Math.round(seconds)) * 1000 : 600_000,
  };
}

/**
 * 宿主是否提供可用的 llm 流。必须走 `service()`：维护用的 ctx 只暴露 `get(name)`，
 * 直接读 `ctx.llm` 恒为 undefined，会让调用方误判「没有维护模型」。
 * @param {object} [ctx]
 * @returns {boolean}
 */
export function hasLlmStream(ctx) {
  return typeof service(ctx, "llm")?.stream === "function";
}

/**
 * 「为什么没拿到维护模型」的可读诊断：日记定时器没有会话可问，只能看这两个服务在不在。
 * 结果直接写进日记的失败段落，省掉一次「猜 + 改 + 重载」的往返。
 * @param {object} [ctx] 同 streamText 的 ctx
 * @returns {string}
 */
export function modelDiagnostics(ctx) {
  const has = (name) => {
    try {
      const value = service(ctx, name);
      return value === undefined || value === null ? "缺失" : typeof value;
    } catch {
      return "不可读";
    }
  };
  const picked = (() => {
    try {
      const selection = service(ctx, "agentDefaultModel")?.currentSelection?.();
      if (!selection || typeof selection !== "object") return "无选择";
      const provider = selection.provider ?? selection.providerId;
      const model = selection.model ?? selection.modelId;
      return provider && model ? `${provider}/${model}` : "选择缺字段";
    } catch {
      return "读取失败";
    }
  })();
  const agentCount = (() => {
    try {
      const list = service(ctx, "agents")?.list?.();
      return Array.isArray(list) ? list.length : 0;
    } catch {
      return 0;
    }
  })();
  return `llm=${has("llm")}, agentDefaultModel=${has("agentDefaultModel")}, 默认选择=${picked}, liveagents=${agentCount}`;
}

/**
 * 取一个宿主服务：优先直接属性，其次 `ctx.get(name)`。
 * 插件只声明了 inject:["tools"]，其它服务（llm / agentDefaultModel / agents）在根 ctx 上
 * 往往只能通过 get 拿到；直接读属性会得到 undefined，导致「没有维护模型」。
 */
function service(ctx, name) {
  if (!ctx) return undefined;
  try {
    const direct = ctx[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // 未声明的属性可能抛错，继续走 get
  }
  try {
    return typeof ctx.get === "function" ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the model used by diary/forget/idle: config override -> live session header ->
 * agent default selection -> first live agent's request header -> null (caller falls back).
 * @param {{ session?: object }} [options] 当前会话（命令里传 agent.session，能直接拿到本轮模型）
 */
export async function resolveMaintenanceModel(ctx, config, options = {}) {
  const configured = config?.maintenance;
  if (configured?.provider && configured?.model) {
    return { provider: String(configured.provider), model: String(configured.model) };
  }

  const session = options?.session;
  if (session) {
    try {
      const header = typeof session.requestHeader === "function" ? await session.requestHeader() : session.requestHeader;
      const fromSession = await selectionToModel(header?.config);
      if (fromSession) return fromSession;
    } catch {
      // fall through to the default selection
    }
  }

  try {
    const fromDefault = await selectionToModel(service(ctx, "agentDefaultModel")?.currentSelection?.());
    if (fromDefault) return fromDefault;
  } catch {
    // fall through to live agents
  }

  for (const agent of toArray(service(ctx, "agents")?.list?.())) {
    if (!agent || agent.live === false) continue;
    const session = agent.session;
    if (!session || session.subagent === true || session.fork === true) continue;
    try {
      const header = typeof session.requestHeader === "function"
        ? await session.requestHeader()
        : session.requestHeader;
      const fromHeader = await selectionToModel(header?.config);
      if (fromHeader) return fromHeader;
    } catch {
      // try next live agent
    }
  }

  return null;
}

/**
 * 宿主 StreamChunk 的 `text-delta` 只带 `text`，并且失败不会抛错，而是以
 * `{type:"finish", reason:{kind:"error"|"aborted", failure}}` 结束——所以要分别收集文本与失败原因。
 * @returns {{ text: string, failure: string|null, types: string[] }}
 */
async function collectStream(iterable) {
  const types = new Set();
  let text = "";
  let blockEnd = "";
  let failure = null;
  let finishKind = null;
  for await (const chunk of iterable) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    const type = typeof chunk.type === "string" ? chunk.type : "";
    if (type) types.add(type);
    if (type === "finish") {
      const reason = chunk.reason;
      if (typeof reason?.kind === "string") finishKind = reason.kind;
      if (reason?.kind === "error" || reason?.kind === "aborted") failure = describeFailure(reason.failure, reason.kind);
      continue;
    }
    if (type === "block-end") {
      const block = chunk.block;
      if (block?.type === "text" && typeof block.text === "string") blockEnd += block.text;
      continue;
    }
    const delta = chunk.textDelta ?? chunk.delta ?? (type === "reasoning-delta" ? "" : chunk.text);
    if (typeof delta === "string") text += delta;
  }
  return { text: text.trim() ? text : blockEnd, failure, types: [...types], finishKind };
}

/** LlmFailure 的字段不固定，取最能说明问题的一个。 */
function describeFailure(failure, kind) {
  if (typeof failure === "string") return failure;
  const message = failure?.message ?? failure?.code ?? failure?.reason;
  if (typeof message === "string" && message.trim()) return message;
  if (failure) {
    try {
      return JSON.stringify(failure);
    } catch {
      // fall through
    }
  }
  return `stream ${kind}`;
}

/**
 * RequestMessage.content 是 ContentBlock[]，纯字符串不保证被适配器接受；统一包成 text 块。
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object" || typeof message.content !== "string") return message;
    return { ...message, content: [{ type: "text", text: message.content }] };
  });
}

/**
 * 推理模型的思考 token 也算在 maxTokens 里；维护任务是「读书 + 输出 JSON」，用最低一档就够，
 * 否则思考会把预算吃光，流里只有 reasoning-delta、最后以 max-tokens 结束（表现为「空响应」）。
 * 拿不到模型信息或 effort 列表时返回 undefined，让适配器用默认值。
 */
async function lowestReasoningEffort(llm, model) {
  const resolve = llm?.resolveModelInfo;
  if (typeof resolve !== "function") return undefined;
  try {
    const info = await resolve.call(llm, model.provider, model.model);
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
    for (const effort of efforts) {
      const id = effort?.id ?? effort?.value;
      if (typeof id === "string" && id && id !== "off" && id !== "none") return id;
    }
  } catch {
    // 解析失败就交给适配器默认值
  }
  return undefined;
}

/**
 * Stream one completion and collect its text. Throws on transport errors, finish failures,
 * or empty text. `maxMs` bounds the call (default 90s); a caller signal still applies and wins on abort.
 */
export async function streamText(ctx, model, { system, messages, maxTokens = 2000, signal, maxMs = 90_000, reasoningEffort } = {}) {
  if (!model?.provider || !model?.model) throw new Error("streamText: invalid model");
  const provider = service(ctx, "llm");
  const stream = provider?.stream;
  if (typeof stream !== "function") throw new Error("streamText: ctx.llm.stream unavailable");

  const timeoutMs = Number.isFinite(Number(maxMs)) && Number(maxMs) > 0 ? Number(maxMs) : 90_000;
  const timeout = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  const bounded = signal
    ? (timeout && typeof AbortSignal?.any === "function" ? AbortSignal.any([signal, timeout]) : signal)
    : timeout;

  const result = await stream.call(provider, {
    provider: model.provider,
    model: model.model,
    system,
    messages: normalizeMessages(messages),
    reasoningEffort: reasoningEffort ?? (await lowestReasoningEffort(provider, model)),
    maxTokens,
    signal: bounded ?? signal,
  });

  if (typeof result === "string") return result;

  const iterable = [result, result?.fullStream, result?.textStream].find(isAsyncIterable);
  if (iterable) {
    const { text, failure, types, finishKind } = await collectStream(iterable);
    if (failure) throw new Error(`streamText: stream failed (${failure})`);
    if (!text.trim()) {
      throw new Error(
        `streamText: empty response (finish: ${finishKind ?? "none"}; chunks: ${types.join(",") || "none"})`,
      );
    }
    return text;
  }

  if (typeof result?.text === "string") return result.text;
  if (result?.text && typeof result.text.then === "function") {
    const text = await result.text;
    if (typeof text === "string" && text.trim()) return text;
    throw new Error("streamText: empty response");
  }

  throw new Error("streamText: ctx.llm.stream returned no text stream");
}

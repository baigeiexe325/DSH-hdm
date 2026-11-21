// HDM 配置模块。
// 无第三方依赖：手写描述对象 + `~standard` 校验协议（参考 dsh-ops 的 settings descriptor）。

import path from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { expandHome } from "./paths.js";

/** 固定常量（不开放配置）：各档快照的关键词数量区间。 */
export const KEYWORD_BANDS = Object.freeze({
  2: Object.freeze([10, 12]),
  1: Object.freeze([8, 10]),
  0: Object.freeze([5, 8]),
});

const SCALARS = {
  enabled: { type: "boolean", def: true, desc: "总开关" },
  homeDir: { type: "string", def: "~/.dsh-hdm", nonEmpty: true, desc: "母文件夹，支持 ~ 展开" },
  timeZone: { type: "string", def: "Asia/Shanghai", nonEmpty: true, desc: "日期归属时区", check: checkTimeZone },
  promptLang: { type: "string", def: "zh", nonEmpty: true, pattern: /^[a-z]{2,8}$/, desc: "提示词语言" },
};

const SECTIONS = {
  save: {
    threshold: { type: "number", def: 0.5, min: 0.01, max: 0.95, desc: "上下文压力触发阈值（0~1）" },
    step: { type: "number", def: 0.15, min: 0.01, max: 0.5, desc: "下一次提醒的压力增量" },
    maxPerSession: { type: "number", def: 4, min: 1, max: 100, int: true, desc: "单会话最多提醒次数" },
    gapHours: { type: "number", def: 3, min: 0.5, max: 168, desc: "同一对话两次保存间隔超过多少小时就另起一条记忆" },
  },
  memory: {
    filenameMaxChars: { type: "number", def: 180, min: 60, max: 1024, int: true, desc: "记忆文件夹名总长上限" },
    maxKeywordLen: { type: "number", def: 32, min: 4, max: 64, int: true, desc: "单个关键词输入长度上限" },
  },
  recall: {
    topK: { type: "number", def: 3, min: 1, max: 10, int: true, desc: "默认返回条数" },
    levelBias: { type: "number", def: 1, min: 0, max: 10, desc: "权重中的等级系数" },
    usageBoost: { type: "number", def: 1, min: 0, max: 10, desc: "boost=usage 时每次命中加成" },
    recencyBoost: { type: "number", def: 2, min: 0, max: 10, desc: "boost=recency 时的最大加成" },
    pinnedBoost: { type: "number", def: 3, min: 0, max: 10, desc: "boost=pinned 的加成" },
  },
  handoff: {
    enabled: { type: "boolean", def: true, desc: "新会话接力" },
    maxChars: { type: "number", def: 2000, min: 100, max: 100000, int: true, desc: "接力摘要上限" },
    maxAgeDays: { type: "number", def: 30, min: 0, max: 3650, int: true, desc: "超过天数不注入正文" },
    preferSameWorkspace: { type: "boolean", def: true, desc: "优先同工作目录" },
    reinjectAfterCompaction: { type: "boolean", def: true, desc: "压缩后重注入" },
  },
  autoRecall: {
    enabled: { type: "boolean", def: true, desc: "自动召回" },
    level: { type: "number", def: 1, min: 0, max: 2, int: true, desc: "检索档位：0=只给词表按需自取，1=用户回复时自动召回，2=再加方案决策点与子代理" },
    subagent: { type: "boolean", def: true, desc: "档位 2 时子代理首步也自动召回" },
    vocabChars: { type: "number", def: 400, min: 0, max: 4000, int: true, desc: "记忆词表注入字数（0=不注入）" },
    topK: { type: "number", def: 2, min: 1, max: 10, int: true, desc: "每条消息最多注入条数" },
    minScore: { type: "number", def: 2, min: 0, max: 100, desc: "低于该分数不注入" },
    maxChars: { type: "number", def: 600, min: 50, max: 100000, int: true, desc: "整块字数上限" },
  },
  compaction: {
    memorize: { type: "boolean", def: true, desc: "压缩前先用维护模型把对话存成一条记忆" },
    maxChars: { type: "number", def: 20000, min: 1000, max: 200000, int: true, desc: "送模型的压缩前对话字数上限" },
    waitMs: { type: "number", def: 20000, min: 1000, max: 300000, int: true, desc: "压缩结束时等待记忆落盘的上限（毫秒）" },
    dedupeMinutes: {
      type: "number",
      def: 5,
      min: 0,
      max: 240,
      int: true,
      desc: "本会话这么多分钟内刚写过记忆就不再重复总结（0=每次压缩都总结）",
    },
  },
  nudge: {
    enabled: { type: "boolean", def: true, desc: "低使用率提醒" },
    everyUserTurns: { type: "number", def: 6, min: 1, max: 1000, int: true, desc: "每 N 个用户回合提醒一次" },
    maxPerSession: { type: "number", def: 2, min: 0, max: 100, int: true, desc: "单会话最多提醒次数" },
    staleMinutes: {
      type: "number",
      def: 45,
      min: 0,
      max: 1440,
      int: true,
      desc: "距上次保存超过多少分钟也允许提醒一次（0=关闭；需已积累 ≥3 个用户回合）",
    },
  },
  iam: {
    inject: { type: "boolean", def: true, desc: "首轮注入 IAM" },
    maxChars: { type: "number", def: 6000, min: 100, max: 100000, int: true, desc: "IAM 上限" },
    anchorEveryTurns: { type: "number", def: 6, min: 0, max: 1000, int: true, desc: "自我锚点间隔（0=关）" },
    anchorMaxChars: { type: "number", def: 400, min: 50, max: 100000, int: true, desc: "锚点长度" },
    fullReinjectAfterCompaction: { type: "boolean", def: true, desc: "压缩后全文重注入" },
    anchorIncludeUserTone: { type: "boolean", def: true, desc: "锚点包含 USER 语气" },
  },
  diary: {
    enabled: { type: "boolean", def: true, desc: "日记开关" },
    time: { type: "string", def: "23:30", pattern: /^([01]\d|2[0-3]):[0-5]\d$/, desc: "每日生成时间 HH:mm" },
    catchUpDays: { type: "number", def: 7, min: 0, max: 365, int: true, desc: "启动补写天数" },
    maxChars: { type: "number", def: 8000, min: 100, max: 100000, int: true, desc: "日记上限" },
    inputMaxChars: { type: "number", def: 12000, min: 100, max: 100000, int: true, desc: "单块输入上限" },
  },
  forget: {
    enabled: { type: "boolean", def: true, desc: "遗忘开关" },
    days: {
      type: "array",
      def: [2, 5],
      minItems: 1,
      sort: true,
      item: { type: "number", min: 1, max: 3650, int: true },
      desc: "快照生成天数（默认 [2,5]）",
    },
    checkHours: { type: "number", def: 6, min: 1, max: 168, int: true, desc: "巡检间隔（小时）" },
    exemptMode: {
      type: "string",
      def: "tiered",
      enum: ["delay", "skip", "tiered"],
      desc: "豁免模式 delay/skip/tiered",
    },
    exemptRecallCount: { type: "number", def: 3, min: 0, max: 100, int: true, desc: "进入 delay 的命中数" },
    exemptWindowDays: { type: "number", def: 14, min: 1, max: 3650, int: true, desc: "delay 窗口天数" },
    autoImmortalRecallCount: { type: "number", def: 6, min: 0, max: 100, int: true, desc: "自动永久豁免命中数" },
    autoImmortalWindowDays: { type: "number", def: 30, min: 1, max: 3650, int: true, desc: "自动永久豁免窗口" },
    immortalImportance: { type: "number", def: 5, min: 1, max: 5, int: true, desc: "重要性达到即永久" },
    respectImmortal: { type: "boolean", def: true, desc: "自动遗忘尊重 immortal（关掉即允许压缩永久豁免记忆，慎用）" },
  },
  association: {
    enabled: { type: "boolean", def: true, desc: "回忆联想" },
    triggerCount: { type: "number", def: 4, min: 0, max: 100, int: true, desc: "hitCount 超过才联想" },
    minLevel: { type: "number", def: 1, min: 0, max: 2, int: true, desc: "联想最低档" },
    maxItems: { type: "number", def: 3, min: 1, max: 10, int: true, desc: "联想条数" },
    maxChars: { type: "number", def: 1500, min: 50, max: 100000, int: true, desc: "联想总字数上限" },
    recencyWindowDays: { type: "number", def: 30, min: 1, max: 3650, int: true, desc: "联想时间衰减窗口（天），越久权重越低（保底 0.2）" },
  },
  characters: {
    enabled: { type: "boolean", def: true, desc: "人物档案" },
    maxChars: { type: "number", def: 12000, min: 100, max: 100000, int: true, desc: "单人物档案上限" },
    injectOnRecall: { type: "boolean", def: true, desc: "召回命中人物关键词时附档案摘录" },
    snippetChars: { type: "number", def: 200, min: 40, max: 1000, int: true, desc: "人物档案摘录字数上限" },
  },
  maintenance: {
    provider: { type: "string", def: "", desc: "后台模型 provider；空则用默认模型" },
    model: { type: "string", def: "", desc: "后台模型 model；空则用默认模型" },
    maxTokens: { type: "number", def: 100000, min: 1000, max: 1000000, int: true, desc: "后台调用的输出 token 预算" },
    timeoutSeconds: { type: "number", def: 600, min: 30, max: 3600, int: true, desc: "单次后台调用超时（秒）" },
  },
  backup: {
    enabled: { type: "boolean", def: true, desc: "自动版本快照（写入后按内容变化保存一版）" },
    dir: { type: "string", def: "", desc: "快照根目录；必须在母文件夹之外，空则用 <主目录>/.dsh-hdm-backups/<母文件夹名>" },
    keep: { type: "number", def: 20, min: 1, max: 500, int: true, desc: "保留最近多少版" },
  },
  idle: {
    enabled: { type: "boolean", def: true, desc: "空闲对话自动整理" },
    idleMinutes: { type: "number", def: 180, min: 1, max: 10080, int: true, desc: "空闲下限（分钟），低于它不整理" },
    maxIdleMinutes: { type: "number", def: 720, min: 1, max: 10080, int: true, desc: "空闲上限（分钟），达到它视为陈旧不整理" },
    checkMinutes: { type: "number", def: 15, min: 1, max: 1440, int: true, desc: "扫描间隔（分钟），只决定检查频率" },
    minIntervalMinutes: { type: "number", def: 60, min: 1, max: 10080, int: true, desc: "同一会话两次整理的最小间隔（分钟）" },
    maxRunsPerDay: { type: "number", def: 12, min: 0, max: 1000, int: true, desc: "每日整理次数上限（0=不限）" },
    minUserMessages: { type: "number", def: 2, min: 1, max: 1000, int: true, desc: "少于该用户消息数不整理" },
    maxInputChars: { type: "number", def: 12000, min: 100, max: 100000, int: true, desc: "单次送模型的增量文本上限" },
  },
};

const SPEC = { ...SCALARS, ...SECTIONS };

const SECTION_DESCRIPTIONS = {
  save: "保存触发",
  memory: "记忆文件命名",
  recall: "检索权重",
  handoff: "新会话接力",
  autoRecall: "自动召回与检索档位",
  compaction: "压缩前记忆",
  nudge: "低使用率提醒",
  iam: "自我记忆 IAM",
  diary: "日记",
  forget: "顺序快照与遗忘",
  association: "回忆联想",
  characters: "人物档案",
  maintenance: "维护模型",
  backup: "版本快照（母文件夹之外）",
  idle: "空闲自动整理",
};

function checkTimeZone(value, pathText) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new Error(`配置项 ${pathText} 不是合法时区: ${value}`);
  }
}

function isLeaf(node) {
  return Boolean(node) && typeof node.type === "string";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function leafDefault(node) {
  if (node.def !== undefined) return clone(node.def);
  if (node.type === "array") return [];
  if (node.type === "string") return "";
  if (node.type === "number") return 0;
  if (node.type === "boolean") return false;
  return null;
}

function buildDefaults(spec) {
  const out = {};
  for (const [key, node] of Object.entries(spec)) {
    out[key] = isLeaf(node) ? leafDefault(node) : buildDefaults(node);
  }
  return out;
}

/** 默认配置（见 PLAN.md §3）。 */
export const DEFAULTS = deepFreeze(buildDefaults(SPEC));

function typeLabel(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

function isVolatile(value) {
  return Boolean(value) && typeof value === "object" && VOLATILE_WRITE in value;
}

/**
 * Schemastery 的 volatile 字段在运行时是 `{ get(), [write]() }` 包装对象。
 * 插件 apply() 拿到的是校验后的配置，必须解包后再走自己的 resolveConfig。
 */
function plainConfig(value) {
  if (isVolatile(value)) return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainConfig(item)]));
  }
  return value;
}

function validateLeaf(node, value, pathText) {
  if (node.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`配置项 ${pathText} 类型应为 boolean，实际为 ${typeLabel(value)}`);
    return value;
  }
  if (node.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`配置项 ${pathText} 类型应为 number，实际为 ${typeLabel(value)}`);
    }
    if (node.int && !Number.isInteger(value)) throw new Error(`配置项 ${pathText} 必须是整数`);
    if (node.min !== undefined && value < node.min) {
      throw new Error(`配置项 ${pathText} 超出范围：应 >= ${node.min}，实际为 ${value}`);
    }
    if (node.max !== undefined && value > node.max) {
      throw new Error(`配置项 ${pathText} 超出范围：应 <= ${node.max}，实际为 ${value}`);
    }
    return value;
  }
  if (node.type === "string") {
    if (typeof value !== "string") throw new Error(`配置项 ${pathText} 类型应为 string，实际为 ${typeLabel(value)}`);
    const normalized = value.trim();
    if (node.nonEmpty && !normalized) throw new Error(`配置项 ${pathText} 不能为空`);
    if (node.enum && !node.enum.includes(normalized)) {
      throw new Error(`配置项 ${pathText} 只能是 ${node.enum.join(" / ")}，实际为 ${normalized || "(空)"}`);
    }
    if (node.pattern && !node.pattern.test(normalized)) {
      throw new Error(`配置项 ${pathText} 格式不合法: ${normalized}`);
    }
    if (node.check) node.check(normalized, pathText);
    return normalized;
  }
  if (node.type === "array") {
    if (!Array.isArray(value)) throw new Error(`配置项 ${pathText} 类型应为 array，实际为 ${typeLabel(value)}`);
    if (node.minItems !== undefined && value.length < node.minItems) {
      throw new Error(`配置项 ${pathText} 至少需要 ${node.minItems} 项`);
    }
    const items = value.map((item, index) => validateLeaf(node.item, item, `${pathText}[${index}]`));
    if (node.sort) items.sort((a, b) => a - b);
    return items;
  }
  throw new Error(`未知配置类型: ${node.type}（${pathText}）`);
}

function normalizeSection(spec, raw, prefix) {
  const out = {};
  for (const [key, node] of Object.entries(spec)) {
    const pathText = prefix ? `${prefix}.${key}` : key;
    if (isLeaf(node)) {
      out[key] = raw[key] === undefined ? leafDefault(node) : validateLeaf(node, raw[key], pathText);
      continue;
    }
    const child = raw[key] === undefined ? {} : raw[key];
    if (!isPlainObject(child)) throw new Error(`配置项 ${pathText} 必须是对象`);
    out[key] = normalizeSection(node, child, pathText);
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      throw new Error(`未知配置键: ${prefix ? `${prefix}.${key}` : key}`);
    }
  }
  return out;
}

/**
 * 填充默认值并校验配置；非法配置抛出可读 Error。
 * @param {unknown} raw
 * @returns {object}
 */
export function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  // apply() 收到的是 Schemastery 校验结果：volatile 字段是 { get(), [write]() } 包装。
  raw = plainConfig(raw);
  if (!isPlainObject(raw)) throw new Error(`HDM 配置必须是对象，实际为 ${typeLabel(raw)}`);
  const merged = normalizeSection(SPEC, raw, "");
  merged.homeDir = path.resolve(expandHome(merged.homeDir));
  return merged;
}

function leafSchema(node, markVolatile = true) {
  if (node.type === "array") {
    // 数组元素不能标 volatile（宿主要求 volatile 字段位于固定对象路径），只有数组本身可标。
    let schema = Schema.array(leafSchema(node.item, false)).default(node.def).description(node.desc ?? "");
    if (node.minItems !== undefined) schema = schema.min(node.minItems);
    return markVolatile ? schema.volatile() : schema;
  }
  let schema;
  if (node.type === "boolean") schema = Schema.boolean();
  else if (node.type === "number") schema = Schema.number();
  else schema = Schema.string();
  if (node.type === "number") {
    if (node.min !== undefined) schema = schema.min(node.min);
    if (node.max !== undefined) schema = schema.max(node.max);
    if (node.int) schema = schema.step(1);
  }
  // 非空/格式等严格校验由 resolveConfig 负责；Schema 只负责投影与默认值。
  if (node.def !== undefined) schema = schema.default(node.def);
  if (node.pattern && typeof schema.pattern === "function") schema = schema.pattern(node.pattern);
  if (node.desc) schema = schema.description(node.desc);
  // 宿主设置文档只收录「可在线修改」的字段（settings 服务的 volatileForm 过滤），
  // 不标记 volatile 的插件根本不会出现在 describe 里，设置页也就无法读写。
  return markVolatile ? schema.volatile() : schema;
}

function sectionSchema(spec, description) {
  const dict = {};
  for (const [key, node] of Object.entries(spec)) {
    dict[key] = isLeaf(node) ? leafSchema(node) : sectionSchema(node, SECTION_DESCRIPTIONS[key]);
  }
  return Schema.object(dict).description(description ?? "");
}

/** 宿主配置 Schema（Schemastery）：内置设置页据此渲染 HDM 设置表单。 */
export const Config = sectionSchema(SPEC, "HDM 长期记忆配置");

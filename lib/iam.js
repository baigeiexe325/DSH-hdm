// IAM（自传体记忆）：固定标题的 IAM.md，首轮全文注入、定期自我锚点、受控更新。
import { promises as fs } from "node:fs";
import path from "node:path";

export const IAM_TEMPLATE = `# IAM（自传体记忆）

> 我是谁、从哪来、要去哪。由 hdm_iam_update 维护；固定标题不得删除。
> 各节按记忆写法：3~6 点降序、行内 ①②③ 编号、一句一事实、可核对、不堆形容词；「当前目标」末点写下一步或阻塞。

## 我是谁
（待补充）

## 我是怎样的人
（待补充）

## 人生阶段
（待补充）

## 重要关系
（待补充）

## 长期主题与价值
（待补充）

## 当前目标
（待补充）

## 自我叙事
（待补充）

## 记忆索引
（待补充）
`;

/** 设置页「生成 IAM 空白模板」写入的文件名与内容：固定标题齐全、正文留空，供用户手改。 */
export const IAM_BLANK_FILENAME = "IAM_Blank.md";

export const IAM_BLANK_TEMPLATE = `# IAM（自传体记忆 · 空白模板）

> 这份文件是**独立草稿**：HDM 不会自动读取它，也不会把它并入 IAM.md。
> 把你想让我长期记住的身份、目标、关系写进下面各节；何时使用由你决定。
> 固定标题不要删除；每节写 1~5 句即可，越具体越有用。
> 各节按记忆写法：3~6 点降序、行内 ①②③ 编号、一句一事实、可核对、不堆形容词；「当前目标」末点写下一步或阻塞。

## 我是谁

## 我是怎样的人

## 人生阶段

## 重要关系

## 长期主题与价值

## 当前目标

## 自我叙事

## 记忆索引
`;

export const REQUIRED_SECTIONS = Object.freeze([
  "我是谁",
  "我是怎样的人",
  "人生阶段",
  "重要关系",
  "长期主题与价值",
  "当前目标",
  "自我叙事",
  "记忆索引",
]);

// 锚点优先顺序：身份 / 风格 / 目标 / 关系 / 价值，其余按固定顺序补齐。
const ANCHOR_ORDER = [
  "我是谁",
  "我是怎样的人",
  "当前目标",
  "重要关系",
  "长期主题与价值",
  "人生阶段",
  "自我叙事",
  "记忆索引",
];

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*$/gm;
const PLACEHOLDER_RE = /^[（(](?:待补充|暂无|空)[）)]$/;

/* ------------------------------------------------------------------ */
/* 各节写作规则（确定性校验，不调 LLM）                                  */
/* ------------------------------------------------------------------ */

const CIRCLED_RE = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/;

/** 运行细节：路径、文件名、哈希、反引号代码——任何节都不该出现。 */
const RUN_DETAIL_RULES = Object.freeze([
  [/[A-Za-z]:[\\/]/, "本机路径"],
  [/\b[\w-]+\.(?:m?js|ts|json|md|txt|ps1|py|yml|yaml|asar)\b/i, "文件名/扩展名"],
  [/\b[0-9a-f]{7,40}\b/, "提交哈希"],
  [/`[^`]+`/, "反引号代码或工具名"],
  [/(报错|异常|超时|参数错|栈|日志|回写|内存副本|校验失败)/, "运行细节"],
]);

/** 内部实现与机制词：只禁出现在「描述自我」的节，不污染价值/目标/阶段。 */
const TECH_DETAIL_RULES = Object.freeze([[/\b(?:registry|commit|push|merge|API|token)\b/i, "实现机制词"]]);

/** 事件回忆：把「发生过什么」写进性格/关系里就是串味。 */
const INCIDENT_RULES = Object.freeze([[/^(?:曾|上次|之前那|那一天|那次)|(?:案例|例子)/, "事件回忆"]]);

/** 长括号解释：定位在说明原因或举例，不是描述性格本身。 */
const PAREN_EXPLAIN_RULE = [/[（(][^）)]{8,}[）)]/, "长括号解释"];

/**
 * 逐节规则：maxPoints 点数上限；maxPointChars 单点字数上限；
 * forbid 禁入模式；requirePerPoint 每条都必须命中的模式（如人生阶段要年份）。
 */
export const IAM_SECTION_RULES = Object.freeze({
  "我是谁": { maxPoints: 3, maxPointChars: 90, forbid: [...RUN_DETAIL_RULES, ...TECH_DETAIL_RULES] },
  "我是怎样的人": {
    maxPoints: 10,
    maxPointChars: 70,
    forbid: [...RUN_DETAIL_RULES, ...TECH_DETAIL_RULES, ...INCIDENT_RULES, PAREN_EXPLAIN_RULE],
  },
  "人生阶段": { maxPoints: 8, maxPointChars: 110, forbid: [...RUN_DETAIL_RULES], requirePerPoint: /20\d{2}/ },
  "重要关系": { maxPoints: 3, maxPointChars: 90, forbid: [...RUN_DETAIL_RULES, ...TECH_DETAIL_RULES, ...INCIDENT_RULES] },
  "长期主题与价值": { maxPoints: 6, maxPointChars: 60, forbid: [...RUN_DETAIL_RULES, ...INCIDENT_RULES] },
  "当前目标": { maxPoints: 5, maxPointChars: 120, forbid: [...RUN_DETAIL_RULES] },
  "自我叙事": {
    maxPoints: 6,
    maxPointChars: 80,
    forbid: [...RUN_DETAIL_RULES, ...TECH_DETAIL_RULES, ...INCIDENT_RULES, PAREN_EXPLAIN_RULE],
  },
});

/** 拆成「点」：有 ①②③ 就按编号拆，没有编号才按句子拆（整段当一点会让长段落被误判超长）。 */
function iamPoints(content) {
  const text = String(content ?? "").trim();
  if (!text) return [];
  const numbered = text.split(CIRCLED_RE).map((part) => part.trim()).filter(Boolean);
  if (CIRCLED_RE.test(text) && numbered.length) return numbered;
  return (text.match(/[^。！？；\n]+[。！？；]?/gu) ?? []).map((part) => part.trim()).filter(Boolean);
}

/**
 * 确定性校验一段要写入某节的正文，返回违规说明（空数组=通过）。
 * 不调 LLM、不看全局状态，纯正则与字数，成本为零。
 * @returns {string[]}
 */
export function lintIamContent(section, content) {
  const title = String(section ?? "").trim();
  const rules = IAM_SECTION_RULES[title];
  if (!rules) return [];
  const points = iamPoints(content);
  const errors = [];
  if (!points.length) return errors;
  if (points.length > rules.maxPoints) {
    errors.push(`点数 ${points.length} 超过上限 ${rules.maxPoints}`);
  }
  points.forEach((point, index) => {
    const label = `第 ${index + 1} 点`;
    const size = [...point].length;
    if (size > rules.maxPointChars) errors.push(`${label} ${size} 字超过 ${rules.maxPointChars} 字`);
    for (const [re, name] of rules.forbid ?? []) {
      if (re.test(point)) errors.push(`${label} 含${name}`);
    }
    // 里程碑必须带日期：编号点逐点要求；无编号整段按句拆开也逐句要求。
    if (rules.requirePerPoint && !rules.requirePerPoint.test(point)) {
      errors.push(`${label} 缺少时间（年份），人生阶段只罗列带日期的里程碑`);
    }
  });
  return [...new Set(errors)];
}

/** 整文校验（rewrite 用）：逐节跑同一套规则，带节名返回。 */
export function lintIamDocument(text) {
  const sections = extractSections(text);
  const errors = [];
  for (const [title, body] of Object.entries(sections)) {
    if (!IAM_SECTION_RULES[title]) continue;
    for (const error of lintIamContent(title, cleanSection(body))) errors.push(`§${title}：${error}`);
  }
  return errors;
}

function iamPath(home) {
  return path.join(home, "IAM.md");
}

function headings(text) {
  const src = String(text ?? "");
  const re = new RegExp(HEADING_RE.source, "gm");
  const list = [];
  let m;
  while ((m = re.exec(src))) list.push({ title: m[1].trim(), start: m.index, bodyStart: re.lastIndex });
  return list;
}

export function extractSections(text) {
  const src = String(text ?? "");
  const list = headings(src);
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const end = i + 1 < list.length ? list[i + 1].start : src.length;
    out[list[i].title] = src.slice(list[i].bodyStart, end).trim();
  }
  return out;
}

function replaceSection(text, title, body) {
  const list = headings(text);
  const idx = list.findIndex((h) => h.title === title);
  if (idx < 0) return null;
  const h = list[idx];
  const end = idx + 1 < list.length ? list[idx + 1].start : text.length;
  const head = text.slice(0, h.bodyStart).replace(/[ \t]+$/, "");
  const tail = text.slice(end);
  return `${head}\n${body.trim()}\n\n${tail}`.trimEnd() + "\n";
}

function appendToSection(text, title, body) {
  const list = headings(text);
  const idx = list.findIndex((h) => h.title === title);
  if (idx < 0) return null;
  const end = idx + 1 < list.length ? list[idx + 1].start : text.length;
  const head = text.slice(0, end).replace(/\s+$/, "");
  const tail = text.slice(end);
  return tail ? `${head}\n${body.trim()}\n\n${tail}` : `${head}\n${body.trim()}\n`;
}

function appendAtEnd(text, body) {
  return `${text.replace(/\s+$/, "")}\n\n${body.trim()}\n`;
}

/**
 * 补齐缺失的固定标题（旧 IAM 的自动自愈）。
 * 位置感知：缺失节插到「REQUIRED_SECTIONS 里排在它之后、且文件里已存在」的那个标题之前，
 * 这样旧文件补出的「我是怎样的人」会落在「我是谁」之后，而不是文件末尾。
 * 找不到后继标题时才追加末尾。已有正文一律不动。
 */
function ensureRequiredHeadings(text) {
  let out = `${text.replace(/\s+$/, "")}\n`;
  const have = new Set(Object.keys(extractSections(out)));
  const missing = REQUIRED_SECTIONS.filter((title) => !have.has(title));
  if (!missing.length) return out;

  // 按「后继标题」分组，同一后继前的多个缺失节按 REQUIRED_SECTIONS 顺序排列。
  const groups = new Map(); // anchorTitle（""=末尾） -> titles[]
  for (const title of missing) {
    const index = REQUIRED_SECTIONS.indexOf(title);
    const anchor = REQUIRED_SECTIONS.slice(index + 1).find((next) => have.has(next)) ?? "";
    if (!groups.has(anchor)) groups.set(anchor, []);
    groups.get(anchor).push(title);
  }

  // 从文件尾部往前插，保证前面的插入不移动后面锚点的偏移。
  const plan = [...groups.entries()]
    .map(([anchor, titles]) => ({ anchor, titles, at: anchor ? out.indexOf(`## ${anchor}`) : out.length }))
    .filter((item) => item.at >= 0)
    .sort((left, right) => right.at - left.at);

  const block = (titles) => `${titles.map((title) => `## ${title}\n（待补充）`).join("\n\n")}\n\n`;
  for (const { at, titles } of plan) {
    const head = out.slice(0, at).replace(/\s+$/, "");
    const tail = out.slice(at).replace(/^\s+/, "");
    out = tail ? `${head}\n\n${block(titles)}${tail}` : `${head}\n\n${block(titles).trimEnd()}\n`;
  }
  return out;
}

function cleanSection(section) {
  if (typeof section !== "string") return "";
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line && !PLACEHOLDER_RE.test(line))
    .join(" ");
}

function firstSentences(text, count) {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) || [];
  return parts.map((s) => s.trim()).filter(Boolean).slice(0, count).join("");
}

/**
 * 锚点取句：首句 + 末个非空句（去重，总句数仍 ≤2）。
 * 只用前两句会让 append 到节尾的新事实永远不进锚点——后追加的内容总在末尾。
 */
export function headAndTailSentences(text, maxSentences = 2) {
  const parts = (text.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) || []).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  const limit = positiveInt(maxSentences, 2);
  if (parts.length <= limit) return parts.join("");
  const head = parts[0];
  const tail = parts[parts.length - 1];
  if (limit === 1) return tail;
  return head === tail ? head : `${head}${tail}`;
}

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

async function userTone(home) {
  const raw = await readIfExists(path.join(home, "characters", "USER.md"));
  if (!raw) return "";
  const body = cleanSection(extractSections(raw)["偏好与语气"]);
  return body ? firstSentences(body, 1) : "";
}

export async function ensureIam(home) {
  const file = iamPath(home);
  const existing = await readIfExists(file);
  if (existing != null) return existing;
  await atomicWrite(file, IAM_TEMPLATE);
  return IAM_TEMPLATE;
}

/**
 * 写出 `IAM_Blank.md` 空白模板（设置页按钮用）。
 * 默认不覆盖用户已改过的文件；`overwrite:true` 才重写。
 * 返回 `{ok, path, existed, overwritten, bytes}`：`existed` 指调用前文件是否已存在，
 * `overwritten` 指本次是否真的重写了（两者含义不同，别混用）。
 */
export async function ensureIamBlank(home, { overwrite = false } = {}) {
  const file = path.join(home, IAM_BLANK_FILENAME);
  try {
    const existing = await readIfExists(file);
    if (existing != null && !overwrite) {
      return { ok: true, path: file, existed: true, overwritten: false, bytes: Buffer.byteLength(existing, "utf8") };
    }
    await atomicWrite(file, IAM_BLANK_TEMPLATE);
    return {
      ok: true,
      path: file,
      existed: existing != null,
      overwritten: existing != null,
      bytes: Buffer.byteLength(IAM_BLANK_TEMPLATE, "utf8"),
    };
  } catch (error) {
    return {
      ok: false,
      path: file,
      existed: false,
      overwritten: false,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildIamContext(home, maxChars) {
  const text = await ensureIam(home);
  const limit = positiveInt(maxChars, 6000);
  return text.length > limit ? text.slice(0, limit) : text;
}

export async function buildIamAnchor(home, config = {}) {
  const limit = positiveInt(config?.iam?.anchorMaxChars ?? config?.anchorMaxChars, 400);
  const text = await ensureIam(home);
  const sections = extractSections(text);
  const parsed = REQUIRED_SECTIONS.some((title) => Object.hasOwn(sections, title));
  if (!parsed) return text.slice(0, Math.min(400, limit));

  const bodies = ANCHOR_ORDER.map((title) => ({ title, body: cleanSection(sections[title]) })).filter((item) => item.body);

  // 贪心填充：按 ANCHOR_ORDER 逐节塞；放不下的节先记下，最后用剩余预算截尾补上，
  // 保证「每节都出现」优先于「某几节完整」——锚点只用来提醒自己是谁，截断不丢关键点。
  const fill = (pieceOf, clip) => {
    const out = [];
    const skipped = [];
    let used = 0;
    for (const { title, body } of bodies) {
      const piece = pieceOf(body);
      const line = `${title}：${piece}`;
      const next = used === 0 ? line.length : used + 1 + line.length;
      if (next > limit) {
        skipped.push({ title, piece });
        continue;
      }
      out.push(line);
      used = next;
    }
    if (!clip) return out;
    for (const { title, piece } of skipped) {
      const room = limit - used - 1 - title.length - 1;
      if (room < 8) break;
      const clipped = Array.from(piece).slice(0, room - 1).join("");
      out.push(`${title}：${clipped}…`);
      used += 1 + title.length + 1 + clipped.length + 1;
    }
    return out;
  };

  // 第三遍：预算按节均分，每节都留位置（标题必现，正文按份额截断）。
  // 只在贪心+截尾仍漏节时启用——均分会浪费短节的空额，但不漏节。
  const evenFill = () => {
    const per = Math.max(12, Math.floor((limit - (bodies.length - 1)) / bodies.length));
    return bodies.map(({ title, body }) => {
      const room = Math.max(4, per - title.length - 1);
      const piece = Array.from(headAndTailSentences(body, 1)).slice(0, room).join("");
      return `${title}：${piece}${piece.length < Array.from(headAndTailSentences(body, 1)).length ? "…" : ""}`;
    });
  };

  // 三遍取覆盖最多的那个：
  // - 富信息遍：每节「首句+末句」，信息最全，但长节会吃光预算、把后面的节整节挤没；
  // - 公平遍：每节只取末句（放不下的截尾补上），节尾（最新追加）优先；
  // - 均分遍：仍漏节时按节平分预算，保证每个有正文的节都出现。
  // 实机 IAM 400 字预算下富信息遍只装下 4 节，公平遍 6~7 节，均分遍 8 节。
  const rich = fill((body) => headAndTailSentences(body, 2), false);
  const fair = fill((body) => headAndTailSentences(body, 1), true);
  const candidates = [rich, fair, evenFill()];
  const parts = candidates.reduce((best, next) => (next.length > best.length ? next : best), candidates[0]);

  const includeTone = config?.iam?.anchorIncludeUserTone ?? config?.anchorIncludeUserTone ?? true;
  if (includeTone) {
    const tone = await userTone(home);
    if (tone) parts.push(`语气：${tone}`);
  }

  const anchor = parts.join("\n");
  const result = anchor.trim() ? anchor : text.slice(0, Math.min(400, limit));
  return result.length > limit ? result.slice(0, limit) : result;
}

function clipText(value, max) {
  const chars = Array.from(String(value ?? ""));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function memoryTitle(meta) {
  const event = String(meta?.event ?? "").trim();
  if (event) return clipText(event, 48);
  const label = String(meta?.label ?? "").replace(/^[0-2]_/, "");
  const keywords = label.split("_").slice(2).join("-");
  return clipText(keywords || label || meta?.uid || "", 48);
}

/**
 * 渲染 IAM「记忆索引」小节：只保留统计 + 最近 N 条，完整清单以 index/memories.json 为准。
 * 这样即使记忆上千条，IAM 也不会线性膨胀。
 */
export function renderMemoryIndex(registry, { maxRecent = 12 } = {}) {
  const list = (registry?.list?.() || []).filter(Boolean);
  if (!list.length) return "（暂无记忆；完整清单见 index/memories.json）";
  const sorted = [...list].sort(
    (left, right) => String(right.date).localeCompare(String(left.date)) || (Number(right.seq) || 0) - (Number(left.seq) || 0),
  );
  const byDate = new Map();
  for (const meta of list) byDate.set(meta.date, (byDate.get(meta.date) ?? 0) + 1);
  const latest = sorted[0]?.date ?? "";
  const lines = [
    `> 自动维护：完整清单见 index/memories.json；此处只保留最近 ${maxRecent} 条与统计，避免 IAM 随记忆数膨胀。`,
    `- 统计：共 ${list.length} 条，覆盖 ${byDate.size} 天；最新 ${latest}（${byDate.get(latest) ?? 0} 条）`,
    "- 最近：",
  ];
  for (const meta of sorted.slice(0, maxRecent)) {
    lines.push(`  - ${meta.uid} ${memoryTitle(meta)}`);
  }
  return lines.join("\n");
}

/** 用生成的小结替换 IAM 的「记忆索引」小节；返回是否发生写入。 */
export async function syncIamIndex(home, registry, options = {}) {
  const current = await ensureIam(home);
  const body = renderMemoryIndex(registry, options);
  const next = replaceSection(current, "记忆索引", body);
  if (next == null || next === current) return false;
  await atomicWrite(iamPath(home), next);
  return true;
}

export async function updateIam(home, input = {}, maxChars) {
  const mode = input.mode || "append";
  const content = String(input.content ?? "").trim();
  const section = String(input.section ?? "").trim();
  const current = await ensureIam(home);
  const limit = positiveInt(maxChars, 6000);
  const reject = (message, chars = current.length) => ({ ok: false, chars, mode, error: message });

  if (!content) return reject("content 不能为空：请提供要写入 IAM 的正文。");
  if (mode !== "append" && mode !== "replace_section" && mode !== "rewrite") {
    return reject(`不支持的 mode「${mode}」；可用 append / replace_section / rewrite。`);
  }
  if (section === "记忆索引") {
    return reject("「记忆索引」由系统自动维护，不接受手写；请改用其他节。");
  }

  // 确定性校验（零 token）：各节职责互斥、单点不写过程与运行细节。
  // 写错方向的内容在这里被拒，而不是等下次注入时才发现串味。
  const violations = [];
  if (mode === "rewrite") {
    violations.push(...lintIamDocument(content));
  } else if (section) {
    violations.push(...lintIamContent(section, content));
  }
  if (violations.length) {
    return reject(`IAM 写入被拒（${section || "追加"}）：${violations.slice(0, 6).join("；")}。请只写结论、去掉过程与运行细节后重试。`);
  }

  let next;
  if (mode === "append") {
    if (section) {
      next = appendToSection(current, section, content);
      if (next == null) {
        return reject(`IAM 中不存在章节「${section}」；现有章节：${REQUIRED_SECTIONS.join(" / ")}。`);
      }
    } else {
      next = appendAtEnd(current, content);
    }
  } else if (mode === "replace_section") {
    if (!section) return reject("replace_section 需要 section：请指定要替换的固定标题。");
    next = replaceSection(current, section, content);
    if (next == null) {
      return reject(`IAM 中不存在章节「${section}」；现有章节：${REQUIRED_SECTIONS.join(" / ")}。`);
    }
  } else {
    next = `${content}\n`;
  }

  next = ensureRequiredHeadings(next);
  if (next.length > limit) {
    return reject(
      `IAM 更新后将达 ${next.length} 字，超过上限 ${limit} 字；请压缩 content 后重试，或用 replace_section 替换旧章节。`,
      next.length,
    );
  }
  await atomicWrite(iamPath(home), next);
  return { ok: true, chars: next.length, mode };
}

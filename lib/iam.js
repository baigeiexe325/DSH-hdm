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

  const parts = [];
  for (const title of ANCHOR_ORDER) {
    const body = cleanSection(sections[title]);
    if (body) parts.push(`${title}：${firstSentences(body, 2)}`);
  }

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

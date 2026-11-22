// 人物档案：USER 优先、只追加、每条带日期/证据/置信度，冲突写入“待确认 / 矛盾”。
import { promises as fs } from "node:fs";
import path from "node:path";

export const USER_TEMPLATE = `# USER 档案

> 用户本人档案，优先级 0；由 hdm_save / hdm_character_update 维护；只追加、不覆盖；冲突写入「待确认 / 矛盾」。

## 基本
（待补充）

## 偏好与语气
（待补充）

## 关系与互动
（待补充）

## 待确认 / 矛盾
（暂无）

## 记忆索引
（暂无）
`;

const CONFLICT_SECTION = "待确认 / 矛盾";
const DEFAULT_CONFIDENCE = 0.6;
// 章节别名：模型常写「偏好」「基本信息」「与我的关系」，而模板标题是「偏好与语气」「基本」
// 「关系与互动」。appendSection 是精确标题匹配，不归一化就会在文件末尾长出重复章节。
const SECTION_ALIASES = new Map(
  Object.entries({
    偏好: "偏好与语气",
    偏好与性格: "偏好与语气",
    语气: "偏好与语气",
    性格: "偏好与语气",
    基本信息: "基本",
    基础: "基本",
    与我的关系: "关系与互动",
    关系: "关系与互动",
    矛盾: "待确认 / 矛盾",
    待确认: "待确认 / 矛盾",
    索引: "记忆索引",
  }).map(([from, to]) => [from.toLowerCase(), to]),
);

function normalizeHeading(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[\s「」"']/g, "");
}

/** 把模型给的章节名对到文件里已有的标题（精确 → 归一化 → 别名），对不上才用原名新建。 */
function resolveHeading(text, requested) {
  const title = String(requested ?? "").trim();
  if (!title) return title;
  const list = headings(text);
  const exact = list.find((h) => h.title === title);
  if (exact) return exact.title;
  const normalized = list.find((h) => normalizeHeading(h.title) === normalizeHeading(title));
  if (normalized) return normalized.title;
  const alias = SECTION_ALIASES.get(title.toLowerCase());
  if (alias) {
    const hit = list.find((h) => normalizeHeading(h.title) === normalizeHeading(alias));
    return hit ? hit.title : alias;
  }
  return title;
}
const DEFAULT_ALIASES = Object.freeze({
  "我": "USER",
  "用户": "USER",
  "你": "USER",
  user: "USER",
  me: "USER",
  USER: "USER",
});

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*$/gm;
const NEGATION_RE = /不|没|并非|不是|不再|从未|无|别/;

function charactersDir(home) {
  return path.join(home, "characters");
}

function userPath(home) {
  return path.join(charactersDir(home), "USER.md");
}

function aliasesPath(home) {
  return path.join(charactersDir(home), "_aliases.json");
}

function characterPath(home, canonical) {
  return path.join(charactersDir(home), `${slugPerson(canonical)}.md`);
}

function characterTemplate(name) {
  return `# ${name} 档案

> 人物档案，优先级 1；只追加、不覆盖；冲突写入「待确认 / 矛盾」。

## 基本
（待补充）

## 待确认 / 矛盾
（暂无）

## 记忆索引
（暂无）
`;
}

function headings(text) {
  const src = String(text ?? "");
  const re = new RegExp(HEADING_RE.source, "gm");
  const list = [];
  let m;
  while ((m = re.exec(src))) list.push({ title: m[1].trim(), start: m.index, bodyStart: re.lastIndex });
  return list;
}

function cleanSection(section) {
  if (typeof section !== "string") return "";
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line && !/^[（(](?:待补充|暂无|空)[）)]$/.test(line))
    .join(" ");
}

function replaceSection(text, title, body) {
  const list = headings(text);
  const idx = list.findIndex((h) => h.title === title);
  if (idx < 0) return null;
  const h = list[idx];
  const end = idx + 1 < list.length ? list[idx + 1].start : text.length;
  const head = text.slice(0, h.bodyStart).replace(/[ \t]+$/, "");
  return `${head}\n${body.trim()}\n\n${text.slice(end)}`.trimEnd() + "\n";
}

function appendSection(text, title, body) {
  const list = headings(text);
  const idx = list.findIndex((h) => h.title === title);
  if (idx < 0) return `${text.replace(/\s+$/, "")}\n\n## ${title}\n${body.trim()}\n`;
  const end = idx + 1 < list.length ? list[idx + 1].start : text.length;
  const head = text.slice(0, end).replace(/\s+$/, "");
  const tail = text.slice(end);
  return tail ? `${head}\n${body.trim()}\n\n${tail}` : `${head}\n${body.trim()}\n`;
}

function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readIfExists(file) {
  return fs.readFile(file, "utf8").catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

function clampInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
}

function aliasMapFromRaw(raw) {
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw)) {
    const alias = String(key).trim();
    if (!alias) continue;
    if (typeof value === "string" && value.trim()) map[alias] = value.trim();
    else if (Array.isArray(value)) {
      for (const item of value) {
        const a = String(item ?? "").trim();
        if (a) map[a] = alias;
      }
    }
  }
  return map;
}

function resolveName(aliases, name) {
  const raw = String(name ?? "").trim();
  return aliases[raw] ?? aliases[raw.toLowerCase()] ?? raw;
}

function compact(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:"“”'（）()【】[\]]/g, "");
}

function stripNegation(text) {
  return compact(text).replace(/并非|不是|不再|从未|不|没|无|别/g, "");
}

function notesConflict(existing, incoming) {
  const a = compact(existing);
  const b = compact(incoming);
  if (!a || !b) return false;
  if (NEGATION_RE.test(existing) === NEGATION_RE.test(incoming)) return false;
  const sa = stripNegation(existing);
  const sb = stripNegation(incoming);
  if (sa.length < 2 || sb.length < 2) return false;
  return sa.includes(sb) || sb.includes(sa);
}

function detectsConflict(text, notes) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("- ")) continue;
    const entry = line
      .replace(/^-\s*\[[^\]]*\]\s*/, "")
      .replace(/\s*（证据[:：][^）]*）\s*$/, "")
      .trim();
    if (!entry || entry.includes("冲突")) continue;
    if (notesConflict(entry, notes)) return true;
  }
  return false;
}

async function ensureProfile(home, canonical) {
  if (canonical.toUpperCase() === "USER") return ensureUserProfile(home);
  const file = characterPath(home, canonical);
  const existing = await readIfExists(file);
  if (existing != null) return existing;
  await atomicWrite(file, characterTemplate(canonical));
  return characterTemplate(canonical);
}

async function readAliasesRaw(home) {
  const raw = await readIfExists(aliasesPath(home));
  if (raw == null) return {};
  try {
    return aliasMapFromRaw(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function persistAliases(home, canonical, aliases) {
  if (!Array.isArray(aliases) || aliases.length === 0) return;
  const map = { ...(await readAliasesRaw(home)), [canonical]: canonical };
  for (const alias of aliases) {
    const a = String(alias ?? "").trim();
    if (a) map[a] = canonical;
  }
  await atomicWrite(aliasesPath(home), `${JSON.stringify(map, null, 2)}\n`);
}

export function slugPerson(name) {
  const cleaned = String(name ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[. _]+|[. _]+$/g, "")
    .slice(0, 60);
  return cleaned || "未命名";
}

export async function loadAliases(home) {
  const aliases = { ...DEFAULT_ALIASES, ...(await readAliasesRaw(home)) };
  return aliases;
}

/** 取某节正文（节标题精确匹配），缺节返回空串。 */
function sectionBody(text, title) {
  const list = headings(text);
  const idx = list.findIndex((h) => h.title === title);
  if (idx < 0) return "";
  const end = idx + 1 < list.length ? list[idx + 1].start : text.length;
  return cleanSection(text.slice(list[idx].bodyStart, end));
}

/**
 * 人物档案摘录：召回命中人物关键词时随结果一起给出，避免模型再去读文件。
 * USER 先「基本」后「偏好与语气」「关系与互动」；其他人物只有「基本」。取前两句并截到 maxChars。
 * @returns {Promise<{name:string,path:string,excerpt:string}|null>}
 */
export async function buildCharacterSnippet(home, name, maxChars = 200) {
  if (!home) return null;
  const aliases = await loadAliases(home);
  const canonical = resolveName(aliases, name) || String(name ?? "").trim();
  if (!canonical) return null;
  const isUser = canonical.toUpperCase() === "USER";
  const file = isUser ? userPath(home) : characterPath(home, canonical);
  const text = await readIfExists(file);
  if (text == null) return null;
  const order = isUser ? ["基本", "偏好与语气", "关系与互动"] : ["基本"];
  let body = "";
  for (const title of order) {
    body = sectionBody(text, title);
    if (body) break;
  }
  if (!body) return null;
  const sentences = body.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) || [];
  const excerpt = sentences.map((s) => s.trim()).filter(Boolean).slice(0, 2).join("");
  const limit = clampInt(maxChars, 200);
  return { name: isUser ? "USER" : canonical, path: file, excerpt: excerpt.slice(0, limit) };
}

export async function ensureUserProfile(home) {
  const file = userPath(home);
  const existing = await readIfExists(file);
  if (existing != null) return existing;
  await atomicWrite(file, USER_TEMPLATE);
  return USER_TEMPLATE;
}

export async function updateCharacter(home, input = {}, maxChars) {
  const rawName = String(input.name ?? "").trim();
  if (!rawName) throw new Error("name 必填：请提供人物名或别名。");

  const aliases = await loadAliases(home);
  const canonical = resolveName(aliases, rawName) || rawName;
  const isUser = canonical.toUpperCase() === "USER";
  const displayName = isUser ? "USER" : canonical;
  const priority = isUser ? 0 : 1;
  const file = isUser ? userPath(home) : characterPath(home, canonical);
  const limit = clampInt(maxChars, 12000);
  const notes = String(input.notes ?? "").trim();
  const requestedSection = String(input.section ?? "").trim();
  const mode = input.mode === "replace_section" ? "replace_section" : "append";

  const text = isUser ? await ensureUserProfile(home) : await ensureProfile(home, canonical);

  if (!notes) {
    await persistAliases(home, canonical, input.aliases);
    return { ok: true, path: file, section: requestedSection || "基本", priority };
  }

  const conflict = input.conflict === true || detectsConflict(text, notes);
  // 章节名先归一到文件里已有的标题，避免「偏好」与「偏好与语气」并存这类重复章节。
  const section = conflict ? CONFLICT_SECTION : resolveHeading(text, requestedSection || "基本");
  const confidence = clampConfidence(input.confidence);
  const evidence = String(input.evidenceUid ?? "").trim() || "无";
  const marker = conflict ? "⚠️ 冲突：" : "";
  const entry = `- [${localDate()}] ${marker}${notes}（证据: ${evidence}；置信度: ${confidence}）`;

  let next;
  if (mode === "replace_section") {
    next = replaceSection(text, section, entry) ?? appendSection(text, section, entry);
  } else {
    next = appendSection(text, section, entry);
  }

  if (next.length > limit) {
    return {
      ok: false,
      path: file,
      section,
      priority,
      chars: next.length,
      error: `「${displayName}」档案更新后将达 ${next.length} 字，超过上限 ${limit} 字；请精简 notes 或拆分独立人物档案。`,
    };
  }

  await atomicWrite(file, next);
  await persistAliases(home, canonical, input.aliases);
  return { ok: true, path: file, section, priority };
}

export async function applySaveCharacters(home, characters, evidenceUid, maxChars) {
  const list = Array.isArray(characters) ? characters.filter((c) => c && typeof c === "object") : [];
  const aliases = await loadAliases(home);
  const rows = list
    .map((character, index) => {
      const canonical = resolveName(aliases, character.name);
      return {
        character,
        index,
        canonical,
        priority: canonical && canonical.toUpperCase() === "USER" ? 0 : 1,
      };
    })
    .filter((row) => row.canonical);

  rows.sort((a, b) => a.priority - b.priority || a.index - b.index);

  const results = [];
  for (const row of rows) {
    const input = { ...row.character, evidenceUid: row.character.evidenceUid ?? evidenceUid };
    const result = await updateCharacter(home, input, maxChars);
    results.push({ name: row.canonical, path: result.path, ok: result.ok });
  }
  return results;
}

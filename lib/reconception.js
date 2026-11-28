/**
 * reconception（0.4.0）：档案调取入口 —— 事件 / 人物 / 关键词三类「档案」。
 *
 * 与 recall 分工：recall 检索「记忆单元」（memory/**\/meta.json + 关键词倒排），
 * reconception 调取已经写下的成文档案（Events/*.txt、characters/*.md、Imagery/*.md）。
 * 只读：不建目录、不重建索引、不写任何文件；未命中返回 matches:[] 而不是抛错（让模型看到「没有」）。
 * 纯 ESM，只用 node: 内置模块与 events / characters / imagery。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { eventFileName, eventSlug, listEvents, readEvent } from "./events.js";
import { buildCharacterSnippet, loadAliases } from "./characters.js";
import { listImagery, readImagery } from "./imagery.js";

export const RECONCEPTION_DEFAULTS = Object.freeze({
  enabled: true,
  maxReadChars: 6000,
  maxIndexItems: 20,
});

const KINDS = Object.freeze(["event", "character", "keyword"]);
const IMAGERY_INDEX_HEADING = "## 记忆索引";

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 对外声明可调取的三类档案（工具 enum 与技能正文共用同一份来源）。 */
export function reconceptionKinds() {
  return [...KINDS];
}

function toPosix(rel) {
  return String(rel ?? "").replace(/\\/g, "/");
}

async function sizeOf(file) {
  const info = await fs.stat(file).catch(() => null);
  return info?.size ?? 0;
}

async function bytesOf(home, rels) {
  let total = 0;
  for (const rel of Array.isArray(rels) ? rels : []) total += await sizeOf(path.join(home, rel));
  return total;
}

/** 事件档案路径：索引里的 files 优先；只有 meta.event 没有档案文件时按命名规则给出预期路径。 */
function eventFileOf(entry) {
  const first = entry?.files?.[0];
  if (first) return toPosix(first);
  const name = eventFileName(entry?.term) || `${eventSlug(entry?.term)}.txt`;
  return toPosix(path.join("Events", name));
}

/** 从档案正文的「## 记忆索引」段取 uid（imagery 索引只缓存分数，不缓存 uids）。 */
function sectionUids(text, heading = IMAGERY_INDEX_HEADING) {
  const src = String(text ?? "");
  const at = src.indexOf(heading);
  if (at < 0) return [];
  const rest = src.slice(at + heading.length);
  const next = rest.search(/^##\s/m);
  const body = next < 0 ? rest : rest.slice(0, next);
  const out = [];
  for (const line of body.split("\n")) {
    const match = /^-\s+(\S+)/.exec(line.trim());
    if (match && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

function uidsOf(value, text) {
  if (Array.isArray(value)) return value.map((uid) => String(uid ?? "").trim()).filter(Boolean);
  return sectionUids(text);
}

function collectUids(matches) {
  const out = [];
  for (const match of matches) {
    for (const uid of match.uids ?? []) if (!out.includes(uid)) out.push(uid);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* event：Events/<事件名>.txt                                          */
/* ------------------------------------------------------------------ */

/** 事件名归一：slug 去掉分隔符后再双向包含，空格/大小写/连字符变体也同口径（P2-3）。 */
function eventKey(value) {
  return eventSlug(value).replace(/-/g, "");
}

/** index 与 read 共用的命中判定：事件名宽泛（`维护` 命中 `维护插件`）。 */
function hitsEvent(termText, entry) {
  const needle = eventKey(termText);
  if (!needle) return true;
  const own = eventKey(entry.term);
  return own.includes(needle) || needle.includes(own);
}

/** 把宽泛 term 解析成唯一事件名：先精确 slug，再按 index 同口径取更新最近的一条。 */
async function resolveEventTerm(home, termText) {
  const slug = eventSlug(termText);
  if (!slug) return "";
  const entries = await listEvents(home);
  const exact = entries.find((entry) => eventSlug(entry.term) === slug);
  if (exact) return exact.term;
  const hit = entries.find((entry) => hitsEvent(termText, entry));
  return hit ? hit.term : "";
}

async function indexEvents(home, termText, maxItems) {
  const entries = await listEvents(home);
  const hits = entries.filter((entry) => hitsEvent(termText, entry)).slice(0, maxItems);

  const matches = [];
  for (const entry of hits) {
    matches.push({
      file: eventFileOf(entry),
      uids: [...(entry.uids ?? [])],
      chars: await bytesOf(home, entry.files),
      title: entry.term,
    });
  }
  return matches;
}

async function readEventArchive(home, termText, limit) {
  // read 仍按精确 slug 解析文件名，但先用 index 的同口径把 term 解析成 slug（P2-3）。
  const resolved = (await resolveEventTerm(home, termText)) || termText;
  let result;
  try {
    result = await readEvent(home, resolved, limit);
  } catch {
    // 没有该事件：返回空匹配，让模型自己看到「没有」，不要抛错。
    return { matches: [] };
  }
  const uids = [...(result.entry.uids ?? [])];
  return {
    matches: [{ file: eventFileOf(result.entry), uids, chars: result.text.length, title: result.entry.term }],
    term: result.entry.term,
    text: result.text,
    truncated: result.truncated,
    relatedUids: uids,
  };
}

/* ------------------------------------------------------------------ */
/* character：characters/<人物>.md                                     */
/* ------------------------------------------------------------------ */

function charactersDir(home) {
  return path.join(home, "characters");
}

async function characterNames(home) {
  try {
    const names = await fs.readdir(charactersDir(home));
    return names.filter((name) => name.toLowerCase().endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function characterTitle(name) {
  return path.basename(name, path.extname(name));
}

/** 归一后匹配：term 经 loadAliases 变成规范名，再对文件名或「别名 → 规范名」表。 */
function hitsCharacter(base, termText, canonical, aliases) {
  const key = termText.toLowerCase();
  if (base.toLowerCase() === key || base.toLowerCase() === String(canonical).toLowerCase()) return true;
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (String(target).toLowerCase() !== base.toLowerCase()) continue;
    if (String(alias).toLowerCase() === key) return true;
  }
  return false;
}

async function indexCharacters(home, termText, maxItems) {
  const aliases = await loadAliases(home);
  const canonical = termText ? (aliases[termText] ?? aliases[termText.toLowerCase()] ?? termText) : "";
  const matches = [];
  for (const name of await characterNames(home)) {
    if (matches.length >= maxItems) break;
    const base = characterTitle(name);
    if (termText && !hitsCharacter(base, termText, canonical, aliases)) continue;
    matches.push({
      file: `characters/${name}`,
      uids: [],
      chars: await sizeOf(path.join(charactersDir(home), name)),
      title: base,
    });
  }
  return matches;
}

async function readCharacter(home, termText, limit) {
  // 摘录本身就限长（「基本 / 偏好与语气 / 关系与互动」前两句），不再标 truncated。
  const snippet = await buildCharacterSnippet(home, termText, limit);
  if (!snippet) return { matches: [] };
  return {
    matches: [
      {
        file: toPosix(path.relative(home, snippet.path)),
        uids: [],
        chars: snippet.excerpt.length,
        title: snippet.name,
      },
    ],
    term: snippet.name,
    text: snippet.excerpt,
    truncated: false,
  };
}

/* ------------------------------------------------------------------ */
/* keyword：Imagery/<词>.md                                            */
/* ------------------------------------------------------------------ */

async function indexKeywords(home, termText, maxItems) {
  const needle = termText.toLowerCase();
  const rows = await listImagery(home);
  const hits = (needle ? rows.filter((row) => row.term.toLowerCase().includes(needle)) : rows).slice(0, maxItems);

  const matches = [];
  for (const row of hits) {
    let text = "";
    try {
      text = await fs.readFile(path.join(home, row.file), "utf8");
    } catch {
      text = "";
    }
    matches.push({
      file: toPosix(row.file),
      uids: uidsOf(row.uids, text),
      chars: text ? text.length : await sizeOf(path.join(home, row.file)),
      title: row.term,
    });
  }
  return matches;
}

async function readKeyword(home, termText, limit) {
  let result;
  try {
    result = await readImagery(home, termText, limit);
  } catch {
    return { matches: [] };
  }
  let full = "";
  try {
    full = await fs.readFile(path.join(home, result.entry.file), "utf8");
  } catch {
    full = "";
  }
  const uids = uidsOf(result.entry.uids, full);
  return {
    matches: [{ file: toPosix(result.entry.file), uids, chars: result.text.length, title: result.entry.term }],
    term: result.entry.term,
    text: result.text,
    truncated: result.truncated,
    relatedUids: uids,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 调取一类档案。
 * @param {object} input
 * @param {string} input.home 母文件夹
 * @param {object} [input.registry] 记忆注册表（与其它工具同签名；调取档案不需要它写盘）
 * @param {"event"|"character"|"keyword"} input.kind 档案类型
 * @param {string} [input.term] 事件名 / 人物名或别名 / 关键词；kind=event 的 index 可空
 * @param {"index"|"read"} [input.mode] index 看有哪些档案，read 读正文
 * @param {number} [input.maxReadChars] read 的正文上限（默认 RECONCEPTION_DEFAULTS.maxReadChars）
 * @param {number} [input.maxIndexItems] index 的条数上限（默认 RECONCEPTION_DEFAULTS.maxIndexItems）
 * @param {object} [input.config] 插件配置（读 config.reconception，缺省回退 RECONCEPTION_DEFAULTS）
 * @returns {Promise<{ok:true, kind:string, term:string, mode:string, matches:Array, text?:string, truncated?:boolean, relatedUids:string[]}>}
 */
export async function reconcept({
  home,
  registry,
  kind,
  term = "",
  mode = "index",
  maxReadChars,
  maxIndexItems,
  config,
} = {}) {
  void registry; // 只读档案；保留参数以与其它工具同签名
  if (!home) throw new Error("HDM: reconception 需要 home。");
  const root = path.resolve(home);
  const options = config?.reconception && typeof config.reconception === "object" ? config.reconception : {};

  const kindText = String(kind ?? "").trim();
  if (!KINDS.includes(kindText)) {
    throw new Error(`HDM: 未知的 reconception kind: ${kindText || "（空）"}（可选 ${KINDS.join("/")}）`);
  }
  const modeText = String(mode ?? "index").trim() || "index";
  if (modeText !== "index" && modeText !== "read") {
    throw new Error(`HDM: 未知的 reconception mode: ${modeText}（可选 index/read）`);
  }
  const termText = String(term ?? "").trim();
  // 事件表可以空 term 列出；其余情况（含任何 read）都必须有 term。
  if (!termText && (kindText !== "event" || modeText === "read")) {
    throw new Error("HDM: reconception 需要 term");
  }

  const readLimit = Math.max(200, Math.trunc(finite(maxReadChars ?? options.maxReadChars, RECONCEPTION_DEFAULTS.maxReadChars)));
  const maxItems = Math.max(1, Math.trunc(finite(maxIndexItems ?? options.maxIndexItems, RECONCEPTION_DEFAULTS.maxIndexItems)));

  let result;
  if (kindText === "event") {
    result = modeText === "read" ? await readEventArchive(root, termText, readLimit) : { matches: await indexEvents(root, termText, maxItems) };
  } else if (kindText === "character") {
    result = modeText === "read" ? await readCharacter(root, termText, readLimit) : { matches: await indexCharacters(root, termText, maxItems) };
  } else {
    result = modeText === "read" ? await readKeyword(root, termText, readLimit) : { matches: await indexKeywords(root, termText, maxItems) };
  }

  const matches = Array.isArray(result.matches) ? result.matches : [];
  const payload = {
    ok: true,
    kind: kindText,
    term: typeof result.term === "string" && result.term ? result.term : termText,
    mode: modeText,
    matches,
    relatedUids: Array.isArray(result.relatedUids) ? result.relatedUids : collectUids(matches),
  };
  if (typeof result.text === "string") {
    payload.text = result.text;
    payload.truncated = result.truncated === true;
  }
  return payload;
}

export default {
  RECONCEPTION_DEFAULTS,
  reconcept,
  reconceptionKinds,
};

#!/usr/bin/env node
// 核对 README 的「配置」表格与 lib/config.js 的 DEFAULTS 是否一致。
//
// 为什么需要它：测试全绿只证明代码行为对，证明不了文档对。0.3.0 发布前
// README 表格写 `recall.topK` 默认 3、代码实为 0，同一份文档另一处又写
// topK=0——测试抓不到这种矛盾，只能靠工具对账。
//
// 三类检查：
//   1. 文档写了但代码没有 —— 错误（文档在教用户传一个不存在的键）
//   2. 代码有但文档没写 —— 只警告（README 表格有意只列常用键）
//   3. 默认值不一致 —— 错误
//
// 用法：node tools/check-docs.mjs       退出码 0 = 通过，1 = 有错误
//       node tools/check-docs.mjs --all 连「代码有、文档未列」的完整清单一起列出

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS } from "../lib/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 把嵌套的 DEFAULTS 摊平成 "a.b.c" -> 默认值。 */
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/** 从 README 里抽出配置表格的行：[键, 默认值]。 */
function parseReadmeTable(readme) {
  const lines = readme.split(/\r?\n/);
  // 表格以 `enabled` | `true` 这一行为锚点，向上找到表头
  let start = lines.findIndex((ln) => ln.includes("`enabled` | `true`"));
  if (start < 0) throw new Error("README 里找不到配置表格（锚点：`enabled` | `true`）");
  while (start > 0 && lines[start - 1].trimStart().startsWith("|")) start -= 1;

  const rows = [];
  for (const ln of lines.slice(start)) {
    if (!ln.trimStart().startsWith("|")) {
      if (rows.length) break; // 表格结束
      continue;
    }
    const m = /^\|\s*`([^`]+)`\s*\|\s*`?([^`|]*)`?\s*\|/.exec(ln);
    if (m) rows.push([m[1], m[2].trim()]);
  }
  return rows;
}

/** 一行可能用 `/` 表示多个键（如 `maintenance.provider` / `maintenance.model`）。 */
function buildDocMap(rows) {
  const doc = new Map();
  for (const [key, val] of rows) {
    for (const k of key.split(/\s*\/\s*/)) doc.set(k.trim(), val);
  }
  return doc;
}

// 数组统一成 JSON 形态（[2,5]），否则 String([2,5]) 会丢方括号变成 "2,5"
const norm = (v) => (Array.isArray(v) ? JSON.stringify(v) : String(v)).replace(/`/g, "").trim();

/** 两个值算不算一致：数字按数值比，布尔按大小写无关比，"空" 与空串等价，数组忽略空格。 */
function sameValue(docVal, codeVal) {
  const a = norm(docVal);
  const b = norm(codeVal);
  if (a === b) return true;
  if (a === "" && (b === "" || b === "空")) return true;
  if (a === "空" && b === "") return true;
  // [2, 5] 与 [2,5] 是同一个数组
  if (a.startsWith("[") && b.startsWith("[")) {
    if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return true;
  }
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  if (/^(true|false)$/i.test(a) && /^(true|false)$/i.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
const flat = flatten(DEFAULTS);
const doc = buildDocMap(parseReadmeTable(readme));

// 「文档有、代码没有」的例外：这些键由插件宿主提供，不在 DEFAULTS 里。
const DOC_ONLY_OK = new Set(["maintenance.provider", "maintenance.model"]);

const errors = [];
const warnings = [];

for (const [k, v] of doc) {
  if (!(k in flat) && !DOC_ONLY_OK.has(k)) errors.push(`文档有、代码没有：\`${k}\` = ${v}`);
}

for (const k of Object.keys(flat)) {
  if (!doc.has(k)) {
    const v = flat[k];
    warnings.push(`代码有、文档未列：\`${k}\` = ${v === "" ? "空" : v}`);
  }
}

for (const [k, v] of doc) {
  if (!(k in flat)) continue;
  if (!sameValue(v, flat[k])) {
    errors.push(`默认值不一致：\`${k}\` README=${JSON.stringify(v)} 代码=${JSON.stringify(flat[k])}`);
  }
}

console.log(`DEFAULTS ${Object.keys(flat).length} 个键，README 表格 ${doc.size} 个键`);

const showAll = process.argv.includes("--all");

if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 个配置键代码有、README 表格未列（表格有意只列常用键）`);
  if (showAll) {
    for (const w of warnings) console.log(`  ${w}`);
  } else {
    console.log("  用 --all 查看完整清单");
  }
}

if (errors.length) {
  console.log(`\n✖ 错误 ${errors.length} 条`);
  for (const e of errors) console.log(`  ${e}`);
  console.log("\n修复：让 README 配置表与 lib/config.js 的 DEFAULTS 对齐。");
  process.exit(1);
}

console.log("\n✔ README 配置表与代码默认值一致");

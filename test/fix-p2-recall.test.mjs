// P2「检索候选与词表」回归：人物别名要能进候选、词表按归一化键聚合、早期
// 「## 追加记忆 #N」块升级时并入摘要/细节而不是被当成原话吞掉。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { parseSnapshot, upgradeLegacySnapshotText } from "../lib/memory.js";
import { normalizeKeywords, recall } from "../lib/recall.js";
import { buildKeywordTable, matchWindowTerms, vocabText } from "../lib/vocab.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-fix-p2-recall-"));
after(() => rm(ROOT, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function kw(term, keyness = 6) {
  return { term, keyness, levels: [2] };
}

function mem(uid, overrides = {}) {
  return {
    uid,
    label: `2_mem_${uid}`,
    folder: path.join(ROOT, "mem", uid),
    defaultLevel: 2,
    snapshots: [2],
    date: "2026-11-20",
    seq: 1,
    keywords: [],
    people: [],
    sessionId: "sess-1",
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    hitCount: 0,
    lastHitAt: null,
    immortal: false,
    immortalReason: null,
    forget: { d2: null, d5: null },
    relatedUids: [],
    ...overrides,
  };
}

function fakeRegistry(memories = []) {
  const map = new Map(memories.map((memory) => [memory.uid, memory]));
  return {
    memories: map,
    get: (uid) => map.get(uid),
    list: () => [...map.values()],
    lookup(terms) {
      const wanted = new Set(normalizeKeywords(terms));
      const hits = new Set();
      for (const memory of map.values()) {
        for (const keyword of memory.keywords ?? []) {
          const term = typeof keyword === "string" ? keyword : keyword.term;
          const normalized = normalizeKeywords([term])[0];
          if (normalized && wanted.has(normalized)) {
            hits.add(memory.uid);
            break;
          }
        }
      }
      return hits;
    },
    async bumpHits(entries) {
      const counts = new Map();
      for (const item of entries) {
        const uid = typeof item === "string" ? item : item?.uid;
        const memory = map.get(uid);
        if (!memory) continue;
        counts.set(uid, memory.hitCount ?? 0);
      }
      return counts;
    },
  };
}

function baseConfig(homeDir) {
  return {
    homeDir,
    recall: { levelBias: 1, usageBoost: 1, recencyBoost: 2, pinnedBoost: 3 },
    association: { enabled: false, triggerCount: 3, minLevel: 1, maxItems: 3, maxChars: 1500 },
  };
}

/* ------------------------------------------------------------------ */
/* 1. 人物别名参与候选生成                                              */
/* ------------------------------------------------------------------ */

test("候选：人物别名（_aliases.json）能命中，无 home 时退回字面匹配", async () => {
  const home = await mkdtemp(path.join(ROOT, "home-alias-"));
  await mkdir(path.join(home, "characters"), { recursive: true });
  // value 为字符串：别名 -> 规范名。
  await writeFile(
    path.join(home, "characters", "_aliases.json"),
    JSON.stringify({ "小林": "小林", Lin: "小林", 阿林: "小林" }),
    "utf8",
  );
  // people 只写规范名，people 里没有关键词，只能靠人物候选进池。
  const person = mem("al-person", { keywords: [kw("插件")], people: ["小林"] });
  const registry = fakeRegistry([person]);

  const byAlias = await recall({
    registry,
    home,
    config: baseConfig(home),
    keywords: ["Lin"],
    topK: 1,
    now: NOW,
  });
  assert.deepEqual(
    byAlias.matches.map((row) => row.uid),
    ["al-person"],
    "别名 Lin 应命中 people=[小林]",
  );
  // 人物名进候选但不进 matchedKeywords（不加权重，保持原口径）。
  assert.deepEqual(byAlias.matches[0].matchedKeywords, []);
  assert.equal(byAlias.matches[0].weight, 2, "只有档位加成 2×1，没有关键词权重");
});

test("候选：无 home 时别名不生效（向后兼容的字面匹配）", async () => {
  const registry = fakeRegistry([mem("no-home", { keywords: [kw("插件")], people: ["小林"] })]);
  const result = await recall({ registry, config: baseConfig(ROOT), keywords: ["Lin"], topK: 1, now: NOW });
  assert.deepEqual(result.matches, [], "没有别名表就只做字面相等匹配");
});

test("候选：别名不扩散泛称——「用户」不会因别名把「小林」也带进来", async () => {
  const home = await mkdtemp(path.join(ROOT, "home-generic-"));
  await mkdir(path.join(home, "characters"), { recursive: true });
  await writeFile(
    path.join(home, "characters", "_aliases.json"),
    JSON.stringify({ "小林": "小林", Lin: "小林" }),
    "utf8",
  );
  const user = mem("g-user", { keywords: [kw("插件")], people: ["用户"] });
  const person = mem("g-person", { keywords: [kw("插件")], people: ["小林"] });
  const registry = fakeRegistry([user, person]);
  const result = await recall({
    registry,
    home,
    config: baseConfig(home),
    keywords: ["用户"],
    topK: 5,
    now: NOW,
  });
  const uids = result.matches.map((row) => row.uid);
  assert.ok(uids.includes("g-user"), "字面命中仍在");
  assert.ok(!uids.includes("g-person"), "泛称不扩散到具体人物");
});

/* ------------------------------------------------------------------ */
/* 2. 词表按归一化键聚合                                                */
/* ------------------------------------------------------------------ */

test("词表：HDM / hdm 合并成一个词位，展示首次出现的写法，分数求和", () => {
  // 泛词过滤会剔掉出现在 >30% 记忆里的词，所以这里把大小写变体放进同一条记忆（每条记忆只计一次 df）。
  const hdm = mem("v-hdm", { keywords: [kw("HDM", 3), kw("hdm", 5), kw("Hdm", 1)] });
  const fillers = ["甲", "乙", "丙", "丁"].map((term, index) => mem(`v-filler-${index}`, { keywords: [kw(term, 2)] }));
  const registry = fakeRegistry([hdm, ...fillers]);

  const table = buildKeywordTable(registry, { now: NOW });
  const hdmRows = table.filter((row) => row.term.toLowerCase() === "hdm");
  assert.equal(hdmRows.length, 1, "大小写变体只占一个词位");
  assert.equal(hdmRows[0].term, "HDM", "保留首次出现的原始写法");
  const decay = 1 - 1 / 30; // 当天记忆衰减 1 天
  const expected = ((3 + 1) + (5 + 1) + (1 + 1)) * decay;
  assert.ok(Math.abs(hdmRows[0].score - expected) < 1e-9, `分数应合并累加，实际 ${hdmRows[0].score}`);
  // 对外形状不变：仍是 [{term, score}]，matchWindowTerms / vocabText 照旧可用。
  assert.deepEqual(Object.keys(table[0]).sort(), ["score", "term"]);
  assert.ok(vocabText(table, 1000).includes("HDM"));
  assert.deepEqual(
    matchWindowTerms(["hdm"], table).map((hit) => [hit.term, hit.match]),
    [["HDM", "exact"]],
    "小写查询仍精确命中合并后的词条",
  );
});

/* ------------------------------------------------------------------ */
/* 3. 早期「## 追加记忆 #N」块升级                                      */
/* ------------------------------------------------------------------ */

function legacyMeta() {
  return {
    uid: "m-20261118-009",
    label: "2_2026-11-18_009_旧",
    date: "2026-11-18",
    sessionId: "session-abcdef01",
    defaultLevel: 2,
    snapshots: [2],
    people: [],
    relatedUids: [],
  };
}

function legacyText() {
  return [
    "# 记忆编号: 2_2026-11-18_009_旧",
    "# 摘要",
    "旧基线要点：第一天的决定。",
    "# 细节",
    "- 旧细节一",
    "# 原话",
    "> 旧原话一",
    "",
    "## 追加记忆 #2（2026/11/18 19:31:31）",
    "### 摘要",
    "旧追加要点：第二天补的预算要求。",
    "### 细节",
    "- 旧追加细节",
    "### 原话",
    "> 旧追加原话",
    "",
  ].join("\n");
}

test("升级：## 追加记忆 #N 的要点并入摘要/细节，不被「# 原话」吞掉", () => {
  const out = upgradeLegacySnapshotText({
    text: legacyText(),
    meta: legacyMeta(),
    level: 2,
    now: Date.UTC(2026, 10, 18, 4),
    timeZone: "Asia/Shanghai",
    keywords: [],
  });
  assert.equal(out.upgraded, true);
  const parsed = parseSnapshot(out.text);
  const summary = parsed.sections["摘要"] ?? "";
  const details = parsed.sections["细节"] ?? "";
  const quotes = parsed.sections["原话"] ?? "";

  assert.match(summary, /旧基线要点/, "基线要点仍在摘要");
  assert.match(summary, /旧追加要点/, "追加块要点也进摘要");
  assert.match(details, /旧细节一/);
  assert.match(details, /旧追加细节/, "追加块细节进细节段");
  assert.match(quotes, /旧原话一/);
  assert.match(quotes, /旧追加原话/);
  // 关键回归：追加块的结构行不得残留在原话里。
  assert.doesNotMatch(quotes, /追加记忆 #/, "「## 追加记忆 #N」标题不能变成原话的一行");
  assert.doesNotMatch(quotes, /###\s*(摘要|细节|原话)/, "追加块的 ### 小节标题不能进原话");
  assert.doesNotMatch(quotes, /旧追加要点/, "追加块摘要不能进原话");
});

test("升级：重复执行结果一致（幂等）", () => {
  const meta = legacyMeta();
  const first = upgradeLegacySnapshotText({
    text: legacyText(),
    meta,
    level: 2,
    now: Date.UTC(2026, 10, 18, 4),
    timeZone: "Asia/Shanghai",
    keywords: [],
  });
  const second = upgradeLegacySnapshotText({
    text: first.text,
    meta,
    level: 2,
    now: Date.UTC(2026, 10, 18, 5),
    timeZone: "Asia/Shanghai",
    keywords: [],
  });
  assert.equal(second.upgraded, false, "已升级的文本带「记忆编号:」行，第二次直接跳过");
  assert.equal(second.text, first.text, "内容不再变化");
});

test("升级：多个追加块按文档顺序并入，块内结构各自解析", () => {
  const text = [
    "# 摘要",
    "基线要点。",
    "# 原话",
    "> 基线原话",
    "",
    "## 追加记忆 #2（2026/11/18 19:31:31）",
    "### 摘要",
    "第二次要点。",
    "### 细节",
    "- 第二次细节",
    "## 追加记忆 #3（2026/11/18 20:00:00）",
    "### 摘要",
    "第三次要点。",
  ].join("\n");
  const out = upgradeLegacySnapshotText({
    text,
    meta: legacyMeta(),
    level: 2,
    now: Date.UTC(2026, 10, 18, 4),
    timeZone: "Asia/Shanghai",
    keywords: [],
  });
  assert.equal(out.upgraded, true);
  const parsed = parseSnapshot(out.text);
  const summary = parsed.sections["摘要"] ?? "";
  const details = parsed.sections["细节"] ?? "";
  // 摘要顺序：基线 → 第二次 → 第三次（① ② ③）。
  const base = summary.indexOf("基线要点");
  const two = summary.indexOf("第二次要点");
  const three = summary.indexOf("第三次要点");
  assert.ok(base >= 0 && two > base && three > two, `摘要顺序应为基线→2→3，实际 ${summary}`);
  assert.match(details, /第二次细节/);
  assert.doesNotMatch(summary, /###/, "小节标题不进摘要正文");
});

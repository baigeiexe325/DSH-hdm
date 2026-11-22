import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test, { after } from "node:test";

import { buildKeywordTable, matchWindowTerms, VOCAB_DEFAULTS, vocabText } from "../lib/vocab.js";
import { buildVocab } from "../lib/injection.js";
import { recall } from "../lib/recall.js";

const ROOT = await mkdtemp(path.join(tmpdir(), "hdm-vocab-test-"));
after(() => rm(ROOT, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-07T12:00:00Z");
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
    date: "2026-11-07",
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
  const normalize = (value) => String(value ?? "").trim().toLowerCase();
  return {
    get: (uid) => map.get(uid),
    list: () => [...map.values()],
    lookup(terms) {
      const wanted = new Set((Array.isArray(terms) ? terms : []).map(normalize));
      const hits = new Set();
      for (const memory of map.values()) {
        for (const keyword of memory.keywords ?? []) {
          const term = typeof keyword === "string" ? keyword : keyword.term;
          if (wanted.has(normalize(term))) {
            hits.add(memory.uid);
            break;
          }
        }
      }
      return hits;
    },
    async bumpHits(entries) {
      const counts = new Map();
      for (const item of entries) counts.set(item.uid, (map.get(item.uid)?.hitCount ?? 0) + 1);
      return counts;
    },
  };
}

function baseConfig() {
  return {
    homeDir: path.join(ROOT, "home"),
    recall: { levelBias: 1, usageBoost: 1, recencyBoost: 2, pinnedBoost: 3 },
    association: { enabled: false, triggerCount: 3, minLevel: 1, maxItems: 3, maxChars: 1500 },
  };
}

/* ------------------------------------------------------------------ */
/* matchWindowTerms                                                     */
/* ------------------------------------------------------------------ */

test("词面匹配：精确 / 双向包含 / 拉丁编辑距离 / 单字不扩散", () => {
  const table = [
    { term: "提示词改造" },
    { term: "提示词" },
    { term: "recall" },
    { term: "用户" },
  ].map((row) => ({ ...row, score: 1 }));

  const exact = matchWindowTerms(["提示词"], table);
  assert.equal(exact[0].term, "提示词");
  assert.equal(exact[0].match, "exact");
  assert.deepEqual(exact.map((hit) => hit.term), ["提示词", "提示词改造"]);

  // 双向包含：输入词更长或更短都算，较短一侧 ≥2 字。
  assert.ok(matchWindowTerms(["提示词改"], table).some((hit) => hit.term === "提示词改造"));
  assert.ok(matchWindowTerms(["提示词改造方案"], table).some((hit) => hit.term === "提示词改造"));
  assert.ok(matchWindowTerms(["用户档案"], table).some((hit) => hit.term === "用户"));

  // 编辑距离只对拉丁词生效，且两侧长度都 ≥4。
  const near = matchWindowTerms(["recoll"], table);
  assert.deepEqual(near.map((hit) => [hit.term, hit.match]), [["recall", "near"]]);

  // 单字不做包含扩散。
  assert.deepEqual(matchWindowTerms(["用"], table), []);
  // 词表为空/窗口越界不报错。
  assert.deepEqual(matchWindowTerms(["用户"], []), []);
  assert.deepEqual(matchWindowTerms(["用户"], table, { start: 4, end: 9 }), []);
});

/* ------------------------------------------------------------------ */
/* buildKeywordTable / buildVocab                                       */
/* ------------------------------------------------------------------ */

test("词表：keyness × 时间衰减排序、limit 截断、泛词过滤", () => {
  const fresh = mem("k-fresh", { keywords: [kw("甲词", 10)] });
  const old = mem("k-old", {
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 60 * DAY,
    keywords: [kw("乙词", 10)],
  });
  const low = mem("k-low", { keywords: [kw("丙词", 1)] });
  // 泛词：4/5 条记忆都有 → df 80% > 30%，不进词表。
  const fillers = Array.from({ length: 3 }, (_, i) => mem(`k-filler-${i}`, { keywords: [kw("常见词", 9)] }));
  const registry = fakeRegistry([fresh, old, low, ...fillers]);

  const table = buildKeywordTable(registry, { now: NOW });
  assert.deepEqual(
    table.map((row) => row.term),
    ["甲词", "乙词", "丙词"],
  );
  // 甲：(10+1)×(1-1/30)≈10.63；乙：(10+1)×0.25=2.75；丙：(1+1)×(1-1/30)≈1.93
  assert.ok(Math.abs(table[0].score - 11 * (1 - 1 / 30)) < 1e-9);
  assert.equal(table[1].score, 2.75);
  assert.ok(Math.abs(table[2].score - 2 * (1 - 1 / 30)) < 1e-9);
  assert.ok(!table.some((row) => row.term === "常见词"));

  assert.deepEqual(
    buildKeywordTable(registry, { now: NOW, limit: 2 }).map((row) => row.term),
    ["甲词", "乙词"],
  );
});

test("buildVocab：默认只给前 50 个词，vocabChars 只卡字数", () => {
  const memories = Array.from({ length: 60 }, (_, i) =>
    mem(`v-${i}`, { keywords: [kw(`词${String(i).padStart(2, "0")}`, 1)] }),
  );
  const registry = fakeRegistry(memories);
  const terms = buildVocab(registry, 100000, NOW).split("、");
  assert.equal(terms.length, VOCAB_DEFAULTS.topN);
  assert.deepEqual(terms.slice(0, 2), ["词00", "词01"]);

  // 显式 topN 优先；字数预算为 0 时不注入。
  assert.equal(buildVocab(registry, 100000, NOW, 3).split("、").length, 3);
  assert.equal(buildVocab(registry, 0, NOW), "");
  assert.equal(vocabText([], 100), "");
});

/* ------------------------------------------------------------------ */
/* recall：默认条数 = 输入关键词数                                       */
/* ------------------------------------------------------------------ */

test("recall：不给 topK 时返回条数默认等于输入关键词数", async () => {
  const memories = Array.from({ length: 5 }, (_, i) =>
    mem(`d-${i}`, { keywords: [kw("用户")], date: `2026-11-0${i + 1}` }),
  );
  const result = await recall({
    registry: fakeRegistry(memories),
    config: baseConfig(),
    keywords: ["用户", "甲", "乙"],
    now: NOW,
  });
  assert.equal(result.matches.length, 3);

  const explicit = await recall({
    registry: fakeRegistry(memories),
    config: baseConfig(),
    keywords: ["用户", "甲", "乙"],
    topK: 1,
    now: NOW,
  });
  assert.equal(explicit.matches.length, 1);
});

/* ------------------------------------------------------------------ */
/* recall：窗口粗查 → 250 上限 → 精确细找                                */
/* ------------------------------------------------------------------ */

test("recall：目标词排在第 50 名之后，第二窗才命中", async () => {
  const fillers = Array.from({ length: 50 }, (_, i) =>
    mem(`w-fill-${i}`, { keywords: [kw(`填充${String(i).padStart(2, "0")}`, 6)] }),
  );
  const target = mem("w-target", { keywords: [kw("目标词", 0.1)] });
  const registry = fakeRegistry([...fillers, target]);

  const result = await recall({ registry, config: baseConfig(), keywords: ["目标词"], now: NOW });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].uid, "w-target");
  assert.equal(result.search.windows, 2, "第一窗没有，第二窗才命中");
  assert.equal(result.search.stage, "fine", "词表词条精确相等，不算模糊扩展");
});

test("recall：粗查一路扫到 250 都没有 → 回退精确倒排细找", async () => {
  // 5 条记忆共享「泛词」→ 泛词被词表过滤，粗查必然为空。
  const memories = Array.from({ length: 5 }, (_, i) =>
    mem(`g-${i}`, { keywords: [kw("泛词")], date: `2026-11-0${i + 1}` }),
  );
  const result = await recall({
    registry: fakeRegistry(memories),
    config: baseConfig(),
    keywords: ["泛词"],
    now: NOW,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.search.stage, "fine");
  assert.ok(result.search.windows <= 5);
});

test("recall：逐窗降低条数期望，最多扫 5 个窗口（250 个词）后放弃", async () => {
  const memories = Array.from({ length: 300 }, (_, i) =>
    mem(`n-${i}`, { keywords: [kw(`词条${String(i).padStart(3, "0")}`, 1)] }),
  );
  const result = await recall({
    registry: fakeRegistry(memories),
    config: baseConfig(),
    keywords: ["查无此词甲", "查无此词乙", "查无此词丙"],
    now: NOW,
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.search.stage, "empty");
  assert.equal(result.search.windows, 5);
  assert.equal(result.search.expected, 3, "初始期望 = 输入关键词数");
  assert.equal(result.search.aim, 1, "3 → 2 → 1，最低 1");
});

test("recall：全库无关键词时词表为空，仍返回空结构", async () => {
  const result = await recall({
    registry: fakeRegistry([mem("e-0")]),
    config: baseConfig(),
    keywords: ["任意"],
    now: NOW,
  });
  assert.deepEqual(result.matches, []);
  assert.equal(result.search.stage, "empty");
  assert.equal(result.search.windows, 0);
});

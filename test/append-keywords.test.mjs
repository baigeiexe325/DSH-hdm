// 追加记忆的关键词回归：`computeKeyness` 按位置给「模型顺序」加成，若把旧词排在新词前面，
// 追加时的关键词永远挤不进 top-12，索引从建单元那天起就不再更新。
// 这条测试走真实的 saveConversationMemory 追加路径（临时母文件夹），修复前会真的失败。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfig } from "../lib/config.js";
import { saveConversationMemory } from "../lib/conversation.js";
import {
  buildSnapshotText,
  commitDerivedSnapshot,
  createMemory,
  deriveSnapshotData,
  expectedMemoryLabel,
  labelTermsOf,
  mergeSnapshotForAppend,
  parseSnapshot,
} from "../lib/memory.js";
import { Registry } from "../lib/registry.js";
import { StateStore } from "../lib/state.js";

const FIRST_INPUT = {
  summary: "用户要求把 HDM 的空闲整理改成可在面板调整，并保留同一编码续写。",
  details: ["窗口默认 180 分钟到 12 小时"],
  quotes: [],
  keywords: ["HDM", "空闲整理", "面板", "同一编码", "窗口", "维护模型", "提示词", "去重", "日志", "测试"],
  people: [],
  event: "HDM 空闲整理",
  source: "observed",
  importance: 3,
};

// 与首次完全不重叠：旧词排前时这些词都会掉出 top-12。
const SECOND_INPUT = {
  summary: "用户又补了预算与超时要求：维护调用的 token 预算要可配，超时必须能覆盖长输出。",
  details: ["预算与超时都要进设置面板", "超时不够会让长输出直接失败"],
  quotes: [],
  keywords: ["预算", "超时", "降级", "关键词", "追加", "快照", "摘要", "排序", "权重", "设置"],
  people: [],
  event: "HDM 空闲整理",
  source: "observed",
  importance: 3,
};

/** 与 memory.expectedMemoryLabel 同口径：按当前关键词与事件重算的标签。 */
function labelAfterAppend(meta) {
  return expectedMemoryLabel(meta);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test("追加记忆时本次输入的关键词能进 top-12（顺序即权重）", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-append-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "append-session", cwd: home };
  const now = Date.now();

  await saveConversationMemory({ registry, config, home, state, session, input: FIRST_INPUT, now });
  const result = await saveConversationMemory({ registry, config, home, state, session, input: SECOND_INPUT, now: now + 1000 });

  assert.equal(result.merged, true, "第二次保存应追加到同一单元");
  // gist 必须跟合并后的摘要走，否则联想永远读到建单元那天的旧摘要。
  // 合并后：新要点在前（①），旧要点去重保留在后（②）——同一个 ## 摘要 里。
  assert.ok(
    result.meta.gist.startsWith(`①${SECOND_INPUT.summary}`),
    `追加后 gist 应以本次摘要开头，实际为 ${result.meta.gist}`,
  );
  assert.ok(
    result.meta.gist.includes(FIRST_INPUT.summary),
    `合并摘要里旧要点仍应保留（去重合并而非替换），实际为 ${result.meta.gist}`,
  );
  assert.ok(Array.from(result.meta.gist).length <= 120, "gist 不超过 120 字");
  const terms = (result.keywordScores ?? []).map((keyword) => keyword.term);
  for (const term of ["降级", "快照", "权重"]) {
    assert.ok(terms.includes(term), `追加后关键词应包含「${term}」，实际为 ${JSON.stringify(terms)}`);
  }
  assert.ok(terms.includes("HDM"), "旧关键词仍应保留在 top-12，不能整体冲掉");

  // 关键词必须带等级，否则 registry 建不出索引桶，hdm_recall 召不回这条记忆。
  assert.deepEqual(
    result.keywordScores[0].levels,
    [2],
    `关键词应带 L2 等级，实际为 ${JSON.stringify(result.keywordScores[0])}`,
  );
  const hits = registry.lookup(["降级"]);
  assert.ok(hits.has(result.meta.uid), `lookup 应命中本院单元，实际命中 ${JSON.stringify([...hits.keys()])}`);

  // 原地改写：level2.txt 仍是单文档，旧要点被去重合并而不是被替换掉。
  const level2 = await readFile(path.join(result.meta.folder, "level2.txt"), "utf8");
  assert.equal((level2.match(/## 摘要/g) || []).length, 1, "同一天追加后只能有一个 ## 摘要");
  assert.doesNotMatch(level2, /追加记忆 #/, "不再生成「追加记忆 #N」段落");
  assert.ok(level2.includes(FIRST_INPUT.summary), "旧摘要的要点在追加后仍应存在");
  assert.ok(level2.includes(SECOND_INPUT.summary), "新摘要的要点也应在同一份摘要里");

  // meta.json 是 rebuild 的唯一来源：追加后必须落盘，否则 /hdm-rebuild 会丢掉这次追加。
  const metaPath = path.join(result.meta.folder, "meta.json");
  const onDisk = JSON.parse(await readFile(metaPath, "utf8"));
  assert.equal(onDisk.appendCount, 2, "追加后 meta.json 应记录 appendCount");
  assert.ok(
    (onDisk.keywords ?? []).some((keyword) => keyword.term === "降级"),
    "追加后 meta.json 应包含本次关键词，否则 rebuild 会退回旧关键词集",
  );

  // rebuild 只认 meta.json：重建后这次追加的关键词必须还在索引里。
  await registry.rebuild();
  const afterRebuild = registry.lookup(["降级"]);
  assert.ok(
    afterRebuild.has(result.meta.uid),
    `rebuild 后仍应命中，实际命中 ${JSON.stringify([...afterRebuild.keys()])}`,
  );
});

test("P1-1 已派生的单元再保存：保留 L1/L0，只置 needsRederive", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-rederive-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "rederive-session", cwd: home };
  const now = Date.now();

  const first = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: FIRST_INPUT,
    now,
    pin: true,
  });
  const meta = registry.get(first.meta.uid);
  const derived = await commitDerivedSnapshot({
    registry,
    meta,
    data: deriveSnapshotData(meta, 1),
    now: now + 500,
  });
  const labelBefore = derived.label;
  const folderBefore = derived.folder;
  assert.deepEqual(derived.snapshots, [1, 2], "先派生 L1 作为前提");

  const result = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: SECOND_INPUT,
    now: now + 1000,
    pin: true,
  });
  assert.equal(result.merged, true, "同一固定单元应继续追加");

  const after = registry.get(first.meta.uid);
  assert.deepEqual(after.snapshots, [1, 2], "同日再保存不得删除派生档");
  assert.equal(after.defaultLevel, 1, "defaultLevel 不应被重置");
  // 标签会跟着当前关键词重算（记忆编号不再冻结在首次保存那批词上），但派生档前缀 1_ 必须保留。
  assert.ok(after.label.startsWith("1_"), `派生单元追加后前缀仍应是 1_，实际为 ${after.label}`);
  assert.equal(after.label, labelAfterAppend(after), "追加后标签应等于按当前关键词重算的标签");  assert.notEqual(after.label, labelBefore, "追加后关键词变了，标签应随当前关键词更新");
  assert.equal(after.folder, path.join(path.dirname(folderBefore), after.label), "folder 跟新标签一致");
  assert.ok(await exists(folderBefore) === false, "旧标签文件夹应已改名");
  assert.equal(after.needsRederive, 1, "应置位 needsRederive=1");
  assert.equal(after.forget.d2, null, "派生时间戳清空，交给遗忘巡检重派生");
  assert.equal(after.forget.d5, null);
  assert.ok(!after.reopenCount, "不再走 reopenToL2，reopenCount 不应增长");

  const level1 = await readFile(path.join(after.folder, "level1.txt"), "utf8");
  assert.ok(level1.length > 0, "原 L1 文件仍在（未被删除）");
  // 改名后 L1 头部的「记忆编号」也要换成新标签，否则头部与文件夹名不一致。
  assert.equal(parseSnapshot(level1).header["记忆编号"], after.label, "L1 头部编号应同步为新标签");
  const level2Text = await readFile(path.join(after.folder, "level2.txt"), "utf8");
  assert.equal(parseSnapshot(level2Text).header["记忆编号"], after.label, "L2 头部编号应同步为新标签");
  const onDisk = JSON.parse(await readFile(path.join(after.folder, "meta.json"), "utf8"));
  assert.equal(onDisk.needsRederive, 1, "meta.json 也要落盘该标记");
});

test("P1-5 L0 的关键词集合是 L1 关键词集合的子集", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-l0-subset-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const now = Date.now();
  const terms = ["甲一", "乙二", "丙三", "丁四", "戊五", "己六", "庚七", "辛八", "壬九", "癸十", "子十一", "丑十二"];
  const { meta } = await createMemory({
    registry,
    config,
    home,
    input: { summary: "L0 子集检查：十二个关键词按档逐级收缩。", keywords: terms },
    session: { id: "l0-subset" },
    now,
  });
  assert.equal(meta.keywords.length, 12);
  assert.ok(meta.gist && Array.from(meta.gist).length <= 120, "createMemory 后 gist 非空且 ≤120");

  // L1：从全量 12 词收缩到 10 词
  const l1 = deriveSnapshotData(meta, 1);
  assert.equal(l1.keywords.length, 10);
  await commitDerivedSnapshot({ registry, meta, data: l1, now: now + 800 });

  // L0：只能在 L1 真正入选的 10 词里收缩
  const l0 = deriveSnapshotData(meta, 0);
  const l1Terms = new Set(l1.keywords.map((keyword) => keyword.term));
  const l0Terms = l0.keywords.map((keyword) => keyword.term);
  assert.ok(l0Terms.length >= 5 && l0Terms.length <= 8, `L0 关键词数应在 5~8，实际 ${l0Terms.length}`);
  for (const term of l0Terms) {
    assert.ok(l1Terms.has(term), `L0 关键词「${term}」必须来自 L1 入选集合，L1=${JSON.stringify([...l1Terms])}`);
  }

  // 未入选 L1 的词不能被强行补上 1 档
  const claimedL1 = meta.keywords.filter((keyword) => keyword.levels.includes(1)).map((keyword) => keyword.term);
  assert.deepEqual(claimedL1.sort(), [...l1Terms].sort());
});

// ------------------------------------------------------------------ 原地追加

const CIRCLED_LIST = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫"];

function fakeMeta(over = {}) {
  return {
    label: "2_2026-11-18_001_测试",
    uid: "m-20261118-001",
    date: "2026-11-18",
    people: ["用户"],
    relatedUids: [],
    ...over,
  };
}

const THIRD_INPUT = {
  summary: "用户要求把同一天的追加记忆改成原地改写，不再另加说明段落。",
  details: ["level2.txt 永远是一份单文档"],
  quotes: ["同一天的追加记忆要直接在原文基础上改"],
  keywords: ["原地改写", "单文档", "追加", "摘要", "去重", "段落", "结构", "刷新", "合并", "统计"],
  people: [],
  event: "HDM 空闲整理",
  source: "observed",
  importance: 3,
};

test("同一单元连续保存 3 次：level2.txt 仍是单文档，appendCount=3", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-append3-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "append3-session", cwd: home };
  const now = Date.now();

  const first = await saveConversationMemory({ registry, config, home, state, session, input: FIRST_INPUT, now });
  const second = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: SECOND_INPUT,
    now: now + 1000,
  });
  const third = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    input: THIRD_INPUT,
    now: now + 2000,
  });

  assert.equal(first.meta.uid, second.meta.uid, "第二次保存并入同一单元");
  assert.equal(first.meta.uid, third.meta.uid, "第三次保存并入同一单元");
  assert.equal(third.meta.appendCount, 3, "appendCount 仍按次数自增（只做统计）");

  const level2 = await readFile(path.join(third.meta.folder, "level2.txt"), "utf8");
  assert.equal((level2.match(/## 摘要/g) || []).length, 1, "只有一个 ## 摘要");
  assert.ok((level2.match(/## 细节/g) || []).length <= 1, "## 细节 至多一个");
  assert.doesNotMatch(level2, /追加记忆 #/, "不再生成追加段落");
  // 三次的要点都还在同一份摘要里，且最新一次排在 ①。
  assert.ok(level2.includes(`①${THIRD_INPUT.summary}`), `本次要点应排在 ①，实际摘要为 ${level2}`);
  assert.ok(level2.includes(FIRST_INPUT.summary), "第一次的要点仍在");
  assert.ok(level2.includes(SECOND_INPUT.summary), "第二次的要点仍在");
});

test("兼容存量数据：旧式「## 追加记忆 #2」块并入单一摘要后消失", () => {
  const meta = fakeMeta();
  const legacyBase = buildSnapshotText({
    meta,
    level: 2,
    now: Date.UTC(2026, 10, 18, 3, 0, 0),
    timeZone: "Asia/Shanghai",
    summary: "旧基线要点：第一天的决定。",
    details: ["旧细节一"],
    quotes: ["旧原话一"],
    keywords: [{ term: "旧词" }],
    scene: "面板",
    event: "旧事件",
    emotion: "平静",
    source: "observed",
  });
  const legacyText = [
    legacyBase.trimEnd(),
    "",
    "## 追加记忆 #2（2026/11/18 19:31:31）",
    "### 摘要",
    "旧追加要点：第二天补的预算要求。",
    "",
    "### 细节",
    "- 旧追加细节",
    "",
    "### 原话",
    "> 旧追加原话",
    "",
  ].join("\n");

  const merged = mergeSnapshotForAppend({
    currentText: legacyText,
    meta,
    input: { summary: "新要点：追加改成原地改写。", details: ["新细节"], quotes: ["新原话"], event: "新事件" },
    now: Date.UTC(2026, 10, 18, 4, 0, 0),
    keywords: [{ term: "原地改写" }],
  });

  assert.doesNotMatch(merged.text, /追加记忆 #/, "旧式追加块应被吸收，不再单独成段");
  assert.equal((merged.text.match(/## 摘要/g) || []).length, 1, "只剩一个 ## 摘要");
  for (const fragment of ["新要点", "旧基线要点", "旧追加要点"]) {
    assert.ok(merged.summary.includes(fragment), `合并摘要应包含「${fragment}」，实际为 ${merged.summary}`);
  }
  // 新在前，旧按原顺序（基线 -> 追加块）。
  assert.ok(merged.summary.indexOf("新要点") < merged.summary.indexOf("旧基线要点"));
  assert.ok(merged.summary.indexOf("旧基线要点") < merged.summary.indexOf("旧追加要点"));
  assert.deepEqual(merged.details, ["新细节", "旧细节一", "旧追加细节"]);
  assert.deepEqual(merged.quotes, ["新原话", "旧原话一", "旧追加原话"]);

  const parsed = parseSnapshot(merged.text);
  const baseHeader = parseSnapshot(legacyBase).header;
  assert.equal(parsed.header["时间"], baseHeader["时间"], "时间沿用首次保存时间");
  assert.equal(parsed.header["场景"], "面板", "本次没有场景就沿用旧 header");
  assert.equal(parsed.header["事件"], "新事件", "本次有值就用本次");
});

test("摘要超长：从尾部（最旧要点）整点丢弃并留省略号", () => {
  const point = (index) => `第${index}点${"甲".repeat(250)}`;
  const summary = Array.from({ length: 10 }, (_, index) => `${CIRCLED_LIST[index]}${point(index)}`).join("");
  const merged = mergeSnapshotForAppend({
    currentText: "",
    meta: fakeMeta(),
    input: { summary },
    now: Date.UTC(2026, 10, 18, 4, 0, 0),
    keywords: [],
  });
  assert.ok(Array.from(merged.summary).length <= 1200, `合并摘要不得超过 1200 字，实际 ${Array.from(merged.summary).length}`);
  assert.ok(merged.summary.endsWith("…"), `丢过要点末尾应有省略号，实际为 ${merged.summary.slice(-8)}`);
  assert.ok(merged.summary.startsWith(`①第0点`), "保留的是靠前的要点");
  assert.ok(!merged.summary.includes("第9点"), "最旧的要点（尾部）应被丢弃");

  // 只剩 1 点仍超长：直接用 truncateChars 截断。
  const single = mergeSnapshotForAppend({
    currentText: "",
    meta: fakeMeta(),
    input: { summary: "长".repeat(1400) },
    now: Date.UTC(2026, 10, 18, 4, 0, 0),
    keywords: [],
  });
  assert.equal(Array.from(single.summary).length, 1200, "单点仍超长时截断到 1200 字");
  assert.ok(single.summary.endsWith("…"));
});

test("摘要要点超过 10 个只保留前 10 个", () => {
  const summary = Array.from({ length: 12 }, (_, index) => `${CIRCLED_LIST[index]}第${index}点`).join("");
  const merged = mergeSnapshotForAppend({
    currentText: "",
    meta: fakeMeta(),
    input: { summary },
    now: Date.UTC(2026, 10, 18, 4, 0, 0),
    keywords: [],
  });
  assert.equal((merged.summary.match(/[\u2460-\u2473]/g) || []).length, 10, "要点编号最多到 ⑩");
  assert.ok(merged.summary.includes("第9点"));
  assert.ok(!merged.summary.includes("第10点"), "第 11 点起被丢弃");
});

test("旧文本没有「## 摘要」段时不崩，仍写出单文档", () => {
  const merged = mergeSnapshotForAppend({
    currentText: "记忆编号: 2_2026-11-18_001_测试\n稳定ID: m-20261118-001\n\n## 关联\n- 日记: diary/2026-11-18.txt\n",
    meta: fakeMeta(),
    input: { summary: "只有新要点：旧文件没有摘要段。", details: [], quotes: [] },
    now: Date.UTC(2026, 10, 18, 4, 0, 0),
    keywords: [{ term: "旧文件" }],
  });
  assert.equal((merged.text.match(/## 摘要/g) || []).length, 1, "补出唯一的 ## 摘要");
  assert.ok(merged.summary.includes("只有新要点"), `摘要应为本次输入，实际为 ${merged.summary}`);
});

/* ------------------------------------------------- 记忆编号（文件夹名）不能再漂移 */

test("记忆编号：按 keyness 取词、整词不截断，且追加后随当前关键词更新", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hdm-relabel-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const config = resolveConfig({ homeDir: home });
  const registry = new Registry(home, config);
  await registry.load();
  const state = new StateStore(home);
  await state.load();
  const session = { id: "relabel-session", cwd: home };
  const now = Date.now();

  // 首次保存：关键词里混入长拉丁词，旧逻辑会把它切成 `dsh-plug` 这类碎片放进编号。
  const first = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    now,
    input: {
      summary: "用户要求把记忆编号里的关键词换成整词，不要再出现被截断的碎片。",
      details: ["长词超过 24 字符时整词跳过"],
      quotes: [],
      keywords: ["记忆编号", "dsh-plugin-iot-thinking", "碎片", "整词", "关键词", "排序", "标签", "目录", "改名", "回归"],
      people: [],
      source: "observed",
      importance: 3,
    },
  });

  const label = first.meta.label;
  assert.equal(label, labelAfterAppend(first.meta), "编号应等于按当前关键词重算的结果");
  // 旧逻辑把长词按 8 字符切碎；新逻辑要么整词进编号，要么整词不进。
  const longTerm = "dsh-plugin-iot-thinking";
  const segments = label.replace(/^\d+_[\d-]+_[a-z0-9]+_\d+_[^_]+_/, "").split("_");
  for (const segment of segments.filter(Boolean)) {
    const truncated = longTerm.startsWith(segment) && segment !== longTerm;
    assert.ok(!truncated, `编号里出现了被截断的碎片「${segment}」：${label}`);
  }
  assert.ok(label.includes(longTerm), `长词要么整词出现，实际编号为 ${label}`);
  assert.ok(label.startsWith("2_"), "首次保存前缀为 2_");

  // 追加一批全新关键词：编号必须跟着换，而不是留在首次保存那批词上。
  const second = await saveConversationMemory({
    registry,
    config,
    home,
    state,
    session,
    now: now + 1000,
    input: {
      summary: "用户又要求编号随关键词更新：旧编号停在首次保存的词上是这次要修的问题。",
      details: [],
      quotes: [],
      keywords: ["编号漂移", "追加", "重算", "文件夹名", "快照头", "一致性", "修复", "回归", "测试", "编号"],
      people: [],
      source: "observed",
      importance: 3,
    },
  });

  assert.equal(second.merged, true, "同一会话应追加到同一单元");
  const after = registry.get(first.meta.uid);
  assert.notEqual(after.label, label, "追加后关键词变了，编号必须重算");
  assert.equal(after.label, labelAfterAppend(after), "编号应等于按当前关键词重算的结果");
  assert.equal(after.folder, path.join(path.dirname(first.meta.folder), after.label), "folder 跟随新编号");
  assert.equal(await exists(first.meta.folder), false, "旧编号文件夹应已改名");
  const level2 = await readFile(path.join(after.folder, "level2.txt"), "utf8");
  assert.equal(parseSnapshot(level2).header["记忆编号"], after.label, "L2 头部编号应同步");
});

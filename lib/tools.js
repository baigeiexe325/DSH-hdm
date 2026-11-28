import { KEYWORD_BANDS } from "./config.js";
import { getToolText } from "./prompts.js";
import { readSnapshot } from "./memory.js";
import { saveConversationMemory } from "./conversation.js";
import { recall } from "./recall.js";
import { CHARACTER_SECTIONS, updateCharacter } from "./characters.js";
import { updateIam, syncIamIndex, REQUIRED_SECTIONS } from "./iam.js";
import { IMAGERY_DEFAULTS, eligibleKeywords, listImagery, readImagery, writeImagery } from "./imagery.js";
import { formatOrganizeReport, organizeMemories } from "./organize.js";
import { applyLabelMigration } from "./migrate-label.js";
import { RECONCEPTION_DEFAULTS, reconcept, reconceptionKinds } from "./reconception.js";
import { list as listBackups, resolveBackupRoot, restore as restoreBackup, snapshot, snapshotIfChanged } from "./backup.js";

function textBlocks(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

function objectSchema(properties, required) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function sessionOf(exec) {
  const session = exec?.agent?.session;
  const id = session?.header?.id ?? "unknown";
  const cwd = session?.header?.cwd;
  const createdAt = session?.header?.createdAt;
  return { id, cwd, createdAt };
}


/**
 * 工具描述优先读 prompts/zh/tools.md（按 mtime 热更新），缺失时回退代码内文案。
 * 之前 getToolText 没有任何消费方，改 tools.md 不会体现在工具描述上——文档与运行时各说一套。
 */
function toolDescription(name, fallback) {
  const fromPrompt = getToolText(`${name}.description`);
  return fromPrompt && fromPrompt.trim() ? fromPrompt.trim() : fallback;
}

async function appendOrCreate({ registry, config, home, input, session, state, now }) {
  // `/hdm-remember` 的语义是「下一个 hdm_save 负责生成内容并固定本会话单元」：
  // 命令只登记 pendingRememberAt，内容由对话智能体写，这里按 pin 落库并清掉登记。
  const pending = session?.id ? state.getSession(session.id)?.pendingRememberAt : null;
  const pin = pending != null;
  const result = await saveConversationMemory({ registry, config, home, state, session, input, now, pin });
  if (pending != null && session?.id) {
    await state.updateSession(session.id, { pendingRememberAt: null, pendingRememberHintAt: null });
  }
  return result;
}

export function createTools({ ctx, home, config, registry, state }) {
  const tools = [];

  // 写入后自动拍版：内容没变就跳过（digest 相同），失败只记日志、绝不阻断主流程。
  const autoSnapshot = (reason) =>
    snapshotIfChanged({ home, config, reason }).catch((error) => {
      ctx.logger?.warn?.(`[hdm] snapshot failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false };
    });

  tools.push({
    name: "hdm_save",
    description:
toolDescription("hdm_save",      "把当前会话中值得长期保留的内容写入 HDM。创建时只生成 level2 完整快照；第 2 天自动生成 L1，第 5 天生成 L0。同一会话在首次快照生成前再次保存会追加到 level2；快照生成后再次保存会创建新的记忆单元。若本会话已被固定到某个记忆单元（/hdm-remember 或空闲自动整理过），保存会并入同一 uid（必要时重开 L2 后再追加）。keywords 必须按重要性从高到低排列，系统会重新计算 keyness。"),
    parameters: objectSchema(
      {
        summary: {
          type: "string",
          minLength: 10,
          maxLength: 1200,
          description: "记忆摘要（gist），必填。",
        },
        details: {
          type: "array",
          maxItems: 8,
          items: { type: "string", maxLength: 500 },
          description: "关键细节，按重要性从高到低；建议 3~8 条。",
        },
        quotes: {
          type: "array",
          maxItems: 5,
          items: { type: "string", maxLength: 300 },
          description: "用户原话，保留措辞；有则强烈建议提供。",
        },
        keywords: {
          type: "array",
          minItems: 10,
          maxItems: 12,
          items: { type: "string", maxLength: 32 },
          description:
            "检索关键词，必填 10~12 个，按重要性从高到低排列。系统会结合摘要命中、人物、细节频率、IDF、专有名词重新计算 keyness，不是简单取前几个。",
        },
        people: {
          type: "array",
          maxItems: 10,
          items: { type: "string", maxLength: 40 },
          description: "涉及人物；用户写“用户”。",
        },
        scene: { type: "string", maxLength: 200, description: "场景/地点。" },
        event: { type: "string", maxLength: 200, description: "事件/任务。" },
        emotion: { type: "string", maxLength: 100, description: "情绪。" },
        source: {
          type: "string",
          enum: ["observed", "told", "inferred", "generated"],
          default: "observed",
          description: "来源：亲眼/被告知/推断/生成。",
        },
        importance: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          default: 3,
          description: "重要性 1~5；5 会自动永久豁免。",
        },
        immortal: {
          type: "boolean",
          default: false,
          description: "用户说“永远记住/最重要”时设为 true。",
        },
        characters: {
          type: "array",
          maxItems: 10,
          items: objectSchema(
            {
              name: { type: "string", maxLength: 40 },
              notes: { type: "string", maxLength: 600 },
              section: { type: "string", maxLength: 40 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            ["name"],
          ),
          description: "本次记忆涉及的人物档案更新；USER 会先写。",
        },
        relatedUids: {
          type: "array",
          maxItems: 20,
          items: { type: "string" },
          description: "本次又提到的旧记忆 uid；会提升其 hitCount。",
        },
      },
      ["summary", "keywords"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          uid: { type: "string" },
          label: { type: "string" },
          folder: { type: "string" },
          path: { type: "string" },
          defaultLevel: { type: "integer" },
          keywordScores: { type: "array" },
          relatedUids: { type: "array" },
          merged: { type: "boolean" },
          next: { type: "string" },
        },
      },
      render: (_args, value) =>
        textBlocks(
          `已保存 ${value.uid}（L${value.defaultLevel}）\n路径: ${value.path}\n关键词: ${(value.keywordScores ?? [])
            .map((k) => `${k.term}:${k.keyness.toFixed(1)}`)
            .join(", ")}\n${value.next ?? ""}`,
        ),
    },
    async execute(args, exec) {
      const input = {
        summary: String(args?.summary ?? "").trim(),
        details: asStringArray(args?.details),
        quotes: asStringArray(args?.quotes),
        keywords: asStringArray(args?.keywords),
        people: asStringArray(args?.people),
        scene: args?.scene ? String(args.scene).trim() : undefined,
        event: args?.event ? String(args.event).trim() : undefined,
        emotion: args?.emotion ? String(args.emotion).trim() : undefined,
        source: args?.source ?? "observed",
        importance: Number.isInteger(args?.importance) ? args.importance : 3,
        immortal: args?.immortal === true,
        relatedUids: asStringArray(args?.relatedUids),
      };

      if (input.summary.length < 10) throw new Error("HDM: summary 至少 10 个字符。");
      if (input.summary.length > 1200) throw new Error("HDM: summary 不能超过 1200 个字符。");
      const band = KEYWORD_BANDS[2];
      if (input.keywords.length < band[0] || input.keywords.length > band[1]) {
        throw new Error(`HDM: 创建记忆需要 ${band[0]}~${band[1]} 个关键词（当前 ${input.keywords.length} 个）。`);
      }
      if (!["observed", "told", "inferred", "generated"].includes(input.source)) {
        throw new Error("HDM: source 必须是 observed/told/inferred/generated。");
      }

      // `characters` 是独立可选参数：schema 允许只传它，且文档没要求同时写 `people`。
      // 以前 people 为空时整段丢弃，模型以为写进档案、实际什么都丢了。
      // 现在把 characters 里的姓名并入 people（去重、保序、上限 10），并保留 notes/section/confidence；
      // 合并必须在 appendOrCreate 之前，meta.people 与快照「人物」字段才会带上这些人。
      const characterEntries = [];
      const characterNames = [];
      const seenCharacters = new Set();
      for (const raw of Array.isArray(args?.characters) ? args.characters : []) {
        const name = String(raw?.name ?? "").trim();
        if (!name) {
          ctx.logger?.warn?.("[hdm] hdm_save: characters 条目缺少 name，已跳过");
          continue;
        }
        if (seenCharacters.has(name)) continue;
        seenCharacters.add(name);
        characterNames.push(name);
        const entry = { name };
        if (raw.notes != null) entry.notes = String(raw.notes);
        if (raw.section != null) entry.section = String(raw.section);
        if (Number.isFinite(Number(raw.confidence))) entry.confidence = Number(raw.confidence);
        characterEntries.push(entry);
      }
      const mergedPeople = [];
      for (const name of [...input.people, ...characterNames]) {
        const value = String(name ?? "").trim();
        if (!value || mergedPeople.includes(value)) continue;
        if (mergedPeople.length >= 10) break;
        mergedPeople.push(value);
      }
      input.people = mergedPeople;

      const session = sessionOf(exec);
      const now = Date.now();
      const { meta, keywordScores, merged } = await appendOrCreate({
        registry,
        config,
        home,
        input,
        session,
        state,
        now,
      });

      if (input.immortal || input.importance >= 5) {
        meta.immortal = true;
        meta.immortalReason = input.immortal ? "explicit" : "importance";
        meta.updatedAt = now;
        await registry.upsert(meta);
      }

      if (config.characters?.enabled) {
        const characterUpdates = [...characterEntries];
        for (const name of input.people) {
          if (name === "用户" || seenCharacters.has(name)) continue;
          characterUpdates.push({ name });
        }
        if (characterUpdates.length) {
          try {
            await (await import("./characters.js")).applySaveCharacters(
              home,
              characterUpdates,
              meta.uid,
              config.characters.maxChars,
            );
          } catch (error) {
            ctx.logger?.warn?.(`[hdm] character update failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      for (const related of input.relatedUids) {
        await registry.bumpHit(related, now).catch(() => undefined);
      }

      await state.updateSession(session.id, {
        lastMemoryToolAt: now,
        userTurnsSinceMemory: 0,
      });

      await syncIamIndex(home, registry).catch(() => undefined);
      await autoSnapshot(`save:${meta.uid}`);

      const eventHint = input.event
        ? ""
        : "本次未给 event，已按时间窗口归并；给出宽泛事件名（如「维护插件」「和用户聊天」）才能按事件分单元。";
      const next = input.immortal
        ? "已标记永久豁免。"
        : "如涉及自我认知/关系/长期目标，请调用 hdm_iam_update / hdm_character_update。";
      // 本次关键词里已达意象门槛的：只提示不自动写（模型自己判断是否值得建条目）。
      let imageryHint = "";
      if (config?.imagery?.enabled !== false) {
        try {
          const threshold = Number(config?.imagery?.threshold ?? IMAGERY_DEFAULTS.threshold);
          const minMemories = Number(config?.imagery?.minMemories ?? IMAGERY_DEFAULTS.minMemories);
          const inputKeys = new Set(input.keywords.map((term) => term.toLowerCase()));
          const eligible = eligibleKeywords(registry, config.imagery, 20).filter((row) => inputKeys.has(row.key));
          if (eligible.length) {
            const top = eligible.slice(0, 5).map((row) => `${row.term}(${row.score})`).join("、");
            imageryHint = `已达意象门槛（分≥${threshold} 且≥${minMemories} 条记忆）：${top}；需要可调 hdm_imagery write。`;
          }
        } catch {
          imageryHint = "";
        }
      }
      return {
        ok: true,
        uid: meta.uid,
        label: meta.label,
        folder: meta.folder,
        path: `${meta.folder}/level2.txt`,
        defaultLevel: meta.defaultLevel,
        keywordScores,
        relatedUids: input.relatedUids,
        merged: merged === true,
        next: [next, eventHint, imageryHint].filter(Boolean).join("\n"),
      };
    },
    presentCall(args) {
      return { card: "generic", title: `保存记忆: ${String(args?.summary ?? "").slice(0, 40)}`, kind: "edit" };
    },
  });

  tools.push({
    name: "hdm_recall",
    description:
toolDescription("hdm_recall",      "按关键词在 HDM 记忆库中检索。检索顺序（0.3.0）：先拿全库关键词按 keyness × 时间衰减排成词表，在前 50 个词上做模糊匹配（精确/包含/编辑距离）；凑不够期望条数就进入 50~100 并降低期望，一直循环到第 250 个词；还没找到就回退到精确倒排细找。返回条数默认 = 你给的关键词个数（上限 12），显式 topK 优先。默认返回当前默认快照（defaultLevel），并给出 higherLevels 供读取更高细节。权重 = 命中关键词数 + 档位等级 × recall.levelBias（默认 1）+ boost 加成；boost 四档：none=原公式 / usage=按 hitCount（每次 recall.usageBoost，默认 1）/ recency=按最近更新（上限 recall.recencyBoost，默认 2，窗口 recall.recencyWindowDays）/ pinned=immortal 加 recall.pinnedBoost（默认 3）。hitCount 超过阈值时附带 level≥1 的联想记忆。要为一个目标选方案（例如抓网页正文用命令还是用用户浏览器）时，先把问题压成 3~8 个词表里的名词再检索，不要整句搜索。"),
    parameters: objectSchema(
      {
        keywords: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: { type: "string", maxLength: 32 },
          description: "检索关键词；可用人物、场景、事件、主题、时间等。",
        },
        topK: { type: "integer", minimum: 1, maximum: 12, description: "返回条数；省略则等于输入关键词个数（上限 12）。" },
        view: {
          type: "string",
          enum: ["auto", "0", "1", "2"],
          default: "auto",
          description: "auto=默认档；0/1/2=强制某档，缺失时回退。",
        },
        sameDayOf: { type: "string", description: "给一个 uid，返回同一天的记忆；两边都写了 eventKey 时还要求 eventKey 相同。" },
        boost: {
          type: "string",
          enum: ["none", "usage", "recency", "pinned"],
          default: "none",
          description: "none=原公式；usage=按 hitCount；recency=按最近命中；pinned=永久豁免加成。",
        },
        includeAssociations: { type: "boolean", default: true, description: "是否返回联想记忆。" },
      },
      ["keywords"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          matches: { type: "array" },
          associations: { type: "array" },
          associationTruncated: { type: "boolean" },
          viewFallback: { type: "boolean" },
          sameDay: { type: "array" },
          search: { type: "object" },
        },
      },
      render: (_args, value) => {
        const rows = (value.matches ?? []).map((m) => {
          const higher = m.higherLevels?.length
            ? `\n  更高档: ${m.higherLevels.map((h) => `L${h.level}`).join(", ")}`
            : "";
          // 0.3.1：意象命中给「释义首句」的概述，人物命中提示先读档案——只看摘录会漏掉档案里的其余事实。
          const imagery = (m.imagery ?? []).length
            ? `\n  意象: ${(m.imagery ?? []).map((i) => `${i.term}——${i.summary || "（释义待写）"}（${i.file}）`).join("；")}`
            : "";
          const people = (m.characters ?? []).length
            ? `\n  人物: ${(m.characters ?? [])
                .map((p) => (p.excerpt ? `${p.name}（${p.excerpt}；${p.path}）` : `${p.name}（档案：${p.path}）`))
                .join("；")}（命中人物，先读档案再判断）`
            : "";
          // 人物名不是关键词：纯人物命中的行没有 matchedKeywords，显示人物名才不会看起来像「空命中」。
          const hit = (m.matchedKeywords ?? []).length
            ? (m.matchedKeywords ?? []).join(", ")
            : (m.characters ?? []).length
              ? `人物 ${(m.characters ?? []).map((p) => p.name).join("、")}`
              : "";
          return `${m.uid}  L${m.level}  w=${Number(m.weight).toFixed(1)}  ${m.path}\n  命中: ${hit}${higher}${imagery}${people}`;
        });
        const assoc = (value.associations ?? []).map(
          (a) => `联想 ${a.uid} L${a.level} (${a.reason})\n  ${a.file ?? a.path}`,
        );
        return textBlocks([...rows, ...(assoc.length ? ["", "回忆联想：", ...assoc] : [])].join("\n") || "没有命中。");
      },
    },
    async execute(args) {
      const keywords = asStringArray(args?.keywords);
      if (!keywords.length) throw new Error("HDM: keywords 至少 1 个。");
      const result = await recall({
        registry,
        config,
        home,
        keywords,
        topK: Number.isInteger(args?.topK) ? args.topK : undefined,
        view: args?.view ?? "auto",
        sameDayOf: args?.sameDayOf ?? null,
        boost: args?.boost ?? "none",
        includeAssociations: args?.includeAssociations !== false,
      });
      return result;
    },
    presentCall(args) {
      return { card: "generic", title: `检索记忆: ${(args?.keywords ?? []).join(" ")}`, kind: "read" };
    },
  });

  tools.push({
    name: "hdm_read",
    description: "按 uid 读取某条 HDM 记忆的指定快照全文。level=auto 读默认档；请求档不存在时回退到最近可用档。",
    parameters: objectSchema(
      {
        uid: { type: "string", description: "记忆稳定 ID（m-YYYYMMDD-NNN）。" },
        level: {
          type: "string",
          enum: ["auto", "0", "1", "2"],
          default: "auto",
          description: "要读的快照等级。",
        },
        offset: { type: "integer", minimum: 0, default: 0, description: "起始字符偏移。" },
        limit: { type: "integer", minimum: 200, maximum: 12000, default: 6000, description: "最多读取字符数。" },
      },
      ["uid"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          uid: { type: "string" },
          level: { type: "integer" },
          path: { type: "string" },
          text: { type: "string" },
          truncated: { type: "boolean" },
        },
      },
      render: (_args, value) => textBlocks(value.text),
    },
    async execute(args) {
      const uid = String(args?.uid ?? "").trim();
      if (!uid) throw new Error("HDM: uid 必填。");
      const meta = registry.get(uid);
      if (!meta) throw new Error(`HDM: 找不到记忆 ${uid}。`);
      const level = args?.level === "auto" || args?.level == null ? meta.defaultLevel : Number(args.level);
      const snapshot = await readSnapshot(meta, level);
      const offset = Math.max(0, Number(args?.offset ?? 0));
      const limit = Math.min(12000, Math.max(200, Number(args?.limit ?? 6000)));
      const text = snapshot.text.slice(offset, offset + limit);
      await registry.bumpHit(uid, Date.now()).catch(() => undefined);
      return {
        ok: true,
        uid,
        level: snapshot.level,
        path: snapshot.path,
        text,
        truncated: offset + limit < snapshot.text.length,
      };
    },
    presentCall(args) {
      return { card: "generic", title: `读取记忆: ${args?.uid ?? ""}`, kind: "read" };
    },
  });

  tools.push({
    name: "hdm_character_update",
    description:
toolDescription("hdm_character_update",      "更新人物档案（characters/<name>.md）。只追加不覆盖；每条带日期、证据 uid、置信度；USER 永远第一优先；冲突写入“待确认 / 矛盾”。" +
      "写法与意象同源且框架固定：一句一事实、只写可核对的事实与结论，不铺陈、不解释、不写百科与评价；" +
      "只写进「基本 / 偏好与语气 / 关系与互动 / 待确认 / 矛盾」四节之一，不为某个话题另开新节。"),
    parameters: objectSchema(
      {
        name: { type: "string", maxLength: 40, description: "人物名；用户写“用户”。" },
        notes: { type: "string", maxLength: 1500, description: "本次新增的一条事实或结论；一句一事实，不写评价与背景。" },
        section: {
          type: "string",
          enum: [...CHARACTER_SECTIONS],
          default: "基本",
          description: "写入哪个小节；框架固定为四节，不另开新节。",
        },
        aliases: { type: "array", maxItems: 10, items: { type: "string" }, description: "别名。" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "置信度。" },
        evidenceUid: { type: "string", description: "证据记忆 uid。" },
        mode: { type: "string", enum: ["append", "replace_section"], default: "append", description: "追加或替换小节。" },
      },
      ["name", "notes"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          section: { type: "string" },
          priority: { type: "integer" },
          chars: { type: "integer" },
          error: { type: "string" },
        },
      },
      render: (_args, value) => textBlocks(`人物档案已更新: ${value.path}（${value.section}）`),
    },
    async execute(args) {
      const result = await updateCharacter(
        home,
        {
          name: String(args?.name ?? "").trim(),
          notes: String(args?.notes ?? "").trim(),
          section: args?.section,
          aliases: asStringArray(args?.aliases),
          confidence: typeof args?.confidence === "number" ? args.confidence : undefined,
          evidenceUid: args?.evidenceUid,
          mode: args?.mode === "replace_section" ? "replace_section" : "append",
        },
        config.characters.maxChars,
      );
      if (result?.ok !== false) await autoSnapshot(`character:${result?.path ?? args?.name ?? ""}`);
      return result;
    },
    presentCall(args) {
      return { card: "generic", title: `更新人物: ${args?.name ?? ""}`, kind: "edit" };
    },
  });

  tools.push({
    name: "hdm_iam_update",
    description:
toolDescription("hdm_iam_update",      "更新自传体记忆 IAM.md。涉及自我认知、长期身份、重要关系变化时调用。保留固定标题；超过上限会拒绝并提示压缩。" +
      "各节职责互斥，不要串味：我是谁=只有身份（角色/环境/工作区）；我是怎样的人=只有性格与做事风格；人生阶段=里程碑事件罗列（按时间）；自我叙事=关于自己的常识（喜欢/讨厌什么、常在哪、平时做什么）；重要关系=与谁是什么关系；长期主题与价值=价值排序。" +
      "写法：一句一事实、只写结论、不写过程与运行细节（报错、命令、路径清单、测试数字不进 IAM）、能删的形容词都删；单节建议 ≤5 点、整文建议 ≤2000 字。" +
      "模式：整节改写用 replace_section（推荐，覆盖旧版本）；append 必须同时给 section（无 section 会被拒绝——追加到文末等于落进「记忆索引」节，下一次同步索引会覆盖），且不要追加到会随阶段变动的节——追加会让旧结论与新结论并存，形成长篇大论。"),
    parameters: objectSchema(
      {
        content: { type: "string", maxLength: 4000, description: "要写入的内容。" },
        mode: {
          type: "string",
          enum: ["append", "replace_section", "rewrite"],
          default: "append",
          description: "整节改写用 replace_section；append 只在新增独立事实时用（勿用于会随阶段变动的节）；rewrite 整文件替换。",
        },
        section: {
          type: "string",
          enum: [...REQUIRED_SECTIONS],
          description:
            "append 与 replace_section 时必填（rewrite 可省）。职责：我是谁=身份；我是怎样的人=性格与做事风格；人生阶段=里程碑；自我叙事=关于自己的常识；重要关系=关系；长期主题与价值=价值排序；记忆索引=自动维护勿手改。",
        },
      },
      ["content"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          chars: { type: "integer" },
          mode: { type: "string" },
          error: { type: "string" },
        },
      },
      render: (_args, value) => textBlocks(`IAM 已更新（${value.mode}，${value.chars} 字）`),
    },
    async execute(args) {
      const result = await updateIam(
        home,
        {
          content: String(args?.content ?? ""),
          mode: args?.mode ?? "append",
          section: args?.section,
        },
        config.iam.maxChars,
      );
      if (result?.ok !== false) await autoSnapshot(`iam:${result?.mode ?? "update"}`);
      return result;
    },
    presentCall() {
      return { card: "generic", title: "更新 IAM 自传体记忆", kind: "edit" };
    },
  });

  tools.push({
    name: "hdm_organize",
    description:
toolDescription("hdm_organize",      "主动整理 HDM 记忆库：扫描 meta.json 并修复快照/关键词/文件夹前缀漂移，清理原子写临时文件，重建索引，并报告日记与遗忘的待办量。dryRun=true 只预览不写入。"),
    parameters: objectSchema(
      {
        dryRun: {
          type: "boolean",
          default: false,
          description: "true 只扫描并报告，不修改任何文件。",
        },
        relabel: {
          type: "boolean",
          default: false,
          description: "按 0.4.0 新命名（等级_日期_会话_序号_事件名_关键词）迁移旧文件夹名；配合 dryRun 可先预览。",
        },
      },
      [],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          dryRun: { type: "boolean" },
          dateFolders: { type: "integer" },
          memories: { type: "integer" },
          repaired: { type: "array" },
          warnings: { type: "array" },
          removedTemp: { type: "array" },
          indexCount: { type: "integer" },
          imageryCount: { type: "integer" },
          eventCount: { type: "integer" },
          diaryPending: { type: "array" },
          forgetDue: { type: "integer" },
          labelMigration: { type: "object" },
        },
      },
      render: (_args, value) => textBlocks(formatOrganizeReport(value)),
    },
    async execute(args) {
      const dryRun = args?.dryRun === true;
      const result = await organizeMemories({ home, config, registry, dryRun });
      if (args?.relabel !== true) return result;
      // 迁移默认跟 dryRun 走：预览与实改必须用同一个开关，否则「只看不改」会被顺手改名。
      const migration = await applyLabelMigration(home, registry, { dryRun });
      return { ...result, labelMigration: migration };
    },
    presentCall(args) {
      // dryRun=true 只扫描不写盘：卡片按只读展示，别让用户以为已经改了什么。
      return { card: "generic", title: "整理 HDM 记忆", kind: args?.dryRun === true ? "read" : "edit" };
    },
  });

  tools.push({
    name: "hdm_backup",
    description:
toolDescription("hdm_backup",      "HDM 版本快照（存在母文件夹之外，母文件夹整个被删也不丢）。action=status 看快照根与最近版本；action=snapshot 立即拍一版；action=restore 把 IAM、人物档案、记忆、日记原样恢复到指定版本（不带 version 则用最新版）。恢复前会自动校验哈希，并把当前状态先拍一版用于回滚。"),
    parameters: objectSchema(
      {
        action: { type: "string", enum: ["status", "snapshot", "restore"], default: "status", description: "要执行的动作。" },
        version: { type: "string", description: "restore 用的版本目录名；省略则取最新版。" },
        confirm: { type: "boolean", default: false, description: "restore 必须显式传 true，避免误触发覆盖。" },
      },
      ["action"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          root: { type: "string" },
          rootSource: { type: "string" },
          warning: { type: "string" },
          total: { type: "integer" },
          versions: { type: "array" },
          skipped: { type: "boolean" },
          version: { type: "string" },
          dir: { type: "string" },
          reason: { type: "string" },
          createdAt: { type: "number" },
          counts: { type: "object" },
          bytes: { type: "integer" },
          files: { type: "integer" },
          pruned: { type: "array" },
          restored: { type: "object" },
          digest: { type: "string" },
          expectedDigest: { type: "string" },
          exact: { type: "boolean" },
          rollbackVersion: { type: "string" },
          indexRebuilt: { type: "boolean" },
          disabled: { type: "boolean" },
          error: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (value?.ok === false) return textBlocks(`快照操作失败：${value.error ?? "unknown"}`);
        if (value?.total !== undefined) {
          const latest = value.versions?.[0];
          return textBlocks(
            `快照根：${value.root}（${value.rootSource === "config" ? "配置指定" : "默认"}）· 共 ${value.total} 版` +
              (latest ? `\n最近一版：${latest.version}（${latest.counts?.memories ?? 0} 记忆 / ${latest.counts?.diary ?? 0} 日记 / ${latest.counts?.characters ?? 0} 人物）` : ""),
          );
        }
        if (value?.exact !== undefined) {
          return textBlocks(
            value.exact
              ? `已从 ${value.version} 恢复到保存时的状态（${value.restored?.memories ?? 0} 记忆 / ${value.restored?.diary ?? 0} 日记 / ${value.restored?.characters ?? 0} 人物，digest 一致）`
              : `恢复未完成：${value.error ?? "内容不一致"}`,
          );
        }
        if (value?.skipped) return textBlocks(`内容未变化，复用版本 ${value.version}（${value.root}）`);
        return textBlocks(`快照 ${value?.version ?? "已完成"}（${value?.root ?? ""}）：${value?.files ?? 0} 个文件，${value?.bytes ?? 0} 字节`);
      },
    },
    async execute(args) {
      const action = args?.action ?? "status";
      // output.schema 里 warning 是 string；内部用 null 表示「没有告警」。
      // 置成 undefined 会让宿主按「非无损 JSON」拒绝整次调用，所以这里直接删掉这个键。
      const clean = (value) => {
        if (!value || typeof value !== "object") return value;
        if (value.warning == null) {
          const { warning: _drop, ...rest } = value;
          return rest;
        }
        return value;
      };
      if (action === "snapshot") {
        const result = await snapshot({ home, config, reason: "manual" });
        return clean(result);
      }
      if (action === "restore") {
        if (args?.confirm !== true) {
          return { ok: false, error: "恢复会覆盖母文件夹里的 IAM/人物档案/记忆/日记，请显式传 confirm:true。" };
        }
        const result = await restoreBackup({ home, config, version: args?.version });
        if (result.ok) {
          // 快照里的 memory/**/meta.json 已恢复，索引按它重建即可指向正确路径。
          try {
            await registry.rebuild();
          } catch (error) {
            return clean({
              ...result,
              ok: true,
              indexRebuilt: false,
              warning: `${result.warning ? `${result.warning}；` : ""}索引重建失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
          return clean({ ...result, indexRebuilt: true });
        }
        return clean(result);
      }
      const listing = await listBackups({ home, config });
      const root = resolveBackupRoot({ home, config });
      return clean({
        ok: true,
        root: listing.root,
        rootSource: root.source,
        warning: listing.warning,
        total: listing.total,
        versions: listing.versions.slice(0, 10),
      });
    },
    presentCall(args) {
      // action 缺省即 status（schema default），其余动作会写盘。
      return {
        card: "generic",
        title: "HDM 版本快照",
        kind: (args?.action ?? "status") === "status" ? "read" : "edit",
      };
    },
  });

  tools.push({
    name: "hdm_imagery",
    description:
toolDescription("hdm_imagery",      "意象层：以关键词为线索的经历记忆（与按时间的 memory/ 互补）。只有关键词的记忆质量分（ΣhitCount + 豁免加成，再乘 keyness）达 imagery.threshold 才能写；只追加不覆盖。action=list 列已建意象；read 读条目正文（受 imagery.maxReadChars）；write 写一条（term 必填，meaning 释义，uids 入「经历」与「记忆索引」）。"),
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "read", "write"],
          default: "list",
          description: "list=列出已建意象；read=读某个关键词的条目；write=写一条。",
        },
        term: { type: "string", maxLength: 64, description: "关键词（read/write 必填）。" },
        meaning: { type: "string", maxLength: 300, description: "这个词对你意味着什么（克制叙述，≤300 字）。" },
        note: { type: "string", maxLength: 300, description: "本次经历的一句话笔记（uids 只有 1 条时用）。" },
        notes: {
          type: "object",
          description: "按 uid 给各自的一句话笔记（{uid: note}），多条记忆时不至于全段重复同一句；缺省则用该记忆的事件名。",
          additionalProperties: { type: "string", maxLength: 300 },
        },
        uids: {
          type: "array",
          maxItems: 5,
          items: { type: "string" },
          description: "要写进「经历」与「记忆索引」的记忆 uid。",
        },
      },
      [],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          action: { type: "string" },
          term: { type: "string" },
          file: { type: "string" },
          score: { type: "number" },
          threshold: { type: "number" },
          created: { type: "boolean" },
          text: { type: "string" },
          truncated: { type: "boolean" },
          items: { type: "array" },
        },
      },
      render: (_args, value) => {
        if (value.text) return textBlocks(value.truncated ? `${value.text}\n\n（已截断）` : value.text);
        if (Array.isArray(value.items)) {
          const lines = value.items.map(
            (item) => `${item.term}  score=${Number(item.score).toFixed(1)}  记忆 ${item.memories} 条  ${item.file}`,
          );
          return textBlocks(lines.length ? lines.join("\n") : "还没有意象条目。");
        }
        return textBlocks(
          `已写入意象：${value.term}（score ${Number(value.score).toFixed(1)}）\n${value.file}${value.created ? "\n（新建）" : "\n（追加）"}`,
        );
      },
    },
    async execute(args) {
      const action = String(args?.action ?? "list");
      const threshold = Number(config?.imagery?.threshold ?? IMAGERY_DEFAULTS.threshold);
      if (action === "list") {
        const items = await listImagery(home);
        return { ok: true, action, threshold, items };
      }
      if (action === "read") {
        const result = await readImagery(home, args?.term, config?.imagery?.maxReadChars);
        return {
          ok: true,
          action,
          term: result.entry.term,
          file: result.entry.file,
          score: result.entry.score,
          text: result.text,
          truncated: result.truncated,
        };
      }
      if (action !== "write") throw new Error(`HDM: 未知的 imagery action: ${action}`);
      const result = await writeImagery(
        home,
        registry,
        {
          term: args?.term,
          meaning: args?.meaning,
          note: args?.note,
          notes: args?.notes,
          uids: args?.uids,
          now: Date.now(),
        },
        { ...config?.imagery, threshold },
      );
      return { ok: true, action, ...result, threshold };
    },
    presentCall(args) {
      return { card: "generic", title: `HDM 意象: ${args?.action ?? "list"} ${args?.term ?? ""}`.trim(), kind: args?.action === "write" ? "edit" : "read" };
    },
  });

  tools.push({
    name: "reconception",
    description:
toolDescription("reconception",      "档案调取入口：按「事件 / 人物 / 关键词」三类取回已写下的成文档案（Events/<事件名>.txt、characters/<人物>.md、Imagery/<词>.md）。与 hdm_recall 分工：recall 检索「记忆单元」（摘要、档位、keyness），reconception 调取「档案」正文。先用 mode:index 看有哪些档案与关联记忆 uid，再 mode:read 读正文；kind=event 且 term 为空时直接列出事件表。只读，不写任何文件。"),
    parameters: objectSchema(
      {
        kind: {
          type: "string",
          enum: reconceptionKinds(),
          description: "档案类型：event=事件档案；character=人物档案；keyword=关键词档案。",
        },
        term: {
          type: "string",
          maxLength: 200,
          description: "事件名（可宽泛）/ 人物名或别名 / 关键词；kind=event 的 index 可省略，其余必填。",
        },
        mode: {
          type: "string",
          enum: ["index", "read"],
          default: "index",
          description: "index=列出命中的档案（含关联记忆 uid）；read=读档案正文（受 reconception.maxReadChars）。",
        },
      },
      ["kind"],
    ),
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          kind: { type: "string" },
          term: { type: "string" },
          mode: { type: "string" },
          matches: { type: "array" },
          text: { type: "string" },
          truncated: { type: "boolean" },
          relatedUids: { type: "array" },
        },
      },
      render: (args, value) => {
        if (value?.text) return textBlocks(value.truncated ? `${value.text}\n\n（已截断）` : value.text);
        const matches = Array.isArray(value?.matches) ? value.matches : [];
        if (!matches.length) {
          // 空匹配是结论，不是错误：告诉模型换词/换 kind，别编造。
          return textBlocks(`没有匹配的${args?.kind ?? ""}档案（term: ${args?.term || "（空）"}）；换词、换 kind，或改用 hdm_recall。`);
        }
        const lines = matches.map((item) => `${item.title}  uids=${(item.uids ?? []).length}  ${item.file}`);
        return textBlocks(lines.join("\n"));
      },
    },
    async execute(args) {
      const settings = config?.reconception ?? {};
      return reconcept({
        home,
        registry,
        kind: args?.kind,
        term: args?.term,
        mode: args?.mode ?? "index",
        maxReadChars: Number(settings.maxReadChars ?? RECONCEPTION_DEFAULTS.maxReadChars),
        maxIndexItems: Number(settings.maxIndexItems ?? RECONCEPTION_DEFAULTS.maxIndexItems),
        config,
      });
    },
    presentCall(args) {
      // 纯只读工具：index 与 read 都按只读展示。
      return { card: "generic", title: `档案调取: ${args?.kind ?? ""} ${args?.term ?? ""}`.trim(), kind: "read" };
    },
  });

  return tools.map((t) => ({ ...t, output: { ...t.output, render: t.output.render ?? ((_a, v) => textBlocks(JSON.stringify(v))) } }));
}

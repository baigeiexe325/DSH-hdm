import { KEYWORD_BANDS } from "./config.js";
import { readSnapshot } from "./memory.js";
import { saveConversationMemory } from "./conversation.js";
import { recall } from "./recall.js";
import { updateCharacter } from "./characters.js";
import { updateIam, syncIamIndex, REQUIRED_SECTIONS } from "./iam.js";
import { formatOrganizeReport, organizeMemories } from "./organize.js";
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
      "把当前会话中值得长期保留的内容写入 HDM。创建时只生成 level2 完整快照；第 2 天自动生成 L1，第 5 天生成 L0。同一会话在首次快照生成前再次保存会追加到 level2；快照生成后再次保存会创建新的记忆单元。若本会话已被固定到某个记忆单元（/hdm-remember 或空闲自动整理过），保存会并入同一 uid（必要时重开 L2 后再追加）。keywords 必须按重要性从高到低排列，系统会重新计算 keyness。",
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

      if (config.characters?.enabled && input.people.length) {
        try {
          await (await import("./characters.js")).applySaveCharacters(
            home,
            [
              ...(Array.isArray(args?.characters) ? args.characters : []),
              ...input.people.filter((p) => p !== "用户").map((name) => ({ name })),
            ],
            meta.uid,
            config.characters.maxChars,
          );
        } catch (error) {
          ctx.logger?.warn?.(`[hdm] character update failed: ${error instanceof Error ? error.message : String(error)}`);
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

      const next = input.immortal
        ? "已标记永久豁免。"
        : "如涉及自我认知/关系/长期目标，请调用 hdm_iam_update / hdm_character_update。";
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
        next,
      };
    },
    presentCall(args) {
      return { card: "generic", title: `保存记忆: ${String(args?.summary ?? "").slice(0, 40)}`, kind: "edit" };
    },
  });

  tools.push({
    name: "hdm_recall",
    description:
      "按关键词在 HDM 记忆库中检索。默认返回当前默认快照（defaultLevel），并给出 higherLevels 供读取更高细节。权重 = 命中关键词数 + 档位等级 × recall.levelBias（默认 1）+ boost 加成；boost 四档：none=原公式 / usage=按 hitCount（每次 recall.usageBoost，默认 1）/ recency=按最近更新（上限 recall.recencyBoost，默认 2，窗口 recall.recencyWindowDays）/ pinned=immortal 加 recall.pinnedBoost（默认 3）。hitCount 超过阈值时附带 level≥1 的联想记忆。要为一个目标选方案（例如抓网页正文用命令还是用用户浏览器）时，先把问题压成 3~8 个词表里的名词再检索，不要整句搜索。",
    parameters: objectSchema(
      {
        keywords: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: { type: "string", maxLength: 32 },
          description: "检索关键词；可用人物、场景、事件、主题、时间等。",
        },
        topK: { type: "integer", minimum: 1, maximum: 10, default: 3, description: "返回条数。" },
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
        },
      },
      render: (_args, value) => {
        const rows = (value.matches ?? []).map(
          (m) =>
            `${m.uid}  L${m.level}  w=${Number(m.weight).toFixed(1)}  ${m.path}\n  命中: ${(m.matchedKeywords ?? []).join(", ")}${m.higherLevels?.length ? `\n  更高档: ${m.higherLevels.map((h) => `L${h.level}`).join(", ")}` : ""}${(m.characters ?? []).length ? `\n  人物: ${(m.characters ?? []).map((p) => `${p.name}（${p.excerpt}；${p.path}）`).join("；")}` : ""}`,
        );
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
        topK: Number.isInteger(args?.topK) ? args.topK : config.recall.topK,
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
      "更新人物档案（characters/<name>.md）。只追加不覆盖；每条带日期、证据 uid、置信度；USER 永远第一优先；冲突写入“待确认 / 矛盾”。",
    parameters: objectSchema(
      {
        name: { type: "string", maxLength: 40, description: "人物名；用户写“用户”。" },
        notes: { type: "string", maxLength: 1500, description: "本次新增的观察/偏好/性格/语气等。" },
        section: {
          type: "string",
          enum: ["基本信息", "性格", "偏好", "爱好", "语气与说话方式", "与我的关系", "重要事件", "待确认 / 矛盾"],
          default: "性格",
          description: "写入哪个小节。",
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
      "更新自传体记忆 IAM.md。涉及自我认知、长期目标、重要关系变化时调用。保留固定标题；超过上限会拒绝并提示压缩。各节沿用记忆写法；「当前目标」分点降序，末点写下一步或阻塞。",
    parameters: objectSchema(
      {
        content: { type: "string", maxLength: 4000, description: "要写入的内容。" },
        mode: {
          type: "string",
          enum: ["append", "replace_section", "rewrite"],
          default: "append",
          description: "append 追加；replace_section 替换小节；rewrite 整文件替换。",
        },
        section: {
          type: "string",
          enum: [...REQUIRED_SECTIONS],
          description: "replace_section 时必填。",
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
      "主动整理 HDM 记忆库：扫描 meta.json 并修复快照/关键词/文件夹前缀漂移，清理原子写临时文件，重建索引，并报告日记与遗忘的待办量。dryRun=true 只预览不写入。",
    parameters: objectSchema(
      {
        dryRun: {
          type: "boolean",
          default: false,
          description: "true 只扫描并报告，不修改任何文件。",
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
          diaryPending: { type: "array" },
          forgetDue: { type: "integer" },
        },
      },
      render: (_args, value) => textBlocks(formatOrganizeReport(value)),
    },
    async execute(args) {
      return organizeMemories({
        home,
        config,
        registry,
        dryRun: args?.dryRun === true,
      });
    },
    presentCall(args) {
      // dryRun=true 只扫描不写盘：卡片按只读展示，别让用户以为已经改了什么。
      return { card: "generic", title: "整理 HDM 记忆", kind: args?.dryRun === true ? "read" : "edit" };
    },
  });

  tools.push({
    name: "hdm_backup",
    description:
      "HDM 版本快照（存在母文件夹之外，母文件夹整个被删也不丢）。action=status 看快照根与最近版本；action=snapshot 立即拍一版；action=restore 把 IAM、人物档案、记忆、日记原样恢复到指定版本（不带 version 则用最新版）。恢复前会自动校验哈希，并把当前状态先拍一版用于回滚。",
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

  return tools.map((t) => ({ ...t, output: { ...t.output, render: t.output.render ?? ((_a, v) => textBlocks(JSON.stringify(v))) } }));
}

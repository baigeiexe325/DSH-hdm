import os from "node:os";
import path from "node:path";
import { Config, resolveConfig } from "./config.js";
import { expandHome, ensureDir, localDate } from "./paths.js";
import { Registry } from "./registry.js";
import { StateStore } from "./state.js";
import { createTools } from "./tools.js";
import { buildPluginMessage, buildPreStepDecision, priorUserCount, REMEMBER_INSTRUCTION } from "./injection.js";
import { registerTriggers } from "./triggers.js";
import { getGuideText } from "./guide.js";
import { getSkillRegistration } from "./skill.js";
import { ensureIam, ensureIamBlank, syncIamIndex } from "./iam.js";
import { HDM_DESCRIPTORS } from "./remote.js";
import {
  activityToPersist,
  maintenanceInfo,
  noteUserActivity,
  organizeSession,
  pendingActivity,
  runIdleScan,
  seedFromSession,
  seedRingsFromState,
} from "./idle.js";
import { ensureUserProfile } from "./characters.js";
import { touchSession } from "./sharing.js";
import { runDiary } from "./diary.js";
import { runForgetPass } from "./forget.js";
import { startGistTimer } from "./gist.js";
import { migrateHome, readPointer, writePointer } from "./migrate.js";
import { resolveBackupRoot, snapshotIfChanged } from "./backup.js";
import { noteCompactionStart, settleCompaction } from "./compact.js";

export const name = "hdm";
export const inject = ["tools"];
export { Config };

/** 目标路径是否落在系统临时目录内（用于拦截「真库→临时目录」的自动迁移）。 */
export function isTempPath(target) {
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(target);
  const rel = path.relative(tmp, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function ok(text) {
  return { kind: "success", text };
}

function fail(text) {
  return { kind: "error", text };
}

function shortId(uid) {
  return typeof uid === "string" ? uid : String(uid ?? "");
}

export async function apply(ctx, rawConfig) {
  let config;
  try {
    config = resolveConfig(rawConfig);
  } catch (error) {
    ctx.logger?.error?.(`[hdm] invalid config: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!config.enabled) {
    ctx.logger?.info?.("[hdm] disabled by config");
    return;
  }

  const home = expandHome(config.homeDir);
  const homeResolved = path.resolve(home);

  // 母文件夹切换：按主目录里的指针找回旧位置并自动迁移。
  // 迁移会 cp + rm 旧目录，属于整目录级操作——动手前先给旧母文件夹拍一版母文件夹之外的快照。
  // 指针只在「迁移成功」「无需迁移（没有指针 / 指针已指向当前 home）」时写回；
  // 迁移抛错时不写，否则会丢掉唯一指向旧目录的线索，数据就再也找不回来了。
  //
  // 临时目录闸门：homeDir 指向系统临时目录、而旧母文件夹不在临时目录时，拒绝迁移。
  // 否则任何临时 home 的实例化（脚本/冒烟/误配）都会把真实库 rename/cp 进临时目录，
  // 进程退出或脚本清理后数据随之消失（2026-11-19 真实事故）。两端都在临时目录时放行，测试照常。
  let migratedHome = false;
  let pointerHome = null;
  let migrateFailed = false;
  try {
    const pointer = await readPointer();
    pointerHome = pointer?.homeDir ? path.resolve(pointer.homeDir) : null;
    if (pointerHome && pointerHome !== homeResolved) {
      if (isTempPath(homeResolved) && !isTempPath(pointerHome)) {
        ctx.logger?.warn?.(
          `[hdm] 拒绝把母文件夹迁入临时目录：${pointerHome} -> ${homeResolved}；旧目录仍是权威，指针未改。`,
        );
      } else {
        const before = await snapshotIfChanged({ home: pointerHome, config, reason: "pre-migration" }).catch(() => null);
        if (before?.ok && !before.skipped) {
          ctx.logger?.info?.(`[hdm] 迁移前快照：${before.version} -> ${before.root}`);
        }
        const result = await migrateHome(pointerHome, home);
        if (result.migrated) {
          migratedHome = true;
          ctx.logger?.info?.(`[hdm] 母文件夹已迁移：${pointerHome} -> ${home}（${result.mode}，重写 ${result.rewritten ?? 0} 条 folder）`);
        }
      }
    }
  } catch (error) {
    migrateFailed = true;
    ctx.logger?.warn?.(
      `[hdm] 母文件夹迁移失败，旧目录 ${pointerHome ?? "（指针不可读）"} 仍是权威，下次启动会重试迁移；本次继续使用 ${home}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!migrateFailed && (migratedHome || !pointerHome || pointerHome === homeResolved)) {
    try {
      await writePointer(home);
    } catch (error) {
      ctx.logger?.warn?.(`[hdm] 母文件夹指针写入失败（下次启动仍可重试迁移）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const disposers = [];
  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
  };

  try {
    await ensureDir(home);
    await ensureDir(`${home}/memory`);
    await ensureDir(`${home}/diary`);
    await ensureDir(`${home}/characters`);
    await ensureDir(`${home}/Imagery`);
    await ensureDir(`${home}/index`);
    await ensureDir(`${home}/Backup`);
    await ensureDir(`${home}/state`);
    await ensureDir(`${home}/state/logs`);
  } catch (error) {
    ctx.logger?.error?.(`[hdm] cannot prepare home ${home}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const registry = new Registry(home, config);
  await registry.adoptLegacyBackups().catch((error) => {
    ctx.logger?.warn?.(`[hdm] backup adoption failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (migratedHome) {
    // 迁移复制来的索引仍带旧 folder 路径；直接从 meta.json 重建，保证读写都指向新母文件夹。
    try {
      await registry.rebuild();
    } catch (rebuildError) {
      ctx.logger?.error?.(`[hdm] rebuild after migration failed: ${rebuildError instanceof Error ? rebuildError.message : String(rebuildError)}`);
    }
  } else {
    try {
      const loaded = await registry.load();
      if (loaded?.repaired) {
        ctx.logger?.info?.("[hdm] 索引已自愈重建：memories/keywords 双写不一致，已按 meta.json 重写 keywords.json");
      }
    } catch (error) {
      ctx.logger?.warn?.(`[hdm] index load failed, rebuilding: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await registry.rebuild();
      } catch (rebuildError) {
        ctx.logger?.error?.(`[hdm] rebuild failed: ${rebuildError instanceof Error ? rebuildError.message : String(rebuildError)}`);
      }
    }
  }

  const state = new StateStore(home);
  try {
    await state.load();
  } catch (error) {
    ctx.logger?.warn?.(`[hdm] state load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // reload 后进程内活跃环是空的：从持久化的活动环回灌，让重载前活跃、之后沉默的会话
  // 仍进入空闲扫描名单，而不是永远「没有活跃会话」。
  try {
    const seeded = seedRingsFromState({ home, state });
    if (seeded > 0) ctx.logger?.info?.(`[hdm] 回灌 ${seeded} 个会话的活跃水位`);
  } catch (error) {
    ctx.logger?.warn?.(`[hdm] seed activity rings failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 维护模型需要 llm / agentDefaultModel / agents，但插件只声明了 inject:["tools"]，
  // 根 ctx 上这些服务可能既没有属性也不好取。这里显式捕获一份，并拼出一个
  // 「只用于 LLM 维护」的 ctx，其余字段（logger/timer/tokenMeter）代理回根 ctx。
  const hostServices = Object.create(null);
  for (const key of ["llm", "agentDefaultModel", "agents"]) {
    try {
      ctx.inject?.([key], (serviceCtx) => {
        hostServices[key] = serviceCtx?.[key];
      });
    } catch {
      /* 服务不存在就跳过，后面还有 ctx.get 兜底 */
    }
  }
  // 只读代理：这些属性在根 ctx 上受 inject 约束，直接读会抛
  // `cannot get property "timer" without inject`，所以必须惰性 + try/catch。
  const modelCtx = {
    get(name) {
      if (hostServices[name] !== undefined) return hostServices[name];
      try {
        return typeof ctx.get === "function" ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    },
  };
  for (const key of ["logger", "timer", "tokenMeter"]) {
    Object.defineProperty(modelCtx, key, {
      get() {
        try {
          return ctx[key];
        } catch {
          return undefined;
        }
      },
    });
  }

  try {
    await ensureIam(home);
    await ensureIamBlank(home);
    await ensureUserProfile(home);
    await syncIamIndex(home, registry);
  } catch (error) {
    ctx.logger?.warn?.(`[hdm] template init failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Tools
  try {
    for (const definition of createTools({ ctx, home, config, registry, state })) {
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === "function") disposers.push(dispose);
    }
  } catch (error) {
    ctx.logger?.error?.(`[hdm] tool registration failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }

  // Skill (optional service)
  ctx.inject?.(["skills"], (sctx) => {
    sctx.effect(() => sctx.skills.register(getSkillRegistration()));
  });

  // Static guide section (optional service)
  ctx.inject?.(["systemPrompt"], (sctx) => {
    sctx.effect(() =>
      sctx.systemPrompt.section({
        name: "hdm:guide",
        order: 131,
        text: getGuideText(),
      }),
    );
  });

  // Settings page: let the built-in Settings service own an auto page for HDM.
  ctx.inject?.(["settings"], (sctx) => {
    sctx.effect(() => {
      if (typeof sctx.settings?.configure !== "function") return undefined;
      return sctx.settings.configure({ auto: true }, sctx.fiber);
    });
  });

  // Remote face: 设置页的「生成 IAM 空白模板」与「维护信息」通过 Typert 调用宿主。
  ctx.inject?.(["typert"], (tctx) => {
    const service = {
      generateIamBlank: (overwrite) => ensureIamBlank(home, { overwrite: overwrite === true }),
      maintenanceInfo: () => maintenanceInfo({ ctx: modelCtx, home, config, now: Date.now() }),
    };
    service.typertRemote = Object.freeze({ service, serviceKey: "hdmSettings", namespace: "hdmSettings" });
    try {
      tctx.provide("hdmSettings", service);
      tctx.effect(() => {
        const dispose = tctx.typert.register({
          package: "dsh-hdm",
          face: "host",
          schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: HDM_DESCRIPTORS,
        });
        return typeof dispose === "function" ? dispose : () => {};
      }, "hdm: hdmSettings remote descriptors");
    } catch (error) {
      ctx.logger?.warn?.(`[hdm] remote face registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Commands (optional service)
  ctx.inject?.(["commands"], (cctx) => {
    cctx.effect(() => registerCommands(cctx, { ctx: modelCtx, home, config, registry, state }));
  });

  // First-turn context / 50% save reminder / auto-recall / nudge
  disposers.push(
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      // 跨会话共享的「正在工作」心跳：本会话每进一次 pre-step 就算活跃（不持久化，跨进程退化为 lastUserAt）。
      try {
        const session = payload?.agent?.session;
        const sessionId = session?.id ?? payload?.agent?.id;
        if (typeof sessionId === "string" && sessionId && !session?.subagent) touchSession(sessionId, Date.now());
      } catch {
        /* 心跳失败不影响注入 */
      }
      // 空闲整理只认真实用户发言：插件注入的消息、子智能体会话都不计入活跃度。
      try {
        const session = payload?.agent?.session;
        const sessionId = session?.id ?? payload?.agent?.id;
        if (typeof sessionId === "string" && sessionId && !session?.subagent) {
          const messages = Array.isArray(decision?.messages) ? decision.messages : [];
          // 只认显式 source.kind === "user"：宿主对真实用户消息会标注，插件注入与内部消息不会。
          const realUsers = messages.filter((message) => message?.source?.kind === "user");
          const last = realUsers[realUsers.length - 1];
          const text = (Array.isArray(last?.content) ? last.content : [])
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n");
          if (text.trim()) {
            const noted = noteUserActivity({ home, sessionId, text, total: priorUserCount(session) });
            // 水位线落盘：`lastUserAt` 必须是真实发言时间（以前只在整理时写，看起来像发言时间其实不是）。
            // 同时持久化有界活动环，reload 后 seedRingsFromState 能把旧会话捞回扫描名单。
            if (noted && !noted.duplicate) {
              const entry = pendingActivity({ home, sessionId });
              const previous = Array.isArray(state.getSession(sessionId)?.activity) ? state.getSession(sessionId).activity : [];
              const fresh = entry?.lastMessage
                ? [{ at: Number(entry.lastMessage.at) || Date.now(), text: String(entry.lastMessage.text ?? "") }]
                : [];
              // 累积而不是覆盖：每次只追加新的一条，持久化环保留最近 20 条。
              const merged = [...previous, ...fresh].slice(-20);
              await state.updateSession(sessionId, {
                lastUserAt: noted.lastAt ?? Date.now(),
                userMessageCount: noted.count ?? 0,
                activity: activityToPersist({ messages: merged }),
              });
            }
          }
        }
      } catch {
        /* 活跃度统计失败不影响注入 */
      }
      try {
        return await buildPreStepDecision({
          ctx,
          home,
          config,
          registry,
          state,
          agent: payload?.agent,
          decision,
          now: Date.now(),
          step: payload?.step,
          turn: payload?.turn,
        });
      } catch (error) {
        ctx.logger?.warn?.(`[hdm] pre-step injection failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
    }),
  );

  // Compaction: 压缩前先存一条记忆，压缩完成后把记忆与 IAM 一起交回下一步。
  disposers.push(
    ctx.on("session/event", (session, event) => {
      const type = event?.type;
      if (type !== "compaction/start" && type !== "compaction/end") return;
      const id = session?.id;
      if (typeof id !== "string") return;
      if (type === "compaction/start") {
        // 同步拍下压缩前对话；模型调用在后台跑，压缩本身不等待。
        try {
          noteCompactionStart({ ctx: modelCtx, home, config, registry, state, session });
        } catch (error) {
          ctx.logger?.warn?.(`[hdm] 压缩前记忆启动失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (event.data?.error) return;
      // 返回 promise：测试与诊断能确定性地等到收尾完成；错误已就地 catch，不会变成未处理拒绝。
      return settleCompaction({ config, state, session })
        .then((result) => {
          if (result?.ok) ctx.logger?.info?.(`[hdm] 压缩前记忆已保存: ${result.uid}`);
          else ctx.logger?.warn?.(`[hdm] 压缩前记忆未保存: ${result?.reason ?? "unknown"}`);
        })
        .catch((error) => {
          ctx.logger?.warn?.(`[hdm] 压缩后收尾失败: ${error instanceof Error ? error.message : String(error)}`);
        });
    }),
  );

  // Timers: diary + sequential forget + idle organizer
  try {
    disposers.push(registerTriggers({ ctx: modelCtx, home, config, registry, state }));
    disposers.push(startGistTimer({ ctx: modelCtx, home, config, registry }));
  } catch (error) {
    ctx.logger?.warn?.(`[hdm] trigger registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.effect(() => () => disposeAll());
  ctx.logger?.info?.(`[hdm] ready: home=${home} memories=${registry.list().length}`);
}

function registerCommands(cctx, { ctx: appCtx, home, config, registry, state }) {
  const disposers = [];
  const commands = cctx.commands;

  disposers.push(
    commands.register({
      name: "hdm",
      description: "HDM 记忆状态：母文件夹、记忆/日记/人物数量、本会话使用情况",
      handler: async (invocation) => {
        const sessionId = invocation?.agent?.id;
        const ss = sessionId ? state.getSession(sessionId) : null;
        const list = registry.list();
        const snapshots = list.reduce((n, m) => n + (m.snapshots?.length ?? 0), 0);
        const immortal = list.filter((m) => m.immortal).length;
        const today = localDate(Date.now(), config.timeZone);
        const lines = [
          "HDM 状态",
          `母文件夹: ${home}`,
          `记忆单元: ${list.length}（快照 ${snapshots}，永久豁免 ${immortal}）`,
          `今天: ${today}`,
          `维护模型: ${config.maintenance.provider && config.maintenance.model ? `${config.maintenance.provider}/${config.maintenance.model}` : "默认模型"}`,
        ];
        try {
          const info = await maintenanceInfo({
            ctx: appCtx,
            home,
            config,
            now: Date.now(),
            session: invocation?.agent?.session,
          });
          const last = info.runs[0];
          const sourceLabel = info.source === "config" ? "设置里指定" : info.source === "auto" ? "跟随默认" : "未找到";
          lines.push(
            `空闲整理: ${info.idle.enabled ? "开" : "关"} ${info.idle.minMinutes}~${info.idle.maxMinutes} 分钟 · 今日 ${info.today.used}/${info.today.budget || "∞"} · 模型来源 ${sourceLabel}（${
              info.model ? `${info.model.provider}/${info.model.model}` : "无"
            }） · 最近 ${last ? `${last.result} ${new Date(last.at).toLocaleTimeString("zh-CN", { hour12: false })}` : "无"}`,
          );
          if (ss?.lastOrganizeError) lines.push(`上次整理错误: ${ss.lastOrganizeError}`);
        } catch {
          lines.push("空闲整理: 状态读取失败");
        }
        if (ss) {
          lines.push(
            `本会话: 记忆 ${ss.uids?.length ?? 0} 条，固定单元 ${ss.memoryUid ?? "无"}，上次保存压力 ${ss.lastSaveRatio ?? "无"}，提醒 ${ss.nudges ?? 0} 次`,
          );
        }
        return ok(lines.join("\n"));
      },
    }),
  );

  disposers.push(
    commands.register({
      name: "hdm-diary",
      description: "强制生成指定日期的 HDM 日记（默认今天）",
      input: { hint: "YYYY-MM-DD（可空）" },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? "").trim();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localDate(Date.now(), config.timeZone);
        const result = await runDiary({ ctx: appCtx, home, config, registry, date, force: true });
        if (result.ok) return ok(`日记已生成: ${result.path}`);
        if (result.path && result.fallback) return ok(`日记已生成（回退摘要）: ${result.path}`);
        return fail(`日记生成失败: ${result.error ?? "unknown"}`);
      },
    }),
  );

  disposers.push(
    commands.register({
      name: "hdm-forget",
      description: "强制执行 HDM 遗忘巡检（due / uid / all）",
      input: { hint: "due | uid | all" },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? "").trim();
        const target = raw || "due";
        const result = await runForgetPass({ ctx: appCtx, home, config, registry, target, state });
        await syncIamIndex(home, registry).catch(() => undefined);
        const okCount = result.processed.filter((p) => p.ok).length;
        return ok(`遗忘巡检完成：处理 ${result.processed.length} 条，成功 ${okCount} 条`);
      },
    }),
  );

  disposers.push(
    commands.register({
      name: "hdm-remember",
      description: "强制把本会话记忆下来：登记后由对话智能体在下一步生成内容，并把本会话固定到该记忆单元（之后都并入同一编码）",
      handler: async (invocation) => {
        const session = invocation?.agent?.session;
        const sessionId = session?.id ?? invocation?.agent?.id;
        if (typeof sessionId !== "string" || !sessionId) return fail("拿不到当前会话 id，无法整理。");
        // 内容由对话智能体生成（它拥有完整上下文），维护模型只负责整库维护与 L2→L1→L0 降级。
        // 这里只登记「下一个 hdm_save 要固定本会话单元」；先固定编码，避免保存分裂成两个单元。
        const at = Date.now();
        await state.updateSession(sessionId, {
          pendingRememberAt: at,
          pendingRememberHintAt: null,
          memoryUid: null,
          pinConversation: true,
        });
        // 命令本身不产生模型回合，只登记的话模型要等到下一条用户消息才看到指令。
        // followup 把指令作为一条用户角色消息投递给同一个 agent 并唤醒它，模型因此在本轮就能保存。
        // 投递成功就把 hintAt 对齐，pre-step 不再重复催；投递失败（老宿主/无 agent）保留 null，
        // 由下一次 pre-step 注入兜底。
        const delivered = deliverRememberInstruction(invocation?.agent, REMEMBER_INSTRUCTION);
        if (delivered) await state.updateSession(sessionId, { pendingRememberHintAt: at }).catch(() => undefined);
        return ok(
          [
            delivered
              ? "已登记本会话的记忆单元，并把保存指令投递给本轮对话；我会立即写入 hdm_save 并固定到同一个编码，同时自查 IAM 与人物档案是否需要更新。"
              : "已登记本会话的记忆单元；下一步会收到指令，由我写入 hdm_save 并固定到同一个编码，同时自查 IAM 与人物档案。",
            "（内容由对话智能体生成；维护模型只负责整库维护与快照降级。）",
          ].join("\n"),
        );
      },
    }),
  );

  disposers.push(
    commands.register({
      name: "hdm-idle",
      description: "扫描活跃会话并立即执行一次空闲记忆整理（加 force 忽略空闲时长门槛）",
      input: { hint: "force（可空）" },
      handler: async (invocation) => {
        const force = /^(force|now|立即|强制)$/i.test(String(invocation?.rawInput ?? "").trim());
        // 老会话（本进程启动前就在跑）没有活跃度 ring：force 时先从会话事件回填，否则永远「没有活跃会话」。
        const session = invocation?.agent?.session;
        const sessionId = session?.id ?? invocation?.agent?.id;
        if (typeof sessionId === "string" && sessionId) seedFromSession({ home, sessionId, session });
        const results = await runIdleScan({ ctx: appCtx, home, config, registry, state, force, liveSession: session });
        if (!results.length) return ok("当前没有活跃会话；空闲整理只覆盖本进程内活跃过的会话。");
        const lines = results.map((row) => {
          const short = row.sessionId.slice(0, 8);
          if (row.ok) return `${short}  已整理 ${row.uid}${row.merged ? "（并入已有单元）" : ""}`;
          return `${short}  跳过：${row.reason}${row.error ? `（${row.error}）` : ""}`;
        });
        return ok([`空闲整理扫描（force=${force ? "on" : "off"}）`, ...lines].join("\n"));
      },
    }),
  );

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
  };
}

// 把「强制记忆」指令作为一条用户角色消息投递给当前 agent 并唤醒它，让模型在命令执行的这一轮
// 就调用 hdm_save。宿主没有 followup（老版本/无 agent）时返回 false，交给 pre-step 注入兜底。
function deliverRememberInstruction(agent, text) {
  if (typeof agent?.followup !== "function") return false;
  try {
    // 用与 pre-step 注入同形状的消息：带唯一 id（inbox 拒绝重复 id）与非 user 的 source。
    agent.followup(buildPluginMessage(text, "remember"));
    return true;
  } catch {
    return false;
  }
}


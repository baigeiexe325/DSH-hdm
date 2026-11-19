import { startDiaryTimer } from "./diary.js";
import { startForgetTimer } from "./forget.js";
import { startIdleOrganizeTimer } from "./idle.js";

export function pressureRatio(ctx, session) {
  try {
    const meter = ctx?.tokenMeter ?? ctx?.get?.("tokenMeter");
    if (!meter) return null;
    const pressure = meter.contextPressure?.(session);
    if (pressure?.pressureTokens != null && pressure?.contextWindow) {
      return pressure.pressureTokens / pressure.contextWindow;
    }
    const measured = meter.measure?.(session);
    if (measured?.totalTokens != null && pressure?.contextWindow) {
      return measured.totalTokens / pressure.contextWindow;
    }
    return null;
  } catch {
    return null;
  }
}

function interval(ctx, fn, ms) {
  if (typeof ctx?.timer?.interval === "function") {
    const dispose = ctx.timer.interval(fn, ms);
    return typeof dispose === "function" ? dispose : () => undefined;
  }
  const id = setInterval(() => {
    try {
      void fn();
    } catch {
      /* ignore */
    }
  }, ms);
  return () => clearInterval(id);
}

export function registerTriggers({ ctx, home, config, registry, state, runDiaryTask = null }) {
  const disposers = [];
  // startDiaryTimer 返回函数才代表「已注册」；返回 null 说明没启用，此时才需要心跳兜底。
  let diaryTimerRegistered = false;

  if (config.diary?.enabled && typeof startDiaryTimer === "function") {
    try {
      const dispose = startDiaryTimer({ ctx, home, config, registry, state });
      if (typeof dispose === "function") {
        disposers.push(dispose);
        diaryTimerRegistered = true;
      }
    } catch (error) {
      ctx.logger?.warn?.(`[hdm] diary timer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.forget?.enabled && typeof startForgetTimer === "function") {
    try {
      const dispose = startForgetTimer({ ctx, home, config, registry, state });
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      ctx.logger?.warn?.(`[hdm] forget timer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.idle?.enabled && typeof startIdleOrganizeTimer === "function") {
    try {
      const dispose = startIdleOrganizeTimer({ ctx, home, config, registry, state });
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      ctx.logger?.warn?.(`[hdm] idle organizer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 兜底心跳：日记定时器没注册（startDiaryTimer 返回 null）时才补跑 runDiary，
  // 否则两套 15 分钟定时器会在同一时刻各跑一遍日记生成。
  disposers.push(
    interval(
      ctx,
      async () => {
        if (!diaryTimerRegistered) {
          try {
            if (typeof runDiaryTask === "function") {
              await runDiaryTask({ ctx, home, config, registry, state });
            } else {
              const { runDiary } = await import("./diary.js");
              if (typeof runDiary === "function") {
                const { localDate } = await import("./paths.js");
                const date = localDate(Date.now(), config.timeZone);
                await runDiary({ ctx, home, config, registry, date, force: false });
              }
            }
          } catch {
            /* ignore */
          }
        }
        // 定时写入（日记、第 2/5 天派生）也要进版本快照：内容没变会被 digest 去重跳过。
        try {
          const { snapshotIfChanged } = await import("./backup.js");
          await snapshotIfChanged({ home, config, reason: "timer" });
        } catch {
          /* 快照失败不影响心跳 */
        }
      },
      15 * 60 * 1000,
    ),
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

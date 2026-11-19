// HDM Web UI 设置页（Client 半）。
// 数据通道：宿主 ui-settings 提供的 configForms 服务（与内置设置页同一套 describe/mutate 通道），
// 拿不到该服务时退回 client 的 remote.settings；两者都没有则只读并给出原因。
// 关键点：必须订阅 configForms 的 form store——describe 镜像初次读取是异步的，
// 只读一次会把「加载中」的快照（value 为空、writable=false）永久当成只读，控件便全部禁用。

window.__ModuleLoader__.load({
  id: "dsh-hdm",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const SLOT = "settings.section";
    // 宿主 describe 的 ns 是 profile 条目 id（patch id）：本插件在 cordis.patch.yml 里的 id 是 "hdm"。
    const NS_CANDIDATES = ["hdm", "include:hdm", "dsh-hdm"];

    // 与 lib/remote.js 同构的字面量：bundle 是手写 CJS，不能 require 宿主模块，只能内联。
    const HDM_REMOTE = Object.freeze({
      package: "dsh-hdm",
      descriptors: [
        {
          id: "dsh-hdm#hdmSettings/generateIamBlank",
          service: "hdmSettings",
          namespace: "hdmSettings",
          method: "generateIamBlank",
          invocation: { kind: "direct" },
          result: { mode: "strict", typeSymbol: "dsh-hdm#HdmSettingsResult", create: () => ({ parse: (value) => value }) },
          parameters: [
            {
              name: "overwrite",
              wire: "overwrite",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-hdm#HdmOverwrite",
                // 与 lib/remote.js 的 parseBoolean 同构：非法值不静默吞掉。
                create: () => ({
                  parse: (value) => {
                    if (value === undefined || value === null) return false;
                    if (typeof value !== "boolean") throw new Error("Expected a boolean");
                    return value;
                  },
                }),
              },
            },
          ],
        },
        {
          id: "dsh-hdm#hdmSettings/maintenanceInfo",
          service: "hdmSettings",
          namespace: "hdmSettings",
          method: "maintenanceInfo",
          invocation: { kind: "direct" },
          result: { mode: "strict", typeSymbol: "dsh-hdm#HdmSettingsResult", create: () => ({ parse: (value) => value }) },
          parameters: [],
        },
      ],
    });

    const DEFAULTS = Object.freeze({
      homeDir: "~/.dsh-hdm",
      enabled: true,
      threshold: 0.5,
      diaryEnabled: true,
      forgetEnabled: true,
      autoRecallEnabled: true,
      recallLevel: 1,
      compactMemorize: true,
      idleEnabled: true,
      idleMinutes: 180,
      idleMaxHours: 12,
      idleCheckMinutes: 15,
      maintenanceProvider: "",
      maintenanceModel: "",
      maintenanceMaxTokens: 100000,
      diaryMaxChars: 8000,
    });

    const EMPTY_SNAPSHOT = Object.freeze({ status: "idle", value: undefined, writable: false, revision: undefined });

    const CSS = `
.hdm-page{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;padding:2px 0 8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.hdm-head{display:flex;flex-direction:column;gap:2px}
.hdm-title{margin:0;font-size:16px;font-weight:600}
.hdm-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hdm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:0 16px}
.hdm-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:16px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hdm-row:last-child{border-bottom:0}
.hdm-row.hdm-stack{grid-template-columns:minmax(0,1fr);row-gap:8px}
.hdm-text{min-width:0}
.hdm-name{font-weight:550}
.hdm-hint{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.hdm-input{display:block;width:100%;min-width:0;box-sizing:border-box;padding:6px 10px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.hdm-input:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.hdm-input:disabled{opacity:.55;cursor:not-allowed}
.hdm-switch{position:relative;flex:none;width:40px;height:22px;padding:0;border:0;border-radius:11px;background:var(--dsw-alias-state-idle-primary);cursor:pointer;transition:background .15s ease}
.hdm-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 0 0 1px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.hdm-switch[data-on="true"]{background:var(--dsw-alias-brand-primary)}
.hdm-switch[data-on="true"]::after{transform:translateX(18px)}
.hdm-switch:disabled{opacity:.5;cursor:not-allowed}
.hdm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.hdm-range-cell{display:flex;align-items:center;gap:10px;width:220px;max-width:46vw}
.hdm-range{flex:1 1 auto;min-width:0;width:100%;height:22px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.hdm-range:disabled{opacity:.5;cursor:not-allowed}
.hdm-value{flex:none;width:42px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.hdm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.hdm-btn{padding:6px 14px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer}
.hdm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.hdm-btn.primary{color:#fff;background:var(--dsw-alias-brand-primary);border-color:transparent}
.hdm-btn:disabled{opacity:.5;cursor:not-allowed}
.hdm-status{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hdm-status.ok{color:var(--dsw-alias-state-success-primary)}
.hdm-status.error{color:var(--dsw-alias-state-error-primary)}
.hdm-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hdm-num{display:flex;align-items:center;gap:6px}
.hdm-num .hdm-input{width:96px;text-align:right}
.hdm-list{margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hdm-list li{margin:2px 0}
`;

    function softService(ctx, name) {
      try {
        return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error ?? "未知错误");
    }

    function readPath(value, path) {
      let node = value;
      for (const key of path) {
        if (node === null || node === undefined) return undefined;
        node = node[key];
      }
      return node;
    }

    function valuesOf(value, ns) {
      const source = value ?? {};
      const pick = (path, fallback) => {
        const next = readPath(source, path);
        return next === undefined ? fallback : next;
      };
      return {
        homeDir: String(pick(["homeDir"], DEFAULTS.homeDir)),
        enabled: Boolean(pick(["enabled"], DEFAULTS.enabled)),
        threshold: Number(pick(["save", "threshold"], DEFAULTS.threshold)),
        diaryEnabled: Boolean(pick(["diary", "enabled"], DEFAULTS.diaryEnabled)),
        forgetEnabled: Boolean(pick(["forget", "enabled"], DEFAULTS.forgetEnabled)),
        autoRecallEnabled: Boolean(pick(["autoRecall", "enabled"], DEFAULTS.autoRecallEnabled)),
        recallLevel: Number(pick(["autoRecall", "level"], DEFAULTS.recallLevel)),
        compactMemorize: Boolean(pick(["compaction", "memorize"], DEFAULTS.compactMemorize)),
        idleEnabled: Boolean(pick(["idle", "enabled"], DEFAULTS.idleEnabled)),
        idleMinutes: Number(pick(["idle", "idleMinutes"], DEFAULTS.idleMinutes)),
        idleMaxHours: Math.round((Number(pick(["idle", "maxIdleMinutes"], DEFAULTS.idleMaxHours * 60)) / 60) * 10) / 10,
        idleCheckMinutes: Number(pick(["idle", "checkMinutes"], DEFAULTS.idleCheckMinutes)),
        maintenanceProvider: String(pick(["maintenance", "provider"], DEFAULTS.maintenanceProvider)),
        maintenanceModel: String(pick(["maintenance", "model"], DEFAULTS.maintenanceModel)),
        maintenanceMaxTokens: Number(pick(["maintenance", "maxTokens"], DEFAULTS.maintenanceMaxTokens)),
        diaryMaxChars: Number(pick(["diary", "maxChars"], DEFAULTS.diaryMaxChars)),
        namespace: ns,
      };
    }

    /** 写入用的字段操作：只提交发生变化的项，避免覆盖同时段的其他修改。 */
    function buildOps(values, base) {
      const ops = [];
      const push = (path, next, before) => {
        if (next === before) return;
        ops.push({ op: "set", path, value: next });
      };
      push(["homeDir"], String(values.homeDir).trim(), base.homeDir);
      push(["enabled"], Boolean(values.enabled), base.enabled);
      push(["save", "threshold"], clampThreshold(values.threshold), base.threshold);
      push(["diary", "enabled"], Boolean(values.diaryEnabled), base.diaryEnabled);
      push(["forget", "enabled"], Boolean(values.forgetEnabled), base.forgetEnabled);
      push(["autoRecall", "enabled"], Boolean(values.autoRecallEnabled), base.autoRecallEnabled);
      push(["autoRecall", "level"], clampInt(values.recallLevel, 0, 2, 1), base.recallLevel);
      push(["compaction", "memorize"], Boolean(values.compactMemorize), base.compactMemorize);
      push(["idle", "enabled"], Boolean(values.idleEnabled), base.idleEnabled);
      push(["idle", "idleMinutes"], clampInt(values.idleMinutes, 1, 10080, 180), base.idleMinutes);
      push(["idle", "maxIdleMinutes"], clampInt(Number(values.idleMaxHours) * 60, 1, 10080, 720), Math.round(base.idleMaxHours * 60));
      push(["idle", "checkMinutes"], clampInt(values.idleCheckMinutes, 1, 1440, 15), base.idleCheckMinutes);
      push(["maintenance", "provider"], String(values.maintenanceProvider ?? "").trim(), base.maintenanceProvider);
      push(["maintenance", "model"], String(values.maintenanceModel ?? "").trim(), base.maintenanceModel);
      push(["maintenance", "maxTokens"], clampInt(values.maintenanceMaxTokens, 1000, 1000000, 100000), base.maintenanceMaxTokens);
      push(["diary", "maxChars"], clampInt(values.diaryMaxChars, 100, 100000, 8000), base.diaryMaxChars);
      return ops;
    }

    function clampInt(value, min, max, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.round(number)));
    }

    function clampThreshold(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return DEFAULTS.threshold;
      return Math.min(0.95, Math.max(0.01, Math.round(number * 100) / 100));
    }

    /**
     * 在宿主 describe 镜像里定位本插件的配置。
     * 命名空间是 profile 条目 id（patch id，例如 "hdm"），不是完整 entry id（"include:hdm"），
     * 也不是包名；镜像还没加载时返回 undefined，调用方保持 loading 等下一次镜像更新。
     */
    function pickRow(view) {
      const rows = Array.isArray(view?.namespaces) ? view.namespaces : [];
      for (const ns of NS_CANDIDATES) {
        const row = rows.find((candidate) => candidate?.ns === ns);
        if (row) return row;
      }
      return rows.find((row) => {
        const value = row?.value;
        return value !== null && typeof value === "object" && "homeDir" in value && "save" in value;
      });
    }

    /** configForms 模型：读走宿主的 describe 镜像（唯一事实来源），写走 form.mutate 的写入队列。 */
    function configFormsModel(configForms) {
      const mirror = configForms.describe?.();
      if (!mirror || typeof mirror.getSnapshot !== "function" || typeof mirror.subscribe !== "function") return null;
      let form = null;
      let formNs = null;
      // useSyncExternalStore 要求 getSnapshot 在数据不变时返回同一引用，否则会无限重渲染。
      let cachedStore = null;
      let cachedSnapshot = { status: "loading", value: undefined, writable: false };
      const formFor = (ns) => {
        if (form !== null && formNs === ns) return form;
        form = typeof configForms.get === "function" ? configForms.get(ns) : null;
        formNs = ns;
        return form;
      };
      const snapshot = () => {
        const store = mirror.getSnapshot();
        if (store === cachedStore) return cachedSnapshot;
        cachedStore = store;
        const view = store?.view;
        if (!view) {
          cachedSnapshot = { status: "loading", value: undefined, writable: false };
          return cachedSnapshot;
        }
        const row = pickRow(view);
        cachedSnapshot = row
          ? { status: "ready", value: row.value, writable: view.writable !== false, revision: row.revision, ns: row.ns }
          : {
              status: "unavailable",
              value: undefined,
              writable: view.writable !== false,
              available: (Array.isArray(view.namespaces) ? view.namespaces : []).map((item) => item?.ns).filter(Boolean),
            };
        return cachedSnapshot;
      };
      return {
        kind: "configForms",
        get namespace() {
          return snapshot().ns ?? NS_CANDIDATES[0];
        },
        subscribe(listener) {
          const off = mirror.subscribe(listener);
          return () => off?.();
        },
        snapshot,
        reload: () => mirror.ensure?.() ?? mirror.load?.(),
        async save(values, base) {
          const ops = buildOps(values, base);
          if (ops.length === 0) return { changed: 0 };
          const row = pickRow(mirror.getSnapshot()?.view);
          const target = formFor(row?.ns ?? NS_CANDIDATES[0]);
          if (!target || typeof target.mutate !== "function") throw new Error("设置服务不支持写入");
          const accepted = await target.mutate(ops);
          if (accepted === false) {
            throw new Error("宿主拒绝了这次保存（配置可能刚被别处改过），请点「重新读取」后重试。");
          }
          return { changed: ops.length };
        },
      };
    }

    /** remote.settings 模型：configForms 缺席时的退路，协议与宿主设置服务一致。 */
    function remoteModel(api) {
      let snapshot = { status: "loading", value: undefined, writable: false, revision: undefined, ns: undefined };
      const listeners = new Set();
      const publish = (next) => {
        snapshot = { ...snapshot, ...next };
        for (const listener of [...listeners]) listener();
      };
      let pending = null;
      const load = () => {
        if (pending !== null) return pending;
        pending = (async () => {
          try {
            const response = await api.describe();
            if (response && response.ok === false) {
              publish({ status: "unavailable", writable: false, error: response.error?.message });
              return;
            }
            const view = response?.ok === true ? response.value : response;
            const rows = Array.isArray(view?.namespaces) ? view.namespaces : [];
            const row =
              rows.find((candidate) => NS_CANDIDATES.includes(candidate?.ns)) ??
              rows.find((candidate) => {
                const value = candidate?.value;
                return value && typeof value === "object" && "homeDir" in value && "save" in value;
              });
            if (!row) {
              publish({ status: "unavailable", writable: view?.writable === true });
              return;
            }
            publish({
              status: "ready",
              value: row.value,
              writable: view?.writable !== false,
              revision: row.revision,
              ns: row.ns,
            });
          } catch (error) {
            publish({ status: "unavailable", writable: false, error: messageOf(error) });
          } finally {
            pending = null;
          }
        })();
        return pending;
      };
      void load();
      return {
        kind: "remote",
        namespace: undefined,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot: () => snapshot,
        reload: () => load(),
        async save(values, base) {
          const ops = buildOps(values, base);
          if (ops.length === 0) return { changed: 0 };
          if (typeof api.mutate !== "function") throw new Error("设置服务不支持写入");
          const result = await api.mutate(snapshot.ns ?? NS_CANDIDATES[0], ops, snapshot.revision);
          if (result && result.ok === false) {
            throw new Error(String(result.error?.message ?? "保存被拒绝"));
          }
          await load();
          return { changed: ops.length };
        },
      };
    }

    /** 远程面：设置页的「生成 IAM 模板」与「维护信息」。拿不到返回 null，页面降级为文字说明。 */
    function hdmRemoteApi(ctx) {
      const service = softService(ctx, "remote.hdmSettings") ?? softService(ctx, "remote.dsh-hdm");
      if (!service || typeof service !== "object") return null;
      return {
        generateIamBlank: typeof service.generateIamBlank === "function" ? service.generateIamBlank.bind(service) : null,
        maintenanceInfo: typeof service.maintenanceInfo === "function" ? service.maintenanceInfo.bind(service) : null,
      };
    }

    function createModel(ctx) {
      const hdm = hdmRemoteApi(ctx);
      const attach = (model) => (model ? Object.assign(model, { hdm }) : model);
      const configForms = softService(ctx, "configForms");
      if (configForms !== undefined && configForms !== null && typeof configForms.get === "function") {
        try {
          const model = configFormsModel(configForms);
          if (model) return attach(model);
        } catch (error) {
          console.warn("[hdm] configForms 不可用，改用 remote.settings：", error);
        }
      }
      const remote = softService(ctx, "remote");
      const api = remote?.settings;
      if (api !== undefined && api !== null && typeof api.describe === "function") {
        return attach(remoteModel(api));
      }
      return null;
    }

    function Toggle(props) {
      const on = Boolean(props.value);
      return h("button", {
        type: "button",
        className: "hdm-switch",
        role: "switch",
        "aria-checked": on,
        "aria-label": props.label,
        "data-on": on ? "true" : "false",
        disabled: Boolean(props.disabled),
        onClick: () => props.onChange(!on),
      });
    }

    function Row(props) {
      return h(
        "div",
        { className: `hdm-row${props.stack ? " hdm-stack" : ""}` },
        h(
          "div",
          { className: "hdm-text" },
          h("div", { className: "hdm-name" }, props.label),
          props.hint ? h("div", { className: "hdm-hint" }, props.hint) : null,
        ),
        props.children,
      );
    }

    function ReadonlyNotice(props) {
      return h(
        "div",
        { className: "hdm-page" },
        h("style", null, CSS),
        h("div", { className: "hdm-head" }, h("h2", { className: "hdm-title" }, "HDM 记忆")),
        h(
          "div",
          { className: "hdm-card" },
          h(
            "div",
            { className: "hdm-row hdm-stack" },
            h(
              "p",
              { className: "hdm-status" },
              props.reason ??
                "当前页面拿不到设置服务，无法读写配置。可以到 设置 → 插件 → dsh-hdm 的自动表单里修改同样的字段。",
            ),
            props.detail ? h("p", { className: "hdm-status error" }, props.detail) : null,
          ),
        ),
      );
    }

    function HdmForm(props) {
      const model = props.model;
      const subscribe = React.useCallback((listener) => model.subscribe(listener), [model]);
      const getSnapshot = React.useCallback(() => model.snapshot() ?? EMPTY_SNAPSHOT, [model]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [iamMessage, setIamMessage] = React.useState(null);
      const [iamBusy, setIamBusy] = React.useState(false);
      const [maintenance, setMaintenance] = React.useState(null);

      React.useEffect(() => {
        const api = model.hdm;
        if (!api || typeof api.maintenanceInfo !== "function") return undefined;
        let cancelled = false;
        void Promise.resolve(api.maintenanceInfo())
          .then((info) => {
            if (!cancelled) setMaintenance(info ?? null);
          })
          .catch(() => {
            if (!cancelled) setMaintenance(null);
          });
        return () => {
          cancelled = true;
        };
      }, [model]);

      const generateIam = async () => {
        const api = model.hdm;
        if (!api || typeof api.generateIamBlank !== "function") {
          setIamMessage({
            kind: "error",
            text: "拿不到宿主服务；插件启动时会自动生成 <母文件夹>/IAM_Blank.md，可直接去编辑。",
          });
          return;
        }
        setIamBusy(true);
        try {
          const result = await api.generateIamBlank(false);
          if (result && result.ok === false) throw new Error(result.error ?? "生成失败");
          setIamMessage({
            kind: "ok",
            text: `${result?.overwritten ? "已覆盖重建" : result?.existed ? "文件已存在，未覆盖" : "已生成"}：${result?.path ?? "IAM_Blank.md"}`,
          });
        } catch (error) {
          setIamMessage({ kind: "error", text: messageOf(error) });
        } finally {
          setIamBusy(false);
        }
      };

      const maintenanceText = (() => {
        if (!maintenance) return "维护信息：当前页面拿不到宿主服务（不影响已有记忆与定时维护）。";
        const modelText = maintenance.model ? `${maintenance.model.provider}/${maintenance.model.model}` : "无可用模型";
        const source =
          maintenance.source === "config" ? "设置里指定" : maintenance.source === "auto" ? "跟随默认" : "未找到";
        const today = maintenance.today ? `${maintenance.today.used}/${maintenance.today.budget || "∞"}` : "?";
        const window = `${maintenance.idle?.minMinutes ?? "?"}~${maintenance.idle?.maxMinutes ?? "?"}`;
        const last = Array.isArray(maintenance.runs) ? maintenance.runs[0] : null;
        return `生效模型：${modelText}（${source}）· 今日整理 ${today} 次 · 空闲窗口 ${window} 分钟${
          last ? ` · 最近：${last.result}${last.merged ? "（并入）" : ""}` : ""
        }`;
      })();

      const ready = snapshot.status === "ready" && snapshot.value !== undefined;
      const writable = ready && snapshot.writable !== false;
      const live = valuesOf(snapshot.value, snapshot.ns);
      const values = draft ?? live;
      const patch = (key, next) => setDraft((previous) => ({ ...(previous ?? values), [key]: next }));

      const save = async () => {
        if (!writable) return;
        const trimmed = String(values.homeDir ?? "").trim();
        if (!trimmed) {
          setMessage({ kind: "error", text: "母文件夹不能为空。" });
          return;
        }
        if (!/^(~|[A-Za-z]:[\\/]|[\\/])/.test(trimmed)) {
          setMessage({ kind: "error", text: "母文件夹要填绝对路径（例如 D:\\dsh-hdm）或以 ~ 开头。" });
          return;
        }
        setBusy(true);
        setMessage(null);
        try {
          const result = await model.save({ ...values, homeDir: trimmed }, live);
          setDraft(null);
          setMessage({
            kind: "ok",
            text:
              result.changed === 0
                ? "没有需要保存的改动。"
                : trimmed !== live.homeDir
                  ? "已保存。HDM 配置会重载，旧记忆会自动迁移到新的母文件夹。"
                  : "已保存。",
          });
          await model.reload?.();
        } catch (error) {
          setMessage({ kind: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      };

      const reset = () => {
        setDraft({ ...values, threshold: DEFAULTS.threshold, enabled: DEFAULTS.enabled, diaryEnabled: DEFAULTS.diaryEnabled, forgetEnabled: DEFAULTS.forgetEnabled, autoRecallEnabled: DEFAULTS.autoRecallEnabled, recallLevel: DEFAULTS.recallLevel, compactMemorize: DEFAULTS.compactMemorize, idleEnabled: DEFAULTS.idleEnabled, idleMinutes: DEFAULTS.idleMinutes, idleMaxHours: DEFAULTS.idleMaxHours, idleCheckMinutes: DEFAULTS.idleCheckMinutes, maintenanceMaxTokens: DEFAULTS.maintenanceMaxTokens, diaryMaxChars: DEFAULTS.diaryMaxChars });
        setMessage({ kind: "info", text: "已恢复默认开关、阈值与空闲整理参数（母文件夹与维护模型未改），点「保存」写入。" });
      };

      const reload = async () => {
        setDraft(null);
        setMessage(null);
        setBusy(true);
        try {
          await model.reload?.();
        } catch (error) {
          setMessage({ kind: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      };

      const status =
        message?.text ??
        (snapshot.status === "idle" || snapshot.status === "loading"
          ? "正在读取宿主配置…"
          : !ready
            ? `宿主没有为 HDM 提供可编辑的配置项（插件可能未启用）。可用配置项：${(snapshot.available ?? []).join("、") || "（无）"}`
            : !writable
              ? "当前连接为只读（只有本机连接可以修改设置）。"
              : "");

      return h(
        "div",
        { className: "hdm-page" },
        h("style", null, CSS),
        h(
          "div",
          { className: "hdm-head" },
          h("h2", { className: "hdm-title" }, "HDM 记忆"),
          h("p", { className: "hdm-sub" }, "长期记忆的存放位置与运行开关，改完点「保存」立即生效。"),
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            Row,
            { label: "母文件夹", hint: "记忆、日记、IAM 与人物档案的根目录，支持 ~。换目录保存后，旧数据会在 HDM 重载时自动迁移过去。", stack: true },
            h("input", {
              className: "hdm-input",
              value: values.homeDir,
              spellCheck: false,
              autoComplete: "off",
              disabled: !writable || busy,
              "aria-label": "母文件夹路径",
              onChange: (event) => patch("homeDir", event.target.value),
              onKeyDown: (event) => {
                if (event.key === "Enter" && writable && !busy) void save();
              },
            }),
          ),
          h(
            Row,
            { label: "总开关", hint: "关闭后 HDM 的工具、注入与定时维护全部停用。" },
            h(Toggle, {
              label: "总开关",
              value: values.enabled,
              disabled: !writable || busy,
              onChange: (next) => patch("enabled", next),
            }),
          ),
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            Row,
            { label: "保存触发阈值", hint: "上下文压力达到该比例时提醒保存，0.01 ~ 0.95。" },
            h(
              "div",
              { className: "hdm-range-cell" },
              h("input", {
                className: "hdm-range",
                type: "range",
                min: 0.01,
                max: 0.95,
                step: 0.01,
                value: values.threshold,
                disabled: !writable || busy,
                "aria-label": "保存触发阈值",
                onChange: (event) => patch("threshold", Number(event.target.value)),
              }),
              h("span", { className: "hdm-value" }, `${Math.round(values.threshold * 100)}%`),
            ),
          ),
          h(
            Row,
            { label: "日记", hint: "每天 23:30 汇总当日记忆；模型不可用时回退为摘要。" },
            h(Toggle, {
              label: "日记",
              value: values.diaryEnabled,
              disabled: !writable || busy,
              onChange: (next) => patch("diaryEnabled", next),
            }),
          ),
          h(
            Row,
            { label: "遗忘 / 顺序快照", hint: "第 2 天压缩为 L1、第 5 天压缩为 L0，永久豁免不受影响。" },
            h(Toggle, {
              label: "遗忘",
              value: values.forgetEnabled,
              disabled: !writable || busy,
              onChange: (next) => patch("forgetEnabled", next),
            }),
          ),
          h(
            Row,
            {
              label: "自动召回",
              hint: "L0 只给记忆词表、由模型自己决定何时检索；L1 用户回复时自动召回；L2 再加「为达成目标选方案」的时刻与子代理首步。",
              stack: true,
            },
            h(Toggle, {
              label: "自动召回",
              value: values.autoRecallEnabled,
              disabled: !writable || busy,
              onChange: (next) => patch("autoRecallEnabled", next),
            }),
            h(
              "div",
              { className: "hdm-range-cell" },
              h(
                "select",
                {
                  className: "hdm-input",
                  "aria-label": "检索档位",
                  value: String(values.recallLevel),
                  disabled: !writable || busy,
                  onChange: (event) => patch("recallLevel", Number(event.target.value)),
                },
                h("option", { value: "0" }, "L0 · 只给词表"),
                h("option", { value: "1" }, "L1 · 用户回复时"),
                h("option", { value: "2" }, "L2 · 加选方案与子代理"),
              ),
            ),
          ),
          h(
            Row,
            {
              label: "压缩前记忆",
              hint: "执行 /compact 前先用维护模型把这段对话存成一条记忆，压缩完成后连同 IAM 交回下一步。",
            },
            h(Toggle, {
              label: "压缩前记忆",
              value: values.compactMemorize,
              disabled: !writable || busy,
              onChange: (next) => patch("compactMemorize", next),
            }),
          ),
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            Row,
            { label: "IAM 空白模板", hint: "生成 <母文件夹>/IAM_Blank.md：固定标题齐全、正文留空。它是独立文件，不会被并入 IAM.md，也不参与注入。" },
            h(
              "button",
              { type: "button", className: "hdm-btn", disabled: iamBusy, onClick: () => void generateIam() },
              iamBusy ? "生成中…" : "生成模板",
            ),
          ),
          iamMessage
            ? h(
                "p",
                { className: `hdm-status${iamMessage.kind === "ok" ? " ok" : " error"}` },
                iamMessage.text,
              )
            : null,
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            Row,
            {
              label: "空闲自动整理",
              hint: "对话空闲后把新增内容整理成一条记忆，此后沿用同一编码；没有新的用户对话就不会再次整理。",
            },
            h(Toggle, {
              label: "空闲自动整理",
              value: values.idleEnabled,
              disabled: !writable || busy,
              onChange: (next) => patch("idleEnabled", next),
            }),
          ),
          h(
            Row,
            { label: "空闲下限（分钟）", hint: "低于该时长不整理；默认 180（3 小时）。" },
            h(
              "div",
              { className: "hdm-num" },
              h("input", {
                className: "hdm-input",
                type: "number",
                min: 1,
                max: 10080,
                step: 1,
                value: values.idleMinutes,
                disabled: !writable || busy,
                "aria-label": "空闲下限分钟",
                onChange: (event) => patch("idleMinutes", Number(event.target.value)),
              }),
              h("span", { className: "hdm-value" }, "分"),
            ),
          ),
          h(
            Row,
            { label: "空闲上限（小时）", hint: "达到该时长视为陈旧、不再整理；默认 12 小时，需大于下限。" },
            h(
              "div",
              { className: "hdm-num" },
              h("input", {
                className: "hdm-input",
                type: "number",
                min: 0.5,
                max: 168,
                step: 0.5,
                value: values.idleMaxHours,
                disabled: !writable || busy,
                "aria-label": "空闲上限小时",
                onChange: (event) => patch("idleMaxHours", Number(event.target.value)),
              }),
              h("span", { className: "hdm-value" }, "时"),
            ),
          ),
          h(
            Row,
            { label: "扫描间隔（分钟）", hint: "只决定多久检查一次，不影响整理门槛；默认 15。" },
            h(
              "div",
              { className: "hdm-num" },
              h("input", {
                className: "hdm-input",
                type: "number",
                min: 1,
                max: 1440,
                step: 1,
                value: values.idleCheckMinutes,
                disabled: !writable || busy,
                "aria-label": "扫描间隔分钟",
                onChange: (event) => patch("idleCheckMinutes", Number(event.target.value)),
              }),
              h("span", { className: "hdm-value" }, "分"),
            ),
          ),
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            Row,
            { label: "维护模型 provider", hint: "留空 = 跟随当前会话默认模型；填了就固定用它跑日记、遗忘与空闲整理。" },
            h("input", {
              className: "hdm-input",
              value: values.maintenanceProvider,
              spellCheck: false,
              placeholder: "例如 deepseek",
              disabled: !writable || busy,
              "aria-label": "维护模型 provider",
              onChange: (event) => patch("maintenanceProvider", event.target.value),
            }),
          ),
          h(
            Row,
            { label: "维护模型 model", hint: "provider 与 model 要么都填，要么都留空。" },
            h("input", {
              className: "hdm-input",
              value: values.maintenanceModel,
              spellCheck: false,
              placeholder: "例如 deepseek-chat",
              disabled: !writable || busy,
              "aria-label": "维护模型 model",
              onChange: (event) => patch("maintenanceModel", event.target.value),
            }),
          ),
          h("p", { className: "hdm-note", "data-hdm-maintenance": maintenance ? "ready" : "missing" }, maintenanceText),
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            Row,
            { label: "记忆维护预算（token）", hint: "后台整理、日记与遗忘压缩单次可用的输出预算；默认 100000。" },
            h(
              "div",
              { className: "hdm-num" },
              h("input", {
                className: "hdm-input",
                type: "number",
                min: 1000,
                max: 1000000,
                step: 1000,
                value: values.maintenanceMaxTokens,
                disabled: !writable || busy,
                "aria-label": "维护 token 预算",
                onChange: (event) => patch("maintenanceMaxTokens", Number(event.target.value)),
              }),
              h("span", { className: "hdm-value" }, "tok"),
            ),
          ),
          h(
            Row,
            { label: "日记字数上限", hint: "日记正文的长度上限，默认 8000 字；调大预算只会让它更容易写满。" },
            h(
              "div",
              { className: "hdm-num" },
              h("input", {
                className: "hdm-input",
                type: "number",
                min: 100,
                max: 100000,
                step: 100,
                value: values.diaryMaxChars,
                disabled: !writable || busy,
                "aria-label": "日记字数上限",
                onChange: (event) => patch("diaryMaxChars", Number(event.target.value)),
              }),
              h("span", { className: "hdm-value" }, "字"),
            ),
          ),
          h(
            "p",
            { className: "hdm-note" },
            "预算是上限：宿主会按模型上下文窗口自动下压，填大了不会报错，只是用不到那么多；日记实际长度仍受字数上限约束。",
          ),
        ),
        h(
          "div",
          { className: "hdm-card" },
          h(
            "div",
            { className: "hdm-row hdm-stack" },
            h(
              "div",
              { className: "hdm-text" },
              h("div", { className: "hdm-name" }, "整理策略"),
              h("ul", { className: "hdm-list" },
                h("li", null, "只在「有新的真实用户发言」且空闲时长落在窗口内时整理；没有新对话不会重复整理。"),
                h("li", null, "一次整理只写目标记忆单元自己的文件，不碰 IAM、人物档案与其他记忆。"),
                h("li", null, "整理成功后本会话固定到该编码；之后保存都续写它，派生过的会先重开 L2。"),
                h("li", null, "失败不重试，结果写进 state/logs/maintenance.jsonl；今日次数与最近运行见上一张卡。"),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "hdm-actions" },
          h(
            "button",
            { type: "button", className: "hdm-btn primary", disabled: !writable || busy, onClick: () => void save() },
            busy ? "保存中…" : "保存",
          ),
          h("button", { type: "button", className: "hdm-btn", disabled: busy, onClick: () => void reload() }, "重新读取"),
          h("button", { type: "button", className: "hdm-btn", disabled: !writable || busy, onClick: reset }, "恢复默认"),
          status
            ? h(
                "p",
                {
                  className: `hdm-status${message?.kind === "ok" ? " ok" : message?.kind === "error" ? " error" : ""}`,
                  "data-hdm-status": message?.kind ?? snapshot.status,
                },
                status,
              )
            : null,
        ),
        h(
          "p",
          { className: "hdm-note" },
          `数据通道：${model.kind === "configForms" ? "configForms" : "remote.settings"} · 配置项 ${snapshot.ns ?? model.namespace ?? NS_CANDIDATES[0]}；其余高级项见 设置 → 插件 → dsh-hdm。`,
        ),
      );
    }

    /** 页面外壳：先解析数据模型；服务晚到时有限次重试，避免启动顺序把页面永久锁成只读。 */
    function HdmSection(props) {
      const [model, setModel] = React.useState(() => props.getModel());
      React.useEffect(() => {
        if (model) return undefined;
        let attempts = 0;
        const timer = setInterval(() => {
          attempts += 1;
          const next = props.getModel();
          if (next) {
            clearInterval(timer);
            setModel(next);
          } else if (attempts >= 50) {
            clearInterval(timer);
          }
        }, 400);
        return () => clearInterval(timer);
      }, [model]);
      if (!model) return h(ReadonlyNotice, {});
      return h(HdmForm, { model });
    }

    function pageFor(ctx) {
      const getModel = () => createModel(ctx);
      return (ownerProps) => h(PageBoundary, null, h(HdmSection, { getModel, ...(ownerProps ?? {}) }));
    }

    // 页面级错误兜底：任何渲染错误都显示文字，避免整块空白。
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        try {
          console.warn("[hdm] settings page crashed:", error);
        } catch {
          /* ignore */
        }
      }
      render() {
        if (this.state.error) {
          return h(
            "div",
            { className: "hdm-page" },
            h("style", null, CSS),
            h("h2", { className: "hdm-title" }, "HDM 记忆"),
            h("p", { className: "hdm-status error" }, `设置页渲染失败：${messageOf(this.state.error)}`),
          );
        }
        return this.props.children;
      }
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // 远程面：先挂描述符，页面才能 ctx.get('remote.hdmSettings')。拿不到就降级，不抛错。
        try {
          const remote = softService(ctx, "remote");
          if (remote && typeof remote.$mount === "function") {
            const mounted = remote.$mount(HDM_REMOTE);
            if (mounted && typeof mounted.catch === "function") {
              mounted.catch((error) => console.warn("[hdm] 远程面挂载失败：", error));
            }
          }
        } catch (error) {
          console.warn("[hdm] 远程面不可用，设置页降级：", error);
        }
        const Page = pageFor(ctx);
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: "hdm",
              order: 40,
              label: () => "HDM 记忆",
              inject: () => ({}),
            },
            Page,
          ),
        );
      },
    };
  },
});

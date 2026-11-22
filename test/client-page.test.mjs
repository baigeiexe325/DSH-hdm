// HDM 设置页（Client 半）的渲染与交互测试。
// 用最小 React 运行时执行真实的 lib/client.js：验证数据通道、控件可用性、开关/滑块/母文件夹的写入路径。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const CLIENT = path.join(import.meta.dirname, "..", "lib", "client.js");

/* ---------------------------------------------------------------- 迷你 React */

const voidTags = new Set(["input", "br", "hr", "img", "meta", "link"]);

function makeRuntime() {
  let current = null;
  let instances = new Map();
  let failure = null;
  const subscriptions = [];

  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
    }
  }
  Component.prototype.isReactComponent = {};

  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    Component,
    useState(initial) {
      const inst = current;
      const index = inst.index++;
      if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        inst.hooks[index] = typeof next === "function" ? next(inst.hooks[index]) : next;
      };
      return [inst.hooks[index], set];
    },
    useCallback(fn) {
      current.index++;
      return fn;
    },
    useEffect(effect) {
      const inst = current;
      inst.index++;
      inst.effects.push(effect);
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      current.index++;
      subscriptions.push(subscribe);
      return getSnapshot();
    },
    useRef(value) {
      const inst = current;
      const index = inst.index++;
      if (!(index in inst.hooks)) inst.hooks[index] = { current: value };
      return inst.hooks[index];
    },
  };

  function instanceFor(key) {
    let inst = instances.get(key);
    if (!inst) {
      inst = { hooks: [], effects: [], index: 0 };
      instances.set(key, inst);
    }
    inst.index = 0;
    return inst;
  }

  function render(node, key) {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === "string" || typeof node === "number") return { text: String(node) };
    if (Array.isArray(node)) return node.map((child, index) => render(child, `${key}.${index}`)).filter(Boolean);
    if (typeof node.type === "function") {
      if (node.type.prototype && node.type.prototype.isReactComponent) {
        let inst = instances.get(`${key}#class`);
        if (!inst) {
          inst = new node.type(node.props);
          instances.set(`${key}#class`, inst);
        }
        try {
          return render(inst.render(), `${key}#out`);
        } catch (thrown) {
          failure = thrown;
          return null;
        }
      }
      const inst = instanceFor(`${key}#${node.type.name || "anon"}`);
      const previous = current;
      current = inst;
      inst.effects = [];
      let out;
      try {
        out = node.type(node.props);
      } catch (thrown) {
        failure = thrown;
        current = previous;
        return null;
      }
      const effects = inst.effects;
      current = previous;
      const rendered = render(out, `${key}#out`);
      for (const effect of effects) effect();
      return rendered;
    }
    const children = [node.props?.children].flat(Infinity).map((child, index) => render(child, `${key}/${index}`));
    return { tag: node.type, props: node.props ?? {}, children: children.filter(Boolean) };
  }

  function escape(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function html(node) {
    if (!node) return "";
    if ("text" in node) return escape(node.text);
    if (!node.tag) return node.children.map(html).join("");
    if (node.tag === "style") return `<style>${node.children.map((child) => child.text ?? "").join("")}</style>`;
    const attrs = Object.entries(node.props)
      .filter(([name, value]) => {
        if (name === "children" || name === "key" || value === undefined || value === null) return false;
        if (value === false) return /^(aria-|data-)/.test(name);
        return true;
      })
      .map(([name, value]) => ` ${name === "className" ? "class" : name}="${escape(name === "disabled" && value === true ? "" : String(value))}"`)
      .join("");
    const inner = node.children.map(html).join("");
    if (voidTags.has(node.tag)) return `<${node.tag}${attrs}>`;
    return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
  }

  function find(node, predicate) {
    if (!node || !("tag" in node)) return undefined;
    if (predicate(node)) return node;
    for (const child of node.children) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return undefined;
  }

  return {
    React,
    render: (element) => render(element, "root"),
    html,
    find,
    subscriptions,
    getFailure: () => failure,
    reset() {
      instances = new Map();
      failure = null;
      subscriptions.length = 0;
    },
  };
}

/* ------------------------------------------------------------ 加载真实客户端 */

async function loadClient(services, runtime) {
  const source = await readFile(CLIENT, "utf8");
  const definitions = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => definitions.push(definition) } },
    console,
    // 测试里不保留真实定时器：页面用轮询等待迟到的服务，断言只关心渲染结果。
    setInterval: () => 0,
    clearInterval: () => {},
  };
  sandbox.require = (id) => {
    if (id === "react") return runtime.React;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  };
  vm.runInContext(source, vm.createContext(sandbox), { filename: CLIENT });
  assert.equal(definitions.length, 1, "客户端模块应注册一次");
  const definition = definitions[0];
  assert.equal(definition.id, "dsh-hdm", "factory id 必须等于包名");

  let registered = null;
  const module = definition.factory(sandbox.require);
  const ctx = {
    get: (name) => services[name],
    slots: {
      inject(_key, callback) {
        return callback();
      },
      register(options, component) {
        registered = { options, component };
        return () => {};
      },
    },
  };
  module.apply(ctx);
  assert.ok(registered, "应注册 settings.section 条目");
  return { module, registered };
}

/**
 * 模拟宿主 ui-settings：describe 镜像是读的唯一来源，写走 form.mutate。
 * state.view === undefined 表示镜像还没加载完。
 */
function fakeConfigForms(state) {
  const listeners = new Set();
  const form = {
    getSnapshot: () => ({ status: "ready", value: state.view?.namespaces?.[0]?.value, writable: true, revision: 3 }),
    subscribe: () => () => {},
    mutate: async (ops) => {
      state.ops = ops;
      return true;
    },
  };
  const mirror = {
    getSnapshot: () => ({ status: state.view ? "ready" : "loading", view: state.view }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: () => {},
    load: () => {},
  };
  return {
    describe: () => mirror,
    get(ns) {
      assert.equal(ns, "hdm", "命名空间应是 profile 条目 id（patch id），不是 include:hdm");
      return form;
    },
    publish() {
      for (const listener of [...listeners]) listener();
    },
  };
}

const readyView = (value) => ({
  writable: true,
  namespaces: [
    { ns: "hdm", value, revision: 3 },
    { ns: "other", value: {}, revision: 1 },
  ],
});

const readyValue = {
  homeDir: "C:\\Users\\tester\\.dsh-hdm",
  enabled: true,
  save: { threshold: 0.5 },
  diary: { enabled: true },
  forget: { enabled: true },
  autoRecall: { enabled: true },
  maintenance: { maxTokens: 100000 },
};

/* ------------------------------------------------------------------ 测试用例 */

test("注册 settings.section 条目并带 owner inject", async () => {
  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const { registered } = await loadClient({ configForms: fakeConfigForms(state) }, runtime);
  assert.equal(registered.options.name, "settings.section");
  assert.equal(registered.options.id, "hdm");
  assert.equal(registered.options.order, 40);
  assert.equal(typeof registered.options.label, "function");
  assert.equal(registered.options.label(), "HDM 记忆");
  assert.equal(Object.keys(registered.options.inject()).length, 0);
});

test("配置就绪后控件可用：母文件夹输入、滑块、开关都不是 disabled", async () => {
  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const { registered } = await loadClient({ configForms: fakeConfigForms(state) }, runtime);
  const markup = runtime.html(runtime.render(registered.component({ close() {} })));

  assert.equal(runtime.getFailure(), null);
  assert.match(markup, /<h2 class="hdm-title">HDM 记忆<\/h2>/);
  assert.match(markup, /<input(?![^>]*disabled)[^>]*aria-label="母文件夹路径"/, "母文件夹输入框必须可编辑");
  assert.match(markup, /<input(?![^>]*disabled)[^>]*type="range"/, "阈值滑块必须可用");
  assert.match(markup, /<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*aria-label="总开关"/);
  assert.match(markup, />50%</, "滑块应显示百分比");
  assert.match(markup, /数据通道：configForms/);
});

test("描述镜像晚一步到达时页面会订阅（回归：只读一次导致全部禁用）", async () => {
  const runtime = makeRuntime();
  const state = { view: undefined };
  const configForms = fakeConfigForms(state);
  const { registered } = await loadClient({ configForms }, runtime);

  const loadingTree = runtime.render(registered.component({}));
  const loadingMarkup = runtime.html(loadingTree);
  assert.match(loadingMarkup, /正在读取宿主配置/);
  assert.match(loadingMarkup, /type="range"[^>]*disabled/, "加载中滑块应暂时禁用");
  assert.equal(runtime.subscriptions.length, 1, "必须订阅 describe 镜像，才能在就绪后解锁");

  state.view = readyView(readyValue);
  configForms.publish();
  runtime.reset();
  const readyMarkup = runtime.html(runtime.render(registered.component({})));
  assert.match(readyMarkup, /<input(?![^>]*disabled)[^>]*type="range"/, "快照就绪后滑块必须恢复可用");
  assert.match(readyMarkup, /C:\\Users\\tester\\\.dsh-hdm/);
});

test("预算卡：维护 token 预算与日记字数上限可编辑，保存只提交改动项", async () => {
  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const configForms = fakeConfigForms(state);
  const { registered } = await loadClient({ configForms }, runtime);

  const first = runtime.render(registered.component({}));
  const markup = runtime.html(first);
  assert.match(markup, /<input(?![^>]*disabled)[^>]*aria-label="维护 token 预算"/, "预算输入必须可编辑");
  assert.match(markup, /<input(?![^>]*disabled)[^>]*aria-label="日记字数上限"/, "日记字数上限必须可编辑");
  assert.match(markup, /记忆维护预算/);
  assert.match(markup, /100000/, "快照里的预算要显示出来");

  const budget = runtime.find(first, (node) => node.props?.["aria-label"] === "维护 token 预算");
  assert.ok(budget, "应找到维护预算输入");
  assert.equal(budget.props.value, 100000);
  budget.props.onChange({ target: { value: "200000" } });

  const second = runtime.render(registered.component({}));
  const saveButton = runtime.find(second, (node) => node.props?.className === "hdm-btn primary");
  assert.ok(saveButton, "应找到保存按钮");
  await saveButton.props.onClick();

  const ops = state.ops ?? [];
  const byPath = new Map(ops.map((op) => [op.path.join("."), op.value]));
  assert.equal(byPath.get("maintenance.maxTokens"), 200000, "预算改动应写到 maintenance.maxTokens");
  assert.ok(!byPath.has("diary.maxChars"), "没改的日记字数上限不应写入");
  assert.ok(!byPath.has("maintenance.provider"), "未改动字段不应写入");
});

test("点击开关、拖动滑块、改母文件夹后保存，提交的是嵌套路径且只含改动", async () => {

  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const configForms = fakeConfigForms(state);
  const { registered } = await loadClient({ configForms }, runtime);

  const first = runtime.render(registered.component({}));
  const forgetSwitch = runtime.find(first, (node) => node.props?.role === "switch" && node.props?.["aria-label"] === "遗忘");
  assert.ok(forgetSwitch, "应找到「遗忘」开关");
  assert.equal(forgetSwitch.props["aria-checked"], true);
  forgetSwitch.props.onClick();

  const slider = runtime.find(first, (node) => node.props?.type === "range");
  assert.ok(slider, "应找到阈值滑块");
  slider.props.onChange({ target: { value: "0.72" } });

  const homeInput = runtime.find(first, (node) => node.props?.["aria-label"] === "母文件夹路径");
  assert.ok(homeInput, "应找到母文件夹输入框");
  homeInput.props.onChange({ target: { value: "D:\\dsh-hdm" } });

  const second = runtime.render(registered.component({}));
  const edited = runtime.html(second);
  assert.match(edited, /aria-label="遗忘"[^>]*data-on="false"|data-on="false"[^>]*aria-label="遗忘"/, "开关点击后应关闭");
  assert.match(edited, />72%</, "滑块拖动后应显示 72%");

  const saveButton = runtime.find(second, (node) => node.props?.className === "hdm-btn primary");
  assert.ok(saveButton, "应找到保存按钮");
  assert.equal(saveButton.props.disabled, false);
  await saveButton.props.onClick();

  const ops = state.ops ?? [];
  assert.ok(ops.length > 0, "保存应向宿主提交字段操作");
  const byPath = new Map(ops.map((op) => [op.path.join("."), op.value]));
  assert.equal(byPath.get("forget.enabled"), false);
  assert.equal(byPath.get("save.threshold"), 0.72);
  assert.equal(byPath.get("homeDir"), "D:\\dsh-hdm");
  assert.ok(!byPath.has("enabled"), "未改动字段不应写入");
});

test("configForms 缺席时退回 remote.settings，仍可读写", async () => {
  const runtime = makeRuntime();
  const mutations = [];
  const remote = {
    settings: {
      describe: async () => ({
        ok: true,
        value: { writable: true, namespaces: [{ ns: "include:hdm", value: readyValue, revision: 7 }] },
      }),
      mutate: async (ns, ops, revision) => {
        mutations.push({ ns, ops, revision });
        return { ok: true, value: { ns, revision: 8 } };
      },
    },
  };
  const { registered } = await loadClient({ remote }, runtime);

  let warm = runtime.render(registered.component({}));
  for (let index = 0; index < 8 && !/C:\\Users\\tester/.test(runtime.html(warm)); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    warm = runtime.render(registered.component({}));
  }
  const markup = runtime.html(warm);
  assert.match(markup, /数据通道：remote\.settings/);
  assert.match(markup, /<input(?![^>]*disabled)[^>]*type="range"/);

  const diary = runtime.find(warm, (node) => node.props?.role === "switch" && node.props?.["aria-label"] === "日记");
  assert.ok(diary, "应找到日记开关");
  diary.props.onClick();

  const afterEdit = runtime.render(registered.component({}));
  const saveButton = runtime.find(afterEdit, (node) => node.props?.className === "hdm-btn primary");
  assert.ok(saveButton, "应找到保存按钮");
  await saveButton.props.onClick();
  assert.equal(mutations.length, 1, "保存应走 remote.settings.mutate");
  assert.equal(mutations[0].ns, "include:hdm");
  assert.equal(mutations[0].revision, 7);
  assert.ok(mutations[0].ops.some((op) => op.path.join(".") === "diary.enabled" && op.value === false));
});

test("两边都没有设置服务时给出可读的只读说明而不是空白", async () => {
  const runtime = makeRuntime();
  const { registered } = await loadClient({}, runtime);
  const markup = runtime.html(runtime.render(registered.component({})));
  assert.equal(runtime.getFailure(), null);
  assert.match(markup, /HDM 记忆/);
  assert.match(markup, /拿不到设置服务/);
});

test("样式包含开关、滑块的布局规则并引用主题变量", async () => {
  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const { registered } = await loadClient({ configForms: fakeConfigForms(state) }, runtime);
  const markup = runtime.html(runtime.render(registered.component({})));
  assert.match(markup, /\.hdm-switch\[data-on="true"\]/);
  assert.match(markup, /\.hdm-range\{/);
  assert.match(markup, /\.hdm-row\{display:grid/);
  assert.match(markup, /var\(--dsw-alias-brand-primary\)/);
});

test("检索档位下拉可改并提交 autoRecall.level；压缩前记忆开关提交 compaction.memorize", async () => {
  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const configForms = fakeConfigForms(state);
  const { registered } = await loadClient({ configForms }, runtime);

  const first = runtime.render(registered.component({}));
  const select = runtime.find(first, (node) => node.props?.["aria-label"] === "检索档位");
  assert.ok(select, "应找到检索档位下拉");
  assert.equal(select.props.value, "1", "默认档位是 L1");
  select.props.onChange({ target: { value: "2" } });

  const compact = runtime.find(first, (node) => node.props?.role === "switch" && node.props?.["aria-label"] === "压缩前记忆");
  assert.ok(compact, "应找到压缩前记忆开关");
  assert.equal(compact.props["aria-checked"], true);
  compact.props.onClick();

  const second = runtime.render(registered.component({}));
  const saveButton = runtime.find(second, (node) => node.props?.className === "hdm-btn primary");
  await saveButton.props.onClick();

  const byPath = new Map((state.ops ?? []).map((op) => [op.path.join("."), op.value]));
  assert.equal(byPath.get("autoRecall.level"), 2);
  assert.equal(byPath.get("compaction.memorize"), false);
  assert.ok(!byPath.has("autoRecall.enabled"), "未改动的召回总开关不应写入");
});

test("跨会话共享下拉可改并提交 sharing.level（同步打开 sharing.enabled）", async () => {
  const runtime = makeRuntime();
  const state = { view: readyView(readyValue) };
  const configForms = fakeConfigForms(state);
  const { registered } = await loadClient({ configForms }, runtime);

  const first = runtime.render(registered.component({}));
  const select = runtime.find(first, (node) => node.props?.["aria-label"] === "跨会话共享");
  assert.ok(select, "应找到跨会话共享下拉");
  assert.equal(select.props.value, "0", "默认关闭");
  select.props.onChange({ target: { value: "2" } });

  const second = runtime.render(registered.component({}));
  const saveButton = runtime.find(second, (node) => node.props?.className === "hdm-btn primary");
  await saveButton.props.onClick();

  const byPath = new Map((state.ops ?? []).map((op) => [op.path.join("."), op.value]));
  assert.equal(byPath.get("sharing.level"), 2);
  assert.equal(byPath.get("sharing.enabled"), true);
});

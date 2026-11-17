const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function fixture(initial = {}) {
  const values = new Map(Object.entries(initial)), listeners = new Map();
  const state = { fail: false, writes: 0 };
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (state.fail) throw Error("storage unavailable"); state.writes++; values.set(key, value); } };
  const window = {
    addEventListener: (name, fn) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatchEvent: event => { for (const listener of listeners.get(event.type) ?? []) listener(event); },
  };
  const load = (file, deps = {}) => {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, require: name => deps[name] ?? {}, structuredClone, Event, window, localStorage: storage });
    return exports;
  };
  const plan = load("chat-reply-plan.ts"), style = load("chat-response-style.ts", { "./chat-reply-plan": plan });
  const menu = load("response-style-menu.ts", { "./chat-response-style": style });
  return { ...style, menu, load, values, window, state, listeners, plan };
}
const plain = value => JSON.parse(JSON.stringify(value));
const context = { provider: "cpa/one", model: "cpa/one/deepseek-flash", chat: "chat-one" };

test("response styles migrate legacy picks and explicit defaults override DeepSeek heuristics", () => {
  const old = fixture({ "coding-tools:ao:chat-style": "focus" });
  assert.equal(old.resolveResponseStyle(old.readResponseStyles(), context).style, "focus");
  const f = fixture();
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), context).style, "deepseek");
  f.saveResponseStyle("global", {}, "transcript");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), context).style, "transcript");
  f.saveResponseStyle("global", {}, "deepseek");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), { model: "gpt" }).style, "deepseek");
  f.saveResponseStyle("global", {}, "auto");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), { model: "gpt" }).style, "transcript");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), context).style, "deepseek");
});

test("chat, exact model, provider and global rules resolve in order, and reset reveals inheritance", () => {
  const f = fixture();
  for (const [scope, value] of [["global", "focus"], ["provider", "plan"], ["model", "timeline"], ["chat", "cascade"]]) f.saveResponseStyle(scope, context, value);
  const resolve = at => plain(f.resolveResponseStyle(f.readResponseStyles(), at));
  assert.equal(resolve(context).style, "cascade");
  f.saveResponseStyle("global", {}, "deepseek");
  assert.equal(resolve(context).style, "cascade", "a global change never clears a chat override");
  for (const [scope, source, style] of [["chat", "model", "timeline"], ["model", "provider", "plan"], ["provider", "global", "deepseek"]]) {
    f.saveResponseStyle(scope, context, null);
    assert.deepEqual(resolve(context), { style, choice: style, source });
  }
});

test("provider and exact model identities never leak to another provider or model", () => {
  const f = fixture();
  const route = { harness_id: "ao:pi", provider_id: "proxy", model: "cpa/one/model" };
  assert.deepEqual(plain(f.responseStyleContext(route)), { provider: "cpa/one", model: "cpa/one/model" });
  assert.equal(f.responseStyleContext({ model: "cpa/model" }).provider, undefined, "unknown CPA source cannot become a wildcard provider");
  assert.equal(f.responseStyleContext({ model: "cpa/model" }, undefined, "two").provider, "cpa/two");
  f.saveResponseStyle("global", {}, "transcript");
  f.saveResponseStyle("provider", context, "deepseek");
  f.saveResponseStyle("model", context, "focus");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), { ...context, chat: "other", model: "another" }).style, "deepseek");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), { ...context, chat: "other", provider: "cpa/two" }).style, "transcript");
  assert.throws(() => f.saveResponseStyle("model", { model: "missing-provider" }, "focus"), /Choose a provider and model/);
});

test("local and cross-window preference updates notify every mounted subscriber and clean up", () => {
  const f = fixture(), first = [], second = [];
  const offOne = f.onResponseStyles(p => first.push(f.resolveResponseStyle(p, context).style));
  const offTwo = f.onResponseStyles(p => second.push(f.resolveResponseStyle(p, context).style));
  f.saveResponseStyle("global", {}, "focus");
  assert.deepEqual(first, ["focus"]); assert.deepEqual(second, ["focus"]);
  f.values.set(f.RESPONSE_STYLE_KEY, JSON.stringify({ version: 1, global: "timeline", providers: {}, models: {}, chats: {} }));
  f.window.dispatchEvent({ type: "storage", key: f.RESPONSE_STYLE_KEY });
  assert.deepEqual(first, ["focus", "timeline"]); assert.deepEqual(second, ["focus", "timeline"]);
  offOne(); offTwo();
  assert.ok([...f.listeners.values()].every(set => set.size === 0));
});

test("unavailable storage keeps a clearly non-persisted session preference; malformed data is safe", () => {
  const f = fixture(); f.state.fail = true;
  assert.equal(f.saveResponseStyle("global", {}, "focus").persisted, false);
  assert.equal(f.readResponseStyles().global, "focus");
  for (const value of ["broken", "[]", '{"version":2,"global":"focus"}', '{"version":1,"global":"bogus","providers":{"x":"bad"}}']) {
    const bad = fixture({ [f.RESPONSE_STYLE_KEY]: value });
    assert.equal(bad.resolveResponseStyle(bad.readResponseStyles(), { model: "gpt" }).style, "transcript");
  }
  assert.throws(() => f.saveResponseStyle("global", {}, "invalid"), /Unknown response style/);
});

test("the Response style menu chooses an explicit scope, preserves route and exposes settings", () => {
  const f = fixture(), picked = [];
  let opened = false;
  const before = JSON.stringify(context);
  const menu = f.menu.responseStyleMenu(f.readResponseStyles(), context, (...args) => picked.push(args), () => { opened = true; });
  assert.equal(menu.label, "Response style");
  for (const [name, scope] of [["This chat", "chat"], ["This model", "model"], ["All models from", "provider"], ["Global default", "global"]]) {
    menu.items.find(item => item.label?.startsWith(name)).items.find(item => item.label === "DeepSeek").run();
    assert.deepEqual(picked.at(-1), [scope, "deepseek"]);
  }
  menu.items.find(item => item.label === "Response style settings…").run();
  assert.equal(opened, true); assert.equal(JSON.stringify(context), before);
  const missing = f.menu.responseStyleMenu(f.readResponseStyles(), {}, () => {}, () => {});
  assert.equal(missing.items[1].items, undefined);
  assert.match(missing.items[1].reason, /not available/);
});

test("explicit Automatic inherits model defaults, and resets never revive a migrated global pick", () => {
  const f = fixture({ "coding-tools:ao:chat-style": "focus" });
  f.saveResponseStyle("provider", context, "cascade");
  f.saveResponseStyle("model", context, "auto");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), context).style, "deepseek");
  f.saveResponseStyle("model", context, null);
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), context).style, "cascade");
  f.saveResponseStyle("global", {}, null);
  assert.equal(f.readResponseStyles().global, "auto");
  const corrupt = fixture({ "coding-tools:ao:chat-style": "focus", [f.RESPONSE_STYLE_KEY]: "broken" });
  assert.equal(corrupt.readResponseStyles().global, "focus");
});

test("long exact model keys round-trip and prototype-shaped provider names remain own data", () => {
  const f = fixture();
  const long = { provider: "p".repeat(300), model: "m".repeat(300) };
  f.saveResponseStyle("model", long, "focus");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), long).style, "focus");
  f.saveResponseStyle("provider", { provider: "__proto__" }, "cascade");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), { provider: "__proto__" }).style, "cascade");
  assert.equal(f.resolveResponseStyle(f.readResponseStyles(), { provider: "constructor" }).style, "transcript");
});

test("saving an unchanged default does not rewrite storage", () => {
  const f = fixture();
  f.saveResponseStyle("global", {}, "focus");
  f.saveResponseStyle("global", {}, "focus");
  assert.equal(f.state.writes, 1);
});

test("rendered Response style settings save global/provider/model choices without provider calls", () => {
  const f = fixture(), slots = [];
  let at = 0;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = { useId: () => "style-settings-test", useEffect() {}, useState(initial) { const index = at++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; } };
  const { ResponseStyleSettings } = f.load("ResponseStyleSettings.tsx", { "./chat-response-style": f, react, "react/jsx-runtime": { jsx, jsxs: jsx } });
  const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
  const render = () => { at = 0; return walk(ResponseStyleSettings({ context })); };
  const change = (label, value) => render().find(node => node.props?.["aria-label"] === label).props.onChange({ target: { value } });
  change("Global response style", "focus");
  assert.equal(f.readResponseStyles().global, "focus");
  change("Scoped response style", "deepseek");
  assert.equal(f.responseStyleOverride(f.readResponseStyles(), "provider", context), "deepseek");
  change("Response style scope", "model");
  change("Scoped response style", "timeline");
  assert.equal(f.responseStyleOverride(f.readResponseStyles(), "model", context), "timeline");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
// The picker's score badges (model-scores.ts) are plain functions with no imports, used as they are.
const scores = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/model-scores.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: scores });
const plain = value => JSON.parse(JSON.stringify(value));
const route = (harness = "ao:codex", model = "cpa/gpt") => ({
  harness_id: harness, provider_id: "agent-orchestrator", account_id: "ao-local", model, permission_profile: ":ao-default",
});
const walk = value => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
/** The window sizes the Context window field suggests (its datalist), which is how it shows the allowed range. */
const presets = tree => walk(walk(tree).find(item => item.type === "label" && item.props.children?.[0] === "Context window"))
  .filter(item => item.type === "option").map(item => item.props.value);
async function picker(current, catalog) {
  let states = [], cursor = 0, effects = [];
  const editor = {};
  vm.runInNewContext(compiled, { exports: editor, require: name => name === "react" ? {
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
    useEffect: effect => effects.push(effect),
  } : name === "react/jsx-runtime" ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : name === "./model-scores" ? scores : {} });
  const changes = [];
  let selectedRoute = current;
  const render = () => { cursor = 0; effects = []; return editor.HarnessPicker({
    route: selectedRoute, harnesses: [], loadModels: async harness => harness === "codex-native" ? ["chatgpt-web/high"] : catalog,
    onChange: value => changes.push(plain(value)),
  }); };
  render(); effects.forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  const tree = render();
  const field = name => walk(tree).find(item => item.type === "label" && item.props.children?.[0] === name)?.props.children[1];
  return { editor, tree, field, changes, selectRoute(next) { selectedRoute = next; return render(); } };
}

test("AO model capabilities enable only advertised effort and a real context control", async () => {
  const p = await picker({ ...route(), effort: "high", context_window: 65536 }, {
    models: ["cpa/gpt"], capabilities: { "cpa/gpt": { efforts: ["low", "high", "auto", "none"], contextWindow: { min: 4096, max: 131072, kind: "context" } } },
  });
  assert.equal(p.field("Reasoning effort").props.disabled, false);
  assert.deepEqual(walk(p.field("Reasoning effort")).filter(item => item.type === "option").map(item => item.props.value), ["", "low", "high", "auto", "none"]);
  assert.equal(p.field("Context window").props.disabled, false);
  assert.deepEqual(presets(p.tree), ["32k", "64k", "128k"], "only sizes within the model's 131,072 are offered");
  assert.equal(p.field("Context window").props.value, "65,536");
  p.field("Reasoning effort").props.onChange({ target: { value: "low" } });
  assert.equal(p.changes[0].model, "cpa/gpt"); assert.equal(p.changes[0].account_id, "ao-local");
  const switched = p.selectRoute(route("ao:claude-code"));
  const effort = walk(switched).find(item => item.type === "label" && item.props.children?.[0] === "Reasoning effort").props.children[1];
  assert.equal(effort.props.disabled, true, "previous harness capabilities never authorize the new harness while it loads");
});

test("every AO harness uses capabilities, including compaction semantics and unsupported models", async () => {
  for (const harness of ["ao:claude-code", "ao:opencode", "ao:gemini"]) {
    const p = await picker(route(harness, "own"), { models: ["own"], capabilities: { own: { efforts: ["high"], contextWindow: { min: 4096, kind: "compaction" } } } });
    assert.equal(p.field("Reasoning effort").props.disabled, false, harness);
    assert.equal(p.field("Context window").props.disabled, false, harness);
    assert.match(JSON.stringify(p.tree), /compaction/i);
  }
  const p = await picker({ ...route(), effort: "high", context_window: 32768 }, {
    models: ["cpa/gpt"], capabilities: { "cpa/gpt": { efforts: [], contextReason: "Client has no context override" } },
  });
  assert.equal(p.field("Reasoning effort").props.disabled, true);
  assert.equal(p.field("Reasoning effort").props.value, "high", "unsupported saved tuning is visible, not erased");
  assert.equal(p.field("Context window").props.disabled, true);
  assert.equal(p.field("Context window").props.value, "32,768", "a saved window stays visible, not erased");
  assert.match(JSON.stringify(p.tree), /Client has no context override/);
});

test("legacy catalogs stay usable without inventing AO tuning support or erasing values", async () => {
  const current = { ...route(), effort: "high", context_window: 32768 };
  const p = await picker(current, ["cpa/gpt", "cpa/next"]);
  assert.equal(p.field("Reasoning effort").props.disabled, true);
  assert.equal(p.field("Reasoning effort").props.value, "high");
  assert.equal(p.field("Context window").props.disabled, true);
  const model = walk(p.tree).find(item => item.type === "select" && item.props.value === "cpa/gpt");
  model.props.onChange({ target: { value: "cpa/next" } });
  assert.equal(p.changes[0].effort, undefined, "a new model starts on its own effort");
  assert.equal(p.changes[0].context_window, 32768);
});

test("AO card metadata reports requested tuning; Native controls and Native-to-AO carry-over stay unchanged", async () => {
  const p = await picker({ ...route("codex-native", "chatgpt-web/high"), effort: "high", context_window: 262144 }, []);
  assert.equal(p.field("Reasoning effort").props.disabled, false);
  assert.deepEqual(walk(p.field("Reasoning effort")).filter(item => item.type === "option").map(item => item.props.value), ["", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(presets(p.tree), ["32k", "64k", "128k", "200k", "272k", "400k", "1M", "2M"], "Native takes 4,096 up to 2M");
  const previous = { ...route("codex-native", "chatgpt-web/high"), effort: "high", context_window: 262144 };
  assert.equal(p.editor.withTuning(route(), previous).effort, undefined);
  assert.match(p.editor.cardMeta({ role: "worker", settings: {}, route: { ...route(), effort: "high", context_window: 65536 } }), /effort high.*64K context/);
});


test("unsupported or unverified AO overrides can be explicitly cleared to model defaults without changing route identity", async () => {
  const current = { ...route(), effort: "high", context_window: 32768 };
  const p = await picker(current, ["cpa/gpt"]);
  const clear = walk(p.tree).find(element => element.type === "button" && element.props.children === "Model defaults");
  assert.ok(clear, "disabled unsupported controls still provide an explicit clear action");
  clear.props.onClick();
  assert.deepEqual(p.changes, [route()], "both requested values are removed, exact model/account identity stays unchanged");
  const native = await picker({ ...route("codex-native", "chatgpt-web/high"), effort: "high", context_window: 262144 }, []);
  assert.equal(walk(native.tree).some(element => element.type === "button" && element.props.children === "Model defaults"), false,
    "Native Codex controls are unchanged");
});

// The split view's grid rules (pure), as the Surface imports them.
function splitRules() {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/chat-split.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports });
  return exports;
}

test("Surface caches model capability catalogs for AO harnesses and Native Codex alike", async () => {
  const surfaceSource = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const surface = {}, calls = [], callbacks = [];
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(surfaceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: surface,
    require: name => name === "react" ? { useState: value => [typeof value === "function" ? value() : value, () => {}],
      useRef: value => ({ current: value }), useCallback: callback => { callbacks.push(callback); return callback; }, useEffect() {}, useLayoutEffect() {},
      useMemo: build => build() }
      : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
      : name === "./page-visibility" ? { pageHidden: () => false, useSurfaceHidden: () => () => false, onAoPush: () => () => {} }
      : name === "../api/client" ? { getCodingToolsClient: () => ({ apps: { call: async request => {
        calls.push(request.arguments.harness);
        return { result: { models: ["fixture"], capabilities: { fixture: { efforts: ["high"] } } } };
      } } }) }
      : name === "./ao-chat" ? { chatList: () => [], chatArchived: () => [] }
      : name === "./chat-split" ? splitRules()
      : name === "../i18n" ? { copyFor: () => ({}) }
      : name === "./AgentOrchestratorRoleEditor" ? { workerRoute: () => ({}), emptyRoleSettings: () => ({}), NATIVE_HARNESS: "codex-native" } : {},
  });
  surface.AgentOrchestratorSurface({ language: "en", setError() {} });
  const loader = callbacks.find(callback => callback.toString().includes("modelCache.current"));
  assert.deepEqual(plain(await loader("ao:codex")), { models: ["fixture"], capabilities: { fixture: { efforts: ["high"] } } });
  await loader("ao:codex");
  assert.deepEqual(calls, ["ao:codex"], "cache retains the full catalog and avoids a duplicate capability request");
  assert.deepEqual(plain(await loader("codex-native")), { models: ["fixture"], capabilities: { fixture: { efforts: ["high"] } } },
    "Native Codex's CPA models carry their capabilities too");
});


test("a new model starts on its own effort; AO-to-AO context still carries over", async () => {
  const p = await picker(route(), ["cpa/gpt"]);
  const maxed = p.editor.withTuning(p.editor.workerRoute("ao:claude-code", "chatgpt-web/high"), { ...route("ao:claude-code", "cpa/fixture"), effort: "max" });
  assert.equal(maxed.effort, undefined, "no effort crosses to another model");
  for (const effort of ["none", "auto", "high"]) {
    const previous = { ...route("ao:claude-code", "cpa/fixture"), effort, context_window: 32768 };
    const native = p.editor.withTuning(p.editor.workerRoute("ao:claude-code", "chatgpt-web/high"), previous);
    assert.equal(native.harness_id, "codex-native");
    assert.equal(native.effort, undefined, `${effort} does not cross into Native Codex`);
    const ao = p.editor.withTuning(route("ao:opencode", "cpa/next"), previous);
    assert.equal(ao.effort, undefined, `${effort} does not cross to another AO model`);
    assert.equal(ao.context_window, 32768, "AO-to-AO client context is retained");
  }
});

test("model lists show a context size only when the catalog reported one, never the 2M client ceiling", async () => {
  const { editor } = await picker(route(), { models: ["cpa/gpt"] });
  assert.equal(editor.capabilityText({ efforts: ["low", "max"], contextWindow: { min: 4096, max: 2000000 } }), "up to max effort");
  assert.equal(editor.capabilityText({ efforts: ["high"], contextLimit: 872000, contextWindow: { min: 4096, max: 872000 } }), "up to high effort · 872K context");
});

test("a saved model the harness no longer lists says so and offers the same model under another provider", async () => {
  const catalog = { models: ["cpa/commandcode-go/deepseek-v4.1-flash", "cpa/cline-pass/deepseek-v4-flash"],
    capabilities: { "cpa/commandcode-go/deepseek-v4.1-flash": { efforts: ["none", "high", "max"] } } };
  const view = await picker({ ...route("ao:claude-code", "cpa/cline-pass/deepseek-v4.1-flash"), effort: "high" }, catalog);
  assert.deepEqual(plain(view.editor.sameModelElsewhere("cpa/cline-pass/deepseek-v4.1-flash", catalog.models)), ["cpa/commandcode-go/deepseek-v4.1-flash"]);
  const notice = walk(view.tree).find(item => item.type === "p" && item.props.role === "status");
  assert.ok(notice, "the editor explains the model is gone");
  const use = walk(notice).find(item => item.type === "button");
  use.props.onClick();
  assert.equal(view.changes.at(-1).model, "cpa/commandcode-go/deepseek-v4.1-flash");
});

test("Native Codex offers its own efforts only for WebGPT; a CPA model there offers what CPA advertised", async () => {
  const { editor } = await picker(route(), ["cpa/gpt"]);
  const native = model => route("codex-native", model);
  assert.deepEqual(plain(editor.routeTuning(native("chatgpt-web/high"), undefined).efforts), ["minimal", "low", "medium", "high", "xhigh"]);
  // Offering all five sent reasoning.effort "xhigh" to upstreams that reject it.
  assert.deepEqual(plain(editor.routeTuning(native("glm-5"), { efforts: [], effortReason: "CPA did not advertise reasoning levels for this model." }).efforts), []);
  assert.deepEqual(plain(editor.routeTuning(native("glm-5"), undefined).efforts), []);
  assert.deepEqual(plain(editor.routeTuning(native("gpt-5.5"), { efforts: ["low", "high"] }).efforts), ["low", "high"]);
  // WebGPT's window is the Codex bridge's: one fixed size, no presets, and a carried window fits to it.
  const bridge = { efforts: [], contextLimit: 111193, contextWindow: { min: 111193, max: 111193, kind: "context", fixed: true } };
  const web = editor.routeTuning(native("chatgpt-web/high"), bridge);
  assert.deepEqual(plain(web.context), { min: 111193, max: 111193 });
  assert.equal(web.fixed, 111193);
  assert.deepEqual(plain(web.presets), []);
  assert.equal(editor.fitWindow({ ...native("chatgpt-web/high"), context_window: 200000 }, bridge).context_window, 111193);
  assert.equal(editor.routeTuning(native("chatgpt-web/high"), undefined).fixed, null, "unknown, the range stays open");
  const p = await picker({ ...native("glm-5"), effort: "xhigh" }, []);
  const effort = p.field("Reasoning effort");
  assert.equal(effort.props.disabled, true);
  assert.equal(effort.props["aria-invalid"], true, "a saved effort the model does not take is flagged");
  assert.ok(walk(p.tree).some(item => item.type === "button" && item.props.children === "Model defaults"), "and can be cleared");
});

test("a window carried to a new model is fitted to the range that model takes", async () => {
  const { editor } = await picker(route(), ["cpa/gpt"]);
  const previous = { ...route("ao:claude-code", "cpa/gemini"), context_window: 1_000_000 };
  const caps = { "cpa/small": { efforts: [], contextLimit: 262144, contextWindow: { min: 4096, max: 262144 } },
    "cpa/fixed": { efforts: [], contextReason: "no setter" } };
  assert.equal(editor.withTuning(route("ao:claude-code", "cpa/small"), previous, caps).context_window, 262144, "clamped to the model's limit");
  assert.equal(Object.hasOwn(editor.withTuning(route("ao:claude-code", "cpa/fixed"), previous, caps), "context_window"), false, "dropped where none can be set");
  assert.equal(editor.withTuning(route("ao:claude-code", "cpa/unknown"), previous, caps).context_window, 1_000_000, "an undescribed model keeps it");
  assert.equal(editor.withTuning(route("ao:claude-code", "cpa/small"), previous).context_window, 1_000_000, "no catalog, no check");
  const toNative = editor.withTuning(editor.workerRoute("codex-native", "chatgpt-web/high"), { ...previous, context_window: 3_000_000 }, {});
  assert.equal(toNative.context_window, 2_000_000, "Native Codex's 2M ceiling is known without a catalog");
  // The editor's model list passes its catalog.
  const p = await picker({ ...route(), context_window: 1_000_000 }, { models: ["cpa/gpt", "cpa/small"],
    capabilities: { "cpa/gpt": { efforts: [], contextWindow: { min: 4096, max: 1_000_000 } }, "cpa/small": caps["cpa/small"] } });
  walk(p.tree).find(item => item.type === "select" && item.props.value === "cpa/gpt").props.onChange({ target: { value: "cpa/small" } });
  assert.equal(p.changes.at(-1).context_window, 262144);
});

test("the Model scores leaderboard ranks like a benchmark: by the chosen view, then finished share; a model needs 3 missions to rank", () => {
  const stats = (average, recent, best) => ({ count: 1, average, recent, best, last: recent });
  const entry = (model, missions, passRate, average, recent = average, best = average) =>
    ({ model, missions, finished: Math.round(missions * passRate), failed: missions - Math.round(missions * passRate), passRate, lastAt: null, overall: stats(average, recent, best), categories: {} });
  const summary = [entry("a", 5, 0.8, 7.0, 9.0), entry("b", 4, 1, 8.0, 6.0), entry("c", 3, 0.5, 8.0, 8.0), entry("lucky", 1, 1, 10, 10, 10), entry("new", 2, 1, 6)];
  const board = (view) => plain(scores.rankModels(summary, view)).map((item) => [item.model, item.rank]);
  assert.deepEqual(board("average"), [["b", 1], ["c", 2], ["a", 3], ["lucky", null], ["new", null]],
    "a tie on the score goes to the higher finished share; one lucky mission does not top the board");
  assert.deepEqual(board("recent"), [["a", 1], ["c", 2], ["b", 3], ["lucky", null], ["new", null]], "the view chosen is what ranks");
  assert.equal(scores.passText(entry("a", 5, 0.8, 7)), "80% (4/5)");
  assert.equal(scores.passText({ missions: 2 }), "–", "an older backend's summary has no record");
});

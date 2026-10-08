const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const route = (harness = "ao:codex", model = "cpa/gpt") => ({
  harness_id: harness, provider_id: "agent-orchestrator", account_id: "ao-local", model, permission_profile: ":ao-default",
});
const walk = value => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
async function picker(current, catalog) {
  let states = [], cursor = 0, effects = [];
  const editor = {};
  vm.runInNewContext(compiled, { exports: editor, require: name => name === "react" ? {
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
    useEffect: effect => effects.push(effect),
  } : name === "react/jsx-runtime" ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : {} });
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
  assert.equal(p.field("Context window").props.max, 131072);
  assert.equal(p.field("Context window").props.value, 65536);
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
  assert.equal(p.field("Context window").props.value, 32768);
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
  assert.equal(p.changes[0].effort, "high");
  assert.equal(p.changes[0].context_window, 32768);
});

test("AO card metadata reports requested tuning; Native controls and Native-to-AO carry-over stay unchanged", async () => {
  const p = await picker({ ...route("codex-native", "chatgpt-web/high"), effort: "high", context_window: 262144 }, []);
  assert.equal(p.field("Reasoning effort").props.disabled, false);
  assert.deepEqual(walk(p.field("Reasoning effort")).filter(item => item.type === "option").map(item => item.props.value), ["", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(p.field("Context window").props.min, 4096); assert.equal(p.field("Context window").props.max, 2000000);
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

test("Surface caches AO model capability catalogs while Native Codex keeps its legacy model array", async () => {
  const surfaceSource = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const surface = {}, calls = [], callbacks = [];
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(surfaceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: surface,
    require: name => name === "react" ? { useState: value => [typeof value === "function" ? value() : value, () => {}],
      useRef: value => ({ current: value }), useCallback: callback => { callbacks.push(callback); return callback; }, useEffect() {}, useLayoutEffect() {} }
      : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
      : name === "../api/client" ? { getCodingToolsClient: () => ({ apps: { call: async request => {
        calls.push(request.arguments.harness);
        return { result: { models: ["fixture"], capabilities: { fixture: { efforts: ["high"] } } } };
      } } }) }
      : name === "./ao-chat" ? { chatList: () => [] }
      : name === "../i18n" ? { copyFor: () => ({}) }
      : name === "./AgentOrchestratorRoleEditor" ? { workerRoute: () => ({}), emptyRoleSettings: () => ({}), NATIVE_HARNESS: "codex-native" } : {},
  });
  surface.AgentOrchestratorSurface({ language: "en", setError() {} });
  const loader = callbacks.find(callback => callback.toString().includes("modelCache.current"));
  assert.deepEqual(plain(await loader("ao:codex")), { models: ["fixture"], capabilities: { fixture: { efforts: ["high"] } } });
  await loader("ao:codex");
  assert.deepEqual(calls, ["ao:codex"], "cache retains the full catalog and avoids a duplicate capability request");
  assert.deepEqual(plain(await loader("codex-native")), ["fixture"], "Native model array and behavior stay unchanged");
});


test("AO-only efforts never cross into Native Codex; valid high and AO-to-AO tuning still carry over", async () => {
  const p = await picker(route(), ["cpa/gpt"]);
  for (const effort of ["none", "auto", "max"]) {
    const previous = { ...route("ao:claude-code", "cpa/fixture"), effort, context_window: 32768 };
    const native = p.editor.withTuning(p.editor.workerRoute("ao:claude-code", "chatgpt-web/high"), previous);
    assert.equal(native.harness_id, "codex-native");
    assert.equal(native.effort, undefined, `Native's unchanged five efforts do not accept ${effort}`);
    const ao = p.editor.withTuning(route("ao:opencode", "cpa/next"), previous);
    assert.equal(ao.effort, effort, "AO-to-AO requested effort is retained");
    assert.equal(ao.context_window, 32768, "AO-to-AO client context is retained");
  }
  const valid = p.editor.withTuning(p.editor.workerRoute("ao:codex", "chatgpt-web/high"),
    { ...route(), effort: "high", context_window: 32768 });
  assert.equal(valid.effort, "high", "valid Native effort carry-over remains unchanged");
});

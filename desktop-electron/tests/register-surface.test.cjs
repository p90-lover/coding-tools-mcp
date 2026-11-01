"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/RegisterSurface.tsx"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
} }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const offline = { projectRoot: "G:/fixture-register", ready: false, starting: false, owned: false, error: null };

function harness(options = {}) {
  const refs = [], states = [], calls = [], windowEvents = new Map(), documentEvents = new Map();
  let refIndex = 0, stateIndex = 0, effects = [], cleanups = [], tree, timer;
  let status = { ...offline, ...options.status };
  const api = {
    registerStatus: async () => { calls.push("status"); return options.read ? options.read() : status; },
    startRegister: async () => { calls.push("start"); status = options.startResult || { ...status, ready: true, owned: true }; return status; },
    configureRegister: async folder => { calls.push(["configure", folder]); status = { ...offline, projectRoot: folder }; return status; },
    chooseFolder: async () => options.folder ?? null,
    onRegisterChanged: () => () => {},
    setRegisterSurfaceActive: async () => status,
  };
  const react = {
    useRef: initial => refs[refIndex++] ||= { current: initial },
    useState: initial => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = value; }];
    },
    useEffect: effect => effects.push(effect),
    useLayoutEffect() {},
    useCallback: callback => callback,
  };
  const jsx = (type, props) => ({ type, props });
  let focused = options.focused !== false;
  const document = { hidden: options.hidden || false, hasFocus: () => focused,
    addEventListener: (name, callback) => documentEvents.set(name, callback),
    removeEventListener: name => documentEvents.delete(name) };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith(".css")) return {};
    throw Error("Unexpected import " + name);
  }, document, window: {
    setInterval: callback => { timer = callback; return 1; }, clearInterval: () => { timer = null; },
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    removeEventListener: name => windowEvents.delete(name),
  } });
  const render = (active = true) => {
    for (const cleanup of cleanups) cleanup?.();
    effects = []; refIndex = 0; stateIndex = 0;
    tree = exports.RegisterSurface({ api, active, language: "en", setError() {} });
    cleanups = effects.map(effect => effect());
  };
  function buttons(node, result = []) {
    if (!node || typeof node !== "object") return result;
    if (node.type === "button") result.push(node);
    for (const child of [node.props?.children].flat(Infinity)) buttons(child, result);
    return result;
  }
  render(options.active !== false);
  return { calls, states, render, documentEvents, windowEvents,
    poll: () => timer?.(), setStatus: value => { status = value; },
    show: () => { document.hidden = false; documentEvents.get("visibilitychange")?.(); },
    focus: () => { focused = true; windowEvents.get("focus")?.(); },
    choose: () => buttons(tree).find(node => node.props.children === "Choose project").props.onClick(),
    dispose: () => { for (const cleanup of cleanups) cleanup?.(); },
  };
}

test("opening a configured offline Register starts it once and polling does not undo Stop", async () => {
  const h = harness(); await tick();
  assert.equal(h.calls.filter(call => call === "start").length, 1);
  assert.equal(h.states[0].ready, true);
  h.setStatus({ ...offline });
  await h.poll(); await h.poll();
  assert.equal(h.calls.filter(call => call === "start").length, 1);
  h.render(false); h.render(true); await tick();
  assert.equal(h.calls.filter(call => call === "start").length, 1, "switching tabs preserves explicit Stop");
  h.dispose();
});

test("an attached service is not started and remains stopped after a later manual Stop", async () => {
  const h = harness({ status: { ready: true } }); await tick();
  h.setStatus({ ...offline }); await h.poll();
  assert.equal(h.calls.includes("start"), false);
  h.dispose();
});

test("startup failure remains visible without an automatic retry loop", async () => {
  const h = harness({ startResult: { ...offline, error: "Missing Python environment" } }); await tick();
  await h.poll(); await h.poll();
  assert.equal(h.calls.filter(call => call === "start").length, 1);
  assert.match(h.states[0].error, /Python/);
  h.dispose();
});

test("choosing a project configures then starts it; cancelling does neither", async () => {
  const h = harness({ status: { projectRoot: "" }, folder: "G:/chosen-register" }); await tick();
  assert.equal(h.calls.includes("start"), false);
  h.choose(); await tick();
  assert.deepEqual(h.calls.slice(-2), [["configure", "G:/chosen-register"], "start"]);
  assert.equal(h.states[0].ready, true);
  h.dispose();
  const cancelled = harness({ status: { projectRoot: "" } }); await tick();
  cancelled.choose(); await tick();
  assert.deepEqual(cancelled.calls, ["status"]);
  cancelled.dispose();
});

test("inactive and hidden surfaces never launch; becoming visible triggers the first attempt", async () => {
  const inactive = harness({ active: false }); await tick();
  assert.deepEqual(inactive.calls, []); inactive.dispose();
  const hidden = harness({ hidden: true }); await tick();
  assert.deepEqual(hidden.calls, []);
  hidden.show(); await tick();
  assert.deepEqual(hidden.calls, ["status", "start"]);
  hidden.dispose();
  assert.equal(hidden.documentEvents.size, 0); assert.equal(hidden.windowEvents.size, 0);
});

test("automatic startup waits for focus so native write authorization can succeed", async () => {
  const h = harness({ focused: false }); await tick();
  assert.deepEqual(h.calls, ["status"]);
  h.focus(); await tick();
  assert.deepEqual(h.calls, ["status", "status", "start"]);
  h.dispose();
});

test("unmounting during a status read fences a late automatic start", async () => {
  let release;
  const h = harness({ read: () => new Promise(resolve => { release = resolve; }) });
  h.dispose(); release({ ...offline }); await tick();
  assert.deepEqual(h.calls, ["status"]);
});

test("a service already starting or reporting a configuration error is not automatically relaunched", async () => {
  for (const status of [{ starting: true }, { error: "Saved project settings could not be read" }]) {
    const h = harness({ status }); await tick();
    assert.equal(h.calls.includes("start"), false); h.dispose();
  }
});

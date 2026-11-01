"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const surface = fs.readFileSync(path.join(root, "src/features/RegisterSurface.tsx"), "utf8");
const parsed = ts.createSourceFile("main.cjs", main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = parsed.statements.filter(ts.isFunctionDeclaration);

test("Register launcher uses packaged files and authorizes only its native service origin", async () => {
  let options, listener, filter, calls = 0;
  const host = {};
  const context = vm.createContext({
    registerHost: null, registerOrigin: "http://127.0.0.1:43123", path, URL,
    SOURCE_ROOT: path.resolve("fixture-source"), CORE_HOME: path.resolve("fixture-profile"),
    app: { isPackaged: true }, process: { resourcesPath: path.resolve("fixture-installed/resources") },
    createRegisterHost: value => { options = value; calls++; return host; }, quitting: false,
    WebContentsView: class {}, mainWindow: null, openWebUrl() {}, send() {},
  });
  const getHost = vm.runInContext("(" + functions.find(node => node.name?.text === "getRegisterHost").getText(parsed) + ")", context);
  assert.equal(getHost({}), host); assert.equal(getHost({}), host); assert.equal(calls, 1);
  assert.equal(options.runtimeRoot, path.resolve("fixture-installed/resources/register-runtime"));
  assert.equal(options.dataRoot, path.resolve("fixture-profile/register"));
  assert.equal(options.projectRoot, undefined); assert.equal(options.configPath, undefined);
  const session = { setProxy: async value => assert.equal(value.mode, "direct"),
    webRequest: { onBeforeSendHeaders: (nextFilter, nextListener) => { filter = nextFilter; listener = nextListener; } } };
  const remove = await options.prepareSession(session, options.origin, "private-fixture-token");
  assert.equal(filter.urls[0], "http://127.0.0.1/*");
  const headers = url => { let result; listener({ url, requestHeaders: { "X-Fixture": "yes" } }, value => { result = value.requestHeaders; }); return result; };
  assert.equal(headers(options.origin + "/api/auth/check").Authorization, "Bearer private-fixture-token");
  assert.equal(headers("http://127.0.0.1:43124/api/auth/check").Authorization, undefined);
  assert.equal(headers("https://example.invalid/").Authorization, undefined);
  remove(); assert.equal(filter, null); assert.equal(listener, undefined);
  await options.prepareSession(session, options.origin, undefined); assert.equal(listener, undefined);
});

test("Register starts once on first entry, needs no project picker and respects Stop across overlays", async () => {
  const states = [], refs = [], effects = [], pending = [], timers = new Map();
  let stateIndex = 0, refIndex = 0, effectIndex = 0, starts = 0, timerId = 0;
  let status = { managed: true, ready: false, starting: false, owned: false, error: null };
  const effect = (work, deps) => {
    const index = effectIndex++, previous = effects[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push(() => {
      previous?.cleanup?.(); effects[index] = { deps, cleanup: work() };
    });
  };
  const api = {
    registerStatus: async () => status,
    startRegister: async () => { starts++; status = { ...status, ready: true, owned: true }; return status; },
    stopRegister: async () => { status = { ...status, ready: false, owned: false }; return status; },
    reloadRegister: async () => status, onRegisterChanged: () => () => {},
    setRegisterSurfaceActive: async () => status, setRegisterBounds: async () => true,
  };
  const jsx = (type, props) => ({ type, props });
  const react = {
    useEffect: effect, useLayoutEffect: effect, useCallback: work => work,
    useRef: value => { const index = refIndex++; return refs[index] ||= { current: value }; },
    useState: initial => { const index = stateIndex++; if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(surface, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : {},
    window: { setInterval: work => { const id = ++timerId; timers.set(id, work); return id; }, clearInterval: id => timers.delete(id),
      addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} }, cancelAnimationFrame() {}, requestAnimationFrame() {},
  });
  const setError = () => {};
  const render = active => { stateIndex = 0; refIndex = 0; effectIndex = 0;
    const tree = exports.RegisterSurface({ api, active, language: "en", setError });
    for (const work of pending.splice(0)) work(); return tree;
  };
  const buttons = node => !node || typeof node !== "object" ? []
    : [...(node.type === "button" ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(buttons)];
  render(false); await new Promise(setImmediate); assert.equal(starts, 0);
  render(true); await new Promise(setImmediate); let tree = render(true); assert.equal(starts, 1);
  assert.equal(buttons(tree).some(node => node.props.children === "Choose project"), false);
  assert.equal(buttons(tree).find(node => node.props.children === "Stop service").props.disabled, false);
  buttons(tree).find(node => node.props.children === "Stop service").props.onClick();
  await new Promise(setImmediate); tree = render(true); assert.equal(status.ready, false);
  for (const tick of timers.values()) await tick(); render(true); assert.equal(starts, 1);
  render(false); render(true); await new Promise(setImmediate); render(true); assert.equal(starts, 1);
  for (const entry of effects) entry?.cleanup?.(); assert.equal(timers.size, 0);
});

test("Register bridge initializes before managed services without sharing browser-control credentials", async () => {
  const startup = functions.find(node => node.name?.text === "start");
  const statements = startup.body.statements;
  const assignment = statements.find(node => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.left.getText(parsed) === "registerApi");
  assert.ok(assignment, "startup must create the scoped Register bridge");
  const init = statements[statements.indexOf(assignment) + 1];
  const calls = [], warnings = [];
  const context = { path, CORE_HOME: path.resolve("fixture-profile"), REGISTER_DESCRIPTOR_PATH: path.resolve("fixture-profile/runtime/register-api.json"),
    registerApi: null, logger: { warn: (...args) => warnings.push(args) }, getRegisterHost: () => "managed-host",
    createRegisterApi: options => { calls.push(options); return { start: async () => calls.push("start") }; } };
  await vm.runInNewContext("(async () => {" + assignment.getText(parsed) + init.getText(parsed) + "})()", context);
  assert.equal(calls[0].host, "managed-host"); assert.equal(calls[0].descriptorPath, context.REGISTER_DESCRIPTOR_PATH);
  assert.equal(calls[1], "start"); assert.equal(calls[0].browserControl, undefined); assert.deepEqual(warnings, []);
  assert.ok(main.indexOf(assignment.getText(parsed)) < main.indexOf("browserControl = await new BrowserControlServer"));
});

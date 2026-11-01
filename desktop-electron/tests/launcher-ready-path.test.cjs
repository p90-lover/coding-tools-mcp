"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  KEEP_UI_RESPONSIVE_SKIP_REASON,
  createIpcRegistrar,
  createLazyFactory,
  createRendererLoader,
  createRetryingInvoker,
  deferUiWork,
  isBlankRendererUrl,
  scheduleFullIpcAfterPaint,
  shouldLoadRenderer,
} = require("../electron/launcher-ready-path.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const IDLE_BROWSER_URL = "data:text/html;charset=utf-8,%3C!doctype%20html%3E#codex-web-gpt-browser-host";
const PACKAGED_RENDERER = "file:///tmp/coding-tools/dist/index.html";

test("blank and data: BrowserHost URLs still load the packaged renderer", () => {
  assert.equal(isBlankRendererUrl(""), true);
  assert.equal(isBlankRendererUrl("about:blank"), true);
  assert.equal(isBlankRendererUrl(IDLE_BROWSER_URL), true);
  assert.equal(shouldLoadRenderer(IDLE_BROWSER_URL, PACKAGED_RENDERER), true);
  assert.equal(shouldLoadRenderer("file:///tmp/coding-tools/dist/index.html", PACKAGED_RENDERER), false);
  assert.equal(shouldLoadRenderer("https://chatgpt.com/", PACKAGED_RENDERER), true);
});

test("renderer loader never starts a second loadFile while one is in flight", async () => {
  let loads = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const loader = createRendererLoader({
    getUrl: () => IDLE_BROWSER_URL,
    load: async () => {
      loads += 1;
      await blocked;
    },
    packagedRendererUrl: PACKAGED_RENDERER,
    timeoutMs: 0,
  });

  const first = loader.loadOnce();
  const second = loader.loadOnce();
  release();
  await Promise.all([first, second]);
  assert.equal(loads, 1);
});

test("browser-surface-active work is deferred and still returns immediately", async () => {
  let ran = false;
  const scheduled = [];
  const result = deferUiWork(() => {
    ran = true;
  }, {
    schedule: (work) => scheduled.push(work),
  });
  assert.equal(result, true);
  assert.equal(ran, false);
  scheduled[0]();
  assert.equal(ran, true);
});

test("five-stack lazy init failure does not brick later UI handlers", () => {
  let attempts = 0;
  const lazy = createLazyFactory(() => {
    attempts += 1;
    throw new Error("peer-environment overflow");
  });
  assert.equal(lazy.tryGet().ok, false);
  assert.equal(lazy.ready(), false);
  assert.equal(attempts, 1);
  assert.equal(lazy.tryGet().ok, false);
  assert.equal(attempts, 2);
});

test("snapshot invoker retries until the launcher handler is registered", async () => {
  let calls = 0;
  const invoke = createRetryingInvoker({
    invoke: async (channel) => {
      calls += 1;
      if (calls < 3) throw new Error(`No handler registered for '${channel}'`);
      return { ok: true, calls };
    },
  }, "launcher:snapshot", {
    delaysMs: [0, 0, 0],
    sleep: async () => {},
  });
  assert.deepEqual(await invoke(), { ok: true, calls: 3 });
  assert.equal(calls, 3);
});

test("keep-ui-responsive skip still completes full IPC after paint", () => {
  const registrar = createIpcRegistrar();
  const events = [];
  let full = 0;
  const scheduled = [];
  scheduleFullIpcAfterPaint(({ reason }) => {
    assert.equal(reason, "after-paint:local-repair-keep-ui-responsive");
    assert.equal(registrar.markFull(), true);
    full += 1;
  }, {
    schedule: (work) => scheduled.push(work),
    logger: {
      warn(event, detail) { events.push([event, detail]); },
    },
    skipReason: KEEP_UI_RESPONSIVE_SKIP_REASON,
  });
  assert.equal(full, 0);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(events, [[
    "launcher.bootstrap_skipped",
    { reason: "local-repair-keep-ui-responsive" },
  ]]);
  scheduled[0]();
  assert.equal(full, 1);
  assert.equal(registrar.isFull(), true);
  assert.equal(registrar.markFull(), false);
});


test("launcher startup resolves a linked userData root before setting every app path", (t) => {
  const vm = require("node:vm");
  const fixtureRoot = path.join(desktopRoot, "..", "aiTemp", "portable-profile-tests");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureRoot, "startup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const physical = path.join(directory, "physical");
  const alias = path.join(directory, "profile-link");
  fs.mkdirSync(physical);
  fs.writeFileSync(path.join(physical, "saved-state.json"), "preserve-user-state");
  fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");

  const configuredPaths = {};
  let diagnosticPath;
  const main = read("electron/main.cjs");
  const startup = main.slice(
    main.indexOf("\nprocess.env.CODEX_CHATGPT_WEB_HOME ="),
    main.indexOf("\nlet mainWindow ="),
  );
  assert.ok(startup.length > 0, "execute the actual main-process profile setup");
  vm.runInNewContext(startup, {
    fs,
    path,
    process: { env: {}, platform: process.platform },
    CORE_HOME: path.join(directory, "core"),
    LAUNCHER_PROFILE: { userData: alias, codexHome: path.join(directory, "codex"), displayName: "Test" },
    IS_DEV_PROFILE: false,
    app: {
      setName() {},
      setAppUserModelId() {},
      setPath(name, value) { configuredPaths[name] = value; },
      setAppLogsPath(value) { configuredPaths.logs = value; },
    },
    installProcessDiagnosticGuards({ filePath }) { diagnosticPath = filePath; },
  });
  assert.equal(configuredPaths.userData, fs.realpathSync.native(physical));
  assert.equal(configuredPaths.logs, path.join(configuredPaths.userData, "logs"));
  assert.equal(diagnosticPath, path.join(configuredPaths.logs, "process-stream-errors.log"));
  assert.equal(fs.readFileSync(path.join(physical, "saved-state.json"), "utf8"), "preserve-user-state");
});

test("critical IPC is registered before the renderer file is loaded", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const registerAt = main.indexOf("registerIpc({ logger, stateStore });");
  const loadAt = main.indexOf("await ensureRendererLoaded(mainWindow, logger)");
  const readyAt = main.indexOf("await browserHost.ready()");
  const minimalAt = main.indexOf("registerMinimalPreRendererIpc({ logger, stateStore })");
  assert.ok(registerAt >= 0, "registerIpc must remain on the ready path");
  assert.ok(loadAt > registerAt, "renderer load must happen after IPC registration");
  assert.ok(readyAt > registerAt, "BrowserHost.ready must not block IPC registration");
  assert.ok(minimalAt >= 0 && minimalAt < registerAt, "minimal pre-renderer IPC must register first");
  assert.match(main, /handle\("launcher:snapshot"/);
  assert.match(main, /handle\("launcher:browser-surface-active"/);
  assert.match(main, /handle\("launcher:original-ui-snapshot"/);
  assert.match(main, /handle\("coding-tools:apps:list"/);
  assert.match(main, /deferUiWork/);
  assert.match(main, /scheduleFullIpcAfterPaint/);
  assert.match(main, /KEEP_UI_RESPONSIVE_SKIP_REASON/);
  assert.match(main, /runtimeHost\?\.browserConnectorName/);
  assert.match(preload, /createRetryingInvoker\(ipcRenderer, "launcher:snapshot"\)/);
  const app = read("src/App.tsx");
  assert.match(app, /IPC_API_RETRY_DELAYS_MS/);
  assert.match(app, /readLauncherApi/);
  assert.match(app, /apiTimedOut/);
});

function launcherApp(available = true) {
  const ts = require("typescript"), vm = require("node:vm");
  const file = ts.createSourceFile("App.tsx", read("src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["App", "FatalMessage", "LaunchLoading", "SecondaryButton", "messageOf"];
  const code = file.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(file)).join("\n");
  const delays = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(file) === "IPC_API_RETRY_DELAYS_MS"));
  const states = [], refs = [], effects = [], queued = [], requests = [], logs = [], afterUnmount = [];
  const subscriptions = new Map(), timers = new Map(); let stateIndex = 0, refIndex = 0, effectIndex = 0, dirty = false, mounted = true, timerId = 0;
  const api = { snapshot: () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    requests.push({ resolve, reject }); return promise; } };
  for (const name of ["onStateChanged", "onBrowserState", "onOperation", "onLog", "onUpdateState"]) {
    const listeners = new Set(); subscriptions.set(name, listeners);
    api[name] = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  }
  let bridge = available ? api : undefined;
  const jsx = (type, props) => ({ type, props: props || {} }), exports = {};
  vm.runInNewContext(ts.transpileModule(delays.getText(file) + "\n" + code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, api: bridge, readLauncherApi: () => bridge, Error, document: { documentElement: {} },
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], next => { if (!mounted) afterUnmount.push(index); const value = typeof next === "function" ? next(states[index]) : next;
        if (!Object.is(value, states[index])) { states[index] = value; dirty = true; } }]; },
    useRef: initial => refs[refIndex++] ??= { current: initial }, useCallback: callback => callback,
    useEffect(work, deps) { const index = effectIndex++, previous = effects[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) queued.push(() => {
        previous?.cleanup?.(); effects[index] = { deps, cleanup: work() }; }); },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    copyFor: () => ({}), replaceLogs: value => logs.push(value), appendLog() {},
    AnimatePresence: "presence", Onboarding: "onboarding", LauncherShell: "shell", ErrorToast: "error-toast", BrandMark: "brand", Icon: "icon",
    require: () => ({ jsx, jsxs: jsx }),
  });
  const render = () => {
    for (let pass = 0; pass < 10; pass++) {
      dirty = false; stateIndex = refIndex = effectIndex = 0; const tree = exports.App();
      for (const work of queued.splice(0)) work();
      if (!dirty) return tree;
    }
    throw new Error("App hooks did not settle");
  };
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk)
    : typeof item.type === "function" ? walk(item.type(item.props)) : [item, ...walk(item.props?.children)];
  const cleanup = () => { for (const effect of effects) effect?.cleanup?.(); };
  return { requests, subscriptions, logs, afterUnmount, render, walk, timers,
    restartEffects() { cleanup(); effects.length = 0; return render(); },
    unmount() { cleanup(); mounted = false; },
    connect() { bridge = api; }, tick() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
  };
}
const startupSnapshot = (version = "test", operation = null) => ({ version, platform: "win32", profile: "test", state: { language: "en", onboardingComplete: true }, browser: null, operation, logs: [], update: { status: "idle" } });

test("a failed startup snapshot shows its error and user Retry recovers without duplicating subscriptions", async () => {
  const app = launcherApp(); app.render(); assert.equal(app.requests.length, 1);
  app.requests[0].reject(new Error("temporary snapshot read failure")); await new Promise(setImmediate);
  let screen = app.walk(app.render());
  assert.ok(screen.some(node => node.type === "p" && node.props.children.includes("temporary snapshot read failure")), "the failure is visible instead of an endless spinner");
  const retry = screen.find(node => node.type === "button"); assert.ok(retry, "startup offers a retry control");
  for (const listener of app.subscriptions.get("onStateChanged")) listener({ language: "en", onboardingComplete: true });
  assert.ok(app.walk(app.render()).some(node => node.props.className === "fatal-message"), "a state-only event cannot replace the missing full snapshot");
  retry.props.onClick(); screen = app.walk(app.render());
  assert.ok(screen.some(node => node.props.className === "launch-loading")); assert.equal(app.requests.length, 2);
  for (const listeners of app.subscriptions.values()) assert.equal(listeners.size, 1);
  app.requests[1].resolve(startupSnapshot("recovered")); await new Promise(setImmediate);
  const shell = app.walk(app.render()).find(node => node.type === "shell"); assert.equal(shell.props.snapshot.version, "recovered");
  assert.equal(app.walk(app.render()).some(node => node.type === "error-toast"), false, "the retired startup error does not survive recovery");
  app.unmount(); for (const listeners of app.subscriptions.values()) assert.equal(listeners.size, 0);
});

test("retry ignores both outcomes from an older canceled startup snapshot", async t => {
  for (const outcome of ["resolve", "reject"]) await t.test(outcome, async () => {
    const app = launcherApp(); app.render(); app.restartEffects();
    app.requests[1].reject(new Error("retry this attempt")); await new Promise(setImmediate);
    const retry = app.walk(app.render()).find(node => node.type === "button"); assert.ok(retry); retry.props.onClick(); app.render();
    app.requests[2].resolve(startupSnapshot("current")); await new Promise(setImmediate);
    app.requests[0][outcome](outcome === "resolve" ? startupSnapshot("old") : new Error("old failure")); await new Promise(setImmediate);
    const screen = app.walk(app.render()); assert.equal(screen.find(node => node.type === "shell").props.snapshot.version, "current");
    assert.equal(screen.some(node => node.type === "error-toast"), false); assert.equal(app.logs.length, 1);
    for (const listeners of app.subscriptions.values()) assert.equal(listeners.size, 1); app.unmount();
  });
});

test("unmount fences both startup snapshot outcomes", async t => {
  for (const outcome of ["resolve", "reject"]) await t.test(outcome, async () => {
    const app = launcherApp(); app.render(); app.unmount();
    app.requests[0][outcome](outcome === "resolve" ? startupSnapshot() : new Error("late failure")); await new Promise(setImmediate);
    assert.deepEqual(app.afterUnmount, []); assert.equal(app.logs.length, 0);
    for (const listeners of app.subscriptions.values()) assert.equal(listeners.size, 0);
  });
});

test("startup preserves operation errors after loading and the launcher-API-unavailable screen", async () => {
  const app = launcherApp(); app.render();
  app.requests[0].resolve(startupSnapshot("ready", { status: "failed", name: "catalog", message: "normal operation failure" }));
  await new Promise(setImmediate);
  assert.equal(app.walk(app.render()).find(node => node.type === "error-toast").props.message, "normal operation failure"); app.unmount();
  const absent = launcherApp(false); absent.render();
  for (let i = 0; i < 6; i++) { absent.tick(); absent.render(); }
  const screen = absent.walk(absent.render());
  assert.ok(screen.some(node => node.type === "p" && node.props.children.includes("Can't reach the launcher")));
  assert.equal(screen.some(node => node.type === "button"), false); assert.equal(absent.requests.length, 0); absent.unmount();
  assert.equal(absent.timers.size, 0);
});

test("a launcher bridge discovered after first render starts one snapshot and one set of listeners", async () => {
  const app = launcherApp(false); app.render(); assert.equal(app.requests.length, 0);
  app.connect(); app.tick(); app.render(); assert.equal(app.requests.length, 1);
  for (const listeners of app.subscriptions.values()) assert.equal(listeners.size, 1);
  app.requests[0].resolve(startupSnapshot()); await new Promise(setImmediate);
  assert.ok(app.walk(app.render()).some(node => node.type === "shell")); app.unmount(); assert.equal(app.timers.size, 0);
});

test("an empty startup error still offers Retry", async () => {
  const app = launcherApp(); app.render(); app.requests[0].reject(new Error("")); await new Promise(setImmediate);
  assert.ok(app.walk(app.render()).some(node => node.type === "button")); app.unmount();
});

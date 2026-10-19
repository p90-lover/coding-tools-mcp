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

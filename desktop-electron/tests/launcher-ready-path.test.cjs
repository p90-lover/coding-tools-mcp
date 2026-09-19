"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createLazyFactory,
  createRendererLoader,
  createRetryingInvoker,
  deferUiWork,
  isBlankRendererUrl,
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

test("critical IPC is registered before the renderer file is loaded", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const registerAt = main.indexOf("registerIpc({ logger, stateStore })");
  const loadAt = main.indexOf("await ensureRendererLoaded(mainWindow, logger)");
  assert.ok(registerAt >= 0, "registerIpc must remain on the ready path");
  assert.ok(loadAt > registerAt, "renderer load must happen after IPC registration");
  assert.match(main, /handle\("launcher:snapshot"/);
  assert.match(main, /handle\("launcher:browser-surface-active"/);
  assert.match(main, /handle\("launcher:original-ui-snapshot"/);
  assert.match(main, /handle\("coding-tools:apps:list"/);
  assert.match(main, /deferUiWork/);
  assert.match(main, /createLazyFactory\(\(\) => createFiveStackControlPlane/);
  assert.match(preload, /createRetryingInvoker\(ipcRenderer, "launcher:snapshot"\)/);
});

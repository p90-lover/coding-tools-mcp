"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const fixtureRoot = path.resolve(__dirname, "../../aiTemp", `browser-debugging-${process.pid}`);
fs.mkdirSync(fixtureRoot, { recursive: true });
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const oldId = "11111111-1111-1111-1111-111111111111";
const newId = "22222222-2222-2222-2222-222222222222";

function fixture(initiallyReady = false) {
  const directory = fs.mkdtempSync(path.join(fixtureRoot, "profile-"));
  const portFile = path.join(directory, "DevToolsActivePort");
  const calls = [];
  let ready = initiallyReady;
  return { portFile, calls, app: {
    isReady: () => ready,
    getPath: name => { assert.equal(name, "userData"); return directory; },
    commandLine: { appendSwitch: (name, value) => calls.push([name, value, ready]) },
    whenReady: async () => { ready = true; },
  } };
}

test("browser debugging switches are configured before waiting for Electron", () => {
  const { prepareBrowserDebugging } = require("../electron/browser-debugging.cjs");
  const { app, calls } = fixture();
  const resolvePort = prepareBrowserDebugging(app);
  assert.equal(typeof resolvePort, "function");
  assert.deepEqual(calls, [
    ["remote-debugging-address", "127.0.0.1", false],
    ["remote-debugging-port", "0", false],
  ]);
  assert.equal(app.isReady(), false);
});

test("browser debugging resolves the fresh port of this launch", async () => {
  const { prepareBrowserDebugging } = require("../electron/browser-debugging.cjs");
  const { app, portFile } = fixture();
  fs.writeFileSync(portFile, `12345\n/devtools/browser/${oldId}\n`);
  const resolvePort = prepareBrowserDebugging(app);
  fs.writeFileSync(portFile, `42345\r\n/devtools/browser/${newId}\r\n`);
  assert.equal(await resolvePort(), 42345);
});

test("browser debugging waits for its port file to appear", async () => {
  const { prepareBrowserDebugging } = require("../electron/browser-debugging.cjs");
  const { app, portFile } = fixture();
  const resolvePort = prepareBrowserDebugging(app);
  const timer = setTimeout(() => fs.writeFileSync(portFile, `42346\n/devtools/browser/${newId}\n`), 20);
  try { assert.equal(await resolvePort(), 42346); }
  finally { clearTimeout(timer); }
});

test("browser debugging refuses a stale port from a previous launch", { timeout: 15_000 }, async () => {
  const { prepareBrowserDebugging } = require("../electron/browser-debugging.cjs");
  const { app, portFile } = fixture();
  fs.writeFileSync(portFile, `12345\n/devtools/browser/${oldId}\n`);
  await assert.rejects(prepareBrowserDebugging(app)(), /automation endpoint did not start/);
});

test("browser debugging refuses invalid fresh port records", async () => {
  const { prepareBrowserDebugging } = require("../electron/browser-debugging.cjs");
  for (const content of [
    `0\n/devtools/browser/${newId}\n`,
    `65536\n/devtools/browser/${newId}\n`,
    "42345\n/devtools/browser/not-a-browser-id\n",
    `42345\nws://example.com/devtools/browser/${newId}\n`,
  ]) {
    const { app, portFile } = fixture();
    const resolvePort = prepareBrowserDebugging(app);
    fs.writeFileSync(portFile, content);
    await assert.rejects(resolvePort(), /automation port record is invalid/);
  }
});

test("browser debugging refuses late switch configuration before disk IO", t => {
  const { prepareBrowserDebugging } = require("../electron/browser-debugging.cjs");
  const { app, calls } = fixture(true);
  let diskReads = 0;
  t.mock.method(fs, "readFileSync", () => { diskReads++; assert.fail("late disk read"); });
  assert.throws(() => prepareBrowserDebugging(app), /before Electron is ready/);
  assert.equal(diskReads, 0);
  assert.deepEqual(calls, []);
});

function startupFixture(gotLock = true) {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const begin = source.indexOf("async function start()");
  const end = source.indexOf("  const stateStore =", begin);
  assert.ok(begin >= 0 && end > begin, "execute the actual startup through its first window-independent phase");
  let ready = false;
  const calls = [];
  const app = {
    isPackaged: false,
    requestSingleInstanceLock: () => gotLock,
    quit: () => calls.push("quit"),
    on: () => {},
    commandLine: { appendSwitch: (name, value) => {
      assert.equal(ready, false, "Browser flags applied after Electron became ready");
      calls.push([name, value]);
    } },
    whenReady: async () => { ready = true; },
  };
  const context = {
    app, fs, path, cdpPort: 0, IS_DEV_PROFILE: false, CORE_HOME: "G:/fixture",
    process: { platform: "test", resourcesPath: "G:/fixture/runtime", execPath: "G:/fixture/app.exe" },
    preparePackagedRuntime: async () => { ready = true; return "G:/fixture/runtime"; },
    ensurePackagedRuntime: () => assert.fail("the prepared runtime must be reused"),
    findFreePort: async () => 42424,
    session: { defaultSession: { setCertificateVerifyProc: () => {} } },
    caDistrust: { verifyCertificate: () => {} },
    prepareBrowserDebugging: () => {
      app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
      app.commandLine.appendSwitch("remote-debugging-port", "0");
      return async () => { assert.equal(ready, true); return 42424; };
    },
  };
  return { calls, context, run: () => vm.runInNewContext(`(${source.slice(begin, end)}return cdpPort;\n})()`, context) };
}

test("slow runtime preparation cannot move browser flags past Electron readiness", async () => {
  const { run, calls, context } = startupFixture();
  await assert.doesNotReject(run);
  assert.equal(context.cdpPort, 42424);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "remote-debugging-port" && call[1] === "0"));
});

test("secondary launches do not configure a browser automation port", async () => {
  const { run, calls } = startupFixture(false);
  await run();
  assert.deepEqual(calls, ["quit"]);
});

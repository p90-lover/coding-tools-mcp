"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  SPI_SETSCREENREADER,
  WM_SETTINGCHANGE,
  FIRST_CHECK_MS,
  CHANGE_SETTLE_MS,
  SCREEN_READER_SCRIPT,
  accessibilityMode,
  blocksAtLaunch,
  applyLaunchSwitch,
  readScreenReaderFlag,
  createRendererAccessibility,
} = require("../electron/renderer-accessibility.cjs");

function fakeApp() {
  const app = {
    switches: [],
    calls: [],
    features: [],
    commandLine: { appendSwitch: (name) => app.switches.push(name) },
    setAccessibilitySupportEnabled(on) {
      app.calls.push(on);
      app.features = on ? ["nativeAPIs", "webContents", "inlineTextBoxes", "extendedProperties"] : [];
    },
    getAccessibilitySupportFeatures: () => app.features,
    isAccessibilitySupportEnabled: () => app.features.length > 0,
  };
  return app;
}

// Timers the test fires by hand: { ms, fire }.
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; pending.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    async fireAll() {
      for (const timer of pending.splice(0)) if (!timer.cleared) timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function controller({ launch = { mode: "auto", blocked: true }, mode = "auto", flags = [], platform = "win32" } = {}) {
  const app = fakeApp();
  const timers = fakeTimers();
  const logs = [];
  const state = { mode };
  let reads = 0;
  const accessibility = createRendererAccessibility({
    app, launch, platform, readMode: () => state.mode,
    logger: { info: (event, data) => logs.push({ event, data }), warn: (event, data) => logs.push({ event, data }) },
    readScreenReader: async () => (reads < flags.length ? flags[reads++] : flags[flags.length - 1] ?? null),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { app, timers, logs, state, accessibility, reads: () => reads };
}

test("saved modes: anything but auto, on or off reads as auto; only off, or auto on Windows, blocks at launch", () => {
  assert.equal(accessibilityMode("on"), "on");
  assert.equal(accessibilityMode("off"), "off");
  assert.equal(accessibilityMode(undefined), "auto");
  assert.equal(accessibilityMode("ON"), "auto");
  assert.equal(blocksAtLaunch("auto", "win32"), true);
  assert.equal(blocksAtLaunch("off", "win32"), true);
  assert.equal(blocksAtLaunch("on", "win32"), false);
  // Without a screen reader check, auto leaves Chromium alone (VoiceOver and Orca keep working).
  assert.equal(blocksAtLaunch("auto", "darwin"), false);
  assert.equal(blocksAtLaunch("off", "linux"), true);
});

test("the launch switch follows the saved mode and falls back to auto when the settings cannot be read", () => {
  const cases = [
    [JSON.stringify({ version: 1, rendererAccessibility: "on" }), "win32", { mode: "on", blocked: false }],
    [JSON.stringify({ version: 1, rendererAccessibility: "off" }), "win32", { mode: "off", blocked: true }],
    [JSON.stringify({ version: 1 }), "win32", { mode: "auto", blocked: true }],
    ["{torn", "win32", { mode: "auto", blocked: true }],
    [null, "win32", { mode: "auto", blocked: true }],
    [JSON.stringify({ version: 1 }), "darwin", { mode: "auto", blocked: false }],
  ];
  for (const [text, platform, expected] of cases) {
    const app = fakeApp();
    const result = applyLaunchSwitch(app, "launcher-state.json", {
      platform, readFile: () => { if (text === null) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return text; },
    });
    assert.deepEqual(result, expected, `${text} on ${platform}`);
    assert.deepEqual(app.switches, expected.blocked ? ["disable-renderer-accessibility"] : []);
  }
});

test("main decides the switch in start()'s first tick, before any await", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const start = source.slice(source.indexOf("async function start() {"));
  const switchAt = start.indexOf("applyRendererAccessibilitySwitch(app,");
  assert.ok(switchAt > 0, "start() applies the accessibility switch");
  assert.equal(start.slice(0, switchAt).includes("await "), false, "no await comes before the switch");
});

test("auto: a screen reader found after start turns accessibility on; Windows announcing it gone turns it off", async () => {
  const { app, timers, logs, accessibility } = controller({ flags: [true, false] });
  accessibility.start();
  assert.deepEqual(timers.pending.map((timer) => timer.ms), [FIRST_CHECK_MS]);
  assert.deepEqual(app.calls, [], "nothing changes before the first check");
  await timers.fireAll();
  assert.deepEqual(app.calls, [true]);
  assert.deepEqual(accessibility.status(), { mode: "auto", active: true, screenReader: true, restartNeeded: false });
  assert.ok(logs.some((entry) => entry.event === "launcher.renderer_accessibility" && entry.data.on && entry.data.reason === "screen-reader"));

  let hook = null;
  accessibility.watchWindow({ hookWindowMessage: (message, callback) => { assert.equal(message, WM_SETTINGCHANGE); hook = callback; } });
  const wParam = (value) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
  hook(wParam(0x2f)); // another setting: ignored
  assert.equal(timers.pending.length, 0);
  hook(wParam(SPI_SETSCREENREADER));
  hook(wParam(SPI_SETSCREENREADER));
  assert.deepEqual(timers.pending.filter((timer) => !timer.cleared).map((timer) => timer.ms), [CHANGE_SETTLE_MS], "a burst of changes is one check");
  await timers.fireAll();
  assert.deepEqual(app.calls, [true, false]);
  assert.equal(accessibility.status().active, false);
});

test("auto: no screen reader leaves it off, and a flag that cannot be read changes nothing", async () => {
  const { app, timers, accessibility } = controller({ flags: [null] });
  accessibility.start();
  await timers.fireAll();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(accessibility.status(), { mode: "auto", active: false, screenReader: null, restartNeeded: false });
});

test("Settings: on and off apply at once after a blocked start, and auto checks again", async () => {
  const { app, state, accessibility, reads } = controller({ flags: [false] });
  state.mode = "on";
  assert.deepEqual(await accessibility.apply(), { mode: "on", active: true, screenReader: null, restartNeeded: false });
  assert.equal(reads(), 0, "on and off need no screen reader check");
  state.mode = "off";
  assert.equal((await accessibility.apply()).active, false);
  state.mode = "auto";
  assert.deepEqual(await accessibility.apply(), { mode: "auto", active: false, screenReader: false, restartNeeded: false });
  assert.equal(reads(), 1);
  assert.deepEqual(app.calls, [true, false]);
});

test("a launch in on mode never overrides Chromium, and turning it off waits for a restart", async () => {
  const { app, timers, state, accessibility } = controller({ launch: { mode: "on", blocked: false }, mode: "on", flags: [true] });
  accessibility.start();
  let hooked = false;
  accessibility.watchWindow({ hookWindowMessage: () => { hooked = true; } });
  assert.equal(timers.pending.length, 0);
  assert.equal(hooked, false);
  state.mode = "off";
  assert.deepEqual(await accessibility.apply(), { mode: "off", active: false, screenReader: null, restartNeeded: true });
  state.mode = "auto";
  assert.equal((await accessibility.apply()).restartNeeded, true);
  assert.deepEqual(app.calls, [], "only the launch switch can keep clients from turning it on");
});

test("a launch in off mode stays off and never checks for a screen reader", async () => {
  const { app, timers, accessibility, reads } = controller({ launch: { mode: "off", blocked: true }, mode: "off", flags: [true] });
  accessibility.start();
  await timers.fireAll();
  assert.equal(reads(), 0);
  assert.deepEqual(app.calls, []);
});

test("Windows' flag is read off the main thread through PowerShell and parsed", async () => {
  const runs = [];
  const run = (stdout, error = null) => (file, args, options, callback) => { runs.push({ file, args, options }); callback(error, stdout, ""); };
  assert.equal(await readScreenReaderFlag(run("screenReader=1\r\n")), true);
  assert.equal(await readScreenReaderFlag(run("screenReader=0\r\n")), false);
  assert.equal(await readScreenReaderFlag(run("screenReader=unknown\r\n")), null);
  assert.equal(await readScreenReaderFlag(run("", new Error("powershell.exe exited with 1"))), null);
  const { file, args, options } = runs[0];
  assert.match(file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.equal(Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le"), SCREEN_READER_SCRIPT);
  assert.ok(options.timeout > 0);
  // No Add-Type: it would start the C# compiler on every launch.
  assert.equal(/Add-Type/i.test(SCREEN_READER_SCRIPT), false);
  assert.match(SCREEN_READER_SCRIPT, /SetImplementationFlags\('PreserveSig'\)/);
});

test("the state store keeps a valid saved mode, drops any other, and the launch reads what it saved", async () => {
  const { createStateStore } = require("../electron/state.cjs");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coding-tools-accessibility-state-"));
  try {
    const file = path.join(root, "launcher-state.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, rendererAccessibility: "always" }));
    assert.equal(Object.hasOwn(createStateStore(file).read(), "rendererAccessibility"), false);
    const store = createStateStore(file);
    store.update({ rendererAccessibility: "on" });
    await store.saved();
    assert.equal(createStateStore(file).read().rendererAccessibility, "on");
    assert.deepEqual(applyLaunchSwitch(fakeApp(), file, { platform: "win32" }), { mode: "on", blocked: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

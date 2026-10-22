"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRtk } = require("../electron/rtk.cjs");

const RTK = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\rtk.exe";

/** A fake rtk: --version answers `version`; rewrite answers from `rewrites` ({ command: [status, stdout] }). */
function world({ version = "rtk 1.0.1", rewrites = {}, enabled = true, files = [RTK] } = {}) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push([file, ...args]);
    if (args[0] === "--version") return { status: 0, stdout: `${version}\n` };
    if (args[0] === "rewrite") {
      assert.equal(options.env.RTK_REWRITE_HOST, undefined, "the approval-relaxing channel never reaches rtk");
      const [status, stdout = ""] = rewrites[args[1]] ?? [1, ""];
      return { status, stdout };
    }
    if (args[0] === "gain") return args.includes("json") ? { status: 0, stdout: '{"total_saved":1234}' } : { status: 0, stdout: "RTK savings: 1.2K tokens" };
    return { status: 1, stdout: "" };
  };
  const rtk = createRtk({ getEnabled: () => enabled, platform: "win32", run, now: () => 0, exists: (file) => files.includes(file),
    env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", RTK_REWRITE_HOST: "1" } });
  return { rtk, calls };
}

test("rtk is found in WinGet's Links folder, and only a real rtk at least 0.23.0 counts", async () => {
  assert.deepEqual(await world().rtk.status(), { enabled: true, installed: true, installing: false, path: RTK, version: "1.0.1", minimum: "0.23.0", installCommand: "winget install rtk-ai.rtk" });
  // Another crates.io project is also called rtk; an old rtk has no `rewrite`.
  for (const version of ["rtk-tui 0.4.0", "rtk 0.22.9", "something else"]) {
    assert.equal((await world({ version }).rtk.status()).installed, false, version);
  }
  assert.equal((await world({ files: [] }).rtk.status()).installed, false);
});

test("the RTK page's status looks rtk up without blocking, and an agent's rewrite meanwhile keeps the cached answer", async () => {
  // status() ran `rtk --version` through spawnSync (5 s timeout) on the main process each time.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let lookups = 0;
  const rtk = createRtk({ getEnabled: () => true, platform: "win32", now: () => 0, exists: (file) => file === RTK,
    env: { PATH: "", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    run: async (_file, args) => {
      if (args[0] === "--version") { lookups += 1; if (lookups > 1) await gate; return { status: 0, stdout: "rtk 1.0.1\n" }; }
      return { status: 0, stdout: "rtk git status" };
    } });
  assert.equal(await rtk.rewrite("git status"), `"${RTK}" git status`);
  const pending = rtk.status();
  assert.ok(pending instanceof Promise, "status resolves later instead of blocking");
  assert.equal(await rtk.rewrite("git status"), `"${RTK}" git status`, "a rewrite does not wait for the page's lookup");
  release();
  assert.equal((await pending).installed, true);
  assert.equal(lookups, 2);
});

test("a command runs as rtk's rewrite on exit 0 or 3, and as written otherwise", async () => {
  const { rtk } = world({ rewrites: {
    "git status": [0, "rtk git status\n"],
    "cargo test --all": [3, "rtk cargo test --all"],
    "rm -rf build": [2, ""],
    "echo hi": [1, ""],
    "cd app && git log -5": [0, "cd app && rtk git log -5"],
    "two lines": [0, "rtk a\nrtk b"],
  } });
  assert.equal(await rtk.rewrite("git status"), `"${RTK}" git status`, "rtk's full path, quoted, so it runs where its folder is not on PATH");
  assert.equal(await rtk.rewrite("cargo test --all"), `"${RTK}" cargo test --all`, "an ask rule still rewrites; the chat's own approval reviews it");
  assert.equal(await rtk.rewrite("rm -rf build"), null, "a deny rule runs the original");
  assert.equal(await rtk.rewrite("echo hi"), null, "no rtk equivalent runs the original");
  assert.equal(await rtk.rewrite("cd app && git log -5"), `cd app && "${RTK}" git log -5`);
  assert.equal(await rtk.rewrite("two lines"), null, "a multi-line answer is not trusted");
  assert.equal(await rtk.rewrite(""), null);
  assert.equal(await rtk.rewrite("x".repeat(20_000)), null, "an oversized command is left alone");
});

test("turned off, nothing is rewritten and Claude Code gets no hook", async () => {
  const { rtk, calls } = world({ enabled: false, rewrites: { "git status": [0, "rtk git status"] } });
  assert.equal(await rtk.rewrite("git status"), null);
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: "" }, "an empty hook turns it off in AO");
  assert.equal(rtk.binDir(), "");
  assert.ok(!calls.some((call) => call[1] === "rewrite"), "rtk is not even asked");
});

test("turned off while rtk is rewriting, the command runs as written", async () => {
  // Codex review: the app answers other work while rtk runs now, so the switch can change meanwhile.
  let enabled = true;
  const RTK_LINK = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\rtk.exe";
  const rtk = createRtk({ getEnabled: () => enabled, platform: "win32", now: () => 0, exists: (file) => file === RTK_LINK,
    env: { PATH: "", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    run: (_file, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "rtk 0.50.0\n" };
      enabled = false; // the person turns RTK off while this rewrite is running
      return { status: 0, stdout: "rtk git status" };
    } });
  assert.equal(await rtk.rewrite("git status"), null);
});

test("on, Claude Code's hook and the agents' PATH point at the installed rtk", () => {
  const { rtk } = world();
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: `"${RTK}" hook claude` });
  assert.equal(rtk.binDir(), path.dirname(RTK));
});

test("AO's hook and PATH use the rtk at hand once looked up, refreshing a stale answer without blocking", async () => {
  let clock = 0;
  let lookups = 0;
  const rtk = createRtk({ getEnabled: () => true, platform: "win32", now: () => clock, exists: (file) => file === RTK,
    env: { PATH: "", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    run: (_file, args) => { if (args[0] === "--version") lookups += 1; return { status: 0, stdout: "rtk 1.0.1\n" }; } });
  assert.equal(rtk.binDir(), path.dirname(RTK), "the first answer is looked up");
  assert.equal(lookups, 1);
  clock = 10 * 60_000;
  // Stale: answered from what is known now; the lookup runs in the background (an async run).
  assert.equal(rtk.claudeHook(), `"${RTK}" hook claude`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 2, "refreshed in the background");
  assert.equal(rtk.binDir(), path.dirname(RTK));
  assert.equal(lookups, 2, "a fresh answer is not looked up again");
});

test("a rewritten command is judged as the command it wraps", () => {
  const { rtk } = world();
  rtk.locate();
  assert.equal(rtk.unwrap(`"${RTK}" git status`), "git status");
  assert.equal(rtk.unwrap("rtk git push origin main"), "git push origin main", "a push is still a push");
  assert.equal(rtk.unwrap(`cd app && "${RTK}" git log -5`), "cd app && git log -5");
  assert.equal(rtk.unwrap("echo rtk is fine"), "echo rtk is fine", "only rtk in command position is removed");
});

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const PACKAGES = path.join(LOCAL, "Microsoft", "WinGet", "Packages");
const PACKAGED = path.join(PACKAGES, "rtk-ai.rtk_Microsoft.Winget.Source_8wekyb3d8bbwe", "rtk.exe");

/** A machine where winget may install rtk: `install()` makes PACKAGED appear when winget exits with `code`. */
function machine({ installed = false, enabled = true, code = 0, now = () => 0 } = {}) {
  const files = new Set(installed ? [PACKAGED] : []);
  const winget = [];
  const { EventEmitter } = require("node:events");
  const spawnProcess = (file, args) => {
    const child = new EventEmitter();
    winget.push({ file, args, child, finish: () => {
      if (code === 0) files.add(PACKAGED);
      child.emit("close", code);
    } });
    return child;
  };
  const rtk = createRtk({ getEnabled: () => enabled, platform: "win32", now, spawnProcess,
    run: (_file, args) => (args[0] === "--version" ? { status: 0, stdout: "rtk 0.50.0\n" } : { status: 1, stdout: "" }),
    exists: (file) => files.has(file),
    listDir: (dir) => (dir === PACKAGES && files.size ? [path.basename(path.dirname(PACKAGED))] : []),
    env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: LOCAL } });
  return { rtk, winget };
}

test("rtk winget unpacked into its Packages folder is found: no Links shim, its PATH entry not seen yet", async () => {
  const { rtk } = machine({ installed: true });
  assert.equal((await rtk.status()).path, PACKAGED);
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: `"${PACKAGED}" hook claude` });
  assert.equal(rtk.binDir(), path.dirname(PACKAGED), "AO's agents get its folder on PATH");
});

test("missing rtk is installed at startup without a click, once, and every harness gets it", async () => {
  const { rtk, winget } = machine();
  const stamps = [];
  const first = rtk.autoInstall({ record: (at) => stamps.push(at) });
  // rtk is looked up first, without blocking; winget starts once that answers "missing".
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(winget.length, 1);
  assert.deepEqual(winget[0].args.slice(0, 4), ["install", "--id", "rtk-ai.rtk", "-e"]);
  assert.ok(winget[0].args.includes("--silent") && winget[0].args.includes("--accept-package-agreements"), "no prompt to answer");
  assert.equal((await rtk.status()).installing, true);
  // The person's click, or a second start, joins the same install.
  rtk.install();
  rtk.autoInstall();
  assert.equal(winget.length, 1, "one winget at a time");
  winget[0].finish();
  const result = await first;
  assert.equal(result.status.installed, true);
  assert.equal((await rtk.status()).installing, false);
  assert.deepEqual(stamps, [0]);
  assert.equal(rtk.claudeHook(), `"${PACKAGED}" hook claude`);
});

test("an automatic install is skipped when rtk is there or off, and a failed one waits a day", async () => {
  for (const options of [{ installed: true }, { enabled: false }]) {
    const { rtk, winget } = machine(options);
    assert.equal(await rtk.autoInstall(), null);
    assert.equal(winget.length, 0, JSON.stringify(options));
  }
  const DAY = 24 * 60 * 60 * 1000;
  let clock = 10 * DAY;
  const { rtk, winget } = machine({ code: 1, now: () => clock });
  await rtk.autoInstall({ lastAttemptAt: clock - DAY + 60_000 });
  assert.equal(winget.length, 0, "tried less than a day ago");
  const retried = rtk.autoInstall({ lastAttemptAt: clock - DAY - 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(winget.length, 1, "a day later it tries again");
  winget[0].finish();
  assert.equal((await retried).status.installed, false);
  // No winget at all (spawn fails): the startup carries on.
  const broken = createRtk({ platform: "win32", now: () => clock, env: { LOCALAPPDATA: LOCAL }, exists: () => false, listDir: () => [],
    spawnProcess: () => { const { EventEmitter } = require("node:events"); const child = new EventEmitter(); setImmediate(() => child.emit("error", new Error("spawn winget ENOENT"))); return child; } });
  assert.equal(await broken.autoInstall(), null);
  assert.equal((await broken.status()).installing, false);
});

test("AO's start waits for an install in progress, but not past its bound", async () => {
  const { rtk, winget } = machine();
  await rtk.ready(10);
  void rtk.autoInstall();
  let done = false;
  const waiting = rtk.ready(60_000).then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "still installing");
  winget[0].finish();
  await waiting;
  assert.equal(rtk.binDir(), path.dirname(PACKAGED), "the daemon starts with rtk's folder");
  const { rtk: slow } = machine();
  void slow.autoInstall();
  const started = Date.now();
  await slow.ready(20);
  assert.ok(Date.now() - started < 2_000, "a hung install does not hold AO back");
});

test("rtk's savings report is read as text and JSON", async () => {
  assert.deepEqual(await world().rtk.gain(), { available: true, text: "RTK savings: 1.2K tokens", data: { total_saved: 1234 } });
  assert.deepEqual(await world({ files: [] }).rtk.gain(), { available: false });
});

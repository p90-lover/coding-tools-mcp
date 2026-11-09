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
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: "", CODING_TOOLS_RTK_CODEX_HOOK: "", CODING_TOOLS_RTK_OPENCODE_PLUGIN: "" }, "an empty hook turns it off in AO");
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
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: `"${RTK}" hook claude`, CODING_TOOLS_RTK_CODEX_HOOK: "rtk hook codex", CODING_TOOLS_RTK_OPENCODE_PLUGIN: "", RTK_SUPPRESS_HOOK_WARNING: "1" });
  assert.equal(rtk.binDir(), path.dirname(RTK));
});

test("Codex's hook names rtk bare, the PATH's first rtk, and only an rtk with `hook codex` gets it", () => {
  // Codex runs a hook with the turn's shell, PowerShell on Windows, where `"C:\...\rtk.exe" hook codex`
  // is a syntax error: every hook run exited 1 and nothing was rewritten (codex 0.164.0, 2026-11-09).
  // Named bare, it is the rtk at the front of the agents' PATH, the same one `rtk git status` then runs.
  for (const [version, hook] of [["rtk 1.2.0", "rtk hook codex"], ["rtk 1.0.1", "rtk hook codex"], ["rtk 1.0.0", ""], ["rtk 0.50.0", ""]]) {
    const { rtk } = world({ version });
    assert.equal(rtk.codexHook(), hook, version);
    assert.equal(rtk.daemonEnvironment().CODING_TOOLS_RTK_CODEX_HOOK, hook, version);
    assert.equal(rtk.daemonEnvironment().CODING_TOOLS_RTK_CLAUDE_HOOK, `"${RTK}" hook claude`, `${version}: Claude's hook doesn't depend on it`);
    assert.equal(rtk.binDir(), path.dirname(RTK), `${version}: rtk's folder still leads the agents' PATH`);
  }
  assert.equal(world({ enabled: false }).rtk.codexHook(), "", "off");
  assert.equal(world({ files: [] }).rtk.codexHook(), "", "missing");
});

test("rtk never tells an agent or the RTK page \"No hook installed\" while the app hooks each session", async () => {
  // Claude Code's Bash tool showed rtk's "No hook installed — run `rtk init -g`" atop 952 agent
  // outputs in two days: the app adds the hook per session and never edits the global settings.
  const { rtk } = world();
  const seen = [];
  const quietRtk = createRtk({ getEnabled: () => true, platform: "win32", now: () => 0, exists: (file) => file === RTK,
    env: { PATH: "", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    run: (_file, args, options) => {
      seen.push([args[0], options?.env?.RTK_SUPPRESS_HOOK_WARNING]);
      if (args[0] === "--version") return { status: 0, stdout: "rtk 1.0.1\n" };
      if (args[0] === "rewrite") return { status: 3, stdout: "rtk git status" };
      return { status: 0, stdout: "{}" };
    } });
  assert.deepEqual(rtk.commandEnvironment(), { RTK_SUPPRESS_HOOK_WARNING: "1" }, "the terminal tool's commands");
  assert.equal(await quietRtk.rewrite("git status"), `"${RTK}" git status`);
  await quietRtk.gain();
  assert.deepEqual(seen.filter(([command]) => command !== "--version"), [["rewrite", "1"], ["gain", "1"], ["gain", "1"]]);
  const off = world({ enabled: false });
  assert.deepEqual(off.rtk.commandEnvironment(), {}, "off, commands run exactly as written");
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

test("AO's timed-out first RTK lookup stays asynchronous for its hook and PATH", async (t) => {
  const childProcess = require("node:child_process");
  const offThread = require("../electron/off-thread-run.cjs");
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let syncLookups = 0, asyncLookups = 0, installs = 0;
  t.mock.method(childProcess, "spawnSync", () => {
    syncLookups += 1;
    return { status: 0, stdout: "rtk 1.0.1\n" };
  });
  t.mock.method(childProcess, "spawn", () => { installs += 1; throw new Error("No installation in this test"); });
  t.mock.method(offThread, "runOffThread", ({ file, args, timeoutMs }) => {
    assert.equal(file, RTK);
    assert.deepEqual(args, ["--version"]);
    assert.equal(timeoutMs, 5_000);
    asyncLookups += 1;
    return pending;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Load with the stand-in spawnSync as the default, preserving run === spawnSync.
  const modulePath = require.resolve("../electron/rtk.cjs");
  const cached = require.cache[modulePath];
  let fresh;
  delete require.cache[modulePath];
  try { fresh = require(modulePath); } finally { require.cache[modulePath] = cached; }
  const rtk = fresh.createRtk({ platform: "win32", now: () => 0,
    env: { CODING_TOOLS_RTK: RTK }, exists: (file) => file === RTK, listDir: () => [] });
  const checking = rtk.autoInstall();
  try {
    const waiting = rtk.ready(15_000);
    t.mock.timers.tick(15_000);
    await waiting;
    assert.equal(asyncLookups, 1, "the worker lookup is still pending after readiness expires");
    assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: "", CODING_TOOLS_RTK_CODEX_HOOK: "", CODING_TOOLS_RTK_OPENCODE_PLUGIN: "" });
    assert.equal(rtk.binDir(), "");
    assert.equal(syncLookups, 0, "the environment does not restart that lookup on the caller");
    assert.equal(asyncLookups, 1, "the readers leave the existing lookup running");
  } finally {
    release({ code: 0, stdout: "rtk 1.0.1\n" });
    await checking;
  }
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: '"' + RTK + '" hook claude', CODING_TOOLS_RTK_CODEX_HOOK: "rtk hook codex", CODING_TOOLS_RTK_OPENCODE_PLUGIN: "", RTK_SUPPRESS_HOOK_WARNING: "1" });
  assert.equal(rtk.binDir(), path.dirname(RTK));
  assert.equal(syncLookups, 0);
  assert.equal(installs, 0);
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
  // This machine's rtk 0.50.0 predates `rtk hook codex`.
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: `"${PACKAGED}" hook claude`, CODING_TOOLS_RTK_CODEX_HOOK: "", CODING_TOOLS_RTK_OPENCODE_PLUGIN: "", RTK_SUPPRESS_HOOK_WARNING: "1" });
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

test("App plugins' update runs winget upgrade for rtk-ai.rtk, one winget at a time", async () => {
  const { rtk, winget } = machine({ installed: true });
  const upgraded = rtk.upgrade();
  assert.deepEqual(winget[0].args.slice(0, 4), ["upgrade", "--id", "rtk-ai.rtk", "--exact"]);
  assert.ok(winget[0].args.includes("--silent") && winget[0].args.includes("--accept-source-agreements"), "no prompt to answer");
  assert.equal(rtk.install(), upgraded, "an install meanwhile joins the upgrade");
  winget[0].finish();
  const result = await upgraded;
  assert.deepEqual([result.code, result.status.version], [0, "0.50.0"]);
  assert.equal(winget.length, 1);
  await assert.rejects(createRtk({ platform: "linux" }).upgrade(), /brew upgrade rtk/);
});

test("winget's refusal to replace a modified portable rtk is answered once with --force", async () => {
  const { EventEmitter } = require("node:events");
  const runs = [];
  const spawnProcess = (_file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    runs.push(args);
    setImmediate(() => {
      const refused = runs.length === 1;
      if (refused) child.stdout.emit("data", "Unable to remove Portable package as it has been modified; to override this check use --force\n");
      child.emit("close", refused ? 2316632151 : 0);
    });
    return child;
  };
  const rtk = createRtk({ getEnabled: () => true, platform: "win32", spawnProcess,
    run: (_file, args) => (args[0] === "--version" ? { status: 0, stdout: "rtk 0.50.0\n" } : { status: 1, stdout: "" }),
    exists: (file) => file === PACKAGED, listDir: () => [path.basename(path.dirname(PACKAGED))],
    env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: LOCAL } });
  const upgraded = rtk.upgrade();
  assert.equal(rtk.install(), upgraded, "the retry stays inside the one winget turn");
  const result = await upgraded;
  assert.equal(runs.length, 2);
  assert.ok(!runs[0].includes("--force") && runs[1].includes("--force"));
  assert.equal(result.code, 0);
  assert.equal((await rtk.status()).installing, false);
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

// The OpenCode plugin's folder, as main.cjs names it under the launcher's data ("Coding Tools" has a space).
const pluginRuns = [];
test.after(() => { for (const run of pluginRuns) require("node:fs").rmSync(run, { recursive: true, force: true }); });
function pluginFolder() {
  const fs = require("node:fs");
  const root = path.resolve(__dirname, "../../aiTemp/rtk-opencode-plugin-tests");
  fs.mkdirSync(root, { recursive: true });
  const run = fs.mkdtempSync(path.join(root, "run-"));
  pluginRuns.push(run);
  return path.join(run, "Coding Tools", "rtk", "opencode");
}

/** world() with the OpenCode plugin's folder. */
function pluginWorld({ version = "rtk 1.2.0", enabled = true, files = [RTK], pluginDir = pluginFolder(), logger = null } = {}) {
  const rtk = createRtk({ getEnabled: () => enabled, platform: "win32", now: () => 0, exists: (file) => files.includes(file), logger, pluginDir,
    run: (_file, args) => (args[0] === "--version" ? { status: 0, stdout: `${version}\n` } : { status: 1, stdout: "" }),
    env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
  return { rtk, pluginDir, file: path.join(pluginDir, "rtk.ts") };
}

test("OpenCode chats get the plugin AO's start wrote, from an rtk with `rtk hook opencode` only", async () => {
  const fs = require("node:fs");
  const { rtk, file } = pluginWorld();
  assert.equal(rtk.opencodePlugin(), "", "nothing to list before the file is written");
  await rtk.ready(5_000);
  assert.equal(rtk.daemonEnvironment().CODING_TOOLS_RTK_OPENCODE_PLUGIN, file);
  const plugin = fs.readFileSync(file, "utf8");
  assert.match(plugin, /execFile\("rtk", args/, "rtk named bare: the PATH's rtk, which the rewritten command runs too");
  assert.match(plugin, /\["hook", "opencode", \.\.\.\(agent \? \["--agent", agent\] : \[\]\), command\]/);
  assert.match(plugin, /async server\(\)/, "OpenCode 1.x's entry point");
  assert.match(plugin, /async setup\(ctx: any\)/, "OpenCode 2.x's entry point");

  // `rtk hook opencode` landed in 0.52.0; the other hooks keep their own floors.
  for (const [version, listed] of [["rtk 0.52.0", true], ["rtk 0.51.9", false]]) {
    const older = pluginWorld({ version });
    await older.rtk.ready(5_000);
    assert.equal(older.rtk.opencodePlugin(), listed ? older.file : "", version);
    assert.ok(fs.existsSync(older.file), `${version}: the file is written either way`);
  }
  const off = pluginWorld({ enabled: false });
  await off.rtk.ready(5_000);
  assert.deepEqual(off.rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: "", CODING_TOOLS_RTK_CODEX_HOOK: "", CODING_TOOLS_RTK_OPENCODE_PLUGIN: "" }, "off");
  const missing = pluginWorld({ files: [] });
  await missing.rtk.ready(5_000);
  assert.equal(missing.rtk.opencodePlugin(), "", "no rtk");
  const noFolder = createRtk({ platform: "win32", now: () => 0, exists: (file) => file === RTK,
    run: () => ({ status: 0, stdout: "rtk 1.2.0\n" }), env: { PATH: "", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
  await noFolder.ready(5_000);
  assert.equal(noFolder.opencodePlugin(), "", "no folder, no plugin");
});

test("the OpenCode plugin's file is replaced only when it differs, and a failed write leaves OpenCode without it", async () => {
  const fs = require("node:fs");
  const first = pluginWorld();
  fs.mkdirSync(first.pluginDir, { recursive: true });
  fs.writeFileSync(first.file, "// an older plugin\n");
  await first.rtk.ready(5_000);
  const written = fs.readFileSync(first.file, "utf8");
  assert.notEqual(written, "// an older plugin\n", "an older plugin is replaced");

  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(first.file, old, old);
  const again = pluginWorld({ pluginDir: first.pluginDir });
  await again.rtk.ready(5_000);
  assert.equal(fs.statSync(again.file).mtimeMs, old.getTime(), "the same plugin is not written again");
  assert.equal(again.rtk.opencodePlugin(), again.file);

  // A file where its folder should be: the write fails, is logged, and is tried at the next start.
  const blocked = pluginFolder();
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, "not a folder");
  const warnings = [];
  const failing = pluginWorld({ pluginDir: blocked, logger: { warn: (event) => warnings.push(event) } });
  await failing.rtk.ready(5_000);
  assert.equal(failing.rtk.opencodePlugin(), "");
  assert.deepEqual(warnings, ["rtk.opencode_plugin_failed"]);
  fs.rmSync(blocked);
  await failing.rtk.ready(5_000);
  assert.equal(failing.rtk.opencodePlugin(), path.join(blocked, "rtk.ts"), "the next start writes it");
});

test("the OpenCode plugin rewrites only the bash tool's command, with rtk's answer, and fails open", async (t) => {
  // OpenCode runs the plugin as TypeScript; here it is compiled to CommonJS so execFile can be stubbed.
  const fs = require("node:fs");
  const ts = require("typescript");
  const childProcess = require("node:child_process");
  const { rtk, file } = pluginWorld();
  await rtk.ready(5_000);
  const source = fs.readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  assert.deepEqual(compiled.diagnostics, [], "valid TypeScript (the template literal kept it intact)");

  const asked = [];
  let answer = (command) => [null, JSON.stringify(command === "git status" ? { command: "rtk git status" } : {})];
  t.mock.method(childProcess, "execFile", (bin, args, options, callback) => {
    asked.push([bin, ...args]);
    assert.equal(options.timeout, 3000);
    const [error, stdout] = answer(args.at(-1));
    callback(error, stdout);
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", compiled.outputText)(loaded, loaded.exports, require);
  const plugin = loaded.exports.default;
  assert.equal(plugin.id, "rtk");

  // OpenCode 1.x: server() returns the hook; output.args is the call's arguments object.
  const hooks = await plugin.server();
  const before = hooks["tool.execute.before"];
  const bash = { command: "git status", description: "status" };
  await before({ tool: "bash" }, { args: bash });
  assert.equal(bash.command, "rtk git status");
  assert.deepEqual(asked.at(-1), ["rtk", "hook", "opencode", "git status"]);
  const unknown = { command: "echo hi" };
  await before({ tool: "bash" }, { args: unknown });
  assert.equal(unknown.command, "echo hi", "{} (no rtk equivalent, or a changed permission verdict) runs it as written");
  const read = { filePath: "a.txt", command: "git status" };
  const count = asked.length;
  await before({ tool: "read" }, { args: read });
  assert.equal(asked.length, count, "other tools are not asked about");
  answer = () => [new Error("spawn rtk ENOENT"), ""];
  const failed = { command: "git status" };
  await before({ tool: "bash" }, { args: failed });
  assert.equal(failed.command, "git status", "no rtk on PATH: as written");
  answer = () => [null, "not json"];
  await before({ tool: "bash" }, { args: failed });
  assert.equal(failed.command, "git status", "an unreadable answer: as written");

  // OpenCode 2.x: setup() registers the hook, and the agent's rules are rtk's to read.
  answer = () => [null, '{"command":"rtk ls -la"}'];
  let registered = null;
  await plugin.setup({ tool: { hook: async (name, handler) => { registered = [name, handler]; } } });
  assert.equal(registered[0], "execute.before");
  const input = { command: "ls -la" };
  await registered[1]({ tool: "bash", input, agent: "ao-auto" });
  assert.equal(input.command, "rtk ls -la");
  assert.deepEqual(asked.at(-1), ["rtk", "hook", "opencode", "--agent", "ao-auto", "ls -la"]);

  const saved = process.env.RTK_DISABLED;
  process.env.RTK_DISABLED = "1";
  try {
    const disabled = { command: "git status" };
    const count2 = asked.length;
    await before({ tool: "bash" }, { args: disabled });
    assert.equal(disabled.command, "git status", "RTK_DISABLED=1 in OpenCode's environment turns it off");
    assert.equal(asked.length, count2, "rtk is not even asked");
  } finally {
    if (saved === undefined) delete process.env.RTK_DISABLED;
    else process.env.RTK_DISABLED = saved;
  }
});

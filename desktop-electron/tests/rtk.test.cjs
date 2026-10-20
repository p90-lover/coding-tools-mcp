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

test("rtk is found in WinGet's Links folder, and only a real rtk at least 0.23.0 counts", () => {
  assert.deepEqual(world().rtk.status(), { enabled: true, installed: true, path: RTK, version: "1.0.1", minimum: "0.23.0", installCommand: "winget install rtk-ai.rtk" });
  // Another crates.io project is also called rtk; an old rtk has no `rewrite`.
  for (const version of ["rtk-tui 0.4.0", "rtk 0.22.9", "something else"]) {
    assert.equal(world({ version }).rtk.status().installed, false, version);
  }
  assert.equal(world({ files: [] }).rtk.status().installed, false);
});

test("a command runs as rtk's rewrite on exit 0 or 3, and as written otherwise", () => {
  const { rtk } = world({ rewrites: {
    "git status": [0, "rtk git status\n"],
    "cargo test --all": [3, "rtk cargo test --all"],
    "rm -rf build": [2, ""],
    "echo hi": [1, ""],
    "cd app && git log -5": [0, "cd app && rtk git log -5"],
    "two lines": [0, "rtk a\nrtk b"],
  } });
  assert.equal(rtk.rewrite("git status"), `"${RTK}" git status`, "rtk's full path, quoted, so it runs where its folder is not on PATH");
  assert.equal(rtk.rewrite("cargo test --all"), `"${RTK}" cargo test --all`, "an ask rule still rewrites; the chat's own approval reviews it");
  assert.equal(rtk.rewrite("rm -rf build"), null, "a deny rule runs the original");
  assert.equal(rtk.rewrite("echo hi"), null, "no rtk equivalent runs the original");
  assert.equal(rtk.rewrite("cd app && git log -5"), `cd app && "${RTK}" git log -5`);
  assert.equal(rtk.rewrite("two lines"), null, "a multi-line answer is not trusted");
  assert.equal(rtk.rewrite(""), null);
  assert.equal(rtk.rewrite("x".repeat(20_000)), null, "an oversized command is left alone");
});

test("turned off, nothing is rewritten and Claude Code gets no hook", () => {
  const { rtk, calls } = world({ enabled: false, rewrites: { "git status": [0, "rtk git status"] } });
  assert.equal(rtk.rewrite("git status"), null);
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: "" }, "an empty hook turns it off in AO");
  assert.equal(rtk.binDir(), "");
  assert.ok(!calls.some((call) => call[1] === "rewrite"), "rtk is not even asked");
});

test("on, Claude Code's hook and the agents' PATH point at the installed rtk", () => {
  const { rtk } = world();
  assert.deepEqual(rtk.daemonEnvironment(), { CODING_TOOLS_RTK_CLAUDE_HOOK: `"${RTK}" hook claude` });
  assert.equal(rtk.binDir(), path.dirname(RTK));
});

test("a rewritten command is judged as the command it wraps", () => {
  const { rtk } = world();
  rtk.locate();
  assert.equal(rtk.unwrap(`"${RTK}" git status`), "git status");
  assert.equal(rtk.unwrap("rtk git push origin main"), "git push origin main", "a push is still a push");
  assert.equal(rtk.unwrap(`cd app && "${RTK}" git log -5`), "cd app && git log -5");
  assert.equal(rtk.unwrap("echo rtk is fine"), "echo rtk is fine", "only rtk in command position is removed");
});

test("rtk's savings report is read as text and JSON", () => {
  assert.deepEqual(world().rtk.gain(), { available: true, text: "RTK savings: 1.2K tokens", data: { total_saved: 1234 } });
  assert.deepEqual(world({ files: [] }).rtk.gain(), { available: false });
});

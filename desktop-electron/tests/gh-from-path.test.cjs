"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runGhCommand, executableOnPath } = require("../electron/chat-agent-tools.cjs");

const EXE = process.platform === "win32" ? "gh.exe" : "gh";

function folders(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-from-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "worktree"), bin = path.join(root, "bin");
  for (const folder of [worktree, bin]) {
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, EXE), "");
  }
  return { worktree, bin };
}

// 2026-11-13: the chat summary's "PR #N" row ran execFile("gh", …, { cwd: <the chat's worktree> }).
// On Windows libuv looks for a bare program name in the child's cwd before PATH (unless
// NoDefaultCurrentDirectoryInExePath is set), so a gh.exe an agent or a cloned repository put in the
// worktree ran in the app's main process, outside the chat's sandbox and without an approval.
test("the PR row runs the GitHub CLI found on PATH, never one in the chat's worktree", async (t) => {
  const { worktree, bin } = folders(t);
  const savedPath = process.env.PATH;
  // A relative entry ("." or empty) would mean the worktree again: those are skipped.
  process.env.PATH = [".", "", bin].join(path.delimiter);
  t.after(() => { process.env.PATH = savedPath; });
  const runs = [];
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    runs.push({ file, cwd: options.cwd });
    callback(null, "{\"number\":1}");
  });
  const out = await runGhCommand({ cwd: worktree, args: ["pr", "view"], timeoutMs: 1000 });
  assert.equal(out, "{\"number\":1}");
  assert.equal(runs.length, 1);
  assert.ok(path.isAbsolute(runs[0].file), `ran ${runs[0].file}, a bare name`);
  assert.equal(path.normalize(runs[0].file).toLowerCase(), path.join(bin, EXE).toLowerCase());
  assert.equal(runs[0].cwd, worktree, "still run in the worktree, so gh reads its branch");
});

test("with no GitHub CLI on PATH the PR row is skipped and nothing runs", async (t) => {
  const { worktree } = folders(t);
  const savedPath = process.env.PATH;
  process.env.PATH = ["."].join(path.delimiter);
  t.after(() => { process.env.PATH = savedPath; });
  let ran = false;
  t.mock.method(childProcess, "execFile", () => { ran = true; });
  await assert.rejects(runGhCommand({ cwd: worktree, args: ["pr", "view"], timeoutMs: 1000 }), /not on PATH/);
  assert.equal(ran, false);
  assert.equal(await executableOnPath("gh", { pathValue: "", platform: process.platform }), null);
});

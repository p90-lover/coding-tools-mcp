"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { findInstalledCodexExecutable } = require("../electron/agent-orchestrator-workflow.cjs");

test("macOS/Linux discover an executable Codex CLI on PATH", { skip: process.platform === "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "codex");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(findInstalledCodexExecutable({ PATH: bin }), fs.realpathSync(executable));
  assert.equal(findInstalledCodexExecutable({ PATH: path.join(root, "missing") }), null);
});

test("Codex discovery follows package-manager symlinks and skips unusable PATH entries", { skip: process.platform === "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discovery-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = ["not-executable", "broken-link", "directory", "bin"].map(name => path.join(root, name));
  for (const directory of directories) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directories[0], "codex"), "not executable", { mode: 0o600 });
  fs.symlinkSync(path.join(root, "missing"), path.join(directories[1], "codex"));
  fs.mkdirSync(path.join(directories[2], "codex"));
  const real = path.join(root, "real-codex");
  fs.writeFileSync(real, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.symlinkSync(real, path.join(directories[3], "codex"));
  assert.equal(findInstalledCodexExecutable({ PATH: directories.join(path.delimiter) }), fs.realpathSync(real));
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const surface = fs.readFileSync(path.join(__dirname, "..", "src", "features", "AgentOrchestratorSurface.tsx"), "utf8");

// The workflow finds the installed Codex CLI when no path is given, so an empty AO setting must
// never block a start, resume or chat (it once stopped every mission with "Set the native Codex
// executable in AO settings first").
test("AO starts without a saved codex.exe and only sends a path the user set", () => {
  assert.doesNotMatch(surface, /Set the native Codex executable/);
  // The path is built in exactly one place, which omits it when the setting is empty.
  assert.equal(surface.split("executable: executable.trim()").length - 1, 1);
  assert.match(surface, /const executableArg = \(\): JsonObject => \(executable\.trim\(\) \? \{ executable: executable\.trim\(\) \} : \{\}\)/);
  assert.match(surface, /moduleCall\("codex_executable"\)/);
});

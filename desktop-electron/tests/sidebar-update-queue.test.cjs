const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const launcherShell = source.slice(source.indexOf("function LauncherShell("));

test("available desktop updates stay clickable during active Codex/browser work", () => {
  assert.match(launcherShell, /disabled=\{updateBusy\}[\s\S]*?label=\{updateLabel\}[\s\S]*?onClick=\{\(\) => void installUpdate\(\)\}/);
  assert.doesNotMatch(launcherShell, /disabled=\{updateBusy \|\| operation\?\.status/);
});

// The user: "fix the update require to be queued instead of one click to update". The browser
// reads "running" nearly all the time, so every click only queued the update.
test("one click starts the update, never a queue", () => {
  assert.match(launcherShell, /const installUpdate = \(\) => \{\s*if \(updateBusy\) return;\s*void startAvailableUpdate\(\);\s*\};/);
  assert.match(launcherShell, /const startAvailableUpdate = useCallback\(async \(\) => \{/);
  assert.doesNotMatch(launcherShell, /updateQueued|Update queued|更新已排程|updateBlockedByWork/);
});

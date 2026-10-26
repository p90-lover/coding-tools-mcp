const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const launcherShell = source.slice(source.indexOf("function LauncherShell("));

test("available desktop updates stay clickable during active Codex/browser work", () => {
  assert.match(launcherShell, /const updateBlockedByWork = operation\?\.status === "running" \|\| browser\?\.status === "running"/);
  assert.match(launcherShell, /disabled=\{updateBusy\}[\s\S]*?label=\{updateLabel\}[\s\S]*?onClick=\{\(\) => void installUpdate\(\)\}/);
  assert.doesNotMatch(launcherShell, /disabled=\{updateBusy \|\| operation\?\.status/);
});

test("an update requested during active work is queued and can be canceled", () => {
  assert.match(launcherShell, /if \(updateBlockedByWork\) \{\s*setUpdateQueued\(\(queued\) => !queued\);\s*return;/);
  assert.match(launcherShell, /Update queued \(click to cancel\)/);
  assert.match(launcherShell, /更新已排程（按一下取消）/);
});

test("queued updates begin after active work becomes idle and clear stale intent", () => {
  assert.match(launcherShell, /if \(snapshot\.update\.status !== "available"\) \{\s*setUpdateQueued\(false\);\s*return;/);
  assert.match(launcherShell, /if \(updateBlockedByWork \|\| updateBusy\) return;\s*setUpdateQueued\(false\);\s*void startAvailableUpdate\(\);/);
  assert.match(launcherShell, /const startAvailableUpdate = useCallback\(async \(\) => \{/);
});

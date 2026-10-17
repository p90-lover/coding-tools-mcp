"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RESTART_MARKER_MAX_MS, restartMarkerPath, writeRestartMarker } = require("../electron/browser-host.cjs");

test("a keep-bridge quit announces the restart next to the browser descriptor, for at most 15 minutes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restart-marker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = path.join(root, "launcher-browser.json");
  assert.equal(restartMarkerPath(descriptor), path.join(root, "launcher-browser.restarting.json"));
  const now = Date.parse("2026-10-13T08:36:28Z");
  writeRestartMarker(descriptor, { reason: "update", now });
  const marker = JSON.parse(fs.readFileSync(restartMarkerPath(descriptor), "utf8"));
  assert.equal(marker.version, 1);
  assert.equal(marker.reason, "update");
  assert.equal(marker.pid, process.pid);
  assert.equal(Date.parse(marker.until) - Date.parse(marker.createdAt), RESTART_MARKER_MAX_MS);
  assert.equal(Date.parse(marker.holdUntil) - Date.parse(marker.createdAt), 30 * 60_000, "newer bridges wait up to 30 minutes (an update took 12)");
  writeRestartMarker(descriptor, { reason: "relaunch", withinMs: 10 * RESTART_MARKER_MAX_MS, now });
  const capped = JSON.parse(fs.readFileSync(restartMarkerPath(descriptor), "utf8"));
  assert.equal(Date.parse(capped.until) - now, RESTART_MARKER_MAX_MS, "never longer than the cap");
});

test("the quit writes it only when the bridge was kept, and the new app's descriptor clears it", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  assert.match(main, /if \(detached\?\.status !== "detached"\) await runtimeSupervisor\?\.shutdown[^\n]*\n\s*else \{[\s\S]{0,400}writeRestartMarker\(BROWSER_DESCRIPTOR_PATH/);
  const host = fs.readFileSync(path.join(__dirname, "../electron/browser-host.cjs"), "utf8");
  assert.match(host, /writePrivateFileAtomic\(this\.descriptorPath[^\n]*\n[^\n]*\n\s*try \{ fs\.rmSync\(restartMarkerPath\(this\.descriptorPath\)/);
});

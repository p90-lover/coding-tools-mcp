"use strict";

// A synchronous disk or process call on Electron main holds every window until it returns, and on
// this machine's busy hard disk that is seconds: launcher.main_blocked has named 0.3-27 s calls on
// every release since 0.8.35 (main-blocking-calls.cjs), each found only after it froze the app.
// This ratchet keeps the count of `*Sync(` calls in each main-process module from growing. A new
// one fails here: read or write with fs.promises, start programs with runOffThread/spawnOffThread
// (off-thread-run.cjs), or, for a call that never runs on main or runs only at startup or quit, add
// one to that file's count below with the reason in the commit. Lower a count when you remove calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ELECTRON = path.join(__dirname, "..", "electron");
const SYNC_CALL = /\b[A-Za-z]+Sync(?:\.native)?\s*\(/g;

const ALLOWED = {
  "agent-orchestrator-accounting.cjs": 2, "agent-orchestrator-gateway.cjs": 4, "agent-orchestrator-upstream.cjs": 10,
  "agent-orchestrator-workflow.cjs": 10, "agent-orchestrator-workspace.cjs": 1, "antigravity-cli.cjs": 20,
  "ao-db-maintenance.cjs": 3, "ao-dependency-links.cjs": 7, "app-handler-paths.cjs": 1, "app-update-worker.cjs": 50,
  "app-update.cjs": 19, "atomic-file.cjs": 11, "autostart.cjs": 2, "backend-bundle.cjs": 18, "browser-accounts.cjs": 1,
  "browser-host.cjs": 3, "ca-distrust.cjs": 5, "chat-agent-tools.cjs": 10, "chat-archive.cjs": 4, "chat-edits.cjs": 4,
  "chat-goals.cjs": 2, "chat-loops.cjs": 4, "chat-mcp-servers.cjs": 1, "chat-sandbox.cjs": 5, "chat-wakeups.cjs": 4,
  "chatgpt-desktop-sync.cjs": 1, "chatgpt-desktop.cjs": 25, "codex-chat-lifecycle-sync.cjs": 9,
  "codex-thread-accounts.cjs": 2, "codex-thread-stats.cjs": 1, "computer-control.cjs": 4, "cpa-antigravity-reauth.cjs": 4,
  "cpa-codex-long-run.cjs": 6, "cpa-managed.cjs": 45, "durable-state.cjs": 5, "external-services.cjs": 27,
  "extra-tunnels.cjs": 5, "gpt-browser.cjs": 1, "gui-update.cjs": 12, "headless-host.cjs": 13, "in-use-files.cjs": 4,
  "keysmith-ipc.cjs": 3, "keysmith-managed.cjs": 11, "logging.cjs": 8, "loopback-mesh.cjs": 1, "main.cjs": 23,
  "managed-components.cjs": 62, "managed-external-services.cjs": 2, "mcp-connector-setup.cjs": 1, "original-ui.cjs": 1,
  "process-tree.cjs": 3, "profile.cjs": 3, "provider-network.cjs": 3, "proxy-gateway-retire.cjs": 2,
  "proxybridge-nova.cjs": 5, "register-host.cjs": 9, "rtk.cjs": 4, "runtime-command.cjs": 6, "runtime-install.cjs": 24,
  "runtime-supervisor.cjs": 19, "runtime.cjs": 39, "smoke-exit.cjs": 1, "subagents.cjs": 4, "update-worker.cjs": 26,
  "update.cjs": 20, "upstream-tools.cjs": 3, "window-state.cjs": 1,
};

test("no main-process module gains a synchronous disk or process call", () => {
  const grown = [];
  for (const name of fs.readdirSync(ELECTRON).filter((file) => file.endsWith(".cjs")).sort()) {
    const calls = fs.readFileSync(path.join(ELECTRON, name), "utf8").match(SYNC_CALL) ?? [];
    const allowed = ALLOWED[name] ?? 0;
    if (calls.length > allowed) grown.push(`${name}: ${calls.length} (allowed ${allowed}): ${[...new Set(calls.map((call) => call.replace(/\s*\($/, "")))].join(", ")}`);
  }
  assert.deepEqual(grown, [], "synchronous calls hold every window on Electron main; see the note at the top of this file");
});

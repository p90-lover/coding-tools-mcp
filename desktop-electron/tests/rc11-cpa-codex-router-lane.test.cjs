"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");

test("this rc.11 lane owns Codex Router and CPA original UI plus 7-day keep-alive", () => {
  const originalMain = read("electron/original-ui.cjs");
  const controlCenter = read("electron/codex-router-original-ui.cjs");
  const cpaManaged = read("electron/cpa-managed.cjs");
  const surface = read("src/features/OriginalUiSurface.tsx");
  const app = read("src/App.tsx");
  const longRun = read("electron/five-stack-long-run.cjs");
  const fiveStack = readRepo("src-tauri/src/integrations/five_stack.rs");
  const tauriPanel = readRepo("src/lib/components/control-center/OriginalUiPanel.svelte");
  const main = read("electron/main.cjs");

  assert.match(originalMain, /const TOOL_IDS = Object\.freeze\(\["cpa", "codex-router"\]\)/);
  assert.match(app, /toolId="cpa"/);
  assert.match(app, /toolId="codex-router"/);
  assert.match(surface, /Copy management key/);
  assert.match(surface, /Original Codex Router Control Center/);
  assert.match(controlCenter, /function openOriginalControlCenter/);
  assert.match(controlCenter, /--router-destination/);
  assert.match(cpaManaged, /disable-control-panel: false/);
  assert.match(cpaManaged, /port: 8317/);
  assert.match(fiveStack, /disable-control-panel: false/);
  assert.match(tauriPanel, /Copy management key/);
  assert.match(longRun, /"cpa"/);
  assert.match(longRun, /"codex-router"/);
  assert.match(longRun, /TARGET_UPTIME_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(main, /powerMonitor\.on\("resume"/);
});

test("CommandCode Check/Copy/Apply and Paseo/Anneal original-function engines stay out of this lane", () => {
  const originalMain = read("electron/original-ui.cjs");
  const commandCode = read("src/features/CommandCodeProxySurface.tsx");
  const upstream = read("src/features/UpstreamToolSurface.tsx");
  assert.doesNotMatch(originalMain, /commandcode-proxy|paseo|anneal/);
  assert.doesNotMatch(commandCode, /Copy plan|Apply non-secret|Check status/);
  assert.doesNotMatch(upstream, /protocol v1|inbox decision|chain hold/);
});

test("the CPA lane keeps the shared frontend type and parser boundaries buildable", () => {
  const orchestrator = readRepo("src/lib/orchestrator-center.ts");
  const providers = readRepo("src/lib/provider-center.ts");
  const appShell = readRepo("src/lib/components/AppShell.svelte");
  const originalPanel = readRepo("src/lib/components/control-center/OriginalUiPanel.svelte");
  const commandCodePanel = readRepo("src/lib/components/control-center/CommandCodeProxyPanel.svelte");

  assert.match(orchestrator, /'id' \| 'archived' \| 'revision' \| 'updated_at'/);
  assert.match(providers, /'id' \| 'generation' \| 'revision' \| 'updated_at' \| 'archived'/);
  assert.match(appShell, /onclick=\{async\(\)=>\{try\{await openUrl\(REPO_URL\);\}catch\{repoError=.*;\}\}\}>/);
  assert.match(originalPanel, /\(tool\.long_run\?\.selected_section \|\| tool\.sections\[0\]\) \?\? ''/);
  assert.match(commandCodePanel, /const next = await invoke<FiveStackSnapshot>\('five_stack_start'/);
  assert.doesNotMatch(commandCodePanel, /map\(\(candidate\)[^\n]*\? await invoke/);
});

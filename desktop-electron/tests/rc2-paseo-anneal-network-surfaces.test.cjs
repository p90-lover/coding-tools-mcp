"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Paseo surface can plan ChatGPT Web work and control an owned mission", () => {
  const source = read("desktop-electron/src/features/PaseoOrchestratorSurface.tsx");

  assert.match(source, /providerExecutionPlan/);
  assert.match(source, /workload:\s*"paseo"/);
  assert.match(source, /chatgpt-web/);
  assert.match(source, /execution\.update/);
  // Runs are prepared by the orchestration service; the surface follows and controls them.
  assert.match(source, /followRun\("run"/);
  assert.match(source, /agent_control/);
  for (const action of ["create", "start", "hold", "resume", "cancel", "close"]) {
    assert.match(source, new RegExp(`\\"${action}\\"`), `missing Paseo action ${action}`);
  }
});

test("Anneal task menu lists tasks and can dispatch through localized Paseo controls", () => {
  const source = read("desktop-electron/src/features/AnnealTasksSurface.tsx");
  const copy = read("desktop-electron/src/features/orchestration-copy.ts");

  // The board reads Anneal's own task API; missions are controlled through the execution plane.
  assert.match(source, /operation: "listTasks"/);
  assert.match(source, /providerExecutionPlan/);
  assert.match(source, /workload:\s*dispatchThroughPaseo\s*\?\s*"paseo"\s*:\s*"anneal"/);
  assert.match(source, /agent_control/);
  assert.match(source, /copy\.annealDispatchThroughPaseo/);
  assert.match(copy, /annealDispatchThroughPaseo:\s*"Dispatch through Paseo"/);
  assert.match(copy, /annealDispatchThroughPaseo:\s*"透過 Paseo 執行"/);
});

test("Network surface manages app-wide and per-provider proxy routing", () => {
  const source = read("desktop-electron/src/features/NetworkProxySurface.tsx");

  for (const api of [
    "providerSnapshot",
    "saveProxyProfile",
    "testProxyProfile",
    "setGlobalProxyRouting",
    "setProviderProxyPolicy",
    "setAccountProxyPolicy",
  ]) {
    assert.match(source, new RegExp(`\\.${api}\\(`), `missing proxy API ${api}`);
  }

  assert.match(source, /All application traffic|所有應用程式流量/);
  assert.match(source, /socks5/);
  assert.match(source, /websocket/);
  assert.match(source, /subagent/);
  assert.match(source, /17891/);
  assert.match(source, /mcp/);
  assert.match(source, /localhost|127\.0\.0\.1/);
});

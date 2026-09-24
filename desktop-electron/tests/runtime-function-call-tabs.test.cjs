"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("loopback iframes are allowed so CPA and Paseo original visuals can load", () => {
  const html = read("index.html");
  assert.match(html, /frame-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/\[::1\]:\* http:\/\/localhost:\* file:/);
  assert.match(html, /script type="module" src="\/src\/main\.tsx"/);
});

test("Runtime screens expose original upstream apps alongside Coding Tools controls", () => {
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  assert.match(app, /toolId="paseo"/);
  // The More entry for Paseo hosts the original app plus Coding Tools controls.
  assert.match(app, /title=\{copy\.paseoOrchestrator\}\s+toolId="paseo"/);
  assert.match(app, /<ModuleControlsPanel language=\{language\} moduleId="paseo" setError=\{setError\} \/>/);
  assert.match(app, /variant="runtime"/);
  assert.match(app, /focus="oauth"/);
  assert.match(app, /focus="api"/);
  assert.match(app, /controls=\{<AnnealTasksSurface/);
  assert.match(app, /initialSection="oauth"/);
  assert.match(app, /IntegratedModuleSurface/);
  assert.doesNotMatch(read("src/i18n.ts"), /Function Call Orchestrator/);
  assert.match(app, /copy\.runtimeOrchestrator/);
  assert.match(app, /navigateSurface\("runtime-tasks"\)/);
  assert.match(types, /"runtime-orchestrator" \| "runtime-oauth" \| "runtime-api" \| "runtime-tasks"/);
});

test("custom OpenAI and Anthropic providers ship default request formats", () => {
  const catalog = read("src/providers/provider-types.ts");
  const hub = read("src/features/ProviderHubSaasSurface.tsx");
  assert.match(catalog, /id: "custom-openai-compatible"/);
  assert.match(catalog, /id: "custom-anthropic-compatible"/);
  assert.match(catalog, /baseUrl: "https:\/\/api\.openai\.com\/v1"/);
  assert.match(catalog, /baseUrl: "https:\/\/api\.anthropic\.com"/);
  assert.match(catalog, /chatPath: "\/chat\/completions"/);
  assert.match(catalog, /chatPath: "\/v1\/messages"/);
  assert.match(catalog, /authHeaderName: "x-api-key"/);
  assert.match(hub, /RUNTIME_OAUTH_IDS/);
  assert.match(hub, /chatgpt-web/);
  assert.match(hub, /Extra headers \(JSON object\)/);
});

test("Web GPT can open a runtime task through the five-stack catalog", () => {
  const plane = read("electron/five-stack-control-plane.cjs");
  const tasks = read("src/features/RuntimeTaskSurface.tsx");
  assert.match(plane, /"runtime_open_task"/);
  assert.match(plane, /async function openRuntimeTask/);
  assert.match(plane, /awaitingWorkers/);
  assert.match(tasks, /tool: "runtime_open_task"/);
  assert.match(tasks, /Workers/);
  assert.match(tasks, /Orchestrator/);
});

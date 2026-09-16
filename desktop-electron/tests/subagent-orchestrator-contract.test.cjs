"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("subagent profiles expose explicit provider binding and typed capabilities", () => {
  const types = read("desktop-electron/src/agents/subagent-types.ts");

  assert.match(types, /providerId\?:\s*string/);
  assert.match(types, /capabilities\?:\s*ProviderCapability\[\]/);
  assert.match(types, /import type \{ ProviderCapability \}/);
});

test("provider adapter resolves current ProviderDefinition profiles with safe legacy defaults", () => {
  const adapter = read("desktop-electron/src/agents/agent-provider-adapter.ts");

  assert.match(adapter, /ProviderDefinition/);
  assert.doesNotMatch(adapter, /ProviderProfile/);
  assert.match(adapter, /agent\.providerId\?\.trim\(\)/);
  assert.match(adapter, /DEFAULT_PROVIDER_BY_AGENT\[agent\.provider\]/);
  assert.match(adapter, /agent\.provider === "custom" \? undefined/);
});

test("Paseo routing is capability typed and tolerates legacy profiles", () => {
  const router = read("desktop-electron/src/paseo/agent-router.ts");

  assert.match(router, /requiredCapabilities\?:\s*ProviderCapability\[\]/);
  assert.match(router, /agent\.capabilities \?\? \[\]/);
});

test("workflow engine queues the canonical agentId field", () => {
  const types = read("desktop-electron/src/orchestrator/workflow-types.ts");
  const engine = read("desktop-electron/src/orchestrator/workflow-engine.ts");

  assert.match(types, /export type OrchestratorWorkflow = CustomOrchestrator/);
  assert.match(engine, /step\.agentId \?\? null/);
  assert.doesNotMatch(engine, /step\.agent[,\s]/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

test("headless sidecar exposes the local Paseo and Anneal execution control plane", () => {
  const source = read("rust-core/coding-tools-headless/src/lib.rs");
  for (const route of ["read", "provider", "update"]) {
    assert.match(
      source,
      new RegExp(`\\.route\\(\\\"/api/v1/execution/${route}\\\", post\\(execution_${route}\\)\\)`),
      `missing authenticated /api/v1/execution/${route} route`,
    );
  }
  for (const operation of ["configure", "reconnect", "disable", "change"]) {
    assert.match(source, new RegExp(`execution::service::${operation}\\(`));
  }
});

test("Electron registers typed execution IPC instead of exposing dead preload methods", () => {
  const schema = read("desktop-electron/electron/ipc-schema.cjs");
  const preload = read("desktop-electron/electron/preload.cjs");
  const main = read("desktop-electron/electron/main.cjs");

  for (const [contract, channel] of [
    ["execution.read", "coding-tools:execution:read"],
    ["execution.provider", "coding-tools:execution:provider"],
    ["execution.update", "coding-tools:execution:update"],
  ]) {
    assert.ok(schema.includes(`"${contract}"`), `missing ${contract} IPC contract`);
    assert.ok(schema.includes(`channel: "${channel}"`), `missing ${channel} IPC channel`);
    assert.ok(main.includes(`handle("${channel}"`), `missing ${channel} IPC handler`);
  }

  assert.match(preload, /execution:\s*Object\.freeze\(/);
  assert.match(main, /assertFocusedMainWindow\(/);
});

test("provider credentials remain main-process only and are rejected from renderer responses", () => {
  const schema = read("desktop-electron/electron/ipc-schema.cjs");
  const contracts = read("desktop-electron/src/api/contracts.ts");
  const surface = read("desktop-electron/src/features/ProviderOrchestratorSurfaces.tsx");
  const main = read("desktop-electron/electron/main.cjs");
  const bootstrap = read("desktop-electron/electron/provider-bootstrap.cjs");

  assert.match(schema, /SENSITIVE_RESPONSE_KEYS[\s\S]*[\"']credential[\"']/);
  assert.match(schema, /rejectSensitiveKeys:\s*true/);

  const schemaRequest = schema.match(/const executionProviderRequest = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(schemaRequest, "execution provider request schema is missing");
  assert.doesNotMatch(schemaRequest[1], /\bcredential\b/);

  const contractRequest = contracts.match(/provider\(input: \{([\s\S]*?)\n    \}\): Promise<JsonObject>/);
  assert.ok(contractRequest, "typed execution provider request is missing");
  assert.doesNotMatch(contractRequest[1], /\bcredential\b/);

  const connectBlock = surface.match(/const connectProvider = async \(\) => \{([\s\S]*?)\n  const addProvider/);
  assert.ok(connectBlock, "provider connect handler is missing");
  const providerCall = connectBlock[1].match(/api\.execution\.provider\(\{([\s\S]*?)\n      \}\);/);
  assert.ok(providerCall, "provider execution call is missing");
  assert.doesNotMatch(providerCall[1], /\bcredential\b/);

  assert.match(bootstrap, /providerNetworkReady/);
  const handler = main.match(/handle\("coding-tools:execution:provider"([\s\S]*?)\n  handle\("coding-tools:execution:update"/);
  assert.ok(handler, "execution provider handler is missing");
  assert.match(handler[1], /createProviderExecutionPlan/);
  assert.match(handler[1], /providerNetworkReady/);
  assert.match(handler[1], /accountSecret/);
  assert.doesNotMatch(handler[1], /credential:\s*input\.credential/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

test("renderer dispatch identifies a Provider Hub account without transmitting credentials", () => {
  const schema = read("desktop-electron/electron/ipc-schema.cjs");
  const contracts = read("desktop-electron/src/api/contracts.ts");
  const surface = read("desktop-electron/src/features/ProviderOrchestratorSurfaces.tsx");

  const schemaRequest = schema.match(/const executionProviderRequest = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(schemaRequest, "execution provider request schema is missing");
  assert.match(schemaRequest[1], /providerAccountId/);
  assert.match(schemaRequest[1], /allowProviderFallback/);
  assert.doesNotMatch(schemaRequest[1], /\bcredential\b/);

  const contractRequest = contracts.match(/provider\(input: \{([\s\S]*?)\n    \}\): Promise<JsonObject>/);
  assert.ok(contractRequest, "typed execution provider request is missing");
  assert.match(contractRequest[1], /providerAccountId/);
  assert.match(contractRequest[1], /allowProviderFallback/);
  assert.doesNotMatch(contractRequest[1], /\bcredential\b/);

  const connectBlock = surface.match(/const connectProvider = async \(\) => \{([\s\S]*?)\n  const addProvider/);
  assert.ok(connectBlock, "provider connect handler is missing");
  const providerCall = connectBlock[1].match(/api\.execution\.provider\(\{([\s\S]*?)\n      \}\);/);
  assert.ok(providerCall, "provider execution call is missing");
  assert.match(providerCall[1], /providerAccountId/);
  assert.doesNotMatch(providerCall[1], /\bcredential\b/);
});

test("main process resolves the execution plan and encrypted account secret", () => {
  const main = read("desktop-electron/electron/main.cjs");
  const bootstrap = read("desktop-electron/electron/provider-bootstrap.cjs");
  const handler = main.match(/handle\("coding-tools:execution:provider"([\s\S]*?)\n  handle\("coding-tools:execution:update"/);

  assert.ok(handler, "execution provider handler is missing");
  assert.match(main, /createProviderExecutionPlan/);
  assert.match(main, /providerNetworkReady/);
  assert.match(handler[1], /createProviderExecutionPlan/);
  assert.match(handler[1], /providerNetworkReady/);
  assert.match(handler[1], /accountSecret/);
  assert.match(handler[1], /storedProviderCredential/);
  assert.doesNotMatch(handler[1], /credential:\s*input\.credential/);
  assert.match(bootstrap, /providerNetworkReady/);
});

test("provider snapshot exposes only credential presence while IPC responses still reject secrets", () => {
  const network = read("desktop-electron/electron/provider-network.cjs");
  const schema = read("desktop-electron/electron/ipc-schema.cjs");

  assert.match(network, /hasCredential/);
  assert.match(schema, /SENSITIVE_RESPONSE_KEYS[\s\S]*[\"']credential[\"']/);
  assert.match(schema, /rejectSensitiveKeys:\s*true/);
});

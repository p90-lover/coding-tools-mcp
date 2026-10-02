"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

test("headless sidecar keeps execution reads and retires standalone Paseo/Anneal execution writes", () => {
  const source = read("rust-core/coding-tools-headless/src/lib.rs");
  for (const route of ["read", "provider", "update"]) {
    assert.match(
      source,
      new RegExp(`\\.route\\(\\\"/api/v1/execution/${route}\\\", post\\(execution_${route}\\)\\)`),
      `missing authenticated /api/v1/execution/${route} route`,
    );
  }
  const handler = (name) => {
    const start = source.indexOf(`async fn ${name}(`);
    assert.ok(start >= 0, `missing ${name} handler`);
    return source.slice(start, source.indexOf("\nasync fn ", start + 1));
  };
  // Reads still report execution state; standalone execution writes are retired in favour of AO.
  assert.match(handler("execution_read"), /execution::service::view\(/);
  for (const retired of ["execution_provider", "execution_update"]) {
    const body = handler(retired);
    assert.match(body, /auth\(&headers, &state\)/, `${retired} stays authenticated`);
    assert.match(body, /StatusCode::GONE,\s*"APP_MODULE_RETIRED"/, `${retired} answers 410 APP_MODULE_RETIRED`);
  }
  for (const operation of ["configure", "reconnect", "disable", "change"]) {
    assert.doesNotMatch(source, new RegExp(`execution::service::${operation}\\(`), `retired ${operation} is not reachable`);
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

test("retired provider contract rejects secret fields while keeping control auth distinct", async () => {
  const schema = read("desktop-electron/electron/ipc-schema.cjs");
  const contracts = read("desktop-electron/src/api/contracts.ts");
  const { invokeContract } = require("../electron/ipc-schema.cjs");

  assert.match(schema, /SENSITIVE_RESPONSE_KEYS[\s\S]*[\"']credential[\"']/);
  assert.match(schema, /rejectSensitiveKeys:\s*true/);

  const schemaRequest = schema.match(/const executionProviderRequest = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(schemaRequest, "execution provider request schema is missing");
  assert.doesNotMatch(schemaRequest[1], /(?:^|\s)credential:\s*/m);
  assert.match(schemaRequest[1], /controlCredential/);

  const contractRequest = contracts.match(/provider\(input: \{([\s\S]*?)\n    \}\): Promise<JsonObject>/);
  assert.ok(contractRequest, "typed execution provider request is missing");
  assert.doesNotMatch(contractRequest[1], /readonly credential\??:/);
  assert.match(contractRequest[1], /readonly controlCredential\?: string/);

  const calls = [];
  const ipcRenderer = { invoke: async (channel, payload) => {
    calls.push([channel, payload]);
    return {};
  } };
  const input = {
    workspaceId: "workspace-1", operation: "configure", confirm: true,
    controlCredential: "control-only",
  };
  await assert.rejects(
    invokeContract(ipcRenderer, "execution.provider", { ...input, credential: "provider-secret" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  assert.equal(calls.length, 0, "provider secret must be rejected before IPC transport");

  await invokeContract(ipcRenderer, "execution.provider", input);
  assert.equal(calls[0][0], "coding-tools:execution:provider");
  assert.equal(calls[0][1].controlCredential, "control-only");
  assert.equal(Object.hasOwn(calls[0][1], "credential"), false);

  await assert.rejects(
    invokeContract({ invoke: async () => ({ credential: "provider-secret" }) }, "execution.provider", input),
    { code: "IPC_RESPONSE_SCHEMA_INVALID" },
  );
});

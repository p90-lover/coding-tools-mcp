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
    assert.ok(main.includes(`handle("${channel}"`), `missing ${channel} main-process handler`);
  }

  assert.match(preload, /execution:\s*Object\.freeze\(/);
  assert.match(main, /assertFocusedMainWindow\(/);
});

test("provider credentials are request-only and rejected from renderer responses", () => {
  const schema = read("desktop-electron/electron/ipc-schema.cjs");
  assert.match(schema, /SENSITIVE_RESPONSE_KEYS[\s\S]*[\"']credential[\"']/);
  assert.match(schema, /rejectSensitiveKeys:\s*true/);
});

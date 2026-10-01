"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { repairFacts } = require("../electron/repair-diagnostics.cjs");

test("repair facts retain only bounded diagnostic states", () => {
  const input = {
    workspaceId: "repair-qa",
    doctor: {
      checks: [
        { id: "browser-host", status: "error", message: "Bearer secret-do-not-copy" },
        { id: "proxy", status: "ok", detail: "https://example.test/?sig=signed-secret" },
        { id: "unknown-secret", status: "error" },
      ],
    },
    services: {
      services: [
        { id: "cpa", managedInstall: { state: "installed" }, status: "ready", error: "password=private-secret" },
        { id: "paseo", managedInstall: { state: "not-installed" }, status: "offline" },
        { id: "unknown-secret", managedInstall: { state: "installed" }, status: "ready" },
      ],
    },
    bridge: {
      installed: true,
      active: false,
      activeTurns: 2,
      url: "http://127.0.0.1/private-secret",
      controlToken: "private-secret",
    },
  };
  const result = repairFacts(input);
  assert.equal(result.kind, "coding_tools_repair");
  assert.equal(result.workspaceId, "repair-qa");
  assert.deepEqual(result.checks, [
    { id: "browser-host", status: "error" },
    { id: "proxy", status: "ok" },
  ]);
  assert.deepEqual(result.modules, [
    { id: "cpa", installState: "installed", running: true },
    { id: "paseo", installState: "not-installed", running: false },
  ]);
  assert.deepEqual(result.bridge, { installed: true, active: false, activeTurns: 2 });
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(repairFacts(input).revision, result.revision);
  assert.equal(repairFacts({
    ...input,
    doctor: { checks: [...input.doctor.checks].reverse() },
    services: { services: [...input.services.services].reverse() },
  }).revision, result.revision);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.notEqual(repairFacts({ ...input, bridge: { ...input.bridge, activeTurns: 1 } }).revision, result.revision);
  assert.equal(repairFacts({ ...input, bridge: {} }).bridge.activeTurns, null);
  assert.throws(() => repairFacts({ ...input, workspaceId: "C:\\private-secret" }), /workspace ID/i);
});

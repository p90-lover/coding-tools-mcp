"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { invokeContract } = require("../electron/ipc-schema.cjs");

test("native Codex IPC requires bounded local connection fields", async () => {
  const calls = [];
  const ipc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return { connected: true };
    },
  };
  const input = {
    workspaceId: "ws-1",
    executable: "C:\\Codex\\codex.exe",
    codexHome: "C:\\CodexHome",
    model: "gpt-6-astra",
    allowModelUsage: true,
    allowCommandExecution: false,
    permissionProfile: ":read-only",
    requestLimit: 10,
    lifetimeSeconds: 600,
  };
  await assert.rejects(
    invokeContract(ipc, "nativeCodex.connect", { ...input, expectedSha256: "untrusted" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  await assert.rejects(
    invokeContract(ipc, "nativeCodex.connect", { ...input, requestLimit: 21 }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  await assert.rejects(
    invokeContract(ipc, "nativeCodex.connect", { ...input, permissionProfile: ":danger-full-access" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await invokeContract(ipc, "nativeCodex.connect", input), { connected: true });
  assert.equal(calls[0].channel, "coding-tools:native-codex:connect");
  assert.deepEqual(await invokeContract(ipc, "nativeCodex.status", { workspaceId: "ws-1" }), { connected: true });
});

test("workspace policy IPC permits only scoped local settings", async () => {
  const calls = [];
  const ipc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return { ok: true };
    },
  };
  const input = {
    workspaceId: "ws-1",
    permissionMode: "workspace-write",
    approvalMode: "ask",
    toolProfile: "advanced",
    screenCaptureEnabled: true,
  };
  await assert.rejects(
    invokeContract(ipc, "workspaces.updatePolicy", { ...input, permissionMode: "danger-full-access" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await invokeContract(ipc, "workspaces.updatePolicy", input), { ok: true });
  assert.equal(calls[0].channel, "coding-tools:workspaces:policy-update");
});

test("workspace auth IPC validates fields before sending a local save", async () => {
  const calls = [];
  const ipc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return { ok: true };
    },
  };
  const input = {
    workspaceId: "ws-1",
    service: "mcp",
    authType: "oauth",
    oauthClientId: "client-1",
    oauthRedirectUris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    oauthScopes: "",
    useSharedSecrets: false,
  };
  await assert.rejects(
    invokeContract(ipc, "workspaces.updateAuth", { ...input, secret: "must-not-cross" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await invokeContract(ipc, "workspaces.updateAuth", input), { ok: true });
  assert.equal(calls[0].channel, "coding-tools:workspaces:auth-update");
  assert.deepEqual(calls[0].payload, input);
});

test("workspace listener IPC accepts only scoped service operations", async () => {
  const calls = [];
  const ipc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return { state: "stopped" };
    },
  };
  const input = { workspaceId: "ws-1", service: "mcp", operation: "status" };
  await assert.rejects(
    invokeContract(ipc, "workspaces.service", { ...input, operation: "delete" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await invokeContract(ipc, "workspaces.service", input), { state: "stopped" });
  assert.equal(calls[0].channel, "coding-tools:workspaces:service");
});

test("workspace credential IPC accepts only known local credential keys", async () => {
  const calls = [];
  const ipc = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      return { ok: true, copied: true };
    },
  };
  await assert.rejects(
    invokeContract(ipc, "workspaces.copySecret", { workspaceId: "ws-1", key: "arbitrary_secret" }),
    { code: "IPC_REQUEST_SCHEMA_INVALID" },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await invokeContract(ipc, "workspaces.copySecret", { workspaceId: "ws-1", key: "oauth_password" }),
    { ok: true, copied: true },
  );
  assert.equal(calls[0].channel, "coding-tools:workspaces:copy-secret");
});

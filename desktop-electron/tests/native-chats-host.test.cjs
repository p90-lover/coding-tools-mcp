"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createNativeChatsHost } = require("../electron/native-chats-host.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");

test("Runtime > Chats is separate from AO and its IPC rejects provider or workspace overrides", async () => {
  const app = readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const main = readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  assert.match(app, /label="Chat" onClick=\{\(\) => navigateSurface\("agent-orchestrator"\)\}/);
  assert.match(app, /label="Chats" onClick=\{\(\) => navigateSurface\("chats"\)\}/);
  assert.match(main, /createNativeChatsHost\(\{ enabled: IS_DEV_PROFILE && !app\.isPackaged/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame[\s\S]*?return nativeChats\.call\(input\)/);
  const host = createNativeChatsHost({ enabled: false, env: { CODING_TOOLS_CHATS_SOURCE: __dirname, CODING_TOOLS_CHATS_ENDPOINT: "http://127.0.0.1/v1",
    CODING_TOOLS_CHATS_PROTOCOL: "openai-completions", CODING_TOOLS_CHATS_MODEL: "fixture" } });
  const ipc = { async invoke(channel, args) { assert.equal(channel, "coding-tools:runtime:chats"); return host.call(args); } };
  assert.equal((await invokeContract(ipc, "runtime.chats", { action: "status" })).available, false);
  await assert.rejects(invokeContract(ipc, "runtime.chats", { action: "open" }), /separately configured development profile/);
  for (const field of ["endpoint", "workspaceRoot", "model", "credential", "permissionMode"]) {
    await assert.rejects(invokeContract(ipc, "runtime.chats", { action: "open", [field]: "never accepted" }), { code: "IPC_REQUEST_SCHEMA_INVALID" });
  }
  await host.close();
});

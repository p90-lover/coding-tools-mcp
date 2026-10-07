"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserControlServer } = require("../electron/control-server.cjs");

// Installers and patch scripts restart the app through this instead of killing it, so the
// Codex bridge, MCP tunnel and CPA keep running. It can only ask for a keep-bridge quit.
test("launcher quit-keep-bridge only accepts { relaunch } from an authorized caller", async () => {
  const calls = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("quit must not inspect the browser"); },
    getPreferences: () => { throw new Error("quit must not inspect preferences"); },
    requestKeepBridgeQuit: async (options) => {
      calls.push(options);
      return { ok: true, status: options.relaunch ? "restarting" : "quitting" };
    },
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/launcher/quit-keep-bridge`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await send({ relaunch: true }, "Bearer wrong")).status, 401);
    assert.equal((await send({})).status, 400);
    assert.equal((await send({ relaunch: "yes" })).status, 400);
    // There is no way to ask for a quit that stops the bridge.
    assert.equal((await send({ relaunch: false, keepBridge: false })).status, 400);
    const restart = await send({ relaunch: true });
    assert.equal(restart.status, 202);
    assert.deepEqual(await restart.json(), { ok: true, status: "restarting" });
    assert.equal((await send({ relaunch: false })).status, 202);
    assert.deepEqual(calls, [{ relaunch: true }, { relaunch: false }]);
  } finally {
    await server.close();
  }
});

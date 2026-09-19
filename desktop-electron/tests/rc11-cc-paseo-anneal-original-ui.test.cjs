"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createHandlerRegistry,
  FOREIGN_SLOTS,
  defaultRegistry,
} = require("../../modules/handler-registry.cjs");
const { MODULE_IDS, createCodingToolsAppsHost } = require("../../modules/host.cjs");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("this lane keeps CommandCode Paseo Anneal on #221's shared registry", () => {
  assert.deepEqual(FOREIGN_SLOTS, ["cpa", "codex-router"]);
  assert.deepEqual(MODULE_IDS, ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]);
  assert.equal(fs.existsSync(path.join(ROOT, "modules/handler-registry.cjs")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "modules/host.cjs")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "modules/lib/in-process-handler.cjs")), true);
  assert.match(source("modules/handler-registry.cjs"), /createHandlerRegistry/);
  assert.doesNotMatch(source("modules/handler-registry.cjs"), /createServer/);
  assert.deepEqual(defaultRegistry.ids().sort(), [...MODULE_IDS].sort());
  for (const id of ["commandcode-proxy", "paseo", "anneal"]) {
    assert.equal(defaultRegistry.get(id).root, `modules/${id}`);
    assert.match(source(`modules/${id}/handler.cjs`), /wrapInProcessHandler/);
    assert.equal(fs.existsSync(path.join(ROOT, "modules", id, "handlers.cjs")), true);
  }
});

test("CommandCode Paseo Anneal keep in-tree source without a second module root", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "modules/commandcode-proxy/source/proxy.mjs")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "modules/paseo/source/BUNDLE.json")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "modules/anneal/source/BUNDLE.json")), true);
  assert.equal(JSON.parse(source("modules/commandcode-proxy/module.json")).source.path, "modules/commandcode-proxy/source");
  assert.equal(JSON.parse(source("modules/paseo/module.json")).source.path, "modules/paseo/source");
  assert.equal(JSON.parse(source("modules/anneal/module.json")).source.path, "modules/anneal/source");
  assert.equal(fs.existsSync(path.join(ROOT, "apps")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "vendored")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "integrations")), false);
});

test("in-process handlers for the three apps use #221 invoke without listen ports", async () => {
  const registry = createHandlerRegistry();
  assert.ok(registry.operations("paseo").includes("send"));
  assert.ok(registry.operations("anneal").includes("task-start"));
  assert.ok(registry.operations("commandcode-proxy").includes("health"));
  assert.equal(registry.snapshot("paseo").transport, "in-process");
  assert.equal(registry.snapshot("commandcode-proxy").transport, "in-process");
  assert.equal(registry.snapshot("anneal").transport, "in-process");

  const sent = await registry.invoke("paseo", "send", { agentId: "a1", text: "hi" }, {
    act: async (payload) => ({ ok: true, op: payload.op, agentId: payload.agentId }),
  });
  assert.equal(sent.transport, "in-process");
  assert.equal(sent.ok, true);
  assert.equal(sent.op, "send");

  const started = await registry.invoke("anneal", "task-start", { taskId: "t1" }, {
    act: async (payload) => ({ ok: true, op: payload.op }),
  });
  assert.equal(started.transport, "in-process");
  assert.equal(started.ok, true);
  assert.equal(started.op, "start");

  const host = createCodingToolsAppsHost({
    services: {
      inspect: async (id) => ({ id, status: "ready" }),
    },
    getFiveStack: () => ({ ok: false }),
  });
  assert.equal(host.transport, "in-process");
  assert.equal(host.listenLoopback, undefined);
  const listed = host.list();
  assert.deepEqual(
    listed.modules.filter((entry) => ["commandcode-proxy", "paseo", "anneal"].includes(entry.id)).map((entry) => entry.id),
    ["commandcode-proxy", "paseo", "anneal"],
  );
});

test("Coding Tools still hosts CommandCode Paseo Anneal visuals in-process", () => {
  const app = source("desktop-electron/src/App.tsx");
  const registry = source("modules/handler-registry.cjs");
  assert.match(app, /PaseoOrchestratorSurface/);
  assert.match(app, /AnnealTasksSurface/);
  assert.match(app, /toolId="paseo"/);
  assert.match(app, /toolId="anneal"/);
  assert.match(source("desktop-electron/src/features/CommandCodeProxySurface.tsx"), /commandcode-proxy-surface/);
  assert.match(source("desktop-electron/electron/preload.cjs"), /invoke: \(input\) => invokeContract\(ipcRenderer, "apps.call"/);
  assert.doesNotMatch(registry, /createServer\(/);
  assert.doesNotMatch(source("modules/host.cjs"), /createServer\(/);
  assert.doesNotMatch(app, /browser-surface-active/);
});

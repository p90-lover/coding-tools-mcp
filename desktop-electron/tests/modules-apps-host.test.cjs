"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { MODULE_IDS, createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { FOREIGN_SLOTS, defaultRegistry } = require("../../app-handler/handler-registry.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

test("app-handler tree hosts CPA, Codex Router, CommandCode, Paseo, Anneal, and Instant MCP Tools", () => {
  assert.deepEqual(MODULE_IDS, ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal", "instant-mcp-tools"]);
  assert.equal(MODULE_IDS.includes("commandcode"), false);
  assert.deepEqual(FOREIGN_SLOTS, ["cpa", "codex-router"]);
  const folderIds = fs.readdirSync(path.join(repoRoot, "app-handler"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, "app-handler", entry.name, "module.json")))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual([...MODULE_IDS].sort(), folderIds);
  for (const id of MODULE_IDS) {
    assert.equal(fs.existsSync(path.join(repoRoot, "app-handler", id, "handler.cjs")), true, id);
    assert.equal(fs.existsSync(path.join(repoRoot, "app-handler", id, "handlers.cjs")), true, id);
    assert.equal(fs.existsSync(path.join(repoRoot, "app-handler", id, "module.json")), true, id);
    assert.equal(fs.existsSync(path.join(repoRoot, "app-handler", id, "README.md")), true, id);
    assert.equal(fs.existsSync(path.join(repoRoot, "modules", id, "handler.cjs")), true, `${id} shim`);
    assert.equal(fs.existsSync(path.join(repoRoot, "modules", id, "README.md")), true, `${id} shim readme`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, "app-handler", id, "module.json"), "utf8")).id, id);
  }
  assert.deepEqual(defaultRegistry.ids().sort(), [...MODULE_IDS].sort());
  const shimHost = require("../../modules/host.cjs");
  assert.deepEqual(shimHost.MODULE_IDS, MODULE_IDS);
  const readme = fs.readFileSync(path.join(repoRoot, "app-handler", "README.md"), "utf8");
  assert.match(readme, /codingTools\.apps/);
  assert.match(readme, /in-process/);
  assert.match(readme, /handler-registry\.cjs/);
  assert.match(readme, /127\.0\.0\.1:17891/);
  assert.match(readme, /apps_list/);
  assert.match(readme, /apps_invoke/);
  assert.doesNotMatch(readme, /launch Control Center/i);
  assert.doesNotMatch(readme, /\/api\/v1\/apps/);
});

test("apps host catalogs operations and drives modules in-process without listen ports or five-stack", async () => {
  const calls = [];
  const host = createCodingToolsAppsHost({
    services: {
      inspect: async (id) => {
        calls.push(["inspect", id]);
        return { id, status: "ready", endpoint: `http://127.0.0.1:${id === "cpa" ? 8317 : 4202}/` };
      },
      start: async (id) => { calls.push(["start", id]); return { id, status: "starting" }; },
    },
    getFiveStack: () => {
      calls.push(["five-stack"]);
      return { ok: false };
    },
  });

  assert.equal(host.transport, "in-process");
  assert.equal(host.listenLoopback, undefined);
  const listed = host.list();
  assert.equal(listed.host, "coding-tools-apps");
  assert.equal(listed.transport, "in-process");
  assert.deepEqual(listed.modules.map((entry) => entry.id), MODULE_IDS);
  assert.ok(listed.modules.find((entry) => entry.id === "cpa").operations.includes("chatCompletions"));
  assert.ok(listed.modules.find((entry) => entry.id === "cpa").operations.includes("listProviders"));
  assert.ok(listed.modules.find((entry) => entry.id === "cpa").operations.includes("linkProvider"));
  assert.ok(listed.modules.find((entry) => entry.id === "codex-router").operations.includes("sync"));
  assert.ok(listed.modules.find((entry) => entry.id === "codex-router").operations.includes("chatCompletions"));
  assert.ok(listed.modules.find((entry) => entry.id === "paseo").operations.includes("send"));
  assert.ok(listed.modules.find((entry) => entry.id === "anneal").operations.includes("startTask"));
  assert.ok(listed.modules.find((entry) => entry.id === "anneal").operations.includes("task-start"));
  assert.ok(listed.modules.find((entry) => entry.id === "instant-mcp-tools").operations.includes("listTools"));
  assert.ok(listed.modules.find((entry) => entry.id === "instant-mcp-tools").operations.includes("list-tools"));
  assert.ok(listed.modules.find((entry) => entry.id === "instant-mcp-tools").operations.includes("runTool"));
  assert.ok(listed.modules.find((entry) => entry.id === "instant-mcp-tools").operations.includes("run-tool"));

  const catalog = host.catalog();
  const cpaModels = catalog.modules.find((entry) => entry.id === "cpa")
    .operations.find((entry) => entry.name === "models");
  assert.equal(cpaModels.readOnly, true);
  assert.match(cpaModels.description, /models/i);

  const inspected = await host.call("cpa", "inspect");
  assert.equal(inspected.ok, true);
  assert.equal(inspected.transport, "in-process");
  assert.equal(inspected.result.id, "cpa");
  const invoked = await host.invoke({ handle: "cpa", operation: "inspect" });
  assert.equal(invoked.handle, "cpa");
  const viaObject = await host.call({ moduleId: "cpa", operation: "inspect" });
  assert.equal(viaObject.ok, true);
  assert.equal(viaObject.moduleId, "cpa");
  assert.deepEqual(calls, [["inspect", "cpa"], ["inspect", "cpa"], ["inspect", "cpa"]]);
  assert.equal(host.isReadOnly("cpa", "inspect"), true);
  assert.equal(host.isReadOnly("cpa", "start"), false);
});

test("Anneal module returns postgres unavailable instead of throwing", async () => {
  const host = createCodingToolsAppsHost({
    actUpstream: async () => {
      throw new Error("password authentication failed for user postgres");
    },
  });
  const result = await host.call("anneal", "startTask", { taskId: "task-1" });
  assert.equal(result.result.unavailable, true);
  assert.equal(result.result.dependency, "postgres");
});

test("desktop shell wires codingTools.apps without constructing five-stack at bootstrap", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const schema = read("electron/ipc-schema.cjs");
  const contracts = read("src/api/contracts.ts");
  const original = read("electron/original-ui.cjs");
  const host = fs.readFileSync(path.join(repoRoot, "app-handler/host.cjs"), "utf8");

  assert.match(main, /createCodingToolsAppsHost/);
  assert.match(main, /requireAppHandler\("host\.cjs"\)/);
  assert.match(read("electron/app-handler-paths.cjs"), /path\.join\(__dirname, "\.\.", "app-handler"\)/);
  assert.match(main, /coding-tools:apps:list/);
  assert.match(main, /coding-tools:apps:catalog/);
  assert.match(main, /coding-tools:apps:call/);
  assert.match(main, /createLazyFactory\(\(\) => createFiveStackControlPlane/);
  assert.match(preload, /"apps.list"/);
  assert.match(preload, /"apps.call"/);
  assert.match(preload, /invoke: \(input\) => invokeContract\(ipcRenderer, "apps.call"/);
  assert.match(schema, /"apps.catalog"/);
  assert.match(contracts, /readonly apps:/);
  assert.match(contracts, /invoke\(input:/);
  assert.match(original, /via: "codingTools\.apps"/);
  assert.doesNotMatch(original, /openOriginalControlCenter/);
  assert.doesNotMatch(host, /createServer/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const { MODULE_IDS, createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { defaultRegistry } = require("../../app-handler/handler-registry.cjs");
const { createInstantMcpToolsServices } = require("../electron/instant-mcp-tools-services.cjs");
const { createCodingToolsAppsMcp } = require("../electron/coding-tools-apps-mcp.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const MODULE_ID = "instant-mcp-tools";

function forbidTcp(label) {
  const originalHttp = http.request;
  const originalHttps = require("node:https").request;
  const originalConnect = net.Socket.prototype.connect;
  function record(kind, target) {
    throw new Error(`${label} must not open TCP (${kind}: ${target})`);
  }
  http.request = function patchedHttp(target, ...rest) {
    record("http.request", target instanceof URL ? target.href : target);
    return originalHttp.call(this, target, ...rest);
  };
  require("node:https").request = function patchedHttps(target, ...rest) {
    record("https.request", target instanceof URL ? target.href : target);
    return originalHttps.call(this, target, ...rest);
  };
  net.Socket.prototype.connect = function patchedConnect(options, ...rest) {
    const target = options && typeof options === "object"
      ? `${options.host || options.hostname || ""}:${options.port || ""}`
      : options;
    record("net.connect", target);
    return originalConnect.call(this, options, ...rest);
  };
  return {
    restore() {
      http.request = originalHttp;
      require("node:https").request = originalHttps;
      net.Socket.prototype.connect = originalConnect;
    },
  };
}

test("Instant MCP Tools is a catalogued in-process module with listTools/runTool", () => {
  assert.equal(MODULE_IDS.includes(MODULE_ID), true);
  assert.equal(defaultRegistry.has(MODULE_ID), true);
  const snapshot = defaultRegistry.snapshot(MODULE_ID);
  assert.equal(snapshot.transport, "in-process");
  assert.equal(snapshot.legacyLoopback, null);
  const operations = defaultRegistry.operations(MODULE_ID);
  for (const name of ["inspect", "listTools", "list-tools", "tools", "runTool", "run-tool", "callTool", "listWorkspaces"]) {
    assert.equal(operations.includes(name), true, name);
  }
  const listed = createCodingToolsAppsHost().list();
  const entry = listed.modules.find((module) => module.id === MODULE_ID);
  assert.equal(entry.name, "Instant MCP Tools");
  assert.equal(entry.transport, "in-process");
  const catalog = createCodingToolsAppsHost().catalog();
  const listTools = catalog.modules
    .find((module) => module.id === MODULE_ID)
    .operations.find((operation) => operation.name === "listTools");
  assert.equal(listTools.readOnly, true);
  const kebabList = catalog.modules
    .find((module) => module.id === MODULE_ID)
    .operations.find((operation) => operation.name === "list-tools");
  assert.equal(kebabList.readOnly, true);
  const runTool = catalog.modules
    .find((module) => module.id === MODULE_ID)
    .operations.find((operation) => operation.name === "runTool");
  assert.equal(runTool.readOnly, false);
  const kebabRun = catalog.modules
    .find((module) => module.id === MODULE_ID)
    .operations.find((operation) => operation.name === "run-tool");
  assert.equal(kebabRun.readOnly, false);
});

test("inspect is ready without Start, listen ports, or TCP", async () => {
  const guard = forbidTcp("instant-mcp-tools inspect");
  let started = false;
  try {
    const host = createCodingToolsAppsHost({
      services: {
        start: async () => {
          started = true;
          throw new Error("inspect must not Start a managed child");
        },
      },
      getFiveStack: () => ({ ok: false }),
    });
    const inspected = await host.call({ moduleId: MODULE_ID, operation: "inspect" });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.transport, "in-process");
    assert.equal(inspected.result.status, "ready");
    assert.equal(inspected.result.listening, false);
    assert.equal(inspected.result.dedicatedListenPort, false);
    assert.equal(inspected.result.startRequired, false);
    assert.equal(inspected.result.runtimeStarted, false);
    assert.equal(started, false);

    const startedOp = await host.invoke({ handle: MODULE_ID, operation: "start" });
    assert.equal(startedOp.ok, true);
    assert.equal(startedOp.result.listening, false);
    assert.equal(startedOp.result.dedicatedListenPort, false);
    assert.equal(started, false);
  } finally {
    guard.restore();
  }
});

test("listTools and runTool work via apps.invoke with JSON args and soft-fail when MCP is down", async () => {
  const calls = [];
  const host = createCodingToolsAppsHost({
    services: {
      listTools: async (input) => {
        calls.push(["listTools", input]);
        return {
          ok: true,
          tools: [
            { name: "apps_list", description: "List modules", readOnly: true, via: "codingTools.apps.list" },
            { name: "read_file", description: "Read a file" },
          ],
          workspaceId: input.workspaceId || null,
        };
      },
      runTool: async (input) => {
        calls.push(["runTool", input]);
        return { ok: true, tool: input.tool, echoed: input.arguments, workspaceId: input.workspaceId };
      },
      listWorkspaces: async () => ({
        ok: true,
        items: [{ id: "ws-1", name: "Demo", path: "/tmp/demo", mcpState: "running", policyRevision: 1 }],
        nextCursor: null,
      }),
    },
    getFiveStack: () => ({ ok: false }),
  });

  const listed = await host.invoke({
    handle: MODULE_ID,
    operation: "listTools",
    arguments: { workspaceId: "ws-1" },
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.handle, MODULE_ID);
  assert.equal(listed.result.listening, false);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["apps_list", "read_file"]);

  const ran = await host.invoke({
    handle: MODULE_ID,
    operation: "runTool",
    arguments: { workspaceId: "ws-1", tool: "read_file", arguments: { path: "README.md" } },
  });
  assert.equal(ran.ok, true);
  assert.equal(ran.result.tool, "read_file");
  assert.deepEqual(ran.result.echoed, { path: "README.md" });

  const viaAlias = await host.call({
    moduleId: MODULE_ID,
    operation: "callTool",
    arguments: { tool: "apps_list", arguments: {} },
  });
  assert.equal(viaAlias.ok, true);
  assert.equal(viaAlias.result.tool, "apps_list");

  const kebabListed = await host.call({
    moduleId: MODULE_ID,
    operation: "list-tools",
    arguments: { workspaceId: "ws-1" },
  });
  assert.equal(kebabListed.ok, true);
  assert.deepEqual(kebabListed.result.tools.map((tool) => tool.name), ["apps_list", "read_file"]);
  assert.equal(host.isReadOnly(MODULE_ID, "list-tools"), true);

  const kebabRan = await host.call({
    moduleId: MODULE_ID,
    operation: "run-tool",
    arguments: { workspaceId: "ws-1", tool: "read_file", arguments: { path: "README.md" } },
  });
  assert.equal(kebabRan.ok, true);
  assert.equal(kebabRan.result.tool, "read_file");
  assert.equal(host.isReadOnly(MODULE_ID, "run-tool"), false);

  const workspaces = await host.call(MODULE_ID, "listWorkspaces");
  assert.equal(workspaces.result.items[0].id, "ws-1");
  assert.deepEqual(calls.map((entry) => entry[0]), ["listTools", "runTool", "runTool", "listTools", "runTool"]);
});

test("runTool soft-fails when no MCP runtime is available", async () => {
  const host = createCodingToolsAppsHost({
    getFiveStack: () => ({ ok: false }),
  });
  const missing = await host.invoke({
    handle: MODULE_ID,
    operation: "runTool",
    arguments: { tool: "read_file", arguments: { path: "x" } },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.result.softFail, true);
  assert.equal(missing.result.unavailable, true);
  assert.equal(missing.result.listening, false);
  assert.doesNotMatch(JSON.stringify(missing), /ECONNREFUSED/);
});

test("desktop Instant MCP Tools services wrap the in-process registry without throwing when headless is down", async () => {
  const services = createInstantMcpToolsServices({
    getHeadlessHost: () => null,
    getFiveStack: () => ({ ok: false }),
    getAppsMcp: () => createCodingToolsAppsMcp({
      getHost: () => createCodingToolsAppsHost({ getFiveStack: () => ({ ok: false }) }),
    }),
  });
  const listed = await services.listTools({});
  assert.equal(listed.ok, true);
  assert.equal(listed.listening, false);
  assert.ok(listed.tools.some((tool) => tool.name === "apps_list"));
  const workspaces = await services.listWorkspaces();
  assert.equal(workspaces.headlessUnavailable, true);
  assert.deepEqual(workspaces.items, []);
  const ran = await services.runTool({ tool: "apps_list", arguments: {} });
  assert.equal(ran.ok, true);
  assert.equal(ran.via, "codingTools.apps");
  assert.ok(Array.isArray(ran.result.modules));
  const unknown = await services.runTool({ tool: "missing_tool", arguments: { foo: 1 } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.softFail, true);
});

test("README and IPC contract document handler id and operations for LOL", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "app-handler/instant-mcp-tools/README.md"), "utf8");
  const schema = fs.readFileSync(path.join(desktopRoot, "electron/ipc-schema.cjs"), "utf8");
  const panel = fs.readFileSync(path.join(desktopRoot, "src/features/McpLiveToolsPanel.tsx"), "utf8");
  const main = fs.readFileSync(path.join(desktopRoot, "electron/main.cjs"), "utf8");
  assert.match(readme, /moduleId: "instant-mcp-tools"/);
  assert.match(readme, /operation: "list-tools"/);
  assert.match(readme, /operation: "run-tool"/);
  assert.match(readme, /operation: "listTools"/);
  assert.match(readme, /alias of listTools/);
  assert.match(readme, /alias of runTool/);
  assert.match(readme, /handle: "instant-mcp-tools"/);
  assert.doesNotMatch(readme, /api_key|secret|token/i);
  assert.match(schema, /instant-mcp-tools/);
  assert.match(panel, /operation: "listTools"/);
  assert.match(panel, /operation: "runTool"/);
  assert.match(main, /listTools: \(input\) => instantMcpToolsServices\.listTools/);
  assert.match(main, /runTool: \(input\) => instantMcpToolsServices\.runTool/);
});

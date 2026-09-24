"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  APPS_MCP_TOOLS,
  PROXY_SEED,
  createCodingToolsAppsMcp,
  mergeAppsCatalog,
} = require("../electron/coding-tools-apps-mcp.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("hello MCP overlay maps tools onto codingTools.apps without listen ports", async () => {
  const overlay = fs.readFileSync(path.join(root, "electron/coding-tools-apps-mcp.cjs"), "utf8");
  assert.deepEqual([...APPS_MCP_TOOLS], [
    "apps_list",
    "apps_catalog",
    "apps_call",
    "apps_invoke",
    "apps_status",
  ]);
  assert.equal(PROXY_SEED, "http://127.0.0.1:17891");
  assert.match(overlay, /codingTools\.apps\.call/);
  assert.match(overlay, /codingTools\.apps\.invoke/);
  assert.doesNotMatch(overlay, /createServer/);
  assert.doesNotMatch(overlay, /listenLoopback/);
  assert.doesNotMatch(overlay, /five_stack_loopbacks/);
  assert.doesNotMatch(overlay, /five_stack_start/);
  assert.doesNotMatch(overlay, /:7890/);
});

test("apps MCP tools list, call, invoke, and report ready without spawning ports", async () => {
  const calls = [];
  const host = createCodingToolsAppsHost({
    services: {
      inspect: async (id) => {
        calls.push(["inspect", id]);
        return { id, status: "ready", endpoint: "http://127.0.0.1:8317/" };
      },
      start: async (id) => {
        calls.push(["start", id]);
        throw new Error("apps_status must not spawn or start children");
      },
    },
    getFiveStack: () => {
      calls.push(["five-stack"]);
      return { ok: false };
    },
  });
  const mcp = createCodingToolsAppsMcp({ getHost: () => host });

  const catalog = mcp.mergeCatalog({ tools: [{ name: "read_file" }] });
  assert.deepEqual(catalog.tools.map((tool) => tool.name).slice(0, APPS_MCP_TOOLS.length), [...APPS_MCP_TOOLS]);
  assert.equal(catalog.apps.transport, "in-process");
  assert.equal(catalog.apps.dedicatedListenPorts, false);
  assert.equal(catalog.apps.proxySeed, PROXY_SEED);
  assert.equal(catalog.apps.via, "codingTools.apps");
  assert.ok(catalog.tools.some((tool) => tool.name === "read_file"));

  const listed = await mcp.callTool("apps_list", {});
  assert.equal(listed.via, "codingTools.apps.list");
  assert.equal(listed.transport, "in-process");
  assert.equal(listed.dedicatedListenPorts, false);
  assert.ok(listed.modules.some((entry) => entry.id === "cpa"));
  assert.ok(listed.modules.some((entry) => entry.id === "codex-router"));

  const called = await mcp.callTool("apps_call", { moduleId: "cpa", operation: "inspect" });
  assert.equal(called.via, "codingTools.apps.call");
  assert.equal(called.moduleId, "cpa");
  assert.equal(called.transport, "in-process");
  assert.equal(called.result.status, "ready");

  const invoked = await mcp.callTool("apps_invoke", { handle: "cpa", operation: "inspect" });
  assert.equal(invoked.via, "codingTools.apps.invoke");
  assert.equal(invoked.handle, "cpa");

  const status = await mcp.callTool("apps_status", {});
  assert.equal(status.transport, "in-process");
  assert.equal(status.listening, false);
  assert.equal(status.dedicatedListenPorts, false);
  assert.equal(status.proxySeed, PROXY_SEED);
  const cpa = status.modules.find((entry) => entry.id === "cpa");
  assert.equal(cpa.handlerRegistered, true);
  assert.equal(cpa.ready, true);
  assert.equal(cpa.listening, false);
  assert.equal(cpa.dedicatedListenPort, false);
  assert.deepEqual(calls.filter((entry) => entry[0] === "start"), []);
  const inspectCalls = calls.filter((entry) => entry[0] === "inspect");
  assert.ok(inspectCalls.some((entry) => entry[1] === "cpa"));
  assert.equal(inspectCalls.some((entry) => entry[1] === "commandcode-proxy"), false);
  assert.equal(inspectCalls.some((entry) => entry[1] === "paseo"), false);
  assert.equal(inspectCalls.some((entry) => entry[1] === "anneal"), false);
  const commandCode = status.modules.find((entry) => entry.id === "commandcode-proxy");
  assert.equal(commandCode.ready, true);
  assert.equal(commandCode.listening, false);
  assert.equal(mcp.isReadOnly("apps_list"), true);
  assert.equal(mcp.isReadOnly("apps_call", { moduleId: "cpa", operation: "inspect" }), true);
  assert.equal(mcp.isReadOnly("apps_call", { moduleId: "cpa", operation: "start" }), false);
});

test("mergeAppsCatalog does not invent loopback-port MCP tools", () => {
  const merged = mergeAppsCatalog({ tools: [] });
  const names = merged.tools.map((tool) => tool.name);
  assert.equal(names.includes("apps_status"), true);
  assert.equal(names.includes("five_stack_loopbacks"), false);
  assert.equal(names.includes("five_stack_start"), false);
});

test("desktop shell and MCP catalog share the in-process apps overlay", () => {
  const main = read("electron/main.cjs");
  const panel = read("src/features/InProcessAppsPanel.tsx");
  const app = read("src/App.tsx");
  const i18n = read("src/i18n.ts");
  const readme = readRepo("app-handler/README.md");

  assert.match(main, /createCodingToolsAppsMcp/);
  assert.match(main, /mergeAppsCatalog/);
  assert.match(main, /appsMcp\.hasTool/);
  assert.match(main, /appsMcp\.callTool/);
  assert.match(app, /<InProcessAppsPanel/);
  assert.match(app, /surface === "runtime-tools"/);
  assert.match(app, /SidebarGroup label=\{copy\.workspace\}/);
  assert.match(app, /label="MCP"/);
  assert.doesNotMatch(
    app,
    /wizard-footer[\s\S]{0,250}<InProcessAppsPanel/,
  );
  assert.doesNotMatch(app, /FiveStackLoopbackPanel/);
  assert.match(panel, /getCodingToolsClient\(\)/);
  assert.match(panel, /client\.apps\.list/);
  assert.match(panel, /client\.apps\.call/);
  assert.match(panel, /client\.apps\.invoke/);
  assert.match(i18n, /127\.0\.0\.1:17891/);
  assert.doesNotMatch(i18n, /:7890/);
  assert.match(readme, /apps_list/);
  assert.match(readme, /codingTools\.apps\.invoke/);
  assert.match(readme, /listening: false/);
});

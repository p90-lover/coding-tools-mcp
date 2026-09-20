"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("the main shell keeps the original Coding Tools navigation order", () => {
  const app = read("src/App.tsx");
  const styles = read("src/styles.css");
  const i18n = read("src/i18n.ts");

  assert.match(app, /SidebarGroup label=\{copy\.workspace\}/);
  assert.match(app, /SidebarGroup label=\{copy\.configuration\}/);
  assert.match(app, /SidebarGroup label=\{copy\.runtime\}/);
  assert.match(app, /<details className="sidebar-more"/);
  assert.match(app, /copy\.paseoOrchestrator/);
  assert.match(app, /copy\.annealTasks/);
  assert.match(app, /copy\.networkProxy/);
  assert.match(app, /setSidebarState\(\{ open, width \}\)/);
  assert.match(app, /className="sidebar-resize"/);
  assert.match(app, /<InstantMcpToolsSurface/);
  assert.match(app, /copy\.instantMcpTools/);
  assert.match(app, /label="MCP"/);
  assert.doesNotMatch(app, /FiveStackLoopbackPanel/);
  assert.match(styles, /\.content-scroll\.is-fit\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.sidebar-more\s*\{/);
  assert.match(i18n, /product: "Coding Tools"/);
});

test("live MCP tool controls call Instant MCP Tools through codingTools.apps", () => {
  const panel = read("src/features/McpLiveToolsPanel.tsx");
  const contract = read("src/api/instant-mcp-tools-contract.ts");
  const contracts = read("src/api/contracts.ts");
  const preload = read("electron/preload.cjs");
  const main = read("electron/main.cjs");
  const schema = read("electron/ipc-schema.cjs");

  assert.match(panel, /callInstantMcpTools/);
  assert.match(panel, /"listWorkspaces"/);
  assert.match(panel, /"listTools"/);
  assert.match(panel, /"runTool"/);
  assert.match(panel, /instant-mcp-tools/);
  assert.doesNotMatch(panel, /client\.tools\.catalog/);
  assert.doesNotMatch(panel, /client\.workspaces\.list/);
  assert.match(contract, /operation: "inspect"/);
  assert.match(contract, /operation: "listTools"/);
  assert.match(contract, /operation: "runTool"/);
  assert.match(contract, /list-tools/);
  assert.match(contract, /run-tool/);
  assert.match(contract, /client\.apps\.call/);
  const appsPanel = read("src/features/InProcessAppsPanel.tsx");
  assert.match(appsPanel, /client\.apps\.list/);
  assert.match(appsPanel, /client\.apps\.call/);
  assert.match(appsPanel, /client\.apps\.invoke/);
  assert.match(appsPanel, /apps_list/);
  assert.match(appsPanel, /apps_invoke/);
  assert.match(contracts, /readonly tools:/);
  assert.match(contracts, /readonly apps:/);
  assert.match(preload, /"tools.catalog"/);
  assert.match(preload, /"tools.call"/);
  assert.match(preload, /"apps.call"/);
  assert.match(main, /coding-tools:workspaces:list/);
  assert.match(main, /coding-tools:tools:catalog/);
  assert.match(main, /coding-tools:tools:call/);
  assert.match(main, /coding-tools:apps:call/);
  assert.match(main, /mergeAppsCatalog/);
  assert.match(main, /appsMcp\.hasTool/);
  assert.match(schema, /"tools.catalog"/);
  assert.match(schema, /"apps.call"/);
});

test("the shell bridge adapts headless workspaces into the typed page contract", () => {
  const {
    pageWorkspaces,
    toWorkspaceSummary,
  } = require("../electron/coding-tools-shell-bridge.cjs");

  assert.equal(toWorkspaceSummary({ id: "", name: "x", path: "/tmp" }), null);
  assert.deepEqual(toWorkspaceSummary({
    id: "ws-1",
    name: "Demo",
    path: "/tmp/demo",
    mcp_state: "running",
    policy_revision: 4,
  }), {
    id: "ws-1",
    name: "Demo",
    path: "/tmp/demo",
    mcpState: "running",
    policyRevision: 4,
  });

  const page = pageWorkspaces([
    { id: "a", name: "A", path: "/a", mcpState: "stopped", policyRevision: 0 },
    { id: "b", name: "B", path: "/b", mcpState: "running", policyRevision: 1 },
  ], 1, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "b");
  assert.equal(page.nextCursor, null);
});

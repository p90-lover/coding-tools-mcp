"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("the main shell keeps the original core navigation order and consolidates managed engines", () => {
  const app = read("src/App.tsx");
  const managedApps = read("src/features/ManagedAppsSurface.tsx");
  const styles = read("src/styles.css");
  const i18n = read("src/i18n.ts");

  const navigationAnchors = [
    'SidebarGroup label={copy.workspace}',
    'SidebarGroup label={copy.configuration}',
    'SidebarGroup label={copy.runtime}',
    '<details className="sidebar-more"',
    'label={language === "zh-TW"',
    'label={language === "zh-TW" ? "網路代理" : copy.networkProxy}',
  ];
  let previous = -1;
  for (const anchor of navigationAnchors) {
    const index = app.indexOf(anchor);
    assert.ok(index > previous, `navigation anchor is missing or out of order: ${anchor}`);
    previous = index;
  }

  assert.match(app, /import \{ ManagedAppsSurface \} from "\.\/features\/ManagedAppsSurface"/);
  assert.match(app, /active=\{surface === "apps"\}/);
  assert.match(app, /onClick=\{\(\) => navigateSurface\("apps"\)\}/);
  assert.match(app, /language === "zh-TW"\s*\?\s*"受管理應用程式"/);
  assert.match(app, /language === "zh-CN"\s*\?\s*"托管应用"/);
  assert.match(app, /language === "ja"\s*\?\s*"管理対象アプリ"/);
  assert.match(app, /:\s*"Managed Apps"/);
  assert.match(app, /<ManagedAppsSurface/);
  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(managedApps, new RegExp(`id: "${id}"`));
  }

  assert.match(app, /setSidebarState\(\{ open, width \}\)/);
  assert.match(app, /className="sidebar-resize"/);
  assert.match(app, /<McpLiveToolsPanel/);
  assert.match(styles, /\.content-scroll\.is-fit\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.sidebar-more\s*\{/);
  assert.match(i18n, /product: "Coding Tools"/);
});

test("live MCP tool controls call the typed Coding Tools API", () => {
  const panel = read("src/features/McpLiveToolsPanel.tsx");
  const contracts = read("src/api/contracts.ts");
  const preload = read("electron/preload.cjs");
  const main = read("electron/main.cjs");
  const schema = read("electron/ipc-schema.cjs");

  assert.match(panel, /getCodingToolsClient\(\)/);
  assert.match(panel, /client\.workspaces\.list/);
  assert.match(panel, /client\.tools\.catalog/);
  assert.match(panel, /tools\.call/);
  assert.match(contracts, /readonly tools:/);
  assert.match(preload, /"tools.catalog"/);
  assert.match(preload, /"tools.call"/);
  assert.match(main, /coding-tools:workspaces:list/);
  assert.match(main, /coding-tools:tools:catalog/);
  assert.match(main, /coding-tools:tools:call/);
  assert.match(schema, /"tools.catalog"/);
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

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
  assert.match(app, /<WorkspacePanel/);

  assert.match(app, /label="MCP"/);
  assert.doesNotMatch(app, /FiveStackLoopbackPanel/);
  assert.match(styles, /\.content-scroll\.is-fit\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.sidebar-more\s*\{/);
  assert.match(i18n, /product: "Coding Tools"/);
});

test("the MCP wizard matches the bundled upstream surface and keeps live tools separate", () => {
  const app = read("src/App.tsx");
  const upstream = fs.readFileSync(
    path.resolve(root, "..", "vendor", "codex-chatgpt-web-v5.0.6", "launcher", "src", "App.tsx"),
    "utf8",
  );
  const extract = (source, name, next) => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`\nfunction ${next}(`, start + 1);
    assert.ok(start >= 0 && end > start, `${name} must remain a standalone surface`);
    return source.slice(start, end).replaceAll("\r\n", "\n");
  };

  assert.equal(extract(app, "McpSurface", "ActivitySurface"), extract(upstream, "McpSurface", "ActivitySurface"));
  assert.match(app, /function InstantMcpToolsSurface[\s\S]*?<WorkspacePanel/);
  assert.match(app, /surface === "instant-mcp"/);
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
    linked_projects: [{ alias: "side", name: "Side", path: "/tmp/side", mode: "read-only" }],
    mcp_state: "running",
    policy_revision: 4,
    permission_mode: "workspace-write",
    approval_mode: "on-request",
    tool_profile: "advanced",
    mcp_auth_type: "oauth",
    actions_auth_type: "api_key",
    mcp_local_port: 28766,
    actions_local_port: 8787,
    screen_capture_enabled: true,
    mcp_oauth_client_id: "client-1",
    mcp_oauth_redirect_uris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    mcp_use_shared_secrets: false,
    actions_oauth_client_id: "actions-1",
    actions_oauth_redirect_uris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    actions_oauth_scopes: "read",
    actions_use_shared_secrets: true,
  }), {
    id: "ws-1",
    name: "Demo",
    path: "/tmp/demo",
    linkedProjects: [{ alias: "side", name: "Side", path: "/tmp/side", mode: "read-only" }],
    mcpState: "running",
    policyRevision: 4,
    permissionMode: "workspace-write",
    approvalMode: "on-request",
    toolProfile: "advanced",
    mcpAuthType: "oauth",
    actionsAuthType: "api_key",
    mcpLocalPort: 28766,
    actionsLocalPort: 8787,
    screenCaptureEnabled: true,
    mcpOAuthClientId: "client-1",
    mcpOAuthRedirectUris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    mcpUseSharedSecrets: false,
    actionsOAuthClientId: "actions-1",
    actionsOAuthRedirectUris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    actionsOAuthScopes: "read",
    actionsUseSharedSecrets: true,
  });

  const page = pageWorkspaces([
    { id: "a", name: "A", path: "/a", mcpState: "stopped", policyRevision: 0 },
    { id: "b", name: "B", path: "/b", mcpState: "running", policyRevision: 1 },
  ], 1, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "b");
  assert.equal(page.nextCursor, null);
});

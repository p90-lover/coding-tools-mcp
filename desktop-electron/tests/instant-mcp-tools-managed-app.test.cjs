"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { MODULE_IDS } = require("../../app-handler/host.cjs");
const { createCodingToolsAppsMcp } = require("../electron/coding-tools-apps-mcp.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("Instant MCP Tools is a Managed App sidebar surface with in-process embed", () => {
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const surface = read("src/features/InstantMcpToolsSurface.tsx");
  const integrations = read("src/features/ExternalServicesSurface.tsx");

  assert.match(types, /"instant-mcp-tools"/);
  assert.match(app, /navigateSurface\("instant-mcp-tools"\)/);
  assert.match(app, /<InstantMcpToolsSurface/);
  assert.match(app, /copy\.instantMcpTools/);
  assert.match(app, /openInstantMcpTools=\{\(\) => navigateSurface\("instant-mcp-tools"\)\}/);
  assert.match(surface, /data-transport="in-process"/);
  assert.match(surface, /data-no-listen-port="true"/);
  assert.match(surface, /data-start="false"/);
  assert.match(surface, /<McpLiveToolsPanel/);
  assert.match(surface, /<InProcessAppsPanel/);
  assert.match(surface, /client\.apps\.list\(\)/);
  assert.match(surface, /callInstantMcpTools\("inspect"\)/);
  assert.match(surface, /INSTANT_MCP_TOOLS_MODULE_ID/);
  assert.doesNotMatch(surface, /callModule\("start"\)/);
  assert.doesNotMatch(surface, /open-port/);
  assert.doesNotMatch(surface, /setupCore/);
  assert.doesNotMatch(surface, /--restart-service/);
  assert.match(integrations, /openInstantMcpTools/);
  assert.match(surface, /copy\.instantMcpToolsConnected/);
  assert.match(surface, /copy\.instantMcpToolsInProcessStatus/);
  assert.doesNotMatch(surface, /function localize\(/);
});

test("MCP setup page keeps a thin Instant MCP Tools link instead of the live-tool panels", () => {
  const app = read("src/App.tsx");
  const mcpSurface = app.slice(app.indexOf("function McpSurface"), app.indexOf("function ActivitySurface"));
  assert.match(mcpSurface, /copy\.liveMcpToolsMoved/);
  assert.match(mcpSurface, /openInstantMcpTools/);
  assert.doesNotMatch(mcpSurface, /<McpLiveToolsPanel/);
  assert.doesNotMatch(mcpSurface, /<InProcessAppsPanel/);
});

test("apps_list stays callable on the existing in-process host without Instant MCP Tools inventing a module folder", async () => {
  assert.deepEqual([...MODULE_IDS], ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]);
  assert.equal(fs.existsSync(path.join(repoRoot, "app-handler/instant-mcp-tools")), false);

  const host = createCodingToolsAppsHost({
    services: {
      inspect: async (id) => ({ id, status: "ready" }),
      start: async () => {
        throw new Error("Instant MCP Tools must not open a listen-port Start");
      },
    },
  });
  const mcp = createCodingToolsAppsMcp({ getHost: () => host });
  const listed = await mcp.callTool("apps_list", {});
  assert.equal(listed.via, "codingTools.apps.list");
  assert.equal(listed.transport, "in-process");
  assert.equal(listed.dedicatedListenPorts, false);
  assert.ok(listed.modules.some((entry) => entry.id === "cpa"));
  assert.equal(listed.modules.some((entry) => entry.id === "instant-mcp-tools"), false);
});

test("typed Instant MCP Tools stubs prefer camelCase ops and keep kebab aliases", () => {
  const contracts = read("src/api/contracts.ts");
  const stub = read("src/api/instant-mcp-tools-contract.ts");
  const panel = read("src/features/McpLiveToolsPanel.tsx");
  const schema = read("electron/ipc-schema.cjs");
  const host = readRepo("app-handler/host.cjs");
  const readme = readRepo("app-handler/README.md");
  const i18n = read("src/i18n.ts");

  assert.match(contracts, /AppsModuleId/);
  assert.match(contracts, /"instant-mcp-tools"/);
  assert.match(stub, /apps_list|codingTools\.apps\.call/);
  assert.match(stub, /listTools/);
  assert.match(stub, /runTool/);
  assert.match(stub, /listWorkspaces/);
  assert.match(stub, /list-tools/);
  assert.match(stub, /run-tool/);
  assert.match(stub, /TODO\(Bot GG\)|Bot GG owns/);
  assert.match(panel, /"listTools"/);
  assert.match(panel, /"runTool"/);
  assert.match(panel, /"listWorkspaces"/);
  assert.doesNotMatch(panel, /client\.tools\.catalog/);
  assert.match(schema, /"instant-mcp-tools"/);
  assert.match(host, /instant-mcp-tools/);
  assert.match(host, /listTools/);
  assert.doesNotMatch(host, /MODULE_IDS = Object\.freeze\(\[[^\]]*instant-mcp-tools/s);
  assert.match(readme, /instant-mcp-tools/);
  assert.match(readme, /TODO\(Bot GG/);
  assert.match(readme, /listTools/);
  assert.match(i18n, /instantMcpTools:/);
  assert.doesNotMatch(stub, /setupCore/);
  assert.doesNotMatch(stub, /--restart-service/);
  assert.doesNotMatch(panel, /setupCore/);
  assert.doesNotMatch(panel, /--restart-service/);
  assert.equal(fs.existsSync(path.join(repoRoot, "app-handler/instant-mcp-tools")), false);
});

test("Instant MCP Tools white chrome uses light tokens, bounded height, and locale-specific status copy", () => {
  const css = read("src/features/instant-mcp-tools.css");
  const originalUi = read("src/features/original-ui.css");
  const surface = read("src/features/InstantMcpToolsSurface.tsx");
  const i18n = read("src/i18n.ts");
  const zhTW = read("src/i18n/locales/zh-TW.ts");

  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--color-text-primary:\s*#111827/);
  assert.match(css, /--color-background-control:\s*#f3f4f6/);
  assert.match(css, /--titlebar-height:\s*var\(--height-titlebar,\s*46px\)/);
  assert.match(css, /height:\s*calc\(100vh - var\(--titlebar-height\)\)/);
  assert.match(css, /\.instant-mcp-tools-embed \{[\s\S]*overflow:\s*auto/);
  assert.doesNotMatch(originalUi, /--height-titlebar/);
  assert.match(originalUi, /var\(--titlebar-height\)/);
  assert.match(surface, /copy\.instantMcpToolsConnected/);
  assert.match(i18n, /instantMcpToolsConnected: "Connected"/);
  assert.match(i18n, /instantMcpToolsConnected: "已连接"/);
  assert.match(i18n, /instantMcpToolsInProcessStatus: "进程内画面"/);
  assert.doesNotMatch(i18n, /instantMcpToolsConnected: "已連線"/);
  assert.doesNotMatch(i18n, /instantMcpToolsInProcessStatus: "行程內畫面"/);
  assert.match(zhTW, /instantMcpToolsConnected: "已連線"/);
  assert.match(zhTW, /instantMcpToolsInProcessStatus: "行程內畫面"/);
});

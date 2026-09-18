"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createCodingToolsShellBridge,
  mergeFiveStackCatalog,
} = require("../electron/coding-tools-shell-bridge.cjs");
const { createExternalServicesController } = require("../electron/external-services.cjs");
const { probeAll } = require("../electron/five-stack-loopbacks.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("hello MCP/shell lane keeps original navigation and hard-targets five loopbacks", () => {
  const app = read("src/App.tsx");
  const panel = read("src/features/FiveStackLoopbackPanel.tsx");
  const i18n = read("src/i18n.ts");
  const integrations = read("src/features/ExternalServicesSurface.tsx");
  const loopbacks = read("electron/five-stack-loopbacks.cjs");
  const services = read("electron/external-services.cjs");
  const managed = read("electron/managed-external-services.cjs");

  assert.match(app, /SidebarGroup label=\{copy\.workspace\}/);
  assert.match(app, /label="MCP"/);
  assert.match(app, /copy\.activity/);
  assert.match(app, /<FiveStackLoopbackPanel/);
  assert.match(panel, /five_stack_start/);
  assert.match(i18n, /CPA :8317, Codex Router :4202, CommandCode :9090/);
  assert.match(integrations, /A separate download is not required/);
  assert.doesNotMatch(integrations, /GitHub read token required/);
  assert.match(integrations, /className="primary".*Start/);
  assert.match(loopbacks, /http:\/\/127\.0\.0\.1:8317/);
  assert.match(loopbacks, /http:\/\/127\.0\.0\.1:4202/);
  assert.match(loopbacks, /http:\/\/127\.0\.0\.1:9090\/health/);
  assert.match(loopbacks, /http:\/\/127\.0\.0\.1:3050\/v1\/models/);
  assert.match(loopbacks, /ws:\/\/127\.0\.0\.1:6768\/ws/);
  assert.match(loopbacks, /http:\/\/127\.0\.0\.1:3000\/#\/tasks/);
  assert.match(services, /executionEndpoint: "ws:\/\/127\.0\.0\.1:6768\/ws"/);
  assert.doesNotMatch(services, /ws:\/\/127\.0\.0\.1:6767\/ws/);
  assert.match(managed, /Loopback Start must not become a download\/install gate/);
});

test("shell MCP overlay exposes five-stack status without a headless catalog", async () => {
  const merged = mergeFiveStackCatalog({ tools: [] });
  const names = merged.tools.map((tool) => tool.name);
  assert.equal(names.includes("five_stack_status"), true);
  assert.equal(names.includes("five_stack_loopbacks"), true);
  assert.equal(names.includes("five_stack_start"), true);
  assert.equal(merged.five_stack.stacks.cpa.origin, "http://127.0.0.1:8317");

  const bridge = createCodingToolsShellBridge({
    assertFocusedMainWindow: () => {},
    headlessHost: {
      request: async () => {
        throw new Error("headless crashed");
      },
    },
    fiveStack: {
      probeAll: async () => ({
        generatedAt: "2026-09-18T00:00:00.000Z",
        loopbackOnly: true,
        downloadRequired: false,
        stacks: [
          {
            id: "cpa",
            name: "CPA / CLIProxyAPI",
            origin: "http://127.0.0.1:8317",
            listening: true,
            callerKey: "should-strip",
          },
        ],
      }),
    },
  });

  const catalog = await bridge.toolsCatalog({}, { workspaceId: "ws-1" });
  assert.equal(catalog.source, "shell-loopback-fallback");
  assert.equal(catalog.tools.some((tool) => tool.name === "five_stack_status"), true);

  const status = await bridge.toolsCall({}, { workspaceId: "ws-1", tool: "five_stack_status", arguments: {} });
  assert.equal(status.stacks[0].listening, true);
  assert.equal(status.stacks[0].callerKey, undefined);

  const snapshot = await bridge.integrationsSnapshot({});
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.downloadRequired, false);
  assert.equal(snapshot.loopbacks.stacks.paseo.port, 6768);
});

test("inspect rejects CommandCode 401 while Start skips spawn on a listening loopback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hello-mcp-loopback-401-"));
  let spawned = 0;
  let authorization = null;
  const fetchImpl = async (_url, options = {}) => {
    authorization = options.headers?.Authorization || null;
    return {
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      clone: () => ({ json: async () => ({ error: "unauthorized" }) }),
    };
  };
  const health = await probeAll({ timeoutMs: 200, fetchImpl });
  assert.equal(health.stacks.find((stack) => stack.id === "commandcode-proxy").listening, true);

  const controller = createExternalServicesController({
    filePath: path.join(directory, "services.json"),
    keyPath: path.join(directory, "services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    getHealthHeaders: () => ({ Authorization: "Bearer managed-secret" }),
    fetchImpl,
    spawnProcess: () => {
      spawned += 1;
      throw new Error("loopback start must not spawn when the port is already listening");
    },
  });
  const inspected = await controller.inspect("commandcode-proxy");
  assert.equal(authorization, "Bearer managed-secret");
  assert.equal(inspected.status, "error");
  assert.equal(inspected.statusCode, 401);
  const started = await controller.start("commandcode-proxy");
  assert.equal(spawned, 0);
  assert.equal(started.status, "error");
  assert.equal(started.statusCode, 401);
  controller.dispose();
});

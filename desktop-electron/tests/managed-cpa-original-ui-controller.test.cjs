"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createOriginalUiController,
  loadManifest,
  normalizeLoopbackEndpoint,
  sectionUrl,
} = require("../electron/original-ui.cjs");

function readyCpaService() {
  return {
    id: "cpa",
    name: "CPA / CLIProxyAPI",
    endpoint: "http://127.0.0.1:8317/",
    status: "ready",
    pid: 8317,
    error: null,
    home: "/managed/cpa",
    managedInstall: { state: "installed" },
  };
}

test("CPA original UI URLs stay on loopback and use the pinned management routes", () => {
  const manifest = loadManifest("cpa");
  assert.equal(normalizeLoopbackEndpoint("http://localhost:8317"), "http://localhost:8317/");
  assert.throws(() => normalizeLoopbackEndpoint("https://example.com/"), /loopback|127\.0\.0\.1/iu);
  assert.equal(
    sectionUrl(manifest, "http://127.0.0.1:8317/", "providers"),
    "http://127.0.0.1:8317/management.html#/providers",
  );
});

test("CPA original UI opens inside the managed tab without a standalone window", async () => {
  const service = readyCpaService();
  const externalServices = {
    snapshot: () => ({ version: 1, services: [service] }),
    inspect: async () => service,
    cpaConnection: () => ({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "management-secret-value-1234567890",
      proxyApiKey: "proxy-secret-value-123456789012345",
    }),
  };
  const controller = createOriginalUiController({ externalServices });
  const opened = await controller.openEmbedded("cpa", "dashboard");
  assert.equal(opened.embedded, true);
  assert.equal(opened.url, "http://127.0.0.1:8317/management.html#/dashboard");
  assert.equal(Object.hasOwn(opened, "originalWindow"), false);
  assert.equal(Object.hasOwn(opened, "pid"), false);
  assert.equal(JSON.stringify(controller.snapshot()).includes("management-secret-value"), false);
});

test("CPA management-key copy returns metadata only", () => {
  let copied = "";
  const externalServices = {
    snapshot: () => ({ version: 1, services: [readyCpaService()] }),
    cpaConnection: () => ({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "management-secret-value-1234567890",
      proxyApiKey: "proxy-secret-value-123456789012345",
    }),
  };
  const controller = createOriginalUiController({ externalServices });
  const result = controller.copyCpaManagementKey({ writeText: (value) => { copied = value; } });
  assert.equal(copied, "management-secret-value-1234567890");
  assert.deepEqual(result, { copied: true, length: copied.length });
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(Object.hasOwn(result, "managementKey"), false);
});

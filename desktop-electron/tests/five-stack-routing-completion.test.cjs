"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, "..");
const read = (relativePath) => fs.readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8");

function retainedTestRoot(name) {
  const root = path.join(
    REPOSITORY_ROOT,
    "aiTemp",
    "rc8-five-stack-tests",
    `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function connectedSnapshot(providerId, model = "model-1") {
  return {
    version: 1,
    accounts: [{
      id: `${providerId}-account`,
      providerId,
      label: providerId,
      auth: providerId === "commandcode-proxy" ? "local_proxy" : "oauth",
      status: "connected",
      enabled: true,
      isDefault: true,
      hasCredential: providerId === "commandcode-proxy",
      models: [model],
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    }],
    proxyProfiles: [],
    routing: {
      globalEnabled: false,
      globalProfileId: null,
      providers: [],
      accounts: [],
    },
  };
}

test("CPA routing plans Codex subagents, Paseo, and Anneal through one account policy", () => {
  const {
    PROVIDER_EXECUTION_CATALOG,
    createProviderExecutionPlan,
  } = require("../electron/provider-execution-router.cjs");

  const provider = PROVIDER_EXECUTION_CATALOG.find((entry) => entry.id === "commandcode-proxy");
  assert.equal(provider?.subagentEnabled, true);

  for (const workload of ["subagent", "paseo", "anneal"]) {
    const plan = createProviderExecutionPlan(
      connectedSnapshot("commandcode-proxy"),
      {
        workload,
        providerId: "commandcode-proxy",
        accountId: "commandcode-proxy-account",
        model: "model-1",
        allowFallback: false,
      },
    );
    assert.equal(plan.workload, workload);
    assert.equal(plan.provider.id, "commandcode-proxy");
    assert.equal(plan.account.id, "commandcode-proxy-account");
    assert.deepEqual(plan.credentialHandle, {
      providerId: "commandcode-proxy",
      accountId: "commandcode-proxy-account",
    });
  }
});

test("external service state owns persisted execution endpoints for Paseo and Anneal", () => {
  const { createExternalServicesController } = require("../electron/external-services.cjs");
  const root = retainedTestRoot("execution-endpoints");
  const filePath = path.join(root, "external-services.json");
  const keyPath = path.join(root, "external-services.key");
  const controller = createExternalServicesController({
    filePath,
    keyPath,
    safeStorage: { isEncryptionAvailable: () => false },
    env: {},
  });

  const initialPaseo = controller.snapshot().services.find((service) => service.id === "paseo");
  const initialAnneal = controller.snapshot().services.find((service) => service.id === "anneal");
  assert.equal(initialPaseo.executionEndpoint, "ws://127.0.0.1:6767/ws");
  assert.equal(initialAnneal.executionEndpoint, "http://127.0.0.1:3000/");

  controller.configure("paseo", { executionEndpoint: "ws://localhost:7777/control" });
  controller.configure("anneal", { executionEndpoint: "http://localhost:3100/api" });
  assert.equal(
    controller.snapshot().services.find((service) => service.id === "paseo").executionEndpoint,
    "ws://localhost:7777/control",
  );
  assert.equal(
    controller.snapshot().services.find((service) => service.id === "anneal").executionEndpoint,
    "http://localhost:3100/api/",
  );
  assert.throws(
    () => controller.configure("paseo", { executionEndpoint: "ws://example.com/ws" }),
    /loopback/i,
  );
  assert.throws(
    () => controller.configure("anneal", { executionEndpoint: "ws://127.0.0.1:3000/ws" }),
    /HTTP/i,
  );
  controller.dispose();

  const reopened = createExternalServicesController({
    filePath,
    keyPath,
    safeStorage: { isEncryptionAvailable: () => false },
    env: {},
  });
  assert.equal(
    reopened.snapshot().services.find((service) => service.id === "paseo").executionEndpoint,
    "ws://localhost:7777/control",
  );
  assert.equal(
    reopened.snapshot().services.find((service) => service.id === "anneal").executionEndpoint,
    "http://localhost:3100/api/",
  );
  reopened.dispose();
});

test("renderer, agent adapter, and browser login use the unified integration contracts", () => {
  const types = read("src/types.ts");
  const providers = read("src/providers/provider-types.ts");
  const agentAdapter = read("src/agents/agent-provider-adapter.ts");
  const providerSurface = read("src/features/ProviderHubSaasSurface.tsx");
  const serviceSurface = read("src/features/ExternalServicesSurface.tsx");
  const providerNetwork = read("electron/provider-network.cjs");

  assert.match(types, /ProviderExecutionWorkload\s*=\s*"subagent"\s*\|\s*"paseo"\s*\|\s*"anneal"/);
  assert.match(types, /\|\s*"subagent"/);
  assert.match(types, /executionEndpoint\?:\s*string/);
  assert.match(providers, /subagentEnabled:\s*boolean/);
  assert.match(agentAdapter, /planAgentExecution/);
  assert.match(agentAdapter, /workload:\s*"subagent"/);
  assert.match(providerSurface, /externalServicesSnapshot/);
  assert.match(providerSurface, /onExternalServicesChanged/);
  assert.match(providerSurface, /executionEndpoint/);
  assert.match(serviceSurface, /Execution endpoint/);
  assert.match(serviceSurface, /執行端點/);
  assert.match(providerNetwork, /syncBrowserProviderAccount/);
  assert.match(providerNetwork, /Browser provider login is unavailable/);
  assert.match(providerNetwork, /browser\.authenticated\s*!==\s*true/);
});

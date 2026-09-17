"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function connectedSnapshot(providerId, accountId = `${providerId}-account`) {
  return {
    version: 1,
    accounts: [{
      id: accountId,
      providerId,
      label: providerId,
      auth: providerId === "commandcode-proxy" ? "local_proxy" : "oauth",
      status: "connected",
      enabled: true,
      isDefault: true,
      hasCredential: providerId === "commandcode-proxy",
      models: ["model-1"],
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
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

test("browser-backed Codex and ChatGPT providers use the live BrowserHost and fail closed", () => {
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const main = read("electron/main.cjs");
  const network = read("electron/provider-network.cjs");

  assert.match(bootstrap, /setProviderBrowserHostResolver/);
  assert.doesNotMatch(bootstrap, /getBrowserHost:\s*\(\)\s*=>\s*null/);
  assert.match(main, /setProviderBrowserHostResolver\(\(\)\s*=>\s*browserHost\)/);
  assert.match(network, /syncBrowserProviderAccount/);
  assert.match(network, /Browser provider login is unavailable/);
  assert.match(network, /browser\.authenticated\s*!==\s*true/);
});

test("Codex Router plans subagent, Paseo, and Anneal through the same account policy", () => {
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

  const providerTypes = read("src/providers/provider-types.ts");
  const publicTypes = read("src/types.ts");
  assert.match(providerTypes, /subagentEnabled:\s*boolean/);
  assert.match(publicTypes, /ProviderExecutionWorkload\s*=\s*"subagent"\s*\|\s*"paseo"\s*\|\s*"anneal"/);
  assert.match(publicTypes, /\|\s*"subagent";/);
});

test("CPA-style Provider Center exposes the full requested account catalogue", () => {
  const providerTypes = read("src/providers/provider-types.ts");
  const providerSurface = read("src/features/ProviderHubSaasSurface.tsx");

  for (const providerId of [
    "codex-oauth",
    "claude-oauth",
    "commandcode-proxy",
    "cliproxyapi-antigravity",
  ]) {
    assert.match(providerTypes, new RegExp(`id:\\s*"${providerId}"`));
    assert.match(providerSurface, new RegExp(`"${providerId}"`));
  }

  assert.match(providerSurface, /setDefaultProviderAccount/);
  assert.match(providerSurface, /setProviderAccountEnabled/);
  assert.match(providerSurface, /archiveProviderAccount/);
  assert.match(providerSurface, /probeProviderAccount/);
  assert.match(providerSurface, /importProviderSession/);
});

test("CommandCode remains a real encrypted login, import, discovery, and probe integration", () => {
  const network = read("electron/provider-network.cjs");
  const bootstrap = read("electron/provider-bootstrap.cjs");

  assert.match(network, /startCommandCodeLogin/);
  assert.match(network, /commandCodeAuthFilePath/);
  assert.match(network, /inspectCommandCodeSession/);
  assert.match(network, /\/v1\/models/);
  assert.match(network, /electron-safe-storage-v1/);
  assert.match(network, /aes-256-gcm-v1/);
  assert.match(bootstrap, /launcher:provider-session-import/);
  assert.match(bootstrap, /launcher:provider-account-probe/);
});

test("Paseo and Anneal expose managed runtime mode and honest prerequisites", () => {
  const upstream = read("electron/upstream-tools.cjs");
  const preload = read("electron/preload.cjs");
  const publicTypes = read("src/types.ts");
  const paseo = JSON.parse(read("vendor/upstream/paseo.json"));
  const anneal = JSON.parse(read("vendor/upstream/anneal.json"));

  assert.match(upstream, /resolveRuntimeSource/);
  assert.match(upstream, /runtimeMode/);
  assert.match(upstream, /prerequisites/);
  assert.match(upstream, /managedRoot/);
  assert.match(preload, /provisionUpstreamTool/);
  assert.match(publicTypes, /UpstreamToolRuntimeMode/);
  assert.match(publicTypes, /provisionUpstreamTool/);

  assert.equal(paseo.runtime?.managed, true);
  assert.equal(paseo.runtime?.platforms?.includes("win32"), true);
  assert.equal(anneal.runtime?.managed, true);
  assert.equal(anneal.runtime?.platforms?.includes("win32"), false);
  assert.match(String(anneal.runtime?.prerequisites?.join(" ")), /Docker/i);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

test("the updater supports manual refresh, periodic discovery, and one-click install", () => {
  const updater = read("electron/update.cjs");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  const app = read("src/App.tsx");

  assert.match(updater, /DEFAULT_UPDATE_CHECK_INTERVAL_MS/);
  assert.match(updater, /checkNow/);
  assert.match(updater, /startPeriodicChecks/);
  assert.match(main, /launcher:update-check/);
  assert.match(main, /launcher:update-automatic/);
  assert.match(preload, /checkForUpdates/);
  assert.match(preload, /setAutomaticUpdates/);
  assert.match(types, /checkForUpdates\(\)/);
  assert.match(types, /setAutomaticUpdates\(enabled: boolean\)/);
  assert.match(app, /checkForUpdates/);
  assert.match(app, /automaticUpdates/);
});

test("Provider Center account creation is independent from workspace routing", () => {
  const surface = read("src/features/ProviderHubSaasSurface.tsx");

  assert.match(surface, /const accountValidation/);
  assert.match(surface, /provider-account-inline-error/);
  assert.match(surface, /Save account/);
  assert.doesNotMatch(
    surface.match(/onClick=\{\(\) => void saveAccount\(\)\}[\s\S]{0,240}/)?.[0] ?? "",
    /workspaceId/,
  );
  assert.match(surface, /routingRequirements/);
});

test("CommandCode Proxy supports native OAuth, CLI-session import, discovery, and probing", () => {
  const providerTypes = read("src/providers/provider-types.ts");
  const network = read("electron/provider-network.cjs");
  const preload = read("electron/preload.cjs");
  const surface = read("src/features/ProviderHubSaasSurface.tsx");

  assert.match(providerTypes, /"commandcode_oauth"/);
  assert.match(providerTypes, /loginMode:\s*"commandcode_oauth"/);
  assert.match(network, /COMMANDCODE_PROVIDER_ID/);
  assert.match(network, /commandcode\.ai\/studio\/auth\/cli/);
  assert.match(network, /\.commandcode[\\/]auth\.json/);
  assert.match(network, /startCommandCodeLogin/);
  assert.match(network, /inspectCommandCodeSession/);
  assert.match(preload, /importProviderSession/);
  assert.match(surface, /Import CommandCode CLI session/);
  assert.match(surface, /Login with CommandCode/);
});

test("the app contains pinned, licensed full upstream Paseo and Anneal integrations", () => {
  for (const relativePath of [
    "vendor/upstream/anneal.json",
    "vendor/upstream/paseo.json",
    "electron/upstream-tools.cjs",
    "src/features/UpstreamToolSurface.tsx",
    "src/features/upstream-tool.css",
  ]) {
    assert.equal(exists(relativePath), true, `${relativePath} is missing`);
  }

  const anneal = JSON.parse(read("vendor/upstream/anneal.json"));
  const paseo = JSON.parse(read("vendor/upstream/paseo.json"));
  const host = read("electron/upstream-tools.cjs");
  const surface = read("src/features/UpstreamToolSurface.tsx");
  const app = read("src/App.tsx");

  assert.equal(anneal.repository, "mosonlab/anneal");
  assert.equal(anneal.license, "MIT");
  assert.ok(anneal.commit);
  assert.deepEqual(
    anneal.sections,
    ["tasks", "projects", "agents", "sessions", "inbox", "automations", "triggers", "costs", "goals", "connections", "settings"],
  );
  assert.equal(paseo.repository, "getpaseo/paseo");
  assert.equal(paseo.license, "Apache-2.0");
  assert.ok(paseo.commit);
  assert.deepEqual(
    paseo.sections,
    ["agents", "sessions", "workspaces", "providers", "plugins", "voice", "settings"],
  );
  assert.match(host, /createUpstreamToolController/);
  assert.match(host, /anneal/);
  assert.match(host, /paseo/);
  assert.match(host, /127\.0\.0\.1/);
  assert.match(surface, /UpstreamToolSurface/);
  assert.match(surface, /openEmbeddedTool/);
  assert.match(app, /UpstreamToolSurface/);
});

test("architecture B exposes one GUI control plane for Provider Hub and external services", () => {
  for (const relativePath of [
    "electron/external-services.cjs",
    "src/features/ExternalServicesSurface.tsx",
    "src/features/external-services.css",
    "vendor/upstream/codex-router.json",
    "vendor/upstream/commandcode-proxy.json",
  ]) {
    assert.equal(exists(relativePath), true, `${relativePath} is missing`);
  }

  const main = read("electron/main.cjs");
  const providerBootstrap = read("electron/provider-bootstrap.cjs");
  const app = read("src/App.tsx");
  const surface = read("src/features/ExternalServicesSurface.tsx");

  assert.match(providerBootstrap, /setProviderBrowserHost/);
  assert.match(main, /launcher:external-services-snapshot/);
  assert.match(main, /launcher:codex-router-sync/);
  assert.match(app, /surface === "integrations"/);
  assert.match(surface, /providerSnapshot/);
  assert.match(surface, /Codex Router/);
  assert.match(surface, /CommandCode Proxy/);
  assert.match(surface, /Paseo/);
  assert.match(surface, /Anneal/);
});

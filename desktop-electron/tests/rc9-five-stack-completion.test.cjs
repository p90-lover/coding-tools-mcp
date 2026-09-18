"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createExternalServicesController } = require("../electron/external-services.cjs");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("Codex Router is the pinned managed git source plus original Control Center", () => {
  const manifest = JSON.parse(read("vendor/managed-components/codex-router.json"));
  assert.equal(manifest.strategy, "bundled-source");
  assert.equal(manifest.commit, "930f547d8d8861a47e18a83216e15e73a73aa97c");
  assert.match(JSON.stringify(manifest), /codex-router-managed\.cjs/);
  assert.doesNotMatch(JSON.stringify(manifest), /AppImage|setup\.exe|release-binary/iu);
  assert.equal(fs.existsSync(path.join(root, "electron/codex-router-managed.cjs")), true);
});

test("Anneal token is optional and fresh migration stays gated to a new dedicated volume", () => {
  const manifest = JSON.parse(read("vendor/managed-components/anneal.json"));
  assert.equal(manifest.strategy, "bundled-source");
  assert.equal(manifest.bundle.entrypoint, "package.json");
  assert.equal(manifest.credentials.githubReadToken.required, false);
  const serialized = JSON.stringify(manifest);
  assert.match(serialized, /database-v0\.9\.0\.initialized/);
  assert.match(serialized, /docker volume ls/);
  assert.match(serialized, /refusing a fresh reset/);
  assert.match(serialized, /--fresh/);
  const directFreshMigrations = manifest.install.steps.filter((step) =>
    step.executable === "{npm}" && Array.isArray(step.arguments) && step.arguments.includes("--fresh"),
  );
  assert.deepEqual(directFreshMigrations, []);
  const databaseStep = manifest.install.steps.find((step) => step.id === "initialize-dedicated-database");
  const guardedScript = databaseStep?.arguments?.join(" ") ?? "";
  assert.ok(guardedScript.indexOf("docker volume ls") >= 0);
  assert.ok(guardedScript.indexOf("docker volume ls") < guardedScript.indexOf("--fresh"));
});

test("CommandCode health sends the managed bearer token and rejects 401", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-strict-health-"));
  let authorization = null;
  const controller = createExternalServicesController({
    filePath: path.join(directory, "services.json"),
    keyPath: path.join(directory, "services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    getHealthHeaders: () => ({ Authorization: "Bearer managed-secret" }),
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return {
        ok: false,
        status: 401,
        headers: { get: () => "application/json" },
        clone: () => ({ json: async () => ({ error: "unauthorized" }) }),
      };
    },
  });
  const result = await controller.inspect("commandcode-proxy");
  assert.equal(authorization, "Bearer managed-secret");
  assert.equal(result.status, "error");
  assert.equal(result.statusCode, 401);
  controller.dispose();
});

test("CPA is a managed original UI while runtimes expose app-managed install and credential wiring", () => {
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const app = read("src/App.tsx");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const provider = read("electron/provider-network.cjs");
  assert.match(surface, /CPA \/ CLIProxyAPI/);
  assert.match(surface, /Open original UI/);
  assert.match(app, /<OriginalUiSurface language=\{language\} setError=\{setError\} toolId="cpa" \/>/);
  assert.match(surface, /Save credential/);
  assert.match(main, /launcher:managed-component-credential/);
  assert.match(preload, /setManagedComponentCredential/);
  assert.match(provider, /COMMANDCODE_PROVIDER_ID/);
});

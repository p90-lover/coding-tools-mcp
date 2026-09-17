"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DESKTOP_ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test("the app registers Codex Router, CPA, CommandCode, Paseo, and Anneal as one product stack", () => {
  const stack = readJson("vendor/upstream/five-stack.json");
  assert.equal(stack.schemaVersion, 1);
  assert.deepEqual(
    stack.integrations.map((entry) => entry.id),
    ["codex-router", "cpa-provider-hub", "commandcode-proxy", "paseo", "anneal"],
  );
  for (const entry of stack.integrations) {
    assert.equal(entry.insideApp, true, `${entry.id} must be controlled inside the app`);
    assert.ok(entry.surface, `${entry.id} must name its in-app surface`);
    assert.ok(entry.healthContract, `${entry.id} must define a health contract`);
  }
});

test("Paseo has a pinned managed installation and production daemon topology", () => {
  const paseo = readJson("vendor/upstream/paseo.json");
  assert.equal(paseo.defaultEndpoint, "http://127.0.0.1:6767/");
  assert.equal(paseo.managed.strategy, "pinned-source");
  assert.equal(paseo.managed.autoInstall, true);
  assert.equal(paseo.managed.source.repositoryUrl, "https://github.com/getpaseo/paseo.git");
  assert.equal(paseo.managed.source.commit, paseo.commit);
  assert.ok(paseo.managed.setup.some((step) => step.id === "npm-ci"));
  assert.ok(paseo.managed.setup.some((step) => step.id === "build-server"));
  assert.deepEqual(paseo.managed.services.map((service) => service.id), ["daemon"]);
  assert.deepEqual(paseo.managed.services[0].arguments, ["start"]);
  assert.equal(paseo.managed.services[0].environment.PASEO_LISTEN, "127.0.0.1:6767");
  assert.match(paseo.managed.officialRelease.win32.x64.sha256, /^[a-f0-9]{64}$/);
});

test("Anneal uses its complete service topology and an explicit Windows WSL2 mode", () => {
  const anneal = readJson("vendor/upstream/anneal.json");
  assert.equal(anneal.defaultEndpoint, "http://127.0.0.1:5173/");
  assert.equal(anneal.managed.strategy, "pinned-source");
  assert.equal(anneal.managed.autoInstall, true);
  assert.equal(anneal.managed.platformModes.win32, "wsl2");
  assert.equal(anneal.managed.platformModes.linux, "native");
  assert.equal(anneal.managed.platformModes.darwin, "native");
  assert.deepEqual(
    anneal.managed.services.map((service) => service.id),
    ["postgres", "api", "runner", "web"],
  );
  assert.ok(anneal.managed.setup.some((step) => step.id === "setup-local"));
  assert.ok(anneal.managed.setup.some((step) => step.id === "build"));
  assert.ok(anneal.managed.setup.some((step) => step.id === "db-migrate"));
  assert.equal(anneal.managed.services.at(-1).readyEndpoint, "http://127.0.0.1:5173/");
});

test("managed runtime never deletes integration files and stages work under aiTemp", () => {
  const source = read("electron/upstream-tools.cjs");
  assert.match(source, /ensureManagedSource/);
  assert.match(source, /runSetupSteps/);
  assert.match(source, /startServiceTopology/);
  assert.match(source, /moveToTrash/);
  assert.match(source, /aiTemp/);
  assert.match(source, /Trash/);
  assert.doesNotMatch(source, /\b(?:rmSync|unlinkSync|rmdirSync)\s*\(/);
});

test("existing Codex Router, CPA multi-account, and CommandCode execution paths remain wired", () => {
  const runtime = read("electron/runtime-supervisor.cjs");
  const providerNetwork = read("electron/provider-network.cjs");
  const providerRouter = read("electron/provider-execution-router.cjs");
  const providerTypes = read("src/providers/provider-types.ts");
  const packageJson = readJson("package.json");

  assert.match(runtime, /proxyHealthPayload/);
  assert.match(providerNetwork, /startCommandCodeLogin/);
  assert.match(providerNetwork, /commandCodeAuthFilePath/);
  assert.match(providerRouter, /commandcode-proxy/);
  assert.match(providerTypes, /commandcode_oauth/);
  assert.match(providerTypes, /ProviderAccount/);
  assert.ok(packageJson.build.files.includes("vendor/upstream/**"));
});

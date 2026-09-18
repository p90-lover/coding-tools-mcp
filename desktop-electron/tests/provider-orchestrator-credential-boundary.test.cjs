"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const readDesktop = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function executionProviderHandler(source) {
  const start = source.indexOf('handle("coding-tools:execution:provider"');
  const end = source.indexOf('handle("coding-tools:execution:update"', start);
  assert.ok(start >= 0 && end > start, "execution provider IPC handler is missing");
  return source.slice(start, end);
}

test("provider account secrets never become Paseo or Anneal control-plane credentials", () => {
  const handler = executionProviderHandler(readDesktop("electron/main.cjs"));

  assert.doesNotMatch(handler, /accountSecret\(/, "provider vault secret must not leave the provider boundary");
  assert.doesNotMatch(handler, /storedProviderCredential\(/, "provider secret extraction must not feed orchestration auth");
  assert.match(handler, /controlCredential/);
  assert.match(handler, /credential:\s*controlCredential/);
});

test("execution IPC and typed API declare a separate bounded control-plane credential", () => {
  const schema = readDesktop("electron/ipc-schema.cjs");
  const contracts = readDesktop("src/api/contracts.ts");
  assert.match(schema, /controlCredential:\s*Object\.freeze\(\{\s*type:\s*"string"/);
  assert.match(schema, /controlCredential[^\n]*maxLength:\s*8192/);
  assert.match(contracts, /readonly controlCredential\?: string/);
});

test("Provider Hub keeps provider and orchestrator credentials in separate bilingual controls", () => {
  const source = readDesktop("src/features/ProviderHubSaasSurface.tsx");

  assert.match(source, /const \[controlCredential, setControlCredential\] = useState\(""\)/);
  assert.match(source, /controlCredential:\s*controlCredential\.trim\(\)/);
  assert.match(source, /Paseo \/ Anneal control credential/);
  assert.match(source, /Paseo／Anneal 控制憑證/);
  assert.match(source, /maxLength=\{8192\}/);
  assert.doesNotMatch(source, /controlCredential:\s*secret/);
});

test("Codex Router, CPA Antigravity, and CommandCode route to subagents, Paseo, and Anneal", () => {
  const router = require(path.join(desktopRoot, "electron", "provider-execution-router.cjs"));
  for (const providerId of [
    "codex-oauth",
    "cliproxyapi-antigravity",
    "commandcode-proxy",
  ]) {
    const provider = router.PROVIDER_EXECUTION_CATALOG.find((candidate) => candidate.id === providerId);
    assert.ok(provider, `missing routed provider ${providerId}`);
    assert.equal(provider.subagentEnabled, true, `${providerId} must support subagents`);
    assert.equal(provider.paseoEnabled, true, `${providerId} must support Paseo`);
    assert.equal(provider.annealEnabled, true, `${providerId} must support Anneal`);
  }
});

test("the packaged five-stack control plane retains every external runtime manifest", () => {
  const services = readDesktop("electron/external-services.cjs");
  const packageManifest = JSON.parse(readDesktop("package.json"));
  const packagedFiles = JSON.stringify(packageManifest.build?.files ?? []);

  for (const serviceId of ["codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(services, new RegExp(`\\"${serviceId}\\"`), `missing external service ${serviceId}`);
  }
  for (const manifest of [
    "desktop-electron/vendor/upstream/codex-router.json",
    "desktop-electron/vendor/upstream/commandcode-proxy.json",
    "desktop-electron/vendor/upstream/paseo.json",
    "desktop-electron/vendor/upstream/anneal.json",
  ]) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, manifest)), true, `missing ${manifest}`);
  }
  assert.match(packagedFiles, /vendor\/upstream\/\*\*/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function executionProviderHandler(source) {
  const start = source.indexOf('handle("coding-tools:execution:provider"');
  const end = source.indexOf('handle("coding-tools:execution:update"', start);
  assert.ok(start >= 0 && end > start, "execution provider IPC handler is missing");
  return source.slice(start, end);
}

test("provider account secrets never become Paseo or Anneal control-plane credentials", () => {
  const handler = executionProviderHandler(read("electron/main.cjs"));

  assert.doesNotMatch(handler, /accountSecret\(/, "provider vault secret must not leave the provider boundary");
  assert.doesNotMatch(handler, /storedProviderCredential\(/, "provider secret extraction must not feed orchestration auth");
  assert.match(handler, /controlCredential/);
  assert.match(handler, /credential:\s*controlCredential/);
});

test("execution IPC declares a separate bounded control-plane credential", () => {
  const schema = read("electron/ipc-schema.cjs");
  assert.match(schema, /controlCredential:\s*Object\.freeze\(\{\s*type:\s*"string"/);
  assert.match(schema, /controlCredential[^\n]*maxLength:\s*8192/);
});

test("Provider Hub keeps provider and orchestrator credentials in separate controls", () => {
  const source = read("src/features/ProviderHubSaasSurface.tsx");

  assert.match(source, /const \[controlCredential, setControlCredential\] = useState\(""\)/);
  assert.match(source, /controlCredential:\s*controlCredential\.trim\(\)/);
  assert.match(source, /Paseo \/ Anneal control credential/);
  assert.match(source, /Paseo／Anneal 控制憑證/);
  assert.doesNotMatch(source, /controlCredential:\s*secret/);
});

test("the routed provider set covers Codex Router, CPA Antigravity, and CommandCode", () => {
  const source = read("electron/provider-execution-router.cjs");
  for (const providerId of [
    "codex-router",
    "cliproxyapi-antigravity",
    "commandcode-proxy",
  ]) {
    assert.match(source, new RegExp(`\\"${providerId}\\"`));
  }
  assert.match(source, /SUPPORTED_ROUTES/);
  assert.match(source, /"paseo"/);
  assert.match(source, /"anneal"/);
});

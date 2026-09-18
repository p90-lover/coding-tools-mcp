"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  FIVE_STACK_ENDPOINTS,
  inAppGenericProviders,
  peerEnvironmentFor,
  publicUrlMap,
  writeInAppProvidersFile,
} = require("../electron/five-stack-cross-use.cjs");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

test("in-app cross-use map pins all five loopbacks and does not recurse CPA into itself", () => {
  const urls = publicUrlMap();
  assert.equal(urls.CODING_TOOLS_CPA_URL, FIVE_STACK_ENDPOINTS.cpa.origin);
  assert.equal(urls.CODING_TOOLS_CODEX_ROUTER_URL, FIVE_STACK_ENDPOINTS["codex-router"].origin);
  assert.equal(urls.CODING_TOOLS_COMMANDCODE_URL, FIVE_STACK_ENDPOINTS["commandcode-proxy"].origin);
  assert.equal(urls.CODING_TOOLS_PASEO_URL, FIVE_STACK_ENDPOINTS.paseo.origin);
  assert.equal(urls.CODING_TOOLS_PASEO_EXECUTION_URL, FIVE_STACK_ENDPOINTS.paseo.ws);
  assert.equal(urls.CODING_TOOLS_ANNEAL_URL, FIVE_STACK_ENDPOINTS.anneal.web);
  assert.equal(urls.CODING_TOOLS_ANNEAL_EXECUTION_URL, FIVE_STACK_ENDPOINTS.anneal.api);

  const secrets = {
    cpaProxyApiKey: "c".repeat(36),
    commandCodeProxyApiKey: "k".repeat(36),
    routerCallerKey: "A".repeat(32),
  };
  const routerEnv = peerEnvironmentFor("codex-router", secrets);
  assert.equal(routerEnv.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(routerEnv.OPENAI_API_KEY, secrets.cpaProxyApiKey);
  assert.equal(routerEnv.CODING_TOOLS_COMMANDCODE_URL, "http://127.0.0.1:9090");

  const cpaEnv = peerEnvironmentFor("cpa", secrets);
  assert.equal(cpaEnv.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
  assert.equal(cpaEnv.OPENAI_BASE_URL, undefined);
  assert.equal(cpaEnv.OPENAI_API_KEY, undefined);

  const commandCodeEnv = peerEnvironmentFor("commandcode-proxy", secrets);
  assert.equal(commandCodeEnv.COMMANDCODE_UPSTREAM_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(commandCodeEnv.COMMANDCODE_UPSTREAM_API_KEY, secrets.cpaProxyApiKey);

  const paseoEnv = peerEnvironmentFor("paseo", secrets);
  assert.equal(paseoEnv.PASEO_ANNEAL_API_URL, "http://127.0.0.1:3000");
  const annealEnv = peerEnvironmentFor("anneal", secrets);
  assert.equal(annealEnv.ANNEAL_PASEO_URL, "http://127.0.0.1:6768");
});

test("Router Start writes in-app CPA and CommandCode provider descriptors", () => {
  const state = temporaryDirectory("coding-tools-cross-use-router");
  const filePath = writeInAppProvidersFile(path.join(state, "router"));
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.providers.map((provider) => provider.id), ["cpa", "commandcode-proxy"]);
  assert.equal(parsed.providers[0].baseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(parsed.providers[1].baseUrl, "http://127.0.0.1:9090/v1");
  assert.deepEqual(inAppGenericProviders().map((provider) => provider.allowPrivate), [true, true]);
});

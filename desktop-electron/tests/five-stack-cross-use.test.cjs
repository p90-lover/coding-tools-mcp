"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { FIVE_STACK_ENDPOINTS, peerEnvironmentFor, publicUrlMap } = require("../electron/five-stack-cross-use.cjs");

test("cross-use topology exposes CPA, Paseo and Anneal only", () => {
  const urls = publicUrlMap();
  assert.equal(urls.CODING_TOOLS_CPA_URL, FIVE_STACK_ENDPOINTS.cpa.origin);
  assert.equal(urls.CODING_TOOLS_PASEO_URL, FIVE_STACK_ENDPOINTS.paseo.origin);
  assert.equal(urls.CODING_TOOLS_ANNEAL_URL, FIVE_STACK_ENDPOINTS.anneal.web);
  assert.equal(urls.CODING_TOOLS_CODEX_ROUTER_URL, undefined);
  assert.equal(urls.CODING_TOOLS_COMMANDCODE_URL, undefined);
});

test("Paseo receives CPA credentials while CPA does not route through itself", () => {
  const secret = "c".repeat(36);
  const paseo = peerEnvironmentFor("paseo", { cpaProxyApiKey: secret });
  assert.equal(paseo.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(paseo.OPENAI_API_KEY, secret);
  const cpa = peerEnvironmentFor("cpa", { cpaProxyApiKey: secret });
  assert.equal(cpa.OPENAI_BASE_URL, undefined);
  assert.equal(cpa.OPENAI_API_KEY, undefined);
});

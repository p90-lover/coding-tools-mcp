"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { planPaseoProviderPatch } = require("../electron/paseo-provider-routes.cjs");

test("Paseo provider patch is fixed, idempotent, and contains no private key", () => {
  const desired = planPaseoProviderPatch({ providers: { user_provider: { label: "Keep me" } } });
  assert.deepEqual(Object.keys(desired.providers), ["coding-tools-web-gpt", "coding-tools-cpa-gemini"]);
  assert.equal(desired.providers["coding-tools-web-gpt"].env.OPENAI_BASE_URL, "");
  assert.equal(desired.providers["coding-tools-web-gpt"].models[0].id, "chatgpt-web/high");
  assert.equal(desired.providers["coding-tools-cpa-gemini"].env.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(desired.providers["coding-tools-cpa-gemini"].models[0].id, "gemini-3.8-flash-high");
  assert.equal(JSON.stringify(desired).includes("private-key"), false);
  assert.equal(planPaseoProviderPatch({ providers: desired.providers }), null);
  assert.deepEqual(Object.keys(planPaseoProviderPatch({
    providers: { "coding-tools-web-gpt": desired.providers["coding-tools-web-gpt"] },
  }).providers), ["coding-tools-cpa-gemini"]);
  assert.throws(
    () => planPaseoProviderPatch({ providers: { "coding-tools-web-gpt": { label: "private-key" } } }),
    (error) => error.message === "Paseo provider ID already belongs to another configuration: coding-tools-web-gpt",
  );
});

"use strict";

// The payload rules the app gives CPA, and how they reach a config CPA has already saved.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");

function stateWith(t, saved) {
  const scratchRoot = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const state = fs.mkdtempSync(path.join(scratchRoot, "coding-tools-cpa-payload-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  if (saved) fs.writeFileSync(path.join(state, "config.yaml"), yaml.dump(saved));
  return state;
}

const configure = (state) => yaml.load(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)));
const reasoningRule = (rule) => rule?.params?.["reasoning.summary"] === "auto";
const minimumRule = (rule) => rule?.params?.max_output_tokens === 16;

// Seen live 2026-11-04: Claude Code's max_tokens 1 probes reached Codex as max_output_tokens 1,
// which OpenAI refuses below 16, so GPT chats through CPA showed "CPA refused the last 4 requests".
test("Codex requests asking for fewer than 16 output tokens are raised to 16, and only those", (t) => {
  const config = configure(stateWith(t));
  const [rule, ...others] = config.payload.override;
  assert.equal(others.length, 0);
  assert.deepEqual(rule.params, { max_output_tokens: 16 });
  assert.deepEqual(rule.models.map((model) => model.match[0].max_output_tokens), Array.from({ length: 15 }, (_, index) => index + 1));
  for (const model of rule.models) {
    assert.equal(model.name, "*");
    assert.equal(model.protocol, "codex");
    assert.equal(model.match.length, 1);
  }
});

test("a config CPA saved in its grouped form gets the app's rules where CPA reads them, once", (t) => {
  // As CPA 8 saves it: rules under requests.payload, every selector field filled in.
  const filled = { headers: {}, "from-protocol": "", match: [], "not-match": [], exist: [], "not-exist": [] };
  const userRule = { models: [{ name: "gemini-*", protocol: "gemini", ...filled }], params: { "generationConfig.temperature": 0.2 } };
  const state = stateWith(t, {
    "config-version": 8,
    requests: {
      "passthrough-headers": true,
      payload: { default: [{ models: [{ name: "*", protocol: "codex", ...filled }], params: { "reasoning.summary": "auto" } }, userRule] },
    },
  });

  const config = configure(state);
  assert.equal(config.payload, undefined, "no flat copy beside the grouped one CPA reads");
  assert.equal(config.requests["passthrough-headers"], true);
  const { payload } = config.requests;
  assert.deepEqual(payload.default.filter(reasoningRule).length, 1, "the saved copy of an app rule is replaced, not doubled");
  assert.deepEqual(payload.default.find((rule) => rule.params["generationConfig.temperature"]), userRule, "the person's own rule stays");
  assert.equal(payload.override.filter(minimumRule).length, 1, "a rule added by a later build arrives");

  fs.writeFileSync(path.join(state, "config.yaml"), yaml.dump(config));
  assert.deepEqual(configure(state).requests.payload, payload, "configuring again changes nothing");
});

test("a flat saved payload keeps the person's rules and gains the app's", (t) => {
  const userRule = { models: [{ name: "gpt-*", protocol: "openai" }], params: { temperature: 0 } };
  const config = configure(stateWith(t, { "config-version": 8, payload: { override: [userRule] } }));
  assert.deepEqual(config.payload.override[0], userRule);
  assert.equal(config.payload.override.filter(minimumRule).length, 1);
  assert.equal(config.payload.default.filter(reasoningRule).length, 1);
});

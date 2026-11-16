"use strict";

// API-key providers that point at OpenAI's own API, and the output-limit field CPA sends them.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");

function stateWith(t, saved) {
  const scratchRoot = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const state = fs.mkdtempSync(path.join(scratchRoot, "coding-tools-cpa-openai-mct-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.writeFileSync(path.join(state, "config.yaml"), yaml.dump(saved));
  return state;
}

const configure = (state) => yaml.load(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)));

// Seen live 2026-11-16: every gpt-6-astra and gpt-5-nano request to an API-key provider at
// api.openai.com failed with HTTP 400 "Unsupported parameter: 'max_tokens' ... Use
// 'max_completion_tokens' instead". CPA sends max_tokens unless the model sets the flag, and
// models fetched from OpenAI's model list never have it.
test("models of an api.openai.com provider send max_completion_tokens; other providers are left alone", (t) => {
  const openai = {
    name: "Chatgpt-api-key",
    "base-url": "https://api.openai.com/v1",
    "api-key-entries": [{ "api-key": "sk-fixture" }],
    models: [{ name: "gpt-5-nano" }, { name: "gpt-6-astra", alias: "astra" }, { name: "gpt-5.1", "use-max-completion-tokens": true }],
  };
  const stepfun = { name: "stepfun", "base-url": "https://api.stepfun.ai/v1", models: [{ name: "step-3.5-flash" }] };
  const broken = { name: "broken", "base-url": "not a url", models: [{ name: "x" }] };
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai, stepfun, broken], claude: [] } });

  const providers = configure(state)["api-keys"]["openai-compatibility"];

  assert.deepEqual(providers[0].models, [
    { name: "gpt-5-nano", "use-max-completion-tokens": true },
    { name: "gpt-6-astra", alias: "astra", "use-max-completion-tokens": true },
    { name: "gpt-5.1", "use-max-completion-tokens": true },
  ]);
  assert.deepEqual(providers[0]["api-key-entries"], openai["api-key-entries"]);
  assert.deepEqual(providers[1], stepfun);
  assert.deepEqual(providers[2], broken);
});

test("a saved config without OpenAI-compatible providers keeps its api-keys as they were", (t) => {
  const apiKeys = { claude: [{ name: "claude-1", models: [{ name: "claude-opus-5-5" }] }], codex: [] };
  const state = stateWith(t, { "config-version": 8, "api-keys": apiKeys });
  assert.deepEqual(configure(state)["api-keys"], apiKeys);
});

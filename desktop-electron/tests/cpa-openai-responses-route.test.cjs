"use strict";

// An OpenAI API key's reasoning models go through /v1/responses (cpa-managed.cjs
// withOpenAIResponsesRoute). Seen 2026-11-16: every Claude Code chat on GPT-6 Astra and GPT-6.1
// Sol failed once the key took over from the ChatGPT accounts. CPA calls an openai-compatibility
// provider on /v1/chat/completions, which refuses tools with a reasoning level ("Function tools
// with reasoning_effort are not supported ... use /v1/responses") and more than 128 tools
// ("Invalid 'tools': array too long", 152 sent). /v1/responses takes both.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");

function stateWith(t, saved) {
  const scratchRoot = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const state = fs.mkdtempSync(path.join(scratchRoot, "coding-tools-cpa-openai-responses-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.writeFileSync(path.join(state, "config.yaml"), yaml.dump(saved));
  return state;
}
const configure = (state) => yaml.load(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)));
/** What the next start of CPA reads: the app's own output, saved. */
const again = (state, edit = (config) => config) => {
  fs.writeFileSync(path.join(state, "config.yaml"), yaml.dump(edit(configure(state))));
  return configure(state);
};
const names = (models) => models.map((model) => model.name);

const REASONING = ["gpt-6.1-sol", "gpt-6-astra", "gpt-5-nano", "gpt-5.4-2026-03-05", "o3"];
const OTHER = ["gpt-4o-2024-11-20", "chat-latest", "tts-1", "whisper-1", "gpt-realtime-2", "gpt-audio-2025-08-28",
  "gpt-4o-mini-transcribe-2025-12-15", "text-embedding-3-large", "omni-moderation-latest", "gpt-image-2", "gpt-5-search-api", "gpt-realtime-translate"];
const openai = (extra = {}) => ({
  name: "Chatgpt-api-key", "base-url": "https://api.openai.com/v1",
  keys: [{ "api-key": "sk-fixture-one", weight: 3 }],
  models: [...REASONING, ...OTHER].map((name) => ({ name, alias: name })),
  ...extra,
});
const CONTINUE = { status: 400, match: ["Function tools with reasoning_effort are not supported", "array too long"], action: "continue" };
// What CPA accepts in an api-keys group other than openai-compatibility (config_v8.go
// expandV8Groups) and in a codex model: any other field makes it refuse the whole file.
const GROUP_FIELDS = ["name", "base-url", "keys", "priority", "prefix", "proxy-url", "headers", "models", "excluded-models", "disable-cooling", "request-retry", "request-scoped-errors"];
const MODEL_FIELDS = ["name", "alias", "display-name", "max-context-length", "force-mapping", "is-compat", "support-configuration-update", "thinking"];
const KEY_FIELDS = ["api-key", "weight", "disable-codex-cloaking", "alpha-search", "websockets"];

test("an OpenAI key's reasoning chat models move to a Responses twin; every other model stays", (t) => {
  const stepfun = { name: "stepfun", "base-url": "https://api.stepfun.ai/v1", keys: [{ "api-key": "sf" }], models: [{ name: "gpt-5-lookalike" }] };
  const mine = { name: "my own codex key", "base-url": "https://api.openai.com/v1", keys: [{ "api-key": "sk-mine" }], models: [{ name: "gpt-5-codex", alias: "codex-latest" }] };
  const state = stateWith(t, { "config-version": 8, "api-keys": { codex: [mine], "openai-compatibility": [stepfun, openai()], claude: [] } });

  const groups = configure(state)["api-keys"];

  const [, provider] = groups["openai-compatibility"];
  assert.deepEqual(names(provider.models), OTHER, "speech, images, embeddings, search and the older chat models stay on /chat/completions");
  assert.deepEqual(provider.keys, [{ "api-key": "sk-fixture-one", weight: 3 }]);
  assert.deepEqual(provider["request-scoped-errors"], [CONTINUE], "a request refused in one of those two ways tries the next credential");
  assert.deepEqual(groups["openai-compatibility"][0], stepfun, "another host is left alone, whatever its models are called");
  // The key is sent as itself, not dressed up as the Codex client. With CPA's default the same
  // key was refused on this route (tried on a scratch CPA 8.0.75, 2026-11-17): "This organization
  // cannot be used for Codex usage because it is enrolled in the monthly API Credits benefit".
  assert.deepEqual(groups.codex, [mine, {
    name: "Chatgpt-api-key (Responses)", "base-url": "https://api.openai.com/v1",
    models: REASONING.map((name) => ({ name, alias: name })),
    keys: [{ "api-key": "sk-fixture-one", weight: 3, "disable-codex-cloaking": true }],
  }], "the person's own codex entry is kept, and the twin follows it");
  const twin = groups.codex[1];
  for (const field of Object.keys(twin)) assert.ok(GROUP_FIELDS.includes(field), `CPA accepts the group field ${field}`);
  for (const model of twin.models) for (const field of Object.keys(model)) assert.ok(MODEL_FIELDS.includes(field), `CPA accepts the model field ${field}`);
  for (const key of twin.keys) for (const field of Object.keys(key)) assert.ok(KEY_FIELDS.includes(field), `CPA accepts the key field ${field}`);
  assert.deepEqual(groups.claude, []);
});

test("the twin keeps the provider's place and settings, and takes only what a codex entry may carry", (t) => {
  const provider = openai({
    priority: 4, prefix: "paid", headers: { "X-Org": "fixture" },
    models: [{ name: "gpt-6.1-sol", "display-name": "Sol", "max-context-length": 400000, thinking: { levels: ["low", "high"] },
      "input-modalities": ["text", "image"], "use-max-completion-tokens": true, image: false }, { name: "gpt-4o" }],
  });
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [provider] } });
  const groups = configure(state)["api-keys"];
  assert.deepEqual(groups.codex, [{
    name: "Chatgpt-api-key (Responses)", "base-url": "https://api.openai.com/v1", priority: 4, prefix: "paid", headers: { "X-Org": "fixture" },
    models: [{ name: "gpt-6.1-sol", alias: "gpt-6.1-sol", "display-name": "Sol", "max-context-length": 400000, thinking: { levels: ["low", "high"] } }],
    keys: [{ "api-key": "sk-fixture-one", weight: 3, "disable-codex-cloaking": true }],
  }]);
  assert.deepEqual(groups["openai-compatibility"][0].models, [{ name: "gpt-4o", "use-max-completion-tokens": true }]);
});

test("writing the config again changes nothing, and a re-fetched model list is split again", (t) => {
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai()] } });
  const first = configure(state)["api-keys"];
  assert.deepEqual(again(state)["api-keys"], first, "the same after CPA's next start");
  assert.deepEqual(again(state)["api-keys"], first, "and the one after");
  // CPA's own panel fetched the provider's model list again: all of them are back on the provider.
  const refetched = again(state, (config) => {
    config["api-keys"]["openai-compatibility"][0].models = [...REASONING, ...OTHER, "gpt-6.2-new"].map((name) => ({ name, alias: name }));
    return config;
  })["api-keys"];
  assert.deepEqual(names(refetched["openai-compatibility"][0].models), OTHER);
  assert.deepEqual(names(refetched.codex[0].models), [...REASONING, "gpt-6.2-new"], "a new reasoning model moves too, and none is listed twice");
  assert.equal(refetched.codex.length, 1);
  assert.deepEqual(refetched["openai-compatibility"][0]["request-scoped-errors"], [CONTINUE], "the rule is not added twice");
});

test("a provider that is disabled, moved or left without keys gets its models back and loses its twin", (t) => {
  for (const [why, edit] of [
    ["disabled", (provider) => { provider.disabled = true; }],
    ["pointed at another host", (provider) => { provider["base-url"] = "https://openrouter.ai/api/v1"; }],
    ["left without keys", (provider) => { provider.keys = []; }],
  ]) {
    const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai()] } });
    assert.equal(configure(state)["api-keys"].codex.length, 1);
    const groups = again(state, (config) => { edit(config["api-keys"]["openai-compatibility"][0]); return config; })["api-keys"];
    assert.deepEqual(names(groups["openai-compatibility"][0].models).sort(), [...REASONING, ...OTHER].sort(), `${why}: every model is on the provider again`);
    assert.deepEqual(groups.codex, [], `${why}: no twin is left`);
  }
  // Removed altogether: its twin goes with it.
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai()] } });
  configure(state);
  const groups = again(state, (config) => { config["api-keys"]["openai-compatibility"] = []; return config; })["api-keys"];
  assert.deepEqual(groups.codex, []);
});

test("keys with their own outbound route get a twin each; providers with nothing to move get none", (t) => {
  const routed = openai({ keys: [{ "api-key": "sk-a" }, { "api-key": "sk-b", "proxy-url": "socks5://127.0.0.1:1080" }, { "api-key": "sk-c" }, { "api-key": "" }] });
  const stub = { name: "Chatgpt-api-key", "base-url": "https://api.openai.com/v1", keys: [{ "api-key": "sk-stub" }], models: [] };
  const speech = { name: "speech only", "base-url": "https://api.openai.com/v1", keys: [{ "api-key": "sk-s" }], models: [{ name: "tts-1" }, { name: "gpt-4o" }] };
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [routed, stub, speech] } });
  const groups = configure(state)["api-keys"];
  assert.deepEqual(groups.codex.map((entry) => [entry.name, entry["proxy-url"] ?? null, entry.keys.map((key) => key["api-key"])]), [
    ["Chatgpt-api-key (Responses)", null, ["sk-a", "sk-c"]],
    ["Chatgpt-api-key (Responses) 2", "socks5://127.0.0.1:1080", ["sk-b"]],
  ]);
  assert.deepEqual(groups["openai-compatibility"][1], stub, "a second provider of the same name with no models is left as it is");
  assert.deepEqual(names(groups["openai-compatibility"][2].models), ["tts-1", "gpt-4o"]);
  assert.equal("request-scoped-errors" in groups["openai-compatibility"][2], false);
  // The twins fold back into the first provider of that name only, once.
  assert.deepEqual(again(state)["api-keys"], groups);
});

// Seen 2026-11-17 in the owner's own settings: two enabled providers of one name at
// api.openai.com, each with its own key and the same 96 models. A twin was matched to its
// provider by name alone, so the second write folded both twins into the first provider and
// the second key no longer served its reasoning models.
test("two providers of one name, each with its own key, keep a twin each however often the config is written", (t) => {
  const first = openai({ keys: [{ "api-key": "sk-one", weight: 3 }] });
  const second = openai({ keys: [{ "api-key": "sk-two" }] });
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [first, second] } });
  const shape = (groups) => ({
    twins: groups.codex.map((entry) => [entry.name, entry.keys.map((key) => key["api-key"]), names(entry.models)]),
    providers: groups["openai-compatibility"].map((provider) => names(provider.models)),
  });
  const groups = configure(state)["api-keys"];
  assert.deepEqual(shape(groups), {
    twins: [["Chatgpt-api-key (Responses)", ["sk-one"], REASONING], ["Chatgpt-api-key (Responses) 2", ["sk-two"], REASONING]],
    providers: [OTHER, OTHER],
  });
  assert.deepEqual(again(state)["api-keys"], groups, "the same after CPA's next start");
  assert.deepEqual(again(state)["api-keys"], groups, "and the one after");
  // The second is disabled: its own models go back to it, and the first keeps its twin.
  const disabled = again(state, (config) => { config["api-keys"]["openai-compatibility"][1].disabled = true; return config; })["api-keys"];
  assert.deepEqual(names(disabled["openai-compatibility"][1].models).sort(), [...REASONING, ...OTHER].sort());
  assert.deepEqual(shape(disabled).twins, [["Chatgpt-api-key (Responses)", ["sk-one"], REASONING]]);
  assert.deepEqual(names(disabled["openai-compatibility"][0].models), OTHER);
  // Enabled again, it gets its twin back.
  const enabled = again(state, (config) => { delete config["api-keys"]["openai-compatibility"][1].disabled; return config; })["api-keys"];
  assert.deepEqual(shape(enabled), shape(groups));
});

test("a renamed provider keeps its reasoning models, and the same key held twice gets one twin", (t) => {
  // Renamed in CPA's panel after the split: the twin still carries the old name.
  const renamed = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai()] } });
  configure(renamed);
  const after = again(renamed, (config) => { config["api-keys"]["openai-compatibility"][0].name = "OpenAI"; return config; })["api-keys"];
  assert.deepEqual(after.codex.map((entry) => [entry.name, names(entry.models)]), [["OpenAI (Responses)", REASONING]], "found by its key, not by the old name");
  assert.deepEqual(names(after["openai-compatibility"][0].models), OTHER);
  assert.deepEqual(again(renamed)["api-keys"], after);

  // The same provider entered twice (one name, one key): one twin serves the models, not two.
  const twice = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai(), openai()] } });
  const groups = configure(twice)["api-keys"];
  assert.deepEqual(groups.codex.map((entry) => [entry.name, entry.keys.map((key) => key["api-key"]), names(entry.models)]),
    [["Chatgpt-api-key (Responses)", ["sk-fixture-one"], REASONING]]);
  assert.deepEqual(groups["openai-compatibility"].map((provider) => names(provider.models)), [OTHER, OTHER], "neither keeps a model that /chat/completions refuses");
  assert.deepEqual(again(twice)["api-keys"], groups, "the same on every later write");
  // Held twice under different prefixes, the key serves two sets of model names: a twin each.
  const prefixed = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai({ prefix: "a" }), openai({ prefix: "b" })] } });
  const both = configure(prefixed)["api-keys"];
  assert.deepEqual(both.codex.map((entry) => [entry.name, entry.prefix]), [["Chatgpt-api-key (Responses)", "a"], ["Chatgpt-api-key (Responses) 2", "b"]]);
  assert.deepEqual(again(prefixed)["api-keys"], both);
});

test("the person's own rules on the provider are kept beside the new one", (t) => {
  const own = { status: 400, match: ["context_length_exceeded"], action: "stop" };
  const state = stateWith(t, { "config-version": 8, "api-keys": { "openai-compatibility": [openai({ "request-scoped-errors": [own] })] } });
  assert.deepEqual(configure(state)["api-keys"]["openai-compatibility"][0]["request-scoped-errors"], [own, CONTINUE]);
  assert.deepEqual(again(state)["api-keys"]["openai-compatibility"][0]["request-scoped-errors"], [own, CONTINUE]);
});

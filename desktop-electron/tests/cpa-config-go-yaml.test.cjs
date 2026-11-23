"use strict";
// Live 2026-11-23: from 0.8.154 CPA exited at every start ("failed to load config: yaml: did not find
// expected ',' or '}'"). The CPA wrapper runs on Bun, and Bun's YAML writer left the Antigravity prompt
// filter's "(?i)\b…\b" patterns unquoted in one-line flow YAML, which Go's yaml.v3 cannot parse. Node
// tests use js-yaml's block output, so they never wrote what Bun wrote.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jsyaml = require("js-yaml");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");

const PATTERN = "(?i)\\bsilent boot\\b";
function stateWithSaved(t) {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const state = fs.mkdtempSync(path.join(parent, "cpa-config-go-yaml-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.writeFileSync(path.join(state, "config.yaml"), jsyaml.dump({
    oauth: { providers: { custom: { "sensitive-patterns-replace": [{ pattern: PATTERN, replacement: "x" }, { pattern: "a?b", replacement: "y" }] } } },
  }));
  return state;
}

test("on Bun the saved config is written as JSON, which Go's YAML parser reads with every string quoted", (t) => {
  const state = stateWithSaved(t);
  const flow = [];
  // Bun's YAML: parse like js-yaml; its writer must not be used for the file CPA reads.
  const bun = { YAML: { parse: (text) => jsyaml.load(text), stringify: (value) => { flow.push(value); return "{unquoted: a?b}"; } } };
  const previous = globalThis.Bun;
  globalThis.Bun = bun;
  t.after(() => { if (previous === undefined) delete globalThis.Bun; else globalThis.Bun = previous; });
  const text = runtimeConfiguration(state, "management-key", "proxy-key", "");
  assert.equal(flow.length, 0, "Bun's flow writer is not used for CPA's config");
  const config = JSON.parse(text);
  const kept = config.oauth.providers.custom["sensitive-patterns-replace"];
  assert.deepEqual(kept.map((rule) => rule.pattern), [PATTERN, "a?b"], "the patterns survive exactly");
  assert.ok(text.includes(JSON.stringify(PATTERN)) && text.includes('"a?b"'), "each pattern is a quoted string");
  assert.deepEqual(jsyaml.load(text), config, "the JSON reads back as the same YAML");
});

test("on Node the saved config keeps js-yaml's block output", (t) => {
  const state = stateWithSaved(t);
  const previous = globalThis.Bun;
  delete globalThis.Bun;
  t.after(() => { if (previous !== undefined) globalThis.Bun = previous; });
  const text = runtimeConfiguration(state, "management-key", "proxy-key", "");
  assert.throws(() => JSON.parse(text));
  assert.match(text, /^oauth:\r?$/m);
  assert.equal(jsyaml.load(text).oauth.providers.custom["sensitive-patterns-replace"][0].pattern, PATTERN);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8");
const editor = {};
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
vm.runInNewContext(compiled, { exports: editor, require: () => ({}) });
const plain = (value) => JSON.parse(JSON.stringify(value));

// WebGPT only works through the bridge on Native Codex: picking a WebGPT model on any harness
// gives the Native Codex route, so a card can never ask an AO harness to run it.
test("a WebGPT model always gets the Native Codex route", () => {
  for (const harness of ["codex-native", "ao:codex", "ao:claude-code"]) {
    for (const model of ["chatgpt-web/high", "cpa/chatgpt-web/high"]) {
      assert.deepEqual(plain(editor.workerRoute(harness, model, ":read-only")), {
        harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only",
      }, `${harness} ${model}`);
    }
  }
  assert.equal(editor.workerRoute("ao:codex", "default").harness_id, "ao:codex");
  assert.equal(editor.workerRoute("ao:codex", "cpa/gemini-3.8-flash-high").model, "cpa/gemini-3.8-flash-high");
  assert.equal(editor.workerRoute("codex-native", "gemini-3.8-flash-high").provider_id, "cliproxyapi-antigravity");
  assert.equal(editor.harnessLabel("codex-native", []), "Native Codex");
  assert.equal(editor.isWebModel("chatgpt-web/luna"), true);
  assert.equal(editor.isWebModel("cpa/chatgpt-web/high"), true);
  assert.equal(editor.isWebModel("gpt-5.5"), false);
});

// The model list on every other harness also offers WebGPT (from Native Codex's list), so a
// WebGPT model can be picked anywhere and the card then moves to Native Codex.
test("every harness lists the WebGPT models and marks that they switch to Native Codex", () => {
  assert.match(source, /loadModels\(NATIVE_HARNESS\)\.then\(items => items\.filter\(isWebModel\)/);
  assert.match(source, /isWebModel\(model\) \? " · switches to Native Codex"/);
  assert.match(source, /choosing a WebGPT model switches the harness/);
  // The model select routes the pick through workerRoute, which forces Native Codex for WebGPT.
  assert.match(source, /onChange=\{event => onChange\(workerRoute\(route\.harness_id, event\.target\.value, nativePermission\(route\)\)\)\}/);
});

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
  assert.match(source, /WebGPT runs only on Native Codex\./);
});

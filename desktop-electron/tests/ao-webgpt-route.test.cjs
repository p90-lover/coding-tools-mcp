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
  // Native Codex runs only WebGPT: any other model picked there moves to an AO harness through
  // the CPA gateway (Gemini to Claude Code, the rest to Codex).
  assert.deepEqual(plain(editor.workerRoute("codex-native", "gemini-3.8-flash-high")), {
    harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gemini-3.8-flash-high", permission_profile: ":ao-default",
  });
  assert.equal(editor.workerRoute("codex-native", "gpt-6-luna").harness_id, "ao:codex");
  assert.equal(editor.workerRoute("codex-native", "gpt-6-luna").model, "cpa/gpt-6-luna");
  assert.equal(editor.harnessLabel("codex-native", []), "Native Codex");
  assert.equal(editor.isWebModel("chatgpt-web/luna"), true);
  assert.equal(editor.isWebModel("cpa/chatgpt-web/high"), true);
  assert.equal(editor.isWebModel("gpt-5.5"), false);
});

// The model list on every other harness also offers WebGPT (from Native Codex's list), so a
// WebGPT model can be picked anywhere and the card then moves to Native Codex.
test("every harness lists the WebGPT models and marks that they switch to Native Codex", () => {
  assert.match(source, /loadModels\(NATIVE_HARNESS\)\.then\(items => items\.filter\(isWebModel\)/);
  assert.match(source, /setModels\(\[\.\.\.new Set\(\[\.\.\.items, \.\.\.webItems\]\)\]\)/, "no duplicate WebGPT rows");
  assert.match(source, /isWebModel\(model\) \? " · switches to Native Codex"/);
  assert.match(source, /Native Codex runs only WebGPT: choosing a WebGPT model switches to it/);
  // The model select routes the pick through workerRoute (which forces Native Codex for WebGPT
  // and an AO harness for everything else), keeping the card's effort and context where they apply.
  assert.match(source, /onChange=\{event => onChange\(withTuning\(workerRoute\(route\.harness_id, event\.target\.value, nativePermission\(route\)\), route\)\)\}/);
});

test("effort and context window carry over only where the new route applies them", () => {
  const native = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only", effort: "high", context_window: 262144 };
  const own = editor.withTuning(editor.workerRoute("ao:codex", "gpt-5.5"), native);
  assert.equal(own.effort, "high", "an AO agent's own model takes effort");
  assert.equal(own.context_window, undefined, "AO harnesses have no context window");
  const gateway = editor.withTuning(editor.workerRoute("ao:codex", "cpa/gpt-6-luna"), native);
  assert.equal(gateway.effort, undefined, "AO skips effort for gateway models");
  assert.deepEqual(plain(editor.withTuning(editor.workerRoute("codex-native", "chatgpt-web/pro"), native)).context_window, 262144);
  assert.equal(editor.tokensLabel(262144), "256K");
  assert.equal(editor.tokensLabel(1000000), "1M");
});

test("every card describes how it runs, with a custom role in place of the built-in one", () => {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only", effort: "xhigh", context_window: 1048576 };
  assert.equal(editor.cardMeta({ role: "planner", route, settings: {} }, []), "Native Codex · WebGPT High · effort xhigh · 1M context · Orchestrator");
  assert.equal(editor.cardMeta({ role: "worker", settings: { role_name: "Security auditor" },
    route: { harness_id: "ao:codex", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-6-luna", permission_profile: ":ao-default", effort: "high" } },
  [{ id: "ao:codex", label: "Codex" }]), "Codex · CPA · gpt-6-luna · Security auditor", "gateway models show no effort");
  assert.match(source, /<option value="custom:">Custom role…<\/option>/);
});

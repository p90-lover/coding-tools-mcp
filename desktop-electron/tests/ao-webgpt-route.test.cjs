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
vm.runInNewContext(compiled, { exports: editor, require: () => ({}), structuredClone });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("saved native policy survives harness and model round trips without coercion", () => {
  for (const profile of [":workspace", ":read-only", ":full-access", "managed/custom-policy"]) {
    const native = { ...editor.WEB_ROUTE, permission_profile: profile, approval_policy: "on-request", approvals_reviewer: "auto_review" };
    const external = editor.withTuning(editor.workerRoute("ao:codex", "gpt-5.5"), native);
    assert.equal(external.permission_profile, ":ao-default");
    assert.equal(external.native_permission_profile, profile);
    const restored = editor.withTuning(editor.workerRoute("codex-native", "chatgpt-web/high", editor.nativePermission(external)), external);
    assert.equal(restored.permission_profile, profile);
    assert.equal(restored.approval_policy, "on-request");
    assert.equal(restored.approvals_reviewer, "auto_review");
  }
  assert.equal(editor.workerRoute("codex-native", "chatgpt-web/high", ":ao-default").permission_profile, ":read-only", "legacy external routes with no native selection restore the legacy native default");
  assert.equal(editor.nativePermission({ permission_profile: "unknown/raw" }), "unknown/raw");
  const current = { ...editor.WEB_ROUTE, permission_profile: "current/raw", native_permission_profile: "older/raw" };
  assert.equal(editor.nativePermission(current), "current/raw");
  const remembered = editor.withTuning(editor.workerRoute("ao:codex", "gpt-5.5"), current);
  assert.equal(remembered.native_permission_profile, "current/raw", "leaving native remembers the active raw policy, not an older inactive selection");
});

test("legacy external-only conversion creates only a read-only native scope with no inherited role policy", () => {
  const legacy = { harness_id: "ao:codex", provider_id: "agent-orchestrator", account_id: "ao-local", model: "gpt-5.5", permission_profile: ":ao-default" };
  for (const harness of ["codex-native", "ao:codex", "ao:claude-code"]) {
    const next = editor.withTuning(editor.workerRoute(harness, "chatgpt-web/high", editor.nativePermission(legacy)), legacy);
    assert.equal(next.harness_id, "codex-native");
    assert.equal(next.permission_profile, ":read-only");
    assert.equal(next.native_permission_profile, undefined);
    assert.equal(next.approval_policy, undefined);
    assert.equal(next.approvals_reviewer, undefined);
  }
});

test("mission permissions win over another saved team's routes while its revision is retained", () => {
  const saved = { id: "team", revision: 7, nodes: [{ id: "lead", route: { ...editor.WEB_ROUTE, permission_profile: ":workspace" } }] };
  const mission = { team: { ...saved, revision: 2, nodes: [{ id: "lead", route: { ...editor.WEB_ROUTE, permission_profile: "managed/custom" } }] }, nodes: [] };
  const draft = editor.teamForMission(mission, saved);
  assert.equal(draft.revision, 7);
  assert.equal(draft.nodes[0].route.permission_profile, "managed/custom");
  assert.equal(saved.nodes[0].route.permission_profile, ":workspace");
  const historical = editor.teamForMission({ ...mission, team: { ...mission.team, id: "old-team" } }, saved);
  assert.equal(historical.id, "old-team");
  assert.equal(historical.nodes[0].route.permission_profile, "managed/custom");
});

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
  // Native Codex runs any other model too, through the shared CPA pool; it never moves off.
  assert.deepEqual(plain(editor.workerRoute("codex-native", "gemini-3.8-flash-high", ":read-only")), {
    harness_id: "codex-native", provider_id: "cliproxyapi-antigravity", account_id: "shared-cpa-pool", model: "gemini-3.8-flash-high", permission_profile: ":read-only",
  });
  assert.equal(editor.workerRoute("codex-native", "cpa/gpt-6-luna").model, "gpt-6-luna", "a gateway id is stored bare on Native Codex");
  assert.equal(editor.workerRoute("codex-native", "gpt-6-luna", ":ao-default").permission_profile, ":workspace");
  assert.equal(editor.workerRoute("codex-native", "default").harness_id, "ao:claude-code", "no model still means an AO agent");
  assert.equal(editor.harnessLabel("codex-native", []), "Native Codex");
  assert.equal(editor.isWebModel("chatgpt-web/luna"), true);
  assert.equal(editor.isWebModel("cpa/chatgpt-web/high"), true);
  assert.equal(editor.isWebModel("gpt-5.5"), false);
});

// The model list on every other harness also offers WebGPT (from Native Codex's list), so a
// WebGPT model can be picked anywhere and the card then moves to Native Codex.
test("every harness lists the WebGPT models and marks that they switch to Native Codex", () => {
  assert.match(source, /loadModels\(NATIVE_HARNESS\)\.then\(items => \(Array\.isArray\(items\) \? items : items\.models\)\.filter\(isWebModel\)/);
  assert.match(source, /setModels\(\[\.\.\.new Set\(\[\.\.\.catalog\.models, \.\.\.webItems\]\)\]\)/, "no duplicate WebGPT rows");
  assert.match(source, /isWebModel\(model\) \? " · switches to Native Codex"/);
  assert.match(source, /WebGPT runs only on Native Codex: choosing a WebGPT model switches to it/);
  // The model select routes the pick through workerRoute (which forces Native Codex for WebGPT),
  // keeping the card's effort and context where they apply.
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
  [{ id: "ao:codex", label: "Codex" }]), "Codex · CPA · gpt-6-luna · effort high · Security auditor", "AO cards show requested tuning");
  assert.match(source, /<option value="custom:">Custom role…<\/option>/);
});

test("new non-WebGPT picks default to Claude Code, stay on Native Codex there, and WebGPT locks the visible harness", () => {
  for (const model of ["gpt-6-luna", "claude-sonnet", "gemini-3.8-flash-high"]) {
    assert.equal(editor.workerRoute("", model).harness_id, "ao:claude-code");
    assert.equal(editor.workerRoute("codex-native", model).harness_id, "codex-native");
  }
  assert.equal(editor.workerRoute("ao:opencode", "gpt-6-luna").harness_id, "ao:opencode", "explicit valid harness choice is retained");
  assert.match(source, /disabled=\{disabled \|\| isWebModel\(route\.model\)\}/, "WebGPT disables harness switching");
  assert.match(source, /WebGPT requires Native Codex/);
});

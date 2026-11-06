"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const route = (model, effort, harness = "claude-code") => ({
  harness_id: `ao:${harness}`, provider_id: "agent-orchestrator", account_id: "ao-local", model, effort,
});

for (const effort of ["low", "high", "max"]) {
  test(`Claude Code CPA DeepSeek preserves ${effort} even when AO clears gateway effort`, () => {
    const workflow = createAgentOrchestratorWorkflow({});
    const selected = route("cpa/opencode-go/deepseek-v4.1-flash", effort);
    const launch = workflow.subagentLaunchArgs("ws", selected, "Worker");
    // AO resolveAgentConfig clears AgentConfig.Effort for gateways, before the ACP driver runs.
    // The model survives that boundary and Provider Manager execute reads its suffix before the
    // translated body's reasoning_effort (which can otherwise fall back to low).
    const gatewayModel = launch.gateway.model;
    assert.equal(gatewayModel, `opencode-go/deepseek-v4.1-flash(${effort})`);
    assert.equal(launch.model, gatewayModel);
    assert.equal(selected.model, "cpa/opencode-go/deepseek-v4.1-flash", "the saved route stays bare");
    assert.equal(launch.effort, effort, "keep the body setting for drivers that can forward it");
    workflow.dispose();
  });
}

test("Claude Code replaces a stale saved suffix, while Auto removes it", () => {
  const workflow = createAgentOrchestratorWorkflow({});
  const launch = (model, effort) => workflow.subagentLaunchArgs("ws", route(model, effort), "Worker");
  assert.equal(launch("cpa/opencode-go/deepseek-v4.1-flash(low)", "max").model, "opencode-go/deepseek-v4.1-flash(max)");
  assert.equal(launch("cpa/opencode-go/deepseek-v4.1-flash(max)", "auto").model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(launch("cpa/opencode-go/deepseek-v4.1-flash(max)", "auto").effort, undefined);
  assert.equal(launch("cpa/opencode-go/deepseek-v4.1-flash", undefined).model, "opencode-go/deepseek-v4.1-flash");
  workflow.dispose();
});

test("Codex body effort, native models, and verbatim plugin models are unchanged", () => {
  const workflow = createAgentOrchestratorWorkflow({});
  const codex = workflow.subagentLaunchArgs("ws", route("cpa/opencode-go/deepseek-v4.1-flash", "max", "codex"), "Worker");
  assert.equal(codex.model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(codex.effort, "max");
  const native = workflow.subagentLaunchArgs("ws", route("native-model", "max"), "Worker");
  assert.equal(native.model, "native-model");
  assert.equal(native.effort, "max");
  assert.equal(native.gateway, undefined);
  const verbatim = workflow.subagentLaunchArgs("ws", route("cpa/grok/custom", "max"), "Worker");
  assert.equal(verbatim.model, "grok/custom");
  assert.equal(verbatim.effort, undefined);
  workflow.dispose();
});

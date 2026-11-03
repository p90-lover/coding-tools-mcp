"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const route = (model, effort, harness = "claude-code") => ({
  harness_id: `ao:${harness}`, provider_id: "agent-orchestrator", account_id: "ao-local", model, effort,
});

const models = [
  ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
  ["opencode-go/deepseek-v4.1-flash", ["none", "low", "high", "max"]],
  ["cline-pass/deepseek-v4.1-flash", ["none", "low", "high", "max"]],
  ["opencode-go/glm-5.3-flash", ["low", "high", "max"]],
  ["opencode-go/kimi-k3", ["max"]],
];
for (const harness of ["claude-code", "codex"]) {
  for (const [model, efforts] of models) {
    for (const effort of efforts) {
      test(`${harness} CPA ${model} preserves ${effort} when AO clears gateway effort`, () => {
        const workflow = createAgentOrchestratorWorkflow({});
        try {
          const selected = route("cpa/" + model, effort, harness);
          const launch = workflow.subagentLaunchArgs("ws", selected, "Worker");
          // AO resolveAgentConfig clears Effort for both harnesses. Only the model survives to CPA.
          assert.equal(launch.gateway.model, `${model}(${effort})`);
          assert.equal(launch.model, launch.gateway.model);
          assert.equal(selected.model, "cpa/" + model, "the saved route stays bare");
          assert.equal(launch.effort, effort, "keep the body setting for drivers that can forward it");
        } finally { workflow.dispose(); }
      });
    }
  }

  test(`${harness} replaces a stale suffix, while Auto removes it`, () => {
    const workflow = createAgentOrchestratorWorkflow({});
    try {
      const launch = (model, effort) => workflow.subagentLaunchArgs("ws", route(model, effort, harness), "Worker");
      assert.equal(launch("cpa/gpt-6.1-sol(low)", "xhigh").model, "gpt-6.1-sol(xhigh)");
      assert.equal(launch("cpa/gpt-6.1-sol(max)", undefined).model, "gpt-6.1-sol(max)");
      assert.equal(launch("cpa/gpt-6.1-sol(max)", "auto").model, "gpt-6.1-sol");
      assert.equal(launch("cpa/gpt-6.1-sol(max)", "auto").effort, undefined);
      assert.equal(launch("cpa/gpt-6.1-sol", undefined).model, "gpt-6.1-sol");
      const native = launch("native-model", "max");
      assert.equal(native.model, "native-model");
      assert.equal(native.effort, "max");
      assert.equal(native.gateway, undefined);
      const verbatim = launch("cpa/grok/custom", "max");
      assert.equal(verbatim.model, "grok/custom");
      assert.equal(verbatim.effort, undefined);
    } finally { workflow.dispose(); }
  });
}

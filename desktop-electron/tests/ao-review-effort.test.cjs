"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

async function reviewRequests({ model = "opencode-go/deepseek-v4.1-flash", effort = "max", levels = ["low", "high", "max"], failReview = false, secondEffort, team = false } = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/" + model,
    effort, native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const node = { id: "one", role: "planner", state: "running", parents: [], route,
    receipt: { thread_id: "session-1", request_key: "k" } };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single",
    grant: { executable_sha256: "a".repeat(64) }, nodes: [
      ...(team ? [{ id: "reviewer", role: "approver", state: "finished", parents: [], route,
        receipt: { verdict: "APPROVED" }, settings: { auto_decide: true } }] : []), node,
    ] };
  const bodies = [], resolved = new Set();
  let approvalID = "write-1";
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [
        { id: model, supported_reasoning_levels: levels.map(effort => ({ effort })) },
        { id: "codex-auto-review", visibility: "hide" },
      ] }) };
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (failReview && body.model === "codex-auto-review") return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"outcome":"allow","rationale":"fixture"}' } }] }) };
    },
    requestHeadless: async endpoint => endpoint.endsWith("/read")
      ? { ok: true, runs: [mission], worker_capacity: { run: 1 } } : { ok: true, run: mission },
    aoHarness: {
      observe: async () => ({ status: "working", turnId: "t", turnState: "running", approvals: resolved.has(approvalID) ? [] : [{
        approval_id: approvalID, source: "ao", kind: "permission", path: "C:/elsewhere/file", tool: "Write", summary: "Write",
        decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }],
      }] }),
      resolveApproval: async (_, id) => { resolved.add(id); return { ok: true }; },
    },
    confirm: async () => true,
  });
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 200 && !resolved.has(approvalID); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(resolved.has(approvalID), "the fixture review must finish");
    if (secondEffort) {
      node.route.effort = secondEffort;
      approvalID = "write-2";
      for (let tries = 0; tries < 200 && !resolved.has(approvalID); tries++) {
        await workflow.call("run_status", { workspaceId: "ws", runId: "run" });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(resolved.has(approvalID), "the second review must finish");
    }
    return bodies;
  } finally { node.state = "finished"; workflow.dispose(); }
}

for (const [model, effort, levels] of [
  ["opencode-go/deepseek-v4.1-flash", "max", ["low", "high", "max"]],
  ["cline-pass/glm-5.3-flash", "xhigh", ["low", "high", "xhigh", "max"]],
]) {
  test(`command-review fallback preserves ${model}'s selected ${effort}`, async () => {
    const bodies = await reviewRequests({ model, effort, levels, failReview: true });
    const own = bodies.find(body => body.model === model);
    assert.ok(own, "the selected fallback was requested");
    assert.equal(own.reasoning_effort, effort);
    assert.equal(bodies[0].model, "codex-auto-review");
    assert.equal(bodies[0].reasoning_effort, undefined, "a different reviewer keeps its own default, not the worker's max");
  });
}

test("auto-review keeps its own effort even when the worker selects Sol xhigh", async () => {
  const bodies = await reviewRequests({ model: "gpt-6.1-sol", effort: "xhigh", levels: ["low", "high", "xhigh", "max"] });
  assert.deepEqual(bodies.map(body => [body.model, body.reasoning_effort]), [["codex-auto-review", undefined]]);
});

test("a team's Sol command approver sends its selected xhigh", async () => {
  const bodies = await reviewRequests({ model: "gpt-6.1-sol", effort: "xhigh", levels: ["low", "high", "xhigh", "max"], team: true });
  assert.deepEqual(bodies.map(body => [body.model, body.reasoning_effort]), [["gpt-6.1-sol", "xhigh"]]);
});

test("same-model reviews fit a stale effort and omit one the model cannot take", async () => {
  const fitted = await reviewRequests({ effort: "medium", failReview: true });
  assert.equal(fitted.find(body => body.model === "opencode-go/deepseek-v4.1-flash").reasoning_effort, "high");
  for (const options of [{ levels: [] }, { model: "grok/custom", levels: ["max"] }]) {
    const bodies = await reviewRequests({ ...options, failReview: true });
    assert.ok(bodies.every(body => body.reasoning_effort === undefined));
  }
});

test("Auto is not sent as an explicit effort by a same-model review fallback", async () => {
  const bodies = await reviewRequests({ effort: "auto", failReview: true });
  assert.ok(bodies.length >= 2);
  assert.ok(bodies.every(body => body.reasoning_effort === undefined));
});

test("changing the selected review effort invalidates its cached verdict", async () => {
  const bodies = await reviewRequests({ effort: "high", failReview: true, secondEffort: "max" });
  assert.deepEqual(bodies.filter(body => body.model === "opencode-go/deepseek-v4.1-flash").map(body => body.reasoning_effort), ["high", "max"]);
});

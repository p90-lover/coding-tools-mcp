"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

function fixture({ review }) {
  const prompts = [], resolved = [];
  const request = { approval_id: "command", source: "ao", kind: "command", tool: "PowerShell",
    command: "python tools/review_job.py",
    decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }] };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", nodes: [
    { id: "one", role: "planner", state: "running", parents: [],
      route: { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
        approval_policy: "on-request", approvals_reviewer: "auto_review" },
      receipt: { thread_id: "session", request_key: "key", turn_id: "turn" } },
  ] };
  const workflow = createAgentOrchestratorWorkflow({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "test-model" }, { id: "codex-auto-review" }] }) };
      const prompt = JSON.parse(init.body).messages[0].content;
      prompts.push(prompt);
      const answer = await review(prompt, prompts.length);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
    },
    requestHeadless: async endpoint => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission] };
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
    aoHarness: {
      observe: async () => ({ status: "working", turnId: "turn", turnState: "running", approvals: resolved.length ? [] : [request] }),
      resolveApproval: async (_session, id, decision) => { resolved.push([id, decision]); return { ok: true }; },
    },
  });
  const poll = () => workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
  return { workflow, prompts, resolved, poll };
}

async function settle(check) {
  for (let tries = 0; tries < 200 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), "the expected review stage was reached");
}

for (const enabled of [false, true]) {
  test(`model judge switched ${enabled ? "on" : "off"} during an undecided review takes effect before its answer is sent`, async () => {
    let release;
    const first = new Promise(resolve => { release = resolve; });
    const world = fixture({ review: async (_prompt, call) => {
      if (call === 1) await first;
      return { action: "ask", reason: "Cannot decide safely" };
    } });
    try {
      await world.workflow.call("chat_model_judges", { enabled: !enabled });
      await world.poll();
      await settle(() => world.prompts.length === 1);
      await world.workflow.call("chat_model_judges", { enabled });
      release();
      await settle(() => world.prompts.length === 2);
      for (let i = 0; i < 5; i++) await nextTurn();
      assert.deepEqual(world.resolved, enabled ? [["command", "no"]] : [], "the first screening uses the new setting without needing another poll");
    } finally { release(); world.workflow.dispose(); }
  });
}

test("enabling model judge while a decisive retry is in flight does not require another review", async () => {
  let release;
  const retry = new Promise(resolve => { release = resolve; });
  const world = fixture({ review: async (_prompt, call) => {
    if (call === 2) await retry;
    return { action: "ask", reason: "Cannot decide safely" };
  } });
  try {
    await world.poll();
    await settle(() => world.prompts.length === 2);
    await world.workflow.call("chat_model_judges", { enabled: true });
    release();
    for (let i = 0; i < 5; i++) await nextTurn();
    assert.deepEqual(world.resolved, [["command", "no"]]);
    assert.equal(world.prompts.length, 2, "the new setting settles the existing review instead of re-asking the model");
  } finally { release(); world.workflow.dispose(); }
});

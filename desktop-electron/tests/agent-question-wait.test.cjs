"use strict";
require("./support/temp-dirs.cjs");

// Settings › Chat › Agent questions. The user (2026-11-08): "fix the asking panel wont pause the agent
// and timed out like few seconds, add a settings that allow the ask to be stay and pause or time out
// in X seconds default is 30 seconds". A question in an "Approve for me" chat got its recommended
// answer after a fixed 20 s, so the agent went on before the person had read it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAgentOrchestratorWorkflow: createWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
  permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
const question = (since) => ({ approval_id: "ask", source: "ao", kind: "question", message: "Which permission behavior?", tool: "AskUserQuestion",
  summary: "Question", decisions: [], since: new Date(since).toISOString(),
  fields: [{ key: "question_0", type: "choice", title: "Which?", options: [{ value: "a", label: "Keep asking (Recommended)", description: "" },
    { value: "b", label: "Never ask", description: "" }], customKey: "question_0_custom" }] });

function world({ clock, preferences = null }) {
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [
    { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session-1", request_key: "k" } }] };
  const answered = [];
  let pending = [question(clock.at)];
  const workflow = createWorkflow({
    findCodexExecutable: () => process.execPath, now: () => clock.at, chatPreferencesFile: preferences,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "test-model" }, { id: "codex-auto-review" }] }) }),
    confirm: async () => true,
    requestHeadless: async (endpoint) => endpoint.endsWith("/read") ? { ok: true, runs: [mission], worker_capacity: { run: 1 } } : { ok: true, run: mission },
    aoHarness: {
      observe: async () => ({ status: "working", turnId: "t", turnState: "running", lastActivityAt: clock.at, timeline: [], approvals: pending }),
      resolveInput: async (...args) => { answered.push(args); pending = []; return { ok: true }; },
    },
  });
  return { workflow, answered, mission };
}

test("Agent questions waits 30 seconds by default; 0 keeps the question, any whole second up to a day is taken", async () => {
  const { workflow } = world({ clock: { at: 1_000_000 } });
  assert.deepEqual(await workflow.call("chat_question_timeout", {}), { ok: true, seconds: 30 }, "30 s unless the person changes it");
  assert.deepEqual(await workflow.call("chat_question_timeout", { seconds: 0 }), { ok: true, seconds: 0 }, "0: wait for my answer");
  assert.deepEqual(await workflow.call("chat_question_timeout", { seconds: 90 }), { ok: true, seconds: 90 });
  for (const seconds of [-1, 1.5, "30", 24 * 60 * 60 + 1]) {
    await assert.rejects(workflow.call("chat_question_timeout", { seconds }), /wait for me|whole number/, String(seconds));
  }
  assert.equal((await workflow.call("chat_question_timeout", {})).seconds, 90, "a refused value changes nothing");
});

test("the choice outlives a restart, in the chat's preferences file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "question-wait-"));
  const file = path.join(dir, "chat-preferences.json");
  await world({ clock: { at: 1 }, preferences: file }).workflow.call("chat_question_timeout", { seconds: 0 });
  assert.equal((await world({ clock: { at: 1 }, preferences: file }).workflow.call("chat_question_timeout", {})).seconds, 0);
});

test("a question this chat answers for the person says when, so its card counts down; kept ones have no deadline", async () => {
  const clock = { at: 1_000_000 };
  const { workflow } = world({ clock });
  const seen = await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
  assert.equal(seen.pending_approvals[0].auto_answer_at, 1_000_000 + 30_000, "asked now, answered for them in 30 s");
  await workflow.call("chat_question_timeout", { seconds: 0 });
  const kept = await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
  assert.equal(kept.pending_approvals[0].auto_answer_at, undefined, "Wait for my answer: no countdown");
});

test("Wait for my answer keeps the agent on its question; a timeout answers it only once it has passed", async () => {
  const clock = { at: 1_000_000 };
  const { workflow, answered, mission } = world({ clock });
  await workflow.call("chat_question_timeout", { seconds: 0 });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  // Long past the old 20 s and the default 30 s: nothing answers it.
  for (let step = 0; step < 20; step++) { clock.at += 60_000; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.deepEqual(answered, [], "the question waits for the person, and the agent with it");

  // Switched to 45 s: not at 40, but after 45 from when it was asked (it was asked long ago).
  await workflow.call("chat_question_timeout", { seconds: 45 });
  for (let tries = 0; tries < 200 && !answered.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(answered.length, 1, "its wait has passed: answered for the person");
  assert.deepEqual(answered[0].slice(0, 3), ["session-1", "ask", "accept"]);
  assert.deepEqual(answered[0][3], { question_0: "a" }, "the option marked Recommended");
  mission.nodes[0].state = "finished";
});

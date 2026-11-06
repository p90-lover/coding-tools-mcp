const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const chat = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/ao-chat.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: chat, require: () => ({}) });
const auto = { approval_policy: "on-request", approvals_reviewer: "auto_review" };

for (const team of [false, true]) test(`an active review never becomes a human prompt because the client waited (${team ? "team" : "single"})`, () => {
  for (const waiting of [0, 30_000, 240_000, 900_000]) {
    assert.equal(chat.approvalAnsweredForYou({ kind: "command", awaiting_review: true }, auto, waiting, team), true);
    assert.equal(chat.approvalAnsweredForYou({ kind: "command", awaiting_review: true,
      recommendation: { action: "allow" } }, auto, waiting, team), true, "sending a verdict is still automatic");
  }
});

test("an explicit reviewer fallback appears immediately, but actual questions and manual approvals remain visible", () => {
  assert.equal(chat.approvalAnsweredForYou({ kind: "command", awaiting_review: true,
    recommendation: { action: "ask" } }, auto, 0), false);
  for (const kind of ["question", "plan"]) assert.equal(chat.approvalAnsweredForYou({ kind, awaiting_review: true }, auto, 0), false);
  assert.equal(chat.approvalAnsweredForYou({ kind: "command" }, { approval_policy: "on-request", approvals_reviewer: "user" }, 0), false);
  assert.equal(chat.approvalAnsweredForYou({ kind: "command" }, auto, 900_000), false, "an unmarked legacy request retains its recovery fallback");
});

async function settle() { for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setImmediate(resolve)); }
function fixture({ decisions, failSend = false, review = false } = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", model: "cpa/test-model", ...auto };
  const request = { approval_id: "command", source: "ao", kind: "command", tool: "Bash",
    command: review ? "Invoke-RestMethod https://service.invalid/action -Method POST" : "npm test",
    decisions: decisions ?? [{ id: "allow", kind: "allow_once", label: "Allow" }] };
  const run = { id: "run", workspace_id: "ws", execution_mode: "single", nodes: [
    { id: "one", role: "planner", state: "running", route, receipt: { thread_id: "session" } },
  ] };
  let clock = 10_000, sent = 0;
  const workflow = createAgentOrchestratorWorkflow({ now: () => clock,
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "test-key" }),
    fetchImpl: async url => ({ ok: true, json: async () => String(url).endsWith("/models")
      ? { data: [{ id: "test-model" }, { id: "codex-auto-review" }] } : { choices: [{ message: { content: JSON.stringify({ action: "ask", reason: "Insufficient context" }) } }] } }),
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [run] }
      : endpoint.endsWith("/harness/status") ? { ok: true, status: { connected: false } } : { ok: true, run },
    aoHarness: {
      observe: async () => ({ turnId: "turn", turnState: "running", approvals: [request] }),
      resolveApproval: async () => { sent++; if (failSend) throw new Error("delivery failed"); return { ok: true }; },
    },
  });
  const input = { workspaceId: "ws", runId: "run", nodeId: "one" };
  return { workflow, input, sent: () => sent, advance: value => { clock += value; },
    pending: async () => (await workflow.call("harness_status", input)).status.pending_approvals };
}

for (const failed of [false, true]) test(`a reviewer verdict ${failed ? "falls back only if delivery fails" : "continues without a question"}`, async () => {
  const world = fixture({ failSend: failed });
  try {
    await world.workflow.call("observe", world.input); await settle();
    assert.equal(world.sent(), 1);
    const pending = await world.pending();
    assert.equal(pending.length, failed ? 1 : 0);
    if (failed) {
      assert.equal(pending[0].recommendation.action, "ask");
      assert.equal(pending[0].awaiting_review, undefined);
    }
  } finally { world.workflow.dispose(); }
});

test("a reviewer unable to deliver an offered decision exposes an explicit fallback instead of staying hidden", async () => {
  const world = fixture({ decisions: [{ id: "deny", kind: "reject_once", label: "Reject" }] });
  try {
    await world.workflow.call("observe", world.input); await settle();
    const [pending] = await world.pending();
    assert.equal(world.sent(), 0, "never choose a different permission than the verdict");
    assert.equal(pending.recommendation.action, "ask");
    assert.equal(pending.awaiting_review, undefined);
    assert.equal(pending.recommendation.unresolved, true);
  } finally { world.workflow.dispose(); }
});

test("a reviewer still unable to decide after its second pass waits for a person, never timed auto-allow", async () => {
  const world = fixture({ review: true });
  try {
    await world.workflow.call("observe", world.input); await settle();
    const [pending] = await world.pending();
    assert.equal(pending.recommendation.action, "ask");
    assert.equal(pending.recommendation.unresolved, true);
    world.advance(30_000);
    await world.workflow.call("observe", world.input); await settle();
    assert.equal(world.sent(), 0);
    assert.equal((await world.pending())[0].recommendation.action, "ask");
  } finally { world.workflow.dispose(); }
});

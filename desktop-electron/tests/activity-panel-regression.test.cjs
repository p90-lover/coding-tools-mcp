const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

for (const failed of [false, true]) test(`an auto-reviewed request ${failed ? "stays answerable after a failed send" : "does not reappear from a stale status after a successful send"}`, async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const requests = [
    { approval_id: "tests", source: "ao", kind: "command", command: "npm test", tool: "Bash", summary: "Bash",
      decisions: [{ id: "yes", kind: "allow_once", label: "Allow" }, { id: "no", kind: "reject_once", label: "Reject" }] },
    { approval_id: "question", source: "ao", kind: "question", tool: "AskUserQuestion", message: "Which account?", fields: [], decisions: [] },
  ];
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", nodes: [
    { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session-1", request_key: "k" } }] };
  let sent = 0;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission] }
      : endpoint.endsWith("/harness/status") ? { ok: true, status: { connected: false } } : { ok: true, run: mission },
    aoHarness: {
      // A cached/in-flight AO snapshot still has the old request after the reply was sent.
      observe: async () => ({ status: "working", turnId: "t", turnState: "running", approvals: requests }),
      resolveApproval: async (_session, id, decision) => {
        sent++;
        assert.equal(id, "tests");
        assert.equal(decision, "yes");
        if (failed) throw new Error("connection closed");
        return { ok: true };
      },
    },
  });
  const input = { workspaceId: "ws", runId: "run", nodeId: "one" };
  try {
    await workflow.call("observe", input);
    for (let tries = 0; tries < 100 && !sent; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sent, 1, "the routine command is answered once without a model call");
    await new Promise(resolve => setImmediate(resolve));
    for (const operation of ["harness_status", "observe"]) {
      const result = await workflow.call(operation, input);
      const pending = result.status?.pending_approvals ?? result.pending_approvals;
      assert.deepEqual(pending.map(item => item.approval_id), failed ? ["tests", "question"] : ["question"], operation);
      if (failed) {
        assert.equal(pending[0].recommendation.action, "ask");
        assert.match(pending[0].recommendation.reason, /couldn't be sent/);
        assert.equal(pending[0].awaiting_review, undefined);
      }
    }
    assert.equal(sent, 1, "stale status must not resend a decision");
  } finally { workflow.dispose(); }
});

test("a native command approval also stays removed after its successful reply", async () => {
  const route = { harness_id: "codex-native", provider_id: "cliproxyapi-antigravity", model: "test-model", permission_profile: ":workspace" };
  const pending = [{ approval_id: "native-tests", kind: "command", command: "npm test" }];
  const mission = { id: "run", workspace_id: "ws", revision: 3, grant: { executable_sha256: "a".repeat(64) }, nodes: [
    { id: "approver", role: "approver", state: "finished", parents: [], route, receipt: { verdict: "APPROVED" }, settings: { auto_decide: true } },
    { id: "worker", role: "worker", state: "running", parents: ["approver"], route },
  ] };
  let sent = 0;
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    requestHeadless: async endpoint => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint.endsWith("/observe")) return { ok: true, pending_approvals: pending };
      if (endpoint.endsWith("/harness/status")) return { ok: true, status: { connected: true, pending_approvals: pending } };
      if (endpoint.endsWith("/approval")) { sent++; return { ok: true, result: { ok: true } }; }
      throw new Error("Unexpected endpoint " + endpoint);
    },
  });
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 100 && !sent; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sent, 1);
    await new Promise(resolve => setImmediate(resolve));
    const result = await workflow.call("harness_status", { workspaceId: "ws", runId: "run", nodeId: "worker" });
    assert.deepEqual(result.status.pending_approvals, []);
  } finally { mission.nodes[1].state = "finished"; workflow.dispose(); }
});

function pollingHarness() {
  let interval, focus, cleared = 0;
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatWorkbench.tsx"), "utf8");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports,
    require: name => name === "./page-visibility" ? { onWindowFocus: callback => { focus = callback; return () => { focus = null; }; } } : {},
    window: { setInterval: callback => { interval = callback; return 1; }, clearInterval: () => { cleared++; } },
  });
  return { start: exports.startWorkbenchPoll, interval: () => interval(), focus: () => focus?.(), cleared: () => cleared };
}

test("workbench polling coalesces slow reads, skips hidden surfaces and stops on cleanup", async () => {
  const poll = pollingHarness();
  let hidden = false, calls = 0, release;
  const stop = poll.start(() => { calls++; return new Promise(resolve => { release = resolve; }); }, 4000, () => hidden);
  assert.equal(calls, 1);
  for (let i = 0; i < 10; i++) { poll.interval(); poll.focus(); }
  assert.equal(calls, 1, "intervals and focus cannot pile up on a slow read");
  release(); await new Promise(resolve => setImmediate(resolve));
  hidden = true;
  poll.interval(); poll.focus();
  assert.equal(calls, 1, "a kept-alive surface behind another tab makes no requests");
  hidden = false; poll.focus();
  assert.equal(calls, 2, "returning to the window refreshes immediately");
  stop(); release(); await new Promise(resolve => setImmediate(resolve));
  poll.interval(); poll.focus();
  assert.equal(calls, 2, "a disposed poll never restarts");
  assert.equal(poll.cleared(), 1);
});

test("a rejected workbench read releases its single-flight slot", async () => {
  const poll = pollingHarness();
  let calls = 0;
  const stop = poll.start(async () => { calls++; throw new Error("IPC unavailable"); }, 4000, () => false);
  await new Promise(resolve => setImmediate(resolve));
  poll.interval();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  stop();
});

"use strict";
require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

/** A Claude Code chat; `reviewer` "auto_review" is Approve for me, "user" is Ask for approval. */
function fixture(preferences, { reviewer = "auto_review", nativeGuardianReview, approvalDetails = {} } = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: reviewer };
  const node = { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session", request_key: "key" } };
  const run = { id: "run", workspace_id: "ws", project_id: "task", revision: 1, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [node] };
  const calls = [], resolved = [];
  let command = "python tools/migrate.py --apply";
  const cwd = path.resolve(__dirname, "..");
  const workflow = createAgentOrchestratorWorkflow({
    chatPreferencesFile: preferences,
    nativeGuardianReview,
    findCodexExecutable: () => process.execPath,
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      return { ok: true, json: async () => String(url).endsWith("/models")
        ? { data: [{ id: "codex-auto-review" }, { id: "test-model" }] }
        : { choices: [{ message: { content: JSON.stringify({ outcome: "allow", rationale: "fixture verdict" }) } }] } };
    },
    requestHeadless: async (endpoint, body) => endpoint.endsWith("/read") ? { ok: true, runs: [run] }
      : body?.tool === "workflow_list" ? { ok: true, operation: { state: "completed", result: { ok: true, task: { description: "I authorize the migration in this test workspace" } } } }
        : { ok: true },
    aoHarness: {
      sessionWorkspace: async () => ({ projectFolder: cwd }),
      observe: async () => ({ turnId: "turn", turnState: "running", timeline: [], approvals: [{
        approval_id: "permission-1", source: "ao", kind: "command", tool: "Bash", turn_id: "turn", command, cwd,
        decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }], ...approvalDetails,
      }] }),
      resolveApproval: async (_session, id, decision) => { resolved.push([id, decision]); return { ok: true }; },
    },
  });
  return { workflow, calls, resolved, route,
    command: value => { command = value; },
    screen: () => workflow.reviewToolCall({ workspaceId: "ws", session: "session", tool: "computer_action", args: { action: "click" } }),
    observe: async () => {
      await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
      for (let tick = 0; tick < 40; tick++) await new Promise(resolve => setImmediate(resolve));
      return (await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" })).pending_approvals;
    },
  };
}

test("Approve for me routes the exact pending shell action to Guardian, without a CPA call", async () => {
  const seen = [];
  const state = fixture(undefined, { nativeGuardianReview: async (input) => {
    seen.push(input);
    return { action: "allow", reason: "fixture native verdict", actor: "guardian" };
  } });
  try {
    assert.equal((await state.workflow.call("chat_model_judges")).meteredReviews, false);
    assert.equal((await state.screen()).action, "ask", "the app's screen actions are not native shell approvals");
    await state.observe();
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].approval.command, "python tools/migrate.py --apply");
    assert.equal(seen[0].approval.cwd, seen[0].folder);
    assert.match(seen[0].task, /I authorize/);
    assert.deepEqual(state.calls, [], "neither catalog nor CPA reviews are sent");
    assert.equal(state.route.approvals_reviewer, "auto_review");
  } finally { state.workflow.dispose(); }
});

test("a changed pending command with the same ID does not receive the old Guardian decision", async () => {
  const state = fixture(undefined, { nativeGuardianReview: async () => {
    state.command("python tools/migrate.py --different");
    return { action: "allow", reason: "fixture old verdict", actor: "guardian" };
  } });
  try {
    const pending = await state.observe();
    assert.equal(pending.length, 1);
    assert.deepEqual(state.resolved, []);
    assert.deepEqual(state.calls, []);
  } finally { state.workflow.dispose(); }
});

test("enabling quota reviews while Guardian is undecided rechecks the pending request", { timeout: 5_000 }, async (t) => {
  for (const action of ["ask", "deny"]) await t.test(action, async () => {
    const started = Promise.withResolvers(), guardian = Promise.withResolvers();
    const state = fixture(undefined, { nativeGuardianReview: async () => {
      started.resolve();
      return guardian.promise;
    } });
    try {
      await state.workflow.call("chat_model_judges", { enabled: true });
      await state.observe();
      await started.promise;
      assert.deepEqual(state.calls, [], "turning the judge on does not enable paid reviews");
      await state.workflow.call("chat_model_judges", { meteredReviews: true });
      guardian.resolve({ action, reason: "fixture Guardian answer", actor: "guardian" });
      for (let tick = 0; tick < 3 && !state.resolved.length; tick++) await state.observe();
      assert.deepEqual(state.resolved, [["permission-1", action === "deny" ? "no" : "yes"]]);
      assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, action === "deny" ? 0 : 1,
        "review the undecided request after consent, but never replace a Guardian denial");
    } finally { guardian.resolve(null); state.workflow.dispose(); }
  });
});

test("unsupported shell context stays manual and local routine commands require no model", async () => {
  let reviews = 0;
  const state = fixture(undefined, { approvalDetails: { cwd: undefined }, nativeGuardianReview: async () => { reviews++; } });
  try {
    assert.equal((await state.observe()).length, 1);
    assert.deepEqual(state.resolved, []);
    assert.equal(reviews, 0);
    assert.deepEqual(state.calls, []);
  } finally { state.workflow.dispose(); }
  const routine = fixture();
  try {
    routine.command("npm test");
    await routine.observe();
    assert.deepEqual(routine.resolved, [["permission-1", "yes"]]);
    assert.deepEqual(routine.calls, []);
  } finally { routine.workflow.dispose(); }
});

for (const judge of [false, true]) test(`screen reviews cannot spend CPA quota with consent off and model judge ${judge ? "on" : "off"}`, async () => {
  const state = fixture(undefined, { reviewer: "user" });
  try {
    await state.workflow.call("chat_model_judges", { enabled: judge });
    const verdict = await state.screen();
    assert.equal(verdict.action, "ask");
    assert.equal(verdict.quotaBlocked, true);
    assert.match(verdict.reason, /CPA reviews use account quota/);
    assert.deepEqual(state.calls, []);
  } finally { state.workflow.dispose(); }
});

test("a harness-required human decision is not automated even with the paid reviewer enabled", async () => {
  const state = fixture(undefined, { approvalDetails: { guardianRequiresHuman: true }, nativeGuardianReview: async () => assert.fail("human-only") });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    const pending = await state.observe();
    assert.equal(pending.length, 1);
    assert.deepEqual(state.resolved, []);
    assert.deepEqual(state.calls, []);
  } finally { state.workflow.dispose(); }
});

test("the switch turns those reviews on, and off again, cached verdicts included", async () => {
  const state = fixture(undefined, { reviewer: "user" });
  try {
    await assert.rejects(state.workflow.call("chat_model_judges", { meteredReviews: "yes" }), /on or off/);
    await state.workflow.call("chat_model_judges", { meteredReviews: true });
    assert.equal((await state.screen()).action, "allow");
    assert.ok(state.calls.some(url => url.endsWith("/chat/completions")));
    const sent = state.calls.length;
    await state.workflow.call("chat_model_judges", { meteredReviews: false });
    assert.equal((await state.screen()).action, "ask");
    assert.equal(state.calls.length, sent);
  } finally { state.workflow.dispose(); }
});

test("quota-review consent is separate from model judge and persists across workflow restarts", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-quota-"));
  const file = path.join(folder, "preferences.json");
  fs.writeFileSync(file, JSON.stringify({ modelJudges: true }));
  const first = fixture(file);
  try {
    assert.deepEqual(await first.workflow.call("chat_model_judges"), { ok: true, modelJudges: true, meteredReviews: false });
    await first.workflow.call("chat_model_judges", { meteredReviews: true });
  } finally { first.workflow.dispose(); }
  const second = fixture(file);
  try {
    assert.equal((await second.workflow.call("chat_model_judges")).meteredReviews, true);
    await second.workflow.call("chat_model_judges", { meteredReviews: false });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).meteredReviews, false);
    assert.equal((await second.workflow.call("chat_model_judges")).modelJudges, true);
  } finally { second.workflow.dispose(); }
});

"use strict";
require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentOrchestratorWorkflow, FALLBACK_JUDGE_ALLOWS, fallbackJudgeAllows, fallbackJudgeRule } = require("../electron/agent-orchestrator-workflow.cjs");

/** A Claude Code chat; `reviewer` "auto_review" is Approve for me, "user" is Ask for approval. */
function fixture(preferences, { reviewer = "auto_review", nativeGuardianReview, approvalDetails = {}, now = Date.now,
  task = () => "I authorize the migration in this test workspace",
  modelVerdict = async () => ({ outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "fixture verdict" }),
} = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: reviewer };
  const node = { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session", request_key: "key" } };
  const run = { id: "run", workspace_id: "ws", project_id: "task", revision: 1, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [node] };
  const calls = [], resolved = [];
  const firstAnswer = Promise.withResolvers(), firstModelCall = Promise.withResolvers();
  let command = "python tools/migrate.py --apply";
  const cwd = path.resolve(__dirname, "..");
  const workflow = createAgentOrchestratorWorkflow({
    chatPreferencesFile: preferences,
    nativeGuardianReview,
    now,
    findCodexExecutable: () => process.execPath,
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/chat/completions")) firstModelCall.resolve();
      return { ok: true, json: async () => String(url).endsWith("/models")
        ? { data: [{ id: "codex-auto-review" }, { id: "test-model" }] }
        : { choices: [{ message: { content: JSON.stringify(await modelVerdict(JSON.parse(init.body))) } }] } };
    },
    requestHeadless: async (endpoint, body) => endpoint.endsWith("/read") ? { ok: true, runs: [run] }
      : body?.tool === "workflow_list" ? { ok: true, operation: { state: "completed", result: { ok: true, task: { description: task() } } } }
        : { ok: true },
    aoHarness: {
      sessionWorkspace: async () => ({ projectFolder: cwd }),
      observe: async () => ({ turnId: "turn", turnState: "running", timeline: [], approvals: [{
        approval_id: "permission-1", source: "ao", kind: "command", tool: "Bash", turn_id: "turn", command, cwd,
        decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }], ...approvalDetails,
      }] }),
      resolveApproval: async (_session, id, decision) => {
        resolved.push([id, decision]);
        firstAnswer.resolve();
        return { ok: true };
      },
    },
  });
  return { workflow, calls, resolved, route, firstAnswer: firstAnswer.promise, firstModelCall: firstModelCall.promise,
    command: value => { command = value; },
    screen: () => workflow.reviewToolCall({ workspaceId: "ws", session: "session", tool: "computer_action", args: { action: "click" } }),
    observe: async () => {
      await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
      for (let tick = 0; tick < 40; tick++) await new Promise(resolve => setImmediate(resolve));
      return (await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" })).pending_approvals;
    },
  };
}

for (const meteredReviews of [false, true]) test(`Approve for me routes the exact shell action to Guardian with CPA consent ${meteredReviews ? "on" : "off"}`, async () => {
  const seen = [];
  const state = fixture(undefined, { nativeGuardianReview: async (input) => {
    seen.push(input);
    return { action: "allow", reason: "fixture native verdict", actor: "guardian" };
  } });
  try {
    await state.workflow.call("chat_model_judges", { meteredReviews });
    assert.equal((await state.workflow.call("chat_model_judges")).meteredReviews, meteredReviews);
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

// Each native Guardian review spends plan quota (about 0.5% of a Plus 5-hour window per 100). On
// 2026-11-23, 9 of a day's 640 Guardian reviews repeated an earlier request in the same chat exactly.
test("Guardian's allow answers the same command again in the same chat without another review", { timeout: 5_000 }, async () => {
  const details = {};
  let reviews = 0;
  const state = fixture(undefined, { approvalDetails: details, nativeGuardianReview: async () => {
    reviews++;
    return { action: "allow", reason: "fixture native verdict", actor: "guardian", reason_code: "native_guardian" };
  } });
  try {
    await state.observe();
    details.approval_id = "permission-2";
    await state.observe();
    assert.deepEqual(state.resolved, [["permission-1", "yes"], ["permission-2", "yes"]]);
    assert.equal(reviews, 1, "the repeat is answered from Guardian's kept allow");
    state.command("python tools/migrate.py --dry-run");
    details.approval_id = "permission-3";
    await state.observe();
    assert.deepEqual(state.resolved.at(-1), ["permission-3", "yes"]);
    assert.equal(reviews, 2, "another command is reviewed");
    assert.deepEqual(state.calls, [], "no CPA review either");
  } finally { state.workflow.dispose(); }
});

test("a Guardian deny or unclear answer is never kept for the same command", { timeout: 5_000 }, async (t) => {
  for (const action of ["deny", "ask"]) await t.test(action, async () => {
    const details = {};
    let reviews = 0;
    const state = fixture(undefined, { approvalDetails: details, nativeGuardianReview: async () => {
      reviews++;
      return { action, reason: "fixture Guardian answer", actor: "guardian" };
    } });
    try {
      await state.observe();
      details.approval_id = "permission-2";
      await state.observe();
      assert.equal(reviews, 2, "the same command is reviewed again");
      assert.ok(state.resolved.every(([, decision]) => decision !== "yes"), "nothing was allowed");
    } finally { state.workflow.dispose(); }
  });
});

test("a kept Guardian allow lapses after ten minutes and never outlives the user's request", { timeout: 5_000 }, async () => {
  const details = {};
  let at = Date.now(), request = "I authorize the migration in this test workspace", reviews = 0;
  const state = fixture(undefined, { approvalDetails: details, now: () => at, task: () => request, nativeGuardianReview: async () => {
    reviews++;
    return { action: "allow", reason: "fixture native verdict", actor: "guardian", reason_code: "native_guardian" };
  } });
  try {
    await state.observe();
    at += 9 * 60_000;
    details.approval_id = "permission-2";
    await state.observe();
    assert.equal(reviews, 1, "reused within ten minutes of Guardian's answer");
    at += 60_000 + 1;
    details.approval_id = "permission-3";
    await state.observe();
    assert.equal(reviews, 2, "an allow older than ten minutes is not reused");
    request = "Stop. Do not run the migration again.";
    details.approval_id = "permission-4";
    await state.observe();
    assert.equal(reviews, 3, "a new message from the user is reviewed afresh");
    assert.deepEqual(state.resolved.map(([id]) => id), ["permission-1", "permission-2", "permission-3", "permission-4"]);
  } finally { state.workflow.dispose(); }
});

test("enabling quota reviews mid-Guardian cannot replace its decision or spend on an undecided review", { timeout: 5_000 }, async (t) => {
  for (const action of ["ask", "deny", "unavailable"]) await t.test(action, async () => {
    const started = Promise.withResolvers(), guardian = Promise.withResolvers();
    let reviews = 0;
    const state = fixture(undefined, { nativeGuardianReview: async () => {
      reviews++;
      started.resolve();
      return guardian.promise;
    } });
    try {
      await state.workflow.call("chat_model_judges", { enabled: true });
      await state.observe();
      await started.promise;
      assert.deepEqual(state.calls, [], "turning the judge on does not enable paid reviews");
      await state.workflow.call("chat_model_judges", { meteredReviews: true });
      guardian.resolve(action === "unavailable" ? null : { action, reason: "fixture Guardian answer", actor: "guardian" });
      let pending;
      for (let tick = 0; tick < 3; tick++) pending = await state.observe();
      assert.deepEqual(state.resolved, action === "deny" ? [["permission-1", "no"]] : []);
      if (action !== "deny") assert.equal(pending[0]?.recommendation?.guardianPending, true);
      assert.equal(reviews, 1);
      assert.deepEqual(state.calls, []);
    } finally { guardian.resolve(null); state.workflow.dispose(); }
  });
});

test("an eligible Guardian fallback stays in review and removes the card after the harness accepts the answer", { timeout: 5_000 }, async () => {
  const verdict = Promise.withResolvers();
  const state = fixture(undefined, {
    nativeGuardianReview: async () => ({ action: "ask", guardianAssessment: "risk-unconfirmed" }),
    modelVerdict: ({ messages }) => {
      assert.match(messages[0].content, /Guardian did not confirm low risk and clear user authorization/);
      // The judge is told the rule it is held to, from the same table.
      assert.ok(messages[0].content.includes(fallbackJudgeRule()), "the prompt states FALLBACK_JUDGE_ALLOWS");
      return verdict.promise;
    },
  });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    const pending = await state.observe();
    assert.equal(pending[0]?.awaiting_review, true, "the chat must not render an Allow/Deny prompt while the fallback reviews");
    await state.firstModelCall;
    assert.equal((await state.observe())[0]?.awaiting_review, true);
    assert.deepEqual(state.resolved, []);
    assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, 1);
    verdict.resolve({ outcome: "allow", risk_level: "low", user_authorization: "high" });
    await state.firstAnswer;
    assert.deepEqual(await state.observe(), [], "acknowledgment clears the card even if the harness snapshot still lists it");
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
  } finally { verdict.resolve({ outcome: "deny" }); state.workflow.dispose(); }
});

test("switching on Model Judge rechecks an eligible waiting request only with quota consent", { timeout: 5_000 }, async () => {
  const state = fixture(undefined, { nativeGuardianReview: async () => ({ action: "ask", guardianAssessment: "low-risk" }) });
  try {
    await state.workflow.call("chat_model_judges", { enabled: false, meteredReviews: true });
    assert.equal((await state.observe())[0]?.recommendation?.guardianPending, true);
    assert.deepEqual(state.calls, []);
    await state.workflow.call("chat_model_judges", { enabled: true });
    await state.observe();
    await state.firstAnswer;
    assert.deepEqual(await state.observe(), []);
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
    assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, 1);
  } finally { state.workflow.dispose(); }
});

for (const [name, native, verdict, expectedCalls] of [
  ["native denial", { action: "deny", actor: "guardian" }, undefined, 0],
  ["high native risk", { action: "ask", guardianAssessment: "high-risk" }, undefined, 0],
  ["unconfirmed native risk the model also cannot clear", { action: "ask", guardianAssessment: "risk-unconfirmed" }, { outcome: "ask", risk_level: "medium", user_authorization: "unknown" }, 1],
  ["CPA would allow critical risk", { action: "ask", guardianAssessment: "low-risk" }, { outcome: "allow", risk_level: "critical", user_authorization: "low" }, 1],
  ["an allow outside the judge's table", { action: "ask", guardianAssessment: "low-risk" },
    { outcome: "allow", risk_level: "high", user_authorization: "unknown", rationale: "it reinstalls the app" }, 1],
]) test(`Model Judge does not approve ${name}`, { timeout: 5_000, skip: verdict && fallbackJudgeAllows(verdict) ? "FALLBACK_JUDGE_ALLOWS allows it" : false }, async () => {
  const state = fixture(undefined, { nativeGuardianReview: async () => native, modelVerdict: verdict && (async () => verdict) });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    await state.observe();
    await state.firstAnswer;
    assert.deepEqual(await state.observe(), []);
    assert.deepEqual(state.resolved, [["permission-1", "no"]]);
    assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, expectedCalls);
  } finally { state.workflow.dispose(); }
});

// Each pair FALLBACK_JUDGE_ALLOWS lists is an allow, the rest of the grid a deny (the judge's answer, not Guardian's).
for (const risk of ["low", "medium", "high", "critical"]) for (const authorization of ["high", "medium", "low", "unknown"]) {
  const allowed = (FALLBACK_JUDGE_ALLOWS[risk] ?? []).includes(authorization);
  assert.equal(fallbackJudgeAllows({ outcome: "allow", risk_level: risk, user_authorization: authorization }), allowed);
  assert.equal(fallbackJudgeAllows({ outcome: "deny", risk_level: risk, user_authorization: authorization }), false);
}
const tableAllow = Object.entries(FALLBACK_JUDGE_ALLOWS).find(([, authorizations]) => authorizations.length);
test("Model Judge approves what its table allows", { timeout: 5_000, skip: tableAllow ? false : "FALLBACK_JUDGE_ALLOWS is empty" }, async () => {
  const [risk_level, [user_authorization]] = tableAllow;
  const state = fixture(undefined, { nativeGuardianReview: async () => ({ action: "ask", guardianAssessment: "low-risk" }),
    modelVerdict: async () => ({ outcome: "allow", risk_level, user_authorization, rationale: "the user's standing instructions ask for this update" }) });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    await state.observe();
    await state.firstAnswer;
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
  } finally { state.workflow.dispose(); }
});

for (const invalidation of ["consent revoked", "request changed"]) test(`a paid Guardian fallback never answers after ${invalidation}`, { timeout: 5_000 }, async () => {
  const verdict = Promise.withResolvers();
  const state = fixture(undefined, {
    nativeGuardianReview: async () => ({ action: "ask", guardianUnavailable: true }),
    modelVerdict: () => verdict.promise,
  });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    await state.observe();
    await state.firstModelCall;
    assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, 1);
    if (invalidation === "consent revoked") await state.workflow.call("chat_model_judges", { meteredReviews: false });
    else state.command("python tools/migrate.py --different");
    verdict.resolve({ outcome: "allow", risk_level: "low", user_authorization: "high" });
    const pending = await state.observe();
    assert.equal(pending[0]?.recommendation?.guardianPending, true, "the invalidated verdict was discarded, not left in flight");
    assert.deepEqual(state.resolved, []);
    assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, 1);
  } finally { verdict.resolve({ outcome: "deny" }); state.workflow.dispose(); }
});

test("a pending request outside Guardian still needs explicit CPA consent", { timeout: 5_000 }, async () => {
  const state = fixture(undefined, { approvalDetails: { cwd: undefined }, nativeGuardianReview: async () => assert.fail("unattested shell") });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true });
    const pending = await state.observe();
    assert.equal(pending[0]?.recommendation?.quotaBlocked, true);
    assert.deepEqual(state.resolved, []);
    assert.deepEqual(state.calls, []);
    await state.workflow.call("chat_model_judges", { meteredReviews: true });
    await state.observe();
    await state.firstAnswer;
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
    assert.equal(state.calls.filter(url => url.endsWith("/chat/completions")).length, 1);
  } finally { state.workflow.dispose(); }
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

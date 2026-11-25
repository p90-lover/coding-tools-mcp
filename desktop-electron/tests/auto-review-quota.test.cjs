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

test("without quota consent, neither standalone Guardian nor CPA is called; opting in resumes the exact pending review", { timeout: 5_000 }, async () => {
  const seen = [];
  const state = fixture(undefined, { nativeGuardianReview: async (input) => {
    seen.push(input);
    return { action: "allow", reason: "fixture native verdict", actor: "guardian" };
  } });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true });
    const pending = await state.observe();
    assert.equal(pending[0]?.recommendation?.quotaBlocked, true);
    assert.match(pending[0].recommendation.reason, /Standalone Codex Guardian can use ChatGPT quota/);
    assert.deepEqual(seen, []);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.resolved, []);

    await state.workflow.call("chat_model_judges", { meteredReviews: true });
    await state.observe();
    await state.firstAnswer;
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
    await state.workflow.call("chat_model_judges", { meteredReviews: true });
    const pending = await state.observe();
    assert.equal(pending.length, 1);
    assert.match(pending[0].recommendation.reason, /original request changed/);
    assert.deepEqual(state.resolved, []);
    assert.deepEqual(state.calls, []);
  } finally { state.workflow.dispose(); }
});

test("revoking quota consent cancels a waiting Guardian review and discards a late reply", { timeout: 5_000 }, async () => {
  const entered = Promise.withResolvers(), guardian = Promise.withResolvers();
  let reviews = 0;
  const state = fixture(undefined, { nativeGuardianReview: async ({ signal }) => {
    reviews++;
    entered.resolve(signal);
    return guardian.promise;
  } });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    await state.observe();
    const signal = await entered.promise;
    assert.equal(signal.aborted, false);
    await state.workflow.call("chat_model_judges", { meteredReviews: false });
    assert.equal(signal.aborted, true);
    guardian.resolve({ action: "allow", reason: "fixture late verdict", actor: "guardian" });
    const pending = await state.observe();
    assert.equal(pending[0]?.recommendation?.quotaBlocked, true);
    assert.equal(reviews, 1);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.resolved, []);
  } finally { guardian.resolve(null); state.workflow.dispose(); }
});

test("Guardian's allow answers the same command again in the same chat only with quota consent", { timeout: 5_000 }, async () => {
  const details = {};
  let reviews = 0;
  const state = fixture(undefined, { approvalDetails: details, nativeGuardianReview: async () => {
    reviews++;
    return { action: "allow", reason: "fixture native verdict", actor: "guardian", reason_code: "native_guardian" };
  } });
  try {
    await state.workflow.call("chat_model_judges", { meteredReviews: true });
    await state.observe();
    await state.firstAnswer;
    await state.workflow.call("chat_model_judges", { meteredReviews: false });
    details.approval_id = "permission-2";
    const pending = await state.observe();
    assert.equal(pending[0]?.recommendation?.quotaBlocked, true);
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
    assert.equal(reviews, 1);

    await state.workflow.call("chat_model_judges", { meteredReviews: true });
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
      await state.workflow.call("chat_model_judges", { meteredReviews: true });
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
    await state.workflow.call("chat_model_judges", { meteredReviews: true });
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

test("the local workspace reviewer still answers without spending quota", async () => {
  const state = fixture(undefined, { nativeGuardianReview: async () => assert.fail("standalone Guardian with quota off") });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true });
    state.command("Set-Content -Path quota-fixture.txt -Value sample");
    await state.observe();
    assert.deepEqual(state.resolved, [["permission-1", "yes"]]);
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
    assert.deepEqual(await first.workflow.call("chat_model_judges"), { ok: true, modelJudges: true, meteredReviews: false, autoReviewAll: true });
    await first.workflow.call("chat_model_judges", { meteredReviews: true });
  } finally { first.workflow.dispose(); }
  const second = fixture(file);
  try {
    assert.equal((await second.workflow.call("chat_model_judges")).meteredReviews, true);
    await second.workflow.call("chat_model_judges", { meteredReviews: false });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).meteredReviews, false);
    assert.equal((await second.workflow.call("chat_model_judges")).modelJudges, true);
    // "Auto-review every approval request" (2026-11-24): on unless turned off, and kept when turned off.
    assert.equal((await second.workflow.call("chat_model_judges")).autoReviewAll, true);
    await second.workflow.call("chat_model_judges", { autoReviewAll: false });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).autoReviewAll, false);
    await assert.rejects(second.workflow.call("chat_model_judges", { autoReviewAll: "yes" }), /Choose on or off/);
  } finally { second.workflow.dispose(); }
});

test("a timed-out Guardian review retries with quota consent and Model Judge off; CPA fallback also retries on transient failure", { timeout: 5_000 }, async () => {
  let at = 1_000_000, guardianCalls = 0;
  const unpaved = fixture(undefined, {
    now: () => at,
    nativeGuardianReview: async () => {
      if (++guardianCalls === 1) return { action: "ask", guardianUnavailable: true, guardianTimedOut: true, reason: "Native Codex Guardian is unavailable." };
      return { action: "allow", reason: "recovered on retry", actor: "guardian", reason_code: "native_guardian" };
    },
  });
  try {
    await unpaved.workflow.call("chat_model_judges", { enabled: false, meteredReviews: true });
    const firstPending = await unpaved.observe();
    assert.equal(firstPending[0]?.awaiting_review, true, "first timeout stays in review for automatic retry");
    assert.deepEqual(unpaved.resolved, []);
    at += 5_000;
    await unpaved.observe();
    await unpaved.firstAnswer;
    assert.deepEqual(unpaved.resolved, [["permission-1", "yes"]]);
    assert.equal(guardianCalls, 2);
    assert.deepEqual(unpaved.calls, []);
  } finally { unpaved.workflow.dispose(); }

  let cpaTries = 0;
  const fallback = fixture(undefined, {
    now: () => at,
    nativeGuardianReview: async () => ({ action: "ask", guardianUnavailable: true, guardianTimedOut: true, reason: "Native Codex Guardian is unavailable." }),
    modelVerdict: async () => {
      if (++cpaTries <= 2) throw new Error("CPA timed out");
      return { outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "approved on second try" };
    },
  });
  try {
    await fallback.workflow.call("chat_model_judges", { enabled: true, meteredReviews: true });
    await fallback.observe();
    for (let wait = 0; wait < 100 && cpaTries < 2; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cpaTries, 2);
    assert.deepEqual(fallback.resolved, [], "first CPA failure retries instead of immediately denying");
    at += 5_000;
    await fallback.observe();
    await fallback.firstAnswer;
    assert.deepEqual(fallback.resolved, [["permission-1", "yes"]]);
    assert.equal(cpaTries, 3);
  } finally { fallback.workflow.dispose(); }
});

test("submitted timeout after launch keeps the launched agent alive and startRun/goal retries recover from headless timeouts", { timeout: 5_000 }, async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const node = { id: "one", role: "planner", state: "pending", parents: [], history: [{ error: "The agent could not start", finished_at_ms: 1_000 }], route, receipt: {} };
  const run = { id: "run", workspace_id: "ws", project_id: "task", revision: 1, execution_mode: "single",
    grant: { executable_sha256: "a".repeat(64), turns_started: 0, max_turns: 4, expires_at_ms: Date.now() + 3_600_000 }, nodes: [node] };
  let stoppedSessions = 0, submittedCalls = 0, grantCalls = 0;
  const timers = [];
  const workflow = createAgentOrchestratorWorkflow({
    setTimer: (fn, ms) => { const entry = { fn, ms, unref() {} }; timers.push(entry); return entry; },
    clearTimer: () => {},
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "test-model" }] }) }),
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/grant") {
        if (++grantCalls === 1) throw new Error("Headless request timed out");
        return { ok: true, run, grant: run.grant };
      }
      if (endpoint === "/api/v1/ao/control" && body?.action === "retry") {
        if (node.state === "pending") throw new Error("Mission control failed; refresh its saved state");
        node.state = "pending";
        return { ok: true, run };
      }
      if (endpoint === "/api/v1/ao/external/reserve") {
        node.state = "reserved";
        node.request_key = "req-1";
        return { ok: true, run, request_key: "req-1", prompt: "go" };
      }
      if (endpoint === "/api/v1/ao/external/submitted") {
        node.state = "running";
        node.receipt = { thread_id: body.session_id, request_key: body.request_key };
        if (++submittedCalls === 1) throw new Error("Headless request timed out");
        return { ok: true, run };
      }
      return { ok: true, runs: [run], worker_capacity: { run: 1 } };
    },
    aoHarness: {
      spawn: async () => "s-live",
      stop: async () => { stoppedSessions++; return { ok: true }; },
      kill: async () => { stoppedSessions++; return { ok: true }; },
      observe: async () => ({ status: "working", turnId: "t-1", turnState: "running", approvals: [], quiet: true }),
    },
    confirm: async () => true,
  });
  try {
    // Reconciles controlRun("retry") when the card was already moved to "pending" with prior history.
    const retried = await workflow.call("control_run", { workspaceId: "ws", runId: "run", action: "retry" });
    assert.equal(retried.ok, true);
    // startRun backs off on Headless request timed out instead of failing the run.
    run.grant = null;
    const started = await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    assert.equal(started.status, "running");
    assert.equal(grantCalls, 1);
    run.grant = { executable_sha256: "a".repeat(64), turns_started: 0, max_turns: 4, expires_at_ms: Date.now() + 3_600_000 };
    const startBackoff = timers.shift();
    assert.ok(startBackoff, "startRun scheduled a timeout backoff retry");
    startBackoff.fn();
    for (let tick = 0; tick < 60 && submittedCalls === 0; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(submittedCalls, 1);
    assert.equal(stoppedSessions, 0, "newly launched session was not killed when submitted timed out");
  } finally { workflow.dispose(); }
});

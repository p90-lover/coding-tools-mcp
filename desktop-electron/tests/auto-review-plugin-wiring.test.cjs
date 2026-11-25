"use strict";
require("./support/temp-dirs.cjs");

// "Approve for me" consults the local auto-review plugin (auto-review-host.cjs) before its other
// reviewers. The user's design (2026-11-24): the plugin's approve or decline settles a shell request
// with its reason; what it cannot settle (ask_user, simplify, unreadable) goes on as before, unless
// its blocklist matched. The app's own safety rules stay first. Outcomes and the person's own
// answers go back to it so it learns; agent questions ask it before the timeout's recommended answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

/** The plugin as the host offers it, answering review() with `verdict(input)`. */
function fakePlugin({ verdict = () => null, question = () => null, available = true } = {}) {
  const calls = { review: [], answerQuestion: [], recordOutcome: [], recordOverride: [] };
  const listeners = new Set();
  let stats = { enabled: true, commands: { today: { total: 0 } } };
  let id = 0;
  return {
    calls,
    emitStats(next) { stats = next; for (const listener of listeners) listener(next); },
    available: () => available,
    review: async (input) => {
      calls.review.push(input);
      const result = verdict(input);
      return result ? { decisionId: `c${++id}`, patterns: [], ...result } : null;
    },
    answerQuestion: async (input) => {
      calls.answerQuestion.push(input);
      const result = question(input);
      return result ? { decisionId: `q${++id}`, ...result } : null;
    },
    recordOutcome: async (input) => { calls.recordOutcome.push(input); return { ok: true }; },
    recordOverride: async (input) => { calls.recordOverride.push(input); return { ok: true }; },
    getStats: async () => stats,
    latestStats: () => stats,
    onStats(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** A Claude Code chat; `reviewer` "auto_review" is Approve for me, "user" is Ask for approval. */
function fixture({ plugin = fakePlugin(), reviewer = "auto_review", command = "python tools/migrate.py --apply", tool = "Bash", nativeGuardianReview, meteredReviews = false } = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: reviewer };
  const node = { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session", request_key: "key" } };
  const run = { id: "run", workspace_id: "ws", project_id: "task", revision: 1, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [node] };
  const resolved = [], guardian = [], events = [];
  const cwd = path.resolve(__dirname, "..");
  const state = { command, approvals: null, timeline: [] };
  const approval = () => ({ approval_id: "permission-1", source: "ao", kind: "command", tool, turn_id: "turn", command: state.command, cwd,
    decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }] });
  state.approvals = [approval()];
  const workflow = createAgentOrchestratorWorkflow({
    autoReview: plugin,
    nativeGuardianReview: nativeGuardianReview ?? (async (input) => { guardian.push(input); return { action: "ask", reason: "fixture Guardian is unsure", actor: "guardian" }; }),
    findCodexExecutable: () => process.execPath,
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "codex-auto-review" }] }) }),
    confirm: async () => true,
    confirmToolRequest: async () => true,
    logger: { info: (event, detail) => events.push([event, detail]), warn: (event, detail) => events.push([event, detail]) },
    requestHeadless: async (endpoint, body) => endpoint.endsWith("/read") ? { ok: true, runs: [run] }
      : endpoint.endsWith("/harness/status") ? { ok: true, status: { connected: false } }
        : body?.tool === "workflow_list" ? { ok: true, operation: { state: "completed", result: { ok: true, task: { description: "build it" } } } }
          : { ok: true },
    aoHarness: {
      sessionWorkspace: async () => ({ projectFolder: cwd }),
      observe: async () => ({ turnId: "turn", turnState: "running", timeline: state.timeline, approvals: state.approvals }),
      resolveApproval: async (_session, id, decision, message) => {
        resolved.push([id, decision, message]);
        state.approvals = [];
        return { ok: true };
      },
    },
  });
  // Since 0.8.165 Guardian runs only with Settings › Chat › "Allow quota-based reviews" on.
  const judges = meteredReviews ? workflow.call("chat_model_judges", { meteredReviews: true }) : Promise.resolve();
  const observe = async () => {
    await judges;
    await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
    for (let tick = 0; tick < 40; tick++) await new Promise(resolve => setImmediate(resolve));
    return (await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" })).pending_approvals;
  };
  return { workflow, plugin, resolved, guardian, events, observe, cwd, approval, set timeline(items) { state.timeline = items; } };
}

const approve = { verdict: "approve", settlement: "approved_by_rule", layer: "rule", reason: "python tools/migrate.py --apply has run safely 5 times" };
const declineByRule = { verdict: "decline", settlement: "declined_by_rule", layer: "rule", reason: "failed 3 times in a row" };

test("the plugin's approve settles an Approve for me shell request with its reason, before any other reviewer", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => approve }) });
  try {
    await state.observe();
    assert.deepEqual(state.resolved.map(([id, decision]) => [id, decision]), [["permission-1", "yes"]]);
    assert.equal(state.guardian.length, 0, "Guardian is not asked");
    assert.equal(state.plugin.calls.review.length, 1);
    assert.deepEqual(state.plugin.calls.review[0], { command: "python tools/migrate.py --apply", cwd: state.cwd, appId: "coding-tools", shell: "bash" });
    const decided = state.events.find(([event]) => event === "ao.approval_decided");
    assert.equal(decided[1].actor, "auto_review_plugin");
    assert.equal(decided[1].reason_code, "approved_by_rule");
  } finally { state.workflow.dispose(); }
});

test("the plugin's decline denies the request and tells the agent why, not as the person's refusal", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => declineByRule }) });
  try {
    await state.observe();
    assert.equal(state.resolved.length, 1);
    assert.equal(state.resolved[0][1], "no");
    assert.match(state.resolved[0][2], /not by the user/);
    assert.match(state.resolved[0][2], /failed 3 times in a row/);
    assert.equal(state.guardian.length, 0);
  } finally { state.workflow.dispose(); }
});

test("what the plugin cannot settle goes on as before: ask_user, simplify, unreadable, no answer", async (t) => {
  for (const [name, verdict] of [
    ["ask_user", { verdict: "ask_user", settlement: "passed_to_user", layer: "default", fallback: "decline", reason: "new command" }],
    ["simplify", { verdict: "simplify", settlement: "sent_back_to_simplify", layer: "simplify", reason: "uses a subshell" }],
    ["unreadable", { verdict: "decline", settlement: "declined_as_unreadable", layer: "unreadable", reason: "contains control characters" }],
    ["unavailable", null],
  ]) await t.test(name, async () => {
    const state = fixture({ plugin: fakePlugin({ verdict: () => verdict }), meteredReviews: true });
    try {
      await state.observe();
      assert.equal(state.plugin.calls.review.length, 1);
      assert.equal(state.guardian.length, 1, "the existing reviewer takes it");
      assert.deepEqual(state.resolved, [], "Guardian was unsure, so it waits for the person as before");
    } finally { state.workflow.dispose(); }
  });
});

test("with quota-based reviews off, what the plugin cannot settle waits for the person and Guardian is not asked", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => ({ verdict: "ask_user", settlement: "passed_to_user", layer: "default", reason: "new command" }) }) });
  try {
    const pending = await state.observe();
    assert.equal(state.plugin.calls.review.length, 1);
    assert.equal(state.guardian.length, 0, "Guardian stays off without the person's quota-based reviews setting");
    assert.deepEqual(state.resolved, []);
    assert.equal(pending?.length, 1, "the card stays for the person");
  } finally { state.workflow.dispose(); }
});

test("a blocklist match declines even when the plugin would otherwise hand it to the person", async () => {
  const blocked = { verdict: "ask_user", settlement: "passed_to_user", layer: "default", reason: "unclear",
    blocklist: { id: "publish", category: "publish", reason: "Publishes a package", command: "npm publish" } };
  const state = fixture({ plugin: fakePlugin({ verdict: () => blocked }) });
  try {
    await state.observe();
    assert.equal(state.resolved[0]?.[1], "no");
    assert.match(state.resolved[0][2], /Publishes a package/);
    assert.equal(state.guardian.length, 0);
  } finally { state.workflow.dispose(); }
});

test("the app's own safety rules stay first and win over a plugin approve", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => approve }), command: "git push --force origin main" });
  try {
    await state.observe();
    assert.equal(state.resolved[0]?.[1], "no");
    assert.match(state.resolved[0][2], /safety rules/);
    assert.equal(state.plugin.calls.review.length, 0, "a blocked request is never sent to the plugin");
  } finally { state.workflow.dispose(); }
});

test("only Approve for me cards, only the agent's own shell tool", async (t) => {
  await t.test("Ask for approval", async () => {
    const state = fixture({ plugin: fakePlugin({ verdict: () => approve }), reviewer: "user" });
    try {
      await state.observe();
      assert.equal(state.plugin.calls.review.length, 0);
    } finally { state.workflow.dispose(); }
  });
  await t.test("an MCP tool's command", async () => {
    const state = fixture({ plugin: fakePlugin({ verdict: () => approve }), tool: "mcp__coding-tools__exec_command" });
    try {
      await state.observe();
      assert.equal(state.plugin.calls.review.length, 0);
    } finally { state.workflow.dispose(); }
  });
  await t.test("PowerShell is reviewed as PowerShell", async () => {
    const state = fixture({ plugin: fakePlugin({ verdict: () => approve }), tool: "PowerShell", command: "Get-ChildItem -Recurse" });
    try {
      await state.observe();
      assert.equal(state.plugin.calls.review[0]?.shell, "powershell");
    } finally { state.workflow.dispose(); }
  });
});

test("Settings › Chat › Local auto-review: on by default, kept off when the person turns it off, with the plugin's stats", async () => {
  const plugin = fakePlugin({ verdict: () => approve });
  const state = fixture({ plugin, meteredReviews: true });
  try {
    const first = await state.workflow.call("chat_auto_review", {});
    assert.equal(first.ok, true);
    assert.equal(first.enabled, true, "on unless the person turns it off");
    assert.equal(first.available, true);
    assert.deepEqual(first.stats, { enabled: true, commands: { today: { total: 0 } } });
    assert.equal((await state.workflow.call("chat_auto_review", { enabled: false })).enabled, false);
    await assert.rejects(state.workflow.call("chat_auto_review", { enabled: "no" }), /on or off/);
    await state.observe();
    assert.equal(plugin.calls.review.length, 0, "switched off: the plugin is not consulted");
    assert.equal(state.guardian.length, 1, "the existing reviewer takes it");
  } finally { state.workflow.dispose(); }
});

test("without the plugin the setting says so and nothing changes", async () => {
  const state = fixture({ plugin: fakePlugin({ available: false }) });
  try {
    const read = await state.workflow.call("chat_auto_review", {});
    assert.equal(read.available, false);
  } finally { state.workflow.dispose(); }
});

test("the plugin's stats reach the app as they change (no polling)", async () => {
  const plugin = fakePlugin();
  const state = fixture({ plugin });
  const seen = [];
  const off = state.workflow.onAutoReviewStats((stats) => seen.push(stats));
  try {
    plugin.emitStats({ enabled: true, commands: { today: { total: 3 } } });
    assert.deepEqual(seen, [{ enabled: true, commands: { today: { total: 3 } } }]);
  } finally { off(); state.workflow.dispose(); }
});

test("the command's outcome goes back to the plugin once it has run", async (t) => {
  for (const [status, exitCode] of [["completed", 0], ["failed", 1]]) await t.test(status, async () => {
    const state = fixture({ plugin: fakePlugin({ verdict: () => approve }) });
    try {
      await state.observe();
      assert.equal(state.resolved.length, 1);
      state.timeline = [{ id: "act-1", kind: "command", status: "running", text: "python tools/migrate.py --apply" }];
      await state.observe();
      assert.deepEqual(state.plugin.calls.recordOutcome, [], "not while it runs");
      state.timeline = [{ id: "act-1", kind: "command", status, text: "python tools/migrate.py --apply" }];
      await state.observe();
      await state.observe();
      assert.deepEqual(state.plugin.calls.recordOutcome, [{ decisionId: "c1", exitCode }], "once");
    } finally { state.workflow.dispose(); }
  });
});

test("a denied request has no outcome to report", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => declineByRule }) });
  try {
    await state.observe();
    state.timeline = [{ id: "act-1", kind: "command", status: "completed", text: "python tools/migrate.py --apply" }];
    await state.observe();
    assert.deepEqual(state.plugin.calls.recordOutcome, []);
  } finally { state.workflow.dispose(); }
});

test("the person's own answer to a request the plugin reviewed is recorded, and its outcome after it ran", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => ({ verdict: "ask_user", settlement: "passed_to_user", layer: "default", fallback: "decline", reason: "new" }) }) });
  try {
    const pending = await state.observe();
    assert.equal(pending.length, 1, "waits for the person");
    const answered = await state.workflow.call("approve_harness", { workspaceId: "ws", runId: "run", nodeId: "one", approvalId: "permission-1", allow: true });
    assert.equal(answered.ok, true);
    assert.deepEqual(state.plugin.calls.recordOverride, [{ decisionId: "c1", userVerdict: "approve" }]);
    state.timeline = [{ id: "act-1", kind: "command", status: "completed", text: "python tools/migrate.py --apply" }];
    await state.observe();
    assert.deepEqual(state.plugin.calls.recordOutcome, [{ decisionId: "c1", exitCode: 0 }]);
  } finally { state.workflow.dispose(); }
});

test("a person's deny is recorded as their verdict", async () => {
  const state = fixture({ plugin: fakePlugin({ verdict: () => ({ verdict: "ask_user", settlement: "passed_to_user", layer: "default", reason: "new" }) }) });
  try {
    await state.observe();
    await state.workflow.call("approve_harness", { workspaceId: "ws", runId: "run", nodeId: "one", approvalId: "permission-1", allow: false });
    assert.deepEqual(state.plugin.calls.recordOverride, [{ decisionId: "c1", userVerdict: "decline" }]);
  } finally { state.workflow.dispose(); }
});

// Agent questions: before the "Agent questions" timeout gives the recommended answer.
const questionRoute = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
  permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
function questionWorld({ plugin, fields }) {
  const clock = { at: 1_000_000 };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [
    { id: "one", role: "planner", state: "running", parents: [], route: questionRoute, receipt: { thread_id: "session-1", request_key: "k" } }] };
  const answered = [];
  let pending = [{ approval_id: "ask", source: "ao", kind: "question", message: "Shall I run the tests again?", tool: "AskUserQuestion",
    summary: "Question", decisions: [], since: new Date(clock.at - 120_000).toISOString(), fields }];
  const workflow = createAgentOrchestratorWorkflow({
    autoReview: plugin,
    findCodexExecutable: () => process.execPath, now: () => clock.at,
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
  const settle = async () => {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 300 && !answered.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    mission.nodes[0].state = "finished";
  };
  return { workflow, answered, settle };
}
const choice = [{ key: "question_0", type: "choice", title: "Run them again?", options: [
  { value: "a", label: "Not now (Recommended)", description: "" }, { value: "b", label: "Yes, run them again", description: "" }] }];

test("an agent question nobody answered gets the plugin's answer when it has one", async () => {
  const plugin = fakePlugin({ question: () => ({ verdict: "answer", settlement: "answered", category: "confirm_routine", answer: "Yes, run them again", choiceIndex: 1, reason: "routine" }) });
  const world = questionWorld({ plugin, fields: choice });
  try {
    await world.settle();
    assert.equal(world.answered.length, 1);
    assert.deepEqual(world.answered[0].slice(0, 4), ["session-1", "ask", "accept", { question_0: "b" }]);
    assert.equal(plugin.calls.answerQuestion.length, 1);
    assert.match(plugin.calls.answerQuestion[0].question, /Shall I run the tests again\?[\s\S]*Run them again\?/);
    assert.deepEqual(plugin.calls.answerQuestion[0].options, ["Not now (Recommended)", "Yes, run them again"]);
    assert.equal(plugin.calls.answerQuestion[0].appId, "coding-tools");
  } finally { world.workflow.dispose(); }
});

test("an agent question the plugin passes on keeps the recommended answer", async () => {
  const plugin = fakePlugin({ question: () => ({ verdict: "ask_user", settlement: "passed_to_user", category: "design", reason: "design" }) });
  const world = questionWorld({ plugin, fields: choice });
  try {
    await world.settle();
    assert.deepEqual(world.answered[0].slice(0, 4), ["session-1", "ask", "accept", { question_0: "a" }]);
  } finally { world.workflow.dispose(); }
});

test("a question with more than one field, or one the plugin cannot map, keeps the recommended answer", async () => {
  const plugin = fakePlugin({ question: () => ({ verdict: "answer", settlement: "answered", category: "continue", answer: "yes", choiceIndex: 7, reason: "routine" }) });
  const world = questionWorld({ plugin, fields: choice });
  try {
    await world.settle();
    assert.deepEqual(world.answered[0].slice(0, 4), ["session-1", "ask", "accept", { question_0: "a" }], "an out-of-range choice is ignored");
  } finally { world.workflow.dispose(); }
});

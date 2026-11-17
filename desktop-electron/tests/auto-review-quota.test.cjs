"use strict";
require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

/** A Claude Code chat; `reviewer` "auto_review" is Approve for me, "user" is Ask for approval. */
function fixture(preferences, { reviewer = "auto_review" } = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: reviewer };
  const node = { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session", request_key: "key" } };
  const run = { id: "run", workspace_id: "ws", project_id: "task", revision: 1, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [node] };
  const calls = [], resolved = [];
  let command = "python tools/migrate.py --apply";
  const workflow = createAgentOrchestratorWorkflow({
    chatPreferencesFile: preferences,
    findCodexExecutable: () => process.execPath,
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      return { ok: true, json: async () => String(url).endsWith("/models")
        ? { data: [{ id: "codex-auto-review" }, { id: "test-model" }] }
        : { choices: [{ message: { content: JSON.stringify({ outcome: "allow", rationale: "fixture verdict" }) } }] } };
    },
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [run] } : { ok: true },
    aoHarness: {
      sessionWorkspace: async () => ({ projectFolder: path.resolve(__dirname, "..") }),
      observe: async () => ({ turnId: "turn", turnState: "running", timeline: [], approvals: [{
        approval_id: command, source: "ao", kind: "command", tool: "Bash", command,
        decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }],
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

// The user's call, 2026-11-17: with Allow quota-based reviews off, Approve for me and Let the model
// judge did nothing ("auto review isn't working ... and let model judge not working too"). Choosing
// either is choosing a model review, so it runs; the switch covers only reviews nobody chose.
test("Approve for me reviews run with quota-based reviews off; routine rules still need no model", async () => {
  const state = fixture();
  try {
    assert.equal((await state.workflow.call("chat_model_judges")).meteredReviews, false);
    const verdict = await state.screen();
    assert.equal(verdict.action, "allow", "the chat's own Approve for me reviews its screen actions");
    assert.ok(state.calls.some(url => url.endsWith("/chat/completions")));
    await state.observe();
    assert.deepEqual(state.resolved, [["python tools/migrate.py --apply", "yes"]], "a command the reviewer allowed is answered for the person");
    assert.equal(state.route.approvals_reviewer, "auto_review", "the saved native reviewer selection is not rewritten");
  } finally { state.workflow.dispose(); }
  const routine = fixture();
  try {
    routine.command("npm test");
    await routine.observe();
    assert.deepEqual(routine.resolved, [["npm test", "yes"]]);
    assert.deepEqual(routine.calls, [], "local rules need no model");
  } finally { routine.workflow.dispose(); }
});

for (const judge of [false, true]) test(`a chat not on Approve for me: its screen reviews ${judge ? "run with Let the model judge on" : "spend no quota while both switches are off"}`, async () => {
  const state = fixture(undefined, { reviewer: "user" });
  try {
    await state.workflow.call("chat_model_judges", { enabled: judge });
    const verdict = await state.screen();
    if (judge) {
      assert.equal(verdict.action, "allow", "Let the model judge is the person's choice of a model review");
      assert.ok(state.calls.some(url => url.endsWith("/chat/completions")));
      return;
    }
    assert.equal(verdict.action, "ask");
    assert.equal(verdict.quotaBlocked, true);
    assert.match(verdict.reason, /CPA reviews use account quota/);
    assert.deepEqual(state.calls, [], "neither catalog nor review requests are sent");
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

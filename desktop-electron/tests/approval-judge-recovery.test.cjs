"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

// Seen live 2026-11-04 (session coding-tools-mcp-259): an agent's `git -C <worktree> push` sat
// "waiting for approval" for an hour with "Let the model judge" on. The publication check could not
// verify a push through -C, so the reviewer left it to the person without asking any model; turning
// the judge on from that request's card never judged it, and nothing restarted the turn.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow: createWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const { gitPushRequest } = require("../electron/git-remote.cjs");

const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
  permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
const decisions = [{ id: "yes", kind: "allow_once" }, { id: "always", kind: "allow_always" }, { id: "no", kind: "reject_once" }];
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

/** A single "Approve for me" chat whose one request is `command`; the reviewer model answers `outcome`. */
function chat({ command, outcome = "allow", keepListing = false, clock = () => Date.now() }) {
  const request = { approval_id: "push", source: "ao", kind: "command", tool: "PowerShell", command, decisions };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) },
    nodes: [{ id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "s", request_key: "k", turn_id: "t" } }] };
  const resolved = [], prompts = [], interrupts = [];
  let lastActivityAt = clock();
  const workflow = createWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    now: clock,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "test-model" }, { id: "codex-auto-review" }] }) };
      prompts.push(JSON.parse(init.body).messages[0].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ outcome, rationale: "a feature-branch push the user asked for" }) } }] }) };
    },
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission], worker_capacity: { run: 1 } } : { ok: true, run: mission },
    aoHarness: {
      // `keepListing`: AO still lists the request after its answer went in.
      observe: async () => ({ status: "working", turnId: "t", turnState: interrupts.length ? "interrupted" : "running", lastActivityAt,
        timeline: [], approvals: interrupts.length || (resolved.length && !keepListing) ? [] : [request], needsInput: !interrupts.length }),
      resolveApproval: async (_session, id, decision) => { resolved.push([id, decision]); return { ok: true }; },
      interrupt: async session => { interrupts.push(session); },
    },
    confirm: async () => true,
  });
  return { workflow, mission, resolved, prompts, interrupts, quiet: (ms) => { lastActivityAt = clock() - ms; } };
}

test("a push through one absolute git -C folder is reviewable, with the repository read there; relative or repeated -C still is not", () => {
  const push = gitPushRequest("git -C G:/Projects/app/worktree -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin fix/accepted-turn-recovery");
  assert.equal(push.status, "review");
  assert.equal(push.workdir, "G:/Projects/app/worktree");
  assert.deepEqual(push.destinations, ["fix/accepted-turn-recovery"]);
  assert.equal(gitPushRequest("git -C /srv/app push origin feat/x").workdir, "/srv/app");
  assert.equal(gitPushRequest("git push origin feat/x").workdir, undefined, "a plain push keeps the request's own folder");
  for (const command of ["git -C ../other push origin feat/x", "git -C G:/a -C G:/b push origin feat/x", "git -C \\\\server\\share\\repo push origin feat/x",
    "git -C $HOME/repo push origin feat/x"]) assert.equal(gitPushRequest(command).status, "unknown", command);
  // -C never unlocks a protected or destructive push.
  assert.equal(gitPushRequest("git -C G:/Projects/app push origin main").status, "blocked");
  assert.equal(gitPushRequest("git -C G:/Projects/app push --force origin feat/x").status, "blocked");
});

test("with \"Let the model judge\" on, a push the app cannot verify is judged by the model, told why, not denied unread", async () => {
  const { workflow, mission, resolved, prompts } = chat({ command: "git -C ../other-worktree push origin feat/fix" });
  await workflow.call("chat_model_judges", { enabled: true });
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 300 && !resolved.length; tries++) await pause();
    assert.deepEqual(resolved, [["push", "yes"]], "the model's allow was sent");
    assert.ok(prompts.length >= 1, "a model saw the request");
    assert.match(prompts[0], /could not verify this publication locally/);
    assert.match(prompts[0], /destination or options need checking/);
  } finally { mission.nodes[0].state = "finished"; }
});

test("without the judge, a push the app cannot verify still waits for the person, unreviewed", async () => {
  const { workflow, mission, resolved, prompts } = chat({ command: "git -C ../other-worktree push origin feat/fix" });
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 30; tries++) await pause();
    assert.deepEqual(resolved, [], "nobody answered it for the person");
    assert.equal(prompts.length, 0, "no model was asked");
    const status = await workflow.call("harness_status", { workspaceId: "ws", runId: "run", nodeId: "one" }).catch(() => null);
    if (status?.status?.pending_approvals) assert.match(JSON.stringify(status.status.pending_approvals), /need checking/);
  } finally { mission.nodes[0].state = "finished"; }
});

test("turning the judge on judges a request the reviewer had already left to the person", async () => {
  const { workflow, mission, resolved, prompts } = chat({ command: "git -C ../other-worktree push origin feat/fix" });
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 30; tries++) await pause();
    assert.deepEqual(resolved, [], "left to the person first");
    await workflow.call("chat_model_judges", { enabled: true });
    for (let tries = 0; tries < 300 && !resolved.length; tries++) await pause();
    assert.deepEqual(resolved, [["push", "yes"]], "judged once the switch was on");
    const asked = prompts.length;
    for (let tries = 0; tries < 30; tries++) await pause();
    assert.equal(prompts.length, asked, "a judged request is not judged again");
  } finally { mission.nodes[0].state = "finished"; }
});

test("a turn AO keeps holding on a request the reviewer already answered is stopped once silent, so it retries on its own", async () => {
  let now = 2_000_000_000_000;
  const { workflow, mission, resolved, interrupts, quiet } = chat({ command: "python tools/poll.py", keepListing: true, clock: () => now });
  await workflow.call("chat_auto_retry", { enabled: true });
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    for (let tries = 0; tries < 300 && !resolved.length; tries++) await pause();
    assert.deepEqual(resolved, [["push", "yes"]], "the reviewer allowed it");
    for (let tries = 0; tries < 20; tries++) await pause();
    assert.deepEqual(interrupts, [], "a turn that just got its answer is left alone");
    now += 11 * 60_000;
    quiet(11 * 60_000);
    for (let tries = 0; tries < 300 && !interrupts.length; tries++) await pause();
    assert.deepEqual(interrupts.slice(0, 1), ["s"], "silent past the stall time with only an answered request: stopped");
  } finally { mission.nodes[0].state = "finished"; }
});

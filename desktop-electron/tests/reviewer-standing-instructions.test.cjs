"use strict";
require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const authorized = "<user_instructions>\nGlobal AGENTS.md: Prefer GitHub MCP.\nWorkspace AGENTS.md: Publish the verified task-scoped change as a pull request in fixture-owner/fixture-repo.\n</user_instructions>\n\n";

function fixture({ standing = authorized, verdict, command } = {}) {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", model: "cpa/test-model",
    approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const mission = { id: "run", workspace_id: "ws", project_id: "task", revision: 1, execution_mode: "single", nodes: [
    { id: "one", role: "planner", state: "running", route, receipt: { thread_id: "session", request_key: "key" } },
  ] };
  const prompts = [], resolved = [], reads = [];
  let instructions = standing, serial = 0, pending = [];
  const workflow = createAgentOrchestratorWorkflow({
    agentInstructions: { forLaunch: async (workspaceId, options) => {
      reads.push({ workspaceId, ...options });
      if (instructions instanceof Error) throw instructions;
      return { text: instructions, hash: instructions };
    } },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "codex-auto-review" }] }) };
      const body = JSON.parse(init.body);
      assert.equal(body.model, "codex-auto-review");
      const prompt = body.messages[0].content;
      prompts.push(prompt);
      const action = verdict ? verdict(prompt) : "deny";
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ outcome: action, rationale: "fixture review" }) } }] }) };
    },
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission] }
      : endpoint === "/api/v1/tools/call" ? { ok: true, operation: { state: "completed", result: {
        ok: true, tasks: [], task: { id: "task", description: "track and fix bugs\n\nFollow-up: pr u can use mcp" },
      } } }
      : endpoint.endsWith("/harness/status") ? { ok: true, status: { connected: false } } : { ok: true, run: mission },
    aoHarness: {
      observe: async () => ({ status: "working", turnId: "turn", turnState: "running", approvals: pending }),
      resolveApproval: async (_session, id, decision) => {
        resolved.push(decision);
        pending = pending.filter(item => item.approval_id !== id);
        return { ok: true };
      },
    },
  });
  return { workflow, prompts, resolved, reads, instructions: value => { instructions = value; },
    review: async (extra = {}) => {
      const before = resolved.length;
      pending = [{ approval_id: `request-${++serial}`, source: "ao", kind: "command",
        tool: command ? "PowerShell" : "mcp__github__push_files", ...(command ? { command } : {}),
        toolInput: JSON.stringify({ owner: "fixture-owner", repo: "fixture-repo", branch: "fix/task", files: [{ path: "fix.txt", content: "verified change" }] }),
        decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }], ...extra }];
      await workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
      for (let tick = 0; tick < 300 && resolved.length === before; tick++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(resolved.length, before + 1, "the review delivers its actual verdict");
      return resolved.at(-1);
    },
  };
}

test("GitHub MCP review receives current global and workspace instructions without bypassing the reviewer", async () => {
  const world = fixture({ verdict: prompt => prompt.includes(authorized) ? "allow" : "deny" });
  try {
    assert.equal(await world.review(), "yes");
    assert.equal(world.prompts.length, 1, "GitHub writes still invoke the selected reviewer");
    assert.ok(world.prompts[0].includes("mcp__github__push_files"));
    assert.ok(world.prompts[0].includes("pr u can use mcp"));
    assert.ok(world.prompts[0].includes("# The user's standing instructions for this workspace (trusted user content)\n" + authorized));
    assert.deepEqual(world.reads, [{ workspaceId: "ws", maxBytes: 24 * 1024 }]);
  } finally { world.workflow.dispose(); }
});

test("changed or unreadable standing instructions cannot reuse a cached GitHub approval", async () => {
  const world = fixture({ verdict: prompt => prompt.includes(authorized) ? "allow" : "deny" });
  try {
    assert.equal(await world.review(), "yes");
    assert.equal(await world.review(), "yes");
    assert.equal(world.prompts.length, 1, "unchanged context can reuse a passing review");
    world.instructions("<user_instructions>Do not publish this task; keep it local.</user_instructions>\n\n");
    assert.equal(await world.review(), "no");
    assert.equal(world.prompts.length, 2, "a revoked instruction changes the verdict cache key");
    world.instructions(new Error("instructions unavailable"));
    assert.equal(await world.review(), "no");
    assert.equal(world.prompts.length, 3, "a read failure cannot retain old authorization");
    assert.doesNotMatch(world.prompts.at(-1), /# The user's standing instructions for this workspace/);
  } finally { world.workflow.dispose(); }
});

test("standing GitHub instructions never override a reviewer denial or the hard safety rules", async () => {
  const denied = fixture({ verdict: () => "deny" });
  try {
    assert.equal(await denied.review(), "no");
    assert.equal(denied.prompts.length, 1);
  } finally { denied.workflow.dispose(); }
  const blocked = fixture({ verdict: () => "allow", command: "git push --force origin main" });
  try {
    assert.equal(await blocked.review(), "no");
    assert.equal(blocked.prompts.length, 0, "a hard-blocked action never reaches the model");
  } finally { blocked.workflow.dispose(); }
});

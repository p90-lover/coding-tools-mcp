"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

test("AO source module drafts with CPA, then appends only after local approval to the old board", async () => {
  const task = { id: "old", title: "Improve workflow", description: "Preserve the old plan",
    state: "in_progress", step: 1, clauses: [] };
  let revision = 4;
  let grants = 0;
  const confirmations = [];
  const calls = [];
  const requestHeadless = async (_path, body) => {
    calls.push(body.tool);
    const args = body.arguments;
    let result;
    if (body.tool === "workflow_list") {
      result = { ok: true, revision, workspace_id: "ws-1", steps: ["Specification", "Plan"],
        ...(args.task_id ? { task } : { tasks: [task] }) };
    } else if (body.tool === "request_permissions") {
      grants += 1;
      result = { ok: true, approval_token: "local-grant" };
    } else if (body.tool === "workflow_update" && !args.approval_token) {
      result = { ok: false, error: { code: "APPROVAL_REQUIRED",
        details: { request_id: "scoped-request" } } };
    } else if (body.tool === "workflow_update") {
      assert.equal(args.expected_revision, 4);
      assert.equal(args.approval_token, "local-grant");
      assert.equal(args.change.operation, "append_clauses");
      task.clauses = args.change.clauses.map((clause, index) => ({
        id: `clause-${index}`, ...clause, state: "backlog",
      }));
      revision += 1;
      result = { ok: true };
    } else {
      throw new Error("Unexpected tool");
    }
    return { ok: true, operation: { state: "completed", result } };
  };
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer local-only-key");
    if (url.endsWith("/models")) {
      return Response.json({ data: [{ id: "gemini-3.8-flash-high" }] });
    }
    assert.equal(url, "http://127.0.0.1:8317/v1/chat/completions");
    assert.equal(JSON.parse(init.body).model, "gemini-3.8-flash-high");
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      clauses: [{ title: "Plan boundaries", detail: "List scopes" }, { title: "Verify", detail: "Check behavior" }],
    }) } }] });
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless,
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "local-only-key" }),
    confirm: async (prompt) => { confirmations.push(prompt.message); return true; },
    fetchImpl,
  });
  const host = createCodingToolsAppsHost({
    services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) },
  });
  assert.ok(host.list().modules.some((module) => module.id === "agent-orchestrator"));
  const draft = (await host.call("agent-orchestrator", "plan", {
    workspaceId: "ws-1", taskId: "old", model: "gemini-3.8-flash-high",
  })).result;
  assert.equal(draft.saved, false);
  assert.equal(task.clauses.length, 0);
  const saved = (await host.call("agent-orchestrator", "append", {
    workspaceId: "ws-1", taskId: "old", expectedRevision: draft.expectedRevision, clauses: draft.clauses,
  })).result;
  assert.equal(saved.revision, 5);
  assert.equal(task.clauses.length, 2);
  assert.equal(grants, 1);
  assert.deepEqual(confirmations, ["Use CPA to draft plan clauses?", "Add clauses to this Coding Tools plan?"]);
  const board = (await host.call("agent-orchestrator", "board", { workspaceId: "ws-1" })).result;
  assert.equal(board.tasks[0].lane, "building");
  assert.deepEqual(board.tasks[0].clauseProgress, { done: 0, total: 2 });
  const next = (await host.call("agent-orchestrator", "next", { workspaceId: "ws-1" })).result;
  assert.match(next.prompt, /List scopes/);
  assert.ok(calls.includes("workflow_update"));
});

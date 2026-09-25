"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

test("AO keeps manual clauses on the old board and confirms durable run changes locally", async () => {
  const task = { id: "old", title: "Improve workflow", state: "in_progress", step: 1, clauses: [] };
  let revision = 4;
  let grants = 0;
  let aoUpdates = 0;
  const confirmations = [];
  const requestHeadless = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/read") {
      assert.equal(body.workspace_id, "ws-1");
      return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [] }], board_revision: revision };
    }
    if (endpoint === "/api/v1/ao/update") {
      assert.deepEqual(options, { localConfirmation: true });
      assert.equal(body.workspace_id, "ws-1");
      assert.equal(body.change.operation, "cancel");
      aoUpdates += 1;
      return { ok: true, run: { id: "run-1", workspace_id: "ws-1", cancelled: true } };
    }
    assert.equal(endpoint, "/api/v1/tools/call");
    const args = body.arguments;
    let result;
    if (body.tool === "workflow_list") {
      result = { ok: true, revision, workspace_id: "ws-1", steps: ["Specification", "Plan"],
        ...(args.task_id ? { task } : { tasks: [task] }) };
    } else if (body.tool === "request_permissions") {
      grants += 1;
      result = { ok: true, approval_token: "local-grant" };
    } else if (body.tool === "workflow_update" && !args.approval_token) {
      result = { ok: false, error: { code: "APPROVAL_REQUIRED", details: { request_id: "scoped-request" } } };
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
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless,
    cpaConnection: () => { throw new Error("CPA is not an AO planner"); },
    confirm: async (prompt) => { confirmations.push(prompt.message); return true; },
    fetchImpl: () => { throw new Error("AO board must not call a model"); },
  });
  const host = createCodingToolsAppsHost({
    services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) },
  });
  assert.ok(host.list().modules.some((module) => module.id === "agent-orchestrator"));
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.some((operation) => operation.name === "plan"), false);
  const saved = (await host.call("agent-orchestrator", "append", {
    workspaceId: "ws-1", taskId: "old", expectedRevision: 4,
    clauses: [{ title: "Plan boundaries", detail: "List scopes" }],
  })).result;
  assert.equal(saved.revision, 5);
  assert.equal(task.clauses.length, 1);
  assert.equal(grants, 1);
  const runs = (await host.call("agent-orchestrator", "runs", { workspaceId: "ws-1" })).result;
  assert.equal(runs.runs[0].id, "run-1");
  const changed = (await host.call("agent-orchestrator", "update_run", {
    workspaceId: "ws-1",
    change: { operation: "cancel", run_id: "run-1", expected_revision: 1 },
  })).result;
  assert.equal(changed.run.cancelled, true);
  assert.equal(aoUpdates, 1);
  assert.deepEqual(confirmations, ["Add clauses to this Coding Tools plan?", "Change this AO mission?"]);
});

test("AO readiness requires both the task and its clauses to be complete", () => {
  const { presentTask } = require("../../app-handler/agent-orchestrator/kanban.cjs");
  const task = { state: "done", step: 7, clauses: [{ state: "backlog" }] };
  assert.equal(presentTask(task).lane, "needs_review");
  task.state = "in_progress";
  task.clauses[0].state = "done";
  assert.equal(presentTask(task).lane, "needs_review");
  task.state = "done";
  assert.equal(presentTask(task).lane, "ready");
});

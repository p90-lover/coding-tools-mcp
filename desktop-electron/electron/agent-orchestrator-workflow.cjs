"use strict";

const { randomUUID } = require("node:crypto");

function clean(value, limit, required = true) {
  if (typeof value !== "string") throw new Error("Expected text");
  const text = value.trim();
  if ((required && !text) || text.length > limit || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    throw new Error("Text is empty, too long, or contains control characters");
  }
  return text;
}

function clausesFrom(value) {
  const clauses = value?.clauses;
  if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 12) {
    throw new Error("Provide between one and twelve clauses");
  }
  return clauses.map((item) => ({
    title: clean(item?.title, 240),
    detail: clean(item?.detail ?? "", 8192, false),
  }));
}

function createAgentOrchestratorWorkflow({ requestHeadless, cpaConnection, confirm, fetchImpl = fetch }) {
  async function tool(workspaceId, name, arguments_) {
    const response = await requestHeadless("/api/v1/tools/call", {
      request_id: randomUUID(),
      workspace_id: clean(workspaceId, 128),
      tool: name,
      arguments: arguments_,
    });
    const operation = response?.operation;
    if (operation?.state !== "completed" || !operation.result) {
      throw new Error("Workflow outcome is unknown; refresh the board before trying again");
    }
    return operation.result;
  }

  function checked(result) {
    if (result?.ok === false) throw new Error(result.error?.message || "Workflow operation failed");
    return result;
  }

  async function write(workspaceId, arguments_) {
    let result = await tool(workspaceId, "workflow_update", arguments_);
    if (result?.error?.code === "APPROVAL_REQUIRED") {
      const requestId = result.error?.details?.request_id;
      if (typeof requestId !== "string") throw new Error("Workflow approval request is invalid");
      const grant = checked(await tool(workspaceId, "request_permissions", {
        request_id: requestId, scope: "once", confirm: true,
      }));
      result = await tool(workspaceId, "workflow_update", {
        ...arguments_, approval_token: grant.approval_token,
      });
    }
    return checked(result);
  }

  async function board({ workspaceId, taskId } = {}) {
    const result = checked(await tool(workspaceId, "workflow_list", {
      ...(taskId ? { task_id: clean(taskId, 128) } : {}),
      limit: 100,
      include_archived: false,
    }));
    return { ok: true, revision: result.revision, steps: result.steps, tasks: result.tasks,
      task: result.task, workspaceId: result.workspace_id };
  }

  function connection() {
    const value = cpaConnection();
    if (!value?.proxyApiKey) throw new Error("Start managed CPA and configure a proxy API key first");
    const url = new URL(value.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "8317"
      || url.username || url.password || url.search || url.hash) {
      throw new Error("CPA must use its managed local endpoint");
    }
    return { baseUrl: url.origin, key: value.proxyApiKey };
  }

  async function models() {
    const { baseUrl, key } = connection();
    const response = await fetchImpl(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`CPA model catalog returned HTTP ${response.status}`);
    const payload = await response.json();
    const models = [...new Set((Array.isArray(payload?.data) ? payload.data : [])
      .map((entry) => entry?.id).filter((id) => typeof id === "string" && id.length <= 128))].slice(0, 100);
    if (!models.length) throw new Error("CPA has no available models");
    return { ok: true, models };
  }

  async function runs({ workspaceId, runId } = {}) {
    const id = clean(workspaceId, 128);
    const response = await requestHeadless("/api/v1/ao/read", {
      workspace_id: id,
      ...(runId ? { run_id: clean(runId, 80) } : {}),
    });
    if (response?.ok !== true || !Array.isArray(response.runs)) {
      throw new Error("AO run read failed");
    }
    return response;
  }

  async function updateRun({ workspaceId, change } = {}) {
    const id = clean(workspaceId, 128);
    if (!change || typeof change !== "object" || Array.isArray(change)
      || !["create", "graph", "cancel"].includes(change.operation)) {
      throw new Error("Choose a supported AO graph change");
    }
    const runId = clean(change.operation === "create" ? change.run?.id : change.run_id, 80);
    const routes = change.operation === "create" && Array.isArray(change.run?.nodes)
      ? change.run.nodes.map((node) => `${clean(node?.role, 20)}: ${clean(node?.route?.harness_id, 128)} / ${clean(node?.route?.model, 128)}`).join("\n")
      : "";
    if (!await confirm({
      message: change.operation === "create" ? "Create this AO mission?" : "Change this AO mission?",
      detail: `Workspace: ${id}\nRun: ${runId}\nAction: ${change.operation}\n${routes}`.slice(0, 1200),
    })) return { ok: false, cancelled: true };
    const response = await requestHeadless("/api/v1/ao/update", {
      workspace_id: id, change, confirm: true,
    }, { localConfirmation: true });
    if (response?.ok !== true || response.run?.workspace_id !== id) {
      throw new Error("AO run update failed; refresh before retrying");
    }
    return response;
  }

  async function create({ workspaceId, title, description = "", expectedRevision } = {}) {
    const name = clean(title, 240);
    const detail = clean(description, 8192, false);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Refresh the board revision");
    if (!await confirm({
      message: "Create a Coding Tools plan task?",
      detail: `Add "${name}" to this workspace's existing plan board.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "create", title: name, description: detail },
    });
    return board({ workspaceId });
  }

  async function append({ workspaceId, taskId, expectedRevision, clauses } = {}) {
    const id = clean(taskId, 128);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Refresh the board revision");
    const additions = clausesFrom({ clauses });
    if (!await confirm({
      message: "Add clauses to this Coding Tools plan?",
      detail: `${additions.length} clauses will be added to task ${id}. Existing clauses and evidence remain intact.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "append_clauses", id, clauses: additions },
    });
    return board({ workspaceId, taskId: id });
  }

  async function moveTask({ workspaceId, taskId, state, expectedRevision } = {}) {
    const id = clean(taskId, 128);
    if (!["backlog", "in_progress", "blocked", "done"].includes(state)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Refresh the board and choose a supported task state");
    }
    if (!await confirm({
      message: "Update this plan task?",
      detail: `Task ${id} will move to ${state}.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "move", id, state },
    });
    return board({ workspaceId });
  }

  async function moveClause({ workspaceId, taskId, clauseId, state, expectedRevision } = {}) {
    const id = clean(taskId, 128);
    const clause = clean(clauseId, 128);
    if (!["backlog", "in_progress", "blocked", "done"].includes(state)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Refresh the board and choose a supported clause state");
    }
    if (!await confirm({
      message: "Update a plan clause?",
      detail: `Clause ${clause} in task ${id} will move to ${state}.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "move_clause", id, clause_id: clause, state },
    });
    return board({ workspaceId, taskId: id });
  }

  async function next({ workspaceId } = {}) {
    const current = await board({ workspaceId });
    const actionable = (clause) => clause.state === "backlog" || clause.state === "in_progress";
    const task = (current.tasks ?? []).find((entry) => entry.state !== "blocked"
      && entry.state !== "done" && entry.clauses?.some(actionable));
    const clause = task?.clauses?.find(actionable);
    const detail = task ? await board({ workspaceId, taskId: task.id }) : null;
    const fullClause = detail?.task?.clauses?.find((entry) => entry.id === clause?.id);
    return { ok: true, taskId: task?.id ?? null, clause: fullClause ?? null,
      prompt: fullClause ? `Work on ${task.title}: ${fullClause.title}. ${fullClause.detail} Inspect the exact workspace and report evidence before marking this clause done.`.trim() : null };
  }

  async function call(operation, args = {}) {
    switch (operation) {
      case "inspect": return { ok: true, status: "graph_ready", source: "coding-tools-plan", plannerRoute: "webgpt-on-codex-required", execution: "not_connected" };
      case "board": return board(args);
      case "models": return models();
      case "runs": return runs(args);
      case "update_run": return updateRun(args);
      case "create": return create(args);
      case "append": return append(args);
      case "move_task": return moveTask(args);
      case "move_clause": return moveClause(args);
      case "next": return next(args);
      default: throw new Error("Unknown Agent Orchestrator operation");
    }
  }

  return Object.freeze({ call });
}

module.exports = { createAgentOrchestratorWorkflow, clausesFrom };

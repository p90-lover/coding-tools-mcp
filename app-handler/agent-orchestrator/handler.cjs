"use strict";

const { presentTask } = require("./kanban.cjs");

const SPECS = Object.freeze({
  upstream_status: { readOnly: true, description: "Inspect the source-built local-only AO daemon." },
  upstream_start: { readOnly: false, description: "Start the bundled source-built AO daemon on loopback." },
  upstream_stop: { readOnly: false, description: "Stop the owned AO daemon after local confirmation." },
  upstream_show: { readOnly: false, description: "Embed the original AO renderer in the Coding Tools window." },
  upstream_hide: { readOnly: false, description: "Hide the embedded original AO renderer without ending sessions." },
  upstream_bounds: { readOnly: false, description: "Resize the embedded AO renderer within the host window." },
  upstream_projects: { readOnly: true, description: "List actual upstream AO projects." },
  upstream_bind_workspace: { readOnly: false, description: "Bind a registered local workspace to AO by its canonical directory without creating repositories or worktrees." },
  upstream_sessions: { readOnly: true, description: "List actual upstream AO sessions." },
  upstream_agents: { readOnly: true, description: "List upstream harness availability." },
  upstream_orchestrators: { readOnly: true, description: "List upstream project orchestrators." },
  upstream_create_project: { readOnly: false, description: "Create an upstream AO project after local confirmation." },
  upstream_create_session: { readOnly: false, description: "Create an upstream AO worker session after local confirmation." },
  upstream_create_orchestrator: { readOnly: false, description: "Create an upstream project orchestrator after local confirmation." },
  upstream_send: { readOnly: false, description: "Send a message to an upstream session after local confirmation." },
  inspect: { readOnly: true, description: "Inspect the in-process source-integrated Agent Orchestrator module." },
  board: { readOnly: true, description: "Read the old Coding Tools plan board with nested clauses." },
  models: { readOnly: true, description: "List models for one worker harness: CPA for Native Codex, or the AO agent's own catalog." },
  harnesses: { readOnly: true, description: "List worker harnesses: Native Codex plus installed upstream AO agents." },
  runs: { readOnly: true, description: "Read durable AO mission graphs in one workspace." },
  update_run: { readOnly: false, description: "Create, edit, or cancel a revisioned AO mission without repeating the caller's confirmation." },
  team_update: { readOnly: false, description: "Save reusable roles, apply settings to queued jobs, or change worker ceilings from the local GUI." },
  harness_status: { readOnly: true, description: "Inspect an AO-owned WebGPT-on-Codex connection; connected is not route verified." },
  connect_harness: { readOnly: false, description: "Connect one saved WebGPT or CPA worker node through the selected Codex executable after local confirmation." },
  stop_harness: { readOnly: false, description: "Stop one AO-owned Codex connection after local confirmation." },
  observe: { readOnly: true, description: "Read and reconcile one reserved AO card without submitting another turn." },
  advance: { readOnly: false, description: "Run one ready AO card, or observe an active reservation, with local approval and no automatic replay." },
  start_run: { readOnly: false, description: "Validate the saved AO graph and grant its read-only background execution; tool approvals remain separate." },
  control_run: { readOnly: false, description: "Pause queued work, resume a paused mission, or stop only that mission's owned harnesses from the local GUI." },
  run_status: { readOnly: true, description: "Read background AO run progress and held state." },
  approve_harness: { readOnly: false, description: "Allow once or deny one visible AO-owned native tool request after focused local confirmation." },
  next: { readOnly: true, description: "Return the next actionable plan clause for the active Codex harness." },
  chat_send: { readOnly: false, description: "Send a chat message: create the chat's task (or append a follow-up) and start a team run on it." },
  codex_executable: { readOnly: true, description: "Locate the installed Codex desktop app's codex.exe used to run missions." },

  create: { readOnly: false, description: "Create a task for the Coding Tools mission board at its expected revision." },
  append: { readOnly: false, description: "Append reviewed clauses to the old plan board with its expected revision." },
  move_task: { readOnly: false, description: "Move one plan task after local confirmation." },
  move_clause: { readOnly: false, description: "Move one plan clause after local confirmation." },
});

module.exports = Object.freeze({
  operations: Object.freeze(Object.keys(SPECS)),
  module: Object.freeze({
    id: "agent-orchestrator",
    name: "Agent Orchestrator",
    operations: Object.freeze(Object.entries(SPECS).map(([name, spec]) => ({ name, ...spec }))),
  }),
  isReadOnly(operation) {
    return SPECS[operation]?.readOnly === true;
  },
  async invoke(operation, args = {}, context = {}) {
    if (!Object.hasOwn(SPECS, operation)) throw new Error("Unknown Agent Orchestrator operation");
    const call = operation.startsWith("upstream_")
      ? context.services?.agentOrchestratorUpstream
      : context.services?.agentOrchestrator;
    if (typeof call !== "function") {
      return { ok: false, status: "unavailable", reason: "Coding Tools workflow service is unavailable" };
    }
    const result = await call(operation, args);
    if (operation !== "board" || result?.ok !== true) return result;
    return {
      ...result,
      tasks: Array.isArray(result.tasks) ? result.tasks.map(presentTask) : [],
      task: result.task ? presentTask(result.task) : null,
    };
  },
});

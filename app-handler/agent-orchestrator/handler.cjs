"use strict";

const { presentTask } = require("./kanban.cjs");

const SPECS = Object.freeze({
  inspect: { readOnly: true, description: "Inspect the in-process source-integrated Agent Orchestrator module." },
  board: { readOnly: true, description: "Read the old Coding Tools plan board with nested clauses." },
  models: { readOnly: true, description: "List CPA models available to eligible worker harnesses." },
  runs: { readOnly: true, description: "Read durable AO mission graphs in one workspace." },
  update_run: { readOnly: false, description: "Create, edit, or cancel a revisioned AO run after focused local confirmation." },
  next: { readOnly: true, description: "Return the next actionable plan clause for the active Codex harness." },

  create: { readOnly: false, description: "Create a task in the old Coding Tools plan board after local confirmation." },
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
    const call = context.services?.agentOrchestrator;
    if (typeof call !== "function") {
      return { ok: false, status: "unavailable", reason: "Coding Tools workflow service is unavailable" };
    }
    const result = await call(operation, args);
    if (operation !== "board" || result?.ok !== true) return result;
    return {
      ...result,
      tasks: Array.isArray(result.tasks) ? result.tasks.map(presentTask) : result.tasks,
      task: result.task ? presentTask(result.task) : result.task,
    };
  },
});

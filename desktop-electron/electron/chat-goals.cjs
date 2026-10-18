"use strict";

// Chat goals, as Codex's /goal: a chat keeps working toward an objective on its own. Codex keeps a
// goal on one app-server thread; here a chat is a series of runs (Single model or a whole team, on
// any harness), so the goal lives with the chat: each round is one run, and when a run settles the
// chat decides from its final answers whether the goal is achieved, stalled or worth another round.

const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

/** Rounds a goal may take before it stops as "limited" (Codex stops on a token budget). */
const DEFAULT_GOAL_ROUNDS = 6;
const MAX_GOAL_ROUNDS = 20;
const OBJECTIVE_LIMIT = 2000;
const STATUSES = new Set(["active", "paused", "achieved", "stalled", "limited"]);

/** What every goal round asks of the agent: work toward the objective and say where it stands. */
function goalPrompt(objective, round, rounds) {
  return [
    round > 1 ? `Continue pursuing the goal (round ${round} of ${rounds}). Pick up from where the last round left off.` : `Goal (round 1 of ${rounds}):`,
    `Goal: ${objective}`,
    "",
    "Work toward this goal and verify the result against it. End your final answer with exactly one line:",
    "GOAL: ACHIEVED — when the goal is fully met and verified",
    "GOAL: CONTINUE — followed by what still remains",
  ].join("\n");
}

/**
 * Where a run left the goal, from the answers of the cards that close it (a Single model's card, a
 * team's reviewer, or an orchestrator that answered alone): "achieved", "continue", or null when no
 * card said, which counts as another round.
 */
function goalVerdict(answers) {
  let verdict = null;
  for (const answer of answers) {
    const lines = String(answer || "").split(/\r?\n/).map(line => line.replace(/[*_`]/g, "").trim());
    const said = lines.reverse().map(line => line.match(/^GOAL\s*:\s*(ACHIEVED|CONTINUE)\b/i)).find(Boolean);
    if (!said) continue;
    if (said[1].toUpperCase() === "ACHIEVED") return "achieved";
    verdict = "continue";
  }
  return verdict;
}

/** The answers of a settled run's closing cards: cards no other card waits on (the retry sidecar aside). */
function closingAnswers(mission) {
  const nodes = (mission?.nodes ?? []).filter(node => node.role !== "retry");
  const parents = new Set(nodes.flatMap(node => node.parents ?? []));
  const closing = nodes.filter(node => !parents.has(node.id));
  const planner = nodes.find(node => node.role === "planner");
  // An orchestrator that answered alone ("solo") closes the mission itself.
  if (mission?.solo && planner) closing.push(planner);
  return closing.map(node => node.receipt?.answer).filter(answer => typeof answer === "string" && answer.trim());
}

function cleanObjective(value) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text) throw new Error("Describe your goal, e.g. /goal make every test pass");
  if (text.length > OBJECTIVE_LIMIT) throw new Error(`A goal can be at most ${OBJECTIVE_LIMIT} characters`);
  return text;
}

/**
 * The saved goals, one per chat ("<workspace>:<task>"), kept in a small JSON file so a goal survives
 * an app restart. Without a file (tests) they live in memory.
 */
function createGoalStore({ file = null, now = Date.now } = {}) {
  let goals = {};
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) goals = saved;
    } catch { /* No goals saved yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  const persist = next => {
    if (file) writePrivateFileAtomic(file, JSON.stringify(next, null, 2));
  };
  return {
    get: (workspaceId, taskId) => goals[key(workspaceId, taskId)] ?? null,
    /** Every goal of one project, by chat. */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(goals).filter(([name]) => name.startsWith(prefix)).map(([name, goal]) => [name.slice(prefix.length), goal]));
    },
    set(workspaceId, taskId, objective, rounds = DEFAULT_GOAL_ROUNDS) {
      const at = now();
      const goal = { objective: cleanObjective(objective), status: "active", round: 0,
        rounds: Math.max(1, Math.min(MAX_GOAL_ROUNDS, Math.round(Number(rounds) || DEFAULT_GOAL_ROUNDS))),
        startedAt: at, updatedAt: at, lastRunId: "", evaluatedRunId: "", note: "" };
      const id = key(workspaceId, taskId);
      persist({ ...goals, [id]: goal });
      goals[id] = goal;
      return goal;
    },
    update(workspaceId, taskId, change) {
      const goal = goals[key(workspaceId, taskId)];
      if (!goal) return null;
      const next = { ...goal, ...change, updatedAt: now() };
      if (!STATUSES.has(next.status)) throw new Error("Unknown goal status");
      persist({ ...goals, [key(workspaceId, taskId)]: next });
      Object.assign(goal, next);
      return goal;
    },
    clear(workspaceId, taskId) {
      const had = Boolean(goals[key(workspaceId, taskId)]);
      if (had) {
        const next = { ...goals };
        delete next[key(workspaceId, taskId)];
        persist(next);
        delete goals[key(workspaceId, taskId)];
      }
      return had;
    },
  };
}

module.exports = { DEFAULT_GOAL_ROUNDS, MAX_GOAL_ROUNDS, goalPrompt, goalVerdict, closingAnswers, cleanObjective, createGoalStore };

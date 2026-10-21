"use strict";

// Chat goals, as Claude Code's /goal: a chat keeps working until a condition holds. Claude Code
// checks the condition each time the agent stops: a separate evaluator model reads the transcript
// and, when the condition is not met yet, the agent goes on with "Stop hook feedback:" naming the
// condition and why. Here a chat is a series of runs (Single model or a whole team, on any
// harness), so the goal lives with the chat: each round is one run, and when a run settles the
// evaluator judges it from the round's message and the closing cards' answers.

const fs = require("node:fs");
const path = require("node:path");

const OBJECTIVE_LIMIT = 2000;
const STATUSES = new Set(["active", "paused", "achieved", "stalled", "limited"]);
// How much of a round the evaluator reads, the end kept: an agent's conclusion comes last.
const TRANSCRIPT_LIMIT = 24_000;
const REASON_LIMIT = 1_500;

/**
 * The message a goal round sends. The first round sends the condition itself, as the person set
 * it; every later one is Claude Code's stop-hook feedback: the condition in brackets and the
 * evaluator's reason it is not met yet.
 */
function goalMessage(objective, round, reason = "") {
  if (round <= 1) return objective;
  const why = String(reason || "").trim() || "The condition is not met yet; continue from where the last round left off.";
  return `Stop hook feedback:\n[${objective}]: ${why}`;
}

/** What a settled round showed: the message it was sent and the closing cards' answers. */
function roundTranscript(message, answers) {
  const parts = [`User:\n${String(message || "").trim() || "(no message)"}`];
  const said = (answers ?? []).filter((answer) => typeof answer === "string" && answer.trim());
  parts.push(said.length ? said.map((answer) => `Assistant:\n${answer.trim()}`).join("\n\n") : "Assistant:\n(no final answer)");
  const text = parts.join("\n\n");
  return text.length > TRANSCRIPT_LIMIT ? `…${text.slice(-TRANSCRIPT_LIMIT)}` : text;
}

/** The evaluator's instructions: judge the condition from the transcript alone, as JSON. */
function goalCheckPrompt(objective, transcript) {
  return [
    "You evaluate whether a stop condition set for an AI coding agent is satisfied, judging only from the transcript of its latest turn below.",
    "",
    `Condition: ${objective}`,
    "",
    "Rules:",
    "- The condition is satisfied only when the transcript shows evidence that it holds now: the work done, checked, and its result reported.",
    "- Claims without evidence, plans, partial progress, waiting on someone or something, or work left for later are not satisfied.",
    "- A condition that describes an ongoing aim rather than an end state is not satisfied by progress alone.",
    "- If the transcript does not show enough to decide, it is not satisfied.",
    "",
    'Answer with JSON only: {"met": true|false, "reason": "<one short paragraph: what the transcript shows, and what is still missing when not met>"}',
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/** The evaluator's answer as { met, reason }; anything unreadable throws. */
function parseGoalCheck(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The goal evaluator gave no verdict");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed?.met !== "boolean") throw new Error("The goal evaluator gave no verdict");
  const reason = String(parsed.reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_LIMIT);
  return { met: parsed.met, reason: reason || (parsed.met ? "The condition is met." : "The condition is not met yet.") };
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
 * an app restart. Without a file (tests) they live in memory. A goal has no round limit, as in
 * Claude Code (`rounds` 0); one saved by an earlier version keeps its limit.
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
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(goals, null, 2));
    fs.renameSync(temporary, file);
  };
  return {
    get: (workspaceId, taskId) => goals[key(workspaceId, taskId)] ?? null,
    /** Every goal of one project, by chat. */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(goals).filter(([name]) => name.startsWith(prefix)).map(([name, goal]) => [name.slice(prefix.length), goal]));
    },
    set(workspaceId, taskId, objective) {
      const at = now();
      const goal = { objective: cleanObjective(objective), status: "active", round: 0, rounds: 0,
        startedAt: at, updatedAt: at, lastRunId: "", evaluatedRunId: "", note: "", feedback: "" };
      goals[key(workspaceId, taskId)] = goal;
      persist();
      return goal;
    },
    update(workspaceId, taskId, change) {
      const goal = goals[key(workspaceId, taskId)];
      if (!goal) return null;
      Object.assign(goal, change, { updatedAt: now() });
      if (!STATUSES.has(goal.status)) throw new Error("Unknown goal status");
      persist();
      return goal;
    },
    clear(workspaceId, taskId) {
      const had = Boolean(goals[key(workspaceId, taskId)]);
      delete goals[key(workspaceId, taskId)];
      if (had) persist();
      return had;
    },
  };
}

module.exports = { goalMessage, roundTranscript, goalCheckPrompt, parseGoalCheck, closingAnswers, cleanObjective, createGoalStore };

"use strict";

// Chat goals, as Claude Code's /goal: a chat keeps working until a condition holds. Claude Code
// checks the condition each time the agent stops: a separate evaluator model reads the transcript
// and, when the condition is not met yet, the agent goes on with "Stop hook feedback:" naming the
// condition and why. Here a chat is a series of runs (Single model or a whole team, on any
// harness), so the goal lives with the chat: each round is one run, and when a run settles the
// evaluator judges it from the round's message and the closing cards' answers.

const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const OBJECTIVE_LIMIT = 2000;
const STATUSES = new Set(["active", "paused", "achieved", "stalled", "limited"]);
// How much of a round the evaluator reads, the end kept: an agent's conclusion comes last.
const TRANSCRIPT_LIMIT = 24_000;
// A team round's other cards (workers, reviewers) are the evidence the closing card summarises;
// each is cut to its end so one long worker cannot crowd out the rest.
const EVIDENCE_LIMIT = 3_000;
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

/**
 * What a settled round showed: the message it was sent, then its answers. An answer is a string (a
 * closing card's final answer) or { label, text } (a team card's evidence, named by its card). The
 * closing answers come last, so the cut, which keeps the end, keeps them.
 */
function roundTranscript(message, answers) {
  const parts = [`User:\n${String(message || "").trim() || "(no message)"}`];
  const said = (answers ?? []).map((answer) => (typeof answer === "string" ? { label: "", text: answer } : answer))
    .filter((answer) => typeof answer?.text === "string" && answer.text.trim());
  parts.push(said.length
    ? said.map(({ label, text }) => `${label ? `Assistant (${label})` : "Assistant"}:\n${text.trim()}`).join("\n\n")
    : "Assistant:\n(no final answer)");
  const text = parts.join("\n\n");
  return text.length > TRANSCRIPT_LIMIT ? `…${text.slice(-TRANSCRIPT_LIMIT)}` : text;
}

/**
 * The evaluator's instructions: judge the condition from the transcript alone, as JSON. With
 * `judge` (the person's "Let the model judge" setting) nobody else will look at the goal: the
 * evaluator also hears how the round ended (`ended`: it waited on the person, or failed), and may end
 * the goal itself ("stop") where going on is unsafe or pointless, so the goal never waits on the
 * person and never runs on regardless.
 */
function goalCheckPrompt(objective, transcript, { judge = false, ended = "" } = {}) {
  return [
    "You evaluate whether a stop condition set for an AI coding agent is satisfied, judging only from the transcript of its latest turn below.",
    "",
    `Condition: ${objective}`,
    ...(ended ? ["", `How the turn ended: ${ended}`] : []),
    "",
    "Rules:",
    "- The condition is satisfied only when the transcript shows evidence that it holds now: the work done, checked, and its result reported.",
    "- Claims without evidence, plans, partial progress, waiting on someone or something, or work left for later are not satisfied.",
    "- A condition that describes an ongoing aim rather than an end state is not satisfied by progress alone.",
    "- If the transcript does not show enough to decide, it is not satisfied.",
    ...(judge ? [
      "- The user is away and has asked you to judge for them: nobody will answer the agent's questions or approvals. When not met, write the reason as the agent's next instruction; if the turn waited on the user, tell the agent to choose the safest reasonable option itself and carry on.",
      "- Set \"stop\" to true to end the goal instead when going on would be unsafe or destructive, the condition cannot be reached, or the same blocker has repeated across turns with no progress. Do not stop merely because the work is hard, slow or unfinished.",
    ] : []),
    "",
    judge
      ? 'Answer with JSON only: {"met": true|false, "stop": true|false, "reason": "<one short paragraph: what the transcript shows, and what is still missing when not met, or why the goal must end when stopping>"}'
      : 'Answer with JSON only: {"met": true|false, "reason": "<one short paragraph: what the transcript shows, and what is still missing when not met>"}',
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/** The evaluator's answer as { met, stop, reason }; anything unreadable throws. A met goal is never stopped. */
function parseGoalCheck(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The goal evaluator gave no verdict");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed?.met !== "boolean") throw new Error("The goal evaluator gave no verdict");
  const reason = String(parsed.reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_LIMIT);
  const stop = !parsed.met && parsed.stop === true;
  return { met: parsed.met, stop, reason: reason || (parsed.met ? "The condition is met." : stop ? "The goal cannot go on." : "The condition is not met yet.") };
}

/**
 * The answers of a settled run's closing cards: cards no other card waits on. The retry sidecar and
 * a Command approver aside: nothing waits on an approver either, but its answers are verdicts on
 * commands, not the work.
 */
function closingAnswers(mission) {
  const nodes = (mission?.nodes ?? []).filter(node => node.role !== "retry" && node.role !== "approver");
  const parents = new Set(nodes.flatMap(node => node.parents ?? []));
  const closing = nodes.filter(node => !parents.has(node.id));
  const planner = nodes.find(node => node.role === "planner");
  // An orchestrator that answered alone ("solo") closes the mission itself.
  if (mission?.solo && planner) closing.push(planner);
  return closing.map(node => node.receipt?.answer).filter(answer => typeof answer === "string" && answer.trim());
}

/**
 * Everything a settled round answered, for the evaluator: in a team, the other cards' answers first
 * (each cut to its end, named by its card), then the closing answers in full. The closing card only
 * summarises; judged from it alone, a team's goal was seldom shown to hold and went on round after
 * round. A Single round has one card, so this is its answer.
 */
function roundAnswers(mission) {
  const closing = closingAnswers(mission);
  const nodes = (mission?.nodes ?? []).filter(node => node.role !== "retry" && node.role !== "approver");
  if (nodes.length <= 1) return closing;
  const evidence = nodes.map(node => ({ node, answer: node.receipt?.answer }))
    .filter(({ answer }) => typeof answer === "string" && answer.trim() && !closing.includes(answer))
    .map(({ node, answer }) => ({
      label: String(node.title || node.role || node.id || "card").replace(/\s+/g, " ").trim().slice(0, 80),
      text: answer.length > EVIDENCE_LIMIT ? `…${answer.slice(-EVIDENCE_LIMIT)}` : answer,
    }));
  return [...evidence, ...closing];
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
    let text = null;
    try { text = fs.readFileSync(file, "utf8"); } catch { /* No goals saved yet. */ }
    try {
      const saved = text === null ? null : JSON.parse(text);
      if (saved && typeof saved === "object" && !Array.isArray(saved)) goals = saved;
    } catch {
      // A file a crash tore (its size in NUL bytes, seen 2026-10-23 on another state file) read as
      // "no goals", and the next save wrote over it: every goal was gone after the restart. It is
      // kept beside the new file instead.
      try { fs.renameSync(file, `${file}.unreadable-${now()}`); } catch { /* the next save replaces it */ }
    }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  // Flushed to disk before it replaces the old file (durable), so a power cut leaves the old goals
  // or the new ones: a goal carries on after a restart only if its file survives it. The flush runs
  // off the main thread (synchronously it held every window up to 1.4 s on the hard disk), and a
  // burst of changes (a round ending) is one save plus at most one more with the latest goals.
  let saving = null;
  let saveAgain = false;
  const persist = () => {
    if (!file) return;
    if (saving) { saveAgain = true; return; }
    saving = writePrivateFileAtomicAsync(file, JSON.stringify(goals, null, 2), { durable: true, protectDirectory: false })
      .catch(() => { /* the old file stays; the next change saves every goal again */ })
      .finally(() => {
        saving = null;
        if (saveAgain) { saveAgain = false; persist(); }
      });
  };
  return {
    /** Resolves once every change so far is on disk (tests, and a caller about to exit). */
    async saved() { while (saving) await saving; },
    get: (workspaceId, taskId) => goals[key(workspaceId, taskId)] ?? null,
    /** Every goal of one project, by chat. */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(goals).filter(([name]) => name.startsWith(prefix)).map(([name, goal]) => [name.slice(prefix.length), goal]));
    },
    set(workspaceId, taskId, objective, { rounds = 0 } = {}) {
      const at = now();
      const limit = Number.isInteger(rounds) && rounds > 0 ? rounds : 0;
      const goal = { objective: cleanObjective(objective), status: "active", round: 0, rounds: limit,
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
    /** A chat that moved to another project (move_chat) keeps its goal there. */
    move(from, to, taskId) {
      const goal = goals[key(from, taskId)];
      if (!goal) return false;
      delete goals[key(from, taskId)];
      goals[key(to, taskId)] = goal;
      persist();
      return true;
    },
    clear(workspaceId, taskId) {
      const had = Boolean(goals[key(workspaceId, taskId)]);
      delete goals[key(workspaceId, taskId)];
      if (had) persist();
      return had;
    },
  };
}

module.exports = { goalMessage, roundTranscript, goalCheckPrompt, parseGoalCheck, closingAnswers, roundAnswers, cleanObjective, createGoalStore };

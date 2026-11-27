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
// A goal's condition and each round's message, in UTF-8 bytes: 2,000 characters of Chinese or emoji
// passed the character limit at up to 8 KB and every round failed to send. GOAL_MESSAGE_BYTES is the
// chat's message budget (agent-orchestrator-workflow.cjs CHAT_MESSAGE_BYTES, checked by a test).
const OBJECTIVE_BYTES = 6000;
const GOAL_MESSAGE_BYTES = 8192 - 256;
const utf8Bytes = (text) => Buffer.byteLength(text, "utf8");
/** The start of a text within a UTF-8 byte budget, never splitting a character. */
function utf8Head(text, bytes) {
  if (utf8Bytes(text) <= bytes) return text;
  let used = 0, end = "";
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > Math.max(0, bytes - 3)) break;
    used += size;
    end += char;
  }
  return `${end}…`;
}
const STATUSES = new Set(["active", "paused", "achieved", "stalled", "limited"]);
// How much of a round the evaluator reads, the end kept: an agent's conclusion comes last.
const TRANSCRIPT_LIMIT = 24_000;
// A team round's other cards (workers, reviewers) are the evidence the closing card summarises;
// each is cut to its end so one long worker cannot crowd out the rest.
const EVIDENCE_LIMIT = 3_000;
const REASON_LIMIT = 1_500;
/**
 * What every goal round tells the agent besides the condition: where its turn ends. Sent as the
 * condition alone, an agent stopped partway as it would after any request (a summary of the first
 * fixes, "want me to go on?", a list of next steps), and called the goal done on an easier task
 * than the one set: a unit test for "working live", one account of several (seen in the saved
 * goals, 2026-11-24). The chat hides this block under the person's message (ao-chat.ts
 * GOAL_RULES_TAIL), so it starts with a line the person never types.
 */
const GOAL_RULES_HEAD = "Goal rules (sent by Coding Tools with every round of this goal):";
const GOAL_RULES = [
  GOAL_RULES_HEAD,
  "- This chat keeps going until the condition holds: after each turn a separate evaluator checks it against what you report.",
  "- Keep working in this turn until it holds and you have checked it yourself. Do not stop to summarise, to ask whether to go on, or to list next steps: do them.",
  "- Stay inside the condition as written. Do not swap in an easier or different task, and do not call it done on a plan, a partial fix or an unchecked change.",
  "- If only the person can unblock a part (a sign-in, an approval, a decision), say exactly what is needed and keep working on every other part.",
  "- End the turn with what you did, how you checked it (the command or check and its result), and what is still left, if anything.",
].join("\n");
// Later rounds carry the same rules in half the bytes: each round's message stays in the chat's
// record, and a goal can run hundreds of rounds (1,339 in one saved goal). Still whole on its own,
// for an agent that compacted or restarted since the first round.
const GOAL_RULES_AGAIN = [
  GOAL_RULES_HEAD,
  "- Keep working in this turn until the condition holds and you have checked it; do not stop to summarise, ask whether to go on, or list next steps.",
  "- Stay inside the condition as written; if only the person can unblock a part, say exactly what and keep working on the rest.",
  "- End with what you did, how you checked it and the result, and what is left.",
].join("\n");
const GOAL_RULES_SEPARATOR = "\n\n";
/** A round's message without its goal rules: what the person (or the evaluator) reads. */
function withoutGoalRules(message) {
  const text = String(message ?? "");
  const at = text.lastIndexOf(GOAL_RULES_SEPARATOR + GOAL_RULES_HEAD + "\n");
  return at < 0 ? text : text.slice(0, at);
}
/**
 * The message a goal round sends. The first round sends the condition itself, as the person set
 * it; every later one is Claude Code's stop-hook feedback: the condition in brackets and the
 * evaluator's reason it is not met yet. Both end with the goal's rules (GOAL_RULES).
 */
function goalMessage(objective, round, reason = "") {
  const rules = GOAL_RULES_SEPARATOR + (round <= 1 ? GOAL_RULES : GOAL_RULES_AGAIN);
  // A round's message is a chat message: within the chat's byte budget, or the round could not be
  // sent and the goal stalled. The rules always go; the evaluator's reason gives way first, then
  // the condition's end.
  const budget = GOAL_MESSAGE_BYTES - utf8Bytes(rules);
  if (round <= 1) return utf8Head(objective, budget) + rules;
  const why = String(reason || "").trim() || "The condition is not met yet; continue from where the last round left off.";
  const frame = (goal, said) => `Stop hook feedback:\n[${goal}]: ${said}`;
  const whole = frame(objective, why);
  if (utf8Bytes(whole) <= budget) return whole + rules;
  const goal = utf8Head(objective, budget - utf8Bytes(frame("", "")) - 400);
  return frame(goal, utf8Head(why, budget - utf8Bytes(frame(goal, "")))) + rules;
}

/**
 * What a settled round showed: the message it was sent, then its answers. An answer is a string (a
 * closing card's final answer) or { label, text } (a team card's evidence, named by its card). The
 * closing answers come last, so the cut, which keeps the end, keeps them.
 */
function roundTranscript(message, answers) {
  // The goal's rules are the app's, the same every round, and the evaluator has the condition itself.
  const input = `User:\n${utf8Head(withoutGoalRules(message).trim() || "(no message)", GOAL_MESSAGE_BYTES)}\n\n`;
  const said = (answers ?? []).map((answer) => (typeof answer === "string" ? { label: "", text: answer } : answer))
    .filter((answer) => typeof answer?.text === "string" && answer.text.trim());
  const evidence = said.length
    ? said.map(({ label, text }) => `${label ? `Assistant (${label})` : "Assistant"}:\n${text.trim()}`).join("\n\n")
    : "Assistant:\n(no final answer)";
  const room = TRANSCRIPT_LIMIT - input.length;
  if (evidence.length <= room) return input + evidence;
  const boundary = evidence.length - room + "Earlier assistant evidence omitted.\n…".length;
  const start = /[\uDC00-\uDFFF]/.test(evidence[boundary]) ? boundary + 1 : boundary;
  return `${input}Earlier assistant evidence omitted.\n…${evidence.slice(start)}`;
}

/**
 * The evaluator's instructions: judge the condition from the transcript alone, as JSON. With
 * `judge` (the person's "Let the model judge" setting) nobody else will look at the goal: the
 * evaluator also hears how the round ended (`ended`: it waited on the person, or failed), and may end
 * the goal itself ("stop") where going on is unsafe or pointless, so the goal never waits on the
 * person and never runs on regardless.
 *
 * Every verdict also says whether the turn made progress, judged against the previous turn's verdict
 * (`previous`): the goal stalls after rounds in a row without any. Without it, an agent blocked on
 * something only the person can change ran round after round (480 rounds over 14 days, seen live
 * 2026-11-08), each one a full turn that only reported the same blocker.
 */
function goalCheckPrompt(objective, transcript, { judge = false, ended = "", previous = "" } = {}) {
  return [
    "You evaluate whether a stop condition set for an AI coding agent is satisfied, judging only from the transcript of its latest turn below.",
    "",
    `Condition: ${objective}`,
    ...(ended ? ["", `How the turn ended: ${ended}`] : []),
    ...(previous ? ["", `The previous turn's verdict: ${previous}`] : []),
    "",
    "Rules:",
    "- The condition is satisfied only when the transcript shows evidence that it holds now: the work done, checked, and its result reported.",
    "- Claims without evidence, plans, partial progress, waiting on someone or something, or work left for later are not satisfied.",
    "- Every part of the condition must hold. When it names several things (several fixes, accounts, features or checks), each needs its own evidence; some of them done is not the condition met.",
    "- Judge the condition as written, not as the agent restated it. A narrower, easier or different task does not satisfy it: a unit test where the condition asks for it working live, a workaround where it asks for a fix, one case where it asks for all.",
    "- The agent's own report counts as evidence only where it names what was run or checked and the result (a command and its output, test counts, what a live check showed). \"Implemented\", \"should work\", \"ready to test\" or \"likely fixed\" are claims, not evidence.",
    "- If the turn's final answer lists remaining work, next steps, unverified items or open problems for the condition, or the turn stopped partway (for example to ask whether to go on), it is not satisfied.",
    "- A condition that describes an ongoing aim rather than an end state is not satisfied by progress alone.",
    "- If the transcript does not show enough to decide, it is not satisfied.",
    "- When not satisfied, the reason is sent to the agent as its next instruction: name the parts still missing, most important first, and what would show that each holds.",
    "- Also say whether this turn made progress. \"progress\" is false when the agent did no new work toward the condition: it only restated the condition, a plan or an earlier report, or it stayed blocked on something it cannot change itself (a refused approval, an account or service that is unavailable, a decision only the user can make) without working around it. New work toward the condition, or clearing a blocker, is progress.",
    ...(previous ? ["- A turn that reports the same blocker or the same missing work as the previous verdict, with nothing new done, made no progress."] : []),
    ...(judge ? [
      "- The user is away and has asked you to judge for them: nobody will answer the agent's questions or approvals. When not met, write the reason as the agent's next instruction; if the turn waited on the user, tell the agent to choose the safest reasonable option itself and carry on.",
      "- Set \"stop\" to true to end the goal instead when going on would be unsafe or destructive, the condition cannot be reached, or the same blocker has repeated across turns with no progress. Do not stop merely because the work is hard, slow or unfinished.",
    ] : []),
    "",
    judge
      ? 'Answer with JSON only: {"met": true|false, "progress": true|false, "stop": true|false, "reason": "<one short paragraph: what the transcript shows, and what is still missing when not met, or why the goal must end when stopping>"}'
      : 'Answer with JSON only: {"met": true|false, "progress": true|false, "reason": "<one short paragraph: what the transcript shows, and what is still missing and how to show it when not met>"}',
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/**
 * The evaluator's answer as { met, stop, progress, reason }. An unmet goal can go on only with an
 * explicit progress verdict; an incomplete check follows the evaluator failure path.
 */
function parseGoalCheck(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The goal evaluator gave no verdict");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed?.met !== "boolean") throw new Error("The goal evaluator gave no verdict");
  const reason = String(parsed.reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_LIMIT);
  const stop = !parsed.met && parsed.stop === true;
  if (!parsed.met && !stop && typeof parsed.progress !== "boolean") throw new Error("The goal evaluator gave no progress verdict");
  const progress = parsed.met || parsed.progress === true;
  return { met: parsed.met, stop, progress, reason: reason || (parsed.met ? "The condition is met." : stop ? "The goal cannot go on." : "The condition is not met yet.") };
}

/**
 * The headings and labels an agent's final answer puts over work it has not done ("## What's left",
 * "### Still incomplete", "**Still open:**", "## 还剩什么"). Matched at the start of the label, so
 * "What's left (not a code bug)" counts.
 */
const LEFT_LABELS = [
  "what's left", "what is left", "what's still left", "what remains", "what still needs", "still left", "still open",
  "still incomplete", "still missing", "still pending", "still to do", "still unverified", "still not done", "still blocked",
  "not done yet", "not yet done", "remaining work", "remaining items", "remaining steps", "remaining tasks", "remaining issues",
  "remaining gaps", "remaining problems", "left to do", "next steps", "next step", "open items", "open issues", "open problems",
  "open questions", "outstanding work", "outstanding items", "outstanding issues", "unfinished",
  "还剩", "剩下", "剩余", "待办", "未完成", "尚未完成", "下一步", "后续", "遗留", "仍未", "还没",
  "還剩", "剩餘", "待辦", "尚未", "後續", "遺留", "還沒",
];
// Words that name left work only as the whole label: "Remaining:" but not "Remaining budget: 40%",
// "To do:" but not "To do this, I ran …:".
const LEFT_LABELS_EXACT = new Set(["remaining", "outstanding", "to do", "todo", "unverified", "left", "pending"]);
// A section that says nothing is left: "Nothing.", "None — the condition holds.", "无".
const NOTHING_LEFT = /^(?:none|nothing|n\/a|no (?:remaining|open|outstanding)|无|無|没有|沒有|暂无|暫無)(?![a-z])/i;
const plainLabel = (text) => text.toLowerCase().replace(/[’`]/g, "'").replace(/[*_]/g, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const isLeftLabel = (text) => {
  const label = plainLabel(text);
  return LEFT_LABELS.some((left) => label.startsWith(left)) || LEFT_LABELS_EXACT.has(label.replace(/[\s:：.]+$/, ""));
};
/**
 * The work an agent's final answer says is still left, or "" when it names none: the body of its
 * first "what's left" heading (to the next heading) or label (to the paragraph's end). A goal is not
 * met while the agent itself says so: a quick evaluator called a goal met over an answer whose
 * "## What's left" named the upgrades that still did not run and the raid that did no damage (seen
 * in the saved goals, 2026-11-25), and the goal ended with the agent half way.
 */
function workLeft(answer) {
  const lines = String(answer ?? "").split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(lines[at]);
    const label = heading ? null : /^\s*(?:[-*]\s+)?(?:\*\*|__)?([^*_:：\n]{2,48}?)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?(.*)$/.exec(lines[at]);
    const title = heading?.[1] ?? label?.[1];
    if (!title || !isLeftLabel(title)) continue;
    const body = label?.[2] ? [label[2]] : [];
    for (let next = at + 1; next < lines.length; next += 1) {
      if (/^\s{0,3}#{1,6}\s/.test(lines[next]) || (!heading && !lines[next].trim())) break;
      body.push(lines[next]);
    }
    // Markdown emphasis goes, identifiers keep their underscores (town_hall).
    const text = body.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim()).filter(Boolean)
      .reduce((said, line) => !said ? line : `${said}${/[.!?。！？；;]$/.test(said) ? " " : "; "}${line}`, "");
    if (text && !NOTHING_LEFT.test(text)) return utf8Head(text.replace(/\s+/g, " "), 600);
  }
  return "";
}
/**
 * A "met" verdict over a round whose own final answer (`answers`, its closing cards' answers) still
 * lists work left is not met: the agent is told to do that work, or to say plainly that an item is
 * outside the condition rather than list it as left. Any other verdict stands.
 */
function holdOpenWork(check, answers) {
  if (!check?.met) return check;
  const left = (answers ?? []).map((answer) => workLeft(typeof answer === "string" ? answer : answer?.text)).find(Boolean);
  if (!left) return check;
  const reason = `Not met yet: your own final answer still lists work left (${left}). Do that work in this round and check it; `
    + "if an item is really outside the condition, say so in your answer instead of listing it as left.";
  return { met: false, stop: false, progress: true, reason: reason.slice(0, REASON_LIMIT), workLeft: left };
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
  if (utf8Bytes(text) > OBJECTIVE_BYTES) throw new Error(`A goal can be at most ${OBJECTIVE_BYTES.toLocaleString("en-US")} bytes; this one is ${utf8Bytes(text).toLocaleString("en-US")}. Shorten it`);
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
    /** The projects with a goal still being pursued. */
    activeWorkspaces: () => [...new Set(Object.entries(goals)
      .filter(([, goal]) => goal?.status === "active")
      .map(([name]) => name.slice(0, name.indexOf(":"))))],
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

module.exports = { goalMessage, withoutGoalRules, roundTranscript, goalCheckPrompt, parseGoalCheck, workLeft, holdOpenWork, closingAnswers, roundAnswers, cleanObjective, createGoalStore, GOAL_MESSAGE_BYTES, GOAL_RULES, GOAL_RULES_AGAIN };

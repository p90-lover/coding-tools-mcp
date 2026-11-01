import { dshActivity, dshToolName, goalFeedback, type ChatLiveItem, type ChatStep, type ChatTurn, type DshActivity } from "./ao-chat";

/**
 * A reply read as a plan: the steps the agent took, how each ended, and where a goal's new round
 * or a retried attempt starts. The chat showed a turn only as a stream of tool rows: a 52-round
 * goal was 52 "Stop hook feedback" lines, and "Attempt 1 failed" sat under the work it replaced.
 * The chat styles (ChatReplyPlan) draw this one model as Claude Code, Codex, Copilot and others do.
 */

/** How the chat draws a reply. `transcript` is the chat as it was (Claude Code's rows). */
export type ChatStyle = "transcript" | "plan" | "timeline" | "focus" | "cascade";
export const CHAT_STYLE_KEY = "coding-tools:ao:chat-style";
export const CHAT_STYLES: { id: ChatStyle; label: string; hint: string }[] = [
  { id: "transcript", label: "Transcript", hint: "Claude Code: every step and tool call in order" },
  { id: "plan", label: "Plan card", hint: "Codex and Cursor: a checklist of steps above the work" },
  { id: "timeline", label: "Step timeline", hint: "GitHub Copilot: one row per step with how it ended" },
  { id: "focus", label: "Focus", hint: "ChatGPT: the answer, a progress line, and work behind Show work" },
  { id: "cascade", label: "Cascade", hint: "Windsurf: each step with chips for what it did" },
];
export function chatStyle(value: unknown): ChatStyle {
  return CHAT_STYLES.some((style) => style.id === value) ? value as ChatStyle : "transcript";
}

export type PlanStepState = "done" | "running" | "pending" | "failed";
export type PlanAction = { activity: DshActivity; count: number; words: string };
export type PlanStep = {
  key: string;
  title: string;
  state: PlanStepState;
  /** What the step did, by kind, busiest first ("3 commands", "2 edits"). */
  actions: PlanAction[];
  /** How the step ended, in a line: its tools' summary, or why it failed. */
  finish?: string;
};
/** `agent`: the agent's own todo list (TodoWrite, update_plan); `work`: steps read from its messages and tool calls. */
export type ReplyPlan = { source: "agent" | "work"; steps: PlanStep[]; done: number };

const WORK_KINDS = new Set(["tool", "command", "edit"]);
const TITLE_MAX = 96;
const ACTION_WORDS: Record<DshActivity, [string, string]> = {
  read: ["read", "reads"], readImage: ["image", "images"], search: ["search", "searches"], write: ["file written", "files written"],
  edit: ["edit", "edits"], commands: ["command", "commands"], code: ["code run", "code runs"], webSearch: ["web search", "web searches"],
  webFetch: ["page", "pages"], subagents: ["subagent", "subagents"], plan: ["plan update", "plan updates"],
  questions: ["question", "questions"], tools: ["tool call", "tool calls"],
};

/** A message's first line as a step title: markdown marks dropped, cut at a word. */
export function stepTitle(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.replace(/^[#>*\-\s]+|[*_`]+/g, "").trim()).find(Boolean) ?? "";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), TITLE_MAX * 0.6)).trimEnd()}…`;
}

export function stepActions(items: ChatLiveItem[]): PlanAction[] {
  const counts = new Map<DshActivity, number>();
  for (const item of items) if (WORK_KINDS.has(item.kind)) counts.set(dshActivity(item), (counts.get(dshActivity(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])
    .map(([activity, count]) => ({ activity, count, words: `${count} ${ACTION_WORDS[activity][count === 1 ? 0 : 1]}` }));
}

const failedItem = (item: ChatLiveItem) => /^(failed|error|errored)$/i.test(item.status);
const runningItem = (item: ChatLiveItem) => /^(running|pending|in_progress)$/i.test(item.status);

/** The agent's newest todo list, from a TodoWrite (`todos`) or update_plan (`plan`) call's input. */
export function agentPlan(items: ChatLiveItem[]): { title: string; status: string }[] | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!WORK_KINDS.has(item.kind) || !["todo_write", "todowrite", "update_plan"].includes(dshToolName(item)) || !item.input) continue;
    let input: unknown;
    try { input = JSON.parse(item.input); } catch { continue; }
    const record = input as { todos?: unknown; plan?: unknown };
    const list = Array.isArray(record?.todos) ? record.todos : Array.isArray(record?.plan) ? record.plan : null;
    if (!list) continue;
    const todos = list.flatMap((entry) => {
      const todo = entry as { content?: unknown; step?: unknown; activeForm?: unknown; status?: unknown };
      const title = typeof todo?.content === "string" ? todo.content : typeof todo?.step === "string" ? todo.step : "";
      return title.trim() ? [{ title: stepTitle(title), status: typeof todo.status === "string" ? todo.status : "pending" }] : [];
    });
    if (todos.length) return todos;
  }
  return null;
}

/**
 * A turn's work as steps. The agent's own todo list wins when it kept one. Otherwise each message
 * the agent wrote between tool calls opens a step, titled by its first line, and the tool calls
 * after it are that step's work; tool calls before any message are one step named by what they
 * did. Every step but the newest is done; the newest runs while the turn is `live`, and fails with
 * `error` when the turn ended on one.
 */
export function replyPlan(items: ChatLiveItem[], live: boolean, error?: string): ReplyPlan {
  const todos = agentPlan(items);
  if (todos) {
    const steps = todos.map((todo, index): PlanStep => ({
      key: `todo:${index}`, title: todo.title, actions: [],
      state: /^(completed|done)$/i.test(todo.status) ? "done" : /^in_progress$/i.test(todo.status) ? (live ? "running" : error ? "failed" : "pending") : "pending",
    }));
    return { source: "agent", steps, done: steps.filter((step) => step.state === "done").length };
  }
  const groups: { key: string; message?: string; items: ChatLiveItem[] }[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.text.trim()) groups.push({ key: item.id, message: item.text, items: [] });
    else if (WORK_KINDS.has(item.kind)) {
      if (!groups.length) groups.push({ key: `lead:${item.id}`, items: [] });
      groups[groups.length - 1].items.push(item);
    }
  }
  // The answer is the turn's last message with nothing after it: the reply, not a step.
  const last = groups[groups.length - 1];
  if (last?.message && !last.items.length && !live) groups.pop();
  const steps = groups.map((group, index): PlanStep => {
    const actions = stepActions(group.items);
    const newest = index === groups.length - 1;
    const state: PlanStepState = newest && live ? "running" : newest && error ? "failed" : "done";
    const failures = group.items.filter(failedItem).length;
    const running = group.items.some(runningItem);
    const summary = actions.map((action) => action.words).join(", ");
    return {
      key: group.key, actions, state,
      title: group.message ? stepTitle(group.message) : summary ? summary.charAt(0).toUpperCase() + summary.slice(1) : "Working",
      finish: state === "failed" ? error : state === "running" ? (running ? "Running…" : undefined)
        // A step named by its tools says only what failed: the title already is the summary.
        : [group.message ? summary : "", failures ? `${failures} failed` : ""].filter(Boolean).join(" · ") || undefined,
    };
  });
  return { source: "work", steps, done: steps.filter((step) => step.state === "done").length };
}

/**
 * A goal's round, for a turn whose message is the goal's feedback (goalFeedback): its number,
 * counted from the round the person's own message started, and the evaluator's reason.
 */
export function goalRound(turns: Pick<ChatTurn, "user">[], index: number): { round: number; reason: string } | null {
  const feedback = turns[index]?.user ? goalFeedback(turns[index].user!.text) : null;
  if (!feedback) return null;
  let round = 2;
  for (let back = index - 1; back >= 0 && turns[back].user && goalFeedback(turns[back].user!.text); back -= 1) round += 1;
  return { round, reason: feedback.reason };
}

/**
 * Goal rounds folded under one row: for each run of rounds longer than `keep`, the turn indexes
 * that fold (all but the newest `keep` rounds), keyed by the turn that opens the run (the person's
 * message, round 1, stays shown).
 */
export function foldedRounds(turns: Pick<ChatTurn, "key" | "user">[], keep = 2): Map<string, number[]> {
  const folds = new Map<string, number[]>();
  for (let index = 0; index < turns.length; index += 1) {
    if (!goalRound(turns, index) || (index > 0 && goalRound(turns, index - 1))) continue;
    let end = index;
    while (end + 1 < turns.length && goalRound(turns, end + 1)) end += 1;
    const hidden = end - index + 1 - keep;
    if (hidden > 0) folds.set(turns[index].key, Array.from({ length: hidden }, (_, offset) => index + offset));
    index = end;
  }
  return folds;
}

/** A card's attempt now (1 for a first run): one more than the earlier attempts it keeps. */
export function stepAttempt(step: Pick<ChatStep, "earlier"> | undefined): number {
  return 1 + (step?.earlier ?? []).filter((round) => /^Attempt \d+/.test(round.label)).length;
}

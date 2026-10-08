// Pure model for the chat-first Mission tab: no React, so it can be tested on its own.
//
// One chat is one board task. Each message the user sent is one run on that task: the first
// message is the task description, and every later one is appended to it by chat_send as
// "\n\nFollow-up (<stamp> UTC):\n<text>". A run's cards (planner, workers, reviewer) become the
// replies; the backend only keeps each card's final answer, so a card still working shows as a
// status line rather than streamed text.

export type ChatNode = {
  id: string;
  role: "planner" | "approver" | "worker" | "review_split" | "sub_reviewer" | "reviewer" | "retry";
  state: string;
  x: number;
  settings?: { name?: string; role_name?: string };
  route?: { harness_id: string; model: string; effort?: string; context_window?: number };
  receipt?: { answer?: string; error?: string; verdict?: string; started_at_ms?: number };
};

/** What a working card is doing now (the workflow's "activity" operation). */
export type ChatActivity = {
  activity?: string;
  output?: string;
  error?: string;
  started_at_ms?: number | null;
  activity_at_ms?: number | null;
  last_event_at_ms?: number | null;
  turn_started?: boolean;
};

export type ChatOptions = {
  /** One line per card: harness · model · effort · context · role. */
  describe?: (node: ChatNode) => string;
  /** Live activity by "<run id>:<card id>". */
  activity?: Record<string, ChatActivity>;
  now?: number;
};

/** A working card that has not been heard from for this long is shown as possibly stuck. */
export const STALL_MS = 10 * 60_000;

/** 42_000 -> "42s"; 185_000 -> "3m"; 10_680_000 -> "2h 58m". */
export function chatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/**
 * The status detail for a working card: how it runs, how long it has been running, its current
 * step and when it was last heard. Stalled when nothing has been heard for STALL_MS, or the turn
 * has still not started after that long.
 */
export function chatWorkingDetail(node: ChatNode, live: ChatActivity | undefined, now: number, describe?: (node: ChatNode) => string): { detail: string; stalled: boolean } {
  const started = live?.started_at_ms ?? node.receipt?.started_at_ms ?? null;
  const heard = live?.last_event_at_ms || live?.activity_at_ms || null;
  const parts = [describe?.(node) ?? ""];
  if (started) parts.push(`running ${chatDuration(now - started)}`);
  if (live?.activity) parts.push(heard ? `${live.activity} (last heard ${chatDuration(now - heard)} ago)` : live.activity);
  const quietSince = heard ?? started;
  const stalled = Boolean(quietSince && now - quietSince >= STALL_MS && (heard || live?.turn_started === false));
  return { detail: parts.filter(Boolean).join(" · "), stalled };
}

export type ChatRun = {
  id: string;
  project_id: string;
  cancelled: boolean;
  paused?: boolean;
  /** The orchestrator judged the mission simple and answered it alone; no other card ran. */
  solo?: boolean;
  nodes: ChatNode[];
};

export type ChatStatus = "queued" | "running" | "paused" | "attention" | "stopped" | "done";

export type ChatSummary = {
  taskId: string;
  title: string;
  runIds: string[];
  latestRunId: string;
  status: ChatStatus;
};

export type ChatMessage =
  | { kind: "user"; key: string; text: string; stamp?: string }
  | { kind: "agent"; key: string; role: ChatNode["role"]; name: string; text: string; tone: "answer" | "error" | "verdict"; verdict?: string; detail?: string }
  | { kind: "status"; key: string; text: string; state: string; detail?: string; stalled?: boolean };

export const CHAT_DEFAULT_TITLE = "New task";

const FOLLOW_UP = /\n\nFollow-up \(([^)]+) UTC\):\n/;
const SETTLED = ["finished", "cancelled", "archived"];

/** The user's messages in a chat, oldest first: the task description plus each follow-up. */
export function chatMessagesFromDescription(description: string | undefined): { text: string; stamp?: string }[] {
  const parts = (description ?? "").split(FOLLOW_UP);
  const messages: { text: string; stamp?: string }[] = [];
  if (parts[0]?.trim()) messages.push({ text: parts[0].trim() });
  for (let index = 1; index < parts.length; index += 2) {
    messages.push({ stamp: parts[index], text: (parts[index + 1] ?? "").trim() });
  }
  return messages;
}

export function chatRunStatus(run: ChatRun): ChatStatus {
  if (run.cancelled) return "stopped";
  if (run.paused) return "paused";
  const states = run.nodes.filter(node => node.role !== "retry" || node.state !== "pending").map((node) => node.state);
  if (states.includes("held")) return "attention";
  if (states.length && states.every((state) => SETTLED.includes(state))) return "done";
  if (states.some((state) => state === "running" || state === "reserved")) return "running";
  if (states.includes("failed")) return "attention";
  return "queued";
}

/**
 * Whether a chat takes a new message. A run that is really working blocks it; a stuck one (a start
 * that never got going, a held card, a pause) does not: sending stops it and starts a new run.
 */
export function chatAcceptsMessage(status: ChatStatus | undefined, working = false): boolean {
  return status !== "running" && !working;
}

/** A run that has not settled yet and can still be stopped. */
export function chatRunOpen(status: ChatStatus | undefined): boolean {
  return status === "queued" || status === "running" || status === "paused" || status === "attention";
}

/** Chats in a workspace, most recently started first. Runs arrive oldest first. */
export function chatList(runs: ChatRun[], tasks: { id: string; title: string }[]): ChatSummary[] {
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const byTask = new Map<string, { runs: ChatRun[]; lastIndex: number }>();
  runs.forEach((run, index) => {
    const entry = byTask.get(run.project_id) ?? { runs: [], lastIndex: index };
    entry.runs.push(run);
    entry.lastIndex = index;
    byTask.set(run.project_id, entry);
  });
  return [...byTask.entries()]
    .sort((a, b) => b[1].lastIndex - a[1].lastIndex)
    .map(([taskId, entry]) => {
      const latest = entry.runs[entry.runs.length - 1];
      return {
        taskId,
        title: titles.get(taskId) || CHAT_DEFAULT_TITLE,
        runIds: entry.runs.map((run) => run.id),
        latestRunId: latest.id,
        status: chatRunStatus(latest),
      };
    });
}

// Pipeline order: plan, command check, work, review split, sub-reviews, final review.
const ROLE_ORDER: Record<ChatNode["role"], number> = { planner: 0, approver: 1, worker: 2, review_split: 3, sub_reviewer: 4, reviewer: 5, retry: 2.5 };
const ROLE_NAME: Record<ChatNode["role"], string> = {
  planner: "Orchestrator", approver: "Command approver", worker: "Worker",
  review_split: "Main reviewer · split", sub_reviewer: "Sub-reviewer", reviewer: "Main reviewer", retry: "Retry",
};

export function chatNodeName(node: ChatNode): string {
  return node.settings?.name?.trim() || ROLE_NAME[node.role];
}

/** Cards in reading order: orchestrator, then workers left to right, then the reviewer. */
export function chatNodeOrder(nodes: ChatNode[]): ChatNode[] {
  return [...nodes].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.x - b.x);
}

/**
 * The orchestrator's answer without the trailing solo marker block the engine reads, fenced
 * (```solo) or as the web bridge flattens it (a bare "solo" line, then the body in backticks).
 */
export function withoutSoloBlock(answer: string): string {
  const fenced = answer.lastIndexOf("```solo");
  const flattened = [...answer.matchAll(/(^|\n)[ \t]*solo[ \t]*\r?\n\s*[`{]/gi)].pop();
  const start = Math.max(fenced, flattened?.index !== undefined ? flattened.index + flattened[1].length : -1);
  return start < 0 ? answer : answer.slice(0, start).trimEnd();
}

/** The conversation for one chat: each user message followed by that run's replies. */
export function chatTranscript(runs: ChatRun[], description: string | undefined, options: ChatOptions = {}): ChatMessage[] {
  const said = chatMessagesFromDescription(description);
  const now = options.now ?? Date.now();
  const messages: ChatMessage[] = [];
  runs.forEach((run, index) => {
    const user = said[index];
    if (user) messages.push({ kind: "user", key: `${run.id}:user`, text: user.text, stamp: user.stamp });
    for (const node of chatNodeOrder(run.nodes)) {
      const name = chatNodeName(node);
      const key = `${run.id}:${node.id}`;
      const described = options.describe?.(node);
      const detail = described ? { detail: described } : {};
      if (node.receipt?.error) {
        messages.push({ kind: "agent", key, role: node.role, name, text: [node.receipt.error, node.receipt.answer ? `Partial work:\n${node.receipt.answer}` : ""].filter(Boolean).join("\n\n"), tone: "error", ...detail });
      } else if (node.state === "finished" && node.receipt?.answer) {
        messages.push({
          kind: "agent", key, role: node.role, name,
          text: run.solo && node.role === "planner" ? withoutSoloBlock(node.receipt.answer) : node.receipt.answer,
          tone: node.role === "reviewer" || node.role === "approver" || node.role === "sub_reviewer" ? "verdict" : "answer",
          ...(node.receipt.verdict ? { verdict: node.receipt.verdict } : {}),
          ...detail,
        });
      } else if (node.state === "running" || node.state === "reserved") {
        const working = chatWorkingDetail(node, options.activity?.[key], now, options.describe);
        messages.push({
          kind: "status", key, state: node.state, detail: working.detail, stalled: working.stalled,
          text: working.stalled ? `${name} may be stuck: nothing heard for a while. Stop or restart the mission if it does not recover.` : `${name} is working…`,
        });
      } else if (node.state === "held") {
        messages.push({ kind: "status", key, text: `${name} needs your attention`, state: node.state });
      }
    }
    if (run.solo) {
      messages.push({ kind: "status", key: `${run.id}:solo`, text: "Simple mission: the orchestrator answered alone; no workers ran.", state: "finished" });
    }
    if (run.cancelled) messages.push({ kind: "status", key: `${run.id}:stopped`, text: "Stopped", state: "cancelled" });
  });
  // A message just sent whose run is not visible yet.
  for (let index = runs.length; index < said.length; index += 1) {
    messages.push({ kind: "user", key: `pending:${index}`, text: said[index].text, stamp: said[index].stamp });
  }
  return messages;
}

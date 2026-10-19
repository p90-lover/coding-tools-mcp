// Pure model for the chat-first Mission tab: no React, so it can be tested on its own.
//
// One chat is one board task. Each message the user sent is one run on that task: the first
// message is the task description, and every later one is appended to it by chat_send as
// "\n\nFollow-up (<stamp> UTC):\n<text>". A run's cards (planner, workers, reviewer) become the
// replies; the backend only keeps each card's final answer. A card still working shows its live
// turn instead (the workflow's "activity" timeline: messages, reasoning and tool calls so far).

export type ChatNode = {
  id: string;
  role: "planner" | "approver" | "worker" | "review_split" | "sub_reviewer" | "reviewer" | "retry";
  state: string;
  x: number;
  settings?: { name?: string; role_name?: string };
  route?: { harness_id: string; model: string; effort?: string; context_window?: number };
  /** `thread_id` is the card's AO session id when its harness is an AO agent ("ao:…"). */
  receipt?: { answer?: string; error?: string; verdict?: string; started_at_ms?: number; thread_id?: string };
  /** Earlier attempts' receipts, oldest first (a retry moves the last receipt here). */
  history?: { answer?: string }[];
};

/** One AO agent session of a chat, for its Preview and Terminal panes. */
export type ChatAgentSession = { id: string; label: string; model?: string; contextWindow?: number };

/**
 * The chat's AO agent sessions, newest first, each once (a follow-up reuses its session): the cards
 * whose harness is an AO agent and that have started one. Native Codex threads are not AO sessions.
 */
export function chatAgentSessions(runs: { nodes: ChatNode[] }[]): ChatAgentSession[] {
  const seen = new Map<string, ChatAgentSession>();
  for (const run of [...runs].reverse()) {
    for (const node of [...run.nodes].reverse()) {
      const id = node.receipt?.thread_id;
      if (!id || seen.has(id) || !node.route?.harness_id?.startsWith("ao:")) continue;
      const name = node.settings?.name || node.settings?.role_name || node.role;
      // The window the card asked for is the one the agent runs with (Claude Code's
      // CLAUDE_CODE_MAX_CONTEXT_TOKENS), even when its usage report still names the model's default.
      const contextWindow = node.route.context_window;
      seen.set(id, { id, label: node.route.model ? `${name} · ${node.route.model}` : name, ...(node.route.model ? { model: node.route.model } : {}),
        ...(typeof contextWindow === "number" && contextWindow > 0 ? { contextWindow } : {}) });
    }
  }
  // The same agent in several sessions (a follow-up that started a fresh one): the newest is the
  // current one, the others are told apart by how far back they are.
  const sessions = [...seen.values()];
  const repeats = new Map<string, number>();
  for (const session of sessions) repeats.set(session.label, (repeats.get(session.label) ?? 0) + 1);
  const seenLabel = new Map<string, number>();
  return sessions.map((session) => {
    if ((repeats.get(session.label) ?? 0) < 2) return session;
    const index = seenLabel.get(session.label) ?? 0;
    seenLabel.set(session.label, index + 1);
    return { ...session, label: `${session.label} · ${index ? `earlier ${index}` : "current"}` };
  });
}

/** What a working card is doing now (the workflow's "activity" operation). */
export type ChatActivity = {
  activity?: string;
  output?: string;
  error?: string;
  started_at_ms?: number | null;
  activity_at_ms?: number | null;
  last_event_at_ms?: number | null;
  turn_started?: boolean;
  /** The current turn so far: messages, reasoning and tool calls in order (AO harness cards). */
  timeline?: ChatLiveItem[];
};

/**
 * One entry of a card's turn. `kind` is "message" or AO's activity kind (reasoning, command, tool, …).
 * A tool call also carries the agent's one-line `description`, its arguments (`input`, JSON) and
 * what came back (`output`), shown when its row is opened.
 */
export type ChatLiveItem = {
  id: string; kind: string; status: string; text: string; label?: string;
  description?: string; input?: string; output?: string;
  /** The same call made this many times in a row (tidyTimeline). */
  count?: number;
  /** For kind "edit": the files it changed (Claude Code's "Edited <file> +12 −3"). */
  files?: ChatEditedFile[];
};
/**
 * A turn's activity as it reads: requests "Approve for me" (or the user) already answered drop
 * out, since every tool call left a second "Approval <tool>" row under it, and the same call made
 * again and again ("read_output" while a test runs) is one row with a count. A request that timed
 * out or was cancelled (AO labels those) still shows.
 */
export function tidyTimeline(items: ChatLiveItem[]): ChatLiveItem[] {
  const out: ChatLiveItem[] = [];
  for (const item of items) {
    if (item.kind === "approval" && !item.label && !/reject|denied|declin/i.test(item.status)) continue;
    const last = out.at(-1);
    if (last && (item.kind === "tool" || item.kind === "command") && last.kind === item.kind && last.label === item.label
      && last.text === item.text && (last.description ?? "") === (item.description ?? "")) {
      // The row keeps the first call's id: it keys the row (and its group), so one the user opened stays open.
      out[out.length - 1] = { ...item, id: last.id, count: (last.count ?? 1) + 1 };
      continue;
    }
    out.push(item);
  }
  return out;
}

/** A stretch of a turn: a message, steer or edit on its own, or a run of tool calls and thinking. */
export type ChatLiveSegment = { kind: "item"; item: ChatLiveItem } | { kind: "group"; key: string; items: ChatLiveItem[] };
const GROUPED = new Set(["tool", "command", "reasoning"]);

/** Runs of tool calls and thinking fold into one group each, as Codex, Cursor and Claude Code show them. */
export function groupTimeline(items: ChatLiveItem[]): ChatLiveSegment[] {
  const segments: ChatLiveSegment[] = [];
  for (const item of items) {
    const last = segments.at(-1);
    if (!GROUPED.has(item.kind)) segments.push({ kind: "item", item });
    else if (last?.kind === "group") last.items.push(item);
    else segments.push({ kind: "group", key: item.id, items: [item] });
  }
  return segments;
}

/** "Ran 2 commands, read_output ×7, search_text · 3 thoughts": what a folded group did. */
export function activitySummary(items: ChatLiveItem[]): string {
  const commands = items.filter((item) => item.kind === "command").reduce((sum, item) => sum + (item.count ?? 1), 0);
  const thoughts = items.filter((item) => item.kind === "reasoning").length;
  const tools = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const name = item.text.replace(/^mcp__[\w-]+__/, "").replace(/\s+/g, " ").trim().slice(0, 40) || item.label || "tool";
    tools.set(name, (tools.get(name) ?? 0) + (item.count ?? 1));
  }
  const named = [...tools].sort((a, b) => b[1] - a[1]);
  const parts = [
    commands ? `ran ${commands === 1 ? "a command" : `${commands} commands`}` : "",
    ...named.slice(0, 3).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)),
    named.length > 3 ? `${named.length - 3} more tools` : "",
  ].filter(Boolean);
  const text = parts.join(", ");
  const thinking = thoughts ? `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}` : "";
  const line = [text, thinking].filter(Boolean).join(" · ") || "Worked";
  // "Ran …" and "3 thoughts" read as sentences; a tool's own name keeps its spelling.
  return commands ? line[0].toUpperCase() + line.slice(1) : line;
}

/** A file a tool call edited: lines added and removed, and the changed lines ("-old", "+new"). */
export type ChatEditedFile = { path: string; additions: number; deletions: number; diff?: string };

/** How a card's state reads in the chat's details panel, in the order the counts are listed. */
const AGENT_STATES = ["working", "waiting", "failed", "done", "queued", "stopped"] as const;
export type AgentState = typeof AGENT_STATES[number];
function agentState(state?: string): AgentState {
  if (state === "finished") return "done";
  if (state === "running" || state === "reserved") return "working";
  if (state === "held") return "waiting";
  if (state === "failed") return "failed";
  if (state === "cancelled" || state === "archived") return "stopped";
  return "queued";
}
/** The latest run's cards as the details panel shows them: one dot per card and a count line ("3 done · 1 working"). */
export function chatAgentSummary(nodes: { state?: string }[]): { dots: AgentState[]; text: string } {
  const dots = nodes.map((node) => agentState(node.state));
  const text = AGENT_STATES.map((state) => [state, dots.filter((dot) => dot === state).length] as const)
    .filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`).join(" · ");
  return { dots, text: text || "No agents yet" };
}
/** How the card's tool requests are answered, as the details panel names it. */
export function chatApprovalMode(route?: { approval_policy?: string; approvals_reviewer?: string } | null): string {
  if (!route?.approval_policy) return "Default";
  if (route.approval_policy === "never") return "Full access, no prompts";
  return route.approvals_reviewer === "auto_review" ? "Approve for me" : "Ask me";
}

/** The folders new worktrees share with the project (`shared`, a link) or get as hard-link farms (`farmed`). */
export type DependencyLinks = { shared: string[]; farmed: string[] };
export type DependencyNote = { tone: "warn" | "info"; text: string };
const NODE_INSTALL = /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:ci|install|i|add|remove|rm|uninstall|un|update|up|upgrade)\b/i;
const PYTHON_INSTALL = /\b(?:pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip|uv\s+pip|uv|poetry|pipenv)(?:\.exe)?\s+(?:install|add|sync|uninstall|remove|update|lock)\b/i;
const isVenv = (dir: string) => /(?:^|\/)\.?venv$/i.test(dir);
const isNodeModules = (dir: string) => /(?:^|\/)node_modules$/i.test(dir);
/**
 * What an agent's install command does to the project's own packages, shown on its approval card:
 * a folder linked to the project (the opt-in shared Python environment, or a user's own link) is
 * changed for the project too; a hard-link farm (node_modules by default) installs privately.
 */
export function dependencyInstallNote(command: string | undefined, links: DependencyLinks | null): DependencyNote | null {
  if (!command || !links) return null;
  if (PYTHON_INSTALL.test(command) && links.shared.some(isVenv)) {
    return { tone: "warn", text: "This worktree shares the project's Python environment: installing here changes the project's packages too." };
  }
  if (NODE_INSTALL.test(command)) {
    if (links.shared.some(isNodeModules)) {
      return { tone: "warn", text: "This worktree shares the project's node_modules: installing here changes the project's packages too." };
    }
    if (links.farmed.some(isNodeModules)) {
      return { tone: "info", text: "Node packages install privately in this worktree; the project's own stay as they are." };
    }
  }
  return null;
}

export type ChatOptions = {
  /** One line per card: harness · model · effort · context · role. */
  describe?: (node: ChatNode, run?: ChatRun) => string;
  /** Live activity by "<run id>:<card id>". */
  activity?: Record<string, ChatActivity>;
  now?: number;
  /** A model's short name ("DeepSeek V4.1 Flash"): a single-model chat's card is named by it. */
  modelName?: (model: string) => string;
};

/** A working card that has not been heard from for this long is shown as possibly stuck. */
export const STALL_MS = 10 * 60_000;

/** 42_000 -> "42s"; 185_000 -> "3m"; 10_680_000 -> "2h 58m". */
export function scheduledStartLabel(dueAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((dueAt-now)/1000));
  const remaining = !seconds ? "due now" : seconds < 60 ? `in ${seconds}s`
    : seconds < 3600 ? `in ${Math.floor(seconds/60)}m ${seconds%60}s`
    : `in ${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`;
  return `Starts at ${new Date(dueAt).toLocaleString()} · ${remaining}`;
}

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
export function chatWorkingDetail(node: ChatNode, live: ChatActivity | undefined, now: number, describe?: (node: ChatNode, run?: ChatRun) => string, run?: ChatRun): { detail: string; stalled: boolean } {
  const started = live?.started_at_ms ?? node.receipt?.started_at_ms ?? null;
  const heard = live?.last_event_at_ms || live?.activity_at_ms || null;
  const parts = [describe?.(node, run) ?? ""];
  if (started) parts.push(`running ${chatDuration(now - started)}`);
  if (live?.activity) parts.push(heard ? `${live.activity} (last heard ${chatDuration(now - heard)} ago)` : live.activity);
  const quietSince = heard ?? started;
  const stalled = Boolean(quietSince && now - quietSince >= STALL_MS && (heard || live?.turn_started === false));
  return { detail: parts.filter(Boolean).join(" · "), stalled };
}

export type TaskLifecycleView = {
  task_id: string; title?: string; workspace_id?: string; revision?: number; visibility?: "active" | "archived" | "deleted";
  reconfigure?: { id: string; previous_run_id: string; replacement_run_id?: string | null; phase: string; handoff?: string }[];
  schedule?: { id: string; run_id: string; due_at_ms: number; state: string; revision: number } | null;
};
export type ChatRun = {
  replaces_run_id?: string;
  /** Restart mission: this run answers the same message again (set by the bridge). */
  restarts_run_id?: string;
  id: string;
  project_id: string;
  cancelled: boolean;
  paused?: boolean;
  /** The orchestrator judged the mission simple and answered it alone; no other card ran. */
  solo?: boolean;
  /** "single": one model answers alone; its card is not an orchestrator. */
  execution_mode?: "single" | "team";
  nodes: ChatNode[];
};

export type ChatStatus = "queued" | "scheduled" | "running" | "paused" | "attention" | "stopped" | "done";

export type ChatSummary = {
  visibility?: "active" | "archived" | "deleted";
  schedule?: TaskLifecycleView["schedule"];
  taskId: string;
  title: string;
  runIds: string[];
  latestRunId: string;
  status: ChatStatus;
  /** When the chat's task last changed (Unix ms), for the list's relative age. */
  updatedAtMs?: number;
  archived?: boolean;
};

/** A board task as the chat list sees it. */
export type ChatTask = { id: string; title: string; state?: string; updated_at?: number };

/** "now", "5m", "3h", "2d", "3w", "4mo", "2y": Codex's compact age. */
export function chatRelativeTime(ms: number | undefined, now: number): string {
  if (!ms) return "";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export type ChatMessage =
  | { kind: "user"; key: string; text: string; stamp?: string }
  | { kind: "agent"; key: string; role: ChatNode["role"]; name: string; text: string; tone: "answer" | "error" | "verdict"; verdict?: string; detail?: string }
  | { kind: "status"; key: string; text: string; state: string; detail?: string; stalled?: boolean };

export const CHAT_DEFAULT_TITLE = "New task";

const FOLLOW_UP = /\n\nFollow-up \(([^)]+) UTC\):\n/;
const SETTLED = ["finished", "cancelled", "archived"];

// A message handed to the working agent mid-turn ("steer"), saved under the turn's message by chat_steer.
const STEER = /\n\n↳ Steer \(([^)]+) UTC\): /;
export type ChatSteer = { text: string; stamp: string };

/** Splits the steers off a message: the message itself, then each steer in the order they were sent. */
function withSteers(raw: string): { text: string; steers?: ChatSteer[] } {
  const parts = raw.split(STEER);
  const steers: ChatSteer[] = [];
  for (let index = 1; index < parts.length; index += 2) steers.push({ stamp: parts[index], text: (parts[index + 1] ?? "").trim() });
  return { text: parts[0].trim(), ...(steers.length ? { steers } : {}) };
}

/** The user's messages in a chat, oldest first: the task description plus each follow-up. */
export function chatMessagesFromDescription(description: string | undefined): { text: string; stamp?: string; steers?: ChatSteer[] }[] {
  const parts = (description ?? "").split(FOLLOW_UP);
  const messages: { text: string; stamp?: string; steers?: ChatSteer[] }[] = [];
  if (parts[0]?.trim()) messages.push(withSteers(parts[0]));
  for (let index = 1; index < parts.length; index += 2) {
    messages.push({ stamp: parts[index], ...withSteers(parts[index + 1] ?? "") });
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

/**
 * Chats in a workspace, most recently started first. Runs arrive oldest first. Archived and
 * deleted chats (by their lifecycle, or an archived board task) are left out unless showInactive.
 */
export function chatList(runs: ChatRun[], tasks: ChatTask[], lifecycle: TaskLifecycleView[] = [], showInactive = false): ChatSummary[] {
  return chatSummaries(runs, tasks, lifecycle).filter((chat) => showInactive || !chat.archived);
}

/** Archived and deleted chats, most recently started first, for the list's "Archived" section. */
export function chatArchived(runs: ChatRun[], tasks: ChatTask[], lifecycle: TaskLifecycleView[] = []): ChatSummary[] {
  return chatSummaries(runs, tasks, lifecycle).filter((chat) => chat.archived);
}

function chatSummaries(runs: ChatRun[], tasks: ChatTask[], lifecycle: TaskLifecycleView[]): ChatSummary[] {
  const lifeByTask = new Map(lifecycle.map(item => [item.task_id, item]));
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
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
      const visibility = lifeByTask.get(taskId)?.visibility ?? (byId.get(taskId)?.state === "archived" ? "archived" : "active");
      return {
        taskId,
        title: titles.get(taskId) || lifeByTask.get(taskId)?.title || CHAT_DEFAULT_TITLE,
        runIds: entry.runs.map((run) => run.id),
        latestRunId: latest.id,
        visibility,
        schedule: lifeByTask.get(taskId)?.schedule,
        status: lifeByTask.get(taskId)?.schedule?.run_id === latest.id && lifeByTask.get(taskId)?.schedule?.state === "scheduled"
          ? "scheduled" : ["missed", "needs_attention"].includes(lifeByTask.get(taskId)?.schedule?.state ?? "")
          ? "attention" : chatRunStatus(latest),
        ...(byId.get(taskId)?.updated_at ? { updatedAtMs: byId.get(taskId)!.updated_at! * 1000 } : {}),
        ...(visibility !== "active" ? { archived: true } : {}),
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
  let messageIndex = 0;
  runs.forEach((run) => {
    const user = run.replaces_run_id ? undefined : said[messageIndex++];
    if (run.replaces_run_id) messages.push({ kind: "status", key: `${run.id}:reconfigured`,
      text: "Configuration changed; continuing from quoted visible work.", state: "finished" });
    if (user) messages.push({ kind: "user", key: `${run.id}:user`, text: user.text, stamp: user.stamp });
    for (const node of chatNodeOrder(run.nodes)) {
      const name = chatNodeName(node);
      const key = `${run.id}:${node.id}`;
      const described = options.describe?.(node, run);
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
      } else if (!run.cancelled && !run.paused && (node.state === "running" || node.state === "reserved")) {
        const working = chatWorkingDetail(node, options.activity?.[key], now, options.describe, run);
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
  for (let index = messageIndex; index < said.length; index += 1) {
    messages.push({ kind: "user", key: `pending:${index}`, text: said[index].text, stamp: said[index].stamp });
  }
  return messages;
}

// ---------------------------------------------------------------------------------------------
// Codex-style turns: each message the user sent, the cards' work collapsed under it, and the
// answer that closes the turn shown in full.

export type ChatStep = {
  key: string;
  nodeId: string;
  role: ChatNode["role"];
  name: string;
  /** How the card runs: harness · model · effort · context · role. */
  detail: string;
  state: string;
  text?: string;
  verdict?: string;
  error?: string;
  /** For a working card: runtime, current step and when it was last heard. */
  working?: { detail: string; stalled: boolean; activity?: string; timeline?: ChatLiveItem[] };
  startedAtMs?: number;
  /** The card ran in an AO session, so its finished work can be read back (turn_timeline). */
  hasWork?: boolean;
};

export type ChatTurn = {
  key: string;
  runId: string;
  user?: { text: string; stamp?: string; steers?: ChatSteer[] };
  /** Which of the chat's messages `user` is (its place in the task description). */
  messageIndex?: number;
  /** The cards' work, in pipeline order, without the answer that closes the turn. */
  steps: ChatStep[];
  /** The answer shown in full: the final reviewer's, or the orchestrator's when it went solo. */
  final?: ChatStep;
  status: ChatStatus;
  solo: boolean;
  /** When the earliest card of this run started (Unix ms). */
  startedAtMs?: number;
};

/** The error the main process gives a card whose turn ended only because the app restarted. */
export const RESTART_INTERRUPTED = /process ended before it finished \(the app restarted\)/;

type ResumeCandidate = {
  cancelled: boolean; paused?: boolean; execution_mode?: string;
  nodes: { state: string; receipt?: { error?: string | null } | null; history?: unknown[] }[];
};

/**
 * Whether a chat picks up by itself after an app restart: its step failed only because the app
 * (and AO with it) restarted mid-turn, so nothing about the work itself went wrong.
 */
export function resumableAfterRestart(mission: ResumeCandidate): boolean {
  // A chat stopped or paused on purpose stays that way.
  if (mission.cancelled || mission.paused) return false;
  // Only a single chat resumes by itself: resuming a team is a bigger step, left to its own controls.
  if (mission.execution_mode !== "single") return false;
  const card = mission.nodes[0];
  // Within the attempt budget, so an agent that brings the app down each time is not restarted forever.
  return Boolean(card) && ["held", "failed"].includes(card.state)
    && RESTART_INTERRUPTED.test(String(card.receipt?.error || "")) && (card.history?.length ?? 0) < 2;
}

/**
 * A working card's turn so far. AO harness cards report a timeline; Native Codex cards (WebGPT and
 * the CPA pool) report only the reply streamed so far (`output`), which the chat used to drop, so a
 * reply showed nothing but "working" until the turn ended. That text now shows as the running message.
 */
export function liveTimeline(key: string, live: ChatActivity | undefined): ChatLiveItem[] {
  const timeline = live?.timeline ?? [];
  const output = live?.output?.trim();
  if (!output || timeline.some(item => item.kind === "message")) return timeline;
  return [...timeline, { id: `${key}:live`, kind: "message", status: "running", text: output }];
}

function chatStep(run: ChatRun, node: ChatNode, options: ChatOptions, now: number): ChatStep {
  const key = `${run.id}:${node.id}`;
  const step: ChatStep = {
    key, nodeId: node.id, role: node.role,
    // A single-model chat's one card reads as the model it runs ("Single assistant" said nothing).
    name: (run.execution_mode === "single" && node.route?.model && options.modelName?.(node.route.model)) || chatNodeName(node), detail: options.describe?.(node, run) ?? "", state: node.state,
    ...(node.receipt?.started_at_ms ? { startedAtMs: node.receipt.started_at_ms } : {}),
    ...(node.receipt?.thread_id && node.route?.harness_id?.startsWith("ao:") && node.state !== "running" && node.state !== "reserved"
      ? { hasWork: true } : {}),
  };
  if (node.receipt?.error) step.error = node.receipt.error;
  if (node.receipt?.answer) step.text = run.solo && node.role === "planner" ? withoutSoloBlock(node.receipt.answer) : node.receipt.answer;
  if (node.receipt?.verdict) step.verdict = node.receipt.verdict;
  if (node.state === "running" || node.state === "reserved") {
    const live = options.activity?.[key];
    const working = chatWorkingDetail(node, live, now);
    const timeline = liveTimeline(key, live);
    step.working = { ...working, ...(live?.activity ? { activity: live.activity } : {}),
      ...(timeline.length ? { timeline } : {}) };
    // A retried card's new attempt starts empty; until it writes, its earlier reply stays readable.
    const earlier = node.history?.[node.history.length - 1]?.answer;
    if (!step.text && earlier?.trim() && !timeline.some((item) => item.kind === "message")) {
      step.text = `Earlier attempt:\n\n${earlier}`;
    }
  }
  return step;
}

/** The chat pet's mood (ChatPet.tsx). */
export type PetMood = "idle" | "working" | "ask" | "done" | "error";

/** The pet's mood from the chat: a waiting request first, then a running turn, then how the last one ended. */
export function petMood({ asking, running, lastStatus, lastFailed }: {
  asking: boolean; running: boolean; lastStatus?: string; lastFailed?: boolean;
}): PetMood {
  if (asking) return "ask";
  if (running) return "working";
  if (lastFailed || lastStatus === "attention") return "error";
  return lastStatus === "done" ? "done" : "idle";
}

/**
 * What the line under the chat box counts: the latest turn, and before it every turn that ended
 * without finishing (failed, stopped, held). A message whose attempt failed and was sent again,
 * often on another model, kept only the new attempt's time and tokens. `from` is when the earliest
 * of those started; `models` are the models they ran on, newest first.
 */
export function chatStatsSpan(turns: ChatTurn[], runs: ChatRun[]): { from?: number; models: string[] } {
  const started = turns.filter((turn) => turn.runId && turn.startedAtMs);
  const latest = started.at(-1);
  if (!latest) return { models: [] };
  const span = [latest];
  for (let index = started.length - 2; index >= 0 && started[index].status !== "done"; index -= 1) span.push(started[index]);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const models = [...new Set(span.flatMap((turn) => (byId.get(turn.runId)?.nodes ?? []).map((node) => node.route?.model ?? ""))
    .filter((model) => model.startsWith("cpa/")))];
  return { from: Math.min(...span.map((turn) => turn.startedAtMs!)), models };
}

/** The conversation as Codex turns, oldest first, plus a just-sent message whose run is not visible yet. */
export function chatTurns(runs: ChatRun[], description: string | undefined, options: ChatOptions = {}): ChatTurn[] {
  const said = chatMessagesFromDescription(description);
  const now = options.now ?? Date.now();
  // Each run answers the next message, except a restart or a reconfigured replacement: that one
  // answers its earlier run's message again, so it shows as a turn of its own without a message.
  let messageIndex = 0;
  const turns: ChatTurn[] = runs.map((run) => {
    const index = run.restarts_run_id || run.replaces_run_id ? -1 : messageIndex++;
    const steps = chatNodeOrder(run.nodes)
      .filter((node) => node.state !== "pending" || node.receipt)
      .map((node) => chatStep(run, node, options, now));
    // A single-model run's one card answers the message itself, as a solo orchestrator's does.
    const closing = run.solo || run.execution_mode === "single"
      ? steps.find((step) => step.role === "planner" && step.state === "finished" && step.text)
      : [...steps].reverse().find((step) => step.role === "reviewer" && step.state === "finished" && step.text);
    const starts = steps.map((step) => step.startedAtMs).filter((value): value is number => Boolean(value));
    return {
      key: run.id, runId: run.id,
      ...(said[index] ? { user: said[index], messageIndex: index } : {}),
      steps: closing ? steps.filter((step) => step !== closing) : steps,
      ...(closing ? { final: closing } : {}),
      status: chatRunStatus(run), solo: Boolean(run.solo),
      ...(starts.length ? { startedAtMs: Math.min(...starts) } : {}),
    };
  });
  for (let index = messageIndex; index < said.length; index += 1) {
    turns.push({ key: `pending:${index}`, runId: "", user: said[index], messageIndex: index, steps: [], status: "queued", solo: false });
  }
  return turns;
}

/** Every run of the message whose turn ran `runId`: that run, then each restart or replacement of it (and of those). */
export function chatRunsOfMessage(runs: ChatRun[], runId: string): string[] {
  const found = runId ? [runId] : [];
  for (let at = 0; at < found.length; at += 1) {
    for (const run of runs) {
      if ((run.restarts_run_id === found[at] || run.replaces_run_id === found[at]) && !found.includes(run.id)) found.push(run.id);
    }
  }
  return found;
}

/** The description up to and including the user's message at `turnIndex`, for "Fork from here". */
export function chatDescriptionUpTo(description: string | undefined, turnIndex: number): string {
  const said = chatMessagesFromDescription(description).slice(0, turnIndex + 1);
  const full = (message: { text: string; steers?: ChatSteer[] }) =>
    [message.text, ...(message.steers ?? []).map((steer) => `↳ Steer (${steer.stamp} UTC): ${steer.text}`)].join("\n\n");
  return said.map((message, index) => index === 0 ? full(message) : `Follow-up (${message.stamp ?? "earlier"} UTC):\n${full(message)}`).join("\n\n");
}

/** One chat as Markdown, for "Copy › Conversation". */
export function chatMarkdown(title: string, turns: ChatTurn[]): string {
  const parts = [`# ${title}`];
  for (const turn of turns) {
    if (turn.user) parts.push(`**You:**\n\n${turn.user.text}`);
    for (const step of [...turn.steps, ...(turn.final ? [turn.final] : [])]) {
      const body = [step.error ? `Error: ${step.error}` : "", step.text ?? ""].filter(Boolean).join("\n\n");
      if (body) parts.push(`**${step.name}${step.verdict ? ` · ${step.verdict}` : ""}:**\n\n${body}`);
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Composer: slash commands and attachments.

export type ChatSlashCommand = { name: string; hint: string; args?: string; needsChat?: boolean; needsRun?: boolean; needsOpen?: boolean };

/**
 * Codex's slash commands, in its order, plus the chat's own. Every command maps to a real action
 * that works the same for a Single model and a team; none is a placeholder.
 */
export const CHAT_SLASH_COMMANDS: ChatSlashCommand[] = [
  { name: "goal", hint: "Set a goal to keep pursuing", args: "<objective> | pause | resume | edit | clear" },
  { name: "plan", hint: "Turn plan mode on or off" },
  { name: "compact", hint: "Compact this chat's context", needsChat: true },
  { name: "review", hint: "Review the current changes", args: "[what to focus on]" },
  { name: "init", hint: "Create an AGENTS.md file with instructions for agents" },
  { name: "status", hint: "Show chat ID, context usage, cards and goal" },
  { name: "diff", hint: "Show the project's uncommitted changes" },
  { name: "mcp", hint: "Show MCP server status" },
  { name: "model", hint: "Choose the model or team" },
  { name: "new", hint: "Start a new chat" },
  { name: "resume", hint: "Resume a recent chat" },
  { name: "fork", hint: "Start a new chat from this conversation", needsChat: true },
  { name: "rewind", hint: "Go back to an earlier message and edit it", args: "[message number]", needsChat: true },
  { name: "delete", hint: "Delete a message and its reply from this chat", args: "[message number]", needsChat: true },
  { name: "rename", hint: "Rename this chat", needsChat: true },
  { name: "archive", hint: "Archive this chat", needsChat: true },
  { name: "copy", hint: "Copy this conversation as Markdown", needsChat: true },
  { name: "stop", hint: "Stop the running mission", needsRun: true, needsOpen: true },
  { name: "retry", hint: "Restart the latest mission with the same task", needsRun: true },
  { name: "structure", hint: "Show or hide the cards panel", needsRun: true },
  { name: "board", hint: "Open the Mission Board" },
];

/** The commands matching a draft that starts with "/" and has no space yet. */
export function chatSlashMatches(draft: string, context: { chat: boolean; run: boolean; open?: boolean }): ChatSlashCommand[] {
  const match = /^\/([a-z]*)$/i.exec(draft.trim());
  if (!match) return [];
  const prefix = match[1].toLowerCase();
  return CHAT_SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix)
    && (!command.needsChat || context.chat) && (!command.needsRun || context.run) && (!command.needsOpen || context.open !== false));
}

/** A command being typed with its argument ("/goal fix the flaky tests"), to show its usage. */
export function chatSlashTyping(draft: string): ChatSlashCommand | null {
  const match = /^\/([a-z]+)\s/i.exec(draft);
  return CHAT_SLASH_COMMANDS.find((command) => command.args && command.name === match?.[1].toLowerCase()) ?? null;
}

/** A whole draft that is one known command, with what follows it: "/goal ship it" → goal, "ship it". */
export function chatSlashParse(draft: string): { name: string; arg: string } | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(draft.trim());
  const name = match?.[1].toLowerCase();
  const command = CHAT_SLASH_COMMANDS.find((entry) => entry.name === name);
  if (!command || (!command.args && match?.[2]?.trim())) return null;
  return { name: command.name, arg: match?.[2]?.trim() ?? "" };
}

/** A chat's goal (/goal), as the bridge keeps it. */
export type ChatGoal = {
  objective: string; status: "active" | "paused" | "achieved" | "stalled" | "limited";
  round: number; rounds: number; startedAt: number; updatedAt: number; note?: string;
};
/** Codex's goal summary words for each state. */
export const GOAL_SUMMARY: Record<ChatGoal["status"], string> = {
  active: "Pursuing goal", paused: "Paused goal", achieved: "Goal achieved", stalled: "Goal stalled", limited: "Goal limited",
};
/** Something typed while a chat's turn runs, sent when the turn finishes: a message, or a command's message. */
export type QueuedChatMessage = { what: string; message: string; goal?: string };
/**
 * Adds to one chat's queue. A plain message joins a plain message queued just before it (they are
 * sent together); anything else (a command, a goal) waits for a turn of its own. Nothing is replaced.
 */
export function chatQueueAdd(queue: QueuedChatMessage[], item: QueuedChatMessage): QueuedChatMessage[] {
  const last = queue[queue.length - 1];
  if (last && item.what === "Message" && last.what === "Message") return [...queue.slice(0, -1), { ...last, message: `${last.message}\n\n${item.message}` }];
  return [...queue, item];
}
/** What a command shows above the composer: a few facts, a block of text, or a list to pick from. */
export type ChatCommandCard = {
  title: string; rows?: [string, string][]; text?: string; mono?: boolean;
  /** The user's own message the card is about (a queued message), shown quoted above the text. */
  quote?: string;
  items?: { label: string; detail?: string; run: () => void }[];
};
/** What the page provides so the chat's commands reach real data and actions. */
export type ChatCommands = {
  goal?: ChatGoal | null;
  goalAction: (action: "pause" | "resume" | "clear") => Promise<void>;
  /** Edit goal: saves a new objective for the rounds still to come. */
  goalEdit: (objective: string) => Promise<void>;
  /** Compacts the chat's context; says what happened. */
  compact: () => Promise<string>;
  diff: () => Promise<ChatCommandCard>;
  mcp: () => Promise<ChatCommandCard>;
  status: () => ChatCommandCard;
  recent: () => ChatCommandCard;
  planMode: boolean;
  setPlanMode: (on: boolean) => void;
};

/** How long a goal has been going, as Codex shows it: "50s", "4m 50s", "7d 4h 4m 50s". */
export function goalElapsed(since: number, now = Date.now()): string {
  let seconds = Math.max(0, Math.floor((now - since) / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    const count = Math.floor(seconds / size);
    seconds -= count * size;
    if (count || parts.length) parts.push(`${count}${unit}`);
  }
  return [...parts, `${seconds}s`].join(" ");
}

/** A whole draft that is exactly one known command ("/stop"), or null. */
export function chatSlashCommand(draft: string): string | null {
  const match = /^\/([a-z]+)$/i.exec(draft.trim());
  const name = match?.[1].toLowerCase();
  return name && CHAT_SLASH_COMMANDS.some((command) => command.name === name) ? name : null;
}

export type ChatAttachment = {
  name: string; path?: string; text?: string; image?: boolean;
  /** The chat box's thumbnail (an object URL of the file); never sent. */
  preview?: string;
};

/** Attachments appended to the message: a file path agents read themselves, or a small text file inline. */
export function chatMessageWithAttachments(message: string, attachments: ChatAttachment[]): string {
  const blocks = attachments.map((item) => item.path
    ? `${item.image ? "Attached image" : "Attached file"}: ${item.path}`
    : `Attached file \`${item.name}\`:\n\`\`\`\n${(item.text ?? "").replace(/\`\`\`/g, "\`\`\u200b\`")}\n\`\`\``);
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}

/** A token count as the context meter shows it: 537523 → "537.5k", 1000000 → "1M". */
export function tokensShort(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 ? 2 : 0))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

/** How full an agent's context is (0..1), or null when it has not said or gives no window size. */
export function contextFraction(usage: { contextUsed: number | null; contextWindow: number | null } | null | undefined): number | null {
  if (!usage || !usage.contextWindow || usage.contextWindow <= 0 || usage.contextUsed === null) return null;
  return Math.max(0, Math.min(1, usage.contextUsed / usage.contextWindow));
}
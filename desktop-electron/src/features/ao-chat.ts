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
  history?: { answer?: string; verdict?: string; error?: string }[];
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
    for (const node of [...(run.nodes ?? [])].reverse()) {
      const id = node.receipt?.thread_id;
      if (!id || seen.has(id) || !node.route?.harness_id?.startsWith("ao:")) continue;
      // Always a string: the chat reads these labels while rendering (the context meter splits
      // them), and a card saved with no name, role name or role would otherwise throw there.
      const name = node.settings?.name || node.settings?.role_name || node.role || "Agent";
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
  /** Images a tool call returned (a screenshot, a picture it read), as the files Claude Code saved them to. */
  images?: string[];
  /** For kind "edit": the files it changed (Claude Code's "Edited <file> +12 −3"). */
  files?: ChatEditedFile[];
  /**
   * On a kind "approval" item, who answered the request ("Allowed by the reviewer: …"); on a tool
   * call, the answer that let it run, folded in by tidyTimeline.
   */
  approval?: string;
  /** On a request or question the person answered: what was asked and what they chose. */
  answered?: { question: string; answer: string };
  /** On a steer: whether the agent's model has read it yet (steerReceipts). */
  receipt?: SteerReceipt;
};

/**
 * Claude Code's receipt on a message the person sent mid-turn: "unread" once the agent has it (a
 * faded check, "Unread"), "read" once its model has taken it (a double check, "Read by Claude").
 */
export type SteerReceipt = "unread" | "read";
const TOOL_KINDS = new Set(["tool", "command", "edit"]);
const MODEL_OUTPUT_KINDS = new Set(["message", "reasoning", ...TOOL_KINDS]);

/**
 * Marks each steer in a turn read or unread. AO and the harness inject a steer into the running
 * turn, and the model reads it with its next request: once the model's response in flight is done.
 * That boundary is a tool call (its result goes back with the steer), or the model already waiting
 * on one when the steer came; output after it was written with the steer in hand. A turn that
 * finished read every steer in it: Claude Code and Codex send one still waiting before they end.
 */
export function steerReceipts(items: ChatLiveItem[], finished: boolean): ChatLiveItem[] {
  let changed = false;
  const marked = items.map((item, index) => {
    if (item.kind !== "steer") return item;
    const receipt: SteerReceipt = finished || steerRead(items, index) ? "read" : "unread";
    if (item.receipt === receipt) return item;
    changed = true;
    return { ...item, receipt };
  });
  return changed ? marked : items;
}

function steerRead(items: ChatLiveItem[], at: number): boolean {
  // What the model last did before the steer: waiting on a tool call means its next request has it.
  let boundary = false;
  for (let index = at - 1; index >= 0; index -= 1) {
    if (!MODEL_OUTPUT_KINDS.has(items[index].kind)) continue;
    boundary = TOOL_KINDS.has(items[index].kind);
    break;
  }
  for (const item of items.slice(at + 1)) {
    if (boundary && MODEL_OUTPUT_KINDS.has(item.kind)) return true;
    if (TOOL_KINDS.has(item.kind)) boundary = true;
  }
  return false;
}

/** Who reads a steer, by the card's harness ("Claude Code · model · …"): Claude Code's own words name Claude. */
export function steerReader(detail: string | undefined): string {
  const harness = (detail ?? "").split(" · ")[0]?.trim();
  return !harness || /^claude code$/i.test(harness) ? "Claude" : harness;
}
/**
 * A turn's activity as it reads. A request "Approve for me" (or the user) allowed is no row of its
 * own (every tool call left a second "Approval <tool>" row under it): its answer goes on the tool
 * call before it, which shows who let it run. A request that was denied, timed out or cancelled
 * (AO labels those) keeps its row. Every tool call keeps its own row: calls to the same tool ran
 * different commands, and folding them into one row with a count showed only the last call's input
 * and output.
 */
export function tidyTimeline(items: ChatLiveItem[]): ChatLiveItem[] {
  const out: ChatLiveItem[] = [];
  // ACP asks after the call it is about, so an answer belongs to the nearest call before it.
  const nearestCall = () => {
    for (let at = out.length - 1; at >= 0; at -= 1) if (["tool", "command", "edit"].includes(out[at].kind)) return at;
    return -1;
  };
  for (const raw of items) {
    // The agent's messages without notices the harness wrote into them; one that was only a notice goes.
    const said = raw.kind === "message" && raw.text ? withoutHarnessNotices(raw.text) : raw.text;
    if (raw.kind === "message" && raw.text && !said) continue;
    const item = said === raw.text ? raw : { ...raw, text: said };
    // One the person answered stays as its own row, shown as Claude Code shows an answered question.
    if (item.answered) { out.push(item); continue; }
    const answered = item.kind === "approval" && !item.label && !/reject|denied|declin/i.test(item.status);
    if (!answered) {
      // A denial that keeps its own row still explains the refusal on the call it refused.
      if (item.kind === "approval") explainRefusal(out, nearestCall(), item.approval);
      out.push(item);
      continue;
    }
    if (!item.approval || /pending/i.test(item.status)) continue;
    const at = nearestCall();
    if (at < 0 || out[at].approval) continue;
    out[at] = { ...out[at], approval: item.approval };
    explainRefusal(out, at, item.approval);
  }
  return out;
}

/**
 * A turn's work without the messages its reply already shows. Claude Code's reply is the turn's
 * messages joined, so a single-model chat showed each one twice: between its tool calls, then again
 * in the answer under the model's name. Only a whole message found in the reply goes.
 */
export function withoutReplied(items: ChatLiveItem[], reply?: string): ChatLiveItem[] {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const said = reply ? flat(reply) : "";
  if (!said) return items;
  return items.filter((item) => item.kind !== "message" || item.answered || !flat(item.text ?? "") || !said.includes(flat(item.text)));
}

// claude-agent-acp answers every denied request with this one line, whoever denied it and why.
const STOCK_REFUSAL = /^(?:Error: )?User refused permission to run tool\.?$/i;

/**
 * A call the reviewer or "Approve for me" denied shows their verdict ("Denied by the reviewer: …")
 * where the adapter's stock "User refused permission to run tool" stood: nobody refused it by hand.
 * The person's own deny is a bare "Denied", and that stock line is true for it, so it stays.
 */
function explainRefusal(out: ChatLiveItem[], at: number, approval: string | undefined) {
  if (at < 0 || !approval || !/^Denied\b./.test(approval)) return;
  const call = out[at];
  if (STOCK_REFUSAL.test((call.output ?? "").trim())) out[at] = { ...call, output: approval };
}

/**
 * `next` runs with each unchanged run (same id and revision) kept as the object already held, and
 * `previous` itself when nothing changed, so a refresh that found nothing new re-renders nothing.
 * A run push used to replace every run with a fresh copy several times a second while a model
 * streamed, and the chat rebuilt all its turns each time.
 */
export function keepRevisions<T extends { id: string; revision?: number; cancelled?: boolean; nodes?: { id: string; state: string }[] }>(previous: T[], next: T[]): T[] {
  const held = new Map(previous.map((run) => [run.id, run]));
  // The cards' states are checked too, so a store that moved a card without a new revision still shows it.
  const cards = (run: T) => (run.nodes ?? []).map((node) => `${node.id}:${node.state}`).join(",");
  let same = previous.length === next.length;
  const merged = next.map((run, index) => {
    const old = held.get(run.id);
    const keep = old && typeof run.revision === "number" && old.revision === run.revision
      && old.cancelled === run.cancelled && cards(old) === cards(run) ? old : run;
    if (keep !== previous[index]) same = false;
    return keep;
  });
  return same ? previous : merged;
}

const sameValue = (a: unknown, b: unknown) => a === b || (typeof a === "object" && a !== null && typeof b === "object" && b !== null
  && JSON.stringify(a) === JSON.stringify(b));
/** A timeline item with the same content as `old` (an IPC copy of it) keeps `old`, so its memoized row skips. */
function keepItem(old: ChatLiveItem | undefined, next: ChatLiveItem): ChatLiveItem {
  if (!old) return next;
  const keys = new Set([...Object.keys(old), ...Object.keys(next)]) as Set<keyof ChatLiveItem>;
  for (const key of keys) if (!sameValue(old[key], next[key])) return next;
  return old;
}
/**
 * The chat's activity frames after a poll: each card's frame, and each item of its timeline, that
 * did not change keeps the object already held, and `current` itself when nothing changed. This
 * replaced comparing the whole frame map as JSON twice per poll, which with long streaming messages
 * cost more than the redraw it saved, and redrew every row when any one of them changed.
 */
export function mergeActivityFrames(current: Record<string, ChatActivity>, next: Record<string, ChatActivity>): Record<string, ChatActivity> {
  let same = Object.keys(current).length === Object.keys(next).length;
  const merged: Record<string, ChatActivity> = {};
  for (const [key, frame] of Object.entries(next)) {
    const old = current[key];
    if (!old) { merged[key] = frame; same = false; continue; }
    const oldItems = new Map((old.timeline ?? []).map((item) => [item.id, item]));
    const timeline = frame.timeline?.map((item) => keepItem(oldItems.get(item.id), item));
    const timelineSame = (timeline?.length ?? -1) === (old.timeline?.length ?? -1)
      && (timeline ?? []).every((item, index) => item === old.timeline![index]);
    const restSame = (Object.keys({ ...old, ...frame }) as (keyof ChatActivity)[])
      .every((field) => field === "timeline" || sameValue(old[field], frame[field]));
    merged[key] = restSame && timelineSame ? old : { ...frame, ...(timeline ? { timeline: timelineSame ? old.timeline : timeline } : {}) };
    if (merged[key] !== old) same = false;
  }
  return same ? current : merged;
}

/**
 * A card's turn as the chat keeps it: a poll carries only the newest items, so the ones seen in
 * earlier polls that have since fallen out of that window stay in front of it, and a long turn
 * keeps every step instead of only its last few. A poll that shares no item with what is kept is
 * still the same turn: a fast model can write more than a poll's window between two polls. Taking
 * that for a new attempt dropped the whole turn so far, the user's steer messages in it included
 * (seen live at 1,300 steps). A retry starts over on its own: the chat keeps work per attempt.
 *
 * At most LIVE_TIMELINE_ITEMS are kept, the newest: an agent running for hours grew the list
 * without end, and the whole of it was rendered again on every one-second poll (a DeepSeek turn
 * shows every item flat while it works), so a long turn made the chat sluggish. A finished turn
 * reads its whole timeline back from AO when opened.
 */
export const LIVE_TIMELINE_ITEMS = 600;
export function mergeTimeline(known: ChatLiveItem[] | null | undefined, latest: ChatLiveItem[],
  { cap = LIVE_TIMELINE_ITEMS }: { cap?: number } = {}): ChatLiveItem[] {
  // `cap` Infinity: a finished turn's timeline read back whole (useStepWork) keeps every entry.
  const capped = (items: ChatLiveItem[]) => (items.length > cap ? items.slice(-cap) : items);
  if (!known?.length) return capped(latest);
  const fresh = new Set(latest.map((item) => item.id));
  return capped([...known.filter((item) => !fresh.has(item.id)), ...latest]);
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

/**
 * A tool call's title as one short phrase: a path argument reads by its last part, as Codex shows it
 * ("Read C:/Users/…/skills/using-ao/commands/report.md" → "Read report.md"), and a title still too
 * long ends in "…". Cut at a fixed length, the path read "…/coding-tools/ski" in the folded line.
 */
export function shortToolTitle(text: string): string {
  const plain = text.replace(/^mcp__[\w-]+__/, "").replace(/\s+/g, " ").trim();
  // The whole path token, relative ones included ("src/features/ao-chat.ts", "frontend\vite.config.ts"),
  // becomes its last part; a URL keeps its address.
  const named = plain.replace(/(^|[\s"'`(])([^\s"'`()]*[\\/][^\s"'`()]*)/g, (match, lead: string, token: string) => {
    if (token.includes("://")) return match;
    const last = token.split(/[\\/]+/).filter(Boolean).pop();
    return last ? lead + last : match;
  });
  if (named.length <= 40) return named;
  // Cut at the last word that fits, so a word is never left half-shown.
  const head = named.slice(0, 40);
  const space = named[40] === " " ? 40 : head.lastIndexOf(" ");
  return `${(space >= 20 ? head.slice(0, space) : head.slice(0, 39)).trimEnd()}…`;
}

/** "Ran 2 commands, read_output ×7, search_text · 3 thoughts": what a folded group did. */
export function activitySummary(items: ChatLiveItem[]): string {
  const commands = items.filter((item) => item.kind === "command").length;
  const thoughts = items.filter((item) => item.kind === "reasoning").length;
  const tools = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const name = shortToolTitle(item.text) || item.label || "tool";
    tools.set(name, (tools.get(name) ?? 0) + 1);
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

/** One line of an edit's diff as the chat draws it: old and new line numbers, the change and its text. */
export type ChatDiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number };
/**
 * An edit's diff as rows with line numbers, as Claude Code shows a change: "@@ -a,b +c,d @@"
 * starts the numbering, removed lines count on the old side, added on the new, context on both.
 * A diff without a hunk header (a snippet edit, which has no place in the file) keeps its lines
 * unnumbered. The file header (`---`/`+++`) is left out: the row above names the file.
 */
export function numberedDiff(text: string): ChatDiffLine[] {
  const lines: ChatDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      // A later hunk after a gap shows as a separator; the first one only starts the count.
      if (lines.length) lines.push({ kind: "hunk", text: "⋯" });
      // "-0,0" (nothing on that side) counts from line 1 for the lines that follow.
      oldLine = Math.max(1, Number(hunk[1])); newLine = Math.max(1, Number(hunk[2]));
      continue;
    }
    if (/^(?:--- |\+\+\+ )/.test(line)) continue;
    const step = (value: number | undefined) => (value === undefined ? undefined : value + 1);
    if (line.startsWith("+")) { lines.push({ kind: "add", text: line.slice(1), new: newLine }); newLine = step(newLine); }
    else if (line.startsWith("-")) { lines.push({ kind: "del", text: line.slice(1), old: oldLine }); oldLine = step(oldLine); }
    else { lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, old: oldLine, new: newLine }); oldLine = step(oldLine); newLine = step(newLine); }
  }
  return lines;
}

/** How long a request the app answers by itself stays off the screen before its card shows anyway. */
export const SELF_ANSWER_GRACE_MS = 30_000;
/**
 * Whether a pending request's card stays hidden because the app answers it for the person: on a
 * card set to "Approve for me" or "Full access" a command or tool request is reviewed and answered
 * at once, so a card would only flash up and offer a click that arrives after the answer. A
 * question or a plan is the person's and always shows; so does a request still waiting after the
 * grace period (an answer that could not be sent), so nothing sits hidden. In a team with a
 * Command approver the card's own reviewer stands aside, so its requests always show; and one the
 * reviewer left at "ask" is the person's, waiting for them with no timer, so it shows at once.
 */
export function approvalAnsweredForYou(
  approval: { kind?: string; recommendation?: { action?: string } },
  route: { approval_policy?: string; approvals_reviewer?: string } | null | undefined,
  waitingMs: number,
  teamHasApprover = false,
): boolean {
  if (approval.kind === "question" || approval.kind === "plan" || teamHasApprover) return false;
  if (approval.recommendation?.action === "ask") return false;
  const answersForYou = route?.approvals_reviewer === "auto_review" || route?.approval_policy === "never";
  return answersForYou && waitingMs < SELF_ANSWER_GRACE_MS;
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
export function chatWorkingDetail(node: ChatNode, live: ChatActivity | undefined, now: number, describe?: (node: ChatNode, run?: ChatRun) => string, run?: ChatRun): { detail: string; stalled: boolean; heardAtMs?: number } {
  const started = live?.started_at_ms ?? node.receipt?.started_at_ms ?? null;
  const heard = live?.last_event_at_ms || live?.activity_at_ms || null;
  const parts = [describe?.(node, run) ?? ""];
  if (started) parts.push(`running ${chatDuration(now - started)}`);
  if (live?.activity) parts.push(heard ? `${live.activity} (last heard ${chatDuration(now - heard)} ago)` : live.activity);
  const quietSince = heard ?? started;
  const stalled = Boolean(quietSince && now - quietSince >= STALL_MS && (heard || live?.turn_started === false));
  return { detail: parts.filter(Boolean).join(" · "), stalled, ...(heard ? { heardAtMs: heard } : {}) };
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
 * A run the person has just stopped, as it shows while the stop goes through (the saved
 * cancellation, each agent's interrupt, the board reload): stopped at once, the way Claude Code's
 * Esc ends the spinner the moment it is pressed. Stop used to change nothing for seconds. The next
 * read of the run replaces this.
 */
export function chatRunStopping<T extends ChatRun>(run: T): T {
  // A card still working or about to start ends its shimmer; a finished, failed or held one keeps
  // its state, and every card keeps its receipt, so its "Worked" stays openable (hasWork).
  const stopping = new Set(["running", "reserved", "pending"]);
  return { ...run, cancelled: true,
    nodes: run.nodes.map((node) => stopping.has(node.state) ? { ...node, state: "cancelled" } : node) };
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

/**
 * A review without the trailing ```rework block the engine reads (the worker card ids to redo),
 * fenced or as the web bridge flattens it (a bare "rework" line, then the ids in backticks). Seen
 * live: the chat ended a review with "rework" and `["7394f7d6-…"]`, card ids nobody can read.
 */
export function withoutReworkBlock(answer: string): string {
  const fenced = answer.lastIndexOf("```rework");
  const flattened = [...answer.matchAll(/(^|\n)[ \t]*rework[ \t]*\r?\n\s*[`[{]/gi)].pop();
  const start = Math.max(fenced, flattened?.index !== undefined ? flattened.index + flattened[1].length : -1);
  return start < 0 ? answer : answer.slice(0, start).trimEnd();
}

// Claude Code writes this notice into a turn's reply when its requests go through a gateway (CPA):
// its own auto-mode classifier billing does not apply there. The agent did not write it, and the
// app reviews requests itself, yet it opened many answers ("**Warning:** We're changing auto mode…").
const AUTO_MODE_NOTICE = /(^|\n)[ \t]*(?:\*\*)?Warning:(?:\*\*)?[ \t]*We[’']re changing auto mode to no longer charge for classifier requests[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g;

/** A reply without notices the harness wrote into it (AUTO_MODE_NOTICE). */
export function withoutHarnessNotices(text: string): string {
  const out = text.replace(AUTO_MODE_NOTICE, "$1");
  return out === text ? text : out.replace(/\n{3,}/g, "\n\n").trim();
}

/** A card's reply as the chat shows it: without harness notices, nor the blocks the engine reads. */
function shownAnswer(node: ChatNode, value: unknown, run?: ChatRun): string {
  let text = withoutHarnessNotices(textOf(value));
  if (run?.solo && node.role === "planner") text = withoutSoloBlock(text);
  if (REVIEW_CARD_ROLES.has(node.role)) text = withoutReworkBlock(text);
  return text;
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
        const partial = shownAnswer(node, node.receipt.answer, run);
        messages.push({ kind: "agent", key, role: node.role, name, text: [node.receipt.error, partial ? `Partial work:\n${partial}` : ""].filter(Boolean).join("\n\n"), tone: "error", ...detail });
      } else if (node.state === "finished" && node.receipt?.answer) {
        messages.push({
          kind: "agent", key, role: node.role, name,
          text: shownAnswer(node, node.receipt.answer, run),
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
  working?: { detail: string; stalled: boolean; activity?: string; timeline?: ChatLiveItem[]; heardAtMs?: number };
  startedAtMs?: number;
  /** The card ran in an AO session, so its finished work can be read back (turn_timeline). */
  hasWork?: boolean;
  /** Its earlier rounds (a reviewer's cycles, a retried card's attempts), oldest first, shown folded. */
  earlier?: ChatStepRound[];
};
export type ChatStepRound = { label: string; text: string; verdict?: string };

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
  nodes: { state: string; receipt?: { error?: string | null; started_at_ms?: number | null } | null; history?: unknown[] }[];
};

/**
 * A restart resumes only work that was going on recently. On 2026-10-20 a restart revived an
 * 11-day-old test mission (its reviewer was still "pending" from Oct 9): its workers re-ran and the
 * chat said "Working for 264h". A run whose newest card start (current or earlier attempt) is older
 * than this was abandoned, not interrupted.
 */
export const RESTART_RESUME_WINDOW_MS = 24 * 60 * 60_000;
// The main process's own bounds (agent-orchestrator-workflow.cjs): a step a restart interrupted runs
// until it has this many attempts (RESTART_HISTORY_LIMIT), any other failed step until this many
// (AUTO_RETRY_LIMIT), and a sign-in or account-pool failure is never retried (POOL_EXHAUSTED).
const RESTART_ATTEMPT_LIMIT = 8;
const AUTO_RETRY_ATTEMPT_LIMIT = 3;
const NEEDS_PERSON = /auth_unavailable|invalid[_ -]?auth|account[^\n]*(?:exhaust|unavail)|pool[^\n]*exhaust|sign[- ]?in|reauth|HTTP (?:401|403)/i;

/** The newest time any card of the run started, current receipts and earlier attempts alike (0: none). */
function newestStart(mission: ResumeCandidate): number {
  let newest = 0;
  for (const node of mission.nodes) {
    newest = Math.max(newest, Number(node.receipt?.started_at_ms) || 0);
    for (const entry of node.history ?? []) {
      newest = Math.max(newest, Number((entry as { started_at_ms?: unknown } | null)?.started_at_ms) || 0);
    }
  }
  return newest;
}

/**
 * How a chat that no loop in this app session is driving picks up after an app restart, or null
 * when it waits for the person. "retry": a step ended only because the app (and AO with it)
 * restarted mid-turn. "continue": work is left, a card still running on an agent host that
 * outlived the app or cards that never started; the run's own loop then drives them, and a
 * team's loop recovers its interrupted workers itself. Teams resume too: before, re-entering a
 * project after a restart left a team chat stuck with its next cards never started.
 */
export function restartResume(mission: ResumeCandidate, now = Date.now(), { autoRetry = false }: { autoRetry?: boolean } = {}): "retry" | "continue" | null {
  // A chat stopped or paused on purpose stays that way.
  if (mission.cancelled || mission.paused) return null;
  // Abandoned long ago, not interrupted by this restart. A run whose cards never started has no
  // age to judge by and still resumes.
  const newest = newestStart(mission);
  if (newest && now - newest > RESTART_RESUME_WINDOW_MS) return null;
  const restarted = mission.nodes.filter(node => ["held", "failed"].includes(node.state)
    && RESTART_INTERRUPTED.test(String(node.receipt?.error || "")));
  // With "Retry automatically" on, a single chat's failed step is retried whether or not a loop of
  // this app session saw it fail: its loop had ended (an app restart, or a launch that failed past
  // it) and the card sat "held" for hours with the switch on. The same budget and exception as the
  // loop's own retry: three attempts, and a sign-in or account-pool failure waits for the person.
  const autoRetried = autoRetry && mission.execution_mode === "single" ? mission.nodes.filter(node => node.state === "held"
    && !restarted.includes(node) && !NEEDS_PERSON.test(String(node.receipt?.error || ""))) : [];
  // Held for any other reason (an approval, a failure to inspect) is the person's call; a reserved
  // card is mid-launch and a start would refuse it.
  if (mission.nodes.some(node => node.state === "reserved"
    || (node.state === "held" && !restarted.includes(node) && !autoRetried.includes(node)))) return null;
  // Within the attempt budget, so an agent that brings the app down each time is not restarted forever.
  if (restarted.length || autoRetried.length) {
    return restarted.every(node => (node.history?.length ?? 0) < RESTART_ATTEMPT_LIMIT)
      && autoRetried.every(node => (node.history?.length ?? 0) < AUTO_RETRY_ATTEMPT_LIMIT) ? "retry" : null;
  }
  return mission.nodes.some(node => ["running", "pending"].includes(node.state)) ? "continue" : null;
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

/** Text for a value that should be a string: a message field of an object, or its JSON. */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof (value as { message?: unknown }).message === "string") return (value as { message: string }).message;
  try { return typeof value === "object" ? JSON.stringify(value) : String(value); } catch { return String(value); }
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
  // The receipt comes from the service as saved; anything but text there (an error object, a
  // number) is shown as text, since rendering it as is or calling string methods on it threw.
  const error = textOf(node.receipt?.error), answer = shownAnswer(node, node.receipt?.answer, run), verdict = textOf(node.receipt?.verdict);
  if (error) step.error = error;
  if (answer) step.text = answer;
  if (verdict) step.verdict = verdict;
  // Only a card whose reply is the one being acted on copies its earlier reply up: a single chat's
  // card (it answers the message) and a reviewer (the workers redo what it asked). A team worker's
  // earlier reports stay folded under their attempts: a failed worker opens on its error, and it
  // opened on a whole earlier report under "Earlier attempt:" with no attempt it belonged to.
  const copiesEarlier = REVIEW_CARD_ROLES.has(node.role) || run.execution_mode === "single" || Boolean(run.solo);
  if (node.state === "running" || node.state === "reserved") {
    const live = options.activity?.[key];
    const working = chatWorkingDetail(node, live, now);
    const timeline = liveTimeline(key, live);
    // A request nobody has answered yet holds the card: it said "working" or its last tool meanwhile.
    const newest = timeline.at(-1);
    const asking = newest?.kind === "approval" && /pending|waiting/i.test(newest.status);
    step.working = { ...working, ...(asking ? { activity: "waiting for approval" } : live?.activity ? { activity: textOf(live.activity) } : {}),
      ...(timeline.length ? { timeline } : {}) };
    // A retried card's new attempt starts empty; until it writes, its earlier reply stays readable.
    const earlier = copiesEarlier ? latestHistoryAnswer(node) : undefined;
    if (!step.text && earlier && !timeline.some((item) => item.kind === "message")) {
      step.text = `${earlierLabel(node)}\n\n${earlier}`;
    }
  } else if (!step.text && node.state !== "finished" && copiesEarlier) {
    // A review that sent the work back resets the reviewer to pending for its next round, and its
    // verdict moves to history. The chat showed nothing for it: the latest response, the one the
    // workers are now acting on, vanished until the reviewer answered again.
    const earlier = latestHistoryAnswer(node);
    if (earlier) step.text = `${earlierLabel(node)}\n\n${earlier}`;
  }
  const rounds = earlierRounds(node, Boolean(step.text?.startsWith(earlierLabel(node))));
  if (rounds.length) step.earlier = rounds;
  return step;
}

const REVIEW_CARD_ROLES = new Set<ChatNode["role"]>(["reviewer", "approver", "sub_reviewer"]);
/**
 * A card's earlier rounds, oldest first: a reviewer's past cycles (each verdict and why), a retried
 * card's past attempts. Only the newest was ever shown ("Last review:"), and only until the card
 * answered again, so how a review got where it is could not be followed. `shownLatest` leaves out
 * the newest answered round when the step's own text already shows it.
 */
export function earlierRounds(node: ChatNode, shownLatest = false): ChatStepRound[] {
  const history = Array.isArray(node.history) ? node.history : [];
  let latestAnswered = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) if (shownAnswer(node, history[index]?.answer).trim()) { latestAnswered = index; break; }
  const noun = REVIEW_CARD_ROLES.has(node.role) ? "Cycle" : "Attempt";
  return history.flatMap((entry, index) => {
    const answer = shownAnswer(node, entry?.answer).trim(), error = textOf(entry?.error).trim();
    const text = answer || error;
    if (!text || (shownLatest && index === latestAnswered)) return [];
    // A round that answered and then failed (the answer kept, the error set) still failed.
    const verdict = textOf(entry?.verdict) || (error ? "failed" : undefined);
    return [{ label: `${noun} ${index + 1}`, text, ...(verdict ? { verdict } : {}) }];
  });
}

/** The newest answer a card gave in an earlier attempt or round (a retry or rework moves it to history). */
function latestHistoryAnswer(node: ChatNode): string | undefined {
  const history = Array.isArray(node.history) ? node.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const answer = shownAnswer(node, history[index]?.answer).trim();
    if (answer) return answer;
  }
  return undefined;
}

const earlierLabel = (node: ChatNode) => (node.role === "reviewer" || node.role === "approver" || node.role === "sub_reviewer" ? "Last review:" : "Earlier attempt:");

/** A DeepSeek model, whose turns show as DeepSeek Harness (dsh) shows them. */
export const isDeepSeekModel = (model?: string | null) => /deepseek/i.test(model ?? "");

// DeepSeek Harness (deepseek-ai/deepseek-harness, packages/client/ui-chat and ui-tool) words and
// groups a turn's work as below; the labels are its English locale's, unchanged.

/** A work kind as DeepSeek Harness ranks a group's work (process-activity.ts). */
export type DshActivity = "read" | "readImage" | "search" | "write" | "edit" | "commands" | "code"
  | "webSearch" | "webFetch" | "subagents" | "plan" | "questions" | "tools";

/** The tool a row names, without an MCP server prefix: "mcp__coding-tools__read_file" → "read_file". */
export const dshToolName = (item: ChatLiveItem) => (item.label || item.text || "").replace(/^mcp__[\w-]+__/, "").trim().split(/\s/)[0].toLowerCase();

/** DeepSeek Harness's activity for a tool, extended to the app's MCP tools and AO's own kinds. */
export function dshActivity(item: ChatLiveItem): DshActivity {
  if (item.kind === "command") return "commands";
  if (item.kind === "edit") return "edit";
  const name = dshToolName(item);
  if (["read", "read_file", "view", "cat", "open_file"].includes(name)) return "read";
  if (name === "read_image" || name === "view_image") return "readImage";
  if (["grep", "glob", "rg", "find", "search", "list_dir", "ls", "search_text", "search_files", "find_files"].includes(name)
    || name.endsWith("_inspect") || name.startsWith("search_")) return "search";
  if (["write", "write_file", "create_file"].includes(name)) return "write";
  if (["edit", "apply_patch", "edit_file", "str_replace", "multi_edit", "multiedit"].includes(name)) return "edit";
  if (["bash", "pwsh", "shell", "exec_command", "write_stdin", "read_output", "kill_command"].includes(name)
    || name.startsWith("terminal_")) return "commands";
  if (name === "run_code") return "code";
  if (name === "web_search") return "webSearch";
  if (name === "web_fetch" || name === "fetch") return "webFetch";
  if (name === "subagent" || name.startsWith("subagent_") || name === "task" || name === "agent") return "subagents";
  if (["todo_write", "todowrite", "update_plan", "create_goal", "update_goal", "get_goal"].includes(name)) return "plan";
  if (["ask_user_question", "request_user_input", "askuserquestion"].includes(name)) return "questions";
  return "tools";
}

const DSH_DONE: Record<DshActivity, string> = {
  read: "Read files", readImage: "Read images", write: "Wrote files", search: "Searched code", edit: "Edited files",
  commands: "Ran commands", code: "Ran code", webSearch: "Searched the web", webFetch: "Visited web pages",
  subagents: "Coordinated subagents", plan: "Updated the plan", questions: "Asked questions", tools: "Called tools",
};
const DSH_NOW: Record<DshActivity | "thinking", string> = {
  thinking: "Analyzing the request", read: "Reading files", readImage: "Reading images", write: "Writing files",
  search: "Searching code", edit: "Editing files", commands: "Running commands", code: "Running code",
  webSearch: "Searching the web", webFetch: "Visiting web pages", subagents: "Coordinating subagents",
  plan: "Updating the plan", questions: "Waiting for your action", tools: "Calling tools",
};
const DSH_WORK = new Set(["tool", "command", "edit"]);
const DSH_DETAIL_MAX = 160;

/** A row's one-line detail, at most 160 characters (DeepSeek Harness's live detail bound). */
function dshDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= DSH_DETAIL_MAX ? flat : `${flat.slice(0, DSH_DETAIL_MAX - 1).trimEnd()}…`;
}

/**
 * A finished group's heading (step-process.ts): its top three kinds of work by number of calls,
 * ties in order of first appearance, without counts: "Ran commands", "Read files and ran
 * commands", "Ran commands, read files, edited files", then ", etc." past three. A group that
 * only thought reads "Analysis completed".
 */
export function dshProcessTitle(items: ChatLiveItem[]): string {
  const counts = new Map<DshActivity, number>();
  for (const item of items) {
    if (!DSH_WORK.has(item.kind)) continue;
    const kind = dshActivity(item);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // Array.prototype.sort is stable, so equal counts keep their first-appearance order.
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([kind]) => kind);
  const labels = ranked.slice(0, 3).map((kind) => DSH_DONE[kind]);
  if (!labels.length) return "Analysis completed";
  const continuation = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${continuation(labels[1])}`;
  const title = [labels[0], ...labels.slice(1).map(continuation)].join(", ");
  return ranked.length > 3 ? `${title}, etc.` : title;
}

/** What a row's detail is: the agent's own words, else its command, path or query. */
export function dshItemDetail(item: ChatLiveItem): string {
  if (item.description) return dshDetail(item.description);
  if (item.kind === "edit") return dshDetail((item.files ?? []).map((file) => file.path).join(", "));
  try {
    const args = item.input ? JSON.parse(item.input) as Record<string, unknown> : {};
    for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "prompt", "description"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return dshDetail(value);
    }
  } catch { /* arguments that are not JSON fall back to the row's own text */ }
  return dshDetail(item.kind === "command" ? item.text : dshToolName(item) || item.text);
}

/**
 * A running group's heading (ChatGroupSeat's live title): what its newest unfinished call does and
 * that call's detail, "Running commands · npm test"; with no call running, its latest thought,
 * "Analyzing the request · <the thought's last paragraph>".
 */
export function dshLiveTitle(items: ChatLiveItem[]): { activity: DshActivity | "thinking"; label: string } {
  const running = [...items].reverse().find((item) => DSH_WORK.has(item.kind) && !/complet|done|success|fail|error|reject|denied|cancel/i.test(item.status));
  // A request nobody has answered holds the turn: say so, not "Running" or "Analyzing" (a DeepSeek
  // chat waited 85 minutes on one while its title said it was still working).
  if (items.at(-1)?.kind === "approval" && /pending|waiting/i.test(items.at(-1)!.status)) {
    const detail = running ? dshItemDetail(running) : "";
    return { activity: "questions", label: detail ? `Waiting for approval · ${detail}` : "Waiting for approval" };
  }
  if (running) {
    const activity = dshActivity(running);
    const detail = dshItemDetail(running);
    return { activity, label: detail ? `${DSH_NOW[activity]} · ${detail}` : DSH_NOW[activity] };
  }
  const thought = [...items].reverse().find((item) => item.kind === "reasoning" && item.text.trim());
  const paragraph = thought?.text.split(/\r?\n[\t ]*\r?\n/).map((part) => dshDetail(part.replaceAll("**", ""))).filter(Boolean).at(-1) ?? "";
  return { activity: "thinking", label: paragraph ? `${DSH_NOW.thinking} · ${paragraph}` : DSH_NOW.thinking };
}

/**
 * A Think row's one line (ReasoningRow.tsx): a finished thought's first line; a streaming one's
 * newest completed paragraph's first line, so the line advances a paragraph at a time. `**` dropped.
 */
export function dshThinkSummary(text: string, running: boolean): string {
  const firstLine = (value: string) => { const newline = value.indexOf("\n"); return newline === -1 ? value : value.slice(0, newline); };
  if (!running) return firstLine(text).replaceAll("**", "").trim();
  let summary = "";
  let start = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  for (;;) {
    const next = separator.exec(text);
    const end = next === null ? text.length : next.index + next[0].indexOf("\n");
    const newline = text.indexOf("\n", start);
    if (newline !== -1 && newline <= end) {
      const candidate = text.slice(start, newline).trim();
      if (candidate) summary = candidate;
    }
    if (next === null) return summary.replaceAll("**", "");
    start = next.index + next[0].length;
  }
}

/** A run's length as DeepSeek Harness writes it: "4s", "1m 4s", "1h 2m 4s"; never under a second. */
export function dshDuration(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return `${hours ? `${hours}h ` : ""}${total >= 60 ? `${minutes}m ` : ""}${total % 60}s`;
}

/**
 * What a running turn's "Deep diving" line adds once the turn has gone quiet: nothing for the first
 * minute, "quiet for 3m 2s" after, and a plain "may be stuck" once it has been quiet as long as a
 * stuck card (STALL_MS). A long model request can be silent for minutes; without this the turn
 * looked frozen.
 */
export function dshQuietNote(heardAtMs: number | undefined, now: number): string {
  const quiet = heardAtMs ? now - heardAtMs : 0;
  if (quiet >= STALL_MS) return ` · nothing new for ${dshDuration(quiet)}, may be stuck`;
  return quiet >= 60_000 ? ` · quiet for ${dshDuration(quiet)}` : "";
}

/**
 * Why a running turn is quiet when the agent is waiting out a model error: Claude Code's own notice
 * ("Retrying Claude, attempt 8 of 10. API error 429. Trying again in 38.6s.") as the newest thing a
 * working card did. Seen live: a rate-limited chat said only "nothing new for 10m, may be stuck"
 * while Claude Code was backing off from 429s, so it looked hung. Empty when no card is retrying.
 */
export function dshRetryNote(steps: ChatStep[]): string {
  for (const step of steps) {
    const items = step.working?.timeline ?? [];
    const last = items[items.length - 1];
    if (!last || last.kind !== "system" || last.status !== "running" || !/^Retrying\b/i.test(last.text)) continue;
    const attempt = last.text.match(/attempt (\d+) of (\d+)/i);
    const status = last.text.match(/API error (\d{3})/i)?.[1];
    const why = status === "429" ? "the model is rate-limited (429)" : status ? `the model's service is failing (${status})` : "the model request failed";
    return ` · ${why}, retrying${attempt ? ` (${attempt[1]} of ${attempt[2]})` : ""}`;
  }
  return "";
}

/** A tool row's title (ui-tool tool-call-model.ts): its variant's word, or the tool's own. */
export function dshToolTitle(item: ChatLiveItem): string {
  const name = dshToolName(item);
  if (item.kind === "command") return "Bash";
  if (name === "pwsh") return "Pwsh";
  if (name === "read_image" || name === "view_image") return "Read image";
  if (name === "web_fetch" || name === "fetch") return "Fetch";
  const activity = dshActivity(item);
  return ({ read: "Read", search: "Search", webSearch: "Search", write: "Write", edit: "Edit", commands: "Bash", code: "Code" } as Partial<Record<DshActivity, string>>)[activity] ?? "Tool call";
}

/**
 * A turn's work as DeepSeek Harness lays it out (process-groups.ts): thinking and tool calls run
 * together into one process group, and a reply or a message the user steered in stands on its own
 * between groups.
 */
export function dshSegments(items: ChatLiveItem[]): ChatLiveSegment[] {
  const segments: ChatLiveSegment[] = [];
  for (const item of items) {
    const last = segments.at(-1);
    if (item.kind === "message" || item.kind === "steer") segments.push({ kind: "item", item });
    else if (last?.kind === "group") last.items.push(item);
    else segments.push({ kind: "group", key: item.id, items: [item] });
  }
  return segments;
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
      // A pending card shows once it has done something: a receipt, or an earlier round's answer.
      .filter((node) => node.state !== "pending" || node.receipt || earlierRounds(node).length)
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
    if (turn.user) parts.push(`**You:**\n\n${chatMessageReadable(turn.user.text)}`);
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
  /** The evaluator's last "not met yet" reason: what the running round was told to do. */
  feedback?: string;
};
/**
 * The line the goal bar shows under its state: the state's own note (why it stalled, what was
 * achieved), else, while it is pursued, why the last check said it is not met yet.
 */
export function goalDetail(goal: Pick<ChatGoal, "status" | "note" | "feedback">): string {
  if (goal.note) return goal.note;
  return goal.status === "active" && goal.feedback ? `Not met yet: ${goal.feedback}` : "";
}
/** A chat's pending wake-up (its agent's schedule_wakeup), as the bridge keeps it. */
export type ChatWakeup = { id: string; minutes: number; reason: string; scheduledAt: number; dueAt: number; due?: boolean };
/** 42_000 -> "Wakes in 42s"; 185_000 -> "Wakes in 3m"; 10_680_000 -> "Wakes in 2h 58m"; a due one waits for its turn to end. */
export function wakeupLabel(wakeup: Pick<ChatWakeup, "dueAt" | "due">, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((wakeup.dueAt - now) / 1000));
  if (wakeup.due || !seconds) return "Waking after this turn";
  return `Wakes in ${seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.ceil(seconds / 60)}m`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`}`;
}
/** Codex's goal summary words for each state. */
export const GOAL_SUMMARY: Record<ChatGoal["status"], string> = {
  active: "Pursuing goal", paused: "Paused goal", achieved: "Goal achieved", stalled: "Goal stalled", limited: "Goal limited",
};
/** "3 of 30" for a goal with a round limit (Single 30, team 10), "3" for one without. */
export function goalRounds(goal: Pick<ChatGoal, "round" | "rounds">): string {
  return goal.rounds > 0 ? `${goal.round} of ${goal.rounds}` : String(goal.round);
}
/** Something typed while a chat's turn runs, sent when the turn finishes: a message, or a command's message. */
export type QueuedChatMessage = { what: string; message: string; goal?: string };
/**
 * Adds to one chat's queue. A plain message joins a plain message queued just before it (they are
 * sent together); anything else (a command, a goal) waits for a turn of its own. Nothing is replaced.
 */
export function chatQueueAdd(queue: QueuedChatMessage[], item: QueuedChatMessage): QueuedChatMessage[] {
  const last = queue[queue.length - 1];
  if (last && item.what === "Message" && last.what === "Message") {
    // Annotated messages join into one block, numbered across both: two blocks each counting from 1
    // read as one set of annotations to the agent, and the second showed raw in the chat.
    const before = chatAnnotationsSplit(last.message), after = chatAnnotationsSplit(item.message);
    const message = chatMessageWithAnnotations([before.rest.trim(), after.rest.trim()].filter(Boolean).join("\n\n"),
      [...before.annotations, ...after.annotations]);
    if (message.length <= CHAT_MESSAGE_LIMIT) return [...queue.slice(0, -1), { ...last, message }];
  }
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
  /** The wake-up the chat's agent asked for (schedule_wakeup), and cancelling it. */
  wakeup?: ChatWakeup | null;
  cancelWakeup?: () => Promise<void>;
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
/** A sent message's attachment, as chatMessageWithAttachments wrote it. */
export type ChatSentAttachment = { image: boolean; name: string; path?: string };

/** Text selected in an earlier answer and added to the chat, with the person's optional comment. */
export type ChatAnnotation = { text: string; comment: string };
// Codex's own wording for response annotations (its prompt builder), so an agent reads them as it
// would from Codex: numbered selections, each comment addressed, cited inline by number.
const ANNOTATIONS_HEAD = "# Response annotations:";
const ANNOTATIONS_RULE = "Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as "
  + "Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation "
  + "you address, include its inline directive `:codex-annotation{index=\"N\"}`, where N is its one-based array position (for example, "
  + "`:codex-annotation{index=\"1\"}`). Do not use unstructured annotation labels.";
const ANNOTATIONS_BLOCK = /^# Response annotations:\n[^\n]*\n<response-annotations>\n([^\n]*)\n<\/response-annotations>\n*/;

/** The longest message the chat sends (chat_send keeps 8,192 characters and refuses more). */
export const CHAT_MESSAGE_LIMIT = 8192;

/** The message with its annotations in front, as Codex sends them. */
export function chatMessageWithAnnotations(message: string, annotations: ChatAnnotation[]): string {
  if (!annotations.length) return message;
  const items = JSON.stringify(annotations.map((item) => ({ text: item.text, annotation: item.comment, source: "chat-response" })));
  return `${ANNOTATIONS_HEAD}\n${ANNOTATIONS_RULE}\n<response-annotations>\n${items}\n</response-annotations>\n\n${message}`.trimEnd();
}

/** A message's leading annotation block, read back, and the rest of the message after it. */
export function chatAnnotationsSplit(message: string): { annotations: ChatAnnotation[]; rest: string } {
  const block = ANNOTATIONS_BLOCK.exec(message);
  if (!block) return { annotations: [], rest: message };
  try {
    const items: unknown = JSON.parse(block[1]);
    if (!Array.isArray(items)) return { annotations: [], rest: message };
    const annotations = items.filter((item): item is { text: string; annotation?: string } => typeof item?.text === "string")
      .map((item) => ({ text: item.text, comment: typeof item.annotation === "string" ? item.annotation : "" }));
    return { annotations, rest: message.slice(block[0].length) };
  } catch { return { annotations: [], rest: message }; }
}

/**
 * A sent message as a person reads it: its annotations as quoted lines instead of the block the
 * agent reads. For copying, exporting, and putting a message back in a chat box (rewind, continue).
 */
export function chatMessageReadable(message: string): string {
  const { annotations, rest } = chatAnnotationsSplit(message);
  if (!annotations.length) return message;
  const lines = annotations.map((item, index) => `${index + 1}. "${item.text.replace(/\s+/g, " ")}"${item.comment ? ` — ${item.comment}` : ""}`);
  return [`Annotations:\n${lines.join("\n")}`, rest.trim()].filter(Boolean).join("\n\n");
}

/**
 * A sent message split back into what the person typed and what they attached, so the chat shows
 * the attachments as cards and image thumbnails (as Claude Code does) instead of their paths, and
 * its annotations as a chip instead of the block the agent reads.
 */
export function chatMessageParts(message: string): { text: string; attachments: ChatSentAttachment[]; annotations?: ChatAnnotation[] } {
  const attachments: ChatSentAttachment[] = [];
  const name = (file: string) => file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || file;
  const split = chatAnnotationsSplit(message);
  const annotations = split.annotations.length ? split.annotations : undefined;
  message = split.rest;
  const text = message
    .replace(/(^|\n)Attached file `([^`\n]+)`:\n```\n[\s\S]*?\n```(?=\n|$)/g, (_match, lead: string, file: string) => {
      attachments.push({ image: false, name: file });
      return lead;
    })
    .replace(/(^|\n)Attached (image|file): ([^\n]+)(?=\n|$)/g, (_match, lead: string, kind: string, file: string) => {
      attachments.push({ image: kind === "image", name: name(file.trim()), path: file.trim() });
      return lead;
    })
    .trim();
  return annotations?.length ? { text, attachments, annotations } : { text, attachments };
}

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
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Caret, Icon } from "../icons";
import { AgentOrchestratorComposerControls, type ComposerControlsProps } from "./AgentOrchestratorComposerControls";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AgentOrchestratorApproval, type AoApproval as ChatApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatWorkbench, useWorkbenchAutoOpen, type WorkbenchTab } from "./ChatWorkbench";
import { ChatBranchBar } from "./ChatBranchBar";
import { ChatContextMeter } from "./ChatContextMeter";
import { ChatTurnStats } from "./ChatTurnStats";
import { INIT_PROMPT, planMessage, reviewPrompt } from "./codex-prompts";
import { ChatGlyph, ChatMenu, FloatingLayer, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
import {
  CHAT_DEFAULT_TITLE, GOAL_SUMMARY, chatAcceptsMessage, chatDuration, chatList, chatMessageWithAttachments, chatRunOpen,
  chatAgentSessions, chatAgentSummary, chatApprovalMode, chatQueueAdd, chatRunsOfMessage, chatSlashMatches, chatSlashParse, chatSlashTyping, chatTurns, goalElapsed,
  type QueuedChatMessage, type ChatCommandCard, type ChatCommands, type ChatActivity, type ChatAttachment, type ChatLiveItem, type ChatNode, type ChatRun, type ChatStatus, type ChatStep, type ChatTurn,
  activitySummary, groupTimeline, tidyTimeline,
} from "./ao-chat";

export { ChatThreadList as ChatListPane } from "./ChatThreadList";

const STATUS_LABEL: Record<ChatStatus, string> = {
  queued: "Starting", scheduled: "Scheduled", running: "Running", paused: "Paused", attention: "Needs you", stopped: "Stopped", done: "Done",
};
/** Text files up to this size are attached inline when their path is unknown. */
const INLINE_ATTACHMENT_BYTES = 200 * 1024;
/**
 * Each chat's queued messages (task id → queue), kept for the app's lifetime outside the chat view so
 * they survive the view closing (another page, the board) and switching chats.
 */
const CHAT_QUEUES = new Map<string, QueuedChatMessage[]>();
/** Each chat's unsent draft (task id → text; "" is the new-chat composer), kept while another chat is open. */
const CHAT_DRAFTS = new Map<string, string>();
/** The cards panel's dragged width (px), kept on this computer. */
const CARDS_WIDTH_KEY = "coding-tools:ao:cards-panel-width";

/** Thread actions the chat header, its ⋯ menu and its slash commands share with the thread list. */
export type ChatThreadActions = {
  newChat: () => void;
  rename: (title: string) => Promise<void>;
  archive: () => void;
  /** Fork from here: a new chat with the messages up to this one (its index in the chat's messages). */
  fork: (messageIndex?: number) => void;
  /** Rewind: a new chat with the messages before this one, this message ready to edit. */
  rewind?: (messageIndex: number) => void;
  /**
   * Delete a message and its reply from the chat (asked to confirm first). `runIds` are the runs
   * its turn showed: the run it started first, then any restart or replacement of that run.
   */
  deleteMessage?: (messageIndex: number, runIds: string[]) => Promise<void>;
  copyConversation: () => void;
  togglePin: () => void;
  pinned: boolean;
};

/**
 * How long since `since`, counting up once a second by itself while `live`: only this label
 * re-renders on a tick, never the transcript around it. Stopped, it holds at `until`.
 */
function Elapsed({ since, live = true, until, format = chatDuration }: { since: number; live?: boolean; until?: number; format?: (ms: number) => string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return <>{format((live ? now : until ?? now) - since)}</>;
}

function stepTone(step: ChatStep): string {
  if (step.error) return "error";
  if (step.working) return step.working.stalled ? "stalled" : "working";
  return step.state;
}

/**
 * The model's reasoning summary, as Codex shows it: its first line (a short bold title such as
 * "**Inspecting the register route**") as one progress line, the rest a click away.
 */
function ReasoningItem({ item }: { item: ChatLiveItem }) {
  const lines = item.text.trim().split(/\r?\n/);
  if (!lines[0]) return <span className="cx-live-label">{item.status === "running" ? "Thinking…" : "Thought"}</span>;
  const label = item.status === "running" ? "Thinking" : "Thought";
  const headline = lines[0].replace(/^\s*\*\*(.+?)\*\*\s*$/, "$1").replace(/[*_`]/g, "").trim();
  // A model that thinks in one long paragraph shows it as one line, the whole of it a click away.
  const rest = lines.slice(1).join("\n").trim() || (headline.length > 140 ? headline : "");
  return rest
    ? <details className="cx-reasoning"><summary><span className="cx-live-label">{label}</span><span className="cx-live-text">{headline}</span></summary>
      <div className="cx-reasoning-body"><ChatMarkdown text={rest} /></div></details>
    : <><span className="cx-live-label">{label}</span><span className="cx-live-text">{headline}</span></>;
}

/**
 * The one line a tool call's row shows next to its name (Claude Code's "Read(src/app.ts)" line).
 * `item.text` is the command for a shell call and AO's summary (the tool's name) for any other;
 * `description` is the agent's own words for what the call is for, when it gave them.
 */
function toolHeadline(item: ChatLiveItem): string {
  // The agent's own words say what the call is for; the command itself is one click away.
  if (item.description) return item.description;
  return item.text.replace(/^mcp__[\w-]+__/, "").replace(/\s+/g, " ").trim();
}

/** How a tool call ended, for its dot: AO's activity status, "pending" while it waits on approval. */
function toolTone(status: string): "ok" | "failed" | "running" {
  if (/fail|error|reject|denied|cancel/i.test(status)) return "failed";
  return /complet|done|success/i.test(status) ? "ok" : "running";
}

/** A tool call as Claude Code shows it: a dot, its name and one line, opening on what it ran and got back. */
function ToolItem({ item }: { item: ChatLiveItem }) {
  const tone = toolTone(item.status);
  const name = item.kind === "command" ? (tone === "running" ? "Running" : "Ran") : item.label ?? item.kind.replace(/_/g, " ");
  const head = <><span className="cx-tool-dot" aria-hidden="true" /><span className="cx-live-label">{name}</span>
    <span className="cx-live-text">{toolHeadline(item)}</span>{item.count && item.count > 1 ? <span className="cx-tool-count">×{item.count}</span> : null}</>;
  const opens = item.kind === "command" || item.input || item.output;
  return opens
    ? <details className={`cx-tool tone-${tone}`}><summary>{head}</summary>
      <div className="cx-tool-body">
        {item.kind === "command" ? <pre className="cx-tool-io"><code>{item.text}</code></pre> : null}
        {item.input ? <pre className="cx-tool-io"><code>{item.input}</code></pre> : null}
        {item.output ? <pre className="cx-tool-io is-output"><code>{item.output}</code></pre>
          : tone === "running" ? null : <p className="cx-tool-empty">No output</p>}
      </div></details>
    : <div className={`cx-tool tone-${tone}`}><div className="cx-tool-row">{head}</div></div>;
}

const fileName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** "+12 −3", green and red, as Claude Code counts an edit. */
function DiffCount({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="cx-diff-count"><span className="is-add">+{additions}</span> <span className="is-del">−{deletions}</span></span>;
}

/** A file edit as Claude Code shows one: "Edited <file> +12 −3", opening on the changed lines. */
function EditItem({ item }: { item: ChatLiveItem }) {
  const files = item.files ?? [];
  const tone = toolTone(item.status);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const head = <><span className="cx-tool-dot" aria-hidden="true" /><span className="cx-live-label">{item.label ?? "Edited"}</span>
    <span className="cx-live-text" title={files.map((file) => file.path).join("\n")}>{files.length === 1 ? fileName(files[0].path) : `${files.length} files`}</span>
    <DiffCount additions={additions} deletions={deletions} /></>;
  if (!files.some((file) => file.diff)) return <div className={`cx-tool tone-${tone}`}><div className="cx-tool-row">{head}</div></div>;
  return <details className={`cx-tool cx-edit tone-${tone}`}><summary>{head}</summary>
    <div className="cx-tool-body">
      {files.map((file) => <section key={file.path} className="cx-edit-file">
        {files.length > 1 ? <header><span title={file.path}>{fileName(file.path)}</span><DiffCount additions={file.additions} deletions={file.deletions} /></header> : null}
        {file.diff ? <pre className="cx-diff"><code>{file.diff.split("\n").map((line, index) =>
          <span key={index} className={line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-del" : undefined}>{line}{"\n"}</span>)}</code></pre> : null}
      </section>)}
    </div></details>;
}

/** What a turn's work did, as Claude Code heads it: "Edited 2 files, ran a command" and the line counts. */
export function workSummary(items: ChatLiveItem[]): { text: string; additions: number; deletions: number } {
  const edits = items.filter((item) => item.kind === "edit");
  const files = new Set(edits.flatMap((item) => (item.files ?? []).map((file) => file.path)));
  const commands = items.filter((item) => item.kind === "command").length;
  const tools = items.filter((item) => item.kind === "tool").length;
  const parts = [
    files.size ? `edited ${files.size === 1 ? "a file" : `${files.size} files`}` : "",
    commands ? `ran ${commands === 1 ? "a command" : `${commands} commands`}` : "",
    tools ? `used ${tools === 1 ? "a tool" : `${tools} tools`}` : "",
  ].filter(Boolean);
  const text = parts.length ? parts.join(", ") : "Worked";
  return {
    text: text[0].toUpperCase() + text.slice(1),
    additions: edits.reduce((sum, item) => sum + (item.files ?? []).reduce((total, file) => total + file.additions, 0), 0),
    deletions: edits.reduce((sum, item) => sum + (item.files ?? []).reduce((total, file) => total + file.deletions, 0), 0),
  };
}

/** Compact activity: runs of tool calls and thinking fold into one line each (the chat's toggle). */
export const CompactActivity = createContext(true);
export const COMPACT_ACTIVITY_KEY = "coding-tools:ao:compact-activity";

/** A row redraws only when what it shows changed: a poll rebuilds every item object each second. */
const sameLiveItem = (a: ChatLiveItem, b: ChatLiveItem) => a === b || (a.id === b.id && a.kind === b.kind && a.status === b.status
  && a.text === b.text && a.label === b.label && a.description === b.description && a.count === b.count
  && a.input === b.input && a.output === b.output && a.files === b.files);
const LiveRow = memo(LiveRowView, (prev, next) => sameLiveItem(prev.item, next.item));

function LiveRowView({ item }: { item: ChatLiveItem }) {
  return <li className={`cx-live-item kind-${item.kind} is-${item.status || "done"}`}>
    {item.kind === "steer" ? <div className="cx-user cx-steer"><div className="cx-bubble"><p>{item.text}</p></div></div>
      : item.kind === "message" ? <ChatMarkdown text={item.text} />
      : item.kind === "reasoning" ? <ReasoningItem item={item} />
      : item.kind === "edit" ? <EditItem item={item} />
      : item.kind === "command" || item.kind === "tool" ? <ToolItem item={item} />
      : <><span className="cx-live-label">{item.label ?? item.kind.replace(/_/g, " ")}</span><span className="cx-live-text">{item.text}</span></>}
  </li>;
}

/**
 * A run of tool calls and thinking as one line, as Codex, Cursor and Claude Code fold them:
 * "Explored · Ran a command, read_output ×7 · 3 thoughts". While the agent is in it, its latest
 * step shows underneath; a click opens every step.
 */
function ActivityGroup({ items, live }: { items: ChatLiveItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = items[items.length - 1];
  return <div className={`cx-group${live ? " is-live" : ""}`}>
    <button type="button" className="cx-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="chevron" width="11" height="11" className={open ? "is-open" : undefined} />
      <span className={`cx-group-verb${live ? " cx-shimmer" : ""}`}>{live ? "Working" : "Explored"}</span>
      <span className="cx-group-text">{activitySummary(items)}</span>
    </button>
    {open ? <ol className="cx-live">{items.map((item) => <LiveRow key={item.id} item={item} />)}</ol>
      : live && latest ? <ol className="cx-live cx-group-now"><LiveRow item={latest} /></ol> : null}
  </div>;
}

/** A role's turn, as Codex and Claude Code show it: thinking, tool calls and streamed messages. */
function LiveTimeline({ items, live = false }: { items: ChatLiveItem[]; live?: boolean }) {
  const compact = useContext(CompactActivity);
  const tidy = tidyTimeline(items);
  if (!compact) return <ol className="cx-live">{tidy.map((item) => <LiveRow key={item.id} item={item} />)}</ol>;
  const segments = groupTimeline(tidy);
  return <ol className="cx-live is-compact">
    {segments.map((segment, index) => segment.kind === "item" ? <LiveRow key={segment.item.id} item={segment.item} />
      : <li key={segment.key} className="cx-live-item kind-group"><ActivityGroup items={segment.items} live={live && index === segments.length - 1} /></li>)}
  </ol>;
}

/**
 * Each card's work (step key → its turn's timeline), kept for the app's lifetime: the live timeline
 * is copied in while the card works, so its thinking and tool calls stay when the answer lands, and
 * a card finished before is read back from AO once, when its work is first opened.
 */
const CHAT_WORK = new Map<string, ChatLiveItem[]>();
type LoadWork = (runId: string, nodeId: string) => Promise<ChatLiveItem[]>;

function useStepWork(step: ChatStep, runId: string, wanted: boolean, loadWork?: LoadWork): ChatLiveItem[] | null {
  const live = step.working?.timeline;
  const [, setLoaded] = useState(0);
  if (live?.length) CHAT_WORK.set(step.key, live);
  const known = CHAT_WORK.get(step.key) ?? null;
  useEffect(() => {
    if (!wanted || known || !step.hasWork || !loadWork) return;
    let current = true;
    void loadWork(runId, step.nodeId).then((items) => {
      if (!items.length) return;
      CHAT_WORK.set(step.key, items);
      if (current) setLoaded((count) => count + 1);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [wanted, known, step.hasWork, step.key, step.nodeId, runId, loadWork]);
  return known;
}

function StepRow({ step, runId, loadWork }: { step: ChatStep; runId: string; loadWork?: LoadWork }) {
  // A failed step opens on its error and a working one on its live turn, as Codex shows them;
  // once the user toggles a row, their choice wins.
  const [chosen, setOpen] = useState<boolean | null>(null);
  const open = chosen ?? Boolean(step.error || step.working?.timeline?.length);
  const work = useStepWork(step, runId, open, loadWork);
  const compact = useContext(CompactActivity);
  const body = step.error || step.text || (work?.length || step.hasWork ? "work" : "");
  return <li className={`cx-step tone-${stepTone(step)}`}>
    <button type="button" className="cx-step-head" aria-expanded={open} disabled={!body && !step.working} onClick={() => setOpen(!open)}
      title={step.working?.detail || undefined}>
      <span className="cx-step-dot" aria-hidden="true" />
      <span className="cx-step-name">{step.name}</span>
      <span className="cx-step-meta">
        {step.working ? (step.working.stalled ? "may be stuck" : step.working.activity || "working") : step.error ? "failed" : step.verdict || (step.state === "finished" ? "done" : step.state)}
        {step.working && step.startedAtMs ? <> · <Elapsed since={step.startedAtMs} /></> : null}
      </span>
      {body ? <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} /> : null}
    </button>
    {open ? <div className="cx-step-body">
      {step.detail ? <p className="cx-step-detail">{step.detail}</p> : null}
      {step.working && !compact ? <p className="cx-step-detail">{step.working.detail}</p> : null}
      {work?.length ? <LiveTimeline items={work} live={Boolean(step.working)} /> : null}
      {/* A held or failed card keeps the reply it gave: the error says why, the reply stays readable. */}
      {step.error ? <p className="cx-step-error">{step.error}</p> : null}
      {step.text ? <ChatMarkdown text={step.text} /> : null}
    </div> : null}
  </li>;
}

/**
 * The work behind an answer that closes its turn itself (a single model's, a solo orchestrator's):
 * folded under "Worked" as Claude Code keeps it, its thinking and tool calls a click away.
 */
function AnswerWork({ step, runId, expanded, loadWork }: { step: ChatStep; runId: string; expanded: boolean; loadWork?: LoadWork }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? expanded;
  const work = useStepWork(step, runId, open, loadWork);
  if (!work?.length && !step.hasWork) return null;
  const summary = workSummary(work ?? []);
  return <div className="cx-work">
    <button type="button" className="cx-work-head" aria-expanded={open} onClick={() => setChosen(!open)}>
      <span>{summary.text}</span>
      {summary.additions || summary.deletions ? <DiffCount additions={summary.additions} deletions={summary.deletions} /> : null}
      <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} />
    </button>
    {open ? work?.length ? <LiveTimeline items={work} /> : <p className="cx-tool-empty">Loading…</p> : null}
  </div>;
}

type WorkGroupProps = { turn: ChatTurn; idle?: boolean; expanded?: boolean; loadWork?: LoadWork };

/** A turn still being worked on: its steps change on every update, so it always re-renders. */
const liveTurn = (turn: ChatTurn) => turn.status === "running" || turn.status === "queued"
  || turn.steps.some((step) => step.working) || Boolean(turn.final?.working);
const stepShape = (step: ChatStep) => [step.key, step.name, step.detail, step.state, step.verdict ?? "", step.error ?? "", step.text ?? "", step.hasWork ?? false];
/** What a finished turn's work shows; equal shapes render the same rows. */
const workShape = (turn: ChatTurn) => JSON.stringify([turn.runId, turn.status, turn.startedAtMs ?? 0, turn.steps.map(stepShape), turn.final ? stepShape(turn.final) : null]);

/**
 * A finished turn's work is skipped on re-render unless it changed. The chat rebuilds every turn
 * object on each update, and re-diffing a long chat's finished work (thousands of rows) blocked
 * the page for up to a second each time; only the live turn needs the work.
 */
export function sameWork(prev: WorkGroupProps, next: WorkGroupProps): boolean {
  if (prev.idle !== next.idle || prev.expanded !== next.expanded || prev.loadWork !== next.loadWork) return false;
  if (prev.turn === next.turn) return true;
  if (liveTurn(prev.turn) || liveTurn(next.turn)) return false;
  return workShape(prev.turn) === workShape(next.turn);
}

const WorkGroup = memo(WorkGroupView, sameWork);

function WorkGroupView({ turn, idle = false, expanded = false, loadWork }: WorkGroupProps) {
  const working = turn.steps.find((step) => step.working);
  // Live and failed work opens by itself, and finished work too when the chat shows its details
  // (single-model chats by default); a toggle on the turn itself holds over both.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (expanded || Boolean(working) || turn.steps.some((step) => step.error));
  if (!turn.steps.length) {
    if (turn.final) return <AnswerWork step={turn.final} runId={turn.runId} expanded={expanded} loadWork={loadWork} />;
    return !idle && (turn.status === "running" || turn.status === "queued")
      ? <div className="cx-work is-live"><span className="cx-shimmer">Starting…</span></div> : null;
  }
  const label = working
    ? <>{working.working!.stalled ? "May be stuck" : "Working"}{turn.startedAtMs ? <> for <Elapsed since={turn.startedAtMs} /></> : null}
      {` · ${working.name}${working.working!.activity ? ` — ${working.working!.activity}` : ""}`}</>
    : `Worked · ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}`;
  return <div className={`cx-work${working ? " is-live" : ""}${working?.working?.stalled ? " is-stalled" : ""}`}>
    <button type="button" className="cx-work-head" aria-expanded={open} onClick={() => setChosen(!open)}>
      <span className={working ? "cx-shimmer" : undefined}>{label}</span>
      <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} />
    </button>
    {open ? <ol className="cx-steps">{turn.steps.map((step) => <StepRow key={step.key} step={step} runId={turn.runId} loadWork={loadWork} />)}</ol> : null}
  </div>;
}

function MessageActions({ text, children }: { text: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return <div className="cx-msg-actions">
    <button type="button" title="Copy" aria-label="Copy message" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
      {copied ? <Icon name="check" width="14" height="14" /> : "⧉"}</button>
    {children}
  </div>;
}

/** The goal bar's glyphs (Lucide outlines, as Codex draws them). */
function GoalGlyph({ name }: { name: "target" | "trash" | "play" | "pause" | "expand" }) {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "target" ? <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>
      : name === "trash" ? <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      : name === "play" ? <><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5Z" /></>
      : name === "pause" ? <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>
      : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}
  </svg>;
}

export function AgentOrchestratorChat({
  runs, tasks, selectedTaskId, busy, loadDescription, send, openStructure,
  approvals, approve, describeRoute: _describeRoute, notice, retryStart, working = false, describeNode, activity, modelName, permissions, composer, onOpenTeam, onOpenMissionBoard,
  projectName, stop, restart, thread, structure, onPause, onResume, onSettings, filePath, seed, onSeedUsed, headerExtra, onOpenProject, projects, projectId, onPickProject, onAddProject, projectBranch: branch, steer,
  pendingMessage, pendingTitle, pendingCreation = false, commands, loadWork,
}: {
  /** A finished card's thinking and tool calls, read back from its AO session (turn_timeline). */
  loadWork?: LoadWork;
  /** Codex slash commands that need the page: goal, compact, diff, MCP, status, recent chats, plan mode. */
  commands?: ChatCommands;
  /** A message being sent into a chat that has no run yet (shown at once, as Codex does). */
  pendingMessage?: string; pendingTitle?: string; pendingCreation?: boolean;
  /** How each card runs (harness · model · effort · context · role), shown on its messages. */
  describeNode?: (node: ChatNode) => string;
  /** What each working card is doing now, by "<run id>:<card id>". */
  activity?: Record<string, ChatActivity>;
  runs: ChatRun[];
  tasks: { id: string; title: string }[];
  /** "" for a new, unsent chat. */
  selectedTaskId: string;
  busy: boolean;
  /** The chat's latest run is being driven right now (not just left pending). */
  working?: boolean;
  loadDescription: (taskId: string) => Promise<string>;
  /** `goal` starts (or replaces) the chat’s goal with this objective; the message is its first round. */
  send: (input: { taskId?: string; title?: string; message: string; goal?: string }) => Promise<void>;
  /** Hands a message to the running agent at once (Codex's steer); false when its turn already ended. */
  /** true: steered; "wait": the agent waits on a request, so the message is queued; false: send it normally. */
  steer?: (input: { taskId: string; message: string }) => Promise<boolean | "wait" | "restart" | "starting">;
  openStructure: (runId: string) => void;
  approvals: ChatApproval[];
  approve: (approval: ChatApproval, reply: ApprovalReply) => void;
  permissions?: ReactNode;
  composer?: Omit<ComposerControlsProps, "permissions" | "busy">;
  onOpenTeam?: () => void;
  onOpenMissionBoard?: () => void;
  describeRoute: (nodeId: string, runId: string) => string;
  /** A model's short name: a single-model chat's card is named by its model. */
  modelName?: (model: string) => string;
  /** Why this chat's latest run could not start, if it could not. */
  notice?: string;
  retryStart: (runId: string) => void;
  /** The project's name, for the empty chat. */
  projectName?: string;
  stop?: (runId: string) => void;
  restart?: (runId: string) => void;
  thread?: ChatThreadActions;
  /** The cards panel for this chat's latest run, shown beside the conversation on demand. */
  structure?: ReactNode;
  onPause?: () => void;
  onResume?: () => void;
  onSettings?: () => void;
  /** The path of a dropped or picked file, when the app can tell. */
  filePath?: (file: File) => string;
  /** A new chat's starting draft ("Continue in project"); taken once, then onSeedUsed clears it. */
  seed?: { key: string; title: string; text: string; context?: string[] };
  onSeedUsed?: () => void;
  /** Extra header controls before the header buttons (the chat's team picker). */
  headerExtra?: ReactNode;
  /** The project folder's checked-out branch, shown in the environment popover. */
  projectBranch?: string;
  /** Opens the open project's folder (the new chat's project name is a link, as in Codex). */
  onOpenProject?: () => void;
  /** The project picker on the new chat's project chip: every project, the open one, and its actions. */
  projects?: { id: string; name: string; path?: string }[];
  projectId?: string;
  /** Switches the new chat to that project, carrying what has been typed so far. */
  onPickProject?: (projectId: string, draft: { title: string; text: string }) => void;
  /** "+ New project": choose a folder and add it as a project. */
  onAddProject?: () => void;
}) {
  const chats = useMemo(() => chatList(runs, tasks, [], true), [runs, tasks]);
  const chat = chats.find((entry) => entry.taskId === selectedTaskId);
  const chatRuns = useMemo(() => runs.filter((run) => run.project_id === selectedTaskId), [runs, selectedTaskId]);
  const latest = chatRuns[chatRuns.length - 1];
  // A queued run that nothing is starting (its start failed, or the app restarted mid-start)
  // offers Start instead of a "Starting…" that never ends; the grace period covers a normal start.
  const idleQueued = Boolean(latest && chat?.status === "queued" && !working && !pendingCreation);
  const [notStarted, setNotStarted] = useState(false);
  useEffect(() => {
    setNotStarted(false);
    if (!idleQueued) return;
    const timer = window.setTimeout(() => setNotStarted(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [idleQueued, latest?.id]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachNote, setAttachNote] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [showStructure, setShowStructure] = useState(false);
  // Whether a finished turn's work (its steps and their messages) shows unfolded. Single-model chats
  // show it by default, Team chats fold the workers' activity; the turn's answer always shows. Each
  // mode remembers the choice made from the ⋯ menu.
  const workMode = latest?.execution_mode === "single" ? "single" : "team";
  const workKey = `coding-tools:ao:work-details:${workMode}`;
  const [workPrefs, setWorkPrefs] = useState<Record<string, boolean>>({});
  const showWork = workPrefs[workKey] ?? (() => {
    try { const saved = localStorage.getItem(workKey); if (saved === "on" || saved === "off") return saved === "on"; } catch { /* default */ }
    return workMode === "single";
  })();
  const toggleWork = () => {
    const next = !showWork;
    try { localStorage.setItem(workKey, next ? "on" : "off"); } catch { /* the choice still applies now */ }
    setWorkPrefs((current) => ({ ...current, [workKey]: next }));
  };
  // The chat's details panel (like Claude's session panel): changes, agents, setup.
  const [details, setDetails] = useState<{ left: number; top: number } | null>(null);
  const detailsPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!details) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (detailsPanel.current?.contains(target) || (target as Element).closest?.("[data-details-toggle]"))) return;
      setDetails(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setDetails(null); };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", escape); };
  }, [details]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ChatMenuState>(null);
  // A menu button toggles its menu: pressing it again closes the menu instead of reopening it.
  const toggleMenu = (owner: HTMLElement, open: (box: DOMRect) => Omit<NonNullable<ChatMenuState>, "owner">) =>
    setMenu((current) => current?.owner === owner ? null : { ...open(owner.getBoundingClientRect()), owner });
  // The project chip's picker, anchored just above the chip.
  const [projectPicker, setProjectPicker] = useState<{ left: number; bottom: number } | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  useEffect(() => {
    if (!projectPicker) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".cx-project-picker, .cx-context-strip")) setProjectPicker(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [projectPicker]);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // The board list omits descriptions; read this chat's task whenever a new run appears on it.
  useEffect(() => {
    if (!selectedTaskId) return;
    let live = true;
    void loadDescription(selectedTaskId).then((text) => {
      if (live) setDescriptions((current) => ({ ...current, [selectedTaskId]: text }));
    }).catch(() => {});
    return () => { live = false; };
  }, [selectedTaskId, chatRuns.length, loadDescription]);

  // Stall checks and "last heard" read a clock that moves every 10 seconds while a card works: each
  // move rebuilds the turns and re-renders the transcript (every message), which ticking once a
  // second made the chat lag. The per-second counters (<Elapsed>) tick on their own.
  const [now, setNow] = useState(() => Date.now());
  const anyWorking = chatRuns.some((run) => run.nodes.some((node) => node.state === "running" || node.state === "reserved"));
  useEffect(() => {
    if (!anyWorking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [anyWorking]);
  const turns: ChatTurn[] = useMemo(
    () => chatTurns(chatRuns, descriptions[selectedTaskId] ?? pendingMessage, { describe: describeNode, activity, now, modelName }),
    [chatRuns, descriptions, selectedTaskId, describeNode, activity, now, pendingMessage, modelName],
  );
  const stepCount = turns.reduce((total, turn) => total + turn.steps.length + (turn.final ? 1 : 0), 0);
  // The side panel beside the thread (ChatWorkbench: preview, changes, files, terminal) for the
  // chat's AO agents; it opens by itself when an agent first opens a page or starts a command.
  const [workbench, setWorkbench] = useState<WorkbenchTab | null>(null);
  const agentSessions = useMemo(() => chatAgentSessions(chatRuns), [chatRuns]);
  const agentSessionIds = useMemo(() => agentSessions.map((session) => session.id), [agentSessions]);
  const livePage = useWorkbenchAutoOpen(selectedTaskId ? agentSessionIds : [], workbench !== null, (tab) => setWorkbench(tab), projectId);
  useEffect(() => { setWorkbench(null); }, [selectedTaskId]);
  // Following new output jumps, even under a theme's smooth scrolling: an animated follow lags the
  // stream and flashes the ↓ button. Only that button scrolls smoothly.
  useEffect(() => { if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "instant" }); }, [turns.length, stepCount, atBottom]);
  // A running step grows without a new turn or step (each tool call, each streamed line): the
  // thread follows any growth of its content while it is read at the bottom.
  const column = useRef<HTMLDivElement>(null);
  const following = useRef(atBottom);
  following.current = atBottom;
  useEffect(() => {
    const box = scroller.current, content = column.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => { if (following.current) box.scrollTop = box.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [selectedTaskId]);
  // Compact activity (the header's toggle): tool calls and thinking fold into one line per run.
  const [compactActivity, setCompactActivity] = useState(() => { try { return localStorage.getItem(COMPACT_ACTIVITY_KEY) !== "off"; } catch { return true; } });
  const toggleCompact = () => setCompactActivity((current) => {
    try { localStorage.setItem(COMPACT_ACTIVITY_KEY, current ? "off" : "on"); } catch { /* applies now regardless */ }
    return !current;
  });
  // The cards panel can be dragged wider for more board room; the width is kept per viewer.
  const [cardsWidth, setCardsWidth] = useState<number | null>(() => {
    try { const value = Number(localStorage.getItem(CARDS_WIDTH_KEY)); return Number.isFinite(value) && value >= 280 ? value : null; } catch { return null; }
  });
  const saveCardsWidth = (value: number | null) => {
    setCardsWidth(value);
    try { if (value === null) localStorage.removeItem(CARDS_WIDTH_KEY); else localStorage.setItem(CARDS_WIDTH_KEY, String(value)); } catch { /* per-session only */ }
  };
  /** Between 280px and 70% of the chat area, so the conversation always keeps some room. */
  const clampCardsWidth = (value: number, handle: Element) => {
    const area = handle.closest(".cx-chat")?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.max(280, Math.min(value, area * 0.7)));
  };
  const startCardsResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const right = handle.parentElement!.getBoundingClientRect().right;
    handle.setPointerCapture(event.pointerId);
    let latest = cardsWidth;
    const move = (moveEvent: PointerEvent) => { latest = clampCardsWidth(right - moveEvent.clientX, handle); setCardsWidth(latest); };
    const end = () => {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end);
      saveCardsWidth(latest);
    };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
  };
  // A new chat starts at the bottom.
  useEffect(() => { setAtBottom(true); setShowStructure(false); setRenaming(null); }, [selectedTaskId]);
  // Each chat keeps its own unsent draft, as Codex does (the new-chat composer is "" here): opening
  // another chat puts this one's draft aside and brings that chat's back.
  const draftOwner = useRef(selectedTaskId);
  const composing = useRef({ taskId: selectedTaskId, draft, attachments });
  composing.current = { taskId: selectedTaskId, draft, attachments };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (draftOwner.current === selectedTaskId) return;
    if (draft) CHAT_DRAFTS.set(draftOwner.current, draft); else CHAT_DRAFTS.delete(draftOwner.current);
    setDraft(CHAT_DRAFTS.get(selectedTaskId) ?? "");
    CHAT_DRAFTS.delete(selectedTaskId);
    draftOwner.current = selectedTaskId;
  }, [selectedTaskId]);
  // Messages a rewound chat carries as context ahead of its first message; the composer holds only
  // the chosen message. Dropped with the chip's ×, or sent once with that first message.
  const [carried, setCarried] = useState<string[] | null>(null);
  // Continue in project / Rewind: the new chat opens with the seeded message, ready to review and send.
  useEffect(() => {
    if (!seed || selectedTaskId) return;
    setDraft(seed.text); setTitle(seed.title); setCarried(seed.context?.length ? seed.context : null);
    onSeedUsed?.();
    window.setTimeout(() => input.current?.focus(), 0);
  }, [seed?.key]);
  // The composer grows with its text, like Codex, up to a cap: CSS field-sizing does it. Measuring
  // it here on every key forced a layout of the whole chat each time, which typing felt.

  const runOpen = Boolean(latest) && chatRunOpen(chat?.status);
  const accepts = chatAcceptsMessage(chat?.status, working);
  // "Steer while working": a message typed while the agent works goes to it right away.
  const [steerOn, setSteerOn] = useState(() => { try { return localStorage.getItem("coding-tools:ao:steer") !== "off"; } catch { return true; } });
  const toggleSteer = () => setSteerOn((current) => {
    try { localStorage.setItem("coding-tools:ao:steer", current ? "off" : "on"); } catch { /* the choice still applies now */ }
    return !current;
  });
  // Only an AO agent can be steered: a single chat's card, or a team's orchestrator (see chat_steer).
  const steerable = Boolean(latest?.nodes.some((node) => node.state === "running" && node.route?.harness_id?.startsWith("ao:")
    && (latest.execution_mode === "single" || node.role === "planner")));
  // A running AO card is steerable whether or not this page is driving its run: after an app restart
  // the run goes on without the page's loop, and the user must still be able to reach the agent.
  // An agent waiting on a request (a tool approval, ExitPlanMode's plan) must be answered on its
  // card: steering pre-empts the turn, which cancels the request ("Tool use aborted").
  const awaitingAnswer = approvals.length > 0;
  // A request waiting on an answer does not turn steering into queueing: with "Approve for me" each
  // tool call shows as one for a moment, and every message typed then waited for the whole turn.
  // The steer waits for the request to be answered, then reaches the agent.
  const steering = !accepts && steerOn && steerable && Boolean(steer && selectedTaskId);
  // Otherwise a message typed while the chat runs waits and is sent when the turn finishes, as in Codex.
  const queueing = !accepts && !steering && runOpen && Boolean(selectedTaskId);
  const canSend = !busy && !sending && Boolean(draft.trim() || attachments.length) && (accepts || steering || queueing);
  const slash = chatSlashMatches(draft, { chat: Boolean(selectedTaskId), run: Boolean(latest), open: runOpen });

  // What a command shows above the composer (its result, or why it couldn't run).
  const [card, setCard] = useState<ChatCommandCard | null>(null);
  // Edit goal: the objective being edited, or null.
  const [goalEditing, setGoalEditing] = useState<string | null>(null);
  const say = (title: string, text: string, quote?: string) => setCard({ title, text, ...(quote ? { quote } : {}) });

  /** Sends a message the way the composer does: into this chat, or as a new chat. */
  const deliver = async (message: string, goal?: string) => {
    const owner = composing.current;
    const current = () => alive.current && composing.current.taskId === owner.taskId && composing.current.draft === owner.draft && composing.current.attachments === owner.attachments;
    setSending(true);
    try {
      // A steer the turn outran (it ended first) is sent as an ordinary follow-up instead; a goal is never steered.
      const steered = !goal && steering && steer && selectedTaskId ? await steer({ taskId: selectedTaskId, message }) : false;
      if ((steered === "wait" || steered === "restart" || steered === "starting") && selectedTaskId) {
        // The agent was found waiting on its own request just now (the page had not seen it yet):
        // steering would cancel that request, so the message waits for the turn like a queued one.
        // Or its turn had hung and was stopped: the message goes as the next turn once it settles.
        setQueue(selectedTaskId, chatQueueAdd(queueOf(selectedTaskId), { what: "Message", message }));
        if (current()) {
          setDraft(""); setAttachments([]); setAttachNote("");
          say(steered === "restart" ? "Restarting" : "Queued", steered === "restart"
            ? "The agent had stopped responding, so its turn was stopped; your message is sent as the next turn."
            : steered === "starting" ? "The agent is still starting; your message is steered in once it can take it."
            : "The agent is waiting for an answer to its request; your message is steered in once that is answered.", message);
        }
        return true;
      }
      // A rewound chat's first message takes the earlier messages along ahead of it, as context.
      const first = !selectedTaskId && carried?.length ? [...carried, message].join("\n\n").slice(-8192) : message;
      if (!steered) await send(selectedTaskId ? { taskId: selectedTaskId, message, ...(goal ? { goal } : {}) }
        : { title: title.trim() || undefined, message: first, ...(goal ? { goal } : {}) });
      if (CHAT_DRAFTS.get(owner.taskId) === owner.draft) CHAT_DRAFTS.delete(owner.taskId);
      if (current()) {
        setDraft(""); setTitle(""); setAttachments([]); setAttachNote(""); setAtBottom(true);
        if (!selectedTaskId) setCarried(null);
      }
      return true;
    } catch {
      // The surface already shows the error; keep the message so it can be sent again.
      return false;
    } finally { setSending(false); }
  };

  const submit = async () => {
    // A whole draft that is a command runs it, even while the chat is working (/status, /goal pause).
    const command = attachments.length ? null : chatSlashParse(draft);
    if (command) { await runCommand(command.name, command.arg); return; }
    if (!canSend) return;
    const message = chatMessageWithAttachments(draft, attachments);
    const text = commands?.planMode ? planMessage(message) : message;
    if (queueing) {
      // Several messages typed during one turn go together, in order.
      setQueue(selectedTaskId, chatQueueAdd(queueOf(selectedTaskId), { what: "Message", message: text }));
      setDraft(""); setAttachments([]); setAttachNote("");
      say("Queued", `It's sent when the current turn finishes.${latest && runOpen && stop ? " Send /stop to end the turn now." : ""}`, text);
      return;
    }
    await deliver(text);
  };

  // Messages (or commands' messages) waiting for their chat's turn to end, as Codex queues them. Each
  // chat has its own queue in CHAT_QUEUES, outside this component, so opening another chat or another
  // view keeps it; a queue is sent only into its own chat, one item per finished turn.
  const [queueVersion, setQueueVersion] = useState(0);
  const queueOf = (taskId: string) => CHAT_QUEUES.get(taskId) ?? [];
  const setQueue = (taskId: string, queue: QueuedChatMessage[]) => {
    if (queue.length) CHAT_QUEUES.set(taskId, queue); else CHAT_QUEUES.delete(taskId);
    setQueueVersion((value) => value + 1);
  };
  const queued = queueOf(selectedTaskId);
  useEffect(() => {
    if (queued.length) say("Queued", `${queued.length === 1 ? "A message is" : `${queued.length} messages are`} waiting for this chat's turn to finish; sent then.`);
  }, [selectedTaskId]);
  // One queued item per free spell: right after a send the chat may still read as free for a moment,
  // and the next item must wait for the turn that send started.
  const sentWhileFree = useRef(false);
  useEffect(() => { sentWhileFree.current = false; }, [accepts, selectedTaskId]);
  // A send runs only from the focused app window. A turn that ended while the user was in another
  // app had its queued message refused and dropped back into the composer; it now waits for focus.
  const [windowFocused, setWindowFocused] = useState(() => typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const on = () => setWindowFocused(true), off = () => setWindowFocused(false);
    window.addEventListener("focus", on); window.addEventListener("blur", off);
    return () => { window.removeEventListener("focus", on); window.removeEventListener("blur", off); };
  }, []);
  useEffect(() => {
    const task = selectedTaskId, [next, ...rest] = queueOf(task);
    if (!task || !next || !accepts || busy || sending || sentWhileFree.current || !windowFocused) return;
    sentWhileFree.current = true;
    setQueue(task, rest);
    const owner = composing.current;
    void deliver(next.message, next.goal).then((sent) => {
      if (sent) { if (alive.current && composing.current.taskId === task && !rest.length) setCard(null); return; }
      if (!alive.current || composing.current.taskId !== task || composing.current.draft !== owner.draft || composing.current.attachments !== owner.attachments) {
        setQueue(task, [next, ...queueOf(task)]);
        return;
      }
      // Nothing is lost: a plain message goes back into the composer to send again.
      if (next.what === "Message") setDraft(next.message);
      say(next.what, next.what === "Message" ? "The queued message couldn't be sent; it's back in the composer." : "The queued message couldn't be sent; run the command again.");
    });
  }, [queueVersion, selectedTaskId, accepts, busy, sending, windowFocused]);
  // In steer mode a queued message (the agent was waiting on a request, or still starting) is
  // steered in as soon as the agent can take it, not held until the whole turn ends. A steer that
  // still finds it waiting comes back to the queue; the backend waits up to half a minute each time.
  const steeringQueue = useRef(false);
  useEffect(() => {
    const task = selectedTaskId, [next, ...rest] = queueOf(task);
    if (!task || !next || accepts || !steering || awaitingAnswer || next.goal || next.what !== "Message"
      || busy || sending || steeringQueue.current || !windowFocused) return;
    steeringQueue.current = true;
    setQueue(task, rest);
    void deliver(next.message).then((sent) => { if (!sent) setQueue(task, [next, ...queueOf(task)]); })
      .finally(() => { steeringQueue.current = false; });
  }, [queueVersion, selectedTaskId, accepts, steering, awaitingAnswer, busy, sending, windowFocused]);
  /**
   * Sends a command's message now when the chat is free, steers it into the working agent when it
   * can be steered (never a goal), and otherwise queues it for when the current turn finishes.
   */
  const dispatch = async (what: string, message: string, goal?: string): Promise<"sent" | "queued" | false> => {
    if (busy || sending) { say(what, "Another action is still running; try again in a moment."); return false; }
    if (accepts || (steering && !goal)) return await deliver(message, goal) ? "sent" : false;
    setQueue(selectedTaskId, chatQueueAdd(queueOf(selectedTaskId), { what, message, ...(goal ? { goal } : {}) }));
    say(what, `Queued: it's sent when the current turn finishes.${latest && runOpen && stop ? " Send /stop to end the turn now." : ""}`);
    return "queued";
  };
  // The messages /rewind can go back to, oldest first, with the turn each one opened.
  const rewindPoints = turns.flatMap((turn, turnIndex) => turn.user ? [{ turnIndex, messageIndex: turn.messageIndex ?? turnIndex, text: turn.user.text }] : []);
  // Delete message: the turn whose message waits for the in-chat confirmation, or null. A message
  // goes with its reply and the steers sent during its turn; the agent's files stay as they are.
  const [deleting, setDeleting] = useState<number | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  useEffect(() => { setDeleting(null); }, [selectedTaskId]);
  const deleteBlocked = runOpen || working ? "Stop the chat first to delete a message"
    : rewindPoints.length <= 1 ? "This is the chat's only message; archive or delete the chat instead" : "";
  // A message is deleted with the runs its turn showed, so exactly that reply leaves the chat.
  const deletion = (turn: ChatTurn | undefined) => turn?.user && turn.runId && turn.messageIndex !== undefined
    ? { index: turn.messageIndex, runIds: chatRunsOfMessage(chatRuns, turn.runId) } : null;
  const notYet = "This message hasn't run yet; it can be deleted once its turn has run";
  const confirmDelete = async () => {
    const target = deleting === null ? null : deletion(turns[deleting]), task = selectedTaskId;
    if (!target || !thread?.deleteMessage || deleteBlocked) return;
    setDeletingBusy(true);
    try {
      await thread.deleteMessage(target.index, target.runIds);
      void loadDescription(task).then((text) => setDescriptions((current) => ({ ...current, [task]: text }))).catch(() => {});
    } catch {
      // The surface already shows why it could not be deleted.
    } finally { setDeletingBusy(false); setDeleting(null); }
  };

  const runCommand = async (name: string, arg = "") => {
    setSlashIndex(0);
    const keep = name === "goal" && arg === "edit";
    if (!keep) setDraft("");
    try {
      switch (name) {
        case "goal": {
          const goal = commands?.goal;
          const action = arg.toLowerCase();
          if (!arg) {
            setCard(goal ? { title: GOAL_SUMMARY[goal.status], rows: [["Goal", goal.objective], ["Round", `${goal.round} of ${goal.rounds}`],
              ["Running for", goalElapsed(goal.startedAt)], ...(goal.note ? [["Note", goal.note] as [string, string]] : [])] }
              : { title: "Goal", text: "No goal is currently set.\nUsage: /goal <objective> | pause | resume | edit | clear\nExample: /goal make every test in this project pass" });
            break;
          }
          if (["pause", "resume", "clear"].includes(action)) {
            if (action === "clear" && queued.some((item) => item.goal)) {
              setQueue(selectedTaskId, queued.filter((item) => !item.goal)); say("Goal", "The queued goal was dropped."); break;
            }
            if (!commands) break;
            if (!goal) { say("Goal", "No goal is currently set."); break; }
            await commands.goalAction(action as "pause" | "resume" | "clear");
            say("Goal", action === "clear" ? "Goal cleared." : action === "pause" ? "Goal paused; the current round finishes, then it waits." : "Goal resumed.");
            break;
          }
          if (action === "edit") {
            setDraft("");
            if (!goal) say("Goal", "No goal is currently set."); else { setCard(null); setGoalEditing(goal.objective); }
            break;
          }
          if (goal && ["active", "paused"].includes(goal.status)
            && !window.confirm("Replace current goal?\n\nThis keeps the chat but replaces the saved goal with this one.")) { setDraft(`/goal ${arg}`); break; }
          // While a turn is working the goal is queued; it starts once the turn finishes.
          const outcome = await dispatch("Goal", arg, arg);
          if (!outcome) setDraft(`/goal ${arg}`);
          else if (outcome === "sent") setCard(null);
          break;
        }
        case "plan":
          commands?.setPlanMode(!commands.planMode);
          say("Plan mode", commands?.planMode ? "Plan mode is off." : "Plan mode is on: messages ask for a plan and no changes, until you turn it off with /plan.");
          break;
        case "compact":
          if (!commands || !selectedTaskId) break;
          if (!accepts) { say("Compact", "Compact is disabled while a chat is in progress."); break; }
          say("Compact", "Compacting this chat's context…");
          say("Compact", await commands.compact());
          break;
        case "review":
          if (await dispatch("Review", reviewPrompt(arg)) === "sent" && !accepts) say("Review", "Sent to the working agent.");
          break;
        case "init":
          if (await dispatch("Init", INIT_PROMPT) === "sent" && !accepts) say("Init", "Sent to the working agent.");
          break;
        case "rewind": {
          if (!thread?.rewind) break;
          if (!rewindPoints.length) { say("Rewind", "There is no message to go back to yet."); break; }
          const pick = Number(arg);
          if (arg) {
            const point = Number.isInteger(pick) ? rewindPoints[pick - 1] : undefined;
            if (point) thread.rewind(point.messageIndex);
            else say("Rewind", `Choose a message from 1 to ${rewindPoints.length}, e.g. /rewind ${rewindPoints.length}.`);
            break;
          }
          setCard({ title: "Rewind",
            text: "Go back to a message: a new chat opens with the conversation up to it and that message ready to edit. This chat and the files on disk stay as they are.",
            items: rewindPoints.map((point, index) => ({ label: `${index + 1}. ${point.text.replace(/\s+/g, " ").slice(0, 90)}`,
              run: () => { setCard(null); thread.rewind?.(point.messageIndex); } })).reverse() });
          break;
        }
        case "delete": {
          if (!thread?.deleteMessage) break;
          if (deleteBlocked) { say("Delete message", `${deleteBlocked}.`); break; }
          const pick = Number(arg);
          if (arg) {
            const point = Number.isInteger(pick) ? rewindPoints[pick - 1] : undefined;
            if (point && !deletion(turns[point.turnIndex])) say("Delete message", `${notYet}.`);
            else if (point) { setCard(null); setDeleting(point.turnIndex); }
            else say("Delete message", `Choose a message from 1 to ${rewindPoints.length}, e.g. /delete ${rewindPoints.length}.`);
            break;
          }
          setCard({ title: "Delete message", text: "Choose the message to delete; you are asked to confirm.",
            items: rewindPoints.map((point, index) => ({ label: `${index + 1}. ${point.text.replace(/\s+/g, " ").slice(0, 90)}`,
              run: () => deletion(turns[point.turnIndex]) ? setDeleting(point.turnIndex) : say("Delete message", `${notYet}.`) })).reverse() });
          break;
        }
        case "status": if (commands) setCard(commands.status()); break;
        case "diff":
          if (!commands) break;
          say("Changes", "Reading the project's changes…");
          setCard(await commands.diff());
          break;
        case "mcp":
          if (!commands) break;
          setCard(await commands.mcp());
          break;
        case "resume": if (commands) setCard(commands.recent()); break;
        case "new": thread?.newChat(); break;
        case "stop": if (latest && runOpen) stop?.(latest.id); break;
        case "retry": if (latest) restart?.(latest.id); break;
        case "model":
          (document.querySelector<HTMLButtonElement>('.cx-composer [aria-label="Choose model"]')
            ?? document.querySelector<HTMLButtonElement>('.cx-composer [aria-label="Choose saved team"]'))?.click();
          break;
        case "structure": setShowStructure((value) => !value); break;
        case "board": onOpenMissionBoard?.(); break;
        case "rename": if (chat) setRenaming(chat.title); break;
        case "fork": thread?.fork(); break;
        case "archive": thread?.archive(); break;
        case "copy": thread?.copyConversation(); say("Copy", "Conversation copied as Markdown."); break;
      }
    } catch (cause) {
      say(`/${name}`, cause instanceof Error ? cause.message : String(cause));
    }
  };
  const typing = chatSlashTyping(draft);
  // Picking a command that takes an argument fills it in to type the rest, as Codex does.
  const pick = (name: string) => {
    const command = slash.find((entry) => entry.name === name);
    // A fully typed command ("/review") runs; picking a partly typed one fills it in to add the argument.
    if (command?.args && draft.trim().toLowerCase() !== `/${name}`) { setDraft(`/${name} `); setSlashIndex(0); window.setTimeout(() => input.current?.focus(), 0); return; }
    void runCommand(name);
  };

  const addFiles = async (files: FileList | File[]) => {
    const added: ChatAttachment[] = [];
    const notes: string[] = [];
    for (const file of Array.from(files)) {
      const path = filePath?.(file) || "";
      const image = file.type.startsWith("image/");
      if (path) { added.push({ name: file.name, path, image }); continue; }
      if (image) { notes.push(`${file.name}: images need their file path, which isn't available here`); continue; }
      if (file.size > INLINE_ATTACHMENT_BYTES) { notes.push(`${file.name}: too large to attach inline (over 200 KB)`); continue; }
      added.push({ name: file.name, text: await file.text() });
    }
    if (added.length) setAttachments((current) => [...current, ...added].slice(0, 8));
    setAttachNote(notes.join("; "));
  };

  const headerMenu = (): ChatMenuItem[] => [
    ...(thread && chat ? [
      { label: "Rename", shortcut: "Alt+Ctrl+R", run: () => setRenaming(chat.title) },
      { label: thread.pinned ? "Unpin" : "Pin", shortcut: "Alt+Ctrl+P", run: thread.togglePin },
      { label: "Fork", run: () => thread.fork() },
      { label: "Copy conversation", run: thread.copyConversation },
    ] as ChatMenuItem[] : []),
    ...(steer ? [{ label: "Steer while working", checked: steerOn, run: toggleSteer } as ChatMenuItem] : []),
    { label: "Compact activity", checked: compactActivity, run: toggleCompact } as ChatMenuItem,
    { label: workMode === "single" ? "Show work details" : "Show workers' activity", checked: showWork, run: toggleWork } as ChatMenuItem,
    { kind: "separator" },
    latest && chat?.status === "paused" && onResume ? { label: "Resume mission", run: onResume }
      : { label: "Pause mission", ...(latest && chat?.status === "running" && onPause ? { run: onPause } : { reason: "Only a running mission can be paused" }) },
    latest && restart ? { label: "Restart mission", run: () => restart(latest.id), ...(working ? { run: undefined, reason: "Stop the mission first" } : {}) }
      : { label: "Restart mission", reason: "This chat has no mission yet" },
    { label: "Team", ...(onOpenTeam ? { run: onOpenTeam } : { reason: "No team is available" }) },
    { label: "Mission Board", ...(onOpenMissionBoard ? { run: onOpenMissionBoard } : { reason: "No board is available" }) },
    { label: "Orchestrator settings", ...(onSettings ? { run: onSettings } : { reason: "Settings are unavailable" }) },
    ...(thread && chat ? [{ kind: "separator" }, chat.status === "running"
      ? { label: "Archive", reason: "Stop the running mission before archiving this chat" }
      : { label: "Archive", shortcut: "Ctrl+Shift+A", run: thread.archive }] as ChatMenuItem[] : []),
  ];

  const commitRename = async () => {
    const value = renaming?.trim();
    setRenaming(null);
    if (value && chat && value !== chat.title) await thread?.rename(value).catch(() => {});
  };

  // The conversation, kept while only the composer changes: each keystroke re-rendered every turn,
  // and a long running turn's hundreds of rows with it, which made typing lag.
  const threadTurns = useMemo(() => turns.map((turn, turnIndex) => <article key={turn.key} className="cx-turn">
              {turn.user ? <div className="cx-user">
                <div className="cx-bubble"><p>{turn.user.text}</p></div>
                <MessageActions text={turn.user.text}>
                  {thread ? <button type="button" title="Fork from here" aria-label="Fork from this message" onClick={() => thread.fork(turn.messageIndex ?? turnIndex)}>⑂</button> : null}
                  {thread?.rewind ? <button type="button" title="Rewind: edit this message in a new chat" aria-label="Rewind to this message" onClick={() => thread.rewind?.(turn.messageIndex ?? turnIndex)}>↶</button> : null}
                  {thread?.deleteMessage ? <button type="button" title={deleteBlocked || (deletion(turn) ? "Delete this message and its reply" : notYet)} aria-label="Delete this message"
                    disabled={Boolean(deleteBlocked) || !deletion(turn) || deletingBusy} onClick={() => setDeleting(turnIndex)}>🗑</button> : null}
                </MessageActions>
                {turn.user.stamp ? <span className="cx-stamp">{turn.user.stamp} UTC</span> : null}
              </div> : null}
              {/* Messages steered into this turn. While it works they show in its live timeline, where
                  they were sent; once it is done, here under the turn's message. */}
              {turn.user?.steers?.length && !turn.steps.some((step) => step.working?.timeline?.some((item) => item.kind === "steer"))
                ? turn.user.steers.map((steer, index) => <div key={`steer:${index}`} className="cx-user cx-steer">
                  <div className="cx-bubble"><p>{steer.text}</p></div>
                  <span className="cx-stamp">Steered · {steer.stamp} UTC</span>
                </div>) : null}
              <WorkGroup key={`${turn.key}:${showWork ? "open" : "folded"}`} turn={turn} idle={notStarted && turn.runId === latest?.id} expanded={showWork} loadWork={loadWork} />
              {turn.final ? <div className={`cx-answer${turn.final.verdict ? " has-verdict" : ""}`}>
                <div className="cx-answer-meta">
                  <span>{turn.final.name}</span>
                  {turn.final.verdict ? <span className={`cx-verdict is-${turn.final.verdict.toLowerCase()}`}>{turn.final.verdict}</span> : null}
                  {turn.final.detail ? <span className="cx-answer-detail">{turn.final.detail}</span> : null}
                </div>
                <ChatMarkdown text={turn.final.text ?? ""} />
                <MessageActions text={turn.final.text ?? ""}>
                  {restart && turn.runId && turn.runId === latest?.id && !runOpen ? <button type="button" title="Retry" aria-label="Retry this mission" disabled={busy} onClick={() => restart(turn.runId)}>↻</button> : null}
                </MessageActions>
              </div> : null}
              {!turn.final && turn.status === "done" && !turn.steps.some((step) => step.text || step.error)
                ? <p className="cx-note">Finished without an answer.</p> : null}
              {turn.status === "stopped" ? <p className="cx-note">Stopped</p> : null}
              {turn.solo ? <p className="cx-note">Answered by the orchestrator alone; no workers ran.</p> : null}
            </article>), [turns, thread, deleteBlocked, deletingBusy, chatRuns, showWork, notStarted, latest?.id, loadWork, restart, runOpen, busy]);

  return (<CompactActivity.Provider value={compactActivity}>
    <div className={`cx-chat${showStructure && structure ? " has-structure" : ""}`}>
      <section className="cx-thread" aria-label={chat?.title || CHAT_DEFAULT_TITLE}>
        <header className="cx-thread-head">
          <span className="cx-head-folder" title={projectName}><ChatGlyph name="folder" size={15} /></span>
          {selectedTaskId || pendingCreation
            ? renaming !== null
              ? <input autoFocus className="cx-title-input" aria-label="Chat name" maxLength={240} value={renaming}
                  onChange={(event) => setRenaming(event.target.value)} onBlur={() => void commitRename()}
                  onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") setRenaming(null); }} />
              : <h2 title="Double-click to rename" onDoubleClick={() => chat && thread && setRenaming(chat.title)}>{chat?.title || pendingTitle || CHAT_DEFAULT_TITLE}</h2>
            : <input aria-label="Task name" className="cx-title-input is-new" maxLength={240} placeholder={CHAT_DEFAULT_TITLE}
                value={title} onChange={(event) => setTitle(event.target.value)} />}
          {pendingCreation && !chat ? <span className="cx-status status-queued" role="status">Starting</span> : null}
          {chat ? <span className={`cx-status status-${chat.status}`}>{STATUS_LABEL[chat.status]}</span> : null}
          <span className="cx-head-spacer" />
          {headerExtra}
          {/* The agent's browser keeps running when its tab or the panel is closed: this brings it back. */}
          {selectedTaskId && livePage && workbench !== "preview" ? <button type="button" className="cx-browser-chip"
            title={`The agent's browser is still open: ${livePage.url}\nShow it`} onClick={() => setWorkbench("preview")}>
            <span className="cx-browser-dot" aria-hidden="true" /><Icon name="browser" width="13" height="13" />
            <span>{livePage.title || (() => { try { return new URL(livePage.url).host; } catch { return livePage.url; } })()}</span></button> : null}
          {selectedTaskId ? <button type="button" className="cx-icon-button cx-compact-toggle" aria-pressed={compactActivity}
            title={compactActivity ? "Compact activity: tool calls and thinking fold into one line (click to show every step)" : "Every step shown (click to compact)"}
            aria-label="Compact activity" onClick={toggleCompact}>
            <Icon name={compactActivity ? "expand" : "minus"} width="16" height="16" /></button> : null}
          {structure || latest ? <button type="button" className="cx-icon-button" aria-pressed={showStructure} title="Show cards (Structure)" aria-label="Show cards"
            disabled={!latest} onClick={() => structure ? setShowStructure((value) => !value) : latest && openStructure(latest.id)}>
            <Icon name="orchestrator" width="16" height="16" /></button> : null}
          {selectedTaskId ? <button type="button" className="cx-icon-button" aria-pressed={workbench !== null} title="Preview and terminal"
            aria-label="Show preview and terminal" onClick={() => setWorkbench((open) => (open ? null : "preview"))}>
            <Icon name="browser" width="16" height="16" /></button> : null}
          {onOpenMissionBoard ? <button type="button" className="cx-icon-button" title="Mission Board" aria-label="Open Mission Board" onClick={onOpenMissionBoard}>
            <Icon name="logs" width="16" height="16" /></button> : null}
          {selectedTaskId ? <button type="button" className="cx-icon-button" data-details-toggle="" title="Chat details" aria-label="Chat details"
            aria-haspopup="dialog" aria-expanded={Boolean(details)}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setDetails((open) => open ? null : { left: Math.max(8, Math.min(box.right - 300, window.innerWidth - 308)), top: box.bottom + 6 });
            }}><ChatGlyph name="section" size={16} /></button> : null}
          <button type="button" className="cx-icon-button" title="More" aria-label="More chat actions" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.right - 240, y: box.bottom + 4, items: headerMenu(), label: "Chat actions" }))}>⋯</button>
        </header>
        {details ? (() => {
          const nodes = latest?.nodes ?? [];
          const lead = nodes.find((node) => node.role === "planner") ?? nodes[0];
          const agents = chatAgentSummary(nodes);
          return <FloatingLayer className="cx-details" role="dialog" style={{ left: details.left, top: details.top }}>
            <div ref={detailsPanel} aria-label="Chat details">
              <div className="cx-details-head"><strong>{projectName || "Project"}</strong>{branch ? <small>{branch}</small> : null}</div>
              <button type="button" className="cx-details-row" disabled={!commands || !latest}
                onClick={() => { setDetails(null); void runCommand("diff"); }}>
                <ChatGlyph name="edit" size={15} /><span>Changes</span></button>
              <p className="cx-details-label">Agents</p>
              {latest ? <button type="button" className="cx-details-row" title="Open the cards"
                onClick={() => { setDetails(null); if (structure) setShowStructure(true); else openStructure(latest.id); }}>
                <span className="cx-details-dots" aria-hidden="true">{agents.dots.slice(0, 8).map((state, index) =>
                  <span key={index} className={`cx-details-dot is-${state}`} />)}</span><span>{agents.text}</span></button>
                : <p className="cx-details-empty">No agents yet; they start with the first message.</p>}
              <p className="cx-details-label">Setup</p>
              {lead ? <>
                <p className="cx-details-line">{describeNode?.(lead) || lead.route?.model || "Model not set"}</p>
                <p className="cx-details-line">Approvals: {chatApprovalMode(lead.route as { approval_policy?: string; approvals_reviewer?: string } | undefined)}</p>
              </> : <p className="cx-details-empty">Chosen when you send.</p>}
            </div>
          </FloatingLayer>;
        })() : null}

        <div className="cx-scroll" ref={scroller}
          onScroll={(event) => { const box = event.currentTarget; setAtBottom(box.scrollHeight - box.scrollTop - box.clientHeight < 48); }}>
          <div className="cx-column" ref={column}>
            {!turns.length ? <div className="cx-empty">
              {selectedTaskId ? <p>Loading…</p> : <>
                <span className="cx-empty-glyph" aria-hidden="true"><ChatGlyph name="codex" size={40} /></span>
                <h1>What should we build{projectName ? <> in {onOpenProject
                  ? <button type="button" className="cx-empty-project" title="Open the project folder" onClick={onOpenProject}>{projectName}</button>
                  : <span className="cx-empty-project">{projectName}</span>}</> : null}?</h1>
              </>}
            </div> : null}
            {threadTurns}
            {(notice || notStarted) && latest && chat?.status === "queued" && !working ? (
              <div className="cx-card tone-error">
                <strong>{notice ? "The run could not start" : "This run hasn't started"}</strong>
                <p>{notice || "Its start stopped before any card ran. Start it again to run the team."}</p>
                <div className="cx-card-actions"><button className="button-primary" type="button" disabled={busy} onClick={() => retryStart(latest.id)}>{notice ? "Retry" : "Start"}</button></div>
              </div>
            ) : null}
            {latest && chat?.status === "attention" ? (
              <div className="cx-card tone-error">
                <strong>A step failed</strong>
                <p>{notice || "The recovery helper retries failed steps up to three times. Retry now, or send a follow-up once you stop this chat."}</p>
                <div className="cx-card-actions"><button className="button-primary" type="button" disabled={busy} onClick={() => retryStart(latest.id)}>Retry failed step</button></div>
              </div>
            ) : null}
            {approvals.map(approval => <AgentOrchestratorApproval key={JSON.stringify([approval.nodeId, approval.approval_id])} approval={approval} busy={busy} approve={approve} />)}
          </div>
          {!atBottom ? <button type="button" className="cx-to-bottom" aria-label="Scroll to the latest message"
            onClick={() => { setAtBottom(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }}>↓</button> : null}
        </div>

        {!selectedTaskId ? <div className="cx-context-strip" aria-label="Where this chat runs">
          {/* Codex's context chips are menus: the project picker, where it runs, and its environment. */}
          <button type="button" className="cx-chip" title={projectName} aria-haspopup="dialog" aria-expanded={Boolean(projectPicker)}
            onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setProjectPicker(projectPicker ? null : { left: box.left, bottom: window.innerHeight - box.top + 6 }); setPickerQuery(""); }}>
            <ChatGlyph name="folder" size={13} />{projectName || "No project"}<Caret className="cx-chip-caret" /></button>
          <button type="button" className="cx-chip" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.left, y: box.top - 96, label: "Work in", items: [
              { label: "This computer", icon: "monitor", checked: true, run: () => undefined },
              { label: "Cloud", icon: "share", reason: "No cloud runner is set up; chats run on this computer" },
            ] }))}>
            <ChatGlyph name="monitor" size={13} />This computer<Caret className="cx-chip-caret" /></button>
          {/* The project's branch sits with where the chat runs, as in Claude Code's start bar. */}
          <ChatBranchBar inline workspaceId={projectId} />
          <span className="cx-head-spacer" />
          <button type="button" className="cx-chip-icon" aria-label="Configure local environment" title="Configure local environment" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.right - 260, y: box.top - 116, label: "Configure local environment", items: [
              // Codex's environment popover. Orchestrator settings live in the header's ⋯ menu, not here.
              { label: "New worktree", icon: "fork", toggle: false, reason: "Chats run in the project folder itself; separate worktrees aren't available yet" },
              { label: "Branch", icon: "repo", detail: branch || "current", reason: "Chats use whatever branch the project folder has checked out" },
              { label: "Environment", icon: "settings", detail: "No environment", reason: "Saved environments aren't available yet" },
            ] }))}>
            <ChatGlyph name="settings" size={14} /></button>
        </div> : null}
        {projectPicker ? <FloatingLayer className="cx-project-picker" role="dialog" style={{ left: projectPicker.left, bottom: projectPicker.bottom }}>
          <input autoFocus aria-label="Search projects" placeholder="Search projects" value={pickerQuery}
            onChange={(event) => setPickerQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setProjectPicker(null); }} />
          <ul role="listbox" aria-label="Projects">
            {(projects ?? []).filter((item) => `${item.name} ${item.path ?? ""}`.toLowerCase().includes(pickerQuery.trim().toLowerCase())).map((item) => {
              const base = item.path?.split(/[\\/]/).filter(Boolean).pop() ?? "";
              return <li key={item.id}><button type="button" role="option" aria-selected={item.id === projectId}
                onClick={() => { setProjectPicker(null); if (item.id !== projectId) onPickProject?.(item.id, { title, text: draft }); }}>
                <ChatGlyph name="folder" size={13} /><span className="cx-picker-name">{item.name}</span>
                {base && base.toLowerCase() !== item.name.toLowerCase() ? <span className="cx-picker-base">{base}</span> : null}
                {item.id === projectId ? <span className="cx-picker-check" aria-hidden="true">✓</span> : null}
              </button></li>;
            })}
          </ul>
          <hr />
          <button type="button" className="cx-picker-action" disabled={!onAddProject} onClick={() => { setProjectPicker(null); onAddProject?.(); }}>
            <ChatGlyph name="plus" size={13} />New project</button>
          <button type="button" className="cx-picker-action" disabled title="Chats run in a project's folder, so a project is required">
            <span aria-hidden="true">✕</span>Don't work in a project</button>
        </FloatingLayer> : null}
        {card ? <section className="cx-command-card" role="status" aria-label={card.title}>
          <header><strong>{card.title}</strong>
            <button type="button" className="cx-icon-button" aria-label="Close" onClick={() => setCard(null)}><Icon name="close" width="12" height="12" /></button></header>
          {card.quote ? <blockquote className="cx-command-quote">{card.quote.length > 280 ? `${card.quote.slice(0, 279)}…` : card.quote}</blockquote> : null}
          {card.rows?.length ? <dl>{card.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
          {card.text ? card.mono ? <pre>{card.text}</pre> : <p>{card.text}</p> : null}
          {card.items?.length ? <ul>{card.items.map((item, index) => <li key={`${item.label}:${index}`}>
            <button type="button" onClick={() => { setCard(null); item.run(); }}><span>{item.label}</span>{item.detail ? <small>{item.detail}</small> : null}</button></li>)}</ul> : null}
        </section> : null}
        {deleting !== null ? <section className="cx-command-card cx-delete-confirm" role="alertdialog" aria-label="Delete message">
          <header><strong>Delete message</strong>
            <button type="button" className="cx-icon-button" aria-label="Cancel" onClick={() => setDeleting(null)}><Icon name="close" width="12" height="12" /></button></header>
          <p>Delete this message? It and its reply are removed from this chat. The agent's files are not changed.</p>
          {deleteBlocked ? <p className="cx-delete-reason">{deleteBlocked}.</p> : null}
          <footer><button type="button" className="cx-text-button" onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="cx-primary-button" disabled={Boolean(deleteBlocked) || deletingBusy} onClick={() => void confirmDelete()}>Delete</button></footer>
        </section> : null}
        {goalEditing !== null && commands?.goal ? <section className="cx-command-card cx-goal-editor" aria-label="Edit goal">
          <header><strong>Edit goal</strong>
            <button type="button" className="cx-icon-button" aria-label="Cancel" onClick={() => setGoalEditing(null)}><Icon name="close" width="12" height="12" /></button></header>
          <textarea aria-label="Goal" rows={4} maxLength={2000} value={goalEditing} placeholder="Describe your goal, define measurable outcomes for best results"
            onChange={(event) => setGoalEditing(event.target.value)} />
          <footer><button type="button" className="cx-text-button" onClick={() => setGoalEditing(null)}>Cancel</button>
            <button type="button" className="cx-primary-button" disabled={!goalEditing.trim() || goalEditing.trim() === commands.goal.objective}
              onClick={() => void commands.goalEdit(goalEditing.trim()).then(() => setGoalEditing(null), (cause) => say("Edit goal", cause instanceof Error ? cause.message : String(cause)))}>Save</button></footer>
        </section> : null}
        {commands?.goal || commands?.planMode ? <div className="cx-composer-modes">
          {/* Codex's goal bar: state, objective, how long it has run, then Clear / Resume or Pause / Edit. */}
          {commands?.goal ? <div className={`cx-goal is-${commands.goal.status}`} role="status">
            <GoalGlyph name="target" />
            <span className="cx-goal-state" title={commands.goal.note || `Round ${commands.goal.round} of ${commands.goal.rounds}`}>{GOAL_SUMMARY[commands.goal.status]}</span>
            <span className="cx-goal-objective" title={commands.goal.objective}>{commands.goal.objective}</span>
            {commands.goal.note ? <span className="cx-goal-note" title={commands.goal.note}>{commands.goal.note}</span> : null}
            <span className="cx-goal-meta" title={`Round ${commands.goal.round} of ${commands.goal.rounds}`}>
              {/* A goal being pursued counts to the second, as Codex shows it; the label ticks alone. */}
              <Elapsed since={commands.goal.startedAt} live={commands.goal.status === "active"} until={commands.goal.updatedAt}
                format={(ms) => goalElapsed(0, ms)} /></span>
            <button type="button" className="cx-goal-icon" title="Clear goal" aria-label="Clear goal" onClick={() => void runCommand("goal", "clear")}><GoalGlyph name="trash" /></button>
            {commands.goal.status === "active"
              ? <button type="button" className="cx-goal-icon" title="Pause goal" aria-label="Pause goal" onClick={() => void runCommand("goal", "pause")}><GoalGlyph name="pause" /></button>
              : commands.goal.status !== "achieved" ? <button type="button" className="cx-goal-icon" title="Resume goal" aria-label="Resume goal" onClick={() => void runCommand("goal", "resume")}><GoalGlyph name="play" /></button> : null}
            <button type="button" className="cx-goal-icon" title="Edit goal" aria-label="Edit goal" onClick={() => void runCommand("goal", "edit")}><GoalGlyph name="expand" /></button>
          </div> : null}
          {commands?.planMode ? <span className="cx-plan-chip" role="status">Plan mode
            <button type="button" aria-label="Turn plan mode off" title="Turn plan mode off" onClick={() => commands.setPlanMode(false)}><Icon name="close" width="11" height="11" /></button></span> : null}
        </div> : null}
        {(() => {
          // A turn keeps the model it started with; say so when the picker now shows another, so the
          // switch is never silent: the next message (and a retry) uses the new one.
          const lead = latest?.nodes.find((node) => node.role === "planner") ?? latest?.nodes[0];
          const running = lead?.route?.model;
          const picked = composer?.mode === "single" ? composer.route?.model : undefined;
          return runOpen && latest?.execution_mode === "single" && running && picked && picked !== running
            ? <p className="cx-route-note" role="status">This turn is running on <b>{running}</b>; your next message uses <b>{picked}</b>.</p> : null;
        })()}
        {selectedTaskId ? <ChatBranchBar workspaceId={projectId} sessionId={agentSessions[0]?.id} /> : null}
        <form className="cx-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } }}>
          {slash.length ? <ul className="cx-slash" role="listbox" aria-label="Commands">
            {slash.map((command, index) => <li key={command.name} role="option" aria-selected={index === slashIndex % slash.length}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(command.name)}>
                <span>/{command.name}{command.args ? <em> {command.args}</em> : null}</span><small>{command.hint}</small></button>
            </li>)}
          </ul> : null}
          {typing && !slash.length ? <p className="cx-slash-usage" role="status">/{typing.name} {typing.args} — {typing.hint}. Press Enter to run it.</p> : null}
          {carried?.length && !selectedTaskId ? <div className="cx-attachments">
            <span className="cx-attachment" title={carried.join("\n\n").slice(0, 600)}>
              ↶ Includes {carried.length} earlier message{carried.length === 1 ? "" : "s"} as context
              <button type="button" aria-label="Drop the earlier messages" onClick={() => setCarried(null)}>×</button>
            </span>
          </div> : null}
          {attachments.length || attachNote ? <div className="cx-attachments">
            {attachments.map((item, index) => <span key={`${item.name}:${index}`} className="cx-attachment" title={item.path || `${item.name} (inline)`}>
              {item.image ? "🖼" : "📄"} {item.name}
              <button type="button" aria-label={`Remove ${item.name}`} onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}>×</button>
            </span>)}
            {attachNote ? <span className="cx-attach-note" role="status">{attachNote}</span> : null}
          </div> : null}
          <textarea ref={input} aria-label="Message" maxLength={8192} rows={1} value={draft}
            placeholder={steering ? "" : awaitingAnswer && queueing ? "Answer the request above first — a message now is sent after it"
              : queueing ? "Running — a message now is sent when it finishes" : !accepts ? "Running — you can send a follow-up when it finishes" : selectedTaskId ? "Send a follow-up…" : "Do anything"}
            onChange={(event) => { setDraft(event.target.value); setSlashIndex(0); }}
            onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files); } }}
            onKeyDown={(event) => {
              if (slash.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault(); setSlashIndex((value) => (value + (event.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length); return;
              }
              if (slash.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
                event.preventDefault(); pick(slash[slashIndex % slash.length].name); return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
                return;
              }
              // Esc interrupts the running mission, as in Codex.
              if (event.key === "Escape" && !draft && latest && runOpen && stop) { event.preventDefault(); stop(latest.id); }
            }} />
          <div className="cx-composer-bar">
            <button type="button" className="cx-icon-button" title="Attach files" aria-label="Attach files" disabled={busy} onClick={() => picker.current?.click()}>
              <Icon name="plus" width="16" height="16" /></button>
            <input ref={picker} type="file" multiple hidden onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
            {composer ? <AgentOrchestratorComposerControls {...composer} permissions={permissions} busy={busy || sending} /> : permissions}
            <span className="cx-head-spacer" />
            {selectedTaskId ? <ChatContextMeter sessionId={agentSessions[0]?.id} agentLabel={agentSessions[0]?.label} model={agentSessions[0]?.model}
              launchedWindow={agentSessions[0]?.contextWindow} nextWindow={composer?.route?.context_window}
              canCompact={Boolean(commands && accepts)} onCompact={() => void runCommand("compact")} /> : null}
            <button type="button" className="cx-icon-button cx-mic" aria-label="Voice input" title="Voice input isn't available yet" disabled>
              <ChatGlyph name="mic" size={16} /></button>
            {latest && runOpen && stop && !accepts && !((steering || queueing) && canSend)
              ? <button className="cx-send is-stop" type="button" aria-label="Stop (Esc)" title="Stop (Esc)" onClick={() => stop(latest.id)}><span aria-hidden="true" /></button>
              : <button className="cx-send" type="submit" aria-label={sending ? "Starting…" : steering ? "Steer the agent" : queueing ? "Queue message" : "Send message"}
                title={steering ? "Steer — sent to the working agent now (Enter)" : queueing ? "Queue — sent when the current turn finishes (Enter)" : "Send (Enter)"} disabled={!canSend}>
                  <Icon name="forward" width="18" height="18" /></button>}
          </div>
        </form>
        {selectedTaskId ? <ChatTurnStats model={agentSessions[0]?.model} rounds={turns.filter((turn) => turn.runId).length}
          from={[...turns].reverse().find((turn) => turn.runId && turn.startedAtMs)?.startedAtMs} running={runOpen} /> : null}
      </section>
      {showStructure && structure ? <aside className="cx-structure" aria-label="Cards" style={cardsWidth ? { flexBasis: cardsWidth } : undefined}>
        <div className="cx-structure-resize" role="separator" aria-orientation="vertical" aria-label="Resize the cards panel" tabIndex={0}
          aria-valuenow={cardsWidth ?? undefined} title="Drag to resize · double-click to reset"
          onPointerDown={startCardsResize} onDoubleClick={() => saveCardsWidth(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const panel = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 320;
            saveCardsWidth(clampCardsWidth(panel + (event.key === "ArrowLeft" ? 24 : -24), event.currentTarget));
          }} />
        <header><strong>Cards</strong><button type="button" className="cx-icon-button" aria-label="Hide cards" onClick={() => setShowStructure(false)}>
          <Icon name="close" width="14" height="14" /></button></header>
        <div className="cx-structure-body">{structure}</div>
      </aside> : null}
      {workbench && selectedTaskId ? <ChatWorkbench sessions={agentSessions} workspaceId={projectId} tab={workbench} onTab={setWorkbench} onClose={() => setWorkbench(null)} /> : null}
      <ChatMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  </CompactActivity.Provider>);
}

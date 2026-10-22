import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { Caret, Icon } from "../icons";
import { AgentOrchestratorComposerControls, type ComposerControlsProps } from "./AgentOrchestratorComposerControls";
import { modelShortLabel } from "./AgentOrchestratorRoleEditor";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AgentOrchestratorApproval, type AoApproval as ChatApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatWorkbench, useWorkbenchAutoOpen, type WorkbenchTab } from "./ChatWorkbench";
import { ChatBranchBar } from "./ChatBranchBar";
import { AnnotationTray, SelectionAnnotator, SentAnnotations, type DraftAnnotation } from "./ChatAnnotations";
import { ChatContextMeter } from "./ChatContextMeter";
import { ChatPet } from "./ChatPet";
import { ChatTurnStats } from "./ChatTurnStats";
import { DshTurnWork, type DshTurnWorkProps, type UseStepWork } from "./DshTranscript";
import { AnsweredRecord, ApprovedMark, EarlierRounds, EditDiff, SentMessageView, SteerReader, SteerReceiptMark, StreamingMarkdown, TurnRestart } from "./ChatToolParts";
import { PartErrorBoundary } from "../PartErrorBoundary";
import { INIT_PROMPT, planMessage, reviewPrompt } from "./codex-prompts";
import { ChatGlyph, ChatMenu, FloatingLayer, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
import {
  CHAT_DEFAULT_TITLE, GOAL_SUMMARY, goalRounds, chatAcceptsMessage, chatAnnotationsSplit, chatDuration, CHAT_MESSAGE_LIMIT, chatList, chatMessageReadable, chatMessageWithAnnotations, chatMessageWithAttachments, chatRunOpen,
  chatAgentSessions, chatAgentSummary, chatApprovalMode, chatQueueAdd, chatRunsOfMessage, chatSlashMatches, chatSlashParse, chatSlashTyping, chatTurns, goalElapsed,
  chatMessageParts, chatStatsSpan, isDeepSeekModel, petMood, type ChatSentAttachment, type QueuedChatMessage, type ChatCommandCard, type ChatCommands, type ChatActivity, type ChatAttachment, type ChatLiveItem, type ChatNode, type ChatRun, type ChatStatus, type ChatStep, type ChatTurn,
  activitySummary, groupTimeline, mergeTimeline, tidyTimeline, withoutReplied, wakeupLabel, dshQuietNote, dshRetryNote, steerReader, steerReceipts, type ChatWakeup,
} from "./ao-chat";

export { ChatThreadList as ChatListPane } from "./ChatThreadList";

const STATUS_LABEL: Record<ChatStatus, string> = {
  queued: "Starting", scheduled: "Scheduled", running: "Running", paused: "Paused", attention: "Needs you", stopped: "Stopped", done: "Done",
};
/** Text files up to this size are attached inline when their path is unknown. */
const INLINE_ATTACHMENT_BYTES = 200 * 1024;

/**
 * "Retry automatically" on the failed-step card (the user: a launch that timed out waited for a
 * click). The preference lives in the app (chat_auto_retry), so it holds for every chat and after a
 * restart; turning it on also retries the step that just failed.
 */
function AutoRetryToggle({ disabled, onRetryNow }: { disabled: boolean; onRetryNow: () => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const call = (args: { enabled: boolean } | Record<string, never>) => getCodingToolsClient().apps
    .call({ moduleId: "agent-orchestrator", operation: "chat_auto_retry", arguments: args })
    .then((outer) => Boolean(((outer as { result?: { autoRetry?: boolean } }).result ?? outer as { autoRetry?: boolean }).autoRetry));
  useEffect(() => {
    let live = true;
    call({}).then((value) => { if (live) setOn(value); }, () => { if (live) setOn(false); });
    return () => { live = false; };
  }, []);
  // A switch, not a checkbox: the box and its words wrapped onto two lines beside the button.
  return <label className="cx-auto-retry" title="A failed step runs again by itself, up to three times with a growing pause; account or sign-in failures still wait for you">
    <input type="checkbox" role="switch" checked={on === true} disabled={disabled || on === null} onChange={(event) => {
      const next = event.target.checked;
      setOn(next);
      call({ enabled: next }).then((value) => { setOn(value); if (value) onRetryNow(); }, () => setOn(!next));
    }} />
    <span className="cx-switch" aria-hidden="true" />
    <span>Retry automatically</span>
  </label>;
}

/**
 * What a chat shows when a step failed and waits for the person: which step, why (its own error,
 * which the DeepSeek transcript then leaves out of that turn), Retry and the automatic-retry switch.
 * It said only "A step failed" and a stock sentence, with the reason printed above it in the turn.
 */
function FailedStepCard({ step, notice, busy, onRetry }: {
  step?: { name?: string; error?: string }; notice?: string; busy: boolean; onRetry: () => void;
}) {
  const reason = notice || step?.error || "The step stopped before it finished.";
  return <section className="cx-card tone-error cx-fail-card" aria-labelledby="cx-fail-title">
    <svg className="cx-fail-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.4v.1" />
    </svg>
    <div className="cx-fail-body">
      <p className="cx-fail-title" id="cx-fail-title">Step failed{step?.name ? <span className="cx-fail-step">{step.name}</span> : null}</p>
      <p className="cx-fail-reason">{reason}</p>
      <div className="cx-card-actions">
        <button className="button-primary" type="button" disabled={busy} onClick={onRetry}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /></svg>
          Retry step
        </button>
        <AutoRetryToggle disabled={busy} onRetryNow={onRetry} />
      </div>
      <p className="cx-fail-hint">Or stop this chat and send a follow-up.</p>
    </div>
  </section>;
}
/** An image attachment's thumbnail URL, where the page can make one. */
const previewOf = (file: File): string | undefined => (typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(file) : undefined);
const freePreview = (url: string | undefined) => { if (url && typeof URL !== "undefined") URL.revokeObjectURL?.(url); };
/**
 * Each chat's queued messages (task id → queue), kept for the app's lifetime outside the chat view so
 * they survive the view closing (another page, the board) and switching chats.
 */
const CHAT_QUEUES = new Map<string, QueuedChatMessage[]>();
/** Each chat's unsent draft (task id → text; "" is the new-chat composer), kept while another chat is open. */
const CHAT_DRAFTS = new Map<string, string>();
/** Each chat's unsent attachments, kept alongside its draft so a file never rides into another chat. */
const CHAT_ATTACHMENTS = new Map<string, ChatAttachment[]>();
// Each chat's unsent annotations (words selected in its answers), kept like its attachments.
const CHAT_ANNOTATIONS = new Map<string, DraftAnnotation[]>();
let annotationIds = 0;
/** The cards panel's dragged width (px), kept on this computer. */
const CARDS_WIDTH_KEY = "coding-tools:ao:cards-panel-width";
/** Whether the chat's pet is shown ("off" hides it), kept on this computer. */
const PET_KEY = "coding-tools:ao:pet";
/** What an AO agent is started with; a follow-up with any of them changed gets a new agent (continuationCard). */
type RouteFields = Record<string, unknown>;
/** A route's model as the composer's picker names it ("MiMo V2.6 Pro"), not its id. */
const routeModelName = (route: RouteFields) => {
  const model = typeof route.model === "string" ? route.model : "";
  return model ? modelShortLabel(model).name || model : "the agent";
};
const routeEffortName = (route: RouteFields) => {
  const effort = typeof route.effort === "string" ? route.effort : "";
  return `${!effort ? "Auto" : effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1)} effort`;
};
const routeWindowName = (route: RouteFields) => typeof route.context_window === "number" && route.context_window > 0
  ? `${Math.round(route.context_window / 1000)}K context` : "the default context";
/**
 * What differs between the agent's route and the picked one, in the composer's own words, and
 * what to pick to get the agent back: "Max effort" / "Medium effort". The note showed the raw
 * model id and asked to switch back to the very model already picked when only the effort changed.
 */
function routeChange(agent: RouteFields, picked: RouteFields): { now: string; back: string } | null {
  const same = (field: string) => (agent[field] ?? null) === (picked[field] ?? null);
  const parts: Array<[string, string]> = [];
  if (!same("model") || !same("harness_id") || !same("provider_id") || !same("account_id")) parts.push([routeModelName(picked), routeModelName(agent)]);
  if (!same("effort")) parts.push([routeEffortName(picked), routeEffortName(agent)]);
  if (!same("context_window")) parts.push([routeWindowName(picked), routeWindowName(agent)]);
  if (["permission_profile", "native_permission_profile", "approval_policy", "approvals_reviewer"].some((field) => !same(field))) {
    parts.push(["Other permissions", "the earlier permissions"]);
  }
  if (!parts.length) return null;
  const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return { now: list(parts.map(([now]) => now)), back: list(parts.map(([, back]) => back)) };
}

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

/** What a stuck turn's Restart sends the same agent as its next turn. */
export const RESTART_MESSAGE = "Your previous turn stopped responding and was restarted. Continue the same task from where you left off; "
  + "do not start over or repeat work that is already done. If a command or tool call never returned, do not run it the same way again.";

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

/**
 * A running turn's state at its foot, where a long turn is read: how long it has worked, which card
 * is on what, and how long nothing new has come (or that its model is being retried). The "Working
 * for" label sat at the turn's top, hundreds of steps up, so a stuck turn could not be told apart.
 */
function TurnRunning({ turn }: { turn: ChatTurn }) {
  // Through context: the transcript around it is memoized and would keep a stale callback.
  const { onRestart, restarting } = useContext(TurnRestart);
  const step = turn.steps.find((item) => item.working) ?? (turn.final?.working ? turn.final : undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!step?.working) return null;
  const heardAt = Math.max(0, ...[...turn.steps, ...(turn.final ? [turn.final] : [])].map((item) => item.working?.heardAtMs ?? 0)) || undefined;
  const note = dshRetryNote(turn.steps) || dshQuietNote(heardAt, now);
  return <p className={`cx-note cx-turn-running${step.working.stalled ? " is-stalled" : ""}`} role="status" aria-live="polite">
    <span className="cx-shimmer">Working</span>{turn.startedAtMs ? <> for <Elapsed since={turn.startedAtMs} /></> : null}
    {` · ${step.name}${step.working.activity ? ` — ${step.working.activity}` : ""}${note}`}
    {/* A stuck turn has a button of its own: the person looking at "may be stuck" had nothing to
        press, and a tool call that never returned held a chat for hours (Restart: chat_steer's restart). */}
    {note.includes("may be stuck") ? onRestart
      ? <> · <button type="button" className="cx-turn-restart" onClick={onRestart} disabled={restarting}
        title="Stop this turn and have the same agent continue where it left off">{restarting ? "Restarting…" : "Restart"}</button></>
      : " · send a message to restart it" : ""}
  </p>;
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
  const [open, setOpen] = useState(false);
  const lines = item.text.trim().split(/\r?\n/);
  const running = item.status === "running";
  if (!lines[0]) return <span className="cx-live-label">{running ? "Thinking…" : "Thought"}</span>;
  const label = running ? "Thinking" : "Thought";
  // Live reasoning arrives as its newest part, so it headlines the current thought, not the first.
  const current = running ? lines.filter((line) => line.trim()).at(-1) ?? lines[0] : lines[0];
  const headline = current.replace(/^\s*\*\*(.+?)\*\*\s*$/, "$1").replace(/[*_`]/g, "").trim();
  // A model that thinks in one long paragraph shows it as one line, the whole of it a click away.
  const rest = running
    ? (lines.length > 1 || headline.length > 140 ? item.text.trim() : "")
    : lines.slice(1).join("\n").trim() || (headline.length > 140 ? headline : "");
  // The body is parsed only while it is open: a long thought streams in on every poll, and parsing
  // it inside a closed <details> cost the chat its frame rate for nothing anyone saw.
  return rest
    ? <details className="cx-reasoning" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span className="cx-live-label">{label}</span><span className="cx-live-text">{headline}</span></summary>
      {open ? <div className="cx-reasoning-body"><ChatMarkdown text={rest} /></div> : null}</details>
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
    <span className="cx-live-text">{toolHeadline(item)}</span><ApprovedMark text={item.approval} /></>;
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
    <DiffCount additions={additions} deletions={deletions} /><ApprovedMark text={item.approval} /></>;
  if (!files.some((file) => file.diff)) return <div className={`cx-tool tone-${tone}`}><div className="cx-tool-row">{head}</div></div>;
  return <details className={`cx-tool cx-edit tone-${tone}`}><summary>{head}</summary>
    <div className="cx-tool-body">
      {files.map((file) => <section key={file.path} className="cx-edit-file">
        {files.length > 1 ? <header><span title={file.path}>{fileName(file.path)}</span><DiffCount additions={file.additions} deletions={file.deletions} /></header> : null}
        {file.diff ? <EditDiff diff={file.diff} /> : null}
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
// An edit's files arrive as new objects with every poll (IPC copies them), so they compare by content.
const sameFiles = (a: ChatLiveItem["files"], b: ChatLiveItem["files"]) => a === b || (Boolean(a) && Boolean(b) && a!.length === b!.length
  && a!.every((file, index) => file.path === b![index].path && file.additions === b![index].additions
    && file.deletions === b![index].deletions && file.diff === b![index].diff));
const sameLiveItem = (a: ChatLiveItem, b: ChatLiveItem) => a === b || (a.id === b.id && a.kind === b.kind && a.status === b.status
  && a.text === b.text && a.label === b.label && a.description === b.description && a.approval === b.approval
  && a.answered?.question === b.answered?.question && a.answered?.answer === b.answered?.answer
  && a.input === b.input && a.output === b.output && a.receipt === b.receipt && sameFiles(a.files, b.files));
const LiveRow = memo(LiveRowView, (prev, next) => sameLiveItem(prev.item, next.item));

function LiveRowView({ item }: { item: ChatLiveItem }) {
  return <li className={`cx-live-item kind-${item.kind} is-${item.status || "done"}`}>
    {item.answered ? <AnsweredRecord question={item.answered.question} answer={item.answered.answer} />
      // As any sent message: an attached image as its thumbnail, not "Attached image: <path>" text.
      // Claude Code shows a message the agent took mid-turn as an ordinary sent message, Copy and all.
      // Its read receipt leads the row, as Claude Code's "Read by Claude" leads Copy (steerReceipts).
      : item.kind === "steer" ? <div className="cx-user cx-steer"><SentMessage text={item.text} />
        <div className="cx-msg-foot"><SteerReceiptMark receipt={item.receipt} /><MessageActions text={chatMessageReadable(item.text)} /></div></div>
      : item.kind === "message" ? <StreamingMarkdown text={item.text} live={item.status === "running"} />
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
    <button type="button" className="cx-activity-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="chevron" width="11" height="11" className={open ? "is-open" : undefined} />
      <span className={`cx-group-verb${live ? " cx-shimmer" : ""}`}>{live ? "Working" : "Explored"}</span>
      <span className="cx-group-text">{activitySummary(items)}</span>
    </button>
    {open ? <ol className="cx-live">{items.map((item) => <LiveRow key={item.id} item={item} />)}</ol>
      : live && latest ? <ol className="cx-live cx-group-now"><LiveRow item={latest} /></ol> : null}
  </div>;
}

/** A role's turn, as Codex and Claude Code show it: thinking, tool calls and streamed messages. */
function LiveTimeline({ items, live = false, finished = false, reply }: { items: ChatLiveItem[]; live?: boolean; finished?: boolean; reply?: string }) {
  const compact = useContext(CompactActivity);
  // A message the reply below already holds is not shown twice (withoutReplied).
  const tidy = withoutReplied(tidyTimeline(steerReceipts(items, finished)), reply);
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
 * a card finished before is read back from AO once, when its work is first opened. A copy taken
 * while the card worked is read back once more when it finishes: the last poll can miss the final
 * items, or leave a row on "Running…".
 */
const CHAT_WORK = new Map<string, ChatLiveItem[]>();
const CHAT_WORK_LIVE = new Set<string>();
type LoadWork = (runId: string, nodeId: string) => Promise<ChatLiveItem[]>;

function useStepWork(step: ChatStep, runId: string, wanted: boolean, loadWork?: LoadWork): ChatLiveItem[] | null {
  // Kept per attempt: a retried card starts again (a new start time) with nothing of the last one.
  // Within an attempt nothing seen is ever dropped (mergeTimeline).
  const workKey = `${step.key}@${step.startedAtMs ?? ""}`;
  const live = step.working?.timeline;
  const [, setLoaded] = useState(0);
  // A poll carries only the turn's newest items; the ones before them stay (mergeTimeline).
  if (live?.length) { CHAT_WORK.set(workKey, mergeTimeline(CHAT_WORK.get(workKey), live)); CHAT_WORK_LIVE.add(workKey); }
  const known = CHAT_WORK.get(workKey) ?? null;
  const settled = !step.working;
  useEffect(() => {
    if (!wanted || !step.hasWork || !loadWork || (known && !(settled && CHAT_WORK_LIVE.has(workKey)))) return;
    CHAT_WORK_LIVE.delete(workKey);
    let current = true;
    void loadWork(runId, step.nodeId).then((items) => {
      if (!items.length) return;
      // A finished turn read back whole keeps every entry; only live polls are capped.
      CHAT_WORK.set(workKey, mergeTimeline(CHAT_WORK.get(workKey), items, { cap: Infinity }));
      if (current) setLoaded((count) => count + 1);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [wanted, known, settled, step.hasWork, workKey, step.nodeId, runId, loadWork]);
  return known;
}

function StepRow({ step, runId, loadWork }: { step: ChatStep; runId: string; loadWork?: LoadWork }) {
  // A failed step opens on its error and a working one on its live turn, as Codex shows them;
  // once the user toggles a row, their choice wins.
  const [chosen, setOpen] = useState<boolean | null>(null);
  const open = chosen ?? Boolean(step.error || step.working?.timeline?.length);
  const work = useStepWork(step, runId, open, loadWork);
  const compact = useContext(CompactActivity);
  const body = step.error || step.text || (work?.length || step.hasWork || step.earlier?.length ? "work" : "");
  return <li className={`cx-step tone-${stepTone(step)}`}>
    <button type="button" className="cx-step-head" aria-expanded={open} disabled={!body && !step.working} onClick={() => setOpen(!open)}
      title={step.working?.detail || undefined}>
      <span className="cx-step-dot" aria-hidden="true" />
      <span className="cx-step-name">{step.name}</span>
      <span className="cx-step-meta">
        {/* A stalled card still says where: "may be stuck · running pytest … (timeout 5m)". */}
        {step.working ? (step.working.stalled ? `may be stuck${step.working.activity ? ` · ${step.working.activity}` : ""}` : step.working.activity || "working")
          : step.error ? "failed" : step.verdict || (step.state === "finished" ? "done" : step.state)}
        {step.working && step.startedAtMs ? <> · <Elapsed since={step.startedAtMs} /></> : null}
      </span>
      {body ? <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} /> : null}
    </button>
    {open ? <div className="cx-step-body">
      {step.detail ? <p className="cx-step-detail">{step.detail}</p> : null}
      {step.working && !compact ? <p className="cx-step-detail">{step.working.detail}</p> : null}
      {/* Its earlier rounds first, folded (oldest first), then the attempt now: a retried card's
          failed attempt showed under the new attempt's work, as if it came after it. */}
      <EarlierRounds rounds={step.earlier} />
      {work?.length ? <SteerReader.Provider value={steerReader(step.detail)}>
        <LiveTimeline items={work} live={Boolean(step.working)} finished={!step.working && step.state === "finished"} reply={step.text} />
      </SteerReader.Provider> : null}
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
    {open ? work?.length ? <SteerReader.Provider value={steerReader(step.detail)}>
      <LiveTimeline items={work} finished={!step.working && step.state === "finished"} reply={step.text} />
    </SteerReader.Provider> : <p className="cx-tool-empty">Loading…</p> : null}
  </div>;
}

type WorkGroupProps = { turn: ChatTurn; idle?: boolean; expanded?: boolean; loadWork?: LoadWork };

/** A turn still being worked on: its steps change on every update, so it always re-renders. */
const liveTurn = (turn: ChatTurn) => turn.status === "running" || turn.status === "queued"
  || turn.steps.some((step) => step.working) || Boolean(turn.final?.working);
const roundsKey = (step: ChatStep) => (step.earlier ?? []).map((round) => `${round.label}:${round.verdict ?? ""}`).join(",");
/** Whether two steps show the same: compared field by field, stopping at the first difference. */
const sameStep = (a: ChatStep, b: ChatStep) => a === b || (a.key === b.key && a.name === b.name && a.detail === b.detail
  && a.state === b.state && (a.verdict ?? "") === (b.verdict ?? "") && (a.error ?? "") === (b.error ?? "")
  && (a.text ?? "") === (b.text ?? "") && (a.hasWork ?? false) === (b.hasWork ?? false) && roundsKey(a) === roundsKey(b));
/**
 * Whether a finished turn's work shows the same. It was a JSON.stringify of every step's whole text
 * for both turns, twice a turn on every second's update: work that grew with the length of the chat.
 */
const sameTurnWork = (a: ChatTurn, b: ChatTurn) => a.runId === b.runId && a.status === b.status
  && (a.startedAtMs ?? 0) === (b.startedAtMs ?? 0) && a.steps.length === b.steps.length
  && a.steps.every((step, index) => sameStep(step, b.steps[index]))
  && (a.final && b.final ? sameStep(a.final, b.final) : !a.final && !b.final);

/**
 * A finished turn's work is skipped on re-render unless it changed. The chat rebuilds every turn
 * object on each update, and re-diffing a long chat's finished work (thousands of rows) blocked
 * the page for up to a second each time; only the live turn needs the work.
 */
export function sameWork(prev: WorkGroupProps, next: WorkGroupProps): boolean {
  if (prev.idle !== next.idle || prev.expanded !== next.expanded || prev.loadWork !== next.loadWork) return false;
  if (prev.turn === next.turn) return true;
  if (liveTurn(prev.turn) || liveTurn(next.turn)) return false;
  return sameTurnWork(prev.turn, next.turn);
}

const WorkGroup = memo(WorkGroupView, sameWork);
/** A DeepSeek turn's work (DshTranscript), skipped on re-render by the same check as WorkGroup. */
const DshWork = memo(DshTurnWork, (prev: DshTurnWorkProps, next: DshTurnWorkProps) => prev.live === next.live
  && prev.useWork === next.useWork && prev.errorShownBelow === next.errorShownBelow && sameWork({ turn: prev.turn, expanded: prev.expanded }, { turn: next.turn, expanded: next.expanded }));

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

/** Reads an attached image for its thumbnail and shows a file in its folder (the desktop app's). */
type AttachmentAccess = { preview?: (path: string) => Promise<string>; reveal?: (path: string) => void };
const Attachments = createContext<AttachmentAccess>({});
/** Thumbnails already read, by path: a poll re-renders every message, and each image is read once. */
const PREVIEWS = new Map<string, Promise<string>>();

function SentImage({ item, onOpen }: { item: ChatSentAttachment; onOpen: (url: string) => void }) {
  const { preview } = useContext(Attachments);
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!item.path || !preview) return;
    let current = true;
    let read = PREVIEWS.get(item.path);
    if (!read) { read = preview(item.path); PREVIEWS.set(item.path, read); }
    read.then((value) => { if (current) setUrl(value); }, () => { PREVIEWS.delete(item.path!); if (current) setMissing(true); });
    return () => { current = false; };
  }, [item.path, preview]);
  return <button type="button" className={`cx-sent-image${missing ? " is-missing" : ""}`} title={item.path} disabled={!url} onClick={() => url && onOpen(url)}>
    {url ? <img src={url} alt={item.name} /> : <span>{missing ? "Image not found" : item.name}</span>}
  </button>;
}

/** SentMessage for the DeepSeek transcript (SentMessageView), which cannot import this file. */
const sentMessageView = (text: string) => <SentMessage text={text} />;

/**
 * A message the person sent, as Claude Code shows one: its attachments above the bubble (images as
 * thumbnails that open full size, other files as cards that show them in their folder), and in
 * the bubble only what they typed.
 */
function SentMessage({ text }: { text: string }) {
  const { reveal } = useContext(Attachments);
  const [open, setOpen] = useState<string | null>(null);
  const parts = chatMessageParts(text);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return <>
    {parts.attachments.length ? <div className="cx-sent-attachments">
      {parts.attachments.map((item, index) => item.image && item.path
        ? <SentImage key={`${item.path}:${index}`} item={item} onOpen={setOpen} />
        : <button key={`${item.name}:${index}`} type="button" className="cx-sent-file" disabled={!item.path || !reveal}
          title={item.path ? `${item.path}\nClick to show it in its folder` : `${item.name} (sent inline)`} onClick={() => item.path && reveal?.(item.path)}>
          <span className="cx-sent-file-icon" aria-hidden="true">{/\.pdf$/i.test(item.name) ? "PDF" : "TXT"}</span>
          <span className="cx-sent-file-name">{item.name}</span>
        </button>)}
    </div> : null}
    {parts.annotations?.length ? <SentAnnotations annotations={parts.annotations} /> : null}
    {parts.text ? <div className="cx-bubble"><p>{parts.text}</p></div> : null}
    {open ? <div className="cx-lightbox" role="dialog" aria-label="Image preview" onClick={() => setOpen(null)}>
      <img src={open} alt="" onClick={(event) => event.stopPropagation()} />
      <button type="button" className="cx-lightbox-close" aria-label="Close image preview" onClick={() => setOpen(null)}>×</button>
    </div> : null}
  </>;
}

function MessageActions({ text, children }: { text: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return <div className="cx-msg-actions">
    <button type="button" title="Copy" aria-label="Copy message" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
      {copied ? <Icon name="check" width="14" height="14" /> : "⧉"}</button>
    {children}
  </div>;
}

/** A message in the queued-message bar: waiting to be sent ("queued"), or on its way to the agent ("pending"). */
type QueuedBarItem = {
  key: string; text: string; state: "queued" | "pending";
  onRemove?: () => void; onEdit?: () => void; onSendNow?: () => void; sendNowBlocked?: string;
};

/** Whether a click inside a queued bubble came from a control of its own (an attachment's button, link or image). */
function queuedNestedControl(target: EventTarget | null, bubble: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  const control = typeof element?.closest === "function" ? element.closest("button, a, input, img, [role='button'], [role='link']") : null;
  return Boolean(control) && control !== bubble;
}

/** The X of Claude Code's "Discard queued message" (its cds "X" icon, 16 px). */
function QueuedDiscardGlyph() {
  return <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>;
}

/**
 * Claude Code's queued messages (claude.ai's composer queue rows, data-testid "pending-queue-row"):
 * a message sent while the agent works waits right above the composer, newest last, as the
 * person's own bubble collapsed to one line with its text greyed, and "Queued" under it. Its X
 * ("Discard queued message") shows on hover or focus just past the bubble's end; the first one also
 * has "Send now". One on its way to the agent pulses and has no actions. Screen readers hear Claude
 * Code's own status line. Not in Claude Code: clicking a queued bubble puts it back in the composer
 * to edit (the earlier bar's "Edit in composer").
 */
function QueuedMessageBar({ items }: { items: QueuedBarItem[] }) {
  if (!items.length) return null;
  const waiting = items.filter((item) => item.state === "queued").length;
  const head = items.findIndex((item) => item.state === "queued");
  return <div className="cx-queued">
    <span className="cx-sr-only" role="status">{waiting === 0 ? "" : waiting === 1 ? "1 message queued. Will send after the current response."
      : `${waiting} messages queued. Will send after the current response.`}</span>
    <ol className="cx-queued-list" aria-label="Queued messages">
      {items.map((item, index) => <li key={item.key} className="cx-queued-row" data-state={item.state}>
        <div className="cx-queued-bubble">
          {item.state === "queued" && item.onEdit
            ? <div className="cx-user cx-queued-message" role="button" tabIndex={0} aria-label="Edit in composer" title="Edit in composer"
              // A click on the message's own attachment (an image preview, a file) is for that control:
              // bubbled up, it dequeued the message and unmounted the preview it had just opened.
              onClick={(event) => { if (!queuedNestedControl(event.target, event.currentTarget)) item.onEdit?.(); }}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); item.onEdit?.(); }
              }}>
              <SentMessage text={item.text} /></div>
            : <div className="cx-user cx-queued-message"><SentMessage text={item.text} /></div>}
          {item.state === "queued" ? <span className="cx-queued-discard">
            <button type="button" aria-label="Discard queued message" data-tip="Discard queued message" onClick={item.onRemove}><QueuedDiscardGlyph /></button>
          </span> : null}
        </div>
        {item.state === "queued" ? <div className="cx-queued-meta">
          {index === head && item.onSendNow ? <button type="button" className="cx-queued-send-now" aria-label="Send now"
            data-tip={item.sendNowBlocked ?? "Send now"} disabled={Boolean(item.sendNowBlocked)} onClick={item.onSendNow}>Send now</button> : null}
          <span className="cx-queued-status">Queued</span>
        </div>
          // On its way to the agent: Claude Code's "Sending…" under the message until the agent has it.
          : <div className="cx-queued-meta"><span className="cx-queued-status" role="status">Sending…</span></div>}
      </li>)}
    </ol>
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

/** The agent asked to be woken later (schedule_wakeup): when, its note, and Cancel. The label ticks alone. */
function WakeupBar({ wakeup, onCancel }: { wakeup: ChatWakeup; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="cx-goal cx-wakeup is-active" role="status">
    <span className="cx-wakeup-glyph" aria-hidden="true">◷</span>
    <span className="cx-goal-state" title={`Asked for ${wakeup.minutes} min at ${new Date(wakeup.scheduledAt).toLocaleTimeString()}`}>{wakeupLabel(wakeup, now)}</span>
    <span className="cx-goal-objective" title={wakeup.reason}>{wakeup.reason}</span>
    <button type="button" title="Cancel wake-up" aria-label="Cancel wake-up" onClick={onCancel}>Cancel</button>
  </div>;
}

export function AgentOrchestratorChat({
  runs, tasks, selectedTaskId, busy, loadDescription, send, openStructure,
  approvals, approve, describeRoute: _describeRoute, notice, retryStart, working = false, describeNode, activity, modelName, permissions, composer, onOpenTeam, onOpenMissionBoard,
  projectName, stop, restart, thread, structure, onPause, onResume, onSettings, filePath, saveAttachment, revealFile, attachmentPreview, seed, onSeedUsed, headerExtra, onOpenProject, projects, projectId, onPickProject, onAddProject, projectBranch: branch, steer,
  pendingMessage, pendingTitle, pendingCreation = false, deciding = false, onComposing, commands, loadWork,
}: {
  /** A finished card's thinking and tool calls, read back from its AO session (turn_timeline). */
  loadWork?: LoadWork;
  /** Codex slash commands that need the page: goal, compact, diff, MCP, status, recent chats, plan mode. */
  commands?: ChatCommands;
  /** A message being sent into a chat that has no run yet (shown at once, as Codex does). */
  pendingMessage?: string; pendingTitle?: string; pendingCreation?: boolean;
  /** Which chat to show is not known yet (a project is opening): show neither a chat nor the new chat page. */
  deciding?: boolean;
  /** The user started typing a message: the surface gets the agent it needs ready (chat_prewarm). */
  onComposing?: () => void;
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
  /** `restart`: stop the turn and send the message as its next turn, whatever its quiet time (Restart). */
  steer?: (input: { taskId: string; message: string; restart?: boolean }) => Promise<boolean | "wait" | "restart" | "interrupt" | "starting">;
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
  /** Saves a path-less attachment (a pasted screenshot) where the agent can open it; its path. */
  saveAttachment?: (input: { name: string; type: string; bytes: Uint8Array }) => Promise<{ path: string }>;
  /** Shows an attached file in the system file manager. */
  revealFile?: (path: string) => void;
  /** An attached image as a data: URL, for its thumbnail in a sent message. */
  attachmentPreview?: (path: string) => Promise<string>;
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
  // Steers shown at once while they reach the agent (deliver), until the turn shows them itself.
  // `waiting`: the agent was busy with a request of its own, so the steer waits in the chat's queue
  // and goes in once the request is answered; it stays shown meanwhile.
  const [pendingSteers, setPendingSteers] = useState<{ id: string; taskId: string | undefined; text: string; at: number; waiting?: boolean }[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachNote, setAttachNote] = useState("");
  // Words selected in this chat's answers and added to the next message (ChatAnnotations).
  // Ones kept when this chat was last left (another view, another chat) come back with it.
  const [annotations, setAnnotations] = useState<DraftAnnotation[]>(() => {
    const kept = CHAT_ANNOTATIONS.get(selectedTaskId) ?? [];
    CHAT_ANNOTATIONS.delete(selectedTaskId);
    return kept;
  });
  const addAnnotation = (text: string, anchor?: DraftAnnotation["anchor"]) => {
    const id = ++annotationIds;
    setAnnotations((current) => [...current, { id, text, comment: "", ...(anchor ? { anchor } : {}) }]);
    return id;
  };
  const commentAnnotation = (id: number, comment: string) =>
    setAnnotations((current) => current.map((item) => item.id === id ? { ...item, comment } : item));
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
  // The message being sent, shown at once as Claude Code shows it: the send (saving the chat,
  // starting its run, reloading the board) took seconds, and the message sat in the composer
  // meanwhile as if nothing happened. It shows as the chat's next message until the saved chat has it.
  const [outgoing, setOutgoing] = useState<{ taskId: string; message: string; stamp: string; sent: boolean; at: number } | null>(null);
  const savedDescription = descriptions[selectedTaskId] ?? pendingMessage;
  const shownDescription = useMemo(() => {
    if (!outgoing || outgoing.taskId !== (selectedTaskId ?? "")) return savedDescription;
    if (!savedDescription) return outgoing.message;
    if (savedDescription.endsWith(outgoing.message)) return savedDescription;
    return `${savedDescription}\n\nFollow-up (${outgoing.stamp} UTC):\n${outgoing.message}`;
  }, [savedDescription, outgoing, selectedTaskId]);
  // Once sent, it gives way to the saved chat when that has it (or after a while, if it never reads back).
  useEffect(() => {
    if (!outgoing?.sent) return undefined;
    const saved = descriptions[outgoing.taskId];
    if (!outgoing.taskId || (saved && saved.endsWith(outgoing.message))) { setOutgoing(null); return undefined; }
    const timer = window.setTimeout(() => setOutgoing((current) => (current === outgoing ? null : current)), Math.max(0, 20_000 - (Date.now() - outgoing.at)));
    return () => window.clearTimeout(timer);
  }, [outgoing, descriptions]);
  const turns: ChatTurn[] = useMemo(
    () => chatTurns(chatRuns, shownDescription, { describe: describeNode, activity, now, modelName }),
    [chatRuns, shownDescription, describeNode, activity, now, modelName],
  );
  // A steer shown at once gives way to the turn's own record of it (its live timeline, or the
  // steers under its message once it is done), or after a minute at most. One still waiting in its
  // chat's queue stays as long as it waits there.
  useEffect(() => {
    if (!pendingSteers.length) return;
    const seen = new Set<string>();
    for (const turn of turns) {
      for (const steer of turn.user?.steers ?? []) seen.add(steer.text.trim());
      for (const step of turn.steps) for (const item of step.working?.timeline ?? []) if (item.kind === "steer") seen.add(item.text.trim());
    }
    const fresh = (entry: typeof pendingSteers[number]) => Date.now() - entry.at < 60_000
      || Boolean(entry.waiting && entry.taskId && (CHAT_QUEUES.get(entry.taskId) ?? []).some((item) => item.message === entry.text));
    const keep = pendingSteers.filter((entry) => !seen.has(entry.text.trim()) && fresh(entry));
    if (keep.length !== pendingSteers.length) setPendingSteers(keep);
    const timer = window.setTimeout(() => setPendingSteers((list) => list.filter(fresh)), 60_000);
    return () => window.clearTimeout(timer);
  }, [turns, pendingSteers]);
  // The stats line counts the latest turn and the unfinished attempts before it (chatStatsSpan).
  const statsSpan = useMemo(() => chatStatsSpan(turns, chatRuns), [turns, chatRuns]);
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
  // A click in the thread (opening "Worked", a group, a tool's output) grows it too, but that is the
  // user reading: the view stays on what they opened and following stops if it left the bottom.
  const following = useRef(atBottom);
  following.current = atBottom;
  const clicked = useRef(false);
  useEffect(() => {
    const box = scroller.current, content = column.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (clicked.current) { clicked.current = false; setAtBottom(box.scrollHeight - box.scrollTop - box.clientHeight < 48); return; }
      // Instant, like the follow above: setting scrollTop obeys the theme's smooth scrolling, and the
      // animation's in-between scroll events read as "left the bottom" and ended following. Seen
      // live: right after a send (the thread grows a lot at once) the view stopped on an older
      // message and stayed there.
      if (following.current) box.scrollTo({ top: box.scrollHeight, behavior: "instant" });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [selectedTaskId]);
  // Compact activity (the header's toggle): tool calls and thinking fold into one line per run.
  const [compactActivity, setCompactActivity] = useState(() => { try { return localStorage.getItem(COMPACT_ACTIVITY_KEY) !== "off"; } catch { return true; } });
  const toggleCompact = () => setCompactActivity((current) => {
    try { localStorage.setItem(COMPACT_ACTIVITY_KEY, current ? "off" : "on"); } catch { /* applies now regardless */ }
    return !current;
  });
  // Bit, the chat's pet (ChatPet), shown unless turned off from the header menu or its own right-click.
  const [petOn, setPetOn] = useState(() => { try { return localStorage.getItem(PET_KEY) !== "off"; } catch { return true; } });
  const togglePet = () => setPetOn((current) => {
    try { localStorage.setItem(PET_KEY, current ? "off" : "on"); } catch { /* applies now regardless */ }
    return !current;
  });
  // The context ring's reading, which the pet's belly follows.
  const [contextShare, setContextShare] = useState<number | null>(null);
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
  const composing = useRef({ taskId: selectedTaskId, draft, attachments, annotations });
  composing.current = { taskId: selectedTaskId, draft, attachments, annotations };
  // Leaving the chat view (the Mission Board, the structure view) unmounts this chat without
  // changing chats: its unsent annotations are kept for when it comes back.
  useEffect(() => () => {
    const { taskId, annotations: kept } = composing.current;
    if (kept.length) CHAT_ANNOTATIONS.set(taskId, kept);
  }, []);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (draftOwner.current === selectedTaskId) return;
    if (draft) CHAT_DRAFTS.set(draftOwner.current, draft); else CHAT_DRAFTS.delete(draftOwner.current);
    if (attachments.length) CHAT_ATTACHMENTS.set(draftOwner.current, attachments); else CHAT_ATTACHMENTS.delete(draftOwner.current);
    if (annotations.length) CHAT_ANNOTATIONS.set(draftOwner.current, annotations); else CHAT_ANNOTATIONS.delete(draftOwner.current);
    setDraft(CHAT_DRAFTS.get(selectedTaskId) ?? "");
    setAttachments(CHAT_ATTACHMENTS.get(selectedTaskId) ?? []);
    setAnnotations(CHAT_ANNOTATIONS.get(selectedTaskId) ?? []);
    setAttachNote("");
    CHAT_DRAFTS.delete(selectedTaskId);
    CHAT_ATTACHMENTS.delete(selectedTaskId);
    CHAT_ANNOTATIONS.delete(selectedTaskId);
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
  // Starting to type gets the agent the message needs ready (the surface throttles it); a run that
  // is open already has its agent.
  const hasDraft = Boolean(draft.trim());
  useEffect(() => { if (hasDraft && !runOpen) onComposing?.(); }, [hasDraft, runOpen, onComposing]);
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
  // While a project opens the chat to send into is not chosen yet: sending then started a new chat
  // although an existing one was about to open. The draft waits until it is.
  // A steer goes straight to the agent and a queued message waits here: neither takes the surface's
  // one-action lock (busy), which an approval or a refresh holds often while a chat runs. Waiting on
  // it kept the Stop button in place of Steer while the user typed.
  // A message typed while the previous one is still being sent waits in the queue, as Claude Code
  // queues one typed during a response. Enter did nothing at all then, so a quick second message
  // looked dropped.
  const queueWhileSending = sending && Boolean(selectedTaskId) && !steering;
  const canSend = (!busy || steering || queueing || queueWhileSending) && (!sending || queueWhileSending) && !(deciding && !selectedTaskId)
    && Boolean(draft.trim() || attachments.length || annotations.length) && (accepts || steering || queueing || queueWhileSending);
  const slash = chatSlashMatches(draft, { chat: Boolean(selectedTaskId), run: Boolean(latest), open: runOpen });

  // What a command shows above the composer (its result, or why it couldn't run).
  const [card, setCard] = useState<ChatCommandCard | null>(null);
  // Edit goal: the objective being edited, or null.
  const [goalEditing, setGoalEditing] = useState<string | null>(null);
  // Another chat's card or goal edit never shows over this one (its queue says so itself, below).
  useEffect(() => { setCard(null); setGoalEditing(null); }, [selectedTaskId]);
  const say = (title: string, text: string, quote?: string) => setCard({ title, text, ...(quote ? { quote } : {}) });

  /**
   * Sends a message the way the composer does: into this chat, or as a new chat. A queued message
   * sent in the background (fromComposer false) leaves whatever the user is typing alone.
   */
  /** `restart`: the stuck turn's Restart: stop it and send `message` as its next turn (chat_steer's restart). */
  const deliver = async (message: string, goal?: string, fromComposer = true, restart = false) => {
    const owner = composing.current;
    const here = () => alive.current && composing.current.taskId === owner.taskId;
    // Only what was sent is cleared: a draft, file or annotation added while it was sending stays.
    const current = () => fromComposer && here() && composing.current.draft === owner.draft && composing.current.attachments === owner.attachments
      && composing.current.annotations === owner.annotations;
    // A steer shows at once, as in Claude Code: the composer clears and the message waits in the
    // queued-message bar, pulsing, while it reaches the agent, which can take seconds (it waits out
    // an approval being answered). Until then the box held the text and the Stop button stayed.
    const steerNow = !goal && (steering || restart) && Boolean(steer && selectedTaskId);
    // A steer sent again from the queue keeps the bubble it already has, not a second one.
    const pendingId = steerNow ? pendingSteers.find((entry) => entry.taskId === selectedTaskId && entry.text === message)?.id
      ?? `steer-${Date.now()}-${Math.random().toString(36).slice(2)}` : "";
    if (steerNow) {
      setPendingSteers((list) => list.some((entry) => entry.id === pendingId)
        ? list.map((entry) => entry.id === pendingId ? { ...entry, at: Date.now() } : entry)
        : [...list, { id: pendingId, taskId: selectedTaskId, text: message, at: Date.now() }]);
      if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
    } else setSending(true);
    const dropPending = () => { if (pendingId) setPendingSteers((list) => list.filter((entry) => entry.id !== pendingId)); };
    try {
      // A steer the turn outran (it ended first) is sent as an ordinary follow-up instead; a goal is never steered.
      const steered = steerNow ? await steer!({ taskId: selectedTaskId, message, ...(restart ? { restart: true } : {}) }) : false;
      // The agent is busy with a request of its own (or still starting): the steer waits in the queue
      // and goes in once it can. It stays shown as steering; a "Queued" card here read as if the
      // message had not been sent at all ("it pop up as queued for no reason").
      const waits = steered === "wait" || steered === "starting";
      // Delivered: it stays shown until the turn shows it (see pendingSteers); anything else drops it.
      if (steered !== true && !waits) dropPending();
      if (waits) setPendingSteers((list) => list.map((entry) => entry.id === pendingId ? { ...entry, waiting: true } : entry));
      if (steerNow && steered === false) setSending(true);
      if ((steered === "wait" || steered === "restart" || steered === "interrupt" || steered === "starting") && selectedTaskId) {
        // The agent was found waiting on its own request just now (the page had not seen it yet):
        // steering would cancel that request, so the message waits for the turn like a queued one.
        // Or its turn had hung, or sat in a long command that would have kept it from reading the
        // message, and was stopped: the message goes as the same agent's next turn once it settles.
        setQueue(selectedTaskId, chatQueueAdd(queueOf(selectedTaskId), { what: "Message", message }));
        if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
        // The queued-message bar shows a waiting steer, as Claude Code does; only a stopped turn is told.
        if (here() && !waits) {
          say(steered === "restart" ? "Restarting" : "Interrupting", steered === "restart"
            ? "The agent had stopped responding, so its turn was stopped; your message is sent as the next turn."
            : "A command was still running, so it was stopped; the same agent gets your message next, with everything it already knows.",
            chatMessageReadable(message));
        }
        return true;
      }
      // A rewound chat's first message takes the earlier messages along ahead of it, as context.
      const first = !selectedTaskId && carried?.length ? [...carried, message].join("\n\n").slice(-8192) : message;
      // Shown at once: the message leaves the composer and appears in the chat while it is sent.
      const shown = !steered && !goal && fromComposer && here();
      if (shown) {
        const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
        setOutgoing({ taskId: selectedTaskId ?? "", message: selectedTaskId ? message : first, stamp, sent: false, at: Date.now() });
        if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
        setAtBottom(true);
      }
      if (!steered) {
        try {
          await send(selectedTaskId ? { taskId: selectedTaskId, message, ...(goal ? { goal } : {}) }
            : { title: title.trim() || undefined, message: first, ...(goal ? { goal } : {}) });
        } catch (error) {
          // Not sent: it goes back where it was typed, unless something new was typed meanwhile, or
          // it is only refused for now (it then waits in the queue; see the catch below).
          if (shown) {
            setOutgoing(null);
            if (here() && !composing.current.draft && !/still running|focused app window/i.test(String((error as Error)?.message ?? error))) {
              setDraft(owner.draft); setAttachments(owner.attachments); setAnnotations(owner.annotations);
            }
          }
          throw error;
        }
        if (shown) setOutgoing((pending) => pending && { ...pending, sent: true });
      }
      if (fromComposer && CHAT_DRAFTS.get(owner.taskId) === owner.draft) CHAT_DRAFTS.delete(owner.taskId);
      if (fromComposer && CHAT_ATTACHMENTS.get(owner.taskId) === owner.attachments) CHAT_ATTACHMENTS.delete(owner.taskId);
      if (current() || (shown && here())) {
        if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
        setTitle("");
        if (!selectedTaskId) setCarried(null);
      }
      if (here()) setAtBottom(true);
      return true;
    } catch (error) {
      dropPending();
      // Refused only for the moment, not for what it says: the chat started working again under it
      // (seen live: "Retrying automatically in 5s" restarted the run as the message went, and "This
      // chat is still running" sent it back to the composer), or the window was not in front (sends
      // run only from the focused window). It waits at the front of the queue instead, steered in or
      // sent as soon as it can be, or once the window is back in front.
      const why = String((error as Error)?.message ?? error);
      const busyNow = /still running/i.test(why), unfocused = /focused app window/i.test(why);
      if (selectedTaskId && (busyNow || unfocused)) {
        // Held until the chat's state changes (sentWhileFree): the chat could still read as free for a
        // moment, and the queue would send it again and again into the same refusal.
        if (busyNow) sentWhileFree.current = true;
        setQueue(selectedTaskId, [{ what: "Message", message, ...(goal ? { goal } : {}) }, ...queueOf(selectedTaskId)]);
        if (unfocused) setWindowFocused(false);
        // It shows in the queued-message bar above the composer (#466), which has no notice cards.
        if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
        return true;
      }
      // The surface already shows the error; keep the message so it can be sent again. A steer had
      // cleared the composer at once: what was typed comes back, unless something new was typed since.
      if (steerNow && here() && !composing.current.draft.trim() && !composing.current.attachments.length) {
        setDraft(owner.draft); setAttachments(owner.attachments); setAnnotations(owner.annotations);
      }
      return false;
    } finally { setSending(false); }
  };
  // Restart on a stuck turn's foot: the same agent continues where it left off, told why.
  const [restarting, setRestarting] = useState(false);
  const restartTurn = steer && selectedTaskId ? () => {
    setRestarting(true);
    void deliver(RESTART_MESSAGE, undefined, false, true).finally(() => setRestarting(false));
  } : undefined;

  const submit = async () => {
    // A whole draft that is a command runs it, even while the chat is working (/status, /goal pause);
    // with files or annotations attached it is a message, so they go with it as shown.
    const command = attachments.length || annotations.length ? null : chatSlashParse(draft);
    if (command) { await runCommand(command.name, command.arg); return; }
    if (!canSend) return;
    // The annotation block goes outermost (after plan mode's wrapper), where the chat reads it back
    // as a chip; inside the wrapper the sent bubble showed its JSON.
    const body = chatMessageWithAttachments(draft, attachments);
    const text = chatMessageWithAnnotations(commands?.planMode ? planMessage(body) : body, annotations);
    // The chat sends at most 8,192 characters; long selections could pass that and the send failed.
    if (text.length > CHAT_MESSAGE_LIMIT) {
      say("Too long", `This message is ${text.length.toLocaleString()} characters with its annotations; the limit is ${CHAT_MESSAGE_LIMIT.toLocaleString()}. Remove an annotation or select less.`);
      return;
    }
    if (queueing || queueWhileSending) {
      // Several messages typed during one turn go together, in order.
      setQueue(selectedTaskId, chatQueueAdd(queueOf(selectedTaskId), { what: "Message", message: text }));
      setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote("");
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
  // One queued item per free spell: right after a send the chat may still read as free for a moment,
  // and the next item must wait for the turn that send started.
  const sentWhileFree = useRef(false);
  // Also on a new run: a send refused as "still running" while the chat read free held the queue
  // until `accepts` changed, and when it never did, the message sat queued for no reason.
  useEffect(() => { sentWhileFree.current = false; }, [accepts, selectedTaskId, latest?.id]);
  // A send runs only from the focused app window. A turn that ended while the user was in another
  // app had its queued message refused and dropped back into the composer; it now waits for focus.
  const [windowFocused, setWindowFocused] = useState(() => typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const on = () => setWindowFocused(true), off = () => setWindowFocused(false);
    window.addEventListener("focus", on); window.addEventListener("blur", off);
    return () => { window.removeEventListener("focus", on); window.removeEventListener("blur", off); };
  }, []);
  // Marked out of focus by a refused send while the window was in front all along, no focus event
  // would ever come: the queue checks again every two seconds.
  useEffect(() => {
    if (windowFocused || typeof document === "undefined" || typeof document.hasFocus !== "function") return undefined;
    const timer = window.setInterval(() => { if (document.hasFocus()) setWindowFocused(true); }, 2_000);
    return () => window.clearInterval(timer);
  }, [windowFocused]);
  useEffect(() => {
    const task = selectedTaskId, [next, ...rest] = queueOf(task);
    if (!task || !next || !accepts || busy || sending || sentWhileFree.current || !windowFocused) return;
    sentWhileFree.current = true;
    setQueue(task, rest);
    const owner = composing.current;
    void deliver(next.message, next.goal, false).then((sent) => {
      if (sent) { if (alive.current && composing.current.taskId === task && !rest.length) setCard(null); return; }
      if (!alive.current || composing.current.taskId !== task || composing.current.draft !== owner.draft || composing.current.attachments !== owner.attachments) {
        setQueue(task, [next, ...queueOf(task)]);
        return;
      }
      // Nothing is lost: a plain message goes back into the composer to send again, after anything
      // already typed there.
      if (next.what === "Message") setDraft((typed) => (typed.trim() ? `${typed}\n\n${next.message}` : next.message));
      say(next.what, next.what === "Message" ? "The queued message couldn't be sent; it's back in the composer." : "The queued message couldn't be sent; run the command again.");
    });
  }, [queueVersion, selectedTaskId, accepts, busy, sending, windowFocused]);
  // In steer mode a queued message (the agent was waiting on a request, or still starting) is
  // steered in as soon as the agent can take it, not held until the whole turn ends. A steer that
  // still finds it waiting comes back to the queue; the backend waits up to half a minute each time.
  // A steer that fails outright (a refused send, a timeout) is tried again after 15 s, 30 s, then
  // every minute while the agent works. Giving up after one failure parked the message until the
  // whole turn ended, an hour on a long turn, so a typed "keep going" looked ignored.
  const steeringQueue = useRef(false);
  const steerRetry = useRef({ attempts: 0, until: 0 });
  const steerRetryTimer = useRef<number | undefined>(undefined);
  const [steerRetryTick, setSteerRetryTick] = useState(0);
  useEffect(() => {
    steerRetry.current = { attempts: 0, until: 0 };
    window.clearTimeout(steerRetryTimer.current);
  }, [accepts, steering, selectedTaskId]);
  useEffect(() => () => window.clearTimeout(steerRetryTimer.current), []);
  useEffect(() => {
    const task = selectedTaskId, [next, ...rest] = queueOf(task);
    if (!task || !next || accepts || !steering || awaitingAnswer || next.goal || next.what !== "Message"
      || busy || sending || steeringQueue.current || Date.now() < steerRetry.current.until || !windowFocused) return;
    steeringQueue.current = true;
    setQueue(task, rest);
    void deliver(next.message, undefined, false).then((sent) => {
      const here = alive.current && composing.current.taskId === task;
      if (sent) {
        steerRetry.current = { attempts: 0, until: 0 };
        if (here && !queueOf(task).length) setCard(null);
        return;
      }
      const attempts = steerRetry.current.attempts + 1;
      const wait = attempts === 1 ? 15_000 : attempts === 2 ? 30_000 : 60_000;
      steerRetry.current = { attempts, until: Date.now() + wait };
      window.clearTimeout(steerRetryTimer.current);
      steerRetryTimer.current = window.setTimeout(() => setSteerRetryTick((value) => value + 1), wait);
      // Back at the head of the queued-message bar, where it stays until the agent can take it.
      setQueue(task, [next, ...queueOf(task)]);
    }).finally(() => { steeringQueue.current = false; });
  }, [queueVersion, selectedTaskId, accepts, steering, awaitingAnswer, busy, sending, windowFocused, steerRetryTick]);
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
  // The queued-message bar: this chat's queued messages (a command or a goal waits out of sight, as
  // before), then the steers still on their way to the agent. Send now steers a message in at once,
  // or sends it when the chat is free; while the agent waits on its own request steering would
  // cancel that request, so it waits too.
  const sendNowBlocked = busy || sending ? "Another message is being sent"
    : accepts || (steering && !awaitingAnswer) ? undefined
    : awaitingAnswer ? "Answer the agent's request first" : "Sent when the current turn finishes";
  const takeQueued = (index: number) => {
    const queue = queueOf(selectedTaskId), item = queue[index];
    if (item) setQueue(selectedTaskId, queue.filter((_, at) => at !== index));
    return item;
  };
  const queuedBar: QueuedBarItem[] = [
    ...queued.flatMap((item, index): QueuedBarItem[] => item.what !== "Message" || item.goal ? [] : [{
      key: `queued:${index}:${item.message.length}`, text: item.message, state: "queued", sendNowBlocked,
      onRemove: () => { takeQueued(index); },
      onEdit: () => {
        const taken = takeQueued(index);
        if (!taken) return;
        // Its annotations come back as the composer's own, ahead of any already there, and only its
        // text goes in the box: the block the agent reads, put in the box, went out behind a new
        // selection's block, numbered from 1 again, and showed raw in the chat.
        const { annotations: kept, rest } = chatAnnotationsSplit(taken.message);
        setDraft((typed) => (typed.trim() ? `${rest}\n\n${typed}` : rest));
        if (kept.length) setAnnotations((current) => [...kept.map((item) => ({ ...item, id: ++annotationIds })), ...current]);
        input.current?.focus();
      },
      onSendNow: () => {
        const task = selectedTaskId, taken = takeQueued(index);
        if (!taken) return;
        void deliver(taken.message, undefined, false).then((sent) => { if (!sent) setQueue(task, [taken, ...queueOf(task)]); });
      },
    }]),
    // A steer that waits for the agent's own request is in the queue too: it shows once, as queued.
    ...pendingSteers.filter((entry) => entry.taskId === selectedTaskId
      && !queued.some((item) => item.what === "Message" && item.message === entry.text))
      .map((entry): QueuedBarItem => ({ key: entry.id, text: entry.text, state: "pending" })),
  ];
  // The messages /rewind can go back to, oldest first, with the turn each one opened.
  const rewindPoints = turns.flatMap((turn, turnIndex) => turn.user ? [{ turnIndex, messageIndex: turn.messageIndex ?? turnIndex, text: chatMessageReadable(turn.user.text) }] : []);
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
            setCard(goal ? { title: GOAL_SUMMARY[goal.status], rows: [["Goal", goal.objective], ["Round", goalRounds(goal)],
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
      const image = file.type.startsWith("image/");
      const preview = image ? previewOf(file) : undefined;
      let path = filePath?.(file) || "";
      // A pasted screenshot or clipboard file has no path: saved for the agent to open, as Claude
      // Code does. A small text file without one still goes inline.
      if (!path && saveAttachment && (image || file.size > INLINE_ATTACHMENT_BYTES || !file.type.startsWith("text/"))) {
        try {
          path = (await saveAttachment({ name: file.name || (image ? "pasted-image" : "pasted"), type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })).path;
        } catch (cause) {
          freePreview(preview);
          notes.push(`${file.name || "Pasted file"}: ${cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(cause)}`);
          continue;
        }
      }
      if (path) { added.push({ name: file.name || fileName(path), path, image, ...(preview ? { preview } : {}) }); continue; }
      if (image) { freePreview(preview); notes.push(`${file.name}: images need their file path, which isn't available here`); continue; }
      if (file.size > INLINE_ATTACHMENT_BYTES) { notes.push(`${file.name}: too large to attach inline (over 200 KB)`); continue; }
      added.push({ name: file.name, text: await file.text() });
    }
    if (added.length) setAttachments((current) => [...current, ...added].slice(0, 8));
    setAttachNote(notes.join("; "));
  };
  // Thumbnails are object URLs: freed when their card leaves the chat box (removed or sent).
  const shownPreviews = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(attachments.map((item) => item.preview).filter((url): url is string => Boolean(url)));
    for (const url of shownPreviews.current) if (!now.has(url)) freePreview(url);
    shownPreviews.current = now;
  }, [attachments]);

  const headerMenu = (): ChatMenuItem[] => [
    ...(thread && chat ? [
      { label: "Rename", shortcut: "Alt+Ctrl+R", run: () => setRenaming(chat.title) },
      { label: thread.pinned ? "Unpin" : "Pin", shortcut: "Alt+Ctrl+P", run: thread.togglePin },
      { label: "Fork", run: () => thread.fork() },
      { label: "Copy conversation", run: thread.copyConversation },
    ] as ChatMenuItem[] : []),
    ...(steer ? [{ label: "Steer while working", checked: steerOn, run: toggleSteer } as ChatMenuItem] : []),
    { label: "Compact activity", checked: compactActivity, run: toggleCompact } as ChatMenuItem,
    { label: "Show pet", checked: petOn, run: togglePet } as ChatMenuItem,
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
  const attachmentAccess = useMemo(() => ({ preview: attachmentPreview, reveal: revealFile }), [attachmentPreview, revealFile]);
  // One work reader per run for DeepSeek turns, kept across renders so a finished turn stays memoized.
  const dshReaders = useMemo(() => new Map<string, UseStepWork>(), [loadWork]);
  // A failed step waiting for the person: the card shows its error, so its turn does not repeat it.
  const recovering = Boolean(latest && chat?.status === "attention");
  const failedTurn = recovering ? turns.findLast((turn) => turn.runId === latest?.id) : undefined;
  const failedStep = failedTurn ? [...failedTurn.steps, ...(failedTurn.final ? [failedTurn.final] : [])].find((step) => step.error) : undefined;
  const threadTurns = useMemo(() => turns.map((turn, turnIndex) => {
    // A turn on a DeepSeek model shows as DeepSeek Harness shows one (DshTranscript); others as Claude Code.
    const dsh = isDeepSeekModel(chatRuns.find((run) => run.id === turn.runId)?.nodes.find((node) => node.role === "planner")?.route?.model);
    let readWork = dshReaders.get(turn.runId);
    if (dsh && !readWork) {
      readWork = (step, wanted) => useStepWork(step, turn.runId, wanted, loadWork);
      dshReaders.set(turn.runId, readWork);
    }
    const idle = notStarted && turn.runId === latest?.id;
    // One message that cannot render (a run's unexpected data) shows a notice in its place; the
    // chat and the rest of the window stay up.
    return <PartErrorBoundary key={turn.key} label="This message"><article className={`cx-turn${dsh ? " is-dsh" : ""}`}>
              {turn.user ? <div className="cx-user">
                <SentMessage text={turn.user.text} />
                <MessageActions text={chatMessageReadable(turn.user.text)}>
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
                ? <SteerReader.Provider value={steerReader(turn.steps[0]?.detail)}>{turn.user.steers.map((steer, index) => <div key={`steer:${index}`} className="cx-user cx-steer">
                  <SentMessage text={steer.text} />
                  {/* Saved only once the agent took it; a turn that finished read it, one that stopped may not have. */}
                  <div className="cx-msg-foot"><SteerReceiptMark receipt={turn.status === "done" ? "read" : liveTurn(turn) ? "unread" : undefined} />
                    <MessageActions text={chatMessageReadable(steer.text)} /></div>
                  <span className="cx-stamp">{steer.stamp} UTC</span>
                </div>)}</SteerReader.Provider> : null}
              {dsh && readWork
                ? <DshWork key={`${turn.key}:${showWork ? "open" : "folded"}`} turn={turn} live={!idle && liveTurn(turn)} expanded={showWork} useWork={readWork}
                  errorShownBelow={turn === failedTurn} />
                : <WorkGroup key={`${turn.key}:${showWork ? "open" : "folded"}`} turn={turn} idle={idle} expanded={showWork} loadWork={loadWork} />}
              {!dsh && !idle && liveTurn(turn) ? <TurnRunning turn={turn} /> : null}
              {turn.final && !(dsh && turn.final.working) ? <div className={`cx-answer${turn.final.verdict ? " has-verdict" : ""}`}>
                {/* DeepSeek Harness names no agent above its reply; a team's verdict still shows. */}
                {dsh ? (turn.final.verdict ? <div className="cx-answer-meta"><span className={`cx-verdict is-${turn.final.verdict.toLowerCase()}`}>{turn.final.verdict}</span></div> : null)
                  : <div className="cx-answer-meta">
                    <span>{turn.final.name}</span>
                    {turn.final.verdict ? <span className={`cx-verdict is-${turn.final.verdict.toLowerCase()}`}>{turn.final.verdict}</span> : null}
                    {turn.final.detail ? <span className="cx-answer-detail">{turn.final.detail}</span> : null}
                  </div>}
                {/* A finished reviewer becomes the answer; its earlier cycles stay above it (DeepSeek's row shows them). */}
                {dsh ? null : <EarlierRounds rounds={turn.final.earlier} />}
                <ChatMarkdown text={turn.final.text ?? ""} />
                <MessageActions text={turn.final.text ?? ""}>
                  {restart && turn.runId && turn.runId === latest?.id && !runOpen ? <button type="button" title="Retry" aria-label="Retry this mission" disabled={busy} onClick={() => restart(turn.runId)}>↻</button> : null}
                </MessageActions>
              </div> : null}
              {!turn.final && turn.status === "done" && !turn.steps.some((step) => step.text || step.error)
                ? <p className="cx-note">Finished without an answer.</p> : null}
              {turn.status === "stopped" && !dsh ? <p className="cx-note">Stopped</p> : null}
              {turn.solo ? <p className="cx-note">Answered by the orchestrator alone; no workers ran.</p> : null}
            </article></PartErrorBoundary>;
  }), [turns, thread, deleteBlocked, deletingBusy, chatRuns, showWork, notStarted, latest?.id, loadWork, dshReaders, restart, runOpen, busy, failedTurn]);

  return (<Attachments.Provider value={attachmentAccess}><SentMessageView.Provider value={sentMessageView}><CompactActivity.Provider value={compactActivity}>
    <TurnRestart.Provider value={{ onRestart: restartTurn, restarting }}>
    <div className={`cx-chat${showStructure && structure ? " has-structure" : ""}`}>
      <section className="cx-thread" aria-label={chat?.title || CHAT_DEFAULT_TITLE}>
        <header className="cx-thread-head">
          <span className="cx-head-folder" title={projectName}><ChatGlyph name="folder" size={15} /></span>
          {deciding && !selectedTaskId ? <h2 aria-hidden="true" /> : selectedTaskId || pendingCreation
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
          {/* The side panel opens on its Overview, as Claude Code's side column: context, changes,
              tasks and usage, each a click from its tab (the browser chip still opens Preview). */}
          {selectedTaskId ? <button type="button" className="cx-icon-button" aria-pressed={workbench !== null} title="Side panel: overview, preview, terminal, changes and files"
            aria-label="Show side panel" onClick={() => setWorkbench((open) => (open ? null : "overview"))}>
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
          <div className="cx-column" ref={column} onClickCapture={() => {
            // Only the growth a click causes (in its next frame or so) counts as the user's.
            clicked.current = true;
            requestAnimationFrame(() => requestAnimationFrame(() => { clicked.current = false; }));
          }}>
            {!turns.length ? <div className="cx-empty">
              {deciding && !selectedTaskId ? null : selectedTaskId ? <p>Loading…</p> : <>
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
            {recovering && latest ? <FailedStepCard step={failedStep} notice={notice} busy={busy} onRetry={() => retryStart(latest.id)} /> : null}
          </div>
          {!atBottom ? <button type="button" className="cx-to-bottom" aria-label="Scroll to the latest message"
            onClick={() => { setAtBottom(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }}>↓</button> : null}
        </div>

        {!selectedTaskId && !deciding ? <div className="cx-context-strip" aria-label="Where this chat runs">
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
        {commands?.goal || commands?.planMode || commands?.wakeup ? <div className="cx-composer-modes">
          {commands?.wakeup ? <WakeupBar wakeup={commands.wakeup} onCancel={() => void commands.cancelWakeup?.().catch((cause) => say("Cancel wake-up", cause instanceof Error ? cause.message : String(cause)))} /> : null}
          {/* Codex's goal bar: state, objective, how long it has run, then Clear / Resume or Pause / Edit. */}
          {commands?.goal ? <div className={`cx-goal is-${commands.goal.status}`} role="status">
            <GoalGlyph name="target" />
            <span className="cx-goal-state" title={commands.goal.note || `Round ${goalRounds(commands.goal)}`}>{GOAL_SUMMARY[commands.goal.status]}</span>
            <span className="cx-goal-objective" title={commands.goal.objective}>{commands.goal.objective}</span>
            {commands.goal.note ? <span className="cx-goal-note" title={commands.goal.note}>{commands.goal.note}</span> : null}
            <span className="cx-goal-meta" title={`Round ${goalRounds(commands.goal)}`}>
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
          if (runOpen && latest?.execution_mode === "single" && running && picked && picked !== running) {
            return <p className="cx-route-note" role="status">This turn runs on <b>{routeModelName({ model: running })}</b>; your next message uses <b>{routeModelName({ model: picked })}</b>.</p>;
          }
          // An agent keeps the model, effort, window and permissions it started with, so a follow-up
          // with any of them changed starts a new agent that gets only a summary of the chat (it
          // "forgot everything" after an effort switch from Max to High). Say so before it is sent.
          const route = composer?.mode === "single" ? composer.route : undefined;
          const change = !runOpen && latest?.execution_mode === "single" && lead?.route && route
            ? routeChange(lead.route as unknown as RouteFields, route as unknown as RouteFields) : null;
          return change ? <p className="cx-route-note" role="status"><b>{change.now}</b> starts a new agent with only a summary of this chat.
            Switch back to <b>{change.back}</b> to keep this one.</p> : null;
        })()}
        {/* Steered and queued messages sit above the project's branch bar, on top of everything below
            the transcript: under it, they read as part of the chat box's own controls. */}
        <QueuedMessageBar items={queuedBar} />
        {selectedTaskId ? <ChatBranchBar workspaceId={projectId} sessionId={agentSessions[0]?.id} /> : null}
        {/* A request waiting on the person sits right above the chat box, as wide as it, as DeepSeek
            Harness shows its approval panel: in the thread it took the thread's own margins and sat
            out of line with the box, scrolled away with the transcript. */}
        {approvals.length ? <div className={`cx-approval-dock${isDeepSeekModel(latest?.nodes.find((node) => node.role === "planner")?.route?.model) ? " is-dsh" : ""}`}>
          {approvals.map(approval => {
            // Codex names who asks ("Allow ChatGPT to run this command?"): here the card's model.
            const model = latest?.nodes.find((node) => node.id === approval.nodeId)?.route?.model;
            const actor = model ? modelName?.(model) || model.slice(model.lastIndexOf("/") + 1) : undefined;
            return <AgentOrchestratorApproval key={JSON.stringify([approval.nodeId, approval.approval_id])} approval={approval} busy={busy} approve={approve} actor={actor} />;
          })}
        </div> : null}
        {/* Outside the chat box's form: its comment box submits on Enter, and that must not send the message. */}
        {selectedTaskId ? <SelectionAnnotator root={scroller} annotations={annotations} onAdd={addAnnotation} onComment={commentAnnotation} /> : null}
        <form className="cx-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } }}>
          {petOn && selectedTaskId ? (() => {
            const last = [...turns].reverse().find((turn) => turn.runId);
            return <ChatPet context={contextShare} onHide={togglePet}
              mood={petMood({ asking: awaitingAnswer, running: runOpen && anyWorking, lastStatus: last?.status,
                lastFailed: Boolean(last && !runOpen && [...last.steps, ...(last.final ? [last.final] : [])].some((step) => step.state === "failed" || step.state === "held")) })} />;
          })() : null}
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
          <AnnotationTray annotations={annotations} onComment={commentAnnotation}
            onRemove={(id) => setAnnotations((current) => current.filter((item) => item.id !== id))} onClear={() => setAnnotations([])} />
          {attachments.length || attachNote ? <div className="cx-attachments">
            {/* As Claude Code shows them: an image as its thumbnail, a file as its name; where it lives
                is on hover, and a click shows it in its folder. */}
            {attachments.map((item, index) => <span key={`${item.name}:${index}`} className={`cx-attachment${item.preview ? " is-image" : ""}`}>
              <button type="button" className="cx-attachment-open" disabled={!item.path || !revealFile}
                title={item.path ? `${item.path}${revealFile ? "\nClick to show it in its folder" : ""}` : `${item.name} (sent inline)`}
                onClick={() => { if (item.path) revealFile?.(item.path); }}>
                {item.preview ? <img src={item.preview} alt={item.name} /> : <span aria-hidden="true">{item.image ? "🖼" : "📄"}</span>}
                <span className="cx-attachment-name">{item.name}</span>
              </button>
              <button type="button" className="cx-attachment-remove" aria-label={`Remove ${item.name}`} data-tip={`Remove ${item.name}`}
                onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </button>
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
            {selectedTaskId ? <ChatContextMeter sessionId={agentSessions[0]?.id}
              previousSessionIds={agentSessions.slice(1).filter((session) => session.model === agentSessions[0]?.model
                && session.label.split(" · ")[0] === agentSessions[0]?.label.split(" · ")[0]).map((session) => session.id)}
              agentLabel={agentSessions[0]?.label} model={agentSessions[0]?.model}
              launchedWindow={agentSessions[0]?.contextWindow} nextWindow={composer?.route?.context_window}
              canCompact={Boolean(commands && accepts)} onCompact={() => void runCommand("compact")} onFraction={setContextShare} /> : null}
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
          from={statsSpan.from} models={statsSpan.models} running={runOpen} /> : null}
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
  </TurnRestart.Provider></CompactActivity.Provider></SentMessageView.Provider></Attachments.Provider>);
}

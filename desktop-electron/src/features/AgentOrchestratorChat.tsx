import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { Caret, Icon } from "../icons";
import { ModelJudgesToggle } from "./ModelJudgesToggle";
import { AgentOrchestratorComposerControls, type ComposerControlsProps } from "./AgentOrchestratorComposerControls";
import { modelShortLabel } from "./AgentOrchestratorRoleEditor";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AgentOrchestratorApproval, type AoApproval as ChatApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import { ChatMarkdown } from "./ChatMarkdown";
import { ComputerControlCard, chatComputerRequests, useComputerRequests } from "./ComputerControlCard";
import { ChatWorkbench, chatProcessRows, navigatePreview, useChatProcesses, useChatSubagents, useWorkbenchAutoOpen, type WorkbenchTab } from "./ChatWorkbench";
import { ChatBranchBar } from "./ChatBranchBar";
import { AnnotationTray, SelectionAnnotator, SentAnnotations, type DraftAnnotation } from "./ChatAnnotations";
import { ChatContextMeter } from "./ChatContextMeter";
import { ChatPet } from "./ChatPet";
import { ChatTurnStats, TurnFoot } from "./ChatTurnStats";
import { ReplyHead, cardTone, replyTone, turnChanges, type ReplyMember } from "./ChatReplyHead";
import { FoldedRounds, ReplyPlanView, RoundDivider } from "./ChatReplyPlan";
import { CHAT_STYLE_KEY, CHAT_STYLES, chatStyle, foldedRounds, goalRound, replyPlan, stepAttempt, type ChatStyle } from "./chat-reply-plan";
import { DshTurnWork, type DshTurnWorkProps, type UseStepWork } from "./DshTranscript";
import { AnsweredRecord, ApprovedMark, EarlierRounds, EditDiff, SentMessageView, SteerReader, SteerReceiptMark, StreamingMarkdown, TurnRestart, Attachments, ImageLightbox, SecretText, SentImage, ToolImages } from "./ChatToolParts";
import { PartErrorBoundary } from "../PartErrorBoundary";
import { INIT_PROMPT, planMessage, reviewPrompt } from "./codex-prompts";
import { ChatGlyph, ChatMenu, FloatingLayer, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
import {
  CHAT_DEFAULT_TITLE, GOAL_SUMMARY, goalDetail, goalFeedback, goalRounds, chatAcceptsMessage, chatAnnotationsSplit, chatDuration, CHAT_MESSAGE_LIMIT, chatList, chatMessageReadable, chatMessageWithAnnotations, chatMessageWithAttachments, chatRunOpen, hasHiddenSecret,
  chatAgentSessions, chatAgentSummary, chatApprovalMode, chatDetailLinks, chatQueueAdd, chatRunsOfMessage, chatSlashMatches, chatSlashParse, chatSlashTyping, chatTurns, goalElapsed,
  chatMessageParts, chatStatsSpan, isDeepSeekModel, petMood, type ChatSentAttachment, type QueuedChatMessage, type ChatCommandCard, type ChatCommands, type ChatActivity, type ChatAttachment, type ChatDetailLink, type ChatLiveItem, type ChatNode, type ChatRun, type ChatStatus, type ChatStep, type ChatTurn,
  activitySummary, groupTimeline, mergeTimeline, tidyTimeline, withoutReplied, wakeupLabel, dshQuietNote, dshRetryNote, steerReader, steerReceipts, waitsForPerson,
  cpaRefusalNote, type ChatWakeup, type CpaRefusal,
  subagentActive, subagentsSummary,
  autoCompactArg, chatLoopParse, loopInterval, loopLabel, type ChatLoop, localChatStamp,
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
  return <label className="cx-auto-retry" title="Retries a failed step up to 8 times over about half an hour. Sign-in errors still wait for you">
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
  // Named by its own words, not an id: two split view panes can each show a failed step.
  return <section className="cx-card tone-error cx-fail-card" aria-label={`Step failed${step?.name ? `: ${step.name}` : ""}`}>
    <svg className="cx-fail-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.4v.1" />
    </svg>
    <div className="cx-fail-body">
      <p className="cx-fail-title">Step failed{step?.name ? <span className="cx-fail-step">{step.name}</span> : null}</p>
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
 * Each chat's queued messages (task id → queue) as this view shows them. The app keeps the queues
 * (chat-queue.cjs) and sends them with the chat closed or the window in the background; this copy
 * is updated from every read of a project's runs (syncChatQueues) and from each change made here.
 */
const CHAT_QUEUES = new Map<string, QueuedChatMessage[]>();
const QUEUE_PROJECTS = new Map<string, string>(); // task id -> its project
const queueListeners = new Set<() => void>();
/**
 * The app's queues for one project: every chat's (`queues` from a runs read), or with `only` the
 * one chat a change was made in. A chat of that project left out has nothing queued.
 */
export function syncChatQueues(workspaceId: string, queues: Record<string, QueuedChatMessage[]>, only?: string) {
  for (const [task, project] of QUEUE_PROJECTS) {
    if (project === workspaceId && (only === undefined || only === task) && !queues[task]?.length) { CHAT_QUEUES.delete(task); QUEUE_PROJECTS.delete(task); }
  }
  for (const [task, items] of Object.entries(queues)) {
    if ((only === undefined || only === task) && Array.isArray(items) && items.length) { CHAT_QUEUES.set(task, items); QUEUE_PROJECTS.set(task, workspaceId); }
  }
  for (const listener of queueListeners) listener();
}
/** The app's queue for the chats of the open project (AgentOrchestratorSurface's chat_queue calls). */
export type ChatQueueActions = {
  /** `front`: ahead of the rest (a message that was refused for now, or a Send now that failed). */
  add: (taskId: string, item: QueuedChatMessage, front?: boolean) => Promise<void>;
  /** Replaces a queued message's text (a message joined to it); false when it was already sent. */
  update: (taskId: string, id: string, message: string) => Promise<boolean>;
  /** Removes the items `ids`, or all of the chat's with null. */
  remove: (taskId: string, ids: string[] | null) => Promise<void>;
};
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
/** Sent to every chat in the window when the pet is shown or hidden (its detail: shown). */
const PET_EVENT = "coding-tools:ao:pet-shown";
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
  /** Rewind this chat to the selected message and immediately run it again. Files are unchanged. */
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
function TurnRunning({ turn, refusal }: { turn: ChatTurn; refusal?: CpaRefusal | null }) {
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
  // Claude Code's own retry notice first; else CPA refusing the model (a subagent's requests too,
  // which post no notice); then how long nothing new has come.
  const retry = dshRetryNote(turn.steps);
  const refused = retry ? "" : cpaRefusalNote(refusal, now);
  // A turn waiting on the person's answer is not stuck: it says so, with no Restart to press.
  const asking = waitsForPerson(step.working.activity);
  const note = `${retry || refused}${dshQuietNote(heardAt, now, asking)}`;
  // A restart does not lift a rate limit or a refused sign-in: it says what does instead.
  const hint = refused && (refusal?.status === 429 || refusal?.status === 402) ? " · switch the model or wait"
    : refused && (refusal?.status === 401 || refusal?.status === 403) ? " · sign in again in CPA" : "";
  return <p className={`cx-note cx-turn-running${(step.working.stalled && !asking) || refused ? " is-stalled" : ""}`} role="status" aria-live="polite">
    <span className="cx-shimmer">Working</span>{turn.startedAtMs ? <> for <Elapsed since={turn.startedAtMs} /></> : null}
    {` · ${step.name}${step.working.activity ? ` — ${step.working.activity}` : ""}${note}${hint}`}
    {/* A stuck turn has a button of its own: the person looking at "may be stuck" had nothing to
        press, and a tool call that never returned held a chat for hours (Restart: chat_steer's restart). */}
    {!hint && note.includes("may be stuck") ? onRestart
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
  const images = item.images ?? [];
  // A returned image is read from disk only once its row is opened, not for every row in the turn.
  const [opened, setOpened] = useState(false);
  const opens = item.kind === "command" || item.input || item.output || images.length;
  return opens
    ? <details className={`cx-tool tone-${tone}`} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
      <summary>{head}{images.length ? <span className="cx-tool-image-count">{images.length === 1 ? "image" : `${images.length} images`}</span> : null}</summary>
      <div className="cx-tool-body">
        {item.kind === "command" ? <pre className="cx-tool-io"><code>{item.text}</code></pre> : null}
        {item.input ? <pre className="cx-tool-io"><code>{item.input}</code></pre> : null}
        {opened && images.length ? <ToolImages paths={images} /> : null}
        {item.output ? <pre className="cx-tool-io is-output"><code>{item.output}</code></pre>
          : tone === "running" || images.length ? null : <p className="cx-tool-empty">No output</p>}
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
  // The numbered lines are drawn once the row is first opened (as DshRow does): a folded edit kept
  // four cells a line in the page, ~50k of a long chat's 85k elements, and every restyle walked them.
  const [opened, setOpened] = useState(false);
  if (!files.some((file) => file.diff)) return <div className={`cx-tool tone-${tone}`}><div className="cx-tool-row">{head}</div></div>;
  return <details className={`cx-tool cx-edit tone-${tone}`} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}><summary>{head}</summary>
    {opened ? <div className="cx-tool-body">
      {files.map((file) => <section key={file.path} className="cx-edit-file">
        {files.length > 1 ? <header><span title={file.path}>{fileName(file.path)}</span><DiffCount additions={file.additions} deletions={file.deletions} /></header> : null}
        {file.diff ? <EditDiff diff={file.diff} /> : null}
      </section>)}
    </div> : null}</details>;
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

/**
 * Messages steered into the running turn that its timeline does not show yet: the same bubble the
 * timeline gives a steer, where it will show it, checked "Sending…" until the agent has it.
 */
type PendingSteer = { id: string; taskId: string | undefined; text: string; at: number; waiting?: boolean; sent?: boolean;
  turnKey?: string; messageIndex?: number };

/**
 * The turn a steer on its way shows in: the one it was sent in (its key, else the latest turn of
 * its message, as a queued turn's key becomes its run's), or -1. It followed whichever turn was
 * live, so a steer the agent had not read yet jumped from where it was sent down into the next
 * mission as soon as that one started.
 */
function steerTurnIndex(turns: ChatTurn[], steer: PendingSteer): number {
  const own = steer.turnKey ? turns.findIndex((turn) => turn.key === steer.turnKey) : -1;
  if (own >= 0 || steer.messageIndex === undefined) return own;
  return turns.findLastIndex((turn) => turn.messageIndex === steer.messageIndex);
}

function PendingSteers({ steers }: { steers: PendingSteer[] }) {
  return <>{steers.map((entry) => <div key={entry.id} className="cx-user cx-steer" data-pending={entry.sent ? "sent" : "sending"}>
    <SentMessage text={entry.text} />
    <div className="cx-msg-foot"><SteerReceiptMark receipt={entry.sent ? "unread" : "sending"} /><MessageActions text={chatMessageReadable(entry.text)} /></div>
  </div>)}</>;
}

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
// Kept per attempt: a retried card starts again (a new start time) with nothing of the last one.
const stepWorkKey = (step: ChatStep) => `${step.key}@${step.startedAtMs ?? ""}`;
/** Whether the chat details panel is open, kept across chats and restarts. */
const DETAILS_OPEN_KEY = "coding-tools:chat:details-open";
/** The details panel reads back the finished cards of this many newest turns, each card once. */
const DETAILS_READ_TURNS = 3;
const DETAILS_READ = new Set<string>();
/** Newest first, the panel lists this many outputs and this many sources. */
const DETAILS_LIST_LIMIT = 12;

function useStepWork(step: ChatStep, runId: string, wanted: boolean, loadWork?: LoadWork): ChatLiveItem[] | null {
  // Within an attempt nothing seen is ever dropped (mergeTimeline).
  const workKey = stepWorkKey(step);
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
  // One line from its dot: the card's name, then how it runs (harness · provider · model · effort ·
  // context). A working card says nothing more here: what it runs and for how long is at the turn's
  // foot (TurnRunning), and its tool calls are right below. Any other state leads the line.
  const state = step.working ? (step.working.stalled ? "may be stuck" : "")
    : step.error ? "failed" : step.verdict || (step.state === "finished" ? "done" : step.state);
  return <li className={`cx-step tone-${stepTone(step)}`}>
    <button type="button" className="cx-step-head" aria-expanded={open} disabled={!body && !step.working} onClick={() => setOpen(!open)}
      title={step.working?.detail || step.detail || undefined}>
      <span className="cx-step-dot" aria-hidden="true" />
      <span className="cx-step-name">{step.name}</span>
      <span className="cx-step-meta">{[state, step.detail].filter(Boolean).join(" · ")}</span>
      {body ? <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} /> : null}
    </button>
    {open ? <div className="cx-step-body">
      {step.working && !compact ? <p className="cx-step-detail">{step.working.detail}</p> : null}
      {/* Its earlier rounds first, folded (oldest first), then the attempt now: a retried card's
          failed attempt showed under the new attempt's work, as if it came after it. */}
      <EarlierRounds rounds={step.earlier} />
      {work?.length ? <SteerReader.Provider value={steerReader(step)}>
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
    {open ? work?.length ? <SteerReader.Provider value={steerReader(step)}>
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
  && (a.startedAtMs ?? 0) === (b.startedAtMs ?? 0) && (a.endedAtMs ?? 0) === (b.endedAtMs ?? 0) && a.steps.length === b.steps.length
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
const DshWork = memo(DshTurnWork, (prev: DshTurnWorkProps, next: DshTurnWorkProps) => prev.live === next.live && prev.headed === next.headed
  && prev.useWork === next.useWork && prev.beforeStatus === next.beforeStatus && prev.errorShownBelow === next.errorShownBelow && prev.refusal === next.refusal && sameWork({ turn: prev.turn, expanded: prev.expanded }, { turn: next.turn, expanded: next.expanded }));

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
  // The card whose reply closes the turn (a team's reviewer) keeps its row with the others, folded
  // like them: its row left "Worked" the moment its reply became the answer, taking its thinking
  // and tool calls with it. Its reply and earlier rounds show in the answer, so the row holds its work.
  const rows = turn.final ? [...turn.steps, { ...turn.final, text: undefined, earlier: undefined }] : turn.steps;
  // While it works the turn has no head of its own: its steps start at their dots, and how long it
  // has worked and on what is said once, at the turn's foot (TurnRunning, whose verb alone shimmers).
  // Once done it folds under "Worked · N steps".
  return <div className={`cx-work${working ? " is-live" : ""}${working?.working?.stalled ? " is-stalled" : ""}`}>
    {working ? null : <button type="button" className="cx-work-head" aria-expanded={open} onClick={() => setChosen(!open)}>
      <span>{`Worked · ${rows.length} ${rows.length === 1 ? "step" : "steps"}`}</span>
      <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} />
    </button>}
    {open || working ? <ol className="cx-steps">{rows.map((step) => <StepRow key={step.key} step={step} runId={turn.runId} loadWork={loadWork} />)}</ol> : null}
  </div>;
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
  return <>
    {parts.attachments.length ? <div className="cx-sent-attachments">
      {parts.attachments.map((item, index) => item.image && item.path
        ? <SentImage key={`${item.path}:${index}`} item={item} onOpen={setOpen} />
        : <button key={`${item.name}:${index}`} type="button" className="cx-sent-file" disabled={!item.path || !reveal}
          title={item.path ? `${item.path}\nClick to show in folder` : `${item.name} · sent inline`} onClick={() => item.path && reveal?.(item.path)}>
          <span className="cx-sent-file-icon" aria-hidden="true">{/\.pdf$/i.test(item.name) ? "PDF" : "TXT"}</span>
          <span className="cx-sent-file-name">{item.name}</span>
        </button>)}
    </div> : null}
    {parts.annotations?.length ? <SentAnnotations annotations={parts.annotations} /> : null}
    {parts.text ? <div className="cx-bubble"><p>{hasHiddenSecret(parts.text) ? <SecretText text={parts.text} /> : parts.text}</p></div> : null}
    {open ? <ImageLightbox url={open} onClose={() => setOpen(null)} /> : null}
  </>;
}

function MessageActions({ text, children }: { text: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return <div className="cx-msg-actions" style={{ userSelect: "none" }}>
    <button type="button" title="Copy" aria-label="Copy message" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
      {copied ? <Icon name="check" width="14" height="14" /> : <ChatGlyph name="copy" />}</button>
    {children}
  </div>;
}

/**
 * A message in the queued-message bar, waiting to be sent. A steer on its way to the agent is not
 * one: it shows in the chat from the moment it is sent (PendingSteers).
 */
export type QueuedBarItem = {
  key: string; text: string; state: "queued";
  onRemove?: () => void; onEdit?: () => void; onSendNow?: () => void; sendNowBlocked?: string;
};

/** Claude Code's queue glyphs (its Anthropicons ArrowReturn, Edit, X, DotsVertical and CaretDown, as outlines). */
function QueuedGlyph({ name, size = 16 }: { name: "send" | "edit" | "remove" | "more" | "caret"; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "send" ? <><path d="m9 10-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></>
      : name === "edit" ? <path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      : name === "remove" ? <path d="M18 6 6 18M6 6l12 12" />
      : name === "more" ? <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>
      : <path d="m6 9 6 6 6-6" />}
  </svg>;
}

/** A queued message on one line, as Claude Code previews it: its readable text, whitespace collapsed. */
const queuedPreview = (text: string) => chatMessageReadable(text).replace(/\s+/g, " ").trim() || "…";

/**
 * Claude Code's queued-message bar (its Code tab's QueuedMessageBar): a band right above the
 * composer, above the branch bar. One message is one row: "1 message queued", the message greyed
 * on one line, then Send now (↵), Edit in composer and Remove from queue. Two or more collapse to
 * "N messages queued · Next: …", which opens the list: each message on up to two lines with a ⋮
 * menu (Edit in composer, Send now, Remove from queue), and Clear all. Only the first can be sent now.
 */
export function QueuedMessageBar({ items, onMenu, onClearAll }: {
  items: QueuedBarItem[]; onMenu: (owner: HTMLElement, items: ChatMenuItem[]) => void; onClearAll?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const sendNow = (item: QueuedBarItem, index: number) => index === 0 ? item.onSendNow : undefined;
  if (items.length === 1) {
    const [item] = items;
    return <div className="cx-queued">
      <div className="cx-queued-band" role="group" aria-label="Queued messages" data-state={item.state}>
        <span className="cx-queued-count">1 message queued</span>
        <span className="cx-queued-preview">{queuedPreview(item.text)}</span>
        {sendNow(item, 0) ? <button type="button" className="cx-queued-icon" aria-label="Send now" data-tip={item.sendNowBlocked ?? "Send now"}
          disabled={Boolean(item.sendNowBlocked)} onMouseDown={(event) => event.preventDefault()} onClick={item.onSendNow}><QueuedGlyph name="send" /></button> : null}
        {item.onEdit ? <button type="button" className="cx-queued-icon" aria-label="Edit in composer" data-tip="Edit in composer"
          onMouseDown={(event) => event.preventDefault()} onClick={item.onEdit}><QueuedGlyph name="edit" /></button> : null}
        {item.onRemove ? <button type="button" className="cx-queued-icon" aria-label="Remove from queue" data-tip="Remove from queue"
          onMouseDown={(event) => event.preventDefault()} onClick={item.onRemove}><QueuedGlyph name="remove" /></button> : null}
      </div>
    </div>;
  }
  const count = `${items.length} messages queued`;
  if (!open) {
    return <div className="cx-queued">
      <button type="button" className="cx-queued-band cx-queued-stack" aria-expanded={false} onClick={() => setOpen(true)}>
        <span className="cx-queued-count">{count}</span>
        <span className="cx-queued-preview">Next: {queuedPreview(items[0].text)}</span>
        <span className="cx-queued-caret" aria-hidden="true"><QueuedGlyph name="caret" /></span>
      </button>
    </div>;
  }
  // The ⋮ menu of one message: Claude Code's Edit in composer, Send now, then Remove from queue.
  const actions = (item: QueuedBarItem, index: number): ChatMenuItem[] => {
    const send = sendNow(item, index);
    const list: ChatMenuItem[] = [
      ...(item.onEdit ? [{ label: "Edit in composer", run: item.onEdit }] : []),
      ...(send ? [item.sendNowBlocked ? { label: "Send now", reason: item.sendNowBlocked } : { label: "Send now", run: send }] : []),
    ];
    return item.onRemove ? [...list, ...(list.length ? [{ kind: "separator" as const }] : []), { label: "Remove from queue", danger: true, run: item.onRemove }] : list;
  };
  return <div className="cx-queued">
    <div className="cx-queued-card">
      <div className="cx-queued-head">
        <span className="cx-queued-count">{count}</span>
        <button type="button" className="cx-queued-icon is-collapse" aria-expanded aria-label="Collapse queued messages" data-tip="Collapse queued messages"
          onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(false)}><QueuedGlyph name="caret" /></button>
      </div>
      <div className="cx-queued-list" role="list" aria-label="Queued messages">
        {items.map((item, index) => {
          const menu = actions(item, index);
          return <div key={item.key} role="listitem" className="cx-queued-row" data-state={item.state}>
            <span className="cx-queued-text">{queuedPreview(item.text)}</span>
            {menu.length ? <span className="cx-queued-actions">
                <button type="button" className="cx-queued-icon is-sm" aria-label="Queued message actions" aria-haspopup="menu"
                  onClick={(event) => onMenu(event.currentTarget, menu)}><QueuedGlyph name="more" size={14} /></button>
              </span> : null}
          </div>;
        })}
      </div>
      {onClearAll && items.some((item) => item.onRemove)
        ? <div className="cx-queued-foot"><button type="button" className="cx-queued-clear" onMouseDown={(event) => event.preventDefault()} onClick={onClearAll}>Clear all</button></div>
        : null}
    </div>
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

/**
 * The agent asked to be woken later (schedule_wakeup): when, its note, then Delete and Edit, drawn as
 * the goal bar's icons. Clicking the note edits it too. The label ticks alone.
 */
function WakeupBar({ wakeup, onEdit, onDelete }: { wakeup: ChatWakeup; onEdit?: () => void; onDelete: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="cx-goal cx-wakeup is-active" role="status">
    <span className="cx-wakeup-glyph" aria-hidden="true">◷</span>
    <span className="cx-goal-state" title={`Asked for ${wakeup.minutes} min at ${new Date(wakeup.scheduledAt).toLocaleTimeString()}`}>{wakeupLabel(wakeup, now)}</span>
    {onEdit
      ? <button type="button" className="cx-goal-objective cx-wakeup-note" title={`${wakeup.reason}\n\nClick to edit`} onClick={onEdit}>{wakeup.reason}</button>
      : <span className="cx-goal-objective" title={wakeup.reason}>{wakeup.reason}</span>}
    <button type="button" className="cx-goal-icon" title="Delete wake-up" aria-label="Delete wake-up" onClick={onDelete}><GoalGlyph name="trash" /></button>
    {onEdit ? <button type="button" className="cx-goal-icon" title="Edit wake-up" aria-label="Edit wake-up" onClick={onEdit}><GoalGlyph name="expand" /></button> : null}
  </div>;
}

/** The chat's loop (/loop): how often it runs and when next, its prompt, then Stop. The label ticks alone. */
function LoopBar({ loop, onStop }: { loop: ChatLoop; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (loop.minutes === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [loop.minutes]);
  return <div className="cx-goal cx-wakeup is-active" role="status">
    <span className="cx-wakeup-glyph" aria-hidden="true">⟳</span>
    <span className="cx-goal-state" title={loop.note || `Round ${loop.round}; ends by ${new Date(loop.expiresAt).toLocaleString()}`}>{loopLabel(loop, now)}</span>
    <span className="cx-goal-objective" title={loop.prompt}>{loop.prompt}</span>
    {loop.note ? <span className="cx-goal-note" title={loop.note}>{loop.note}</span> : null}
    <button type="button" className="cx-goal-icon" title="Stop loop" aria-label="Stop loop" onClick={onStop}><GoalGlyph name="trash" /></button>
  </div>;
}

export function AgentOrchestratorChat({
  runs, tasks, selectedTaskId, busy, loadDescription, send, openStructure,
  approvals, approve, describeRoute: _describeRoute, notice, warning, retryStart, retrying = false, working = false, describeNode, activity, modelName, permissions, composer, onOpenTeam, onOpenMissionBoard,
  projectName, stop, restart, thread, structure, onPause, onResume, onSettings, filePath, saveAttachment, revealFile, attachmentPreview, seed, onSeedUsed, headerExtra, onOpenProject, projects, projectId, onPickProject, onAddProject, projectBranch: branch, steer,
  pendingMessage, pendingTitle, pendingCreation = false, deciding = false, projectLoadError, onRetryProject, onComposing, commands, loadWork, onClosePane, queue,
}: {
  /** The app's queue of this project's chats: a message typed while a turn runs waits there. */
  queue?: ChatQueueActions;
  /** Close split view: set on every pane while the window is split (ChatSplit). */
  onClosePane?: () => void;
  /** A finished card's thinking and tool calls, read back from its AO session (turn_timeline). */
  loadWork?: LoadWork;
  /** Codex slash commands that need the page: goal, compact, diff, MCP, status, recent chats, plan mode. */
  commands?: ChatCommands;
  /** A message being sent into a chat that has no run yet (shown at once, as Codex does). */
  pendingMessage?: string; pendingTitle?: string; pendingCreation?: boolean;
  /** Which chat to show is not known yet (a project is opening): show neither a chat nor the new chat page. */
  deciding?: boolean;
  /** An initial project read failed. Give the user a recovery action instead of an empty chat pane. */
  projectLoadError?: string;
  onRetryProject?: () => void;
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
  steer?: (input: { taskId: string; message: string; restart?: boolean; goal?: string }) => Promise<boolean | "wait" | "restart" | "interrupt" | "starting">;
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
  /** Something that went wrong in the latest run while it carries on by itself (a tool call that timed out). */
  warning?: string;
  retryStart: (runId: string) => void;
  /** This chat's own Retry is on its way; Retry waits on nothing else (not the app-wide `busy`). */
  retrying?: boolean;
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
  // CPA refusing the running turn's model, as the line under the chat box reads it (ChatTurnStats):
  // the turn's status line says so instead of only "may be stuck".
  const [cpaRefusal, setCpaRefusal] = useState<CpaRefusal | null>(null);
  useEffect(() => { setCpaRefusal(null); }, [selectedTaskId]);
  // Steers shown at once while they reach the agent (deliver), until the turn shows them itself.
  // `waiting`: the agent was busy with a request of its own, so the steer waits in the chat's queue
  // and goes in once the request is answered; it stays shown meanwhile. `sent`: the agent has it.
  // `turnKey`/`messageIndex`: the turn it was sent in, where it stays shown (steerTurnIndex).
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
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
  // The chat's details panel (Codex's task panel): changes, agents, setup, outputs and sources. It
  // stays open, in every chat and after a restart, until its button closes it: a click anywhere
  // else closed it, so it was never there to glance at while the agents worked.
  const [detailsOpen, setDetailsOpen] = useState(() => { try { return localStorage.getItem(DETAILS_OPEN_KEY) === "on"; } catch { return false; } });
  const toggleDetails = () => setDetailsOpen((open) => {
    try { localStorage.setItem(DETAILS_OPEN_KEY, open ? "off" : "on"); } catch { /* the choice still applies now */ }
    return !open;
  });
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const [details, setDetails] = useState<{ left: number; top: number } | null>(null);
  // Anchored under its button, following it when the window or a split pane resizes (it shows once
  // placed, so it never flashes at the window's corner).
  useEffect(() => {
    const button = detailsToggle.current;
    if (!detailsOpen || !button) { setDetails(null); return; }
    const place = () => {
      const box = button.getBoundingClientRect();
      setDetails({ left: Math.max(8, Math.min(box.right - 300, window.innerWidth - 308)), top: box.bottom + 6 });
    };
    place();
    const observer = new ResizeObserver(place);
    if (button.parentElement) observer.observe(button.parentElement);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [detailsOpen, selectedTaskId]);
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
    const fresh = (entry: PendingSteer) => Date.now() - entry.at < 60_000
      || Boolean(entry.waiting && entry.taskId && (CHAT_QUEUES.get(entry.taskId) ?? []).some((item) => item.message === entry.text));
    // One that waited in the queue and went as the next turn's message shows there, as that message.
    const sentAsTurn = (entry: PendingSteer) => {
      const at = steerTurnIndex(turns, entry);
      return at >= 0 && turns.slice(at + 1).some((turn) => turn.user?.text.trim() === entry.text.trim());
    };
    // `turns` are the open chat's: another chat's steer is never matched against them (a "continue"
    // here dropped one still on its way there), only aged out.
    const shown = (entry: PendingSteer) => entry.taskId === selectedTaskId && (seen.has(entry.text.trim()) || sentAsTurn(entry));
    const keep = pendingSteers.filter((entry) => !shown(entry) && fresh(entry));
    if (keep.length !== pendingSteers.length) setPendingSteers(keep);
    const timer = window.setTimeout(() => setPendingSteers((list) => list.filter(fresh)), 60_000);
    return () => window.clearTimeout(timer);
  }, [turns, pendingSteers, selectedTaskId]);
  // The stats line counts the latest turn and the unfinished attempts before it (chatStatsSpan).
  const statsSpan = useMemo(() => chatStatsSpan(turns, chatRuns), [turns, chatRuns]);
  const stepCount = turns.reduce((total, turn) => total + turn.steps.length + (turn.final ? 1 : 0), 0);
  // The side panel beside the thread (ChatWorkbench: preview, changes, files, terminal) for the
  // chat's AO agents; it opens by itself when an agent first opens a page or starts a command.
  const [workbench, setWorkbench] = useState<WorkbenchTab | null>(null);
  const agentSessions = useMemo(() => chatAgentSessions(chatRuns), [chatRuns]);
  const agentSessionIds = useMemo(() => agentSessions.map((session) => session.id), [agentSessions]);
  // An agent of this chat asking to control a window: asked here, beside its other requests.
  const allComputerRequests = useComputerRequests();
  const computerRequests = useMemo(() => selectedTaskId ? chatComputerRequests(allComputerRequests, agentSessionIds, projectId) : [],
    [selectedTaskId, allComputerRequests, agentSessionIds, projectId]);
  const livePage = useWorkbenchAutoOpen(selectedTaskId ? agentSessionIds : [], workbench !== null, (tab) => setWorkbench(tab), projectId);
  // The details panel's Processes: the agent's app page and the chat's terminals, read while it is open.
  const processCommands = useChatProcesses(selectedTaskId ? agentSessionIds : [], detailsOpen, projectId);
  const processRows = useMemo(() => detailsOpen ? chatProcessRows(processCommands, livePage) : [], [detailsOpen, processCommands, livePage]);
  // A subagent starting opens the panel on its Subagents tab, as Codex's panel shows a thread's
  // subagents; a Preview, Terminal or diff the person has open stays (the line above the chat box says it).
  const subagents = useChatSubagents(selectedTaskId ? agentSessionIds : [],
    () => setWorkbench((open) => (open === null || open === "overview" || open === "new" ? "subagents" : open)));
  const subagentLine = useMemo(() => (subagents.some(subagentActive) ? subagentsSummary(subagents) : null), [subagents]);
  const renderSubagentWork = useMemo(() => (items: ChatLiveItem[], live: boolean, reply?: string) =>
    <LiveTimeline items={items} live={live} finished={!live} reply={reply} />, []);
  useEffect(() => { setWorkbench(null); }, [selectedTaskId]);
  // The details panel's Outputs and Sources, and each reply head's changed files: the cards' work
  // this window has seen (CHAT_WORK holds live polls and turns read back), plus the newest turns'
  // finished cards, read back once each. Older turns count once their work is opened in the chat.
  const [detailsWorkTick, setDetailsWorkTick] = useState(0);
  useEffect(() => {
    if (!loadWork) return;
    for (const turn of turns.slice(-DETAILS_READ_TURNS)) {
      for (const step of [...turn.steps, ...(turn.final ? [turn.final] : [])]) {
        const key = stepWorkKey(step);
        if (!step.hasWork || step.working || CHAT_WORK.has(key) || DETAILS_READ.has(key)) continue;
        DETAILS_READ.add(key);
        void loadWork(turn.runId, step.nodeId).then((items) => {
          if (!items.length) return;
          CHAT_WORK.set(key, mergeTimeline(CHAT_WORK.get(key), items, { cap: Infinity }));
          setDetailsWorkTick((tick) => tick + 1);
        }).catch(() => undefined);
      }
    }
  }, [loadWork, turns]);
  const detailLinks = useMemo(() => detailsOpen ? chatDetailLinks(turns.flatMap((turn) => [...turn.steps, ...(turn.final ? [turn.final] : [])])
    .flatMap((step) => CHAT_WORK.get(stepWorkKey(step)) ?? step.working?.timeline ?? [])) : null,
  // CHAT_WORK changes with the polls that change turns, or with a read back (the tick).
  [detailsOpen, turns, detailsWorkTick]);
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
  // How a reply draws its steps (chat-reply-plan's styles), picked from the header menu.
  const [replyStyle, setReplyStyle] = useState<ChatStyle>(() => { try { return chatStyle(localStorage.getItem(CHAT_STYLE_KEY)); } catch { return "transcript"; } });
  const pickReplyStyle = (next: ChatStyle) => {
    try { localStorage.setItem(CHAT_STYLE_KEY, next); } catch { /* applies now regardless */ }
    setReplyStyle(next);
  };
  // Bit, the chat's pet (ChatPet), shown unless turned off from the header menu or its own right-click.
  const [petOn, setPetOn] = useState(() => { try { return localStorage.getItem(PET_KEY) !== "off"; } catch { return true; } });
  // In split view the panes share one pet: hiding it in one pane hides it in all of them.
  const togglePet = () => {
    const next = !petOn;
    try { localStorage.setItem(PET_KEY, next ? "on" : "off"); } catch { /* applies now regardless */ }
    setPetOn(next);
    window.dispatchEvent(new CustomEvent<boolean>(PET_EVENT, { detail: next }));
  };
  useEffect(() => {
    const shown = (event: Event) => setPetOn((event as CustomEvent<boolean>).detail === true);
    window.addEventListener(PET_EVENT, shown);
    return () => window.removeEventListener(PET_EVENT, shown);
  }, []);
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
  // A new request ends the thread: bring it into view even when the person had scrolled up to read.
  const requestKeys = approvals.map((approval) => `${approval.nodeId}\u0000${approval.approval_id}`).join("\u0001");
  useEffect(() => {
    if (!requestKeys) return;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "instant" });
  }, [requestKeys]);
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
  // Continue in project: the new chat opens with the seeded message, ready to review and send.
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
  // An AO agent or a Native Codex one (WebGPT; Codex's turn/steer) can be steered: a single chat's
  // card, or a team's orchestrator (see chat_steer).
  const steerable = Boolean(latest?.nodes.some((node) => node.state === "running"
    && (node.route?.harness_id?.startsWith("ao:") || node.route?.harness_id === "codex-native")
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
  // Also a steer typed while the last message is still being sent, and a message typed while the
  // surface's one-action lock is held (a refresh, an approval): Enter did nothing for 2-5 s after a
  // send ("it will stop then freeze"), as the new run turned the chat steerable before the send
  // returned. The composer never refuses, as in Claude Code: it waits in the queued-message bar and
  // goes (steered or sent) the moment the send or the lock is done.
  const queueWhileSending = Boolean(selectedTaskId) && (sending || (busy && !steering));
  const canSend = !(deciding && !selectedTaskId) && (!sending || queueWhileSending)
    && Boolean(draft.trim() || attachments.length || annotations.length) && (accepts || steering || queueing || queueWhileSending);
  const slash = chatSlashMatches(draft, { chat: Boolean(selectedTaskId), run: Boolean(latest), open: runOpen });

  // What a command shows above the composer (its result, or why it couldn't run).
  const [card, setCard] = useState<ChatCommandCard | null>(null);
  // Edit goal: the objective being edited, or null.
  const [goalEditing, setGoalEditing] = useState<string | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  // Edit wake-up: its note and the minutes from now being edited, or null.
  const [wakeupEditing, setWakeupEditing] = useState<{ reason: string; minutes: string } | null>(null);
  // Another chat's card or goal edit never shows over this one (its queue says so itself, below).
  useEffect(() => { setCard(null); setGoalEditing(null); setWakeupEditing(null); }, [selectedTaskId]);
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
    // A steer shows at once, as in Claude Code: the composer clears and the message is in the chat,
    // at the end of the running turn where the turn will show it, its check pulsing while it reaches
    // the agent, which can take seconds (it waits out an approval being answered). It sat in the
    // queued bar under the goal at first and then jumped up into the chat once delivered.
    // A /goal steers in too: its condition is the goal's first round (see chat_steer's goal).
    const steerNow = (steering || restart) && Boolean(steer && selectedTaskId);
    // A steer sent again from the queue keeps the bubble it already has, not a second one.
    const pendingId = steerNow ? pendingSteers.find((entry) => entry.taskId === selectedTaskId && entry.text === message)?.id
      ?? `steer-${Date.now()}-${Math.random().toString(36).slice(2)}` : "";
    if (steerNow) {
      // It stays with the turn it is sent in (the running one, else the last), also once a new mission starts.
      const host = turns.findLast(liveTurn) ?? turns.at(-1);
      setPendingSteers((list) => list.some((entry) => entry.id === pendingId)
        ? list.map((entry) => entry.id === pendingId ? { ...entry, at: Date.now() } : entry)
        : [...list, { id: pendingId, taskId: selectedTaskId, text: message, at: Date.now(), turnKey: host?.key, messageIndex: host?.messageIndex }]);
      if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
    } else setSending(true);
    const dropPending = () => { if (pendingId) setPendingSteers((list) => list.filter((entry) => entry.id !== pendingId)); };
    try {
      // A steer the turn outran (it ended first) is sent as an ordinary follow-up instead.
      const steered = steerNow ? await steer!({ taskId: selectedTaskId, message, ...(restart ? { restart: true } : {}), ...(goal ? { goal } : {}) }) : false;
      // The agent is busy with a request of its own (or still starting): the steer waits in the queue
      // and goes in once it can. It stays shown as steering; a "Queued" card here read as if the
      // message had not been sent at all ("it pop up as queued for no reason").
      const waits = steered === "wait" || steered === "starting";
      // Delivered: it stays shown until the turn shows it (see pendingSteers); anything else drops it.
      if (steered !== true && !waits) dropPending();
      if (steered === true) setPendingSteers((list) => list.map((entry) => entry.id === pendingId ? { ...entry, sent: true } : entry));
      if (waits) setPendingSteers((list) => list.map((entry) => entry.id === pendingId ? { ...entry, waiting: true } : entry));
      if (steerNow && steered === false) setSending(true);
      if ((steered === "wait" || steered === "restart" || steered === "interrupt" || steered === "starting") && selectedTaskId) {
        // The agent was found waiting on its own request just now (the page had not seen it yet):
        // steering would cancel that request, so the message waits for the turn like a queued one.
        // Or its turn had hung, or sat in a long command that would have kept it from reading the
        // message, and was stopped: the message goes as the same agent's next turn once it settles.
        // The app keeps it (chat-queue.cjs): a waiting steer is steered in once the agent can take
        // it, and anything else goes as the next turn, with this chat closed too.
        await enqueue(selectedTaskId, { ...(goal ? { what: "Goal", message, goal } : { what: "Message", message }), steer: waits });
        if (current()) { setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote(""); }
        // The queued-message bar shows a waiting steer, as Claude Code does; only a stopped turn is told.
        if (here() && !waits) {
          say(steered === "restart" ? "Restarting" : "Interrupting", steered === "restart"
            ? "The agent stopped responding, so its turn was stopped. Your message goes in as the next turn."
            : "A command was still running, so it was stopped. The same agent gets your message next.",
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
      // The app queues it at the front and sends it when the chat is free (a queue refused while the
      // window is not in front leaves it to come back below).
      if (selectedTaskId && (busyNow || unfocused) && await enqueue(selectedTaskId, { what: "Message", message, ...(goal ? { goal } : {}) }, true).then(() => true, () => false)) {
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
      say("Too long", `This message is ${text.length.toLocaleString()} characters with annotations. The limit is ${CHAT_MESSAGE_LIMIT.toLocaleString()}. Remove an annotation or select less.`);
      return;
    }
    if (queueing || queueWhileSending) {
      // Several messages typed during one turn go together, in order.
      setDraft(""); setAttachments([]); setAnnotations([]); setAttachNote("");
      // Not queued: it goes back into the composer, ahead of anything typed since.
      void enqueue(selectedTaskId, { what: "Message", message: text }).catch((error) => {
        setDraft((typed) => (typed.trim() ? `${text}\n\n${typed}` : text));
        say("Message", `Couldn't queue the message: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    await deliver(text);
  };

  // Messages (or commands' messages) waiting for their chat's turn to end, as Codex queues them. The
  // app keeps each chat's queue (chat-queue.cjs): it sends the next item when the chat's turn settles,
  // and steers a waiting one in once the agent can take it (15 s, 30 s, then every minute), with this
  // chat closed, another one open or the window in the background. Before, this view sent the queue
  // itself, only for the chat on screen and only with the window focused, and a restart lost it.
  const [, setQueueVersion] = useState(0);
  useEffect(() => {
    const changed = () => setQueueVersion((value) => value + 1);
    queueListeners.add(changed);
    return () => { queueListeners.delete(changed); };
  }, []);
  const queueOf = (taskId: string) => CHAT_QUEUES.get(taskId) ?? [];
  const queued = queueOf(selectedTaskId);
  /**
   * Queues `item` with the app, to steer in while the agent works (in steer mode) or else to send as
   * the next turn. A plain message joins one queued just before it (chatQueueAdd).
   */
  const enqueue = async (taskId: string, item: QueuedChatMessage, front = false) => {
    if (!queue) throw new Error("Queued messages are unavailable here");
    const entry = { ...item, steer: item.steer ?? steerOn };
    const current = queueOf(taskId), joined = front ? null : chatQueueAdd(current, entry);
    const last = joined && joined.length === current.length ? joined.at(-1) : undefined;
    if (last?.id && await queue.update(taskId, last.id, last.message)) return;
    await queue.add(taskId, entry, front);
  };
  // Gone from the bar at once; the app's answer confirms it.
  const dequeue = (taskId: string, ids: string[] | null) => {
    const project = QUEUE_PROJECTS.get(taskId);
    if (project) syncChatQueues(project, { [taskId]: ids === null ? [] : queueOf(taskId).filter((item) => !item.id || !ids.includes(item.id)) }, taskId);
    void queue?.remove(taskId, ids).catch(() => undefined);
  };
  /**
   * Sends a command's message now when the chat is free, steers it into the working agent when it
   * can be steered (a goal too, as its first round), and otherwise queues it for when the current turn finishes.
   */
  const dispatch = async (what: string, message: string, goal: string | undefined, typed: string): Promise<"sent" | "queued" | false> => {
    if (busy || sending) { say(what, "Another action is running. Try again in a moment."); return false; }
    if (accepts || steering) return await deliver(message, goal) ? "sent" : false;
    // Queued as Claude Code queues a command: it joins the queued messages above the composer, as
    // typed. The "Queued. It's sent when this turn finishes" card is gone.
    try {
      await enqueue(selectedTaskId, { what, message, ...(goal ? { goal } : {}), typed });
    } catch (error) {
      say(what, `Couldn't queue it: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    setCard(null);
    return "queued";
  };
  // The queued-message bar: the steers still on their way to the agent (Claude Code's head of the
  // queue, which goes first), then this chat's queued messages and commands. Send now steers one in
  // at once (a goal too, as its first round), or sends it when the chat is free; while the agent
  // waits on its own request steering would cancel that request, so it waits too.
  const sendNowBlocked = busy || sending ? "Another message is being sent"
    : accepts || (steering && !awaitingAnswer) ? undefined
    : awaitingAnswer ? "Answer the agent's request first" : "Sent when the current turn finishes";
  const takeQueued = (index: number) => {
    const item = queueOf(selectedTaskId)[index];
    if (item?.id) dequeue(selectedTaskId, [item.id]);
    return item;
  };
  // A steer is in the chat from the moment it is sent (steersByTurn), not in this bar. One that waits
  // for the agent's own request is in the queue too, to go in later; it shows once, in the chat.
  const steerWaiting = (message: string) => pendingSteers.some((entry) => entry.taskId === selectedTaskId && entry.waiting && entry.text === message);
  const queuedBar: QueuedBarItem[] = queued.flatMap((item, index): QueuedBarItem[] => {
    if (item.what === "Message" && !item.goal) return steerWaiting(item.message) ? [] : [queuedMessageItem(item, index)];
    // A command shows as typed; clicking it puts it back in the composer, ahead of anything typed.
    const typed = item.typed ?? (item.goal ? `/goal ${item.goal}` : `/${item.what.toLowerCase()}`);
    return [{
      key: `queued:${index}:${typed.length}`, text: typed, state: "queued", sendNowBlocked,
      onRemove: () => { takeQueued(index); },
      onEdit: () => {
        if (!takeQueued(index)) return;
        setDraft((draft) => (draft.trim() ? `${typed}\n\n${draft}` : typed));
        input.current?.focus();
      },
      onSendNow: () => {
        const task = selectedTaskId, taken = takeQueued(index);
        if (!taken) return;
        void deliver(taken.message, taken.goal, false).then((sent) => { if (!sent) void enqueue(task, taken, true).catch(() => undefined); });
      },
    }];
  });
  function queuedMessageItem(item: QueuedChatMessage, index: number): QueuedBarItem {
    return {
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
        void deliver(taken.message, undefined, false).then((sent) => { if (!sent) void enqueue(task, taken, true).catch(() => undefined); });
      },
    };
  }
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
  const notYet = "This message hasn't run yet. Delete it after its turn runs";
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

  /** `typed`: the command was typed or picked in the box, which it then clears; a button (the goal
   * bar's icons, Stop loop, Compact) leaves what is typed alone. Clicking the goal bar's icons wiped
   * the draft ("remove boxes when clicked on logos"). */
  const runCommand = async (name: string, arg = "", typed = true) => {
    setSlashIndex(0);
    if (typed) setDraft("");
    try {
      switch (name) {
        case "goal": {
          const goal = commands?.goal;
          const action = arg.toLowerCase();
          // A bare /goal opens the goal to edit, or with none set waits for one in the box: the line
          // under the box already says how /goal is used, and a card repeating it only got in the way.
          if (!arg) {
            if (goal) { setCard(null); setGoalEditing(goal.objective); }
            else { setDraft("/goal "); input.current?.focus(); }
            break;
          }
          // Done quietly: the goal bar shows the new state (paused, pursuing, gone), and a card saying so
          // under the chat only cluttered it (the user: "keep the chat clean").
          if (["pause", "resume", "clear"].includes(action)) {
            setCard(null);
            if (action === "clear" && queued.some((item) => item.goal)) {
              dequeue(selectedTaskId, queued.flatMap((item) => (item.goal && item.id ? [item.id] : []))); break;
            }
            if (!commands) break;
            if (!goal) { say("Goal", "No goal set."); break; }
            // The bar's icons wait while it is applied, so a second click can't stack another action.
            setGoalBusy(true);
            try { await commands.goalAction(action as "pause" | "resume" | "clear"); } finally { setGoalBusy(false); }
            break;
          }
          if (action === "edit") {
            if (!goal) say("Goal", "No goal set."); else { setCard(null); setGoalEditing(goal.objective); }
            break;
          }
          if (goal && ["active", "paused"].includes(goal.status)
            && !window.confirm("Replace the current goal?\n\nThe chat stays. Only its goal changes.")) { setDraft(`/goal ${arg}`); break; }
          // While a turn is working the goal steers in (its first round); if the agent can't be steered it waits for the turn.
          const outcome = await dispatch("Goal", arg, arg, `/goal ${arg}`);
          if (!outcome) setDraft(`/goal ${arg}`);
          else if (outcome === "sent") setCard(null);
          break;
        }
        case "loop": {
          const loop = commands?.loop;
          if (!arg) {
            setCard(loop ? { title: "Loop", rows: [["Prompt", loop.prompt],
              ["Runs", loop.minutes === null ? "When the agent asks (schedule_wakeup)" : `Every ${loopInterval(loop.minutes)}`],
              ["Round", String(loop.round)], ["Ends by", new Date(loop.expiresAt).toLocaleString()],
              ...(loop.note ? [["Note", loop.note] as [string, string]] : [])] }
              : { title: "Loop", text: "No loop is running in this chat.\nUsage: /loop [interval] <prompt> | stop\n"
                + "Examples: /loop 5m check whether the deploy finished\n/loop 30m /review\n"
                + "/loop watch the CI run and fix what fails (no interval: the agent picks when to look again)" });
            break;
          }
          if (["stop", "cancel", "clear"].includes(arg.toLowerCase())) {
            if (!loop) { say("Loop", "No loop is running in this chat."); break; }
            await commands?.stopLoop?.();
            say("Loop", "Loop stopped; a round already running finishes.");
            break;
          }
          if (!selectedTaskId || !commands?.startLoop) { say("Loop", "Open a chat first: a loop runs in the chat it was started in."); break; }
          const parsed = chatLoopParse(arg);
          if ("error" in parsed) { say("Loop", parsed.error); setDraft(`/loop ${arg}`); break; }
          // A command that sends a prompt runs as that prompt each round; the others act on the app.
          const inner = chatSlashParse(parsed.prompt);
          const prompt = inner?.name === "review" ? reviewPrompt(inner.arg) : inner?.name === "init" ? INIT_PROMPT : parsed.prompt;
          if (inner && !["review", "init"].includes(inner.name)) {
            say("Loop", `/${inner.name} acts on the app, so it can't loop. A loop runs a prompt, /review or /init.`); setDraft(`/loop ${arg}`); break;
          }
          if (loop && !window.confirm("Replace this chat's loop?\n\nThe running loop stops and this one starts.")) { setDraft(`/loop ${arg}`); break; }
          await commands.startLoop({ prompt, minutes: parsed.minutes });
          const first = accepts ? "runs now" : "runs when the current turn finishes";
          say("Loop", parsed.minutes === null
            ? `Looping: it ${first}, then the agent picks when to run it again. It ends when the agent stops scheduling rounds, after 7 days, or with /loop stop.`
            : `Looping every ${loopInterval(parsed.minutes)}: it ${first}, then every ${loopInterval(parsed.minutes)} for up to 7 days. /loop stop ends it.`);
          break;
        }
        case "plan":
          commands?.setPlanMode(!commands.planMode);
          say("Plan mode", commands?.planMode ? "Plan mode is off." : "Plan mode is on. Messages ask for a plan, not changes. Send /plan to turn it off.");
          break;
        case "compact":
          if (!commands || !selectedTaskId) break;
          if (!accepts) { say("Compact", "Can't compact while the chat is running."); break; }
          say("Compact", arg ? `Compacting this chat's context, focused on: ${arg}` : "Compacting this chat's context…");
          say("Compact", await commands.compact(arg));
          break;
        case "autocompact": {
          if (!commands?.autoCompact) break;
          const change = autoCompactArg(arg);
          if (change && "error" in change) { say("Auto-compact", change.error); setDraft(`/autocompact ${arg}`); break; }
          const setting = await commands.autoCompact(change ?? {});
          const now = setting.autoCompact
            ? `Auto-compact is on: before a message that would fill ${setting.percent}% of the chat's ${setting.limit.toLocaleString("en-US")}-byte limit, the earlier conversation becomes a summary.`
            : "Auto-compact is off: a full chat stops until you /compact it.";
          say("Auto-compact", change ? now : `${now}
Change it with /autocompact on, off, or a share like /autocompact 80.`);
          break;
        }
        case "context": if (commands?.context) setCard(await commands.context()); break;
        case "review":
          if (await dispatch("Review", reviewPrompt(arg), undefined, arg ? `/review ${arg}` : "/review") === "sent" && !accepts) say("Review", "Sent to the working agent.");
          break;
        case "init":
          if (await dispatch("Init", INIT_PROMPT, undefined, "/init") === "sent" && !accepts) say("Init", "Sent to the working agent.");
          break;
        case "rewind": {
          if (!thread?.rewind) break;
          if (!rewindPoints.length) { say("Rewind", "No message to go back to yet."); break; }
          const pick = Number(arg);
          if (arg) {
            const point = Number.isInteger(pick) ? rewindPoints[pick - 1] : undefined;
            if (point) thread.rewind(point.messageIndex);
            else say("Rewind", `Choose a message from 1 to ${rewindPoints.length}, like /rewind ${rewindPoints.length}.`);
            break;
          }
          setCard({ title: "Rewind",
            text: "Pick a message to rewind and resend in this chat. Later replies leave the conversation; your files don't change. Stop any running task first.",
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
            else say("Delete message", `Choose a message from 1 to ${rewindPoints.length}, like /delete ${rewindPoints.length}.`);
            break;
          }
          setCard({ title: "Delete message", text: "Choose a message to delete. You confirm before it goes.",
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
        case "new": case "clear": thread?.newChat(); break;
        case "stop": if (latest && runOpen) stop?.(latest.id); break;
        case "retry": if (latest) restart?.(latest.id); break;
        case "model":
          // This chat's own picker: in split view every pane has one.
          ((chatRoot.current ?? document).querySelector<HTMLButtonElement>('.cx-composer [aria-label="Choose model"]')
            ?? (chatRoot.current ?? document).querySelector<HTMLButtonElement>('.cx-composer [aria-label="Choose saved team"]'))?.click();
          break;
        case "effort":
          // This chat's own effort chip, as /model opens its model chip.
          (chatRoot.current ?? document).querySelector<HTMLButtonElement>('.cx-composer [aria-label^="Reasoning effort"]')?.click();
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
      if (image) { freePreview(preview); notes.push(`${file.name}: can't attach an image without its file path`); continue; }
      if (file.size > INLINE_ATTACHMENT_BYTES) { notes.push(`${file.name}: over 200 KB, too large to attach inline`); continue; }
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

  const chatRoot = useRef<HTMLDivElement>(null);
  const headerMenu = (): ChatMenuItem[] => [
    ...(thread && chat ? [
      { label: "Rename", shortcut: "Alt+Ctrl+R", run: () => setRenaming(chat.title) },
      { label: thread.pinned ? "Unpin" : "Pin", shortcut: "Alt+Ctrl+P", run: thread.togglePin },
      { label: "Fork", run: () => thread.fork() },
      { label: "Copy conversation", run: thread.copyConversation },
    ] as ChatMenuItem[] : []),
    ...(steer ? [{ label: "Steer while working", checked: steerOn, run: toggleSteer } as ChatMenuItem] : []),
    { label: "Compact activity", checked: compactActivity, run: toggleCompact } as ChatMenuItem,
    { label: "Reply style", detail: CHAT_STYLES.find((style) => style.id === replyStyle)?.label,
      items: CHAT_STYLES.map((style) => ({ label: style.label, detail: style.hint, checked: style.id === replyStyle, run: () => pickReplyStyle(style.id) })) } as ChatMenuItem,
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
      ? { label: "Archive", reason: "Stop the mission to archive this chat" }
      : { label: "Archive", shortcut: "Ctrl+Shift+A", run: thread.archive }] as ChatMenuItem[] : []),
    ...(onClosePane ? [{ kind: "separator" }, { label: "Close split view", shortcut: "Ctrl+Alt+W", run: onClosePane }] as ChatMenuItem[] : []),
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
  // This chat's steers on their way, each under the turn it was sent in (steerTurnIndex); one whose
  // turn is not in the chat shows in the running turn (else the last).
  const steersByTurn = useMemo(() => {
    const byTurn = new Map<number, PendingSteer[]>();
    const live = turns.findLastIndex(liveTurn);
    for (const entry of pendingSteers) {
      if (entry.taskId !== selectedTaskId) continue;
      const own = steerTurnIndex(turns, entry);
      const at = own >= 0 ? own : live >= 0 ? live : turns.length - 1;
      byTurn.set(at, [...(byTurn.get(at) ?? []), entry]);
    }
    return byTurn;
  }, [pendingSteers, selectedTaskId, turns]);
  // Each turn's steers on their way as one element, kept while they are unchanged so a DeepSeek turn's
  // memoized work (DshWork) does not draw again for them.
  const steerViews = useMemo(() => new Map([...steersByTurn].map(([at, list]) => [at, <PendingSteers steers={list} />])), [steersByTurn]);
  // A goal's rounds past the newest two fold under one row (FoldedRounds): a 52-round goal was 52
  // replies to scroll past. `foldOf` maps a folded turn to its run of rounds, `foldAt` the run's first turn to its row.
  const [openRounds, setOpenRounds] = useState<ReadonlySet<string>>(() => new Set());
  const roundFolds = useMemo(() => {
    const foldOf = new Map<number, string>();
    const foldAt = new Map<number, { key: string; first: number; last: number }>();
    for (const [key, indexes] of foldedRounds(turns)) {
      for (const index of indexes) foldOf.set(index, key);
      foldAt.set(indexes[0], { key, first: goalRound(turns, indexes[0])!.round, last: goalRound(turns, indexes[indexes.length - 1])!.round });
    }
    return { foldOf, foldAt };
  }, [turns]);
  const toggleRounds = (key: string) => setOpenRounds((open) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const threadTurns = useMemo(() => turns.map((turn, turnIndex) => {
    const foldKey = roundFolds.foldOf.get(turnIndex);
    const foldRow = roundFolds.foldAt.get(turnIndex);
    const foldToggle = foldRow ? <FoldedRounds key={`fold:${foldRow.key}`} first={foldRow.first} last={foldRow.last}
      open={openRounds.has(foldRow.key)} onToggle={() => toggleRounds(foldRow.key)} /> : null;
    if (foldKey && !openRounds.has(foldKey)) return foldToggle;
    // A turn on a DeepSeek model shows as DeepSeek Harness shows one (DshTranscript); others as Claude Code.
    const dsh = isDeepSeekModel(chatRuns.find((run) => run.id === turn.runId)?.nodes.find((node) => node.role === "planner")?.route?.model);
    let readWork = dshReaders.get(turn.runId);
    if (dsh && !readWork) {
      readWork = (step, wanted) => useStepWork(step, turn.runId, wanted, loadWork);
      dshReaders.set(turn.runId, readWork);
    }
    const idle = notStarted && turn.runId === latest?.id;
    // A goal's next round is its Stop hook's feedback, shown as Claude Code shows it, not as a message the person sent.
    const feedback = turn.user ? goalFeedback(turn.user.text) : null;
    // Who answered, said once and plainly: a single chat's model (its maker's mark and name), or a
    // team's answering card marked Team. How it ran (harness, provider, effort, window) is the tooltip.
    const answerRun = chatRuns.find((run) => run.id === turn.runId);
    const teamAnswer = Boolean(answerRun) && answerRun?.execution_mode !== "single";
    // The reply's head (ReplyHead): who answered, how it stands, why it failed and what it changed.
    const live = !idle && liveTurn(turn);
    const cards = [...turn.steps, ...(turn.final ? [turn.final] : [])];
    const modelOf = (step: ChatStep) => answerRun?.nodes.find((node) => node.id === step.nodeId)?.route?.model;
    const lead = turn.final ?? cards[0];
    const leadModel = lead ? modelOf(lead) : undefined;
    const members: ReplyMember[] = teamAnswer ? cards.map((step) => {
      const model = modelOf(step);
      const tone = cardTone(step);
      return { key: step.key, name: step.name, model, modelName: model ? modelShortLabel(model).name || model : undefined, tone,
        state: step.verdict || (tone === "working" ? step.working?.activity || "Working" : tone === "failed" ? "Failed" : tone === "done" ? "Done"
          : tone === "stopped" ? "Stopped" : tone === "stalled" ? "May be stuck" : "Waiting") };
    }) : [];
    const failing = cards.find((step) => step.error);
    // The chat's failed-step card says this turn's error already (FailedStepCard).
    const headError = failing && turn !== failedTurn ? { step: failing.name, message: failing.error! } : undefined;
    const items = cards.flatMap((step) => CHAT_WORK.get(stepWorkKey(step)) ?? step.working?.timeline ?? []);
    const changes = turnChanges(items);
    // The reply as steps, drawn in the chat style (ChatReplyPlan); the transcript's rows are its steps.
    const plan = replyStyle === "transcript" ? null : replyPlan(items, live, failing?.error);
    // Focus keeps the work behind Show work whatever the chat's setting: its progress line says where the turn is.
    const turnWork = replyStyle === "focus" ? false : showWork;
    const hasReply = Boolean(cards.length || live);
    // A goal's later round opens on a divider: its number and why the last round fell short.
    const round = feedback ? goalRound(turns, turnIndex) : null;
    // One message that cannot render (a run's unexpected data) shows a notice in its place; the
    // chat and the rest of the window stay up.
    const view = <PartErrorBoundary key={turn.key} label="This message"><article className={`cx-turn${dsh ? " is-dsh" : ""}`}>
              {feedback ? <RoundDivider round={round?.round ?? 2} reason={feedback.reason}
                stamp={turn.user?.stamp ? <span className="cx-stamp" title={`${turn.user.stamp} UTC`}>{localChatStamp(turn.user.stamp)}</span> : null} />
              : turn.user ? <div className="cx-user">
                <SentMessage text={turn.user.text} />
                <MessageActions text={chatMessageReadable(turn.user.text)}>
                  {thread ? <button type="button" title="Fork from here" aria-label="Fork from this message" onClick={() => thread.fork(turn.messageIndex ?? turnIndex)}><ChatGlyph name="fork" /></button> : null}
                  {thread?.rewind ? <button type="button" title="Rewind and resend this message (files are unchanged)" aria-label="Rewind to this message" onClick={() => thread.rewind?.(turn.messageIndex ?? turnIndex)}><Icon name="reload" width="14" height="14" /></button> : null}
                  {thread?.deleteMessage ? <button type="button" title={deleteBlocked || (deletion(turn) ? "Delete this message and its reply" : notYet)} aria-label="Delete this message"
                    disabled={Boolean(deleteBlocked) || !deletion(turn) || deletingBusy} onClick={() => setDeleting(turnIndex)}><ChatGlyph name="delete" /></button> : null}
                </MessageActions>
                {turn.user.stamp ? <span className="cx-stamp" title={`${turn.user.stamp} UTC`}>{localChatStamp(turn.user.stamp)}</span> : null}
              </div> : null}
              {/* Messages steered into this turn. While it works they show in its live timeline, where
                  they were sent; once it is done, here under the turn's message. */}
              {turn.user?.steers?.length && !turn.steps.some((step) => step.working?.timeline?.some((item) => item.kind === "steer"))
                ? <SteerReader.Provider value={steerReader(turn.steps[0])}>{turn.user.steers.map((steer, index) => <div key={`steer:${index}`} className="cx-user cx-steer">
                  <SentMessage text={steer.text} />
                  {/* Saved only once the agent took it; a turn that finished read it, one that stopped may not have. */}
                  <div className="cx-msg-foot"><SteerReceiptMark receipt={turn.status === "done" ? "read" : liveTurn(turn) ? "unread" : undefined} />
                    <MessageActions text={chatMessageReadable(steer.text)} /></div>
                  <span className="cx-stamp" title={`${steer.stamp} UTC`}>{localChatStamp(steer.stamp)}</span>
                </div>)}</SteerReader.Provider> : null}
              {hasReply ? <section className={`cx-reply is-${replyTone(turn, live)}${teamAnswer ? " is-team" : ""}`} aria-label="Reply">
              <ReplyHead team={teamAnswer} name={teamAnswer ? "Team" : lead?.name ?? "Agent"} model={leadModel} tone={replyTone(turn, live)}
                startedAtMs={turn.startedAtMs} endedAtMs={turn.endedAtMs ?? turns.slice(turnIndex + 1).find((later) => later.startedAtMs)?.startedAtMs}
                verdict={turn.final?.verdict} attempt={stepAttempt(lead)} error={headError} members={members} changes={changes} />
              {plan ? <ReplyPlanView plan={plan} style={replyStyle} live={live} /> : null}
              {/* The head says the error, so the DeepSeek turn leaves its own copy out. */}
              {dsh && readWork
                ? <DshWork key={`${turn.key}:${turnWork ? "open" : "folded"}`} turn={turn} live={live} expanded={turnWork} useWork={readWork}
                  errorShownBelow={Boolean(failing)} refusal={live ? cpaRefusal : null}
                  beforeStatus={live ? steerViews.get(turnIndex) : undefined} headed />
                : <WorkGroup key={`${turn.key}:${turnWork ? "open" : "folded"}`} turn={turn} idle={idle} expanded={turnWork} loadWork={loadWork} />}
              {/* A steer on its way sits above the turn's running line ("Deep diving", "Working"), never
                  under it: a running DeepSeek turn draws it inside its work, right above that line. */}
              {steerViews.has(turnIndex) && !(dsh && readWork && live) ? steerViews.get(turnIndex) : null}
              {!dsh && live ? <TurnRunning turn={turn} refusal={cpaRefusal} /> : null}
              {turn.final && !(dsh && turn.final.working) ? <div className={`cx-answer${turn.final.verdict ? " has-verdict" : ""}`}>
                {/* Who answered and its verdict are in the head; a finished reviewer's earlier cycles stay above its answer (DeepSeek's row shows them). */}
                {dsh ? null : <EarlierRounds rounds={turn.final.earlier} />}
                <ChatMarkdown text={turn.final.text ?? ""} />
                <MessageActions text={turn.final.text ?? ""}>
                  {restart && turn.runId && turn.runId === latest?.id && !runOpen ? <button type="button" title="Retry" aria-label="Retry this mission" disabled={busy} onClick={() => restart(turn.runId)}><Icon name="reload" width="14" height="14" /></button> : null}
                </MessageActions>
              </div> : null}
              {!turn.final && turn.status === "done" && !turn.steps.some((step) => step.text || step.error)
                ? <p className="cx-note">Finished without an answer.</p> : null}
              {turn.solo ? <p className="cx-note">The orchestrator answered alone. No workers ran.</p> : null}
              {/* How long it worked is in the head; the foot keeps the turn's model requests. */}
              {turn.runId && turn.startedAtMs && !liveTurn(turn)
                ? <TurnFoot from={turn.startedAtMs} endedAt={turn.endedAtMs} models={turn.cpaModels} status={turn.status} showTime={false}
                  to={turn.endedAtMs ?? turns.slice(turnIndex + 1).find((later) => later.startedAtMs)?.startedAtMs} /> : null}
              </section> : null}
              {turn.unsent ? <p className="cx-note">This message didn't start a turn. Send it again if it's still needed.</p> : null}
            </article></PartErrorBoundary>;
    return foldToggle ? [foldToggle, view] : view;
  }), [turns, thread, deleteBlocked, deletingBusy, chatRuns, showWork, notStarted, latest?.id, loadWork, dshReaders, restart, runOpen, busy, failedTurn, steerViews, detailsWorkTick,
    replyStyle, roundFolds, openRounds]);

  return (<Attachments.Provider value={attachmentAccess}><SentMessageView.Provider value={sentMessageView}><CompactActivity.Provider value={compactActivity}>
    <TurnRestart.Provider value={{ onRestart: restartTurn, restarting }}>
    <div ref={chatRoot} className={`cx-chat${showStructure && structure ? " has-structure" : ""}`}>
      <section className="cx-thread" aria-label={chat?.title || CHAT_DEFAULT_TITLE}>
        <header className="cx-thread-head">
          <span className="cx-head-folder" title={projectName}><ChatGlyph name="folder" size={15} /></span>
          {deciding && !selectedTaskId ? <h2>{projectLoadError ? "Couldn't load project" : "Opening project…"}</h2> : selectedTaskId || pendingCreation
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
            title={`Agent's browser: ${livePage.url}\nClick to show`} onClick={() => setWorkbench("preview")}>
            <span className="cx-browser-dot" aria-hidden="true" /><Icon name="browser" width="13" height="13" />
            <span>{livePage.title || (() => { try { return new URL(livePage.url).host; } catch { return livePage.url; } })()}</span></button> : null}
          {/* Preview, as Claude Code's header has it: the chat's browser in one click, open page or not
              (the user found it only behind Side panel → Overview → Preview). */}
          {selectedTaskId && !(livePage && workbench !== "preview") ? <button type="button" className="cx-icon-button" aria-pressed={workbench === "preview"}
            title="Preview: the chat's browser" aria-label="Preview" onClick={() => setWorkbench((open) => (open === "preview" ? null : "preview"))}>
            <Icon name="globe" width="16" height="16" /></button> : null}
          {selectedTaskId ? <button type="button" className="cx-icon-button cx-compact-toggle" aria-pressed={compactActivity}
            title={compactActivity ? "Show every step" : "Compact activity"}
            aria-label="Compact activity" onClick={toggleCompact}>
            <Icon name={compactActivity ? "expand" : "minus"} width="16" height="16" /></button> : null}
          {structure || latest ? <button type="button" className="cx-icon-button" aria-pressed={showStructure} title="Show cards" aria-label="Show cards"
            disabled={!latest} onClick={() => structure ? setShowStructure((value) => !value) : latest && openStructure(latest.id)}>
            <Icon name="orchestrator" width="16" height="16" /></button> : null}
          {/* The side panel opens on its Overview, as Claude Code's side column: context, changes,
              tasks and usage, each a click from its tab (the browser chip still opens Preview). */}
          {selectedTaskId ? <button type="button" className="cx-icon-button" aria-pressed={workbench !== null} title="Show side panel"
            aria-label="Show side panel" onClick={() => setWorkbench((open) => (open ? null : "overview"))}>
            <Icon name="browser" width="16" height="16" /></button> : null}
          {onOpenMissionBoard ? <button type="button" className="cx-icon-button" title="Mission Board" aria-label="Open Mission Board" onClick={onOpenMissionBoard}>
            <Icon name="logs" width="16" height="16" /></button> : null}
          {selectedTaskId ? <button type="button" ref={detailsToggle} className="cx-icon-button" data-details-toggle=""
            title={detailsOpen ? "Hide chat details" : "Chat details: changes, agents, setup, outputs and sources"} aria-label="Chat details"
            aria-pressed={detailsOpen} onClick={toggleDetails}><ChatGlyph name="section" size={16} /></button> : null}
          <button type="button" className="cx-icon-button" title="More" aria-label="More chat actions" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.right - 240, y: box.bottom + 4, items: headerMenu(), label: "Chat actions" }))}>⋯</button>
          {/* Claude Code's pane close: on every split view pane, the window's own chat included. */}
          {onClosePane ? <button type="button" className="cx-icon-button cx-pane-close" aria-label="Close split view" title="Close split view (Ctrl+Alt+W)"
            onMouseDown={(event) => event.preventDefault()} onClick={onClosePane}><Icon name="close" width="14" height="14" /></button> : null}
        </header>
        {details ? (() => {
          const nodes = latest?.nodes ?? [];
          const lead = nodes.find((node) => node.role === "planner") ?? nodes[0];
          const agents = chatAgentSummary(nodes);
          const { outputs = [], sources = [] } = detailLinks ?? {};
          // A file opens the worktree's files, a page on this machine the agent's preview, a web page
          // the browser; an MCP server only names what was called.
          const linkRow = (link: ChatDetailLink) => {
            const icon = link.kind === "file" ? <ChatGlyph name="edit" size={15} /> : link.kind === "image" ? <ChatGlyph name="spark" size={15} />
              : <Icon name={link.kind === "page" ? "globe" : link.kind === "tool" ? "mcp" : "external"} width="15" height="15" />;
            const body = <>{icon}<span>{link.kind === "image" ? `Generated image · ${link.label}` : link.label}</span></>;
            if (link.kind === "link") return <a key={link.key} className="cx-details-row" href={link.title} target="_blank" rel="noreferrer noopener" title={link.title}>{body}</a>;
            if (link.kind === "tool") return <p key={link.key} className="cx-details-row is-static" title={link.title}>{body}</p>;
            return <button key={link.key} type="button" className="cx-details-row" title={link.title} onClick={() => {
              if (link.kind === "page" && agentSessionIds[0]) { navigatePreview(agentSessionIds[0], link.title); setWorkbench("preview"); }
              else if (link.kind !== "page") setWorkbench("files");
            }}>{body}</button>;
          };
          return <FloatingLayer className="cx-details" role="complementary" style={{ left: details.left, top: details.top, maxHeight: `calc(100vh - ${details.top + 12}px)` }}>
            <div aria-label="Chat details">
              <div className="cx-details-head"><strong>{projectName || "Project"}</strong>{branch ? <small>{branch}</small> : null}</div>
              <button type="button" className="cx-details-row" disabled={!commands || !latest}
                onClick={() => { void runCommand("diff", "", false); }}>
                <ChatGlyph name="edit" size={15} /><span>Changes</span></button>
              <p className="cx-details-label">Agents</p>
              {latest ? <button type="button" className="cx-details-row" title="Open the cards"
                onClick={() => { if (structure) setShowStructure(true); else openStructure(latest.id); }}>
                <span className="cx-details-dots" aria-hidden="true">{agents.dots.slice(0, 8).map((state, index) =>
                  <span key={index} className={`cx-details-dot is-${state}`} />)}</span><span>{agents.text}</span></button>
                : <p className="cx-details-empty">No agents yet. They start with your first message.</p>}
              {/* Apps and terminals: a lit green dot while one runs, a red one once it is offline. A
                  click shows it (the Preview or the Terminal), which no longer opens by itself. */}
              <p className="cx-details-label">Processes</p>
              {processRows.length ? processRows.map((row) => <button key={row.key} type="button" className="cx-details-row cx-process-row"
                title={`${row.title}
${row.running ? "Running" : "Offline"} · click to show`} onClick={() => setWorkbench(row.kind === "app" ? "preview" : "terminal")}>
                <span className={`cx-process-dot ${row.running ? "is-running" : "is-offline"}`} role="img" aria-label={row.running ? "Running" : "Offline"} />
                <Icon name={row.kind === "app" ? "globe" : "logs"} width="14" height="14" />
                <span>{row.label}</span><small>{row.running ? "Running" : "Offline"}</small></button>)
                : <p className="cx-details-empty">Apps and terminals the agents start show here.</p>}
              <p className="cx-details-label">Setup</p>
              {lead ? <>
                <p className="cx-details-line">{describeNode?.(lead) || lead.route?.model || "Model not set"}</p>
                <p className="cx-details-line">Approvals: {chatApprovalMode(lead.route as { approval_policy?: string; approvals_reviewer?: string } | undefined)}</p>
              </> : <p className="cx-details-empty">Chosen when you send.</p>}
              <p className="cx-details-label">Outputs</p>
              {outputs.length ? outputs.slice(0, DETAILS_LIST_LIMIT).map(linkRow)
                : <p className="cx-details-empty">Files, images and local pages the agents make show here.</p>}
              <p className="cx-details-label">Sources</p>
              {sources.length ? sources.slice(0, DETAILS_LIST_LIMIT).map(linkRow)
                : <p className="cx-details-empty">Web pages and MCP servers the agents use show here.</p>}
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
              {deciding && !selectedTaskId ? <div role="status">
                <p>{projectLoadError ? `Couldn't load chats: ${projectLoadError}` : "Loading project chats…"}</p>
                {projectLoadError && onRetryProject ? <button type="button" className="button-primary" onClick={onRetryProject}>Retry loading</button> : null}
              </div> : selectedTaskId ? <p>Loading…</p> : <>
                <span className="cx-empty-glyph" aria-hidden="true"><ChatGlyph name="codex" size={40} /></span>
                <h1>What should we build{projectName ? <> in {onOpenProject
                  ? <button type="button" className="cx-empty-project" title="Open the project folder" onClick={onOpenProject}>{projectName}</button>
                  : <span className="cx-empty-project">{projectName}</span>}</> : null}?</h1>
              </>}
            </div> : null}
            {threadTurns}
            {/* A tool call that timed out: the chat keeps going by itself, so this is a red line in the
                conversation, not the failed-step card that waited for a click (2026-10-31). */}
            {warning && latest && !recovering ? <p className="cx-step-error cx-timeout-line" role="status">{warning}</p> : null}
            {(notice || notStarted) && latest && chat?.status === "queued" && !working ? (
              <div className="cx-card tone-error">
                <strong>{notice ? "Couldn't start the run" : "This run hasn't started"}</strong>
                <p>{notice || "It stopped before any agent ran. Start it again."}</p>
                <div className="cx-card-actions"><button className="button-primary" type="button" disabled={retrying} onClick={() => retryStart(latest.id)}>{notice ? "Retry" : "Start"}</button></div>
              </div>
            ) : null}
            {recovering && latest ? <FailedStepCard step={failedStep} notice={notice} busy={retrying} onRetry={() => retryStart(latest.id)} /> : null}
            {/* The agent's questions and requests end the conversation, right above the chat box, and
                scroll with it. Docked under the box they took up to 420 px of the pane: in a split pane
                the conversation had no room left at all (2026-10-31). */}
            {approvals.length || computerRequests.length ? <div className={`cx-approval-dock${isDeepSeekModel(latest?.nodes.find((node) => node.role === "planner")?.route?.model) ? " is-dsh" : ""}`}>
              {computerRequests.map((request) => <ComputerControlCard key={request.id} request={request} />)}
              {approvals.map(approval => {
                // Codex names who asks ("Allow ChatGPT to run this command?"): here the card's model.
                const model = latest?.nodes.find((node) => node.id === approval.nodeId)?.route?.model;
                const actor = model ? modelName?.(model) || model.slice(model.lastIndexOf("/") + 1) : undefined;
                return <AgentOrchestratorApproval key={JSON.stringify([approval.nodeId, approval.approval_id])} approval={approval} busy={busy} approve={approve} actor={actor} />;
              })}
            </div> : null}
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
              { label: "Cloud", icon: "share", reason: "No cloud runner set up. Chats run on this computer" },
            ] }))}>
            <ChatGlyph name="monitor" size={13} />This computer<Caret className="cx-chip-caret" /></button>
          {/* The project's branch sits with where the chat runs, as in Claude Code's start bar. */}
          <ChatBranchBar inline workspaceId={projectId} />
          <span className="cx-head-spacer" />
          <button type="button" className="cx-chip-icon" aria-label="Configure local environment" title="Configure local environment" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.right - 260, y: box.top - 116, label: "Configure local environment", items: [
              // Codex's environment popover. Orchestrator settings live in the header's ⋯ menu, not here.
              { label: "New worktree", icon: "fork", toggle: false, reason: "Worktrees aren't available yet. Chats run in the project folder" },
              { label: "Branch", icon: "repo", detail: branch || "current", reason: "Chats use the project folder's current branch" },
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
          <button type="button" className="cx-picker-action" disabled title="Chats need a project">
            <span aria-hidden="true">✕</span>Don't work in a project</button>
        </FloatingLayer> : null}
        {/* Queued messages always come first, above every other bar (a command's card, the goal, a
            loop or wake-up, notes, the subagents' line) and the branch picker, as Claude Code keeps its
            queued bar on top: under the goal bar it read as part of the goal (the user's ask). */}
        <QueuedMessageBar items={queuedBar}
          onMenu={(owner, items) => toggleMenu(owner, (box) => ({ x: box.right - 180, y: box.bottom + 4, label: "Queued message actions", items }))}
          // Queued commands and goals show in the bar too now, so Clear all clears all of them.
          onClearAll={() => dequeue(selectedTaskId, null)} />
        {goalEditing !== null && commands?.goal ? (() => {
          // The goal bar opened for editing: its target and "Edit goal", the objective in a box that
          // grows with it, then how long it may be, Cancel and Save. Ctrl+Enter saves, Esc cancels.
          const next = goalEditing.trim();
          const changed = Boolean(next) && next !== commands.goal.objective;
          const save = () => {
            if (changed) void commands.goalEdit(next).then(() => setGoalEditing(null), (cause) => say("Edit goal", cause instanceof Error ? cause.message : String(cause)));
          };
          return <section className="cx-goal-edit" aria-label="Edit goal">
            <header><GoalGlyph name="target" /><strong>Edit goal</strong>
              <button type="button" className="cx-goal-icon" aria-label="Cancel" title="Cancel (Esc)" onClick={() => setGoalEditing(null)}><Icon name="close" width="12" height="12" /></button></header>
            <textarea aria-label="Goal" autoFocus rows={2} maxLength={2000} value={goalEditing} placeholder="What should be true when it's done? Name an outcome you can check."
              onChange={(event) => setGoalEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
                else if (event.key === "Escape") { event.preventDefault(); setGoalEditing(null); }
              }} />
            <footer><span className="cx-goal-edit-hint">{goalEditing.length > 1600 ? `${goalEditing.length} / 2000` : "Ctrl+Enter to save"}</span>
              <button type="button" className="cx-goal-edit-cancel" onClick={() => setGoalEditing(null)}>Cancel</button>
              <button type="button" className="cx-goal-edit-save" disabled={!changed} onClick={save}>Save</button></footer>
          </section>;
        })() : null}
        {wakeupEditing !== null && commands?.wakeup && commands.editWakeup ? (() => {
          const minutes = Number(wakeupEditing.minutes);
          const valid = wakeupEditing.reason.trim() !== "" && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 720;
          return <section className="cx-command-card cx-goal-editor cx-wakeup-editor" aria-label="Edit wake-up">
            <header><strong>Edit wake-up</strong>
              <button type="button" className="cx-icon-button" aria-label="Cancel" onClick={() => setWakeupEditing(null)}><Icon name="close" width="12" height="12" /></button></header>
            <textarea aria-label="What to check when it wakes" rows={3} maxLength={500} value={wakeupEditing.reason} placeholder="What the agent should check when it wakes"
              onChange={(event) => setWakeupEditing({ ...wakeupEditing, reason: event.target.value })} />
            <label className="cx-wakeup-minutes">Wake in
              <input type="number" min={1} max={720} step={1} inputMode="numeric" aria-label="Minutes from now" value={wakeupEditing.minutes}
                onChange={(event) => setWakeupEditing({ ...wakeupEditing, minutes: event.target.value })} /> min</label>
            <footer><button type="button" className="cx-text-button" onClick={() => setWakeupEditing(null)}>Cancel</button>
              <button type="button" className="cx-primary-button" disabled={!valid}
                onClick={() => void commands.editWakeup?.({ reason: wakeupEditing.reason.trim(), minutes })
                  .then(() => setWakeupEditing(null), (cause) => say("Edit wake-up", cause instanceof Error ? cause.message : String(cause)))}>Save</button></footer>
          </section>;
        })() : null}
        {commands?.goal || commands?.planMode || commands?.wakeup || commands?.loop ? <div className="cx-composer-modes">
          {commands?.loop ? <LoopBar loop={commands.loop} onStop={() => void runCommand("loop", "stop", false)} /> : null}
          {commands?.wakeup ? <WakeupBar wakeup={commands.wakeup}
            onEdit={commands.editWakeup ? () => { setCard(null); setWakeupEditing({ reason: commands.wakeup!.reason,
              minutes: String(Math.min(720, Math.max(1, Math.ceil((commands.wakeup!.dueAt - Date.now()) / 60_000)))) }); } : undefined}
            onDelete={() => { setWakeupEditing(null); void commands.cancelWakeup?.().catch((cause) => say("Delete wake-up", cause instanceof Error ? cause.message : String(cause))); }} /> : null}
          {/* Codex's goal bar: state, objective, how long it has run, then Clear / Resume or Pause / Edit. */}
          {commands?.goal ? <div className={`cx-goal is-${commands.goal.status}`} role="status">
            <GoalGlyph name="target" />
            <span className="cx-goal-state" title={commands.goal.note || `Round ${goalRounds(commands.goal)}`}>{GOAL_SUMMARY[commands.goal.status]}</span>
            <span className="cx-goal-objective" title={commands.goal.objective}>{commands.goal.objective}</span>
            <span className="cx-goal-meta" title={`Round ${goalRounds(commands.goal)}`}>
              {/* Which round it is on, then how long it has run, to the second as Codex shows it. */}
              <span className="cx-goal-round">Round {goalRounds(commands.goal)} · </span>
              <Elapsed since={commands.goal.startedAt} live={commands.goal.status === "active"} until={commands.goal.updatedAt}
                format={(ms) => goalElapsed(0, ms)} /></span>
            <ModelJudgesToggle compact />
            <button type="button" className="cx-goal-icon" title="Clear goal" aria-label="Clear goal" disabled={goalBusy} onClick={() => void runCommand("goal", "clear", false)}><GoalGlyph name="trash" /></button>
            {commands.goal.status === "active"
              ? <button type="button" className="cx-goal-icon" title="Pause goal" aria-label="Pause goal" disabled={goalBusy} onClick={() => void runCommand("goal", "pause", false)}><GoalGlyph name="pause" /></button>
              : commands.goal.status !== "achieved" ? <button type="button" className="cx-goal-icon" title="Resume goal" aria-label="Resume goal" disabled={goalBusy} onClick={() => void runCommand("goal", "resume", false)}><GoalGlyph name="play" /></button> : null}
            <button type="button" className="cx-goal-icon" title="Edit goal" aria-label="Edit goal" onClick={() => void runCommand("goal", "edit", false)}><GoalGlyph name="expand" /></button>
          </div> : null}
          {/* What the last check said (or why the goal waits), in its own box that always sits under the
              goal bar: in the bar it was cut to a few words beside the objective. */}
          {commands?.goal && goalDetail(commands.goal) ? <div className="cx-goal-verdict" role="note" title={goalDetail(commands.goal)}><span>{goalDetail(commands.goal)}</span></div> : null}
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
            return <p className="cx-route-note" role="status">This turn runs on <b>{routeModelName({ model: running })}</b>. Your next message uses <b>{routeModelName({ model: picked })}</b>.</p>;
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
        {/* Codex's "… started working" line for a thread's subagents: who works now, a click from their work. */}
        {selectedTaskId && subagentLine ? <button type="button" className="cx-subagent-strip" role="status" title="Show the subagents and what they are doing"
          onClick={() => setWorkbench("subagents")}>
          <span className="cx-subagent-dots" aria-hidden="true">{subagents.filter(subagentActive).slice(0, 3).map((run) => <i key={run.subagent_id} />)}</span>
          <span className="cx-shimmer">{subagentLine}</span>
        </button> : null}
        {selectedTaskId ? <ChatBranchBar workspaceId={projectId} sessionId={agentSessions[0]?.id} /> : null}
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
          {typing && !slash.length ? <p className="cx-slash-usage" role="status">/{typing.name} {typing.args} — {typing.hint}. Press Enter to run.</p> : null}
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
                title={item.path ? `${item.path}${revealFile ? "\nClick to show in folder" : ""}` : `${item.name} · sent inline`}
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
            placeholder={steering ? "" : awaitingAnswer && queueing ? "Answer the request above. New messages send after it"
              : queueing ? "Running. New messages send when it finishes" : !accepts ? "Running. Send a follow-up when it finishes" : selectedTaskId ? "Send a follow-up…" : "Do anything"}
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
              canCompact={Boolean(commands && accepts)} onCompact={() => void runCommand("compact", "", false)} onFraction={setContextShare} /> : null}
            <button type="button" className="cx-icon-button cx-mic" aria-label="Voice input" title="Voice input isn't available yet" disabled>
              <ChatGlyph name="mic" size={16} /></button>
            {/* A run waiting out an automatic retry (or an answer) takes a message, yet it is still open: with
                nothing typed, Stop shows instead of a disabled Send. It showed only while a card ran, so a step
                retrying for half an hour had no Stop between its attempts (2026-10-29). */}
            {latest && runOpen && stop && (accepts ? !canSend && !sending : !((steering || queueing) && canSend))
              ? <button className="cx-send is-stop" type="button" aria-label="Stop (Esc)" title="Stop (Esc)" onClick={() => stop(latest.id)}><span aria-hidden="true" /></button>
              : <button className="cx-send" type="submit" aria-label={sending ? "Starting…" : steering ? "Steer the agent" : queueing ? "Queue message" : "Send message"}
                title={steering ? "Steer now (Enter)" : queueing ? "Queue for after this turn (Enter)" : "Send (Enter)"} disabled={!canSend}>
                  <Icon name="forward" width="18" height="18" /></button>}
          </div>
        </form>
        {selectedTaskId ? <ChatTurnStats model={agentSessions[0]?.model} rounds={turns.filter((turn) => turn.runId).length}
          from={statsSpan.from} models={statsSpan.models} running={runOpen} onRefusal={setCpaRefusal} /> : null}
        {/* A command's card (its choices) and the delete confirmation sit below the chat box, as wide
            as it. Above the box they pushed it up the pane and away from where the person types. */}
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
          <p>Delete this message and its reply? Files on disk don't change.</p>
          {deleteBlocked ? <p className="cx-delete-reason">{deleteBlocked}.</p> : null}
          <footer><button type="button" className="cx-text-button" onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="cx-primary-button" disabled={Boolean(deleteBlocked) || deletingBusy} onClick={() => void confirmDelete()}>Delete</button></footer>
        </section> : null}
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
      {workbench && selectedTaskId ? <ChatWorkbench sessions={agentSessions} workspaceId={projectId} tab={workbench} onTab={setWorkbench} onClose={() => setWorkbench(null)}
        subagents={subagents} renderWork={renderSubagentWork} /> : null}
      <ChatMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  </TurnRestart.Provider></CompactActivity.Provider></SentMessageView.Provider></Attachments.Provider>);
}

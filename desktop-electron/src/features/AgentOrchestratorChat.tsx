import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { AgentOrchestratorComposerControls, type ComposerControlsProps } from "./AgentOrchestratorComposerControls";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AgentOrchestratorApproval, type AoApproval as ChatApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatGlyph, ChatMenu, FloatingLayer, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
import {
  CHAT_DEFAULT_TITLE, chatAcceptsMessage, chatDuration, chatList, chatMessageWithAttachments, chatRunOpen, chatSlashCommand,
  chatSlashMatches, chatTurns,
  type ChatActivity, type ChatAttachment, type ChatLiveItem, type ChatNode, type ChatRun, type ChatStatus, type ChatStep, type ChatTurn,
} from "./ao-chat";

export { ChatThreadList as ChatListPane } from "./ChatThreadList";

const STATUS_LABEL: Record<ChatStatus, string> = {
  queued: "Starting", scheduled: "Scheduled", running: "Running", paused: "Paused", attention: "Needs you", stopped: "Stopped", done: "Done",
};
/** Text files up to this size are attached inline when their path is unknown. */
const INLINE_ATTACHMENT_BYTES = 200 * 1024;
/** The cards panel's dragged width (px), kept on this computer. */
const CARDS_WIDTH_KEY = "coding-tools:ao:cards-panel-width";

/** Thread actions the chat header, its ⋯ menu and its slash commands share with the thread list. */
export type ChatThreadActions = {
  newChat: () => void;
  rename: (title: string) => Promise<void>;
  archive: () => void;
  fork: (turnIndex?: number) => void;
  copyConversation: () => void;
  togglePin: () => void;
  pinned: boolean;
};

function stepTone(step: ChatStep): string {
  if (step.error) return "error";
  if (step.working) return step.working.stalled ? "stalled" : "working";
  return step.state;
}

/** A working role's turn so far, as Codex shows it: thinking, tool calls and streamed messages. */
function LiveTimeline({ items }: { items: ChatLiveItem[] }) {
  return <ol className="cx-live">
    {items.map((item) => <li key={item.id} className={`cx-live-item kind-${item.kind} is-${item.status || "done"}`}>
      {item.kind === "message" ? <ChatMarkdown text={item.text} />
        : item.kind === "reasoning" ? <span className="cx-live-label">{item.status === "running" ? "Thinking…" : "Thought"}</span>
        : item.kind === "command" ? <><span className="cx-live-label">{item.status === "running" ? "Running" : "Ran"}</span><code>{item.text}</code></>
        : <><span className="cx-live-label">{item.kind.replace(/_/g, " ")}</span><span className="cx-live-text">{item.text}</span></>}
    </li>)}
  </ol>;
}

function StepRow({ step, now }: { step: ChatStep; now: number }) {
  // A failed step opens on its error and a working one on its live turn, as Codex shows them;
  // once the user toggles a row, their choice wins.
  const [chosen, setOpen] = useState<boolean | null>(null);
  const open = chosen ?? Boolean(step.error || step.working?.timeline?.length);
  const body = step.error || step.text || (step.working?.timeline?.length ? "live" : "");
  const elapsed = step.working && step.startedAtMs ? chatDuration(now - step.startedAtMs) : "";
  return <li className={`cx-step tone-${stepTone(step)}`}>
    <button type="button" className="cx-step-head" aria-expanded={open} disabled={!body && !step.working} onClick={() => setOpen(!open)}>
      <span className="cx-step-dot" aria-hidden="true" />
      <span className="cx-step-name">{step.name}</span>
      <span className="cx-step-meta">
        {step.working ? (step.working.stalled ? "may be stuck" : step.working.activity || "working") : step.error ? "failed" : step.verdict || (step.state === "finished" ? "done" : step.state)}
        {elapsed ? ` · ${elapsed}` : ""}
      </span>
      {body ? <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} /> : null}
    </button>
    {open ? <div className="cx-step-body">
      {step.detail ? <p className="cx-step-detail">{step.detail}</p> : null}
      {step.working ? <p className="cx-step-detail">{step.working.detail}</p> : null}
      {step.working?.timeline?.length ? <LiveTimeline items={step.working.timeline} /> : null}
      {step.error ? <p className="cx-step-error">{step.error}</p> : step.text ? <ChatMarkdown text={step.text} /> : null}
    </div> : null}
  </li>;
}

function WorkGroup({ turn, now, idle = false }: { turn: ChatTurn; now: number; idle?: boolean }) {
  const working = turn.steps.find((step) => step.working);
  // Live and failed work opens by itself until the user toggles it; after that their choice holds.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (Boolean(working) || turn.steps.some((step) => step.error));
  if (!turn.steps.length) {
    return !idle && (turn.status === "running" || turn.status === "queued")
      ? <div className="cx-work is-live"><span className="cx-shimmer">Starting…</span></div> : null;
  }
  const label = working
    ? `${working.working!.stalled ? "May be stuck" : "Working"}${turn.startedAtMs ? ` for ${chatDuration(now - turn.startedAtMs)}` : ""} · ${working.name}${working.working!.activity ? ` — ${working.working!.activity}` : ""}`
    : `Worked · ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}`;
  return <div className={`cx-work${working ? " is-live" : ""}${working?.working?.stalled ? " is-stalled" : ""}`}>
    <button type="button" className="cx-work-head" aria-expanded={open} onClick={() => setChosen(!open)}>
      <span className={working ? "cx-shimmer" : undefined}>{label}</span>
      <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} />
    </button>
    {open ? <ol className="cx-steps">{turn.steps.map((step) => <StepRow key={step.key} step={step} now={now} />)}</ol> : null}
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

export function AgentOrchestratorChat({
  runs, tasks, selectedTaskId, busy, loadDescription, send, openStructure,
  approvals, approve, describeRoute: _describeRoute, notice, retryStart, working = false, describeNode, activity, permissions, composer, onOpenTeam, onOpenMissionBoard,
  projectName, stop, restart, thread, structure, onPause, onResume, onSettings, filePath, seed, onSeedUsed, headerExtra, onOpenProject, projects, projectId, onPickProject, onAddProject, projectBranch: branch,
  pendingMessage, pendingTitle, pendingCreation = false,
}: {
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
  send: (input: { taskId?: string; title?: string; message: string }) => Promise<void>;
  openStructure: (runId: string) => void;
  approvals: ChatApproval[];
  approve: (approval: ChatApproval, reply: ApprovalReply) => void;
  permissions?: ReactNode;
  composer?: Omit<ComposerControlsProps, "permissions" | "busy">;
  onOpenTeam?: () => void;
  onOpenMissionBoard?: () => void;
  describeRoute: (nodeId: string, runId: string) => string;
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
  seed?: { key: string; title: string; text: string };
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

  // Runtimes count up while a card works.
  const [now, setNow] = useState(() => Date.now());
  const anyWorking = chatRuns.some((run) => run.nodes.some((node) => node.state === "running" || node.state === "reserved"));
  useEffect(() => {
    if (!anyWorking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [anyWorking]);
  const turns: ChatTurn[] = useMemo(
    () => chatTurns(chatRuns, descriptions[selectedTaskId] ?? pendingMessage, { describe: describeNode, activity, now }),
    [chatRuns, descriptions, selectedTaskId, describeNode, activity, now, pendingMessage],
  );
  const stepCount = turns.reduce((total, turn) => total + turn.steps.length + (turn.final ? 1 : 0), 0);
  useEffect(() => { if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [turns.length, stepCount, atBottom]);
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
  // Continue in project: the new chat opens with the carried messages, ready to review and send.
  useEffect(() => {
    if (!seed || selectedTaskId) return;
    setDraft(seed.text); setTitle(seed.title);
    onSeedUsed?.();
    window.setTimeout(() => input.current?.focus(), 0);
  }, [seed?.key]);
  // The composer grows with its text, like Codex, up to a cap.
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
  }, [draft]);

  const runOpen = Boolean(latest) && chatRunOpen(chat?.status);
  const accepts = chatAcceptsMessage(chat?.status, working);
  const canSend = !busy && !sending && Boolean(draft.trim() || attachments.length) && accepts;
  const slash = chatSlashMatches(draft, { chat: Boolean(selectedTaskId), run: Boolean(latest), open: runOpen });

  const submit = async () => {
    if (!canSend) return;
    const message = chatMessageWithAttachments(draft, attachments);
    setSending(true);
    try {
      await send(selectedTaskId ? { taskId: selectedTaskId, message } : { title: title.trim() || undefined, message });
      setDraft(""); setTitle(""); setAttachments([]); setAttachNote(""); setAtBottom(true);
    } catch {
      // The surface already shows the error; keep the message so it can be sent again.
    } finally { setSending(false); }
  };

  const runCommand = (name: string) => {
    setDraft(""); setSlashIndex(0);
    switch (name) {
      case "new": thread?.newChat(); break;
      case "stop": if (latest && runOpen) stop?.(latest.id); break;
      case "retry": if (latest) restart?.(latest.id); break;
      case "model": document.querySelector<HTMLButtonElement>(".cx-composer .ao-composer-chip")?.click(); break;
      case "structure": setShowStructure((value) => !value); break;
      case "board": onOpenMissionBoard?.(); break;
      case "rename": if (chat) setRenaming(chat.title); break;
      case "fork": thread?.fork(); break;
      case "archive": thread?.archive(); break;
      case "copy": thread?.copyConversation(); break;
    }
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

  return (
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
          {structure || latest ? <button type="button" className="cx-icon-button" aria-pressed={showStructure} title="Show cards (Structure)" aria-label="Show cards"
            disabled={!latest} onClick={() => structure ? setShowStructure((value) => !value) : latest && openStructure(latest.id)}>
            <Icon name="orchestrator" width="16" height="16" /></button> : null}
          {onOpenMissionBoard ? <button type="button" className="cx-icon-button" title="Mission Board" aria-label="Open Mission Board" onClick={onOpenMissionBoard}>
            <Icon name="logs" width="16" height="16" /></button> : null}
          <button type="button" className="cx-icon-button" title="More" aria-label="More chat actions" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.right - 240, y: box.bottom + 4, items: headerMenu(), label: "Chat actions" }))}>⋯</button>
        </header>

        <div className="cx-scroll" ref={scroller}
          onScroll={(event) => { const box = event.currentTarget; setAtBottom(box.scrollHeight - box.scrollTop - box.clientHeight < 48); }}>
          <div className="cx-column">
            {!turns.length ? <div className="cx-empty">
              {selectedTaskId ? <p>Loading…</p> : <>
                <span className="cx-empty-glyph" aria-hidden="true"><ChatGlyph name="codex" size={40} /></span>
                <h1>What should we build{projectName ? <> in {onOpenProject
                  ? <button type="button" className="cx-empty-project" title="Open the project folder" onClick={onOpenProject}>{projectName}</button>
                  : <span className="cx-empty-project">{projectName}</span>}</> : null}?</h1>
              </>}
            </div> : null}
            {turns.map((turn, turnIndex) => <article key={turn.key} className="cx-turn">
              {turn.user ? <div className="cx-user">
                <div className="cx-bubble"><p>{turn.user.text}</p></div>
                <MessageActions text={turn.user.text}>
                  {thread ? <button type="button" title="Fork from here" aria-label="Fork from this message" onClick={() => thread.fork(turnIndex)}>⑂</button> : null}
                </MessageActions>
                {turn.user.stamp ? <span className="cx-stamp">{turn.user.stamp} UTC</span> : null}
              </div> : null}
              <WorkGroup turn={turn} now={now} idle={notStarted && turn.runId === latest?.id} />
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
            </article>)}
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
            {approvals.map(approval => <AgentOrchestratorApproval key={approval.approval_id} approval={approval} busy={busy} approve={approve} />)}
          </div>
          {!atBottom ? <button type="button" className="cx-to-bottom" aria-label="Scroll to the latest message"
            onClick={() => { setAtBottom(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }}>↓</button> : null}
        </div>

        {!selectedTaskId ? <div className="cx-context-strip" aria-label="Where this chat runs">
          {/* Codex's context chips are menus: the project picker, where it runs, and its environment. */}
          <button type="button" className="cx-chip" title={projectName} aria-haspopup="dialog" aria-expanded={Boolean(projectPicker)}
            onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setProjectPicker(projectPicker ? null : { left: box.left, bottom: window.innerHeight - box.top + 6 }); setPickerQuery(""); }}>
            <ChatGlyph name="folder" size={13} />{projectName || "No project"}<span className="cx-chip-caret" aria-hidden="true">⌄</span></button>
          <button type="button" className="cx-chip" aria-haspopup="menu"
            onClick={(event) => toggleMenu(event.currentTarget, (box) => ({ x: box.left, y: box.top - 96, label: "Work in", items: [
              { label: "This computer", icon: "monitor", checked: true, run: () => undefined },
              { label: "Cloud", icon: "share", reason: "No cloud runner is set up; chats run on this computer" },
            ] }))}>
            <ChatGlyph name="monitor" size={13} />This computer<span className="cx-chip-caret" aria-hidden="true">⌄</span></button>
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
        <form className="cx-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } }}>
          {slash.length ? <ul className="cx-slash" role="listbox" aria-label="Commands">
            {slash.map((command, index) => <li key={command.name} role="option" aria-selected={index === slashIndex % slash.length}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand(command.name)}>
                <span>/{command.name}</span><small>{command.hint}</small></button>
            </li>)}
          </ul> : null}
          {attachments.length || attachNote ? <div className="cx-attachments">
            {attachments.map((item, index) => <span key={`${item.name}:${index}`} className="cx-attachment" title={item.path || `${item.name} (inline)`}>
              {item.image ? "🖼" : "📄"} {item.name}
              <button type="button" aria-label={`Remove ${item.name}`} onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}>×</button>
            </span>)}
            {attachNote ? <span className="cx-attach-note" role="status">{attachNote}</span> : null}
          </div> : null}
          <textarea ref={input} aria-label="Message" maxLength={8192} rows={1} value={draft}
            placeholder={!accepts ? "Running — you can send a follow-up when it finishes" : selectedTaskId ? "Send a follow-up…" : "Do anything"}
            onChange={(event) => { setDraft(event.target.value); setSlashIndex(0); }}
            onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files); } }}
            onKeyDown={(event) => {
              if (slash.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault(); setSlashIndex((value) => (value + (event.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length); return;
              }
              if (slash.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
                event.preventDefault(); runCommand(slash[slashIndex % slash.length].name); return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const command = chatSlashCommand(draft);
                if (command) runCommand(command); else void submit();
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
            <button type="button" className="cx-icon-button cx-mic" aria-label="Voice input" title="Voice input isn't available yet" disabled>
              <ChatGlyph name="mic" size={16} /></button>
            {latest && runOpen && stop && !accepts
              ? <button className="cx-send is-stop" type="button" aria-label="Stop (Esc)" title="Stop (Esc)" onClick={() => stop(latest.id)}><span aria-hidden="true" /></button>
              : <button className="cx-send" type="submit" aria-label={sending ? "Starting…" : "Send message"} title="Send (Enter)" disabled={!canSend}>
                  <Icon name="forward" width="18" height="18" /></button>}
          </div>
        </form>
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
      <ChatMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

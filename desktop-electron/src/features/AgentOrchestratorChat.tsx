import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import type { ReactNode } from "react";
import { AgentOrchestratorApproval, type AoApproval as ChatApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import {
  CHAT_DEFAULT_TITLE, chatAcceptsMessage, chatList, chatNodeName, chatNodeOrder, chatTranscript,
  type ChatActivity, type ChatMessage, type ChatNode, type ChatRun, type ChatStatus, type ChatSummary,
} from "./ao-chat";


const STATUS_LABEL: Record<ChatStatus, string> = {
  queued: "Starting", running: "Running", paused: "Paused", attention: "Needs you", stopped: "Stopped", done: "Done",
};

/** Workspaces and task-level view controls share one persistent tree. */
export type ChatWorkspaces = {
  workspaces: { id: string; name: string }[];
  workspaceId: string;
  onWorkspace: (workspaceId: string) => void;
  view?: "chat" | "overview";
  labels?: { chat: string; overview: string };
};

/**
 * Like Codex's sidebar: workspaces first, each opening to its chats. Only the current workspace
 * is expanded (its chats are the ones loaded); choosing another workspace switches to it.
 */
export function ChatListPane({ chats, selectedTaskId, onSelect, onNew, tree }: {
  chats: ChatSummary[]; selectedTaskId: string; onSelect: (taskId: string, view: "chat" | "overview") => void; onNew?: () => void;
  tree?: ChatWorkspaces;
}) {
  const chatItems = (
    <ul className="ao-chat-items">
      {onNew ? <li><button type="button" className="ao-chat-new" aria-pressed={!selectedTaskId} onClick={onNew}>＋ New chat</button></li> : null}
      {chats.map((entry) => (
        <li key={entry.taskId} className="ao-chat-row">
          <button type="button" className="ao-chat-select" title={entry.title} aria-current={entry.taskId === selectedTaskId}
            onClick={() => onSelect(entry.taskId, "chat")}>
            <span className={`ao-chat-dot status-${entry.status}`} aria-label={STATUS_LABEL[entry.status]} title={STATUS_LABEL[entry.status]} />
            <span className="ao-chat-title">{entry.title}</span>
          </button>
          <button type="button" className="ao-chat-view" aria-label={`${tree?.labels?.chat ?? "Mission"} · ${entry.title}`}
            title={`${tree?.labels?.chat ?? "Mission"} · ${entry.title}`}
            aria-pressed={entry.taskId === selectedTaskId && tree?.view === "chat"} onClick={() => onSelect(entry.taskId, "chat")}>
            <Icon name="mail" width="15" height="15" />
          </button>
          <button type="button" className="ao-chat-view" aria-label={`${tree?.labels?.overview ?? "Overview"} · ${entry.title}`}
            title={`${tree?.labels?.overview ?? "Overview"} · ${entry.title}`}
            aria-pressed={entry.taskId === selectedTaskId && tree?.view === "overview"} onClick={() => onSelect(entry.taskId, "overview")}>
            <Icon name="orchestrator" width="15" height="15" />
          </button>
        </li>
      ))}
      {!chats.length && !onNew ? <li><p className="ao-chat-empty">No chats yet</p></li> : null}
    </ul>
  );
  return (
    <aside className="ao-chat-list" aria-label={tree ? "Workspaces and chats" : "Chats"}>
      {tree ? (
        <ul className="ao-chat-tree">
          {tree.workspaces.map((workspace) => {
            const open = workspace.id === tree.workspaceId;
            return (
              <li key={workspace.id} className={open ? "is-open" : undefined}>
                <button type="button" className="ao-chat-workspace" aria-expanded={open} title={workspace.name}
                  onClick={() => { if (!open) tree.onWorkspace(workspace.id); }}>
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span><span aria-hidden="true">📁</span>
                  <span className="ao-chat-title">{workspace.name}</span>
                </button>
                {open ? chatItems : null}
              </li>
            );
          })}
        </ul>
      ) : chatItems}
    </aside>
  );
}

export function AgentOrchestratorChat({
  runs, tasks, selectedTaskId, busy, loadDescription, send, openStructure,
  approvals, approve, describeRoute, notice, retryStart, working = false, describeNode, activity, permissions,
}: {
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
  describeRoute: (nodeId: string, runId: string) => string;
  /** Why this chat's latest run could not start, if it could not. */
  notice?: string;
  retryStart: (runId: string) => void;
}) {
  const chats = useMemo(() => chatList(runs, tasks), [runs, tasks]);
  const chat = chats.find((entry) => entry.taskId === selectedTaskId);
  const chatRuns = useMemo(() => runs.filter((run) => run.project_id === selectedTaskId), [runs, selectedTaskId]);
  const latest = chatRuns[chatRuns.length - 1];
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [showStructure, setShowStructure] = useState(true);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

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
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [anyWorking]);
  const transcript: ChatMessage[] = useMemo(
    () => chatTranscript(chatRuns, descriptions[selectedTaskId], { describe: describeNode, activity, now }),
    [chatRuns, descriptions, selectedTaskId, describeNode, activity, now],
  );
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [transcript.length]);

  const accepts = chatAcceptsMessage(chat?.status, working);
  const canSend = !busy && !sending && Boolean(draft.trim()) && accepts;
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await send(selectedTaskId ? { taskId: selectedTaskId, message: draft.trim() } : { title: title.trim() || undefined, message: draft.trim() });
      setDraft(""); setTitle("");
    } catch {
      // The surface already shows the error; keep the message so it can be sent again.
    } finally { setSending(false); }
  };

  return (
    <div className={`ao-chat${showStructure && latest ? " with-structure" : ""}`}>
      <section className="ao-chat-main" aria-label={chat?.title || CHAT_DEFAULT_TITLE}>
        <header className="ao-chat-head">
          {selectedTaskId
            ? <h2>{chat?.title || CHAT_DEFAULT_TITLE}</h2>
            : <input aria-label="Task name" className="ao-chat-name" maxLength={240} placeholder={CHAT_DEFAULT_TITLE}
                value={title} onChange={(event) => setTitle(event.target.value)} />}
          {chat ? <span className={`ao-pill status-${chat.status}`}><span className="ao-pill-dot" aria-hidden="true" />{STATUS_LABEL[chat.status]}</span> : null}
          <span className="ao-head-spacer" />
          {latest ? <button type="button" className="button-secondary" aria-pressed={showStructure}
            onClick={() => setShowStructure((value) => !value)}>Team summary</button> : null}
        </header>

        <div className="ao-chat-scroll" ref={scroller}>
          {!transcript.length ? <p className="ao-chat-empty">
            {selectedTaskId ? "Loading…" : "Describe the task. Sending starts the orchestrator, workers and reviewer."}
          </p> : null}
          {transcript.map((message) => message.kind === "user"
            ? <div key={message.key} className="ao-msg ao-msg-user">
                {message.stamp ? <span className="ao-msg-meta">{message.stamp} UTC</span> : null}
                <p>{message.text}</p>
              </div>
            : message.kind === "agent"
              ? <div key={message.key} className={`ao-msg ao-msg-agent tone-${message.tone}`}>
                  <span className="ao-msg-meta">{message.name}{message.verdict ? ` · ${message.verdict}` : ""}</span>
                  {message.detail ? <span className="ao-msg-detail">{message.detail}</span> : null}
                  <p>{message.text}</p>
                </div>
              : <div key={message.key} className={`ao-msg ao-msg-status state-${message.state}${message.stalled ? " is-stalled" : ""}`}>
                  {message.text}
                  {message.detail ? <span className="ao-msg-detail">{message.detail}</span> : null}
                </div>)}
          {notice && latest && chat?.status === "queued" ? (
            <div className="ao-msg ao-msg-approval tone-error">
              <span className="ao-msg-meta">The run could not start</span>
              <p>{notice}</p>
              <div className="ao-msg-actions">
                <button className="button-primary" type="button" disabled={busy} onClick={() => retryStart(latest.id)}>Retry</button>
              </div>
            </div>
          ) : null}
          {latest && chat?.status === "attention" ? (
            <div className="ao-msg ao-msg-approval tone-error">
              <span className="ao-msg-meta">A step failed</span>
              <p>{notice || "The recovery helper retries failed steps up to three times. Retry now, or send a follow-up once you stop this chat."}</p>
              <div className="ao-msg-actions">
                <button className="button-primary" type="button" disabled={busy} onClick={() => retryStart(latest.id)}>Retry failed step</button>
              </div>
            </div>
          ) : null}
          {approvals.map(approval => <AgentOrchestratorApproval key={approval.approval_id} approval={approval} busy={busy} approve={approve} />)}
        </div>

        {permissions}
        <form className="ao-chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <textarea aria-label="Message" maxLength={8192} rows={3} value={draft}
            placeholder={!accepts ? "Running — you can send a follow-up when it finishes" : selectedTaskId ? "Send a follow-up…" : "What should the team do?"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
          <button className="button-primary" type="submit" disabled={!canSend}>{sending ? "Starting…" : "Send"}</button>
        </form>
      </section>

      {showStructure && latest ? (
        <aside className="ao-chat-structure" aria-label="Structure">
          <h3>Structure</h3>
          <ol>
            {chatNodeOrder(latest.nodes).map((node) => (
              <li key={node.id} className={`state-${node.state}`}>
                <span className={`ao-chat-dot state-${node.state}`} aria-hidden="true" />
                <span className="ao-chat-node-name">{chatNodeName(node)}</span>
                <span className="ao-chat-node-meta" title={describeRoute(node.id, latest.id)}>{node.state}</span>
              </li>
            ))}
          </ol>
          <p className="ao-chat-node-meta">
            {latest.nodes.filter((node) => node.role === "worker" && node.state === "finished").length}
            /{latest.nodes.filter((node) => node.role === "worker").length} workers done
          </p>
          <button type="button" className="button-secondary" onClick={() => openStructure(latest.id)}>Open overview</button>
        </aside>
      ) : null}
    </div>
  );
}

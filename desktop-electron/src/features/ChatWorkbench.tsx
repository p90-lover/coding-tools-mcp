import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
import { Icon } from "../icons";
import type { ChatAgentSession } from "./ao-chat";

// The chat's Preview and Terminal panes, as Codex shows them beside a thread: the page the chat's
// agent opened in its own browser (a native view drawn over the pane's slot), and the commands it
// started through the app's terminal with their live output. Both act for the user: navigating,
// stopping a command or typing into it needs no approval, since the user does it here.

export type WorkbenchTab = "preview" | "terminal";

type PreviewState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; errors: number };
type Command = { id: string; cmd: string; workdir: string; startedAt: number; status: string; exitCode: number | null };

const PREVIEW_POLL_MS = 1500;
const COMMANDS_POLL_MS = 2000;
const OUTPUT_POLL_MS = 1000;
const MAX_OUTPUT_CHARS = 200_000;
// Terminal colours and cursor movement, OSC titles and links: the pane shows plain text.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

async function paneCall(operation: string, args: JsonObject = {}) {
  const outer = await getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation, arguments: args });
  const result = (outer.result && typeof outer.result === "object" ? outer.result : {}) as Record<string, unknown>;
  if (outer.ok === false || result.ok === false) throw new Error(String(result.error || result.reason || "That did not work"));
  return result;
}

const plain = (text: string) => text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");

function since(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

export function ChatWorkbench({ sessions, tab, onTab, onClose }: {
  sessions: ChatAgentSession[];
  tab: WorkbenchTab;
  onTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  useEffect(() => {
    if (!sessions.some((session) => session.id === sessionId)) setSessionId(sessions[0]?.id ?? "");
  }, [sessions, sessionId]);
  return <aside className="cx-structure cx-workbench" aria-label="Preview and terminal">
    <header>
      <div className="cx-workbench-tabs" role="tablist" aria-label="Pane">
        <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => onTab("preview")}>Preview</button>
        <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => onTab("terminal")}>Terminal</button>
      </div>
      {sessions.length > 1 ? <select className="cx-workbench-agent" aria-label="Agent" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
      </select> : <span className="cx-head-spacer" />}
      <button type="button" className="cx-icon-button" aria-label="Hide preview and terminal" onClick={onClose}>
        <Icon name="close" width="14" height="14" /></button>
    </header>
    {!sessionId
      ? <p className="cx-workbench-empty">No agent has started in this chat yet. The pages it opens and the commands it runs show here.</p>
      : tab === "preview" ? <PreviewPane key={sessionId} sessionId={sessionId} /> : <TerminalPane key={sessionId} sessionId={sessionId} />}
  </aside>;
}

function PreviewPane({ sessionId }: { sessionId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PreviewState | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const tick = () => void paneCall("chat_preview_state", { sessionIds: [sessionId] })
      .then((result) => { if (live) setState((result.previews as Record<string, PreviewState> | undefined)?.[sessionId] ?? null); })
      .catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, PREVIEW_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);
  useEffect(() => { if (!editing) setAddress(state?.url && state.url !== "about:blank" ? state.url : ""); }, [state?.url, editing]);

  // The page is a native view: keep it on the slot while the pane shows, and take it off after.
  const hasPage = Boolean(state);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element || !hasPage) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        void paneCall("chat_preview_show", { sessionId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).catch(() => undefined);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      void paneCall("chat_preview_hide").catch(() => undefined);
    };
  }, [sessionId, hasPage]);

  const navigate = (request: JsonObject) => {
    setError("");
    void paneCall("chat_preview_navigate", { sessionId, ...request }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const open = () => {
    const raw = address.trim();
    if (!raw) return;
    setEditing(false);
    navigate({ url: /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}` });
  };

  return <div className="cx-preview">
    <form className="cx-preview-bar" onSubmit={(event) => { event.preventDefault(); open(); }}>
      <button type="button" className="cx-icon-button" aria-label="Back" disabled={!state?.canGoBack} onClick={() => navigate({ action: "back" })}>
        <Icon name="back" width="14" height="14" /></button>
      <button type="button" className="cx-icon-button" aria-label="Forward" disabled={!state?.canGoForward} onClick={() => navigate({ action: "forward" })}>
        <Icon name="forward" width="14" height="14" /></button>
      <button type="button" className="cx-icon-button" aria-label="Reload" disabled={!state} onClick={() => navigate({ action: "reload" })}>
        <Icon name="reload" width="14" height="14" /></button>
      <input aria-label="Address" placeholder="http://localhost:5173" value={address} spellCheck={false}
        onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(event) => setAddress(event.target.value)} />
      {state?.errors ? <span className="cx-preview-errors" title="Console errors and failed requests the agent can read with preview_console">{state.errors} errors</span> : null}
    </form>
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    {state ? <div ref={slot} className="cx-preview-slot" aria-label={state.title || state.url} />
      : <p className="cx-workbench-empty">The agent has not opened a page yet. When it starts a dev server it can open it here with preview_open, or enter a localhost address above.</p>}
  </div>;
}

function TerminalPane({ sessionId }: { sessionId: string }) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [selected, setSelected] = useState("");
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const offsets = useRef({ stdout: 0, stderr: 0 });
  const screen = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let live = true;
    const tick = () => void paneCall("chat_processes", { sessionIds: [sessionId] })
      .then((result) => {
        if (!live) return;
        const found = ((result.sessions as { commands: Command[] }[] | undefined)?.[0]?.commands) ?? [];
        setCommands(found);
        setNow(Date.now());
        setSelected((current) => (found.some((command) => command.id === current) ? current
          : (found.find((command) => command.status === "running") ?? found[0])?.id ?? ""));
      })
      .catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, COMMANDS_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);

  const command = commands.find((item) => item.id === selected);
  const running = command?.status === "running";
  useEffect(() => {
    offsets.current = { stdout: 0, stderr: 0 };
    setOutput("");
    pinned.current = true;
    if (!selected) return undefined;
    let live = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        let added = "";
        for (const stream of ["stdout", "stderr"] as const) {
          const result = await paneCall("chat_process_output", { sessionId, commandId: selected, stream, offset: offsets.current[stream] });
          offsets.current[stream] = Number(result.nextOffset) || offsets.current[stream];
          if (result.gap === true) added += "\n[earlier output was dropped]\n";
          if (typeof result.content === "string" && result.content) added += plain(result.content);
        }
        if (live && added) setOutput((current) => (current + added).slice(-MAX_OUTPUT_CHARS));
      } catch { /* the next tick tries again */ } finally { busy = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), OUTPUT_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId, selected]);
  useLayoutEffect(() => {
    if (pinned.current && screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [output]);

  const stop = () => {
    setError("");
    void paneCall("chat_process_stop", { sessionId, commandId: selected }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const send = () => {
    if (!input) return;
    setError("");
    const text = `${input}\n`;
    setInput("");
    void paneCall("chat_process_input", { sessionId, commandId: selected, text }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  if (!commands.length) {
    return <p className="cx-workbench-empty">No commands yet. Dev servers and other commands the agent starts through the app's terminal show here, with their output. (Settings → "Let chat agents run commands through the app's terminal".)</p>;
  }
  return <div className="cx-terminal">
    <ul className="cx-terminal-list" aria-label="Commands">
      {commands.map((item) => <li key={item.id}>
        <button type="button" aria-pressed={item.id === selected} title={item.cmd} onClick={() => setSelected(item.id)}>
          <span className={`cx-terminal-dot is-${item.status === "running" ? "running" : item.exitCode === 0 ? "ok" : "failed"}`} aria-hidden="true" />
          <code>{item.cmd}</code>
          <small>{item.status === "running" ? since(item.startedAt, now) : item.exitCode !== null ? `exit ${item.exitCode}` : item.status}</small>
        </button>
      </li>)}
    </ul>
    {command ? <div className="cx-terminal-head">
      <code title={`${command.workdir}`}>{command.cmd}</code>
      {running ? <button type="button" className="cx-terminal-stop" onClick={stop}>Stop</button> : null}
    </div> : null}
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    <pre ref={screen} className="cx-terminal-output" aria-live="off"
      onScroll={(event) => { const box = event.currentTarget; pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>
      {output || (running ? "Waiting for output…" : "No output.")}
    </pre>
    {running ? <form className="cx-terminal-input" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <input aria-label="Type into the command" placeholder="Type into the command, Enter sends" value={input} spellCheck={false}
        onChange={(event) => setInput(event.target.value)} />
    </form> : null}
  </div>;
}

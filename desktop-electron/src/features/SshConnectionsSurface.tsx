import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
import { Icon } from "../icons";
import { AgentOrchestratorOriginalSurface } from "./AgentOrchestratorOriginalSurface";
import "./ssh-connections.css";

// Connections > SSH hosts (the sidebar tab): the servers the person approves for SSH, kept by the
// app module "ssh-connections" (electron/ssh-connections.cjs). Chat agents may run ssh only to a
// host approved here, and each of their commands is still reviewed. A host is approved by
// confirming its key: the app fetches the key the server shows, and the person compares its
// fingerprint with one they got another way. The app cannot tell a genuine key from an
// interceptor's, so nothing here approves a key by itself, no choice skips the comparison, and a
// host whose key changed stays blocked until the person compares the new one.
// Every value shown comes from the main process and is drawn as text only.
// An approved host opens in the in-app terminal (milestone 2): AO runs ssh against the pinned key
// and shows it in its remote mode, in place of the list, one terminal at a time. Its handle lives
// in this page's memory only.

export type SshKey = { type: string; fingerprint: string; pinnedAt: string | number | null; method: "pasted" | "compared" };
export type SshCandidate = { type: string; fingerprint: string; fetchedAt: string | number | null };
/** "draft": no confirmed key. "pinned": approved. "changed": the server showed another key, so the host is blocked. */
export type SshHostState = "draft" | "pinned" | "changed";
export type SshHost = {
  id: string; label: string; host: string; port: number; user: string; identityFile: string | null;
  production: boolean; state: SshHostState; key: SshKey | null; candidate: SshCandidate | null;
};
export type SshClient = { path: string; version: string };
type SshOperation = "list" | "add" | "update" | "remove" | "fetch_key" | "confirm_key" | "terminal_open" | "terminal_close";
type AddDraft = { label: string; host: string; port: string; user: string; identityFile: string };
/** The open terminal: AO's handle for it, and the host it belongs to as the panel names it. */
export type SshTerminal = { handle: string; generation: string; title: string; hostId: string; label: string; address: string; production: boolean };

const DIALOG_TITLE_ID = "ssh-dialog-title";
const DIALOG_ABOUT_ID = "ssh-dialog-about";
const EMPTY_DRAFT: AddDraft = { label: "", host: "", port: "22", user: "", identityFile: "" };

/** A failure in the module's own words, without the wrapper the app puts around a refused call. */
export function reasonOf(cause: unknown): string {
  const message = cause && typeof cause === "object" ? (cause as { message?: unknown }).message : undefined;
  const text = (typeof message === "string" ? message : String(cause))
    .replace(/^IPC_TRANSPORT_FAILED: apps\.call failed:?\s*/, "")
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    .trim();
  return text || "That didn't go through. Try again.";
}

/** One call to the module. `list` only reads; every other operation runs from the focused app window. */
async function call(operation: SshOperation, args?: JsonObject): Promise<Record<string, unknown>> {
  const outer = await getCodingToolsClient().apps.call({ moduleId: "ssh-connections", operation, ...(args ? { arguments: args } : {}) });
  const value = outer.result as unknown;
  const result = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (outer.ok === false || result.ok === false) {
    throw Object.assign(new Error(typeof result.error === "string" && result.error ? result.error : "That didn't go through. Try again."),
      { code: typeof result.code === "string" ? result.code : "" });
  }
  return result;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const when = (value: unknown): string | number | null => (typeof value === "string" || typeof value === "number" ? value : null);

function keyOf(value: unknown): SshKey | null {
  const raw = record(value);
  if (!raw || typeof raw.type !== "string" || typeof raw.fingerprint !== "string" || !raw.fingerprint) return null;
  return { type: raw.type, fingerprint: raw.fingerprint, pinnedAt: when(raw.pinnedAt), method: raw.method === "pasted" ? "pasted" : "compared" };
}
function candidateOf(value: unknown): SshCandidate | null {
  const raw = record(value);
  if (!raw || typeof raw.type !== "string" || typeof raw.fingerprint !== "string" || !raw.fingerprint) return null;
  return { type: raw.type, fingerprint: raw.fingerprint, fetchedAt: when(raw.fetchedAt) };
}
/**
 * A host as the module sent it. A state this page does not know reads as not approved, and a port
 * it cannot read shows as 0, never as a likely-looking 22: the address is what the person checks.
 */
export function hostOf(value: unknown): SshHost | null {
  const raw = record(value);
  if (!raw || typeof raw.id !== "string" || !raw.id) return null;
  return {
    id: raw.id,
    label: typeof raw.label === "string" ? raw.label : "",
    host: typeof raw.host === "string" ? raw.host : "",
    port: typeof raw.port === "number" ? raw.port : typeof raw.port === "string" && /^\d{1,5}$/.test(raw.port) ? Number(raw.port) : 0,
    user: typeof raw.user === "string" ? raw.user : "",
    identityFile: typeof raw.identityFile === "string" && raw.identityFile ? raw.identityFile : null,
    production: raw.production === true,
    state: raw.state === "pinned" || raw.state === "changed" ? raw.state : "draft",
    key: keyOf(raw.key),
    candidate: candidateOf(raw.candidate),
  };
}
const hostsOf = (value: unknown): SshHost[] =>
  (Array.isArray(value) ? value : []).flatMap((item) => { const host = hostOf(item); return host ? [host] : []; });
function clientOf(value: unknown): SshClient | null {
  const raw = record(value);
  return raw && typeof raw.path === "string" && raw.path ? { path: raw.path, version: typeof raw.version === "string" ? raw.version : "" } : null;
}

/** user@host:port, an IPv6 address in brackets so its colons are not read as the port's. */
export function hostAddress(host: Pick<SshHost, "host" | "port" | "user">): string {
  return `${host.user}@${host.host.includes(":") ? `[${host.host}]` : host.host}:${host.port}`;
}

/**
 * Whether a terminal may be offered for a host: approved (a confirmed key, state "pinned") and no
 * other entry for the same server and port says it shows another key, as the module reads it
 * (ssh-connections.cjs `disputed`). The module checks again before it opens anything.
 */
export function terminalAllowed(host: SshHost, hosts: readonly SshHost[]): boolean {
  if (host.state !== "pinned" || !host.key) return false;
  const pinnedAt = host.key.pinnedAt === null ? Number.NaN : new Date(host.key.pinnedAt).getTime();
  const other = (key: { type: string; fingerprint: string }) => key.type !== host.key!.type || key.fingerprint !== host.key!.fingerprint;
  return !hosts.some((entry) => entry.host === host.host && entry.port === host.port && (
    (entry.id !== host.id && entry.state === "pinned" && entry.key !== null && other(entry.key))
    || (entry.candidate !== null && other(entry.candidate)
      && !(new Date(entry.candidate.fetchedAt ?? Number.NaN).getTime() < pinnedAt))));
}

/** The terminal the module opened, or null when its answer is not one. */
export function terminalOf(value: unknown, host: SshHost): SshTerminal | null {
  const raw = record(value);
  if (!raw || typeof raw.handle !== "string" || !/^[\w:.-]{1,200}$/.test(raw.handle)) return null;
  return {
    handle: raw.handle,
    generation: typeof raw.generation === "string" && raw.generation ? raw.generation : raw.handle,
    title: typeof raw.title === "string" && raw.title ? raw.title : host.label,
    hostId: host.id, label: host.label, address: hostAddress(host),
    // The tag shows when either says production: a missing answer never hides it.
    production: raw.production === true || host.production,
  };
}

/** The badge a host shows, in the app's chip tones. */
export function stateBadge(state: SshHostState): { text: string; tone: "ok" | "error" | "blocked" } {
  if (state === "pinned") return { text: "Approved", tone: "ok" };
  if (state === "changed") return { text: "Key changed, blocked", tone: "blocked" };
  return { text: "Key not confirmed", tone: "error" };
}

/** The file on the server whose fingerprint `ssh-keygen -lf` prints, for the kind of key the server showed. */
export function hostKeyFile(type: string): string {
  const kind = /ecdsa/i.test(type) ? "ecdsa" : /rsa/i.test(type) ? "rsa" : "ed25519";
  return `/etc/ssh/ssh_host_${kind}_key.pub`;
}

/**
 * The fingerprints in what the person pasted, each different one once. `ssh-keygen -lf` prints a
 * whole line ("256 SHA256:… root@server (ED25519)"), so the SHA256 value is read out of it. The
 * fetched key plays no part in the reading. Found 2026-11-27: the page picked whichever pasted
 * value equalled the fetched key, so a pasted list of several servers' fingerprints matched when
 * the address reached another of those machines, and the main process, which compares again, was
 * only ever sent the value that fitted. A paste counts only when it holds exactly one value, and
 * that value is what the main process is sent. The comparison stays exact, here and there.
 */
export function pastedFingerprints(pasted: string): string[] {
  return [...new Set(pasted.match(/SHA256:[A-Za-z0-9+/]+/g) ?? [])];
}

/** A saved time as the person's own date and time; nothing when the module sent none. */
export function dateText(value: string | number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** When and how a key was approved: "Approved 26 Nov 2026, 14:03 · pasted fingerprint matched". */
export function approvalText(key: SshKey): string {
  const at = dateText(key.pinnedAt);
  return `Approved${at ? ` ${at}` : ""} · ${key.method === "pasted" ? "pasted fingerprint matched" : "compared by eye"}`;
}

function Toggle({ checked, disabled = false, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <button aria-checked={checked} aria-label={label} className={`switch${checked ? " is-on" : ""}`} disabled={disabled}
    onClick={() => onChange(!checked)} role="switch" type="button"><span /></button>;
}

/**
 * Keeps the keyboard in an open dialog, and returns the undo for when it closes. Found 2026-11-27
 * in the browser: the dialog heard its keys only while one of its own controls had the focus.
 * After a click on its text (to select the ssh-keygen command) Escape did nothing, and Shift+Tab
 * went to the page behind, where Space changed another host's Production switch and Enter put
 * another host's key into the open dialog. So the keys are read on the document, and everything
 * beside the dialog is switched off (inert) while it is open. When the dialog is gone, the focus
 * goes back to the button `opener` names.
 */
function holdKeyboard(dialog: HTMLElement, cancel: () => void, opener: () => HTMLElement | null): () => void {
  const beside = Array.from(dialog.parentElement?.children ?? [])
    .filter((node): node is HTMLElement => node !== dialog && "inert" in node && !(node as HTMLElement).inert);
  for (const node of beside) node.inert = true;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (event.key !== "Tab") return;
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
    const first = stops[0], last = stops[stops.length - 1], current = document.activeElement;
    // From the dialog's text or the dimmed area around it, Tab goes to a control of the dialog too.
    const onStop = stops.some((stop) => stop === current);
    if (!onStop || (event.shiftKey ? current === first : current === last)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
  };
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    for (const node of beside) node.inert = false;
    // Only once the dialog is really gone (React undoes and repeats effects while developing), and
    // only when the focus went with it: a focus the person has since put elsewhere stays there.
    const current = document.activeElement;
    if (!dialog.isConnected && (!current || current === document.body)) opener()?.focus();
  };
}

/**
 * The app's dialog panel over the whole window. It is drawn into document.body: the page sits in a
 * layer below the sidebar and the title bar, and a dialog drawn there could be clicked around.
 * Escape takes `onCancel`, the way out that changes nothing, and Tab stays inside (holdKeyboard).
 * A click on the backdrop does nothing: the person may leave the app to fetch a fingerprint and
 * click back in. The panel itself takes the focus when its text is clicked, so the focus stays in
 * the dialog. `onCopy` hears a copy, or a drag, of anything in the panel.
 */
function Dialog({ title, eyebrow, warning = false, describedBy, opener, onCancel, onCopy, children }: {
  title: string; eyebrow?: string; warning?: boolean; describedBy?: string;
  opener: () => HTMLElement | null; onCancel: () => void; onCopy?: () => void; children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  // The newest of each: what Escape may do depends on what the page is doing when it is pressed.
  const latest = useRef({ onCancel, opener });
  latest.current = { onCancel, opener };
  useEffect(() => (element.current
    ? holdKeyboard(element.current, () => latest.current.onCancel(), () => latest.current.opener()) : undefined), []);
  // React events bubble out of a portal to the page that owns it; the dialog keeps its keys.
  const dialog = <div aria-describedby={describedBy} aria-labelledby={DIALOG_TITLE_ID} aria-modal="true" className="bigger-context-recommendation-backdrop"
    onKeyDown={(event) => event.stopPropagation()} ref={element} role={warning ? "alertdialog" : "dialog"}>
    <section className="bigger-context-recommendation ssh-dialog mcp-live-fields" onCopy={onCopy} onDragStart={onCopy} tabIndex={-1}>
      <header className="bigger-context-recommendation-header">
        {eyebrow ? <small>{eyebrow}</small> : null}
        <h2 id={DIALOG_TITLE_ID}>{title}</h2>
      </header>
      {children}
    </section>
  </div>;
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}

/** Where the real fingerprint comes from: the server itself, never this connection. */
function FingerprintSources({ type }: { type: string }) {
  return <>
    <p className="bigger-context-recommendation-body">Get the real fingerprint another way, not over this connection:</p>
    <ul className="ssh-dialog-steps">
      <li>On the server's own console, run <code>ssh-keygen -lf {hostKeyFile(type)}</code></li>
      <li>Or read it in your hosting provider's console.</li>
    </ul>
  </>;
}

export function SshConnectionsSurface({ active, setError }: {
  /** The tab is on screen: the list is read then, and a dialog shows only then. */
  active: boolean;
  setError: (error: string | null) => void;
}) {
  const [client, setClient] = useState<SshClient | null>(null);
  // null until the first list arrives.
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  // What is being done now ("add", "fetch:<id>", "confirm:<id>", "remove:<id>", "update:<id>"), so its button waits.
  const [busy, setBusy] = useState<string | null>(null);
  // What the last action on a host did, on its own row.
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [storeNotice, setStoreNotice] = useState("");
  const [adding, setAdding] = useState<AddDraft | null>(null);
  const [addError, setAddError] = useState("");
  // The host whose fetched key is in front of the person, what they pasted, and why approving failed.
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  // The box was filled by a paste right after a copy made in the open dialog: the value came from
  // this dialog, not from the server.
  const [pastedOwnCopy, setPastedOwnCopy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [copied, setCopied] = useState(false);
  // A fingerprint was copied in the open dialog and the person has not left the window since.
  const ownCopy = useRef(false);
  // The buttons a dialog opens from, by name ("add", "check:<id>", "review:<id>"), and the names the
  // open dialog came from, first choice first: the focus goes back there when it closes.
  const openers = useRef<Record<string, HTMLButtonElement>>({});
  const openedFrom = useRef<string[]>([]);
  // The in-app terminal in front of the list, and why closing it failed. One at a time, in this
  // page's memory only: nothing about it is saved.
  const [terminal, setTerminal] = useState<SshTerminal | null>(null);
  const [closeError, setCloseError] = useState("");
  // The app can show that terminal at all (Coding Agent's web host cannot yet): the list says so.
  const [canShowTerminal, setCanShowTerminal] = useState(true);
  // A terminal still open when the page itself goes away (a reload, a crash of the page) is closed
  // with it: nothing on screen could reach it again, and the SSH session would run on unseen.
  const openHandle = useRef<string | null>(null);
  openHandle.current = terminal?.handle ?? null;
  useEffect(() => () => {
    const handle = openHandle.current;
    if (handle) void call("terminal_close", { handle }).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call("list");
      setClient(clientOf(result.client));
      setHosts(hostsOf(result.hosts));
      // The saved list could not be read: it shows empty and approves no host until it can be.
      setStoreNotice(typeof result.notice === "string" ? result.notice : "");
      setCanShowTerminal(result.terminals !== false);
      setLoadError("");
    } catch (cause) {
      setLoadError(reasonOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  // Another window is where a fingerprint from the server gets onto the clipboard.
  useEffect(() => {
    const left = () => { ownCopy.current = false; };
    window.addEventListener("blur", left);
    return () => window.removeEventListener("blur", left);
  }, []);

  const working = busy !== null;
  const loaded = hosts !== null;
  const reviewHost = reviewId ? hosts?.find((host) => host.id === reviewId) ?? null : null;
  const candidate = reviewHost?.candidate ?? null;
  // Which dialog the fetched key calls for: the first comparison for a host with no confirmed key,
  // the warning for one whose server shows another key than the approved one, none otherwise.
  const reviewKind = !reviewHost || !candidate ? null
    : reviewHost.state === "draft" ? "confirm"
      : reviewHost.state === "changed" || reviewHost.key?.fingerprint !== candidate.fingerprint ? "changed" : null;
  // A blocked host whose server shows the approved key again. The module keeps it blocked: a key
  // that changed and changed back is what an interception that has ended looks like. Found
  // 2026-11-27: the warning then said "a different key" over two identical fingerprints.
  const keyBack = reviewKind === "changed" && reviewHost?.key?.fingerprint === candidate?.fingerprint;
  const confirming = Boolean(reviewHost) && busy === `confirm:${reviewHost?.id}`;
  const found = pastedFingerprints(pasted);
  const pastedValue = found.length === 1 ? found[0] : "";
  const same = candidate !== null && pastedValue === candidate.fingerprint;
  // The paste approves: one value, the fetched key's, and not this dialog's own copy of it.
  const matches = same && !pastedOwnCopy;
  // Something is in the box and it is not this key: neither way to approve is open.
  const differs = pasted.trim() !== "" && !same;
  // A dialog is in front of the page: nothing on the page behind it acts until it is closed.
  const dialogOpen = adding !== null || reviewKind !== null;

  const putHost = (next: SshHost) => setHosts((current) => current && current.some((item) => item.id === next.id)
    ? current.map((item) => (item.id === next.id ? next : item)) : [...(current ?? []), next]);
  const setNote = (id: string, note: { ok: boolean; text: string } | null) => setNotes(({ [id]: _, ...rest }) => (note ? { ...rest, [id]: note } : rest));
  const opener = (name: string) => (element: HTMLButtonElement | null) => { if (element) openers.current[name] = element; else delete openers.current[name]; };
  const returnFocus = () => openedFrom.current.map((name) => openers.current[name]).find((element) => element && !element.disabled) ?? null;
  const openReview = (id: string) => { ownCopy.current = false; setPasted(""); setPastedOwnCopy(false); setReviewError(""); setCopied(false); setReviewId(id); };
  const endReview = () => { setReviewId(null); setPasted(""); setPastedOwnCopy(false); setReviewError(""); };
  // Cancel, Stay disconnected and Escape. Not while an approval is on its way: it can no longer be
  // taken back, and closing then would read as if it had been.
  const closeReview = () => { if (!busy?.startsWith("confirm:")) endReview(); };
  const openAdd = () => { if (busy || dialogOpen) return; openedFrom.current = ["add"]; setAddError(""); setAdding(EMPTY_DRAFT); };
  const closeAdd = () => { if (busy === "add") return; setAdding(null); setAddError(""); };

  const submitAdd = async () => {
    if (!adding || busy) return;
    setBusy("add");
    setAddError("");
    try {
      const port = adding.port.trim();
      const identityFile = adding.identityFile.trim();
      // The module checks every field and says which one is wrong; a port that is not a number goes
      // as typed so its message is the one shown.
      const result = await call("add", {
        label: adding.label.trim(),
        host: adding.host.trim(),
        port: /^\d{1,5}$/.test(port) ? Number(port) : port || 22,
        user: adding.user.trim(),
        ...(identityFile ? { identityFile } : {}),
      });
      const next = hostOf(result.host);
      if (next) putHost(next); else await load();
      setAdding(null);
    } catch (cause) {
      setAddError(reasonOf(cause));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Fetches the key the server shows now. It approves nothing: a host with no confirmed key goes
   * to the comparison, an approved host whose server shows another key comes back blocked and goes
   * to the warning, and an unchanged one only says so. Not while a dialog is open: a fetch started
   * from behind one put another host's key into it (2026-11-27).
   */
  const checkKey = async (host: SshHost) => {
    if (busy || dialogOpen) return;
    openedFrom.current = [`check:${host.id}`];
    setBusy(`fetch:${host.id}`);
    setNote(host.id, null);
    try {
      const result = await call("fetch_key", { id: host.id });
      const next = hostOf(result.host);
      if (!next || !next.candidate) throw new Error("The server sent no key. Try again.");
      putHost(next);
      // A changed key blocks every entry for the same server and port, not only this one.
      if (next.state === "changed") void load();
      const unchanged = next.state === "pinned" && next.key?.fingerprint === next.candidate.fingerprint;
      if (unchanged) setNote(host.id, { ok: true, text: "The server still shows the key you approved." });
      else openReview(next.id);
    } catch (cause) {
      setNote(host.id, { ok: false, text: reasonOf(cause) });
      // A failed fetch can still have blocked hosts (a changed key whose save failed): show them as they are.
      void load();
    } finally {
      setBusy(null);
    }
  };

  /** The warning of a blocked host again, from its row: the key fetched last, with no new fetch. */
  const reviewChange = (host: SshHost) => {
    if (busy || dialogOpen) return;
    openedFrom.current = [`review:${host.id}`, `check:${host.id}`];
    openReview(host.id);
  };

  /**
   * Approves the fetched key. With `byPaste` the one fingerprint read from what the person pasted
   * goes along and the main process compares it again; without it the person only says they
   * compared it themselves. Each way does nothing while its button is shut.
   */
  const confirmKey = async (host: SshHost, byPaste: boolean) => {
    const candidate = host.candidate;
    if (!candidate || busy || (byPaste ? !matches : differs)) return;
    setBusy(`confirm:${host.id}`);
    setReviewError("");
    try {
      const result = await call("confirm_key", byPaste
        ? { id: host.id, fingerprint: candidate.fingerprint, pasted: pastedValue }
        : { id: host.id, fingerprint: candidate.fingerprint });
      const next = hostOf(result.host);
      if (next) putHost(next); else await load();
      endReview();
      setNote(host.id, { ok: true, text: byPaste ? "Key approved. The pasted fingerprint matched." : "Key approved." });
    } catch (cause) {
      setReviewError(reasonOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (host: SshHost) => {
    if (busy || dialogOpen) return;
    if (!window.confirm(`Remove “${host.label}” from SSH hosts?\n\nAgents can no longer use SSH to it, and its approved key is forgotten.`)) return;
    setBusy(`remove:${host.id}`);
    try {
      const result = await call("remove", { id: host.id });
      setHosts(hostsOf(result.hosts));
      setNote(host.id, null);
    } catch (cause) {
      setError(reasonOf(cause));
    } finally {
      setBusy(null);
    }
  };

  /**
   * One update at a time, and the switch waits for it. Found 2026-11-27: the switch stayed live
   * while its update was on its way, so two quick clicks that were both refused left it showing
   * On while the saved value was Off.
   */
  const setProduction = async (host: SshHost, production: boolean) => {
    if (busy || dialogOpen) return;
    setBusy(`update:${host.id}`);
    // Shown at once; the saved host replaces it, and a refused change goes back to what the host had.
    setHosts((current) => current && current.map((item) => (item.id === host.id ? { ...item, production } : item)));
    try {
      const result = await call("update", { id: host.id, production });
      const next = hostOf(result.host);
      if (next) putHost(next);
    } catch (cause) {
      setHosts((current) => current && current.map((item) => (item.id === host.id ? { ...item, production: host.production } : item)));
      setError(reasonOf(cause));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Opens the in-app terminal to an approved host. The module checks the host again, writes the
   * pinned keys file and has AO start ssh; the terminal then shows in place of the list. A refusal
   * shows on the host's row, in the module's words.
   */
  const openTerminal = async (host: SshHost) => {
    if (busy || dialogOpen || terminal || !terminalAllowed(host, hosts ?? [])) return;
    setBusy(`open:${host.id}`);
    setNote(host.id, null);
    try {
      const result = await call("terminal_open", { id: host.id });
      const opened = terminalOf(result.terminal, host);
      if (!opened) throw new Error("The terminal could not be opened. Try again.");
      setCloseError("");
      // When the panel gives way to the list again, the focus goes back to this row.
      openedFrom.current = [`terminal:${host.id}`, `check:${host.id}`];
      setTerminal(opened);
    } catch (cause) {
      setNote(host.id, { ok: false, text: reasonOf(cause) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Closes the terminal and shows the list again. A close that failed keeps the terminal on screen
   * with the reason, so it can be tried again; one the module does not know (the app's backend
   * restarted since) goes back to the list and says so on the host's row.
   */
  const closeTerminal = async () => {
    if (!terminal || busy) return;
    const { handle, hostId } = terminal;
    setBusy("close");
    setCloseError("");
    try {
      await call("terminal_close", { handle });
      setTerminal(null);
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "not_own") {
        setTerminal(null);
        setNote(hostId, { ok: false, text: reasonOf(cause) });
      } else setCloseError(reasonOf(cause));
    } finally {
      setBusy(null);
    }
  };

  // The panel gave way to the list (Close terminal, or a terminal the module no longer knows): once
  // the page is on screen, the focus goes back to that row's Open terminal button, as it goes back
  // to a dialog's button when the dialog closes.
  const panelShown = useRef(false);
  useEffect(() => {
    if (terminal) { panelShown.current = true; return; }
    if (!panelShown.current || !active) return;
    panelShown.current = false;
    returnFocus()?.focus();
  }, [terminal, active]);

  const copiedHere = () => { ownCopy.current = true; };
  const copy = (value: string) => void navigator.clipboard.writeText(value).then(
    () => { copiedHere(); setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
    () => setReviewError("Couldn't copy. Select the fingerprint and copy it yourself."),
  );
  const field = (key: keyof AddDraft) => (event: { target: { value: string } }) =>
    setAdding((current) => current && { ...current, [key]: event.target.value });

  /**
   * The box for the fingerprint the person got from the server. Found 2026-11-27: the dialog's own
   * Copy and a paste here approved the key as "pasted fingerprint matched" with no value from the
   * server involved. A paste (or a drop) that follows a copy (or a drag) made in the dialog, with no
   * visit to another window in between, is therefore kept apart as the dialog's own value. Text
   * copied or dragged out of this box is the person's, and what is typed by hand is their own reading.
   */
  const pasteBox = (label: string) => <input aria-label={label} autoComplete="off"
    onChange={(event) => {
      const next = event.target.value;
      // Dragging the fingerprint from the field above into this box is the same as copying it.
      const put = ["insertFromPaste", "insertFromDrop"].includes((event.nativeEvent as InputEvent).inputType);
      // A key typed after such a paste that leaves the same fingerprints in the box (a space at the
      // end) does not turn the dialog's value into the server's.
      const kept = pastedFingerprints(next).join("\n") === pastedFingerprints(pasted).join("\n");
      setPastedOwnCopy((was) => (put ? ownCopy.current : was && kept));
      setPasted(next);
    }}
    onCopy={(event) => event.stopPropagation()} onDragStart={(event) => event.stopPropagation()} placeholder="SHA256:…" spellCheck={false} value={pasted} />;
  // What the page can say about the pasted text. It gives a verdict on the key only for one SHA256
  // value: the same key in another form (MD5, the public key line) is not a different key.
  const pasteStatus = !candidate || pasted.trim() === "" ? null
    : matches ? <p className="app-plugin-detail is-ok" role="status">It matches the key this server sent.</p>
      : <p className="app-plugin-detail is-error" role="status">{same
        ? "That is the fingerprint copied from this dialog, not one you got from the server. Get it from the server's console or your hosting provider, then paste it."
        : found.length > 1 ? `There is more than one fingerprint here. Paste only the line for this server's ${candidate.type} key.`
          : found.length === 0 ? "This is not a SHA256 fingerprint. Paste the line that has SHA256: in it."
            : "It is not the key this server sent. Do not approve this key."}</p>;

  const row = (host: SshHost) => {
    const badge = stateBadge(host.state);
    const note = notes[host.id];
    const back = host.state === "changed" && host.candidate !== null && host.key?.fingerprint === host.candidate.fingerprint;
    return (
      <div aria-label={host.label} className={`ssh-host is-${host.state}`} key={host.id} role="group">
        <div className="ssh-host-head">
          <div className="ssh-host-name">
            <strong>{host.label}</strong>
            <span className="ssh-host-address">{hostAddress(host)}</span>
          </div>
          <span className={`app-plugin-chip ssh-host-state is-${badge.tone}`}>{badge.text}</span>
          <div className="ssh-host-actions">
            {canShowTerminal && terminalAllowed(host, hosts ?? [])
              ? <button className="button-primary" disabled={working || !client} onClick={() => void openTerminal(host)} ref={opener(`terminal:${host.id}`)} type="button">
                {busy === `open:${host.id}` ? "Opening…" : "Open terminal"}
              </button> : null}
            {host.state === "changed" && host.candidate
              ? <button className="button-primary" disabled={working} onClick={() => reviewChange(host)} ref={opener(`review:${host.id}`)} type="button">Review key change</button> : null}
            <button className={host.state === "draft" ? "button-primary" : "button-secondary"} disabled={working || !client}
              onClick={() => void checkKey(host)} ref={opener(`check:${host.id}`)} type="button">
              {busy === `fetch:${host.id}` ? "Fetching key…" : host.state === "draft" ? "Confirm key" : "Check key"}
            </button>
            <button className="button-secondary" disabled={working} onClick={() => void remove(host)} type="button">Remove</button>
          </div>
        </div>
        {host.key
          ? <p className="ssh-host-key"><code>{host.key.type} {host.key.fingerprint}</code><small>{approvalText(host.key)}</small></p>
          : <p className="ssh-host-note">No key confirmed yet. Agents can't use this host.</p>}
        {host.state === "changed" ? <p className="ssh-host-note is-error">{back
          ? "The server showed a different key and now shows the approved one again. Agents can't use this host until you review the change."
          : "The server now shows a different key. Agents can't use this host until you review the change."}</p> : null}
        {host.identityFile ? <p className="ssh-host-note">Key file: {host.identityFile}</p> : null}
        <div className="setting-row is-flush-after ssh-host-production">
          <div><strong>Production</strong><p>Every agent command on a production host waits for you.</p></div>
          <Toggle checked={host.production} disabled={working} label={`Production: ${host.label}`}
            onChange={(checked) => void setProduction(host, checked)} />
        </div>
        {note ? <p className={`app-plugin-detail is-${note.ok ? "ok" : "error"}`} role="status">{note.text}</p> : null}
      </div>
    );
  };

  // The open terminal, in place of the list. AO draws it in a native view over this panel, in its
  // remote mode; the view steps aside on its own while this tab is hidden or something covers it.
  if (terminal) {
    return <section aria-label="SSH hosts" className="content-surface ssh-connections">
      <div aria-label={`SSH terminal: ${terminal.label}`} className="ssh-terminal" role="group">
        <header className="ssh-terminal-bar">
          <div className="ssh-host-name">
            <strong>{terminal.label}</strong>
            <span className="ssh-host-address">{terminal.address}</span>
          </div>
          {terminal.production ? <span className="app-plugin-chip ssh-host-state is-error">Production</span> : null}
          <button className="button-secondary" disabled={busy === "close"} onClick={() => void closeTerminal()} type="button">
            {busy === "close" ? "Closing…" : "Close terminal"}
          </button>
        </header>
        {closeError ? <p className="app-plugin-detail is-error" role="alert">{closeError}</p> : null}
        <div className="ssh-terminal-view">
          <AgentOrchestratorOriginalSurface hostbar={false} openMissions={() => undefined}
            terminal={{ handle: terminal.handle, generation: terminal.generation, title: terminal.title, remote: true }} />
        </div>
      </div>
    </section>;
  }

  return <section aria-label="SSH hosts" className="content-surface ssh-connections">
    <div className="content-scroll is-narrow">
      <header className="surface-header">
        <h1>SSH hosts</h1>
        <p>Servers chat agents may reach over SSH. You approve each one by confirming its key.</p>
      </header>

      <div className="app-plugins-bar">
        <small role="status">{client ? [client.version, client.path].filter(Boolean).join(" · ")
          : loaded ? "No SSH client found" : loadError ? "SSH hosts didn't load" : "Looking for the SSH client…"}</small>
        <button className="button-secondary" disabled={loading} onClick={() => void load()} type="button">
          <Icon name="reload" /><span>Check again</span>
        </button>
        <button className="button-primary" disabled={working || !loaded} onClick={openAdd} ref={opener("add")} type="button">Add host</button>
      </div>
      {loaded && !client ? <div className="notice-row">
        <Icon name="warning" />
        <span>No SSH client was found on this computer, so the app can't fetch a server's key. On Windows, add OpenSSH Client under Settings, System, Optional features, then choose Check again.</span>
      </div> : null}
      {storeNotice ? <div className="notice-row" role="alert">
        <Icon name="warning" />
        <span>{storeNotice}</span>
      </div> : null}
      {loaded && !canShowTerminal ? <div className="notice-row">
        <Icon name="info" />
        <span>This app can't show the in-app terminal yet. Approved hosts and the agent rules work as usual.</span>
      </div> : null}

      <div className="section-heading"><span>Hosts</span>{hosts?.length ? <small>{hosts.length}</small> : null}</div>
      {loadError ? <p className="surface-empty-note" role="alert">SSH hosts didn't load: {loadError}</p>
        : !hosts ? <p className="surface-empty-note">Loading…</p>
          : hosts.length ? <div className="ssh-hosts">{hosts.map(row)}</div>
            : <p className="surface-empty-note">No hosts yet. Agents may only use SSH to hosts you approve here, and each command is still reviewed.</p>}
    </div>

    {active && adding ? <Dialog onCancel={closeAdd} opener={returnFocus} title="Add host">
      <p className="bigger-context-recommendation-body">Agents can't use the host until you confirm its key.</p>
      <form className="ssh-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitAdd(); }}>
        <label className="field-row"><span>Label</span>
          <input autoFocus maxLength={60} onChange={field("label")} placeholder="Build server" value={adding.label} /></label>
        <label className="field-row"><span>Host</span>
          <input autoCapitalize="off" autoComplete="off" onChange={field("host")} placeholder="server.example.com" spellCheck={false} value={adding.host} /></label>
        <label className="field-row"><span>Port</span>
          <input autoComplete="off" inputMode="numeric" onChange={field("port")} placeholder="22" value={adding.port} /></label>
        <label className="field-row"><span>User</span>
          <input autoCapitalize="off" autoComplete="off" onChange={field("user")} placeholder="deploy" spellCheck={false} value={adding.user} /></label>
        <label className="field-row"><span>Key file (optional)</span>
          <input autoComplete="off" onChange={field("identityFile")} placeholder="C:\Users\you\.ssh\id_ed25519" spellCheck={false} value={adding.identityFile} />
          <small>Only the path is saved. The app never reads the key.</small></label>
        {addError ? <p className="mcp-server-error" role="alert">{addError}</p> : null}
        <footer>
          <button className="button-secondary" disabled={busy === "add"} onClick={closeAdd} type="button">Cancel</button>
          <button className="button-primary" disabled={busy === "add"} type="submit">{busy === "add" ? "Adding…" : "Add host"}</button>
        </footer>
      </form>
    </Dialog> : null}

    {/* The first key of a host. Cancel is the default: it has the focus, and Escape takes it. */}
    {active && reviewHost && candidate && reviewKind === "confirm" ? <Dialog eyebrow={reviewHost.label} onCancel={closeReview} onCopy={copiedHere}
      opener={returnFocus} title="Confirm this server's key">
      {/* The dialog comes back with its tab, so it says when the key was fetched, never "just now". */}
      <dl className="ssh-dialog-facts">
        <dt>Host</dt><dd>{reviewHost.host}</dd>
        <dt>Port</dt><dd>{reviewHost.port}</dd>
        <dt>Key type</dt><dd>{candidate.type}</dd>
        <dt>Fetched</dt><dd>{dateText(candidate.fetchedAt) || "Time not recorded"}</dd>
      </dl>
      <div className="field-row is-stacked">
        <span>Fingerprint the server sent</span>
        <div className="ssh-copy-row">
          <input aria-label="Fingerprint the server sent" onFocus={(event) => event.currentTarget.select()} readOnly spellCheck={false} value={candidate.fingerprint} />
          <button className="button-secondary" onClick={() => copy(candidate.fingerprint)} type="button">{copied ? "Copied" : "Copy"}</button>
        </div>
      </div>
      <div className="notice-row">
        <Icon name="warning" />
        <span>Coding Tools can't tell whether this key is genuine. It is only what the server at this address sent when the key was fetched. If someone is intercepting the connection, it is their key.</span>
      </div>
      <FingerprintSources type={candidate.type} />
      <div className="field-row is-stacked">
        <span>Paste the fingerprint you got there</span>
        {pasteBox("Fingerprint from the server")}
      </div>
      {pasteStatus}
      {reviewError ? <p className="mcp-server-error" role="alert">{reviewError}</p> : null}
      <footer>
        <button className="button-secondary" disabled={confirming || differs} onClick={() => void confirmKey(reviewHost, false)} type="button">I compared it myself</button>
        <button className="button-secondary" disabled={confirming || !matches} onClick={() => void confirmKey(reviewHost, true)} type="button">
          {confirming ? "Approving…" : "Approve this key"}
        </button>
        <button autoFocus className="button-primary" disabled={confirming} onClick={closeReview} type="button">Cancel</button>
      </footer>
    </Dialog> : null}

    {/* A blocked host. Staying disconnected is the default, and only a pasted fingerprint that matches replaces the key or unblocks the host. */}
    {active && reviewHost && candidate && reviewKind === "changed" ? <Dialog describedBy={DIALOG_ABOUT_ID} eyebrow={`${reviewHost.label} · ${hostAddress(reviewHost)}`}
      onCancel={closeReview} onCopy={copiedHere} opener={returnFocus} title={keyBack ? "This server shows the approved key again" : "This server's key changed"} warning>
      <p className="bigger-context-recommendation-body" id={DIALOG_ABOUT_ID}>{keyBack
        ? "The server shows the key you approved again. It showed a different one before. Agents can't use this host while it is blocked."
        : "The server now shows a different key from the one you approved. Agents can't use this host while it is blocked."}</p>
      <div className="ssh-key-compare">
        <div className="ssh-key-card">
          <strong>Key you approved</strong>
          {reviewHost.key ? <>
            <span>{reviewHost.key.type}</span>
            <code>{reviewHost.key.fingerprint}</code>
            <small>{approvalText(reviewHost.key)}</small>
          </> : <small>No approved key on record.</small>}
        </div>
        <div className={`ssh-key-card${keyBack ? "" : " is-new"}`}>
          <strong>Key the server shows now</strong>
          <span>{candidate.type}</span>
          <code>{candidate.fingerprint}</code>
          <small>{dateText(candidate.fetchedAt) ? `Fetched ${dateText(candidate.fetchedAt)}` : "Fetched just now"}</small>
        </div>
      </div>
      <div className="notice-row">
        <Icon name="warning" />
        <span>{keyBack
          ? "A different key that goes away again can mean the address pointed at another machine for a while, or that someone was intercepting the connection and has stopped. Coding Tools can't tell which."
          : "Ordinary causes: the server was reinstalled, its keys were rotated, or this address now belongs to another machine. The bad cause: someone is intercepting the connection. Coding Tools can't tell which."}</span>
      </div>
      <FingerprintSources type={candidate.type} />
      <div className="field-row is-stacked">
        <span>{keyBack ? "To unblock this host, paste the fingerprint you got there" : "To replace the approved key, paste the new fingerprint you got there"}</span>
        {pasteBox(keyBack ? "Fingerprint from the server" : "New fingerprint from the server")}
      </div>
      {pasteStatus}
      {reviewError ? <p className="mcp-server-error" role="alert">{reviewError}</p> : null}
      <footer>
        <button className="button-secondary" disabled={confirming || !matches} onClick={() => void confirmKey(reviewHost, true)} type="button">
          {keyBack ? (confirming ? "Unblocking…" : "Unblock this host") : confirming ? "Replacing…" : "Replace key"}
        </button>
        <button autoFocus className="button-primary" disabled={confirming} onClick={closeReview} type="button">Stay disconnected</button>
      </footer>
    </Dialog> : null}
  </section>;
}

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  EmailMailbox,
  EmailMessage,
  EmailMessageSummary,
  EmailStatus,
  LauncherApi,
} from "../types";
import { Icon } from "../icons";
import "./email.css";

// A surface-local boundary: a render error here shows a message instead of unmounting the app.
class EmailBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="email-surface email-connect">
          <div className="email-connect-card">
            <Icon name="mail" width={28} height={28} />
            <h1>Email hit an error</h1>
            <p className="email-warn">{this.state.error}</p>
            <button className="email-primary" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function EmailSurface(props: { api: LauncherApi; setError: (e: string | null) => void }) {
  return <EmailBoundary><EmailSurfaceInner {...props} /></EmailBoundary>;
}

const PAGE_SIZE = 20;
const ALL_ACCOUNTS = "all";
const NEW_MAIL_POLL_MS = 30_000;

// The Worker stores D1 CURRENT_TIMESTAMP: UTC written as "YYYY-MM-DD HH:MM:SS" with no zone.
// Chromium would read that as *local* time, so pin it to UTC before converting to Hong Kong time.
const HONG_KONG_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function formatHongKongTime(value: string | null): string {
  if (!value) return "";
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
  const date = new Date(zoneless ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? value : `${HONG_KONG_TIME.format(date)} HKT`;
}

// Fold the newest page into what's loaded. If none of it overlaps, more than a page of mail
// arrived since the last look — restart from the top rather than leave a silent gap.
function mergeNewest(current: EmailMessageSummary[], newest: EmailMessageSummary[]): EmailMessageSummary[] {
  if (!current.length) return newest;
  const known = new Set(current.map((m) => m.id));
  if (!newest.some((m) => known.has(m.id))) return newest;
  const fresh = newest.filter((m) => !known.has(m.id));
  return fresh.length ? [...fresh, ...current] : current;
}

// The email preview is the one place untrusted remote HTML enters the app. It renders in a
// sandboxed iframe (no scripts, forms, same-origin, or top navigation) with a CSP that blocks
// every network fetch, so tracking pixels and remote resources never load and the content can
// never reach a launcher:* channel. The HTML is already sanitized in the main process.
const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;";

function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`
    + `<style>body{font:14px/1.5 system-ui,sans-serif;color:#e7e7ea;margin:12px;overflow-wrap:anywhere}`
    + `a{color:#8ab4ff;pointer-events:none}img{max-width:100%}</style></head>`
    + `<body>${html}</body></html>`;
}

// The Worker has no read/unread flag, so "read" is a local notion: the ids this app has opened,
// scoped per Worker origin (message ids are only unique within one Worker).
// Only message ids are stored (nothing secret), capped so deleted mail can't grow it forever.
const MAX_READ_IDS = 2000;

function loadReadIds(storageKey: string): Set<number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is number => Number.isInteger(id)) : []);
  } catch { return new Set(); }
}

function saveReadIds(storageKey: string, ids: Set<number>): void {
  try { localStorage.setItem(storageKey, JSON.stringify([...ids].slice(-MAX_READ_IDS))); } catch {}
}

function useReadIds(origin: string | null) {
  const storageKey = origin ? `email.read.${origin}` : null;
  const [readIds, setReadIds] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    setReadIds(storageKey ? loadReadIds(storageKey) : new Set());
  }, [storageKey]);

  const markRead = useCallback((id: number) => {
    setReadIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current).add(id);
      if (storageKey) saveReadIds(storageKey, next);
      return next;
    });
  }, [storageKey]);

  return { readIds, markRead };
}

type Confirm =
  | { kind: "delete-message"; id: number; subject: string }
  | { kind: "clear-inbox"; mailbox: EmailMailbox }
  | { kind: "remove-mailbox"; mailbox: EmailMailbox };

function EmailSurfaceInner({ api, setError }: { api: LauncherApi; setError: (e: string | null) => void }) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [mailboxes, setMailboxes] = useState<EmailMailbox[]>([]);
  const [mailboxQuery, setMailboxQuery] = useState("");
  const [selected, setSelected] = useState<EmailMailbox | null>(null);
  // "All accounts" lists every mailbox's mail at once; `selected` is kept so switching back is cheap.
  const [allView, setAllView] = useState(false);
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const [filter, setFilter] = useState("");
  const [openMessage, setOpenMessage] = useState<EmailMessage | null>(null);
  const [previewMode, setPreviewMode] = useState<"html" | "text">("html");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [origin, setOrigin] = useState("");
  const [adminAuth, setAdminAuth] = useState("");
  const [mobilePane, setMobilePane] = useState<"list" | "message">("list");

  // Rising token so a response for a mailbox the user has since switched away from is discarded.
  const loadToken = useRef(0);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [setError]);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Guard against a bridge that predates the email methods: never let this throw
    // synchronously inside the effect (that would unmount the tree and blank the app).
    try {
      if (typeof api.emailStatus !== "function") {
        throw new Error("This build's bridge has no email support — rebuild the app (preload out of date).");
      }
      void Promise.resolve(api.emailStatus())
        .then((next) => { if (alive) { setStatus(next); setLoadError(null); } })
        .catch((cause) => { if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
    return () => { alive = false; };
  }, [api]);

  const loadMailboxes = useCallback((query: string) => run(async () => {
    const { mailboxes: next } = await api.listEmailMailboxes({ limit: 50, query: query || undefined });
    setMailboxes(next);
    setSelected((current) => current ?? next[0] ?? null);
  }), [api, run]);

  useEffect(() => { if (status?.configured) void loadMailboxes(""); }, [status?.configured, loadMailboxes]);

  // `undefined` address = every mailbox (the Worker's /admin/mails without an address filter).
  const viewAddress = allView ? undefined : selected?.address;
  const hasView = allView || Boolean(selected);
  const { readIds, markRead } = useReadIds(status?.origin ?? null);

  const loadMessages = useCallback((address: string | undefined, offset: number) => run(async () => {
    const token = ++loadToken.current;
    const { messages: next, count } = await api.listEmailMessages({ address, limit: PAGE_SIZE, offset });
    if (token !== loadToken.current) return; // a newer selection won; drop this stale page
    // The Worker computes the total only for offset 0 and reports 0 on later pages.
    if (offset === 0) setMessageCount(count);
    setMessages((current) => {
      if (offset === 0) return next;
      // Mail that arrived since page one shifts the offsets, so a later page can repeat rows.
      const known = new Set(current.map((m) => m.id));
      return [...current, ...next.filter((m) => !known.has(m.id))];
    });
  }), [api, run]);

  useEffect(() => {
    if (!hasView) return;
    setMessages([]);
    setOpenMessage(null);
    void loadMessages(viewAddress, 0);
  }, [hasView, viewAddress, loadMessages]);

  // Quietly pick up new mail: no busy state and no error banner for a background check.
  useEffect(() => {
    if (!hasView) return;
    const timer = setInterval(() => {
      const token = loadToken.current;
      void api.listEmailMessages({ address: viewAddress, limit: PAGE_SIZE, offset: 0 })
        .then(({ messages: newest, count }) => {
          if (token !== loadToken.current) return;
          setMessageCount(count);
          setMessages((current) => mergeNewest(current, newest));
        })
        .catch(() => {});
    }, NEW_MAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [api, hasView, viewAddress]);

  const shownMessages = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((m) =>
      [m.from, m.subject, m.preview].some((f) => f?.toLowerCase().includes(needle)));
  }, [messages, filter]);

  const connect = () => run(async () => {
    setStatus(await api.connectEmail({ origin: origin.trim(), adminAuth }));
    setAdminAuth("");
  });

  const openMessageById = (id: number) => run(async () => {
    const { message } = await api.getEmailMessage({ id });
    setOpenMessage(message);
    markRead(id);
    setPreviewMode(message?.html ? "html" : "text");
    setMobilePane("message");
  });

  const createAddress = () => run(async () => {
    const domain = status?.capabilities?.domains[0];
    if (!domain) throw new Error("The Worker reported no configured domain");
    await api.createEmailAddress({ name: newAddress.trim(), domain });
    setNewAddress("");
    await loadMailboxes(mailboxQuery);
  });

  const runConfirm = () => run(async () => {
    if (!confirm) return;
    if (confirm.kind === "delete-message") {
      await api.deleteEmailMessage({ id: confirm.id });
      if (openMessage?.id === confirm.id) setOpenMessage(null);
      if (hasView) await loadMessages(viewAddress, 0);
    } else if (confirm.kind === "clear-inbox") {
      await api.clearEmailInbox({ id: confirm.mailbox.id });
      if (hasView) await loadMessages(viewAddress, 0);
    } else if (confirm.kind === "remove-mailbox") {
      await api.removeEmailMailbox({ id: confirm.mailbox.id });
      setSelected(null);
      await loadMailboxes(mailboxQuery);
    }
    setConfirm(null);
  });

  if (loadError) {
    return (
      <div className="email-surface email-connect">
        <div className="email-connect-card">
          <Icon name="mail" width={28} height={28} />
          <h1>Email couldn’t load</h1>
          <p className="email-warn">{loadError}</p>
          <button className="email-primary" onClick={() => { setLoadError(null); void api.emailStatus?.().then(setStatus).catch((c) => setLoadError(c instanceof Error ? c.message : String(c))); }}>Retry</button>
        </div>
      </div>
    );
  }
  if (!status) return <div className="email-surface email-loading">Loading…</div>;

  if (!status.configured) {
    return (
      <div className="email-surface email-connect">
        <div className="email-connect-card">
          <Icon name="mail" width={28} height={28} />
          <h1>Connect your mail Worker</h1>
          <p>Reuse your Cloudflare mailbox Worker read-only first. The admin credential is encrypted
            with your OS keychain in the main process and never shown again or sent to the page.</p>
          {!status.encryptionAvailable ? (
            <p className="email-warn">OS-backed encryption is unavailable, so the credential can't be
              stored securely. Connecting is disabled until it's available.</p>
          ) : null}
          <label>Mail API origin
            <input value={origin} placeholder="https://mail-api.example.com"
              onChange={(e) => setOrigin(e.target.value)} spellCheck={false} />
          </label>
          <label>Admin credential (x-admin-auth)
            <input type="password" value={adminAuth} autoComplete="off"
              onChange={(e) => setAdminAuth(e.target.value)} />
          </label>
          <button className="email-primary" disabled={busy || !origin || !adminAuth || !status.encryptionAvailable}
            onClick={connect}>{busy ? "Verifying…" : "Verify & connect"}</button>
        </div>
      </div>
    );
  }

  const domain = status.capabilities?.domains[0] ?? null;

  return (
    <div className={`email-surface pane-${mobilePane}`}>
      <header className="email-header">
        <div className="email-origin"><Icon name="mail" width={18} height={18} /><span>{status.origin}</span>
          {status.capabilities?.version ? <em>v{status.capabilities.version}</em> : null}</div>
        <div className="email-header-actions">
          <button disabled={busy} onClick={() => hasView && loadMessages(viewAddress, 0)}><Icon name="reload" width={16} height={16} />Refresh</button>
          <button disabled={busy} onClick={() => run(async () => setStatus(await api.disconnectEmail()))}>Disconnect</button>
        </div>
      </header>

      <div className="email-body">
        <aside className="email-list">
          <div className="email-mailboxes">
            <div className="email-search">
              <input value={mailboxQuery} placeholder="Search addresses"
                onChange={(e) => setMailboxQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void loadMailboxes(mailboxQuery); }} />
            </div>
            <select value={allView ? ALL_ACCOUNTS : selected?.id ?? ""} onChange={(e) => {
              setMobilePane("list");
              if (e.target.value === ALL_ACCOUNTS) { setAllView(true); return; }
              setAllView(false);
              setSelected(mailboxes.find((m) => String(m.id) === e.target.value) ?? null);
            }}>
              {mailboxes.length ? <option value={ALL_ACCOUNTS}>All accounts</option> : null}
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
            </select>
            <div className="email-new-address">
              <input value={newAddress} placeholder="new-name"
                onChange={(e) => setNewAddress(e.target.value)} />
              <span className="email-domain">@{domain ?? "…"}</span>
              <button disabled={busy || !newAddress || !domain} onClick={createAddress}><Icon name="plus" width={14} height={14} /></button>
            </div>
            {selected && !allView ? (
              <div className="email-mailbox-actions">
                <button disabled={busy} onClick={() => setConfirm({ kind: "clear-inbox", mailbox: selected })}>Clear inbox</button>
                <button className="email-danger" disabled={busy} onClick={() => setConfirm({ kind: "remove-mailbox", mailbox: selected })}>Remove mailbox</button>
              </div>
            ) : null}
          </div>

          <div className="email-filter">
            <input value={filter} placeholder="Search loaded messages"
              onChange={(e) => setFilter(e.target.value)} />
          </div>

          <ul className="email-messages">
            {shownMessages.length === 0 ? <li className="email-empty">No messages.</li> : null}
            {shownMessages.map((m) => (
              <li key={m.id} className={openMessage?.id === m.id ? "is-open" : ""}>
                <button onClick={() => openMessageById(m.id)}
                  title={[m.from, formatHongKongTime(m.receivedAt)].filter(Boolean).join("\n") || undefined}>
                  {allView ? <div className="email-row-account">{m.mailbox ?? "(unknown account)"}</div> : null}
                  <div className="email-row">
                    <span className={`email-dot ${readIds.has(m.id) ? "is-read" : "is-unread"}`}
                      aria-label={readIds.has(m.id) ? "Read" : "Unread"} />
                    <span className="email-subject">{m.subject ?? "(no subject)"}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {messages.length < messageCount ? (
            <button className="email-loadmore" disabled={busy}
              onClick={() => hasView && loadMessages(viewAddress, messages.length)}>Load more ({messages.length}/{messageCount})</button>
          ) : null}
        </aside>

        <section className="email-message">
          <button className="email-back" onClick={() => setMobilePane("list")}><Icon name="back" width={16} height={16} />Back to inbox</button>
          {!openMessage ? <div className="email-empty">Select a message to read.</div> : (
            <>
              <div className="email-message-head">
                <h2>{openMessage.subject ?? "(no subject)"}</h2>
                <dl>
                  <div><dt>From</dt><dd>{openMessage.from ?? "(unknown)"}</dd></div>
                  <div><dt>To</dt><dd>{openMessage.to ?? "(unknown)"}</dd></div>
                  <div><dt>Date</dt><dd>{formatHongKongTime(openMessage.receivedAt)}</dd></div>
                </dl>
                <div className="email-message-actions">
                  {openMessage.html && openMessage.text ? (
                    <div className="email-modes">
                      <button className={previewMode === "html" ? "is-active" : ""} onClick={() => setPreviewMode("html")}>HTML</button>
                      <button className={previewMode === "text" ? "is-active" : ""} onClick={() => setPreviewMode("text")}>Plain text</button>
                    </div>
                  ) : null}
                  <button className="email-danger" disabled={busy}
                    onClick={() => setConfirm({ kind: "delete-message", id: openMessage.id, subject: openMessage.subject ?? "(no subject)" })}>Delete</button>
                </div>
              </div>
              {previewMode === "html" && openMessage.html ? (
                <iframe className="email-html" sandbox="" title="Email content" srcDoc={previewDocument(openMessage.html)} />
              ) : (
                <pre className="email-text">{openMessage.text ?? "(no text content)"}</pre>
              )}
              {openMessage.attachments.length ? (
                <div className="email-attachments">
                  <h3>Attachments</h3>
                  <ul>{openMessage.attachments.map((a, i) => (
                    <li key={i}>{a.filename ?? "(unnamed)"} <em>{a.mimeType ?? ""}{a.size != null ? ` · ${a.size} B` : ""}</em></li>
                  ))}</ul>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {confirm ? (
        <div className="email-modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="email-modal" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === "delete-message" ? (
              <><h3>Delete this message?</h3>
                <p>“{confirm.subject}” will be permanently deleted from the Worker. This cannot be undone.</p></>
            ) : confirm.kind === "clear-inbox" ? (
              <><h3>Clear this inbox?</h3>
                <p>All received messages for <strong>{confirm.mailbox.address}</strong> will be permanently
                  deleted from the Worker. The address itself stays. This cannot be undone.</p></>
            ) : (
              <><h3>Remove this mailbox?</h3>
                <p>The Worker will <strong>permanently remove</strong> <strong>{confirm.mailbox.address}</strong>:
                  its received mail, sent records, sender settings, auto-reply records, and address links.
                  There is no restore, and this affects every client of this mail service.</p></>
            )}
            <div className="email-modal-actions">
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button className="email-danger" disabled={busy} onClick={runConfirm}>
                {confirm.kind === "delete-message" ? "Delete message"
                  : confirm.kind === "clear-inbox" ? "Clear inbox" : "Remove mailbox"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

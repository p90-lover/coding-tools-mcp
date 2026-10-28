import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  EmailMailbox,
  EmailMessage,
  EmailMessageSummary,
  EmailStatus,
  LauncherApi,
} from "../types";
import { Icon } from "../icons";
import "./email.css";
import { pageHidden } from "./page-visibility";

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
const ADDRESS_PAGE = 50;
const NEW_MAIL_POLL_MS = 20_000;
const WAITING_POLL_MS = 5_000;
const SEARCH_DEBOUNCE_MS = 250;
const PREFETCH_DELAY_MS = 150;
const MESSAGE_CACHE_LIMIT = 60;
// The Worker's own rule for an address name (this app creates names without its prefix).
const ADDRESS_NAME_RE = /^[a-z0-9._-]{1,64}$/;

// The Worker stores D1 CURRENT_TIMESTAMP: UTC written as "YYYY-MM-DD HH:MM:SS" with no zone.
// Chromium would read that as *local* time, so pin it to UTC before converting to Hong Kong time.
const HONG_KONG_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const HONG_KONG_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "numeric", month: "short" });

function parseWorkerTime(value: string | null): Date | null {
  if (!value) return null;
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
  const date = new Date(zoneless ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatHongKongTime(value: string | null): string {
  const date = parseWorkerTime(value);
  return date ? `${HONG_KONG_TIME.format(date)} HKT` : value ?? "";
}

function shortTime(value: string | null, now: number): string {
  const date = parseWorkerTime(value);
  if (!date) return "";
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return HONG_KONG_DAY.format(date);
}

/** "ChatGPT <noreply@x>" -> "ChatGPT"; a bare address stays as it is. */
function senderName(from: string | null): string {
  if (!from) return "(unknown sender)";
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return named ? named[1] : from.replace(/[<>]/g, "");
}

// The code a sign-up or login mail carries, so it can be copied without opening the mail. Only in a
// mail that talks about a code, and never a year (so "© 2026" in a footer is not one).
const CODE_WORDS = /\b(code|verif\w*|otp|one[- ]time|passcode|pin)\b|驗證|验证|認証|確認碼|确认码/i;
function verificationCode(...parts: (string | null | undefined)[]): string | null {
  const text = parts.filter(Boolean).join("\n").slice(0, 6000);
  if (!CODE_WORDS.test(text)) return null;
  for (const match of text.matchAll(/(?<![\d#-])(\d{4,8})(?![\d-])/g)) {
    if (!/^(19|20)\d{2}$/.test(match[1])) return match[1];
  }
  return null;
}

// Fold the newest page into what's loaded. If none of it overlaps, more than a page of mail
// arrived since the last look — restart from the top rather than leave a silent gap. The Worker
// lists newest (highest id) first, so a loaded row inside the page's id range that the page lacks
// was deleted (here or by another client) and goes too.
function mergeNewest(current: EmailMessageSummary[], newest: EmailMessageSummary[]): EmailMessageSummary[] {
  if (!current.length) return newest;
  const known = new Set(current.map((m) => m.id));
  if (!newest.some((m) => known.has(m.id))) return newest;
  const onPage = new Set(newest.map((m) => m.id));
  const oldest = Math.min(...onPage);
  return [...newest, ...current.filter((m) => m.id < oldest && !onPage.has(m.id))];
}

// The email preview is the one place untrusted remote HTML enters the app. It renders in a
// sandboxed iframe (no scripts, forms, same-origin, or top navigation) with a CSP that blocks
// every network fetch, so tracking pixels and remote resources never load and the content can
// never reach a launcher:* channel. The HTML is already sanitized in the main process.
// Links are the one way out: <base target="_blank"> plus sandbox allow-popups turns a click into
// a window-open request, which the main window's open handler denies and hands to the system
// browser (http/https only). Without allow-scripts nothing can open a window without a click.
const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;";
const PREVIEW_SANDBOX = "allow-popups";

function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`
    + `<base target="_blank">`
    // Mail HTML is written for a white page with dark text (an iframe paints white anyway), so it
    // reads as paper: light-grey text on that white was unreadable.
    + `<style>html{color-scheme:light;background:#fff}body{font:14px/1.55 system-ui,sans-serif;color:#1f2328;margin:0;padding:18px 20px;overflow-wrap:anywhere}`
    + `a{color:#0969da;cursor:pointer}img{max-width:100%;height:auto}</style></head>`
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

// Each Worker call takes most of a second (it returns every row's raw mail), so what was loaded is
// kept for the app's run: going back to a list or a mail shows it at once and refreshes underneath.
// Memory only, per Worker origin; nothing is written to disk.
// Message ids are only unique within one Worker, so a reply that started before a switch to
// another Worker (generation bump) must not land in the new one's cache or reader.
const cache = {
  origin: null as string | null,
  generation: 0,
  lists: new Map<string, { messages: EmailMessageSummary[]; count: number }>(),
  messages: new Map<number, EmailMessage>(),
  loading: new Map<number, Promise<EmailMessage | null>>(),
};

function resetCacheFor(origin: string | null) {
  if (cache.origin !== origin) {
    cache.origin = origin;
    cache.generation += 1;
    cache.lists.clear();
    cache.messages.clear();
    cache.loading.clear();
  }
}

/** Resolves to null, not to another Worker's mail, when the Worker changed while it loaded. */
function fetchMessage(api: LauncherApi, id: number): Promise<EmailMessage | null> {
  const known = cache.messages.get(id);
  if (known) return Promise.resolve(known);
  const pending = cache.loading.get(id);
  if (pending) return pending;
  const generation = cache.generation;
  const request = api.getEmailMessage({ id }).then(({ message }) => {
    if (generation !== cache.generation) return null;
    if (message) {
      cache.messages.set(id, message);
      if (cache.messages.size > MESSAGE_CACHE_LIMIT) cache.messages.delete(cache.messages.keys().next().value!);
    }
    return message;
  }).finally(() => {
    if (cache.loading.get(id) === request) cache.loading.delete(id);
  });
  cache.loading.set(id, request);
  return request;
}

/** Drops deleted mail from every cached list (All mail and each address that showed it). */
function forgetMessage(id: number) {
  cache.messages.delete(id);
  for (const [key, list] of cache.lists) {
    if (!list.messages.some((m) => m.id === id)) continue;
    cache.lists.set(key, { messages: list.messages.filter((m) => m.id !== id), count: Math.max(0, list.count - 1) });
  }
}

/** Drops cached lists that showed an address's mail: its own list and All mail. */
function forgetAddress(address: string) {
  cache.lists.delete(address.toLowerCase());
  cache.lists.delete("*");
}

/** Calls `onVisible` when the returned element scrolls near view: the list's next page. */
function useSentinel(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLLIElement | null>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current();
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  return ref;
}

// Copy and delete have no glyph in the app's icon set; these follow its 24-unit, 1.8-stroke style.
const Glyph = ({ d }: { d: string }) => (
  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="15"><path d={d} /></svg>
);
const COPY = "M9 9h10v10H9zM5 15V5h10";
const TRASH = "M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13";

type View = { kind: "all" } | { kind: "address"; address: string; mailbox: EmailMailbox | null };
const viewKey = (view: View) => (view.kind === "all" ? "*" : view.address.toLowerCase());

type Confirm =
  | { kind: "delete-message"; id: number; subject: string }
  | { kind: "clear-inbox"; mailbox: EmailMailbox }
  | { kind: "remove-mailbox"; mailbox: EmailMailbox };

function randomName(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function EmailSurfaceInner({ api, setError }: { api: LauncherApi; setError: (e: string | null) => void }) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [adminAuth, setAdminAuth] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pane, setPane] = useState<"rail" | "list" | "message">("list");
  const [now, setNow] = useState(() => Date.now());

  // Addresses: searched on the Worker, paged as the rail scrolls.
  const [addresses, setAddresses] = useState<EmailMailbox[]>([]);
  const [addressCount, setAddressCount] = useState(0);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressesLoading, setAddressesLoading] = useState(false);
  const addressToken = useRef(0);

  // Mail in the chosen view.
  const [view, setView] = useState<View>({ kind: "all" });
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const listToken = useRef(0);

  // The open mail.
  const [openId, setOpenId] = useState<number | null>(null);
  const [openMessage, setOpenMessage] = useState<EmailMessage | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"html" | "text">("html");
  const openRef = useRef<number | null>(null);
  const prefetchTimer = useRef<number | null>(null);

  resetCacheFor(status?.origin ?? null);
  const { readIds, markRead } = useReadIds(status?.origin ?? null);
  const domains = status?.capabilities?.domains ?? [];

  const act = useCallback(async (label: string, action: () => Promise<void>) => {
    setPending(label);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }, [setError]);

  const flash = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 1800);
  }, []);

  const copy = useCallback((text: string, what = text) => {
    void navigator.clipboard.writeText(text).then(() => flash(`Copied ${what}`), () => flash("Couldn't copy"));
  }, [flash]);

  const loadStatus = useCallback(() => {
    // Guard against a bridge that predates the email methods: never let this throw
    // synchronously inside the effect (that would unmount the tree and blank the app).
    try {
      if (typeof api.emailStatus !== "function") throw new Error("This build doesn't support Email. Update Coding Tools.");
      void Promise.resolve(api.emailStatus())
        .then((next) => { setStatus(next); setLoadError(null); })
        .catch((cause) => setLoadError(cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(loadStatus, [loadStatus]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // --- addresses -------------------------------------------------------------------------

  const loadAddresses = useCallback(async (query: string, offset: number) => {
    const token = offset === 0 ? ++addressToken.current : addressToken.current;
    setAddressesLoading(true);
    try {
      const { mailboxes, count } = await api.listEmailMailboxes({ limit: ADDRESS_PAGE, offset, query: query || undefined });
      if (token !== addressToken.current) return;
      if (offset === 0) setAddressCount(count);
      setAddresses((current) => {
        if (offset === 0) return mailboxes;
        const known = new Set(current.map((m) => m.id));
        return [...current, ...mailboxes.filter((m) => !known.has(m.id))];
      });
    } catch (cause) {
      if (token === addressToken.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === addressToken.current) setAddressesLoading(false);
    }
  }, [api, setError]);

  useEffect(() => {
    if (!status?.configured) return;
    const timer = window.setTimeout(() => void loadAddresses(addressQuery.trim(), 0), addressQuery ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [status?.configured, addressQuery, loadAddresses]);

  const moreAddresses = addresses.length < addressCount;
  const addressSentinel = useSentinel(() => {
    if (!addressesLoading && moreAddresses) void loadAddresses(addressQuery.trim(), addresses.length);
  }, moreAddresses);

  // What was typed, read as an address on one of the Worker's domains that isn't there yet:
  // offered as a row that creates it ("capture") and opens its inbox.
  const capture = useMemo(() => {
    const typed = addressQuery.trim().toLowerCase();
    if (!typed) return null;
    const [name, typedDomain] = typed.includes("@") ? typed.split("@", 2) : [typed, ""];
    const domain = typedDomain ? domains.find((d) => d.toLowerCase() === typedDomain) : domains[0];
    if (!domain || !ADDRESS_NAME_RE.test(name)) return null;
    const address = `${name}@${domain}`;
    return addresses.some((m) => m.address.toLowerCase() === address) ? null : { name, domain, address };
  }, [addressQuery, addresses, domains]);

  const createAndOpen = (name: string, domain: string) => act("create", async () => {
    const { address } = await api.createEmailAddress({ name, domain });
    setAddressQuery("");
    setView({ kind: "address", address, mailbox: null });
    setPane("list");
    copy(address);
    await loadAddresses("", 0);
  });

  // --- mail ------------------------------------------------------------------------------

  const viewAddress = view.kind === "address" ? view.address : undefined;
  const key = viewKey(view);

  const loadList = useCallback(async (offset: number) => {
    const token = offset === 0 ? ++listToken.current : listToken.current;
    setListLoading(true);
    setListError(null);
    try {
      const { messages: page, count } = await api.listEmailMessages({ address: viewAddress, limit: PAGE_SIZE, offset });
      if (token !== listToken.current) return; // a newer view won; drop this stale page
      setMessages((current) => {
        // Page one folds into the cached rows (or replaces them when nothing overlaps); later pages
        // append, skipping rows that new mail pushed down into them.
        const known = new Set(current.map((m) => m.id));
        const next = offset === 0 ? mergeNewest(current, page) : [...current, ...page.filter((m) => !known.has(m.id))];
        // The Worker computes the total only for offset 0 and reports 0 on later pages.
        const total = offset === 0 ? count : undefined;
        cache.lists.set(key, { messages: next, count: total ?? cache.lists.get(key)?.count ?? next.length });
        return next;
      });
      if (offset === 0) setMessageCount(count);
    } catch (cause) {
      if (token === listToken.current) setListError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === listToken.current) setListLoading(false);
    }
  }, [api, viewAddress, key]);

  // A new view shows its cached rows at once (if any) while page one loads.
  useEffect(() => {
    if (!status?.configured) return;
    const cached = cache.lists.get(key);
    setMessages(cached?.messages ?? []);
    setMessageCount(cached?.count ?? 0);
    setFilter("");
    void loadList(0);
  }, [status?.configured, key, loadList]);

  // Quietly pick up new mail while the page is visible: every few seconds while an address has no
  // mail yet (one just captured is usually waiting for a sign-up code), else every 20 s.
  const waitingForMail = view.kind === "address" && messages.length === 0;
  useEffect(() => {
    if (!status?.configured) return;
    const timer = setInterval(() => {
      if (pageHidden()) return;
      const token = listToken.current;
      void api.listEmailMessages({ address: viewAddress, limit: PAGE_SIZE, offset: 0 })
        .then(({ messages: newest, count }) => {
          if (token !== listToken.current) return;
          setMessageCount(count);
          setMessages((current) => {
            const next = mergeNewest(current, newest);
            cache.lists.set(key, { messages: next, count });
            return next;
          });
        })
        .catch(() => {});
    }, waitingForMail ? WAITING_POLL_MS : NEW_MAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [api, status?.configured, viewAddress, key, waitingForMail]);

  const moreMessages = messages.length < messageCount;
  const messageSentinel = useSentinel(() => {
    if (!listLoading && moreMessages) void loadList(messages.length);
  }, moreMessages && !filter);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((m) => [m.from, m.subject, m.preview, m.mailbox].some((f) => f?.toLowerCase().includes(needle)));
  }, [messages, filter]);

  const showMessage = (message: EmailMessage | null) => {
    setOpenMessage(message);
    setPreviewMode(message?.html ? "html" : "text");
  };

  const openById = (id: number) => {
    openRef.current = id;
    setOpenId(id);
    setOpenError(null);
    setPane("message");
    markRead(id);
    const cached = cache.messages.get(id);
    showMessage(cached ?? null);
    if (cached) return;
    void fetchMessage(api, id)
      .then((message) => {
        if (openRef.current !== id) return;
        if (message) showMessage(message);
        else setOpenError("This mail is no longer on the Worker.");
      })
      .catch((cause) => { if (openRef.current === id) setOpenError(cause instanceof Error ? cause.message : String(cause)); });
  };

  // Hovering a row starts loading that mail, so opening it is usually instant.
  const prefetch = (id: number) => {
    if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = window.setTimeout(() => { void fetchMessage(api, id).catch(() => {}); }, PREFETCH_DELAY_MS);
  };

  const runConfirm = () => act("confirm", async () => {
    if (!confirm) return;
    if (confirm.kind === "delete-message") {
      await api.deleteEmailMessage({ id: confirm.id });
      forgetMessage(confirm.id);
      if (openId === confirm.id) { openRef.current = null; setOpenId(null); setOpenMessage(null); setPane("list"); }
      setMessages((current) => current.filter((m) => m.id !== confirm.id));
      setMessageCount((count) => Math.max(0, count - 1));
    } else if (confirm.kind === "clear-inbox") {
      await api.clearEmailInbox({ id: confirm.mailbox.id });
      forgetAddress(confirm.mailbox.address);
      setMessages([]);
      setMessageCount(0);
    } else {
      await api.removeEmailMailbox({ id: confirm.mailbox.id });
      forgetAddress(confirm.mailbox.address);
      setView({ kind: "all" });
      await loadAddresses(addressQuery.trim(), 0);
    }
    setConfirm(null);
  });

  const choose = (next: View) => {
    setView(next);
    openRef.current = null;
    setOpenId(null);
    setOpenMessage(null);
    setPane("list");
  };

  // --- screens ---------------------------------------------------------------------------

  if (loadError) {
    return (
      <div className="email-surface email-connect">
        <div className="email-connect-card">
          <Icon name="mail" width={28} height={28} />
          <h1>Email couldn’t load</h1>
          <p className="email-warn">{loadError}</p>
          <button className="email-primary" onClick={loadStatus}>Retry</button>
        </div>
      </div>
    );
  }
  if (!status) return <div className="email-surface email-loading"><span className="email-spinner" /></div>;

  if (!status.configured) {
    return (
      <div className="email-surface email-connect">
        <form className="email-connect-card" onSubmit={(event) => {
          event.preventDefault();
          void act("connect", async () => { setStatus(await api.connectEmail({ origin: origin.trim(), adminAuth })); setAdminAuth(""); });
        }}>
          <Icon name="mail" width={28} height={28} />
          <h1>Connect your mail Worker</h1>
          {!status.encryptionAvailable ? (
            <p className="email-warn">OS encryption isn't available, so the credential can't be stored safely.</p>
          ) : null}
          <input value={origin} placeholder="https://mail-api.example.com" aria-label="Mail API origin"
            onChange={(e) => setOrigin(e.target.value)} spellCheck={false} />
          <input type="password" value={adminAuth} autoComplete="off" placeholder="Admin password (x-admin-auth)" aria-label="Admin password"
            onChange={(e) => setAdminAuth(e.target.value)} />
          <button className="email-primary" type="submit" disabled={pending !== null || !origin || !adminAuth || !status.encryptionAvailable}>
            {pending === "connect" ? "Verifying…" : "Connect"}
          </button>
        </form>
      </div>
    );
  }

  const selectedMailbox = view.kind === "address"
    ? view.mailbox ?? addresses.find((m) => m.address.toLowerCase() === view.address.toLowerCase()) ?? null
    : null;
  const openCode = openMessage ? verificationCode(openMessage.subject, openMessage.text) : null;

  return (
    <div className={`email-surface pane-${pane}`}>
      <aside className="email-rail">
        <div className="email-rail-head">
          <div className="email-search">
            <input value={addressQuery} placeholder="Find or capture an address" aria-label="Find or capture an address"
              spellCheck={false} onChange={(e) => setAddressQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && capture) void createAndOpen(capture.name, capture.domain);
                if (e.key === "Escape") setAddressQuery("");
              }} />
            {addressQuery ? <button className="email-icon" aria-label="Clear search" onClick={() => setAddressQuery("")}><Icon name="x" width={14} height={14} /></button> : null}
          </div>
          <button className="email-icon" title="New random address" aria-label="New random address" disabled={pending !== null || !domains[0]}
            onClick={() => void createAndOpen(randomName(), domains[0])}><Icon name="plus" width={16} height={16} /></button>
        </div>

        <ul className="email-addresses">
          {capture ? (
            <li className="email-capture">
              <button disabled={pending !== null} onClick={() => void createAndOpen(capture.name, capture.domain)}>
                <Icon name="plus" width={14} height={14} />
                <span><strong>{pending === "create" ? "Capturing…" : "Capture"}</strong> {capture.address}</span>
              </button>
            </li>
          ) : null}
          {!addressQuery ? (
            <li className={view.kind === "all" ? "is-on" : ""}>
              <button onClick={() => choose({ kind: "all" })}>
                <Icon name="mail" width={14} height={14} /><span className="email-addr">All mail</span>
                <em>{addressCount ? `${addressCount} addresses` : ""}</em>
              </button>
            </li>
          ) : null}
          {addresses.map((mailbox) => {
            const [local, domain] = mailbox.address.split("@");
            const on = view.kind === "address" && view.address.toLowerCase() === mailbox.address.toLowerCase();
            return (
              <li key={mailbox.id} className={on ? "is-on" : ""}>
                <button onClick={() => choose({ kind: "address", address: mailbox.address, mailbox })} title={mailbox.address}>
                  <span className="email-addr">{local}<i>@{domain}</i></span>
                  {mailbox.mailCount ? <em>{mailbox.mailCount}</em> : null}
                </button>
              </li>
            );
          })}
          {addressesLoading && !addresses.length ? [0, 1, 2, 3, 4].map((i) => <li key={`s${i}`} className="email-skeleton" />) : null}
          {!addressesLoading && addressQuery && !addresses.length && !capture ? <li className="email-empty">No address matches</li> : null}
          {moreAddresses ? <li ref={addressSentinel} className="email-more">{addressesLoading ? <span className="email-spinner" /> : null}</li> : null}
        </ul>
      </aside>

      <section className="email-list">
        <header className="email-list-head">
          <button className="email-icon email-only-narrow" aria-label="Addresses" onClick={() => setPane("rail")}><Icon name="sidebar" width={16} height={16} /></button>
          <div className="email-list-title">
            <h2 title={view.kind === "address" ? view.address : undefined}>{view.kind === "all" ? "All mail" : view.address}</h2>
            <span>{messageCount ? `${messageCount} ${messageCount === 1 ? "mail" : "mails"}` : listLoading ? "" : "No mail yet"}</span>
          </div>
          {view.kind === "address" ? (
            <button className="email-icon" title="Copy address" aria-label="Copy address" onClick={() => copy(view.address)}><Glyph d={COPY} /></button>
          ) : null}
          <button className={`email-icon${listLoading ? " is-spinning" : ""}`} title="Refresh" aria-label="Refresh" onClick={() => void loadList(0)}><Icon name="reload" width={15} height={15} /></button>
          {selectedMailbox ? (
            <details className="email-menu">
              <summary className="email-icon" aria-label="More"><Icon name="chevronDown" width={15} height={15} /></summary>
              <div>
                <button onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; setConfirm({ kind: "clear-inbox", mailbox: selectedMailbox }); }}>Clear inbox</button>
                <button className="email-danger" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; setConfirm({ kind: "remove-mailbox", mailbox: selectedMailbox }); }}>Remove address</button>
              </div>
            </details>
          ) : null}
        </header>
        <div className="email-filter">
          <input value={filter} placeholder="Filter loaded mail" aria-label="Filter loaded mail" onChange={(e) => setFilter(e.target.value)} />
        </div>
        {listError ? (
          <div className="email-error-row">{listError}<button onClick={() => void loadList(0)}>Retry</button></div>
        ) : null}
        <ul className="email-messages">
          {shown.map((m, index) => {
            const code = verificationCode(m.subject, m.preview);
            const unread = !readIds.has(m.id);
            return (
              <li key={m.id} className={`${openId === m.id ? "is-open" : ""}${unread ? " is-unread" : ""}${code ? " has-code" : ""}`}
                style={{ "--i": Math.min(index, 12) } as CSSProperties}>
                <button onClick={() => openById(m.id)} onMouseEnter={() => prefetch(m.id)}
                  title={[m.from, formatHongKongTime(m.receivedAt)].filter(Boolean).join("\n") || undefined}>
                  <div className="email-row-top">
                    <span className="email-dot" aria-label={unread ? "Unread" : "Read"} />
                    <span className="email-from">{senderName(m.from)}</span>
                    <time>{shortTime(m.receivedAt, now)}</time>
                  </div>
                  <div className="email-subject">{m.subject ?? "(no subject)"}</div>
                  {m.preview ? <div className="email-preview">{m.preview}</div> : null}
                  {view.kind === "all" && m.mailbox ? <div className="email-to">{m.mailbox}</div> : null}
                </button>
                {code ? (
                  <button className="email-code" title="Copy code" onClick={() => copy(code, "code")}>{code}</button>
                ) : null}
              </li>
            );
          })}
          {listLoading && !messages.length ? [0, 1, 2, 3, 4, 5].map((i) => <li key={`s${i}`} className="email-skeleton is-tall" />) : null}
          {!listLoading && !listError && !shown.length ? (
            <li className="email-empty">{filter ? "Nothing matches the filter" : view.kind === "address" ? "Waiting for mail…" : "No mail yet"}</li>
          ) : null}
          {moreMessages && !filter ? <li ref={messageSentinel} className="email-more">{listLoading ? <span className="email-spinner" /> : null}</li> : null}
        </ul>
      </section>

      <section className="email-reader">
        {openId === null ? (
          <div className="email-empty email-reader-empty"><Icon name="mail" width={30} height={30} /></div>
        ) : !openMessage ? (
          // Back stays reachable here too: on a narrow window this pane is the only one shown.
          <div className="email-reader-loading">
            <button className="email-icon email-only-narrow" aria-label="Back" onClick={() => setPane("list")}><Icon name="back" width={16} height={16} /></button>
            {openError ? (
              <div className="email-error-row">{openError}<button onClick={() => openById(openId)}>Retry</button></div>
            ) : (
              <><div className="email-skeleton is-title" /><div className="email-skeleton" /><div className="email-skeleton is-block" /></>
            )}
          </div>
        ) : (
          <article key={openMessage.id} className="email-article">
            <header className="email-article-head">
              <button className="email-icon email-only-narrow" aria-label="Back" onClick={() => setPane("list")}><Icon name="back" width={16} height={16} /></button>
              <h1>{openMessage.subject ?? "(no subject)"}</h1>
              <div className="email-article-actions">
                {openMessage.html && openMessage.text ? (
                  <div className="email-modes">
                    <button className={previewMode === "html" ? "is-on" : ""} onClick={() => setPreviewMode("html")}>HTML</button>
                    <button className={previewMode === "text" ? "is-on" : ""} onClick={() => setPreviewMode("text")}>Text</button>
                  </div>
                ) : null}
                <button className="email-icon email-danger" title="Delete" aria-label="Delete" disabled={pending !== null}
                  onClick={() => setConfirm({ kind: "delete-message", id: openMessage.id, subject: openMessage.subject ?? "(no subject)" })}><Glyph d={TRASH} /></button>
              </div>
            </header>
            <div className="email-meta">
              <span className="email-meta-from">{openMessage.from ?? "(unknown sender)"}</span>
              <span>to {openMessage.to ?? "(unknown)"}</span>
              <time>{formatHongKongTime(openMessage.receivedAt)}</time>
            </div>
            {openCode ? (
              <button className="email-code is-big" onClick={() => copy(openCode, "code")}>{openCode}<small>Copy</small></button>
            ) : null}
            {previewMode === "html" && openMessage.html ? (
              <iframe className="email-html" sandbox={PREVIEW_SANDBOX} title="Email content" srcDoc={previewDocument(openMessage.html)} />
            ) : (
              <pre className="email-text">{openMessage.text ?? "(no text content)"}</pre>
            )}
            {openMessage.attachments.length ? (
              <ul className="email-attachments">{openMessage.attachments.map((a, i) => (
                <li key={i}>{a.filename ?? "(unnamed)"}<em>{a.mimeType ?? ""}{a.size != null ? ` · ${a.size} B` : ""}</em></li>
              ))}</ul>
            ) : null}
          </article>
        )}
      </section>

      <footer className="email-status">
        <span>{status.origin}</span>
        {status.capabilities?.version ? <span>{status.capabilities.version}</span> : null}
        <button disabled={pending !== null} onClick={() => void act("disconnect", async () => setStatus(await api.disconnectEmail()))}>Disconnect</button>
      </footer>

      {toast ? <div className="email-toast" role="status">{toast}</div> : null}

      {confirm ? (
        <div className="email-modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="email-modal" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === "delete-message" ? (
              <><h3>Delete this mail?</h3>
                <p>“{confirm.subject}” is deleted from the Worker. This can't be undone.</p></>
            ) : confirm.kind === "clear-inbox" ? (
              <><h3>Clear this inbox?</h3>
                <p>All mail at <strong>{confirm.mailbox.address}</strong> is deleted; the address stays.</p></>
            ) : (
              <><h3>Remove this address?</h3>
                <p><strong>{confirm.mailbox.address}</strong> and all its mail are removed from the Worker, for every client. This can't be undone.</p></>
            )}
            <div className="email-modal-actions">
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button className="email-danger" disabled={pending !== null} onClick={runConfirm}>
                {confirm.kind === "delete-message" ? "Delete" : confirm.kind === "clear-inbox" ? "Clear inbox" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

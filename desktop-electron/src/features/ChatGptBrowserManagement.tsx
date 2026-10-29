import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  BrowserAccount,
  BrowserAccountsStatus,
  CodexThreadAction,
  CodexThreadBinding,
  BrowserState,
  LauncherApi,
  ProviderNetworkSnapshot,
  ProxyProfileRecord,
} from "../types";
import "./chatgpt-browser-management.css";

const CONFIRM_WINDOW_MS = 4_000;
const DECODO_PREFIX = "decodo:";

const accountName = (account: BrowserAccount) => account.email ?? account.label;
const proxyAddress = (profile: ProxyProfileRecord) => `${profile.endpoint.host}:${profile.endpoint.port}`;

/**
 * ChatGPT browser management: the Browser tab's accounts in one list (which one is in use, its tabs,
 * the proxy bound to it) and Decodo's sticky proxies to bind, one per account. The account in use is
 * also the one Codex's WebGPT chats run on, so main refuses changes to it while a chat turn runs.
 */
export function ChatGptBrowserManagement({ api, browser, setError }: {
  api: LauncherApi;
  browser: BrowserState | null;
  setError: (error: string | null) => void;
}) {
  const [accounts, setAccounts] = useState<BrowserAccountsStatus | null>(null);
  const [network, setNetwork] = useState<ProviderNetworkSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void api.browserAccounts().then(next => { if (live) setAccounts(next); }).catch(() => {});
    void api.providerSnapshot().then(next => { if (live) setNetwork(next); }).catch(() => {});
    const offAccounts = api.onBrowserAccountsChanged(next => setAccounts(next));
    const offNetwork = api.onProviderNetworkChanged(next => setNetwork(next));
    return () => {
      live = false;
      offAccounts();
      offNetwork();
      window.clearTimeout(confirmTimer.current);
    };
  }, [api]);

  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [setError]);

  const proxies = useMemo(() => (network?.proxyProfiles ?? [])
    .filter(profile => !profile.archivedAt)
    .sort((a, b) => Number(b.id.startsWith(DECODO_PREFIX)) - Number(a.id.startsWith(DECODO_PREFIX)) || a.name.localeCompare(b.name)),
  [network]);
  const proxyById = useMemo(() => new Map(proxies.map(profile => [profile.id, profile])), [proxies]);
  const [threads, setThreads] = useState<CodexThreadBinding[]>([]);
  // Threads change when turns start and end: re-read them whenever a tab's status changes.
  const tabSignature = (browser?.tabs ?? []).map(tab => `${tab.id}:${tab.status}`).join(",");
  useEffect(() => {
    let live = true;
    void api.codexThreads().then(next => { if (live) setThreads(next.threads); }).catch(() => {});
    return () => { live = false; };
  }, [api, tabSignature, accounts?.accounts.length]);
  const sessionsOf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) counts.set(thread.accountId, (counts.get(thread.accountId) ?? 0) + 1);
    return counts;
  }, [threads]);

  const holderOf = useMemo(() => new Map((accounts?.accounts ?? [])
    .filter(account => account.proxyProfileId)
    .map(account => [account.proxyProfileId!, account])), [accounts]);

  const openTabs = (browser?.tabs ?? []).filter(tab => tab.id !== "home");
  const runningTabs = openTabs.filter(tab => tab.status === "running").length;
  const chatRunning = runningTabs > 0 || browser?.status === "running";
  const locked = busy !== null || accounts?.switching === true;
  const decodoFree = proxies.filter(profile => profile.id.startsWith(DECODO_PREFIX) && profile.enabled && !holderOf.has(profile.id)).length;
  const unbound = (accounts?.accounts ?? []).filter(account => !account.proxyProfileId).length;

  const remove = (id: string) => {
    if (confirmRemove !== id) {
      setConfirmRemove(id);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmRemove(null), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmRemove(null);
    void run(`remove:${id}`, () => api.removeBrowserAccount(id));
  };

  if (!accounts) return <section className="cbm"><p className="cbm-muted">Loading accounts…</p></section>;
  return (
    <section className="cbm">
      <header className="cbm-header">
        <div>
          <h1>ChatGPT browser management</h1>
          <p className="cbm-muted">Each account keeps its own sign-in and proxy. Codex's WebGPT chats run on the account in use.</p>
        </div>
        <button
          className="cbm-button"
          disabled={locked || accounts.accounts.length >= accounts.maxAccounts}
          onClick={() => void run("add", () => api.addBrowserAccount())}
          type="button"
        >
          Add account
        </button>
      </header>

      <div className="cbm-list" role="table" aria-label="ChatGPT accounts">
        <div className="cbm-row cbm-row-head" role="row">
          <span role="columnheader">Account</span>
          <span role="columnheader">Tabs</span>
          <span role="columnheader">Proxy</span>
          <span role="columnheader" aria-label="Actions" />
        </div>
        {accounts.accounts.map(account => {
          const inUse = account.id === accounts.activeId;
          const proxy = account.proxyProfileId ? proxyById.get(account.proxyProfileId) : undefined;
          const proxyMissing = Boolean(account.proxyProfileId) && (!proxy || !proxy.enabled);
          return (
            <div className={`cbm-row${inUse ? " is-active" : ""}`} key={account.id} role="row">
              <div className="cbm-account" role="cell">
                <i className={`cbm-dot${inUse ? (browser?.authenticated ? " is-on" : " is-warn") : ""}`} aria-hidden />
                <div>
                  <strong title={account.label}>{accountName(account)}</strong>
                  <span className="cbm-muted">
                    {inUse ? (browser?.authenticated ? "In use · signed in" : "In use · not signed in") : "Not in use"}
                    {sessionsOf.get(account.id) ? ` · ${sessionsOf.get(account.id)} session${sessionsOf.get(account.id) === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
              </div>
              <div role="cell" className="cbm-tabs">
                {inUse
                  ? <><strong>{openTabs.length}</strong><span className="cbm-muted">{runningTabs ? `${runningTabs} running` : "open"}</span></>
                  : <span className="cbm-muted">—</span>}
              </div>
              <div role="cell" className="cbm-proxy">
                <select
                  aria-label={`Proxy for ${accountName(account)}`}
                  disabled={locked || (inUse && chatRunning)}
                  onChange={event => void run(`proxy:${account.id}`, () => api.setBrowserAccountProxy(account.id, event.target.value || null))}
                  value={account.proxyProfileId ?? ""}
                >
                  <option value="">Global Routing</option>
                  {proxyMissing ? <option value={account.proxyProfileId!}>Missing proxy</option> : null}
                  {proxies.map(profile => {
                    const holder = holderOf.get(profile.id);
                    const elsewhere = holder && holder.id !== account.id;
                    return (
                      <option disabled={Boolean(elsewhere) || !profile.enabled} key={profile.id} value={profile.id}>
                        {profile.name} · {proxyAddress(profile)}{elsewhere ? ` (${accountName(holder)})` : ""}
                      </option>
                    );
                  })}
                </select>
                <span className={`cbm-muted${proxyMissing || proxy?.lastError ? " is-error" : ""}`}>
                  {proxyMissing
                    ? "Bound proxy is gone; using Global Routing"
                    : proxy
                      ? proxy.lastError ? proxy.lastError : proxy.latencyMs !== undefined ? `${proxy.latencyMs} ms` : "Not checked"
                      : "No proxy of its own"}
                </span>
              </div>
              <div role="cell" className="cbm-actions">
                {proxy ? (
                  <button
                    className="cbm-link"
                    disabled={locked}
                    onClick={() => void run(`check:${proxy.id}`, () => api.testProxyProfile(proxy.id))}
                    type="button"
                  >
                    {busy === `check:${proxy.id}` ? "Checking…" : "Check"}
                  </button>
                ) : null}
                {!inUse ? (
                  <button
                    className="cbm-link"
                    disabled={locked || chatRunning}
                    onClick={() => void run(`use:${account.id}`, () => api.switchBrowserAccount(account.id))}
                    type="button"
                  >
                    {busy === `use:${account.id}` ? "Switching…" : "Use"}
                  </button>
                ) : null}
                {accounts.accounts.length > 1 ? (
                  <button
                    className={`cbm-link${confirmRemove === account.id ? " is-danger" : ""}`}
                    disabled={locked || (inUse && chatRunning)}
                    onClick={() => remove(account.id)}
                    type="button"
                  >
                    {confirmRemove === account.id ? "Click again" : "Remove"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {unbound > 0 && decodoFree > 0 ? (
        <div className="cbm-hint">
          <span>{unbound === 1 ? "1 account has" : `${unbound} accounts have`} no proxy of its own.</span>
          <button
            className="cbm-link"
            disabled={locked}
            onClick={() => void run("assign", () => api.assignBrowserAccountProxies())}
            type="button"
          >
            Give each one its own Decodo proxy
          </button>
        </div>
      ) : null}

      <SessionsPanel
        accounts={accounts.accounts}
        busy={busy}
        locked={locked}
        onAction={(input) => run(`thread:${input.threadId}`, async () => setThreads((await api.codexThreadAction(input)).threads))}
        threads={threads}
      />

      <DecodoPanel api={api} network={network} locked={locked} run={run} busy={busy} />
    </section>
  );
}

/**
 * Codex sessions and the account each one runs on. A session keeps its account and reopens its saved
 * chat there; archiving or deleting it in Codex does the same to that chat (and so do these buttons).
 */
function SessionsPanel({ accounts, threads, locked, busy, onAction }: {
  accounts: BrowserAccount[];
  threads: CodexThreadBinding[];
  locked: boolean;
  busy: string | null;
  onAction: (input: CodexThreadAction) => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);
  const accountLabel = (id: string) => {
    const account = accounts.find(entry => entry.id === id);
    return account ? accountName(account) : "Removed account";
  };
  const remove = (threadId: string) => {
    if (confirmDelete !== threadId) {
      setConfirmDelete(threadId);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmDelete(null), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmDelete(null);
    void onAction({ threadId, action: "delete" });
  };

  return (
    <section className="cbm-sessions" aria-label="Codex sessions">
      <div>
        <h2>Codex sessions</h2>
        <p className="cbm-muted">
          {threads.length
            ? "Each session stays on its account and reopens its own chat there."
            : "A Codex session joins the account in use on its first turn."}
        </p>
      </div>
      {threads.length ? (
        <div className="cbm-list cbm-session-list" role="table" aria-label="Codex sessions">
          {threads.map(thread => {
            const archived = thread.chats.length > 0 && thread.chats.every(chat => chat.archived);
            const disabled = locked || thread.running;
            return (
              <div className="cbm-row" key={thread.threadId} role="row">
                <div className="cbm-account" role="cell">
                  <i className={`cbm-dot${thread.running ? " is-on" : ""}`} aria-hidden />
                  <div>
                    <strong title={thread.threadId}>{thread.title ?? `Session ${thread.threadId.slice(0, 8)}`}</strong>
                    <span className="cbm-muted">
                      {thread.running ? "Running" : `Last used ${new Date(thread.lastUsedAt).toLocaleString()}`}
                    </span>
                  </div>
                </div>
                <div className="cbm-tabs" role="cell">
                  <strong>{thread.chats.length}</strong>
                  <span className="cbm-muted">{archived ? "archived" : thread.chats.length === 1 ? "chat" : "chats"}</span>
                </div>
                <div className="cbm-proxy" role="cell">
                  <select
                    aria-label={`Account for ${thread.title ?? thread.threadId}`}
                    disabled={disabled}
                    onChange={event => void onAction({ threadId: thread.threadId, action: "move", accountId: event.target.value })}
                    value={thread.accountId}
                  >
                    {accounts.some(entry => entry.id === thread.accountId)
                      ? null
                      : <option value={thread.accountId}>{accountLabel(thread.accountId)}</option>}
                    {accounts.map(entry => <option key={entry.id} value={entry.id}>{accountName(entry)}</option>)}
                  </select>
                  <span className="cbm-muted">
                    {busy === `thread:${thread.threadId}` ? "Working…" : "Moving starts a new chat on that account"}
                  </span>
                </div>
                <div className="cbm-actions" role="cell">
                  {thread.chats.length ? (
                    <button
                      className="cbm-link"
                      disabled={disabled}
                      onClick={() => void onAction({ threadId: thread.threadId, action: archived ? "unarchive" : "archive" })}
                      type="button"
                    >
                      {archived ? "Unarchive" : "Archive"}
                    </button>
                  ) : null}
                  <button
                    className={`cbm-link${confirmDelete === thread.threadId ? " is-danger" : ""}`}
                    disabled={disabled}
                    onClick={() => thread.chats.length ? remove(thread.threadId) : void onAction({ threadId: thread.threadId, action: "forget" })}
                    title={thread.chats.length ? "Deletes this session's chats on ChatGPT" : "Forgets this session's account"}
                    type="button"
                  >
                    {thread.chats.length ? (confirmDelete === thread.threadId ? "Click again" : "Delete") : "Forget"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function DecodoPanel({ api, network, locked, run, busy }: {
  api: LauncherApi;
  network: ProviderNetworkSnapshot | null;
  locked: boolean;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  busy: string | null;
}) {
  const saved = network?.decodo;
  const [draft, setDraft] = useState({ username: "", password: "", country: "", count: "10", sessionMinutes: "60" });
  useEffect(() => {
    if (!saved) return;
    setDraft(current => ({
      ...current,
      username: saved.username,
      country: saved.country.toUpperCase(),
      count: String(saved.count),
      sessionMinutes: String(saved.sessionMinutes),
    }));
  }, [saved?.username, saved?.country, saved?.count, saved?.sessionMinutes]);
  const decodoCount = (network?.proxyProfiles ?? []).filter(profile => profile.id.startsWith(DECODO_PREFIX) && !profile.archivedAt).length;
  const field = (key: keyof typeof draft) => ({
    value: draft[key],
    onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(current => ({ ...current, [key]: event.target.value })),
  });
  const save = () => api.saveDecodo({
    username: draft.username,
    country: draft.country.trim().toLowerCase(),
    count: Number(draft.count),
    sessionMinutes: Number(draft.sessionMinutes),
    ...(draft.password ? { password: draft.password } : {}),
  });

  return (
    <section className="cbm-decodo" aria-label="Decodo proxies">
      <div className="cbm-decodo-head">
        <div>
          <h2>Decodo proxies</h2>
          <p className="cbm-muted">
            {saved?.lastError
              ? <span className="is-error">{saved.lastError}</span>
              : saved?.lastSyncAt
                ? `${decodoCount} proxies · synced ${new Date(saved.lastSyncAt).toLocaleString()}`
                : "Sticky sessions from your Decodo proxy user, one per account."}
          </p>
        </div>
        <button
          className="cbm-button"
          disabled={locked || !draft.username || (!draft.password && !saved?.hasPassword)}
          onClick={() => void run("decodo-sync", async () => {
            await save();
            setDraft(current => ({ ...current, password: "" }));
            await api.syncDecodo();
          })}
          type="button"
        >
          {busy === "decodo-sync" ? "Syncing…" : "Sync from Decodo"}
        </button>
      </div>
      <div className="cbm-fields">
        <label><span>Proxy username</span><input autoComplete="off" spellCheck={false} {...field("username")} /></label>
        <label>
          <span>Password</span>
          <input autoComplete="new-password" placeholder={saved?.hasPassword ? "Saved" : ""} type="password" {...field("password")} />
        </label>
        <label><span>Country</span><input maxLength={2} placeholder="Any" spellCheck={false} {...field("country")} /></label>
        <label><span>Proxies</span><input inputMode="numeric" {...field("count")} /></label>
        <label><span>Session (min)</span><input inputMode="numeric" {...field("sessionMinutes")} /></label>
      </div>
    </section>
  );
}

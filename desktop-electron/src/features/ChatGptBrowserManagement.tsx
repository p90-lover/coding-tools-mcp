import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  BrowserAccount,
  BrowserAccountsStatus,
  BrowserState,
  CodexThreadAction,
  CodexThreadBinding,
  LauncherApi,
  McpTunnel,
  ProviderNetworkSnapshot,
  ProxyProfileRecord,
} from "../types";
import "./chatgpt-browser-management.css";

const CONFIRM_WINDOW_MS = 4_000;
const DECODO_PREFIX = "decodo:";
// browser-host.cjs: every account's tabs together, and Codex's turns at once (the bridge's cap).
const TOTAL_TAB_CEILING = 15;
const CONCURRENT_TURNS = 5;
const KEEP_FINISHED_TABS_MINUTES = [5, 10, 20, 30, 60];

const accountName = (account: BrowserAccount) => account.email ?? account.label;
const proxyAddress = (profile: ProxyProfileRecord) => `${profile.endpoint.host}:${profile.endpoint.port}`;

function ago(at: number | null | undefined) {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

/** What an account's last inspection says its GPT-6 efforts go up to (#662: Plus 6 High, Team/Pro 6 Pro). */
function planText(plan: BrowserAccount["plan"]) {
  if (!plan) return { label: "Not checked", detail: "Checked when the account signs in" };
  if (plan.proAvailable) return { label: "Team or Pro", detail: `Efforts up to 6 Pro · checked ${ago(plan.checkedAt)}` };
  if (plan.solAvailable) return { label: "Plus", detail: `Efforts up to 6 High · checked ${ago(plan.checkedAt)}` };
  return { label: "No GPT-6 Sol", detail: `Checked ${ago(plan.checkedAt)}` };
}

const TUNNEL_TONE: Record<McpTunnel["state"], string> = { ready: "ok", starting: "idle", stopped: "warn", failed: "error" };
const TUNNEL_LABEL: Record<McpTunnel["state"], string> = { ready: "Ready", starting: "Starting", stopped: "Stopped", failed: "Failed" };

function connectorText(connector: BrowserAccount["connector"]) {
  if (!connector) return { tone: "idle", label: "Not used yet", detail: "Shown after a Codex turn uses it" };
  if (connector.error && (connector.errorAt ?? 0) >= (connector.okAt ?? 0)) {
    return { tone: "error", label: "Failed", detail: `${connector.error} · ${ago(connector.errorAt)}` };
  }
  return { tone: "ok", label: "Connected", detail: `Last bound ${ago(connector.okAt)}` };
}

export interface BridgeSetup {
  mcpReady: boolean;
  bridgeReady: boolean;
}

/**
 * ChatGPT browser management: every ChatGPT account the Browser tab holds, with what it is doing
 * (sign-in, plan, connector, proxy, tabs, sessions) and its settings, the Codex sessions bound to
 * them, and Decodo's sticky proxies to bind, one per account.
 */
export function ChatGptBrowserManagement({ api, browser, setup, setError }: {
  api: LauncherApi;
  browser: BrowserState | null;
  setup: BridgeSetup;
  setError: (error: string | null) => void;
}) {
  const [accounts, setAccounts] = useState<BrowserAccountsStatus | null>(null);
  const [network, setNetwork] = useState<ProviderNetworkSnapshot | null>(null);
  const [threads, setThreads] = useState<CodexThreadBinding[]>([]);
  const [tunnels, setTunnels] = useState<McpTunnel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Bulk delete: the accounts ticked on their cards.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    void api.browserAccounts().then(next => { if (live) setAccounts(next); }).catch(() => {});
    void api.providerSnapshot().then(next => { if (live) setNetwork(next); }).catch(() => {});
    void api.mcpTunnels().then(next => { if (live) setTunnels(next); }).catch(() => {});
    const offAccounts = api.onBrowserAccountsChanged(next => setAccounts(next));
    const offNetwork = api.onProviderNetworkChanged(next => setNetwork(next));
    const offTunnels = api.onMcpTunnelsChanged(next => setTunnels(next));
    return () => {
      live = false;
      offAccounts();
      offNetwork();
      offTunnels();
    };
  }, [api]);

  // Sessions change when turns start and end: re-read them whenever a tab's status changes.
  const tabSignature = (browser?.tabs ?? []).map(tab => `${tab.id}:${tab.status}`).join(",");
  useEffect(() => {
    let live = true;
    void api.codexThreads().then(next => { if (live) setThreads(next.threads); }).catch(() => {});
    return () => { live = false; };
  }, [api, tabSignature, accounts?.accounts.length]);

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

  if (!accounts) return <section className="cbm"><p className="cbm-muted">Loading accounts…</p></section>;

  const activeId = accounts.activeId;
  const pages = (browser?.tabs ?? []).filter(tab => tab.id !== "home");
  const tabsOf = (id: string) => pages.filter(tab => (tab.accountId ?? activeId) === id);
  const running = pages.filter(tab => tab.status === "running").length;
  const sessionsOf = (id: string) => threads.filter(thread => thread.accountId === id).length;
  const bound = accounts.accounts.filter(account => account.proxyProfileId).length;
  const decodoCount = proxies.filter(profile => profile.id.startsWith(DECODO_PREFIX)).length;
  const locked = busy !== null || accounts.switching;
  const chatRunning = browser?.status === "running" || running > 0;
  // A ticked account that has since gone (removed elsewhere) no longer counts.
  const ticked = accounts.accounts.filter(account => selected.has(account.id)).map(account => account.id);
  const signedInOf = (account: BrowserAccount) => (account.id === activeId ? browser?.authenticated === true : account.signedIn === true);
  const toggle = (id: string, on: boolean) => setSelected(previous => {
    const next = new Set(previous);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  return (
    <section className="cbm">
      <header className="cbm-header">
        <div>
          <h1>ChatGPT browser management</h1>
          <p className="cbm-muted">Every ChatGPT account the Browser tab holds, what it is doing, and how it runs Codex.</p>
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

      <div className="cbm-stats" role="list" aria-label="Overview">
        <Stat label="Accounts" value={accounts.accounts.length} detail={`${accounts.accounts.filter(a => (a.id === activeId ? browser?.authenticated === true : a.signedIn)).length} signed in`} />
        <Stat label="Tabs open" value={pages.length} detail={`of ${TOTAL_TAB_CEILING} · ${running} running`} />
        <Stat label="Codex sessions" value={threads.length} detail={`${threads.filter(t => t.running).length} running · ${CONCURRENT_TURNS} turns at once`} />
        <Stat
          label="MCP connector"
          value={setup.mcpReady ? "Ready" : "Not set up"}
          tone={setup.mcpReady ? "ok" : "warn"}
          detail={`${1 + tunnels.length} tunnel${tunnels.length ? "s" : ""} · ${setup.bridgeReady ? "Codex bridge set up" : "Codex bridge not set up"}`}
        />
        <Stat label="Proxies" value={`${bound}/${accounts.accounts.length}`} detail={`accounts bound · ${decodoCount} from Decodo`} />
      </div>

      {accounts.accounts.length > 1 ? (
        <BulkRemoveBar
          total={accounts.accounts.length}
          ticked={ticked}
          locked={locked}
          onSelectNotSignedIn={() => setSelected(new Set(accounts.accounts.filter(account => !signedInOf(account)).map(account => account.id)))}
          onClear={() => setSelected(new Set())}
          onRemove={() => void run("remove-many", async () => {
            const result = await api.removeBrowserAccounts(ticked);
            setSelected(new Set(result.failed.map(entry => entry.id)));
            if (result.failed.length) {
              throw new Error(`${result.removed.length} removed; ${result.failed.length} kept: ${result.failed[0].message}`);
            }
          })}
        />
      ) : null}

      <div className="cbm-cards">
        {accounts.accounts.map(account => (
          <AccountCard
            account={account}
            api={api}
            authenticated={browser?.authenticated === true}
            busy={busy}
            chatRunning={chatRunning}
            canRemove={accounts.accounts.length > 1}
            inUse={account.id === activeId}
            key={account.id}
            locked={locked}
            selected={selected.has(account.id)}
            onSelect={accounts.accounts.length > 1 ? (on: boolean) => toggle(account.id, on) : undefined}
            maxTabs={accounts.maxTabsPerAccount}
            mainTunnelReady={setup.mcpReady}
            proxies={proxies}
            holders={accounts.accounts}
            run={run}
            sessions={sessionsOf(account.id)}
            tabs={tabsOf(account.id)}
            tunnel={tunnels.find(entry => entry.accountId === account.id)}
          />
        ))}
      </div>

      <BrowserSettings accounts={accounts} locked={locked} run={run} api={api} />

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
 * Bulk delete: tick accounts on their cards (or every account that is not signed in), then remove
 * them in one action, confirmed by a second click as a single Remove is. The Browser tab keeps at
 * least one account, so all of them ticked cannot be removed.
 */
function BulkRemoveBar({ total, ticked, locked, onSelectNotSignedIn, onClear, onRemove }: {
  total: number;
  ticked: string[];
  locked: boolean;
  onSelectNotSignedIn: () => void;
  onClear: () => void;
  onRemove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const count = ticked.length;
  const all = count >= total;
  const remove = () => {
    if (!confirm) {
      setConfirm(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setConfirm(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(timer.current);
    setConfirm(false);
    onRemove();
  };
  return (
    <div className="cbm-bulk" role="toolbar" aria-label="Remove several accounts">
      <span className="cbm-muted">{count ? `${count} selected` : "Tick accounts to remove several at once"}</span>
      <button className="cbm-link" disabled={locked} onClick={onSelectNotSignedIn} type="button">Select not signed in</button>
      {count ? <button className="cbm-link" disabled={locked} onClick={onClear} type="button">Clear</button> : null}
      <button
        className={`cbm-button cbm-bulk-remove${confirm ? " is-danger" : ""}`}
        disabled={locked || !count || all}
        onClick={remove}
        title={all ? "Keep at least one account: the Browser tab needs one" : undefined}
        type="button"
      >
        {confirm ? `Click again to remove ${count}` : count ? `Remove ${count} selected` : "Remove selected"}
      </button>
    </div>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone?: "ok" | "warn" }) {
  return (
    <div className="cbm-stat" role="listitem">
      <span className="cbm-stat-label">{label}</span>
      <strong className={tone ? `is-${tone}` : undefined}>{value}</strong>
      <span className="cbm-muted">{detail}</span>
    </div>
  );
}

function AccountCard({
  account, api, authenticated, busy, chatRunning, canRemove, inUse, locked, mainTunnelReady, maxTabs, proxies, holders, run, sessions, tabs,
  tunnel, selected = false, onSelect,
}: {
  account: BrowserAccount;
  /** Ticked for bulk delete; no tick box without `onSelect` (a single account cannot be removed). */
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  api: LauncherApi;
  authenticated: boolean;
  busy: string | null;
  chatRunning: boolean;
  canRemove: boolean;
  inUse: boolean;
  locked: boolean;
  /** The main MCP tunnel is set up (it serves the accounts without a tunnel of their own). */
  mainTunnelReady: boolean;
  maxTabs: number;
  proxies: ProxyProfileRecord[];
  holders: BrowserAccount[];
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  sessions: number;
  tabs: BrowserState["tabs"];
  /** This account's own MCP tunnel (#674), if it has one. */
  tunnel: McpTunnel | undefined;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const proxy = account.proxyProfileId ? proxies.find(profile => profile.id === account.proxyProfileId) : undefined;
  const proxyMissing = Boolean(account.proxyProfileId) && (!proxy || !proxy.enabled);
  const holderOf = (profileId: string) => holders.find(other => other.id !== account.id && other.proxyProfileId === profileId);
  const runningTabs = tabs.filter(tab => tab.status === "running").length;
  const plan = planText(account.plan);
  const connector = connectorText(account.connector);
  // Every account keeps its own sign-in: the one in use from its live page, the others from their
  // own saved session (null until read).
  const signedIn = inUse ? authenticated : account.signedIn;
  const signIn = signedIn === null
    ? { tone: "idle", label: "Checking…" }
    : signedIn ? { tone: inUse ? "ok" : "idle", label: "Signed in" } : { tone: "warn", label: "Not signed in" };
  const fill = Math.min(100, Math.round((tabs.length / account.maxTabs) * 100));

  const remove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmRemove(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmRemove(false);
    void run(`remove:${account.id}`, () => api.removeBrowserAccount(account.id));
  };

  return (
    <article className={`cbm-card${inUse ? " is-active" : ""}`} aria-label={accountName(account)}>
      <header className="cbm-card-head">
        {onSelect ? (
          <input
            aria-label={`Select ${accountName(account)} to remove`}
            checked={selected}
            className="cbm-select"
            disabled={locked}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onSelect(event.target.checked)}
            type="checkbox"
          />
        ) : null}
        <i className={`cbm-dot${signedIn === null ? "" : signedIn ? " is-on" : " is-warn"}`} aria-hidden />
        <div className="cbm-card-title">
          <strong title={account.label}>{accountName(account)}</strong>
          {account.email ? <span className="cbm-muted">{account.label}</span> : null}
        </div>
        {inUse ? <span className="cbm-pill is-accent">In use</span> : null}
        <span className="cbm-pill">{plan.label}</span>
      </header>

      <dl className="cbm-facts">
        <div>
          <dt>Sign-in</dt>
          <dd><span className={`cbm-tone is-${signIn.tone}`}>{signIn.label}</span>{!inUse && account.email ? <span className="cbm-muted"> · last seen as {account.email}</span> : null}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>
            <span className="cbm-muted">{plan.detail}</span>
            {inUse ? (
              <button className="cbm-link" disabled={locked || chatRunning} onClick={() => void run(`plan:${account.id}`, () => api.inspectBrowserAccount())} type="button">
                {busy === `plan:${account.id}` ? "Checking…" : "Refresh"}
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>MCP</dt>
          <dd>
            {tunnel ? (
              <>
                <span className={`cbm-tone is-${TUNNEL_TONE[tunnel.state]}`}>{TUNNEL_LABEL[tunnel.state]}</span>
                <span className={`cbm-muted${tunnel.state === "failed" ? " is-error" : ""}`} title={tunnel.detail}>
                  {" "}· {tunnel.label}{tunnel.detail ? ` · ${tunnel.detail}` : ""}
                </span>
                {tunnel.state === "failed" || tunnel.state === "stopped" ? (
                  <button className="cbm-link" disabled={locked} onClick={() => void run(`tunnel:${tunnel.id}`, () => api.reconnectMcpTunnel(tunnel.id))} type="button">
                    {busy === `tunnel:${tunnel.id}` ? "Reconnecting…" : "Reconnect"}
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <span className={`cbm-tone is-${mainTunnelReady ? "idle" : "warn"}`}>Main tunnel</span>
                <span className="cbm-muted"> · {mainTunnelReady ? "no tunnel of its own" : "not set up"}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Connector</dt>
          <dd>
            <span className={`cbm-tone is-${connector.tone}`}>{connector.label}</span>
            <span className={`cbm-muted${connector.tone === "error" ? " is-error" : ""}`} title={connector.detail}> · {connector.detail}</span>
          </dd>
        </div>
        <div>
          <dt>Proxy</dt>
          <dd className="cbm-proxy">
            <select
              aria-label={`Proxy for ${accountName(account)}`}
              disabled={locked || (inUse && chatRunning)}
              onChange={event => void run(`proxy:${account.id}`, () => api.setBrowserAccountProxy(account.id, event.target.value || null))}
              value={account.proxyProfileId ?? ""}
            >
              <option value="">Global Routing</option>
              {proxyMissing ? <option value={account.proxyProfileId!}>Missing proxy</option> : null}
              {proxies.map(profile => {
                const holder = holderOf(profile.id);
                return (
                  <option disabled={Boolean(holder) || !profile.enabled} key={profile.id} value={profile.id}>
                    {profile.name} · {proxyAddress(profile)}{holder ? ` (${accountName(holder)})` : ""}
                  </option>
                );
              })}
            </select>
            <div className="cbm-proxy-meta">
              <span className={`cbm-muted${proxyMissing || proxy?.lastError ? " is-error" : ""}`}>
                {proxyMissing ? "Bound proxy is gone; using Global Routing"
                  : proxy ? (proxy.lastError ?? (proxy.latencyMs !== undefined ? `${proxy.latencyMs} ms` : "Not checked"))
                    : "No proxy of its own"}
              </span>
              {proxy ? (
                <button className="cbm-link" disabled={locked} onClick={() => void run(`check:${proxy.id}`, () => api.testProxyProfile(proxy.id))} type="button">
                  {busy === `check:${proxy.id}` ? "Checking…" : "Check"}
                </button>
              ) : null}
            </div>
          </dd>
        </div>
        <div>
          <dt>Tabs</dt>
          <dd className="cbm-meter-row">
            <span className="cbm-meter" aria-hidden><span style={{ width: `${fill}%` }} /></span>
            <span className="cbm-muted">{tabs.length} of {account.maxTabs}{runningTabs ? ` · ${runningTabs} running` : ""}</span>
          </dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd className="cbm-muted">{sessions ? `${sessions} Codex session${sessions === 1 ? "" : "s"}` : "None yet"}</dd>
        </div>
      </dl>

      <div className="cbm-card-settings">
        <div className="cbm-setting">
          <span>Max tabs</span>
          <div className="cbm-segments" role="radiogroup" aria-label={`Max tabs for ${accountName(account)}`}>
            {Array.from({ length: maxTabs }, (_unused, index) => index + 1).map(value => (
              <button
                aria-checked={account.maxTabs === value}
                className={account.maxTabs === value ? "is-selected" : undefined}
                disabled={locked}
                key={value}
                onClick={() => void run(`tabs:${account.id}`, () => api.setBrowserAccountSettings(account.id, { maxTabs: value }))}
                role="radio"
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <label className="cbm-setting cbm-switch">
          <span>Takes new sessions</span>
          <input
            checked={account.acceptsNewSessions}
            disabled={locked}
            onChange={event => void run(`accepts:${account.id}`, () => api.setBrowserAccountSettings(account.id, { acceptsNewSessions: event.target.checked }))}
            type="checkbox"
          />
        </label>
      </div>

      <footer className="cbm-card-actions">
        {!inUse ? (
          <button className="cbm-button" disabled={locked} onClick={() => void run(`use:${account.id}`, () => api.switchBrowserAccount(account.id))} type="button">
            {busy === `use:${account.id}` ? "Switching…" : "Use in Browser tab"}
          </button>
        ) : null}
        {canRemove ? (
          <button className={`cbm-link${confirmRemove ? " is-danger" : ""}`} disabled={locked || (inUse && chatRunning)} onClick={remove} type="button">
            {confirmRemove ? "Click again to remove" : "Remove"}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function BrowserSettings({ accounts, locked, run, api }: {
  accounts: BrowserAccountsStatus;
  locked: boolean;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  api: LauncherApi;
}) {
  return (
    <section className="cbm-panel" aria-label="Browser settings">
      <div>
        <h2>Browser settings</h2>
        <p className="cbm-muted">
          Each account holds up to {accounts.maxTabsPerAccount} tabs, all accounts together up to {TOTAL_TAB_CEILING}; Codex runs up to {CONCURRENT_TURNS} turns at once.
        </p>
      </div>
      <div className="cbm-fields">
        <label>
          <span>New sessions start on</span>
          <select
            disabled={locked}
            onChange={event => void run("settings:new", () => api.setBrowserAccountsSettings({ newSessions: event.target.value }))}
            value={accounts.settings.newSessions}
          >
            <option value="active">The account in use</option>
            <option value="balance">The least busy account</option>
            {accounts.accounts.map(account => <option key={account.id} value={account.id}>Always {accountName(account)}</option>)}
          </select>
        </label>
        <label>
          <span>Keep finished tabs open</span>
          <select
            disabled={locked}
            onChange={event => void run("settings:keep", () => api.setBrowserAccountsSettings({ keepFinishedTabsMinutes: Number(event.target.value) }))}
            value={accounts.settings.keepFinishedTabsMinutes}
          >
            {KEEP_FINISHED_TABS_MINUTES.map(minutes => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
          </select>
        </label>
      </div>
      <p className="cbm-muted">
        {accounts.settings.newSessions === "balance"
          ? "A new session goes to the account with the fewest open tabs, then the fewest sessions today, among accounts that take new sessions."
          : "A session stays on the account it started on; move it below."}
      </p>
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
    <section className="cbm-panel" aria-label="Codex sessions">
      <div>
        <h2>Codex sessions</h2>
        <p className="cbm-muted">
          {threads.length
            ? "Each session stays on its account and reopens its own chat there."
            : "A Codex session joins an account on its first turn."}
        </p>
      </div>
      {threads.length ? (
        <div className="cbm-list" role="table" aria-label="Codex sessions">
          {threads.map(thread => {
            const archived = thread.chats.length > 0 && thread.chats.every(chat => chat.archived);
            const disabled = locked || thread.running;
            return (
              <div className="cbm-row" key={thread.threadId} role="row">
                <div className="cbm-account" role="cell">
                  <i className={`cbm-dot${thread.running ? " is-on" : ""}`} aria-hidden />
                  <div>
                    <strong title={thread.threadId}>{thread.title ?? `Session ${thread.threadId.slice(0, 8)}`}</strong>
                    <span className="cbm-muted">{thread.running ? "Running" : `Last used ${ago(thread.lastUsedAt)}`}</span>
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
    <section className="cbm-panel cbm-decodo" aria-label="Decodo proxies">
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
        <div className="cbm-decodo-actions">
          <button
            className="cbm-link"
            disabled={locked}
            onClick={() => void run("assign", () => api.assignBrowserAccountProxies())}
            type="button"
          >
            Give each account its own
          </button>
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

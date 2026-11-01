import { useEffect, useRef, useState } from "react";
import type { BrowserAccount, BrowserAccountsStatus, LauncherApi, McpTunnel } from "../types";
import "./mcp-tunnels.css";

const CONFIRM_WINDOW_MS = 4_000;
const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/;
const STATE_LABEL: Record<McpTunnel["state"], string> = {
  ready: "Connected",
  starting: "Connecting…",
  failed: "Not connected",
  stopped: "Stopped",
};

const accountName = (account: BrowserAccount) => account.email ?? account.label;
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * More tunnels beside the main one, one per further ChatGPT account. A tunnel belongs to one OpenAI
 * account and ChatGPT reaches Codex's tools only through a tunnel of its own account, so each Browser
 * account that should use the connector gets its own tunnel here; all of them reach the same bridge.
 */
export function McpTunnelsPanel({ api, initial, setError }: {
  api: LauncherApi;
  initial: McpTunnel[];
  setError: (error: string | null) => void;
}) {
  const [tunnels, setTunnels] = useState<McpTunnel[]>(initial);
  const [accounts, setAccounts] = useState<BrowserAccountsStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void api.mcpTunnels().then(next => { if (live) setTunnels(next); }).catch(() => {});
    void api.browserAccounts().then(next => { if (live) setAccounts(next); }).catch(() => {});
    const offTunnels = api.onMcpTunnelsChanged(next => setTunnels(next));
    const offAccounts = api.onBrowserAccountsChanged(next => setAccounts(next));
    return () => {
      live = false;
      offTunnels();
      offAccounts();
      window.clearTimeout(confirmTimer.current);
    };
  }, [api]);

  const accountList = accounts?.accounts ?? [];
  const accountLabel = (id: string | null) => {
    if (!id) return "No account";
    if (!accounts) return "…";
    const account = accountList.find(entry => entry.id === id);
    return account ? accountName(account) : "Removed account";
  };
  // An account with a tunnel already keeps it; the main tunnel serves the account the bridge set up on.
  const freeAccounts = accountList.filter(entry => !tunnels.some(tunnel => tunnel.accountId === entry.id));

  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const add = () => void run("add", async () => {
    await api.addMcpTunnel({ label: label.trim(), tunnelId: tunnelId.trim(), runtimeKey, accountId: accountId || null });
    setLabel("");
    setAccountId("");
    setTunnelId("");
    setRuntimeKey("");
    setAdding(false);
  });

  const remove = (id: string) => {
    if (confirmRemove !== id) {
      setConfirmRemove(id);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmRemove(null), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmRemove(null);
    void run(`remove:${id}`, () => api.removeMcpTunnel(id));
  };

  const canAdd = label.trim() && TUNNEL_ID.test(tunnelId.trim()) && runtimeKey.trim();

  return (
    <section className="mtp" aria-label="More tunnels">
      <div className="mtp-head">
        <div>
          <h3>More tunnels</h3>
          <p className="mtp-muted">
            Each further ChatGPT account needs a tunnel created in its own OpenAI account. Every tunnel
            reaches the same Codex tools, and each serves all of that account's ChatGPT chats.
          </p>
        </div>
        {!adding ? (
          <button className="mtp-button" disabled={Boolean(busy)} onClick={() => setAdding(true)} type="button">
            Add tunnel
          </button>
        ) : null}
      </div>

      {tunnels.length ? (
        <div className="mtp-list" role="table" aria-label="Tunnels">
          {tunnels.map(tunnel => (
            <div className="mtp-row" key={tunnel.id} role="row">
              <div className="mtp-name" role="cell">
                <i className={`mtp-dot is-${tunnel.state}`} aria-hidden />
                <div>
                  <strong>{tunnel.label}</strong>
                  <span className="mtp-muted" title={tunnel.tunnelId}>
                    {accountLabel(tunnel.accountId)} · {tunnel.tunnelId.slice(0, 15)}…
                  </span>
                </div>
              </div>
              <div className="mtp-state" role="cell" title={tunnel.detail}>
                <span>{busy === `reconnect:${tunnel.id}` ? "Connecting…" : STATE_LABEL[tunnel.state]}</span>
                {tunnel.state === "failed" && tunnel.detail ? <small className="mtp-muted">{tunnel.detail}</small> : null}
              </div>
              <div className="mtp-actions" role="cell">
                <button
                  className="mtp-link"
                  disabled={Boolean(busy) || !accountList.some(account => account.id === tunnel.accountId)}
                  onClick={() => void run(`settings:${tunnel.id}`, () => api.openMcpTunnelSettings(tunnel.id))}
                  title="Open Platform settings in this Browser account"
                  type="button"
                >
                  {busy === `settings:${tunnel.id}` ? "Opening…" : "Platform settings"}
                </button>
                {tunnel.connectorHref ? (
                  <span className="mtp-muted">Connector added</span>
                ) : (
                  <button
                    className="mtp-link"
                    disabled={Boolean(busy) || !tunnel.accountId || tunnel.state !== "ready"}
                    onClick={() => void run(`connector:${tunnel.id}`, () => api.createMcpTunnelConnector(tunnel.id))}
                    title={tunnel.accountId ? "Create the ChatGPT connector in this tunnel's account" : "No Browser account: add the connector in that ChatGPT account's settings"}
                    type="button"
                  >
                    {busy === `connector:${tunnel.id}` ? "Creating…" : "Create connector"}
                  </button>
                )}
                <button
                  className="mtp-link"
                  disabled={Boolean(busy)}
                  onClick={() => void run(`reconnect:${tunnel.id}`, () => api.reconnectMcpTunnel(tunnel.id))}
                  type="button"
                >
                  Reconnect
                </button>
                <button
                  className={`mtp-link${confirmRemove === tunnel.id ? " is-danger" : ""}`}
                  disabled={Boolean(busy)}
                  onClick={() => remove(tunnel.id)}
                  type="button"
                >
                  {confirmRemove === tunnel.id ? "Click again to remove" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !adding ? (
        <p className="mtp-muted mtp-empty">Only the main tunnel is connected.</p>
      ) : null}

      {adding ? (
        <div className="mtp-form">
          <label>
            <span>Name</span>
            <input maxLength={60} onChange={event => setLabel(event.target.value)} placeholder="Team account" value={label} />
          </label>
          <label>
            <span>ChatGPT account</span>
            <select onChange={event => setAccountId(event.target.value)} value={accountId}>
              <option value="">None (add its connector by hand)</option>
              {freeAccounts.map(entry => <option key={entry.id} value={entry.id}>{accountName(entry)}</option>)}
            </select>
          </label>
          <label>
            <span>Tunnel ID</span>
            <input
              autoCapitalize="none"
              autoCorrect="off"
              onChange={event => setTunnelId(event.target.value)}
              placeholder="tunnel_…"
              spellCheck={false}
              value={tunnelId}
            />
          </label>
          <label>
            <span>API key</span>
            <input
              autoCapitalize="none"
              autoCorrect="off"
              onChange={event => setRuntimeKey(event.target.value)}
              placeholder="sk-…"
              spellCheck={false}
              type="password"
              value={runtimeKey}
            />
          </label>
          <div className="mtp-form-actions">
            <button className="mtp-link" disabled={busy === "add"} onClick={() => setAdding(false)} type="button">Cancel</button>
            <button className="mtp-button is-primary" disabled={!canAdd || Boolean(busy)} onClick={add} type="button">
              {busy === "add" ? "Connecting…" : "Connect tunnel"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

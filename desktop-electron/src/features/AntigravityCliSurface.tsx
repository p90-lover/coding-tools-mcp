import { useCallback, useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import { AgentOrchestratorOriginalSurface, type AoTerminalView } from "./AgentOrchestratorOriginalSurface";
import "./antigravity-cli.css";
import { pageHidden } from "./page-visibility";

type Account = { name: string; email: string | null; status: string; disabled: boolean; error: string | null };
type Sweep = { at: string; refreshed: string[]; signIn: string[]; failed: string[]; error?: string };
type Status = {
  version: string; supported: boolean; installed: boolean; installing: boolean; installedAt: string | null;
  command: string; shim: string | null; previous: string[];
  download: { fileName: string; size: number; url: string } | null;
  proxy?: { configured: boolean; error?: string };
  cpa: { auto: boolean; accounts: Account[]; needsAttention: number; signingIn: boolean; lastSweep: Sweep | null; error: string | null };
};

const TERMINAL_KEY = "coding-tools:agy:terminal";

async function call(operation: string, args: JsonObject = {}) {
  const outer = await getCodingToolsClient().apps.call({ moduleId: "antigravity-cli", operation, arguments: args });
  const result = (outer.result ?? {}) as Record<string, unknown>;
  if (outer.ok === false || result.ok === false) {
    if (result.cancelled === true) return result;
    throw new Error(String(result.reason || result.detail || result.error || "Antigravity CLI operation failed"));
  }
  return result;
}

function savedTerminal(): AoTerminalView | null {
  try {
    const value = JSON.parse(localStorage.getItem(TERMINAL_KEY) || "null");
    return value && typeof value.handle === "string" ? value : null;
  } catch { return null; }
}
function saveTerminal(value: AoTerminalView | null) {
  try { if (value) localStorage.setItem(TERMINAL_KEY, JSON.stringify(value)); else localStorage.removeItem(TERMINAL_KEY); }
  catch { /* The terminal still works for this view. */ }
}

const needsAuth = (account: Account) => !account.disabled && (account.status === "expired" || account.status === "error");

export function AntigravityCliSurface({ setError, openNetwork }: { setError: (error: string | null) => void; openNetwork: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<"terminal" | "accounts">("terminal");
  const [terminal, setTerminal] = useState<AoTerminalView | null>(savedTerminal);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await call("status") as unknown as Status); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [setError]);

  useEffect(() => {
    void refreshStatus();
    void getCodingToolsClient().workspaces.list({ cursor: 0, limit: 100 })
      .then(page => { setWorkspaces([...page.items]); setWorkspaceId(page.items[0]?.id ?? ""); })
      .catch(() => undefined);
    const timer = setInterval(() => { if (!pageHidden()) void refreshStatus(); }, 15_000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const run = (name: string, operation: string, args: JsonObject = {}, after?: (result: Record<string, unknown>) => void) => async () => {
    if (busy) return;
    setBusy(name); setError(null);
    try { const result = await call(operation, args); after?.(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); await refreshStatus(); }
  };

  const openTerminal = run("terminal", "terminal_open", workspaceId ? { workspaceId } : {}, result => {
    const next = { handle: String(result.handle), generation: String(result.generation || result.handle), title: "agy" };
    saveTerminal(next); setTerminal(next); setTab("terminal");
  });
  const closeTerminal = () => {
    if (!terminal) return;
    const handle = terminal.handle;
    saveTerminal(null); setTerminal(null);
    void call("terminal_close", { handle }).catch(() => undefined);
  };

  const cpa = status?.cpa;
  const proxyReady = status?.proxy?.configured === true;
  return (
    <section className="agy-surface" aria-label="Antigravity CLI">
      <header className="agy-bar">
        <strong>Antigravity CLI</strong>
        {status ? <span className={`agy-state ${status.installed ? "is-ok" : ""}`}>{status.installed ? `v${status.version}` : status.installing ? "Installing…" : "Not installed"}</span> : null}
        <div className="agy-tabs" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => setTab("terminal")}>Terminal</button>
          <button type="button" role="tab" aria-selected={tab === "accounts"} onClick={() => setTab("accounts")}>
            Accounts{cpa?.needsAttention ? <span className="agy-badge">{cpa.needsAttention}</span> : null}
          </button>
        </div>
        <span className="agy-spacer" />
        <button type="button" className={`agy-proxy ${proxyReady ? "is-ok" : "is-off"}`} onClick={openNetwork}
          title={proxyReady ? "All agy traffic goes through the global network proxy" : status?.proxy?.error || "Select a global proxy to run agy"}>
          {proxyReady ? "Proxy on" : "Proxy required"}
        </button>
        {status?.installed ? <>
          <select aria-label="Workspace" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
            <option value="">No workspace</option>
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button type="button" className="button-primary" disabled={Boolean(busy) || !proxyReady} onClick={openTerminal}
            title="Opens agy in an in-app terminal. The first run signs in with Google.">{terminal ? "New terminal" : "Open agy"}</button>
          {terminal ? <button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={closeTerminal}>Close</button> : null}
        </> : <button type="button" className="button-primary" disabled={!status?.supported || Boolean(busy) || status?.installing}
          onClick={run("install", "install")} title={status?.download ? `${status.download.fileName} · ${(status.download.size / 1048576).toFixed(0)} MB · checksum-verified` : undefined}>
          {busy === "install" || status?.installing ? "Installing…" : `Install ${status?.version ?? ""}`}
        </button>}
      </header>

      {tab === "terminal" ? <div className="agy-terminal">
        {terminal ? <AgentOrchestratorOriginalSurface hostbar={false} openMissions={() => undefined} terminal={terminal} />
          : <div className="agy-empty">
            <p>{!status?.installed ? "Install the Antigravity CLI to run it here." : !proxyReady ? "agy runs only through the network proxy." : "Start agy in the selected workspace."}</p>
            {status?.installed && !proxyReady ? <button type="button" className="button-secondary" onClick={openNetwork}>Open Network Proxy</button> : null}
            {status?.installed && proxyReady ? <button type="button" className="button-primary" disabled={Boolean(busy)} onClick={openTerminal}>Open agy</button> : null}
          </div>}
      </div> : <div className="agy-body">
        <section className="agy-card">
          <header>
            <h2>Gemini accounts in CPA</h2>
            <label className="agy-toggle" title="Refresh expired tokens automatically; if Google revoked one, open CPA's sign-in (at most every 6 hours per account).">
              <input type="checkbox" checked={cpa?.auto ?? true} disabled={!cpa || Boolean(busy)}
                onChange={event => void run("auto", "set_auto", { auto: event.target.checked })()} />
              Auto re-auth
            </label>
            <button type="button" className="button-secondary" disabled={!cpa || Boolean(busy)} onClick={run("sweep", "sweep")}>{busy === "sweep" ? "Checking…" : "Check now"}</button>
          </header>
          {cpa?.error ? <p className="agy-note" role="status">{cpa.error}</p> : null}
          {cpa && !cpa.accounts.length && !cpa.error ? <p className="agy-note">No Antigravity account in CPA yet.</p> : null}
          <ul className="agy-accounts">
            {cpa?.accounts.map(account => <li key={account.name}>
              <span className={`agy-dot is-${account.disabled ? "disabled" : account.status}`} aria-hidden="true" />
              <span className="agy-account">
                <strong>{account.email || account.name}</strong>
                <small title={account.error ?? undefined}>{account.disabled ? "disabled" : account.status}{account.error ? ` · ${account.error}` : ""}</small>
              </span>
              {!account.disabled ? <>
                <button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={run(`refresh:${account.name}`, "refresh", { name: account.name })}>Refresh</button>
                <button type="button" className={needsAuth(account) ? "button-primary" : "button-secondary"} disabled={Boolean(busy) || cpa.signingIn}
                  onClick={run(`sign:${account.name}`, "sign_in", { name: account.name })}>{busy === `sign:${account.name}` ? "Waiting for browser…" : "Sign in again"}</button>
              </> : null}
            </li>)}
          </ul>
          {cpa?.lastSweep ? <p className="agy-note">Last check {new Date(cpa.lastSweep.at).toLocaleTimeString()}
            {cpa.lastSweep.refreshed.length ? ` · refreshed ${cpa.lastSweep.refreshed.length}` : ""}
            {cpa.lastSweep.signIn.length ? ` · signed in ${cpa.lastSweep.signIn.length}` : ""}
            {cpa.lastSweep.failed.length ? ` · ${cpa.lastSweep.failed.length} need you` : ""}</p> : null}
        </section>
        <section className="agy-card agy-facts">
          <dl>
            <dt>Agent Orchestrator</dt><dd>{status?.installed ? "Available as the Agy worker harness (restart the AO runtime once after install or proxy changes)" : "Install to enable the Agy harness"}</dd>
            <dt>Network</dt><dd>Every agy process, in this terminal or started by AO, uses the global network proxy and refuses to start without it.</dd>
            <dt>Sign-in</dt><dd>The CLI keeps its own Google sign-in. CPA accounts are renewed through CPA; the CLI's credentials are never read.</dd>
          </dl>
        </section>
      </div>}
    </section>
  );
}

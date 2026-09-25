import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import "./workspace-auth.css";

interface NativeCodexPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

export function NativeCodexPanel({ copy, language, setError }: NativeCodexPanelProps) {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [executable, setExecutable] = useState("");
  const [codexHome, setCodexHome] = useState("");
  const [model, setModel] = useState("");
  const [permissionProfile, setPermissionProfile] = useState<":read-only" | ":workspace">(":read-only");
  const [requestLimit, setRequestLimit] = useState("10");
  const [lifetimeSeconds, setLifetimeSeconds] = useState("600");
  const [allowModelUsage, setAllowModelUsage] = useState(false);
  const [allowCommandExecution, setAllowCommandExecution] = useState(false);
  const [status, setStatus] = useState<JsonObject | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);
  const connected = status?.connected === true;

  const refreshWorkspaces = async () => {
    setBusy(true);
    setError(null);
    try {
      const items: WorkspaceSummary[] = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page = await getCodingToolsClient().workspaces.list({ cursor, limit: 100 });
        items.push(...page.items);
        cursor = page.nextCursor;
      }
      setWorkspaces(items);
      const nextId = items.some((item) => item.id === workspaceId) ? workspaceId : items[0]?.id ?? "";
      setWorkspaceId(nextId);
      setStatus(nextId ? await getCodingToolsClient().nativeCodex.status({ workspaceId: nextId }) : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshWorkspaces();
    // Load once on mount; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }
    let current = true;
    let reading = false;
    setStatus(null);
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await getCodingToolsClient().nativeCodex.status({ workspaceId });
        if (current) setStatus(value);
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { current = false; clearInterval(timer); };
  }, [workspaceId, setError]);

  const connect = async () => {
    if (!selected || busy || connected) return;
    const limit = Number(requestLimit);
    const lifetime = Number(lifetimeSeconds);
    if (!/^(0|[1-9]\d*)$/.test(requestLimit) || !Number.isInteger(limit) || limit > 20
      || !/^(0|[1-9]\d*)$/.test(lifetimeSeconds) || !Number.isInteger(lifetime)
      || (lifetime !== 0 && (lifetime < 30 || lifetime > 900))) {
      setError(copy.nativeCodexLimits);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await getCodingToolsClient().nativeCodex.connect({
        workspaceId: selected.id,
        executable: executable.trim(),
        codexHome: codexHome.trim(),
        model: model.trim(),
        allowModelUsage,
        allowCommandExecution,
        permissionProfile,
        requestLimit: limit,
        lifetimeSeconds: lifetime,
      });
      if (result.cancelled === true) {
        setNotice(copy.workspaceAuthCancelled);
      } else if (result.connected === true) {
        setStatus(result);
        setNotice(copy.nativeCodexConnected);
      } else {
        throw new Error("Native Codex did not confirm a connected session");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await getCodingToolsClient().nativeCodex.disconnect({ workspaceId: selected.id });
      setStatus(result);
      setAllowModelUsage(false);
      setAllowCommandExecution(false);
      setNotice(copy.nativeCodexDisconnected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={copy.nativeCodex} lang={language}>
      <div className="section-heading">
        <span>{copy.nativeCodex}</span>
        <button className="button-secondary" disabled={busy} onClick={() => void refreshWorkspaces()} type="button">
          {busy ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.nativeCodexBody}</p>
      {selected ? (
        <form className="workspace-auth-form" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
          <label><span>{copy.selectWorkspace}</span>
            <select disabled={busy} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setNotice(""); }}>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <code className="workspace-auth-path">{selected.path}</code>
          <p role="status">{connected ? copy.nativeCodexConnected : copy.nativeCodexDisconnected}
            {typeof status?.reason === "string" ? ` · ${status.reason}` : ""}
            {typeof status?.model === "string" ? ` · ${status.model}` : ""}
          </p>
          <label><span>{copy.nativeCodexExecutable}</span>
            <input autoComplete="off" disabled={busy || connected} onChange={(event) => setExecutable(event.target.value)} spellCheck={false} value={executable} />
          </label>
          <label><span>{copy.nativeCodexHome}</span>
            <input autoComplete="off" disabled={busy || connected} onChange={(event) => setCodexHome(event.target.value)} spellCheck={false} value={codexHome} />
          </label>
          <label><span>{copy.nativeCodexModel}</span>
            <input autoComplete="off" disabled={busy || connected} onChange={(event) => setModel(event.target.value)} spellCheck={false} value={model} />
          </label>
          <label><span>{copy.nativeCodexPermissionProfile}</span>
            <select disabled={busy || connected} onChange={(event) => setPermissionProfile(event.target.value as ":read-only" | ":workspace")} value={permissionProfile}>
              <option value=":read-only">:read-only</option>
              <option value=":workspace">:workspace</option>
            </select>
          </label>
          <label><span>{copy.nativeCodexRequestLimit}</span>
            <input disabled={busy || connected} max={20} min={0} onChange={(event) => setRequestLimit(event.target.value)} type="number" value={requestLimit} />
          </label>
          <label><span>{copy.nativeCodexLifetime}</span>
            <input disabled={busy || connected} max={900} min={0} onChange={(event) => setLifetimeSeconds(event.target.value)} type="number" value={lifetimeSeconds} />
          </label>
          <label className="workspace-auth-check"><input checked={allowModelUsage} disabled={busy || connected} onChange={(event) => setAllowModelUsage(event.target.checked)} type="checkbox" /><span>{copy.nativeCodexModelUse}</span></label>
          <label className="workspace-auth-check"><input checked={allowCommandExecution} disabled={busy || connected} onChange={(event) => setAllowCommandExecution(event.target.checked)} type="checkbox" /><span>{copy.nativeCodexCommandUse}</span></label>
          <p className="workspace-auth-note">{permissionProfile === ":workspace" ? copy.nativeCodexWorkspaceNote : copy.nativeCodexReadOnly}</p>
          <div className="inline-actions">
            <button className="button-primary" disabled={busy || connected || !executable.trim() || !codexHome.trim() || !model.trim() || (!allowModelUsage && !allowCommandExecution)} type="submit">{copy.nativeCodexConnect}</button>
            <button className="button-secondary" disabled={busy || !workspaceId} onClick={() => void stop()} type="button">{copy.nativeCodexStop}</button>
          </div>
          {notice ? <p role="status">{notice}</p> : null}
        </form>
      ) : <div className="surface-empty"><span>{copy.noWorkspaces}</span></div>}
    </section>
  );
}

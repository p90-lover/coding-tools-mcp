import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import { pageHidden } from "./page-visibility";
import { Card, Field, Notice, Pill, Segmented, WorkspacePicker, errorText, useWorkspaces } from "./workspace-ui";

interface NativeCodexPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

type Profile = ":read-only" | ":workspace";
type Remembered = { executable: string; codexHome: string; model: string };

const STATUS_POLL_MS = 3000;
// Only these non-secret paths and the model ID are remembered, per workspace, in this browser profile.
const rememberKey = (workspaceId: string) => `native-codex:${workspaceId}`;
function recall(workspaceId: string): Remembered {
  try {
    const saved = JSON.parse(localStorage.getItem(rememberKey(workspaceId)) || "{}") as Partial<Remembered>;
    return { executable: saved.executable ?? "", codexHome: saved.codexHome ?? "", model: saved.model ?? "" };
  } catch {
    return { executable: "", codexHome: "", model: "" };
  }
}
function remember(workspaceId: string, value: Remembered) {
  try { localStorage.setItem(rememberKey(workspaceId), JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const wholeNumber = (value: string) => /^(0|[1-9]\d*)$/.test(value);

export function NativeCodexPanel({ copy, language, setError }: NativeCodexPanelProps) {
  const { workspaces, loaded, loading, refresh } = useWorkspaces(setError);
  const [workspaceId, setWorkspaceId] = useState("");
  const [executable, setExecutable] = useState("");
  const [codexHome, setCodexHome] = useState("");
  const [model, setModel] = useState("");
  const [permissionProfile, setPermissionProfile] = useState<Profile>(":read-only");
  const [requestLimit, setRequestLimit] = useState("10");
  const [lifetimeSeconds, setLifetimeSeconds] = useState("600");
  const [allowModelUsage, setAllowModelUsage] = useState(false);
  const [allowCommandExecution, setAllowCommandExecution] = useState(false);
  const [status, setStatus] = useState<JsonObject | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);
  const connected = status?.connected === true;
  const busy = loading || working;

  useEffect(() => {
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) setWorkspaceId(workspaces[0]?.id ?? "");
  }, [workspaces, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const saved = recall(workspaceId);
    setExecutable(saved.executable);
    setCodexHome(saved.codexHome);
    setModel(saved.model);
  }, [workspaceId]);

  // Poll while visible. A failed read marks the status card instead of raising a toast every 3s.
  useEffect(() => {
    if (!workspaceId) { setStatus(null); return; }
    let current = true;
    let reading = false;
    setStatus(null);
    setStatusFailed(false);
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await getCodingToolsClient().nativeCodex.status({ workspaceId });
        if (current) { setStatus(value); setStatusFailed(false); }
      } catch {
        if (current) setStatusFailed(true);
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => { if (!pageHidden()) void read(); }, STATUS_POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [workspaceId]);

  const limitsValid = wholeNumber(requestLimit) && Number(requestLimit) <= 20 && wholeNumber(lifetimeSeconds)
    && (Number(lifetimeSeconds) === 0 || (Number(lifetimeSeconds) >= 30 && Number(lifetimeSeconds) <= 900));
  const ready = Boolean(executable.trim() && codexHome.trim() && model.trim()) && (allowModelUsage || allowCommandExecution) && limitsValid;

  const connect = async () => {
    if (!selected || busy || connected || !ready) return;
    setWorking(true);
    setError(null);
    setNotice("");
    try {
      const value = { executable: executable.trim(), codexHome: codexHome.trim(), model: model.trim() };
      remember(selected.id, value);
      const result = await getCodingToolsClient().nativeCodex.connect({
        workspaceId: selected.id, ...value, allowModelUsage, allowCommandExecution, permissionProfile,
        requestLimit: Number(requestLimit), lifetimeSeconds: Number(lifetimeSeconds),
      });
      if (result.cancelled === true) setNotice(copy.workspaceAuthCancelled);
      else if (result.connected === true) { setStatus(result); setNotice(copy.nativeCodexConnected); }
      else throw new Error("Native Codex did not confirm a connected session");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setWorking(false);
    }
  };

  const stop = async () => {
    if (!selected || busy) return;
    setWorking(true);
    setError(null);
    try {
      setStatus(await getCodingToolsClient().nativeCodex.disconnect({ workspaceId: selected.id }));
      setAllowModelUsage(false);
      setAllowCommandExecution(false);
      setNotice(copy.nativeCodexDisconnected);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setWorking(false);
    }
  };

  const locked = busy || connected;
  return (
    <div className="wsx-page" lang={language} aria-label={copy.nativeCodex}>
      <p className="wsx-intro">{copy.nativeCodexBody}</p>
      {!loaded ? <div className="wsx-loading">{copy.wsLoading}</div>
        : !selected ? <div className="surface-empty"><span>{copy.noWorkspaces}</span></div>
        : <>
          <div className="wsx-toolbar">
            <WorkspacePicker workspaces={workspaces} value={workspaceId} label={copy.selectWorkspace} disabled={busy}
              onChange={(id) => { setWorkspaceId(id); setNotice(""); }} />
            <span className="wsx-spacer" />
            <button className="button-secondary" disabled={busy} onClick={() => void refresh()} type="button">
              {loading ? copy.running : copy.refreshTools}
            </button>
          </div>
          <code className="wsx-mono">{selected.path}</code>

          <Card title={copy.nativeCodex} aside={
            statusFailed ? <Pill tone="error">{copy.ncStatusUnavailable}</Pill>
              : status === null ? <Pill tone="busy">{copy.wsListenerChecking}</Pill>
              : <Pill tone={connected ? "ok" : "idle"}>{connected ? copy.nativeCodexConnected : copy.nativeCodexDisconnected}</Pill>
          }>
            {typeof status?.model === "string" || typeof status?.reason === "string" ? (
              <dl className="wsx-facts">
                {typeof status?.model === "string" ? <><dt>{copy.nativeCodexModel}</dt><dd>{status.model}</dd></> : null}
                {typeof status?.reason === "string" ? <><dt>{copy.workspaceListenerStatus}</dt><dd>{status.reason}</dd></> : null}
              </dl>
            ) : null}
            <div className="wsx-actions">
              <button className="button-secondary" disabled={busy || !connected} onClick={() => void stop()} type="button">{copy.nativeCodexStop}</button>
            </div>
            {notice ? <Notice>{notice}</Notice> : null}
          </Card>

          <Card title={copy.ncConnection}>
            <form className="wsx-grid" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
              <Field label={copy.nativeCodexExecutable} wide>
                <input autoComplete="off" disabled={locked} placeholder={copy.ncExePlaceholder} spellCheck={false}
                  value={executable} onChange={(event) => setExecutable(event.target.value)} />
              </Field>
              <Field label={copy.nativeCodexHome}>
                <input autoComplete="off" disabled={locked} placeholder={copy.ncHomePlaceholder} spellCheck={false}
                  value={codexHome} onChange={(event) => setCodexHome(event.target.value)} />
              </Field>
              <Field label={copy.nativeCodexModel}>
                <input autoComplete="off" disabled={locked} placeholder={copy.ncModelPlaceholder} spellCheck={false}
                  value={model} onChange={(event) => setModel(event.target.value)} />
              </Field>
              <Field label={copy.ncPermissions} wide>
                <Segmented<Profile> label={copy.nativeCodexPermissionProfile} value={permissionProfile} disabled={locked}
                  options={[{ value: ":read-only", label: copy.ncProfileReadOnly }, { value: ":workspace", label: copy.ncProfileWorkspace }]}
                  onChange={setPermissionProfile} />
              </Field>
              <Field label={copy.nativeCodexRequestLimit} hint={copy.ncRequestHint}>
                <input disabled={locked} max={20} min={0} type="number" value={requestLimit} onChange={(event) => setRequestLimit(event.target.value)} />
              </Field>
              <Field label={copy.nativeCodexLifetime} hint={copy.ncLifetimeHint}>
                <input disabled={locked} max={900} min={0} type="number" value={lifetimeSeconds} onChange={(event) => setLifetimeSeconds(event.target.value)} />
              </Field>
              <label className="wsx-check" style={{ gridColumn: "1 / -1" }}>
                <input checked={allowModelUsage} disabled={locked} type="checkbox" onChange={(event) => setAllowModelUsage(event.target.checked)} />
                {copy.nativeCodexModelUse}
              </label>
              <label className="wsx-check" style={{ gridColumn: "1 / -1" }}>
                <input checked={allowCommandExecution} disabled={locked} type="checkbox" onChange={(event) => setAllowCommandExecution(event.target.checked)} />
                {copy.nativeCodexCommandUse}
              </label>
              {!limitsValid ? <span className="wsx-field-hint" style={{ gridColumn: "1 / -1", color: "var(--color-text-error)" }}>{copy.nativeCodexLimits}</span> : null}
              <div className="wsx-actions" style={{ gridColumn: "1 / -1" }}>
                <button className="button-primary" disabled={locked || !ready} type="submit">{working ? copy.running : copy.nativeCodexConnect}</button>
              </div>
              <details className="wsx-details" style={{ gridColumn: "1 / -1" }}>
                <summary>{copy.ncHowItWorks}</summary>
                <p>{permissionProfile === ":workspace" ? copy.nativeCodexWorkspaceNote : copy.nativeCodexReadOnly}</p>
              </details>
            </form>
          </Card>
        </>}
    </div>
  );
}

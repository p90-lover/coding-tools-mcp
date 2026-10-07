import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import { pageHidden } from "./page-visibility";
import { Card, Field, Notice, Pill, Segmented, WorkspacePicker, errorText, useWorkspaces } from "./workspace-ui";
import type { Tone } from "./workspace-ui";

type CredentialKey = "bearer_token" | "oauth_password" | "actions_api_key" | "actions_oauth_client_secret" | "actions_oauth_password";
type Service = "mcp" | "actions";

interface WorkspaceAuthPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

const LISTENER_POLL_MS = 5000;

function listenerState(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const state = (value as Record<string, unknown>).state;
    if (typeof state === "string") return state;
  }
  return "unknown";
}

export function WorkspaceAuthPanel({ copy, language, setError }: WorkspaceAuthPanelProps) {
  const { workspaces, loaded, loading, refresh } = useWorkspaces(setError);
  const [workspaceId, setWorkspaceId] = useState("");
  const [service, setService] = useState<Service>("mcp");
  const [authType, setAuthType] = useState("");
  const [clientId, setClientId] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [scopes, setScopes] = useState("");
  const [shared, setShared] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ text: string; restart?: boolean } | null>(null);
  const [listener, setListener] = useState("checking");
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);
  const busy = loading || working;

  // Keep a valid selection as the list loads or changes.
  useEffect(() => {
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) setWorkspaceId(workspaces[0]?.id ?? "");
  }, [workspaces, workspaceId]);

  useEffect(() => {
    if (!selected) return;
    setAuthType(service === "mcp" ? selected.mcpAuthType : selected.actionsAuthType);
    setClientId(service === "mcp" ? selected.mcpOAuthClientId : selected.actionsOAuthClientId);
    setRedirectUris((service === "mcp" ? selected.mcpOAuthRedirectUris : selected.actionsOAuthRedirectUris).join("\n"));
    setScopes(service === "mcp" ? "" : selected.actionsOAuthScopes);
    setShared((service === "mcp" ? selected.mcpUseSharedSecrets : selected.actionsUseSharedSecrets) === true);
  }, [selected, service]);

  // The listener can be started or stopped from elsewhere, so poll while this page is visible.
  // A failed read shows as an error state here instead of a repeating global toast.
  useEffect(() => {
    if (!selected) return;
    let current = true;
    let reading = false;
    setListener("checking");
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await getCodingToolsClient().workspaces.service({ workspaceId: selected.id, service, operation: "status" });
        if (current) setListener(listenerState(result.status));
      } catch {
        if (current) setListener("error");
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => { if (!pageHidden()) void read(); }, LISTENER_POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [selected?.id, service]);

  const savedType = service === "mcp" ? selected?.mcpAuthType : selected?.actionsAuthType;
  const savedClientId = service === "mcp" ? selected?.mcpOAuthClientId : selected?.actionsOAuthClientId;
  const savedRedirectUris = service === "mcp" ? selected?.mcpOAuthRedirectUris : selected?.actionsOAuthRedirectUris;
  const savedScopes = service === "mcp" ? "" : selected?.actionsOAuthScopes;
  const savedShared = service === "mcp" ? selected?.mcpUseSharedSecrets : selected?.actionsUseSharedSecrets;
  const known = selected && savedType !== "unknown" && savedShared !== null;
  const dirty = known && (
    authType !== savedType || clientId !== savedClientId
    || redirectUris.trim() !== (savedRedirectUris ?? []).join("\n")
    || scopes !== savedScopes || shared !== savedShared
  );

  const credentials: { key: CredentialKey; label: string }[] = service === "mcp"
    ? authType === "oauth" ? [{ key: "oauth_password", label: copy.wsCredOAuthPassword }]
      : authType === "bearer" ? [{ key: "bearer_token", label: copy.wsCredBearer }] : []
    : authType === "oauth" ? [
      { key: "actions_oauth_client_secret", label: copy.wsCredClientSecret },
      { key: "actions_oauth_password", label: copy.wsCredOAuthPassword },
    ] : authType === "api_key" ? [{ key: "actions_api_key", label: copy.wsCredApiKey }] : [];

  const authOptions = service === "mcp"
    ? [{ value: "oauth", label: copy.wsAuthOAuth }, { value: "bearer", label: copy.wsAuthBearer }, { value: "noauth", label: copy.wsAuthNone }]
    : [{ value: "oauth", label: copy.wsAuthOAuth }, { value: "api_key", label: copy.wsAuthApiKey }, { value: "none", label: copy.wsAuthNone }];

  const act = async (run: () => Promise<void>) => {
    if (!selected || busy) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try { await run(); } catch (cause) { setError(errorText(cause)); } finally { setWorking(false); }
  };

  const save = () => act(async () => {
    if (!selected || !dirty) return;
    const result = await getCodingToolsClient().workspaces.updateAuth({
      workspaceId: selected.id,
      service,
      authType,
      oauthClientId: clientId.trim(),
      oauthRedirectUris: redirectUris.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      oauthScopes: service === "actions" ? scopes.trim() : "",
      useSharedSecrets: shared,
    });
    if (result.cancelled === true) { setNotice({ text: copy.workspaceAuthCancelled }); return; }
    if (result.ok !== true) throw new Error("Workspace authentication save was not confirmed");
    await refresh();
    setNotice({ text: copy.workspaceAuthSaved, restart: true });
  });

  const copyCredential = (key: CredentialKey) => act(async () => {
    if (!selected) return;
    const result = await getCodingToolsClient().workspaces.copySecret({ workspaceId: selected.id, key });
    if (result.cancelled === true) setNotice({ text: copy.workspaceAuthCancelled });
    else if (result.copied === true) setNotice({ text: copy.workspaceCredentialCopied });
    else throw new Error("Workspace credential copy was not confirmed");
  });

  const control = (operation: "start" | "stop" | "restart") => act(async () => {
    if (!selected) return;
    const result = await getCodingToolsClient().workspaces.service({ workspaceId: selected.id, service, operation });
    if (result.cancelled === true) setNotice({ text: copy.workspaceAuthCancelled });
    else if (result.ok === true) setListener(listenerState(result.status));
    else throw new Error("Workspace listener change was not confirmed");
  });

  const listenerPill: [Tone, string] = listener === "running" ? ["ok", copy.wsListenerRunning]
    : listener === "stopped" ? ["idle", copy.wsListenerStopped]
    : listener === "error" ? ["error", copy.wsListenerError]
    : listener === "checking" ? ["busy", copy.wsListenerChecking]
    : ["warn", listener || copy.workspaceUnknown];
  const port = service === "mcp" ? selected?.mcpLocalPort : selected?.actionsLocalPort;

  return (
    <div className="wsx-page" lang={language} aria-label={copy.workspaceAuth}>
      <p className="wsx-intro">{copy.workspaceAuthBody}</p>
      {!loaded ? <div className="wsx-loading">{copy.wsLoading}</div>
        : !selected ? <div className="surface-empty"><span>{copy.noWorkspaces}</span></div>
        : <>
          <div className="wsx-toolbar">
            <WorkspacePicker workspaces={workspaces} value={workspaceId} label={copy.selectWorkspace} disabled={busy}
              onChange={(id) => { setWorkspaceId(id); setNotice(null); }} />
            <Segmented<Service> label={copy.workspaceService} value={service} disabled={busy}
              options={[{ value: "mcp", label: "MCP" }, { value: "actions", label: "Actions" }]}
              onChange={(next) => { setService(next); setNotice(null); }} />
            <span className="wsx-spacer" />
            <button className="button-secondary" disabled={busy} onClick={() => void refresh()} type="button">
              {loading ? copy.running : copy.refreshTools}
            </button>
          </div>
          <code className="wsx-mono">{selected.path}</code>

          <Card title={copy.workspaceListenerStatus} aside={<Pill tone={listenerPill[0]}>{listenerPill[1]}</Pill>}>
            <dl className="wsx-facts">
              <dt>{service === "mcp" ? "MCP" : "Actions"}</dt>
              <dd>{port ? <code className="wsx-mono">http://127.0.0.1:{port}</code> : copy.wsEndpointUnset}</dd>
            </dl>
            <div className="wsx-actions">
              {listener === "running" ? <>
                <button className="button-secondary" disabled={busy} onClick={() => void control("restart")} type="button">{copy.workspaceRestart}</button>
                <button className="button-secondary" disabled={busy} onClick={() => void control("stop")} type="button">{copy.workspaceStop}</button>
              </> : (
                <button className="button-primary" disabled={busy || listener === "checking"} onClick={() => void control("start")} type="button">{copy.workspaceStart}</button>
              )}
              <span className="wsx-field-hint">{copy.workspaceListenerTunnelNote}</span>
            </div>
          </Card>

          <Card title={copy.wsAuthentication}>
            <form className="wsx-grid" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <Field label={copy.workspaceAuthType} wide>
                {authType === "unknown"
                  ? <select value="unknown" disabled><option value="unknown">{copy.workspaceUnknown}</option></select>
                  : <Segmented label={copy.workspaceAuthType} value={authType} disabled={busy} options={authOptions} onChange={setAuthType} />}
              </Field>
              {authType === "oauth" ? <>
                <Field label={copy.workspaceClientId} wide>
                  <input disabled={busy} spellCheck={false} value={clientId} onChange={(event) => setClientId(event.target.value)} />
                </Field>
                <Field label={copy.workspaceRedirectUris} wide>
                  <textarea disabled={busy} rows={3} spellCheck={false} value={redirectUris} onChange={(event) => setRedirectUris(event.target.value)} />
                </Field>
                {service === "actions" ? (
                  <Field label={copy.workspaceScopes} wide>
                    <input disabled={busy} spellCheck={false} value={scopes} onChange={(event) => setScopes(event.target.value)} />
                  </Field>
                ) : null}
              </> : null}
              <label className="wsx-check" style={{ gridColumn: "1 / -1" }}>
                <input type="checkbox" disabled={busy} checked={shared} onChange={(event) => setShared(event.target.checked)} />
                {copy.workspaceSharedSecrets}
              </label>
              <div className="wsx-actions" style={{ gridColumn: "1 / -1" }}>
                <button className="button-primary" disabled={busy || !dirty} type="submit">{copy.workspaceSaveAuth}</button>
                <span className="wsx-spacer" />
                {credentials.map((credential) => (
                  <button className="button-secondary" disabled={busy} key={credential.key} onClick={() => void copyCredential(credential.key)} type="button">
                    {credential.label}
                  </button>
                ))}
              </div>
              <span className="wsx-field-hint" style={{ gridColumn: "1 / -1" }}>{copy.workspaceAuthSecretNote}</span>
            </form>
            {notice ? (
              <Notice action={notice.restart && listener === "running" ? (
                <button className="button-secondary" disabled={busy} onClick={() => void control("restart")} type="button">{copy.wsRestartToApply}</button>
              ) : undefined}>{notice.text}</Notice>
            ) : null}
          </Card>
        </>}
    </div>
  );
}

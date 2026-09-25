import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { WorkspaceSummary } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import "./workspace-auth.css";

type CredentialKey = "bearer_token" | "oauth_password" | "actions_api_key" | "actions_oauth_client_secret" | "actions_oauth_password";

interface WorkspaceAuthPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

function listenerState(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const state = (value as Record<string, unknown>).state;
    if (typeof state === "string") return state;
  }
  return "unknown";
}

export function WorkspaceAuthPanel({ copy, language, setError }: WorkspaceAuthPanelProps) {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [service, setService] = useState<"mcp" | "actions">("mcp");
  const [authType, setAuthType] = useState("");
  const [clientId, setClientId] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [scopes, setScopes] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [listenerStatus, setListenerStatus] = useState("unknown");
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);

  const refresh = async () => {
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
      setWorkspaceId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Load once when this surface mounts; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    setAuthType(service === "mcp" ? selected.mcpAuthType : selected.actionsAuthType);
    setClientId(service === "mcp" ? selected.mcpOAuthClientId : selected.actionsOAuthClientId);
    setRedirectUris((service === "mcp" ? selected.mcpOAuthRedirectUris : selected.actionsOAuthRedirectUris).join("\n"));
    setScopes(service === "mcp" ? "" : selected.actionsOAuthScopes);
    setShared((service === "mcp" ? selected.mcpUseSharedSecrets : selected.actionsUseSharedSecrets) === true);
  }, [selected, service]);

  useEffect(() => {
    if (!selected) {
      setListenerStatus("unknown");
      return;
    }
    let current = true;
    setListenerStatus("loading");
    void (async () => {
      try {
        const result = await getCodingToolsClient().workspaces.service({ workspaceId: selected.id, service, operation: "status" });
        if (current) setListenerStatus(listenerState(result.status));
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { current = false; };
  }, [selected?.id, service, setError]);

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

  const credentialKeys: CredentialKey[] = service === "mcp"
    ? authType === "oauth" ? ["oauth_password"] : authType === "bearer" ? ["bearer_token"] : []
    : authType === "oauth" ? ["actions_oauth_client_secret", "actions_oauth_password"]
      : authType === "api_key" ? ["actions_api_key"] : [];

  const save = async () => {
    if (!selected || !dirty || busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await getCodingToolsClient().workspaces.updateAuth({
        workspaceId: selected.id,
        service,
        authType,
        oauthClientId: clientId.trim(),
        oauthRedirectUris: redirectUris.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        oauthScopes: service === "actions" ? scopes.trim() : "",
        useSharedSecrets: shared,
      });
      if (result.cancelled === true) {
        setNotice(copy.workspaceAuthCancelled);
      } else if (result.ok === true) {
        await refresh();
        setNotice(copy.workspaceAuthSaved);
      } else {
        throw new Error("Workspace authentication save was not confirmed");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyCredential = async (key: CredentialKey) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await getCodingToolsClient().workspaces.copySecret({ workspaceId: selected.id, key });
      if (result.cancelled === true) {
        setNotice(copy.workspaceAuthCancelled);
      } else if (result.copied === true) {
        setNotice(copy.workspaceCredentialCopied);
      } else {
        throw new Error("Workspace credential copy was not confirmed");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const control = async (operation: "start" | "stop" | "restart") => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await getCodingToolsClient().workspaces.service({ workspaceId: selected.id, service, operation });
      if (result.cancelled === true) {
        setNotice(copy.workspaceAuthCancelled);
      } else if (result.ok === true) {
        setListenerStatus(listenerState(result.status));
      } else {
        throw new Error("Workspace listener change was not confirmed");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={copy.workspaceAuth} lang={language}>
      <div className="section-heading">
        <span>{copy.workspaceAuth}</span>
        <button className="button-secondary" disabled={busy} onClick={() => void refresh()} type="button">
          {busy ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.workspaceAuthBody}</p>
      {loaded && workspaces.length === 0 ? (
        <div className="surface-empty"><span>{copy.noWorkspaces}</span></div>
      ) : selected ? (
        <form className="workspace-auth-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label><span>{copy.selectWorkspace}</span>
            <select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setNotice(""); }}>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <code className="workspace-auth-path">{selected.path}</code>
          <label><span>{copy.workspaceService}</span>
            <select value={service} onChange={(event) => { setService(event.target.value as "mcp" | "actions"); setNotice(""); }}>
              <option value="mcp">MCP</option>
              <option value="actions">Actions</option>
            </select>
          </label>
          <code className="workspace-auth-endpoint">127.0.0.1:{service === "mcp" ? selected.mcpLocalPort ?? "?" : selected.actionsLocalPort ?? "?"}</code>
          <div className="workspace-listener">
            <strong>{copy.workspaceListenerStatus}: {listenerStatus === "loading" ? copy.loading : listenerStatus}</strong>
            <div className="inline-actions">
              {listenerStatus === "running" ? (
                <>
                  <button className="button-secondary" disabled={busy} onClick={() => void control("stop")} type="button">{copy.workspaceStop}</button>
                  <button className="button-secondary" disabled={busy} onClick={() => void control("restart")} type="button">{copy.workspaceRestart}</button>
                </>
              ) : (
                <button className="button-secondary" disabled={busy || (listenerStatus !== "stopped" && listenerStatus !== "error")} onClick={() => void control("start")} type="button">{copy.workspaceStart}</button>
              )}
            </div>
            <p>{copy.workspaceListenerTunnelNote}</p>
          </div>
          <label><span>{copy.workspaceAuthType}</span>
            <select value={authType} onChange={(event) => setAuthType(event.target.value)}>
              {authType === "unknown" ? <option value="unknown" disabled>{copy.workspaceUnknown}</option> : null}
              {service === "mcp" ? (
                <>
                  <option value="oauth">OAuth</option>
                  <option value="bearer">Bearer</option>
                  <option value="noauth">No authentication</option>
                </>
              ) : (
                <>
                  <option value="oauth">OAuth</option>
                  <option value="api_key">API key</option>
                  <option value="none">No authentication</option>
                </>
              )}
            </select>
          </label>
          {authType === "oauth" ? (
            <>
              <label><span>{copy.workspaceClientId}</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
              <label><span>{copy.workspaceRedirectUris}</span><textarea rows={3} value={redirectUris} onChange={(event) => setRedirectUris(event.target.value)} /></label>
              {service === "actions" ? (
                <label><span>{copy.workspaceScopes}</span><input value={scopes} onChange={(event) => setScopes(event.target.value)} /></label>
              ) : null}
            </>
          ) : null}
          <label className="workspace-auth-check"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /><span>{copy.workspaceSharedSecrets}</span></label>
          <p className="workspace-auth-note">{copy.workspaceAuthSecretNote}</p>
          {credentialKeys.length ? (
            <div className="inline-actions">
              {credentialKeys.map((key) => (
                <button className="button-secondary" disabled={busy} key={key} onClick={() => void copyCredential(key)} type="button">
                  {copy.workspaceCopyCredential}: <code>{key}</code>
                </button>
              ))}
            </div>
          ) : null}
          <div className="inline-actions">
            <button className="button-primary" disabled={busy || !dirty} type="submit">{copy.workspaceSaveAuth}</button>
          </div>
          {notice ? <p role="status">{notice}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

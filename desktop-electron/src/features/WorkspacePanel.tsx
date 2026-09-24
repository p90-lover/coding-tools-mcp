import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { WorkspaceSummary } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import "./workspace-panel.css";

interface WorkspacePanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

export function WorkspacePanel({ copy, language, setError }: WorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<{ workspaceId: string; permissionMode: string; approvalMode: string; toolProfile: string; screenCaptureEnabled: boolean } | null>(null);
  const [notice, setNotice] = useState("");

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
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    if (!draft || busy) return;
    const { permissionMode, approvalMode, toolProfile } = draft;
    if ((permissionMode !== "read-only" && permissionMode !== "workspace-write")
      || (approvalMode !== "ask" && approvalMode !== "on-request" && approvalMode !== "never")
      || (toolProfile !== "read-only" && toolProfile !== "core" && toolProfile !== "advanced" && toolProfile !== "compat-readonly-all")) {
      setError(copy.workspaceUnknown);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await getCodingToolsClient().workspaces.updatePolicy({
        workspaceId: draft.workspaceId,
        permissionMode,
        approvalMode,
        toolProfile,
        screenCaptureEnabled: draft.screenCaptureEnabled,
      });
      if (result.cancelled === true) {
        setNotice(copy.workspaceAuthCancelled);
      } else if (result.ok === true) {
        setDraft(null);
        await refresh();
        setNotice(copy.workspaceAuthSaved);
      } else {
        throw new Error("Workspace permissions were not saved");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Load once when the Workspace surface mounts; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-label={copy.workspace} lang={language}>
      <div className="section-heading">
        <span>{copy.workspace}</span>
        <button className="button-secondary" disabled={busy} onClick={() => void refresh()} type="button">
          {busy ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.liveMcpToolsBody}</p>
      {loaded && workspaces.length === 0 ? (
        <div className="surface-empty"><span>{copy.noWorkspaces}</span></div>
      ) : (
        <div className="workspace-access-list">
          {workspaces.map((workspace) => {
            const writable = ["workspace-write", "trusted", "danger-full-access", "dangerous"].includes(workspace.permissionMode);
            const readOnly = ["read-only", "safe"].includes(workspace.permissionMode);
            return (
              <article className="workspace-access-row" key={workspace.id}>
                <header>
                  <h2>{workspace.name}</h2>
                  <button className="button-secondary" disabled={busy} onClick={() => {
                    setDraft(draft?.workspaceId === workspace.id ? null : {
                      workspaceId: workspace.id,
                      permissionMode: workspace.permissionMode,
                      approvalMode: workspace.approvalMode,
                      toolProfile: workspace.toolProfile,
                      screenCaptureEnabled: workspace.screenCaptureEnabled === true,
                    });
                    setNotice("");
                  }} type="button">{copy.workspaceEditPolicy}</button>

                </header>
                <p className="workspace-access-path"><span>{copy.workspacePath}</span><code>{workspace.path}</code></p>
                <dl className="workspace-access-grid">
                  <div><dt>{copy.workspaceReadAccess}</dt><dd>{copy.workspaceReadScope}</dd></div>
                  <div><dt>{copy.workspaceWriteAccess}</dt><dd>{writable ? copy.workspaceWriteScope : readOnly ? copy.workspaceBlocked : copy.workspaceUnknown}</dd></div>
                  <div><dt>{copy.workspacePermissionMode}</dt><dd>{workspace.permissionMode}</dd></div>
                  <div><dt>{copy.workspaceApprovalMode}</dt><dd>{workspace.approvalMode}</dd></div>
                  <div><dt>{copy.workspaceToolProfile}</dt><dd>{workspace.toolProfile}</dd></div>
                  {workspace.linkedProjects.map((project) => (
                    <div key={project.alias}><dt>@{project.alias} · {project.mode}</dt><dd><code>{project.path}</code></dd></div>
                  ))}
                </dl>
                {draft?.workspaceId === workspace.id ? (
                  <form className="workspace-policy-form" onSubmit={(event) => { event.preventDefault(); void savePolicy(); }}>
                    <label><span>{copy.workspacePermissionMode}</span>
                      <select value={draft.permissionMode} onChange={(event) => setDraft((current) => current ? { ...current, permissionMode: event.target.value } : current)}>
                        {!["read-only", "workspace-write"].includes(draft.permissionMode) ? <option disabled value={draft.permissionMode}>{draft.permissionMode}</option> : null}
                        <option value="read-only">read-only</option>
                        <option value="workspace-write">workspace-write</option>
                      </select>
                    </label>
                    <label><span>{copy.workspaceApprovalMode}</span>
                      <select value={draft.approvalMode} onChange={(event) => setDraft((current) => current ? { ...current, approvalMode: event.target.value } : current)}>
                        {!["ask", "on-request", "never"].includes(draft.approvalMode) ? <option disabled value={draft.approvalMode}>{draft.approvalMode}</option> : null}
                        <option value="ask">ask</option>
                        <option value="on-request">on-request</option>
                        <option value="never">never</option>
                      </select>
                    </label>
                    <label><span>{copy.workspaceToolProfile}</span>
                      <select value={draft.toolProfile} onChange={(event) => setDraft((current) => current ? { ...current, toolProfile: event.target.value } : current)}>
                        {!["read-only", "core", "advanced", "compat-readonly-all"].includes(draft.toolProfile) ? <option disabled value={draft.toolProfile}>{draft.toolProfile}</option> : null}
                        <option value="read-only">read-only</option>
                        <option value="core">core</option>
                        <option value="advanced">advanced</option>
                        <option value="compat-readonly-all">compat-readonly-all</option>
                      </select>
                    </label>
                    <label className="workspace-policy-check"><input checked={draft.screenCaptureEnabled} onChange={(event) => setDraft((current) => current ? { ...current, screenCaptureEnabled: event.target.checked } : current)} type="checkbox" /><span>{copy.workspaceCapture}</span></label>
                    <p>{copy.workspacePolicyRestart}</p>
                    <button className="button-primary" disabled={busy || (
                      draft.permissionMode === workspace.permissionMode
                      && draft.approvalMode === workspace.approvalMode
                      && draft.toolProfile === workspace.toolProfile
                      && draft.screenCaptureEnabled === (workspace.screenCaptureEnabled === true)
                    )} type="submit">{copy.workspaceSavePolicy}</button>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      <p className="workspace-access-boundary">{copy.workspaceOutsideScope}</p>
    </section>
  );
}

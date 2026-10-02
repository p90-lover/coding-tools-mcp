import { useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { WorkspaceSummary } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import { Card, Field, Notice, Pill, errorText, useWorkspaces } from "./workspace-ui";

interface WorkspacePanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

type Draft = { workspaceId: string; permissionMode: string; approvalMode: string; toolProfile: string; screenCaptureEnabled: boolean };

const PERMISSION_MODES = ["read-only", "workspace-write"] as const;
const APPROVAL_MODES = ["ask", "on-request", "never"] as const;
const TOOL_PROFILES = ["read-only", "core", "advanced", "compat-readonly-all"] as const;

const isWritable = (mode: string) => ["workspace-write", "trusted", "danger-full-access", "dangerous"].includes(mode);
const isReadOnly = (mode: string) => ["read-only", "safe"].includes(mode);
// The backend treats "full" as an alias of "advanced" (tools/registry_definitions.rs).
const profileOf = (profile: string) => profile === "full" ? "advanced" : profile;

function labels(copy: Copy) {
  return {
    permission: (mode: string) => isWritable(mode) ? copy.wsEditWritable : isReadOnly(mode) ? copy.wsEditReadOnly : mode || copy.workspaceUnknown,
    approval: (mode: string) => ({ ask: copy.wsApprovalAsk, "on-request": copy.wsApprovalOnRequest, never: copy.wsApprovalNever } as Record<string, string>)[mode] ?? mode,
    profile: (profile: string) => ({
      "read-only": copy.wsProfileReadOnly, core: copy.wsProfileCore, advanced: copy.wsProfileAdvanced, full: copy.wsProfileAdvanced,
      "compat-readonly-all": copy.wsProfileCompat,
    } as Record<string, string>)[profile] ?? profile,
  };
}

export function WorkspacePanel({ copy, language, setError }: WorkspacePanelProps) {
  const { workspaces, loaded, loading, refresh } = useWorkspaces(setError);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ workspaceId: string; text: string } | null>(null);
  const label = labels(copy);
  const busy = loading || saving;

  const savePolicy = async () => {
    if (!draft || busy) return;
    const { permissionMode, approvalMode, toolProfile } = draft;
    if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode) || !(APPROVAL_MODES as readonly string[]).includes(approvalMode)
      || !(TOOL_PROFILES as readonly string[]).includes(toolProfile)) {
      setError(copy.workspaceUnknown);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await getCodingToolsClient().workspaces.updatePolicy({
        workspaceId: draft.workspaceId,
        permissionMode: permissionMode as typeof PERMISSION_MODES[number],
        approvalMode: approvalMode as typeof APPROVAL_MODES[number],
        toolProfile: toolProfile as typeof TOOL_PROFILES[number],
        screenCaptureEnabled: draft.screenCaptureEnabled,
      });
      if (result.cancelled === true) {
        setNotice({ workspaceId: draft.workspaceId, text: copy.workspaceAuthCancelled });
      } else if (result.ok === true) {
        const id = draft.workspaceId;
        setDraft(null);
        await refresh();
        setNotice({ workspaceId: id, text: copy.workspacePolicyRestart });
      } else {
        throw new Error("Workspace permissions were not saved");
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const unchanged = (workspace: WorkspaceSummary) => !draft || (
    draft.permissionMode === workspace.permissionMode && draft.approvalMode === workspace.approvalMode
    && draft.toolProfile === profileOf(workspace.toolProfile) && draft.screenCaptureEnabled === (workspace.screenCaptureEnabled === true));

  const select = (key: keyof Draft, value: string, options: readonly string[], describe: (value: string) => string) => (
    <select disabled={busy} value={value} onChange={(event) => setDraft((current) => current ? { ...current, [key]: event.target.value } : current)}>
      {!options.includes(value) ? <option disabled value={value}>{value}</option> : null}
      {options.map((option) => <option key={option} value={option}>{describe(option)}</option>)}
    </select>
  );

  return (
    <div className="wsx-page" lang={language} aria-label={copy.liveMcpTools}>
      <div className="wsx-toolbar">
        <p className="wsx-intro">{copy.wsIntro}</p>
        <span className="wsx-spacer" />
        <button className="button-secondary" disabled={busy} onClick={() => void refresh()} type="button">
          {loading ? copy.running : copy.refreshTools}
        </button>
      </div>
      {!loaded ? <div className="wsx-loading">{copy.wsLoading}</div>
        : workspaces.length === 0 ? <div className="surface-empty"><span>{copy.noWorkspaces}</span></div>
        : workspaces.map((workspace) => {
          const editing = draft?.workspaceId === workspace.id;
          const writable = isWritable(workspace.permissionMode);
          return (
            <Card key={workspace.id} title={workspace.name} aside={!editing ? (
              <button className="button-secondary" disabled={busy} type="button" onClick={() => {
                setDraft({
                  workspaceId: workspace.id, permissionMode: workspace.permissionMode, approvalMode: workspace.approvalMode,
                  toolProfile: profileOf(workspace.toolProfile), screenCaptureEnabled: workspace.screenCaptureEnabled === true,
                });
                setNotice(null);
              }}>{copy.workspaceEditPolicy}</button>) : null}>
              <code className="wsx-mono">{workspace.path}</code>
              <div className="wsx-row">
                <Pill tone={writable ? "warn" : isReadOnly(workspace.permissionMode) ? "ok" : "idle"} title={copy.workspacePermissionMode}>
                  {label.permission(workspace.permissionMode)}</Pill>
                <Pill tone="idle" title={copy.workspaceApprovalMode}>{label.approval(workspace.approvalMode)}</Pill>
                <Pill tone="idle" title={copy.workspaceToolProfile}>{label.profile(workspace.toolProfile)}</Pill>
                {workspace.screenCaptureEnabled === true ? <Pill tone="warn">{copy.wsCaptureOn}</Pill> : null}
              </div>
              {workspace.linkedProjects.length ? (
                <dl className="wsx-facts">
                  {workspace.linkedProjects.map((project) => (
                    <div key={project.alias} style={{ display: "contents" }}>
                      <dt>@{project.alias}</dt>
                      {/* Linked projects are "read-only" or "read-write" (workspace/linked_projects.rs). */}
                      <dd><code className="wsx-mono">{project.path}</code> · {project.mode.toLowerCase() === "read-only" ? copy.wsEditReadOnly : copy.wsEditWritable}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {editing && draft ? (
                <form className="wsx-grid" onSubmit={(event) => { event.preventDefault(); void savePolicy(); }}>
                  <Field label={copy.workspacePermissionMode}>{select("permissionMode", draft.permissionMode, PERMISSION_MODES, label.permission)}</Field>
                  <Field label={copy.workspaceApprovalMode}>{select("approvalMode", draft.approvalMode, APPROVAL_MODES, label.approval)}</Field>
                  <Field label={copy.workspaceToolProfile} wide>{select("toolProfile", draft.toolProfile, TOOL_PROFILES, label.profile)}</Field>
                  <label className="wsx-check" style={{ gridColumn: "1 / -1" }}>
                    <input checked={draft.screenCaptureEnabled} disabled={busy} type="checkbox"
                      onChange={(event) => setDraft((current) => current ? { ...current, screenCaptureEnabled: event.target.checked } : current)} />
                    {copy.workspaceCapture}
                  </label>
                  <div className="wsx-actions" style={{ gridColumn: "1 / -1" }}>
                    <button className="button-primary" disabled={busy || unchanged(workspace)} type="submit">{saving ? copy.running : copy.workspaceSavePolicy}</button>
                    <button className="button-secondary" disabled={saving} type="button" onClick={() => setDraft(null)}>{copy.wsCancel}</button>
                  </div>
                </form>
              ) : null}
              {notice?.workspaceId === workspace.id ? <Notice>{notice.text}</Notice> : null}
            </Card>
          );
        })}
      <p className="wsx-intro" style={{ color: "var(--color-text-tertiary)", fontSize: "var(--text-xs)" }}>{copy.workspaceOutsideScope}</p>
    </div>
  );
}

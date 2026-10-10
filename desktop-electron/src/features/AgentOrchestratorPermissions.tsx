import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { useComposerPopover } from "./AgentOrchestratorComposerControls";
import type { ReactNode } from "react";
import type { AoMission, AoNode } from "./AgentOrchestratorSurface";
import { NATIVE_HARNESS, nativePermission, type AoTeam } from "./AgentOrchestratorRoleEditor";

export type PermissionCapability = {
  supported: boolean; reason?: string;
  profiles: { id: string; allowed: boolean; description?: string }[];
  approval_policies?: string[]; approvals_reviewers?: string[];
  requirements?: Record<string, unknown>;
};
export type RuntimePermissionPolicy = { policy_acknowledged: boolean; effective_policy?: { permission_profile?: string; active_permission_profile?: string; approval_policy?: string; approvals_reviewer?: string } | null };
export type PermissionSelection = { profile?: string; policy?: string; reviewer?: string };
/** The selected chat owns its role list. Include generated helpers without saving new roles. */
export function missionPermissionNodes(mission: AoMission): AoNode[] {
  const nodes = (mission.team?.nodes ?? []).map(node => ({ ...node, route: { ...node.route } }));
  for (const attempt of [...mission.nodes].reverse()) {
    const id = attempt.template_role_id || attempt.id;
    if (!nodes.some(node => node.id === id)) nodes.push({ ...attempt, id, route: { ...attempt.route } });
  }
  return nodes;
}
export function permissionSummary(nodes: AoNode[]): string {
  const values = new Set(nodes.map(node => [nativePermission(node.route), node.route.approval_policy ?? "Legacy", node.route.approvals_reviewer ?? "Legacy"].join(" · ")));
  return values.size > 1 ? "Mixed" : values.values().next().value || "Unknown";
}
/** Persist only explicit fields, never replay a historical chat's other routes or saved permissions. */
export function mergeSavedPermissions(saved: AoTeam, ids: string[], selection: PermissionSelection): AoTeam {
  if (ids.some(id => !saved.nodes.some(node => node.id === id))) throw new Error("Selected role no longer exists in the saved team; refresh before applying.");
  return { ...saved, nodes: saved.nodes.map(node => {
    if (!ids.includes(node.id)) return node;
    const route = { ...node.route };
    if (selection.profile !== undefined) {
      route.native_permission_profile = selection.profile;
      if (route.harness_id === NATIVE_HARNESS) route.permission_profile = selection.profile;
    }
    if (selection.policy !== undefined) route.approval_policy = selection.policy;
    if (selection.reviewer !== undefined) route.approvals_reviewer = selection.reviewer;
    return { ...node, route };
  }) };
}
export function selectPermissions(team: AoTeam, ids: string[], selection: PermissionSelection): AoTeam {
  return { ...team, nodes: team.nodes.map(node => {
    if (!ids.includes(node.id)) return node;
    const route = { ...node.route };
    if (selection.profile !== undefined) { if (route.harness_id === NATIVE_HARNESS) route.permission_profile = selection.profile; route.native_permission_profile = selection.profile; }
    if (selection.policy !== undefined) route.approval_policy = selection.policy;
    if (selection.reviewer !== undefined) route.approvals_reviewer = selection.reviewer;
    return { ...node, route };
  }) };
}

// Codex's three approval modes, in its order, glyphs and wording; Full access is drawn as a warning.
export const PERMISSION_MODES = [
  { label: "Ask for approval", detail: "Always ask to edit external files and use the internet", icon: "hand", profile: ":workspace", policy: "on-request", reviewer: "user", danger: false },
  { label: "Approve for me", detail: "Only ask for actions detected as potentially unsafe", icon: "shieldPrompt", profile: ":workspace", policy: "on-request", reviewer: "auto_review", danger: false },
  { label: "Full access", detail: "Unrestricted access to the internet and any file on your computer", icon: "warning", profile: ":danger-full-access", policy: "never", reviewer: "user", danger: true },
] as const;

/**
 * The permission choices a role may take before it has connected, when there is no runtime yet
 * to report its capabilities. The choice is only saved on the role's route: the connection is
 * refused later if that route's permissions don't match what the runtime grants.
 */
export function draftPermissionCapability(): PermissionCapability {
  // Every Codex mode, Full access included: apply() still asks before arming it.
  const unique = (values: string[]) => [...new Set(values)];
  return { supported: true,
    profiles: unique(PERMISSION_MODES.map(mode => mode.profile)).map(id => ({ id, allowed: true })),
    approval_policies: unique(PERMISSION_MODES.map(mode => mode.policy)),
    approvals_reviewers: unique(PERMISSION_MODES.map(mode => mode.reviewer)) };
}

export function AgentOrchestratorPermissions({ team, mission, busy, loadProfiles, save, runtimePolicies }: {
  team: AoTeam | null; mission?: AoMission; busy: boolean;
  loadProfiles: (roleId: string) => Promise<PermissionCapability>;
  save: (team: AoTeam, missionRevision: number | undefined, selectedRoleIds: string[], selection: PermissionSelection) => Promise<string>;
  /** Retained for legacy callers; shared grant controls deliberately do not render here. */
  shared?: ReactNode; runtimePolicies?: Record<string, RuntimePermissionPolicy>;
}) {
  const popup = useComposerPopover();
  const [metadata, setMetadata] = useState<Record<string, PermissionCapability>>({});
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const nodes = team?.nodes ?? [];
  const supported = nodes.filter(node => metadata[node.id]?.supported);
  const key = nodes.map(node => node.id).join("|");
  useEffect(() => { popup.setOpen(false); setMetadata({}); setNotice(""); }, [mission?.id, team?.id]);
  useEffect(() => {
    if (!popup.open) return;
    let live = true;
    setMetadata({}); setNotice("");
    void Promise.all(nodes.map(async node => {
      try { return [node.id, await loadProfiles(node.id)] as const; }
      catch (cause) { return [node.id, { supported: false, profiles: [], reason: String(cause) }] as const; }
    })).then(entries => { if (live) setMetadata(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [popup.open, key, loadProfiles]);
  const capabilities = supported.map(node => metadata[node.id]);
  const available = nodes.length > 0 && nodes.every(node => metadata[node.id]?.supported === true);
  const canSelect = (selection: PermissionSelection) => available && capabilities.every(capability =>
    capability.profiles.some(profile => profile.id === selection.profile && profile.allowed) &&
    capability.approval_policies?.includes(selection.policy!) && capability.approvals_reviewers?.includes(selection.reviewer!));
  const active = PERMISSION_MODES.find(mode => nodes.length > 0 && nodes.every(node =>
    nativePermission(node.route) === mode.profile && node.route.approval_policy === mode.policy && node.route.approvals_reviewer === mode.reviewer));
  const effective = mission?.nodes.filter(node => ["running", "reserved"].includes(node.state)).map(node => {
    const status = runtimePolicies?.[mission.id + ":" + node.id];
    return status?.policy_acknowledged && status.effective_policy ? "Effective native runtime: " + Object.values(status.effective_policy).join(" · ")
      : "Native policy not acknowledged / effective readback unavailable";
  }).join("; ");
  const reason = nodes.map(node => metadata[node.id]?.reason).filter(Boolean).join("; ")
    || (!nodes.length ? "Choose a model or saved team first." : !nodes.every(node => metadata[node.id] !== undefined) ? "Reading runtime permission capabilities…" : !supported.length ? "Permissions unavailable on this adapter; existing settings remain unchanged." : "Runtime or managed policy does not allow this selection.");
  const apply = async (selection: PermissionSelection) => {
    if (!team || !canSelect(selection) || busy || saving) return;
    if (selection.profile === ":danger-full-access" && !window.confirm("Full access removes the native sandbox boundary. Apply explicitly to these roles? Workspace MCP and app grants remain unchanged.")) return;
    setSaving(true); setNotice(""); setFailed(false);
    try {
      const ids = supported.map(node => node.id);
      setNotice(await save(selectPermissions(team, ids, selection), mission?.revision, ids, selection));
      popup.close();
    } catch (cause) { setFailed(true); setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="ao-permissions ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
    <button type="button" className="ao-composer-chip" ref={popup.trigger} aria-expanded={popup.open} aria-haspopup="menu"
      aria-controls="ao-permissions-panel" disabled={busy || saving} title={permissionSummary(nodes) + (effective ? " · " + effective : "") + (notice && !failed ? " · " + notice : "")}
      onClick={() => popup.setOpen(value => !value)}>
      <Icon name={active?.icon ?? "shield"} width="16" height="16" /><span>{active?.label || "Custom / Mixed"}</span><span aria-hidden="true">⌄</span>
    </button>
    {popup.open ? <section ref={popup.panel} id="ao-permissions-panel" className="ao-composer-popover ao-permissions-panel" aria-label="Access permissions" role="menu">
      <header><h3>How should actions be approved?</h3><button type="button" className="ao-popover-close" aria-label="Close permissions" onClick={popup.close}><Icon name="close" width="14" height="14" /></button></header>
      {PERMISSION_MODES.map(mode => <button key={mode.label} type="button" role="menuitemradio" aria-checked={active?.label === mode.label}
        className={"ao-permission-option" + (mode.danger ? " is-danger" : "")} disabled={busy || saving || !canSelect(mode)} title={canSelect(mode) ? "Applies to queued / future attempts only; running attempts and shared app grants are unchanged." : reason}
        onClick={() => void apply({ profile: mode.profile, policy: mode.policy, reviewer: mode.reviewer })}>
        <span className="ao-permission-symbol"><Icon name={mode.icon} width="17" height="17" /></span>
        <span><strong>{mode.label}</strong><small>{mode.detail}</small></span>
        {active?.label === mode.label ? <Icon name="check" width="16" height="16" /> : null}
      </button>)}
    </section> : null}
    {notice ? <span className="ao-permission-notice" role={failed ? "alert" : "status"}
      style={failed ? undefined : { position: "absolute", width: 1, height: 1, minWidth: 0, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0 }}>{notice}</span> : null}
  </div>;
}

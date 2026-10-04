import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AoMission, AoNode } from "./AgentOrchestratorSurface";
import { NATIVE_HARNESS, nativePermission, roleLabel, type AoTeam } from "./AgentOrchestratorRoleEditor";

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
    if (!ids.includes(node.id) || node.route.harness_id !== NATIVE_HARNESS) return node;
    const route = { ...node.route };
    if (selection.profile !== undefined) { route.permission_profile = selection.profile; route.native_permission_profile = selection.profile; }
    if (selection.policy !== undefined) route.approval_policy = selection.policy;
    if (selection.reviewer !== undefined) route.approvals_reviewer = selection.reviewer;
    return { ...node, route };
  }) };
}

export function AgentOrchestratorPermissions({ team, mission, busy, loadProfiles, save, shared, runtimePolicies }: {
  team: AoTeam | null; mission?: AoMission; busy: boolean;
  loadProfiles: (roleId: string) => Promise<PermissionCapability>;
  save: (team: AoTeam, missionRevision: number | undefined, selectedRoleIds: string[], selection: PermissionSelection) => Promise<string>;
  shared: ReactNode; runtimePolicies?: Record<string, RuntimePermissionPolicy>;
}) {
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState("*");
  const [metadata, setMetadata] = useState<Record<string, PermissionCapability>>({});
  const [selection, setSelection] = useState<PermissionSelection>({});
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const nodes = team?.nodes ?? [];
  const selected = roleId === "*" ? nodes : nodes.filter(node => node.id === roleId);
  const supported = selected.filter(node => node.route.harness_id === NATIVE_HARNESS);
  const key = supported.map(node => node.id).join("|");
  useEffect(() => { setOpen(false); setSelection({}); setMetadata({}); setNotice(""); }, [mission?.id, team?.id]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSelection({}); setMetadata({}); setNotice("");
    void Promise.all(supported.map(async node => {
      try { return [node.id, await loadProfiles(node.id)] as const; }
      catch (cause) { return [node.id, { supported: false, profiles: [], reason: String(cause) }] as const; }
    })).then(entries => { if (live) setMetadata(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [open, key, loadProfiles]);
  const capabilities = supported.map(node => metadata[node.id]);
  const available = capabilities.length > 0 && capabilities.every(cap => cap?.supported);
  const profiles = available ? capabilities[0].profiles.filter(profile => capabilities.every(cap => cap.profiles.some(item => item.id === profile.id && item.allowed))) : [];
  const policies = available ? (capabilities[0].approval_policies ?? []).filter(policy => capabilities.every(cap => cap.approval_policies?.includes(policy))) : [];
  const reviewers = available ? (capabilities[0].approvals_reviewers ?? []).filter(reviewer => capabilities.every(cap => cap.approvals_reviewers?.includes(reviewer))) : [];
  const changed = Object.values(selection).some(value => value !== undefined);
  const apply = async () => {
    if (!team || !available || !changed || busy || saving) return;
    if (selection.profile && /full.access/i.test(selection.profile) && !window.confirm("Full access removes the native sandbox boundary. Apply explicitly to the selected roles? Workspace MCP and app grants remain unchanged.")) return;
    setSaving(true); setNotice("");
    try { const ids = supported.map(node => node.id); setNotice(await save(selectPermissions(team, ids, selection), mission?.revision, ids, selection)); setSelection({}); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="ao-permissions">
    <button type="button" className="button-secondary" aria-expanded={open} aria-controls="ao-permissions-panel" onClick={() => setOpen(value => !value)}>Permissions · {permissionSummary(nodes)}</button>
    {open ? <section id="ao-permissions-panel" className="ao-permissions-panel" aria-label="Chat permissions">
      <h3>Native role permissions</h3>
      <p className="ao-hint">Saved policy for this {mission ? "chat" : "future team"}. Apply updates queued/future attempts only; running attempts keep their bound policy. Saved is not effective runtime readback.</p>
      <label>Roles<select value={roleId} disabled={saving} onChange={event => { setRoleId(event.target.value); setSelection({}); }}>
        <option value="*">All supported roles</option>
        {nodes.map(node => <option key={node.id} value={node.id}>{node.settings?.name || roleLabel(node)} · {node.route.harness_id}</option>)}
      </select></label>
      <p>Saved: {permissionSummary(selected)}</p>
      {selected.filter(node => node.route.harness_id !== NATIVE_HARNESS).map(node => <p key={node.id} className="ao-hint">{node.settings?.name || node.id}: native policy unavailable on {node.route.harness_id}; retained unchanged.</p>)}
      {supported.map(node => <p key={node.id} className="ao-hint">{node.settings?.name || node.id}: {metadata[node.id]?.supported ? "Native runtime metadata available" : metadata[node.id]?.reason || "Reading runtime capability…"}
        {mission?.nodes.filter(attempt => (attempt.template_role_id || attempt.id) === node.id && ["running", "reserved"].includes(attempt.state)).map(attempt => {
          const status = runtimePolicies?.[mission.id + ":" + attempt.id];
          const effective = status?.policy_acknowledged ? status.effective_policy : null;
          return <span key={attempt.id}> · Running attempt saved profile: {attempt.route.permission_profile || "Unknown"}
            {effective ? " · Effective native runtime: " + (effective.permission_profile || "Unknown") + " · " + (effective.approval_policy || "Unknown") + " · " + (effective.approvals_reviewer || "Unknown")
              : " · Native policy not acknowledged / effective readback unavailable; normal lifecycle reconnect may be required."}
          </span>;
        })}
      </p>)}
      <label>Native profile<select value={selection.profile ?? ""} disabled={!available || saving} onChange={event => setSelection(current => ({ ...current, profile: event.target.value || undefined }))}>
        <option value="">Keep saved ({permissionSummary(selected)})</option>
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.id}{profile.description ? " · " + profile.description : ""}</option>)}
      </select></label>
      <label>Native approval policy<select value={selection.policy ?? ""} disabled={!available || saving} onChange={event => setSelection(current => ({ ...current, policy: event.target.value || undefined }))}>
        <option value="">Keep saved / legacy</option>{policies.map(policy => <option key={policy} value={policy}>{policy}</option>)}
      </select></label>
      <label>Approval reviewer<select value={selection.reviewer ?? ""} disabled={!available || saving} onChange={event => setSelection(current => ({ ...current, reviewer: event.target.value || undefined, ...(event.target.value === "auto_review" ? { policy: "on-request" } : {}) }))}>
        <option value="">Keep saved / legacy</option>{reviewers.map(reviewer => <option key={reviewer} value={reviewer}>{reviewer}</option>)}
      </select></label>
      <p className="ao-hint">Automatic review uses on-request with the same sandbox. Native never does not grant workspace MCP/app consent.</p>
      <button type="button" className="button-primary" disabled={!available || !changed || busy || saving} onClick={() => void apply()}>{saving ? "Saving…" : "Apply to queued / future"}</button>
      <button type="button" className="button-secondary" disabled={saving} onClick={() => { setSelection({}); setOpen(false); }}>Cancel</button>
      {notice ? <p role="status">{notice}</p> : null}
      {shared}
    </section> : null}
  </div>;
}

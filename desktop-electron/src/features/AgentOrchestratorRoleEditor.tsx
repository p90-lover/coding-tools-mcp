import { useEffect, useState } from "react";
import type { AoMission, AoNode } from "./AgentOrchestratorSurface";

export type RoleSettings = { name: string; specialty: string; instructions: string; expected_output: string; working_directory: string; revision: number; auto_decide?: boolean };
export type AoTeam = { id: string; workspace_id: string; name: string; revision: number; worker_limit: number; max_review_rounds?: number; nodes: AoNode[] };
export type AoHarness = { id: string; label: string; runnable: boolean; installed: boolean; authStatus?: string; chat?: boolean };
export type AoRoute = AoNode["route"];
export const emptyRoleSettings = (): RoleSettings => ({ name: "", specialty: "", instructions: "", expected_output: "", working_directory: "", revision: 0 });

export const NATIVE_HARNESS = "codex-native";
export const DEFAULT_WORKER_MODEL = "gemini-3.8-flash-high";
export const WEB_ROUTE: AoRoute = { harness_id: NATIVE_HARNESS, provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
export const SPECIALTIES = ["planning", "research", "architecture", "frontend", "backend", "database", "api", "devops", "security",
  "testing", "performance", "debugging", "refactor", "docs", "ui-ux", "mobile", "data-ml", "implementation", "qa", "review", "delivery"];

/**
 * Any worker may use any harness and model: Native Codex runs WebGPT or any model in the
 * shared CPA pool; every other harness runs as an AO worker session.
 */
export function workerRoute(harness: string, model: string, permission: NativePermission = ":workspace"): AoRoute {
  if (harness.startsWith("ao:")) {
    return { harness_id: harness, provider_id: "agent-orchestrator", account_id: "ao-local", model: model || "default", permission_profile: ":ao-default" };
  }
  if (model.startsWith("chatgpt-web/")) return { ...WEB_ROUTE, model, permission_profile: permission };
  return { harness_id: NATIVE_HARNESS, provider_id: "cliproxyapi-antigravity", account_id: "shared-cpa-pool", model, permission_profile: permission };
}

/**
 * Native Codex cards use Codex's own profiles: workspace (create, edit and delete inside the
 * workspace; anything else is asked for) or read-only. Workers default to workspace.
 */
export type NativePermission = ":workspace" | ":read-only";
export const nativePermission = (route: AoRoute): NativePermission => route.permission_profile === ":workspace" ? ":workspace" : ":read-only";

/** "chatgpt-web/extra-high" -> "WebGPT Extra High"; other model ids are shown as-is. */
export function modelLabel(model: string): string {
  // On an AO harness, "cpa/<model>" runs that CPA pool model through the local gateway.
  if (model.startsWith("cpa/")) return `CPA · ${model.slice(4)}`;
  if (!model.startsWith("chatgpt-web/")) return model;
  return `WebGPT ${model.slice("chatgpt-web/".length).split("-").map(part => part[0]?.toUpperCase() + part.slice(1)).join(" ")}`;
}

export function harnessLabel(harnessId: string, harnesses: AoHarness[]): string {
  return harnesses.find(item => item.id === harnessId)?.label
    ?? (harnessId === NATIVE_HARNESS ? "Codex CLI" : harnessId.replace(/^ao:/, ""));
}

export function teamForMission(mission: AoMission, saved: AoTeam | null): AoTeam {
  if (saved) {
    const team = structuredClone(saved);
    if (mission.team?.id === team.id) {
      const extra = mission.team.nodes.filter(role => !team.nodes.some(existing => existing.id === role.id));
      team.nodes.push(...structuredClone(extra));
      const reviewer = team.nodes.find(role => role.role === "reviewer");
      if (reviewer) reviewer.parents = [...new Set([...reviewer.parents, ...extra.map(role => role.id)])];
    }
    return team;
  }
  if (mission.team) return structuredClone(mission.team);
  const roleIds = new Map(mission.nodes.map(node => [node.id, node.template_role_id || node.id]));
  return { id: crypto.randomUUID(), workspace_id: mission.workspace_id, name: "Workspace team", revision: 0, worker_limit: mission.worker_limit || 3,
    nodes: mission.nodes.map(node => ({ id: roleIds.get(node.id)!, task_id: "", role: node.role, route: { ...node.route },
      parents: node.parents.map(id => roleIds.get(id)!), state: "pending", x: node.x, y: node.y, positioned: node.positioned === true,
      settings: { ...emptyRoleSettings(), ...node.settings, name: node.settings?.name || ({ planner: "Orchestrator", approver: "Command approver", worker: "Worker", review_split: "Main reviewer · split", sub_reviewer: "Sub-reviewer", reviewer: "Main reviewer" } as const)[node.role] },
    })) };
}

export function defaultTeam(workspaceId: string, worker: AoRoute): AoTeam {
  return { id: crypto.randomUUID(), workspace_id: workspaceId, name: "Workspace team", revision: 0, worker_limit: 3,
    nodes: [
      { id: "lead", task_id: "", role: "planner", parents: [], x: 0, y: 0, state: "pending", route: WEB_ROUTE, settings: { ...emptyRoleSettings(), name: "Orchestrator", specialty: "planning", instructions: "Break the mission into clear assignments. Coordinate workers and pass their evidence to independent review." } },
      { id: "worker", task_id: "", role: "worker", parents: ["lead"], x: 0, y: 1, state: "pending", route: worker, settings: { ...emptyRoleSettings(), name: "Worker", specialty: "implementation", instructions: "Complete the assigned task within the selected workspace and report the result with evidence." } },
      { id: "review", task_id: "", role: "reviewer", parents: ["worker"], x: 0, y: 2, state: "pending", route: WEB_ROUTE, settings: { ...emptyRoleSettings(), name: "Reviewer", specialty: "review", expected_output: "Begin with APPROVED or CHANGES_REQUIRED and explain why. Do not edit the implementation." } },
    ] };
}

/** Harness + model pickers shared by the inspector, New mission and Add worker sheets. */
export function HarnessPicker({ route, harnesses, loadModels, onChange, disabled = false }: {
  route: AoRoute; harnesses: AoHarness[]; disabled?: boolean;
  loadModels: (harness: string) => Promise<string[]>;
  onChange: (route: AoRoute) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [notice, setNotice] = useState("");
  const harness = route.harness_id;
  useEffect(() => {
    let live = true;
    setModels(null); setNotice("");
    loadModels(harness).then(items => { if (live) setModels(items); })
      .catch(cause => { if (live) { setModels([]); setNotice(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [harness, loadModels]);
  const known = harnesses.some(item => item.id === harness);
  return <>
    <label>Harness<select value={harness} disabled={disabled} onChange={event => onChange(workerRoute(event.target.value, event.target.value === NATIVE_HARNESS ? DEFAULT_WORKER_MODEL : "default", nativePermission(route)))}>
      {!known ? <option value={harness}>{harnessLabel(harness, harnesses)}</option> : null}
      {harnesses.map(item => <option key={item.id} value={item.id} disabled={!item.runnable}>
        {item.label}{!item.runnable ? " · not installed" : item.authStatus === "unauthorized" ? " · sign in" : item.chat === false ? " · terminal" : ""}
      </option>)}
    </select></label>
    <label>Model<select value={route.model} disabled={disabled || models === null} onChange={event => onChange(workerRoute(route.harness_id, event.target.value, nativePermission(route)))}>
      {models && !models.includes(route.model) ? <option value={route.model}>{route.model || "Choose"} (unverified)</option> : null}
      {models === null ? <option value={route.model}>{route.model || "Loading"}</option> : null}
      {(models ?? []).map(model => <option key={model} value={model}>{modelLabel(model)}</option>)}
    </select></label>
    {harness === NATIVE_HARNESS ? <label>Permission<select value={nativePermission(route)} disabled={disabled}
      onChange={event => onChange({ ...route, permission_profile: event.target.value })}>
      <option value=":workspace">Workspace: create, edit and delete in this workspace</option>
      <option value=":read-only">Read only</option>
    </select></label> : null}
    {notice ? <p className="ao-hint" role="status">{notice}</p> : null}
  </>;
}

export function AgentOrchestratorRoleEditor({ node, mission, draft, harnesses, loadModels, busy, change, apply, discard, close, taskName }: {
  node: AoNode; mission: AoMission; draft: AoTeam; harnesses: AoHarness[]; busy: boolean;
  loadModels: (harness: string) => Promise<string[]>;
  change: (team: AoTeam) => void; apply: () => void; discard: () => void; close: () => void; taskName: (id: string) => string;
}) {
  const [tab, setTab] = useState<"settings" | "output" | "history">("settings");
  const roleId = node.template_role_id || node.id;
  const role = draft.nodes.find(role => role.id === roleId);
  const settings = { ...emptyRoleSettings(), ...role?.settings };
  const jobs = mission.nodes.filter(job => (job.template_role_id || job.id) === roleId);
  const [jobId, setJobId] = useState(node.id);
  const job = jobs.find(job => job.id === jobId) || jobs[0] || node;
  const updateRole = (patch: Partial<AoNode>) => change({ ...draft, nodes: draft.nodes.map(item => item.id === roleId ? { ...item, ...patch } : item) });
  const updateSettings = (patch: Partial<RoleSettings>) => updateRole({ settings: { ...settings, ...patch } });
  const changeKind = (kind: AoNode["role"]) => {
    // Every role may run on any harness and model, so changing the role keeps its route.
    if (role) updateRole({ role: kind });
  };
  return <aside className="ao-role-inspector" aria-label="Role inspector">
    <div className="ao-inspector-header">
      <span className={`ao-dot ao-dot-${node.state}`} aria-hidden="true" />
      <strong>{settings.name || node.role}</strong>
      <span className="ao-inspector-state">{node.state}</span>
      <button type="button" onClick={close} aria-label="Close role inspector">×</button>
    </div>
    <div className="ao-inspector-tabs" role="tablist" aria-label="Role details">
      {(["settings", "output", "history"] as const).map(name => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div>
    {tab === "settings" ? role ? <form onSubmit={event => { event.preventDefault(); apply(); }}>
      <div className="ao-field-row">
        <label>Name<input maxLength={96} value={settings.name} onChange={event => updateSettings({ name: event.target.value })} /></label>
        <label>Role<select value={role.role} onChange={event => changeKind(event.target.value as AoNode["role"])}>
          <option value="planner">Orchestrator</option><option value="approver">Command approver</option><option value="worker">Worker</option>
          <option value="sub_reviewer">Sub-reviewer</option><option value="reviewer">Main reviewer</option>
          {role.role === "review_split" ? <option value="review_split">Main reviewer · split</option> : null}
        </select></label>
      </div>
      <div className="ao-field-row">
        <HarnessPicker route={role.route} harnesses={harnesses} loadModels={loadModels} onChange={route => updateRole({ route })} />
      </div>
      <label>Focus<select value={settings.specialty} onChange={event => updateSettings({ specialty: event.target.value })}>
        <option value="">Custom</option>{SPECIALTIES.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label>Instructions<textarea aria-label="Instructions" rows={4} maxLength={4096} value={settings.instructions} onChange={event => updateSettings({ instructions: event.target.value })} /></label>
      <details className="ao-more">
        <summary>More</summary>
        <label>Expected output<textarea aria-label="Expected output" rows={3} maxLength={2048} value={settings.expected_output} onChange={event => updateSettings({ expected_output: event.target.value })} /></label>
        <label>Working directory<input placeholder="Workspace root" maxLength={512} value={settings.working_directory} onChange={event => updateSettings({ working_directory: event.target.value })} /></label>
      </details>
      <div className="ao-inspector-actions" title="Saves the team and updates queued cards. Running attempts keep their settings.">
        <button className="button-primary" type="submit" disabled={busy || !role.route.model}>Apply</button>
        <button className="button-secondary" type="button" disabled={busy} onClick={discard}>Reset</button>
      </div>
    </form> : <p className="ao-hint">Not linked to the saved team. Results stay available.</p> : null}
    {tab === "output" ? <div>
      {jobs.length > 1 ? <label>Task<select value={job.id} onChange={event => setJobId(event.target.value)}>{jobs.map(item => <option key={item.id} value={item.id}>{taskName(item.task_id)}</option>)}</select></label> : null}
      {job.receipt?.error ? <p role="alert">{job.receipt.error}</p> : null}
      {job.receipt?.verdict ? <p className="ao-chip-line"><span className="ao-chip">{job.receipt.verdict}</span></p> : null}
      <pre>{job.receipt?.answer || "No output yet."}</pre>
    </div> : null}
    {tab === "history" ? <div>{jobs.map(item => <section key={item.id} className="ao-attempt-history">
      <strong>{taskName(item.task_id)}</strong>
      {[...(item.history || []), ...(item.receipt ? [item.receipt] : [])].map((receipt, index) => <details key={receipt.request_key || index}>
        <summary>#{index + 1} · {receipt.status}</summary>
        <dl><dt>Model</dt><dd>{receipt.route?.model || item.route.model}</dd><dt>Session</dt><dd>{receipt.thread_id || "—"}</dd><dt>Turn</dt><dd>{receipt.turn_id || "—"}</dd></dl>
        {receipt.error ? <p role="alert">{receipt.error}</p> : null}<pre>{receipt.answer || "No final output"}</pre>
      </details>)}
      {!item.receipt && !item.history?.length ? <p className="ao-hint">Not started</p> : null}
    </section>)}</div> : null}
  </aside>;
}

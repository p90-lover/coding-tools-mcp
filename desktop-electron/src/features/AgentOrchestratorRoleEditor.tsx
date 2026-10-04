import { useEffect, useState } from "react";
import type { AoMission, AoNode } from "./AgentOrchestratorSurface";

export type RoleSettings = { name: string; specialty: string; instructions: string; expected_output: string; working_directory: string; revision: number; auto_decide?: boolean; role_name?: string };
export type AoTeam = { id: string; workspace_id: string; name: string; revision: number; worker_limit: number; max_review_rounds?: number; nodes: AoNode[]; permission_selections?: Record<string, { permission_profile?: string; approval_policy?: string; approvals_reviewer?: string }> };
export type AoHarness = { id: string; label: string; runnable: boolean; installed: boolean; authStatus?: string; chat?: boolean };
export type AoRoute = AoNode["route"];
export const emptyRoleSettings = (): RoleSettings => ({ name: "", specialty: "", instructions: "", expected_output: "", working_directory: "", revision: 0 });

export const NATIVE_HARNESS = "codex-native";
/** New workers run Gemini through the CPA gateway on Claude Code (Native Codex is for OpenAI models). */
export const DEFAULT_WORKER_HARNESS = "ao:claude-code";
export const DEFAULT_WORKER_MODEL = "cpa/gemini-3.8-flash-high";
/** "default" lets an AO agent pick (and change) its own model, so it is never offered or saved. */
export const AGENT_DEFAULT_MODEL = "default";
export const WEB_ROUTE: AoRoute = { harness_id: NATIVE_HARNESS, provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
export const SPECIALTIES = ["planning", "research", "architecture", "frontend", "backend", "database", "api", "devops", "security",
  "testing", "performance", "debugging", "refactor", "docs", "ui-ux", "mobile", "data-ml", "implementation", "qa", "review", "delivery"];

/**
 * Native Codex runs only WebGPT, through the bridge; every other model runs on an AO harness
 * (CPA pool models through the gateway as "cpa/<model>"). A WebGPT model therefore always gets
 * the Native Codex route, and any other model picked on Native Codex moves to an AO harness:
 * Gemini to Claude Code, the rest to Codex.
 */
export const isWebModel = (model: string) => model.replace(/^cpa\//, "").startsWith("chatgpt-web/");

export function workerRoute(harness: string, model: string, permission: NativePermission = ":workspace"): AoRoute {
  const bare = model.replace(/^cpa\//, "");
  if (isWebModel(model)) return { ...WEB_ROUTE, model: bare, permission_profile: permission === ":ao-default" ? WEB_ROUTE.permission_profile : permission };
  const agent = harness.startsWith("ao:") ? harness : /^gemini/i.test(bare) ? "ao:claude-code" : "ao:codex";
  const routed = harness.startsWith("ao:") || !model ? model : `cpa/${bare}`;
  return { harness_id: agent, provider_id: "agent-orchestrator", account_id: "ao-local", model: routed || "default", permission_profile: ":ao-default" };
}

/** Reasoning efforts a card may ask for (Codex's names; the engine checks the same list). */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
/** Effort applies on Native Codex and to an AO agent's own models; AO skips it for gateway models. */
export const effortApplies = (route: AoRoute) => !(route.harness_id.startsWith("ao:") && route.model.startsWith("cpa/"));
/** Only Native Codex has a context-window setting. */
export const contextApplies = (route: AoRoute) => route.harness_id === NATIVE_HARNESS;

/** Carry a card's effort and context window over to its new route where they still apply. */
export function withTuning(next: AoRoute, previous: AoRoute): AoRoute {
  const route: AoRoute = { ...next };
  // Routing is not a permission change: preserve raw custom and managed profile IDs.
  const permission = previous.harness_id === NATIVE_HARNESS ? previous.permission_profile : previous.native_permission_profile ?? (previous.permission_profile !== ":ao-default" ? previous.permission_profile : undefined);
  if (permission !== undefined) {
    if (route.harness_id === NATIVE_HARNESS) route.permission_profile = permission;
    else route.native_permission_profile = permission;
  }
  if (route.harness_id === NATIVE_HARNESS && previous.native_permission_profile !== undefined) route.native_permission_profile = previous.native_permission_profile;
  if (previous.approval_policy !== undefined) route.approval_policy = previous.approval_policy;
  if (previous.approvals_reviewer !== undefined) route.approvals_reviewer = previous.approvals_reviewer;
  delete route.effort;
  delete route.context_window;
  if (previous.effort && effortApplies(route)) route.effort = previous.effort;
  if (previous.context_window && contextApplies(route)) route.context_window = previous.context_window;
  return route;
}

/** 262144 -> "256K"; 1048576 and 1000000 -> "1M". */
export function tokensLabel(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_024 && tokens % 1_024 === 0) return `${tokens / 1_024}K`;
  return tokens.toLocaleString("en-US");
}

const ROLE_LABELS = { planner: "Orchestrator", approver: "Command approver", worker: "Worker", review_split: "Main reviewer · split", sub_reviewer: "Sub-reviewer", reviewer: "Main reviewer" } as const;

/** The role a card shows: the custom role the user typed, else its built-in role's name. */
export function roleLabel(node: Pick<AoNode, "role" | "settings">): string {
  return node.settings?.role_name?.trim() || ROLE_LABELS[node.role];
}

/** One line describing how a card runs: harness · model · effort · context · role. */
export function cardMeta(node: Pick<AoNode, "role" | "settings" | "route">, harnesses: AoHarness[] = []): string {
  const route = node.route;
  return [
    harnessLabel(route.harness_id, harnesses),
    modelLabel(route.model),
    route.effort && effortApplies(route) ? `effort ${route.effort}` : "",
    route.context_window && contextApplies(route) ? `${tokensLabel(route.context_window)} context` : "",
    roleLabel(node),
  ].filter(Boolean).join(" · ");
}

/**
 * Native Codex cards use Codex's own profiles: workspace (create, edit and delete inside the
 * workspace; anything else is asked for) or read-only. Workers default to workspace.
 */
export type NativePermission = string;
export const nativePermission = (route: AoRoute): NativePermission => route.harness_id === NATIVE_HARNESS ? route.permission_profile : route.native_permission_profile ?? route.permission_profile;

/** "chatgpt-web/extra-high" -> "WebGPT Extra High"; other model ids are shown as-is. */
export function modelLabel(model: string): string {
  // On an AO harness, "cpa/<model>" runs that CPA pool model through the local gateway.
  if (model.startsWith("cpa/")) return `CPA · ${model.slice(4)}`;
  if (!model.startsWith("chatgpt-web/")) return model;
  return `WebGPT ${model.slice("chatgpt-web/".length).split("-").map(part => part[0]?.toUpperCase() + part.slice(1)).join(" ")}`;
}

export function harnessLabel(harnessId: string, harnesses: AoHarness[]): string {
  return harnesses.find(item => item.id === harnessId)?.label
    ?? (harnessId === NATIVE_HARNESS ? "Native Codex" : harnessId.replace(/^ao:/, ""));
}

export function teamForMission(mission: AoMission, saved: AoTeam | null): AoTeam {
  if (saved) {
    if (mission.team && mission.team.id !== saved.id) return structuredClone(mission.team);
    const team = structuredClone(saved);
    if (mission.team?.id === team.id) {
      // Use this mission's policy snapshot, retaining the revision needed for optimistic save.
      team.nodes = team.nodes.map(role => {
        const snapshot = mission.team!.nodes.find(item => item.id === role.id);
        return snapshot ? { ...role, route: structuredClone(snapshot.route), settings: structuredClone(snapshot.settings) } : role;
      });
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
    // Every harness also lists the WebGPT models; choosing one moves the card to Native Codex,
    // the only harness WebGPT runs on (workerRoute).
    const web = harness === NATIVE_HARNESS ? Promise.resolve([])
      : loadModels(NATIVE_HARNESS).then(items => items.filter(isWebModel), () => []);
    Promise.all([loadModels(harness), web]).then(([items, webItems]) => { if (live) setModels([...new Set([...items, ...webItems])]); })
      .catch(cause => { if (live) { setModels([]); setNotice(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [harness, loadModels]);
  const known = harnesses.some(item => item.id === harness);
  return <>
    <label>Harness<select value={harness} disabled={disabled} onChange={event => {
      // Start each harness on an explicit model; an agent without a known one shows "Choose a model".
      const next = event.target.value;
      const model = next === NATIVE_HARNESS ? WEB_ROUTE.model : next === DEFAULT_WORKER_HARNESS ? DEFAULT_WORKER_MODEL : "";
      onChange(withTuning(workerRoute(next, model, nativePermission(route)), route));
    }}>
      {!known ? <option value={harness}>{harnessLabel(harness, harnesses)}</option> : null}
      {harnesses.map(item => <option key={item.id} value={item.id} disabled={!item.runnable}>
        {item.label}{!item.runnable ? " · not installed" : item.authStatus === "unauthorized" ? " · sign in" : item.chat === false ? " · terminal" : ""}
      </option>)}
    </select></label>
    <label>Model<select value={route.model} disabled={disabled || models === null} onChange={event => onChange(withTuning(workerRoute(route.harness_id, event.target.value, nativePermission(route)), route))}>
      {!route.model || route.model === AGENT_DEFAULT_MODEL
        ? <option value={route.model} disabled>Choose a model{route.model ? " (\"default\" is not allowed)" : ""}</option>
        : models && !models.includes(route.model) ? <option value={route.model}>{route.model} (unverified)</option> : null}
      {models === null ? <option value={route.model}>{route.model || "Loading"}</option> : null}
      {(models ?? []).map(model => <option key={model} value={model}>
        {modelLabel(model)}{harness !== NATIVE_HARNESS && isWebModel(model) ? " · switches to Native Codex" : ""}
      </option>)}
    </select></label>
    {harness === NATIVE_HARNESS ? <p className="ao-hint">Saved native permission: {nativePermission(route) || "Unknown"}. Change permissions explicitly in the chat composer menu; runtime capabilities are authoritative.</p>
      : <p className="ao-hint">Native Codex runs only WebGPT: choosing a WebGPT model switches to it, and any other model runs here. Native permissions are retained but unavailable on this adapter.</p>}
    <fieldset className="ao-route-tuning"><legend>Model tuning</legend>
    <label title={effortApplies(route) ? "Reasoning effort for this card" : "AO skips effort for CPA gateway models"}>Reasoning effort
      <select value={effortApplies(route) ? route.effort ?? "" : ""} disabled={disabled || !effortApplies(route)}
        onChange={event => { const next = { ...route }; if (event.target.value) next.effort = event.target.value; else delete next.effort; onChange(next); }}>
        <option value="">{effortApplies(route) ? "Model default" : "Not applicable (gateway model)"}</option>
        {EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select></label>
    <label title={contextApplies(route) ? "Context window in tokens (4,096 to 2,000,000)" : "AO harnesses have no context-window setting"}>Context window
      <input type="number" min={4096} max={2000000} step={1} inputMode="numeric" disabled={disabled || !contextApplies(route)}
        placeholder={contextApplies(route) ? "Model default" : "Not applicable on AO harnesses"}
        value={contextApplies(route) ? route.context_window ?? "" : ""}
        onChange={event => { const next = { ...route }; const tokens = Math.round(Number(event.target.value)); if (event.target.value && Number.isFinite(tokens)) next.context_window = tokens; else delete next.context_window; onChange(next); }} /></label>
    <p className="ao-hint ao-wide">{contextApplies(route)
      ? "Native harness context budget: 4,096–2,000,000 tokens. Blank uses the model default, not a claimed model limit."
      : effortApplies(route) ? "This harness accepts reasoning effort; context window is managed by the harness."
      : "CPA gateway models manage their own effort and context window; these overrides are not sent."}</p>
    </fieldset>
    {notice ? <p className="ao-hint" role="status">{notice}</p> : null}
  </>;
}

export function AgentOrchestratorRoleEditor({ node, mission, draft, harnesses, loadModels, busy, change, apply, discard, taskName }: {
  node: AoNode; mission: AoMission; draft: AoTeam; harnesses: AoHarness[]; busy: boolean;
  loadModels: (harness: string) => Promise<string[]>;
  change: (team: AoTeam) => void; apply: () => void; discard: () => void; taskName: (id: string) => string;
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
    if (role) updateRole({ role: kind, settings: { ...settings, role_name: "" } });
  };
  // A custom role works as a worker under the name the user typed; names already used in this
  // team are offered again.
  const customRoles = [...new Set(draft.nodes.map(item => item.settings?.role_name?.trim() || "").filter(Boolean))];
  const roleValue = settings.role_name !== undefined && settings.role_name !== "" ? `custom:${settings.role_name}` : role?.role ?? "worker";
  const [typingRole, setTypingRole] = useState(false);
  const pickRole = (value: string) => {
    if (!role) return;
    if (value === "custom:") { setTypingRole(true); updateRole({ role: "worker", settings: { ...settings, role_name: settings.role_name || "" } }); return; }
    setTypingRole(false);
    if (value.startsWith("custom:")) updateRole({ role: "worker", settings: { ...settings, role_name: value.slice(7) } });
    else changeKind(value as AoNode["role"]);
  };
  return <div className="ao-role-inspector" aria-label="Role inspector">
    <div className="ao-inspector-tabs" role="tablist" aria-label="Role details">
      {(["settings", "output", "history"] as const).map(name => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div>
    {tab === "settings" ? role ? <form onSubmit={event => { event.preventDefault(); apply(); }}>
      <div className="ao-field-row">
        <label>Name<input maxLength={96} value={settings.name} onChange={event => updateSettings({ name: event.target.value })} /></label>
        <label>Role<select value={typingRole ? "custom:" : roleValue} onChange={event => pickRole(event.target.value)}>
          <option value="planner">Orchestrator</option><option value="approver">Command approver</option><option value="worker">Worker</option>
          <option value="sub_reviewer">Sub-reviewer</option><option value="reviewer">Main reviewer</option>
          {role.role === "review_split" ? <option value="review_split">Main reviewer · split</option> : null}
          {customRoles.map(name => <option key={name} value={`custom:${name}`}>{name}</option>)}
          <option value="custom:">Custom role…</option>
        </select></label>
      </div>
      {typingRole || (settings.role_name !== undefined && settings.role_name !== "" && !customRoles.includes(settings.role_name.trim()))
        ? <label>Custom role<input autoFocus maxLength={48} placeholder="e.g. Security auditor" value={settings.role_name ?? ""}
          onChange={event => updateSettings({ role_name: event.target.value })} onBlur={() => setTypingRole(false)} /></label> : null}
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
  </div>;
}

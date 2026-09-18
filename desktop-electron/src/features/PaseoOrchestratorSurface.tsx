import { useEffect, useMemo, useState } from "react";
import type {
  Language,
  ProviderAccountRecord,
  ProviderExecutionPlan,
  ProviderNetworkSnapshot,
} from "../types";
import type { JsonObject } from "../api/contracts";
import {
  boardRevision,
  executionBindings,
  messageOf,
  missionRevision,
  missionViews,
  object,
  sanitizeIdentifier,
  selectBinding,
  workspaceOptions,
  type MissionView,
  type WorkspaceOption,
} from "./execution-surface-utils";
import {
  actionLabel,
  orchestrationCopy,
  phaseLabel,
} from "./orchestration-copy";
import "./orchestration-control.css";

type Action = "create" | "start" | "hold" | "resume" | "cancel" | "close";
type InspectorTab = "route" | "mission" | "plan";
type SubagentDraft = {
  key: string;
  providerId: string;
  accountId: string;
  model: string;
  role: string;
};
const ACTIONS: readonly Exclude<Action, "create">[] = ["start", "hold", "resume", "cancel", "close"];
const WEB_GPT_PROVIDER_ID = "chatgpt-web";

function usable(snapshot: ProviderNetworkSnapshot | null): ProviderAccountRecord[] {
  return (snapshot?.accounts ?? []).filter((account) => (
    account.enabled && account.status === "connected" && !account.archivedAt
  ));
}

function canRun(action: Action, mission: MissionView | undefined): boolean {
  if (!mission) return false;
  if (action === "start") return ["ready", "changes_requested"].includes(mission.phase);
  if (["hold", "cancel"].includes(action)) {
    return ["running", "unknown", "scheduling_held"].includes(mission.phase);
  }
  if (action === "resume") return mission.phase === "held";
  if (action === "close") {
    return mission.quiescent
      && ["ready", "held", "review_required", "accepted", "changes_requested"].includes(mission.phase);
  }
  return action === "create" && mission.phase === "draft";
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function phaseTone(phase: string): string {
  if (["accepted", "closed"].includes(phase)) return "is-success";
  if (["ready", "review_required", "changes_requested"].includes(phase)) return "is-warning";
  if (["failed", "cancelled"].includes(phase)) return "is-error";
  if (["running"].includes(phase)) return "is-running";
  return "is-muted";
}

export function PaseoOrchestratorSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = orchestrationCopy(language);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [network, setNetwork] = useState<ProviderNetworkSnapshot | null>(null);
  const [providerId, setProviderId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [route, setRoute] = useState<ProviderExecutionPlan | null>(null);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [missionId, setMissionId] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("route");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [subagents, setSubagents] = useState<SubagentDraft[]>([]);
  const [assignmentPlan, setAssignmentPlan] = useState<JsonObject | null>(null);
  const [assignmentRun, setAssignmentRun] = useState<JsonObject | null>(null);
  const [assignmentReview, setAssignmentReview] = useState<JsonObject | null>(null);

  const accounts = useMemo(() => usable(network), [network]);
  const providers = useMemo(
    () => [...new Set(accounts.map((account) => account.providerId))],
    [accounts],
  );
  const matchingAccounts = useMemo(
    () => accounts.filter((account) => !providerId || account.providerId === providerId),
    [accounts, providerId],
  );
  const account = matchingAccounts.find((candidate) => candidate.id === accountId)
    ?? matchingAccounts[0];
  const selectedMission = missions.find((mission) => mission.id === missionId);

  useEffect(() => {
    const launcher = window.codexWebLauncher;
    const codingTools = window.codingTools;
    if (!launcher || !codingTools) return;
    let cancelled = false;
    void Promise.all([launcher.providerSnapshot(), codingTools.workspaces.list({})])
      .then(([snapshot, page]) => {
        if (cancelled) return;
        setNetwork(snapshot);
        const options = workspaceOptions(page);
        setWorkspaces(options);
        setWorkspaceId(options[0]?.id ?? "");
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = launcher.onProviderNetworkChanged(setNetwork);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setError]);

  useEffect(() => {
    if (!providers.length) return;
    setProviderId((current) => (
      current
      || (providers.includes(WEB_GPT_PROVIDER_ID) ? WEB_GPT_PROVIDER_ID : providers[0] ?? "")
    ));
  }, [providers]);

  useEffect(() => {
    const first = matchingAccounts[0];
    setAccountId((current) => (
      matchingAccounts.some((candidate) => candidate.id === current)
        ? current
        : first?.id ?? ""
    ));
  }, [matchingAccounts]);

  useEffect(() => {
    setModel((current) => (
      current && account?.models.includes(current)
        ? current
        : account?.models[0] ?? ""
    ));
  }, [account]);

  useEffect(() => {
    if (!accounts.length) return;
    setSubagents((current) => {
      if (current.length) return current;
      const fallback = accounts.find((item) => item.providerId !== providerId) ?? accounts[0];
      return [{
        key: crypto.randomUUID().slice(0, 8),
        providerId: fallback?.providerId ?? "",
        accountId: fallback?.id ?? "",
        model: fallback?.models[0] ?? "",
        role: "implementer",
      }];
    });
  }, [accounts, providerId]);

  useEffect(() => {
    if (workspaceId) void refresh();
  }, [workspaceId]);

  const refresh = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId) return;
    setBusy(true);
    try {
      const view = await api.execution.read({
        workspaceId,
        missionId: null,
        refreshSource: false,
      });
      const next = missionViews(view).filter((mission) => mission.engine === "paseo");
      setMissions(next);
      setMissionId((current) => (
        next.some((mission) => mission.id === current)
          ? current
          : next[0]?.id ?? ""
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const plan = async (): Promise<ProviderExecutionPlan> => {
    const launcher = window.codexWebLauncher;
    if (!launcher) throw new Error(copy.executionPlanningUnavailable);
    const next = await launcher.providerExecutionPlan({
      workload: "paseo",
      ...(providerId ? { providerId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      allowFallback,
    });
    setRoute(next);
    return next;
  };

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await plan();
      setInspectorTab("route");
      setNotice(`${copy.routeReady}: ${next.provider.name} · ${next.account.label}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const callPlane = async (tool: string, args: JsonObject): Promise<JsonObject> => {
    const api = window.codingTools;
    if (!api) throw new Error(copy.executionPlanningUnavailable);
    if (!workspaceId) throw new Error(copy.chooseWorkspace);
    return api.tools.call({
      workspaceId,
      tool,
      arguments: args,
    }) as Promise<JsonObject>;
  };

  const planAssignments = async () => {
    if (!taskId.trim() || !subagents.length) return;
    setBusy(true);
    setError(null);
    try {
      const next = await callPlane("paseo_plan", {
        brief: taskId.trim(),
        orchestrator: {
          providerId,
          accountId,
          model,
          allowFallback,
        },
        subagents: subagents.map((item) => ({
          role: item.role,
          providerId: item.providerId,
          accountId: item.accountId,
          model: item.model,
          allowFallback,
        })),
      });
      setAssignmentPlan(next);
      setAssignmentRun(null);
      setAssignmentReview(null);
      setInspectorTab("plan");
      setNotice(`${copy.paseoAssignmentPreview}: ${stringValue(object(next.orchestrator)?.role, "orchestrator")}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const runSubagents = async () => {
    const planId = stringValue(assignmentPlan?.id);
    if (!planId || !taskId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await callPlane("paseo_run", {
        planId,
        message: taskId.trim(),
      });
      setAssignmentRun(next);
      setInspectorTab("plan");
      setNotice(copy.paseoRunningSubagents);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const reviewResults = async () => {
    const runId = stringValue(assignmentRun?.id);
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await callPlane("paseo_review", { runId });
      setAssignmentReview(next);
      setInspectorTab("plan");
      setNotice(copy.paseoReviewReady);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openAnnealTask = async () => {
    const reviewId = stringValue(assignmentReview?.id);
    if (!reviewId) return;
    setBusy(true);
    setError(null);
    try {
      await callPlane("anneal_open_from_review", { reviewId });
      setNotice(copy.paseoAnnealTaskOpened);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const recordAssignment = async (assignmentId: string, withIssue: boolean) => {
    const runId = stringValue(assignmentRun?.id);
    if (!runId || !assignmentId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await callPlane("paseo_submit_result", {
        runId,
        assignmentId,
        ok: !withIssue,
        summary: taskId.trim() || assignmentId,
        issues: withIssue
          ? [{ title: (taskId.trim() || assignmentId).slice(0, 240), detail: taskId.trim() }]
          : [],
      });
      setAssignmentRun(next);
      const reviewed = await callPlane("paseo_review", { runId });
      setAssignmentReview(reviewed);
      setInspectorTab("plan");
      setNotice(copy.paseoReviewReady);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const updateSubagent = (key: string, patch: Partial<SubagentDraft>) => {
    setSubagents((current) => current.map((item) => (
      item.key === key ? { ...item, ...patch } : item
    )));
  };

  const prepare = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId || !taskId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const selectedRoute = await plan();
      const view = await api.execution.read({
        workspaceId,
        missionId: null,
        refreshSource: false,
      });
      const binding = selectBinding(
        view,
        "paseo",
        selectedRoute.provider.id,
        selectedRoute.model,
      );
      if (!binding) {
        const available = executionBindings(view)
          .filter((candidate) => candidate.engine === "paseo")
          .map((candidate) => `${candidate.provider}/${candidate.model}`)
          .join(", ");
        throw new Error(available
          ? `${copy.paseoBindingsMissing} ${copy.paseoAvailableBindings}: ${available}`
          : copy.paseoBindingsMissing);
      }
      const id = sanitizeIdentifier(`paseo-${taskId}-${crypto.randomUUID().slice(0, 8)}`);
      await api.execution.update({
        workspaceId,
        expectedRevision: boardRevision(view),
        change: {
          operation: "agent_prepare",
          binding_id: binding.id,
          task_id: taskId.trim(),
          mission_id: id,
        },
        confirm: true,
      });
      const prepared = await api.execution.read({
        workspaceId,
        missionId: id,
        refreshSource: false,
      });
      await api.execution.update({
        workspaceId,
        expectedRevision: missionRevision(prepared, id),
        change: {
          operation: "agent_control",
          mission_id: id,
          request_key: crypto.randomUUID(),
          action: "create",
        },
        confirm: true,
      });
      setMissionId(id);
      setInspectorTab("mission");
      setNotice(copy.paseoMissionCreationSubmitted);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: Exclude<Action, "create">) => {
    const api = window.codingTools;
    if (!api || !workspaceId || !missionId) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.execution.read({
        workspaceId,
        missionId,
        refreshSource: false,
      });
      await api.execution.update({
        workspaceId,
        expectedRevision: missionRevision(view, missionId),
        change: {
          operation: "agent_control",
          mission_id: missionId,
          request_key: crypto.randomUUID(),
          action,
        },
        confirm: true,
      });
      setNotice(`${actionLabel(copy, action)} · ${missionId}`);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId || !missionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.execution.read({ workspaceId, missionId, refreshSource: true });
      await refresh();
      setInspectorTab("mission");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const beginNewSession = () => {
    setMissionId("");
    setTaskId("");
    setRoute(null);
    setAssignmentPlan(null);
    setAssignmentRun(null);
    setAssignmentReview(null);
    setNotice("");
    setInspectorTab("route");
  };

  const proxySummary = route?.proxy.mode === "profile"
    ? `${route.proxy.source} · ${route.proxy.profile?.name ?? copy.proxy}`
    : copy.direct;

  return (
    <section className="control-surface paseo-studio">
      <aside className="paseo-session-rail">
        <header className="paseo-rail-header">
          <div>
            <span className="surface-kicker">PASEO</span>
            <h1>{copy.paseoSessions}</h1>
          </div>
          <button
            aria-label={copy.paseoNewSession}
            className="paseo-new-session-button"
            onClick={beginNewSession}
            type="button"
          >
            +
          </button>
        </header>
        <button className="paseo-new-session-card" onClick={beginNewSession} type="button">
          <span aria-hidden="true">＋</span>
          <strong>{copy.paseoNewSession}</strong>
        </button>
        <div className="paseo-session-list">
          {missions.map((mission) => (
            <button
              className={`paseo-session-item${mission.id === missionId ? " is-selected" : ""}`}
              key={mission.id}
              onClick={() => {
                setMissionId(mission.id);
                setInspectorTab("mission");
              }}
              type="button"
            >
              <span className={`paseo-status-dot ${phaseTone(mission.phase)}`} />
              <span className="paseo-session-copy">
                <strong>{mission.title}</strong>
                <small>{mission.provider} · {mission.model || copy.defaultModel}</small>
              </span>
              <em>{phaseLabel(copy, mission.phase)}</em>
            </button>
          ))}
          {!missions.length ? <p className="paseo-empty-sessions">{copy.paseoNoSessions}</p> : null}
        </div>
      </aside>

      <main className="paseo-workbench">
        <header className="paseo-workbench-toolbar">
          <div>
            <span className="surface-kicker">PASEO</span>
            <h2>{selectedMission?.title ?? copy.paseoNewWorkspace}</h2>
          </div>
          <label className="paseo-workspace-picker">
            <span>{copy.workspace}</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">{copy.chooseWorkspace}</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={busy || !workspaceId}
            onClick={() => void refresh()}
            type="button"
          >
            {busy ? copy.refreshing : copy.refresh}
          </button>
        </header>

        {selectedMission ? (
          <div className="paseo-transcript">
            <section className="paseo-mission-hero">
              <div>
                <span className={`paseo-phase-badge ${phaseTone(selectedMission.phase)}`}>
                  {phaseLabel(copy, selectedMission.phase)}
                </span>
                <h3>{selectedMission.title}</h3>
                <p>{selectedMission.taskId}</p>
              </div>
              <div className="paseo-inline-controls">
                <button className="secondary-button" disabled={busy} onClick={() => void inspect()} type="button">
                  {copy.inspect}
                </button>
                {ACTIONS.map((action) => (
                  <button
                    className={action === "start" || action === "resume" ? "primary-button compact" : "secondary-button"}
                    disabled={busy || !canRun(action, selectedMission)}
                    key={action}
                    onClick={() => void control(action)}
                    type="button"
                  >
                    {actionLabel(copy, action)}
                  </button>
                ))}
              </div>
            </section>

            <section className="paseo-activity-stream">
              <header>
                <h3>{copy.paseoActivity}</h3>
                <span>{selectedMission.id}</span>
              </header>
              <article className="paseo-activity-card">
                <span className={`paseo-activity-marker ${phaseTone(selectedMission.phase)}`} />
                <div>
                  <strong>{selectedMission.provider} · {selectedMission.model || copy.defaultModel}</strong>
                  <p>{selectedMission.lastStatus ?? phaseLabel(copy, selectedMission.phase)}</p>
                  <small>{copy.taskReference}: {selectedMission.taskId}</small>
                </div>
              </article>
              {notice ? <p className="control-notice paseo-inline-notice">{notice}</p> : null}
            </section>
          </div>
        ) : (
          <div className="paseo-empty-workspace">
            <div className="paseo-composer-heading">
              <span className="paseo-orbit-mark" aria-hidden="true"><i /><i /><i /></span>
              <h2>{copy.paseoComposerTitle}</h2>
              <p>{copy.paseoSubtitle}</p>
            </div>

            <div className="paseo-meta-row">
              <label className="paseo-meta-chip">
                <span>{copy.paseoOrchestrator}</span>
                <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                  <option value="">{copy.automatic}</option>
                  {providers.map((id) => (
                    <option key={id} value={id}>{id === WEB_GPT_PROVIDER_ID ? "ChatGPT Web" : id}</option>
                  ))}
                </select>
              </label>
              <label className="paseo-meta-chip">
                <span>{copy.account}</span>
                <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  <option value="">{copy.automatic}</option>
                  {matchingAccounts.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="paseo-meta-chip">
                <span>{copy.model}</span>
                <input
                  list="paseo-models"
                  placeholder={copy.defaultModel}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
                <datalist id="paseo-models">
                  {(account?.models ?? []).map((name) => <option key={name} value={name} />)}
                </datalist>
              </label>
              <label className="paseo-fallback-chip">
                <input
                  checked={allowFallback}
                  onChange={(event) => setAllowFallback(event.target.checked)}
                  type="checkbox"
                />
                <span>{copy.allowHealthyFallback}</span>
              </label>
            </div>

            <section className="paseo-subagent-board">
              <header>
                <h3>{copy.paseoSubagents}</h3>
                <button
                  className="secondary-button"
                  disabled={busy || !accounts.length || subagents.length >= 8}
                  onClick={() => {
                    const fallback = accounts.find((item) => (
                      !subagents.some((agent) => agent.accountId === item.id)
                    )) ?? accounts[0];
                    setSubagents((current) => [
                      ...current,
                      {
                        key: crypto.randomUUID().slice(0, 8),
                        providerId: fallback?.providerId ?? "",
                        accountId: fallback?.id ?? "",
                        model: fallback?.models[0] ?? "",
                        role: `subagent-${current.length + 1}`,
                      },
                    ]);
                  }}
                  type="button"
                >
                  {copy.paseoAddSubagent}
                </button>
              </header>
              {subagents.map((item) => {
                const agentAccounts = accounts.filter((account) => (
                  !item.providerId || account.providerId === item.providerId
                ));
                const agentAccount = agentAccounts.find((account) => account.id === item.accountId)
                  ?? agentAccounts[0];
                return (
                  <div className="paseo-subagent-row" key={item.key}>
                    <label>
                      <span>{copy.paseoSubagentRole}</span>
                      <input
                        value={item.role}
                        onChange={(event) => updateSubagent(item.key, { role: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{copy.provider}</span>
                      <select
                        value={item.providerId}
                        onChange={(event) => updateSubagent(item.key, {
                          providerId: event.target.value,
                          accountId: "",
                          model: "",
                        })}
                      >
                        <option value="">{copy.automatic}</option>
                        {providers.map((id) => <option key={id} value={id}>{id}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{copy.account}</span>
                      <select
                        value={item.accountId}
                        onChange={(event) => updateSubagent(item.key, { accountId: event.target.value })}
                      >
                        <option value="">{copy.automatic}</option>
                        {agentAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{copy.model}</span>
                      <input
                        value={item.model}
                        onChange={(event) => updateSubagent(item.key, { model: event.target.value })}
                        placeholder={copy.defaultModel}
                      />
                    </label>
                    <button
                      className="secondary-button"
                      disabled={busy || subagents.length <= 1}
                      onClick={() => setSubagents((current) => current.filter((agent) => agent.key !== item.key))}
                      type="button"
                    >
                      {copy.paseoRemoveSubagent}
                    </button>
                    <small>{agentAccount?.label}</small>
                  </div>
                );
              })}
              {!subagents.length ? <p className="paseo-provider-warning">{copy.paseoNoSubagents}</p> : null}
            </section>

            <section className="paseo-composer">
              <textarea
                aria-label={copy.taskId}
                placeholder={copy.paseoComposerPlaceholder}
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
              />
              <footer>
                <small>{copy.paseoComposerHint}</small>
                <div>
                  <button
                    className="secondary-button"
                    disabled={busy || !accounts.length}
                    onClick={() => void preview()}
                    type="button"
                  >
                    {copy.previewRoute}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !workspaceId || !taskId.trim() || !subagents.length || !accounts.length}
                    onClick={() => void planAssignments()}
                    type="button"
                  >
                    {busy ? copy.paseoPlanning : copy.paseoPlanAssignments}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !assignmentPlan}
                    onClick={() => void runSubagents()}
                    type="button"
                  >
                    {copy.paseoRunSubagents}
                  </button>
                  <button
                    className="primary-button paseo-submit-button"
                    disabled={busy || !workspaceId || !taskId.trim() || !accounts.length}
                    onClick={() => void prepare()}
                    type="button"
                  >
                    {busy ? copy.paseoPreparing : copy.paseoCreateSession}
                    <span aria-hidden="true">↵</span>
                  </button>
                </div>
              </footer>
            </section>
            {!accounts.length ? <p className="paseo-provider-warning">{copy.noProviderAccounts}</p> : null}
            {notice ? <p className="control-notice paseo-inline-notice">{notice}</p> : null}
          </div>
        )}
      </main>

      <aside className="paseo-inspector">
        <header className="paseo-inspector-header">
          <h2>{copy.paseoInspector}</h2>
          <div role="tablist">
            <button
              aria-selected={inspectorTab === "route"}
              className={inspectorTab === "route" ? "is-active" : ""}
              onClick={() => setInspectorTab("route")}
              role="tab"
              type="button"
            >
              {copy.paseoRouteTab}
            </button>
            <button
              aria-selected={inspectorTab === "mission"}
              className={inspectorTab === "mission" ? "is-active" : ""}
              onClick={() => setInspectorTab("mission")}
              role="tab"
              type="button"
            >
              {copy.paseoMissionTab}
            </button>
            <button
              aria-selected={inspectorTab === "plan"}
              className={inspectorTab === "plan" ? "is-active" : ""}
              onClick={() => setInspectorTab("plan")}
              role="tab"
              type="button"
            >
              {copy.paseoAssignmentTab}
            </button>
          </div>
        </header>

        {inspectorTab === "route" ? (
          route ? (
            <div className="paseo-inspector-content">
              <span className="paseo-route-ready">{copy.routeReady}</span>
              <dl className="paseo-detail-list">
                <div><dt>{copy.provider}</dt><dd>{route.provider.name}</dd></div>
                <div><dt>{copy.account}</dt><dd>{route.account.label}</dd></div>
                <div><dt>{copy.model}</dt><dd>{route.model ?? copy.defaultModel}</dd></div>
                <div><dt>{copy.proxy}</dt><dd>{proxySummary}</dd></div>
                <div><dt>{copy.fallbackUsed}</dt><dd>{route.fallbackUsed ? "✓" : "—"}</dd></div>
              </dl>
            </div>
          ) : (
            <p className="paseo-inspector-empty">{copy.routeUnavailable}</p>
          )
        ) : inspectorTab === "plan" ? (
          assignmentPlan ? (
            <div className="paseo-inspector-content">
              <span className="paseo-route-ready">{copy.paseoAssignmentPreview}</span>
              <dl className="paseo-detail-list">
                <div>
                  <dt>{copy.paseoOrchestrator}</dt>
                  <dd>
                    {stringValue(object(object(assignmentPlan.orchestrator)?.route)?.providerId)}
                    {" · "}
                    {stringValue(object(object(assignmentPlan.orchestrator)?.route)?.model, copy.defaultModel)}
                  </dd>
                </div>
              </dl>
              <ol className="paseo-assignment-list">
                {listValue(assignmentPlan.subagents).map((entry) => {
                  const row = object(entry) ?? {};
                  const routeRow = object(row.route) ?? {};
                  return (
                    <li key={stringValue(row.id)}>
                      <strong>{stringValue(row.role)}</strong>
                      <small>{stringValue(routeRow.providerId)} · {stringValue(routeRow.model, copy.defaultModel)}</small>
                      <code>{stringValue(row.backend)}</code>
                    </li>
                  );
                })}
              </ol>
              {assignmentRun ? (
                <div className="paseo-run-results">
                  <h3>{copy.paseoReviewResults}</h3>
                  {listValue(assignmentRun.assignments).map((entry) => {
                    const row = object(entry) ?? {};
                    return (
                      <article className="paseo-assignment-result" key={stringValue(row.id)}>
                        <strong>{stringValue(row.role)}</strong>
                        <small>{stringValue(row.status)}</small>
                        <div className="paseo-inline-controls">
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => void recordAssignment(stringValue(row.id), false)}
                            type="button"
                          >
                            {copy.paseoRecordReturn}
                          </button>
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => void recordAssignment(stringValue(row.id), true)}
                            type="button"
                          >
                            {copy.paseoRecordIssue}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  <button
                    className="secondary-button"
                    disabled={busy || !assignmentRun}
                    onClick={() => void reviewResults()}
                    type="button"
                  >
                    {copy.paseoReviewResults}
                  </button>
                  <button
                    className="primary-button compact"
                    disabled={busy || listValue(assignmentReview?.findings).length === 0}
                    onClick={() => void openAnnealTask()}
                    type="button"
                  >
                    {copy.paseoOpenAnnealTask}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="paseo-inspector-empty">{copy.paseoNoSubagents}</p>
          )
        ) : selectedMission ? (
          <div className="paseo-inspector-content">
            <dl className="paseo-detail-list">
              <div><dt>{copy.mission}</dt><dd>{selectedMission.id}</dd></div>
              <div><dt>{copy.phase}</dt><dd>{phaseLabel(copy, selectedMission.phase)}</dd></div>
              <div><dt>{copy.taskReference}</dt><dd>{selectedMission.taskId}</dd></div>
              <div><dt>{copy.provider}</dt><dd>{selectedMission.provider}</dd></div>
              <div><dt>{copy.model}</dt><dd>{selectedMission.model || copy.defaultModel}</dd></div>
            </dl>
          </div>
        ) : (
          <p className="paseo-inspector-empty">{copy.paseoNoMissionSelected}</p>
        )}
      </aside>
    </section>
  );
}

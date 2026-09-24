import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Language,
  ProviderAccountRecord,
  ProviderExecutionPlan,
  ProviderNetworkSnapshot,
} from "../types";
import type { JsonObject } from "../api/contracts";
import {
  boardRevision,
  messageOf,
  missionRevision,
  missionViews,
  object,
  sanitizeIdentifier,
  selectBinding,
  taskOptions,
  workspaceOptions,
  type MissionView,
  type TaskOption,
  type WorkspaceOption,
} from "./execution-surface-utils";
import {
  actionLabel,
  orchestrationCopy,
  phaseLabel,
  type OrchestrationCopy,
} from "./orchestration-copy";
import "./orchestration-control.css";

type Action = "start" | "hold" | "resume" | "cancel" | "close";
type AnnealColumnId = "backlog" | "todo" | "doing" | "review" | "done";

const ACTIONS: readonly Action[] = ["start", "hold", "resume", "cancel", "close"];
const ANNEAL_COLUMNS: readonly { id: AnnealColumnId }[] = [
  { id: "backlog" },
  { id: "todo" },
  { id: "doing" },
  { id: "review" },
  { id: "done" },
];

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
  return action === "close" && mission.quiescent
    && ["ready", "held", "review_required", "accepted", "changes_requested"].includes(mission.phase);
}

function annealColumnForState(state: string): AnnealColumnId {
  const normalized = state.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["todo", "ready", "queued", "pending", "planned"].includes(normalized)) return "todo";
  if (["doing", "running", "in_progress", "active", "held", "scheduling_held"].includes(normalized)) return "doing";
  if (["review", "review_required", "changes_requested", "verification", "verifying", "qa"].includes(normalized)) return "review";
  if (["done", "completed", "accepted", "merged", "closed", "cancelled", "canceled"].includes(normalized)) return "done";
  return "backlog";
}

function columnLabel(copy: OrchestrationCopy, id: AnnealColumnId): string {
  if (id === "backlog") return copy.annealBacklog;
  if (id === "todo") return copy.annealTodo;
  if (id === "doing") return copy.annealDoing;
  if (id === "review") return copy.annealReview;
  return copy.annealDone;
}

function phaseTone(phase: string): string {
  if (["accepted", "closed"].includes(phase)) return "is-success";
  if (["ready", "review_required", "changes_requested"].includes(phase)) return "is-warning";
  if (["failed", "cancelled"].includes(phase)) return "is-error";
  if (phase === "running") return "is-running";
  return "is-muted";
}

function asJson(value: unknown): JsonObject | null {
  const row = object(value);
  return row ? row as JsonObject : null;
}

function jsonList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function AnnealTasksSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = orchestrationCopy(language);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [taskId, setTaskId] = useState("");
  const [network, setNetwork] = useState<ProviderNetworkSnapshot | null>(null);
  const [providerId, setProviderId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [dispatchThroughPaseo, setDispatchThroughPaseo] = useState(true);
  const [route, setRoute] = useState<ProviderExecutionPlan | null>(null);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [missionId, setMissionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [assignmentPreview, setAssignmentPreview] = useState<JsonObject | null>(null);
  const [paseoReviews, setPaseoReviews] = useState<JsonObject[]>([]);
  const refreshGeneration = useRef(0);

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
  const task = tasks.find((candidate) => candidate.id === taskId);
  const selectedMission = missions.find((mission) => mission.id === missionId);
  const groupedTasks = useMemo(() => {
    const groups = new Map<AnnealColumnId, TaskOption[]>(
      ANNEAL_COLUMNS.map(({ id }) => [id, []]),
    );
    for (const item of tasks) groups.get(annealColumnForState(item.state))?.push(item);
    return groups;
  }, [tasks]);
  const relatedMissions = useMemo(
    () => missions.filter((mission) => !taskId || mission.taskId === taskId),
    [missions, taskId],
  );

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
    setProviderId((current) => (
      current && providers.includes(current) ? current : providers[0] ?? ""
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
    setTasks([]);
    setMissions([]);
    setPaseoReviews([]);
    setTaskId("");
    setMissionId("");
    if (workspaceId) void refresh();
    return () => { refreshGeneration.current += 1; };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !taskId || !window.codingTools) {
      setAssignmentPreview(null);
      return;
    }
    let cancelled = false;
    void window.codingTools.tools.call({
      workspaceId,
      tool: "anneal_preview",
      arguments: { taskId },
    }).then((preview) => {
      if (!cancelled) setAssignmentPreview(asJson(preview));
    }).catch(() => {
      if (!cancelled) setAssignmentPreview(null);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, workspaceId]);

  const refresh = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId) return;
    const generation = ++refreshGeneration.current;
    setBusy(true);
    try {
      const [page, view, control] = await Promise.allSettled([
        api.tasks.list({ workspaceId, limit: 200 }),
        api.execution.read({ workspaceId, missionId: null, refreshSource: false }),
        api.tools.call({ workspaceId, tool: "five_stack_status", arguments: {} }),
      ]);
      if (generation !== refreshGeneration.current) return;
      const nextTasks = taskOptions(page.status === "fulfilled" ? page.value : null)
        .filter((item) => item.state.toLowerCase() !== "archived");
      const nextMissions = missionViews(view.status === "fulfilled" ? view.value : null).filter((mission) => (
        mission.engine === "anneal" || mission.engine === "paseo"
      ));
      const root = object(control.status === "fulfilled" ? control.value : null) ?? {};
      const controlTasks = taskOptions({ items: root.annealTasks })
        .filter((item) => item.state.toLowerCase() !== "archived");
      const reviews = (Array.isArray(root.reviews) ? root.reviews : []).flatMap((entry) => {
        const row = object(entry);
        return row ? [row as JsonObject] : [];
      });
      const failures = [page, view, control].flatMap((result) => (
        result.status === "rejected" ? [messageOf(result.reason)] : []
      ));
      setNotice(failures.length ? `Some task sources are unavailable: ${failures.join("; ")}` : "");
      const mergedTasks = [
        ...nextTasks,
        ...controlTasks.filter((item) => !nextTasks.some((existing) => existing.id === item.id)),
      ];
      setTasks(mergedTasks);
      setPaseoReviews(reviews);
      setTaskId((current) => (
        mergedTasks.some((item) => item.id === current) ? current : ""
      ));
      setMissions(nextMissions);
      setMissionId((current) => (
        nextMissions.some((mission) => mission.id === current)
          ? current
          : nextMissions[0]?.id ?? ""
      ));
    } catch (cause) {
      if (generation !== refreshGeneration.current) return;
      const message = messageOf(cause);
      if (!/IPC_TRANSPORT_FAILED|Workspace-bound listener/i.test(message)) {
        setError(message);
      }
    } finally {
      if (generation === refreshGeneration.current) setBusy(false);
    }
  };

  const plan = async (): Promise<ProviderExecutionPlan> => {
    const launcher = window.codexWebLauncher;
    if (!launcher) throw new Error(copy.executionPlanningUnavailable);
    const next = await launcher.providerExecutionPlan({
      workload: dispatchThroughPaseo ? "paseo" : "anneal",
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
      setNotice(`${copy.routeReady}: ${next.provider.name} · ${next.account.label}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const dispatch = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId || !taskId) return;
    setBusy(true);
    setError(null);
    try {
      const selectedRoute = await plan();
      const engine = dispatchThroughPaseo ? "paseo" : "anneal";
      const view = await api.execution.read({
        workspaceId,
        missionId: null,
        refreshSource: false,
      });
      const binding = selectBinding(
        view,
        engine,
        selectedRoute.provider.id,
        selectedRoute.model,
      );
      if (!binding) {
        throw new Error(`${copy.connectApprovedBinding} ${selectedRoute.provider.id}/${selectedRoute.model ?? copy.defaultModel}`);
      }
      const id = sanitizeIdentifier(`${engine}-${taskId}-${crypto.randomUUID().slice(0, 8)}`);
      await api.execution.update({
        workspaceId,
        expectedRevision: boardRevision(view),
        change: {
          operation: "agent_prepare",
          binding_id: binding.id,
          task_id: taskId,
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
      setNotice(copy.annealMissionSubmitted);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openFromPaseoReview = async (reviewId: string) => {
    const api = window.codingTools;
    if (!api || !workspaceId || !reviewId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.tools.call({
        workspaceId,
        tool: "anneal_open_from_review",
        arguments: { reviewId },
      });
      const preview = asJson(created);
      const id = typeof preview?.id === "string" ? preview.id : "";
      setAssignmentPreview(preview);
      setNotice(copy.annealFromPaseoReview);
      await refresh();
      if (id) setTaskId(id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: Action) => {
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

  const proxySummary = route?.proxy.mode === "profile"
    ? `${route.proxy.source} · ${route.proxy.profile?.name ?? copy.proxy}`
    : copy.direct;

  return (
    <section className="control-surface anneal-shell">
      <header className="control-heading anneal-heading">
        <div>
          <span className="surface-kicker">ANNEAL</span>
          <h1>{copy.annealTitle}</h1>
          <p>{copy.annealSubtitle}</p>
        </div>
        <div className="anneal-heading-actions">
          <label>
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
        </div>
      </header>

      <div className={`anneal-board-layout${task ? " has-selection" : ""}`}>
        <section className="anneal-board-shell">
          <header className="anneal-board-toolbar">
            <div>
              <h2>{copy.annealTaskBoard}</h2>
              <span>{tasks.length}</span>
            </div>
            {!accounts.length ? <p>{copy.noProviderAccounts}</p> : null}
          </header>

          <div className="anneal-board">
            {ANNEAL_COLUMNS.map(({ id }) => {
              const columnTasks = groupedTasks.get(id) ?? [];
              return (
                <section className={`anneal-column is-${id}`} key={id}>
                  <header className="anneal-column-head">
                    <span className="anneal-column-dot" />
                    <strong>{columnLabel(copy, id)}</strong>
                    <em>{columnTasks.length}</em>
                  </header>
                  <div className="anneal-column-body">
                    {columnTasks.map((item) => (
                      <button
                        className={`anneal-task-card${item.id === taskId ? " is-selected" : ""}`}
                        key={item.id}
                        onClick={() => {
                          setTaskId(item.id);
                          setRoute(null);
                          setNotice("");
                        }}
                        type="button"
                      >
                        <span className="anneal-card-state">{columnLabel(copy, id)}</span>
                        <strong>{item.title}</strong>
                        <p>{item.description || item.id}</p>
                        <footer>
                          <code>{item.id}</code>
                          <span aria-hidden="true">›</span>
                        </footer>
                      </button>
                    ))}
                    {!columnTasks.length ? (
                      <p className="anneal-empty-column">{copy.annealNoTasks}</p>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        </section>

        {task ? (
          <aside className="anneal-dispatch-drawer">
            <header className="anneal-drawer-header">
              <div>
                <span className="surface-kicker">{copy.annealSelectedTask}</span>
                <h2>{task.title}</h2>
              </div>
              <button
                aria-label={copy.close}
                onClick={() => {
                  setTaskId("");
                  setRoute(null);
                  setNotice("");
                }}
                type="button"
              >
                ×
              </button>
            </header>

            <dl className="anneal-task-details">
              <div><dt>{copy.taskId}</dt><dd>{task.id}</dd></div>
              <div><dt>{copy.annealTaskState}</dt><dd>{columnLabel(copy, annealColumnForState(task.state))}</dd></div>
              {task.description ? <div><dt>{copy.annealTaskDescription}</dt><dd>{task.description}</dd></div> : null}
            </dl>

            <section className="anneal-assignment-preview">
              <h3>{copy.annealAssignmentPreview}</h3>
              {assignmentPreview ? (
                <ol className="paseo-assignment-list">
                  <li>
                    <strong>{copy.paseoOrchestrator}</strong>
                    <small>
                      {String(object(object(object(assignmentPreview.assignment)?.orchestrator)?.route)?.providerId
                        ?? copy.unknown)}
                    </small>
                  </li>
                  {jsonList(object(assignmentPreview.assignment)?.subagents).flatMap((entry) => {
                    const row = object(entry);
                    if (!row) return [];
                    const route = object(row.route) ?? {};
                    return [(
                      <li key={String(row.id ?? row.role)}>
                        <strong>{String(row.role ?? copy.paseoSubagents)}</strong>
                        <small>{String(route.providerId ?? copy.unknown)} · {String(route.model ?? copy.defaultModel)}</small>
                        <code>{String(row.backend ?? "")}</code>
                      </li>
                    )];
                  })}
                </ol>
              ) : (
                <p className="empty-copy">{copy.annealNoAssignment}</p>
              )}
              {paseoReviews.filter((item) => Number(item.findings) > 0).map((item) => (
                <button
                  className="secondary-button"
                  disabled={busy}
                  key={String(item.id)}
                  onClick={() => void openFromPaseoReview(String(item.id))}
                  type="button"
                >
                  {copy.paseoOpenAnnealTask}
                </button>
              ))}
            </section>

            <section className="anneal-dispatch-section">
              <h3>{copy.annealDispatch}</h3>
              <div className="anneal-engine-toggle" role="radiogroup">
                <button
                  aria-pressed={dispatchThroughPaseo}
                  className={dispatchThroughPaseo ? "is-active" : ""}
                  onClick={() => setDispatchThroughPaseo(true)}
                  type="button"
                >
                  {copy.annealDispatchThroughPaseo}
                </button>
                <button
                  aria-pressed={!dispatchThroughPaseo}
                  className={!dispatchThroughPaseo ? "is-active" : ""}
                  onClick={() => setDispatchThroughPaseo(false)}
                  type="button"
                >
                  {copy.annealDispatchDirect}
                </button>
              </div>

              <div className="anneal-route-fields">
                <label>
                  <span>{copy.provider}</span>
                  <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                    <option value="">{copy.automatic}</option>
                    {providers.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </label>
                <label>
                  <span>{copy.account}</span>
                  <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                    <option value="">{copy.automatic}</option>
                    {matchingAccounts.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{copy.model}</span>
                  <input
                    list="anneal-models"
                    placeholder={copy.defaultModel}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  />
                  <datalist id="anneal-models">
                    {(account?.models ?? []).map((name) => <option key={name} value={name} />)}
                  </datalist>
                </label>
                <label className="check-row anneal-fallback-row">
                  <input
                    checked={allowFallback}
                    onChange={(event) => setAllowFallback(event.target.checked)}
                    type="checkbox"
                  />
                  <span>{copy.allowHealthyFallback}</span>
                </label>
              </div>

              <div className="control-actions anneal-dispatch-actions">
                <button
                  className="secondary-button"
                  disabled={busy || !accounts.length}
                  onClick={() => void preview()}
                  type="button"
                >
                  {copy.previewRoute}
                </button>
                <button
                  className="primary-button compact"
                  disabled={busy || !workspaceId || !taskId || !accounts.length}
                  onClick={() => void dispatch()}
                  type="button"
                >
                  {busy ? copy.annealDispatching : copy.annealDispatchTask}
                </button>
              </div>

              {route ? (
                <article className="route-preview anneal-route-preview">
                  <strong>{route.workload} · {route.provider.name}</strong>
                  <span>{route.account.label} · {route.model ?? copy.defaultModel}</span>
                  <small>{copy.proxy}: {proxySummary}</small>
                </article>
              ) : null}
            </section>

            <section className="anneal-related-section">
              <h3>{copy.annealRelatedMissions}</h3>
              <div className="mission-list compact-list">
                {relatedMissions.map((mission) => (
                  <button
                    className={`mission-row${mission.id === missionId ? " is-selected" : ""}`}
                    key={mission.id}
                    onClick={() => setMissionId(mission.id)}
                    type="button"
                  >
                    <div>
                      <strong>{mission.title}</strong>
                      <small>{mission.engine} · {mission.provider}</small>
                    </div>
                    <span className={`anneal-phase-label ${phaseTone(mission.phase)}`}>
                      {phaseLabel(copy, mission.phase)}
                    </span>
                  </button>
                ))}
                {!relatedMissions.length ? (
                  <p className="empty-copy">{copy.annealNoRelatedMissions}</p>
                ) : null}
              </div>
              {selectedMission ? (
                <div className="mission-buttons">
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
              ) : null}
            </section>

            {notice ? <p className="control-notice anneal-inline-notice">{notice}</p> : null}
          </aside>
        ) : (
          <aside className="anneal-dispatch-drawer is-empty">
            <span className="anneal-empty-drawer-mark" aria-hidden="true">◇</span>
            <h2>{copy.annealSelectedTask}</h2>
            <p>{copy.annealSelectTask}</p>
            {paseoReviews.filter((item) => Number(item.findings) > 0).map((item) => (
              <button
                className="primary-button compact"
                disabled={busy}
                key={String(item.id)}
                onClick={() => void openFromPaseoReview(String(item.id))}
                type="button"
              >
                {copy.paseoOpenAnnealTask}
              </button>
            ))}
          </aside>
        )}
      </div>
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Language,
  ProviderAccountRecord,
  ProviderExecutionPlan,
  ProviderNetworkSnapshot,
} from "../types";
import type { JsonObject } from "../api/contracts";
import {
  messageOf,
  missionRevision,
  missionViews,
  object,
  workspaceOptions,
  type MissionView,
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
type AnnealMoveTarget = {
  status: string;
  via: "patch" | "start";
};
type AnnealProject = {
  id: string;
  name: string;
};
type AnnealTask = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: string;
  moveTargets: AnnealMoveTarget[];
};

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

function annealResult(response: unknown): JsonObject {
  const envelope = object(response) ?? {};
  const result = object(envelope.result) ?? envelope;
  if (envelope.ok === false || result.ok === false) {
    throw new Error(String(result.error ?? result.detail ?? envelope.error ?? "Anneal request failed"));
  }
  return result as JsonObject;
}

function annealBody(response: unknown): unknown {
  const result = annealResult(response);
  return result.body ?? result;
}

function records(value: unknown, keys: readonly string[]): JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const row = asJson(entry);
      return row ? [row] : [];
    });
  }
  const row = object(value);
  if (!row) return [];
  for (const key of keys) {
    if (Array.isArray(row[key])) return records(row[key], []);
  }
  return [];
}

function projectRows(value: unknown): AnnealProject[] {
  return records(value, ["projects", "items", "data"]).flatMap((row) => {
    const id = String(row.id ?? "").trim();
    if (!id) return [];
    return [{ id, name: String(row.name ?? row.title ?? id) }];
  });
}

function taskRows(value: unknown): AnnealTask[] {
  return records(value, ["tasks", "items", "cards", "data"]).flatMap((row) => {
    const id = String(row.id ?? "").trim();
    if (!id) return [];
    const moveTargets = jsonList(row.moveTargets).flatMap((entry) => {
      const target = object(entry);
      const status = String(target?.status ?? "").trim();
      const via = target?.via;
      return status && (via === "patch" || via === "start")
        ? [{ status, via } satisfies AnnealMoveTarget]
        : [];
    });
    return [{
      id,
      projectId: String(row.projectId ?? ""),
      name: String(row.name ?? row.title ?? id),
      description: String(row.description ?? ""),
      status: String(row.status ?? row.state ?? "BACKLOG"),
      moveTargets,
    }];
  });
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
  const [annealProjects, setAnnealProjects] = useState<AnnealProject[]>([]);
  const [annealProjectId, setAnnealProjectId] = useState("");
  const [annealTasks, setAnnealTasks] = useState<AnnealTask[]>([]);
  const [annealTaskId, setAnnealTaskId] = useState("");
  const [annealTaskDetails, setAnnealTaskDetails] = useState<JsonObject | null>(null);
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
  const [paseoReviews, setPaseoReviews] = useState<JsonObject[]>([]);
  const annealProjectIdRef = useRef("");
  const annealBoardGeneration = useRef(0);
  const annealBoardRequest = useRef(0);

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
  const annealTask = annealTasks.find((candidate) => candidate.id === annealTaskId);
  const selectedMission = missions.find((mission) => mission.id === missionId);
  const groupedTasks = useMemo(() => {
    const groups = new Map<AnnealColumnId, AnnealTask[]>(
      ANNEAL_COLUMNS.map(({ id }) => [id, []]),
    );
    for (const item of annealTasks) {
      groups.get(annealColumnForState(item.status))?.push(item);
    }
    return groups;
  }, [annealTasks]);

  const selectAnnealProject = (projectId: string) => {
    annealProjectIdRef.current = projectId;
    annealBoardGeneration.current += 1;
    annealBoardRequest.current += 1;
    setAnnealProjectId(projectId);
    setAnnealTasks([]);
    setAnnealTaskId("");
    setAnnealTaskDetails(null);
    setNotice("");
  };

  const refreshAnnealBoard = async (): Promise<boolean> => {
    const api = window.codingTools;
    const projectId = annealProjectIdRef.current;
    const generation = annealBoardGeneration.current;
    const requestId = ++annealBoardRequest.current;
    if (!api || !projectId) return false;
    const response = await api.apps.call({
      moduleId: "anneal",
      operation: "listTasks",
      arguments: { projectId },
    });
    if (
      generation !== annealBoardGeneration.current
      || projectId !== annealProjectIdRef.current
      || requestId !== annealBoardRequest.current
    ) return false;
    const nextTasks = taskRows(annealBody(response));
    setAnnealTasks(nextTasks);
    setAnnealTaskId((current) => (
      nextTasks.some((item) => item.id === current) ? current : ""
    ));
    return true;
  };

  const refreshLocalMissions = async (refreshSource = false) => {
    const api = window.codingTools;
    if (!api || !workspaceId) {
      setMissions([]);
      setPaseoReviews([]);
      return;
    }
    if (refreshSource && missionId) {
      await api.execution.read({ workspaceId, missionId, refreshSource: true });
    }
    const view = await api.execution.read({
      workspaceId,
      missionId: null,
      refreshSource: false,
    });
    const nextMissions = missionViews(view).filter((mission) => (
      mission.engine === "anneal" || mission.engine === "paseo"
    ));
    let reviews: JsonObject[] = [];
    try {
      const status = await api.tools.call({
        workspaceId,
        tool: "five_stack_status",
        arguments: {},
      });
      const root = object(status) ?? {};
      reviews = jsonList(root.reviews).flatMap((entry) => {
        const row = asJson(entry);
        return row ? [row] : [];
      });
    } catch {
      reviews = [];
    }
    setMissions(nextMissions);
    setMissionId((current) => (
      nextMissions.some((mission) => mission.id === current)
        ? current
        : nextMissions[0]?.id ?? ""
    ));
    setPaseoReviews(reviews);
  };

  const refresh = async (refreshSource = false) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([
        refreshAnnealBoard(),
        refreshLocalMissions(refreshSource),
      ]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

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

    void codingTools.apps.call({
      moduleId: "anneal",
      operation: "projects",
      arguments: {},
    }).then((response) => {
      if (cancelled) return;
      const projects = projectRows(annealBody(response));
      setAnnealProjects(projects);
      selectAnnealProject(projects[0]?.id ?? "");
    }).catch((cause) => setError(messageOf(cause)));

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
    if (annealProjectId) {
      void refreshAnnealBoard().catch((cause) => setError(messageOf(cause)));
    }
  }, [annealProjectId]);

  useEffect(() => {
    if (workspaceId) {
      void refreshLocalMissions().catch((cause) => setError(messageOf(cause)));
    }
  }, [workspaceId]);

  useEffect(() => {
    const api = window.codingTools;
    if (!api || !annealTaskId) {
      setAnnealTaskDetails(null);
      return;
    }
    let cancelled = false;
    void api.apps.call({
      moduleId: "anneal",
      operation: "preview",
      arguments: { taskId: annealTaskId },
    }).then((response) => {
      if (!cancelled) setAnnealTaskDetails(asJson(annealBody(response)));
    }).catch((cause) => {
      if (!cancelled) {
        setAnnealTaskDetails(null);
        setError(messageOf(cause));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [annealTaskId, setError]);

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

  const previewRoute = async () => {
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

  const moveTask = async (target: AnnealMoveTarget) => {
    const api = window.codingTools;
    if (!api || !annealTaskId) return;
    const generation = annealBoardGeneration.current;
    const projectId = annealProjectIdRef.current;
    const taskId = annealTaskId;
    setBusy(true);
    setError(null);
    try {
      const response = await api.apps.call({
        moduleId: "anneal",
        operation: target.via === "start" ? "startTask" : "updateTask",
        arguments: target.via === "start"
          ? { taskId }
          : { taskId, status: target.status },
      });
      annealResult(response);
      if (generation !== annealBoardGeneration.current || projectId !== annealProjectIdRef.current) return;
      if (!await refreshAnnealBoard()) return;
      setNotice(`${taskId} → ${target.status}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openFromPaseoReview = async (reviewId: string) => {
    const api = window.codingTools;
    const generation = annealBoardGeneration.current;
    const projectId = annealProjectIdRef.current;
    if (!api || !workspaceId || !projectId || !reviewId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.apps.call({
        moduleId: "anneal",
        operation: "openFromReview",
        arguments: { reviewId, projectId, workspaceId },
      });
      const created = annealResult(response);
      const handoff = object(created.handoff);
      const createdTaskId = String(handoff?.remoteId ?? "").trim();
      if (handoff?.posted !== true || !createdTaskId) {
        throw new Error(String(handoff?.error ?? "Anneal did not return a created task ID"));
      }
      if (generation !== annealBoardGeneration.current || projectId !== annealProjectIdRef.current) return;
      if (!await refreshAnnealBoard()) return;
      setAnnealTaskId(createdTaskId);
      setNotice(`${copy.annealFromPaseoReview} · ${createdTaskId}`);
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
      await refreshLocalMissions();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const proxySummary = route?.proxy.mode === "profile"
    ? `${route.proxy.source} · ${route.proxy.profile?.name ?? copy.proxy}`
    : copy.direct;
  const taskDescription = String(annealTaskDetails?.description ?? annealTask?.description ?? "");

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
            <span>Anneal project</span>
            <select
              value={annealProjectId}
              onChange={(event) => selectAnnealProject(event.target.value)}
            >
              <option value="">Choose project</option>
              {annealProjects.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{copy.workspace} · Coding Tools</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">{copy.chooseWorkspace}</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void refresh(true)}
            type="button"
          >
            {busy ? copy.refreshing : copy.refresh}
          </button>
        </div>
      </header>

      <div className={`anneal-board-layout${annealTask ? " has-selection" : ""}`}>
        <section className="anneal-board-shell">
          <header className="anneal-board-toolbar">
            <div>
              <h2>{copy.annealTaskBoard}</h2>
              <span>{annealTasks.length}</span>
            </div>
            {!annealProjectId ? <p>Choose an Anneal project to load its board.</p> : null}
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
                        className={`anneal-task-card${item.id === annealTaskId ? " is-selected" : ""}`}
                        key={item.id}
                        onClick={() => {
                          setAnnealTaskId(item.id);
                          setRoute(null);
                          setNotice("");
                        }}
                        type="button"
                      >
                        <span className="anneal-card-state">{columnLabel(copy, id)}</span>
                        <strong>{item.name}</strong>
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

        {annealTask ? (
          <aside className="anneal-dispatch-drawer">
            <header className="anneal-drawer-header">
              <div>
                <span className="surface-kicker">{copy.annealSelectedTask}</span>
                <h2>{annealTask.name}</h2>
              </div>
              <button
                aria-label={copy.close}
                onClick={() => {
                  setAnnealTaskId("");
                  setRoute(null);
                  setNotice("");
                }}
                type="button"
              >
                ×
              </button>
            </header>

            <dl className="anneal-task-details">
              <div><dt>{copy.taskId}</dt><dd>{annealTask.id}</dd></div>
              <div><dt>Anneal project</dt><dd>{annealTask.projectId || annealProjectId}</dd></div>
              <div>
                <dt>{copy.annealTaskState}</dt>
                <dd>{columnLabel(copy, annealColumnForState(annealTask.status))}</dd>
              </div>
              {taskDescription ? (
                <div><dt>{copy.annealTaskDescription}</dt><dd>{taskDescription}</dd></div>
              ) : null}
            </dl>

            <section className="anneal-assignment-preview">
              <h3>Advertised moves</h3>
              <div className="mission-buttons">
                {annealTask.moveTargets.map((target) => (
                  <button
                    className={target.via === "start" ? "primary-button compact" : "secondary-button"}
                    disabled={busy}
                    key={`${target.status}:${target.via}`}
                    onClick={() => void moveTask(target)}
                    type="button"
                  >
                    {target.via === "start" ? "Start" : `Move to ${target.status}`}
                  </button>
                ))}
              </div>
              {!annealTask.moveTargets.length ? (
                <p className="empty-copy">Anneal has not advertised a move for this task.</p>
              ) : null}
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
                  onClick={() => void previewRoute()}
                  type="button"
                >
                  {copy.previewRoute}
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
              <h3>Coding Tools missions</h3>
              <div className="mission-list compact-list">
                {missions.map((mission) => (
                  <button
                    className={`mission-row${mission.id === missionId ? " is-selected" : ""}`}
                    key={mission.id}
                    onClick={() => setMissionId(mission.id)}
                    type="button"
                  >
                    <div>
                      <strong>{mission.title}</strong>
                      <small>
                        {mission.engine} · {mission.provider}
                        {mission.lastStatus ? ` · ${mission.lastStatus}` : ""}
                      </small>
                    </div>
                    <span className={`anneal-phase-label ${phaseTone(mission.phase)}`}>
                      {phaseLabel(copy, mission.phase)}
                    </span>
                  </button>
                ))}
                {!missions.length ? (
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

            {paseoReviews.filter((item) => Number(item.findings) > 0).map((item) => (
              <button
                className="secondary-button"
                disabled={busy || !annealProjectId}
                key={String(item.id)}
                onClick={() => void openFromPaseoReview(String(item.id))}
                type="button"
              >
                {copy.paseoOpenAnnealTask}
              </button>
            ))}
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
                disabled={busy || !annealProjectId}
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

import { useEffect, useMemo, useState } from "react";
import type {
  Language,
  ProviderAccountRecord,
  ProviderExecutionPlan,
  ProviderNetworkSnapshot,
} from "../types";
import {
  boardRevision,
  localText,
  messageOf,
  missionRevision,
  missionViews,
  sanitizeIdentifier,
  selectBinding,
  taskOptions,
  workspaceOptions,
  type MissionView,
  type TaskOption,
  type WorkspaceOption,
} from "./execution-surface-utils";
import "./orchestration-control.css";

type Action = "start" | "hold" | "resume" | "cancel" | "close";
const ACTIONS: readonly Action[] = ["start", "hold", "resume", "cancel", "close"];

function usable(snapshot: ProviderNetworkSnapshot | null): ProviderAccountRecord[] {
  return (snapshot?.accounts ?? []).filter((account) => (
    account.enabled && account.status === "connected" && !account.archivedAt
  ));
}

function canRun(action: Action, mission: MissionView | undefined): boolean {
  if (!mission) return false;
  if (action === "start") return ["ready", "changes_requested"].includes(mission.phase);
  if (["hold", "cancel"].includes(action)) return ["running", "unknown", "scheduling_held"].includes(mission.phase);
  if (action === "resume") return mission.phase === "held";
  return action === "close" && mission.quiescent
    && ["ready", "held", "review_required", "accepted", "changes_requested"].includes(mission.phase);
}

export function AnnealTasksSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
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

  const accounts = useMemo(() => usable(network), [network]);
  const providers = useMemo(() => [...new Set(accounts.map((account) => account.providerId))], [accounts]);
  const matchingAccounts = useMemo(
    () => accounts.filter((account) => !providerId || account.providerId === providerId),
    [accounts, providerId],
  );
  const account = matchingAccounts.find((candidate) => candidate.id === accountId) ?? matchingAccounts[0];
  const task = tasks.find((candidate) => candidate.id === taskId);
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
    const unsubscribe = launcher.onProviderNetworkChanged((snapshot) => setNetwork(snapshot));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setError]);

  useEffect(() => {
    setProviderId((current) => current && providers.includes(current) ? current : providers[0] ?? "");
  }, [providers]);

  useEffect(() => {
    const first = matchingAccounts[0];
    setAccountId((current) => matchingAccounts.some((candidate) => candidate.id === current) ? current : first?.id ?? "");
  }, [matchingAccounts]);

  useEffect(() => {
    setModel((current) => current && account?.models.includes(current) ? current : account?.models[0] ?? "");
  }, [account]);

  useEffect(() => {
    if (workspaceId) void refresh();
  }, [workspaceId]);

  const refresh = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId) return;
    setBusy(true);
    try {
      const [page, view] = await Promise.all([
        api.tasks.list({ workspaceId, limit: 200 }),
        api.execution.read({ workspaceId, missionId: null, refreshSource: false }),
      ]);
      const nextTasks = taskOptions(page).filter((item) => item.state !== "archived");
      const nextMissions = missionViews(view).filter((mission) => (
        mission.engine === "anneal" || mission.engine === "paseo"
      ));
      setTasks(nextTasks);
      setTaskId((current) => nextTasks.some((item) => item.id === current) ? current : nextTasks[0]?.id ?? "");
      setMissions(nextMissions);
      setMissionId((current) => nextMissions.some((mission) => mission.id === current) ? current : nextMissions[0]?.id ?? "");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const plan = async (): Promise<ProviderExecutionPlan> => {
    const launcher = window.codexWebLauncher;
    if (!launcher) throw new Error("Provider execution planning is unavailable");
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
      setNotice(`${next.workload} · ${next.provider.name} · ${next.account.label} · ${next.model ?? "default"}`);
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
      const view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
      const binding = selectBinding(view, engine, selectedRoute.provider.id, selectedRoute.model);
      if (!binding) throw new Error(`Connect an approved ${engine} binding for ${selectedRoute.provider.id}/${selectedRoute.model ?? "default"}`);
      const id = sanitizeIdentifier(`${engine}-${taskId}-${crypto.randomUUID().slice(0, 8)}`);
      await api.execution.update({
        workspaceId,
        expectedRevision: boardRevision(view),
        change: { operation: "agent_prepare", binding_id: binding.id, task_id: taskId, mission_id: id },
        confirm: true,
      });
      const prepared = await api.execution.read({ workspaceId, missionId: id, refreshSource: false });
      await api.execution.update({
        workspaceId,
        expectedRevision: missionRevision(prepared, id),
        change: { operation: "agent_control", mission_id: id, request_key: crypto.randomUUID(), action: "create" },
        confirm: true,
      });
      setMissionId(id);
      setNotice(localText(
        language,
        `Task dispatched through ${engine}. Refresh until Ready, then start it.`,
        `任務已透過 ${engine} 執行。請刷新至 Ready，再啟動。`,
        `任务已通过 ${engine} 执行。请刷新至 Ready，再启动。`,
        `${engine} 経由でタスクを準備しました。Ready になってから開始してください。`,
      ));
      await refresh();
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
      const view = await api.execution.read({ workspaceId, missionId, refreshSource: false });
      await api.execution.update({
        workspaceId,
        expectedRevision: missionRevision(view, missionId),
        change: { operation: "agent_control", mission_id: missionId, request_key: crypto.randomUUID(), action },
        confirm: true,
      });
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="control-surface">
      <header className="control-heading">
        <div>
          <span className="surface-kicker">ANNEAL</span>
          <h1>{localText(language, "Anneal Tasks", "Anneal 任務", "Anneal 任务", "Anneal タスク")}</h1>
          <p>{localText(
            language,
            "Select an existing task, choose its provider account and model, then run it directly in Anneal or through Paseo as the orchestrator.",
            "選擇現有任務、供應商帳戶及模型，再直接使用 Anneal 或透過 Paseo 協調器執行。",
            "选择现有任务、供应商账户及模型，再直接使用 Anneal 或通过 Paseo 协调器执行。",
            "既存タスクを Anneal または Paseo 経由で実行します。",
          )}</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void refresh()} type="button">Refresh</button>
      </header>

      <div className="control-grid two-column">
        <section className="control-panel task-menu-panel">
          <h2>{localText(language, "Task menu", "任務選單", "任务菜单", "タスクメニュー")}</h2>
          <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">—</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <div className="task-list">
            {tasks.map((item) => <button className={`task-row${item.id === taskId ? " is-selected" : ""}`} key={item.id} onClick={() => setTaskId(item.id)} type="button"><div><strong>{item.title}</strong><small>{item.description || item.id}</small></div><span>{item.state}</span></button>)}
            {!tasks.length ? <p className="empty-copy">No active tasks.</p> : null}
          </div>
          {task ? <article className="selected-task"><strong>{task.title}</strong><p>{task.description}</p><code>{task.id}</code></article> : null}
        </section>

        <section className="control-panel">
          <h2>{localText(language, "Dispatch", "執行", "执行", "実行")}</h2>
          <div className="control-fields">
            <label className="check-row"><input checked={dispatchThroughPaseo} onChange={(event) => setDispatchThroughPaseo(event.target.checked)} type="checkbox" /><span>{localText(language, "Dispatch through Paseo", "透過 Paseo 執行", "通过 Paseo 执行", "Paseo 経由で実行")}</span></label>
            <label><span>Provider</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Automatic</option>{providers.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
            <label><span>Account</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Automatic</option>{matchingAccounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label><span>Model</span><input list="anneal-models" value={model} onChange={(event) => setModel(event.target.value)} /><datalist id="anneal-models">{(account?.models ?? []).map((name) => <option key={name} value={name} />)}</datalist></label>
            <label className="check-row"><input checked={allowFallback} onChange={(event) => setAllowFallback(event.target.checked)} type="checkbox" /><span>Allow healthy fallback</span></label>
          </div>
          <div className="control-actions">
            <button className="secondary-button" disabled={busy || !accounts.length} onClick={() => void preview()} type="button">Preview route</button>
            <button className="primary-button compact" disabled={busy || !workspaceId || !taskId || !accounts.length} onClick={() => void dispatch()} type="button">Dispatch task</button>
          </div>
          {route ? <article className="route-preview"><strong>{route.workload} · {route.provider.name}</strong><span>{route.account.label} · {route.model ?? "default"}</span><small>{route.proxy.mode === "profile" ? `${route.proxy.source}: ${route.proxy.profile?.name}` : "direct"}</small></article> : null}
          <h3>Related missions</h3>
          <div className="mission-list compact-list">{missions.filter((mission) => !taskId || mission.taskId === taskId).map((mission) => <button className={`mission-row${mission.id === missionId ? " is-selected" : ""}`} key={mission.id} onClick={() => setMissionId(mission.id)} type="button"><div><strong>{mission.title}</strong><small>{mission.engine} · {mission.provider}</small></div><span>{mission.phase}</span></button>)}</div>
          {selectedMission ? <div className="mission-buttons">{ACTIONS.map((action) => <button className={action === "start" || action === "resume" ? "primary-button compact" : "secondary-button"} disabled={busy || !canRun(action, selectedMission)} key={action} onClick={() => void control(action)} type="button">{action}</button>)}</div> : null}
        </section>
      </div>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}

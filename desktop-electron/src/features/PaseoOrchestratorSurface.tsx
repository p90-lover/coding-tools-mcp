import { useEffect, useMemo, useState } from "react";
import type {
  Language,
  ProviderAccountRecord,
  ProviderExecutionPlan,
  ProviderNetworkSnapshot,
} from "../types";
import {
  boardRevision,
  executionBindings,
  localText,
  messageOf,
  missionRevision,
  missionViews,
  sanitizeIdentifier,
  selectBinding,
  workspaceOptions,
  type MissionView,
  type WorkspaceOption,
} from "./execution-surface-utils";
import "./orchestration-control.css";

type Action = "create" | "start" | "hold" | "resume" | "cancel" | "close";
const ACTIONS: readonly Action[] = ["create", "start", "hold", "resume", "cancel", "close"];
const WEB_GPT_PROVIDER_ID = "chatgpt-web";

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
  if (action === "close") return mission.quiescent && ["ready", "held", "review_required", "accepted", "changes_requested"].includes(mission.phase);
  return action === "create" && mission.phase === "draft";
}

export function PaseoOrchestratorSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const accounts = useMemo(() => usable(network), [network]);
  const providers = useMemo(() => [...new Set(accounts.map((account) => account.providerId))], [accounts]);
  const matchingAccounts = useMemo(
    () => accounts.filter((account) => !providerId || account.providerId === providerId),
    [accounts, providerId],
  );
  const account = matchingAccounts.find((candidate) => candidate.id === accountId) ?? matchingAccounts[0];
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
    if (!providers.length) return;
    setProviderId((current) => current || (providers.includes(WEB_GPT_PROVIDER_ID) ? WEB_GPT_PROVIDER_ID : providers[0] ?? ""));
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
      const view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
      const next = missionViews(view).filter((mission) => mission.engine === "paseo");
      setMissions(next);
      setMissionId((current) => next.some((mission) => mission.id === current) ? current : next[0]?.id ?? "");
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
      setNotice(`${next.provider.name} · ${next.account.label} · ${next.model ?? "default"}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    const api = window.codingTools;
    if (!api || !workspaceId || !taskId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const selectedRoute = await plan();
      const view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
      const binding = selectBinding(view, "paseo", selectedRoute.provider.id, selectedRoute.model);
      if (!binding) {
        const available = executionBindings(view)
          .filter((candidate) => candidate.engine === "paseo")
          .map((candidate) => `${candidate.provider}/${candidate.model}`)
          .join(", ");
        throw new Error(available
          ? `No connected Paseo binding matches this route. Available: ${available}`
          : "Connect an approved Paseo provider binding in Providers first");
      }
      const id = sanitizeIdentifier(`paseo-${taskId}-${crypto.randomUUID().slice(0, 8)}`);
      await api.execution.update({
        workspaceId,
        expectedRevision: boardRevision(view),
        change: { operation: "agent_prepare", binding_id: binding.id, task_id: taskId.trim(), mission_id: id },
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
        "Paseo mission creation submitted. Refresh until Ready, then start it.",
        "已提交 Paseo 任務建立要求。請刷新至 Ready，再啟動。",
        "已提交 Paseo 任务建立请求。请刷新至 Ready，再启动。",
        "Paseo ミッションを作成しました。Ready になってから開始してください。",
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
      setNotice(`${action}: ${missionId}`);
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
          <span className="surface-kicker">PASEO</span>
          <h1>{localText(language, "Paseo Orchestrator", "Paseo 協調器", "Paseo 协调器", "Paseo オーケストレーター")}</h1>
          <p>{localText(language,
            "Use ChatGPT Web or another connected provider as the task model, with explicit route preview and mission controls.",
            "使用 ChatGPT Web 或其他已連線供應商作為任務模型，並提供明確路由預覽及任務控制。",
            "使用 ChatGPT Web 或其他已连接供应商作为任务模型，并提供明确路由预览及任务控制。",
            "ChatGPT Web などのモデルで Paseo ミッションを管理します。")}</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void refresh()} type="button">Refresh</button>
      </header>

      <div className="control-grid two-column">
        <section className="control-panel">
          <h2>{localText(language, "Task route", "任務路由", "任务路由", "タスクルート")}</h2>
          <div className="control-fields">
            <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">—</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label><span>Task ID</span><input value={taskId} onChange={(event) => setTaskId(event.target.value)} /></label>
            <label><span>Provider</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Automatic</option>{providers.map((id) => <option key={id} value={id}>{id === WEB_GPT_PROVIDER_ID ? "ChatGPT Web" : id}</option>)}</select></label>
            <label><span>Account</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Automatic</option>{matchingAccounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label><span>Task model</span><input list="paseo-models" value={model} onChange={(event) => setModel(event.target.value)} /><datalist id="paseo-models">{(account?.models ?? []).map((name) => <option key={name} value={name} />)}</datalist></label>
            <label className="check-row"><input checked={allowFallback} onChange={(event) => setAllowFallback(event.target.checked)} type="checkbox" /><span>Allow healthy fallback</span></label>
          </div>
          <div className="control-actions">
            <button className="secondary-button" disabled={busy || !accounts.length} onClick={() => void preview()} type="button">Preview route</button>
            <button className="primary-button compact" disabled={busy || !workspaceId || !taskId.trim() || !accounts.length} onClick={() => void prepare()} type="button">Prepare mission</button>
          </div>
          {route ? <article className="route-preview"><strong>{route.provider.name} · {route.account.label}</strong><span>{route.model ?? "default"}</span><small>{route.proxy.mode === "profile" ? `${route.proxy.source}: ${route.proxy.profile?.name}` : "direct"}</small></article> : null}
        </section>

        <section className="control-panel">
          <h2>Paseo missions</h2>
          <div className="mission-list">
            {missions.map((mission) => <button className={`mission-row${mission.id === missionId ? " is-selected" : ""}`} key={mission.id} onClick={() => setMissionId(mission.id)} type="button"><div><strong>{mission.title}</strong><small>{mission.provider} · {mission.model}</small></div><span>{mission.phase}</span></button>)}
            {!missions.length ? <p className="empty-copy">No Paseo missions.</p> : null}
          </div>
          {selectedMission ? <div className="mission-control"><strong>{selectedMission.id}</strong><div className="mission-buttons"><button className="secondary-button" disabled={busy} onClick={() => void inspect()} type="button">inspect</button>{ACTIONS.filter((action) => action !== "create").map((action) => <button className={action === "start" || action === "resume" ? "primary-button compact" : "secondary-button"} disabled={busy || !canRun(action, selectedMission)} key={action} onClick={() => void control(action)} type="button">{action}</button>)}</div></div> : null}
        </section>
      </div>
      {notice ? <p className="control-notice">{notice}</p> : null}
    </section>
  );
}

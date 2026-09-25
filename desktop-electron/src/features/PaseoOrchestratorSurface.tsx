import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Language,
  ProviderAccountRecord,
  ProviderExecutionPlan,
  ProviderNetworkSnapshot,
} from "../types";
import type { JsonObject } from "../api/contracts";
import {
  localText,
  messageOf,
  missionRevision,
  missionViews,
  object,
  sanitizeIdentifier,
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
const WEB_GPT_MODEL = "chatgpt-web/high";
const GEMINI_PROVIDER_ID = "cliproxyapi-antigravity";
const GEMINI_MODEL = "gemini-3.8-flash-high";
type RouteDraft = Pick<SubagentDraft, "providerId" | "accountId" | "model">;
type PaseoDurableStep = {
  id: string;
  recordId: string;
  taskId: string;
  title: string;
  phase: string;
  providerId: string;
  accountId: string;
  model: string;
  output: string;
  permission: string;
  pendingWrite: boolean;
};
type PaseoDurableRun = {
  id: string;
  taskId: string;
  status: string;
  planner: PaseoDurableStep;
  workers: PaseoDurableStep[];
  reviewer: PaseoDurableStep;
};
type ActiveLoop = { mode: "run" | "review"; runId: string };
const POLL_INTERVAL_MS = 1_500;
const POLL_LIMIT = 200;

export function paseoRouteSelection(
  providerId: string,
  accountId: string,
  model: string,
): RouteDraft & { allowFallback: false } {
  return { providerId, accountId, model, allowFallback: false };
}

export function paseoRouteDefaults(accounts: ProviderAccountRecord[]): {
  orchestrator: RouteDraft | null;
  worker: RouteDraft | null;
} {
  const exact = (providerId: string, model: string): RouteDraft | null => {
    const candidates = accounts.filter((account) => (
      account.providerId === providerId
      && account.models.includes(model)
      && account.enabled
      && account.status === "connected"
      && !account.archivedAt
    ));
    const account = candidates.find((candidate) => candidate.isDefault) ?? candidates[0];
    return account ? { providerId, accountId: account.id, model } : null;
  };
  return {
    orchestrator: exact(WEB_GPT_PROVIDER_ID, WEB_GPT_MODEL),
    worker: exact(GEMINI_PROVIDER_ID, GEMINI_MODEL),
  };
}

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

export function paseoDurableRuns(value: unknown): PaseoDurableRun[] {
  const root = object(value) ?? {};
  const execution = object(root.execution) ?? root;
  const missions = listValue(execution.missions).map((entry) => object(entry) ?? {});
  const byId = new Map(missions.flatMap((entry) => {
    const id = stringValue(object(object(entry.mission)?.spec)?.mission_id);
    return id ? [[id, entry] as const] : [];
  }));
  const step = (
    id: string,
    taskId: string,
    bindingGeneration: string,
    requestKey: string,
  ): PaseoDurableStep => {
    const entry = byId.get(id) ?? {};
    const mission = object(entry.mission) ?? {};
    const spec = object(mission.spec) ?? {};
    const output = object(entry.output);
    const ownedOutput = Boolean(output
      && entry.binding_generation === bindingGeneration
      && entry.start_message_id === requestKey
      && output.agent_id === mission.record_id
      && typeof output.text === "string"
      && typeof output.turn_id === "string"
      && typeof output.epoch === "string"
      && Number.isInteger(output.seq_start)
      && Number.isInteger(output.seq_end)
      && Number(output.seq_end) >= Number(output.seq_start));
    const permissionRow = object(entry.permission_request) ?? object(mission.permission_request);
    const pendingKey = stringValue(mission.pending);
    const pendingWrite = Boolean(pendingKey
      && object(object(mission.receipts)?.[pendingKey])?.state === "reserved");
    const pendingPermissions = listValue(entry.pending_permissions).length
      || listValue(mission.pending_permissions).length;
    const lastStatus = stringValue(mission.last_status);
    const permission = stringValue(permissionRow?.summary, stringValue(permissionRow?.title))
      || (pendingPermissions ? "Permission request pending" : "")
      || (/permission|approval/i.test(lastStatus) ? lastStatus : "");
    return {
      id,
      recordId: stringValue(mission.record_id),
      taskId: taskId || stringValue(spec.task_id),
      title: stringValue(spec.title, id),
      phase: stringValue(mission.phase, "pending"),
      providerId: stringValue(spec.provider),
      accountId: stringValue(spec.account_id),
      model: stringValue(spec.model),
      output: ownedOutput ? stringValue(output?.text) : "",
      permission,
      pendingWrite,
    };
  };

  return listValue(execution.orchestrations).flatMap((candidate) => {
    const row = object(candidate) ?? {};
    const id = stringValue(row.id);
    if (!id) return [];
    const workerIds = listValue(row.worker_mission_ids).map((entry) => stringValue(entry)).filter(Boolean);
    const workerTasks = listValue(row.worker_task_ids).map((entry) => stringValue(entry));
    const workerGenerations = listValue(row.worker_binding_generations).map((entry) => stringValue(entry));
    const workerKeys = listValue(row.worker_request_keys).map((entry) => stringValue(entry));
    const planner = step(
      stringValue(row.planner_mission_id),
      stringValue(row.planner_task_id),
      stringValue(row.planner_binding_generation),
      stringValue(row.planner_request_key),
    );
    const workers = workerIds.map((missionId, index) => step(
      missionId,
      workerTasks[index] ?? "",
      workerGenerations[index] ?? "",
      workerKeys[index] ?? "",
    ));
    const reviewer = step(
      stringValue(row.reviewer_mission_id),
      stringValue(row.reviewer_task_id),
      stringValue(row.reviewer_binding_generation),
      stringValue(row.reviewer_request_key),
    );
    const active = (candidate: PaseoDurableStep) => (
      !["draft", "ready", "pending", "review_required", "accepted", "closed"].includes(candidate.phase)
    );
    const durableStatus = stringValue(row.status);
    const status = (["passed", "needs_changes"].includes(durableStatus) ? durableStatus : "")
      || (paseoTerminalStep({ planner, workers, reviewer }) ? "failed" : "")
      || (reviewer.permission || workers.some((worker) => worker.permission) || planner.permission ? "held" : "")
      || (reviewer.output ? "review_ready" : "")
      || (active(reviewer) ? "reviewing" : "")
      || (workers.length && workers.every((worker) => worker.output) ? "ready_for_review" : "")
      || (workers.some((worker) => worker.output || active(worker)) ? "executing" : "")
      || (planner.output ? "planned" : "planning");
    return [{
      id,
      taskId: stringValue(row.task_id),
      status,
      planner,
      workers,
      reviewer,
    }];
  });
}

function phaseTone(phase: string): string {
  if (["accepted", "closed", "passed"].includes(phase)) return "is-success";
  if (["ready", "review_required", "changes_requested", "ready_for_review", "review_ready", "needs_changes", "planned"].includes(phase)) return "is-warning";
  if (["failed", "cancelled"].includes(phase)) return "is-error";
  if (["running", "planning", "executing", "reviewing"].includes(phase)) return "is-running";
  return "is-muted";
}

function createPaseoRunId(): string {
  return sanitizeIdentifier(`paseo-${crypto.randomUUID()}`).slice(0, 80);
}

function storedDraftRunId(workspaceId: string, replace = false): string {
  const key = `coding-tools:paseo-draft:${workspaceId}`;
  try {
    const stored = replace ? "" : window.localStorage.getItem(key) ?? "";
    if (/^[A-Za-z0-9_-]{1,80}$/.test(stored)) return stored;
    const next = createPaseoRunId();
    window.localStorage.setItem(key, next);
    return next;
  } catch {
    return createPaseoRunId();
  }
}

function stepFinished(step: PaseoDurableStep): boolean {
  return Boolean(step.output);
}

export function paseoTerminalStep(
  run: Pick<PaseoDurableRun, "planner" | "workers" | "reviewer">,
): PaseoDurableStep | undefined {
  return [run.planner, ...run.workers, run.reviewer].find((step) => (
    !stepFinished(step) && ["failed", "closed", "cancelled"].includes(step.phase)
  ));
}

export function shouldRefreshPaseoStep(
  step: Pick<PaseoDurableStep, "phase" | "recordId" | "pendingWrite">,
): boolean {
  return step.phase === "running" && Boolean(step.recordId) && !step.pendingWrite;
}

export function paseoVerifiedReviewStatus(runId: string, review: JsonObject | null): string {
  const status = stringValue(review?.status);
  return runId && review?.runId === runId && review.liveModelCompletion === true
    && ["passed", "needs_changes"].includes(status) ? status : "";
}

export function paseoDurableFindings(run: PaseoDurableRun): { title: string; detail: string }[] {
  if (!["passed", "needs_changes"].includes(run.status) || !run.reviewer.output
    || run.reviewer.output.length > 64 * 1024) return [];
  try {
    const output = run.reviewer.output.trim();
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(output);
    const parsed = object(JSON.parse(fenced ? fenced[1].trim() : output));
    if (!parsed || Object.keys(parsed).length !== 2
      || parsed.verdict !== (run.status === "passed" ? "pass" : "needs_changes")
      || !Array.isArray(parsed.findings) || parsed.findings.length > 32
      || (run.status === "passed" && parsed.findings.length !== 0)
      || (run.status === "needs_changes" && parsed.findings.length === 0)) return [];
    const findings = parsed.findings.map((value) => object(value));
    if (findings.some((value) => !value || Object.keys(value).length !== 2
      || typeof value.title !== "string" || !value.title.trim() || value.title.length > 200
      || typeof value.detail !== "string" || !value.detail.trim() || value.detail.length > 4_000)) return [];
    return findings.map((value) => ({ title: String(value?.title).trim(), detail: String(value?.detail).trim() }));
  } catch {
    return [];
  }
}

function currentStep(run: PaseoDurableRun, mode: ActiveLoop["mode"]): PaseoDurableStep {
  if (mode === "review") return run.reviewer;
  return [run.planner, ...run.workers].find((step) => !stepFinished(step)) ?? run.workers.at(-1) ?? run.planner;
}

function stepState(step: PaseoDurableStep, currentId: string, reviewer = false): string {
  if (stepFinished(step)) return "finished";
  if (["failed", "closed", "cancelled"].includes(step.phase)) return "failed";
  if (["held", "scheduling_held", "hold_requested"].includes(step.phase)) return "held";
  if (step.id === currentId) return reviewer ? "review" : "current";
  return "pending";
}

function workflowStateLabel(language: Language, state: string): string {
  if (state === "failed") return localText(language, "Failed", "失敗", "失败", "失敗");
  if (state === "current") return localText(language, "Current", "目前", "当前", "進行中");
  if (state === "review") return localText(language, "Review", "審查", "审查", "レビュー");
  if (state === "finished") return localText(language, "Finished", "完成", "完成", "完了");
  if (state === "held") return localText(language, "Held", "保留", "保留", "保留");
  return localText(language, "Pending", "待處理", "待处理", "待機中");
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
  const [route, setRoute] = useState<ProviderExecutionPlan | null>(null);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [missionId, setMissionId] = useState("");
  const [runs, setRuns] = useState<PaseoDurableRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [draftRunId, setDraftRunId] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [activeLoop, setActiveLoop] = useState<ActiveLoop | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("route");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [subagents, setSubagents] = useState<SubagentDraft[]>([]);
  const [assignmentReview, setAssignmentReview] = useState<JsonObject | null>(null);
  const pollGeneration = useRef(0);

  const accounts = useMemo(() => usable(network), [network]);
  const defaults = useMemo(() => paseoRouteDefaults(accounts), [accounts]);
  const providers = useMemo(
    () => [...new Set(accounts.map((account) => account.providerId))],
    [accounts],
  );
  const matchingAccounts = useMemo(
    () => accounts.filter((account) => !providerId || account.providerId === providerId),
    [accounts, providerId],
  );
  const account = matchingAccounts.find((candidate) => candidate.id === accountId);
  const orchestratorReady = Boolean(
    account && account.providerId === providerId && account.models.includes(model),
  );
  const workersReady = subagents.length > 0 && subagents.every((item) => (
    accounts.some((candidate) => (
      candidate.id === item.accountId
      && candidate.providerId === item.providerId
      && candidate.models.includes(item.model)
    ))
  ));
  const selectedMission = missions.find((mission) => mission.id === missionId);
  const selectedRun = runs.find((run) => run.id === selectedRunId);

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
    setProviderId((current) => current || defaults.orchestrator?.providerId || "");
  }, [defaults.orchestrator?.providerId]);

  useEffect(() => {
    setAccountId((current) => {
      if (matchingAccounts.some((candidate) => candidate.id === current)) return current;
      return providerId === defaults.orchestrator?.providerId
        ? defaults.orchestrator?.accountId ?? ""
        : "";
    });
  }, [defaults.orchestrator, matchingAccounts, providerId]);

  useEffect(() => {
    setModel((current) => {
      if (current && account?.models.includes(current)) return current;
      return account?.id === defaults.orchestrator?.accountId
        ? defaults.orchestrator?.model ?? ""
        : "";
    });
  }, [account, defaults.orchestrator]);

  useEffect(() => {
    setSubagents((current) => {
      if (current.length || !defaults.worker) return current;
      return [{
        key: crypto.randomUUID().slice(0, 8),
        ...defaults.worker,
        role: "implementer",
      }];
    });
  }, [defaults.worker]);

  useEffect(() => {
    if (!workspaceId) return;
    pollGeneration.current += 1;
    setActiveLoop(null);
    setDraftRunId(storedDraftRunId(workspaceId));
    setSelectedRunId("");
    setMissionId("");
    setDrafting(false);
    void refresh(true);
  }, [workspaceId]);

  useEffect(() => () => {
    pollGeneration.current += 1;
  }, []);

  const applyExecutionView = (view: JsonObject, chooseDefault = false): PaseoDurableRun[] => {
    const nextMissions = missionViews(view).filter((mission) => mission.engine === "paseo");
    const nextRuns = paseoDurableRuns(view);
    setMissions(nextMissions);
    setRuns(nextRuns);
    setSelectedRunId((current) => (
      nextRuns.some((run) => run.id === current)
        ? current
        : chooseDefault ? nextRuns[0]?.id ?? "" : ""
    ));
    setMissionId((current) => (
      nextMissions.some((mission) => mission.id === current)
        ? current
        : chooseDefault && !nextRuns.length ? nextMissions[0]?.id ?? "" : ""
    ));
    return nextRuns;
  };

  const refresh = async (chooseDefault = false): Promise<PaseoDurableRun[]> => {
    const api = window.codingTools;
    if (!api || !workspaceId) return [];
    setBusy(true);
    try {
      const view = await api.execution.read({
        workspaceId,
        missionId: null,
        refreshSource: false,
      });
      return applyExecutionView(view, chooseDefault);
    } catch (cause) {
      setError(messageOf(cause));
      return [];
    } finally {
      setBusy(false);
    }
  };

  const plan = async (): Promise<ProviderExecutionPlan> => {
    const launcher = window.codexWebLauncher;
    if (!launcher) throw new Error(copy.executionPlanningUnavailable);
    const next = await launcher.providerExecutionPlan({
      workload: "paseo",
      ...paseoRouteSelection(providerId, accountId, model),
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
    const stableRunId = draftRunId || storedDraftRunId(workspaceId);
    setDraftRunId(stableRunId);
    setBusy(true);
    setError(null);
    try {
      const next = await callPlane("paseo_plan", {
        runId: stableRunId,
        taskId: taskId.trim(),
        brief: taskId.trim(),
        orchestrator: paseoRouteSelection(providerId, accountId, model),
        subagents: subagents.map((item) => ({
          role: item.role,
          ...paseoRouteSelection(item.providerId, item.accountId, item.model),
        })),
      });
      setAssignmentReview(null);
      setInspectorTab("plan");
      setNotice(`${copy.paseoAssignmentPreview}: ${stringValue(object(next.orchestrator)?.role, "orchestrator")}`);
      await refresh();
      setSelectedRunId(stableRunId);
      setDrafting(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const stopFollowing = () => {
    pollGeneration.current += 1;
    setActiveLoop(null);
    setBusy(false);
  };

  const followRun = async (mode: ActiveLoop["mode"], runId: string) => {
    const api = window.codingTools;
    if (!api || !workspaceId || !runId) return;
    const generation = pollGeneration.current + 1;
    pollGeneration.current = generation;
    setActiveLoop({ mode, runId });
    setBusy(true);
    setError(null);
    try {
      for (let attempt = 0; attempt < POLL_LIMIT && pollGeneration.current === generation; attempt += 1) {
        let view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
        if (pollGeneration.current !== generation) return;
        let run = applyExecutionView(view).find((candidate) => candidate.id === runId);
        if (!run) throw new Error(`Paseo run ${runId} is unavailable in this workspace`);
        if (["passed", "needs_changes"].includes(run.status)) return;
        const terminal = paseoTerminalStep(run);
        if (terminal) throw new Error(`Paseo mission ${terminal.id} ${terminal.phase} before returning a result`);
        const blocked = [run.planner, ...run.workers, run.reviewer].find((step) => step.permission);
        if (blocked) {
          setMissionId(blocked.id);
          setInspectorTab("mission");
          setNotice(blocked.permission);
          return;
        }

        const active = currentStep(run, mode);
        const waitingForState = active.id && !stepFinished(active)
          && !["draft", "ready", "pending", "review_required"].includes(active.phase);
        if (shouldRefreshPaseoStep(active)) {
          await api.execution.read({ workspaceId, missionId: active.id, refreshSource: true });
        }
        if (waitingForState) {
          await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
          if (pollGeneration.current !== generation) return;
          view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
          run = applyExecutionView(view).find((candidate) => candidate.id === runId);
          if (!run) throw new Error(`Paseo run ${runId} is unavailable in this workspace`);
          const terminal = paseoTerminalStep(run);
          if (terminal) throw new Error(`Paseo mission ${terminal.id} ${terminal.phase} before returning a result`);
          const pendingPermission = [run.planner, ...run.workers, run.reviewer]
            .find((step) => step.permission);
          if (pendingPermission) {
            setMissionId(pendingPermission.id);
            setInspectorTab("mission");
            setNotice(pendingPermission.permission);
            return;
          }
        }

        if (mode === "run") {
          if (run.workers.length > 0 && run.workers.every(stepFinished)) {
            setNotice(copy.paseoReviewReady);
            return;
          }
          const next = currentStep(run, mode);
          const waiting = !stepFinished(next)
            && !["draft", "ready", "pending", "review_required"].includes(next.phase);
          if (waiting) continue;
          const result = await callPlane("paseo_run", { planId: runId });
          if (pollGeneration.current !== generation) return;
          if (stringValue(result.status) === "ready_for_review") {
            await refresh();
            setNotice(copy.paseoReviewReady);
            return;
          }
        } else {
          const reviewerReady = stepFinished(run.reviewer)
            || (["draft", "ready", "pending"].includes(run.reviewer.phase)
              && run.workers.length > 0
              && run.workers.every(stepFinished));
          if (!reviewerReady) continue;
          const result = await callPlane("paseo_review", { runId });
          if (pollGeneration.current !== generation) return;
          setAssignmentReview(result);
          if (["passed", "needs_changes"].includes(stringValue(result.status))) {
            await refresh();
            setNotice(copy.paseoReviewReady);
            return;
          }
        }
      }
      if (pollGeneration.current === generation) {
        setNotice(localText(
          language,
          "Following paused after five minutes. Resume when ready.",
          "追蹤已在五分鐘後暫停，準備好後再繼續。",
          "跟踪已在五分钟后暂停，准备好后再继续。",
          "5 分後に追跡を一時停止しました。準備ができたら再開してください。",
        ));
      }
    } catch (cause) {
      if (pollGeneration.current === generation) setError(messageOf(cause));
    } finally {
      if (pollGeneration.current === generation) {
        setActiveLoop(null);
        setBusy(false);
      }
    }
  };

  const openAnnealTask = async () => {
    if (!paseoVerifiedReviewStatus(selectedRunId, assignmentReview)
      || !listValue(assignmentReview?.findings).length) return;
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

  const updateSubagent = (key: string, patch: Partial<SubagentDraft>) => {
    setSubagents((current) => current.map((item) => (
      item.key === key ? { ...item, ...patch } : item
    )));
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

  const inspect = async (targetMissionId = missionId) => {
    const api = window.codingTools;
    if (!api || !workspaceId || !targetMissionId) return;
    setBusy(true);
    setError(null);
    try {
      setMissionId(targetMissionId);
      await api.execution.read({ workspaceId, missionId: targetMissionId, refreshSource: true });
      await refresh();
      setInspectorTab("mission");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const beginNewSession = () => {
    stopFollowing();
    const nextRunId = workspaceId ? storedDraftRunId(workspaceId, true) : createPaseoRunId();
    setDraftRunId(nextRunId);
    setDrafting(true);
    setSelectedRunId("");
    setMissionId("");
    setTaskId("");
    setRoute(null);
    setAssignmentReview(null);
    setNotice("");
    setInspectorTab("route");
  };

  const proxySummary = route?.proxy.mode === "profile"
    ? `${route.proxy.source} · ${route.proxy.profile?.name ?? copy.proxy}`
    : copy.direct;
  const selectedReviewStatus = selectedRun
    ? (["passed", "needs_changes"].includes(selectedRun.status) ? selectedRun.status : "")
      || paseoVerifiedReviewStatus(selectedRun.id, assignmentReview) : "";
  const selectedDisplayStatus = selectedReviewStatus || selectedRun?.status || "";
  const selectedRunMode: ActiveLoop["mode"] = selectedRun
    && ["ready_for_review", "review_ready", "reviewing", "passed", "needs_changes"].includes(selectedDisplayStatus)
    ? "review"
    : "run";
  const selectedCurrentId = selectedRun ? currentStep(selectedRun, selectedRunMode).id : "";
  const selectedSteps = selectedRun
    ? [selectedRun.planner, ...selectedRun.workers, selectedRun.reviewer]
    : [];
  const selectedHasPermission = selectedSteps.some((step) => step.permission);
  const selectedWorkersComplete = Boolean(
    selectedRun?.workers.length && selectedRun.workers.every(stepFinished),
  );
  const selectedReviewComplete = Boolean(selectedReviewStatus);
  const selectedFindings = selectedRun ? paseoDurableFindings(selectedRun) : [];
  const workflowSteps = selectedRun ? [
    {
      key: "planner",
      label: localText(language, "Planner", "規劃者", "规划者", "プランナー"),
      step: selectedRun.planner,
      reviewer: false,
    },
    ...selectedRun.workers.map((step, index) => ({
      key: `worker-${index + 1}`,
      label: localText(language, `Worker ${index + 1}`, `工作者 ${index + 1}`, `工作者 ${index + 1}`, `ワーカー ${index + 1}`),
      step,
      reviewer: false,
    })),
    {
      key: "reviewer",
      label: localText(language, "Reviewer", "審查者", "审查者", "レビュアー"),
      step: selectedRun.reviewer,
      reviewer: true,
    },
  ] : [];

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
            disabled={busy}
            onClick={beginNewSession}
            type="button"
          >
            +
          </button>
        </header>
        <button className="paseo-new-session-card" disabled={busy} onClick={beginNewSession} type="button">
          <span aria-hidden="true">＋</span>
          <strong>{copy.paseoNewSession}</strong>
        </button>
        <div className="paseo-session-list">
          {runs.map((run) => {
            const status = run.id === selectedRunId ? selectedDisplayStatus : run.status;
            return (
              <button
                className={`paseo-session-item${run.id === selectedRunId ? " is-selected" : ""}`}
                key={run.id}
                onClick={() => {
                  stopFollowing();
                  setDrafting(false);
                  setSelectedRunId(run.id);
                  setMissionId(run.planner.id);
                  setInspectorTab("plan");
                }}
                type="button"
              >
                <span className={`paseo-status-dot ${phaseTone(status)}`} />
                <span className="paseo-session-copy">
                  <strong>{run.taskId}</strong>
                  <small>{run.id}</small>
                </span>
                <em>{phaseLabel(copy, status)}</em>
              </button>
            );
          })}
          {missions.map((mission) => (
            <button
              className={`paseo-session-item is-mission${!selectedRunId && !drafting && mission.id === missionId ? " is-selected" : ""}`}
              key={mission.id}
              onClick={() => {
                stopFollowing();
                setDrafting(false);
                setSelectedRunId("");
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
          {!runs.length && !missions.length ? <p className="paseo-empty-sessions">{copy.paseoNoSessions}</p> : null}
        </div>
      </aside>

      <main className="paseo-workbench">
        <header className="paseo-workbench-toolbar">
          <div>
            <span className="surface-kicker">PASEO</span>
            <h2>{selectedRun?.taskId ?? selectedMission?.title ?? copy.paseoNewWorkspace}</h2>
          </div>
          <label className="paseo-workspace-picker">
            <span>{copy.workspace}</span>
            <select disabled={busy} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
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

        {selectedRun ? (
          <div className="paseo-workflow-board">
            <header className="paseo-workflow-heading">
              <div>
                <span className={`paseo-phase-badge ${phaseTone(selectedDisplayStatus)}`}>
                  {phaseLabel(copy, selectedDisplayStatus)}
                </span>
                <h3>{selectedRun.taskId}</h3>
                <code>{selectedRun.id}</code>
              </div>
              <div className="paseo-inline-controls">
                {activeLoop?.runId === selectedRun.id ? (
                  <button className="secondary-button" onClick={stopFollowing} type="button">
                    {localText(language, "Pause follow", "暫停追蹤", "暂停跟踪", "追跡を停止")}
                  </button>
                ) : null}
                <button
                  className="secondary-button"
                  disabled={busy || selectedHasPermission || selectedWorkersComplete}
                  onClick={() => void followRun("run", selectedRun.id)}
                  type="button"
                >
                  {copy.paseoRunSubagents}
                </button>
                <button
                  className="primary-button compact"
                  disabled={busy || selectedHasPermission || !selectedWorkersComplete || selectedReviewComplete}
                  onClick={() => void followRun("review", selectedRun.id)}
                  type="button"
                >
                  {copy.paseoReviewResults}
                </button>
              </div>
            </header>

            <div className="paseo-workflow-steps">
              {workflowSteps.map(({ key, label, step, reviewer }) => {
                const state = stepState(step, selectedCurrentId, reviewer);
                return (
                  <article className={`paseo-workflow-step is-${state}`} key={key}>
                    <span className={`paseo-status-dot ${phaseTone(state === "failed" ? "failed" : step.phase)}`} />
                    <div>
                      <header>
                        <strong>{label}</strong>
                        <em>{workflowStateLabel(language, state)}</em>
                      </header>
                      <small>
                        {phaseLabel(copy, step.phase)} · {step.providerId} · {step.accountId} · {step.model}
                      </small>
                      <small>{step.taskId || step.id}</small>
                      {step.output ? <pre>{step.output}</pre> : null}
                      {step.permission ? <p role="alert">{step.permission}</p> : null}
                    </div>
                    <button
                      className="secondary-button"
                      disabled={busy || !step.id}
                      onClick={() => void inspect(step.id)}
                      type="button"
                    >
                      {copy.inspect}
                    </button>
                  </article>
                );
              })}
            </div>
            {selectedFindings.length ? (
              <div className="paseo-workflow-steps paseo-run-results">
                <strong>{localText(language, "Review findings", "審查發現", "审核发现", "レビューの指摘")}</strong>
                <ol className="paseo-assignment-list">
                  {selectedFindings.map((finding, index) => (
                    <li key={`${index}-${finding.title}`}>
                      <strong>{finding.title}</strong>
                      <small>{finding.detail}</small>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {notice ? <p className="control-notice paseo-inline-notice">{notice}</p> : null}
          </div>
        ) : selectedMission && !drafting ? (
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
            </div>

            <section className="paseo-subagent-board">
              <header>
                <h3>{copy.paseoSubagents}</h3>
                <button
                  className="secondary-button"
                  disabled={busy || !accounts.length || subagents.length >= 8}
                  onClick={() => {
                    setSubagents((current) => [
                      ...current,
                      {
                        key: crypto.randomUUID().slice(0, 8),
                        providerId: defaults.worker?.providerId ?? "",
                        accountId: defaults.worker?.accountId ?? "",
                        model: defaults.worker?.model ?? "",
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
                const agentAccount = agentAccounts.find((account) => account.id === item.accountId);
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
                placeholder={copy.taskId}
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
              />
              <footer>
                <small>{copy.paseoComposerHint} · {draftRunId}</small>
                <div>
                  <button
                    className="secondary-button"
                    disabled={busy || !orchestratorReady}
                    onClick={() => void preview()}
                    type="button"
                  >
                    {copy.previewRoute}
                  </button>
                  <button
                    className="primary-button paseo-submit-button"
                    disabled={busy || !workspaceId || !taskId.trim() || !orchestratorReady || !workersReady}
                    onClick={() => void planAssignments()}
                    type="button"
                  >
                    {busy ? copy.paseoPlanning : copy.paseoPlanAssignments}
                    <span aria-hidden="true">↵</span>
                  </button>
                </div>
              </footer>
            </section>
            {!accounts.length ? <p className="paseo-provider-warning">{copy.noProviderAccounts}</p> : null}
            {accounts.length && (!orchestratorReady || !workersReady) ? (
              <p className="paseo-provider-warning">
                {WEB_GPT_MODEL} + {GEMINI_MODEL} unavailable; select connected routes explicitly.
              </p>
            ) : null}
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
          selectedRun ? (
            <div className="paseo-inspector-content">
              <span className="paseo-route-ready">{copy.paseoAssignmentPreview}</span>
              <dl className="paseo-detail-list">
                <div><dt>{copy.taskReference}</dt><dd>{selectedRun.taskId}</dd></div>
                <div><dt>{copy.mission}</dt><dd>{selectedRun.id}</dd></div>
                <div><dt>{copy.phase}</dt><dd>{phaseLabel(copy, selectedDisplayStatus)}</dd></div>
              </dl>
              <ol className="paseo-assignment-list">
                {workflowSteps.map(({ key, label, step }) => (
                  <li key={key}>
                    <strong>{label}</strong>
                    <small>{phaseLabel(copy, step.phase)} · {step.providerId} · {step.model}</small>
                    <code>{step.id}</code>
                  </li>
                ))}
              </ol>
              {paseoVerifiedReviewStatus(selectedRun.id, assignmentReview)
                && listValue(assignmentReview?.findings).length > 0 ? (
                <div className="paseo-run-results">
                  <button
                    className="primary-button compact"
                    disabled={busy}
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

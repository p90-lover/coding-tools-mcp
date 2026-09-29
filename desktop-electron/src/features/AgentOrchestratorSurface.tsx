import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import type { Language } from "../types";
import { AgentOrchestratorOriginalSurface } from "./AgentOrchestratorOriginalSurface";
import { AgentOrchestratorCanvas, type CanvasNode } from "./AgentOrchestratorCanvas";
import {
  AgentOrchestratorRoleEditor, DEFAULT_WORKER_MODEL, HarnessPicker, NATIVE_HARNESS, SPECIALTIES, defaultTeam, emptyRoleSettings,
  harnessLabel, teamForMission, workerRoute, type AoHarness, type AoRoute, type AoTeam, type RoleSettings,
} from "./AgentOrchestratorRoleEditor";
import "./agent-orchestrator.css";

type Clause = { id: string; title: string; detail?: string; state: string };
type PlanTask = {
  id: string; title: string; description?: string; state: string; step: number;
  lane: string; displayStatus: string; clauses: Clause[];
  clauseProgress: { done: number; total: number };
};
type Board = { revision: number; steps: string[]; tasks: PlanTask[]; task?: PlanTask };
export type AoReceipt = { status: string; answer?: string; error?: string; verdict?: string; thread_id?: string; turn_id?: string; request_key?: string; settings?: RoleSettings; route?: { model: string } };
export type AoNode = {
  id: string; task_id: string; role: "planner" | "worker" | "reviewer";
  parents: string[]; x: number; y: number; positioned?: boolean; state: string;
  clause_id?: string; request_key?: string; template_role_id?: string;
  settings?: RoleSettings;
  route: { harness_id: string; provider_id: string; account_id: string; model: string; permission_profile: string };
  receipt?: AoReceipt;
  history?: AoReceipt[];
};
export type AoMission = { id: string; project_id: string; workspace_id: string; revision: number; cancelled: boolean; paused?: boolean; nodes: AoNode[]; team?: AoTeam; worker_limit?: number };
type AoApproval = { nodeId: string; approval_id: string; kind?: string; path?: string; reason?: string; command?: string; cwd?: string; permissions?: Record<string, unknown>; seconds_remaining?: number };
type Sheet = "" | "mission" | "worker" | "settings";

const words = {
  en: { title: "Agent Orchestrator", workspace: "Workspace", mission: "Mission", newMission: "New mission", canvas: "Canvas", board: "Board",
    start: "Start", resume: "Resume", pause: "Pause", stop: "Stop", settings: "Settings", refresh: "Refresh", addWorker: "Worker",
    noMissions: "No missions yet", noWorkspace: "Add a workspace to begin", create: "Create", add: "Add", cancel: "Cancel" },
  "zh-CN": { title: "代理编排", workspace: "工作区", mission: "任务", newMission: "新任务", canvas: "画布", board: "看板",
    start: "开始", resume: "继续", pause: "暂停", stop: "停止", settings: "设置", refresh: "刷新", addWorker: "工作者",
    noMissions: "尚无任务", noWorkspace: "先添加工作区", create: "创建", add: "添加", cancel: "取消" },
  "zh-TW": { title: "代理編排", workspace: "工作區", mission: "任務", newMission: "新任務", canvas: "畫布", board: "看板",
    start: "開始", resume: "繼續", pause: "暫停", stop: "停止", settings: "設定", refresh: "重新整理", addWorker: "工作者",
    noMissions: "尚無任務", noWorkspace: "先新增工作區", create: "建立", add: "新增", cancel: "取消" },
  ja: { title: "エージェント編成", workspace: "ワークスペース", mission: "ミッション", newMission: "新規ミッション", canvas: "キャンバス", board: "ボード",
    start: "開始", resume: "再開", pause: "一時停止", stop: "停止", settings: "設定", refresh: "更新", addWorker: "ワーカー",
    noMissions: "ミッションはまだありません", noWorkspace: "ワークスペースを追加してください", create: "作成", add: "追加", cancel: "キャンセル" },
} satisfies Record<Language, Record<string, string>>;

type GlyphName = "play" | "pause" | "stop" | "plus" | "gear" | "refresh" | "worker";
// Built on demand so importing this module never evaluates JSX.
const glyphPaths = (): Record<GlyphName, ReactNode> => ({
  play: <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />,
  pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  worker: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
});
function Glyph({ name }: { name: GlyphName }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphPaths()[name]}</svg>;
}
function ToolButton({ icon, label, onClick, disabled, primary, pressed }: { icon: GlyphName; label: string; onClick: () => void; disabled?: boolean; primary?: boolean; pressed?: boolean }) {
  return <button type="button" className={`ao-tool${primary ? " is-primary" : ""}`} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Glyph name={icon} /></button>;
}

async function moduleCall(operation: string, args: JsonObject = {}) {
  const outer = await getCodingToolsClient().apps.call({
    moduleId: "agent-orchestrator", operation, arguments: args,
  });
  const value = outer.result as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Orchestrator returned no result");
  }
  const result = value as Record<string, unknown>;
  if (result.cancelled === true) return result;
  if (outer.ok === false || result.ok === false) {
    throw new Error(String(result.reason || result.detail || "Agent Orchestrator operation failed"));
  }
  return result;
}

async function listAllWorkspaces(): Promise<WorkspaceSummary[]> {
  const items: WorkspaceSummary[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = await getCodingToolsClient().workspaces.list({ cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  return items;
}

export function aoLevels(run: Pick<AoMission, "nodes">): AoNode[][] {
  const nodes = new Map(run.nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const depth = (id: string, visiting = new Set<string>()): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(0, ...((nodes.get(id)?.parents ?? []).map((parent) => depth(parent, visiting) + 1)));
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  const levels: AoNode[][] = [];
  for (const node of run.nodes) (levels[depth(node.id)] ??= []).push(node);
  for (const level of levels) level.sort((a, b) => a.x - b.x || a.y - b.y);
  return levels;
}

export function aoDependencyChange(run: Pick<AoMission, "nodes">, nodeId: string, parentId: string) {
  const node = run.nodes.find((item) => item.id === nodeId);
  const parent = run.nodes.find((item) => item.id === parentId);
  if (!node || !parent || node.role !== "worker" || node.state !== "pending"
    || parent.role === "reviewer" || nodeId === parentId || node.parents.includes(parentId)) return null;
  const byId = new Map(run.nodes.map((item) => [item.id, item]));
  const ancestors = (id: string, seen = new Set<string>()): boolean => {
    if (id === nodeId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.parents ?? []).some((item) => ancestors(item, seen));
  };
  if (ancestors(parentId)) return null;
  return { operation: "set_parents", node_id: nodeId, parents: [...node.parents, parentId] };
}

export function aoPreviewText(run: Pick<AoMission, "cancelled" | "nodes">, tasks: Pick<PlanTask, "id" | "title" | "description">[]): string {
  if (run.cancelled) return "No ready card in this run.";
  const node = run.nodes.find((item) => item.state === "pending" && (item.role === "planner" ||
    item.parents.length > 0 && item.parents.every((id) => run.nodes.some((parent) => parent.id === id && parent.state === "finished"))));
  if (!node) return "No ready card in this run.";
  const task = tasks.find((item) => item.id === node.task_id);
  return `${node.role}: ${task?.title ?? node.task_id}\n${task?.description ?? ""}`.trim();
}

const NATIVE_ENTRY: AoHarness = { id: NATIVE_HARNESS, label: "Native Codex", runnable: true, installed: true };

export function AgentOrchestratorSurface({ language, setError }: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = words[language];
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(() => { try { return localStorage.getItem("coding-tools:ao:workspace") || ""; } catch { return ""; } });
  const [view, setView] = useState<"board" | "team">("team");
  const [sheet, setSheet] = useState<Sheet>("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [missions, setMissions] = useState<AoMission[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [inspectedId, setInspectedId] = useState("");
  const [team, setTeam] = useState<AoTeam | null>(null);
  const [draftTeam, setDraftTeam] = useState<AoTeam | null>(null);
  const [limits, setLimits] = useState({ revision: 0, max_workers: 3 });
  const [globalLimit, setGlobalLimit] = useState(3);
  const [missionLimit, setMissionLimit] = useState(3);
  const [harnesses, setHarnesses] = useState<AoHarness[]>([NATIVE_ENTRY]);
  const [harnessNotice, setHarnessNotice] = useState("");
  const [workerRouteDraft, setWorkerRouteDraft] = useState<AoRoute>(() => workerRoute(NATIVE_HARNESS, DEFAULT_WORKER_MODEL));
  const [workerName, setWorkerName] = useState("Worker");
  const [workerSpecialty, setWorkerSpecialty] = useState("implementation");
  const [executable, setExecutable] = useState(() => {
    try { return localStorage.getItem("coding-tools:ao:codex-executable") ?? ""; }
    catch { return ""; }
  });
  const [advanceNotice, setAdvanceNotice] = useState("");
  const [autoStatus, setAutoStatus] = useState("idle");
  const [pendingApprovals, setPendingApprovals] = useState<AoApproval[]>([]);
  const [runTaskId, setRunTaskId] = useState("");
  const [workerParentId, setWorkerParentId] = useState("");
  const [busy, setBusy] = useState("");
  const [missionTitle, setMissionTitle] = useState("");
  const [missionPrompt, setMissionPrompt] = useState("");

  const modelCache = useRef(new Map<string, Promise<string[]>>());
  const loadModels = useCallback((harness: string) => {
    const key = JSON.stringify([workspaceId, harness]);
    let pending = modelCache.current.get(key);
    if (!pending) {
      // Native Codex lists WebGPT plus every CPA model; AO harnesses list their own catalog.
      pending = moduleCall("models", { harness, workspaceId }).then(result => (Array.isArray(result.models) ? result.models as string[] : []));
      pending.catch(() => modelCache.current.delete(key));
      modelCache.current.set(key, pending);
    }
    return pending;
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    void moduleCall("harnesses").then(result => {
      if (!live) return;
      const items = Array.isArray(result.harnesses) ? result.harnesses as AoHarness[] : [];
      setHarnesses(items.length ? items : [NATIVE_ENTRY]);
      setHarnessNotice(typeof result.notice === "string" ? result.notice : "");
    }).catch(cause => { if (live) setHarnessNotice(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, []);

  const loadMissions = async (id: string) => {
    const current = await moduleCall("runs", { workspaceId: id });
    const runs = Array.isArray(current.runs) ? current.runs as AoMission[] : [];
    setMissions(runs);
    setTeam(current.team as AoTeam | null ?? null);
    if (current.limits) { setLimits(current.limits as typeof limits); setGlobalLimit((current.limits as typeof limits).max_workers); }
    setSelectedRunId((selected) => runs.some((run) => run.id === selected) ? selected : runs[0]?.id ?? "");
  };

  const loadBoard = async (id: string) => {
    const current = await moduleCall("board", { workspaceId: id }) as unknown as Board;
    setBoard(current);
    return current;
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const items = await listAllWorkspaces();
        if (live) {
          setWorkspaces(items);
          setWorkspaceId(selected => items.some(item => item.id === selected) ? selected : items[0]?.id ?? "");
          setWorkspaceReady(true);
          if (!items.length) setSheet("settings");
        }
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { live = false; };
  }, [setError]);

  useEffect(() => {
    if (!workspaceReady || !workspaceId) { setBoard(null); setMissions([]); return; }
    let live = true;
    setBoard(null);
    setMissions([]);
    setSelectedRunId("");
    setTeam(null); setDraftTeam(null); setInspectedId("");
    void (async () => {
      try {
        const current = await moduleCall("board", { workspaceId }) as unknown as Board;
        if (live) setBoard(current);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
      try {
        const current = await moduleCall("runs", { workspaceId });
        if (live) {
          const runs = Array.isArray(current.runs) ? current.runs as AoMission[] : [];
          setMissions(runs);
          setTeam(current.team as AoTeam | null ?? null);
          if (current.limits) { setLimits(current.limits as typeof limits); setGlobalLimit((current.limits as typeof limits).max_workers); }
          setSelectedRunId(runs[0]?.id ?? "");
        }
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { live = false; };
  }, [workspaceId, workspaceReady, setError]);

  const run = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };

  const createWorkspace = () => void run("workspace", async () => {
    const result = await getCodingToolsClient().workspaces.create({
      path: workspacePath.trim(), ...(workspaceName.trim() ? { name: workspaceName.trim() } : {}), confirm: true,
    });
    if (result.cancelled || !result.id) return;
    setWorkspaces(await listAllWorkspaces());
    setWorkspaceId(result.id);
    setWorkspacePath(""); setWorkspaceName("");
    setSheet("");
  });

  const selectedRun = missions.find((mission) => mission.id === selectedRunId);
  const inspectedNode = selectedRun?.nodes.find(node => node.id === inspectedId);
  useEffect(() => { setInspectedId(""); setDraftTeam(null); setMissionLimit(selectedRun?.worker_limit || 3); }, [selectedRunId]);
  const inspectRole = (id: string) => {
    setInspectedId(id);
    if (selectedRun && !draftTeam) setDraftTeam(teamForMission(selectedRun, team));
  };
  const applyTeam = () => void run("team", async () => {
    if (!draftTeam || !selectedRun) return;
    const saved = await moduleCall("team_update", { workspaceId, change: { operation: "save_team", expected_revision: draftTeam.revision, team: draftTeam as unknown as JsonObject } });
    const next = saved.team as AoTeam; setTeam(next); setDraftTeam(structuredClone(next));
    try {
      const latest = await moduleCall("runs", { workspaceId, runId: selectedRun.id });
      const mission = (latest.runs as AoMission[]).find(item => item.id === selectedRun.id)!;
      await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: mission.id, expected_revision: mission.revision, team_revision: next.revision } });
      setAdvanceNotice("Team saved; queued cards updated");
    } catch (cause) {
      setAdvanceNotice("Team saved for future missions only");
      throw cause;
    } finally { await loadMissions(workspaceId); }
  });
  const saveLimits = () => void run("limits", async () => {
    await moduleCall("team_update", { workspaceId, change: { operation: "set_limits", expected_revision: limits.revision, max_workers: globalLimit,
      ...(selectedRun ? { run_id: selectedRun.id, run_revision: selectedRun.revision, worker_limit: missionLimit } : {}) } });
    await loadMissions(workspaceId);
  });
  useEffect(() => {
    if (view !== "board" || !workspaceId) return;
    let disposed = false;
    let reading = false;
    const pollSelection = async () => {
      if (reading) return;
      reading = true;
      let accepted = false;
      try {
        const status = await moduleCall("upstream_status");
        const selection = status.missionSelection as { id: string; workspaceId: string; runId: string; intent: string } | null;
        if (disposed || !selection || selection.workspaceId !== workspaceId
          || sessionStorage.getItem("coding-tools:ao:selection") === selection.id) return;
        // Consume the UI request before any start. Reloading must never replay it.
        sessionStorage.setItem("coding-tools:ao:selection", selection.id);
        accepted = true;
        setSelectedRunId(selection.runId); setView("team");
        if (["start", "resume"].includes(selection.intent)) {
          if (!executable.trim()) throw new Error("Set the native Codex executable in AO settings first");
          await moduleCall("upstream_hide");
          const result = await moduleCall(selection.intent === "resume" ? "control_run" : "start_run", { workspaceId, runId: selection.runId, executable: executable.trim(), ...(selection.intent === "resume" ? { action: "resume" } : {}) });
          if (!disposed) { setAutoStatus(String(result.status || "running")); await loadMissions(workspaceId); }
        }
      } catch (cause) { if (!disposed || accepted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void pollSelection(), 750);
    return () => { disposed = true; clearInterval(timer); };
  }, [view, workspaceId, executable, setError]);
  useEffect(() => {
    if (!workspaceId || !selectedRunId) { setAutoStatus("idle"); return; }
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const status = await moduleCall("run_status", { workspaceId, runId: selectedRunId });
        if (!live) return;
        const nextStatus = typeof status.status === "string" ? status.status : "idle";
        setAutoStatus(nextStatus);
        setAdvanceNotice(typeof status.detail === "string" ? status.detail : "");
        if (nextStatus !== "idle") {
          const current = await moduleCall("runs", { workspaceId, runId: selectedRunId });
          if (live && Array.isArray(current.runs)) {
            setMissions((previous) => previous.map((run) =>
              (current.runs as AoMission[]).find((fresh) => fresh.id === run.id) ?? run));
          }
        }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => { live = false; clearInterval(timer); };
  }, [workspaceId, selectedRunId, setError]);
  const activeNodeIds = JSON.stringify(selectedRun?.nodes.filter(node => ["reserved", "running"].includes(node.state)).map(node => node.id) ?? []);
  useEffect(() => {
    const ids = JSON.parse(activeNodeIds) as string[];
    if (!workspaceId || !selectedRunId || !ids.length) { setPendingApprovals([]); return; }
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const results = await Promise.all(ids.map(async nodeId => ({
          nodeId, result: await moduleCall(["running", "paused"].includes(autoStatus) ? "harness_status" : "observe", { workspaceId, runId: selectedRunId, nodeId }),
        })));
        if (!live) return;
        const approvals: AoApproval[] = [];
        let newest: AoMission | undefined;
        for (const { nodeId, result } of results) {
          const status = result.status as { pending_approvals?: unknown[] } | undefined;
          const pending = ["running", "paused"].includes(autoStatus) ? status?.pending_approvals : result.pending_approvals;
          for (const item of Array.isArray(pending) ? pending : []) {
            if (item && typeof item === "object" && typeof (item as AoApproval).approval_id === "string") approvals.push({ ...(item as AoApproval), nodeId });
          }
          const updated = result.run as AoMission | undefined;
          if (updated?.id === selectedRunId && updated.workspace_id === workspaceId && (!newest || updated.revision > newest.revision)) newest = updated;
        }
        setPendingApprovals(approvals);
        if (newest) { const updated = newest; setMissions(current => current.map(mission => mission.id === updated.id && mission.revision <= updated.revision ? updated : mission)); }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => { live = false; clearInterval(timer); };
  }, [workspaceId, selectedRunId, activeNodeIds, autoStatus, setError]);

  const taskName = (id: string) => board?.tasks.find((task) => task.id === id)?.title ?? id;
  const describeNode = (node: CanvasNode) => node.route.model === "chatgpt-web/high" ? "WebGPT High"
    : `${harnessLabel(node.route.harness_id || NATIVE_HARNESS, harnesses)} · ${node.route.model}`;
  const moveCard = async (positions: { id: string; x: number; y: number }[], parentId?: string) => {
    if (!selectedRun || busy) throw new Error("Wait for the current graph change");
    setBusy("position"); setError(null);
    try {
      const moved = await moduleCall("update_run", { workspaceId, change: { operation: "graph", run_id: selectedRun.id,
        expected_revision: selectedRun.revision, change: { operation: "move_nodes", positions: positions.map(({ id, x, y }) => ({ node_id: id, x, y })) } } });
      let updated = moved.run as AoMission;
      setMissions(current => current.map(mission => mission.id === updated.id ? updated : mission));
      if (parentId && positions.length === 1) {
        const change = aoDependencyChange(updated, positions[0].id, parentId);
        if (!change) throw new Error("The card changed before this dependency could be added");
        const connected = await moduleCall("update_run", { workspaceId, change: { operation: "graph", run_id: updated.id,
          expected_revision: updated.revision, change } });
        updated = connected.run as AoMission;
        setMissions(current => current.map(mission => mission.id === updated.id ? updated : mission));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadMissions(workspaceId).catch(() => {});
      throw cause;
    } finally { setBusy(""); }
  };
  const addDependency = (nodeId: string, parentId: string) => void run("dependency", async () => {
    if (!selectedRun) return;
    const change = aoDependencyChange(selectedRun, nodeId, parentId);
    if (!change) return;
    const result = await moduleCall("update_run", { workspaceId,
      change: { operation: "graph", run_id: selectedRun.id, expected_revision: selectedRun.revision, change } });
    if (!result.cancelled) await loadMissions(workspaceId);
  });

  const openSheet = (next: Sheet) => {
    if (next === sheet) { setSheet(""); return; }
    if (next === "mission") {
      setRunTaskId(""); setMissionLimit(team?.worker_limit || 3);
      const saved = team?.nodes.find(node => node.role === "worker")?.route;
      setWorkerRouteDraft(saved ? { ...saved } : workerRoute(NATIVE_HARNESS, DEFAULT_WORKER_MODEL));
    }
    if (next === "worker") {
      setRunTaskId(selectedRun?.project_id ?? ""); setWorkerParentId("");
      setWorkerName("Worker"); setWorkerSpecialty("implementation");
    }
    setSheet(next);
  };

  const createRun = () => void run("new-run", async () => {
    if (!board || !workspaceId || !workerRouteDraft.model || (!runTaskId && !missionPrompt.trim())) return;
    let missionBoard = board;
    let taskId = runTaskId;
    if (!taskId) {
      const previousIds = new Set(board.tasks.map((task) => task.id));
      missionBoard = await moduleCall("create", { workspaceId,
        title: missionTitle.trim() || missionPrompt.trim().slice(0, 80), description: missionPrompt.trim(),
        expectedRevision: board.revision }) as unknown as Board;
      setBoard(missionBoard);
      const added = missionBoard.tasks.filter((task) => !previousIds.has(task.id));
      if (added.length !== 1) throw new Error("Task creation needs review. Refresh and pick the saved task.");
      taskId = added[0].id;
      setRunTaskId(taskId);
    }
    const id = crypto.randomUUID();
    let chosenTeam = team;
    if (!chosenTeam) {
      const saved = await moduleCall("team_update", { workspaceId, change: { operation: "save_team", expected_revision: 0,
        team: defaultTeam(workspaceId, workerRouteDraft) as unknown as JsonObject } });
      chosenTeam = saved.team as AoTeam; setTeam(chosenTeam);
    }
    const result = await moduleCall("update_run", { workspaceId, change: { operation: "create_from_team", run_id: id, task_id: taskId,
      expected_board_revision: missionBoard.revision, team_revision: chosenTeam.revision, worker_limit: missionLimit } });
    if (result.cancelled) return;
    setSheet("");
    setMissionTitle(""); setMissionPrompt("");
    await loadMissions(workspaceId);
    setSelectedRunId(id);
    setView("team");
  });

  const addWorker = () => void run("add-worker", async () => {
    if (!selectedRun || !runTaskId || !workerRouteDraft.model) return;
    const planner = selectedRun.nodes.find((node) => node.role === "planner");
    if (!planner) return;
    const node = { id: crypto.randomUUID(), task_id: runTaskId, role: "worker", state: "pending",
      settings: { ...emptyRoleSettings(), name: workerName.trim() || "Worker", specialty: workerSpecialty },
      parents: workerParentId ? [planner.id, workerParentId] : [planner.id],
      x: selectedRun.nodes.length, y: 1, route: workerRouteDraft };
    const result = await moduleCall("update_run", { workspaceId, change: { operation: "graph", run_id: selectedRun.id,
      expected_revision: selectedRun.revision, change: { operation: "add_worker", node } } });
    if (result.cancelled) return;
    setSheet("");
    await loadMissions(workspaceId);
  });

  const needsExecutable = () => {
    if (executable.trim()) return false;
    setSheet("settings");
    setError("Set the native Codex executable in AO settings first");
    return true;
  };

  const startRun = () => void run("start-run", async () => {
    if (!selectedRun || needsExecutable()) return;
    const result = await moduleCall("start_run", { workspaceId, runId: selectedRun.id,
      executable: executable.trim() });
    if (result.cancelled) return;
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    setAdvanceNotice("Running; tool approvals still need you");
    await loadMissions(workspaceId);
  });

  const controlRun = (action: "pause" | "resume" | "stop") => void run(action, async () => {
    if (!selectedRun) return;
    await moduleCall("control_run", { workspaceId, runId: selectedRun.id, action, executable: executable.trim() });
    setAutoStatus(action === "pause" ? "paused" : action === "resume" ? "running" : "held");
    await loadMissions(workspaceId);
  });

  const approve = (approval: AoApproval, allow: boolean) => void run("approval", async () => {
    if (!selectedRun) return;
    const result = await moduleCall("approve_harness", { workspaceId, runId: selectedRun.id,
      nodeId: approval.nodeId, approvalId: approval.approval_id, allow });
    if (!result.cancelled) setPendingApprovals((current) => current.filter((item) => item.approval_id !== approval.approval_id));
  });

  const finished = !selectedRun || selectedRun.nodes.every(node => node.state === "finished");
  const canStart = Boolean(selectedRun) && !selectedRun!.cancelled && !finished && autoStatus !== "running" && !busy;
  const statusText = selectedRun?.cancelled ? "stopped" : autoStatus;
  const visibleNodes = selectedRun?.nodes.filter(node => showInactive || !["cancelled", "archived"].includes(node.state)) ?? [];
  const workers = selectedRun?.nodes.filter(node => node.role === "worker") ?? [];

  return (
    <section className="ao-workflow" aria-label={copy.title} lang={language}>
      <header className="ao-toolbar">
        <select className="ao-select" aria-label={copy.workspace} title={copy.workspace} value={workspaceId} disabled={Boolean(busy)}
          onChange={(event) => { setWorkspaceId(event.target.value); try { localStorage.setItem("coding-tools:ao:workspace", event.target.value); } catch { /* Selection still works for this session. */ } }}>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <span className="ao-toolbar-sep" aria-hidden="true">/</span>
        <select className="ao-select ao-select-mission" aria-label={copy.mission} title={copy.mission} value={selectedRunId} disabled={Boolean(busy) || !missions.length}
          onChange={(event) => setSelectedRunId(event.target.value)}>
          {!missions.length ? <option value="">{copy.noMissions}</option> : null}
          {missions.map((mission) => <option key={mission.id} value={mission.id}>{taskName(mission.project_id)}</option>)}
        </select>
        <ToolButton icon="plus" label={copy.newMission} disabled={!board || Boolean(busy)} pressed={sheet === "mission"} onClick={() => openSheet("mission")} />
        <div className="ao-segmented" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "team"} onClick={() => setView("team")}>{copy.canvas}</button>
          <button type="button" role="tab" aria-selected={view === "board"} onClick={() => { setSheet(""); setView("board"); }}>{copy.board}</button>
        </div>
        <span className="ao-toolbar-spacer" />
        {selectedRun ? <span className={`ao-pill status-${statusText}`} role="status" title={advanceNotice || statusText}>
          <span className="ao-pill-dot" aria-hidden="true" />{statusText}
          {advanceNotice && ["held", "paused"].includes(statusText) ? <span className="ao-pill-detail">{advanceNotice}</span> : null}
        </span> : null}
        {selectedRun?.paused
          ? <ToolButton icon="play" label={copy.resume} primary disabled={!canStart} onClick={() => controlRun("resume")} />
          : <ToolButton icon="play" label={copy.start} primary disabled={!canStart} onClick={startRun} />}
        <ToolButton icon="pause" label={copy.pause} disabled={!selectedRun || selectedRun.cancelled || selectedRun.paused || autoStatus !== "running" || Boolean(busy)} onClick={() => controlRun("pause")} />
        <ToolButton icon="stop" label={copy.stop} disabled={!selectedRun || selectedRun.cancelled || finished || Boolean(busy)} onClick={() => controlRun("stop")} />
        <span className="ao-toolbar-sep" aria-hidden="true" />
        <ToolButton icon="refresh" label={copy.refresh} disabled={!workspaceId || Boolean(busy)} onClick={() => void run("refresh", async () => { modelCache.current.clear(); await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]); })} />
        <ToolButton icon="gear" label={copy.settings} pressed={sheet === "settings"} onClick={() => openSheet("settings")} />
      </header>

      <div className="ao-stage">
        {sheet === "mission" ? <form className="ao-sheet" aria-label={copy.newMission} onSubmit={(event) => { event.preventDefault(); createRun(); }}>
          <h2>{copy.newMission}</h2>
          <label>Task<select aria-label="Mission task" value={runTaskId} onChange={(event) => setRunTaskId(event.target.value)}>
            <option value="">New task</option>{board?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select></label>
          {!runTaskId ? <>
            <label>Name<input aria-label="Mission name" placeholder="Optional" maxLength={240} value={missionTitle} onChange={(event) => setMissionTitle(event.target.value)} /></label>
            <label className="ao-wide">Brief<textarea aria-label="Mission task description" placeholder="What should this mission do?" maxLength={8192} value={missionPrompt} onChange={(event) => setMissionPrompt(event.target.value)} /></label>
          </> : null}
          {team ? <p className="ao-chip-line ao-wide" title="Edit roles by clicking cards on the canvas">
            {team.nodes.map(node => <span key={node.id} className="ao-chip">{node.settings?.name || node.role}{node.role === "worker" ? ` · ${harnessLabel(node.route.harness_id, harnesses)}` : ""}</span>)}
          </p> : <div className="ao-field-row ao-wide">
            <HarnessPicker route={workerRouteDraft} harnesses={harnesses} loadModels={loadModels} onChange={setWorkerRouteDraft} />
          </div>}
          <label>Max workers<input type="number" min={1} max={24} value={missionLimit} onChange={event => setMissionLimit(Number(event.target.value))} /></label>
          <div className="ao-sheet-actions ao-wide">
            <button className="button-primary" disabled={(!runTaskId && !missionPrompt.trim()) || !workerRouteDraft.model || Boolean(busy)} type="submit">{copy.create}</button>
            <button className="button-secondary" onClick={() => setSheet("")} type="button">{copy.cancel}</button>
          </div>
        </form> : null}

        {sheet === "worker" && selectedRun ? <form className="ao-sheet" aria-label="Add worker" onSubmit={(event) => { event.preventDefault(); addWorker(); }}>
          <h2>Add worker</h2>
          <div className="ao-field-row ao-wide">
            <label>Name<input maxLength={96} value={workerName} onChange={event => setWorkerName(event.target.value)} /></label>
            <label>Focus<select value={workerSpecialty} onChange={event => { setWorkerSpecialty(event.target.value); setWorkerName(event.target.value[0].toUpperCase() + event.target.value.slice(1)); }}>
              {SPECIALTIES.filter(value => value !== "review").map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
          </div>
          <div className="ao-field-row ao-wide">
            <HarnessPicker route={workerRouteDraft} harnesses={harnesses} loadModels={loadModels} onChange={setWorkerRouteDraft} />
          </div>
          <div className="ao-field-row ao-wide">
            <label>Task<select aria-label="Mission task" value={runTaskId} onChange={(event) => setRunTaskId(event.target.value)}>{board?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
            <label>After<select value={workerParentId} onChange={(event) => setWorkerParentId(event.target.value)}><option value="">Orchestrator</option>{workers.map((node) => <option key={node.id} value={node.id}>{node.settings?.name || taskName(node.task_id)}</option>)}</select></label>
          </div>
          <div className="ao-sheet-actions ao-wide">
            <button className="button-primary" disabled={!runTaskId || !workerRouteDraft.model || Boolean(busy)} type="submit">{copy.add}</button>
            <button className="button-secondary" onClick={() => setSheet("")} type="button">{copy.cancel}</button>
          </div>
        </form> : null}

        {sheet === "settings" ? <div className="ao-sheet ao-sheet-right" aria-label={copy.settings}>
          <h2>{copy.settings}</h2>
          <label className="ao-wide" title="Runs the WebGPT orchestrator/reviewer and Native Codex workers">Native Codex executable<input aria-label="Native Codex executable" autoComplete="off" placeholder="C:\…\codex.exe"
            spellCheck={false} value={executable} onChange={(event) => {
              const value = event.target.value;
              setExecutable(value);
              try { localStorage.setItem("coding-tools:ao:codex-executable", value); } catch { /* Keep it for this session. */ }
            }} /></label>
          <form className="ao-field-row ao-wide" onSubmit={event => { event.preventDefault(); saveLimits(); }}>
            <label>Workers (all)<input type="number" min={1} max={24} value={globalLimit} onChange={event => setGlobalLimit(Number(event.target.value))} /></label>
            <label>This mission<input type="number" min={1} max={24} value={missionLimit} onChange={event => setMissionLimit(Number(event.target.value))} /></label>
            <button className="button-secondary" type="submit" disabled={Boolean(busy) || !workspaceId || ![globalLimit, missionLimit].every(value => Number.isInteger(value) && value >= 1 && value <= 24)}>Save</button>
          </form>
          <label className="ao-check ao-wide"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Show cancelled cards</label>
          <p className="ao-hint ao-wide">{harnesses.filter(item => item.runnable).length} runnable harnesses{harnessNotice ? ` · ${harnessNotice}` : ""}</p>
          <details className="ao-more ao-wide"><summary>Add workspace</summary>
            <form className="ao-field-row" onSubmit={(event) => { event.preventDefault(); createWorkspace(); }}>
              <label>Directory<input aria-label="Workspace directory" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} /></label>
              <label>Name<input aria-label="Workspace name" maxLength={128} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
              <button className="button-primary" disabled={!workspacePath.trim() || Boolean(busy)} type="submit">{copy.add}</button>
            </form>
          </details>
          {selectedRun && board ? <details className="ao-more ao-wide"><summary>Next prompt</summary><pre>{aoPreviewText(selectedRun, board.tasks)}</pre></details> : null}
        </div> : null}

        {view === "board" && workspaceReady && workspaceId && !sheet ? <div className="ao-workspace-board">
          <AgentOrchestratorOriginalSurface projectBoard hostbar={false} workspaceId={workspaceId} openMissions={() => setView("team")} />
        </div> : null}

        <div hidden={view !== "team"} className="ao-team-view">
          {!workspaceId && workspaceReady ? <div className="ao-empty-state"><p>{copy.noWorkspace}</p><button className="button-primary" type="button" onClick={() => setSheet("settings")}>{copy.settings}</button></div>
            : !selectedRun ? <div className="ao-empty-state"><p>{copy.noMissions}</p><button className="button-primary" type="button" disabled={!board} onClick={() => openSheet("mission")}>{copy.newMission}</button></div>
            : <AgentOrchestratorCanvas key={selectedRun.id}
              nodes={visibleNodes}
              levels={aoLevels(selectedRun).map(level => level.filter(node => showInactive || !["cancelled", "archived"].includes(node.state)))}
              selectedId={inspectedId} busy={Boolean(busy)} onSelect={inspectRole} onMove={moveCard} describe={describeNode}
              onConnect={addDependency} canConnect={(nodeId, parentId) => Boolean(aoDependencyChange(selectedRun, nodeId, parentId))}>
              {pendingApprovals.length ? <aside className="ao-approvals ao-canvas-overlay" aria-label="AO tool approvals">
                {pendingApprovals.map((approval) => <div key={approval.approval_id}>
                  <p><strong>Approve?</strong> {approval.reason || "Tool request"} · {approval.path || approval.cwd || approval.nodeId}</p>
                  {approval.kind === "command" ? <pre aria-label="Requested command" title={`Once only · expires in ${approval.seconds_remaining ?? 0}s`}>{approval.command}</pre> : null}
                  {approval.permissions ? <details><summary>Permissions</summary><pre aria-label="Requested permissions">{JSON.stringify(approval.permissions, null, 2)}</pre></details> : null}
                  <button className="button-primary" disabled={Boolean(busy)} onClick={() => approve(approval, true)} type="button">Allow once</button>
                  <button className="button-secondary" disabled={Boolean(busy)} onClick={() => approve(approval, false)} type="button">Deny</button>
                </div>)}
              </aside> : null}
              <button type="button" className="ao-fab ao-canvas-overlay" title="Add worker"
                disabled={selectedRun.cancelled || selectedRun.nodes.length >= 24 || selectedRun.nodes.some((node) => node.role === "reviewer" && node.state !== "pending") || Boolean(busy)}
                onClick={() => { openSheet("worker"); setWorkerRouteDraft(workerRoute(NATIVE_HARNESS, DEFAULT_WORKER_MODEL)); }}><Glyph name="worker" /><span>{copy.addWorker}</span></button>
            </AgentOrchestratorCanvas>}
          {selectedRun && inspectedNode && draftTeam ? <AgentOrchestratorRoleEditor key={inspectedNode.id}
            node={inspectedNode} mission={selectedRun} draft={draftTeam} harnesses={harnesses} loadModels={loadModels} busy={Boolean(busy)}
            change={setDraftTeam} apply={applyTeam} discard={() => setDraftTeam(teamForMission(selectedRun, team))}
            close={() => setInspectedId("")} taskName={taskName} /> : null}
        </div>
      </div>
    </section>
  );
}

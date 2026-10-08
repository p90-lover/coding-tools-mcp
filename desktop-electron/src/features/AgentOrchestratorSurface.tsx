import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import type { Language } from "../types";
import { AgentOrchestratorOriginalSurface } from "./AgentOrchestratorOriginalSurface";
import { AgentOrchestratorCanvas, type CanvasNode } from "./AgentOrchestratorCanvas";
import { AgentOrchestratorChat } from "./AgentOrchestratorChat";
import { ChatThreadList, type ThreadWorkspace } from "./ChatThreadList";
import { AgentOrchestratorPermissions, mergeSavedPermissions, missionPermissionNodes, type PermissionCapability, type PermissionSelection, type RuntimePermissionPolicy } from "./AgentOrchestratorPermissions";
import { AgentOrchestratorApproval, type AoApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import { AgentOrchestratorTeam, prepareTeamGraph } from "./AgentOrchestratorTeam";
import { chatArchived, chatList, chatMarkdown, chatMessagesFromDescription, chatTurns, type ChatActivity, type ChatNode, type ChatRun, type TaskLifecycleView } from "./ao-chat";
import { createLatestConfigQueue } from "./ao-config";
import {
  AgentOrchestratorRoleEditor, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, HarnessPicker, NATIVE_HARNESS, SPECIALTIES, defaultTeam, emptyRoleSettings,
  cardMeta, harnessLabel, modelLabel, teamForMission, workerRoute, type AoHarness, type AoModelCatalog, type AoModelLoader, type AoRoute, type AoTeam, type RoleSettings,
} from "./AgentOrchestratorRoleEditor";
import "./agent-orchestrator.css";
import "./codex-chat.css";
import { pageHidden } from "./page-visibility";

type Clause = { id: string; title: string; detail?: string; state: string };
type PlanTask = {
  id: string; title: string; description?: string; state: string; step: number; updated_at?: number;
  lane: string; displayStatus: string; clauses: Clause[];
  clauseProgress: { done: number; total: number };
};
type Board = { revision: number; steps: string[]; tasks: PlanTask[]; task?: PlanTask };
export type AoReceipt = { status: string; answer?: string; error?: string; verdict?: string; thread_id?: string; turn_id?: string; request_key?: string; settings?: RoleSettings; route?: { model: string }; started_at_ms?: number };
export type AoNode = {
  id: string; task_id: string; role: "planner" | "approver" | "worker" | "review_split" | "sub_reviewer" | "reviewer" | "retry";
  parents: string[]; x: number; y: number; positioned?: boolean; state: string;
  clause_id?: string; request_key?: string; template_role_id?: string;
  settings?: RoleSettings;
  route: { harness_id: string; provider_id: string; account_id: string; model: string; permission_profile: string; native_permission_profile?: string; approval_policy?: string; approvals_reviewer?: string; effort?: string; context_window?: number };
  receipt?: AoReceipt;
  history?: AoReceipt[];
};
export type AoMission = { id: string; project_id: string; workspace_id: string; revision: number; cancelled: boolean; paused?: boolean; solo?: boolean; nodes: AoNode[]; team?: AoTeam; worker_limit?: number; execution_mode?: "single" | "team" };

type Sheet = "" | "mission" | "worker" | "settings" | "team" | "schedule";

const words = {
  en: { title: "Agent Orchestrator", workspace: "Workspace", mission: "Mission", newMission: "New mission", canvas: "Mission tab", overview: "Overview board", history: "Inactive cards shown for this mission",
    start: "Start", resume: "Resume", pause: "Pause", stop: "Stop", settings: "Settings", refresh: "Refresh", addWorker: "Worker",
    noMissions: "No missions yet", noWorkspace: "Add a workspace to begin", create: "Create", add: "Add", cancel: "Cancel" },
  "zh-CN": { title: "代理编排", workspace: "工作区", mission: "任务", newMission: "新任务", canvas: "任务页", overview: "总览看板", history: "正在显示此任务的历史节点",
    start: "开始", resume: "继续", pause: "暂停", stop: "停止", settings: "设置", refresh: "刷新", addWorker: "工作者",
    noMissions: "尚无任务", noWorkspace: "先添加工作区", create: "创建", add: "添加", cancel: "取消" },
  "zh-TW": { title: "代理編排", workspace: "工作區", mission: "任務", newMission: "新任務", canvas: "任務分頁", overview: "總覽看板", history: "正在顯示此任務的歷史節點",
    start: "開始", resume: "繼續", pause: "暫停", stop: "停止", settings: "設定", refresh: "重新整理", addWorker: "工作者",
    noMissions: "尚無任務", noWorkspace: "先新增工作區", create: "建立", add: "新增", cancel: "取消" },
  ja: { title: "エージェント編成", workspace: "ワークスペース", mission: "ミッション", newMission: "新規ミッション", canvas: "ミッション", overview: "概要ボード", history: "このミッションの履歴カードを表示",
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

const OVERVIEW_RATIO_KEY = "coding-tools:ao:overview-ratio:v1";
const OVERVIEW_DIVIDER = 8;

/** Keep both panes usable, scaling their minimums together only on very short screens. */
export function aoOverviewSplit(ratio: number, height: number) {
  const available = Math.max(0, height - OVERVIEW_DIVIDER);
  const preferred = Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 0.7;
  const min = available ? Math.min(160 / available, 160 / 280) : 0;
  const max = available <= 280 && available > 0 ? min : available ? 1 - 120 / available : 1;
  const bounded = Math.min(max, Math.max(min, preferred));
  return { ratio: bounded, min, max, graph: available * bounded };
}

/** A captured drag suspends the native board, which otherwise intercepts pointer events. */
export function OverviewSplit({ hidden, onResize, children }: {
  hidden: boolean; onResize: (resizing: boolean) => void; children: [ReactNode, ReactNode];
}) {
  const panel = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(OVERVIEW_RATIO_KEY));
      return Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : 0.7;
    } catch { return 0.7; }
  });
  const [height, setHeight] = useState(0);
  const split = aoOverviewSplit(ratio, height);
  useLayoutEffect(() => {
    if (hidden) dragCleanup.current?.();
    const measure = () => setHeight(panel.current?.getBoundingClientRect().height ?? 0);
    measure();
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
  }, [hidden]);
  useEffect(() => () => dragCleanup.current?.(), []);
  const remember = (next: number) => {
    setRatio(next);
    try { localStorage.setItem(OVERVIEW_RATIO_KEY, String(next)); } catch { /* Keep the ratio for this session. */ }
  };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragCleanup.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    onResize(true);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const area = panel.current?.getBoundingClientRect();
      if (area && area.height > OVERVIEW_DIVIDER) {
        const nextRatio = (next.clientY - area.top - OVERVIEW_DIVIDER / 2) / (area.height - OVERVIEW_DIVIDER);
        remember(aoOverviewSplit(Math.min(0.99, Math.max(0.01, nextRatio)), area.height).ratio);
      }
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      dragCleanup.current = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      onResize(false);
    };
    dragCleanup.current = end;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  };
  return <div hidden={hidden} className="ao-overview" ref={panel}
    style={{ gridTemplateRows: height > OVERVIEW_DIVIDER ? `${split.graph}px ${OVERVIEW_DIVIDER}px minmax(0, 1fr)` : undefined }}>
    {children[0]}
    <div className="ao-overview-divider" role="separator" tabIndex={0} aria-label="Resize Structure and Mission board"
      aria-orientation="horizontal" aria-valuemin={Math.round(split.min * 100)} aria-valuemax={Math.round(split.max * 100)}
      aria-valuenow={Math.round(split.ratio * 100)} title="Drag or use arrow keys to resize; double-click to reset"
      onPointerDown={drag} onDoubleClick={() => remember(0.7)}
      onKeyDown={event => {
        const next = event.key === "ArrowUp" ? split.ratio - 0.03 : event.key === "ArrowDown" ? split.ratio + 0.03
          : event.key === "Home" ? split.min : event.key === "End" ? split.max : event.key === "0" ? 0.7 : null;
        if (next === null) return;
        event.preventDefault();
        remember(aoOverviewSplit(next, height).ratio);
      }} />
    {children[1]}
  </div>;
}

type PopupAnchor = { left: number; right: number; top: number };

/** Keep floating controls inside their own stage, including the graph above the native board. */
export function clampPopupPosition(area: { width: number; height: number }, box: { width: number; height: number }, point: { x: number; y: number }) {
  return {
    x: Math.min(Math.max(8, point.x), Math.max(8, area.width - box.width - 8)),
    y: Math.min(Math.max(8, point.y), Math.max(8, area.height - box.height - 8)),
  };
}

/** Sheets open centrally; role settings open beside their selected card. Both drag by the header. */
function FloatingSheet({ stage, title, onClose, children, anchor, className = "", closeLabel = "Close" }: {
  stage: RefObject<HTMLDivElement | null>; title: string; onClose: () => void; children: ReactNode;
  anchor?: PopupAnchor; className?: string; closeLabel?: string;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const clamp = useCallback((x: number, y: number) => {
    const area = stage.current?.getBoundingClientRect();
    const box = sheet.current?.getBoundingClientRect();
    if (!area || !box) return { x, y };
    return clampPopupPosition(area, box, { x, y });
  }, [stage]);
  useLayoutEffect(() => {
    const area = stage.current?.getBoundingClientRect();
    const box = sheet.current?.getBoundingClientRect();
    if (area && box) setPosition(clamp(
      anchor ? anchor.right + box.width + 20 <= area.width ? anchor.right + 12 : anchor.left - box.width - 12 : (area.width - box.width) / 2,
      anchor ? anchor.top : (area.height - box.height) / 2,
    ));
  }, [anchor, clamp, stage]);
  useEffect(() => {
    const keep = () => setPosition(current => current && clamp(current.x, current.y));
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const observer = new ResizeObserver(keep);
    if (stage.current) observer.observe(stage.current);
    if (sheet.current) observer.observe(sheet.current);
    window.addEventListener("resize", keep);
    window.addEventListener("keydown", escape);
    return () => { observer.disconnect(); window.removeEventListener("resize", keep); window.removeEventListener("keydown", escape); };
  }, [clamp, onClose, stage]);
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !position || (event.target as HTMLElement).closest("button")) return;
    const handle = event.currentTarget;
    const start = { pointerX: event.clientX, pointerY: event.clientY, ...position };
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setPosition(clamp(start.x + next.clientX - start.pointerX, start.y + next.clientY - start.pointerY));
    const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return <div ref={sheet} className={`ao-float ${className}`} role="dialog" aria-label={title}
    style={position ? { left: position.x, top: position.y } : { visibility: "hidden" }}>
    <div className="ao-float-head" onPointerDown={drag} title="Drag to move">
      <h2>{title}</h2>
      <button type="button" className="ao-float-close" aria-label={closeLabel} onClick={onClose}>✕</button>
    </div>
    {children}
  </div>;
}

export async function moduleCall(operation: string, args: JsonObject = {}) {
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

/** Per-viewer chat list state (pins, unread, pinned projects), kept on this computer like Codex. */
function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 500) : [];
  } catch { return []; }
}
function writeList(key: string, value: string[]) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Kept for this session only. */ }
}
const PINNED_CHATS = "coding-tools:ao:pinned-chats";
const UNREAD_CHATS = "coding-tools:ao:unread-chats";
const PINNED_PROJECTS = "coding-tools:ao:pinned-projects";

export async function listAllWorkspaces(): Promise<WorkspaceSummary[]> {
  const items: WorkspaceSummary[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = await getCodingToolsClient().workspaces.list({ cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  return items;
}

/** A selected historical run stays inspectable even when every card is filtered as inactive. */
export function aoVisibleNodes(nodes: AoNode[], showInactive: boolean): AoNode[] {
  const visible = nodes.filter(node => showInactive || !["cancelled", "archived"].includes(node.state));
  return visible.length ? visible : nodes;
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
  // Links are free between every card except the orchestrator, which only starts the mission.
  // Linking a working card stops it and reruns it from its new links (the engine does that).
  if (!node || !parent || node.role === "planner" || nodeId === parentId || node.parents.includes(parentId)) return null;
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

/** Removes one link. A card left without links waits on the orchestrator (the engine adds it). */
export function aoUnlinkChange(run: Pick<AoMission, "nodes">, nodeId: string, parentId: string) {
  const node = run.nodes.find((item) => item.id === nodeId);
  if (!node || node.role === "planner" || !node.parents.includes(parentId)) return null;
  return { operation: "set_parents", node_id: nodeId, parents: node.parents.filter((id) => id !== parentId) };
}

/** Removes a card; a worker's task passes to another worker (linked first, idle before busy). */
export function aoRemoveChange(run: Pick<AoMission, "nodes">, nodeId: string) {
  const node = run.nodes.find((item) => item.id === nodeId);
  if (!node || node.role === "planner") return null;
  return { operation: "remove_node", node_id: nodeId };
}

export function aoNodeWorking(node: Pick<AoNode, "state"> | undefined) {
  return Boolean(node && ["running", "reserved"].includes(node.state));
}

export function aoPreviewText(run: Pick<AoMission, "cancelled" | "nodes">, tasks: Pick<PlanTask, "id" | "title" | "description">[]): string {
  if (run.cancelled) return "No ready card in this run.";
  const node = run.nodes.find((item) => item.state === "pending" && (item.role === "planner" ||
    item.parents.length > 0 && item.parents.every((id) => run.nodes.some((parent) => parent.id === id && parent.state === "finished"))));
  if (!node) return "No ready card in this run.";
  const task = tasks.find((item) => item.id === node.task_id);
  return `${node.role}: ${task?.title ?? node.task_id}\n${task?.description ?? ""}`.trim();
}

/** Catalog data is authoritative; legacy servers expose only one real saved team. */
export function aoSavedTeams(result: { teams?: unknown; team?: unknown }, workspaceId: string): AoTeam[] {
  const items = Array.isArray(result.teams) ? result.teams : result.team ? [result.team] : [];
  return items.filter((item): item is AoTeam => Boolean(item && typeof item === "object" &&
    typeof (item as AoTeam).id === "string" && (item as AoTeam).workspace_id === workspaceId &&
    Number.isSafeInteger((item as AoTeam).revision) && Array.isArray((item as AoTeam).nodes)));
}
export function aoChatExecution(mode: "single" | "team", route: AoRoute, teams: AoTeam[], teamId: string, workspaceId: string): JsonObject {
  if (mode === "single") {
    if (!route.model || route.model === "default") throw new Error("Choose one explicit model first.");
    return { executionMode: "single", singleRoute: { ...route } };
  }
  const selected = teams.find(team => team.id === teamId && team.workspace_id === workspaceId);
  if (!selected || !Number.isSafeInteger(selected.revision)) throw new Error("Selected saved team is unavailable; refresh and choose its current configuration.");
  return { executionMode: "team", teamId: selected.id, teamRevision: selected.revision };
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
  // One project tree switches between the conversation and the selected graph above its workspace board.
  const [view, setView] = useState<"chat" | "overview" | "board">("chat");
  // null until the workspace's runs load; "" means a new, unsent chat.
  const [chatTaskId, setChatTaskId] = useState<string | null>(null);
  // Why a chat's latest run could not start, by task id; cleared once it starts.
  const [chatNotices, setChatNotices] = useState<Record<string, string>>({});
  // Codex's thread list: pinned and unread chats and pinned projects stay on this computer.
  const [chatPins, setChatPins] = useState<string[]>(() => readList(PINNED_CHATS));
  const [chatUnread, setChatUnread] = useState<string[]>(() => readList(UNREAD_CHATS));
  const [projectPins, setProjectPins] = useState<string[]>(() => readList(PINNED_PROJECTS));
  const [listNow, setListNow] = useState(() => Date.now());
  const [sheet, setSheet] = useState<Sheet>("");
  const stageRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const [overviewResizing, setOverviewResizing] = useState(false);
  const [roleAnchor, setRoleAnchor] = useState<PopupAnchor>();
  const closeSheet = useCallback(() => setSheet(""), []);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [missions, setMissions] = useState<AoMission[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [inspectedId, setInspectedId] = useState("");
  const [team, setTeam] = useState<AoTeam | null>(null);
  const [savedTeams, setSavedTeams] = useState<AoTeam[]>([]);
  const [composerTeamId, setComposerTeamId] = useState("");
  const [composerMode, setComposerMode] = useState<"single" | "team">("single");
  const [singleRoute, setSingleRoute] = useState<AoRoute>(() => ({ ...workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL),
    native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" }));
  const hydratedComposer = useRef("");
  // The New mission sheet's team choice (#254); the composer keeps its own (composerTeamId).
  const [missionTeamId, setMissionTeamId] = useState("");
  const [draftTeam, setDraftTeam] = useState<AoTeam | null>(null);
  const [limits, setLimits] = useState({ revision: 0, max_workers: 3 });
  const [globalLimit, setGlobalLimit] = useState(3);
  const [missionLimit, setMissionLimit] = useState(3);
  const [harnesses, setHarnesses] = useState<AoHarness[]>([NATIVE_ENTRY]);
  const [harnessNotice, setHarnessNotice] = useState("");
  const [workerRouteDraft, setWorkerRouteDraft] = useState<AoRoute>(() => workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL));
  const [workerName, setWorkerName] = useState("Worker");
  const [workerSpecialty, setWorkerSpecialty] = useState("implementation");
  const [executable, setExecutable] = useState(() => {
    try { return localStorage.getItem("coding-tools:ao:codex-executable") ?? ""; }
    catch { return ""; }
  });
  // An empty setting is fine: the workflow then uses the installed Codex CLI (codex_executable).
  const [detectedExecutable, setDetectedExecutable] = useState("");
  const executableArg = (): JsonObject => (executable.trim() ? { executable: executable.trim() } : {});
  const [advanceNotice, setAdvanceNotice] = useState("");
  const [autoStatus, setAutoStatus] = useState("idle");
  const [pendingApprovals, setPendingApprovals] = useState<AoApproval[]>([]);
  const [runtimePolicies, setRuntimePolicies] = useState<Record<string, RuntimePermissionPolicy>>({});
  const [runTaskId, setRunTaskId] = useState("");
  const [workerParentId, setWorkerParentId] = useState("");
  const [busy, setBusy] = useState("");
  const [missionTitle, setMissionTitle] = useState("");
  const [missionPrompt, setMissionPrompt] = useState("");
  const [pendingChat, setPendingChat] = useState<{ title: string; message: string; taskId?: string } | null>(null);

  const selection = useRef({ workspaceId, taskId: chatTaskId ?? "", runId: selectedRunId });
  selection.current = { workspaceId, taskId: chatTaskId ?? "", runId: selectedRunId };
  const [taskLifecycle, setTaskLifecycle] = useState<TaskLifecycleView[]>([]);
  const [configStatus, setConfigStatus] = useState("");
  const [scheduleNow,setScheduleNow] = useState(Date.now);
  useEffect(()=>{ if(!taskLifecycle.some(item=>item.schedule?.state==="scheduled"))return; const timer=setInterval(()=>setScheduleNow(Date.now()),1000);return()=>clearInterval(timer); },[taskLifecycle]);
  const configuration = useRef<ReturnType<typeof createLatestConfigQueue> | null>(null);
  const draftScopes = useRef(new Map<string, { workspaceId: string; taskId: string; runId?: string }>());
  const configNavigation = useRef(false);
  const inspectedRole = useRef("");
  const ownTeamRevisions = useRef(new Map<string,number>());
  const queuedExecutables = useRef(new Map<string,string>());
  const latestDrafts = useRef(new Map<string,AoTeam>());
  const [scheduleTarget, setScheduleTarget] = useState<{workspaceId: string; taskId: string; runId: string} | null>(null);
  const [startDelay, setStartDelay] = useState(1);
  const [delayUnit, setDelayUnit] = useState("minutes");
  useEffect(() => {
    const queue = createLatestConfigQueue({
      apply: async (scope, draft) => {
        const saved = await moduleCall("runs",{workspaceId:scope.workspaceId});
        const known = saved.team as AoTeam | null;
        const revisionKey = JSON.stringify([scope.workspaceId,draft.id]);
        if (known?.id === draft.id && known.revision !== (draft as AoTeam).revision
            && ownTeamRevisions.current.get(revisionKey) !== known.revision) throw new Error("Team changed in another window; refresh before retrying");
        const rebased = {...draft, revision:known?.id===draft.id ? known.revision : (draft as AoTeam).revision};
        const executable = queuedExecutables.current.get(JSON.stringify(scope));
        const result = scope.runId
          ? await moduleCall("reconfigure_run",{...scope,team:rebased as unknown as JsonObject,...(executable ? {executable} : {})})
          : await moduleCall("team_update",{workspaceId:scope.workspaceId,change:{
              operation:"save_team",expected_revision:rebased.revision,team:rebased as unknown as JsonObject}});
        const changed = result.team as AoTeam | undefined;
        if (changed) ownTeamRevisions.current.set(revisionKey,changed.revision);
        const current = await moduleCall("runs", { workspaceId: scope.workspaceId });
        return { ...result, current };
      },
      onState: state => {
        const current = selection.current;
        if (current.workspaceId !== state.scope.workspaceId || current.taskId !== state.scope.taskId
            || state.scope.runId && current.runId !== state.scope.runId) return;
        if (state.phase === "applying") { setConfigStatus("Applying configuration; stopping owned work…"); return; }
        if (state.phase === "error") { setConfigStatus(state.error instanceof Error ? state.error.message : "Configuration needs attention"); return; }
        const result = state.result as { team?: AoTeam; runId?: string; status?: string; detail?: string;
          current: {runs: AoMission[]; task_lifecycle?: TaskLifecycleView[]} };
        setTaskLifecycle(result.current.task_lifecycle || []);
        setMissions(result.current.runs);
        if (result.team) { setTeam(result.team); setDraftTeam(structuredClone(result.team)); latestDrafts.current.set(JSON.stringify([state.scope.workspaceId,state.scope.taskId]),structuredClone(result.team)); }
        if (result.runId) {
          const replacement = result.current.runs.find(run => run.id === result.runId);
          const card = replacement?.nodes.find(node => (node.template_role_id || node.id) === inspectedRole.current);
          configNavigation.current = true;
          setSelectedRunId(result.runId);
          setInspectedId(card?.id || "");
        }
        setConfigStatus(result.status === "failed" ? result.detail || "Applied; start needs attention"
          : result.status === "scheduled" ? "Applied; original delayed start preserved" : ["missed","needs_attention","cancelled"].includes(result.status || "") ? "Applied; explicit schedule recovery required" : "Applied");
      },
    });
    configuration.current = queue;
    return () => { queue.dispose(); if (configuration.current === queue) configuration.current = null; };
  }, []);

  const modelCache = useRef(new Map<string, ReturnType<AoModelLoader>>());
  const loadModels = useCallback<AoModelLoader>((harness: string) => {
    const key = JSON.stringify([workspaceId, harness]);
    let pending = modelCache.current.get(key);
    if (!pending) {
      // Native Codex keeps its model array; AO also carries verified model capabilities.
      pending = moduleCall("models", { harness, workspaceId }).then(result => {
        const models = Array.isArray(result.models) ? result.models as string[] : [];
        return harness.startsWith("ao:") ? { models, capabilities: result.capabilities as AoModelCatalog["capabilities"] } : models;
      });
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
    // Show which codex.exe an empty setting resolves to (the Codex CLI first).
    void moduleCall("codex_executable").then(result => {
      if (live && typeof result.executable === "string") setDetectedExecutable(result.executable);
    }).catch(() => { /* No Codex found: the start reports it with install guidance. */ });
    return () => { live = false; };
  }, []);

  const loadMissions = async (id: string) => {
    const current = await moduleCall("runs", { workspaceId: id });
    const runs = Array.isArray(current.runs) ? current.runs as AoMission[] : [];
    if (selection.current.workspaceId !== id) return;
    setTaskLifecycle((current.task_lifecycle as TaskLifecycleView[]) || []);
    setMissions(runs);
    const setups = aoSavedTeams(current, id);
    setSavedTeams(setups); setComposerTeamId(selected => selected || setups[0]?.id || "");
    setTeam(current.team as AoTeam | null ?? setups[0] ?? null);
    if (current.limits) { setLimits(current.limits as typeof limits); setGlobalLimit((current.limits as typeof limits).max_workers); }
    setSelectedRunId((selected) => runs.some((run) => run.id === selected) ? selected : runs[0]?.id ?? "");
  };

  const loadBoard = async (id: string) => {
    const current = await moduleCall("board", { workspaceId: id }) as unknown as Board;
    if (selection.current.workspaceId === id) setBoard(current);
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
    setTeam(null); setSavedTeams([]); setComposerTeamId(""); setMissionTeamId(""); setDraftTeam(null); setInspectedId(""); setTaskLifecycle([]); setConfigStatus("");
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
          setTaskLifecycle((current.task_lifecycle as TaskLifecycleView[]) || []);
          setMissions(runs);
          const setups = aoSavedTeams(current, workspaceId);
          setSavedTeams(setups); setComposerTeamId(selected => selected || setups[0]?.id || "");
          setTeam(current.team as AoTeam | null ?? setups[0] ?? null);
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

  useEffect(() => { setChatTaskId(null); }, [workspaceId]);
  useEffect(() => {
    if (chatTaskId !== null || !board) return;
    const latest = chatList(missions, board.tasks, taskLifecycle)[0];
    setChatTaskId(latest?.taskId ?? "");
    if (latest) setSelectedRunId(latest.latestRunId);
  }, [chatTaskId, missions, board]);
  // Keep the shared project tree and newly created runs current in either view.
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const timer = setInterval(() => {
      if (pageHidden()) return;
      void moduleCall("runs", { workspaceId }).then((current) => {
        if (live && Array.isArray(current.runs)) {
          setMissions(current.runs as AoMission[]);
          setTeam(current.team as AoTeam | null ?? null);
          setSavedTeams(aoSavedTeams(current, workspaceId));
          setTaskLifecycle((current.task_lifecycle as TaskLifecycleView[]) || []);
        }
      }).catch(() => {});
    }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [workspaceId]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId !== workspaceId) return;
      void loadMissions(workspaceId).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    window.addEventListener("coding-tools:ao:teams-changed", changed);
    return () => window.removeEventListener("coding-tools:ao:teams-changed", changed);
  }, [workspaceId, setError]);
  const selectChat = (taskId: string, next: "chat" | "overview" = "chat") => {
    if (pendingChat?.taskId !== taskId) setPendingChat(null);
    setSheet(""); setInspectedId(""); setDraftTeam(null); setConfigStatus(""); setView(next);
    setChatTaskId(taskId);
    if (chatUnread.includes(taskId)) markUnread(taskId, false);
    const latest = chatList(missions, board?.tasks ?? [], taskLifecycle).find((entry) => entry.taskId === taskId);
    if (latest) setSelectedRunId(latest.latestRunId);
  };
  const loadDescription = useCallback(async (taskId: string) => {
    const detail = await moduleCall("board", { workspaceId, taskId }) as unknown as Board;
    return detail.task?.description ?? "";
  }, [workspaceId]);

  const selectedRun = missions.find((mission) => mission.id === selectedRunId);
  const savedMissionTeam = savedTeams.find(item => item.id === selectedRun?.team?.id) ?? team;
  const missionTeam = missionTeamId ? savedTeams.find(item => item.id === missionTeamId) ?? null : team;
  const inspectedNode = selectedRun?.nodes.find(node => node.id === inspectedId);
  useEffect(() => { if (configNavigation.current) configNavigation.current = false; else { setInspectedId(""); setDraftTeam(null); } setMissionLimit(selectedRun?.worker_limit || 3); }, [selectedRunId]);
  const inspectRole = (id: string) => {
    const area = graphRef.current?.getBoundingClientRect();
    const card = graphRef.current?.querySelector<HTMLElement>(`[data-ao-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    setRoleAnchor(area && card ? { left: card.left - area.left, right: card.right - area.left, top: card.top - area.top } : undefined);
    inspectedRole.current = selectedRun?.nodes.find(node => node.id === id)?.template_role_id || id;
    setInspectedId(id);
    if (selectedRun && !draftTeam) setDraftTeam(teamForMission(selectedRun, savedMissionTeam));
  };
  const persistTeam = async (draft: AoTeam, mission?: AoMission, expectedRevision?: number, permissionScope?: { selected_role_ids: string[]; permission_selection: JsonObject }) => {
    const { permission_selections: _missionPermissionSelections, ...reusableTeam } = draft;
    const saved = await moduleCall("team_update", { workspaceId, change: { operation: "save_team", expected_revision: draft.revision, team: reusableTeam as unknown as JsonObject } });
    if (saved.cancelled || !saved.team) throw new Error("Permission save cancelled; no application confirmed.");
    const next = saved.team as AoTeam; setTeam(next); setSavedTeams(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [...current, next]); setDraftTeam(structuredClone(next));
    if (!mission) return "Team saved for future missions. Running attempts are unchanged.";
    try {
      const applied = await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: mission.id, expected_revision: expectedRevision ?? mission.revision, team_id: next.id, team_revision: next.revision, ...permissionScope } });
      if (applied.cancelled) throw new Error("Application cancelled");
      return "Policy saved for queued / future attempts. Running attempts are unchanged; each future native turn still requires exact runtime acknowledgement.";
    } catch (cause) {
      throw new Error("Team saved for future missions only; this chat was not updated: " + (cause instanceof Error ? cause.message : String(cause)));
    } finally { await loadMissions(workspaceId); }
  };
  const applyTeam = () => void run("team", async () => {
    if (!draftTeam || !selectedRun) return;
    setAdvanceNotice(await persistTeam(draftTeam, selectedRun));
  });
  const editTeam = (next: AoTeam, immediate = false) => {
    setDraftTeam(next);
    latestDrafts.current.set(JSON.stringify([workspaceId,chatTaskId || ""]),structuredClone(next));
    const invalid = next.nodes.find(node => !node.route.model || node.route.model === "default");
    const rounds = next.max_review_rounds ?? 3;
    if (invalid || !Number.isInteger(next.worker_limit) || next.worker_limit < 1 || next.worker_limit > 24
        || !Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
      const pending=draftScopes.current.get(JSON.stringify([workspaceId,selectedRun?.project_id || ""]));
      if (pending) configuration.current?.cancel(pending);
      setConfigStatus(invalid ? `Choose an explicit model for ${invalid.settings?.name || invalid.role}` : "Choose valid worker and review limits");
      return;
    }
    const mission = chatTaskId ? selectedRun : undefined;
    const scope = { workspaceId, taskId: mission?.project_id || "", ...(mission ? {runId:mission.id} : {}) };
    draftScopes.current.set(JSON.stringify([workspaceId,scope.taskId]),scope);
    queuedExecutables.current.set(JSON.stringify(scope),executable.trim());
    setConfigStatus(immediate ? "Applying…" : "Applying after typing…");
    configuration.current?.enqueue(scope,next,{immediate});
  };
  const missionAction = (taskId: string, action: "schedule" | "cancel_schedule" | "archive" | "delete" | "restore") => {
    const entry = chatList(missions, board?.tasks ?? [], taskLifecycle, true).find(entry => entry.taskId === taskId);
    if (!entry) return;
    const scope = {workspaceId,taskId,runId:entry.latestRunId};
    if (action === "schedule") { setScheduleTarget(scope); setSheet("schedule"); return; }
    const pending = draftScopes.current.get(JSON.stringify([workspaceId,taskId]));
    if (pending) configuration.current?.cancel(pending);
    void run("mission_action", async () => {
      const operation = action === "cancel_schedule" ? action : `${action}_task`;
      await moduleCall(operation,{workspaceId:scope.workspaceId,taskId:scope.taskId});
      if (selection.current.workspaceId !== scope.workspaceId) return;
      await Promise.all([loadBoard(scope.workspaceId),loadMissions(scope.workspaceId)]);
      if (selection.current.taskId === taskId && ["archive","delete"].includes(action)) {
        setChatTaskId("");setDraftTeam(null);setInspectedId("");
      }
    });
  };
  const submitSchedule = () => void run("schedule",async()=>{
    const target=scheduleTarget;
    if (!target) return;
    const key=JSON.stringify([target.workspaceId,target.taskId]);
    const pending=draftScopes.current.get(key);
    if(pending) configuration.current?.cancel(pending);
    const newest=latestDrafts.current.get(key);
    const restoreEdit = () => { if(pending && newest) configuration.current?.enqueue(pending,newest,{immediate:true}); };
    let result:Record<string,unknown>;
    try {
      result=await moduleCall("schedule_start",{...target,delay:startDelay,unit:delayUnit,
        ...(newest ? {team:newest as unknown as JsonObject} : {})});
    } catch(error) { restoreEdit();throw error; }
    if(result.cancelled) { restoreEdit();return; }
    if(selection.current.workspaceId !== target.workspaceId) return;
    await loadMissions(target.workspaceId);
    if (selection.current.taskId === target.taskId) setSelectedRunId(String(result.runId));
    setSheet("");
  });
  const chatMission = [...missions].reverse().find(mission => mission.project_id === chatTaskId);
  const selectedSetup = savedTeams.find(setup => setup.id === composerTeamId && setup.workspace_id === workspaceId);
  // Reading a saved chat restores its own raw policy, once. Polling never resets explicit draft choices.
  useEffect(() => {
    if (chatTaskId === null || (chatTaskId && !chatMission)) return;
    const key = workspaceId + ":" + chatTaskId;
    if (hydratedComposer.current === key) return;
    hydratedComposer.current = key;
    if (!chatMission) {
      setComposerMode("single");
      setSingleRoute({ ...workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL), native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" });
    } else if (chatMission.execution_mode === "single") {
      setComposerMode("single");
      const node = chatMission.nodes[0];
      if (node) {
        const id = node.template_role_id || node.id;
        const intent = chatMission.team?.permission_selections?.[id];
        const route = { ...node.route };
        if (intent?.permission_profile !== undefined) {
          route.native_permission_profile = intent.permission_profile;
          if (route.harness_id === NATIVE_HARNESS) route.permission_profile = intent.permission_profile;
        }
        if (intent?.approval_policy !== undefined) route.approval_policy = intent.approval_policy;
        if (intent?.approvals_reviewer !== undefined) route.approvals_reviewer = intent.approvals_reviewer;
        setSingleRoute(route);
      }
    } else {
      setComposerMode("team");
      setComposerTeamId(chatMission.team?.id || "");
    }
  }, [workspaceId, chatTaskId, chatMission]);
  const permissionMission = composerMode === "single" ? chatMission?.execution_mode === "single" ? chatMission : undefined
    : chatMission?.execution_mode !== "single" && chatMission?.team?.id === selectedSetup?.id ? chatMission : undefined;
  const singleAttempt = permissionMission?.execution_mode === "single" ? permissionMission.nodes[0] : undefined;
  const singleRoleId = singleAttempt?.template_role_id || singleAttempt?.id || "single-draft";
  const permissionTeam: AoTeam | null = composerMode === "single" ? {
    id: "single-composer", workspace_id: workspaceId, name: "Single model", revision: permissionMission?.revision ?? 0, worker_limit: 1,
    nodes: [{ id: singleRoleId, task_id: chatTaskId || "", role: "planner", parents: [], x: 0, y: 0, state: "pending", route: singleRoute, settings: { ...emptyRoleSettings(), name: "Single assistant" } }],
  } : permissionMission ? { ...teamForMission(permissionMission, selectedSetup ?? null), nodes: missionPermissionNodes(permissionMission) } : selectedSetup ?? null;
  const loadPermissionProfiles = useCallback(async (roleId: string): Promise<PermissionCapability> => {
    const role = permissionTeam?.nodes.find(node => node.id === roleId);
    if (!role) return { supported: false, profiles: [], reason: "Choose a model or saved team first." };
    const node = [...(permissionMission?.nodes ?? [])].reverse().find(item => (item.template_role_id || item.id) === roleId);
    if (role.route.harness_id === NATIVE_HARNESS && !node) return { supported: false, profiles: [], reason: "Native permissions require an actual connected role; menu opening does not connect it." };
    const result = await moduleCall("permission_profiles", { workspaceId, route: role.route as unknown as JsonObject,
      ...(node && permissionMission ? { runId: permissionMission.id, nodeId: node.id } : {}) });
    return result.capability as PermissionCapability ?? { supported: false, profiles: [], reason: "Runtime permission metadata unavailable" };
  }, [workspaceId, permissionMission?.id, JSON.stringify(permissionTeam?.nodes.map(node => [node.id, node.route]))]);
  const savePermissions = async (snapshot: AoTeam, revision: number | undefined, selectedRoleIds: string[], selection: PermissionSelection) => {
    const permissionSelection: JsonObject = {
      ...(selection.profile !== undefined ? { permission_profile: selection.profile } : {}),
      ...(selection.policy !== undefined ? { approval_policy: selection.policy } : {}),
      ...(selection.reviewer !== undefined ? { approvals_reviewer: selection.reviewer } : {}),
    };
    const scope = { selected_role_ids: selectedRoleIds, permission_selection: permissionSelection };
    if (composerMode === "single") {
      const chosen = snapshot.nodes.find(node => node.id === singleRoleId);
      if (!chosen || selectedRoleIds.length !== 1 || selectedRoleIds[0] !== singleRoleId) throw new Error("Single permission target changed; reopen the menu.");
      if (permissionMission) {
        const applied = await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: permissionMission.id,
          expected_revision: revision ?? permissionMission.revision, ...scope } });
        if (applied.cancelled) throw new Error("Permission application cancelled; existing policy is unchanged.");
        await loadMissions(workspaceId);
      }
      setSingleRoute({ ...chosen.route });
      return "Selected for the next Single attempt. Running attempts and shared app grants are unchanged; runtime acknowledgement is still required.";
    }
    if (!selectedSetup) throw new Error("Selected saved team unavailable; refresh before applying.");
    const latest = await moduleCall("runs", { workspaceId });
    const saved = aoSavedTeams(latest, workspaceId).find(setup => setup.id === selectedSetup.id);
    if (!saved || saved.revision !== selectedSetup.revision) throw new Error("Saved team revision changed; refresh and select permissions again.");
    const reusableIds = selectedRoleIds.filter(id => saved.nodes.some(node => node.id === id));
    if (reusableIds.length) return persistTeam(mergeSavedPermissions(saved, reusableIds, selection), permissionMission, revision, scope);
    if (!permissionMission) throw new Error("Selected roles no longer exist in this saved team.");
    const applied = await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: permissionMission.id,
      expected_revision: revision ?? permissionMission.revision, team_id: saved.id, team_revision: saved.revision, ...scope } });
    if (applied.cancelled) throw new Error("Permission application cancelled; no change confirmed.");
    await loadMissions(workspaceId);
    return "Policy saved for queued / future attempts in this mission only. Running attempts and the reusable team are unchanged; runtime acknowledgement is still required.";
  };
  const saveLimits = () => void run("limits", async () => {
    await moduleCall("team_update", { workspaceId, change: { operation: "set_limits", expected_revision: limits.revision, max_workers: globalLimit,
      ...(selectedRun ? { run_id: selectedRun.id, run_revision: selectedRun.revision, worker_limit: missionLimit } : {}) } });
    await loadMissions(workspaceId);
  });
  useEffect(() => {
    if (view !== "overview" || !workspaceId) return;
    let disposed = false;
    let reading = false;
    const pollSelection = async () => {
      if (reading || pageHidden()) return;
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
        const current = await moduleCall("runs", { workspaceId });
        if (disposed) return;
        const currentRuns = Array.isArray(current.runs) ? current.runs as AoMission[] : [];
        setMissions(currentRuns);
        setSelectedRunId(selection.runId);
        const selected = currentRuns.find(mission => mission.id === selection.runId);
        if (selected) setChatTaskId(selected.project_id);
        if (selection.intent === "chat") setView("chat");
        if (selection.intent === "schedule" && selected) {
          setScheduleTarget({workspaceId,taskId:selected.project_id,runId:selected.id});setSheet("schedule");
        }
        if (selection.intent === "restart") {
          // A fresh run of the same task; the board's old run stays in history.
          const result = await moduleCall("restart_run", { workspaceId, runId: selection.runId, ...executableArg() });
          if (typeof result.runId === "string") setSelectedRunId(result.runId);
          if (result.status === "failed" && typeof result.detail === "string") setError(result.detail);
          if (!disposed) { setAutoStatus(String(result.status || "running")); await loadMissions(workspaceId); }
        } else if (["start", "resume"].includes(selection.intent)) {
          const result = await moduleCall(selection.intent === "resume" ? "control_run" : "start_run", { workspaceId, runId: selection.runId, ...executableArg(), ...(selection.intent === "resume" ? { action: "resume" } : {}) });
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
      if (reading || pageHidden()) return;
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
      if (reading || pageHidden()) return;
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
        setRuntimePolicies(Object.fromEntries(results.flatMap(({ nodeId, result }) => {
          const status = (result.status ?? result) as Record<string, unknown>;
          return typeof status.policy_acknowledged === "boolean" ? [[selectedRunId + ":" + nodeId, status as unknown as RuntimePermissionPolicy]] : [];
        })));
        if (newest) { const updated = newest; setMissions(current => current.map(mission => mission.id === updated.id && mission.revision <= updated.revision ? updated : mission)); }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => { live = false; clearInterval(timer); };
  }, [workspaceId, selectedRunId, activeNodeIds, autoStatus, setError]);

  const taskName = (id: string) => board?.tasks.find((task) => task.id === id)?.title ?? id;
  const describeNode = (node: CanvasNode) => node.route.model.startsWith("chatgpt-web/") ? modelLabel(node.route.model)
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
  // Changing a working card stops its turn and reruns it (or, when removed, hands its task on).
  const stopsWork = (nodeId: string, what: string) => {
    const node = selectedRun?.nodes.find((item) => item.id === nodeId);
    return !aoNodeWorking(node) || window.confirm(`${node?.settings?.name || node?.role || "This card"} is working. ${what}`);
  };
  const applyGraphChange = (change: JsonObject) => void run("dependency", async () => {
    if (!selectedRun) return;
    const result = await moduleCall("update_run", { workspaceId,
      change: { operation: "graph", run_id: selectedRun.id, expected_revision: selectedRun.revision, change } });
    if (!result.cancelled) await loadMissions(workspaceId);
  });
  const unlink = (nodeId: string, parentId: string) => {
    if (!selectedRun) return;
    const change = aoUnlinkChange(selectedRun, nodeId, parentId);
    if (change && stopsWork(nodeId, "Removing this link stops it and runs it again from its remaining links.")) applyGraphChange(change);
  };
  const removeCard = (nodeId: string) => {
    if (!selectedRun) return;
    const change = aoRemoveChange(selectedRun, nodeId);
    if (!change || !window.confirm("Remove this card? A worker's task passes to another worker: a linked one first, an idle one before a busy one (which runs it after its current turn).")) return;
    if (stopsWork(nodeId, "Removing it stops its current turn.")) applyGraphChange(change);
  };
  const addDependency = (nodeId: string, parentId: string) => void run("dependency", async () => {
    if (!selectedRun) return;
    const change = aoDependencyChange(selectedRun, nodeId, parentId);
    if (!change || !stopsWork(nodeId, "Linking it stops its current turn and runs it again from the new links.")) return;
    const result = await moduleCall("update_run", { workspaceId,
      change: { operation: "graph", run_id: selectedRun.id, expected_revision: selectedRun.revision, change } });
    if (!result.cancelled) await loadMissions(workspaceId);
  });

  const openSheet = (next: Sheet) => {
    if (next === sheet) { setSheet(""); return; }
    if (next === "mission") {
      setRunTaskId(""); setMissionLimit(team?.worker_limit || 3); setMissionTeamId(team?.id ?? "");
      const saved = team?.nodes.find(node => node.role === "worker")?.route;
      setWorkerRouteDraft(saved ? { ...saved } : workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL));
    }
    if (next === "worker") {
      setRunTaskId(selectedRun?.project_id ?? ""); setWorkerParentId("");
      setWorkerName("Worker"); setWorkerSpecialty("implementation");
    }
    setSheet(next);
  };

  const createRun = () => void run("new-run", async () => {
    if (!board || !workspaceId || (!runTaskId && !missionPrompt.trim())) return;
    const execution = aoChatExecution(composerMode, workerRouteDraft, savedTeams, composerTeamId, workspaceId);
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
    const result = await moduleCall("update_run", { workspaceId, change: { operation: "create_from_team", run_id: id, task_id: taskId,
      expected_board_revision: missionBoard.revision,
      ...(composerMode === "single" ? { execution_mode: "single", single_route: execution.singleRoute, worker_limit: 1 }
        : { execution_mode: "team", team_id: execution.teamId, team_revision: execution.teamRevision, worker_limit: missionLimit }) } });
    if (result.cancelled) return;
    setSheet("");
    setMissionTitle(""); setMissionPrompt("");
    await loadMissions(workspaceId);
    setSelectedRunId(id);
    setView("overview");
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

  const startRun = () => void run("start-run", async () => {
    if (!selectedRun) return;
    const result = await moduleCall("start_run", { workspaceId, runId: selectedRun.id, ...executableArg() });
    if (result.cancelled) return;
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    setAdvanceNotice("Running; tool approvals still need you");
    await loadMissions(workspaceId);
  });

  // Restart = a fresh run of the same task with the current team; the old run stays in history.
  const restartRun = () => void run("restart-run", async () => {
    if (!selectedRun) return;
    const result = await moduleCall("restart_run", { workspaceId, runId: selectedRun.id, ...executableArg() });
    if (result.cancelled) return;
    if (typeof result.runId === "string") setSelectedRunId(result.runId);
    if (result.status === "failed" && typeof result.detail === "string") setError(result.detail);
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    await loadMissions(workspaceId);
  });

  const controlRun = (action: "pause" | "resume" | "stop") => void run(action, async () => {
    if (!selectedRun) return;
    await moduleCall("control_run", { workspaceId, runId: selectedRun.id, action, ...executableArg() });
    setAutoStatus(action === "pause" ? "paused" : action === "resume" ? "running" : "held");
    await loadMissions(workspaceId);
  });

  const sendChat = (input: { taskId?: string; title?: string; message: string }) => new Promise<void>((resolve, reject) => {
    // run() skips its action while another one is in flight; never leave the chat waiting on it.
    if (busy) { reject(new Error("Another action is still running")); return; }
    void run("chat", async () => {
      try {
        if (!workspaceId) throw new Error("Add a workspace first");
        const execution = aoChatExecution(composerMode, singleRoute, savedTeams, composerTeamId, workspaceId);
        const result = await moduleCall("chat_send", { workspaceId, message: input.message,
          ...(input.taskId ? { taskId: input.taskId } : input.title ? { title: input.title } : {}),
          ...execution, ...executableArg() });
        if (result.cancelled) throw new Error("Message start cancelled; no new attempt confirmed.");
        await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]);
        const taskId = String(result.taskId);
        if (result.run) {
          const created = result.run as AoMission;
          setMissions(previous => [...previous.filter(mission => mission.id !== created.id), created]);
        }
        if (!input.taskId) {
          setPendingChat({ title: input.title || "New task", message: input.message, taskId });
          setBoard(current => current ? { ...current, tasks: [...current.tasks.filter(task => task.id !== taskId), {
            id: taskId, title: input.title || "New task", description: input.message, state: "pending", step: 0,
            lane: "", displayStatus: "Starting", clauses: [], clauseProgress: { done: 0, total: 0 },
          }] } : current);
        }
        setChatTaskId(taskId);
        setSelectedRunId(String(result.runId));
        setChatNotices((current) => ({ ...current, [taskId]: result.status === "failed" ? String(result.detail || "The run could not start") : "" }));
        setAutoStatus(result.status === "failed" ? "idle" : typeof result.status === "string" ? result.status : "running");
        resolve();
        void Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
      } catch (cause) { if (!input.taskId) setPendingChat(null); reject(cause); throw cause; }
    });
  });
  const retryChatStart = (runId: string) => void run("start-run", async () => {
    const taskId = missions.find((mission) => mission.id === runId)?.project_id ?? "";
    try {
      const mission = missions.find(item => item.id === runId);
      if (mission?.nodes.some(node => ["held", "failed"].includes(node.state))) {
        await moduleCall("control_run", { workspaceId, runId, action: "retry", ...executableArg() });
      }
      const result = await moduleCall("start_run", { workspaceId, runId, ...executableArg() });
      setChatNotices((current) => ({ ...current, [taskId]: "" }));
      setAutoStatus(typeof result.status === "string" ? result.status : "running");
    } catch (cause) {
      setChatNotices((current) => ({ ...current, [taskId]: cause instanceof Error ? cause.message : String(cause) }));
    }
    await loadMissions(workspaceId);
  });
  // Team opens this chat's own mission graph (never another task's shared template); its role
  // inspector edits that mission's captured draft live. No writes happen on open.
  const openTeam = () => {
    setSheet(""); setInspectedId(""); setDraftTeam(null);
    setSelectedRunId(chatMission?.id || "");
    setView("overview");
  };
  const saveTeam = (draft: AoTeam) => void run("team", async () => {
    const saved = await moduleCall("team_update", { workspaceId, change: { operation: "save_team", expected_revision: team?.revision ?? 0,
      team: draft as unknown as JsonObject } });
    const next = saved.team as AoTeam; setTeam(next);
    setSavedTeams(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [...current, next]);
    setSheet("");
  });
  // ---- Codex thread actions (thread list, chat header, slash commands) ----
  const allTasks = board?.tasks ?? [];
  const togglePin = (taskId: string) => setChatPins((current) => {
    const next = current.includes(taskId) ? current.filter((id) => id !== taskId) : [taskId, ...current];
    writeList(PINNED_CHATS, next);
    return next;
  });
  function markUnread(taskId: string, unread: boolean) {
    setChatUnread((current) => {
      const next = unread ? [...new Set([taskId, ...current])] : current.filter((id) => id !== taskId);
      writeList(UNREAD_CHATS, next);
      return next;
    });
  }
  const toggleProjectPin = (id: string) => setProjectPins((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
    writeList(PINNED_PROJECTS, next);
    return next;
  });
  const startNewChat = () => { setPendingChat(null); setChatTaskId(""); setDraftTeam(null); setInspectedId(""); setView("chat"); setSheet(""); setMissionTeamId(team?.id ?? ""); };
  const renameChat = (taskId: string, title: string) => new Promise<void>((resolve, reject) => {
    if (busy) { reject(new Error("Another action is still running")); return; }
    void run("rename", async () => {
      try {
        await moduleCall("task_rename", { workspaceId, taskId, title });
        await loadBoard(workspaceId);
        resolve();
      } catch (cause) { reject(cause); throw cause; }
    });
  });
  // "Archive chats" on a project: each chat goes through the lifecycle's own archive (which asks
  // before stopping a chat's running work), one after another.
  const archiveAllChats = () => void run("archive-all", async () => {
    const chats = chatList(missions, allTasks, taskLifecycle);
    for (const entry of chats) await moduleCall("archive_task", { workspaceId, taskId: entry.taskId });
    setChatTaskId("");
    await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]);
  });
  // Fork: a new chat starting from this chat's messages (all, the first, or up to one of them).
  const forkChat = (taskId: string, upTo?: number | "first") => void (async () => {
    const messages = chatMessagesFromDescription(await loadDescription(taskId));
    const kept = upTo === undefined ? messages : messages.slice(0, upTo === "first" ? 1 : upTo + 1);
    if (!kept.length) return;
    await sendChat({ title: `Fork of ${taskName(taskId)}`.slice(0, 240), message: kept.map((message) => message.text).join("\n\n").slice(0, 8192) });
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  const copyChat = (taskId: string, what: "title" | "conversation" | "answer" | "id") => void (async () => {
    let text = what === "title" ? taskName(taskId) : what === "id" ? taskId : "";
    if (what === "conversation" || what === "answer") {
      const turns = chatTurns(missions.filter((mission) => mission.project_id === taskId) as unknown as ChatRun[], await loadDescription(taskId), { describe: describeChatNode });
      text = what === "conversation" ? chatMarkdown(taskName(taskId), turns)
        : [...turns].reverse().map((turn) => turn.final?.text ?? [...turn.steps].reverse().find((step) => step.text)?.text).find(Boolean) ?? "";
    }
    if (text) await navigator.clipboard.writeText(text);
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  const openFolder = (item: ThreadWorkspace) => {
    if (item.path) void window.codexWebLauncher?.openFolder?.(item.path).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const restartChatRun = (runId: string) => void run("restart-run", async () => {
    const result = await moduleCall("restart_run", { workspaceId, runId, ...executableArg() });
    if (result.cancelled) return;
    if (typeof result.runId === "string") setSelectedRunId(result.runId);
    if (result.status === "failed" && typeof result.detail === "string") setError(result.detail);
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    await loadMissions(workspaceId);
  });

  const stopChatRun = (runId: string) => void run("stop", async () => {
    await moduleCall("control_run", { workspaceId, runId, action: "stop" });
    await loadMissions(workspaceId);
  });

  const approve = (approval: AoApproval, reply: ApprovalReply) => void run("approval", async () => {
    if (!selectedRun) return;
    const result = await moduleCall("approve_harness", { workspaceId, runId: selectedRun.id,
      nodeId: approval.nodeId, approvalId: approval.approval_id,
      ...(typeof reply === "boolean" ? { allow: reply } : { response: reply as JsonObject, threadId: approval.thread_id!, turnId: approval.turn_id! }) });
    if (!result.cancelled) setPendingApprovals((current) => current.filter((item) => item.approval_id !== approval.approval_id));
  });

  const finished = !selectedRun || selectedRun.nodes.every(node => node.state === "finished" || (node.role === "retry" && node.state === "pending"));
  const canStart = Boolean(selectedRun) && !selectedRun!.cancelled && !finished && !["starting", "running"].includes(autoStatus) && !busy;
  const statusText = selectedRun?.cancelled ? "stopped" : autoStatus;
  const visibleNodes = aoVisibleNodes(selectedRun?.nodes ?? [], showInactive);
  const showingHistory = !showInactive && visibleNodes.length > 0 && visibleNodes.every(node => ["cancelled", "archived"].includes(node.state));
  const workers = selectedRun?.nodes.filter(node => node.role === "worker") ?? [];
  const chooseWorkspace = (id: string) => {
    setWorkspaceId(id);
    setChatTaskId(null);
    try { localStorage.setItem("coding-tools:ao:workspace", id); } catch { /* Selection still works for this session. */ }
  };
  // A chat that finishes or needs you while another is open is marked unread, as in Codex.
  const lastChatStatus = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const entry of chatList(missions, allTasks, taskLifecycle)) {
      const before = lastChatStatus.current[entry.taskId];
      if (before && before !== entry.status && ["done", "attention", "stopped"].includes(entry.status) && entry.taskId !== chatTaskId) markUnread(entry.taskId, true);
      lastChatStatus.current[entry.taskId] = entry.status;
    }
  }, [missions]);
  useEffect(() => {
    const timer = window.setInterval(() => setListNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Every message names how its card runs; working cards also show runtime and current step.
  const describeChatNode = useCallback((node: ChatNode) => node.route ? cardMeta(node as unknown as AoNode, harnesses) : "", [harnesses]);
  const [chatActivity, setChatActivity] = useState<Record<string, ChatActivity>>({});
  const workingRunIds = (view === "overview" && inspectedId && selectedRun ? [selectedRun] : missions.filter(mission => mission.project_id === chatTaskId))
    .filter(mission => mission.nodes.some(node => ["running", "reserved"].includes(node.state))).map(mission => mission.id).join(",");
  useEffect(() => {
    if (!workspaceId || !workingRunIds) return;
    let live = true;
    let reading = false;
    const poll = async () => {
      if (reading || pageHidden()) return;
      reading = true;
      try {
        const frames = await Promise.all(workingRunIds.split(",").map(async runId => {
          try {
            const result = await moduleCall("activity", { workspaceId, runId }) as { nodes?: Record<string, ChatActivity> };
            return Object.entries(result.nodes ?? {}).map(([nodeId, value]) => [`${runId}:${nodeId}`, value] as const);
          } catch { return []; }
        }));
        if (live) setChatActivity(Object.fromEntries(frames.flat()));
      } finally { reading = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, [workspaceId, workingRunIds]);

  return (
    <section className="ao-workflow" aria-label={copy.title} lang={language}>
      <ChatThreadList workspaces={workspaces.map((item) => ({ id: item.id, name: item.name, path: item.path }))} workspaceId={workspaceId} onWorkspace={chooseWorkspace}
        chats={chatList(missions, allTasks, taskLifecycle)} archived={chatArchived(missions, allTasks, taskLifecycle)} selectedTaskId={chatTaskId ?? ""} now={listNow}
        pinned={chatPins} togglePin={togglePin} unread={chatUnread} setUnread={markUnread}
        pinnedProjects={projectPins} toggleProjectPin={toggleProjectPin} busy={Boolean(busy)}
        busyTaskId={busy ? chatTaskId ?? "" : undefined} pendingTitle={pendingChat && !pendingChat.taskId ? pendingChat.title : undefined}
        actions={{ select: (taskId) => selectChat(taskId, "chat"), newChat: startNewChat, rename: renameChat,
          lifecycle: missionAction, archiveAll: archiveAllChats,
          fork: (taskId, from) => forkChat(taskId, from === "first" ? "first" : undefined), copy: copyChat,
          openStructure: (taskId) => selectChat(taskId, "overview"), openBoard: () => { setSheet(""); setView("board"); }, openFolder }} />
      <div className="ao-main">
      <div className="ao-dragstrip" aria-hidden="true" />
      {view !== "chat" ? <header className="ao-workspace-head">
        <div className="ao-workspace-title">
          <strong>{workspaces.find(workspace => workspace.id === workspaceId)?.name || copy.title}</strong>
          <label className="ao-hint"><input type="checkbox" checked={showInactive} onChange={event=>setShowInactive(event.target.checked)} /> Show archived and deleted</label>
          <span>{view === "board" ? "Mission Board" : view === "overview" ? copy.overview : copy.canvas}{selectedRun && (view === "overview" || chatTaskId) ? ` · ${taskName(selectedRun.project_id)}` : ""}</span>
        </div>
        <span className="ao-head-spacer" />
        {selectedRun && (view === "overview" || chatTaskId) ? <span className={`ao-pill status-${statusText}`} role="status" title={advanceNotice || statusText}>
          <span className="ao-pill-dot" aria-hidden="true" />{statusText}
          {advanceNotice && ["held", "paused"].includes(statusText) ? <span className="ao-pill-detail">{advanceNotice}</span> : null}
        </span> : null}
        {selectedRun && (view === "overview" || chatTaskId) ? <div className="ao-head-tools" aria-label="Mission controls">
          {selectedRun?.paused
            ? <ToolButton icon="play" label={copy.resume} primary disabled={!canStart} onClick={() => controlRun("resume")} />
            : <ToolButton icon="play" label={copy.start} primary disabled={!canStart} onClick={startRun} />}
          <ToolButton icon="pause" label={copy.pause} disabled={!selectedRun || selectedRun.cancelled || selectedRun.paused || autoStatus !== "running" || Boolean(busy)} onClick={() => controlRun("pause")} />
          <ToolButton icon="stop" label={copy.stop} disabled={!selectedRun || selectedRun.cancelled || finished || Boolean(busy)} onClick={() => controlRun("stop")} />
          <ToolButton icon="refresh" label="Restart mission" disabled={!selectedRun || autoStatus === "running" || Boolean(busy)} onClick={restartRun} />
        </div> : null}
        <div className="ao-head-tools" aria-label="Project controls">
          <ToolButton icon="plus" label={copy.newMission} disabled={!board || Boolean(busy)} pressed={sheet === "mission"}
            onClick={() => openSheet("mission")} />
          <button type="button" className="button-secondary" disabled={Boolean(busy) || !workspaceId} onClick={openTeam}>Team</button>
          <ToolButton icon="refresh" label={copy.refresh} disabled={!workspaceId || Boolean(busy)} onClick={() => void run("refresh", async () => { modelCache.current.clear(); await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]); })} />
          <ToolButton icon="gear" label={copy.settings} pressed={sheet === "settings"} onClick={() => openSheet("settings")} />
        </div>
      </header> : null}

      <div className="ao-stage" ref={stageRef}>
        {sheet === "schedule" && scheduleTarget ? <FloatingSheet stage={stageRef} title="One-time delayed start" onClose={closeSheet}>
          <form className="ao-sheet" onSubmit={event=>{event.preventDefault();submitSchedule();}}>
            <label>Start after<input type="number" min={1} step={1} value={startDelay} onChange={event=>setStartDelay(Number(event.target.value))} /></label>
            <label>Unit<select value={delayUnit} onChange={event=>setDelayUnit(event.target.value)}>
              <option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option>
            </select></label>
            <p className="ao-hint ao-wide">Runs once. Keep the app running. Missed or uncertain starts require a new explicit schedule.</p>
            <button type="submit" className="button-primary" disabled={Boolean(busy) || !Number.isSafeInteger(startDelay) || startDelay<1}>Schedule start</button>
          </form>
        </FloatingSheet> : null}
        {sheet === "mission" ? <FloatingSheet stage={stageRef} title={`🚀 ${copy.newMission}`} onClose={closeSheet}>
          <form className="ao-sheet" aria-label={copy.newMission} onSubmit={(event) => { event.preventDefault(); createRun(); }}>
          <label>Task<select aria-label="Mission task" value={runTaskId} onChange={(event) => setRunTaskId(event.target.value)}>
            <option value="">New task</option>{board?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select></label>
          {!runTaskId ? <>
            <label>Name<input aria-label="Mission name" placeholder="Optional" maxLength={240} value={missionTitle} onChange={(event) => setMissionTitle(event.target.value)} /></label>
            <label className="ao-wide">Brief<textarea aria-label="Mission task description" placeholder="What should this mission do?" maxLength={8192} value={missionPrompt} onChange={(event) => setMissionPrompt(event.target.value)} /></label>
          </> : null}
          {savedTeams.length ? <label>Team<select aria-label="Mission team" value={missionTeamId || team?.id || ""} disabled={Boolean(busy)} onChange={event => {
            setMissionTeamId(event.target.value); setMissionLimit(savedTeams.find(item => item.id === event.target.value)?.worker_limit || 3);
          }}>{savedTeams.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === team?.id ? " · Default" : ""}</option>)}</select></label> : null}
          {missionTeam ? <p className="ao-chip-line ao-wide" title="Edit roles in Runtime → Orchestrator Team">
            {missionTeam.nodes.map(node => <span key={node.id} className="ao-chip">{node.settings?.name || node.role}{node.role === "worker" ? ` · ${harnessLabel(node.route.harness_id, harnesses)}` : ""}</span>)}
          </p> : <div className="ao-field-row ao-wide">
            <HarnessPicker route={workerRouteDraft} harnesses={harnesses} loadModels={loadModels} onChange={setWorkerRouteDraft} />
          </div>}
          <label>Max workers<input type="number" min={1} max={24} value={missionLimit} onChange={event => setMissionLimit(Number(event.target.value))} /></label>
          <div className="ao-sheet-actions ao-wide">
            <button className="button-primary" disabled={(!runTaskId && !missionPrompt.trim()) || !workerRouteDraft.model || Boolean(busy)} type="submit">{copy.create}</button>
            <button className="button-secondary" onClick={closeSheet} type="button">{copy.cancel}</button>
          </div>
        </form></FloatingSheet> : null}

        {sheet === "worker" && selectedRun ? <FloatingSheet stage={stageRef} title="👷 Add worker" onClose={closeSheet}>
          <form className="ao-sheet" aria-label="Add worker" onSubmit={(event) => { event.preventDefault(); addWorker(); }}>
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
            <button className="button-secondary" onClick={closeSheet} type="button">{copy.cancel}</button>
          </div>
        </form></FloatingSheet> : null}

        {sheet === "team" && team ? <FloatingSheet stage={stageRef} title="👥 Team" onClose={closeSheet}>
          <AgentOrchestratorTeam team={draftTeam || team} harnesses={harnesses} loadModels={loadModels} status={configStatus} busy={Boolean(busy)} change={editTeam} close={closeSheet} />
        </FloatingSheet> : null}

        {sheet === "settings" ? <FloatingSheet stage={stageRef} title={`⚙️ ${copy.settings}`} onClose={closeSheet}>
          <div className="ao-settings">
            <label className="ao-set-row" title="Native Codex executable: runs the WebGPT orchestrator/reviewer and Native Codex workers">
              <span className="ao-set-icon" aria-hidden="true">🧠</span>
              <input aria-label="Native Codex executable" autoComplete="off" placeholder={detectedExecutable ? `Auto: ${detectedExecutable}` : "Auto-detect the Codex CLI"} spellCheck={false} value={executable} onChange={(event) => {
                const value = event.target.value;
                setExecutable(value);
                try { localStorage.setItem("coding-tools:ao:codex-executable", value); } catch { /* Keep it for this session. */ }
              }} />
            </label>
            <form className="ao-set-row" onSubmit={event => { event.preventDefault(); saveLimits(); }}>
              <span className="ao-set-icon" aria-hidden="true">👷</span>
              <label className="ao-set-num" title="Workers across all missions"><span aria-hidden="true">🌐</span>
                <input aria-label="Workers across all missions" type="number" min={1} max={24} value={globalLimit} onChange={event => setGlobalLimit(Number(event.target.value))} /></label>
              <label className="ao-set-num" title="Workers for this mission"><span aria-hidden="true">🎯</span>
                <input aria-label="Workers for this mission" type="number" min={1} max={24} value={missionLimit} onChange={event => setMissionLimit(Number(event.target.value))} /></label>
              <button className="ao-set-save" type="submit" aria-label="Save worker limits" title="Save worker limits"
                disabled={Boolean(busy) || !workspaceId || ![globalLimit, missionLimit].every(value => Number.isInteger(value) && value >= 1 && value <= 24)}>💾</button>
            </form>
            <label className="ao-set-row ao-set-toggle" title="Show cancelled and archived cards alongside active cards. Historical missions always remain inspectable.">
              <span className="ao-set-icon" aria-hidden="true">👁️</span>
              <span>Cancelled cards</span>
              <input type="checkbox" role="switch" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
            </label>
            <p className="ao-set-row ao-set-note" title={harnessNotice || undefined}>
              <span className="ao-set-icon" aria-hidden="true">🧩</span>
              <span>{harnesses.filter(item => item.runnable).length} harnesses ready{harnessNotice ? " ⚠️" : ""}</span>
            </p>
            <details className="ao-set-more"><summary><span aria-hidden="true">📂</span> Add workspace</summary>
              <form className="ao-field-row" onSubmit={(event) => { event.preventDefault(); createWorkspace(); }}>
                <label>Directory<input aria-label="Workspace directory" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} /></label>
                <label>Name<input aria-label="Workspace name" maxLength={128} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
                <button className="button-primary" disabled={!workspacePath.trim() || Boolean(busy)} type="submit">{copy.add}</button>
              </form>
            </details>
            {selectedRun && board ? <details className="ao-set-more"><summary><span aria-hidden="true">🔮</span> Next prompt</summary><pre>{aoPreviewText(selectedRun, board.tasks)}</pre></details> : null}
          </div>
        </FloatingSheet> : null}

        {view === "chat" && chatTaskId === "" && savedTeams.length ? <div className="ao-new-chat-team">
          <label>Team<select aria-label="New chat team" disabled={Boolean(busy)} value={missionTeamId || team?.id || ""}
            onChange={event => setMissionTeamId(event.target.value)}>
            {savedTeams.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === team?.id ? " · Default" : ""}</option>)}
          </select></label><span className="ao-hint">Uses these role blocks for this chat</span>
        </div> : null}
        {view === "chat" ? (
          !workspaceId && workspaceReady
            ? <div className="ao-empty-state"><p>{copy.noWorkspace}</p><button className="button-primary" type="button" onClick={() => setSheet("settings")}>{copy.settings}</button></div>
            : <AgentOrchestratorChat
                runs={missions.map(mission => ({...mission, replaces_run_id: taskLifecycle.flatMap(item=>item.reconfigure || []).find(intent=>intent.replacement_run_id===mission.id)?.previous_run_id}))}
                tasks={allTasks} selectedTaskId={chatTaskId ?? ""}
                projectName={workspaces.find((item) => item.id === workspaceId)?.name}
                stop={stopChatRun} restart={restartChatRun}
                thread={chatTaskId ? { newChat: startNewChat, rename: (title) => renameChat(chatTaskId, title), archive: () => missionAction(chatTaskId, "archive"),
                  fork: (turnIndex) => forkChat(chatTaskId, turnIndex), copyConversation: () => copyChat(chatTaskId, "conversation"),
                  togglePin: () => togglePin(chatTaskId), pinned: chatPins.includes(chatTaskId) } : undefined}
                onPause={() => controlRun("pause")} onResume={() => controlRun("resume")} onSettings={() => openSheet("settings")}
                filePath={(file) => window.codexWebLauncher?.filePath?.(file) ?? ""}
                structure={selectedRun && chatTaskId && selectedRun.project_id === chatTaskId ? <AgentOrchestratorCanvas key={`chat-${selectedRun.id}`}
                  nodes={visibleNodes} levels={aoLevels(selectedRun).map(level => level.filter(node => visibleNodes.includes(node)))}
                  selectedId="" busy={Boolean(busy)} describe={describeNode}
                  /* Selecting or dragging a card in the side panel stays in the chat;
                     the header has its own Mission Board button. */
                  onSelect={() => {}} onMove={moveCard}
                  onConnect={addDependency} canConnect={(nodeId, parentId) => Boolean(aoDependencyChange(selectedRun, nodeId, parentId))}
                  onUnlink={unlink} canUnlink={(nodeId, parentId) => Boolean(aoUnlinkChange(selectedRun, nodeId, parentId))}
                  onRemove={removeCard} canRemove={(nodeId) => Boolean(aoRemoveChange(selectedRun, nodeId))} /> : undefined}
                busy={Boolean(busy)} loadDescription={loadDescription} send={sendChat}
                pendingMessage={pendingChat && (!pendingChat.taskId || pendingChat.taskId === chatTaskId) ? pendingChat.message : undefined}
                pendingTitle={pendingChat?.title} pendingCreation={Boolean(pendingChat && !pendingChat.taskId)}
                working={Boolean(selectedRun && chatTaskId && selectedRun.project_id === chatTaskId && ["starting", "running"].includes(autoStatus))}
                openStructure={(runId) => { setSelectedRunId(runId); setView("overview"); }}
                approvals={selectedRun && chatTaskId && selectedRun.project_id === chatTaskId ? pendingApprovals : []}
                composer={{ mode: composerMode, onModeChange: setComposerMode, route: singleRoute, onRouteChange: setSingleRoute,
                  harnesses, loadModels, teams: savedTeams, teamId: composerTeamId, onTeamChange: setComposerTeamId }}
                onOpenTeam={openTeam}
                onOpenMissionBoard={() => { setSheet(""); setView("board"); }}
                permissions={<AgentOrchestratorPermissions key={composerMode + ":" + (permissionTeam?.id || "none")} team={permissionTeam} mission={permissionMission} busy={Boolean(busy)}
                  loadProfiles={loadPermissionProfiles} save={savePermissions} runtimePolicies={runtimePolicies} />}
                approve={approve}
                notice={chatTaskId ? chatNotices[chatTaskId] || (selectedRun?.project_id === chatTaskId && ["held", "failed"].includes(autoStatus) ? advanceNotice || undefined : undefined) : undefined}
                retryStart={retryChatStart}
                describeNode={describeChatNode} activity={chatActivity}
                describeRoute={(nodeId, runId) => { const node = missions.find((mission) => mission.id === runId)?.nodes.find((entry) => entry.id === nodeId); return node ? describeNode(node as unknown as CanvasNode) : ""; }} />
        ) : null}

        {view === "board" ? <section className="ao-board-view" aria-label="Mission Board">
          <header><strong>Mission Board</strong><button type="button" className="button-secondary" onClick={() => setView("chat")}>Back to chat</button>
            <button type="button" className="button-secondary" onClick={() => setView("overview")}>Team graph</button></header>
          {workspaceReady && workspaceId && !sheet
            ? <AgentOrchestratorOriginalSurface projectBoard hostbar={false} workspaceId={workspaceId} openMissions={() => setView("overview")} />
            : <div className="ao-empty-state">{copy.noWorkspace}</div>}
        </section> : null}
        <OverviewSplit hidden={view !== "overview"} onResize={setOverviewResizing}>
          <div className="ao-overview-graph" ref={graphRef}>
          {!workspaceId && workspaceReady ? <div className="ao-empty-state"><p>{copy.noWorkspace}</p><button className="button-primary" type="button" onClick={() => setSheet("settings")}>{copy.settings}</button></div>
            : !selectedRun ? <div className="ao-empty-state"><p>{copy.noMissions}</p><button className="button-primary" type="button" disabled={!board} onClick={() => openSheet("mission")}>{copy.newMission}</button></div>
            : <AgentOrchestratorCanvas key={selectedRun.id}
              nodes={visibleNodes}
              levels={aoLevels(selectedRun).map(level => level.filter(node => visibleNodes.includes(node)))}
              selectedId={inspectedId} busy={Boolean(busy)} onSelect={inspectRole} onMove={moveCard} describe={describeNode}
              onConnect={addDependency} canConnect={(nodeId, parentId) => Boolean(aoDependencyChange(selectedRun, nodeId, parentId))}
              onUnlink={unlink} canUnlink={(nodeId, parentId) => Boolean(aoUnlinkChange(selectedRun, nodeId, parentId))}
              onRemove={removeCard} canRemove={(nodeId) => Boolean(aoRemoveChange(selectedRun, nodeId))}>
              {pendingApprovals.length ? <aside className="ao-approvals ao-canvas-overlay" aria-label="AO tool approvals">
                {pendingApprovals.map(approval => <AgentOrchestratorApproval key={approval.approval_id} approval={approval} busy={Boolean(busy)} approve={approve} />)}
              </aside> : null}
              <button type="button" className="ao-fab ao-canvas-overlay" title="Add worker"
                disabled={selectedRun.cancelled || selectedRun.nodes.length >= 24 || selectedRun.nodes.some((node) => node.role === "reviewer" && node.state !== "pending") || Boolean(busy)}
                onClick={() => { openSheet("worker"); setWorkerRouteDraft(workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL)); }}><Glyph name="worker" /><span>{copy.addWorker}</span></button>
            </AgentOrchestratorCanvas>}
          {showingHistory ? <span className="ao-history-hint" role="status">{copy.history}</span> : null}
          {view === "overview" && !sheet && selectedRun && inspectedNode && draftTeam ? <FloatingSheet key={inspectedNode.id} stage={graphRef}
            title={`${inspectedNode.settings?.name || inspectedNode.role} · ${inspectedNode.state}`} anchor={roleAnchor}
            className="ao-role-popup" closeLabel="Close role inspector" onClose={() => setInspectedId("")}>
            <AgentOrchestratorRoleEditor node={inspectedNode} mission={selectedRun} draft={draftTeam} harnesses={harnesses} loadModels={loadModels} busy={Boolean(busy)}
              status={configStatus} change={editTeam} activity={chatActivity} discard={() => editTeam(teamForMission(selectedRun, savedMissionTeam), true)} taskName={taskName} />
          </FloatingSheet> : null}
          </div>
          {/* Collapse native bounds during a drag without unmounting and reopening the board. */}
          <div className="ao-workspace-board" style={{ display: overviewResizing ? "none" : undefined }}>
            {view === "overview" && workspaceReady && workspaceId && !sheet
              ? <AgentOrchestratorOriginalSurface projectBoard hostbar={false} workspaceId={workspaceId} openMissions={() => setView("overview")} />
              : sheet ? <div className="ao-empty-state">Mission board resumes when this dialog closes.</div> : null}
          </div>
        </OverviewSplit>
      </div>
      </div>
    </section>
  );
}

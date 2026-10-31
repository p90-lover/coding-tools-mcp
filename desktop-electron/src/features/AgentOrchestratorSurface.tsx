import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import type { Language } from "../types";
import { AgentOrchestratorOriginalSurface } from "./AgentOrchestratorOriginalSurface";
import { AgentOrchestratorCanvas, type CanvasNode } from "./AgentOrchestratorCanvas";
import { AgentOrchestratorChat, syncChatQueues, type ChatQueueActions } from "./AgentOrchestratorChat";
import { ChatThreadList, type ArchivedChat, type ThreadWorkspace } from "./ChatThreadList";
import { ChatSplit } from "./ChatSplit";
import {
  SPLIT_ROW, SPLIT_STORE, belowPlace, defaultPlace, focusOrder, movePane, normalizeSplit, paneOrder, readSplit, relocatePane, spatialNeighbour, splitColumns,
  type PanePos, type SplitDropTarget, type SplitPane, type SplitSaved,
} from "./chat-split";
import { ProjectEditDialog, type WorkspaceMode, type WorkspaceModeState } from "./ProjectEditDialog";
import { AgentOrchestratorPermissions, draftPermissionCapability, mergeSavedPermissions, missionPermissionNodes, type PermissionCapability, type PermissionSelection, type RuntimePermissionPolicy } from "./AgentOrchestratorPermissions";
import { AgentOrchestratorApproval, type AoApproval, type ApprovalReply } from "./AgentOrchestratorApproval";
import { AgentOrchestratorTeam, prepareTeamGraph } from "./AgentOrchestratorTeam";
import { GOAL_SUMMARY, goalRounds, approvalAnsweredForYou, chatArchived, chatList, chatLiveRun, keepRevisions, mergeActivityFrames, chatMarkdown, chatMessageReadable, chatMessagesFromDescription, chatRunStopping, chatTurns, dependencyInstallNote, goalElapsed, restartResume, type DependencyLinks, type ChatActivity, type ChatCommands, type ChatLiveItem, type ChatGoal, type ChatLoop, type ChatWakeup, type ChatNode, type ChatRun, type QueuedChatMessage, type TaskLifecycleView } from "./ao-chat";
import { chatWindowBody, chatWindowPage } from "./chat-window";
import { ChatSettingsPage } from "./ChatSettingsPage";
import { createLatestConfigQueue } from "./ao-config";
import {
  AGENT_DEFAULT_MODEL, AgentOrchestratorRoleEditor, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, HarnessPicker, NATIVE_HARNESS, SPECIALTIES, defaultTeam, emptyRoleSettings, starterSettings,
  cardMeta, harnessLabel, modelLabel, modelShortLabel, teamForMission, workerRoute, type AoHarness, type AoModelCatalog, type AoModelLoader, type AoRoute, type AoTeam, type RoleSettings,
} from "./AgentOrchestratorRoleEditor";
import "./agent-orchestrator.css";
import "./codex-chat.css";
import "./claude-theme.css";
import { onAoPush, pageHidden, useSurfaceHidden } from "./page-visibility";

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
  en: { title: "Agent Orchestrator", workspace: "Workspace", mission: "Mission", newMission: "New mission", canvas: "Mission tab", overview: "Overview board", history: "Showing this mission's inactive cards",
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

// How long a request the "Approve for me" reviewer has not answered stays hidden: longer than the
// backend's whole review (REVIEW_DEADLINE_MS, about 3.5 min: three tries, their waits and the
// decide pass), which then stops marking it awaiting_review and hands it to the person itself. At
// one minute a slow review (a PowerShell check allowed after 114 s, retries while Codex's review
// account was signed out) put a box in front of the person that the reviewer then answered anyway;
// the user's call (2026-10-30): a request the reviewer may still accept is never theirs. This is
// only the backstop for a request nothing screens at all.
const REVIEW_GRACE_MS = 240_000;
/**
 * A chat message refused only for the moment: the chat started working again under it (its
 * automatic retry), or the app window was not in front. The chat keeps it at the front of its queue
 * and sends it as soon as it can, so it is no "Something went wrong".
 */
const QUIET_SEND_REFUSAL = /still running|focused app window/i;
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
    <div className="ao-overview-divider" role="separator" tabIndex={0} aria-label="Resize structure and mission board"
      aria-orientation="horizontal" aria-valuemin={Math.round(split.min * 100)} aria-valuemax={Math.round(split.max * 100)}
      aria-valuenow={Math.round(split.ratio * 100)} title="Drag to resize, double-click to reset"
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

/**
 * A new chat's single-model route: the default worker in the project, set to "Approve for me", so
 * routine commands run and anything else is judged by the command reviewer (codex-auto-review when
 * CPA can reach it), with only unclear requests coming to the person.
 */
function newChatRoute(): AoRoute {
  return lastChatRoute() ?? { ...workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL),
    native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
}
/**
 * A new chat starts on the route the last chat was sent with, as Codex and Claude Code keep the
 * last model. A new chat pre-warms its route as soon as it opens, so with the default model there
 * the agent being readied was one nobody used, and the chosen model's started only once picked.
 */
const LAST_CHAT_ROUTE = "coding-tools:ao:last-chat-route";
const CHAT_ROUTE_FIELDS = ["harness_id", "provider_id", "account_id", "model", "permission_profile", "native_permission_profile",
  "approval_policy", "approvals_reviewer", "effort", "context_window"];
/**
 * What a chat says about a start that did not get going: a failed start, or one held before it
 * began (a WebGPT card whose browser check failed was held with its reason, and the chat said
 * "Starting…" for good). Empty when the start went ahead.
 */
function startNotice(result: Record<string, unknown>): string {
  if (result.status === "failed") return String(result.detail || "The run could not start");
  if (result.status === "held" && typeof result.detail === "string" && result.detail) return result.detail;
  return "";
}
/** The fields that decide how a route launches, in a fixed order (absent ones as null). */
const routeIdentity = (route: AoRoute) => CHAT_ROUTE_FIELDS.map(name => (route as unknown as Record<string, unknown>)[name] ?? null);
function lastChatRoute(): AoRoute | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_CHAT_ROUTE) || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
    const route = Object.fromEntries(Object.entries(saved).filter(([name, value]) => CHAT_ROUTE_FIELDS.includes(name)
      && (typeof value === "string" || (name === "context_window" && Number.isSafeInteger(value)))));
    const required = ["harness_id", "provider_id", "account_id", "model", "permission_profile"];
    return required.every(name => typeof route[name] === "string") && route.model && route.model !== AGENT_DEFAULT_MODEL
      ? route as unknown as AoRoute : null;
  } catch { return null; }
}
function rememberChatRoute(route: AoRoute) {
  const kept = Object.fromEntries(Object.entries(route).filter(([name, value]) => CHAT_ROUTE_FIELDS.includes(name) && value !== undefined && value !== null));
  try { localStorage.setItem(LAST_CHAT_ROUTE, JSON.stringify(kept)); } catch { /* New chats keep the default model. */ }
}

export async function moduleCall(operation: string, args: JsonObject = {}) {
  const outer = await getCodingToolsClient().apps.call({
    moduleId: "agent-orchestrator", operation, arguments: args,
  });
  const value = outer.result as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The orchestrator returned no result. Try again.");
  }
  const result = value as Record<string, unknown>;
  if (result.cancelled === true) return result;
  if (outer.ok === false || result.ok === false) {
    throw new Error(String(result.reason || result.detail || "The orchestrator couldn't do that. Try again."));
  }
  return result;
}

/** Reads, or with `mode` sets, where a project's chats work (the Edit project dialog). */
async function workspaceMode(workspaceId: string, mode?: WorkspaceMode): Promise<WorkspaceModeState> {
  const result = await moduleCall("workspace_mode", { workspaceId, ...(mode ? { mode } : {}) });
  return {
    available: result.available === true,
    ...(typeof result.mode === "string" ? { mode: result.mode as WorkspaceMode } : {}),
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
  };
}

/**
 * Reads the harness list, and while AO is still starting (the list then holds only Native Codex,
 * with a notice) asks again with a growing pause for about three minutes, so Claude Code, Codex and
 * the other AO harnesses appear once AO is up instead of staying missing until a reload.
 * Returns a function that stops asking.
 */
export function watchHarnesses(update: (harnesses: AoHarness[], notice: string) => void): () => void {
  let live = true;
  void (async () => {
    for (let attempt = 0; live && attempt < 20; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(2000 * attempt, 10_000)));
      if (!live) return;
      const result = await moduleCall("harnesses")
        .catch(cause => ({ harnesses: [], notice: cause instanceof Error ? cause.message : String(cause) } as Record<string, unknown>));
      if (!live) return;
      const notice = typeof result.notice === "string" ? result.notice : "";
      update(Array.isArray(result.harnesses) ? result.harnesses as AoHarness[] : [], notice);
      if (!notice) return;
    }
  })();
  return () => { live = false; };
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

/** Catalog data is authoritative; legacy servers expose only one real saved team. Saved teams are
 *  shared by every project: a team's workspace_id only records where it was first saved. */
export function aoSavedTeams(result: { teams?: unknown; team?: unknown }): AoTeam[] {
  const items = Array.isArray(result.teams) ? result.teams : result.team ? [result.team] : [];
  return items.filter((item): item is AoTeam => Boolean(item && typeof item === "object" &&
    typeof (item as AoTeam).id === "string" &&
    Number.isSafeInteger((item as AoTeam).revision) && Array.isArray((item as AoTeam).nodes)));
}
/** The team the composer starts on: the one still chosen, else the project's default, else the first. */
export function aoComposerTeam(selected: string, teams: AoTeam[], fallback?: AoTeam | null): string {
  if (selected && teams.some(team => team.id === selected)) return selected;
  return (fallback?.id && teams.some(team => team.id === fallback.id) ? fallback.id : teams[0]?.id) || "";
}
/** A looping team draws its reviewer’s way back to the orchestrator on the mission canvas too. */
export function missionLoop(run: AoMission, shown: AoNode[]): { from: string; to: string } | null {
  const planner = shown.find(node => node.role === "planner"), reviewer = shown.find(node => node.role === "reviewer");
  return run.team?.review_loop && planner && reviewer ? { from: reviewer.id, to: planner.id } : null;
}
/** The chat goals (/goal) a runs read carries, by chat. */
export function chatGoals(result: { goals?: unknown }): Record<string, ChatGoal> {
  const goals = result.goals;
  return goals && typeof goals === "object" && !Array.isArray(goals) ? goals as Record<string, ChatGoal> : {};
}
/** The chat wake-ups (schedule_wakeup) a runs read carries, by chat. */
export function chatWakeups(result: { wakeups?: unknown }): Record<string, ChatWakeup> {
  const wakeups = result.wakeups;
  return wakeups && typeof wakeups === "object" && !Array.isArray(wakeups) ? wakeups as Record<string, ChatWakeup> : {};
}
/** The chats' loops (/loop) a runs read carries, by chat. */
export function chatLoops(result: { loops?: unknown }): Record<string, ChatLoop> {
  const loops = result.loops;
  return loops && typeof loops === "object" && !Array.isArray(loops) ? loops as Record<string, ChatLoop> : {};
}
/** How full a chat's context (its task text, capped at 8,192 characters) is. */
export const CHAT_CONTEXT_LIMIT = 8192;
export function aoChatExecution(mode: "single" | "team", route: AoRoute, teams: AoTeam[], teamId: string): JsonObject {
  if (mode === "single") {
    if (!route.model || route.model === "default") throw new Error("Choose a model first.");
    return { executionMode: "single", singleRoute: { ...route } };
  }
  const selected = teams.find(team => team.id === teamId);
  if (!selected || !Number.isSafeInteger(selected.revision)) throw new Error("This saved team changed. Refresh and choose it again.");
  return { executionMode: "team", teamId: selected.id, teamRevision: selected.revision };
}

const NATIVE_ENTRY: AoHarness = { id: NATIVE_HARNESS, label: "Native Codex", runnable: true, installed: true };

/** A project folder's git kind for the chat list's labels; one stable function, so each folder is read once. */
const readProjectGit = (folder: string) => window.codexWebLauncher?.projectGit?.(folder) ?? Promise.resolve(null);

/** The headless observe answer for a card whose attempt changed between the poll's read and its check. */
const STALE_OBSERVE = /AO receipt changed/;

/** A chat card's model as the composer's chip names it ("DeepSeek V4.1 Flash", "WebGPT High"). */
const chatModelName = (model: string) => modelShortLabel(model.replace(/\((?:\d+|none|auto|minimal|low|medium|high|xhigh|max|ultra)\)$/i, ""), model.startsWith("cpa/")).name;

/**
 * A split pane: one more chat beside the window's own, run by a Surface of its own (so its run,
 * approvals, composer and sends are its own). The window's Surface chooses the chat it shows and
 * hears which chat it opened (`onChat`); a new chat asked for inside it opens another pane.
 */
export type SplitPaneLink = {
  workspaceId: string;
  taskId: string;
  onChat: (workspaceId: string, taskId: string) => void;
  onNewChat: (workspaceId: string) => void;
  onClose: () => void;
};

export function AgentOrchestratorSurface({ language, setError, pane }: {
  language: Language;
  setError: (error: string | null) => void;
  pane?: SplitPaneLink;
}) {
  const copy = words[language];
  const surfaceHidden = useSurfaceHidden();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  // The project whose board and runs were last read in full: until it is the open one, the chat
  // list is still loading, not empty.
  const [loadedWorkspace, setLoadedWorkspace] = useState("");
  const [projectLoadError, setProjectLoadError] = useState("");
  const [projectLoadRevision, setProjectLoadRevision] = useState(0);
  const autoRetriedProjects = useRef(new Set<string>());
  // A split pane opens its own project, and never changes the one the window opens next time.
  const [workspaceId, setWorkspaceId] = useState(() => { if (pane) return pane.workspaceId; try { return localStorage.getItem("coding-tools:ao:workspace") || ""; } catch { return ""; } });
  // The chat a split pane is to show once its project has loaded (null: not a pane).
  const paneWanted = useRef(pane ? { workspaceId: pane.workspaceId, taskId: pane.taskId } : null);
  // One project tree switches between the conversation and the selected graph above its workspace board.
  const [view, setView] = useState<"chat" | "overview" | "board">("chat");
  // Settings covers the chat area as Codex's does (ChatSettingsPage); the chat stays mounted below.
  // Ctrl+, opens it and, pressed again, closes it. Split panes have no sidebar and no Settings.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (pane) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pane]);
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
  // The sidebar's Edit project dialog (or its remove confirmation) for one project.
  const [projectEdit, setProjectEdit] = useState<{ id: string; step: "edit" | "remove" } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const [overviewResizing, setOverviewResizing] = useState(false);
  const [roleAnchor, setRoleAnchor] = useState<PopupAnchor>();
  const closeSheet = useCallback(() => setSheet(""), []);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [missions, setMissions] = useState<AoMission[]>([]);
  // Runs whose Stop is still going through; the chat shows them stopped already (stopChatRun).
  const [stoppingRuns, setStoppingRuns] = useState<string[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  // What agent worktrees get of the project's installed dependencies (null: not read yet):
  // `enabled` reuses node_modules as a hard-link farm, `python` shares the .venv/venv itself.
  type DependencySettings = { enabled: boolean; python: boolean };
  const [depSettings, setDepSettings] = useState<DependencySettings | null>(null);
  const readDepSettings = (result: { enabled?: unknown; python?: unknown }): DependencySettings =>
    ({ enabled: result.enabled !== false, python: result.python === true });
  useEffect(() => {
    if (sheet !== "settings") return;
    let live = true;
    void moduleCall("upstream_dependency_links")
      .then((result) => { if (live) setDepSettings(readDepSettings(result)); })
      .catch(() => { if (live) setDepSettings(null); });
    return () => { live = false; };
  }, [sheet]);
  const changeDepSetting = (name: keyof DependencySettings, value: boolean) => {
    const previous = depSettings;
    if (previous) setDepSettings({ ...previous, [name]: value });
    void moduleCall("upstream_set_dependency_links", { [name]: value })
      .then((result) => setDepSettings(readDepSettings(result)))
      .catch(() => setDepSettings(previous));
  };
  const [inspectedId, setInspectedId] = useState("");
  const [team, setTeam] = useState<AoTeam | null>(null);
  const [savedTeams, setSavedTeams] = useState<AoTeam[]>([]);
  const [composerTeamId, setComposerTeamId] = useState("");
  const [composerMode, setComposerMode] = useState<"single" | "team">("single");
  const [singleRoute, setSingleRoute] = useState<AoRoute>(newChatRoute);
  // A model, effort, window or permission picked in the composer is the next new chat's too, from
  // the moment it is picked: only a sent message kept it before, so a New chat (or another task)
  // opened right after picking went back to the old model. Only the person's picks are kept: the
  // composer fitting an opened chat's route to its model (`adjusted`) is that chat's, and keeping it
  // made a rewind or a new chat start on the old chat's model, effort and window.
  const pickSingleRoute = (route: AoRoute, adjusted = false) => { setSingleRoute(route); if (!adjusted) rememberChatRoute(route); };
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
  // What went wrong in the selected run while it carries on by itself (run_status `warning`).
  const [runWarning, setRunWarning] = useState("");
  const [autoStatus, setAutoStatus] = useState("idle");
  const [pendingApprovals, setPendingApprovals] = useState<AoApproval[]>([]);
  const approvalScope = useRef({ workspaceId: "", runId: "" });
  const pendingApprovalsHere = approvalScope.current.workspaceId === workspaceId && approvalScope.current.runId === selectedRunId ? pendingApprovals : [];
  // Which folders this project's worktrees share or farm, for the install note on approval cards.
  const [dependencyLinks, setDependencyLinks] = useState<{ workspaceId: string; at: number; links: DependencyLinks } | null>(null);
  const wantsDependencyLinks = Boolean(workspaceId) && pendingApprovalsHere.some((approval) => Boolean(approval.command));
  useEffect(() => {
    if (!wantsDependencyLinks) return;
    if (dependencyLinks?.workspaceId === workspaceId && Date.now() - dependencyLinks.at < 60_000) return;
    let live = true;
    void moduleCall("dependency_link_info", { workspaceId }).then((result) => {
      const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      if (live) setDependencyLinks({ workspaceId, at: Date.now(), links: { shared: list(result.shared), farmed: list(result.farmed) } });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [wantsDependencyLinks, workspaceId, pendingApprovals.length]);
  // When each request was first seen (the poll runs every 3 s, so render time is close enough).
  const approvalSeen = useRef(new Map<string, number>());
  const seenAt = (approval: AoApproval) => {
    const key = `${approval.nodeId}:${approval.approval_id}`;
    if (!approvalSeen.current.has(key)) approvalSeen.current.set(key, Date.now());
    if (approvalSeen.current.size > 500) approvalSeen.current.delete(approvalSeen.current.keys().next().value!);
    return approvalSeen.current.get(key)!;
  };
  // A request the "Approve for me" reviewer is still checking is not shown (awaiting_review), and
  // neither is one the app is answering for the person right after (approvalAnsweredForYou): a card
  // then only flashed up, offering a click that arrived after the answer.
  // The run is looked up here, not through `selectedRun`: that const is declared further down, and
  // reading it while this filter runs during render threw "Cannot access … before initialization"
  // (the window's render error, every time a request was pending).
  const approvalRun = missions.find((mission) => mission.id === selectedRunId);
  // A request still awaiting review after REVIEW_GRACE_MS is shown after all: when nothing was
  // screening it (the run's loop had stopped, or its reads of the chat failed), it stayed hidden while
  // the agent waited on it, and a long task sat "may be stuck" for hours.
  const shownApprovals = pendingApprovalsHere.filter((approval) => !(approval.awaiting_review && Date.now() - seenAt(approval) < REVIEW_GRACE_MS) && !approvalAnsweredForYou(approval,
    approvalRun?.nodes.find((node) => node.id === approval.nodeId)?.route as { approval_policy?: string; approvals_reviewer?: string } | undefined,
    Date.now() - seenAt(approval), Boolean(approvalRun?.nodes.some((node) => node.role === "approver")))).map((approval) => {
    const note = dependencyInstallNote(approval.command, dependencyLinks?.workspaceId === workspaceId ? dependencyLinks.links : null);
    return note ? { ...approval, dependencyNote: note } : approval;
  });
  const [runtimePolicies, setRuntimePolicies] = useState<Record<string, RuntimePermissionPolicy>>({});
  const [runTaskId, setRunTaskId] = useState("");
  const [workerParentId, setWorkerParentId] = useState("");
  const [busy, setBusy] = useState("");
  const [missionTitle, setMissionTitle] = useState("");
  const [missionPrompt, setMissionPrompt] = useState("");
  const [pendingChat, setPendingChat] = useState<{ title: string; message: string; taskId?: string } | null>(null);
  /** "Continue in project": a new chat in another project, its composer filled with this chat's messages. */
  const [chatSeed, setChatSeed] = useState<{ key: string; workspaceId: string; title: string; text: string; context?: string[] } | null>(null);

  const selection = useRef({ workspaceId, taskId: chatTaskId ?? "", runId: selectedRunId });
  selection.current = { workspaceId, taskId: chatTaskId ?? "", runId: selectedRunId };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
            && ownTeamRevisions.current.get(revisionKey) !== known.revision) throw new Error("The team changed in another window. Refresh and try again.");
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
        if (state.phase === "applying") { setConfigStatus("Stopping work to apply changes…"); return; }
        if (state.phase === "error") { setConfigStatus(state.error instanceof Error ? state.error.message : "Couldn't apply changes"); return; }
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
        setConfigStatus(result.status === "failed" ? result.detail || "Applied, but the start failed"
          : result.status === "scheduled" ? "Applied. The scheduled start is kept." : ["missed","needs_attention","cancelled"].includes(result.status || "") ? "Applied. Schedule the start again." : "Applied");
      },
    });
    configuration.current = queue;
    return () => { queue.dispose(); if (configuration.current === queue) configuration.current = null; };
  }, []);

  // A catalog is kept a minute (as the main process keeps CPA's), then read again: a provider
  // added in CPA meanwhile appears without a restart.
  const modelCache = useRef(new Map<string, { at: number; models: ReturnType<AoModelLoader> }>());
  const loadModels = useCallback<AoModelLoader>((harness: string) => {
    const key = JSON.stringify([workspaceId, harness]);
    const cached = modelCache.current.get(key);
    let pending = cached && Date.now() - cached.at < 60_000 ? cached.models : undefined;
    if (!pending) {
      // Both catalogs carry model capabilities when their source reports them.
      pending = moduleCall("models", { harness, workspaceId }).then(result => {
        const models = Array.isArray(result.models) ? result.models as string[] : [];
        return result.capabilities || result.unavailable || result.held ? { models, ...(result.capabilities ? { capabilities: result.capabilities as AoModelCatalog["capabilities"] } : {}),
          ...(result.unavailable ? { unavailable: result.unavailable as AoModelCatalog["unavailable"] } : {}),
          ...(result.held ? { held: result.held as AoModelCatalog["held"] } : {}), ...(result.stale === true ? { stale: true } : {}) } : models;
      });
      const entry = { at: Date.now(), models: pending };
      const forget = () => { if (modelCache.current.get(key) === entry) modelCache.current.delete(key); };
      // The remembered list (CPA could not be read) is asked for again next time, not kept a minute.
      pending.then(items => { if (!Array.isArray(items) && items.stale) forget(); }, forget);
      modelCache.current.set(key, entry);
    }
    return pending;
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    // A list that only has Native Codex never replaces a fuller one already shown.
    const stopHarnesses = watchHarnesses((items, notice) => {
      setHarnesses(current => items.length > 1 || current.length <= 1 ? items.length ? items : [NATIVE_ENTRY] : current);
      setHarnessNotice(notice);
    });
    // Show which codex.exe an empty setting resolves to (the Codex CLI first).
    void moduleCall("codex_executable").then(result => {
      if (live && typeof result.executable === "string") setDetectedExecutable(result.executable);
    }).catch(() => { /* No Codex found: the start reports it with install guidance. */ });
    return () => { live = false; stopHarnesses(); };
  }, []);

  const loadMissions = async (id: string) => {
    const current = await moduleCall("runs", { workspaceId: id });
    const runs = Array.isArray(current.runs) ? current.runs as AoMission[] : [];
    if (selection.current.workspaceId !== id) return;
    setTaskLifecycle((current.task_lifecycle as TaskLifecycleView[]) || []);
    setMissions(runs);
    setGoals(chatGoals(current));
    setWakeups(chatWakeups(current));
    setLoops(chatLoops(current));
    // The app's queued messages of this project's chats (chat-queue.cjs).
    if (current.queues && typeof current.queues === "object") syncChatQueues(id, current.queues as Record<string, QueuedChatMessage[]>);
    const setups = aoSavedTeams(current);
    setSavedTeams(setups); setComposerTeamId(selected => aoComposerTeam(selected, setups, current.team as AoTeam | null));
    setTeam(current.team as AoTeam | null ?? setups[0] ?? null);
    if (current.limits) { setLimits(current.limits as typeof limits); setGlobalLimit((current.limits as typeof limits).max_workers); }
    setSelectedRunId((selected) => runs.some((run) => run.id === selected) ? selected : runs[0]?.id ?? "");
  };

  // A card can be left "running" by a previous app session: its Native Codex harness or AO turn
  // died with that app, but only an observe records that, and nothing observes a run that is no
  // longer driven until you open that very chat. Such chats stayed "running" (and on top of the
  // list). Each run nothing is driving is observed once per session: a dead native harness is
  // recorded as failed (so it can be retried) and a dead AO chat host settles as interrupted,
  // while a live AO host just reports that it is still working. That one keeps working with nothing
  // watching it, so its card would stay "running" after the turn ends and the chat could never take
  // another message: it is observed again every few seconds until its turn ends and the card settles.
  // (Observing needs no consent; resuming the run would need the focused window's approval.)
  const settledRuns = useRef(new Set<string>());
  // Chats resumed after a restart, once each per app session.
  const resumedRuns = useRef(new Set<string>());
  useEffect(() => {
    if (!workspaceId) return;
    for (const mission of missions) {
      const running = mission.nodes.filter((node) => node.state === "running");
      const key = `${workspaceId}:${mission.id}`;
      // A run with work left but nothing running (its next cards never started) is just as orphaned.
      // Whether it could resume at all; "Retry automatically" is read below, once a run qualifies.
      if (mission.workspace_id !== workspaceId || mission.cancelled || settledRuns.current.has(key)
        || (!running.length && !restartResume(mission, Date.now(), { autoRetry: true }))) continue;
      settledRuns.current.add(key);
      // A failed step a loop is still holding (it waits out its retry pause) is looked at again on a
      // later update: if that loop ends without retrying, this is what picks the chat up.
      const held = !running.length && mission.nodes.some((node) => node.state === "held");
      void (async () => {
        const status = await moduleCall("run_status", { workspaceId, runId: mission.id });
        if (!mounted.current || selection.current.workspaceId !== workspaceId) { settledRuns.current.delete(key); return; }
        // A loop in this app session drives it (or is starting it).
        if (status.driven !== false || ["starting", "running"].includes(String(status.status))) {
          if (held) settledRuns.current.delete(key);
          return;
        }
        // Read only where it decides anything: a single chat with a failed step.
        const autoRetry = held && mission.execution_mode === "single"
          ? await moduleCall("chat_auto_retry", {}).then((result) => result.autoRetry === true, () => false) : false;
        let nodes = running;
        let still: AoMission | undefined = mission;
        for (;;) {
          for (const node of nodes) await moduleCall("observe", { workspaceId, runId: mission.id, nodeId: node.id }).catch(() => undefined);
          if (!mounted.current || selection.current.workspaceId !== workspaceId) { settledRuns.current.delete(key); return; }
          const after = await moduleCall("runs", { workspaceId, runId: mission.id }).catch(() => null);
          still = (after?.runs as AoMission[] | undefined)?.find((run) => run.id === mission.id);
          // Resumable now: its loop takes over the cards still running and starts the next ones.
          if (still && !resumedRuns.current.has(key) && restartResume(still, Date.now(), { autoRetry })) break;
          nodes = still && !still.cancelled ? still.nodes.filter((node) => node.state === "running" && node.route?.harness_id?.startsWith("ao:")) : [];
          // Done once nothing is left running here, another project is open, or a loop took the run over.
          if (!nodes.length || !mounted.current || selection.current.workspaceId !== workspaceId
            || (await moduleCall("run_status", { workspaceId, runId: mission.id }).catch(() => null))?.driven !== false) break;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        // Left for another project with the card still running: watch it again when it is back.
        if (nodes.length && (!mounted.current || selection.current.workspaceId !== workspaceId)) settledRuns.current.delete(key);
        // A chat the app restart interrupted picks up where it was, the way "Retry failed step"
        // does, and one with work left continues; teams too. With "Retry automatically" on, so does a
        // single chat's failed step that nothing retried. A new background grant still asks in
        // this window.
        const resume = still && !resumedRuns.current.has(key) ? restartResume(still, Date.now(), { autoRetry }) : null;
        if (mounted.current && selection.current.workspaceId === workspaceId && resume) {
          // Starting a run is refused unless the window is focused, and after a restart it often
          // opens behind other windows: five chats' resumes were refused that way (2026-10-24 06:47)
          // and never tried again. The resume waits for the person to come back to the window, then
          // checks nothing else (a goal's round, a retry) picked the chat up meanwhile.
          if (!document.hasFocus()) {
            await new Promise<void>((resolve) => window.addEventListener("focus", () => resolve(), { once: true }));
            if (!mounted.current || selection.current.workspaceId !== workspaceId) { settledRuns.current.delete(key); return; }
          }
          // The app's own restart resume may have picked it up while this one observed: both retried
          // the same chat, and one lost on the revision. Checked last, right before retrying.
          const now = await moduleCall("run_status", { workspaceId, runId: mission.id });
          if (now.driven !== false || ["starting", "running"].includes(String(now.status)) || resumedRuns.current.has(key)) return;
          resumedRuns.current.add(key);
          if (resume === "retry") await moduleCall("control_run", { workspaceId, runId: mission.id, action: "retry", ...executableArg() });
          await moduleCall("start_run", { workspaceId, runId: mission.id, ...executableArg() });
        }
        if (mounted.current && selection.current.workspaceId === workspaceId) await loadMissions(workspaceId);
      })().catch(() => { settledRuns.current.delete(key); });
    }
  }, [missions, workspaceId]);
  // The same orphans in projects that are not open: the effect above reads only the open project's
  // runs, so after a restart a card elsewhere whose turn had already failed (a quota error, its host
  // gone) kept saying "running" until that project was opened. Each other project is swept once per
  // app session: a card still marked running with nothing driving it is observed, which records how
  // its turn ended. Nothing is resumed here; that waits for the project to be opened, as above.
  const sweptWorkspaces = useRef(new Set<string>());
  useEffect(() => {
    if (!workspaceReady) return;
    for (const item of workspaces) {
      if (item.id === workspaceId || sweptWorkspaces.current.has(item.id)) continue;
      sweptWorkspaces.current.add(item.id);
      void (async () => {
        const current = await moduleCall("runs", { workspaceId: item.id }).catch(() => null);
        const runs = Array.isArray(current?.runs) ? current.runs as AoMission[] : [];
        for (const mission of runs) {
          const running = mission.nodes.filter((node) => node.state === "running");
          if (mission.cancelled || !running.length) continue;
          const status = await moduleCall("run_status", { workspaceId: item.id, runId: mission.id }).catch(() => null);
          if (!status || status.driven !== false || ["starting", "running"].includes(String(status.status))) continue;
          for (const node of running) {
            await moduleCall("observe", { workspaceId: item.id, runId: mission.id, nodeId: node.id }).catch(() => undefined);
          }
        }
      })();
    }
  }, [workspaceReady, workspaces, workspaceId]);

  /** The project the loaded board belongs to; the board state itself does not say. */
  const boardWorkspace = useRef("");
  const loadBoard = async (id: string) => {
    const current = await moduleCall("board", { workspaceId: id }) as unknown as Board;
    if (selection.current.workspaceId === id) { boardWorkspace.current = id; setBoard(current); }
    return current;
  };

  useEffect(() => {
    let live = true, reading = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (retried = false) => {
      if (!live || reading || pageHidden()) return;
      if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined; }
      reading = true;
      try {
        const items = await listAllWorkspaces();
        if (live) {
          setWorkspaces(items);
          setWorkspaceId(selected => items.some(item => item.id === selected) ? selected : items[0]?.id ?? "");
          setWorkspaceReady(true);
          if (!items.length) setSheet("settings");
        }
      } catch (cause) {
        if (live) {
          setError(cause instanceof Error ? cause.message : String(cause));
          if (!retried && !pageHidden()) {
            retryTimer = setTimeout(() => { retryTimer = undefined; void refresh(true); }, 750);
          }
        }
      } finally { reading = false; }
    };
    const onVisible = () => { void refresh(); };
    void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setError]);

  // A chat clicked in another project: that project's board and runs, read before switching to it
  // (selectChatIn), so the switch shows them at once instead of an empty project first.
  const preloaded = useRef<{ workspaceId: string; board: Board; runs: Record<string, unknown> } | null>(null);
  useEffect(() => {
    if (!workspaceReady || !workspaceId) { setBoard(null); setMissions([]); return; }
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const stalledTimer = setTimeout(() => {
      if (live && loadedWorkspace !== workspaceId) setProjectLoadError("The project is taking too long to respond.");
    }, 15000);
    setProjectLoadError("");
    const ready = preloaded.current?.workspaceId === workspaceId ? preloaded.current : null;
    preloaded.current = null;
    boardWorkspace.current = "";
    setBoard(null);
    setMissions([]);
    setSelectedRunId("");
    setTeam(null); setSavedTeams([]); setComposerTeamId(""); setMissionTeamId(""); setDraftTeam(null); setInspectedId(""); setTaskLifecycle([]); setConfigStatus("");
    // This project is loading again (it may have been loaded before: A, then B, then A).
    setLoadedWorkspace("");
    const applyBoard = (current: Board) => { boardWorkspace.current = workspaceId; setBoard(current); };
    const applyRuns = (current: Record<string, unknown>) => {
      const runs = Array.isArray(current.runs) ? current.runs as AoMission[] : [];
      setTaskLifecycle((current.task_lifecycle as TaskLifecycleView[]) || []);
      setMissions(runs);
      setGoals(chatGoals(current));
      setWakeups(chatWakeups(current));
      setLoops(chatLoops(current));
      const setups = aoSavedTeams(current);
      setSavedTeams(setups); setComposerTeamId(selected => aoComposerTeam(selected, setups, current.team as AoTeam | null));
      setTeam(current.team as AoTeam | null ?? setups[0] ?? null);
      if (current.limits) { setLimits(current.limits as typeof limits); setGlobalLimit((current.limits as typeof limits).max_workers); }
      setSelectedRunId(runs[0]?.id ?? "");
    };
    if (ready) {
      // Applied with the resets above, in one render: the runs poll keeps them current from here.
      applyBoard(ready.board);
      applyRuns(ready.runs);
      setLoadedWorkspace(workspaceId);
      clearTimeout(stalledTimer);
      return () => { live = false; };
    }
    // Both reads start at once (one after the other, behind every poll a switch sets off, they left
    // the new project's list empty for 2-6 s), and each is applied as soon as it lands: the board
    // never waits on the runs. The chat list counts as loaded only once both have landed.
    const boardRead = (async () => {
      try {
        const current = await moduleCall("board", { workspaceId }) as unknown as Board;
        if (live) applyBoard(current);
        return true;
      } catch (cause) {
        if (live) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setProjectLoadError(message);
          setError(message);
        }
        return false;
      }
    })();
    void (async () => {
      let runsLoaded = false;
      try {
        const current = await moduleCall("runs", { workspaceId });
        if (live) {
          applyRuns(current);
          runsLoaded = true;
        }
      } catch (cause) {
        if (live) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setProjectLoadError(message);
          setError(message);
        }
      }
      // A failed read leaves the list loading (the runs poller marks it loaded once a read lands),
      // never the false "No chats yet".
      const boardLoaded = await boardRead;
      if (!live) return;
      if (boardLoaded && runsLoaded) {
        clearTimeout(stalledTimer);
        setProjectLoadError("");
        setLoadedWorkspace(workspaceId);
      } else if (!autoRetriedProjects.current.has(workspaceId)) {
        // One bounded retry recovers a transient read error after a project switch. Further failures
        // stay visible in the chat pane with a manual Retry button instead of an empty screen.
        autoRetriedProjects.current.add(workspaceId);
        retryTimer = setTimeout(() => { if (live) setProjectLoadRevision((value) => value + 1); }, 1500);
      }
    })();
    return () => { live = false; clearTimeout(stalledTimer); if (retryTimer) clearTimeout(retryTimer); };
  }, [workspaceId, workspaceReady, setError, projectLoadRevision]);

  const run = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };
  // Chat-list actions (rename, archive, delete, restore, cancel a schedule) are guarded per chat,
  // not by the surface-wide busy flag: run() silently skips its action while anything else is in
  // flight (a team auto-save, a start awaiting consent), which made these menu items do nothing.
  const chatBusyIds = useRef(new Set<string>());
  const [chatBusy, setChatBusy] = useState<string[]>([]);
  const chatRun = (taskId: string, action: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    if (chatBusyIds.current.has(taskId)) { reject(new Error("This chat is still updating. Try again.")); return; }
    chatBusyIds.current.add(taskId); setChatBusy([...chatBusyIds.current]); setError(null);
    action().then(resolve, (cause) => { setError(cause instanceof Error ? cause.message : String(cause)); reject(cause); })
      .finally(() => { chatBusyIds.current.delete(taskId); setChatBusy([...chatBusyIds.current]); });
  });

  // "+ New project" on the new chat's project chip: pick a folder, add it (the app asks to confirm),
  // then open a new chat there.
  const addProjectFromFolder = () => void (async () => {
    const folder = await window.codexWebLauncher?.chooseFolder?.();
    if (!folder) return;
    const result = await getCodingToolsClient().workspaces.create({ path: folder, confirm: true });
    if (result.cancelled || !result.id) return;
    setWorkspaces(await listAllWorkspaces());
    setChatSeed({ key: crypto.randomUUID(), workspaceId: result.id, title: "", text: "" });
    chooseWorkspace(result.id);
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // The Edit project dialog saves the name and folders; errors stay in the dialog.
  const saveProjectEdit = async (id: string, change: { name: string; path: string; linkedPaths: string[] }) => {
    await getCodingToolsClient().workspaces.update({ workspaceId: id, ...change, confirm: true });
    setWorkspaces(await listAllWorkspaces());
  };
  // "Remove local project" drops it from the list only (no file is deleted). If it was open,
  // another project opens, or the empty state when it was the last one.
  const removeProject = async (id: string) => {
    await getCodingToolsClient().workspaces.remove({ workspaceId: id, confirm: true });
    const items = await listAllWorkspaces();
    setWorkspaces(items);
    setProjectPins((current) => { const next = current.filter((item) => item !== id); writeList(PINNED_PROJECTS, next); return next; });
    if (id === workspaceId) chooseWorkspace(items[0]?.id ?? "");
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

  useEffect(() => { setChatTaskId(null); setPendingChat(null); }, [workspaceId]);
  // The open project's checked-out branch, for the new chat's environment popover (as Codex shows it).
  const openProjectPath = workspaces.find((item) => item.id === workspaceId)?.path ?? "";
  const [projectBranch, setProjectBranch] = useState("");
  // /goal state per chat, from the bridge, and /plan (a composer mode, kept for this session).
  const [goals, setGoals] = useState<Record<string, ChatGoal>>({});
  // Wake-ups the chats' agents asked for (schedule_wakeup), per chat.
  const [wakeups, setWakeups] = useState<Record<string, ChatWakeup>>({});
  // The chats' loops (/loop), per chat.
  const [loops, setLoops] = useState<Record<string, ChatLoop>>({});
  // A model picked while the open chat's goal runs is used from its next round on (the running
  // round keeps the model it started with; the composer says so). A round that fails on the old
  // model is not retried on it: the next round starts on the pick.
  // A team picked the same way runs the next rounds as that team (its current revision then).
  // A paused or stalled goal takes the pick too, so Resume runs on it: a goal paused because its
  // model's provider refused the request resumed on that same model after the person switched.
  const goalPursued = Boolean(chatTaskId && goals[chatTaskId] && goals[chatTaskId].status !== "achieved");
  const goalRouteKey = !goalPursued ? ""
    : composerMode === "single" ? JSON.stringify([workspaceId, chatTaskId, "single", singleRoute])
    : composerTeamId ? JSON.stringify([workspaceId, chatTaskId, "team", composerTeamId]) : "";
  useEffect(() => {
    if (!goalRouteKey || !chatTaskId) return;
    const pick: JsonObject | null = composerMode === "single"
      ? (singleRoute.model && singleRoute.model !== "default" ? { singleRoute: { ...singleRoute } as unknown as JsonObject } : null)
      : { teamId: composerTeamId };
    if (!pick) return;
    const timer = setTimeout(() => {
      void moduleCall("chat_goal", { workspaceId, taskId: chatTaskId, action: "route", ...pick }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [goalRouteKey]);
  const [planMode, setPlanMode] = useState(false);
  useEffect(() => {
    setProjectBranch("");
    if (!openProjectPath) return;
    let live = true;
    void window.codexWebLauncher?.projectBranch?.(openProjectPath).then((branch) => { if (live) setProjectBranch(branch ?? ""); }, () => undefined);
    return () => { live = false; };
  }, [openProjectPath]);
  useEffect(() => {
    // Right after a project switch this runs while the previous project's board and runs are
    // still loaded; picking its "latest chat" re-selected the old project's task under the new
    // project, so a send went to a task the new workspace refuses. Wait for this project's board.
    if (chatTaskId !== null || !board || boardWorkspace.current !== workspaceId) return;
    // A split pane opens the chat it was given (a new one for ""), never the project's latest.
    const wanted = paneWanted.current;
    if (wanted) {
      if (wanted.workspaceId !== workspaceId || loadedWorkspace !== workspaceId) return;
      const found = wanted.taskId ? chatList(missions, board.tasks, taskLifecycle).find((entry) => entry.taskId === wanted.taskId) : undefined;
      setChatTaskId(found?.taskId ?? "");
      if (found) setSelectedRunId(found.latestRunId);
      return;
    }
    // "Continue in project" switched here to open a new, pre-filled chat, not the latest one.
    if (chatSeed?.workspaceId === workspaceId) { setChatTaskId(""); setView("chat"); return; }
    // A chat clicked in this project's rows opens itself (pendingSelect), not the latest one.
    if (pendingSelect.current?.workspaceId === workspaceId) return;
    // The board and the runs are read at once and the board usually lands first: deciding then found
    // no chats, opened the new chat page, and stayed there although the project had chats.
    if (loadedWorkspace !== workspaceId) return;
    const latest = chatList(missions.filter((mission) => mission.workspace_id === workspaceId), board.tasks, taskLifecycle)[0];
    setChatTaskId(latest?.taskId ?? "");
    if (latest) setSelectedRunId(latest.latestRunId);
  }, [chatTaskId, missions, board, loadedWorkspace]);
  // Keep the shared project tree and newly created runs current in either view.
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    let reading = false;
    const refresh = () => {
      if (reading || surfaceHidden()) return;
      reading = true;
      void moduleCall("runs", { workspaceId }).then((current) => {
        if (live && Array.isArray(current.runs)) {
          // What did not change keeps its object, so a refresh that found nothing new redraws nothing.
          setMissions((previous) => keepRevisions(previous, current.runs as AoMission[]));
          // A switch whose own runs read failed is loaded once a refresh lands with the board there.
          if (boardWorkspace.current === workspaceId) setLoadedWorkspace(workspaceId);
          const goals = chatGoals(current), team = current.team as AoTeam | null ?? null, saved = aoSavedTeams(current);
          const lifecycle = (current.task_lifecycle as TaskLifecycleView[]) || [];
          setGoals((previous) => JSON.stringify(previous) === JSON.stringify(goals) ? previous : goals);
          const wakeups = chatWakeups(current);
          setWakeups((previous) => JSON.stringify(previous) === JSON.stringify(wakeups) ? previous : wakeups);
          const loops = chatLoops(current);
          setLoops((previous) => JSON.stringify(previous) === JSON.stringify(loops) ? previous : loops);
          setTeam((previous) => JSON.stringify(previous) === JSON.stringify(team) ? previous : team);
          setSavedTeams((previous) => JSON.stringify(previous) === JSON.stringify(saved) ? previous : saved);
          setTaskLifecycle((previous) => JSON.stringify(previous) === JSON.stringify(lifecycle) ? previous : lifecycle);
        }
      }).catch(() => {}).finally(() => { reading = false; });
    };
    const timer = setInterval(refresh, 5000);
    // A run changing state (a card finished, a new one started) refreshes the tree at once.
    const stopPush = onAoPush((change) => { if (change.runs.some((key) => key.startsWith(`${workspaceId}:`))) refresh(); });
    return () => { live = false; clearInterval(timer); stopPush(); };
  }, [workspaceId]);
  useEffect(() => {
    const changed = (event: Event) => {
      // Saved teams are shared by every workspace, so any save refreshes this one.
      if (!workspaceId) return;
      void loadMissions(workspaceId).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    window.addEventListener("coding-tools:ao:teams-changed", changed);
    return () => window.removeEventListener("coding-tools:ao:teams-changed", changed);
  }, [workspaceId, setError]);
  const selectChat = (taskId: string, next: "chat" | "overview" = "chat") => {
    // A chat chosen here wins over another project's chat still loading to open (selectChatIn).
    switchTarget.current = ""; pendingSelect.current = null;
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
  // An open chat follows its live run (chatLiveRun): a round its goal, wakeup or loop started, or an
  // older run retried after a newer one stopped. Its approvals, working state and steers come from
  // the selected run, and the run it was opened on stayed selected after it settled.
  useEffect(() => {
    if (view !== "chat" || !chatTaskId) return;
    const live = chatLiveRun(missions.filter((mission) => mission.workspace_id === workspaceId), chatTaskId, selectedRunId);
    if (live !== selectedRunId) setSelectedRunId(live);
  }, [view, chatTaskId, missions, workspaceId, selectedRunId]);
  const currentRun = () => mounted.current && selection.current.workspaceId === workspaceId && selection.current.runId === selectedRunId;
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
    if (saved.cancelled || !saved.team) throw new Error("Permission change cancelled.");
    const next = saved.team as AoTeam; setTeam(next); setSavedTeams(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [...current, next]); setDraftTeam(structuredClone(next));
    if (!mission) return "Team saved. Running agents keep their current permissions.";
    try {
      const applied = await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: mission.id, expected_revision: expectedRevision ?? mission.revision, team_id: next.id, team_revision: next.revision, ...permissionScope } });
      if (applied.cancelled) throw new Error("Change cancelled");
      return "Permissions saved for the next turns. Running agents keep their current permissions.";
    } catch (cause) {
      throw new Error("Team saved, but this chat wasn't updated: " +(cause instanceof Error ? cause.message : String(cause)));
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
      setConfigStatus(invalid ? `Choose a model for ${invalid.settings?.name || invalid.role}` : "Set valid worker and review limits");
      return;
    }
    const mission = chatTaskId ? selectedRun : undefined;
    const scope = { workspaceId, taskId: mission?.project_id || "", ...(mission ? {runId:mission.id} : {}) };
    draftScopes.current.set(JSON.stringify([workspaceId,scope.taskId]),scope);
    queuedExecutables.current.set(JSON.stringify(scope),executable.trim());
    setConfigStatus(immediate ? "Applying…" : "Applying when you stop typing…");
    configuration.current?.enqueue(scope,next,{immediate});
  };
  const missionAction = (taskId: string, action: "schedule" | "cancel_schedule" | "archive" | "delete" | "restore") => {
    const entry = chatList(missions, board?.tasks ?? [], taskLifecycle, true).find(entry => entry.taskId === taskId);
    if (!entry) return;
    const scope = {workspaceId,taskId,runId:entry.latestRunId};
    if (action === "schedule") { setScheduleTarget(scope); setSheet("schedule"); return; }
    const pending = draftScopes.current.get(JSON.stringify([workspaceId,taskId]));
    if (pending) configuration.current?.cancel(pending);
    void chatRun(taskId, async () => {
      const operation = action === "cancel_schedule" ? action : `${action}_task`;
      await moduleCall(operation,{workspaceId:scope.workspaceId,taskId:scope.taskId});
      if (selection.current.workspaceId !== scope.workspaceId) return;
      await Promise.all([loadBoard(scope.workspaceId),loadMissions(scope.workspaceId)]);
      if (selection.current.taskId === taskId && ["archive","delete"].includes(action)) {
        setChatTaskId("");setDraftTeam(null);setInspectedId("");
      }
    }).catch(() => {});
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
  const selectedSetup = savedTeams.find(setup => setup.id === composerTeamId);
  // Reading a saved chat restores its own raw policy, once. Polling never resets explicit draft choices.
  useEffect(() => {
    if (chatTaskId === null || (chatTaskId && !chatMission)) return;
    const key = workspaceId + ":" + chatTaskId;
    if (hydratedComposer.current === key) return;
    hydratedComposer.current = key;
    if (!chatMission) {
      setComposerMode("single");
      setSingleRoute(newChatRoute());
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
    // A native role that hasn't connected yet has no runtime to ask. The choice is saved as its
    // route and the connection refuses a route its permissions don't match, so the menu stays usable.
    if (role.route.harness_id === NATIVE_HARNESS && !node) return draftPermissionCapability();
    const result = await moduleCall("permission_profiles", { workspaceId, route: role.route as unknown as JsonObject,
      ...(node && permissionMission ? { runId: permissionMission.id, nodeId: node.id } : {}) });
    return result.capability as PermissionCapability ?? { supported: false, profiles: [], reason: "This agent didn't report its permissions" };
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
      if (!chosen || selectedRoleIds.length !== 1 || selectedRoleIds[0] !== singleRoleId) throw new Error("The chat's agent changed. Reopen the menu.");
      if (permissionMission) {
        const applied = await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: permissionMission.id,
          expected_revision: revision ?? permissionMission.revision, ...scope } });
        if (applied.cancelled) throw new Error("Cancelled. Permissions are unchanged.");
        await loadMissions(workspaceId);
      }
      pickSingleRoute({ ...chosen.route });
      return "Applies from the next turn. A running turn keeps its permissions.";
    }
    if (!selectedSetup) throw new Error("This team isn't available. Refresh and try again.");
    const latest = await moduleCall("runs", { workspaceId });
    const saved = aoSavedTeams(latest).find(setup => setup.id === selectedSetup.id);
    if (!saved || saved.revision !== selectedSetup.revision) throw new Error("The team changed. Refresh and choose permissions again.");
    const reusableIds = selectedRoleIds.filter(id => saved.nodes.some(node => node.id === id));
    if (reusableIds.length) return persistTeam(mergeSavedPermissions(saved, reusableIds, selection), permissionMission, revision, scope);
    if (!permissionMission) throw new Error("These roles are no longer in the team.");
    const applied = await moduleCall("team_update", { workspaceId, change: { operation: "apply_team", run_id: permissionMission.id,
      expected_revision: revision ?? permissionMission.revision, team_id: saved.id, team_revision: saved.revision, ...scope } });
    if (applied.cancelled) throw new Error("Cancelled. Permissions are unchanged.");
    await loadMissions(workspaceId);
    return "Permissions saved for this chat's next turns. The running turn and the saved team are unchanged.";
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
      if (reading || surfaceHidden()) return;
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
  // Poll a run only once it is known in the open project: right after a project switch the
  // selected run still belongs to the previous one, and asking the new project for it failed
  // ("AO run not found in this workspace"), surfacing as an error toast.
  const selectedRunHere = missions.some((mission) => mission.id === selectedRunId && mission.workspace_id === workspaceId);
  useEffect(() => {
    setRunWarning("");
    if (!workspaceId || !selectedRunId || !selectedRunHere) { setAutoStatus("idle"); return; }
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading || surfaceHidden()) return;
      reading = true;
      try {
        const status = await moduleCall("run_status", { workspaceId, runId: selectedRunId });
        if (!live) return;
        const nextStatus = typeof status.status === "string" ? status.status : "idle";
        setAutoStatus(nextStatus);
        setAdvanceNotice(typeof status.detail === "string" ? status.detail : "");
        setRunWarning(typeof status.warning === "string" ? status.warning : "");
        if (nextStatus !== "idle") {
          const current = await moduleCall("runs", { workspaceId, runId: selectedRunId });
          if (live && Array.isArray(current.runs)) {
            setMissions((previous) => keepRevisions(previous, previous.map((run) =>
              (current.runs as AoMission[]).find((fresh) => fresh.id === run.id) ?? run)));
          }
        }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void refresh(), 3000);
    const stopPush = onAoPush((change) => { if (change.runs.includes(`${workspaceId}:${selectedRunId}`)) void refresh(); });
    void refresh();
    return () => { live = false; clearInterval(timer); stopPush(); };
  }, [workspaceId, selectedRunId, selectedRunHere, setError]);
  const activeNodeIds = JSON.stringify(selectedRun?.nodes.filter(node => ["reserved", "running"].includes(node.state)).map(node => node.id) ?? []);
  useEffect(() => {
    const ids = JSON.parse(activeNodeIds) as string[];
    setPendingApprovals([]);
    approvalScope.current = { workspaceId, runId: selectedRunId };
    // As the status poll above: a run still selected from the previous project was asked about in
    // this one every 3 s ("AO run not found in this workspace", 25 times in the launcher log).
    if (!workspaceId || !selectedRunId || !selectedRunHere || !ids.length) return;
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading || surfaceHidden()) return;
      reading = true;
      try {
        // A card whose attempt moved on while this poll read it (a retry, the app restarting under it)
        // answers "AO receipt changed; refresh before retrying": the next tick reads the new attempt.
        // It showed as "Something went wrong" and, rejecting the whole batch, hid the other cards'
        // requests for that tick.
        const read = await Promise.all(ids.map(async nodeId => {
          try {
            return { nodeId, result: await moduleCall(["running", "paused"].includes(autoStatus) ? "harness_status" : "observe", { workspaceId, runId: selectedRunId, nodeId }) };
          } catch (cause) {
            if (STALE_OBSERVE.test(cause instanceof Error ? cause.message : String(cause))) return null;
            throw cause;
          }
        }));
        const results = read.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        if (!live || selection.current.workspaceId !== workspaceId || selection.current.runId !== selectedRunId) return;
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
  }, [workspaceId, selectedRunId, selectedRunHere, activeNodeIds, autoStatus, setError]);

  const taskName =(id: string) => board?.tasks.find((task) => task.id === id)?.title ?? id;
  const describeNode = (node: CanvasNode) => node.route.model.startsWith("chatgpt-web/") ? modelLabel(node.route.model)
    : `${harnessLabel(node.route.harness_id || NATIVE_HARNESS, harnesses)} · ${node.route.model}`;
  const moveCard = async (positions: { id: string; x: number; y: number }[], parentId?: string) => {
    if (!selectedRun || busy) throw new Error("Wait for the current change to finish");
    setBusy("position"); setError(null);
    try {
      const moved = await moduleCall("update_run", { workspaceId, change: { operation: "graph", run_id: selectedRun.id,
        expected_revision: selectedRun.revision, change: { operation: "move_nodes", positions: positions.map(({ id, x, y }) => ({ node_id: id, x, y })) } } });
      let updated = moved.run as AoMission;
      setMissions(current => current.map(mission => mission.id === updated.id ? updated : mission));
      if (parentId && positions.length === 1) {
        const change = aoDependencyChange(updated, positions[0].id, parentId);
        if (!change) throw new Error("The card changed. Link it again.");
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
    if (!change || !window.confirm("Remove this card? Its task passes to another worker, linked and idle ones first.")) return;
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
    const execution = aoChatExecution(composerMode, workerRouteDraft, savedTeams, composerTeamId);
    let missionBoard = board;
    let taskId = runTaskId;
    if (!taskId) {
      const previousIds = new Set(board.tasks.map((task) => task.id));
      missionBoard = await moduleCall("create", { workspaceId,
        title: missionTitle.trim() || missionPrompt.trim().slice(0, 80), description: missionPrompt.trim(),
        expectedRevision: board.revision }) as unknown as Board;
      boardWorkspace.current = workspaceId; setBoard(missionBoard);
      const added = missionBoard.tasks.filter((task) => !previousIds.has(task.id));
      if (added.length !== 1) throw new Error("Couldn't tell which task was created. Refresh and pick it.");
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
      settings: starterSettings("worker", workerName.trim() || "Worker", workerSpecialty),
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
    if (result.cancelled || !currentRun()) return;
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    setAdvanceNotice("Running. Tool requests still need your approval.");
    await loadMissions(workspaceId);
  });

  // Restart = a fresh run of the same task with the current team; the old run stays in history.
  const restartRun = () => void run("restart-run", async () => {
    if (!selectedRun) return;
    const result = await moduleCall("restart_run", { workspaceId, runId: selectedRun.id, ...executableArg() });
    if (result.cancelled || !currentRun()) return;
    if (typeof result.runId === "string") setSelectedRunId(result.runId);
    if (result.status === "failed" && typeof result.detail === "string") setError(result.detail);
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    await loadMissions(workspaceId);
  });

  const controlRun = (action: "pause" | "resume" | "stop") => void run(action, async () => {
    if (!selectedRun) return;
    const result = await moduleCall("control_run", { workspaceId, runId: selectedRun.id, action, ...executableArg() });
    if (result.cancelled || !currentRun()) return;
    setAutoStatus(action === "pause" ? "paused" : action === "resume" ? "running" : "held");
    await loadMissions(workspaceId);
  });

  const sendChat = (input: { taskId?: string; title?: string; message: string; goal?: string; rewind?: { index: number; description: string } }) => new Promise<void>((resolve, reject) => {
    // run() skips its action while another one is in flight; never leave the chat waiting on it.
    if (busy) { reject(new Error("Another action is still running")); return; }
    const owner = selection.current;
    const current = () => mounted.current && selection.current.workspaceId === workspaceId && selection.current.taskId === owner.taskId;
    void run("chat", async () => {
      try {
        if (!workspaceId) throw new Error("Add a project first");
        // A follow-up must go to a task of the open project; anything else is a stale selection.
        if (input.taskId && !(boardWorkspace.current === workspaceId && board?.tasks.some((task) => task.id === input.taskId))) {
          throw new Error("This chat is in another project. Open it there, or start a new chat here.");
        }
        const execution = aoChatExecution(composerMode, singleRoute, savedTeams, composerTeamId);
        // A new chat shows its message and "Starting" the moment it is sent, as Claude Code does,
        // before the answer below. A follow-up shows its own (AgentOrchestratorChat).
        if (!input.taskId) setPendingChat({ title: input.title || "New task", message: input.message });
        // deferStart: the answer comes once the run exists, and it starts in the background. Waiting
        // for the start too (resolving the agent, the grant, two more run reads) held the send button
        // and Enter for seconds after every message. A start that fails is still told: the run's
        // status says why (run_status detail), as the chat's notice.
        const result = await moduleCall("chat_send", { workspaceId, message: input.message,
          ...(input.taskId ? { taskId: input.taskId } : input.title ? { title: input.title } : {}),
          ...execution, ...executableArg(), ...(input.goal ? { goal: input.goal } : {}), ...(input.rewind ? { rewind: input.rewind } : {}), deferStart: true });
        if (result.cancelled) throw new Error("Message not sent. The start was cancelled.");
        if (!current()) { resolve(); return; }
        // The route is not kept here: picks are kept as they are made, and a follow-up in an older
        // chat runs on that chat's route, which must not become the next new chat's (or a rewind's).
        // The board and missions reload in the background below: awaiting them here too (two more
        // reads, then the same two again) held the sent message for seconds on a busy disk. The new
        // run and the new chat's task are set from the answer meanwhile.
        const taskId = String(result.taskId);
        if (input.rewind) {
          await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]);
          if (!current()) { resolve(); return; }
        }
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
        setChatNotices((current) => ({ ...current, [taskId]: startNotice(result) }));
        setAutoStatus(startNotice(result) ? "idle" : typeof result.status === "string" ? result.status : "running");
        resolve();
        if (!input.rewind) void Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
      } catch (cause) {
        if (current() && !input.taskId) setPendingChat(null);
        reject(cause);
        // Refused only for now (the chat started working again under the message, or the window was
        // not in front): the chat queues the message and says so; no "Something went wrong" toast.
        if (input.taskId && QUIET_SEND_REFUSAL.test(cause instanceof Error ? cause.message : String(cause))) return;
        throw cause;
      }
    });
  });
  // Steering goes straight to the running agent, outside run()'s one-action-at-a-time lock: it must
  // not wait behind another action, and it changes no run state the surface tracks.
  const steerChat = async (input: { taskId: string; message: string; restart?: boolean; goal?: string }) => {
    if (!workspaceId) throw new Error("Add a project first");
    try {
      const result = await moduleCall("chat_steer", { workspaceId, taskId: input.taskId, message: input.message, ...(input.restart ? { restart: true } : {}), ...(input.goal ? { goal: input.goal } : {}) });
      if (result.steered) void loadBoard(workspaceId).catch(() => undefined);
      // The agent waits on a request of its own (or its hung turn, or a long command, was just
      // stopped): the message waits for the turn instead.
      return result.steered === true ? true : result.interrupted === true ? "interrupt" as const : result.restarted === true ? "restart" as const
        : result.starting === true ? "starting" as const
        : result.waiting === true ? "wait" as const : false;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // The chat waits for focus and steers it in then (see QUIET_SEND_REFUSAL).
      if (!QUIET_SEND_REFUSAL.test(message)) setError(message);
      throw cause;
    }
  };
  // The chats' queued messages are the app's (chat_queue): it sends them when a chat's turn settles,
  // whichever chat is open. A queued message runs on the model or team picked when it was queued.
  const queueCall = async (taskId: string, args: JsonObject) => {
    if (!workspaceId) throw new Error("Add a project first");
    const result = await moduleCall("chat_queue", { workspaceId, taskId, ...args });
    if (Array.isArray(result.queue)) syncChatQueues(workspaceId, { [taskId]: result.queue as QueuedChatMessage[] }, taskId);
    return result;
  };
  const chatQueue: ChatQueueActions = {
    add: async (taskId, item, front = false) => {
      let selection: JsonObject | undefined;
      try { selection = aoChatExecution(composerMode, singleRoute, savedTeams, composerTeamId); } catch { selection = undefined; }
      await queueCall(taskId, { action: "add", front, item: { ...item, ...(selection ? { selection } : {}), ...executableArg() } });
    },
    update: async (taskId, id, message) => (await queueCall(taskId, { action: "update", itemId: id, message })).updated === true,
    remove: async (taskId, ids) => { await queueCall(taskId, ids === null ? { action: "clear" } : { action: "remove", ids }); },
  };
  // Have the agent the next message needs running before it is sent, so sending does not wait half
  // a minute for a launch: the selected model's (or the team's orchestrator) on a new chat, and on an
  // open chat whenever its agent cannot simply continue (the backend decides, and wakes one that was
  // released while idle). Best effort and silent.
  const prewarmKey = view === "chat" && chatTaskId !== null && workspaceId
    ? JSON.stringify([workspaceId, chatTaskId, composerMode, composerMode === "single" ? singleRoute : composerTeamId]) : "";
  useEffect(() => {
    if (!prewarmKey) return;
    let execution: JsonObject;
    try { execution = aoChatExecution(composerMode, singleRoute, savedTeams, composerTeamId); } catch { return; }
    // Wait for the picker to settle so trying models does not start an agent for each.
    const timer = setTimeout(() => {
      lastPrewarm.current = Date.now();
      void moduleCall("chat_prewarm", { workspaceId, ...execution, ...(chatTaskId ? { taskId: chatTaskId } : {}) }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [prewarmKey, savedTeams.length]);
  // Warmed again when the user starts typing (at most every 30 s): an agent left idle is released,
  // and the message then waited for a whole launch (4-59 s, measured live) after it was sent. The
  // backend keeps a warm or running agent as it is, so asking again costs nothing then.
  const lastPrewarm = useRef(0);
  const prewarmOnTyping = useCallback(() => {
    if (!prewarmKey || Date.now() - lastPrewarm.current < 30_000) return;
    let execution: JsonObject;
    try { execution = aoChatExecution(composerMode, singleRoute, savedTeams, composerTeamId); } catch { return; }
    lastPrewarm.current = Date.now();
    void moduleCall("chat_prewarm", { workspaceId, ...execution, ...(chatTaskId ? { taskId: chatTaskId } : {}) }).catch(() => undefined);
  }, [prewarmKey, composerMode, singleRoute, savedTeams, composerTeamId, workspaceId, chatTaskId]);
  // Guarded per chat (chatRun), like the chat list's actions: run() skipped Retry without a word
  // while anything else was in flight (another chat's start awaiting consent, a team save), and the
  // failed-step card's button sat disabled, so "Retry step" did nothing.
  const retryChatStart = (runId: string) => {
    const taskId = missions.find((mission) => mission.id === runId)?.project_id ?? "";
    void chatRun(taskId || runId, () => retryRun(runId, taskId)).catch(() => undefined);
  };
  const retryRun = async (runId: string, taskId: string) => {
    try {
      const mission = missions.find(item => item.id === runId);
      // Retry ran the run's saved route again: a model that had gone failed the same way however
      // often it was retried, whatever the composer showed. A single chat whose composer now has
      // another model restarts on that one, as the next message would.
      const card = mission?.execution_mode === "single" ? mission.nodes[0] : undefined;
      const picked = composerMode === "single" && singleRoute.model && singleRoute.model !== "default" ? singleRoute : null;
      if (card && picked && JSON.stringify(routeIdentity(card.route)) !== JSON.stringify(routeIdentity(picked))) {
        const result = await moduleCall("restart_run", { workspaceId, runId, ...executableArg(), singleRoute: { ...picked } as unknown as JsonObject });
        if (result.cancelled || !currentRun()) return;
        if (typeof result.runId === "string") setSelectedRunId(result.runId);
        setChatNotices((current) => ({ ...current, [taskId]: startNotice(result) }));
        setAutoStatus(startNotice(result) ? "idle" : typeof result.status === "string" ? result.status : "running");
        await loadMissions(workspaceId);
        return;
      }
      if (mission?.nodes.some(node => ["held", "failed"].includes(node.state))) {
        await moduleCall("control_run", { workspaceId, runId, action: "retry", ...executableArg() });
      }
      const result = await moduleCall("start_run", { workspaceId, runId, ...executableArg() });
      if (result.cancelled || !currentRun()) return;
      setChatNotices((current) => ({ ...current, [taskId]: startNotice(result) }));
      setAutoStatus(startNotice(result) ? "idle" : typeof result.status === "string" ? result.status : "running");
    } catch (cause) {
      if (currentRun()) setChatNotices((current) => ({ ...current, [taskId]: cause instanceof Error ? cause.message : String(cause) }));
    }
    await loadMissions(workspaceId);
  };
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
  const allTasks = useMemo(() => board?.tasks ?? [], [board]);
  const togglePin =(taskId: string) => setChatPins((current) => {
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
  // Split view (Claude Code's): more chats beside the window's own, each in a pane of its own
  // (SplitPaneLink). "main" is the window's own chat; a sidebar click goes to the focused pane.
  const [splitPanes, setSplitPanes] = useState<SplitPane[]>([]);
  const [focusedPane, setFocusedPane] = useState("main");
  const focusedSplit = splitPanes.find((item) => item.id === focusedPane);
  const [splitMaxCols, setSplitMaxCols] = useState(2);
  const [splitWeightsSaved, setSplitWeightsSaved] = useState<number[] | undefined>(undefined);
  const [splitRow, setSplitRow] = useState(SPLIT_ROW.DEFAULT);
  /** The pane already showing a chat, so a chat is never open twice (both would send its queue). */
  const paneShowing = (id: string, taskId: string) => !taskId ? undefined : workspaceId === id && chatTaskId === taskId ? "main"
    : splitPanes.find((item) => item.workspaceId === id && item.taskId === taskId)?.id;
  /** The window's own chat becomes this one (a promoted pane, a chat dropped to the left of it). */
  const showInMain = (id: string, taskId: string) => {
    if (id === workspaceId) { if (taskId) selectChat(taskId); else startNewChat(); return; }
    if (taskId) selectChatIn(id, taskId);
    else { setChatSeed({ key: crypto.randomUUID(), workspaceId: id, title: "", text: "" }); chooseWorkspace(id); }
  };
  /**
   * Opens a chat ("" a new one) in a pane: where it was asked to go, else Claude Code's next place
   * (a new column while one fits, then a free bottom row, else in place of the last chat).
   */
  const openInSplit = (id: string, taskId: string, at?: SplitDropTarget | PanePos | null) => {
    const open = paneShowing(id, taskId);
    setView("chat"); setSheet("");
    // An open chat dragged from the sidebar to another place moves there and its old pane closes;
    // only a click (no target) goes back to the pane already showing it.
    if (open && at && "kind" in at && open !== "main") {
      if (at.kind === "left") { moveSplitPane(open, at); return; }
      const next = relocatePane(splitPanes, open, at);
      if (next) setSplitPanes(next);
      setFocusedPane(open);
      return;
    }
    if (open === "main" && at && "kind" in at && at.kind !== "left") { moveMainChat(at); return; }
    if (open) { setFocusedPane(open); return; }
    if (at && "kind" in at && at.kind === "left") {
      // In front of the window's own chat: that chat moves into a pane of its own, every column one right.
      const moved = { id: crypto.randomUUID(), workspaceId, taskId: chatTaskId ?? "", col: 1, row: 0 as const };
      setSplitPanes((current) => normalizeSplit([moved, ...current.map((item) => ({ ...item, col: item.col + 1 }))]));
      setFocusedPane("main");
      showInMain(id, taskId);
      return;
    }
    const place: PanePos | { replace: string } = !at ? defaultPlace(splitPanes, splitMaxCols)
      : "kind" in at ? at.kind === "column" ? { col: splitColumns(splitPanes), row: 0 } : { col: at.col, row: at.row } : at;
    const holder = "replace" in place ? splitPanes.find((item) => item.id === place.replace)
      : splitPanes.find((item) => item.col === place.col && item.row === place.row);
    if ("col" in place && place.col === 0 && place.row === 0) { setFocusedPane("main"); showInMain(id, taskId); return; }
    if (holder) {
      setSplitPanes((current) => current.map((item) => item.id === holder.id ? { ...item, workspaceId: id, taskId } : item));
      setFocusedPane(holder.id);
      return;
    }
    const added = { id: crypto.randomUUID(), workspaceId: id, taskId, ...(place as PanePos) };
    setSplitPanes((current) => normalizeSplit([...current, added]));
    setFocusedPane(added.id);
  };
  /** A new chat in this pane, in place of the chat it showed. */
  const newChatInPane = (paneId: string, id: string) => {
    setView("chat"); setSheet("");
    setSplitPanes((current) => current.map((item) => item.id === paneId ? { ...item, workspaceId: id, taskId: "" } : item));
    setFocusedPane(paneId);
  };
  /**
   * A pane dragged by its grip (Claude Code's pane move): to a new column or another cell, trading
   * places with the pane there; dropped in front of the window's own chat, it becomes that chat and
   * the window's chat moves into a pane of its own.
   */
  const moveSplitPane = (id: string, target: SplitDropTarget) => {
    const moving = splitPanes.find((item) => item.id === id);
    if (!moving) return;
    if (target.kind === "left") {
      const moved = { id: crypto.randomUUID(), workspaceId, taskId: chatTaskId ?? "", col: 1, row: 0 as const };
      setSplitPanes((current) => normalizeSplit([moved, ...current.filter((item) => item.id !== id).map((item) => ({ ...item, col: item.col + 1 }))]));
      setFocusedPane("main");
      showInMain(moving.workspaceId, moving.taskId);
      return;
    }
    const next = movePane(splitPanes, id, target);
    if (!next) return;
    setSplitPanes(next);
    setFocusedPane(id);
  };
  /**
   * The window's own chat dragged from the sidebar into a pane's cell: onto another chat, the two
   * trade places; into a new column or an empty cell, it opens there and the window's place goes to
   * the first pane with a chat (whose pane closes), as when the window's chat is closed.
   */
  const moveMainChat = (target: Exclude<SplitDropTarget, { kind: "left" }>) => {
    const to: PanePos = target.kind === "column" ? { col: splitColumns(splitPanes), row: 0 } : { col: target.col, row: target.row };
    if (to.col === 0 && to.row === 0) { setFocusedPane("main"); return; }
    const own = { workspaceId, taskId: chatTaskId ?? "" };
    const holder = splitPanes.find((item) => item.col === to.col && item.row === to.row);
    if (holder) {
      setSplitPanes((current) => current.map((item) => item.id === holder.id ? { ...item, ...own } : item));
      setFocusedPane(holder.id);
      showInMain(holder.workspaceId, holder.taskId);
      return;
    }
    const added = { id: crypto.randomUUID(), ...own, ...to };
    const first = [...splitPanes].sort(paneOrder).find((item) => item.taskId);
    setSplitPanes((current) => normalizeSplit([...current.filter((item) => item.id !== first?.id), added]));
    setFocusedPane(added.id);
    if (first) showInMain(first.workspaceId, first.taskId);
    else startNewChat();
  };
  /** Close split view: a pane goes; the window's own chat closed hands its place to the first pane with a chat. */
  const closeSplitPane = (id: string) => {
    if (!splitPanes.length) return;
    if (id === "main") {
      const ordered = [...splitPanes].sort(paneOrder);
      const first = ordered.find((item) => item.taskId);
      setFocusedPane("main");
      if (!first) { startNewChat(); return; }
      setSplitPanes((current) => normalizeSplit(current.filter((item) => item.id !== first.id)));
      showInMain(first.workspaceId, first.taskId);
      return;
    }
    const order = focusOrder(splitPanes);
    setSplitPanes((current) => normalizeSplit(current.filter((item) => item.id !== id)));
    if (focusedPane === id) setFocusedPane(order[Math.max(0, order.indexOf(id) - 1)] ?? "main");
  };
  // The split view is kept between runs (its chats, column widths and row split), as Claude Code keeps it.
  const splitRestored = useRef(false);
  useEffect(() => {
    if (pane || splitRestored.current || !workspaceReady) return;
    splitRestored.current = true;
    let saved: SplitSaved = { panes: [] };
    try { saved = readSplit(localStorage.getItem(SPLIT_STORE)); } catch { /* Nothing kept. */ }
    if (saved.panes.length) setSplitPanes(normalizeSplit(saved.panes.map((item) => ({ ...item, id: crypto.randomUUID() }))));
    if (saved.weights) setSplitWeightsSaved(saved.weights);
    if (saved.rowSplit) setSplitRow(saved.rowSplit);
  }, [workspaceReady]);
  useEffect(() => {
    if (pane || !splitRestored.current) return;
    const kept: SplitSaved = { panes: splitPanes.filter((item) => item.taskId).map(({ workspaceId: id, taskId, col, row }) => ({ workspaceId: id, taskId, col, row })),
      weights: splitWeightsSaved, rowSplit: splitRow };
    try { localStorage.setItem(SPLIT_STORE, JSON.stringify(kept)); } catch { /* Kept for this session only. */ }
  }, [splitPanes, splitWeightsSaved, splitRow]);
  // Claude Code's split view keys (Windows): Ctrl+Alt+\ a new chat on the right, Ctrl+Alt+- one below,
  // Ctrl+] / Ctrl+[ the next or previous pane, Ctrl+Alt+Arrow the pane that way, Ctrl+Alt+W close it.
  useEffect(() => {
    if (pane) return;
    const onKey = (event: KeyboardEvent) => {
      // AltGr arrives as Ctrl+Alt: on many layouts it types \ or - and must not open a pane.
      if (view !== "chat" || event.getModifierState?.("AltGraph")) return;
      const key = event.key;
      if (event.ctrlKey && event.altKey && !event.shiftKey && (key === "\\" || event.code === "Backslash")) {
        event.preventDefault();
        openInSplit(workspaceId, "", splitColumns(splitPanes) < splitMaxCols ? { kind: "column" } : null);
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && (key === "-" || event.code === "Minus")) {
        event.preventDefault();
        const from = focusedSplit ?? { col: 0, row: 0 as const };
        openInSplit(workspaceId, "", belowPlace(splitPanes, from, splitMaxCols) as PanePos);
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && (key.toLowerCase() === "w" || event.code === "KeyW")) {
        if (!splitPanes.length) return;
        event.preventDefault();
        closeSplitPane(focusedPane);
      } else if (event.ctrlKey && !event.altKey && !event.shiftKey && (key === "]" || key === "[")) {
        if (!splitPanes.length) return;
        event.preventDefault();
        const order = focusOrder(splitPanes);
        const at = Math.max(0, order.indexOf(focusedPane));
        focusComposer.current = true;
        setFocusedPane(order[(at + (key === "]" ? 1 : -1) + order.length) % order.length]);
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && /^Arrow(Left|Right|Up|Down)$/.test(key)) {
        const next = spatialNeighbour(splitPanes, focusedPane, key.slice(5).toLowerCase() as "left" | "right" | "up" | "down");
        if (!next) return;
        event.preventDefault();
        focusComposer.current = true;
        setFocusedPane(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // A pane focused from the keyboard or just opened takes the keyboard: its composer, as Claude
  // Code's does. A click into a pane leaves focus where the click put it.
  const focusComposer = useRef(false);
  useEffect(() => {
    if (pane || !splitPanes.length || !focusComposer.current) return;
    focusComposer.current = false;
    const frame = window.requestAnimationFrame(() => {
      const box = stageRef.current?.querySelector<HTMLElement>(`.cx-split > .cx-pane[data-focused]`);
      if (box && !box.contains(document.activeElement)) box.querySelector<HTMLTextAreaElement>(".cx-composer textarea")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedPane]);
  /** A chat chosen in the sidebar: its pane if it is open, else the focused pane shows it. */
  const showChat = (id: string, taskId: string) => {
    const open = paneShowing(id, taskId);
    if (open) { setFocusedPane(open); if (open === "main") selectChat(taskId); else setView("chat"); return; }
    if (focusedSplit) {
      setView("chat"); setSheet("");
      setSplitPanes((current) => current.map((item) => item.id === focusedSplit.id ? { ...item, workspaceId: id, taskId } : item));
      return;
    }
    if (id === workspaceId) selectChat(taskId); else selectChatIn(id, taskId);
  };
  /**
   * New chat: in the focused pane, in place of its chat. It opened a pane of its own in a split
   * window, so each New chat added one more screen (2026-10-31: the user asked for it to open where
   * they were). Ctrl+Alt+\ / Ctrl+Alt+- and dragging a chat still open more panes.
   */
  const openNewChat = (id = workspaceId) => {
    if (pane) { pane.onNewChat(id); return; }
    if (focusedSplit) { newChatInPane(focusedSplit.id, id); return; }
    if (id === workspaceId) startNewChat();
    else { setChatSeed({ key: crypto.randomUUID(), workspaceId: id, title: "", text: "" }); chooseWorkspace(id); }
  };
  const renameChat = (taskId: string, title: string) => chatRun(taskId, async () => {
    await moduleCall("task_rename", { workspaceId, taskId, title });
    await loadBoard(workspaceId);
  });
  // "Archive chats" on a project: each chat goes through the lifecycle's own archive (which asks
  // before stopping a chat's running work), one after another.
  const archiveAllChats = () => void run("archive-all", async () => {
    const chats = chatList(missions, allTasks, taskLifecycle);
    for (const entry of chats) await moduleCall("archive_task", { workspaceId, taskId: entry.taskId });
    setChatTaskId("");
    await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]);
  });
  // Rewind the conversation and run the selected message again; workspace files stay unchanged.
  const rewindChat = (taskId: string, upTo: number) => (async () => {
    const description = await loadDescription(taskId);
    const messages = chatMessagesFromDescription(description);
    if (!Number.isInteger(upTo) || upTo < 0 || upTo >= messages.length) throw new Error("That message is no longer in this chat; reload it");
    await sendChat({ taskId, message: messages[upTo].text, rewind: { index: upTo, description } });
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // Fork: a new chat starting from this chat's messages (all, the first, or up to one of them).
  const forkChat = (taskId: string, upTo?: number | "first") => void (async () => {
    const messages = chatMessagesFromDescription(await loadDescription(taskId));
    const kept = upTo === undefined ? messages : messages.slice(0, upTo === "first" ? 1 : upTo + 1);
    if (!kept.length) return;
    await sendChat({ title: `Fork of ${taskName(taskId)}`.slice(0, 240), message: kept.map((message) => chatMessageReadable(message.text)).join("\n\n").slice(0, 8192) });
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // Delete message (confirmed in the chat): the message and its reply leave this chat. The chat
  // names the runs its turn showed (the first is the one the message started); the bridge hides
  // exactly those, so every other answer stays with its message, and the next turn starts a fresh
  // agent session. Files on disk are not changed.
  const deleteChatMessage = (taskId: string, index: number, runIds: string[]) => chatRun(taskId, async () => {
    const [runId, ...more] = runIds;
    await moduleCall("chat_delete_message", { workspaceId, taskId, index, runId, runIds: more });
    await loadMissions(workspaceId);
  });
  /** A chat as Codex turns, read fresh (the board list omits task descriptions). */
  const chatTranscript = async (taskId: string) => chatTurns(missions.filter((mission) => mission.project_id === taskId) as unknown as ChatRun[],
    await loadDescription(taskId), { describe: describeChatNode, activity: chatActivity, now: Date.now() });
  const copyChat = (taskId: string, what: "title" | "conversation" | "answer" | "id") => void (async () => {
    let text = what === "title" ? taskName(taskId) : what === "id" ? taskId : "";
    if (what === "conversation" || what === "answer") {
      const turns = await chatTranscript(taskId);
      text = what === "conversation" ? chatMarkdown(taskName(taskId), turns)
        : [...turns].reverse().map((turn) => turn.final?.text ?? [...turn.steps].reverse().find((step) => step.text)?.text).find(Boolean) ?? "";
    }
    if (text) await navigator.clipboard.writeText(text);
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // Share: chats stay on this computer, so sharing saves the conversation as a Markdown file
  // (Electron asks where, as for any download).
  const shareChat = (taskId: string) => void (async () => {
    const markdown = chatMarkdown(taskName(taskId), await chatTranscript(taskId));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    link.download = `${taskName(taskId).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "chat"}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // Continue in project: runs stay with their own project, so another project gets a new chat whose
  // composer holds this chat's messages; you pick that project's team or model and send.
  const continueInProject = (taskId: string, targetWorkspaceId: string) => void (async () => {
    const messages = chatMessagesFromDescription(await loadDescription(taskId));
    const text = messages.map((message) => chatMessageReadable(message.text)).join("\n\n").slice(0, 8192);
    setChatSeed({ key: crypto.randomUUID(), workspaceId: targetWorkspaceId, title: `${taskName(taskId)} (continued)`.slice(0, 240), text });
    setPendingChat(null); setInspectedId(""); setDraftTeam(null); setSheet("");
    if (targetWorkspaceId === workspaceId) { setChatTaskId(""); setView("chat"); } else chooseWorkspace(targetWorkspaceId);
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // Open in new window: a read-only live copy of the chat (see chat-window.tsx); kept current below.
  const [chatWindowIds, setChatWindowIds] = useState<string[]>([]);
  const pushChatWindow = async (taskId: string, mode: "open" | "update") => {
    const launcher = window.codexWebLauncher;
    if (!launcher?.showChatWindow) throw new Error("Update Coding Tools to open chats in a new window");
    const title = taskName(taskId), turns = await chatTranscript(taskId);
    const result = await launcher.showChatWindow({ key: taskId, title, page: chatWindowPage(title, turns), body: chatWindowBody(title, turns), mode });
    setChatWindowIds((current) => result.open ? (current.includes(taskId) ? current : [...current, taskId]) : current.filter((id) => id !== taskId));
  };
  const openChatWindow = (taskId: string) => void pushChatWindow(taskId, "open")
    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  const openFolder = (item: ThreadWorkspace) => {
    if (item.path) void window.codexWebLauncher?.openFolder?.(item.path).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  // A finished card's thinking and tool calls, read back from AO when its folded work is opened.
  const loadChatWork = useCallback(async (runId: string, nodeId: string) => {
    if (!workspaceId) return [];
    const result = await moduleCall("turn_timeline", { workspaceId, runId, nodeId }) as { timeline?: ChatLiveItem[] };
    return Array.isArray(result?.timeline) ? result.timeline : [];
  }, [workspaceId]);
  const restartChatRun = (runId: string) => void run("restart-run", async () => {
    // Retry and Restart run on the model picked now, as the next message would.
    const result = await moduleCall("restart_run", { workspaceId, runId, ...executableArg(),
      ...(composerMode === "single" && singleRoute.model && singleRoute.model !== "default" ? { singleRoute: { ...singleRoute } as unknown as JsonObject } : {}) });
    if (result.cancelled || !currentRun()) return;
    if (typeof result.runId === "string") setSelectedRunId(result.runId);
    if (result.status === "failed" && typeof result.detail === "string") setError(result.detail);
    setAutoStatus(typeof result.status === "string" ? result.status : "running");
    await loadMissions(workspaceId);
  });

  // Stop shows at once, as Claude Code's Esc does: the run reads as stopped (chatRunStopping) while
  // the stop goes through. It is not run(): its one-action lock dropped a Stop clicked while anything
  // else was in flight, and the stop's agent interrupts and reloads took seconds before anything changed.
  const stopChatRun = (runId: string) => {
    if (stoppingRuns.includes(runId)) return;
    const owner = workspaceId;
    setStoppingRuns((current) => [...current, runId]);
    if (selectedRun?.id === runId) setAutoStatus("held");
    setError(null);
    void moduleCall("control_run", { workspaceId: owner, runId, action: "stop" })
      .then(() => loadMissions(owner))
      // Not stopped after all: the error says why, and a fresh read shows the run as it really is.
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return loadMissions(owner).catch(() => undefined);
      })
      .finally(() => setStoppingRuns((current) => current.filter((id) => id !== runId)));
  };

  const approve = (approval: AoApproval, reply: ApprovalReply) => {
    const owner = approvalScope.current;
    if (!mounted.current || owner.workspaceId !== workspaceId || owner.runId !== selectedRun?.id
      || selection.current.workspaceId !== owner.workspaceId || selection.current.runId !== owner.runId
      || !shownApprovals.some(item => item.nodeId === approval.nodeId && item.approval_id === approval.approval_id)) return;
    void run("approval", async () => {
      const result = await moduleCall("approve_harness", { workspaceId: owner.workspaceId, runId: owner.runId,
        nodeId: approval.nodeId, approvalId: approval.approval_id,
        ...(typeof reply === "boolean" ? { allow: reply }
          // The person's answer to a question the AO agent asked.
          : approval.kind === "question" && approval.source === "ao" ? { answer: reply as JsonObject }
          : typeof (reply as { decisionId?: unknown }).decisionId === "string" ? { decisionId: (reply as { decisionId: string }).decisionId }
            : { response: reply as JsonObject, threadId: approval.thread_id!, turnId: approval.turn_id! }) })
        // Answered already (by the reviewer, or in another window) before this click arrived: the
        // card just goes, as the next poll would take it away; it is not an error to report.
        // An AO tool request says "AO tool request is no longer pending": seen in the launcher log on a
        // list_windows card clicked while its reviewer was still answering, it showed as an error.
        // Nor can one be answered once its agent stopped (CHAT_CONTROLLER_NOT_READY): the chat's turn
        // says the agent stopped, and Allow failed on each click.
        .catch((cause: unknown) => {
          if (/CHAT_REQUEST_NOT_PENDING|CHAT_CONTROLLER_NOT_READY|no longer waiting|no longer pending/.test(cause instanceof Error ? cause.message : String(cause))) return {} as Record<string, unknown>;
          throw cause;
        });
      if (!result.cancelled && mounted.current && selection.current.workspaceId === owner.workspaceId && selection.current.runId === owner.runId) {
        setPendingApprovals((current) => current.filter((item) => item.nodeId !== approval.nodeId || item.approval_id !== approval.approval_id));
      }
    });
  };

  const finished = !selectedRun || selectedRun.nodes.every(node => node.state === "finished" || (node.role === "retry" && node.state === "pending"));
  const canStart = Boolean(selectedRun) && !selectedRun!.cancelled && !finished && !["starting", "running"].includes(autoStatus) && !busy;
  const statusText = selectedRun?.cancelled ? "stopped" : autoStatus;
  const visibleNodes = aoVisibleNodes(selectedRun?.nodes ?? [], showInactive);
  const showingHistory = !showInactive && visibleNodes.length > 0 && visibleNodes.every(node => ["cancelled", "archived"].includes(node.state));
  const workers = selectedRun?.nodes.filter(node => node.role === "worker") ?? [];
  const switchToWorkspace = (id: string) => {
    setWorkspaceId(id);
    setChatTaskId(null);
    if (pane) return;
    try { localStorage.setItem("coding-tools:ao:workspace", id); } catch { /* Selection still works for this session. */ }
  };
  const chooseWorkspace = (id: string) => {
    // A chat clicked in a project still loading gives way to whatever is chosen now: a project, a
    // new chat in one, a conversation continued there. Only that click's own switch keeps it.
    switchTarget.current = ""; pendingSelect.current = null;
    // A project chosen inside a split pane opens a new chat there. Keeping the old pane target
    // left selection waiting for that project's load while the parent waited for selection.
    if (pane) paneWanted.current = { workspaceId: id, taskId: "" };
    switchToWorkspace(id);
  };
  // A chat opened from another project's rows in the list. As in Codex the open chat stays until the
  // clicked one can show: that project's board and runs are read first, then the switch applies them
  // at once and opens the chat (switching first showed the empty project, its new chat page, and
  // only then the chat). `switchTarget` is the project being read, so a later click wins.
  const pendingSelect = useRef<{ workspaceId: string; taskId: string } | null>(null);
  const switchTarget = useRef("");
  const selectChatIn = (id: string, taskId: string) => {
    // A cached row of the project just switched to (its runs not read yet) waits like another
    // project's: selecting it now set a chat with no run, and the load then picked another chat's run.
    if (id === workspaceId && loadedWorkspace === workspaceId) { selectChat(taskId); return; }
    if (id === workspaceId) { pendingSelect.current = { workspaceId: id, taskId }; return; }
    pendingSelect.current = { workspaceId: id, taskId };
    switchTarget.current = id;
    void Promise.all([moduleCall("board", { workspaceId: id }), moduleCall("runs", { workspaceId: id })])
      .then(([projectBoard, projectRuns]) => {
        if (switchTarget.current === id) preloaded.current = { workspaceId: id, board: projectBoard as unknown as Board, runs: projectRuns };
      }, () => undefined)
      .then(() => {
        // A failed read switches anyway; the project then loads as any switch does.
        if (switchTarget.current !== id) return;
        switchTarget.current = "";
        switchToWorkspace(id);
      });
  };
  // The open chat moved to another project (its agent's move_chat): follow it there.
  useEffect(() => onAoPush((change) => {
    const moved = change.moved?.find((entry) => entry.from === workspaceId && entry.taskId === chatTaskId);
    if (moved) selectChatIn(moved.to, moved.taskId);
  }), [workspaceId, chatTaskId, loadedWorkspace]);
  useEffect(() => {
    const pending = pendingSelect.current;
    if (!pending || pending.workspaceId !== workspaceId) return;
    const chats = chatList(missions, board?.tasks ?? [], taskLifecycle);
    if (!chats.some((entry) => entry.taskId === pending.taskId)) {
      // Gone from the project once it loaded (archived or deleted meanwhile): open what a switch opens.
      if (loadedWorkspace !== workspaceId || boardWorkspace.current !== workspaceId) return;
      pendingSelect.current = null;
      // Opened as a click opens a chat, so the chat view shows it even from the board or overview.
      const latest = chatList(missions.filter((mission) => mission.workspace_id === workspaceId), board?.tasks ?? [], taskLifecycle)[0];
      if (latest) selectChat(latest.taskId);
      else { setChatTaskId(""); setView("chat"); }
      return;
    }
    pendingSelect.current = null;
    selectChat(pending.taskId);
  }, [missions, board, taskLifecycle, workspaceId, loadedWorkspace]);
  // A split pane shows the chat the window chose for it (a sidebar click while it was focused).
  useEffect(() => {
    if (!pane) return;
    paneWanted.current = { workspaceId: pane.workspaceId, taskId: pane.taskId };
    if (pane.workspaceId !== workspaceId) { switchToWorkspace(pane.workspaceId); return; }
    if (chatTaskId === null || chatTaskId === pane.taskId) return;
    if (pane.taskId) selectChat(pane.taskId); else startNewChat();
  }, [pane?.workspaceId, pane?.taskId]);
  // ...and tells it which chat it opened itself (a new chat's first send, a project picked in it).
  useEffect(() => {
    if (!pane || chatTaskId === null || loadedWorkspace !== workspaceId) return;
    paneWanted.current = { workspaceId, taskId: chatTaskId };
    if (pane.workspaceId !== workspaceId || pane.taskId !== chatTaskId) pane.onChat(workspaceId, chatTaskId);
  }, [chatTaskId, workspaceId, loadedWorkspace]);
  // Another project's chats for its open row in the list, without switching to it.
  const loadProjectChats = useCallback(async (id: string) => {
    const [projectBoard, projectRuns] = await Promise.all([moduleCall("board", { workspaceId: id }), moduleCall("runs", { workspaceId: id })]);
    return chatList(Array.isArray(projectRuns.runs) ? projectRuns.runs as AoMission[] : [],
      (projectBoard as unknown as Board).tasks ?? [], (projectRuns.task_lifecycle as TaskLifecycleView[]) || []);
  }, []);
  // A chat that finishes or needs you while another is open is marked unread, as in Codex.
  const lastChatStatus = useRef<Record<string, string>>({});
  useEffect(() => {
    // The window's Surface keeps the unread marks; a chat shown in any pane is being read.
    if (pane) return;
    for (const entry of chatList(missions, allTasks, taskLifecycle)) {
      const before = lastChatStatus.current[entry.taskId];
      if (before && before !== entry.status && ["done", "attention", "stopped"].includes(entry.status) && entry.taskId !== chatTaskId
        && !splitPanes.some((item) => item.taskId === entry.taskId)) markUnread(entry.taskId, true);
      lastChatStatus.current[entry.taskId] = entry.status;
    }
  }, [missions]);
  // The chat list's clock (its "5m ago" times, and the refresh of other open projects' chats) stops
  // while the window is hidden and ticks as soon as it is shown again. Minimized, each tick's reads
  // were refused ("Open the Coding Tools window (not minimized)": 9 board + runs pairs a minute
  // apart in the launcher log).
  useEffect(() => {
    const tick = () => { if (!pageHidden()) setListNow(Date.now()); };
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  // Every message names how its card runs; working cards also show runtime and current step.
  // A single-model chat's one card is stored as the planner; it is no orchestrator, so no role is shown.
  const describeChatNode = useCallback((node: ChatNode, run?: ChatRun) => node.route
    ? cardMeta(node as unknown as AoNode, harnesses, run?.execution_mode !== "single") : "", [harnesses]);
  const [chatActivity, setChatActivity] = useState<Record<string, ChatActivity>>({});
  // Only runs of the open project: right after a project switch `missions` still holds the previous
  // one's, and asking this workspace for them failed every second ("AO run not found in this workspace").
  const workingRunIds = (view === "overview" && inspectedId && selectedRun ? [selectedRun] : missions.filter(mission => mission.project_id === chatTaskId))
    // A cancelled run works no more, whatever its cards were left saying: three such runs whose
    // cards stayed "running" kept this one-second poll going for good.
    .filter(mission => mission.workspace_id === workspaceId && !mission.cancelled
      && mission.nodes.some(node => ["running", "reserved"].includes(node.state))).map(mission => mission.id).join(",");
  useEffect(() => {
    if (!workspaceId || !workingRunIds) return;
    let live = true;
    let reading = false;
    const poll = async () => {
      if (reading || surfaceHidden()) return;
      reading = true;
      try {
        const frames = await Promise.all(workingRunIds.split(",").map(async runId => {
          try {
            const result = await moduleCall("activity", { workspaceId, runId }) as { nodes?: Record<string, ChatActivity> };
            return Object.entries(result.nodes ?? {}).map(([nodeId, value]) => [`${runId}:${nodeId}`, value] as const);
          } catch { return []; }
        }));
        // Unchanged frames and items keep their objects (mergeActivityFrames), so neither the surface
        // nor an unchanged row re-renders.
        const next = Object.fromEntries(frames.flat());
        if (live) setChatActivity(current => mergeActivityFrames(current, next));
      } finally { reading = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    // An AO session moving (a role streamed text, started a tool, finished) reads again soon. A fast
    // model moves its session on every pulse (150 ms), and reading at once plus 300 ms later for
    // each one read the conversation many times a second; a burst now gets one read, 300 ms after
    // it began (the activity read answers from its last frame while it fetches, so this also
    // collects the frame the burst's first read started).
    let follow: number | undefined;
    const stopPush = onAoPush((change) => {
      if (!change.sessions.length || follow !== undefined) return;
      follow = window.setTimeout(() => { follow = undefined; void poll(); }, 300);
    });
    return () => { live = false; window.clearInterval(timer); window.clearTimeout(follow); stopPush(); };
  }, [workspaceId, workingRunIds]);
  // Chats open in their own window follow along: re-render and push shortly after they change.
  // A push to a window the user closed answers open:false, which drops it from the list.
  useEffect(() => {
    if (!chatWindowIds.length) return;
    const timer = window.setTimeout(() => {
      for (const id of chatWindowIds) void pushChatWindow(id, "update").catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [missions, chatActivity, chatWindowIds]);

  const chatRunsHere = missions.filter(mission => mission.workspace_id === workspaceId && mission.project_id === chatTaskId);
  const chatCommands: ChatCommands = {
    goal: chatTaskId ? goals[chatTaskId] ?? null : null,
    goalAction: async (action) => {
      if (!chatTaskId) throw new Error("Open a chat first");
      await moduleCall("chat_goal", { workspaceId, taskId: chatTaskId, action });
      await loadMissions(workspaceId);
    },
    wakeup: chatTaskId ? wakeups[chatTaskId] ?? null : null,
    cancelWakeup: async () => {
      const wakeup = chatTaskId ? wakeups[chatTaskId] : undefined;
      if (!chatTaskId || !wakeup) return;
      await moduleCall("chat_wakeup", { workspaceId, taskId: chatTaskId, action: "cancel", id: wakeup.id });
      await loadMissions(workspaceId);
    },
    editWakeup: async ({ reason, minutes }) => {
      const wakeup = chatTaskId ? wakeups[chatTaskId] : undefined;
      if (!chatTaskId || !wakeup) throw new Error("This wake-up already fired");
      await moduleCall("chat_wakeup", { workspaceId, taskId: chatTaskId, action: "edit", id: wakeup.id, reason, minutes });
      await loadMissions(workspaceId);
    },
    loop: chatTaskId ? loops[chatTaskId] ?? null : null,
    startLoop: async ({ prompt, minutes }) => {
      if (!chatTaskId) throw new Error("Open a chat first");
      await moduleCall("chat_loop", { workspaceId, taskId: chatTaskId, action: "start", prompt, minutes });
      await loadMissions(workspaceId);
    },
    stopLoop: async () => {
      if (!chatTaskId) return;
      await moduleCall("chat_loop", { workspaceId, taskId: chatTaskId, action: "stop" });
      await loadMissions(workspaceId);
    },
    goalEdit: async (objective) => {
      if (!chatTaskId) throw new Error("Open a chat first");
      await moduleCall("chat_goal", { workspaceId, taskId: chatTaskId, action: "edit", objective });
      await loadMissions(workspaceId);
    },
    compact: async (instructions = "") => {
      if (!chatTaskId) throw new Error("Open a chat first");
      const result = await moduleCall("compact_chat", { workspaceId, taskId: chatTaskId, ...(instructions ? { instructions } : {}) });
      await loadBoard(workspaceId);
      const full = (size: number) => Math.round(size / CHAT_CONTEXT_LIMIT * 100);
      return result.compacted
        ? `Context compacted from ${Number(result.before).toLocaleString("en-US")} to ${Number(result.after).toLocaleString("en-US")} characters, now ${full(Number(result.after))}% full.`
        : `Nothing to compact yet. The context is ${Number(result.before).toLocaleString("en-US")} characters, ${full(Number(result.before))}% full.`;
    },
    autoCompact: async (change = {}) => {
      const result = await moduleCall("chat_auto_compact", change);
      return { autoCompact: result.autoCompact !== false, percent: Number(result.percent) || 95, limit: Number(result.limit) || CHAT_CONTEXT_LIMIT };
    },
    context: async () => {
      const description = board?.tasks.find(task => task.id === chatTaskId)?.description ?? "";
      const setting = await moduleCall("chat_auto_compact", {});
      const percent = Number(setting.percent) || 95;
      const used = Math.round(description.length / CHAT_CONTEXT_LIMIT * 100);
      // A compacted chat starts with its summary's heading (compactChat), which says when.
      const compacted = /^Summary of the earlier conversation \(compacted ([^)]+) UTC\)/.exec(description)?.[1];
      const rows: [string, string][] = [
        ["Context", `${description.length.toLocaleString("en-US")} of ${CHAT_CONTEXT_LIMIT.toLocaleString("en-US")} characters (${used}% full)`],
        ["Auto-compact", setting.autoCompact === false ? "Off: a full chat stops until you /compact" : `On: compacts before a message that would fill ${percent}%`],
        ["Last compacted", compacted ? `${compacted} UTC` : "Never"],
      ];
      return { title: "Context", rows, text: "The chat's context is its messages, sent to every new agent session. Each agent also compacts its own session by itself." };
    },
    diff: async () => {
      const result = await moduleCall("chat_diff", { workspaceId });
      const files = Array.isArray(result.files) ? result.files.length : 0;
      const diff = String(result.diff || "");
      if (!diff.trim()) return { title: "Changes", text: (Array.isArray(result.warnings) && result.warnings[0] ? String(result.warnings[0]) : "No uncommitted changes.") + " Untracked files aren't listed." };
      return { title: `Changes · ${files} ${files === 1 ? "file" : "files"}`, mono: true, text: diff + (result.truncated ? "\n… (more changes not shown)" : "") };
    },
    mcp: async () => {
      const items = await listAllWorkspaces();
      const open = items.find(item => item.id === workspaceId);
      if (!open) return { title: "MCP", text: "No project is open." };
      return { title: "MCP", rows: [["Project", open.name], ["Server", open.mcpState], ...(open.mcpLocalPort ? [["Port", `127.0.0.1:${open.mcpLocalPort}`] as [string, string]] : []),
        ["Auth", open.mcpAuthType], ["Tools", open.toolProfile], ["Permissions", `${open.permissionMode} · ${open.approvalMode}`]] };
    },
    status: () => {
      const latestRun = chatRunsHere.at(-1);
      const description = board?.tasks.find(task => task.id === chatTaskId)?.description ?? "";
      const goal = chatTaskId ? goals[chatTaskId] : undefined;
      const rows: [string, string][] = [["Chat ID", chatTaskId || "New chat, not sent yet"]];
      if (latestRun) {
        rows.push(["Run", `${latestRun.id.slice(0, 8)} · ${chatRunsHere.length} ${chatRunsHere.length === 1 ? "run" : "runs"}`]);
        rows.push(["Mode", latestRun.execution_mode === "single" ? "Single model" : `Team · ${latestRun.team?.name ?? "saved team"}`]);
        for (const node of latestRun.nodes) rows.push([node.settings?.name || node.role, `${describeChatNode(node as unknown as ChatNode, latestRun as unknown as ChatRun)} · ${node.state}`]);
      } else rows.push(["Mode", composerMode === "single" ? `Single model · ${singleRoute.model}` : "Team"]);
      if (chatTaskId) rows.push(["Context", `${description.length.toLocaleString("en-US")} of ${CHAT_CONTEXT_LIMIT.toLocaleString("en-US")} characters (${Math.round(description.length / CHAT_CONTEXT_LIMIT * 100)}% full)`]);
      rows.push(["Goal", goal ? `${GOAL_SUMMARY[goal.status]} · round ${goalRounds(goal)} · ${goalElapsed(goal.startedAt)} · ${goal.objective}` : "None"]);
      rows.push(["Plan mode", planMode ? "On" : "Off"]);
      return { title: "Status", rows };
    },
    recent: () => {
      const recent = chatList(missions.filter(mission => mission.workspace_id === workspaceId), board?.tasks ?? [], taskLifecycle).filter(entry => entry.taskId !== chatTaskId).slice(0, 12);
      return recent.length ? { title: "Resume a chat", items: recent.map(entry => ({ label: entry.title, detail: entry.status, run: () => selectChat(entry.taskId, "chat") })) }
        : { title: "Resume a chat", text: "No other chats in this project." };
    },
    planMode, setPlanMode,
  };

  // Archived chats of every project, for the list's Archived section (grouped by project there).
  // Reading them also moves chats archived longer than the set days to "deleted", so it runs when
  // the list opens, after any chat is archived or restored here, and hourly.
  const [archivedAll, setArchivedAll] = useState<{ days: number; idleDays: number; chats: ArchivedChat[] } | null>(null);
  const workspaceIds = workspaces.map((item) => item.id).join("\n");
  const archivedKey = taskLifecycle.map((item) => `${item.task_id}:${item.visibility}`).join(",");
  const loadArchived = useCallback(async () => {
    if (!workspaceIds) return;
    const result = await moduleCall("archived_chats", { workspaceIds: workspaceIds.split("\n") }).catch(() => null);
    if (result && Array.isArray(result.chats)) setArchivedAll({ days: Number(result.days) || 0, idleDays: Number(result.idleDays) || 0, chats: result.chats as ArchivedChat[] });
  }, [workspaceIds]);
  useEffect(() => {
    void loadArchived();
    const timer = window.setInterval(() => { void loadArchived(); }, 3_600_000);
    return () => window.clearInterval(timer);
  }, [loadArchived, archivedKey]);
  const restoreArchived = (id: string, taskId: string) => void (async () => {
    if (id === workspaceId) { missionAction(taskId, "restore"); return; }
    await moduleCall("restore_task", { workspaceId: id, taskId });
    await loadArchived();
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  const setArchiveDays = (change: { days?: number; idleDays?: number }) => void (async () => {
    const result = await moduleCall("archive_settings", change);
    setArchivedAll((current) => current && { ...current, days: Number(result.days), idleDays: Number(result.idleDays) });
    await loadArchived();
  })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));

  // What the chat list and the open chat are given stays the same object until it changes. Built
  // inline it was new on every render (each second's activity read, each poll), and the open chat
  // rebuilds its whole transcript from it, so a project switch rebuilt the conversation many times.
  const shownMissions = useMemo(() => stoppingRuns.length
    ? missions.map((mission) => stoppingRuns.includes(mission.id) ? chatRunStopping(mission) : mission) : missions, [missions, stoppingRuns]);
  const threadChats = useMemo(() => chatList(shownMissions, allTasks, taskLifecycle), [shownMissions, allTasks, taskLifecycle]);
  const threadArchived = useMemo(() => chatArchived(shownMissions, allTasks, taskLifecycle), [shownMissions, allTasks, taskLifecycle]);
  const chatRuns = useMemo(() => {
    const replaced = new Map<string, string>();
    for (const item of taskLifecycle) {
      for (const intent of item.reconfigure || []) {
        const id = intent.replacement_run_id;
        if (id && !replaced.has(id)) replaced.set(id, intent.previous_run_id);
      }
    }
    return shownMissions.map(mission => ({ ...mission, replaces_run_id: replaced.get(mission.id) }));
  }, [shownMissions, taskLifecycle]);
  // The chat's actions call the current handlers through this ref, so the objects it holds keep
  // their identity across renders (they are only called after a render has committed).
  const chatHandlers = useRef({ openNewChat, renameChat, missionAction, forkChat, rewindChat, deleteChatMessage, copyChat, togglePin, restartChatRun, stopChatRun });
  useLayoutEffect(() => {
    chatHandlers.current = { openNewChat, renameChat, missionAction, forkChat, rewindChat, deleteChatMessage, copyChat, togglePin, restartChatRun, stopChatRun };
  });
  const chatPinned = Boolean(chatTaskId && chatPins.includes(chatTaskId));
  const chatThread = useMemo(() => {
    if (!chatTaskId) return undefined;
    return {
      newChat: () => chatHandlers.current.openNewChat(),
      rename: (title: string) => chatHandlers.current.renameChat(chatTaskId, title),
      archive: () => chatHandlers.current.missionAction(chatTaskId, "archive"),
      fork: (turnIndex?: number | "first") => chatHandlers.current.forkChat(chatTaskId, turnIndex),
      rewind: (turnIndex: number) => chatHandlers.current.rewindChat(chatTaskId, turnIndex),
      deleteMessage: (messageIndex: number, runIds: string[]) => chatHandlers.current.deleteChatMessage(chatTaskId, messageIndex, runIds),
      copyConversation: () => chatHandlers.current.copyChat(chatTaskId, "conversation"),
      togglePin: () => chatHandlers.current.togglePin(chatTaskId),
      pinned: chatPinned,
    };
  }, [chatTaskId, chatPinned]);
  const restartChat = useCallback((runId: string) => chatHandlers.current.restartChatRun(runId), []);
  const stopChat = useCallback((runId: string) => chatHandlers.current.stopChatRun(runId), []);

  return (
    <section className={pane ? "ao-workflow cx-pane-surface" : "ao-workflow"} aria-label={copy.title} lang={language}>
      {pane ? null : <ChatThreadList workspaces={workspaces.map((item) => ({ id: item.id, name: item.name, path: item.path }))} workspaceId={workspaceId} onWorkspace={chooseWorkspace}
        chats={threadChats} archived={threadArchived} selectedTaskId={focusedSplit ? focusedSplit.taskId : chatTaskId ?? ""} now={listNow}
        archivedAll={archivedAll ?? undefined} restoreArchived={restoreArchived} setArchiveDays={setArchiveDays}
        pinned={chatPins} togglePin={togglePin} unread={chatUnread} setUnread={markUnread}
        pinnedProjects={projectPins} toggleProjectPin={toggleProjectPin}
        busyTaskIds={chatBusy} openTaskIds={[chatTaskId ?? "", ...splitPanes.map((item) => item.taskId)].filter(Boolean)} pendingTitle={pendingChat && !pendingChat.taskId ? pendingChat.title : undefined}
        actions={{ select: (taskId) => showChat(workspaceId, taskId), newChat: () => openNewChat(), rename: renameChat,
          lifecycle: missionAction, archiveAll: archiveAllChats,
          fork: (taskId, from) => forkChat(taskId, from === "first" ? "first" : undefined), copy: copyChat,
          openStructure: (taskId) => selectChat(taskId, "overview"), openBoard: () => { setSheet(""); setView("board"); }, openFolder,
          openSettings: () => setSettingsOpen(true),
          continueIn: continueInProject, share: shareChat, openWindow: openChatWindow,
          openSplit: (id, taskId) => openInSplit(id || workspaceId, taskId),
          // Another project's new chat goes through the same seed as "Continue in", with an empty draft.
          newChatIn: (id) => openNewChat(id),
          editProject: (id) => setProjectEdit({ id, step: "edit" }),
          removeProject: (id) => setProjectEdit({ id, step: "remove" }),
          selectIn: (id, taskId) => showChat(id, taskId) }}
        loadProjectChats={loadProjectChats} chatsLoading={loadedWorkspace !== workspaceId}
        projectRemote={(folder) => window.codexWebLauncher?.projectRemote?.(folder) ?? Promise.resolve(null)}
        projectGit={readProjectGit} />}
      <div className="ao-main">
      {/* A pane sits inside the window's own chat area: only that one holds the window's drag strip. */}
      {pane ? null : <div className="ao-dragstrip" aria-hidden="true" />}
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
        {sheet === "schedule" && scheduleTarget ? <FloatingSheet stage={stageRef} title="Schedule start" onClose={closeSheet}>
          <form className="ao-sheet" onSubmit={event=>{event.preventDefault();submitSchedule();}}>
            <label>Start after<input type="number" min={1} step={1} value={startDelay} onChange={event=>setStartDelay(Number(event.target.value))} /></label>
            <label>Unit<select value={delayUnit} onChange={event=>setDelayUnit(event.target.value)}>
              <option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option>
            </select></label>
            <p className="ao-hint ao-wide">Runs once while the app stays open. If a start is missed, schedule it again.</p>
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
          {missionTeam ? <p className="ao-chip-line ao-wide" title="Edit roles on the Orchestrator Team page">
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
            <label className="ao-set-row" title="Codex executable for Native Codex and WebGPT agents">
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
            <label className="ao-set-row ao-set-toggle" title="Show cancelled and archived cards">
              <span className="ao-set-icon" aria-hidden="true">👁️</span>
              <span>Cancelled cards</span>
              <input type="checkbox" role="switch" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
            </label>
            <label className="ao-set-row ao-set-toggle" title="Hard-link the project's node_modules into each agent's worktree instead of reinstalling. Same drive only. An npm install there replaces only the worktree's copy, but editing a package file in place changes the project's. Skipped when package.json or the lockfile differs.">
              <span className="ao-set-icon" aria-hidden="true">📦</span>
              <span>Reuse installed Node packages</span>
              <input type="checkbox" role="switch" checked={depSettings?.enabled !== false} disabled={depSettings === null} onChange={(event) => changeDepSetting("enabled", event.target.checked)} />
            </label>
            <label className="ao-set-row ao-set-toggle" title="Link the project's .venv or venv into each agent's worktree. It's shared, so a pip install there changes the project's environment. Skipped when requirements differ. Off: agents make their own.">
              <span className="ao-set-icon" aria-hidden="true">🐍</span>
              <span>Share the Python environment</span>
              <input type="checkbox" role="switch" checked={depSettings?.python === true} disabled={depSettings === null} onChange={(event) => changeDepSetting("python", event.target.checked)} />
            </label>
            <p className="ao-set-row ao-set-note" title={harnessNotice || undefined}>
              <span className="ao-set-icon" aria-hidden="true">🧩</span>
              <span>{harnesses.filter(item => item.runnable).length} agents ready{harnessNotice ? " ⚠️" : ""}</span>
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

        {/* The split view holds every view of the window's own pane (chat, Mission Board, team
            graph), so the other panes stay open while that pane shows the board, as Claude Code's do. */}
        <ChatSplit focused={focusedPane} onFocus={setFocusedPane}
          weights={splitWeightsSaved} onWeights={setSplitWeightsSaved} rowSplit={splitRow} onRowSplit={setSplitRow}
          maxColumns={splitMaxCols} onMaxColumns={setSplitMaxCols}
          onDropChat={pane ? undefined : (chat, target) => openInSplit(chat.workspaceId || workspaceId, chat.taskId, target)}
          onMovePane={pane ? undefined : moveSplitPane}
          panes={pane ? [] : splitPanes.map((item) => ({ ...item, content: <AgentOrchestratorSurface language={language} setError={setError}
            pane={{ workspaceId: item.workspaceId, taskId: item.taskId, onNewChat: (id) => newChatInPane(item.id, id), onClose: () => closeSplitPane(item.id),
              onChat: (id, taskId) => setSplitPanes((current) => current.map((entry) => entry.id === item.id ? { ...entry, workspaceId: id, taskId } : entry)) }} /> }))}>
        {view === "chat" ? (
          !workspaceId && workspaceReady
            ? <div className="ao-empty-state"><p>{copy.noWorkspace}</p><button className="button-primary" type="button" onClick={() => setSheet("settings")}>{copy.settings}</button></div>
            : <AgentOrchestratorChat
                onClosePane={pane ? pane.onClose : splitPanes.length ? () => closeSplitPane("main") : undefined}
                runs={chatRuns}
                tasks={allTasks} selectedTaskId={chatTaskId ?? ""} deciding={chatTaskId === null}
                projectLoadError={projectLoadError} onRetryProject={() => setProjectLoadRevision((value) => value + 1)} onComposing={prewarmOnTyping}
                projectName={workspaces.find((item) => item.id === workspaceId)?.name} projectBranch={projectBranch}
                stop={stopChat} restart={restartChat} loadWork={loadChatWork}
                thread={chatThread}
                onPause={() => controlRun("pause")} onResume={() => controlRun("resume")} onSettings={() => openSheet("settings")}
                onOpenProject={(() => { const open = workspaces.find((item) => item.id === workspaceId); return open?.path ? () => openFolder(open) : undefined; })()}
                projects={workspaces.map((item) => ({ id: item.id, name: item.name, path: item.path }))} projectId={workspaceId}
                onPickProject={(id, carried) => { setChatSeed({ key: crypto.randomUUID(), workspaceId: id, title: carried.title, text: carried.text }); chooseWorkspace(id); }}
                onAddProject={addProjectFromFolder}
                filePath={(file) => window.codexWebLauncher?.filePath?.(file) ?? ""}
                saveAttachment={async (input) => {
                  const save = window.codexWebLauncher?.saveAttachment;
                  if (!save) throw new Error("Attach pasted files in the desktop app");
                  return save(input);
                }}
                revealFile={(file) => {
                  void window.codexWebLauncher?.revealFile?.(file).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
                attachmentPreview={(file) => window.codexWebLauncher?.attachmentPreview?.(file) ?? Promise.reject(new Error("Previews show in the desktop app"))}
                structure={selectedRun && chatTaskId && selectedRun.project_id === chatTaskId ? <AgentOrchestratorCanvas key={`chat-${selectedRun.id}`}
                  nodes={visibleNodes} levels={aoLevels(selectedRun).map(level => level.filter(node => visibleNodes.includes(node)))}
                  selectedId="" busy={Boolean(busy)} describe={describeNode}
                  loop={missionLoop(selectedRun, visibleNodes)} points={selectedRun.team?.link_points}
                  /* Selecting or dragging a card in the side panel stays in the chat;
                     the header has its own Mission Board button. */
                  onSelect={() => {}} onMove={moveCard}
                  onConnect={addDependency} canConnect={(nodeId, parentId) => Boolean(aoDependencyChange(selectedRun, nodeId, parentId))}
                  onUnlink={unlink} canUnlink={(nodeId, parentId) => Boolean(aoUnlinkChange(selectedRun, nodeId, parentId))}
                  onRemove={removeCard} canRemove={(nodeId) => Boolean(aoRemoveChange(selectedRun, nodeId))} /> : undefined}
                busy={Boolean(busy)} loadDescription={loadDescription} send={sendChat} steer={steerChat} queue={chatQueue} commands={chatCommands}
                // A new chat's team sits in the header, as Codex keeps the page free of setting bars.
                headerExtra={chatTaskId === "" && savedTeams.length ? <label className="cx-head-team" title="Team for this chat">
                  <span>Team</span>
                  <select aria-label="New chat team" disabled={Boolean(busy)} value={missionTeamId || team?.id || ""} onChange={event => setMissionTeamId(event.target.value)}>
                    {savedTeams.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === team?.id ? " · Default" : ""}</option>)}
                  </select>
                </label> : undefined}
                seed={chatSeed && chatSeed.workspaceId === workspaceId && !chatTaskId ? chatSeed : undefined}
                onSeedUsed={() => setChatSeed(null)}
                pendingMessage={pendingChat && (!pendingChat.taskId || pendingChat.taskId === chatTaskId) ? pendingChat.message : undefined}
                pendingTitle={pendingChat?.title} pendingCreation={Boolean(pendingChat && !pendingChat.taskId)}
                working={Boolean(selectedRun && chatTaskId && selectedRun.project_id === chatTaskId && ["starting", "running"].includes(autoStatus))}
                openStructure={(runId) => { setSelectedRunId(runId); setView("overview"); }}
                approvals={selectedRun && chatTaskId && selectedRun.project_id === chatTaskId ? shownApprovals : []}
                composer={{ mode: composerMode, onModeChange: setComposerMode, route: singleRoute, onRouteChange: pickSingleRoute,
                  harnesses, loadModels, teams: savedTeams, teamId: composerTeamId, onTeamChange: setComposerTeamId }}
                onOpenTeam={openTeam}
                onOpenMissionBoard={() => { setSheet(""); setView("board"); }}
                permissions={<AgentOrchestratorPermissions key={composerMode + ":" + (permissionTeam?.id || "none")} team={permissionTeam} mission={permissionMission} busy={Boolean(busy)}
                  loadProfiles={loadPermissionProfiles} save={savePermissions} runtimePolicies={runtimePolicies} />}
                approve={approve}
                notice={chatTaskId ? chatNotices[chatTaskId] || (selectedRun?.project_id === chatTaskId && ["held", "failed"].includes(autoStatus) ? advanceNotice || undefined : undefined) : undefined}
                warning={chatTaskId && selectedRun?.project_id === chatTaskId ? runWarning || undefined : undefined}
                retryStart={retryChatStart} retrying={Boolean(chatTaskId && chatBusy.includes(chatTaskId))}
                describeNode={describeChatNode} activity={chatActivity} modelName={chatModelName}
                describeRoute={(nodeId, runId) => { const node = missions.find((mission) => mission.id === runId)?.nodes.find((entry) => entry.id === nodeId); return node ? describeNode(node as unknown as CanvasNode) : ""; }} />
        ) : null}

        {view === "board" ? <section className="ao-board-view" aria-label="Mission Board">
          <header><strong>Mission board</strong><button type="button" className="button-secondary" onClick={() => setView("chat")}>Back to chat</button>
            <button type="button" className="button-secondary" onClick={() => setView("overview")}>Team graph</button></header>
          {workspaceReady && workspaceId && !sheet && !projectEdit
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
              loop={missionLoop(selectedRun, visibleNodes)} points={selectedRun.team?.link_points}
              onConnect={addDependency} canConnect={(nodeId, parentId) => Boolean(aoDependencyChange(selectedRun, nodeId, parentId))}
              onUnlink={unlink} canUnlink={(nodeId, parentId) => Boolean(aoUnlinkChange(selectedRun, nodeId, parentId))}
              onRemove={removeCard} canRemove={(nodeId) => Boolean(aoRemoveChange(selectedRun, nodeId))}>
              {shownApprovals.length ? <aside className="ao-approvals ao-canvas-overlay" aria-label="Tool approvals">
                {shownApprovals.map(approval => <AgentOrchestratorApproval key={JSON.stringify([approval.nodeId, approval.approval_id])} approval={approval} busy={Boolean(busy)} approve={approve} />)}
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
            {view === "overview" && workspaceReady && workspaceId && !sheet && !projectEdit
              ? <AgentOrchestratorOriginalSurface projectBoard hostbar={false} workspaceId={workspaceId} openMissions={() => setView("overview")} />
              : sheet || projectEdit ? <div className="ao-empty-state">The mission board returns when you close this dialog.</div> : null}
          </div>
        </OverviewSplit>
        </ChatSplit>
      </div>
      </div>
      {(() => {
        const project = projectEdit && workspaces.find((item) => item.id === projectEdit.id);
        if (!projectEdit || !project) return null;
        return <ProjectEditDialog key={`${project.id}:${projectEdit.step}`} project={project} initialStep={projectEdit.step}
          chooseFolder={window.codexWebLauncher?.chooseFolder ? () => window.codexWebLauncher!.chooseFolder!() : undefined}
          onSave={(change) => saveProjectEdit(project.id, change)} onRemove={() => removeProject(project.id)}
          onClose={() => setProjectEdit(null)}
          readWorkspaceMode={() => workspaceMode(project.id)}
          saveWorkspaceMode={async (mode) => {
            // An unavailable answer (AO stopped, no AO project) must keep the dialog open, not
            // close it as if the choice were saved.
            const saved = await workspaceMode(project.id, mode);
            if (!saved.available || saved.mode !== mode) throw new Error(saved.reason || "Couldn't save where chats work. Try again.");
          }} />;
      })()}
      {settingsOpen && !pane ? <ChatSettingsPage onClose={() => setSettingsOpen(false)} /> : null}
    </section>
  );
}

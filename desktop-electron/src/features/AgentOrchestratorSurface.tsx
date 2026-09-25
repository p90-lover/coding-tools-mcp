import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import type { Language } from "../types";
import "./agent-orchestrator.css";

type Clause = { id: string; title: string; detail?: string; state: string };
type PlanTask = {
  id: string; title: string; description?: string; state: string; step: number;
  lane: string; displayStatus: string; clauses: Clause[];
  clauseProgress: { done: number; total: number };
};
type Board = { revision: number; steps: string[]; tasks: PlanTask[]; task?: PlanTask };
type Draft = { taskId: string; expectedRevision: number; clauses: { title: string; detail: string }[] };
type AoMission = { id: string; revision: number; cancelled: boolean; nodes: { id: string; role: string; state: string; route: { harness_id: string; model: string } }[] };

const lanes = ["building", "validating", "needs_review", "ready"] as const;
const words = {
  en: { title: "Agent Orchestrator", intro: "The existing plan drives AO missions. Execution waits for exact WebGPT and worker harness routes.",
    workspace: "Workspace", refresh: "Refresh", missions: "AO missions", noMissions: "No AO missions saved yet", cancelled: "Cancelled", nodes: "nodes",
    addTitle: "New plan task", addDescription: "What should be done?", create: "Add task",
    manual: "Add clause", review: "Review clauses", apply: "Add reviewed clauses", cancel: "Discard draft",
    clauseTitle: "Clause title", clauseDetail: "Details", remove: "Remove", addAnother: "Add another clause",
    next: "Preview next prompt", noTasks: "No plan tasks yet. Add one here or through workflow_update.",
    building: "Building", validating: "Validating", needs_review: "Needs you", ready: "Ready",
    clauses: "Clauses", noClauses: "No clauses yet", progress: "clauses marked done",
    backlog: "Backlog", in_progress: "In progress", blocked: "Blocked", done: "Done",
    copy: "Copy prompt", source: "Coding Tools plan", stage: "Plan step", execution: "Execution unavailable until AO harness is ready", promptOnly: "Prompt only — no execution" },
  "zh-CN": { title: "代理编排", intro: "现有计划驱动 AO 任务；执行须等待 WebGPT 与工作代理的准确运行路线就绪。",
    workspace: "工作区", refresh: "刷新", missions: "AO 任务", noMissions: "尚无已保存的 AO 任务", cancelled: "已取消", nodes: "节点",
    addTitle: "新计划任务", addDescription: "需要完成什么？", create: "添加任务",
    manual: "添加子条款", review: "审阅子条款", apply: "添加已审阅子条款", cancel: "丢弃草案",
    clauseTitle: "子条款标题", clauseDetail: "详细说明", remove: "移除", addAnother: "再添加一条",
    next: "下一条款", noTasks: "暂无计划任务。可在这里或通过 workflow_update 添加。",
    building: "构建中", validating: "验证中", needs_review: "需要你处理", ready: "已就绪",
    clauses: "子条款", noClauses: "暂无子条款", progress: "已完成",
    backlog: "待办", in_progress: "进行中", blocked: "受阻", done: "完成",
    copy: "复制提示", source: "Coding Tools 计划", stage: "计划步骤", execution: "AO 执行暂不可用，等待执行环境就绪", promptOnly: "仅供参考的提示词，未执行" },
  "zh-TW": { title: "代理編排", intro: "現有計劃驅動 AO 任務；執行須等待 WebGPT 與工作代理的準確運行路線就緒。",
    workspace: "工作區", refresh: "重新整理", missions: "AO 任務", noMissions: "尚無已儲存的 AO 任務", cancelled: "已取消", nodes: "節點",
    addTitle: "新計劃任務", addDescription: "需要完成什麼？", create: "新增任務",
    manual: "新增子條款", review: "審閱子條款", apply: "新增已審閱子條款", cancel: "捨棄草案",
    clauseTitle: "子條款標題", clauseDetail: "詳細說明", remove: "移除", addAnother: "再新增一條",
    next: "下一條款", noTasks: "目前沒有計劃任務。可在此處或透過 workflow_update 新增。",
    building: "建置中", validating: "驗證中", needs_review: "需要你處理", ready: "已就緒",
    clauses: "子條款", noClauses: "尚無子條款", progress: "已完成",
    backlog: "待辦", in_progress: "進行中", blocked: "受阻", done: "完成",
    copy: "複製提示", source: "Coding Tools 計劃", stage: "計劃步驟", execution: "AO 執行暫不可用，等待執行環境就緒", promptOnly: "僅供參考的提示詞，尚未執行" },
  ja: { title: "エージェント編成", intro: "既存の計画が AO ミッションを動かします。実行には WebGPT とワーカーハーネスの正確なルートが必要です。",
    workspace: "ワークスペース", refresh: "更新", missions: "AO ミッション", noMissions: "保存済みの AO ミッションはありません", cancelled: "キャンセル済み", nodes: "ノード",
    addTitle: "新しい計画タスク", addDescription: "何を行いますか？", create: "タスクを追加",
    manual: "小項目を追加", review: "小項目を確認", apply: "確認済み小項目を追加", cancel: "草案を破棄",
    clauseTitle: "小項目の題名", clauseDetail: "詳細", remove: "削除", addAnother: "別の小項目を追加",
    next: "次の小項目", noTasks: "計画タスクがありません。ここか workflow_update から追加できます。",
    building: "作業中", validating: "検証中", needs_review: "確認が必要", ready: "準備完了",
    clauses: "小項目", noClauses: "小項目はありません", progress: "完了",
    backlog: "未着手", in_progress: "進行中", blocked: "停止中", done: "完了",
    copy: "指示をコピー", source: "Coding Tools プラン", stage: "計画ステップ", execution: "AO ハーネスの準備が整うまで実行できません", promptOnly: "プロンプトのみ — 実行されていません" },
} satisfies Record<Language, Record<string, string>>;

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

export function AgentOrchestratorSurface({ language, setError }: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = words[language];
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [missions, setMissions] = useState<AoMission[]>([]);
  const [busy, setBusy] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nextPrompt, setNextPrompt] = useState("");

  const loadMissions = async (id: string) => {
    const current = await moduleCall("runs", { workspaceId: id });
    setMissions(Array.isArray(current.runs) ? current.runs as AoMission[] : []);
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
        const items: WorkspaceSummary[] = [];
        let cursor: number | null = 0;
        while (cursor !== null) {
          const page = await getCodingToolsClient().workspaces.list({ cursor, limit: 100 });
          items.push(...page.items);
          cursor = page.nextCursor;
        }
        if (live) {
          setWorkspaces(items);
          setWorkspaceId(items[0]?.id ?? "");
        }
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { live = false; };
  }, [setError]);

  useEffect(() => {
    if (!workspaceId) { setBoard(null); setMissions([]); return; }
    let live = true;
    setBoard(null);
    setMissions([]);
    setDraft(null);
    void (async () => {
      try {
        const current = await moduleCall("board", { workspaceId }) as unknown as Board;
        if (live) setBoard(current);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
      try {
        const current = await moduleCall("runs", { workspaceId });
        if (live) setMissions(Array.isArray(current.runs) ? current.runs as AoMission[] : []);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { live = false; };
  }, [workspaceId, setError]);

  const run = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };

  const create = () => void run("create", async () => {
    if (!board || !workspaceId || !taskTitle.trim()) return;
    const result = await moduleCall("create", { workspaceId, title: taskTitle, description: taskDescription,
      expectedRevision: board.revision });
    if (result.cancelled) return;
    setTaskTitle(""); setTaskDescription("");
    await loadBoard(workspaceId);
  });

  const apply = () => void run("append", async () => {
    if (!draft) return;
    const result = await moduleCall("append", { workspaceId, taskId: draft.taskId,
      expectedRevision: draft.expectedRevision, clauses: draft.clauses });
    if (result.cancelled) return;
    setDraft(null);
    await loadBoard(workspaceId);
  });

  const move = (operation: "move_task" | "move_clause", taskId: string, state: string, clauseId?: string) =>
    void run(operation, async () => {
      if (!board) return;
      const result = await moduleCall(operation, { workspaceId, taskId, state, ...(clauseId ? { clauseId } : {}),
        expectedRevision: board.revision });
      if (!result.cancelled) await loadBoard(workspaceId);
    });

  const editClause = (index: number, patch: Partial<Draft["clauses"][number]>) =>
    setDraft((current) => current ? { ...current, clauses: current.clauses.map((clause, i) => i === index ? { ...clause, ...patch } : clause) } : null);
  const remainingClauses = draft && board ? 12 - (board.tasks.find((task) => task.id === draft.taskId)?.clauses.length ?? 12) : 0;

  const next = () => void run("next", async () => {
    const result = await moduleCall("next", { workspaceId });
    setNextPrompt(typeof result.prompt === "string" ? result.prompt : "");
  });

  return (
    <section className="ao-workflow" aria-label={copy.title} lang={language}>
      <p className="ao-workflow-intro">{copy.intro}</p>
      <p className="ao-model-note" role="status">{copy.execution}</p>
      <div className="ao-workflow-toolbar">
        <label>{copy.workspace}
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={Boolean(busy)}>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
        <button className="button-secondary" disabled={!workspaceId || Boolean(busy)} onClick={() => void run("refresh", async () => { await Promise.all([loadBoard(workspaceId), loadMissions(workspaceId)]); })} type="button">{copy.refresh}</button>
        <button className="button-secondary" disabled={!board || Boolean(busy)} onClick={next} type="button">{copy.next}</button>
      </div>
      {nextPrompt ? <div className="ao-next"><strong>{copy.promptOnly}</strong><p>{nextPrompt}</p><button className="button-secondary" onClick={() => void navigator.clipboard.writeText(nextPrompt)} type="button">{copy.copy}</button></div> : null}
      <section className="ao-missions" aria-label={copy.missions}>
        <h2>{copy.missions}</h2>
        {missions.length ? missions.map((mission) => <article key={mission.id}>
          <strong>{mission.id}</strong><span>{mission.cancelled ? copy.cancelled : `${mission.nodes.length} ${copy.nodes}`}</span>
          <ul>{mission.nodes.map((node) => <li key={node.id}>{node.role}: {node.state} · {node.route.harness_id}/{node.route.model}</li>)}</ul>
        </article>) : <p>{copy.noMissions}</p>}
      </section>
      <form className="ao-create" onSubmit={(event) => { event.preventDefault(); create(); }}>
        <input aria-label={copy.addTitle} maxLength={240} onChange={(event) => setTaskTitle(event.target.value)} placeholder={copy.addTitle} value={taskTitle} />
        <input aria-label={copy.addDescription} maxLength={8192} onChange={(event) => setTaskDescription(event.target.value)} placeholder={copy.addDescription} value={taskDescription} />
        <button className="button-primary" disabled={!board || !taskTitle.trim() || Boolean(busy)} type="submit">{copy.create}</button>
      </form>
      {!board ? <p className="ao-empty">{workspaceId ? "…" : copy.workspace}</p> : board.tasks.length === 0 ? <p className="ao-empty">{copy.noTasks}</p> : (
        <div className="ao-board" role="region" aria-label={copy.source}>
          {lanes.map((lane) => (
            <section className="ao-lane" key={lane} aria-label={copy[lane]}>
              <header><h2>{copy[lane]}</h2><span>{board.tasks.filter((task) => task.lane === lane).length}</span></header>
              {board.tasks.filter((task) => task.lane === lane).map((task) => (
                <article className="ao-card" key={task.id}>
                  <div className="ao-card-head"><h3>{task.title}</h3><span>{task.displayStatus}</span></div>
                  <p className="ao-card-stage">{copy.stage}: {board.steps[task.step] ?? task.step}</p>
                  <label className="ao-state">{copy.source}
                    <select value={task.state} disabled={Boolean(busy)} onChange={(event) => move("move_task", task.id, event.target.value)}>
                      {(["backlog", "in_progress", "blocked", "done"] as const).map((state) => <option key={state} value={state}>{copy[state]}</option>)}
                    </select>
                  </label>
                  <div className="ao-clauses-head"><strong>{copy.clauses}</strong><span>{task.clauseProgress.done}/{task.clauseProgress.total} {copy.progress}</span></div>
                  {task.clauses.length ? <ul className="ao-clauses">
                    {task.clauses.map((clause) => <li key={clause.id}>
                      <span>{clause.title}</span>
                      <select aria-label={`${clause.title} state`} value={clause.state} disabled={Boolean(busy)} onChange={(event) => move("move_clause", task.id, event.target.value, clause.id)}>
                        {(["backlog", "in_progress", "blocked", "done"] as const).map((state) => <option key={state} value={state}>{copy[state]}</option>)}
                      </select>
                    </li>)}
                  </ul> : <p className="ao-card-empty">{copy.noClauses}</p>}
                  <div className="inline-actions">
                    <button className="button-secondary" disabled={Boolean(busy) || Boolean(draft) || task.clauses.length >= 12} onClick={() => setDraft({ taskId: task.id, expectedRevision: board.revision, clauses: [{ title: "", detail: "" }] })} type="button">{copy.manual}</button>
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
      {draft ? <section className="ao-draft" aria-label={copy.review}>
        <h2>{copy.review}</h2>
        <ol>{draft.clauses.map((clause, index) => <li key={index}>
          <input aria-label={`${copy.clauseTitle} ${index + 1}`} maxLength={240} onChange={(event) => editClause(index, { title: event.target.value })} placeholder={copy.clauseTitle} value={clause.title} />
          <textarea aria-label={`${copy.clauseDetail} ${index + 1}`} maxLength={8192} onChange={(event) => editClause(index, { detail: event.target.value })} placeholder={copy.clauseDetail} value={clause.detail} />
          <button className="button-secondary" disabled={Boolean(busy)} onClick={() => setDraft((current) => current ? { ...current, clauses: current.clauses.filter((_, i) => i !== index) } : null)} type="button">{copy.remove}</button>
        </li>)}</ol>
        <div className="inline-actions">
          <button className="button-secondary" disabled={Boolean(busy) || draft.clauses.length >= remainingClauses} onClick={() => setDraft((current) => current ? { ...current, clauses: [...current.clauses, { title: "", detail: "" }] } : null)} type="button">{copy.addAnother}</button>
          <button className="button-primary" disabled={Boolean(busy) || draft.clauses.length === 0 || draft.clauses.length > remainingClauses || draft.clauses.some((clause) => !clause.title.trim())} onClick={apply} type="button">{copy.apply}</button>
          <button className="button-secondary" disabled={Boolean(busy)} onClick={() => setDraft(null)} type="button">{copy.cancel}</button>
        </div>
      </section> : null}
    </section>
  );
}

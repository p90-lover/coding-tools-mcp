import type { Language } from "../types";

export interface OrchestrationCopy {
  refresh: string;
  refreshing: string;
  workspace: string;
  chooseWorkspace: string;
  provider: string;
  automatic: string;
  account: string;
  model: string;
  defaultModel: string;
  allowHealthyFallback: string;
  previewRoute: string;
  routePreview: string;
  routeUnavailable: string;
  routeReady: string;
  direct: string;
  proxy: string;
  proxySource: string;
  fallbackUsed: string;
  noProviderAccounts: string;
  status: string;
  task: string;
  taskId: string;
  taskModel: string;
  mission: string;
  missions: string;
  controls: string;
  inspect: string;
  start: string;
  hold: string;
  resume: string;
  cancel: string;
  close: string;
  create: string;
  phase: string;
  taskReference: string;
  providerAccount: string;
  selected: string;
  noSelection: string;
  unknown: string;
  paseoTitle: string;
  paseoSubtitle: string;
  paseoSessions: string;
  paseoNewSession: string;
  paseoNoSessions: string;
  paseoNewWorkspace: string;
  paseoComposerTitle: string;
  paseoComposerPlaceholder: string;
  paseoComposerHint: string;
  paseoCreateSession: string;
  paseoPreparing: string;
  paseoActivity: string;
  paseoInspector: string;
  paseoRouteTab: string;
  paseoMissionTab: string;
  paseoNoMissionSelected: string;
  paseoMissionCreationSubmitted: string;
  paseoReadyToStart: string;
  paseoBindingsMissing: string;
  paseoAvailableBindings: string;
  paseoOrchestrator: string;
  paseoSubagents: string;
  paseoAddSubagent: string;
  paseoRemoveSubagent: string;
  paseoSubagentRole: string;
  paseoPlanAssignments: string;
  paseoPlanning: string;
  paseoRunSubagents: string;
  paseoRunningSubagents: string;
  paseoReviewResults: string;
  paseoOpenAnnealTask: string;
  paseoAssignmentTab: string;
  paseoAssignmentPreview: string;
  paseoNoSubagents: string;
  paseoReviewReady: string;
  paseoAnnealTaskOpened: string;
  paseoRecordIssue: string;
  paseoRecordReturn: string;
  annealTitle: string;
  annealSubtitle: string;
  annealTaskBoard: string;
  annealBacklog: string;
  annealTodo: string;
  annealDoing: string;
  annealReview: string;
  annealDone: string;
  annealNoTasks: string;
  annealSelectedTask: string;
  annealSelectTask: string;
  annealDispatch: string;
  annealDispatchThroughPaseo: string;
  annealDispatchDirect: string;
  annealDispatchTask: string;
  annealDispatching: string;
  annealRelatedMissions: string;
  annealNoRelatedMissions: string;
  annealTaskDescription: string;
  annealTaskState: string;
  annealMissionSubmitted: string;
  annealFromPaseoReview: string;
  annealAssignmentPreview: string;
  annealNoAssignment: string;
  executionPlanningUnavailable: string;
  connectApprovedBinding: string;
  phases: Record<string, string>;
}

const EN: OrchestrationCopy = {
  refresh: "Refresh",
  refreshing: "Refreshing…",
  workspace: "Workspace",
  chooseWorkspace: "Choose a workspace",
  provider: "Provider",
  automatic: "Automatic",
  account: "Account",
  model: "Model",
  defaultModel: "Default model",
  allowHealthyFallback: "Allow healthy fallback",
  previewRoute: "Preview route",
  routePreview: "Route preview",
  routeUnavailable: "Preview a route to see the selected provider, account, model, and proxy.",
  routeReady: "Execution route ready",
  direct: "Direct connection",
  proxy: "Proxy",
  proxySource: "Route source",
  fallbackUsed: "Fallback selected",
  noProviderAccounts: "Add and connect a Provider Hub account before dispatching work.",
  status: "Status",
  task: "Task",
  taskId: "Task ID",
  taskModel: "Task model",
  mission: "Mission",
  missions: "Missions",
  controls: "Controls",
  inspect: "Inspect",
  start: "Start",
  hold: "Hold",
  resume: "Resume",
  cancel: "Cancel",
  close: "Close",
  create: "Create",
  phase: "Phase",
  taskReference: "Task reference",
  providerAccount: "Provider account",
  selected: "Selected",
  noSelection: "Nothing selected",
  unknown: "Unknown",
  paseoTitle: "Paseo",
  paseoSubtitle: "Run connected coding agents in a Paseo-style session workspace with explicit Provider Hub routing.",
  paseoSessions: "Sessions",
  paseoNewSession: "New session",
  paseoNoSessions: "No Paseo sessions yet.",
  paseoNewWorkspace: "New workspace",
  paseoComposerTitle: "What should the agent work on?",
  paseoComposerPlaceholder: "Describe the task or enter an existing task ID…",
  paseoComposerHint: "Paseo uses this task reference to prepare a routed mission in the selected workspace.",
  paseoCreateSession: "Create session",
  paseoPreparing: "Preparing…",
  paseoActivity: "Activity",
  paseoInspector: "Inspector",
  paseoRouteTab: "Route",
  paseoMissionTab: "Mission",
  paseoNoMissionSelected: "Select a session to inspect its mission details and controls.",
  paseoMissionCreationSubmitted: "Paseo session creation was submitted. Refresh until it is Ready, then start it.",
  paseoReadyToStart: "The session is ready to start.",
  paseoBindingsMissing: "Connect an approved Paseo provider binding in Providers first.",
  paseoAvailableBindings: "Available bindings",
  paseoOrchestrator: "Main orchestrator",
  paseoSubagents: "Subagents",
  paseoAddSubagent: "Add subagent",
  paseoRemoveSubagent: "Remove",
  paseoSubagentRole: "Role",
  paseoPlanAssignments: "Plan assignments",
  paseoPlanning: "Planning…",
  paseoRunSubagents: "Run subagents",
  paseoRunningSubagents: "Running…",
  paseoReviewResults: "Review results",
  paseoOpenAnnealTask: "Open Anneal task",
  paseoAssignmentTab: "Assignment",
  paseoAssignmentPreview: "Orchestrator → subagent assignment",
  paseoNoSubagents: "Add at least one subagent from a connected provider.",
  paseoReviewReady: "Orchestrator review is ready.",
  paseoAnnealTaskOpened: "Anneal task opened from review findings.",
  paseoRecordIssue: "Record issue",
  paseoRecordReturn: "Record return",
  annealTitle: "Anneal Tasks",
  annealSubtitle: "Queue and dispatch work from an Anneal-style five-column board, then inspect the selected chain and route.",
  annealTaskBoard: "Task board",
  annealBacklog: "Backlog",
  annealTodo: "To do",
  annealDoing: "Doing",
  annealReview: "Review",
  annealDone: "Done",
  annealNoTasks: "No tasks in this column.",
  annealSelectedTask: "Selected task",
  annealSelectTask: "Select a task card to configure its route and dispatch it.",
  annealDispatch: "Dispatch",
  annealDispatchThroughPaseo: "Dispatch through Paseo",
  annealDispatchDirect: "Dispatch directly through Anneal",
  annealDispatchTask: "Dispatch task",
  annealDispatching: "Dispatching…",
  annealRelatedMissions: "Related missions",
  annealNoRelatedMissions: "No related missions.",
  annealTaskDescription: "Description",
  annealTaskState: "Board state",
  annealMissionSubmitted: "Task dispatch was submitted. Refresh until it is Ready, then start it.",
  annealFromPaseoReview: "Opened from Paseo review",
  annealAssignmentPreview: "Assignment preview",
  annealNoAssignment: "This task has no orchestrator→subagent assignment yet.",
  executionPlanningUnavailable: "Provider execution planning is unavailable.",
  connectApprovedBinding: "Connect an approved provider binding first.",
  phases: {
    draft: "Draft",
    ready: "Ready",
    running: "Running",
    held: "Held",
    scheduling_held: "Scheduling held",
    review_required: "Review required",
    changes_requested: "Changes requested",
    accepted: "Accepted",
    cancelled: "Cancelled",
    closed: "Closed",
    failed: "Failed",
    unknown: "Unknown",
  },
};

const ZH_TW: OrchestrationCopy = {
  refresh: "更新",
  refreshing: "更新中…",
  workspace: "工作區",
  chooseWorkspace: "選擇工作區",
  provider: "供應商",
  automatic: "自動選擇",
  account: "帳戶",
  model: "模型",
  defaultModel: "預設模型",
  allowHealthyFallback: "允許健康帳戶後備切換",
  previewRoute: "預覽路由",
  routePreview: "路由預覽",
  routeUnavailable: "預覽路由後，呢度會顯示已選供應商、帳戶、模型同代理設定。",
  routeReady: "執行路由已準備好",
  direct: "直接連線",
  proxy: "代理伺服器",
  proxySource: "路由來源",
  fallbackUsed: "已使用後備帳戶",
  noProviderAccounts: "請先喺供應商中心新增並連線帳戶，之後先可以執行任務。",
  status: "狀態",
  task: "任務",
  taskId: "任務 ID",
  taskModel: "任務模型",
  mission: "工作階段",
  missions: "工作階段",
  controls: "控制",
  inspect: "檢查",
  start: "啟動",
  hold: "暫停排程",
  resume: "繼續",
  cancel: "取消",
  close: "關閉",
  create: "建立",
  phase: "階段",
  taskReference: "任務參照",
  providerAccount: "供應商帳戶",
  selected: "已選取",
  noSelection: "尚未選取",
  unknown: "未知",
  paseoTitle: "Paseo",
  paseoSubtitle: "以 Paseo 式工作階段介面運行已連線嘅 coding agent，並使用明確嘅供應商中心路由。",
  paseoSessions: "Paseo 工作階段",
  paseoNewSession: "新增工作階段",
  paseoNoSessions: "尚未有 Paseo 工作階段。",
  paseoNewWorkspace: "新增工作區",
  paseoComposerTitle: "你想 agent 完成咩工作？",
  paseoComposerPlaceholder: "描述任務，或者輸入現有任務 ID…",
  paseoComposerHint: "Paseo 會使用呢個任務參照，喺所選工作區建立已路由嘅工作階段。",
  paseoCreateSession: "建立工作階段",
  paseoPreparing: "準備中…",
  paseoActivity: "活動",
  paseoInspector: "檢查器",
  paseoRouteTab: "路由",
  paseoMissionTab: "工作階段",
  paseoNoMissionSelected: "選擇一個工作階段，以檢查任務資料同控制選項。",
  paseoMissionCreationSubmitted: "已提交 Paseo 工作階段建立要求。請更新至「準備好」，再啟動工作階段。",
  paseoReadyToStart: "工作階段已準備好，可以啟動。",
  paseoBindingsMissing: "請先喺供應商中心連線已批准嘅 Paseo 供應商綁定。",
  paseoAvailableBindings: "可用綁定",
  paseoOrchestrator: "主協調器",
  paseoSubagents: "子代理",
  paseoAddSubagent: "新增子代理",
  paseoRemoveSubagent: "移除",
  paseoSubagentRole: "角色",
  paseoPlanAssignments: "規劃指派",
  paseoPlanning: "規劃中…",
  paseoRunSubagents: "執行子代理",
  paseoRunningSubagents: "執行中…",
  paseoReviewResults: "審查結果",
  paseoOpenAnnealTask: "開啟 Anneal 任務",
  paseoAssignmentTab: "指派",
  paseoAssignmentPreview: "協調器 → 子代理指派",
  paseoNoSubagents: "請至少從已連線供應商新增一個子代理。",
  paseoReviewReady: "協調器審查已準備好。",
  paseoAnnealTaskOpened: "已從審查發現開啟 Anneal 任務。",
  paseoRecordIssue: "記錄問題",
  paseoRecordReturn: "記錄回傳",
  annealTitle: "Anneal 任務",
  annealSubtitle: "以 Anneal 式五欄任務板整理及執行工作，再檢查所選 chain 同路由。",
  annealTaskBoard: "Anneal 任務板",
  annealBacklog: "待整理",
  annealTodo: "待執行",
  annealDoing: "執行中",
  annealReview: "審查",
  annealDone: "完成",
  annealNoTasks: "呢一欄暫時冇任務。",
  annealSelectedTask: "已選任務",
  annealSelectTask: "選擇任務卡，設定路由並執行任務。",
  annealDispatch: "執行設定",
  annealDispatchThroughPaseo: "透過 Paseo 執行",
  annealDispatchDirect: "直接透過 Anneal 執行",
  annealDispatchTask: "執行任務",
  annealDispatching: "執行中…",
  annealRelatedMissions: "相關工作階段",
  annealNoRelatedMissions: "尚未有相關工作階段。",
  annealTaskDescription: "描述",
  annealTaskState: "任務板狀態",
  annealMissionSubmitted: "已提交任務執行要求。請更新至「準備好」，再啟動工作階段。",
  annealFromPaseoReview: "由 Paseo 審查開啟",
  annealAssignmentPreview: "指派預覽",
  annealNoAssignment: "呢個任務尚未有協調器→子代理指派結構。",
  executionPlanningUnavailable: "供應商執行路由功能目前無法使用。",
  connectApprovedBinding: "請先連線已批准嘅供應商綁定。",
  phases: {
    draft: "草稿",
    ready: "準備好",
    running: "執行中",
    held: "已暫停",
    scheduling_held: "排程已暫停",
    review_required: "需要審查",
    changes_requested: "要求修改",
    accepted: "已接受",
    cancelled: "已取消",
    closed: "已關閉",
    failed: "失敗",
    unknown: "未知",
  },
};

const ZH_CN: OrchestrationCopy = {
  ...ZH_TW,
  refresh: "刷新",
  refreshing: "刷新中…",
  workspace: "工作区",
  chooseWorkspace: "选择工作区",
  provider: "供应商",
  automatic: "自动选择",
  account: "账户",
  defaultModel: "默认模型",
  allowHealthyFallback: "允许健康账户后备切换",
  previewRoute: "预览路由",
  routePreview: "路由预览",
  routeUnavailable: "预览路由后，这里会显示所选供应商、账户、模型和代理设置。",
  routeReady: "执行路由已准备好",
  direct: "直接连接",
  proxy: "代理服务器",
  proxySource: "路由来源",
  fallbackUsed: "已使用后备账户",
  noProviderAccounts: "请先在供应商中心添加并连接账户，然后才能执行任务。",
  mission: "会话",
  missions: "会话",
  controls: "控制",
  inspect: "检查",
  start: "启动",
  hold: "暂停调度",
  resume: "继续",
  close: "关闭",
  create: "创建",
  taskReference: "任务引用",
  providerAccount: "供应商账户",
  selected: "已选择",
  noSelection: "尚未选择",
  paseoSubtitle: "以 Paseo 式会话界面运行已连接的 coding agent，并使用明确的供应商中心路由。",
  paseoSessions: "Paseo 会话",
  paseoNewSession: "新建会话",
  paseoNoSessions: "尚无 Paseo 会话。",
  paseoNewWorkspace: "新建工作区",
  paseoComposerTitle: "你希望 agent 完成什么工作？",
  paseoComposerPlaceholder: "描述任务，或者输入现有任务 ID…",
  paseoComposerHint: "Paseo 会使用这个任务引用，在所选工作区创建已路由的会话。",
  paseoCreateSession: "创建会话",
  paseoPreparing: "准备中…",
  paseoInspector: "检查器",
  paseoMissionTab: "会话",
  paseoNoMissionSelected: "选择一个会话，以检查任务信息和控制选项。",
  paseoMissionCreationSubmitted: "已提交 Paseo 会话创建请求。请刷新到“准备好”，然后启动会话。",
  paseoReadyToStart: "会话已准备好，可以启动。",
  paseoBindingsMissing: "请先在供应商中心连接已批准的 Paseo 供应商绑定。",
  paseoAvailableBindings: "可用绑定",
  paseoOrchestrator: "主协调器",
  paseoSubagents: "子代理",
  paseoAddSubagent: "新增子代理",
  paseoRemoveSubagent: "移除",
  paseoSubagentRole: "角色",
  paseoPlanAssignments: "规划指派",
  paseoPlanning: "规划中…",
  paseoRunSubagents: "执行子代理",
  paseoRunningSubagents: "执行中…",
  paseoReviewResults: "审核结果",
  paseoOpenAnnealTask: "打开 Anneal 任务",
  paseoAssignmentTab: "指派",
  paseoAssignmentPreview: "协调器 → 子代理指派",
  paseoNoSubagents: "请至少从已连接供应商新增一个子代理。",
  paseoReviewReady: "协调器审核已准备好。",
  paseoAnnealTaskOpened: "已从审核发现打开 Anneal 任务。",
  paseoRecordIssue: "记录问题",
  paseoRecordReturn: "记录返回",
  annealSubtitle: "以 Anneal 式五栏任务板整理和执行工作，再检查所选 chain 和路由。",
  annealTaskBoard: "Anneal 任务板",
  annealBacklog: "待整理",
  annealTodo: "待执行",
  annealDoing: "执行中",
  annealReview: "审核",
  annealDone: "完成",
  annealNoTasks: "这一栏暂无任务。",
  annealSelectedTask: "已选任务",
  annealSelectTask: "选择任务卡，设置路由并执行任务。",
  annealDispatch: "执行设置",
  annealDispatchThroughPaseo: "通过 Paseo 执行",
  annealDispatchDirect: "直接通过 Anneal 执行",
  annealDispatchTask: "执行任务",
  annealDispatching: "执行中…",
  annealRelatedMissions: "相关会话",
  annealNoRelatedMissions: "尚无相关会话。",
  annealTaskState: "任务板状态",
  annealMissionSubmitted: "已提交任务执行请求。请刷新到“准备好”，然后启动会话。",
  annealFromPaseoReview: "由 Paseo 审核打开",
  annealAssignmentPreview: "指派预览",
  annealNoAssignment: "这个任务还没有协调器→子代理指派结构。",
  executionPlanningUnavailable: "供应商执行路由功能当前不可用。",
  connectApprovedBinding: "请先连接已批准的供应商绑定。",
  phases: {
    draft: "草稿",
    ready: "准备好",
    running: "执行中",
    held: "已暂停",
    scheduling_held: "调度已暂停",
    review_required: "需要审核",
    changes_requested: "要求修改",
    accepted: "已接受",
    cancelled: "已取消",
    closed: "已关闭",
    failed: "失败",
    unknown: "未知",
  },
};

const JA: OrchestrationCopy = {
  ...EN,
  refresh: "更新",
  refreshing: "更新中…",
  workspace: "ワークスペース",
  chooseWorkspace: "ワークスペースを選択",
  provider: "プロバイダー",
  automatic: "自動選択",
  account: "アカウント",
  model: "モデル",
  defaultModel: "既定モデル",
  allowHealthyFallback: "正常なアカウントへのフォールバックを許可",
  previewRoute: "ルートをプレビュー",
  routePreview: "ルートプレビュー",
  direct: "直接接続",
  status: "状態",
  start: "開始",
  hold: "保留",
  resume: "再開",
  cancel: "キャンセル",
  close: "閉じる",
  paseoSubtitle: "Provider Hub の明示的なルーティングで、Paseo 形式のセッションを実行します。",
  paseoSessions: "Paseo セッション",
  paseoNewSession: "新しいセッション",
  paseoNoSessions: "Paseo セッションはまだありません。",
  paseoNewWorkspace: "新しいワークスペース",
  paseoComposerTitle: "エージェントに何を依頼しますか？",
  paseoComposerPlaceholder: "タスクを説明するか、既存のタスク ID を入力…",
  paseoCreateSession: "セッションを作成",
  paseoOrchestrator: "メインオーケストレーター",
  paseoSubagents: "サブエージェント",
  paseoAddSubagent: "サブエージェントを追加",
  paseoRemoveSubagent: "削除",
  paseoSubagentRole: "役割",
  paseoPlanAssignments: "割り当てを計画",
  paseoPlanning: "計画中…",
  paseoRunSubagents: "サブエージェントを実行",
  paseoRunningSubagents: "実行中…",
  paseoReviewResults: "結果をレビュー",
  paseoOpenAnnealTask: "Anneal タスクを開く",
  paseoAssignmentTab: "割り当て",
  paseoAssignmentPreview: "オーケストレーター → サブエージェント割り当て",
  paseoNoSubagents: "接続済みプロバイダーからサブエージェントを 1 つ以上追加してください。",
  paseoReviewReady: "オーケストレーターのレビュー準備ができました。",
  paseoAnnealTaskOpened: "レビューの指摘から Anneal タスクを開きました。",
  paseoRecordIssue: "問題を記録",
  paseoRecordReturn: "結果を記録",
  paseoActivity: "アクティビティ",
  paseoInspector: "インスペクター",
  paseoRouteTab: "ルート",
  paseoMissionTab: "ミッション",
  annealSubtitle: "Anneal 形式の5列ボードでタスクを管理し、選択したルートで実行します。",
  annealTaskBoard: "Anneal タスクボード",
  annealBacklog: "バックログ",
  annealTodo: "予定",
  annealDoing: "実行中",
  annealReview: "レビュー",
  annealDone: "完了",
  annealNoTasks: "この列にタスクはありません。",
  annealSelectedTask: "選択したタスク",
  annealSelectTask: "カードを選択してルートを設定し、タスクを実行します。",
  annealDispatch: "実行設定",
  annealDispatchThroughPaseo: "Paseo 経由で実行",
  annealDispatchDirect: "Anneal で直接実行",
  annealDispatchTask: "タスクを実行",
  annealRelatedMissions: "関連ミッション",
  annealNoRelatedMissions: "関連ミッションはありません。",
  annealFromPaseoReview: "Paseo レビューから開く",
  annealAssignmentPreview: "割り当てプレビュー",
  annealNoAssignment: "このタスクにはオーケストレーター→サブエージェント割り当てがまだありません。",
  phases: {
    draft: "下書き",
    ready: "準備完了",
    running: "実行中",
    held: "保留中",
    scheduling_held: "スケジュール保留",
    review_required: "レビューが必要",
    changes_requested: "変更要求",
    accepted: "承認済み",
    cancelled: "キャンセル済み",
    closed: "終了",
    failed: "失敗",
    unknown: "不明",
  },
};

const COPY: Record<Language, OrchestrationCopy> = {
  en: EN,
  "zh-TW": ZH_TW,
  "zh-CN": ZH_CN,
  ja: JA,
};

export function orchestrationCopy(language: Language): OrchestrationCopy {
  return COPY[language] ?? EN;
}

export function phaseLabel(copy: OrchestrationCopy, phase: string): string {
  return copy.phases[phase] ?? phase.replaceAll("_", " ");
}

export function actionLabel(
  copy: OrchestrationCopy,
  action: "start" | "hold" | "resume" | "cancel" | "close" | "inspect",
): string {
  return copy[action];
}

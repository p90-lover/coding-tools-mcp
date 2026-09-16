export type Orchestrator = "paseo" | "anneal";

export type TaskModelSource =
  | "chatgpt-web"
  | "codex-router"
  | "commandcode-proxy"
  | "custom";

export interface OrchestrationTask {
  id: string;
  title: string;
  orchestrator: Orchestrator;
  modelSource: TaskModelSource;
  model?: string;
  provider?: string;
  status: "draft" | "running" | "paused" | "completed" | "failed";
}

export interface PaseoDispatch {
  taskId: string;
  model: string;
  provider: string;
}

export interface AnnealDispatch {
  taskId: string;
  paseoOrchestrator?: boolean;
}

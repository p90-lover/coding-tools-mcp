export type Orchestrator = "paseo" | "anneal";

export type TaskModelSource =
  | "chatgpt-web"
  | "codex-router"
  | "commandcode-proxy"
  | "custom";

export interface TaskModelSelection {
  source: TaskModelSource;
  model: string;
}

export interface OrchestratedTask {
  id: string;
  title: string;
  orchestrator: Orchestrator;
  model: TaskModelSelection;
  workspace?: string;
}

export interface PaseoDispatchRequest {
  taskId: string;
  model: TaskModelSelection;
  brief: string;
}

export interface AnnealDispatchRequest {
  taskId: string;
  orchestrator: Orchestrator;
  model: TaskModelSelection;
}

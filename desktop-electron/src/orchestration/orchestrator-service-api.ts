export type TaskModelSource =
  | "chatgpt-web"
  | "codex-router"
  | "commandcode-proxy"
  | "custom";

export interface OrchestratorTask {
  id: string;
  title: string;
  modelSource: TaskModelSource;
  model: string;
  orchestrator: "paseo" | "anneal";
  status: "draft" | "running" | "paused" | "completed" | "failed";
}

export interface OrchestratorSnapshot {
  tasks: OrchestratorTask[];
  paseoConnected: boolean;
  annealConnected: boolean;
}

export interface OrchestratorServiceApi {
  snapshot(): Promise<OrchestratorSnapshot>;
  create(input: {
    orchestrator: "paseo" | "anneal";
    modelSource: TaskModelSource;
    model: string;
    title: string;
  }): Promise<OrchestratorSnapshot>;
  control(input: {
    taskId: string;
    action: "start" | "pause" | "resume" | "cancel";
  }): Promise<OrchestratorSnapshot>;
}

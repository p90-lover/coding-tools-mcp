export type OrchestratorEngine = "paseo" | "anneal";

export type TaskModelSource =
  | "chatgpt-web"
  | "codex-router"
  | "commandcode-proxy"
  | "custom";

export interface OrchestratorTask {
  id: string;
  engine: OrchestratorEngine;
  modelSource: TaskModelSource;
  model: string;
  status: string;
  workspace?: string;
}

export interface OrchestratorApi {
  list(engine?: OrchestratorEngine): Promise<OrchestratorTask[]>;
  create(input: {
    engine: OrchestratorEngine;
    modelSource: TaskModelSource;
    model: string;
    prompt: string;
  }): Promise<OrchestratorTask>;
  control(id: string, action: "start" | "pause" | "resume" | "cancel"): Promise<OrchestratorTask>;
}

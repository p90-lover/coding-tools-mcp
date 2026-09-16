export type OrchestratorEngine = "paseo" | "anneal" | "custom";

export type OrchestrationStatus =
  | "draft"
  | "running"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export interface TaskModelSelection {
  providerId: string;
  model: string;
}

export type StageApprovalMode = "inherit" | "required" | "auto-approved";

export interface OrchestrationStage {
  id: string;
  name: string;
  agentId?: string;
  orchestratorId?: string;
  model?: TaskModelSelection;
  fallbackStageId?: string;
  maxRetries: number;
  approvalMode: StageApprovalMode;
  timeoutMs: number;
  completionRules: string[];
}

export interface CustomOrchestratorDefinition {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  entryStageId: string;
  stages: OrchestrationStage[];
}

export interface OrchestrationTask {
  id: string;
  title: string;
  engine: OrchestratorEngine;
  model?: TaskModelSelection;
  workflowId?: string;
  workspace?: string;
  status: OrchestrationStatus;
}

export interface PaseoDispatchRequest {
  taskId: string;
  model: TaskModelSelection;
  brief: string;
}

export interface AnnealDispatchRequest {
  taskId: string;
  workflowId?: string;
  usePaseoAsSubagent: boolean;
}

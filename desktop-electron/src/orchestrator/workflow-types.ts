export type WorkflowStepType =
  | "agent"
  | "condition"
  | "validator";

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  agentId?: string;
  next?: string[];
}

export interface CustomOrchestrator {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  retryOnFailure: boolean;
}

export type OrchestratorWorkflow = CustomOrchestrator;

export interface OrchestratorExecutionContext {
  taskId: string;
  workflowId: string;
  currentStep?: string;
  status: "created" | "running" | "waiting" | "completed" | "failed";
}

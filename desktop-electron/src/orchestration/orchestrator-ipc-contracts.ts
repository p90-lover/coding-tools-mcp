import type {
  AnnealDispatchRequest,
  CustomOrchestratorDefinition,
  OrchestrationTask,
  OrchestratorEngine,
  PaseoDispatchRequest,
  TaskModelSelection,
} from "./paseo-anneal-types";

export interface OrchestratorSnapshot {
  tasks: OrchestrationTask[];
  workflows: CustomOrchestratorDefinition[];
  paseoConnected: boolean;
  annealConnected: boolean;
}

export interface OrchestratorCreateInput {
  title: string;
  engine: OrchestratorEngine;
  model?: TaskModelSelection;
  workflowId?: string;
  workspace?: string;
}

export interface OrchestratorApi {
  snapshot(): Promise<OrchestratorSnapshot>;
  create(input: OrchestratorCreateInput): Promise<OrchestratorSnapshot>;
  saveWorkflow(input: CustomOrchestratorDefinition): Promise<OrchestratorSnapshot>;
  dispatchPaseo(input: PaseoDispatchRequest): Promise<OrchestratorSnapshot>;
  dispatchAnneal(input: AnnealDispatchRequest): Promise<OrchestratorSnapshot>;
  control(input: {
    taskId: string;
    action: "start" | "pause" | "resume" | "cancel";
  }): Promise<OrchestratorSnapshot>;
}

export type {
  AnnealDispatchRequest,
  CustomOrchestratorDefinition,
  OrchestrationStage,
  OrchestrationStatus,
  OrchestrationTask,
  OrchestratorEngine,
  PaseoDispatchRequest,
  StageApprovalMode,
  TaskModelSelection,
} from "./paseo-anneal-types";

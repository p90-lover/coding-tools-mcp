import type { OrchestratorWorkflow } from "./workflow-types";

export interface QueuedWorkflowStep {
  step: string;
  agent: string | null;
  status: "queued";
  context: unknown;
}

export class WorkflowEngine {
  async run(
    workflow: OrchestratorWorkflow,
    context: unknown,
  ): Promise<QueuedWorkflowStep[]> {
    return workflow.steps.map((step) => ({
      step: step.id,
      agent: step.agentId ?? null,
      status: "queued" as const,
      context,
    }));
  }
}

import type { OrchestratorWorkflow } from './workflow-types';

export class WorkflowEngine {
  async run(workflow: OrchestratorWorkflow, context: unknown) {
    const results = [];

    for (const step of workflow.steps) {
      results.push({
        step: step.id,
        agent: step.agent,
        status: 'queued',
        context,
      });
    }

    return results;
  }
}

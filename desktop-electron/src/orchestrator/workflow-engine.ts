import { AgentRegistry } from "../agents/agent-registry";
import type { CustomOrchestratorDefinition } from "../orchestration/paseo-anneal-types";
import { resolveOrchestratorAgent } from "./orchestrator-router";
import type {
  ResolvedStageTarget,
  ResolvedWorkflowPlan,
  ResolvedWorkflowStage,
} from "./workflow-types";

export class WorkflowEngine {
  constructor(private readonly registry: AgentRegistry) {}

  buildPlan(
    workflow: CustomOrchestratorDefinition,
    ancestry: readonly string[] = [],
  ): ResolvedWorkflowPlan {
    if (!workflow.enabled) throw new Error(`workflow ${workflow.id} is disabled`);
    if (ancestry.includes(workflow.id)) {
      throw new Error(`recursive orchestrator delegation: ${workflow.id}`);
    }
    if (workflow.stages.length === 0) {
      throw new Error(`workflow ${workflow.id} has no stages`);
    }

    const stageIds = new Set<string>();
    for (const stage of workflow.stages) {
      if (stageIds.has(stage.id)) throw new Error(`duplicate workflow stage ${stage.id}`);
      stageIds.add(stage.id);
    }
    if (!stageIds.has(workflow.entryStageId)) {
      throw new Error(`workflow entry stage ${workflow.entryStageId} does not exist`);
    }

    const nextAncestry = [...ancestry, workflow.id];
    const stages = workflow.stages.map((stage): ResolvedWorkflowStage => {
      if (!Number.isInteger(stage.maxRetries) || stage.maxRetries < 0) {
        throw new Error(`stage ${stage.id} has invalid maxRetries`);
      }
      if (!Number.isInteger(stage.timeoutMs) || stage.timeoutMs <= 0) {
        throw new Error(`stage ${stage.id} has invalid timeoutMs`);
      }
      if (stage.fallbackStageId && !stageIds.has(stage.fallbackStageId)) {
        throw new Error(`stage ${stage.id} has unknown fallback ${stage.fallbackStageId}`);
      }
      if (stage.fallbackStageId === stage.id) {
        throw new Error(`stage ${stage.id} cannot fall back to itself`);
      }

      return {
        id: stage.id,
        name: stage.name,
        target: this.resolveTarget(stage.agentId, stage.orchestratorId, nextAncestry),
        fallbackStageId: stage.fallbackStageId,
        maxRetries: stage.maxRetries,
        approvalMode: stage.approvalMode,
        timeoutMs: stage.timeoutMs,
        completionRules: [...stage.completionRules],
      };
    });

    return {
      workflowId: workflow.id,
      name: workflow.name,
      entryStageId: workflow.entryStageId,
      ancestry: nextAncestry,
      stages,
    };
  }

  private resolveTarget(
    agentId: string | undefined,
    orchestratorId: string | undefined,
    ancestry: readonly string[],
  ): ResolvedStageTarget {
    if ((agentId ? 1 : 0) + (orchestratorId ? 1 : 0) !== 1) {
      throw new Error("workflow stage must define exactly one agentId or orchestratorId");
    }

    if (orchestratorId) {
      if (ancestry.includes(orchestratorId)) {
        throw new Error(`recursive orchestrator delegation: ${orchestratorId}`);
      }
      return { kind: "orchestrator", orchestratorId };
    }

    const agent = this.registry.get(agentId!);
    if (!agent) throw new Error(`agent ${agentId} is not registered`);
    if (!agent.enabled) throw new Error(`agent ${agentId} is disabled`);
    if (agent.kind === "orchestrator") {
      const resolved = resolveOrchestratorAgent(this.registry, agent.id, ancestry);
      return {
        kind: "orchestrator",
        agentId: resolved.id,
        orchestratorId: resolved.orchestratorId,
      };
    }

    return {
      kind: "agent",
      agentId: agent.id,
      providerId: agent.providerId,
      model: agent.model,
    };
  }
}

import { AgentRegistry } from "../agents/agent-registry";
import type { OrchestratorAgentProfile } from "../agents/subagent-types";

export function resolveOrchestratorAgent(
  registry: AgentRegistry,
  agentId: string,
  workflowAncestry: readonly string[],
): OrchestratorAgentProfile {
  const agent = registry.get(agentId);
  if (!agent) throw new Error(`agent ${agentId} is not registered`);
  if (!agent.enabled) throw new Error(`agent ${agentId} is disabled`);
  if (agent.kind !== "orchestrator") {
    throw new Error(`agent ${agentId} is not an orchestrator`);
  }
  if (workflowAncestry.includes(agent.orchestratorId)) {
    throw new Error(`recursive orchestrator delegation: ${agent.orchestratorId}`);
  }
  return agent;
}

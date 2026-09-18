import { AgentRegistry } from "../agents/agent-registry";
import { resolveAgentProvider } from "../agents/agent-provider-adapter";
import type { AgentProfile, AgentRole } from "../agents/subagent-types";
import { resolveOrchestratorAgent } from "../orchestrator/orchestrator-router";
import type {
  ProviderCapability,
  ProviderDefinition,
} from "../providers/provider-types";

export interface AgentRoutingRequest {
  role?: AgentRole;
  requiredCapabilities: ProviderCapability[];
  workflowAncestry: string[];
}

export interface AgentRoutingResult {
  agent: AgentProfile | null;
  provider?: ProviderDefinition;
  reason: string;
}

export class AgentRouter {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly providers: readonly ProviderDefinition[],
  ) {}

  route(request: AgentRoutingRequest): AgentRoutingResult {
    for (const agent of this.registry.list()) {
      if (request.role && agent.role !== request.role) continue;
      if (!request.requiredCapabilities.every((capability) =>
        agent.capabilities.includes(capability))) continue;

      if (agent.kind === "orchestrator") {
        try {
          const resolved = resolveOrchestratorAgent(
            this.registry,
            agent.id,
            request.workflowAncestry,
          );
          return {
            agent: resolved,
            reason: "matched-enabled-orchestrator",
          };
        } catch {
          continue;
        }
      }

      const provider = resolveAgentProvider(agent, this.providers);
      if (!provider.compatible || !provider.provider) continue;
      return {
        agent,
        provider: provider.provider,
        reason: "matched-enabled-agent-and-provider",
      };
    }

    return {
      agent: null,
      reason: "no-compatible-agent",
    };
  }
}

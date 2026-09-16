import type { AgentProfile } from "../agents/subagent-types";
import type { ProviderCapability } from "../providers/provider-types";

export interface RoutingRequest {
  taskType: string;
  requiredCapabilities?: ProviderCapability[];
}

export interface RoutingResult {
  agent: AgentProfile | null;
  reason: string;
}

export class AgentRouter {
  constructor(private readonly agents: AgentProfile[] = []) {}

  route(request: RoutingRequest): RoutingResult {
    const match = this.agents.find((agent) => {
      if (!agent.enabled) return false;
      if (!request.requiredCapabilities?.length) return true;
      const capabilities = agent.capabilities ?? [];
      return request.requiredCapabilities.every((capability) =>
        capabilities.includes(capability)
      );
    });

    return {
      agent: match ?? null,
      reason: match ? "matched-enabled-agent" : "no-compatible-agent",
    };
  }
}

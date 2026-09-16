import type { AgentProfile } from '../agents/subagent-types';

export interface RoutingRequest {
  taskType: string;
  requiredCapabilities?: string[];
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
      return request.requiredCapabilities.every((capability) =>
        agent.capabilities.includes(capability)
      );
    });

    return {
      agent: match ?? null,
      reason: match ? 'matched-enabled-agent' : 'no-compatible-agent',
    };
  }
}

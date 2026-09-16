import type { AgentProfile } from '../agents/subagent-types';

export interface OrchestratorRoute {
  task: string;
  agent: AgentProfile;
}

export class OrchestratorRouter {
  selectAgent(task: string, agents: AgentProfile[]): AgentProfile | undefined {
    return agents.find((agent) =>
      task.toLowerCase().includes(agent.role.toLowerCase())
    ) ?? agents[0];
  }
}

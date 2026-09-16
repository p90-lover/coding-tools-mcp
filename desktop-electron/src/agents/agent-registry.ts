import type { AgentProfile } from './subagent-types';

export class AgentRegistry {
  private agents = new Map<string, AgentProfile>();

  register(agent: AgentProfile) {
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id: string) {
    return this.agents.get(id);
  }

  list() {
    return [...this.agents.values()];
  }

  remove(id: string) {
    return this.agents.delete(id);
  }
}

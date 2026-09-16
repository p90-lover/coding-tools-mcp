import type { AgentProfile } from './subagent-types';

export class AgentStore {
  private agents: AgentProfile[] = [];

  load(agents: AgentProfile[]) {
    this.agents = [...agents];
  }

  save(agent: AgentProfile) {
    this.agents = [
      ...this.agents.filter((item) => item.id !== agent.id),
      agent,
    ];
  }

  list() {
    return [...this.agents];
  }
}

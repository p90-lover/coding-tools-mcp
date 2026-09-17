import type { AgentProfile } from "./subagent-types";
import { validateAgentProfile } from "./subagent-types";

function cloneAgent(agent: AgentProfile): AgentProfile {
  return {
    ...agent,
    capabilities: [...agent.capabilities],
    tools: [...agent.tools],
    budget: { ...agent.budget },
  } as AgentProfile;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentProfile>();

  constructor(initialAgents: readonly AgentProfile[] = []) {
    for (const agent of initialAgents) this.register(agent);
  }

  register(agent: AgentProfile): AgentProfile {
    if (this.agents.has(agent.id)) {
      throw new Error(`agent ${agent.id} is already registered`);
    }
    return this.store(agent);
  }

  save(agent: AgentProfile): AgentProfile {
    return this.store(agent);
  }

  get(id: string): AgentProfile | undefined {
    const agent = this.agents.get(id);
    return agent ? cloneAgent(agent) : undefined;
  }

  list(options: { includeDisabled?: boolean } = {}): AgentProfile[] {
    return [...this.agents.values()]
      .filter((agent) => options.includeDisabled === true || agent.enabled)
      .map(cloneAgent);
  }

  archive(id: string): AgentProfile {
    const current = this.agents.get(id);
    if (!current) throw new Error(`agent ${id} is not registered`);
    return this.store({ ...current, enabled: false } as AgentProfile);
  }

  private store(agent: AgentProfile): AgentProfile {
    const errors = validateAgentProfile(agent);
    if (errors.length > 0) {
      throw new Error(`invalid agent ${agent.id || "<unknown>"}: ${errors.join("; ")}`);
    }
    const stored = cloneAgent(agent);
    this.agents.set(stored.id, stored);
    return cloneAgent(stored);
  }
}

import { AgentRegistry } from "./agent-registry";
import type { AgentProfile } from "./subagent-types";

export interface AgentStoreSnapshot {
  version: 1;
  agents: AgentProfile[];
}

export interface AgentStoreAdapter {
  read(): Promise<AgentStoreSnapshot | null>;
  write(snapshot: AgentStoreSnapshot): Promise<void>;
}

export class AgentStore {
  constructor(private readonly adapter: AgentStoreAdapter) {}

  async load(): Promise<AgentRegistry> {
    const snapshot = await this.adapter.read();
    if (!snapshot) return new AgentRegistry();
    if (snapshot.version !== 1 || !Array.isArray(snapshot.agents)) {
      throw new Error("unsupported agent store snapshot");
    }
    return new AgentRegistry(snapshot.agents);
  }

  async save(registry: AgentRegistry): Promise<void> {
    await this.adapter.write({
      version: 1,
      agents: registry.list({ includeDisabled: true }),
    });
  }
}

export class MemoryAgentStoreAdapter implements AgentStoreAdapter {
  private snapshot: AgentStoreSnapshot | null = null;

  async read(): Promise<AgentStoreSnapshot | null> {
    if (!this.snapshot) return null;
    return {
      version: 1,
      agents: this.snapshot.agents.map((agent) => ({
        ...agent,
        capabilities: [...agent.capabilities],
        tools: [...agent.tools],
        budget: { ...agent.budget },
      } as AgentProfile)),
    };
  }

  async write(snapshot: AgentStoreSnapshot): Promise<void> {
    this.snapshot = {
      version: 1,
      agents: snapshot.agents.map((agent) => ({
        ...agent,
        capabilities: [...agent.capabilities],
        tools: [...agent.tools],
        budget: { ...agent.budget },
      } as AgentProfile)),
    };
  }
}

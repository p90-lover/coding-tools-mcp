import type { AgentProfile } from './subagent-types';
import type { ProviderProfile } from '../providers/provider-types';

export interface AgentProviderAdapter {
  resolveProvider(agent: AgentProfile, providers: ProviderProfile[]): ProviderProfile | undefined;
}

export class DefaultAgentProviderAdapter implements AgentProviderAdapter {
  resolveProvider(agent: AgentProfile, providers: ProviderProfile[]) {
    return providers.find((provider) => provider.id === agent.providerId);
  }
}

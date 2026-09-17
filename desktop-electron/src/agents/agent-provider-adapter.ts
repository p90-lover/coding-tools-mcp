import type { ProviderDefinition } from "../providers/provider-types";
import type { AgentProfile, ModelAgentProfile } from "./subagent-types";

export interface AgentProviderResolution {
  compatible: boolean;
  provider?: ProviderDefinition;
  errors: string[];
}

export function resolveAgentProvider(
  agent: AgentProfile,
  providers: readonly ProviderDefinition[],
): AgentProviderResolution {
  if (agent.kind !== "model") {
    return {
      compatible: false,
      errors: ["orchestrator agents do not resolve model providers"],
    };
  }

  return resolveModelAgentProvider(agent, providers);
}

function resolveModelAgentProvider(
  agent: ModelAgentProfile,
  providers: readonly ProviderDefinition[],
): AgentProviderResolution {
  const provider = providers.find((candidate) => candidate.id === agent.providerId);
  if (!provider) {
    return {
      compatible: false,
      errors: [`provider ${agent.providerId} is not registered`],
    };
  }

  const missingCapabilities = agent.capabilities.filter(
    (capability) => !provider.capabilities.includes(capability),
  );
  const errors = missingCapabilities.map(
    (capability) => `provider ${provider.id} does not support ${capability}`,
  );

  if (provider.models.length > 0 && !provider.models.includes(agent.model)) {
    errors.push(`provider ${provider.id} does not advertise model ${agent.model}`);
  }

  return {
    compatible: errors.length === 0,
    provider,
    errors,
  };
}

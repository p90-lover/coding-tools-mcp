import type {
  LauncherApi,
  ProviderExecutionPlan,
} from "../types";
import {
  PROVIDER_CATALOG,
  type ProviderDefinition,
} from "../providers/provider-types";
import type { AgentProfile, ModelAgentProfile } from "./subagent-types";

export interface AgentProviderResolution {
  compatible: boolean;
  provider?: ProviderDefinition;
  errors: string[];
}

export interface AgentExecutionOptions {
  accountId?: string;
  allowFallback?: boolean;
}

export interface AgentProviderExecution {
  provider: ProviderDefinition;
  plan: ProviderExecutionPlan;
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

  if (!provider.subagentEnabled) {
    errors.push(`provider ${provider.id} is not enabled for subagent execution`);
  }
  if (provider.models.length > 0 && !provider.models.includes(agent.model)) {
    errors.push(`provider ${provider.id} does not advertise model ${agent.model}`);
  }

  return {
    compatible: errors.length === 0,
    provider,
    errors,
  };
}

export async function planAgentExecution(
  agent: ModelAgentProfile,
  api: Pick<LauncherApi, "providerExecutionPlan">,
  options: AgentExecutionOptions = {},
  providers: readonly ProviderDefinition[] = PROVIDER_CATALOG,
): Promise<AgentProviderExecution> {
  const resolution = resolveModelAgentProvider(agent, providers);
  if (!resolution.compatible || !resolution.provider) {
    throw new Error(resolution.errors.join("; ") || "Agent provider is unavailable");
  }

  const plan = await api.providerExecutionPlan({
    workload: "subagent",
    providerId: resolution.provider.id,
    accountId: options.accountId,
    model: agent.model,
    allowFallback: options.allowFallback ?? true,
  });

  if (plan.workload !== "subagent") {
    throw new Error("Codex Router returned a non-subagent execution plan");
  }
  if (!plan.credentialHandle?.providerId || !plan.credentialHandle?.accountId) {
    throw new Error("Codex Router returned an invalid credential handle");
  }
  return { provider: resolution.provider, plan };
}

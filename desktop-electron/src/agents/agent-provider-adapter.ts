import type { AgentProfile, AgentProvider } from "./subagent-types";
import type { ProviderDefinition } from "../providers/provider-types";

const DEFAULT_PROVIDER_BY_AGENT = Object.freeze({
  codex: "codex-oauth",
  claude: "claude-oauth",
  "chatgpt-web": "chatgpt-web",
  gemini: "gemini-reverse-proxy",
} satisfies Record<Exclude<AgentProvider, "custom">, string>);

export interface AgentProviderAdapter {
  resolveProvider(
    agent: AgentProfile,
    providers: readonly ProviderDefinition[],
  ): ProviderDefinition | undefined;
}

export class DefaultAgentProviderAdapter implements AgentProviderAdapter {
  resolveProvider(agent: AgentProfile, providers: readonly ProviderDefinition[]) {
    const explicitProviderId = agent.providerId?.trim();
    const providerId = explicitProviderId
      || (agent.provider === "custom" ? undefined : DEFAULT_PROVIDER_BY_AGENT[agent.provider]);
    if (!providerId) return undefined;
    return providers.find((provider) => provider.id === providerId);
  }
}

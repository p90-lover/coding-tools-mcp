import { builtinProviderProfiles, type ProviderProfile } from "./provider-registry";

export interface ProviderHealth {
  providerId: string;
  status: "unknown" | "ready" | "error";
  checkedAt?: number;
  latencyMs?: number;
  error?: string;
}

export interface ProviderConnectionResult {
  ok: boolean;
  provider: ProviderProfile;
  health: ProviderHealth;
}

export interface ProviderFallbackPolicy {
  primary: string;
  fallback: string[];
}

const healthStore = new Map<string, ProviderHealth>();

export function listProviders(): ProviderProfile[] {
  return [...builtinProviderProfiles].sort((a, b) => a.priority - b.priority);
}

export function getProvider(id: string): ProviderProfile | undefined {
  return builtinProviderProfiles.find(provider => provider.id === id);
}

export function providersForEngine(engine: "paseo" | "anneal"): ProviderProfile[] {
  return listProviders().filter(provider =>
    engine === "paseo" ? provider.paseoEnabled : provider.annealEnabled,
  );
}

export function supportsCapability(
  providerId: string,
  capability: ProviderProfile["capabilities"][number],
): boolean {
  return getProvider(providerId)?.capabilities.includes(capability) ?? false;
}

export async function testProvider(providerId: string): Promise<ProviderConnectionResult> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const started = Date.now();
  const health: ProviderHealth = {
    providerId,
    status: "ready",
    checkedAt: Date.now(),
    latencyMs: Date.now() - started,
  };

  healthStore.set(providerId, health);
  return { ok: true, provider, health };
}

export function providerHealth(providerId: string): ProviderHealth | undefined {
  return healthStore.get(providerId);
}

export function resolveFallbackPolicy(
  primary: string,
  fallback: string[],
): ProviderFallbackPolicy {
  return {
    primary,
    fallback: fallback.filter(id => id !== primary && Boolean(getProvider(id))),
  };
}

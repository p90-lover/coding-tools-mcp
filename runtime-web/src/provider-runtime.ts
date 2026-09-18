import {
  builtinProviderProfiles,
  getBuiltinProvider,
  providersForEngine as registryProvidersForEngine,
  type ProviderCapability,
  type ProviderEngine,
  type ProviderProfile,
} from "./provider-registry";

export interface ProviderModel {
  id: string;
  label?: string;
  capabilities?: ProviderCapability[];
}

export interface ProviderHealth {
  providerId: string;
  status: "unknown" | "ready" | "error";
  checkedAt?: number;
  latencyMs?: number;
  error?: string;
}

export interface ProviderProbeResult {
  status?: "ready" | "error";
  latencyMs?: number;
  error?: string;
  models?: ProviderModel[];
}

export interface ProviderRuntimeAdapter {
  test(profile: ProviderProfile, signal: AbortSignal): Promise<ProviderProbeResult>;
  discoverModels?(profile: ProviderProfile, signal: AbortSignal): Promise<ProviderModel[]>;
}

export interface ProviderConnectionResult {
  ok: boolean;
  provider: ProviderProfile;
  health: ProviderHealth;
  models: ProviderModel[];
}

export interface ProviderFallbackPolicy {
  primary: string;
  fallback: string[];
}

export interface ProviderFallbackOptions {
  engine?: ProviderEngine;
  capability?: ProviderCapability;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const healthStore = new Map<string, ProviderHealth>();
const modelStore = new Map<string, ProviderModel[]>();
const adapterStore = new Map<string, ProviderRuntimeAdapter>();

function copyModels(models: readonly ProviderModel[]): ProviderModel[] {
  return models.map((model) => ({
    ...model,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
  }));
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Provider operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function writeHealth(health: ProviderHealth): ProviderHealth {
  const stored = { ...health };
  healthStore.set(health.providerId, stored);
  return { ...stored };
}

export function registerProviderRuntimeAdapter(
  providerId: string,
  adapter: ProviderRuntimeAdapter,
): () => void {
  if (!getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);
  adapterStore.set(providerId, adapter);
  return () => {
    if (adapterStore.get(providerId) === adapter) adapterStore.delete(providerId);
  };
}

export function unregisterProviderRuntimeAdapter(providerId: string): void {
  adapterStore.delete(providerId);
}

export function listProviders(): ProviderProfile[] {
  return [...builtinProviderProfiles]
    .sort((left, right) => left.priority - right.priority)
    .map((provider) => ({ ...provider, capabilities: [...provider.capabilities] }));
}

export function getProvider(id: string): ProviderProfile | undefined {
  const provider = getBuiltinProvider(id);
  return provider ? { ...provider, capabilities: [...provider.capabilities] } : undefined;
}

export function providersForEngine(engine: ProviderEngine): ProviderProfile[] {
  return registryProvidersForEngine(engine).map((provider) => ({
    ...provider,
    capabilities: [...provider.capabilities],
  }));
}

export function supportsCapability(
  providerId: string,
  capability: ProviderCapability,
): boolean {
  return getBuiltinProvider(providerId)?.capabilities.includes(capability) ?? false;
}

export async function testProvider(
  providerId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderConnectionResult> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const adapter = adapterStore.get(providerId);
  if (!adapter) {
    const health = writeHealth({
      providerId,
      status: "unknown",
      checkedAt: Date.now(),
      error: "Provider runtime adapter is not configured",
    });
    return {
      ok: false,
      provider,
      health,
      models: providerModels(providerId),
    };
  }

  const startedAt = Date.now();
  try {
    const probe = await withTimeout(
      (signal) => adapter.test(provider, signal),
      timeoutMs,
    );
    const models = probe.models ? copyModels(probe.models) : providerModels(providerId);
    if (probe.models) modelStore.set(providerId, models);
    const status = probe.status ?? (probe.error ? "error" : "ready");
    const health = writeHealth({
      providerId,
      status,
      checkedAt: Date.now(),
      latencyMs: probe.latencyMs ?? Date.now() - startedAt,
      error: probe.error,
    });
    return { ok: status === "ready", provider, health, models };
  } catch (error) {
    const health = writeHealth({
      providerId,
      status: "error",
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, provider, health, models: providerModels(providerId) };
  }
}

export async function discoverProviderModels(
  providerId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderModel[]> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const adapter = adapterStore.get(providerId);
  if (!adapter?.discoverModels) {
    throw new Error(`Model discovery is not configured for ${provider.name}`);
  }

  const models = copyModels(
    await withTimeout(
      (signal) => adapter.discoverModels!(provider, signal),
      timeoutMs,
    ),
  );
  modelStore.set(providerId, models);
  return copyModels(models);
}

export function providerHealth(providerId: string): ProviderHealth | undefined {
  const health = healthStore.get(providerId);
  return health ? { ...health } : undefined;
}

export function providerModels(providerId: string): ProviderModel[] {
  return copyModels(modelStore.get(providerId) ?? []);
}

export function resetProviderRuntimeState(): void {
  healthStore.clear();
  modelStore.clear();
  adapterStore.clear();
}

export function resolveFallbackPolicy(
  primary: string,
  fallback: string[],
  options: ProviderFallbackOptions = {},
): ProviderFallbackPolicy {
  const primaryProvider = getBuiltinProvider(primary);
  if (!primaryProvider) throw new Error(`Unknown primary provider: ${primary}`);

  const allowed = new Set(
    (options.engine ? registryProvidersForEngine(options.engine) : builtinProviderProfiles)
      .filter((provider) =>
        options.capability ? provider.capabilities.includes(options.capability) : true,
      )
      .map((provider) => provider.id),
  );

  if (!allowed.has(primary)) {
    throw new Error(`Primary provider ${primary} does not satisfy the fallback policy`);
  }

  const seen = new Set<string>([primary]);
  const resolvedFallback: string[] = [];
  for (const providerId of fallback) {
    if (seen.has(providerId) || !allowed.has(providerId)) continue;
    seen.add(providerId);
    resolvedFallback.push(providerId);
  }

  return { primary, fallback: resolvedFallback };
}

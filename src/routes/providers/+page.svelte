<script lang="ts">
  import { onMount } from "svelte";
  import {
    ShieldCheck,
    RefreshCw,
    Plug,
    Settings2,
    Cpu,
    KeyRound,
    Globe2,
  } from "@lucide/svelte";
  import {
    discoverProviderModels,
    listProviders,
    providerHealth,
    providerModels,
    registerProviderRuntimeAdapter,
    testProvider,
    type ProviderModel,
    type ProviderRuntimeAdapter,
  } from "../../../runtime-web/src/provider-runtime";
  import type {
    ProviderCategory,
    ProviderProfile,
  } from "../../../runtime-web/src/provider-registry";

  const SETTINGS_KEY = "coding-tools.provider-settings.v1";
  const providers = listProviders();
  const adapterDisposers = new Map<string, () => void>();

  type ProviderUiState = {
    baseUrl: string;
    apiKey: string;
    expanded: boolean;
  };

  let category = $state<"all" | ProviderCategory>("all");
  let status = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  let models = $state<Record<string, ProviderModel[]>>({});
  let configuration = $state<Record<string, ProviderUiState>>(
    Object.fromEntries(
      providers.map((provider) => [
        provider.id,
        {
          baseUrl: provider.baseUrl ?? "",
          apiKey: "",
          expanded: false,
        },
      ]),
    ),
  );

  let visibleProviders = $derived(
    category === "all"
      ? providers
      : providers.filter((provider) => provider.category === category),
  );

  function joinUrl(baseUrl: string, endpoint: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  }

  function requestHeaders(provider: ProviderProfile, apiKey: string): HeadersInit {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!apiKey) return headers;
    if (provider.protocol === "anthropic_messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider.protocol === "gemini_native") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  function parseModels(payload: unknown): ProviderModel[] {
    if (!payload || typeof payload !== "object") return [];
    const record = payload as Record<string, unknown>;
    const candidates = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : Array.isArray(payload)
          ? payload
          : [];
    return candidates
      .map((entry) => {
        if (typeof entry === "string") return { id: entry };
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        const id = typeof item.id === "string"
          ? item.id
          : typeof item.name === "string"
            ? item.name.replace(/^models\//, "")
            : "";
        if (!id) return null;
        return {
          id,
          label: typeof item.displayName === "string" ? item.displayName : undefined,
        } satisfies ProviderModel;
      })
      .filter((entry): entry is ProviderModel => Boolean(entry));
  }

  function createHttpAdapter(provider: ProviderProfile): ProviderRuntimeAdapter | undefined {
    const state = configuration[provider.id];
    const baseUrl = state?.baseUrl.trim();
    const apiKey = state?.apiKey.trim();
    if (!baseUrl) return undefined;
    if (provider.auth === "api_key" && !apiKey) return undefined;

    const discover = async (signal: AbortSignal): Promise<ProviderModel[]> => {
      if (!provider.modelsEndpoint) return [];
      const response = await fetch(joinUrl(baseUrl, provider.modelsEndpoint), {
        method: "GET",
        headers: requestHeaders(provider, apiKey),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Model discovery failed with HTTP ${response.status}`);
      }
      return parseModels(await response.json());
    };

    return {
      async test(_profile, signal) {
        const startedAt = Date.now();
        const discovered = provider.modelsEndpoint ? await discover(signal) : [];
        if (!provider.modelsEndpoint) {
          const response = await fetch(baseUrl, {
            method: "HEAD",
            headers: requestHeaders(provider, apiKey),
            signal,
          });
          if (!response.ok) throw new Error(`Provider probe failed with HTTP ${response.status}`);
        }
        return {
          status: "ready",
          latencyMs: Date.now() - startedAt,
          models: discovered,
        };
      },
      discoverModels: discover,
    };
  }

  function configureAdapter(provider: ProviderProfile): boolean {
    adapterDisposers.get(provider.id)?.();
    adapterDisposers.delete(provider.id);

    if (provider.auth === "oauth" || provider.auth === "browser_session") {
      errors[provider.id] = "Complete this provider's OAuth or browser sign-in from Connections before testing it here.";
      return false;
    }

    const adapter = createHttpAdapter(provider);
    if (!adapter) {
      errors[provider.id] = provider.auth === "api_key"
        ? "Enter a base URL and a session-only API key. Keys are never saved by this page."
        : "Enter the local proxy base URL.";
      return false;
    }

    adapterDisposers.set(provider.id, registerProviderRuntimeAdapter(provider.id, adapter));
    return true;
  }

  async function connect(provider: ProviderProfile) {
    errors[provider.id] = "";
    status[provider.id] = "checking";
    if (!configureAdapter(provider)) {
      status[provider.id] = "configuration required";
      return;
    }
    const result = await testProvider(provider.id);
    status[provider.id] = result.health.status;
    models[provider.id] = result.models;
    errors[provider.id] = result.health.error ?? "";
    saveNonSecretSettings();
  }

  async function refreshModels(provider: ProviderProfile) {
    errors[provider.id] = "";
    status[provider.id] = "discovering models";
    if (!configureAdapter(provider)) {
      status[provider.id] = "configuration required";
      return;
    }
    try {
      models[provider.id] = await discoverProviderModels(provider.id);
      status[provider.id] = providerHealth(provider.id)?.status ?? "ready";
    } catch (cause) {
      status[provider.id] = "error";
      errors[provider.id] = cause instanceof Error ? cause.message : String(cause);
    }
    saveNonSecretSettings();
  }

  function toggleSettings(providerId: string) {
    configuration[providerId].expanded = !configuration[providerId].expanded;
  }

  function saveNonSecretSettings() {
    const safeSettings = Object.fromEntries(
      Object.entries(configuration).map(([id, value]) => [id, { baseUrl: value.baseUrl }]),
    );
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(safeSettings));
  }

  onMount(() => {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Record<string, { baseUrl?: string }>;
      for (const [providerId, value] of Object.entries(parsed)) {
        if (configuration[providerId] && typeof value.baseUrl === "string") {
          configuration[providerId].baseUrl = value.baseUrl;
        }
      }
    } catch {
      // Invalid non-secret settings are ignored; credentials are never persisted here.
    }
  });
</script>

<section class="cc-page">
  <header class="cc-page-heading">
    <div>
      <h1><Cpu size={18} /> Providers</h1>
      <p>Manage API-key, OAuth, ChatGPT Web and local reverse-proxy providers for Codex, Paseo and Anneal.</p>
    </div>
    <span class="cc-inline-label"><ShieldCheck size={16} /> Provider execution requires explicit consent</span>
  </header>

  <section class="filter-row" aria-label="Provider categories">
    {#each ["all", "api_key", "oauth", "browser", "reverse_proxy", "custom"] as item}
      <button
        type="button"
        class="cc-button"
        class:primary={category === item}
        class:ghost={category !== item}
        onclick={() => { category = item as typeof category; }}
      >
        {item === "all" ? "All" : item.replaceAll("_", " ")}
      </button>
    {/each}
  </section>

  <div class="provider-grid">
    {#each visibleProviders as provider (provider.id)}
      <article class="cc-panel provider-card">
        <div class="provider-heading">
          <div>
            <h2>{provider.name}</h2>
            <p>{provider.description}</p>
          </div>
          <span class="status" data-status={status[provider.id] ?? providerHealth(provider.id)?.status ?? "unknown"}>
            {status[provider.id] ?? providerHealth(provider.id)?.status ?? "not tested"}
          </span>
        </div>

        <p class="meta">{provider.category.replaceAll("_", " ")} · {provider.auth.replaceAll("_", " ")} · {provider.protocol.replaceAll("_", " ")}</p>
        <div class="caps">
          {#each provider.capabilities as capability}
            <span>{capability.replaceAll("_", " ")}</span>
          {/each}
        </div>
        <small>
          Engines:
          {provider.codexEnabled ? "Codex" : ""}{provider.codexEnabled && provider.paseoEnabled ? ", " : ""}{provider.paseoEnabled ? "Paseo" : ""}{(provider.codexEnabled || provider.paseoEnabled) && provider.annealEnabled ? ", " : ""}{provider.annealEnabled ? "Anneal" : ""}
        </small>

        <div class="buttons">
          <button type="button" class="cc-button secondary" onclick={() => connect(provider)}>
            <Plug size={14} /> Test
          </button>
          <button type="button" class="cc-button ghost" disabled={!provider.modelsEndpoint} onclick={() => refreshModels(provider)}>
            <RefreshCw size={14} /> Models
          </button>
          <button type="button" class="cc-button ghost" onclick={() => toggleSettings(provider.id)}>
            <Settings2 size={14} /> Configure
          </button>
        </div>

        {#if configuration[provider.id].expanded}
          <section class="settings-panel">
            <label>
              <Globe2 size={14} /> Base URL
              <input
                bind:value={configuration[provider.id].baseUrl}
                placeholder={provider.configurableBaseUrl ? "http://127.0.0.1:PORT/v1" : "Managed by sign-in"}
                disabled={!provider.configurableBaseUrl}
                onblur={saveNonSecretSettings}
              />
            </label>
            {#if provider.auth === "api_key"}
              <label>
                <KeyRound size={14} /> Session-only API key
                <input
                  type="password"
                  autocomplete="off"
                  bind:value={configuration[provider.id].apiKey}
                  placeholder="Not saved"
                />
              </label>
            {/if}
            {#if provider.auth === "oauth" || provider.auth === "browser_session"}
              <p class="notice">OAuth and browser sessions are owned by the dedicated sign-in flow; this page does not copy or persist those credentials.</p>
            {/if}
          </section>
        {/if}

        {#if errors[provider.id]}
          <p class="error" role="alert">{errors[provider.id]}</p>
        {/if}
        {#if (models[provider.id] ?? providerModels(provider.id)).length > 0}
          <details class="models">
            <summary>{(models[provider.id] ?? providerModels(provider.id)).length} discovered models</summary>
            <ul>
              {#each (models[provider.id] ?? providerModels(provider.id)).slice(0, 50) as model}
                <li>{model.label ?? model.id}<code>{model.id}</code></li>
              {/each}
            </ul>
          </details>
        {/if}
      </article>
    {/each}
  </div>
</section>

<style>
  .filter-row,
  .buttons,
  .caps {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .filter-row {
    margin-bottom: 1rem;
  }
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(260px, 1fr));
    gap: 1rem;
  }
  .provider-card {
    display: grid;
    align-content: start;
    gap: 0.8rem;
    padding: 1rem;
  }
  .provider-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }
  .provider-heading h2,
  .provider-heading p,
  .meta {
    margin: 0;
  }
  .provider-heading p,
  .meta,
  small {
    opacity: 0.76;
  }
  .status {
    white-space: nowrap;
    padding: 0.25rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.75rem;
  }
  .caps span {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.75rem;
  }
  .settings-panel {
    display: grid;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.8rem;
  }
  input {
    min-width: 0;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface, transparent);
    color: inherit;
  }
  .notice,
  .error {
    margin: 0;
    padding: 0.65rem 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.8rem;
  }
  .notice {
    border: 1px solid var(--border);
  }
  .error {
    border: 1px solid color-mix(in srgb, #ef4444 55%, transparent);
  }
  .models ul {
    max-height: 14rem;
    overflow: auto;
    margin: 0.5rem 0 0;
    padding-left: 1rem;
  }
  .models li {
    display: grid;
    gap: 0.1rem;
    margin-bottom: 0.4rem;
  }
  .models code {
    font-size: 0.7rem;
    opacity: 0.75;
  }
  @media (max-width: 1100px) {
    .provider-grid {
      grid-template-columns: repeat(2, minmax(260px, 1fr));
    }
  }
  @media (max-width: 720px) {
    .provider-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

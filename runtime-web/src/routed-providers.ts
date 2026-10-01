const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface CpaConnection {
  origin: string;
  proxyApiKey: string;
  baseUrl: string;
}

export interface ProviderBackendDiscovery {
  kind: "coding-tools-provider-backends";
  role: "provider-backend";
  backends: {
    cpa?: {
      role: "main-provider";
      origin: string;
      openaiBaseUrl: string;
      healthUrl: string;
      chatCompletionsUrl: string;
    };
  };
}

function normalizeOrigin(value: string, label: string, allowRemoteHttps: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(`${label} must use loopback or HTTPS`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP(S)`);
  }
  if (!loopback && !allowRemoteHttps) {
    throw new Error(`${label} must use a loopback host`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function resolveCpaConnection(
  env: Record<string, string | undefined> = process.env,
): CpaConnection | undefined {
  const configuredOrigin = env.CODING_TOOLS_CPA_URL?.trim() || env.CODING_TOOLS_CPA_OPENAI_BASE_URL?.trim();
  const proxyApiKey = env.CODING_TOOLS_CPA_PROXY_API_KEY?.trim();
  if (!configuredOrigin && !proxyApiKey) return undefined;
  if (!proxyApiKey || proxyApiKey.length < 32 || proxyApiKey.includes("\0")) {
    throw new Error("CPA proxy API key must be at least 32 characters");
  }
  const origin = normalizeOrigin(
    configuredOrigin || "http://127.0.0.1:8317",
    "CPA URL",
    false,
  );
  const parsed = new URL(origin);
  if (parsed.pathname !== "/" && parsed.pathname !== "/v1") {
    throw new Error("CPA URL must be an origin or /v1 OpenAI base");
  }
  const normalizedOrigin = origin.replace(/\/v1$/, "").replace(/\/$/, "");
  return {
    origin: normalizedOrigin,
    proxyApiKey,
    baseUrl: `${normalizedOrigin}/v1`,
  };
}

export function describeProviderBackends(
  env: Record<string, string | undefined> = process.env,
): ProviderBackendDiscovery {
  const backends: ProviderBackendDiscovery["backends"] = {};
  try {
    const cpa = resolveCpaConnection(env);
    if (cpa) {
      backends.cpa = {
        role: "main-provider",
        origin: cpa.origin,
        openaiBaseUrl: cpa.baseUrl,
        healthUrl: `${cpa.baseUrl}/models`,
        chatCompletionsUrl: `${cpa.baseUrl}/chat/completions`,
      };
    }
  } catch {
    // Invalid CPA env stays undiscoverable so MCP catalog reads do not throw.
  }
  return {
    kind: "coding-tools-provider-backends",
    role: "provider-backend",
    backends,
  };
}

export function resolvePaseoExecutionLoopback(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env.CODING_TOOLS_PASEO_EXECUTION_URL?.trim();
  if (!configured) return undefined;
  const parsed = new URL(configured);
  if (!LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase())) {
    throw new Error("Paseo execution URL must use a loopback host");
  }
  if (!new Set(["ws:", "wss:", "http:", "https:"]).has(parsed.protocol)) {
    throw new Error("Paseo execution URL must use WebSocket or HTTP");
  }
  return parsed.toString();
}

export function resolveAnnealExecutionLoopback(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env.CODING_TOOLS_ANNEAL_EXECUTION_URL?.trim();
  if (!configured) return undefined;
  return normalizeOrigin(configured, "Anneal execution URL", false);
}

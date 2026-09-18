import type { AppConfig } from "./config";

const CODEX_ROUTER_PREFIX = "codex-router/";
const CALLER_KEY = /^[A-Za-z0-9_-]{32,}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface CodexRouterConnection {
  origin: string;
  callerKey: string;
  baseUrl: string;
}

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
    "codex-router"?: {
      role: "subagent-provider";
      origin: string;
      openaiBaseUrl: string;
      healthUrl: string;
      chatCompletionsUrl: string;
    };
  };
}

export interface CommandCodeProxyProviderProfile {
  id: "commandcode-proxy";
  name: "CommandCode Proxy";
  baseUrl: string;
  adapter: "openai-chat";
  modelEndpoint: "/models";
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonObject = Record<string, unknown>;

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

export function resolveCodexRouterConnection(
  env: Record<string, string | undefined> = process.env,
): CodexRouterConnection | undefined {
  const configuredOrigin = env.CODING_TOOLS_CODEX_ROUTER_URL?.trim();
  const callerKey = env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY?.trim();
  if (!configuredOrigin && !callerKey) return undefined;
  if (!callerKey || !CALLER_KEY.test(callerKey)) {
    throw new Error("Codex Router caller key must be at least 32 URL-safe characters");
  }
  const origin = normalizeOrigin(
    configuredOrigin || "http://127.0.0.1:4202",
    "Codex Router URL",
    false,
  );
  const parsed = new URL(origin);
  if (parsed.pathname !== "/") {
    throw new Error("Codex Router URL must be an origin without a path");
  }
  const normalizedOrigin = origin.replace(/\/$/, "");
  return {
    origin: normalizedOrigin,
    callerKey,
    baseUrl: `${normalizedOrigin}/_codex-router/${callerKey}/v1`,
  };
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
  try {
    const router = resolveCodexRouterConnection(env);
    if (router) {
      backends["codex-router"] = {
        role: "subagent-provider",
        origin: router.origin,
        openaiBaseUrl: router.baseUrl,
        healthUrl: `${router.baseUrl}/models`,
        chatCompletionsUrl: `${router.baseUrl}/chat/completions`,
      };
    }
  } catch {
    // Invalid Router env stays undiscoverable so MCP catalog reads do not throw.
  }
  return {
    kind: "coding-tools-provider-backends",
    role: "provider-backend",
    backends,
  };
}

export function codexRouterModelId(slug: string): string {
  const normalized = slug.trim();
  if (!normalized || normalized.startsWith(CODEX_ROUTER_PREFIX)) {
    throw new Error("Codex Router model slug must be a non-namespaced model id");
  }
  return `${CODEX_ROUTER_PREFIX}${normalized}`;
}

export function parseCodexRouterModelId(model: string): string | undefined {
  if (!model.startsWith(CODEX_ROUTER_PREFIX)) return undefined;
  const slug = model.slice(CODEX_ROUTER_PREFIX.length).trim();
  if (!slug || slug.startsWith(CODEX_ROUTER_PREFIX)) return undefined;
  return slug;
}

export function redactRouterError(text: string, connection: CodexRouterConnection): string {
  const capability = `/_codex-router/${connection.callerKey}`;
  return text
    .split(connection.callerKey).join("[REDACTED]")
    .split(encodeURIComponent(connection.callerKey)).join("[REDACTED]")
    .split(capability).join("/_codex-router/[REDACTED]");
}

export function commandCodeProxyProviderProfile(baseUrl: string): CommandCodeProxyProviderProfile {
  const normalized = normalizeOrigin(baseUrl.trim(), "CommandCode Proxy URL", true);
  return {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    baseUrl: normalized,
    adapter: "openai-chat",
    modelEndpoint: "/models",
  };
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function modelSlug(value: unknown): string | undefined {
  const model = object(value);
  return typeof model?.slug === "string" ? model.slug : undefined;
}

function routedTemplate(models: unknown[]): JsonObject | undefined {
  return models.find(candidate => {
    const model = object(candidate);
    const slug = modelSlug(model);
    return Boolean(
      model
      && slug
      && !slug.startsWith("chatgpt-web/")
      && !slug.startsWith(CODEX_ROUTER_PREFIX)
      && model.visibility === "list"
      && Array.isArray(model.supported_reasoning_levels),
    );
  }) as JsonObject | undefined;
}

function routedSubagentVersion(template: JsonObject, config: AppConfig): string | undefined {
  if (config.subagentProtocol === "compatibility-v1") return "v1";
  return typeof template.multi_agent_version === "string"
    ? template.multi_agent_version
    : undefined;
}

function routedCatalogRow(
  template: JsonObject,
  routerSlug: string,
  config: AppConfig,
  index: number,
): JsonObject {
  const priority = typeof template.priority === "number" && Number.isSafeInteger(template.priority)
    ? template.priority + 100 + index
    : undefined;
  const subagentVersion = routedSubagentVersion(template, config);
  const row: JsonObject = {
    ...structuredClone(template),
    slug: codexRouterModelId(routerSlug),
    display_name: `${routerSlug} (Codex Router)`,
    description: `Routed through the local Codex Router: ${routerSlug}`,
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    ...(priority === undefined ? {} : { priority }),
    ...(subagentVersion === undefined ? {} : { multi_agent_version: subagentVersion }),
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete row.comp_hash;
  delete row.availability_nux;
  return row;
}

function externalModelIds(value: unknown): string[] | undefined {
  const root = object(value);
  if (!root || !Array.isArray(root.data)) return undefined;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of root.data) {
    const entry = object(item);
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || id.startsWith(CODEX_ROUTER_PREFIX) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function augmentWithCodexRouterModels(
  value: Record<string, unknown>,
  config: AppConfig,
  connection: CodexRouterConnection,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const result = structuredClone(value);
  if (!Array.isArray(result.models)) return result;
  let response: Response;
  try {
    response = await fetchImpl(`${connection.baseUrl}/models`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    return result;
  }
  if (!response.ok) return result;
  let ids: string[] | undefined;
  try {
    ids = externalModelIds(await response.json());
  } catch {
    return result;
  }
  if (!ids?.length) return result;
  const template = routedTemplate(result.models);
  if (!template) return result;
  const existing = new Set(result.models.map(modelSlug).filter((slug): slug is string => Boolean(slug)));
  const rows: JsonObject[] = [];
  for (const id of ids) {
    const namespaced = `${CODEX_ROUTER_PREFIX}${id}`;
    if (existing.has(namespaced)) continue;
    existing.add(namespaced);
    rows.push(routedCatalogRow(template, id, config, rows.length));
  }
  result.models.push(...rows);
  return result;
}

export async function forwardCodexRouterResponse(
  req: Request,
  rawBody: Record<string, unknown>,
  connection: CodexRouterConnection,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const requestedModel = typeof rawBody.model === "string" ? rawBody.model : "";
  const routedModel = parseCodexRouterModelId(requestedModel);
  if (!routedModel) throw new Error("Request does not target a Codex Router model");
  const body = { ...rawBody, model: routedModel };
  const headers = new Headers(req.headers);
  headers.delete("authorization");
  headers.delete("content-length");
  headers.delete("host");
  headers.set("content-type", "application/json");
  try {
    return await fetchImpl(`${connection.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactRouterError(message, connection));
  }
}

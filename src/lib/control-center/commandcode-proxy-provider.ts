export interface CommandCodeProxyProviderProfile {
  id: "commandcode-proxy";
  name: "CommandCode Proxy";
  baseUrl: string;
  adapter: "openai-chat";
  modelEndpoint: "/models";
}

export interface CommandCodeProxyRegistrationPlan {
  provider: CommandCodeProxyProviderProfile;
  commands: string[][];
  credentialPromptRequired: true;
}

export interface CommandCodeProxyRegistrationOptions {
  baseUrl: string;
  routerCli?: string;
  curateCli?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

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

export function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return LOOPBACK_HOSTS.has(hostname);
}

export function commandCodeProxyRegistrationPlan({
  baseUrl,
  routerCli = "model-router",
  curateCli = "curate-models",
}: CommandCodeProxyRegistrationOptions): CommandCodeProxyRegistrationPlan {
  if (!routerCli.trim()) throw new Error("Codex Router CLI path is required");
  if (!curateCli.trim()) throw new Error("Codex Router curate-models path is required");
  const provider = commandCodeProxyProviderProfile(baseUrl);
  const add = [
    routerCli,
    "codex",
    "providers",
    "generic",
    "add",
    provider.id,
    "--name",
    provider.name,
    "--base-url",
    provider.baseUrl,
    "--adapter",
    provider.adapter,
  ];
  if (isLoopbackUrl(provider.baseUrl)) add.push("--allow-private");
  return {
    provider,
    commands: [
      add,
      [routerCli, "codex", "providers", "generic", "credential", provider.id, "set"],
      [routerCli, "codex", "providers", "generic", "enable", provider.id],
      [curateCli, provider.id],
    ],
    credentialPromptRequired: true,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderCommandCodeProxyPlan(plan: CommandCodeProxyRegistrationPlan): string {
  return [
    "CommandCode Proxy will be registered as a Codex Router generic provider.",
    "The CommandCode user_* key is entered only in Codex Router's hidden credential prompt; Coding Tools never accepts it.",
    "",
    ...plan.commands.map(command => command.map(shellQuote).join(" ")),
    "",
    "Run the curation step after the provider credential and enable steps so the live /v1/models catalog becomes available to Codex subagents.",
  ].join("\n");
}

export const COMMANDCODE_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:3050/v1";
export const COMMANDCODE_PROXY_ALTERNATE_LISTEN = "http://127.0.0.1:9090/";

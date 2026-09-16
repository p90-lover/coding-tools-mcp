export type ProviderAuth = "oauth" | "api_key" | "browser" | "proxy";

export type ProxyMode = "inherit" | "direct" | "custom";

export interface ProviderDefinition {
  id: string;
  name: string;
  auth: ProviderAuth;
  models: string[];
  proxyMode: ProxyMode;
}

export interface ProviderRoute {
  providerId: string;
  model?: string;
  proxy?: string;
}

export const DEFAULT_PROVIDERS: ProviderDefinition[] = [
  {
    id: "chatgpt-web",
    name: "ChatGPT Web",
    auth: "browser",
    models: ["web-gpt"],
    proxyMode: "inherit",
  },
  {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    auth: "proxy",
    models: [],
    proxyMode: "custom",
  },
  {
    id: "paseo",
    name: "Paseo Orchestrator",
    auth: "proxy",
    models: [],
    proxyMode: "inherit",
  },
  {
    id: "anneal",
    name: "Anneal Tasks",
    auth: "proxy",
    models: [],
    proxyMode: "inherit",
  },
];

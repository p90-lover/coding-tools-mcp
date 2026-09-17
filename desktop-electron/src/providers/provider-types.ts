export type ProviderAuth =
  | "oauth"
  | "api_key"
  | "browser_session"
  | "local_proxy";

export type ProviderCategory =
  | "api_key"
  | "oauth"
  | "browser"
  | "reverse_proxy"
  | "custom";

export type ProviderProtocol =
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_native"
  | "custom";

export type ProviderCapability =
  | "text"
  | "reasoning"
  | "tools"
  | "vision"
  | "image_generation";

export type ProxyMode = "inherit" | "direct" | "custom";
export type ProviderLoginMode = "browser" | "antigravity_management";

export interface ProviderDefinition {
  id: string;
  name: string;
  category: ProviderCategory;
  auth: ProviderAuth;
  protocol: ProviderProtocol;
  capabilities: ProviderCapability[];
  models: string[];
  proxyMode: ProxyMode;
  baseUrl?: string;
  modelsEndpoint?: string;
  loginMode?: ProviderLoginMode;
  paseoEnabled: boolean;
  annealEnabled: boolean;
  priority: number;
}

export interface ProviderRoute {
  providerId: string;
  model?: string;
  proxyPolicyId?: string;
}

export const DEFAULT_PROVIDERS = [
  {
    id: "codex-oauth",
    name: "Codex OAuth",
    category: "oauth",
    auth: "oauth",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 100,
  },
  {
    id: "claude-oauth",
    name: "Claude OAuth",
    category: "oauth",
    auth: "oauth",
    protocol: "anthropic_messages",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 90,
  },
  {
    id: "chatgpt-web",
    name: "ChatGPT Web",
    category: "browser",
    auth: "browser_session",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: ["web-gpt"],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 80,
  },
  {
    id: "ai-studio-reverse-proxy",
    name: "AI Studio Reverse Proxy",
    category: "reverse_proxy",
    auth: "browser_session",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "vision", "image_generation"],
    models: [],
    proxyMode: "custom",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 70,
  },
  {
    id: "gemini-reverse-proxy",
    name: "Gemini Reverse Proxy",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "custom",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 60,
  },
  {
    id: "aistudio-to-api",
    name: "AIStudioToAPI",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "vision", "image_generation"],
    models: [],
    proxyMode: "custom",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 50,
  },
  {
    id: "cliproxyapi-antigravity",
    name: "CLIProxyAPI / Antigravity",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "custom",
    baseUrl: "http://127.0.0.1:8317",
    modelsEndpoint: "/v0/management/auth-files/models",
    loginMode: "antigravity_management",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 40,
  },
  {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "custom",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 30,
  },
] satisfies ProviderDefinition[];

export const ADDITIONAL_PROVIDERS = [
  {
    id: "openai-api",
    name: "OpenAI API",
    category: "api_key",
    auth: "api_key",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 95,
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    category: "api_key",
    auth: "api_key",
    protocol: "anthropic_messages",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 85,
  },
  {
    id: "gemini-api",
    name: "Gemini API",
    category: "api_key",
    auth: "api_key",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 75,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "api_key",
    auth: "api_key",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "inherit",
    baseUrl: "https://openrouter.ai/api/v1",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 65,
  },
  {
    id: "ollama",
    name: "Ollama",
    category: "custom",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "direct",
    baseUrl: "http://127.0.0.1:11434/v1",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 20,
  },
  {
    id: "custom-openai-compatible",
    name: "Custom OpenAI Compatible",
    category: "custom",
    auth: "api_key",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 10,
  },
] satisfies ProviderDefinition[];

export const PROVIDER_CATALOG = [
  ...DEFAULT_PROVIDERS,
  ...ADDITIONAL_PROVIDERS,
] satisfies ProviderDefinition[];

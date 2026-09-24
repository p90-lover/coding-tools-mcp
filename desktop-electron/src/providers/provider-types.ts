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
export type ProviderLoginMode = "browser" | "antigravity_management" | "commandcode_oauth";
export type ProviderLoginAdapterKind =
  | "native_browser"
  | "cpa_oauth"
  | "cpa_auth_file"
  | "commandcode_oauth";

export interface ProviderLoginAdapterDefinition {
  id: string;
  kind: ProviderLoginAdapterKind;
  label: string;
  labelTraditionalChinese: string;
  route?: string;
  cpaProvider?: string;
}

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
  requestDefaults?: {
    chatPath?: string;
    modelsPath?: string;
    authHeaderName?: string;
    extraHeaders?: Record<string, string>;
  };
  loginMode?: ProviderLoginMode;
  loginAdapters?: ProviderLoginAdapterDefinition[];
  subagentEnabled: boolean;
  paseoEnabled: boolean;
  annealEnabled: boolean;
  priority: number;
}

export interface ProviderRoute {
  providerId: string;
  model?: string;
  proxyPolicyId?: string;
}

export const DEFAULT_PROVIDERS: ProviderDefinition[] = [
  {
    id: "codex-oauth",
    name: "Codex OAuth",
    category: "oauth",
    auth: "oauth",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-codex", kind: "cpa_oauth", label: "CPA / CLIProxyAPI OAuth", labelTraditionalChinese: "CPA／CLIProxyAPI OAuth", route: "codex-auth-url", cpaProvider: "codex" },
      { id: "native-browser", kind: "native_browser", label: "Native BrowserHost", labelTraditionalChinese: "原生 BrowserHost" },
    ],
    subagentEnabled: true,
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
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-claude", kind: "cpa_oauth", label: "CPA / CLIProxyAPI OAuth", labelTraditionalChinese: "CPA／CLIProxyAPI OAuth", route: "anthropic-auth-url", cpaProvider: "anthropic" },
    ],
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 90,
  },
  {
    id: "gemini-oauth",
    name: "Gemini OAuth (CPA)",
    category: "oauth",
    auth: "oauth",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-gemini", kind: "cpa_auth_file", label: "Import CPA Gemini account", labelTraditionalChinese: "匯入 CPA Gemini 帳戶", cpaProvider: "gemini" },
    ],
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 78,
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
    loginAdapters: [
      { id: "native-browser", kind: "native_browser", label: "Native BrowserHost", labelTraditionalChinese: "原生 BrowserHost" },
    ],
    subagentEnabled: true,
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
    subagentEnabled: true,
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
    subagentEnabled: true,
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
    subagentEnabled: true,
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
    loginAdapters: [
      { id: "cpa-antigravity", kind: "cpa_oauth", label: "CPA / Antigravity OAuth", labelTraditionalChinese: "CPA／Antigravity OAuth", route: "antigravity-auth-url", cpaProvider: "antigravity" },
    ],
    subagentEnabled: true,
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
    baseUrl: "http://127.0.0.1:9090",
    modelsEndpoint: "/v1/models",
    loginMode: "commandcode_oauth",
    loginAdapters: [
      { id: "commandcode-oauth", kind: "commandcode_oauth", label: "CommandCode OAuth", labelTraditionalChinese: "CommandCode OAuth" },
    ],
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 30,
  },
] satisfies ProviderDefinition[];

export const ADDITIONAL_PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai-api",
    name: "OpenAI API",
    category: "api_key",
    auth: "api_key",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: ["gpt-4.1", "gpt-4o", "o3"],
    proxyMode: "inherit",
    baseUrl: "https://api.openai.com/v1",
    modelsEndpoint: "/models",
    requestDefaults: {
      chatPath: "/chat/completions",
      modelsPath: "/models",
      authHeaderName: "Authorization",
    },
    subagentEnabled: true,
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
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    proxyMode: "inherit",
    baseUrl: "https://api.anthropic.com",
    modelsEndpoint: "/v1/models",
    requestDefaults: {
      chatPath: "/v1/messages",
      modelsPath: "/v1/models",
      authHeaderName: "x-api-key",
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
    subagentEnabled: true,
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
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    proxyMode: "inherit",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsEndpoint: "/models",
    requestDefaults: {
      chatPath: "/models/{model}:generateContent",
      modelsPath: "/models",
      authHeaderName: "x-goog-api-key",
    },
    subagentEnabled: true,
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
    modelsEndpoint: "/models",
    requestDefaults: {
      chatPath: "/chat/completions",
      modelsPath: "/models",
      authHeaderName: "Authorization",
      extraHeaders: { "HTTP-Referer": "https://coding-tools.local", "X-Title": "Coding Tools" },
    },
    subagentEnabled: true,
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
    modelsEndpoint: "/models",
    requestDefaults: {
      chatPath: "/chat/completions",
      modelsPath: "/models",
      authHeaderName: "Authorization",
    },
    subagentEnabled: true,
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
    models: ["gpt-4.1", "gpt-4o"],
    proxyMode: "inherit",
    baseUrl: "https://api.openai.com/v1",
    modelsEndpoint: "/models",
    requestDefaults: {
      chatPath: "/chat/completions",
      modelsPath: "/models",
      authHeaderName: "Authorization",
    },
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 10,
  },
  {
    id: "custom-anthropic-compatible",
    name: "Custom Anthropic Compatible",
    category: "custom",
    auth: "api_key",
    protocol: "anthropic_messages",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    proxyMode: "inherit",
    baseUrl: "https://api.anthropic.com",
    modelsEndpoint: "/v1/models",
    requestDefaults: {
      chatPath: "/v1/messages",
      modelsPath: "/v1/models",
      authHeaderName: "x-api-key",
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 9,
  },
] satisfies ProviderDefinition[];

export const PROVIDER_CATALOG = [
  ...DEFAULT_PROVIDERS,
  ...ADDITIONAL_PROVIDERS,
] satisfies ProviderDefinition[];

export type ProviderAuthKind =
  | "api_key"
  | "oauth"
  | "browser_session"
  | "local_proxy";

export type ProviderProtocol =
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_native"
  | "image_api";

export type ProviderCapability =
  | "text"
  | "reasoning"
  | "tools"
  | "vision"
  | "image_generation";

export type ProviderCategory =
  | "api_key"
  | "oauth"
  | "browser"
  | "reverse_proxy"
  | "custom";

export type ProviderEngine = "codex" | "paseo" | "anneal";

export interface ProviderProfile {
  id: string;
  name: string;
  description: string;
  category: ProviderCategory;
  auth: ProviderAuthKind;
  protocol: ProviderProtocol;
  baseUrl?: string;
  modelsEndpoint?: string;
  capabilities: ProviderCapability[];
  codexEnabled: boolean;
  paseoEnabled: boolean;
  annealEnabled: boolean;
  priority: number;
  configurableBaseUrl: boolean;
  requiresExplicitConsent: boolean;
}

export const builtinProviderProfiles: readonly ProviderProfile[] = [
  {
    id: "codex-oauth",
    name: "Codex OAuth",
    description: "Use the signed-in Codex account through the native Codex provider path.",
    category: "oauth",
    auth: "oauth",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools", "vision"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 10,
    configurableBaseUrl: false,
    requiresExplicitConsent: true,
  },
  {
    id: "claude-oauth",
    name: "Claude OAuth",
    description: "Use a Claude OAuth session without storing a raw API key in Coding Tools.",
    category: "oauth",
    auth: "oauth",
    protocol: "anthropic_messages",
    capabilities: ["text", "reasoning", "tools", "vision"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 20,
    configurableBaseUrl: false,
    requiresExplicitConsent: true,
  },
  {
    id: "chatgpt-web",
    name: "ChatGPT Web",
    description: "Route through the user-authenticated ChatGPT Web Responses bridge.",
    category: "browser",
    auth: "browser_session",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 30,
    configurableBaseUrl: false,
    requiresExplicitConsent: true,
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    description: "OpenAI-compatible API-key provider with Responses and model discovery support.",
    category: "api_key",
    auth: "api_key",
    protocol: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 40,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Anthropic Messages API provider using a user-supplied key.",
    category: "api_key",
    auth: "api_key",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    capabilities: ["text", "reasoning", "tools", "vision"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 50,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "gemini-api",
    name: "Gemini API",
    description: "Google Gemini API-key provider with native model discovery.",
    category: "api_key",
    auth: "api_key",
    protocol: "gemini_native",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 60,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    description: "Local CommandCode-compatible reverse proxy with dynamic model discovery.",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 70,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "ai-studio-reverse-proxy",
    name: "AI Studio Reverse Proxy",
    description: "Browser-session-backed AI Studio reverse proxy for Gemini-native traffic.",
    category: "reverse_proxy",
    auth: "browser_session",
    protocol: "gemini_native",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 80,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "gemini-reverse-proxy",
    name: "Gemini Reverse Proxy",
    description: "Local Gemini-native reverse proxy for browser or API-backed models.",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "gemini_native",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 90,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "aistudio-to-api",
    name: "AIStudioToAPI",
    description: "AIStudioToAPI OpenAI-compatible local reverse proxy.",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 100,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "cliproxyapi-antigravity",
    name: "CLIProxyAPI / Antigravity",
    description: "CLIProxyAPI-compatible local endpoint, including Antigravity-style model routing.",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 110,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "custom-openai-compatible",
    name: "Custom OpenAI-Compatible",
    description: "User-defined OpenAI Chat or Responses-compatible provider profile.",
    category: "custom",
    auth: "api_key",
    protocol: "openai_chat",
    modelsEndpoint: "/models",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 120,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
  {
    id: "custom-anthropic-compatible",
    name: "Custom Anthropic-Compatible",
    description: "User-defined Anthropic Messages-compatible provider profile.",
    category: "custom",
    auth: "api_key",
    protocol: "anthropic_messages",
    capabilities: ["text", "reasoning", "tools", "vision"],
    codexEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 130,
    configurableBaseUrl: true,
    requiresExplicitConsent: true,
  },
];

export function getBuiltinProvider(id: string): ProviderProfile | undefined {
  return builtinProviderProfiles.find((provider) => provider.id === id);
}

export function providersForEngine(engine: ProviderEngine): ProviderProfile[] {
  return builtinProviderProfiles
    .filter((provider) => {
      if (engine === "codex") return provider.codexEnabled;
      if (engine === "paseo") return provider.paseoEnabled;
      return provider.annealEnabled;
    })
    .sort((left, right) => left.priority - right.priority);
}

export function validateProviderProfiles(
  profiles: readonly ProviderProfile[] = builtinProviderProfiles,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const provider of profiles) {
    if (!provider.id || !/^[a-z0-9][a-z0-9-]*$/.test(provider.id)) {
      errors.push(`Invalid provider id: ${provider.id || "<empty>"}`);
    }
    if (ids.has(provider.id)) errors.push(`Duplicate provider id: ${provider.id}`);
    ids.add(provider.id);
    if (!provider.name.trim()) errors.push(`Provider ${provider.id} has no name`);
    if (!provider.description.trim()) errors.push(`Provider ${provider.id} has no description`);
    if (!Number.isFinite(provider.priority) || provider.priority < 0) {
      errors.push(`Provider ${provider.id} has an invalid priority`);
    }
    if (provider.capabilities.length === 0) {
      errors.push(`Provider ${provider.id} has no capabilities`);
    }
    if (!provider.codexEnabled && !provider.paseoEnabled && !provider.annealEnabled) {
      errors.push(`Provider ${provider.id} is not enabled for any engine`);
    }
  }

  return errors;
}

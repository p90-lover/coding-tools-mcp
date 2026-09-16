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

export interface ProviderProfile {
  id: string;
  name: string;
  category: ProviderCategory;
  auth: ProviderAuthKind;
  protocol: ProviderProtocol;
  baseUrl?: string;
  modelsEndpoint?: string;
  capabilities: ProviderCapability[];
  paseoEnabled: boolean;
  annealEnabled: boolean;
  priority: number;
}

export const builtinProviderProfiles: ProviderProfile[] = [
  {
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools"],
    paseoEnabled: true,
    annealEnabled: true,
    priority: 50,
  },
  {
    id: "ai-studio-reverse-proxy",
    name: "AI Studio Reverse Proxy",
    category: "reverse_proxy",
    auth: "browser_session",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "vision", "image_generation"],
    paseoEnabled: true,
    annealEnabled: true,
    priority: 40,
  },
  {
    id: "gemini-reverse-proxy",
    name: "Gemini Reverse Proxy",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "vision"],
    paseoEnabled: true,
    annealEnabled: true,
    priority: 30,
  },
  {
    id: "aistudio-to-api",
    name: "AIStudioToAPI",
    category: "reverse_proxy",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "vision", "image_generation"],
    paseoEnabled: true,
    annealEnabled: true,
    priority: 20,
  },
];

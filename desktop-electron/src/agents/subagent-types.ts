import type { ProviderCapability } from "../providers/provider-types";

export type AgentProvider =
  | "codex"
  | "claude"
  | "chatgpt-web"
  | "gemini"
  | "custom";

export type AgentRole =
  | "planner"
  | "coder"
  | "researcher"
  | "reviewer"
  | "monitor";

export interface AgentPermissionPolicy {
  browser: boolean;
  filesystem: boolean;
  terminal: boolean;
  github: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  provider: AgentProvider;
  providerId?: string;
  capabilities?: ProviderCapability[];
  role: AgentRole;
  enabled: boolean;
  permissions: AgentPermissionPolicy;
  systemPrompt?: string;
}

export interface AgentRegistry {
  agents: AgentProfile[];
  register(agent: AgentProfile): void;
  get(id: string): AgentProfile | undefined;
}

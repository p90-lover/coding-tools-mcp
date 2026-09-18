export type ProviderAuthType =
  | 'api_key'
  | 'oauth'
  | 'browser_session'
  | 'local_proxy';

export type ProviderProtocol =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'gemini_native'
  | 'image_api';

export type ProviderCapability =
  | 'text'
  | 'reasoning'
  | 'tools'
  | 'vision'
  | 'image_generation';

export type ExecutionTarget = 'paseo' | 'anneal';

export interface ProviderCapabilityProfile {
  id: string;
  name: string;
  auth: ProviderAuthType;
  protocol: ProviderProtocol;
  capabilities: ProviderCapability[];
  targets: ExecutionTarget[];
}

export const builtInProviderCapabilities: ProviderCapabilityProfile[] = [
  {
    id: 'codex-oauth',
    name: 'Codex OAuth',
    auth: 'oauth',
    protocol: 'openai_responses',
    capabilities: ['text', 'reasoning', 'tools'],
    targets: ['paseo', 'anneal'],
  },
  {
    id: 'claude-oauth',
    name: 'Claude OAuth',
    auth: 'oauth',
    protocol: 'anthropic_messages',
    capabilities: ['text', 'reasoning', 'tools'],
    targets: ['paseo', 'anneal'],
  },
  {
    id: 'ai-studio-reverse-proxy',
    name: 'AI Studio Reverse Proxy',
    auth: 'browser_session',
    protocol: 'gemini_native',
    capabilities: ['text', 'vision', 'image_generation'],
    targets: ['paseo', 'anneal'],
  },
  {
    id: 'gemini-reverse-proxy',
    name: 'Gemini Reverse Proxy',
    auth: 'local_proxy',
    protocol: 'gemini_native',
    capabilities: ['text', 'vision', 'tools', 'image_generation'],
    targets: ['paseo', 'anneal'],
  },
  {
    id: 'commandcode-proxy',
    name: 'CommandCode Proxy',
    auth: 'local_proxy',
    protocol: 'openai_chat',
    capabilities: ['text', 'reasoning', 'tools'],
    targets: ['paseo', 'anneal'],
  },
];

export function supports(profile: ProviderCapabilityProfile, capability: ProviderCapability): boolean {
  return profile.capabilities.includes(capability);
}

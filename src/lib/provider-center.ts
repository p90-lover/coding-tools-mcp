import { invoke } from '@tauri-apps/api/core';

export type ProviderCategory = 'api_key' | 'oauth' | 'browser' | 'reverse_proxy' | 'custom';
export type ProviderAuth = 'api_key' | 'oauth' | 'browser_session' | 'local_proxy' | 'none';
export type ProviderProtocol =
  | 'open_ai_chat'
  | 'open_ai_responses'
  | 'anthropic_messages'
  | 'gemini_native'
  | 'image_api';
export type ProviderCapability =
  | 'text'
  | 'reasoning'
  | 'tools'
  | 'vision'
  | 'image_generation';

export interface ProviderProfile {
  id: string;
  name: string;
  template_id: string;
  category: ProviderCategory;
  auth: ProviderAuth;
  protocol: ProviderProtocol;
  base_url: string | null;
  models_endpoint: string | null;
  models: string[];
  capabilities: ProviderCapability[];
  paseo_enabled: boolean;
  anneal_enabled: boolean;
  direct_enabled: boolean;
  image_enabled: boolean;
  priority: number;
  enabled: boolean;
  archived: boolean;
  generation: string;
  revision: number;
  updated_at: number;
}

export interface ProviderHealth {
  provider_id: string;
  status: 'unknown' | 'ready' | 'error' | 'needs_authentication' | 'managed_externally' | 'disabled';
  checked_at: number | null;
  latency_ms: number | null;
  error: string | null;
  models: string[];
}

export interface ProviderRegistryView {
  revision: number;
  templates: ProviderProfile[];
  profiles: ProviderProfile[];
  health: ProviderHealth[];
}

export type ProviderProfileInput = Omit<
  ProviderProfile,
  'generation' | 'revision' | 'updated_at' | 'archived'
> & { id: string | null };

export const PROVIDER_CAPABILITIES: ProviderCapability[] = [
  'text',
  'reasoning',
  'tools',
  'vision',
  'image_generation'
];

export function profileFromTemplate(template: ProviderProfile): ProviderProfileInput {
  return {
    id: null,
    name: template.name,
    template_id: template.id,
    category: template.category,
    auth: template.auth,
    protocol: template.protocol,
    base_url: template.base_url,
    models_endpoint: template.models_endpoint,
    models: [...template.models],
    capabilities: [...template.capabilities],
    paseo_enabled: template.paseo_enabled,
    anneal_enabled: template.anneal_enabled,
    direct_enabled: template.direct_enabled,
    image_enabled: template.image_enabled,
    priority: template.priority,
    enabled: true
  };
}

export function profileForEdit(profile: ProviderProfile): ProviderProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    template_id: profile.template_id,
    category: profile.category,
    auth: profile.auth,
    protocol: profile.protocol,
    base_url: profile.base_url,
    models_endpoint: profile.models_endpoint,
    models: [...profile.models],
    capabilities: [...profile.capabilities],
    paseo_enabled: profile.paseo_enabled,
    anneal_enabled: profile.anneal_enabled,
    direct_enabled: profile.direct_enabled,
    image_enabled: profile.image_enabled,
    priority: profile.priority,
    enabled: profile.enabled
  };
}

export const readProviderProfiles = (): Promise<ProviderRegistryView> =>
  invoke('provider_profiles_read');

export const saveProviderProfile = (
  expectedRevision: number,
  profile: ProviderProfileInput,
  credential: string | null
): Promise<ProviderRegistryView> =>
  invoke('provider_profile_save', {
    expectedRevision,
    profile,
    credential: credential?.trim() ? credential : null,
    confirm: true
  });

export const connectProviderProfile = (
  profileId: string,
  credential: string
): Promise<ProviderRegistryView> =>
  invoke('provider_profile_connect', { profileId, credential, confirm: true });

export const disableProviderProfile = (profileId: string): Promise<ProviderRegistryView> =>
  invoke('provider_profile_disable', { profileId, confirm: true });

export const archiveProviderProfile = (profileId: string): Promise<ProviderRegistryView> =>
  invoke('provider_profile_archive', { profileId, confirm: true });

export const probeProviderProfile = (
  profileId: string,
  discoverModels: boolean
): Promise<ProviderRegistryView> =>
  invoke('provider_profile_probe', { profileId, discoverModels });

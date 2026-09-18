import { invoke } from '@tauri-apps/api/core';

export type ImageGenerationTarget = 'paseo' | 'anneal' | 'direct';

export interface ImageGenerationInput {
  workspace_id: string;
  provider_profile_id: string;
  credential: string;
  target: ImageGenerationTarget;
  model: string;
  prompt: string;
  negative_prompt: string | null;
  size: string | null;
  aspect_ratio: string | null;
  count: number;
}

export interface ImageArtifact {
  id: string;
  absolute_path: string;
  relative_path: string;
  media_type: string;
  byte_length: number;
  revised_prompt: string | null;
}

export interface ImageGenerationResult {
  request_id: string;
  workspace_id: string;
  provider_profile_id: string;
  provider_name: string;
  model: string;
  target: ImageGenerationTarget;
  created_at: number;
  artifacts: ImageArtifact[];
  manifest_path: string;
}

export const generateProviderImage = (
  input: ImageGenerationInput
): Promise<ImageGenerationResult> =>
  invoke('provider_image_generate', { input, confirm: true });

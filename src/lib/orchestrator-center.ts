import { invoke } from '@tauri-apps/api/core';

export type OrchestratorExecutionMode = 'sequential' | 'parallel_groups';

export interface OrchestratorStage {
  id: string;
  name: string;
  role: string;
  provider_profile_id: string;
  model: string;
  fallback_provider_ids: string[];
  instructions: string;
  anneal_agent_id: string | null;
  parallel_group: number | null;
  approval_gate: boolean;
  optional: boolean;
  opens_pull_request: boolean;
  requires_commit: boolean;
  output_kind: string;
}

export interface OrchestratorProfile {
  id: string;
  name: string;
  project_id: string;
  repo_id: string;
  environment_id: string | null;
  template_id: string | null;
  staffing_profile_id: string | null;
  stages: OrchestratorStage[];
  execution_mode: OrchestratorExecutionMode;
  max_concurrency: number;
  retry_limit: number;
  max_duration_min: number;
  approval_required: boolean;
  enabled: boolean;
  archived: boolean;
  revision: number;
  updated_at: number;
}

export type OrchestratorProfileInput = Omit<
  OrchestratorProfile,
  'archived' | 'revision' | 'updated_at'
> & { id: string | null };

export interface ResolvedOrchestrator {
  id: string;
  runnable: boolean;
  stages: Array<{
    id: string;
    name: string;
    role: string;
    provider_profile_id: string;
    provider_name: string | null;
    model: string;
    fallback_provider_ids: string[];
    anneal_agent_id: string | null;
    parallel_group: number | null;
    approval_gate: boolean;
    output_kind: string;
  }>;
}

export interface OrchestratorRegistryView {
  revision: number;
  profiles: OrchestratorProfile[];
  resolved: ResolvedOrchestrator[];
}

export interface AnnealOrchestratorRunInput {
  profile_id: string;
  endpoint: string;
  operator_token: string;
  name: string;
  description: string;
  branch_name: string;
  auto_start: boolean;
}

export interface AnnealOrchestratorRunResult {
  profile_id: string;
  profile_revision: number;
  project_id: string;
  template_id: string;
  status: number;
  accepted: boolean;
  response: unknown;
}

export function defaultStages(providerProfileId = ''): OrchestratorStage[] {
  return [
    {
      id: 'planner',
      name: 'Planner',
      role: 'planner',
      provider_profile_id: providerProfileId,
      model: '',
      fallback_provider_ids: [],
      instructions: 'Break the task into an explicit implementation plan and identify risks.',
      anneal_agent_id: null,
      parallel_group: null,
      approval_gate: true,
      optional: false,
      opens_pull_request: false,
      requires_commit: false,
      output_kind: 'plan'
    },
    {
      id: 'implementation',
      name: 'Implementer',
      role: 'implementer',
      provider_profile_id: providerProfileId,
      model: '',
      fallback_provider_ids: [],
      instructions: 'Implement the approved plan with focused tests and retained evidence.',
      anneal_agent_id: null,
      parallel_group: null,
      approval_gate: false,
      optional: false,
      opens_pull_request: true,
      requires_commit: true,
      output_kind: 'implementation'
    },
    {
      id: 'review',
      name: 'Reviewer',
      role: 'reviewer',
      provider_profile_id: providerProfileId,
      model: '',
      fallback_provider_ids: [],
      instructions: 'Review correctness, security, regressions and requirement coverage.',
      anneal_agent_id: null,
      parallel_group: null,
      approval_gate: true,
      optional: false,
      opens_pull_request: false,
      requires_commit: false,
      output_kind: 'review'
    },
    {
      id: 'verification',
      name: 'Verifier',
      role: 'verifier',
      provider_profile_id: providerProfileId,
      model: '',
      fallback_provider_ids: [],
      instructions: 'Run the focused and release verification gates and report exact evidence.',
      anneal_agent_id: null,
      parallel_group: null,
      approval_gate: true,
      optional: false,
      opens_pull_request: false,
      requires_commit: false,
      output_kind: 'verification'
    }
  ];
}

export function newOrchestratorProfile(providerProfileId = ''): OrchestratorProfileInput {
  return {
    id: null,
    name: 'Coding team',
    project_id: '',
    repo_id: '',
    environment_id: null,
    template_id: null,
    staffing_profile_id: null,
    stages: defaultStages(providerProfileId),
    execution_mode: 'sequential',
    max_concurrency: 1,
    retry_limit: 2,
    max_duration_min: 60,
    approval_required: true,
    enabled: true
  };
}

export function orchestratorForEdit(profile: OrchestratorProfile): OrchestratorProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    project_id: profile.project_id,
    repo_id: profile.repo_id,
    environment_id: profile.environment_id,
    template_id: profile.template_id,
    staffing_profile_id: profile.staffing_profile_id,
    stages: profile.stages.map((stage) => ({
      ...stage,
      fallback_provider_ids: [...stage.fallback_provider_ids]
    })),
    execution_mode: profile.execution_mode,
    max_concurrency: profile.max_concurrency,
    retry_limit: profile.retry_limit,
    max_duration_min: profile.max_duration_min,
    approval_required: profile.approval_required,
    enabled: profile.enabled
  };
}

export const readOrchestrators = (): Promise<OrchestratorRegistryView> =>
  invoke('orchestrator_profiles_read');

export const saveOrchestrator = (
  expectedRevision: number,
  profile: OrchestratorProfileInput
): Promise<OrchestratorRegistryView> =>
  invoke('orchestrator_profile_save', { expectedRevision, profile, confirm: true });

export const archiveOrchestrator = (profileId: string): Promise<OrchestratorRegistryView> =>
  invoke('orchestrator_profile_archive', { profileId, confirm: true });

export const runAnnealOrchestrator = (
  input: AnnealOrchestratorRunInput
): Promise<AnnealOrchestratorRunResult> =>
  invoke('orchestrator_profile_run', { input, confirm: true });

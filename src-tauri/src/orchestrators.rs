use crate::{
    data::{AppData, DataStore},
    error::{AppError, AppResult},
    providers::{self, ProviderCapability, ProviderProfile},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{SystemTime, UNIX_EPOCH},
};

fn fail(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn default_true() -> bool {
    true
}

fn default_duration() -> u32 {
    60
}

fn default_concurrency() -> u8 {
    1
}

fn identifier(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(fail(format!(
            "{label} must contain 1..128 letters, digits, hyphens, underscores, dots or colons"
        )));
    }
    Ok(())
}

fn text(value: &str, max: usize, label: &str, required: bool) -> AppResult<()> {
    if (required && value.trim().is_empty())
        || value.len() > max
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(fail(format!("Invalid {label}")));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratorExecutionMode {
    #[default]
    Sequential,
    ParallelGroups,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestratorStage {
    pub id: String,
    pub name: String,
    pub role: String,
    pub provider_profile_id: String,
    pub model: String,
    #[serde(default)]
    pub fallback_provider_ids: Vec<String>,
    #[serde(default)]
    pub instructions: String,
    pub anneal_agent_id: Option<String>,
    pub parallel_group: Option<u8>,
    #[serde(default)]
    pub approval_gate: bool,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub opens_pull_request: bool,
    #[serde(default = "default_true")]
    pub requires_commit: bool,
    pub output_kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestratorProfile {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub repo_id: String,
    pub environment_id: Option<String>,
    pub template_id: Option<String>,
    pub staffing_profile_id: Option<String>,
    #[serde(default)]
    pub stages: Vec<OrchestratorStage>,
    #[serde(default)]
    pub execution_mode: OrchestratorExecutionMode,
    #[serde(default = "default_concurrency")]
    pub max_concurrency: u8,
    #[serde(default)]
    pub retry_limit: u8,
    #[serde(default = "default_duration")]
    pub max_duration_min: u32,
    #[serde(default = "default_true")]
    pub approval_required: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestratorProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub project_id: String,
    pub repo_id: String,
    pub environment_id: Option<String>,
    pub template_id: Option<String>,
    pub staffing_profile_id: Option<String>,
    #[serde(default)]
    pub stages: Vec<OrchestratorStage>,
    #[serde(default)]
    pub execution_mode: OrchestratorExecutionMode,
    #[serde(default = "default_concurrency")]
    pub max_concurrency: u8,
    #[serde(default)]
    pub retry_limit: u8,
    #[serde(default = "default_duration")]
    pub max_duration_min: u32,
    #[serde(default = "default_true")]
    pub approval_required: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestratorSnapshot {
    pub profile_id: String,
    pub profile_revision: u64,
    pub template_id: String,
    pub staffing_profile_id: Option<String>,
    pub step_overrides: BTreeMap<String, String>,
    pub approval_required: bool,
    pub max_duration_min: u32,
}

impl OrchestratorStage {
    fn validate(&self, data: &AppData) -> AppResult<ProviderProfile> {
        identifier(&self.id, "Orchestrator stage ID")?;
        text(&self.name, 200, "orchestrator stage name", true)?;
        text(&self.role, 128, "orchestrator stage role", true)?;
        identifier(&self.provider_profile_id, "Provider profile ID")?;
        text(&self.model, 256, "orchestrator stage model", true)?;
        text(
            &self.instructions,
            32_768,
            "orchestrator stage instructions",
            false,
        )?;
        text(&self.output_kind, 200, "orchestrator output kind", true)?;
        if let Some(agent_id) = &self.anneal_agent_id {
            identifier(agent_id, "Anneal agent ID")?;
        }
        if self.parallel_group.is_some_and(|group| group > 32) {
            return Err(fail("Parallel group must be between 0 and 32"));
        }
        let provider = providers::profile(data, &self.provider_profile_id)?;
        if !provider.anneal_enabled {
            return Err(fail(format!(
                "Provider {} is not admitted for Anneal",
                provider.name
            )));
        }
        if !provider.capabilities.contains(&ProviderCapability::Text) {
            return Err(fail(format!(
                "Provider {} cannot run a text-based Anneal stage",
                provider.name
            )));
        }
        if !provider.models.is_empty() && !provider.models.iter().any(|model| model == &self.model)
        {
            return Err(fail(format!(
                "Model {} is not in the discovered catalogue for {}",
                self.model, provider.name
            )));
        }
        let mut fallbacks = BTreeSet::new();
        for fallback in &self.fallback_provider_ids {
            identifier(fallback, "Fallback provider ID")?;
            if fallback == &self.provider_profile_id {
                return Err(fail("A stage cannot fall back to its primary provider"));
            }
            if !fallbacks.insert(fallback) {
                return Err(fail("Fallback providers must be unique"));
            }
            let fallback_profile = providers::profile(data, fallback)?;
            if !fallback_profile.anneal_enabled
                || !fallback_profile
                    .capabilities
                    .contains(&ProviderCapability::Text)
            {
                return Err(fail(format!(
                    "Fallback provider {} is not usable for Anneal",
                    fallback_profile.name
                )));
            }
        }
        Ok(provider)
    }
}

impl OrchestratorProfile {
    pub fn validate(&self, data: &AppData) -> AppResult<()> {
        identifier(&self.id, "Orchestrator profile ID")?;
        text(&self.name, 200, "orchestrator name", true)?;
        identifier(&self.project_id, "Anneal project ID")?;
        identifier(&self.repo_id, "Anneal repository ID")?;
        for value in [
            self.environment_id.as_deref(),
            self.template_id.as_deref(),
            self.staffing_profile_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            identifier(value, "Anneal resource ID")?;
        }
        if self.stages.is_empty() || self.stages.len() > 32 {
            return Err(fail("An orchestrator requires 1..32 stages"));
        }
        if !(1..=32).contains(&self.max_concurrency) {
            return Err(fail("Maximum concurrency must be 1..32"));
        }
        if self.retry_limit > 10 {
            return Err(fail("Retry limit must be 0..10"));
        }
        if !(1..=1_440).contains(&self.max_duration_min) {
            return Err(fail("Duration budget must be 1..1440 minutes"));
        }
        let mut stage_ids = BTreeSet::new();
        let mut output_kinds = BTreeSet::new();
        for stage in &self.stages {
            if !stage_ids.insert(&stage.id) {
                return Err(fail("Orchestrator stage IDs must be unique"));
            }
            if !output_kinds.insert(&stage.output_kind) {
                return Err(fail("Orchestrator output kinds must be unique"));
            }
            stage.validate(data)?;
        }
        if self.execution_mode == OrchestratorExecutionMode::Sequential
            && self
                .stages
                .iter()
                .any(|stage| stage.parallel_group.is_some())
        {
            return Err(fail(
                "Sequential orchestrators cannot assign parallel groups",
            ));
        }
        Ok(())
    }

    pub fn runnable_snapshot(&self) -> AppResult<OrchestratorSnapshot> {
        let template_id = self.template_id.clone().ok_or_else(|| {
            fail("Select an Anneal task template before running this orchestrator")
        })?;
        let mut step_overrides = BTreeMap::new();
        for (index, stage) in self.stages.iter().enumerate() {
            let agent_id = stage.anneal_agent_id.clone().ok_or_else(|| {
                fail(format!(
                    "Stage {} needs an Anneal agent ID before execution",
                    stage.name
                ))
            })?;
            step_overrides.insert((index + 1).to_string(), agent_id);
        }
        Ok(OrchestratorSnapshot {
            profile_id: self.id.clone(),
            profile_revision: self.revision,
            template_id,
            staffing_profile_id: self.staffing_profile_id.clone(),
            step_overrides,
            approval_required: self.approval_required,
            max_duration_min: self.max_duration_min,
        })
    }
}

fn view(data: &AppData) -> Value {
    let profiles: Vec<_> = data
        .orchestrator_profiles
        .iter()
        .filter(|profile| !profile.archived)
        .cloned()
        .collect();
    let resolved: Vec<_> = profiles
        .iter()
        .map(|profile| {
            let stages: Vec<_> = profile
                .stages
                .iter()
                .map(|stage| {
                    let provider = data
                        .provider_profiles
                        .iter()
                        .find(|provider| provider.id == stage.provider_profile_id);
                    json!({
                        "id": &stage.id,
                        "name": &stage.name,
                        "role": &stage.role,
                        "provider_profile_id": &stage.provider_profile_id,
                        "provider_name": provider.map(|provider| provider.name.as_str()),
                        "model": &stage.model,
                        "fallback_provider_ids": &stage.fallback_provider_ids,
                        "anneal_agent_id": &stage.anneal_agent_id,
                        "parallel_group": stage.parallel_group,
                        "approval_gate": stage.approval_gate,
                        "output_kind": &stage.output_kind,
                    })
                })
                .collect();
            json!({
                "id": &profile.id,
                "runnable": profile.runnable_snapshot().is_ok(),
                "stages": stages,
            })
        })
        .collect();
    json!({
        "revision": data.orchestrator_registry_revision,
        "profiles": profiles,
        "resolved": resolved,
    })
}

pub fn read() -> AppResult<Value> {
    DataStore::read_file(|data| Ok(view(data)))
}

pub fn save(expected_revision: u64, input: OrchestratorProfileInput) -> AppResult<Value> {
    DataStore::update_file(|data| {
        if data.orchestrator_registry_revision != expected_revision {
            return Err(fail("Orchestrator registry changed; refresh before saving"));
        }
        let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let previous = data
            .orchestrator_profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned();
        let profile = OrchestratorProfile {
            id: id.clone(),
            name: input.name.trim().to_string(),
            project_id: input.project_id.trim().to_string(),
            repo_id: input.repo_id.trim().to_string(),
            environment_id: input
                .environment_id
                .filter(|value| !value.trim().is_empty()),
            template_id: input.template_id.filter(|value| !value.trim().is_empty()),
            staffing_profile_id: input
                .staffing_profile_id
                .filter(|value| !value.trim().is_empty()),
            stages: input.stages,
            execution_mode: input.execution_mode,
            max_concurrency: input.max_concurrency,
            retry_limit: input.retry_limit,
            max_duration_min: input.max_duration_min,
            approval_required: input.approval_required,
            enabled: input.enabled,
            archived: false,
            revision: previous
                .as_ref()
                .map_or(0, |profile| profile.revision.saturating_add(1)),
            updated_at: now(),
        };
        profile.validate(data)?;
        if let Some(index) = data
            .orchestrator_profiles
            .iter()
            .position(|candidate| candidate.id == id)
        {
            data.orchestrator_profiles[index] = profile;
        } else {
            if data.orchestrator_profiles.len() >= 64 {
                return Err(fail(
                    "Orchestrator profile limit reached; existing profiles were retained",
                ));
            }
            data.orchestrator_profiles.push(profile);
        }
        data.orchestrator_registry_revision = data
            .orchestrator_registry_revision
            .checked_add(1)
            .ok_or_else(|| fail("Orchestrator registry revision exhausted"))?;
        Ok(view(data))
    })
}

pub fn archive(id: &str) -> AppResult<Value> {
    DataStore::update_file(|data| {
        {
            let profile = data
                .orchestrator_profiles
                .iter_mut()
                .find(|profile| profile.id == id)
                .ok_or_else(|| fail("Orchestrator profile not found"))?;
            profile.enabled = false;
            profile.archived = true;
            profile.updated_at = now();
        }
        data.orchestrator_registry_revision = data
            .orchestrator_registry_revision
            .checked_add(1)
            .ok_or_else(|| fail("Orchestrator registry revision exhausted"))?;
        Ok(view(data))
    })
}

pub fn profile(data: &AppData, id: &str) -> AppResult<OrchestratorProfile> {
    data.orchestrator_profiles
        .iter()
        .find(|profile| profile.id == id && profile.enabled && !profile.archived)
        .cloned()
        .ok_or_else(|| fail("Orchestrator profile is not enabled"))
}

pub fn snapshot(data: &AppData, id: &str) -> AppResult<OrchestratorSnapshot> {
    let profile = profile(data, id)?;
    profile.validate(data)?;
    profile.runnable_snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ProviderAuth, ProviderCategory, ProviderProtocol};

    fn provider() -> ProviderProfile {
        ProviderProfile {
            id: "provider".into(),
            name: "Provider".into(),
            template_id: "custom-compatible".into(),
            category: ProviderCategory::Custom,
            auth: ProviderAuth::None,
            protocol: ProviderProtocol::OpenAiResponses,
            base_url: Some("http://127.0.0.1:9000/v1".into()),
            models_endpoint: Some("/models".into()),
            models: vec!["model".into()],
            capabilities: vec![ProviderCapability::Text],
            paseo_enabled: true,
            anneal_enabled: true,
            direct_enabled: true,
            image_enabled: false,
            priority: 1,
            enabled: true,
            archived: false,
            generation: "generation".into(),
            revision: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn runnable_profile_resolves_stable_step_overrides() {
        let mut data = AppData::default();
        data.provider_profiles.push(provider());
        let profile = OrchestratorProfile {
            id: "orchestrator".into(),
            name: "Orchestrator".into(),
            project_id: "project".into(),
            repo_id: "repo".into(),
            environment_id: None,
            template_id: Some("template".into()),
            staffing_profile_id: None,
            stages: vec![OrchestratorStage {
                id: "plan".into(),
                name: "Plan".into(),
                role: "planner".into(),
                provider_profile_id: "provider".into(),
                model: "model".into(),
                fallback_provider_ids: vec![],
                instructions: String::new(),
                anneal_agent_id: Some("agent".into()),
                parallel_group: None,
                approval_gate: true,
                optional: false,
                opens_pull_request: false,
                requires_commit: true,
                output_kind: "plan".into(),
            }],
            execution_mode: OrchestratorExecutionMode::Sequential,
            max_concurrency: 1,
            retry_limit: 1,
            max_duration_min: 60,
            approval_required: true,
            enabled: true,
            archived: false,
            revision: 3,
            updated_at: 0,
        };
        profile.validate(&data).unwrap();
        let snapshot = profile.runnable_snapshot().unwrap();
        assert_eq!(
            snapshot.step_overrides.get("1").map(String::as_str),
            Some("agent")
        );
        assert_eq!(snapshot.profile_revision, 3);
    }
}

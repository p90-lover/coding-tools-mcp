use crate::{
    data::DataStore,
    error::{AppError, AppResult},
    integrations::execution::{
        model::Engine,
        protocol,
    },
    orchestrators,
};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;

fn fail(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}

fn bounded(value: &str, max: usize, label: &str, required: bool) -> AppResult<()> {
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

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnealOrchestratorRunInput {
    pub profile_id: String,
    pub endpoint: String,
    pub operator_token: String,
    pub name: String,
    pub description: String,
    pub branch_name: String,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnnealOrchestratorRunResult {
    pub profile_id: String,
    pub profile_revision: u64,
    pub project_id: String,
    pub template_id: String,
    pub status: u16,
    pub accepted: bool,
    pub response: Value,
}

fn build_body(
    profile: &orchestrators::OrchestratorProfile,
    snapshot: &orchestrators::OrchestratorSnapshot,
    input: &AnnealOrchestratorRunInput,
) -> AppResult<Value> {
    bounded(&input.name, 200, "Anneal task name", true)?;
    bounded(&input.description, 32_768, "Anneal task description", false)?;
    bounded(&input.branch_name, 240, "Anneal branch name", true)?;
    if input.branch_name.starts_with('/')
        || input.branch_name.ends_with('/')
        || input.branch_name.contains("..")
        || input.branch_name.chars().any(char::is_whitespace)
    {
        return Err(fail("Anneal branch name is invalid"));
    }

    let mut step_overrides = Map::new();
    for (step, agent_id) in &snapshot.step_overrides {
        step_overrides.insert(step.clone(), json!({ "assigneeAgentId": agent_id }));
    }
    let mut body = Map::new();
    body.insert("repoId".into(), json!(profile.repo_id));
    body.insert("variables".into(), json!({ "branchName": input.branch_name }));
    body.insert("autoStart".into(), json!(input.auto_start));
    body.insert("name".into(), json!(input.name));
    if !input.description.trim().is_empty() {
        body.insert("description".into(), json!(input.description));
    }
    body.insert("stepOverrides".into(), Value::Object(step_overrides));
    if let Some(staffing_profile_id) = &snapshot.staffing_profile_id {
        body.insert("staffingProfileId".into(), json!(staffing_profile_id));
    }
    if snapshot.approval_required {
        body.insert("gates".into(), json!({ "spec": true, "merge": true }));
    }
    Ok(Value::Object(body))
}

fn headers(token: &str) -> AppResult<HeaderMap> {
    bounded(token, 8_192, "Anneal operator token", true)?;
    if token.chars().any(char::is_control) {
        return Err(fail("Anneal operator token is invalid"));
    }
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| fail("Anneal operator token cannot be encoded"))?,
    );
    Ok(headers)
}

pub async fn run(input: AnnealOrchestratorRunInput) -> AppResult<AnnealOrchestratorRunResult> {
    let endpoint = protocol::endpoint(Engine::Anneal, &input.endpoint).map_err(fail)?;
    let (profile, snapshot) = DataStore::read_file(|data| {
        let profile = orchestrators::profile(data, &input.profile_id)?;
        profile.validate(data)?;
        let snapshot = profile.runnable_snapshot()?;
        Ok((profile, snapshot))
    })?;
    let body = build_body(&profile, &snapshot, &input)?;
    let template_path = format!(
        "projects/{}/task-templates/{}/instantiate",
        profile.project_id, snapshot.template_id
    );
    let url = endpoint
        .join(&template_path)
        .map_err(|_| fail("Anneal orchestrator endpoint could not be constructed"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("Anneal orchestrator client unavailable"))?;
    let response = client
        .post(url)
        .headers(headers(&input.operator_token)?)
        .json(&body)
        .send()
        .await
        .map_err(|error| fail(format!("Anneal orchestrator request failed: {error}")))?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let summary = payload
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("Anneal rejected the orchestrator request");
        return Err(fail(format!("Anneal returned HTTP {}: {summary}", status.as_u16())));
    }
    Ok(AnnealOrchestratorRunResult {
        profile_id: profile.id,
        profile_revision: snapshot.profile_revision,
        project_id: profile.project_id,
        template_id: snapshot.template_id,
        status: status.as_u16(),
        accepted: true,
        response: payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrators::{
        OrchestratorExecutionMode, OrchestratorProfile, OrchestratorSnapshot,
    };
    use std::collections::BTreeMap;

    fn profile() -> OrchestratorProfile {
        OrchestratorProfile {
            id: "orchestrator".into(),
            name: "Orchestrator".into(),
            project_id: "project".into(),
            repo_id: "repo".into(),
            environment_id: None,
            template_id: Some("template".into()),
            staffing_profile_id: Some("staffing".into()),
            stages: vec![],
            execution_mode: OrchestratorExecutionMode::Sequential,
            max_concurrency: 1,
            retry_limit: 2,
            max_duration_min: 60,
            approval_required: true,
            enabled: true,
            archived: false,
            revision: 3,
            updated_at: 0,
        }
    }

    #[test]
    fn native_body_maps_stages_to_anneal_step_overrides() {
        let snapshot = OrchestratorSnapshot {
            profile_id: "orchestrator".into(),
            profile_revision: 3,
            template_id: "template".into(),
            staffing_profile_id: Some("staffing".into()),
            step_overrides: BTreeMap::from([
                ("1".into(), "planner".into()),
                ("2".into(), "implementer".into()),
            ]),
            approval_required: true,
            max_duration_min: 60,
        };
        let input = AnnealOrchestratorRunInput {
            profile_id: "orchestrator".into(),
            endpoint: "http://127.0.0.1:3000/".into(),
            operator_token: "operator-token".into(),
            name: "Implement provider center".into(),
            description: "Deliver the approved work".into(),
            branch_name: "coding-tools/provider-center".into(),
            auto_start: false,
        };
        let body = build_body(&profile(), &snapshot, &input).unwrap();
        assert_eq!(body["repoId"], "repo");
        assert_eq!(body["variables"]["branchName"], "coding-tools/provider-center");
        assert_eq!(body["stepOverrides"]["1"]["assigneeAgentId"], "planner");
        assert_eq!(body["stepOverrides"]["2"]["assigneeAgentId"], "implementer");
        assert_eq!(body["staffingProfileId"], "staffing");
        assert_eq!(body["gates"]["spec"], true);
        assert_eq!(body["gates"]["merge"], true);
        assert_eq!(body["autoStart"], false);
    }
}

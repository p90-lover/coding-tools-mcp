//! Parse source evidence, not caller-declared outcomes. Only bounded diagnostic
//! summaries persist; provider credentials and arbitrary raw outputs do not.
use super::{book::Entry, model::*};
use serde_json::{json, Value};
fn required<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str()
        .filter(|s| !s.is_empty() && s.len() < 2048)
        .ok_or_else(|| format!("Missing or invalid source field: {k}"))
}
fn item(v: &Value, k: &str) -> Value {
    v[k].as_str()
        .map(|s| json!(s.chars().take(512).collect::<String>()))
        .unwrap_or(Value::Null)
}
pub struct Evidence {
    pub observation: Observation,
    pub revision: String,
    pub summary: Value,
}
pub fn inspect(spec: &Spec, id: &str, body: &Value) -> Result<Evidence, String> {
    identifier(id)?;
    match spec.engine {
        Engine::Paseo => {
            let a = &body["agent"];
            if a["id"] != id
                || a["cwd"] != spec.cwd
                || a["provider"] != spec.provider
                || a["labels"]["coding-tools-mission"] != spec.mission_id
                || a["labels"]["coding-tools-workspace"] != spec.workspace_id
            {
                return Err(
                    "Paseo snapshot does not match the owned mission, provider and root".into(),
                );
            }
            let permissions = a["pendingPermissions"]
                .as_array()
                .ok_or("Paseo omitted pending-permission evidence")?;
            let raw = required(a, "status")?;
            let status = if a["archivedAt"].is_string() {
                "archived"
            } else {
                raw
            };
            let active = a
                .get("activeTurn")
                .ok_or("Paseo snapshot lacks active-turn evidence")?;
            let run_id = active["turnId"].as_str().map(str::to_owned);
            if let Some(id) = &run_id {
                identifier(id)?;
            }
            let quiescent = active.is_null()
                && permissions.is_empty()
                && matches!(status, "idle" | "error" | "closed" | "archived");
            let updated = required(a, "updatedAt")?;
            Ok(Evidence {
                revision: json!([updated, status, active.get("turnId"), permissions.len()])
                    .to_string(),
                observation: Observation {
                    record_id: id.into(),
                    status: if !permissions.is_empty() {
                        "waiting_permission".into()
                    } else {
                        status.into()
                    },
                    run_id,
                    quiescent,
                },
                summary: json!({"source":"paseo","record_id":id,"reported_status":status,"updated_at":updated,"pending_permissions":permissions.len(),"active_turn_id":active["turnId"],"attention_reason":item(a,"attentionReason"),"last_error":item(a,"lastError"),"quiescent":quiescent}),
            })
        }
        Engine::Anneal => {
            if body["id"] != id
                || body["projectId"].as_str() != spec.project_id.as_deref()
                || body["repoId"].as_str() != spec.repo_id.as_deref()
                || body["assigneeAgentId"].as_str() != spec.assignee_id.as_deref()
                || body["workingDirectory"] != spec.cwd
                || body["chainId"] != spec.mission_id
            {
                return Err(
                    "Anneal task does not match the owned project, repository, worker and root"
                        .into(),
                );
            }
            // A provider change cannot be hidden behind a stable assignee ID. The bound
            // worker must keep its configured model-provider type; do not fall back.
            let provider = body["assigneeAgent"]["provider"]
                .as_str()
                .or_else(|| body["assigneeAgent"]["runner"].as_str());
            if provider.is_some_and(|p| !p.eq_ignore_ascii_case(&spec.provider)) {
                return Err("Anneal worker provider changed; reapprove the binding".into());
            }
            let runs = body["runs"]
                .as_array()
                .ok_or("Anneal omitted run ownership evidence")?;
            if runs.len() > 200 {
                return Err("Anneal run list exceeds reconciliation bound".into());
            }
            let raw = required(body, "status")?;
            let active = runs.iter().find(|r| {
                matches!(
                    r["status"].as_str(),
                    Some("QUEUED" | "CLAIMED" | "PROVISIONING" | "RUNNING" | "WAITING_INBOX")
                )
            });
            let run = active.or_else(|| runs.first());
            if runs.iter().any(|r| r["taskId"] != id) {
                return Err("Anneal reported a foreign run in this task".into());
            }
            let run_id = run.and_then(|r| r["id"].as_str()).map(str::to_owned);
            if let Some(id) = &run_id {
                identifier(id)?;
            }
            let status = if body["archivedAt"].is_string() {
                "archived"
            } else if active.is_some() {
                "running"
            } else if run.is_some_and(|r| {
                matches!(r["status"].as_str(), Some("FAILED" | "TIMED_OUT" | "LOST"))
            }) {
                "failed"
            } else if matches!(raw, "BACKLOG" | "REVIEW" | "DONE") {
                "idle"
            } else {
                "unknown"
            };
            let quiescent = active.is_none() && matches!(status, "idle" | "failed" | "archived");
            let updated = required(body, "updatedAt")?;
            Ok(Evidence {
                revision: json!([updated, raw, run_id, run.map(|r| &r["status"])]).to_string(),
                observation: Observation {
                    record_id: id.into(),
                    status: status.into(),
                    run_id: run_id.clone(),
                    quiescent,
                },
                summary: json!({"source":"anneal","record_id":id,"reported_status":raw,"updated_at":updated,"run_id":run_id,"run_status":run.map(|r|&r["status"]),"quiescent":quiescent,"chain_id":spec.mission_id,"approval_gate":body["approvalGate"],"budget_remaining":body["budgetRemaining"]}),
            })
        }
    }
}
pub fn apply(entry: &mut Entry, evidence: Evidence, now: u64) -> Result<(), String> {
    let mut next = entry.clone();
    let review_changed = next.mission.phase == Phase::Accepted
        && next.source_revision.as_deref() != Some(&evidence.revision);
    next.mission.observe(evidence.observation)?;
    if review_changed && next.mission.phase == Phase::Accepted {
        next.mission.phase = Phase::ReviewRequired;
    }
    next.source_revision = Some(evidence.revision);
    next.observed_at = Some(now);
    next.updated_at = now;
    next.last_error = None;
    next.owner_runtime = None;
    next.observation = evidence.summary;
    *entry = next;
    Ok(())
}

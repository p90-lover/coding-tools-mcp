//! Bounded durable metadata embedded in AppData. Credentials never enter this
//! structure. The service must persist a successful reservation before IO.
use super::{model::*, protocol::endpoint, result::PaseoStartResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub workspace_id: String,
    pub root: String,
    pub roots_revision: String,
    pub policy_stamp: String,
    pub generation: String,
    pub engine: Engine,
    pub endpoint: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    pub mode: String,
    pub project_id: Option<String>,
    pub repo_id: Option<String>,
    pub assignee_id: Option<String>,
    pub max_duration_min: u32,
    pub allow_codex: bool,
    pub enabled: bool,
}
impl Binding {
    pub fn validate(&self) -> Result<(), String> {
        for id in [&self.id, &self.workspace_id, &self.generation] {
            identifier(id)?;
        }
        endpoint(self.engine, &self.endpoint)?;
        if self.provider.eq_ignore_ascii_case("codex") && !self.allow_codex {
            return Err("Codex model execution needs its own explicit local quota consent; native computer tools do not".into());
        }
        for v in [&self.roots_revision, &self.policy_stamp] {
            if v.is_empty() || v.len() > 256 {
                return Err("Invalid scope revision".into());
            }
        }
        self.spec(
            "binding-validation",
            "binding-validation",
            "Binding validation",
            "No task submission",
        )
        .validate()
    }
    pub fn spec(&self, mission: &str, task: &str, title: &str, brief: &str) -> Spec {
        Spec {
            engine: self.engine,
            mission_id: mission.into(),
            workspace_id: self.workspace_id.clone(),
            task_id: task.into(),
            cwd: self.root.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            account_id: self.account_id.clone(),
            route_id: self.route_id.clone(),
            mode: self.mode.clone(),
            project_id: self.project_id.clone(),
            repo_id: self.repo_id.clone(),
            assignee_id: self.assignee_id.clone(),
            title: title.into(),
            brief: brief.into(),
            max_duration_min: self.max_duration_min,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub binding_id: String,
    pub binding_generation: String,
    pub mission: Mission,
    pub owner_runtime: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub observed_at: Option<u64>,
    pub source_revision: Option<String>,
    pub last_error: Option<String>,
    pub observation: Value,
    #[serde(default)]
    pub start_message_id: Option<String>,
    #[serde(default)]
    pub output: Option<PaseoStartResult>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestrationRecord {
    pub id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub planner_task_id: String,
    pub planner_binding_id: String,
    pub planner_binding_generation: String,
    pub planner_mission_id: String,
    pub planner_request_key: String,
    pub worker_binding_ids: Vec<String>,
    pub worker_binding_generations: Vec<String>,
    pub worker_mission_ids: Vec<String>,
    pub worker_task_ids: Vec<String>,
    pub worker_request_keys: Vec<String>,
    pub reviewer_binding_id: String,
    pub reviewer_binding_generation: String,
    pub reviewer_task_id: String,
    pub reviewer_mission_id: String,
    pub reviewer_request_key: String,
    pub status: String,
    pub revision: u64,
}
impl OrchestrationRecord {
    fn validate(&self) -> Result<(), String> {
        for value in [
            &self.id,
            &self.workspace_id,
            &self.task_id,
            &self.planner_task_id,
            &self.planner_binding_id,
            &self.planner_binding_generation,
            &self.planner_mission_id,
            &self.planner_request_key,
            &self.reviewer_binding_id,
            &self.reviewer_binding_generation,
            &self.reviewer_task_id,
            &self.reviewer_mission_id,
            &self.reviewer_request_key,
            &self.status,
        ] {
            identifier(value)?;
        }
        if self.worker_mission_ids.is_empty()
            || self.worker_mission_ids.len() > 8
            || self.worker_mission_ids.len() != self.worker_binding_ids.len()
            || self.worker_mission_ids.len() != self.worker_binding_generations.len()
            || self.worker_mission_ids.len() != self.worker_task_ids.len()
            || self.worker_mission_ids.len() != self.worker_request_keys.len()
        {
            return Err(err(
                "Orchestration requires 1..8 worker missions with matching binding identities, task IDs and request keys",
            ));
        }
        for value in self
            .worker_binding_ids
            .iter()
            .chain(self.worker_binding_generations.iter())
            .chain(self.worker_mission_ids.iter())
            .chain(self.worker_task_ids.iter())
            .chain(self.worker_request_keys.iter())
        {
            identifier(value)?;
        }
        if !matches!(
            self.status.as_str(),
            "planning"
                | "executing"
                | "ready_for_review"
                | "reviewing"
                | "passed"
                | "needs_changes"
                | "held"
                | "uncertain"
        ) {
            return Err(err("Invalid orchestration status"));
        }
        Ok(())
    }
    fn same_identity(&self, other: &Self) -> bool {
        self.id == other.id
            && self.workspace_id == other.workspace_id
            && self.task_id == other.task_id
            && self.planner_task_id == other.planner_task_id
            && self.planner_binding_id == other.planner_binding_id
            && self.planner_binding_generation == other.planner_binding_generation
            && self.planner_mission_id == other.planner_mission_id
            && self.planner_request_key == other.planner_request_key
            && self.worker_binding_ids == other.worker_binding_ids
            && self.worker_binding_generations == other.worker_binding_generations
            && self.worker_mission_ids == other.worker_mission_ids
            && self.worker_task_ids == other.worker_task_ids
            && self.worker_request_keys == other.worker_request_keys
            && self.reviewer_binding_id == other.reviewer_binding_id
            && self.reviewer_binding_generation == other.reviewer_binding_generation
            && self.reviewer_task_id == other.reviewer_task_id
            && self.reviewer_mission_id == other.reviewer_mission_id
            && self.reviewer_request_key == other.reviewer_request_key
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Book {
    pub revision: u64,
    pub bindings: Vec<Binding>,
    pub missions: Vec<Entry>,
    #[serde(default)]
    pub orchestrations: Vec<OrchestrationRecord>,
}
fn err(s: &str) -> String {
    s.into()
}
fn reviewer_verdict(text: &str) -> Result<&'static str, String> {
    if text.len() > 64 * 1024 {
        return Err(err("Reviewer output exceeds limit"));
    }
    let text = text.trim();
    let source = if let Some(fenced) = text.strip_prefix("```json") {
        let fenced = fenced.trim_start_matches([' ', '\t']);
        let fenced = fenced
            .strip_prefix("\r\n")
            .or_else(|| fenced.strip_prefix('\n'))
            .ok_or_else(|| err("Invalid reviewer output"))?;
        fenced
            .strip_suffix("\r\n```")
            .or_else(|| fenced.strip_suffix("\n```"))
            .ok_or_else(|| err("Invalid reviewer output"))?
    } else {
        text
    };
    let parsed: Value =
        serde_json::from_str(source.trim()).map_err(|_| err("Invalid reviewer output"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| err("Invalid reviewer output"))?;
    let verdict = object
        .get("verdict")
        .and_then(Value::as_str)
        .ok_or_else(|| err("Invalid reviewer verdict"))?;
    let findings = object
        .get("findings")
        .and_then(Value::as_array)
        .ok_or_else(|| err("Invalid reviewer findings"))?;
    if object.len() != 2
        || findings.len() > 32
        || !matches!(verdict, "pass" | "needs_changes")
        || (verdict == "pass") != findings.is_empty()
        || findings.iter().any(|item| {
            let Some(item) = item.as_object() else {
                return true;
            };
            item.len() != 2
                || [("title", 200), ("detail", 4_000)]
                    .iter()
                    .any(|(key, max)| {
                        item.get(*key)
                            .and_then(Value::as_str)
                            .is_none_or(|text| text.trim().is_empty() || text.trim().len() > *max)
                    })
        })
    {
        return Err(err("Invalid reviewer verdict or findings"));
    }
    Ok(if verdict == "pass" {
        "passed"
    } else {
        "needs_changes"
    })
}
fn active_writer(e: &Entry) -> bool {
    matches!(
        e.mission.phase,
        Phase::Creating
            | Phase::StartRequested
            | Phase::Running
            | Phase::HoldRequested
            | Phase::SchedulingHeld
            | Phase::CloseRequested
            | Phase::Unknown
    )
}
impl Book {
    fn bump(&self) -> Result<u64, String> {
        self.revision
            .checked_add(1)
            .ok_or_else(|| err("Execution book revision exhausted"))
    }
    pub fn size_check(&self) -> Result<(), String> {
        if self.bindings.len() > 32
            || self.missions.len() > 128
            || self.orchestrations.len() > 128
            || serde_json::to_vec(self)
                .map_err(|_| err("Invalid execution metadata"))?
                .len()
                > 4 * 1024 * 1024
        {
            return Err(err(
                "Execution metadata limit reached; all prior records were retained",
            ));
        }
        Ok(())
    }
    pub fn configure(&mut self, binding: Binding, expected: u64) -> Result<(), String> {
        binding.validate()?;
        if self.revision != expected {
            return Err(err("Provider settings changed; refresh before saving"));
        }
        if self
            .bindings
            .iter()
            .any(|b| b.id == binding.id && b.workspace_id != binding.workspace_id)
        {
            return Err(err("Provider ID belongs to another workspace"));
        }
        if self.missions.iter().any(|e| {
            e.binding_id == binding.id
                && !matches!(
                    e.mission.phase,
                    Phase::Closed | Phase::Accepted | Phase::Draft
                )
        }) {
            return Err(err("Unclosed missions retain this binding; reconnect its existing credentials instead of replacing it"));
        }
        let mut next = self.clone();
        next.revision = self.bump()?;
        if let Some(row) = next.bindings.iter_mut().find(|b| b.id == binding.id) {
            *row = binding
        } else {
            next.bindings.push(binding)
        }
        next.size_check()?;
        *self = next;
        Ok(())
    }
    pub fn binding(&self, workspace: &str, id: &str) -> Result<&Binding, String> {
        self.bindings
            .iter()
            .find(|b| b.id == id && b.workspace_id == workspace && b.enabled)
            .ok_or_else(|| err("Provider is not locally enabled for this workspace"))
    }
    pub fn orchestration(&self, workspace: &str, id: &str) -> Result<&OrchestrationRecord, String> {
        self.orchestrations
            .iter()
            .find(|record| record.workspace_id == workspace && record.id == id)
            .ok_or_else(|| err("Orchestration is not in the selected workspace"))
    }
    pub fn save_orchestration(
        &mut self,
        mut record: OrchestrationRecord,
        expected: u64,
    ) -> Result<(), String> {
        record.validate()?;
        let current = self
            .orchestrations
            .iter()
            .find(|stored| stored.workspace_id == record.workspace_id && stored.id == record.id);
        record.revision = if let Some(stored) = current {
            if stored.revision != expected {
                return Err(err("Orchestration changed; refresh before saving"));
            }
            if !stored.same_identity(&record) {
                return Err(err(
                    "Orchestration mission identities and request keys are immutable",
                ));
            }
            stored
                .revision
                .checked_add(1)
                .ok_or_else(|| err("Orchestration revision exhausted"))?
        } else {
            if expected != 0 || record.revision != 0 {
                return Err(err("New orchestration must start at revision zero"));
            }
            1
        };
        let mut next = self.clone();
        next.revision = self.bump()?;
        if let Some(stored) = next
            .orchestrations
            .iter_mut()
            .find(|stored| stored.workspace_id == record.workspace_id && stored.id == record.id)
        {
            *stored = record;
        } else {
            next.orchestrations.push(record);
        }
        next.size_check()?;
        *self = next;
        Ok(())
    }
    pub fn advance_orchestration(
        &mut self,
        workspace: &str,
        id: &str,
        expected: u64,
        status: &str,
    ) -> Result<OrchestrationRecord, String> {
        let mut record = self.orchestration(workspace, id)?.clone();
        if record.revision != expected {
            return Err(err("Orchestration changed; refresh before saving"));
        }
        if record.status == status {
            return Ok(record);
        }
        let allowed = match record.status.as_str() {
            "planning" => matches!(status, "executing" | "held" | "uncertain"),
            "executing" => matches!(status, "ready_for_review" | "held" | "uncertain"),
            "ready_for_review" => matches!(status, "reviewing" | "held" | "uncertain"),
            "reviewing" => matches!(status, "passed" | "needs_changes" | "held" | "uncertain"),
            "held" | "uncertain" => matches!(
                status,
                "planning" | "executing" | "ready_for_review" | "reviewing"
            ),
            _ => false,
        };
        if !allowed {
            return Err(err("Orchestration status transition is not allowed"));
        }
        let owned_output =
            |mission_id: &str, binding_id: &str, generation: &str, start_key: &str| {
                self.find(workspace, mission_id).ok().and_then(|entry| {
                    let output = entry.output.as_ref()?;
                    (entry.binding_id == binding_id
                        && entry.binding_generation == generation
                        && entry.start_message_id.as_deref() == Some(start_key)
                        && entry.mission.record_id.as_deref() == Some(output.agent_id.as_str())
                        && !output.text.trim().is_empty())
                    .then_some(output)
                })
            };
        if matches!(
            status,
            "executing" | "ready_for_review" | "reviewing" | "passed" | "needs_changes"
        ) {
            let planner = owned_output(
                &record.planner_mission_id,
                &record.planner_binding_id,
                &record.planner_binding_generation,
                &record.planner_request_key,
            )
            .ok_or_else(|| err("Reserved planner output is not yet verified"))?;
            if matches!(
                status,
                "ready_for_review" | "reviewing" | "passed" | "needs_changes"
            ) {
                let workers = record
                    .worker_mission_ids
                    .iter()
                    .enumerate()
                    .map(|(index, mission_id)| {
                        owned_output(
                            mission_id,
                            &record.worker_binding_ids[index],
                            &record.worker_binding_generations[index],
                            &record.worker_request_keys[index],
                        )
                        .ok_or_else(|| err("Reserved worker output is not yet verified"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if matches!(status, "passed" | "needs_changes") {
                    let reviewer = owned_output(
                        &record.reviewer_mission_id,
                        &record.reviewer_binding_id,
                        &record.reviewer_binding_generation,
                        &record.reviewer_request_key,
                    )
                    .ok_or_else(|| err("Reserved reviewer output is not yet verified"))?;
                    if reviewer.agent_id == planner.agent_id
                        || reviewer.turn_id == planner.turn_id
                        || workers.iter().any(|worker| {
                            reviewer.agent_id == worker.agent_id
                                || reviewer.turn_id == worker.turn_id
                        })
                    {
                        return Err(err("Reviewer output must use a distinct agent and turn"));
                    }
                    if reviewer_verdict(&reviewer.text)? != status {
                        return Err(err("Reviewer verdict does not match orchestration status"));
                    }
                }
            }
        }
        record.status = status.into();
        self.save_orchestration(record, expected)?;
        Ok(self.orchestration(workspace, id)?.clone())
    }
    pub fn find(&self, workspace: &str, id: &str) -> Result<&Entry, String> {
        self.missions
            .iter()
            .find(|e| e.mission.spec.mission_id == id && e.mission.spec.workspace_id == workspace)
            .ok_or_else(|| err("Mission is not in the selected workspace"))
    }
    pub fn find_mut(&mut self, workspace: &str, id: &str) -> Result<&mut Entry, String> {
        self.missions
            .iter_mut()
            .find(|e| e.mission.spec.mission_id == id && e.mission.spec.workspace_id == workspace)
            .ok_or_else(|| err("Mission is not in the selected workspace"))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        &mut self,
        workspace: &str,
        binding_id: &str,
        task_id: &str,
        mission_id: &str,
        title: &str,
        brief: &str,
        now: u64,
    ) -> Result<(), String> {
        identifier(mission_id)?;
        identifier(task_id)?;
        if let Some(e) = self
            .missions
            .iter()
            .find(|e| e.mission.spec.mission_id == mission_id)
        {
            return if e.mission.spec.workspace_id == workspace
                && e.mission.spec.task_id == task_id
                && e.binding_id == binding_id
            {
                Ok(())
            } else {
                Err(err(
                    "Preparation key already identifies a different mission",
                ))
            };
        }
        let b = self.binding(workspace, binding_id)?;
        let entry = Entry {
            binding_id: b.id.clone(),
            binding_generation: b.generation.clone(),
            mission: Mission::new(b.spec(mission_id, task_id, title, brief))?,
            owner_runtime: None,
            created_at: now,
            updated_at: now,
            observed_at: None,
            source_revision: None,
            last_error: None,
            observation: Value::Null,
            start_message_id: None,
            output: None,
        };
        let mut next = self.clone();
        next.revision = self.bump()?;
        next.missions.push(entry);
        next.size_check()?;
        *self = next;
        Ok(())
    }
    pub fn reserve(
        &mut self,
        workspace: &str,
        id: &str,
        expected: u64,
        key: &str,
        runtime: &str,
        action: Action,
    ) -> Result<Reservation, String> {
        identifier(runtime)?;
        let row = self.find(workspace, id)?;
        // A known key is only queried here; it can never dispatch again, even after a
        // revoked binding. Scope still must match and a key cannot change its action.
        if row.mission.receipts.contains_key(key) {
            return self
                .find_mut(workspace, id)?
                .mission
                .reserve(expected, key, action);
        }
        let b = self.binding(workspace, &row.binding_id)?;
        if b.generation != row.binding_generation {
            return Err(err("Mission belongs to an older provider grant"));
        }
        if matches!(action, Action::Create | Action::Start | Action::Resume)
            && self.missions.iter().any(|e| {
                e.mission.spec.workspace_id == workspace
                    && e.mission.spec.mission_id != id
                    && active_writer(e)
            })
        {
            return Err(err(
                "Another mission may still own workspace writes; hold or reconcile it first",
            ));
        }
        let mut next = self.clone();
        next.revision = self.bump()?;
        let row = next.find_mut(workspace, id)?;
        let result = row.mission.reserve(expected, key, action)?;
        if result.dispatch {
            row.owner_runtime = Some(runtime.into());
            row.last_error = None;
            if matches!(action, Action::Start | Action::Resume) {
                row.start_message_id = Some(key.into());
                row.output = None;
            }
        }
        next.size_check()?;
        *self = next;
        Ok(result)
    }
    pub fn acknowledge(
        &mut self,
        workspace: &str,
        id: &str,
        key: &str,
        reply: Reply,
        now: u64,
    ) -> Result<(), String> {
        let mut next = self.clone();
        next.revision = self.bump()?;
        let row = next.find_mut(workspace, id)?;
        row.mission.settle(key, reply)?;
        row.owner_runtime = None;
        row.updated_at = now;
        row.last_error = None;
        next.size_check()?;
        *self = next;
        Ok(())
    }
    pub fn uncertain(
        &mut self,
        workspace: &str,
        id: &str,
        key: &str,
        reason: &str,
        now: u64,
    ) -> Result<(), String> {
        if reason.len() > 256 {
            return Err(err("Status reason exceeds metadata limit"));
        }
        let mut next = self.clone();
        next.revision = self.bump()?;
        let row = next.find_mut(workspace, id)?;
        row.mission.uncertain(key)?;
        row.owner_runtime = None;
        row.last_error = Some(reason.into());
        row.updated_at = now;
        next.size_check()?;
        *self = next;
        Ok(())
    }
    pub fn recover(&mut self, workspace: &str, runtime: &str, now: u64) -> Result<(), String> {
        let unresolved = self
            .missions
            .iter()
            .filter(|e| {
                e.mission.spec.workspace_id == workspace
                    && e.mission.pending.is_some()
                    && e.owner_runtime.as_deref() != Some(runtime)
            })
            .filter(|e| {
                e.mission
                    .pending
                    .as_ref()
                    .and_then(|k| e.mission.receipts.get(k))
                    .is_some_and(|r| r.state == ReceiptState::Reserved)
            })
            .map(|e| {
                (
                    e.mission.spec.mission_id.clone(),
                    e.mission.pending.clone().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let mut next = self.clone();
        for (id, key) in unresolved {
            next.uncertain(
                workspace,
                &id,
                &key,
                "Previous Desktop instance lost the acknowledgement; inspect, never resubmit",
                now,
            )?;
        }
        *self = next;
        Ok(())
    }
    pub fn disable(&mut self, workspace: &str, id: &str) -> Result<(), String> {
        let revision = self.bump()?;
        let b = self
            .bindings
            .iter_mut()
            .find(|b| b.id == id && b.workspace_id == workspace)
            .ok_or_else(|| err("Binding not found"))?;
        b.enabled = false;
        self.revision = revision;
        Ok(())
    }
    pub fn suspend_recovered(&mut self) {
        for b in &mut self.bindings {
            b.enabled = false;
        }
        // Backup recovery is not proof that any remote process stopped. Do not
        // resume or retransmit anything from recovered application metadata.
        for e in &mut self.missions {
            if active_writer(e) {
                e.mission.phase = Phase::Unknown;
                e.last_error =
                    Some("Recovered application backup; verify external task state".into());
            }
        }
    }
    pub fn view(&self, workspace: &str, mission: Option<&str>) -> Result<Value, String> {
        if let Some(id) = mission {
            self.find(workspace, id)?;
        }
        let bindings = self
            .bindings
            .iter()
            .filter(|b| b.workspace_id == workspace)
            .collect::<Vec<_>>();
        let missions = self
            .missions
            .iter()
            .filter(|e| {
                e.mission.spec.workspace_id == workspace
                    && mission.is_none_or(|id| e.mission.spec.mission_id == id)
            })
            .collect::<Vec<_>>();
        let orchestrations = self
            .orchestrations
            .iter()
            .filter(|record| {
                record.workspace_id == workspace
                    && mission.is_none_or(|id| {
                        record.planner_mission_id == id
                            || record.reviewer_mission_id == id
                            || record.worker_mission_ids.iter().any(|worker| worker == id)
                    })
            })
            .collect::<Vec<_>>();
        Ok(
            json!({"revision":self.revision,"bindings":bindings,"missions":missions,"orchestrations":orchestrations,
   "persistence":"application data with retained backups; credentials remain RAM-only",
   "automatic_replay":false,"external_runtime_sandbox_inherited":false,
   "review_identity":"coordinator attestation, not fabricated human approval"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_route_identity_survives_book_roundtrip() {
        let selected = serde_json::json!({
            "id": "web-main",
            "workspace_id": "qa",
            "root": "C:/qa",
            "roots_revision": "roots",
            "policy_stamp": "policy",
            "generation": "generation",
            "engine": "paseo",
            "endpoint": "ws://127.0.0.1:6768/ws",
            "provider": "chatgpt-web",
            "model": "chatgpt-web/high",
            "mode": "full-access",
            "account_id": "web-account",
            "route_id": "web-route",
            "project_id": null,
            "repo_id": null,
            "assignee_id": null,
            "max_duration_min": 10,
            "allow_codex": true,
            "enabled": true
        });
        let binding: Binding = serde_json::from_value(selected.clone()).unwrap();
        let mut book = Book::default();
        book.configure(binding, 0).unwrap();
        let saved: Book = serde_json::from_value(serde_json::to_value(&book).unwrap()).unwrap();
        let spec =
            saved
                .binding("qa", "web-main")
                .unwrap()
                .spec("mission", "task", "Read", "Read only");
        let public = serde_json::to_value(spec).unwrap();
        assert_eq!(public["account_id"], "web-account");
        assert_eq!(public["route_id"], "web-route");
        assert_eq!(public["model"], "chatgpt-web/high");

        let mut invalid = serde_json::to_value(saved.binding("qa", "web-main").unwrap()).unwrap();
        invalid["route_id"] = serde_json::json!("unsafe/route");
        let mut refused = Book::default();
        assert!(refused
            .configure(serde_json::from_value(invalid).unwrap(), 0)
            .is_err());

        let mut legacy = selected;
        legacy.as_object_mut().unwrap().remove("account_id");
        legacy.as_object_mut().unwrap().remove("route_id");
        let old: Binding = serde_json::from_value(legacy).unwrap();
        let old_spec = serde_json::to_value(old.spec("old", "task", "Read", "Read only")).unwrap();
        assert!(old_spec["account_id"].is_null());
        assert!(old_spec["route_id"].is_null());
    }

    #[test]
    fn paseo_start_identity_is_durable_before_transport() {
        let mut book = Book::default();
        book.configure(
            Binding {
                id: "paseo-binding".into(),
                workspace_id: "qa".into(),
                root: "C:/qa".into(),
                roots_revision: "roots".into(),
                policy_stamp: "policy".into(),
                generation: "generation".into(),
                engine: Engine::Paseo,
                endpoint: "ws://127.0.0.1:6768/ws".into(),
                provider: "codex".into(),
                model: "gemini-3.1-pro-low".into(),
                account_id: None,
                route_id: None,
                mode: "full-access".into(),
                project_id: None,
                repo_id: None,
                assignee_id: None,
                max_duration_min: 10,
                allow_codex: true,
                enabled: true,
            },
            0,
        )
        .unwrap();
        book.prepare(
            "qa",
            "paseo-binding",
            "task",
            "mission",
            "Title",
            "Brief",
            1,
        )
        .unwrap();
        book.reserve("qa", "mission", 0, "create-key", "runtime", Action::Create)
            .unwrap();
        book.acknowledge(
            "qa",
            "mission",
            "create-key",
            Reply::Created {
                record_id: "agent-1".into(),
            },
            2,
        )
        .unwrap();
        let revision = book.find("qa", "mission").unwrap().mission.revision;
        book.reserve(
            "qa",
            "mission",
            revision,
            "start-key",
            "runtime",
            Action::Start,
        )
        .unwrap();

        let saved: Book = serde_json::from_value(serde_json::to_value(book).unwrap()).unwrap();
        assert_eq!(
            saved
                .find("qa", "mission")
                .unwrap()
                .start_message_id
                .as_deref(),
            Some("start-key")
        );
    }

    #[test]
    fn orchestration_identity_is_durable_and_stable() {
        let mut book = Book::default();
        let record = OrchestrationRecord {
            id: "run-1".into(),
            workspace_id: "qa".into(),
            task_id: "task-1".into(),
            planner_task_id: "planner-task-1".into(),
            planner_binding_id: "planner-binding".into(),
            planner_binding_generation: "planner-generation".into(),
            planner_mission_id: "planner-1".into(),
            planner_request_key: "planner-key".into(),
            worker_binding_ids: vec!["worker-binding-1".into(), "worker-binding-2".into()],
            worker_binding_generations: vec![
                "worker-generation-1".into(),
                "worker-generation-2".into(),
            ],
            worker_mission_ids: vec!["worker-1".into(), "worker-2".into()],
            worker_task_ids: vec!["worker-task-1".into(), "worker-task-2".into()],
            worker_request_keys: vec!["worker-key-1".into(), "worker-key-2".into()],
            reviewer_binding_id: "reviewer-binding".into(),
            reviewer_binding_generation: "reviewer-generation".into(),
            reviewer_task_id: "reviewer-task-1".into(),
            reviewer_mission_id: "reviewer-1".into(),
            reviewer_request_key: "reviewer-key".into(),
            status: "planning".into(),
            revision: 0,
        };

        book.save_orchestration(record.clone(), 0).unwrap();
        let saved: Book = serde_json::from_value(serde_json::to_value(&book).unwrap()).unwrap();
        let persisted = saved.orchestration("qa", "run-1").unwrap();
        assert_eq!(persisted.planner_task_id, record.planner_task_id);
        assert_eq!(persisted.planner_binding_id, record.planner_binding_id);
        assert_eq!(
            persisted.planner_binding_generation,
            record.planner_binding_generation
        );
        assert_eq!(persisted.worker_binding_ids, record.worker_binding_ids);
        assert_eq!(
            persisted.worker_binding_generations,
            record.worker_binding_generations
        );
        assert_eq!(persisted.worker_mission_ids, record.worker_mission_ids);
        assert_eq!(persisted.worker_task_ids, record.worker_task_ids);
        assert_eq!(persisted.worker_request_keys, record.worker_request_keys);
        assert_eq!(persisted.reviewer_binding_id, record.reviewer_binding_id);
        assert_eq!(
            persisted.reviewer_binding_generation,
            record.reviewer_binding_generation
        );
        assert_eq!(persisted.reviewer_task_id, record.reviewer_task_id);
        assert_eq!(persisted.status, "planning");
        assert_eq!(persisted.revision, 1);
        assert_eq!(
            saved.view("qa", None).unwrap()["orchestrations"][0]["id"],
            "run-1"
        );

        let mut updated = persisted.clone();
        updated.status = "executing".into();
        book.save_orchestration(updated, 1).unwrap();
        assert_eq!(book.orchestration("qa", "run-1").unwrap().revision, 2);

        let mut changed_identity = book.orchestration("qa", "run-1").unwrap().clone();
        changed_identity.planner_task_id = "replacement-planner-task".into();
        assert!(book.save_orchestration(changed_identity, 2).is_err());

        let mut unaligned = record.clone();
        unaligned.worker_binding_generations.pop();
        unaligned.id = "run-2".into();
        assert!(book.save_orchestration(unaligned, 0).is_err());

        assert!(book
            .advance_orchestration("qa", "run-1", 2, "reviewing")
            .is_err());
        assert_eq!(
            book.orchestration("qa", "run-1").unwrap().status,
            "executing"
        );
        assert!(book
            .advance_orchestration("qa", "run-1", 1, "ready_for_review")
            .is_err());
        assert!(book
            .advance_orchestration("qa", "run-1", 2, "ready_for_review")
            .is_err());
        let owned = |mission_id: &str, binding_id: &str, generation: &str, key: &str| {
            let mut mission = Mission::new(Spec {
                engine: Engine::Paseo,
                mission_id: mission_id.into(),
                workspace_id: "qa".into(),
                task_id: "task-1".into(),
                cwd: "C:/qa".into(),
                provider: "chatgpt-web".into(),
                model: "chatgpt-web/high".into(),
                account_id: None,
                route_id: None,
                mode: "full-access".into(),
                project_id: None,
                repo_id: None,
                assignee_id: None,
                title: "test".into(),
                brief: "test".into(),
                max_duration_min: 10,
            })
            .unwrap();
            mission.record_id = Some(format!("agent-{mission_id}"));
            Entry {
                binding_id: binding_id.into(),
                binding_generation: generation.into(),
                mission,
                owner_runtime: None,
                created_at: 1,
                updated_at: 1,
                observed_at: Some(1),
                source_revision: None,
                last_error: None,
                observation: Value::Null,
                start_message_id: Some(key.into()),
                output: Some(PaseoStartResult {
                    agent_id: format!("agent-{mission_id}"),
                    turn_id: format!("turn-{mission_id}"),
                    epoch: "epoch".into(),
                    seq_start: 1,
                    seq_end: 2,
                    text: "verified".into(),
                }),
            }
        };
        book.missions.push(owned(
            "planner-1",
            "planner-binding",
            "planner-generation",
            "planner-key",
        ));
        book.missions.push(owned(
            "worker-1",
            "worker-binding-1",
            "worker-generation-1",
            "worker-key-1",
        ));
        book.missions.push(owned(
            "worker-2",
            "worker-binding-2",
            "worker-generation-2",
            "worker-key-2",
        ));
        let mut planning = saved.clone();
        assert!(planning
            .advance_orchestration("qa", "run-1", 1, "executing")
            .is_err());
        planning.missions.push(book.missions[0].clone());
        assert_eq!(
            planning
                .advance_orchestration("qa", "run-1", 1, "executing")
                .unwrap()
                .status,
            "executing"
        );
        let ready = book
            .advance_orchestration("qa", "run-1", 2, "ready_for_review")
            .unwrap();
        assert_eq!(ready.revision, 3);
        book.advance_orchestration("qa", "run-1", 3, "reviewing")
            .unwrap();
        assert!(book
            .advance_orchestration("qa", "run-1", 4, "passed")
            .is_err());
        book.missions.push(owned(
            "reviewer-1",
            "reviewer-binding",
            "reviewer-generation",
            "reviewer-key",
        ));
        book.missions
            .last_mut()
            .unwrap()
            .output
            .as_mut()
            .unwrap()
            .text =
            r#"{"verdict":"needs_changes","findings":[{"title":"Fix","detail":"Try again"}]}"#
                .into();
        assert!(book
            .advance_orchestration("qa", "run-1", 4, "passed")
            .is_err());
        assert_eq!(
            book.orchestration("qa", "run-1").unwrap().status,
            "reviewing"
        );
        let mut needs_changes = book.clone();
        assert_eq!(
            needs_changes
                .advance_orchestration("qa", "run-1", 4, "needs_changes")
                .unwrap()
                .status,
            "needs_changes"
        );
        book.missions
            .last_mut()
            .unwrap()
            .output
            .as_mut()
            .unwrap()
            .text = r#"{"verdict":"pass","findings":[],"extra":"untrusted"}"#.into();
        assert!(book
            .advance_orchestration("qa", "run-1", 4, "passed")
            .is_err());
        book.missions
            .last_mut()
            .unwrap()
            .output
            .as_mut()
            .unwrap()
            .text =
            r#"{"verdict":"pass","findings":[{"title":"Mismatch","detail":"Invalid"}]}"#.into();
        assert!(book
            .advance_orchestration("qa", "run-1", 4, "passed")
            .is_err());
        book.missions
            .last_mut()
            .unwrap()
            .output
            .as_mut()
            .unwrap()
            .text = r#"{"verdict":"pass","findings":[]}"#.into();
        book.advance_orchestration("qa", "run-1", 4, "passed")
            .unwrap();
        assert!(book
            .advance_orchestration("qa", "run-1", 5, "executing")
            .is_err());

        let legacy: Book = serde_json::from_value(json!({
            "revision": 0,
            "bindings": [],
            "missions": []
        }))
        .unwrap();
        assert!(legacy.orchestrations.is_empty());
    }
}

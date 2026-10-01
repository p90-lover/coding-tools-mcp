//! Reusable role definitions share the mission store; attempts keep their own settings.
use super::ao::{self, Node, Role, Run, State};
use crate::{
    data::AppData,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn fail(message: &str) -> AppError {
    AppError::Message(message.into())
}
pub fn default_worker_limit() -> u8 {
    3
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RoleSettings {
    pub name: String,
    pub specialty: String,
    pub instructions: String,
    pub expected_output: String,
    pub working_directory: String,
    pub revision: u64,
}

impl RoleSettings {
    pub fn validate(&self) -> AppResult<()> {
        for (value, limit, multiline) in [
            (&self.name, 96, false),
            (&self.specialty, 64, false),
            (&self.instructions, 4096, true),
            (&self.expected_output, 2048, true),
            (&self.working_directory, 512, false),
        ] {
            if value.len() > limit
                || value
                    .chars()
                    .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
            {
                return Err(fail(
                    "Role setting is too long or contains control characters",
                ));
            }
        }
        if self.working_directory.starts_with(['/', '\\'])
            || self.working_directory.contains(':')
            || self
                .working_directory
                .split(['/', '\\'])
                .any(|part| part == "..")
        {
            return Err(fail(
                "Role working directory must stay inside its registered workspace",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Team {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub revision: u64,
    #[serde(default = "default_worker_limit")]
    pub worker_limit: u8,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub revision: u64,
    pub max_workers: u8,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            revision: 0,
            max_workers: default_worker_limit(),
        }
    }
}

pub fn available_workers(data: &AppData, run: &Run) -> usize {
    let active = |mission: &Run| {
        mission
            .nodes
            .iter()
            .filter(|node| {
                node.role == Role::Worker && matches!(node.state, State::Reserved | State::Running)
            })
            .count()
    };
    let global = data.ao_runs.iter().map(active).sum::<usize>();
    usize::from(data.ao_limits.max_workers)
        .saturating_sub(global)
        .min(usize::from(run.worker_limit).saturating_sub(active(run)))
}

pub fn attach_worker_role(run: &mut Run, node: &mut Node) {
    let parents: Vec<_> = node
        .parents
        .iter()
        .filter_map(|id| run.nodes.iter().find(|parent| parent.id == *id))
        .map(|parent| {
            parent
                .template_role_id
                .clone()
                .unwrap_or_else(|| parent.id.clone())
        })
        .collect();
    if let Some(team) = run.team.as_mut() {
        let mut role = node.clone();
        role.task_id.clear();
        role.clause_id = None;
        role.parents = parents;
        role.template_role_id = None;
        node.template_role_id = Some(role.id.clone());
        if let Some(reviewer) = team
            .nodes
            .iter_mut()
            .find(|role| role.role == Role::Reviewer)
        {
            reviewer.parents.push(role.id.clone());
        }
        team.nodes.push(role);
    }
}

pub fn save(
    data: &mut AppData,
    workspace_id: &str,
    expected_revision: u64,
    mut team: Team,
) -> AppResult<Team> {
    if team.workspace_id != workspace_id
        || !data
            .profiles
            .iter()
            .any(|profile| profile.id == workspace_id)
    {
        return Err(fail("Team is outside the registered workspace"));
    }
    if team.name.trim().is_empty()
        || team.name.len() > 128
        || team.name.chars().any(char::is_control)
        || !(1..=24).contains(&team.worker_limit)
    {
        return Err(fail(
            "Choose a team name and one to 24 simultaneous workers",
        ));
    }
    let existing = data
        .ao_teams
        .iter()
        .position(|item| item.workspace_id == workspace_id);
    if existing
        .map(|index| data.ao_teams[index].revision)
        .unwrap_or(0)
        != expected_revision
        || existing.is_some_and(|index| data.ao_teams[index].id != team.id)
    {
        return Err(fail("AO team revision changed; refresh before applying"));
    }
    if team.nodes.iter().any(|node| {
        node.state != State::Pending
            || !node.task_id.is_empty()
            || node.clause_id.is_some()
            || node.request_key.is_some()
            || node.receipt.is_some()
            || !node.history.is_empty()
    }) {
        return Err(fail(
            "Reusable roles cannot contain task execution receipts",
        ));
    }
    let proposal = Run {
        id: team.id.clone(),
        workspace_id: workspace_id.into(),
        project_id: team.id.clone(),
        revision: 0,
        cancelled: false,
        paused: false,
        nodes: team.nodes.clone(),
        grant: None,
        team: None,
        worker_limit: team.worker_limit,
        review_rounds: 0,
    };
    ao::validate(None, &proposal)?;
    team.revision = expected_revision + 1;
    for node in &mut team.nodes {
        node.settings.revision = team.revision;
        node.template_role_id = None;
    }
    if let Some(index) = existing {
        data.ao_teams[index] = team.clone();
    } else {
        data.ao_teams.push(team.clone());
    }
    Ok(team)
}

pub fn create_run(
    data: &mut AppData,
    workspace_id: &str,
    run_id: String,
    task_id: String,
    expected_board_revision: u64,
    team_revision: u64,
    worker_limit: u8,
) -> AppResult<Run> {
    let team = data
        .ao_teams
        .iter()
        .find(|team| team.workspace_id == workspace_id && team.revision == team_revision)
        .cloned()
        .ok_or_else(|| fail("Saved team changed; refresh before creating this mission"))?;
    if !(1..=24).contains(&worker_limit) {
        return Err(fail("Mission worker limit must be one to 24"));
    }
    let ids: HashMap<_, _> = team
        .nodes
        .iter()
        .map(|role| (role.id.clone(), uuid::Uuid::new_v4().to_string()))
        .collect();
    let nodes = team
        .nodes
        .iter()
        .map(|role| {
            let mut node = role.clone();
            node.id = ids[&role.id].clone();
            node.template_role_id = Some(role.id.clone());
            node.task_id = task_id.clone();
            node.parents = role
                .parents
                .iter()
                .map(|parent| ids[parent].clone())
                .collect();
            node
        })
        .collect();
    ao::create(
        data,
        expected_board_revision,
        Run {
            id: run_id,
            workspace_id: workspace_id.into(),
            project_id: task_id,
            revision: 0,
            cancelled: false,
            paused: false,
            nodes,
            grant: None,
            team: Some(team),
            worker_limit,
            review_rounds: 0,
        },
    )
}

pub fn control(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    action: &str,
) -> AppResult<Run> {
    let run = data
        .ao_runs
        .iter_mut()
        .find(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO mission was not found"))?;
    if run.nodes.iter().all(|node| node.state == State::Finished) {
        return Ok(run.clone());
    }
    match action {
        "pause" => run.paused = true,
        "resume" if !run.cancelled => run.paused = false,
        "stop" => {
            run.paused = true;
            run.cancelled = true;
            run.grant = None;
            for node in &mut run.nodes {
                if node.state == State::Pending {
                    node.state = State::Cancelled;
                }
            }
        }
        // A held card (its turn failed or could not be confirmed) goes back to the queue; the
        // failed attempt stays in its history. The grant is dropped so the next start re-grants.
        "retry" if !run.cancelled => {
            let mut retried = false;
            for node in &mut run.nodes {
                if node.state != State::Held {
                    continue;
                }
                if let Some(receipt) = node.receipt.take() {
                    node.history.push(receipt);
                }
                if node.history.len() > 2 {
                    let excess = node.history.len() - 2;
                    node.history.drain(..excess);
                }
                node.request_key = None;
                node.state = State::Pending;
                retried = true;
            }
            if !retried {
                return Err(fail("This mission has no held card to retry"));
            }
            run.grant = None;
            run.paused = false;
        }
        "stopped" if run.cancelled => {
            for node in &mut run.nodes {
                if matches!(node.state, State::Running | State::Reserved | State::Held) {
                    node.state = State::Cancelled;
                    if let Some(receipt) = node.receipt.as_mut() {
                        receipt.status = "held".into();
                        receipt.error =
                            Some("Stopped by the user; this request will not be replayed".into());
                    }
                }
            }
        }
        _ => return Err(fail("Stopped missions cannot resume; create a new mission")),
    }
    run.revision += 1;
    Ok(run.clone())
}

pub fn apply(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
    team_revision: u64,
) -> AppResult<Run> {
    let team = data
        .ao_teams
        .iter()
        .find(|team| team.workspace_id == workspace_id && team.revision == team_revision)
        .cloned()
        .ok_or_else(|| fail("Saved team changed; refresh before applying"))?;
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO mission was not found"))?;
    let mut next = data.ao_runs[index].clone();
    if next.revision != expected_revision || next.cancelled {
        return Err(fail("AO mission revision changed"));
    }
    if next
        .team
        .as_ref()
        .is_some_and(|snapshot| snapshot.id != team.id)
    {
        return Err(fail("Mission uses another team"));
    }
    for node in &mut next.nodes {
        if node.state != State::Pending {
            continue;
        }
        let role_id = node.template_role_id.as_deref().unwrap_or(&node.id);
        let role = team.nodes.iter().find(|role| role.id == role_id)
            .ok_or_else(|| fail("A queued role was removed; cancel its task or use the changed team for a new mission"))?;
        node.template_role_id = Some(role.id.clone());
        node.settings = role.settings.clone();
        node.route = role.route.clone();
        node.role = role.role.clone();
    }
    ao::validate(Some(data), &next)?;
    next.team = Some(team);
    // This API is local-UI-only. Apply explicitly authorizes queued settings; running receipts stay intact.
    if next.grant.is_some() {
        let fingerprint = ao::graph_sha256(data, &next)?;
        if let Some(grant) = next.grant.as_mut() {
            grant.graph_sha256 = fingerprint;
        }
    }
    next.revision += 1;
    data.ao_runs[index] = next.clone();
    Ok(next)
}

pub fn set_limits(
    data: &mut AppData,
    workspace_id: &str,
    expected_revision: u64,
    max_workers: u8,
    mission: Option<(&str, u64, u8)>,
) -> AppResult<()> {
    if data.ao_limits.revision != expected_revision || !(1..=24).contains(&max_workers) {
        return Err(fail("Worker limit changed or is outside one to 24"));
    }
    if let Some((id, revision, limit)) = mission {
        let run = data
            .ao_runs
            .iter_mut()
            .find(|run| run.id == id && run.workspace_id == workspace_id)
            .ok_or_else(|| fail("AO mission is outside this workspace"))?;
        if run.revision != revision || !(1..=24).contains(&limit) {
            return Err(fail("Mission worker limit or revision changed"));
        }
        run.worker_limit = limit;
        run.revision += 1;
    }
    data.ao_limits.max_workers = max_workers;
    data.ao_limits.revision += 1;
    Ok(())
}

// Called only after the owned reviewer connection is closed, never when reopening saved work.
pub fn queue_rework(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    reviewer_id: &str,
    request_key: &str,
    now_ms: u64,
) -> AppResult<Option<Run>> {
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO mission was not found"))?;
    let mut next = data.ao_runs[index].clone();
    let reviewer = next.nodes.iter().position(|node| {
        node.id == reviewer_id && node.role == Role::Reviewer && node.state == State::Held
    });
    let Some(reviewer) = reviewer else {
        return Ok(None);
    };
    let Some(receipt) = next.nodes[reviewer].receipt.as_ref() else {
        return Ok(None);
    };
    if next.cancelled
        || receipt.request_key != request_key
        || receipt.turn_id.is_none()
        || receipt.verdict.as_deref() != Some("CHANGES_REQUIRED")
        || next.grant.is_none()
    {
        return Ok(None);
    }
    if next.review_rounds >= 2 {
        next.nodes[reviewer].receipt.as_mut().unwrap().error = Some(
            "Review still requests changes after two rework rounds; human review is required"
                .into(),
        );
    } else if let Err(error) = ao::grant_valid(
        data,
        &next,
        now_ms,
        &next.grant.as_ref().unwrap().executable_sha256,
    ) {
        next.nodes[reviewer].receipt.as_mut().unwrap().error =
            Some(format!("Rework held: {error}"));
    } else {
        if next
            .nodes
            .iter()
            .filter(|node| node.role == Role::Worker)
            .any(|node| {
                node.state != State::Finished
                    || node.receipt.as_ref().is_none_or(|receipt| {
                        receipt.status != "completed" || receipt.turn_id.is_none()
                    })
            })
        {
            return Ok(None);
        }
        for node in &mut next.nodes {
            if node.role == Role::Planner {
                continue;
            }
            if let Some(receipt) = node.receipt.take() {
                node.history.push(receipt);
            }
            node.request_key = None;
            node.state = State::Pending;
        }
        next.review_rounds += 1;
    }
    next.revision += 1;
    data.ao_runs[index] = next.clone();
    Ok(Some(next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saved_roles_apply_to_queued_work_without_rewriting_the_active_attempt() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let mut data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),"tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"goal","workspace_id":"qa","title":"Test roles","description":"Read only","state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        })).unwrap();
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let worker = json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity","account_id":"shared-cpa-pool","model":"gemini-3.8-flash-high","permission_profile":":read-only"});
        let team: Team = serde_json::from_value(json!({"id":"team","workspace_id":"qa","name":"Product team","revision":0,"nodes":[
            {"id":"lead","task_id":"","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":web},
            {"id":"worker","task_id":"","role":"worker","parents":["lead"],"x":0,"y":1,"state":"pending","route":worker},
            {"id":"review","task_id":"","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":web}
        ]})).unwrap();
        let mut team = save(&mut data, "qa", 0, team).unwrap();
        let run = create_run(&mut data, "qa", "run".into(), "goal".into(), 1, 1, 2).unwrap();
        let planner = run.nodes[0].id.clone();
        assert_eq!(run.nodes[1].template_role_id.as_deref(), Some("worker"));
        let sha = "a".repeat(64);
        let granted = ao::grant_run(&mut data, "qa", "run", run.revision, &sha, 1000).unwrap();
        ao::reserve(
            &mut data,
            "qa",
            "run",
            &planner,
            granted.revision,
            "one".into(),
            Some(1001),
        )
        .unwrap();
        let active = ao::record_submission(
            &mut data,
            "qa",
            "run",
            &planner,
            "one",
            Some("native-thread"),
        )
        .unwrap();
        team.nodes[0].settings.instructions = "Updated planning rules".into();
        team.nodes[1].settings.instructions = "Verify the API contract".into();
        let saved = save(&mut data, "qa", 1, team.clone()).unwrap();
        assert!(save(&mut data, "qa", 1, team).is_err());
        let applied = apply(&mut data, "qa", "run", active.revision, saved.revision).unwrap();
        assert_eq!(applied.nodes[0].settings.revision, 1);
        assert_eq!(
            applied.nodes[0]
                .receipt
                .as_ref()
                .unwrap()
                .settings
                .as_ref()
                .unwrap()
                .revision,
            1
        );
        assert_eq!(applied.nodes[1].settings.revision, 2);
        assert_eq!(
            applied.nodes[1].settings.instructions,
            "Verify the API contract"
        );
        assert_eq!(applied.nodes[0].state, State::Running);
        assert!(ao::grant_valid(&data, &applied, 1002, &sha).is_ok());

        ao::record_terminal(
            &mut data,
            "qa",
            "run",
            &planner,
            "native-thread",
            Some("plan-turn"),
            Some("Plan"),
            true,
            None,
        )
        .unwrap();
        let mut extra = data.ao_runs[0].nodes[1].clone();
        extra.id = "another-worker".into();
        let revision = data.ao_runs[0].revision;
        ao::update_graph(
            &mut data,
            "qa",
            "run",
            revision,
            ao::GraphChange::AddWorker {
                node: Box::new(extra),
            },
        )
        .unwrap();
        data.ao_runs[0].worker_limit = 1;
        let first_worker = data.ao_runs[0].nodes[1].id.clone();
        let revision = data.ao_runs[0].revision;
        ao::reserve(
            &mut data,
            "qa",
            "run",
            &first_worker,
            revision,
            "slot-one".into(),
            None,
        )
        .unwrap();
        let revision = data.ao_runs[0].revision;
        assert!(ao::reserve(
            &mut data,
            "qa",
            "run",
            "another-worker",
            revision,
            "slot-two".into(),
            None
        )
        .is_err());
        assert_eq!(data.ao_runs[0].nodes.last().unwrap().state, State::Pending);
        let second = create_run(&mut data, "qa", "run-two".into(), "goal".into(), 1, 2, 3).unwrap();
        let second_planner = second.nodes[0].id.clone();
        ao::reserve(
            &mut data,
            "qa",
            "run-two",
            &second_planner,
            second.revision,
            "plan-two".into(),
            None,
        )
        .unwrap();
        ao::record_submission(
            &mut data,
            "qa",
            "run-two",
            &second_planner,
            "plan-two",
            Some("thread-two"),
        )
        .unwrap();
        let second = ao::record_terminal(
            &mut data,
            "qa",
            "run-two",
            &second_planner,
            "thread-two",
            Some("turn-two"),
            Some("Plan"),
            true,
            None,
        )
        .unwrap();
        data.ao_limits.max_workers = 1;
        assert!(ao::reserve(
            &mut data,
            "qa",
            "run-two",
            &second.nodes[1].id,
            second.revision,
            "global-slot".into(),
            None
        )
        .is_err());
        let paused = control(&mut data, "qa", "run-two", "pause").unwrap();
        data.ao_limits.max_workers = 3;
        assert!(ao::reserve(
            &mut data,
            "qa",
            "run-two",
            &second.nodes[1].id,
            paused.revision,
            "paused-slot".into(),
            None
        )
        .is_err());
        let resumed = control(&mut data, "qa", "run-two", "resume").unwrap();
        ao::reserve(
            &mut data,
            "qa",
            "run-two",
            &second.nodes[1].id,
            resumed.revision,
            "resumed-slot".into(),
            None,
        )
        .unwrap();
        control(&mut data, "qa", "run-two", "stop").unwrap();
        let stopped = control(&mut data, "qa", "run-two", "stopped").unwrap();
        assert_eq!(stopped.nodes[1].state, State::Cancelled);
        assert!(control(&mut data, "qa", "run-two", "resume").is_err());
    }
    #[test]
    fn a_held_card_can_be_retried_and_keeps_its_failed_attempt() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let mut data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),"tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"goal","workspace_id":"qa","title":"Retry","description":"","state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        })).unwrap();
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let team: Team = serde_json::from_value(json!({"id":"team","workspace_id":"qa","name":"T","revision":0,"nodes":[
            {"id":"lead","task_id":"","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":web},
            {"id":"worker","task_id":"","role":"worker","parents":["lead"],"x":0,"y":1,"state":"pending","route":web},
            {"id":"review","task_id":"","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":web}
        ]})).unwrap();
        save(&mut data, "qa", 0, team).unwrap();
        create_run(&mut data, "qa", "run".into(), "goal".into(), 1, 1, 2).unwrap();
        assert!(
            control(&mut data, "qa", "run", "retry").is_err(),
            "nothing is held yet"
        );
        {
            let run = data.ao_runs.iter_mut().find(|run| run.id == "run").unwrap();
            run.nodes[0].state = State::Held;
            run.nodes[0].request_key = Some("one".into());
            run.nodes[0].receipt = Some(serde_json::from_value(json!({"request_key":"one","status":"held","error":"send not confirmed","route":web})).unwrap());
        }
        let retried = control(&mut data, "qa", "run", "retry").unwrap();
        assert_eq!(retried.nodes[0].state, State::Pending);
        assert!(retried.nodes[0].receipt.is_none() && retried.nodes[0].request_key.is_none());
        assert_eq!(retried.nodes[0].history.len(), 1);
        assert!(retried.grant.is_none() && !retried.paused);
        ao::validate(Some(&data), &retried).unwrap();
    }

    #[test]
    fn role_settings_and_limits_are_bounded_without_changing_credentials() {
        assert_eq!(Limits::default().max_workers, 3);
        for directory in [
            "../outside",
            "C:\\private",
            "src/../../private",
            "\\\\host\\share",
        ] {
            assert!(RoleSettings {
                working_directory: directory.into(),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        assert!(RoleSettings {
            instructions: "Plan\nthen test".into(),
            working_directory: "src/tests".into(),
            ..Default::default()
        }
        .validate()
        .is_ok());
        let mut data = AppData::default();
        assert!(set_limits(&mut data, "workspace", 0, 0, None).is_err());
        set_limits(&mut data, "workspace", 0, 6, None).unwrap();
        assert_eq!(data.ao_limits.max_workers, 6);
        assert!(set_limits(&mut data, "workspace", 0, 5, None).is_err());
    }
}

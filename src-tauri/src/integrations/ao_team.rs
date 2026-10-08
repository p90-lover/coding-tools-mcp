//! Reusable role definitions share the mission store; attempts keep their own settings.
use super::ao::{self, Node, Role, Run, State};
use crate::{
    data::AppData,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

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
    /// Command approver only: allow or deny tool requests on its own. Off means it only recommends.
    /// Omitted when off, so grants issued before this setting keep their fingerprint.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub auto_decide: bool,
    /// A role the user typed (e.g. "Security auditor"). The card keeps its base role's place in
    /// the mission; the name is shown everywhere and given to the model as its role.
    /// Omitted when empty, so grants issued before this setting keep their fingerprint.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub role_name: String,
}

impl RoleSettings {
    pub fn validate(&self) -> AppResult<()> {
        for (value, limit, multiline) in [
            (&self.name, 96, false),
            (&self.specialty, 64, false),
            (&self.instructions, 4096, true),
            (&self.expected_output, 2048, true),
            (&self.working_directory, 512, false),
            (&self.role_name, 48, false),
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub editable_graph: bool,
    #[serde(default = "default_worker_limit")]
    pub worker_limit: u8,
    /// Rework rounds new missions from this team allow (1 to 10).
    #[serde(default = "ao::default_review_rounds")]
    pub max_review_rounds: u8,
    pub nodes: Vec<Node>,
    /// Explicit mission-only future intent; never persisted as a reusable team's grant.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub permission_selections: BTreeMap<String, PermissionSelection>,
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
        team.nodes.push(role);
        normalize_roles(&mut team.nodes);
    }
}

/// Wires the helper roles so a team only lists them: the command approver sits between the
/// planner and the workers, and sub-reviewers get the main reviewer's split pass in front of
/// them. The split pass mirrors the main reviewer's harness, model and settings.
pub fn normalize_roles(nodes: &mut Vec<Node>) {
    let first = |nodes: &[Node], role: Role| {
        nodes
            .iter()
            .find(|node| node.role == role)
            .map(|node| node.id.clone())
    };
    let all = |nodes: &[Node], role: Role| {
        nodes
            .iter()
            .filter(|node| node.role == role)
            .map(|node| node.id.clone())
            .collect::<Vec<_>>()
    };
    let (Some(planner), Some(reviewer)) =
        (first(nodes, Role::Planner), first(nodes, Role::Reviewer))
    else {
        return;
    };
    let approver = first(nodes, Role::Approver);
    let workers = all(nodes, Role::Worker);
    let sub_reviewers = all(nodes, Role::SubReviewer);
    if sub_reviewers.is_empty() {
        nodes.retain(|node| node.role != Role::ReviewSplit);
    } else if first(nodes, Role::ReviewSplit).is_none() {
        let main = nodes
            .iter()
            .find(|node| node.id == reviewer)
            .cloned()
            .expect("reviewer exists");
        let mut split = main.clone();
        split.id = (0..)
            .map(|n| {
                if n == 0 {
                    format!("{}-split", main.id)
                } else {
                    format!("{}-split-{n}", main.id)
                }
            })
            .find(|id| !nodes.iter().any(|node| &node.id == id))
            .expect("a free id");
        split.role = Role::ReviewSplit;
        split.y = main.y.saturating_sub(1);
        split.request_key = None;
        split.receipt = None;
        split.history.clear();
        split.state = State::Pending;
        nodes.push(split);
    }
    let split = first(nodes, Role::ReviewSplit);
    if let (Some(split_id), Some(main)) = (
        &split,
        nodes.iter().find(|node| node.id == reviewer).cloned(),
    ) {
        if let Some(node) = nodes.iter_mut().find(|node| &node.id == split_id) {
            let previous = node.route.clone();
            node.route = main.route;
            node.route.permission_profile = if node.route.harness_id == "codex-native" {
                if previous.harness_id == "codex-native" {
                    previous.permission_profile.clone()
                } else {
                    previous
                        .native_permission_profile
                        .clone()
                        .unwrap_or_else(|| {
                            if previous.permission_profile == ao::EXTERNAL_PERMISSION {
                                ":read-only".into()
                            } else {
                                previous.permission_profile.clone()
                            }
                        })
                }
            } else {
                ao::EXTERNAL_PERMISSION.into()
            };
            node.route.native_permission_profile = if node.route.harness_id != "codex-native"
                && previous.harness_id == "codex-native"
            {
                Some(previous.permission_profile)
            } else {
                previous.native_permission_profile
            };
            node.route.approval_policy = previous.approval_policy;
            node.route.approvals_reviewer = previous.approvals_reviewer;
            node.settings = main.settings.clone();
            node.settings.name = format!(
                "{} · split",
                if main.settings.name.is_empty() {
                    "Main reviewer"
                } else {
                    &main.settings.name
                }
            );
        }
    }
    for node in nodes.iter_mut() {
        match node.role {
            Role::Planner => node.parents.clear(),
            Role::Approver | Role::Retry => node.parents = vec![planner.clone()],
            Role::Worker => {
                for required in std::iter::once(&planner).chain(approver.as_ref()) {
                    if !node.parents.contains(required) {
                        node.parents.push(required.clone());
                    }
                }
            }
            Role::ReviewSplit => node.parents = workers.clone(),
            Role::SubReviewer => node.parents = split.iter().cloned().collect(),
            Role::Reviewer => {
                node.parents = if sub_reviewers.is_empty() {
                    workers.clone()
                } else {
                    sub_reviewers.clone()
                }
            }
        }
    }
}

/// Native Codex runs only WebGPT. Every other model runs on an AO harness through the CPA
/// gateway ("cpa/<model>"): Gemini on Claude Code, the rest on Codex. A Native Codex card with
/// a CPA model is moved there when a team is saved or a mission is created from it; its effort
/// is kept, and its context window dropped (AO harnesses have no such setting).
pub fn normalize_routes(nodes: &mut [Node]) {
    for node in nodes {
        let route = &mut node.route;
        if route.harness_id == "codex-native" && route.provider_id == "cliproxyapi-antigravity" {
            let agent = if route.model.to_ascii_lowercase().starts_with("gemini") {
                "ao:claude-code"
            } else {
                "ao:codex"
            };
            route.model = format!("cpa/{}", route.model);
            route.harness_id = agent.into();
            route.provider_id = "agent-orchestrator".into();
            route.account_id = "ao-local".into();
            if route.native_permission_profile.is_none() {
                route.native_permission_profile = Some(route.permission_profile.clone());
            }
            route.permission_profile = ":ao-default".into();
            route.context_window = None;
        }
    }
}

/// Every card must name its model. "default" lets an agent pick, and change, its own model.
pub fn require_explicit_models(nodes: &[Node]) -> AppResult<()> {
    match nodes
        .iter()
        .find(|node| node.route.model.trim().is_empty() || node.route.model == "default")
    {
        Some(node) => Err(fail(&format!(
            "Choose a model for {} in Team settings: \"default\" lets the agent pick and change its own model",
            if node.settings.name.is_empty() { node.id.as_str() } else { node.settings.name.as_str() }
        ))),
        None => Ok(()),
    }
}

/// Old stores have one unflagged team. Keep it as the default until explicitly promoted.
pub fn default_team<'a>(data: &'a AppData, workspace_id: &str) -> Option<&'a Team> {
    let mut teams = data
        .ao_teams
        .iter()
        .filter(|team| team.workspace_id == workspace_id);
    teams
        .clone()
        .find(|team| team.is_default)
        .or_else(|| teams.next())
}

pub fn save(
    data: &mut AppData,
    workspace_id: &str,
    expected_revision: u64,
    mut team: Team,
) -> AppResult<Team> {
    if !team.permission_selections.is_empty() {
        return Err(fail(
            "Mission-only deferred permissions cannot be saved as a reusable team",
        ));
    }
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
    if !(1..=ao::MAX_REVIEW_ROUNDS).contains(&team.max_review_rounds) {
        return Err(fail("Choose one to ten review rounds"));
    }
    if data
        .ao_teams
        .iter()
        .any(|item| item.id == team.id && item.workspace_id != workspace_id)
    {
        return Err(fail("Team is outside the registered workspace"));
    }
    if !team.editable_graph {
        normalize_roles(&mut team.nodes);
    }
    normalize_routes(&mut team.nodes);
    require_explicit_models(&team.nodes)?;
    let existing = data
        .ao_teams
        .iter()
        .position(|item| item.workspace_id == workspace_id && item.id == team.id);
    if existing
        .map(|index| data.ao_teams[index].revision)
        .unwrap_or(0)
        != expected_revision
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
        assignments: Default::default(),
        max_review_rounds: team.max_review_rounds,
        plan_rounds: 0,
        review_parts: Default::default(),
        rerun_after: Default::default(),
        solo: false,
        execution_mode: ao::ExecutionMode::Team,
    };
    ao::validate(None, &proposal)?;
    team.revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| fail("AO team revision exhausted"))?;
    let current_default = default_team(data, workspace_id).map(|team| team.id.clone());
    team.is_default = team.is_default || current_default.as_ref().is_none_or(|id| id == &team.id);
    // Promotion changes the former default's metadata, so its stale drafts must be rejected.
    let demoted: Vec<_> = data
        .ao_teams
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            item.workspace_id == workspace_id
                && item.id != team.id
                && team.is_default
                && (item.is_default || current_default.as_deref() == Some(item.id.as_str()))
        })
        .map(|(index, item)| {
            item.revision
                .checked_add(1)
                .map(|revision| (index, revision))
                .ok_or_else(|| fail("AO team revision exhausted"))
        })
        .collect::<AppResult<_>>()?;
    for (index, revision) in demoted {
        data.ao_teams[index].is_default = false;
        data.ao_teams[index].revision = revision;
    }
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

#[derive(Clone, Debug, Default)]
pub struct CreateSelection {
    pub execution_mode: Option<ao::ExecutionMode>,
    pub team_id: Option<String>,
    pub team_revision: Option<u64>,
    pub single_route: Option<ao::Route>,
}

fn selected_team<'a>(
    data: &'a AppData,
    workspace_id: &str,
    id: Option<&str>,
    revision: u64,
) -> AppResult<&'a Team> {
    // Never search by revision alone: multiple saved identities may have the same revision.
    // Without an explicit id the workspace's default team is meant, as in saved-team creation.
    let team = match id {
        Some(id) => data
            .ao_teams
            .iter()
            .find(|team| team.workspace_id == workspace_id && team.id == id),
        None => default_team(data, workspace_id),
    }
    .ok_or_else(|| fail("Saved team was not found in this workspace"))?;
    if team.revision != revision {
        return Err(fail("Saved team revision changed; refresh"));
    }
    Ok(team)
}

#[allow(clippy::too_many_arguments)] // Mirrors the headless create-run mutation's fields one to one.
pub fn create_run(
    data: &mut AppData,
    workspace_id: &str,
    run_id: String,
    task_id: String,
    expected_board_revision: u64,
    team_revision: u64,
    team_id: Option<&str>,
    worker_limit: u8,
) -> AppResult<Run> {
    create_selected_run(
        data,
        workspace_id,
        run_id,
        task_id,
        expected_board_revision,
        worker_limit,
        CreateSelection {
            team_id: team_id.map(str::to_owned),
            team_revision: Some(team_revision),
            ..Default::default()
        },
    )
}

pub fn create_selected_run(
    data: &mut AppData,
    workspace_id: &str,
    run_id: String,
    task_id: String,
    expected_board_revision: u64,
    worker_limit: u8,
    selection: CreateSelection,
) -> AppResult<Run> {
    if !(1..=24).contains(&worker_limit) {
        return Err(fail("Mission worker limit must be one to 24"));
    }
    if selection.execution_mode == Some(ao::ExecutionMode::Single) {
        if selection.team_id.is_some() || selection.team_revision.is_some() {
            return Err(fail("Single execution does not select a reusable team"));
        }
        let route = selection
            .single_route
            .ok_or_else(|| fail("Single execution requires an explicit selected model route"))?;
        let node = Node {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.clone(),
            clause_id: None,
            role: Role::Planner,
            parents: vec![],
            x: 0,
            y: 0,
            positioned: false,
            state: State::Pending,
            route,
            template_role_id: None,
            settings: RoleSettings {
                name: "Single assistant".into(),
                ..Default::default()
            },
            request_key: None,
            receipt: None,
            history: vec![],
        };
        require_explicit_models(std::slice::from_ref(&node))?;
        return ao::create(
            data,
            expected_board_revision,
            Run {
                id: run_id,
                workspace_id: workspace_id.into(),
                project_id: task_id,
                revision: 0,
                cancelled: false,
                paused: false,
                nodes: vec![node],
                grant: None,
                team: None,
                worker_limit: 1,
                review_rounds: 0,
                assignments: Default::default(),
                max_review_rounds: ao::default_review_rounds(),
                plan_rounds: 0,
                review_parts: Default::default(),
                rerun_after: Default::default(),
                solo: false,
                execution_mode: ao::ExecutionMode::Single,
            },
        );
    }
    if selection.single_route.is_some()
        || (selection.execution_mode.is_some() && selection.team_id.is_none())
    {
        return Err(fail(
            "Team execution requires a saved team identity and no single route",
        ));
    }
    let revision = selection
        .team_revision
        .ok_or_else(|| fail("Team execution requires the saved team revision"))?;
    let team = selected_team(data, workspace_id, selection.team_id.as_deref(), revision)?.clone();
    create_run_with_snapshot(
        data,
        workspace_id,
        run_id,
        task_id,
        expected_board_revision,
        team,
        worker_limit,
    )
}

/// Creates from an exact saved snapshot, so an edit in another task cannot change this run.
pub fn create_run_with_snapshot(
    data: &mut AppData,
    workspace_id: &str,
    run_id: String,
    task_id: String,
    expected_board_revision: u64,
    team: Team,
    worker_limit: u8,
) -> AppResult<Run> {
    if team.workspace_id != workspace_id {
        return Err(fail("Saved team belongs to another workspace"));
    }
    if !(1..=24).contains(&worker_limit) {
        return Err(fail("Mission worker limit must be one to 24"));
    }
    let ids: HashMap<_, _> = team
        .nodes
        .iter()
        .map(|role| (role.id.clone(), uuid::Uuid::new_v4().to_string()))
        .collect();
    let mut nodes: Vec<Node> = team
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
    // Older saved teams: move Gemini to Claude Code and refuse cards left on "default".
    normalize_routes(&mut nodes);
    require_explicit_models(&nodes)?;
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
            max_review_rounds: team.max_review_rounds,
            team: Some(team),
            worker_limit,
            review_rounds: 0,
            assignments: Default::default(),
            plan_rounds: 0,
            review_parts: Default::default(),
            rerun_after: Default::default(),
            solo: false,
            execution_mode: ao::ExecutionMode::Team,
        },
    )
}

pub fn control(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    action: &str,
) -> AppResult<Run> {
    control_selected(data, workspace_id, run_id, action, None)
}

/// Local-UI control; selecting one failed attempt never restarts or interrupts its siblings.
pub fn control_selected(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    action: &str,
    node_id: Option<&str>,
) -> AppResult<Run> {
    let run = data
        .ao_runs
        .iter_mut()
        .find(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO mission was not found"))?;
    if node_id.is_some_and(|id| !run.nodes.iter().any(|node| node.id == id)) {
        return Err(fail("AO control node is outside this mission"));
    }
    if action == "retry_auto" {
        let node = node_id
            .and_then(|id| run.nodes.iter().find(|node| node.id == id))
            .ok_or_else(|| fail("Automatic retry requires one saved worker"))?;
        if node.role != Role::Worker || node.state != State::Held || node.history.len() >= 2 {
            return Err(fail(
                "Automatic worker retries are exhausted or the saved attempt changed",
            ));
        }
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
        "retry" | "retry_auto" if !run.cancelled => {
            let recovering = run
                .nodes
                .iter()
                .any(|node| node.role == Role::Worker && node.state == State::Held);
            let mut retried = false;
            for node in &mut run.nodes {
                if node_id.is_some_and(|id| node.id != id) {
                    continue;
                }
                if !matches!(node.state, State::Held | State::Failed)
                    && !(node_id.is_some()
                        && node.role == Role::Retry
                        && node.state == State::Finished
                        && recovering)
                {
                    continue;
                }
                requeue(node, run.team.as_ref());
                retried = true;
            }
            if !retried {
                return Err(fail("This mission has no failed card to retry"));
            }
            // Only attempt state changed; the signed graph and healthy receipts are unchanged.
            run.paused = false;
        }
        "review_failures" if !run.cancelled => {
            let new_worker_failure = run.nodes.iter().any(|node| {
                node.state == State::Held
                    && node.role == Role::Worker
                    && node_id.is_none_or(|id| node.id == id)
            });
            let refresh_review = new_worker_failure
                && run.nodes.iter().any(|node| {
                    matches!(
                        node.role,
                        Role::ReviewSplit | Role::SubReviewer | Role::Reviewer
                    ) && node.state != State::Pending
                        && !run.rerun_after.contains(&node.id)
                });
            if refresh_review && run.review_rounds >= run.max_review_rounds {
                return Err(fail(
                    "Failure review rounds exhausted; local review is required",
                ));
            }
            let mut changed = false;
            for node in &mut run.nodes {
                if node_id.is_some_and(|id| node.id != id) {
                    continue;
                }
                if node.state == State::Held && matches!(node.role, Role::Worker | Role::Retry) {
                    node.state = State::Failed;
                    changed = true;
                }
            }
            if !changed {
                return Err(fail(
                    "No held worker or Retry role can be sent for failure review",
                ));
            }
            if new_worker_failure {
                if refresh_review {
                    run.review_rounds += 1;
                }
                for node in &mut run.nodes {
                    if !matches!(
                        node.role,
                        Role::ReviewSplit | Role::SubReviewer | Role::Reviewer
                    ) {
                        continue;
                    }
                    if matches!(node.state, State::Running | State::Reserved) {
                        run.rerun_after.insert(node.id.clone());
                    } else if matches!(node.state, State::Finished | State::Held | State::Failed) {
                        requeue(node, run.team.as_ref());
                    }
                }
                run.review_parts.clear();
            }
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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PermissionSelection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
}

impl PermissionSelection {
    fn validate(&self) -> AppResult<()> {
        if (self.permission_profile.is_none()
            && self.approval_policy.is_none()
            && self.approvals_reviewer.is_none())
            || self.permission_profile.as_deref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 128
                    || value.trim() != value
                    || value.chars().any(char::is_control)
                    || value == ao::EXTERNAL_PERMISSION
            })
            || self
                .approval_policy
                .as_deref()
                .is_some_and(|value| !matches!(value, "on-request" | "never"))
            || self
                .approvals_reviewer
                .as_deref()
                .is_some_and(|value| !matches!(value, "user" | "auto_review"))
        {
            return Err(fail(
                "Choose at least one explicit valid native permission field",
            ));
        }
        Ok(())
    }
    fn merge(&mut self, selection: &Self) {
        if selection.permission_profile.is_some() {
            self.permission_profile = selection.permission_profile.clone();
        }
        if selection.approval_policy.is_some() {
            self.approval_policy = selection.approval_policy.clone();
        }
        if selection.approvals_reviewer.is_some() {
            self.approvals_reviewer = selection.approvals_reviewer.clone();
        }
    }
    fn apply(&self, route: &mut ao::Route) {
        if let Some(profile) = &self.permission_profile {
            route.native_permission_profile = Some(profile.clone());
            if route.harness_id == "codex-native" {
                route.permission_profile = profile.clone();
            }
        }
        if let Some(policy) = &self.approval_policy {
            route.approval_policy = Some(policy.clone());
        }
        if let Some(reviewer) = &self.approvals_reviewer {
            route.approvals_reviewer = Some(reviewer.clone());
        }
    }
}

fn mission_role(nodes: &[Node], node: &Node) -> Node {
    let mut role = node.clone();
    role.id = node
        .template_role_id
        .clone()
        .unwrap_or_else(|| node.id.clone());
    role.parents = node
        .parents
        .iter()
        .filter_map(|id| nodes.iter().find(|parent| &parent.id == id))
        .map(|parent| {
            parent
                .template_role_id
                .clone()
                .unwrap_or_else(|| parent.id.clone())
        })
        .collect();
    role.task_id.clear();
    role.clause_id = None;
    role.template_role_id = None;
    role.request_key = None;
    role.receipt = None;
    role.history.clear();
    role.state = State::Pending;
    role
}

pub fn apply(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
    team_revision: u64,
) -> AppResult<Run> {
    apply_selected(
        data,
        workspace_id,
        run_id,
        expected_revision,
        team_revision,
        None,
        None,
    )
}

#[derive(Clone, Debug, Default)]
pub struct ApplySelection {
    pub team_id: Option<String>,
    pub team_revision: Option<u64>,
    pub selected_role_ids: Option<Vec<String>>,
    pub permission_selection: Option<PermissionSelection>,
}

pub fn apply_selected(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
    team_revision: u64,
    selected_role_ids: Option<&[String]>,
    permission_selection: Option<&PermissionSelection>,
) -> AppResult<Run> {
    apply_selected_config(
        data,
        workspace_id,
        run_id,
        expected_revision,
        ApplySelection {
            team_revision: Some(team_revision),
            selected_role_ids: selected_role_ids.map(<[String]>::to_vec),
            permission_selection: permission_selection.cloned(),
            ..Default::default()
        },
    )
}

pub fn apply_selected_config(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
    selection: ApplySelection,
) -> AppResult<Run> {
    let team_revision = selection.team_revision.unwrap_or(0);
    let selected_role_ids = selection.selected_role_ids.as_deref();
    let permission_selection = selection.permission_selection.as_ref();
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO mission was not found"))?;
    let mut next = data.ao_runs[index].clone();
    if next.revision != expected_revision || next.cancelled {
        return Err(fail("AO mission revision changed"));
    }
    let single = next.execution_mode == ao::ExecutionMode::Single;
    let team = if single {
        if selection.team_id.is_some()
            || selection.team_revision.is_some()
            || selected_role_ids.is_none()
            || permission_selection.is_none()
        {
            return Err(fail(
                "Single execution permits only scoped policy selection without a reusable team",
            ));
        }
        None
    } else {
        // Without an explicit choice, applying the whole team keeps the mission's own team rather
        // than the workspace default. A scoped role/policy selection uses the current team.
        let team_id = selection.team_id.clone().or_else(|| {
            selected_role_ids
                .is_none()
                .then(|| next.team.as_ref().map(|snapshot| snapshot.id.clone()))
                .flatten()
        });
        Some(
            selected_team(
                data,
                workspace_id,
                team_id.as_deref(),
                selection
                    .team_revision
                    .ok_or_else(|| fail("Saved team revision is required"))?,
            )?
            .clone(),
        )
    };
    if selected_role_ids.is_none()
        && next
            .team
            .as_ref()
            .is_some_and(|snapshot| team.as_ref().is_some_and(|team| snapshot.id != team.id))
    {
        return Err(fail("Mission uses another team"));
    }
    if selected_role_ids.is_some() != permission_selection.is_some() {
        return Err(fail(
            "Selected roles and permission_selection must be supplied together",
        ));
    }
    if let (Some(ids), Some(selection)) = (selected_role_ids, permission_selection) {
        selection.validate()?;
        if ids.is_empty()
            || ids.len() > next.nodes.len()
            || ids.iter().enumerate().any(|(index, id)| {
                ids[..index].contains(id)
                    || !next.nodes.iter().any(|node| {
                        policy_supported_route(&node.route)
                            && node.template_role_id.as_deref().unwrap_or(&node.id) == id
                    })
            })
        {
            return Err(fail(
                "Select nonempty unique known supported mission role IDs",
            ));
        }
    }
    for node in &mut next.nodes {
        if node.state != State::Pending {
            continue;
        }
        let role_id = node.template_role_id.as_deref().unwrap_or(&node.id);
        if let (Some(ids), Some(selection)) = (selected_role_ids, permission_selection) {
            if ids.iter().any(|id| id == role_id) && node.route.harness_id == "codex-native" {
                selection.apply(&mut node.route);
            }
            continue;
        }
        let role = team.as_ref().expect("legacy team selected").nodes.iter().find(|role| role.id == role_id)
            .ok_or_else(|| fail("A queued role was removed; cancel its task or use the changed team for a new mission"))?;
        node.template_role_id = Some(role.id.clone());
        node.settings = role.settings.clone();
        node.route = role.route.clone();
        node.role = role.role.clone();
    }
    ao::validate(Some(data), &next)?;
    if let (Some(ids), Some(selection)) = (selected_role_ids, permission_selection) {
        if next.team.is_none() {
            next.team = Some(Team {
                id: format!("mission:{}", next.id),
                workspace_id: next.workspace_id.clone(),
                name: "Mission-only role policy".into(),
                revision: team_revision,
                is_default: false,
                editable_graph: false,
                worker_limit: next.worker_limit,
                max_review_rounds: next.max_review_rounds,
                nodes: next
                    .nodes
                    .iter()
                    .map(|node| mission_role(&next.nodes, node))
                    .collect(),
                permission_selections: BTreeMap::new(),
            });
        }
        let snapshot = next.team.as_mut().expect("mission snapshot created");
        for id in ids {
            if !snapshot.nodes.iter().any(|role| &role.id == id) {
                let node = next
                    .nodes
                    .iter()
                    .find(|node| node.template_role_id.as_deref().unwrap_or(&node.id) == id)
                    .expect("known role");
                let role = mission_role(&next.nodes, node);
                snapshot.nodes.push(role);
            }
            snapshot
                .permission_selections
                .entry(id.clone())
                .or_default()
                .merge(selection);
        }
        for role in &mut snapshot.nodes {
            if ids.contains(&role.id) {
                selection.apply(&mut role.route);
            }
        }
    } else {
        next.team = team;
    }
    // This API is local-UI-only. Apply explicitly authorizes queued settings; running receipts stay intact.
    if selected_role_ids.is_some() {
        next.grant = None; // A new native scope needs the normal local background grant again.
    } else if next.grant.is_some() {
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

pub fn policy_supported_route(route: &ao::Route) -> bool {
    matches!(
        route.harness_id.as_str(),
        "codex-native" | "ao:claude-code" | "ao:codex"
    )
}

fn bind_future_permission(node: &mut Node, snapshot: Option<&Team>) {
    if !policy_supported_route(&node.route) {
        return;
    }
    let role_id = node.template_role_id.as_deref().unwrap_or(&node.id);
    if let Some(selection) = snapshot.and_then(|team| team.permission_selections.get(role_id)) {
        selection.apply(&mut node.route);
    }
}

fn requeue(node: &mut Node, snapshot: Option<&Team>) -> bool {
    let previous = node.route.clone();
    if let Some(receipt) = node.receipt.take() {
        node.history.push(receipt);
    }
    if node.history.len() > ao::HISTORY_LIMIT {
        let excess = node.history.len() - ao::HISTORY_LIMIT;
        node.history.drain(..excess);
    }
    node.request_key = None;
    node.state = State::Pending;
    bind_future_permission(node, snapshot);
    node.route != previous
}

// Called only after the owned gate connection is closed, never when reopening saved work.
// A main reviewer's CHANGES_REQUIRED sends the named workers (or all) and the review chain back;
// a command approver's CHANGES_REQUIRED sends the plan back to the planner.
pub fn queue_rework(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    gate_id: &str,
    request_key: &str,
    now_ms: u64,
) -> AppResult<Option<Run>> {
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO mission was not found"))?;
    let mut next = data.ao_runs[index].clone();
    if next.execution_mode == ao::ExecutionMode::Single {
        return Ok(None);
    }
    let gate = next.nodes.iter().position(|node| {
        node.id == gate_id
            && matches!(node.role, Role::Reviewer | Role::Approver)
            && node.state == State::Held
    });
    let Some(gate) = gate else { return Ok(None) };
    let Some(receipt) = next.nodes[gate].receipt.as_ref() else {
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
    let answer = receipt.answer.clone().unwrap_or_default();
    let replan = next.nodes[gate].role == Role::Approver;
    let exhausted = if replan {
        (next.plan_rounds >= ao::MAX_PLAN_ROUNDS).then(|| format!(
            "The command approver still sends the plan back after {} rounds; a person must decide", ao::MAX_PLAN_ROUNDS))
    } else {
        (next.review_rounds >= next.max_review_rounds).then(|| {
            format!(
                "Review still requests changes after {} rework rounds; human review is required",
                next.max_review_rounds
            )
        })
    };
    if let Some(message) = exhausted {
        next.nodes[gate].receipt.as_mut().unwrap().error = Some(message);
    } else if let Err(error) = ao::grant_valid(
        data,
        &next,
        now_ms,
        &next.grant.as_ref().unwrap().executable_sha256,
    ) {
        next.nodes[gate].receipt.as_mut().unwrap().error = Some(format!("Rework held: {error}"));
    } else if replan {
        for node in next
            .nodes
            .iter_mut()
            .filter(|node| matches!(node.role, Role::Planner | Role::Approver))
        {
            if requeue(node, next.team.as_ref()) {
                next.grant = None;
            }
        }
        next.plan_rounds += 1;
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
        let targets = ao::parse_rework_targets(&answer, &next);
        for node in &mut next.nodes {
            let redo = match node.role {
                Role::Worker => targets.is_empty() || targets.contains(&node.id),
                Role::ReviewSplit | Role::SubReviewer | Role::Reviewer => true,
                Role::Planner | Role::Approver | Role::Retry => false,
            };
            if redo && requeue(node, next.team.as_ref()) {
                next.grant = None;
            }
        }
        next.review_parts.clear();
        next.review_rounds += 1;
    }
    next.revision += 1;
    data.ao_runs[index] = next.clone();
    Ok(Some(next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_models_and_saved_team_ids_do_not_substitute_or_mutate_running_work() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let mut data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),"tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"task","workspace_id":"qa","title":"Task","description":"Direct task","state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        })).unwrap();
        let route: ao::Route = serde_json::from_value(json!({"harness_id":"ao:claude-code","provider_id":"agent-orchestrator","account_id":"ao-local","model":"cpa/gpt-6-luna","permission_profile":":ao-default","native_permission_profile":":workspace","approval_policy":"on-request","approvals_reviewer":"user"})).unwrap();
        let single = |route: ao::Route| CreateSelection {
            execution_mode: Some(ao::ExecutionMode::Single),
            single_route: Some(route),
            ..Default::default()
        };
        let created = create_selected_run(
            &mut data,
            "qa",
            "one".into(),
            "task".into(),
            1,
            1,
            single(route.clone()),
        )
        .unwrap();
        assert_eq!(created.nodes.len(), 1);
        assert_eq!(created.nodes[0].route, route);
        assert!(data.ao_teams.is_empty() && created.team.is_none());
        let id = created.nodes[0].id.clone();
        let sha = "a".repeat(64);
        let granted = ao::grant_run(&mut data, "qa", "one", created.revision, &sha, 100).unwrap();
        assert_eq!(granted.grant.as_ref().unwrap().max_turns, 1);
        ao::reserve(
            &mut data,
            "qa",
            "one",
            &id,
            granted.revision,
            "request".into(),
            Some(101),
        )
        .unwrap();
        let running =
            ao::record_submission(&mut data, "qa", "one", &id, "request", Some("thread")).unwrap();
        let before = serde_json::to_value(&running.nodes[0]).unwrap();
        let staged = apply_selected_config(
            &mut data,
            "qa",
            "one",
            running.revision,
            ApplySelection {
                selected_role_ids: Some(vec![id.clone()]),
                permission_selection: Some(PermissionSelection {
                    permission_profile: Some(":danger-full-access".into()),
                    approval_policy: Some("never".into()),
                    approvals_reviewer: Some("user".into()),
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&staged.nodes[0]).unwrap(), before);
        assert!(data.ao_teams.is_empty());
        let done = ao::record_terminal(
            &mut data,
            "qa",
            "one",
            &id,
            "thread",
            Some("turn"),
            Some("Direct answer, no assignment fence"),
            true,
            None,
        )
        .unwrap();
        assert_eq!(done.nodes[0].state, State::Finished);
        assert!(
            done.assignments.is_empty()
                && !done.solo
                && done.nodes[0].receipt.as_ref().unwrap().verdict.is_none()
        );
        assert!(queue_rework(&mut data, "qa", "one", &id, "request", 102)
            .unwrap()
            .is_none());
        let mut invalid = single(route.clone());
        invalid.team_revision = Some(1);
        assert!(
            create_selected_run(&mut data, "qa", "bad".into(), "task".into(), 1, 1, invalid)
                .is_err()
        );
        assert!(create_selected_run(
            &mut data,
            "other",
            "bad".into(),
            "task".into(),
            1,
            1,
            single(route.clone())
        )
        .is_err());
        assert!(create_selected_run(
            &mut data,
            "qa",
            "bad".into(),
            "task".into(),
            99,
            1,
            single(route.clone())
        )
        .is_err());
        let mut bad_route = route;
        bad_route.model = "chatgpt-web/high".into();
        assert!(create_selected_run(
            &mut data,
            "qa",
            "bad".into(),
            "task".into(),
            1,
            1,
            single(bad_route)
        )
        .is_err());

        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let team = |id: &str| -> Team {
            serde_json::from_value(json!({"id":id,"workspace_id":"qa","name":id,"revision":0,"nodes":[
            {"id":"lead","task_id":"","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":web},
            {"id":"worker","task_id":"","role":"worker","parents":["lead"],"x":0,"y":1,"state":"pending","route":web},
            {"id":"review","task_id":"","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":web}
        ]})).unwrap()
        };
        let first = save(&mut data, "qa", 0, team("first")).unwrap();
        let second = save(&mut data, "qa", 0, team("second")).unwrap();
        assert_eq!(data.ao_teams[0], first);
        assert_eq!(data.ao_teams.len(), 2);
        let team_selection = |id: &str, revision: u64| CreateSelection {
            execution_mode: Some(ao::ExecutionMode::Team),
            team_id: Some(id.into()),
            team_revision: Some(revision),
            ..Default::default()
        };
        let selected = create_selected_run(
            &mut data,
            "qa",
            "two".into(),
            "task".into(),
            1,
            1,
            team_selection("second", second.revision),
        )
        .unwrap();
        assert_eq!(selected.nodes.len(), 3);
        assert_eq!(selected.team.as_ref().unwrap().id, "second");
        assert!(
            serde_json::to_value(&selected)
                .unwrap()
                .get("execution_mode")
                .is_none(),
            "legacy team serialization stays unchanged"
        );
        assert_eq!(selected.execution_mode, ao::ExecutionMode::Team);
        let legacy_hash = ao::graph_sha256(&data, &selected).unwrap();
        let mut explicit_team = serde_json::to_value(&selected).unwrap();
        explicit_team["execution_mode"] = json!("team");
        assert_eq!(
            legacy_hash,
            ao::graph_sha256(&data, &serde_json::from_value(explicit_team).unwrap()).unwrap()
        );
        let mut wrong_mode = created.clone();
        wrong_mode.execution_mode = ao::ExecutionMode::Team;
        assert!(
            ao::validate(Some(&data), &wrong_mode).is_err(),
            "one-node team graph cannot masquerade as Single"
        );
        let mut polluted_single = created.clone();
        polluted_single.nodes.push(polluted_single.nodes[0].clone());
        assert!(
            ao::validate(Some(&data), &polluted_single).is_err(),
            "Single cannot acquire hidden extra phases"
        );
        let mut wrong_workspace_team = team("foreign");
        wrong_workspace_team.workspace_id = "other".into();
        data.ao_teams.push(wrong_workspace_team);
        assert!(create_selected_run(
            &mut data,
            "qa",
            "bad".into(),
            "task".into(),
            1,
            1,
            team_selection("foreign", 0)
        )
        .is_err());
        assert!(create_selected_run(
            &mut data,
            "qa",
            "bad".into(),
            "task".into(),
            1,
            1,
            team_selection("deleted", 1)
        )
        .is_err());
        assert!(create_selected_run(
            &mut data,
            "qa",
            "bad".into(),
            "task".into(),
            1,
            1,
            team_selection("second", 99)
        )
        .is_err());
        let mut updated = second;
        updated.name = "Updated second".into();
        save(&mut data, "qa", 1, updated.clone()).unwrap();
        assert_eq!(data.ao_teams[0], first);
        assert!(save(&mut data, "qa", 1, updated).is_err());
        assert_eq!(
            create_run(
                &mut data,
                "qa",
                "legacy".into(),
                "task".into(),
                1,
                first.revision,
                None,
                1
            )
            .unwrap()
            .team
            .unwrap()
            .id,
            "first"
        );
    }

    #[test]
    fn explicit_single_run_is_one_node_without_a_team_or_planning_protocol() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),"tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"task","workspace_id":"qa","title":"Direct answer","description":"Explain the result","state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        })).unwrap();
        let run: Run = serde_json::from_value(json!({
            "id":"single","workspace_id":"qa","project_id":"task","revision":0,"execution_mode":"single",
            "nodes":[{"id":"only","task_id":"task","role":"planner","parents":[],"x":0,"y":0,"state":"pending",
                "route":{"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":workspace","approval_policy":"on-request","approvals_reviewer":"user"}}]
        })).unwrap();
        assert!(ao::validate(Some(&data), &run).is_ok());
        let prompt = ao::prompt_for_node(&data, &run, "only").unwrap();
        assert!(prompt.contains("Explain the result"));
        assert!(
            !prompt.contains("First judge")
                && !prompt.contains("```assignments")
                && !prompt.contains("```solo")
        );
    }

    #[test]
    fn split_keeps_its_own_permission_selection_when_reviewer_changes() {
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let node = |id: &str, role: &str| -> Node {
            serde_json::from_value(json!({"id":id,"task_id":"","role":role,"parents":[],"x":0,"y":0,"state":"pending","route":web})).unwrap()
        };
        let mut nodes = vec![
            node("lead", "planner"),
            node("worker", "worker"),
            node("review", "reviewer"),
            node("sub", "sub_reviewer"),
            node("split", "review_split"),
        ];
        nodes[4].route.permission_profile = ":workspace".into();
        nodes[4].route.native_permission_profile = Some(":workspace".into());
        nodes[4].route.approval_policy = Some("on-request".into());
        nodes[4].route.approvals_reviewer = Some("auto_review".into());
        let before = nodes[4].route.clone();
        nodes[2].route.permission_profile = ":danger-full-access".into();
        nodes[2].route.approval_policy = Some("never".into());
        normalize_roles(&mut nodes);
        assert_eq!(
            nodes[4].route, before,
            "single main reviewer change must not overwrite split policy"
        );
        nodes[4].route.permission_profile = "custom-minimal".into();
        nodes[4].route.native_permission_profile = Some("custom-minimal".into());
        let chosen = nodes[4].route.clone();
        normalize_roles(&mut nodes);
        assert_eq!(
            nodes[4].route, chosen,
            "split-only choice survives save normalization"
        );
        nodes[2].route.harness_id = "ao:codex".into();
        nodes[2].route.permission_profile = ":ao-default".into();
        normalize_roles(&mut nodes);
        assert_eq!(nodes[4].route.permission_profile, ":ao-default");
        assert_eq!(
            nodes[4].route.native_permission_profile.as_deref(),
            Some("custom-minimal")
        );
        assert_eq!(nodes[4].route.approvals_reviewer, chosen.approvals_reviewer);
        nodes[2].route = serde_json::from_value(web).unwrap();
        normalize_roles(&mut nodes);
        assert_eq!(nodes[4].route.permission_profile, "custom-minimal");
        nodes[4].route.harness_id = "ao:codex".into();
        nodes[4].route.permission_profile = ":ao-default".into();
        nodes[4].route.native_permission_profile = None;
        normalize_roles(&mut nodes);
        assert_eq!(nodes[4].route.permission_profile, ":read-only", "an external-only legacy role initializes safe new native scope, never the main reviewer's broader rights");
    }
    #[test]
    fn gemini_moves_to_claude_code_and_default_models_are_refused() {
        let node = |route: serde_json::Value| -> Node {
            serde_json::from_value(serde_json::json!({
                "id": "w", "task_id": "", "role": "worker", "parents": [], "x": 0, "y": 0,
                "state": "pending", "route": route, "settings": {"name": "Gemini worker"},
            }))
            .unwrap()
        };
        let mut nodes = vec![
            node(
                serde_json::json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
                "account_id":"shared-cpa-pool","model":"gemini-3.8-flash-high","permission_profile":":workspace"}),
            ),
            node(
                serde_json::json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
                "account_id":"shared-cpa-pool","model":"gpt-6-luna","permission_profile":":workspace"}),
            ),
        ];
        normalize_routes(&mut nodes);
        assert_eq!(nodes[0].route.harness_id, "ao:claude-code");
        assert_eq!(nodes[0].route.model, "cpa/gemini-3.8-flash-high");
        assert_eq!(nodes[0].route.provider_id, "agent-orchestrator");
        // Native Codex runs only WebGPT: every other CPA model moves to AO's Codex harness.
        assert_eq!(nodes[1].route.harness_id, "ao:codex");
        assert_eq!(nodes[1].route.model, "cpa/gpt-6-luna");
        assert_eq!(nodes[1].route.permission_profile, ":ao-default");
        assert!(require_explicit_models(&nodes).is_ok());
        nodes[1].route.model = "default".into();
        let refused = require_explicit_models(&nodes).unwrap_err().to_string();
        assert!(
            refused.contains("Gemini worker") && refused.contains("default"),
            "{refused}"
        );
    }
    use serde_json::json;

    #[test]
    fn team_presets_create_exact_ids_and_apply_the_mission_snapshot() {
        let (mut data, first) = team_fixture("first");
        let first = save(&mut data, "qa", 0, first).unwrap();
        let (_, second) = team_fixture("second");
        let mut second = save(&mut data, "qa", 0, second).unwrap();
        let run = create_run(
            &mut data,
            "qa",
            "selected".into(),
            "goal".into(),
            1,
            1,
            Some("second"),
            2,
        )
        .unwrap();
        assert_eq!(run.team.as_ref().unwrap().id, "second");
        let granted = ao::grant_run(
            &mut data,
            "qa",
            "selected",
            run.revision,
            &"a".repeat(64),
            1000,
        )
        .unwrap();
        let snapshot = serde_json::to_value(&granted).unwrap();
        let mut first_draft = first.clone();
        first_draft.name = "Default updated".into();
        save(&mut data, "qa", first.revision, first_draft).unwrap();
        assert_eq!(serde_json::to_value(&data.ao_runs[0]).unwrap(), snapshot);
        second.nodes[1].settings.instructions = "Second revision".into();
        let second = save(&mut data, "qa", second.revision, second).unwrap();
        assert_eq!(data.ao_teams[0].revision, second.revision);
        let applied = apply(
            &mut data,
            "qa",
            "selected",
            granted.revision,
            second.revision,
        )
        .unwrap();
        assert_eq!(applied.team.as_ref().unwrap().id, "second");
        assert_eq!(applied.nodes[1].settings.instructions, "Second revision");
        assert!(ao::grant_valid(&data, &applied, 1001, &"a".repeat(64)).is_ok());
        for id in ["unknown", "foreign"] {
            assert!(create_run(
                &mut data,
                "qa",
                id.into(),
                "goal".into(),
                1,
                second.revision,
                Some(id),
                2
            )
            .is_err());
        }
        data.ao_teams.push(Team {
            id: "foreign".into(),
            workspace_id: "other".into(),
            ..second.clone()
        });
        assert!(create_run(
            &mut data,
            "qa",
            "foreign".into(),
            "goal".into(),
            1,
            second.revision,
            Some("foreign"),
            2
        )
        .is_err());
        assert!(create_run(
            &mut data,
            "qa",
            "stale".into(),
            "goal".into(),
            1,
            1,
            Some("second"),
            2
        )
        .is_err());
        let mut promoted = second.clone();
        promoted.is_default = true;
        let before_promotion = serde_json::to_value(&data.ao_runs).unwrap();
        let promoted = save(&mut data, "qa", second.revision, promoted).unwrap();
        assert_eq!(
            serde_json::to_value(&data.ao_runs).unwrap(),
            before_promotion
        );
        let default = create_run(
            &mut data,
            "qa",
            "default".into(),
            "goal".into(),
            1,
            promoted.revision,
            None,
            2,
        )
        .unwrap();
        assert_eq!(default.team.unwrap().id, "second");
    }

    #[test]
    fn team_presets_legacy_unflagged_team_is_the_default() {
        let (mut data, mut legacy) = team_fixture("legacy");
        legacy.revision = 7;
        let serialized = serde_json::to_value(&legacy).unwrap();
        assert!(
            serialized.get("is_default").is_none() && serialized.get("editable_graph").is_none()
        );
        data.ao_teams
            .push(serde_json::from_value(serialized).unwrap());
        assert_eq!(default_team(&data, "qa").unwrap().id, "legacy");
        let run = create_run(
            &mut data,
            "qa",
            "legacy-run".into(),
            "goal".into(),
            1,
            7,
            None,
            2,
        )
        .unwrap();
        assert_eq!(run.team.unwrap(), legacy);
        assert!(default_team(&data, "other").is_none());
    }

    #[test]
    fn final_review_requeues_stale_planner_only_review_once_with_preserved_grant() {
        let mut data = recovery_fixture_review(true);
        let review = data.ao_runs[0].nodes[2].id.clone();
        let worker = data.ao_runs[0].nodes[1].id.clone();
        let revision = data.ao_runs[0].revision;
        ao::reserve(
            &mut data,
            "qa",
            "recovery",
            &review,
            revision,
            "old-review".into(),
            Some(1003),
        )
        .unwrap();
        ao::record_submission(
            &mut data,
            "qa",
            "recovery",
            &review,
            "old-review",
            Some("review-thread"),
        )
        .unwrap();
        let old = ao::record_terminal(
            &mut data,
            "qa",
            "recovery",
            &review,
            "review-thread",
            Some("old-review-turn"),
            Some("APPROVED old evidence"),
            true,
            None,
        )
        .unwrap();
        let fresh = control_selected(
            &mut data,
            "qa",
            "recovery",
            "review_failures",
            Some(&worker),
        )
        .unwrap();
        assert_eq!(fresh.nodes[2].state, State::Pending);
        assert_eq!(
            fresh.nodes[2].history.last().unwrap().answer.as_deref(),
            Some("APPROVED old evidence")
        );
        assert_eq!(
            fresh.nodes[3], old.nodes[3],
            "healthy running sibling is unchanged"
        );
        assert_eq!(fresh.grant, old.grant);
        assert_eq!(fresh.review_rounds, old.review_rounds + 1);
        ao::grant_valid(&data, &fresh, 1004, &"a".repeat(64)).unwrap();
        assert!(control_selected(
            &mut data,
            "qa",
            "recovery",
            "review_failures",
            Some(&worker)
        )
        .is_err());
        assert_eq!(
            data.ao_runs[0], fresh,
            "repeated handoff cannot requeue or charge twice"
        );
        assert!(ao::parents_finished(&fresh, &review));
        assert!(ao::prompt_for_node(&data, &fresh, &review)
            .unwrap()
            .contains("Partial worker output"));

        let mut exhausted = recovery_fixture_review(true);
        exhausted.ao_runs[0].nodes[2].state = State::Finished;
        exhausted.ao_runs[0].review_rounds = exhausted.ao_runs[0].max_review_rounds;
        let unchanged = exhausted.ao_runs[0].clone();
        let worker = unchanged.nodes[1].id.clone();
        assert!(control_selected(
            &mut exhausted,
            "qa",
            "recovery",
            "review_failures",
            Some(&worker)
        )
        .is_err());
        assert_eq!(
            exhausted.ao_runs[0], unchanged,
            "review budget denial is atomic"
        );
    }

    #[test]
    fn final_review_defers_in_flight_review_refresh_until_its_owned_attempt_settles() {
        let mut data = recovery_fixture_review(true);
        let review = data.ao_runs[0].nodes[2].id.clone();
        let worker = data.ao_runs[0].nodes[1].id.clone();
        let revision = data.ao_runs[0].revision;
        ao::reserve(
            &mut data,
            "qa",
            "recovery",
            &review,
            revision,
            "live-review".into(),
            Some(1003),
        )
        .unwrap();
        let active = ao::record_submission(
            &mut data,
            "qa",
            "recovery",
            &review,
            "live-review",
            Some("review-thread"),
        )
        .unwrap();
        let changed = control_selected(
            &mut data,
            "qa",
            "recovery",
            "review_failures",
            Some(&worker),
        )
        .unwrap();
        assert_eq!(changed.nodes[2], active.nodes[2]);
        assert!(changed.rerun_after.contains(&review));
        assert_eq!(changed.grant, active.grant);
        let settled = ao::record_terminal(
            &mut data,
            "qa",
            "recovery",
            &review,
            "review-thread",
            Some("stale-review-turn"),
            Some("APPROVED stale evidence"),
            true,
            None,
        )
        .unwrap();
        assert_eq!(settled.nodes[2].state, State::Pending);
        assert_eq!(settled.nodes[2].history.len(), 1);
        assert!(!settled.rerun_after.contains(&review));
        assert_eq!(settled.review_rounds, changed.review_rounds);
    }

    fn recovery_fixture() -> AppData {
        recovery_fixture_review(false)
    }

    fn recovery_fixture_review(planner_only: bool) -> AppData {
        let (mut data, mut team) = team_fixture("recovery");
        let mut sibling = team.nodes[1].clone();
        sibling.id = "healthy".into();
        team.nodes.push(sibling);
        if planner_only {
            team.editable_graph = true;
            team.nodes[2].parents = vec!["lead".into()];
        }
        let team = save(&mut data, "qa", 0, team).unwrap();
        let run = create_run(
            &mut data,
            "qa",
            "recovery".into(),
            "goal".into(),
            1,
            team.revision,
            None,
            2,
        )
        .unwrap();
        let granted = ao::grant_run(
            &mut data,
            "qa",
            "recovery",
            run.revision,
            &"a".repeat(64),
            1000,
        )
        .unwrap();
        let planner = data.ao_runs[0].nodes[0].id.clone();
        ao::reserve(
            &mut data,
            "qa",
            "recovery",
            &planner,
            granted.revision,
            "planner-attempt".into(),
            Some(1000),
        )
        .unwrap();
        ao::record_submission(
            &mut data,
            "qa",
            "recovery",
            &planner,
            "planner-attempt",
            Some("planner-session"),
        )
        .unwrap();
        let assignments: Vec<_> = data.ao_runs[0]
            .nodes
            .iter()
            .filter(|node| node.role == Role::Worker)
            .map(|node| json!({"worker":node.id,"task":"Fixture assigned work"}))
            .collect();
        let plan = format!(
            "Plan\n\u{60}\u{60}\u{60}assignments\n{}\n\u{60}\u{60}\u{60}",
            serde_json::to_string(&assignments).unwrap()
        );
        let planned = ao::record_terminal(
            &mut data,
            "qa",
            "recovery",
            &planner,
            "planner-session",
            Some("planner-turn"),
            Some(&plan),
            true,
            None,
        )
        .unwrap();
        assert_eq!(planned.nodes[0].state, State::Finished);
        let worker = data.ao_runs[0].nodes[1].id.clone();
        let healthy = data.ao_runs[0].nodes[3].id.clone();
        let reserved = ao::reserve(
            &mut data,
            "qa",
            "recovery",
            &worker,
            planned.revision,
            "failed-attempt".into(),
            Some(1001),
        )
        .unwrap();
        let held =
            ao::record_submission(&mut data, "qa", "recovery", &worker, "failed-attempt", None)
                .unwrap();
        assert!(held.revision > reserved.revision);
        data.ao_runs[0].nodes[1].receipt.as_mut().unwrap().answer =
            Some("Partial worker output".into());
        data.ao_runs[0].nodes[1].receipt.as_mut().unwrap().error = Some("auth_unavailable".into());
        let reserved = ao::reserve(
            &mut data,
            "qa",
            "recovery",
            &healthy,
            held.revision,
            "healthy-attempt".into(),
            Some(1002),
        )
        .unwrap();
        ao::record_submission(
            &mut data,
            "qa",
            "recovery",
            &healthy,
            "healthy-attempt",
            Some("healthy-session"),
        )
        .unwrap();
        assert_eq!(reserved.nodes[3].state, State::Reserved);
        data
    }

    #[test]
    fn runtime_recovery_retry_preserves_live_sibling_and_valid_grant() {
        let mut data = recovery_fixture();
        let before = data.ao_runs[0].clone();
        let mut exhausted = data.clone();
        for n in 0..2 {
            let mut receipt = exhausted.ao_runs[0].nodes[1].receipt.clone().unwrap();
            receipt.request_key = format!("previous-{n}");
            exhausted.ao_runs[0].nodes[1].history.push(receipt);
        }
        let unchanged = exhausted.ao_runs[0].clone();
        assert!(control_selected(
            &mut exhausted,
            "qa",
            "recovery",
            "retry_auto",
            Some(&before.nodes[1].id)
        )
        .is_err());
        assert_eq!(
            exhausted.ao_runs[0], unchanged,
            "exhaustion denial is atomic"
        );
        let retried = control_selected(
            &mut data,
            "qa",
            "recovery",
            "retry_auto",
            Some(&before.nodes[1].id),
        )
        .unwrap();
        assert_eq!(retried.nodes[3], before.nodes[3]);
        assert_eq!(retried.grant, before.grant);
        assert_eq!(retried.nodes[1].state, State::Pending);
        assert_eq!(
            retried.nodes[1].history.last().unwrap().answer.as_deref(),
            Some("Partial worker output")
        );
        ao::grant_valid(&data, &retried, 1003, &"a".repeat(64)).unwrap();
    }

    #[test]
    fn runtime_recovery_failure_handoff_keeps_receipts_and_blocks_worker_dependencies() {
        let mut data = recovery_fixture();
        let before = data.ao_runs[0].clone();
        let failed = control(&mut data, "qa", "recovery", "review_failures").unwrap();
        assert_eq!(
            serde_json::to_value(&failed.nodes[1].state).unwrap(),
            "failed"
        );
        assert_eq!(failed.nodes[1].receipt, before.nodes[1].receipt);
        assert_eq!(failed.nodes[1].history, before.nodes[1].history);
        assert_eq!(failed.nodes[3], before.nodes[3]);
        assert_eq!(failed.grant, before.grant);
        let mut manual_data = data.clone();
        let worker = failed.nodes[1].id.clone();
        let manual =
            control_selected(&mut manual_data, "qa", "recovery", "retry", Some(&worker)).unwrap();
        assert_eq!(
            manual.nodes[1].state,
            State::Pending,
            "explicit retry can recover terminal failed work"
        );
        assert_eq!(manual.nodes[3], before.nodes[3]);
        assert_eq!(manual.grant, before.grant);
        ao::grant_valid(&manual_data, &manual, 1003, &"a".repeat(64)).unwrap();
        assert!(
            control_selected(&mut manual_data, "qa", "recovery", "retry", Some("foreign")).is_err()
        );
        let review = failed.nodes[2].id.clone();
        let healthy = data.ao_runs[0].nodes[3].id.clone();
        ao::record_terminal(
            &mut data,
            "qa",
            "recovery",
            &healthy,
            "healthy-session",
            Some("healthy-turn"),
            Some("Healthy worker completed its assigned fixture work"),
            true,
            None,
        )
        .unwrap();
        assert!(ao::parents_finished(&data.ao_runs[0], &review));
        let prompt = ao::prompt_for_node(&data, &data.ao_runs[0], &review).unwrap();
        assert!(
            prompt.contains("auth_unavailable")
                && prompt.contains("Partial worker output")
                && prompt.contains("cannot approve")
        );
        let mut dependent = data.ao_runs[0].nodes[3].clone();
        dependent.parents = vec![failed.nodes[1].id.clone()];
        let id = dependent.id.clone();
        data.ao_runs[0].nodes[3] = dependent;
        assert!(!ao::parents_finished(&data.ao_runs[0], &id));
    }

    #[test]
    fn runtime_recovery_retry_role_is_dormant_and_optional() {
        let (mut data, mut team) = team_fixture("retry-role");
        let mut node = serde_json::to_value(&team.nodes[1]).unwrap();
        node["id"] = json!("retry");
        node["role"] = json!("retry");
        team.nodes.push(serde_json::from_value(node).unwrap());
        let team = save(&mut data, "qa", 0, team).unwrap();
        let run = create_run(
            &mut data,
            "qa",
            "retry-role".into(),
            "goal".into(),
            1,
            team.revision,
            None,
            2,
        )
        .unwrap();
        let retry_id = run.nodes[3].id.clone();
        data.ao_runs[0].nodes[0].state = State::Finished;
        assert!(!ao::parents_finished(&data.ao_runs[0], &retry_id));
        data.ao_runs[0].nodes[1].state = State::Held;
        assert!(ao::parents_finished(&data.ao_runs[0], &retry_id));
        assert_eq!(
            data.ao_runs[0].nodes[2].parents.len(),
            1,
            "review does not depend on Retry"
        );
        let mut invalid = team;
        invalid.editable_graph = true;
        invalid.nodes[2].parents.push("retry".into());
        assert!(save(&mut data, "qa", invalid.revision, invalid).is_err());
    }

    fn team_fixture(id: &str) -> (AppData, Team) {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let data = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),"tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"goal","workspace_id":"qa","title":"Preset test","description":"","state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        })).unwrap();
        let route = json!({"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let team = serde_json::from_value(json!({
            "id":id,"workspace_id":"qa","name":id,"revision":0,"nodes":[
                {"id":"lead","task_id":"","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":route},
                {"id":"worker","task_id":"","role":"worker","parents":["lead"],"x":40,"y":90,"state":"pending","route":route},
                {"id":"review","task_id":"","role":"reviewer","parents":["worker"],"x":80,"y":180,"state":"pending","route":route}
            ]
        })).unwrap();
        (data, team)
    }

    #[test]
    fn team_presets_save_independently_and_promote_one_default() {
        let (mut data, first) = team_fixture("first");
        let first = save(&mut data, "qa", 0, first).unwrap();
        let (_, mut second) = team_fixture("second");
        second.nodes[1].settings.instructions = "Independent preset".into();
        let second = save(&mut data, "qa", 0, second).unwrap();
        assert_eq!(data.ao_teams.len(), 2);
        assert_eq!(first.revision, second.revision);
        let encoded = serde_json::to_value(&data.ao_teams).unwrap();
        assert_eq!(encoded[0]["is_default"], true);
        assert!(encoded[1].get("is_default").is_none());
        assert_eq!(
            serde_json::from_value::<Vec<Team>>(encoded).unwrap(),
            data.ao_teams
        );
        let mut promoted = serde_json::to_value(&second).unwrap();
        promoted["is_default"] = json!(true);
        let promoted = save(
            &mut data,
            "qa",
            second.revision,
            serde_json::from_value(promoted).unwrap(),
        )
        .unwrap();
        assert_eq!(promoted.revision, 2);
        assert_eq!(data.ao_teams[0].revision, 2);
        assert!(save(&mut data, "qa", first.revision, first).is_err());
        let encoded = serde_json::to_value(&data.ao_teams).unwrap();
        assert!(encoded[0].get("is_default").is_none());
        assert_eq!(encoded[1]["is_default"], true);
        let (_, mut third) = team_fixture("third");
        third.revision = 1;
        assert!(save(&mut data, "qa", 1, third).is_err());
    }

    #[test]
    fn team_presets_editable_graph_preserves_links_and_rejects_cycles() {
        let (mut data, team) = team_fixture("editable");
        let mut value = serde_json::to_value(team).unwrap();
        value["editable_graph"] = json!(true);
        value["nodes"][2]["parents"] = json!(["lead"]);
        let team: Team = serde_json::from_value(value).unwrap();
        let saved = save(&mut data, "qa", 0, team).unwrap();
        assert_eq!(saved.nodes[2].parents, vec!["lead"]);
        assert_eq!((saved.nodes[1].x, saved.nodes[1].y), (40, 90));
        let mut cycle = saved.clone();
        cycle.nodes[1].parents = vec!["review".into()];
        cycle.nodes[2].parents = vec!["worker".into()];
        assert!(save(&mut data, "qa", saved.revision, cycle).is_err());
        assert_eq!(data.ao_teams[0], saved);
        let mut receipt = saved.clone();
        receipt.nodes[0].request_key = Some("already-executed".into());
        assert!(save(&mut data, "qa", saved.revision, receipt).is_err());
    }

    #[test]
    fn team_presets_refuse_foreign_ids_and_invalid_identities() {
        let (mut data, team) = team_fixture("owned");
        data.ao_teams.push(Team {
            workspace_id: "other".into(),
            ..team.clone()
        });
        assert!(save(&mut data, "qa", 0, team.clone()).is_err());
        data.ao_teams.clear();
        for id in ["", " ", "\n"] {
            let mut invalid = team.clone();
            invalid.id = id.into();
            assert!(save(&mut data, "qa", 0, invalid).is_err());
        }
        let mut foreign = team;
        foreign.workspace_id = "other".into();
        assert!(save(&mut data, "qa", 0, foreign).is_err());
    }

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
        let worker = json!({"harness_id":"ao:codex","provider_id":"agent-orchestrator","account_id":"ao-local","model":"cpa/gemini-3.8-flash-high","permission_profile":":ao-default"});
        let team: Team = serde_json::from_value(json!({"id":"team","workspace_id":"qa","name":"Product team","revision":0,"nodes":[
            {"id":"lead","task_id":"","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":web},
            {"id":"worker","task_id":"","role":"worker","parents":["lead"],"x":0,"y":1,"state":"pending","route":worker},
            {"id":"review","task_id":"","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":web}
        ]})).unwrap();
        let mut team = save(&mut data, "qa", 0, team).unwrap();
        let run = create_run(&mut data, "qa", "run".into(), "goal".into(), 1, 1, None, 2).unwrap();
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
        let mut scoped_data = data.clone();
        let before = scoped_data.ao_runs[0].clone();
        let selection = PermissionSelection {
            approval_policy: Some("on-request".into()),
            ..Default::default()
        };
        let ids = vec!["lead".into(), "review".into()];
        let scoped = apply_selected(
            &mut scoped_data,
            "qa",
            "run",
            active.revision,
            saved.revision,
            Some(&ids),
            Some(&selection),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&scoped.nodes[0]).unwrap(),
            serde_json::to_value(&before.nodes[0]).unwrap(),
            "running attempt stays exact"
        );
        assert_eq!(
            serde_json::to_value(&scoped.nodes[1]).unwrap(),
            serde_json::to_value(&before.nodes[1]).unwrap(),
            "unselected queued policy and settings stay exact"
        );
        assert_eq!(
            scoped.nodes[2].route.approval_policy.as_deref(),
            Some("on-request")
        );
        assert_eq!(
            scoped.nodes[2].route.permission_profile,
            before.nodes[2].route.permission_profile
        );
        assert_eq!(scoped.nodes[2].settings, before.nodes[2].settings);
        assert_eq!(
            serde_json::to_value(&scoped.team.as_ref().unwrap().nodes[1]).unwrap(),
            serde_json::to_value(&before.team.as_ref().unwrap().nodes[1]).unwrap()
        );
        assert!(apply_selected(
            &mut scoped_data,
            "qa",
            "run",
            scoped.revision,
            saved.revision,
            Some(&["unknown".into()]),
            Some(&selection)
        )
        .is_err());
        assert!(apply_selected(
            &mut scoped_data,
            "qa",
            "run",
            scoped.revision,
            saved.revision,
            Some(&ids),
            Some(&PermissionSelection::default())
        )
        .is_err());
        let mut helper_data = data.clone();
        helper_data.ao_teams[0].id = "different-future-team".into();
        helper_data.ao_runs[0].nodes[2].template_role_id = None;
        let helper_id = helper_data.ao_runs[0].nodes[2].id.clone();
        let helper_before = serde_json::to_value(&helper_data.ao_runs[0].nodes[2]).unwrap();
        let helper_selected = apply_selected(
            &mut helper_data,
            "qa",
            "run",
            active.revision,
            saved.revision,
            Some(&[helper_id]),
            Some(&selection),
        )
        .unwrap();
        let mut helper_expected = helper_before;
        helper_expected["route"]["approval_policy"] = json!("on-request");
        assert_eq!(serde_json::to_value(&helper_selected.nodes[2]).unwrap(), helper_expected, "mission-only role receives only explicitly selected policy despite a different future team");
        assert_eq!(
            helper_selected.team.as_ref().unwrap().id,
            before.team.as_ref().unwrap().id
        );
        let mut deferred_data = data.clone();
        deferred_data.ao_runs[0].nodes[0].route.permission_profile = ":workspace".into();
        deferred_data.ao_runs[0].nodes[0]
            .receipt
            .as_mut()
            .unwrap()
            .route
            .permission_profile = ":workspace".into();
        deferred_data.ao_runs[0].team.as_mut().unwrap().nodes[0]
            .route
            .approval_policy = Some("never".into());
        let running_before = serde_json::to_value(&deferred_data.ao_runs[0].nodes[0]).unwrap();
        let narrow = PermissionSelection {
            permission_profile: Some(":read-only".into()),
            ..Default::default()
        };
        let staged = apply_selected(
            &mut deferred_data,
            "qa",
            "run",
            active.revision,
            saved.revision,
            Some(&["lead".into()]),
            Some(&narrow),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&staged.nodes[0]).unwrap(),
            running_before
        );
        assert!(staged.grant.is_none());
        deferred_data.ao_runs[0].nodes[0].state = State::Held;
        let retried = control(&mut deferred_data, "qa", "run", "retry").unwrap();
        assert_eq!(retried.nodes[0].route.permission_profile, ":read-only");
        assert_eq!(
            retried.nodes[0].route.approval_policy, None,
            "omitted field is not copied from a differing historical snapshot"
        );
        assert_eq!(
            retried.nodes[0]
                .history
                .last()
                .unwrap()
                .route
                .permission_profile,
            ":workspace"
        );
        let mut finished = staged.nodes[0].clone();
        finished.state = State::Finished;
        assert!(requeue(&mut finished, staged.team.as_ref()));
        assert_eq!(finished.route.permission_profile, ":read-only");

        let mut legacy_helper = data.clone();
        legacy_helper.ao_runs[0].team = None;
        legacy_helper.ao_runs[0].nodes[0].template_role_id = None;
        legacy_helper.ao_runs[0].nodes[0].route.permission_profile = ":workspace".into();
        legacy_helper.ao_runs[0].nodes[0]
            .receipt
            .as_mut()
            .unwrap()
            .route
            .permission_profile = ":workspace".into();
        let reusable_before = serde_json::to_value(&legacy_helper.ao_teams).unwrap();
        let helper_id = legacy_helper.ao_runs[0].nodes[0].id.clone();
        let staged = apply_selected(
            &mut legacy_helper,
            "qa",
            "run",
            active.revision,
            saved.revision,
            Some(std::slice::from_ref(&helper_id)),
            Some(&narrow),
        )
        .unwrap();
        assert_eq!(
            staged.team.as_ref().unwrap().nodes.len(),
            staged.nodes.len()
        );
        assert!(staged
            .team
            .as_ref()
            .unwrap()
            .permission_selections
            .contains_key(&helper_id));
        assert_eq!(
            serde_json::to_value(&legacy_helper.ao_teams).unwrap(),
            reusable_before,
            "no reusable helper role is created"
        );
        legacy_helper.ao_runs[0].nodes[0].state = State::Held;
        assert_eq!(
            control(&mut legacy_helper, "qa", "run", "retry")
                .unwrap()
                .nodes[0]
                .route
                .permission_profile,
            ":read-only"
        );
        assert!(save(
            &mut legacy_helper,
            "qa",
            saved.revision,
            staged.team.unwrap()
        )
        .unwrap_err()
        .to_string()
        .contains("Mission-only"));
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

        let plan = |run: &Run| {
            format!(
                "Plan
```assignments
[{{\"worker\":\"{}\",\"task\":\"Build it\"}}]
```",
                run.nodes
                    .iter()
                    .find(|node| node.role == Role::Worker)
                    .unwrap()
                    .id
            )
        };
        let first_plan = plan(&data.ao_runs[0]);
        ao::record_terminal(
            &mut data,
            "qa",
            "run",
            &planner,
            "native-thread",
            Some("plan-turn"),
            Some(&first_plan),
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
        let second = create_run(
            &mut data,
            "qa",
            "run-two".into(),
            "goal".into(),
            1,
            2,
            None,
            3,
        )
        .unwrap();
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
        let second_plan = plan(data.ao_runs.iter().find(|run| run.id == "run-two").unwrap());
        let second = ao::record_terminal(
            &mut data,
            "qa",
            "run-two",
            &second_planner,
            "thread-two",
            Some("turn-two"),
            Some(&second_plan),
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
        create_run(&mut data, "qa", "run".into(), "goal".into(), 1, 1, None, 2).unwrap();
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

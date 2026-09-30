//! AO mission graph and execution reservations. Task text stays in the workflow board.
use crate::{
    data::AppData,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn fail(message: &str) -> AppError {
    AppError::Message(message.into())
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Planner,
    Worker,
    Reviewer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Reserved,
    Running,
    Finished,
    Held,
    Cancelled,
    Archived,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub harness_id: String,
    pub provider_id: String,
    pub account_id: String,
    pub model: String,
    pub permission_profile: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_key: String,
    pub status: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub answer: Option<String>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub settings: Option<super::ao_team::RoleSettings>,
    pub route: Route,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub clause_id: Option<String>,
    pub role: Role,
    #[serde(default)]
    pub parents: Vec<String>,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub positioned: bool,
    #[serde(default)]
    pub settings: super::ao_team::RoleSettings,
    #[serde(default)]
    pub template_role_id: Option<String>,
    pub state: State,
    pub route: Route,
    #[serde(default)]
    pub request_key: Option<String>,
    #[serde(default)]
    pub receipt: Option<Receipt>,
    #[serde(default)]
    pub history: Vec<Receipt>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub revision: u64,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub paused: bool,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub grant: Option<RunGrant>,
    #[serde(default)]
    pub team: Option<super::ao_team::Team>,
    #[serde(default = "super::ao_team::default_worker_limit")]
    pub worker_limit: u8,
    #[serde(default)]
    pub review_rounds: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunGrant {
    pub graph_sha256: String,
    pub executable_sha256: String,
    pub granted_at_ms: u64,
    pub expires_at_ms: u64,
    pub max_turns: u8,
    pub turns_started: u8,
}

/// Workers may run on an upstream AO harness (`ao:<agent>`) instead of native Codex.
/// Such a card is dispatched as an AO worker session; its answer returns as the receipt.
pub const EXTERNAL_PROVIDER: &str = "agent-orchestrator";
pub const EXTERNAL_ACCOUNT: &str = "ao-local";
pub const EXTERNAL_PERMISSION: &str = ":ao-default";

pub fn external_harness(route: &Route) -> Option<&str> {
    route.harness_id.strip_prefix("ao:").filter(|agent| {
        (1..=40).contains(&agent.len())
            && agent.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// The automatic tiers the WebGPT bridge serves (runtime-web chatgpt-web-models.ts); the
/// bridge itself falls back to a lower tier when the account lacks the chosen one.
pub(crate) const WEB_TIERS: &[&str] = &["light", "medium", "high", "extra-high", "pro", "luna", "think"];

/// WebGPT-on-Codex at any tier the bridge serves.
fn web_route_valid(route: &Route) -> bool {
    route.harness_id == "codex-native"
        && route.provider_id == "chatgpt-web"
        && route
            .model
            .strip_prefix("chatgpt-web/")
            .is_some_and(|tier| WEB_TIERS.contains(&tier))
}

/// Any model in the shared CPA pool, run by Native Codex.
fn cpa_route_valid(route: &Route) -> bool {
    route.harness_id == "codex-native"
        && route.provider_id == "cliproxyapi-antigravity"
        && route.account_id == "shared-cpa-pool"
        && (1..=128).contains(&route.model.len())
}

fn external_route_valid(route: &Route) -> bool {
    external_harness(route).is_some()
        && route.provider_id == EXTERNAL_PROVIDER
        && route.account_id == EXTERNAL_ACCOUNT
        && route.permission_profile == EXTERNAL_PERMISSION
}

fn sha256_text(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn graph_sha256(data: &AppData, run: &Run) -> AppResult<String> {
    let profile = data
        .profiles
        .iter()
        .find(|profile| profile.id == run.workspace_id)
        .ok_or_else(|| fail("AO workspace changed after run grant"))?;
    let workspace_root =
        std::fs::canonicalize(&profile.path).map_err(|_| fail("AO workspace path unavailable"))?;
    let mut nodes = Vec::with_capacity(run.nodes.len());
    for node in &run.nodes {
        let task = data
            .control_board
            .tasks
            .iter()
            .find(|task| task.id == node.task_id && task.workspace_id == run.workspace_id)
            .ok_or_else(|| fail("AO task changed after run grant"))?;
        let clause = match node.clause_id.as_ref() {
            Some(id) => Some(
                task.clauses
                    .iter()
                    .find(|clause| &clause.id == id)
                    .ok_or_else(|| fail("AO clause changed after run grant"))?,
            ),
            None => None,
        };
        let clause =
            clause.map(|clause| serde_json::json!({"title":clause.title,"detail":clause.detail}));
        nodes.push(serde_json::json!({
            "id":node.id,"task_id":node.task_id,"clause_id":node.clause_id,
            "role":node.role,"parents":node.parents,"route":node.route,
            "settings":node.settings,"template_role_id":node.template_role_id,
            "task_title":task.title,"task_description":task.description,"clause":clause,
        }));
    }
    let scope = serde_json::json!({"run_id":run.id,"workspace_id":run.workspace_id,
        "workspace_root":workspace_root,"project_id":run.project_id,"nodes":nodes});
    let bytes = serde_json::to_vec(&scope).map_err(|_| fail("AO grant scope is unavailable"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodePosition {
    pub node_id: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum GraphChange {
    AddWorker {
        node: Node,
    },
    MoveNode {
        node_id: String,
        x: i32,
        y: i32,
    },
    MoveNodes {
        positions: Vec<NodePosition>,
    },
    SetParents {
        node_id: String,
        parents: Vec<String>,
    },
}

pub(super) fn validate(data: Option<&AppData>, run: &Run) -> AppResult<()> {
    if !text(&run.id, 80)
        || !text(&run.workspace_id, 128)
        || !text(&run.project_id, 128)
        || !(3..=24).contains(&run.nodes.len())
        || !(1..=24).contains(&run.worker_limit)
        || run.review_rounds > 2
    {
        return Err(fail("Invalid AO run identity or size"));
    }
    let mut ids = HashSet::new();
    let mut planner = None;
    let mut reviewer = None;
    let mut workers = Vec::new();
    for node in &run.nodes {
        if !text(&node.id, 80)
            || !ids.insert(node.id.as_str())
            || (data.is_some() && !text(&node.task_id, 128))
            || !(-10_000..=10_000).contains(&node.x)
            || !(-10_000..=10_000).contains(&node.y)
            || node.parents.len() > 24
            || ![
                &node.route.harness_id,
                &node.route.provider_id,
                &node.route.account_id,
                &node.route.model,
                &node.route.permission_profile,
            ]
            .iter()
            .all(|value| text(value, 128))
        {
            return Err(fail("Invalid AO node or route"));
        }
        node.settings.validate()?;
        if node.history.len() > 2 { return Err(fail("AO attempt history exceeds two rework rounds")); }
        if node.template_role_id.as_deref().is_some_and(|id| !text(id, 80)) { return Err(fail("Invalid reusable role identity")); }
        if node.clause_id.as_deref().is_some_and(|id| !text(id, 128)) {
            return Err(fail("Invalid AO clause identity"));
        }
        if let Some(receipt) = &node.receipt {
            if node.request_key.as_deref() != Some(receipt.request_key.as_str())
                || receipt.route != node.route
                || !matches!(
                    receipt.status.as_str(),
                    "reserved" | "submitted" | "held" | "completed"
                )
                || receipt
                    .answer
                    .as_ref()
                    .is_some_and(|answer| answer.len() > 12_000)
                || receipt
                    .verdict
                    .as_deref()
                    .is_some_and(|verdict| !matches!(verdict, "APPROVED" | "CHANGES_REQUIRED"))
            {
                return Err(fail("Invalid AO receipt"));
            }
        }
        if let Some(data) = data {
        let task = data
            .control_board
            .tasks
            .iter()
            .find(|task| task.id == node.task_id && task.workspace_id == run.workspace_id)
            .ok_or_else(|| fail("AO task is outside this workspace"))?;
        if node
            .clause_id
            .as_ref()
            .is_some_and(|id| !task.clauses.iter().any(|clause| &clause.id == id))
        {
            return Err(fail("AO clause is outside the selected task"));
        }
        }
        match node.role {
            Role::Planner => {
                if planner.replace(node.id.as_str()).is_some() || !node.parents.is_empty() {
                    return Err(fail("AO requires one root planner"));
                }
            }
            Role::Worker => {
                // Workers may run on any route; a WebGPT worker must use the bridge on Native Codex.
                if (node.route.provider_id == "chatgpt-web"
                    || node.route.model.starts_with("chatgpt-web/"))
                    && !web_route_valid(&node.route)
                {
                    return Err(fail("AO WebGPT worker requires a WebGPT-on-Codex route"));
                }
                if node.route.harness_id.starts_with("ao:") && !external_route_valid(&node.route) {
                    return Err(fail("AO harness worker route is invalid"));
                }
                workers.push(node.id.as_str());
            }
            Role::Reviewer => {
                if reviewer.replace(node.id.as_str()).is_some() {
                    return Err(fail("AO requires one reviewer"));
                }
            }
        }
    }
    let (Some(planner), Some(reviewer)) = (planner, reviewer) else {
        return Err(fail("AO requires a planner and reviewer"));
    };
    if workers.is_empty() {
        return Err(fail("AO requires at least one worker"));
    }
    let by_id: HashMap<&str, &Node> = run
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    for node in &run.nodes {
        let mut parents = HashSet::new();
        if node.parents.iter().any(|parent| {
            !parents.insert(parent.as_str())
                || parent == &node.id
                || !by_id.contains_key(parent.as_str())
        }) {
            return Err(fail("AO has a duplicate, self, or foreign dependency"));
        }
        if node.role == Role::Worker && !node.parents.iter().any(|parent| parent == planner) {
            return Err(fail("AO worker must depend on its planner"));
        }
        if node.id == reviewer
            && workers
                .iter()
                .any(|worker| !node.parents.iter().any(|parent| parent == worker))
        {
            return Err(fail("AO reviewer must depend on every worker"));
        }
        // The run loop drives external harnesses only as workers, so the orchestrator and
        // reviewer stay on Native Codex, with any WebGPT tier or any CPA model.
        if matches!(node.role, Role::Planner | Role::Reviewer)
            && !web_route_valid(&node.route)
            && !cpa_route_valid(&node.route)
        {
            return Err(fail(
                "AO planner and reviewer run on Native Codex with WebGPT or a CPA model",
            ));
        }
    }
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a Node>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visited.contains(id) {
            return true;
        }
        if !visiting.insert(id) {
            return false;
        }
        let valid = by_id[id]
            .parents
            .iter()
            .all(|parent| visit(parent, by_id, visiting, visited));
        visiting.remove(id);
        if valid {
            visited.insert(id);
        }
        valid
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    if !run
        .nodes
        .iter()
        .all(|node| visit(&node.id, &by_id, &mut visiting, &mut visited))
    {
        return Err(fail("AO dependency graph contains a cycle"));
    }
    Ok(())
}

pub fn parents_finished(run: &Run, node_id: &str) -> bool {
    let Some(node) = run.nodes.iter().find(|node| node.id == node_id) else {
        return false;
    };
    !node.parents.is_empty()
        && node.parents.iter().all(|parent| {
            run.nodes
                .iter()
                .any(|candidate| candidate.id == *parent && candidate.state == State::Finished)
        })
}

pub fn grant_valid(
    data: &AppData,
    run: &Run,
    now_ms: u64,
    executable_sha256: &str,
) -> AppResult<()> {
    let grant = run
        .grant
        .as_ref()
        .ok_or_else(|| fail("AO run has no background grant"))?;
    if run.cancelled
        || !sha256_text(executable_sha256)
        || grant.executable_sha256 != executable_sha256
        || grant.graph_sha256 != graph_sha256(data, run)?
        || grant.max_turns == 0
        || grant.max_turns > 72
        || grant.max_turns as usize > run.nodes.len() * 3
        || grant
            .expires_at_ms
            .checked_sub(grant.granted_at_ms)
            .is_none_or(|span| span > 60 * 60 * 1000)
        || now_ms < grant.granted_at_ms
        || now_ms >= grant.expires_at_ms
        || grant.turns_started >= grant.max_turns
    {
        return Err(fail("AO background run grant expired or changed"));
    }
    Ok(())
}

pub fn grant_run(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
    executable_sha256: &str,
    now_ms: u64,
) -> AppResult<Run> {
    if !sha256_text(executable_sha256) || now_ms == 0 {
        return Err(fail("AO executable identity is invalid"));
    }
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    let run = &data.ao_runs[index];
    if run.cancelled || run.paused
        || run.revision != expected_revision
        || run
            .nodes
            .iter()
            .any(|node| !matches!(node.state, State::Pending | State::Finished))
    {
        return Err(fail("AO run changed or has unresolved execution"));
    }
    let pending = run
        .nodes
        .iter()
        .filter(|node| node.state == State::Pending)
        .count();
    if pending == 0 || pending > 24 {
        return Err(fail("AO run has no bounded pending turns"));
    }
    let fingerprint = graph_sha256(data, run)?;
    let remaining_reworks = 2usize.saturating_sub(usize::from(run.review_rounds));
    let max_turns: usize = run.nodes.iter().map(|node| match (&node.role, &node.state) {
        (Role::Planner, State::Pending) => 1,
        (Role::Planner, _) | (Role::Reviewer, State::Finished) => 0,
        (_, State::Pending) => 1 + remaining_reworks,
        _ => remaining_reworks,
    }).sum();
    let run = &mut data.ao_runs[index];
    run.grant = Some(RunGrant {
        graph_sha256: fingerprint,
        executable_sha256: executable_sha256.into(),
        granted_at_ms: now_ms,
        expires_at_ms: now_ms.saturating_add(60 * 60 * 1000),
        max_turns: max_turns as u8,
        turns_started: 0,
    });
    run.revision += 1;
    Ok(run.clone())
}

pub fn prompt_for_node(data: &AppData, run: &Run, node_id: &str) -> AppResult<String> {
    let node = run
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .ok_or_else(|| fail("AO node not found"))?;
    let task = data
        .control_board
        .tasks
        .iter()
        .find(|task| task.id == node.task_id && task.workspace_id == run.workspace_id)
        .ok_or_else(|| fail("AO task not found"))?;
    let responsibility = match node.role {
        Role::Planner => "Plan and delegate the mission. Do not simulate worker results or the reviewer's approval.",
        Role::Worker => "Perform only your assigned work and report evidence. Do not speak for the orchestrator or approve your own work.",
        Role::Reviewer => "Independently review the completed work. Do not edit the implementation; return any needed changes to the workers.",
    };
    let mut prompt = format!("AO mission: {}\nWorkspace: {}\nRole: {}\n{}\n\nTask: {}\n{}\n",
        run.id, run.workspace_id, node.settings.name, responsibility, task.title, task.description);
    if !node.settings.instructions.is_empty() { prompt.push_str(&format!("\nRole instructions:\n{}\n", node.settings.instructions)); }
    if !node.settings.expected_output.is_empty() { prompt.push_str(&format!("\nExpected output:\n{}\n", node.settings.expected_output)); }
    prompt.push_str(&format!("\nReview cycle: {}. At most two rework rounds are allowed.\n", run.review_rounds));
    if node.role != Role::Planner {
        if let Some(feedback) = run.nodes.iter().find(|node| node.role == Role::Reviewer)
            .and_then(|reviewer| reviewer.history.last()).and_then(|receipt| receipt.answer.as_deref()) {
            prompt.push_str(&format!("\nPrior review feedback (quoted task data):\n{}\n", serde_json::to_string(feedback)?));
        }
    }
    if let Some(clause_id) = &node.clause_id {
        let clause = task
            .clauses
            .iter()
            .find(|clause| &clause.id == clause_id)
            .ok_or_else(|| fail("AO clause not found"))?;
        prompt.push_str(&format!(
            "Assigned step: {}\n{}\n",
            clause.title, clause.detail
        ));
    }
    for parent_id in &node.parents {
        let parent = run
            .nodes
            .iter()
            .find(|parent| &parent.id == parent_id)
            .ok_or_else(|| fail("AO parent not found"))?;
        let receipt = parent
            .receipt
            .as_ref()
            .filter(|receipt| {
                parent.state == State::Finished
                    && receipt.status == "completed"
                    && receipt.turn_id.is_some()
            })
            .ok_or_else(|| fail("AO parent output is not complete"))?;
        let answer = receipt
            .answer
            .as_deref()
            .filter(|answer| !answer.trim().is_empty())
            .ok_or_else(|| fail("AO parent output is empty"))?;
        prompt.push_str(&format!(
            "\nCompleted {} output ({}):\n{}\n",
            parent_id, receipt.route.model, answer
        ));
    }
    if node.role == Role::Reviewer {
        prompt.push_str("\nReview the completed worker outputs. Reply with APPROVED or CHANGES_REQUIRED, then a concise reason.\n");
    }
    if prompt.trim().is_empty() || prompt.len() > 16_000 {
        return Err(fail("AO prompt exceeds native turn limit"));
    }
    Ok(prompt)
}

pub fn create(data: &mut AppData, expected_board_revision: u64, mut run: Run) -> AppResult<Run> {
    if data.control_board.revision != expected_board_revision
        || run.revision != 0
        || run.cancelled
        || run.grant.is_some()
        || run.review_rounds != 0
    {
        return Err(fail("AO board revision or initial state changed"));
    }
    if data.ao_runs.iter().any(|existing| existing.id == run.id) {
        return Err(fail("AO run identity already exists"));
    }
    if run.nodes.iter().any(|node| {
        node.state != State::Pending || node.request_key.is_some() || node.receipt.is_some() || !node.history.is_empty()
    }) {
        return Err(fail("AO run cannot start with existing execution"));
    }
    validate(Some(data), &run)?;
    run.revision = 1;
    data.ao_runs.push(run.clone());
    Ok(run)
}

pub fn update_graph(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
    change: GraphChange,
) -> AppResult<Run> {
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    let mut next = data.ao_runs[index].clone();
    let layout_only = matches!(&change, GraphChange::MoveNode { .. } | GraphChange::MoveNodes { .. });
    let policy_intact = next.grant.as_ref().is_some_and(|grant| graph_sha256(data, &next).ok().as_ref() == Some(&grant.graph_sha256));
    let mut same_scope = true;
    let mut extra_turns = 0;
    if next.revision != expected_revision || (next.cancelled && !layout_only) {
        return Err(fail("AO run revision changed or run cancelled"));
    }
    match change {
        GraphChange::AddWorker { mut node } => {
            if node.role != Role::Worker
                || node.state != State::Pending
                || node.request_key.is_some()
                || node.receipt.is_some()
                || !node.history.is_empty()
                || next.nodes.len() >= 24
                || next.nodes.iter().any(|existing| existing.id == node.id)
            {
                return Err(fail("AO worker card is invalid or already exists"));
            }
            same_scope = next.nodes.iter().any(|existing| existing.role == Role::Worker && existing.route == node.route);
            extra_turns = 1 + 2u8.saturating_sub(next.review_rounds);
            super::ao_team::attach_worker_role(&mut next, &mut node);
            let reviewer = next
                .nodes
                .iter_mut()
                .find(|existing| existing.role == Role::Reviewer)
                .ok_or_else(|| fail("AO reviewer is missing"))?;
            if reviewer.state != State::Pending {
                return Err(fail("AO review has already started"));
            }
            reviewer.parents.push(node.id.clone());
            next.nodes.push(node);
        }
        GraphChange::MoveNode { node_id, x, y } => {
            let node = next
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .ok_or_else(|| fail("AO node not found"))?;
            node.x = x;
            node.y = y;
            node.positioned = true;
        }
        GraphChange::MoveNodes { positions } => {
            let mut ids = HashSet::new();
            if positions.is_empty() || positions.len() > 24 {
                return Err(fail("Select between one and 24 AO cards"));
            }
            for position in positions {
                if !ids.insert(position.node_id.clone()) {
                    return Err(fail("Duplicate AO card in layout change"));
                }
                let node = next.nodes.iter_mut().find(|node| node.id == position.node_id)
                    .ok_or_else(|| fail("AO node not found"))?;
                node.x = position.x;
                node.y = position.y;
                node.positioned = true;
            }
        }
        GraphChange::SetParents { node_id, parents } => {
            let node = next
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .ok_or_else(|| fail("AO node not found"))?;
            if node.state != State::Pending {
                return Err(fail("Active AO node cannot be rewired"));
            }
            node.parents = parents;
        }
    }
    validate(Some(data), &next)?;
    // Coordinates are presentation, not an expansion of the execution grant.
    if !layout_only {
        if policy_intact && same_scope {
            let fingerprint = graph_sha256(data, &next)?;
            let grant = next.grant.as_mut().unwrap();
            grant.graph_sha256 = fingerprint;
            grant.max_turns = grant.max_turns.saturating_add(extra_turns);
        } else { next.grant = None; }
    }
    next.revision += 1;
    data.ao_runs[index] = next.clone();
    Ok(next)
}

pub fn reserve(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    node_id: &str,
    expected_revision: u64,
    request_key: String,
    grant_now_ms: Option<u64>,
) -> AppResult<Run> {
    if !text(&request_key, 128) {
        return Err(fail("AO request key is invalid"));
    }
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    if let Some(now_ms) = grant_now_ms {
        let executable = data.ao_runs[index]
            .grant
            .as_ref()
            .ok_or_else(|| fail("AO background grant is missing"))?
            .executable_sha256
            .clone();
        grant_valid(data, &data.ao_runs[index], now_ms, &executable)?;
    }
    let worker_capacity = super::ao_team::available_workers(data, &data.ao_runs[index]);
    let run = &mut data.ao_runs[index];
    if run.cancelled || run.paused
        || run.revision != expected_revision
        || !parents_finished(run, node_id)
            && run
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .is_none_or(|node| node.role != Role::Planner)
    {
        return Err(fail("AO node is not ready or run revision changed"));
    }
    if run
        .nodes
        .iter()
        .any(|node| node.request_key.as_deref() == Some(&request_key) || node.history.iter().any(|receipt| receipt.request_key == request_key))
    {
        return Err(fail("AO request key already belongs to a node"));
    }
    let node = run
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id && node.state == State::Pending)
        .ok_or_else(|| fail("AO node is not pending"))?;
    if node.role == Role::Worker && worker_capacity == 0 {
        return Err(fail("AO_WORKER_CAPACITY_BUSY"));
    }
    node.state = State::Reserved;
    node.request_key = Some(request_key.clone());
    node.receipt = Some(Receipt {
        request_key,
        status: "reserved".into(),
        error: None,
        settings: Some(node.settings.clone()),
        thread_id: None,
        turn_id: None,
        answer: None,
        verdict: None,
        route: node.route.clone(),
    });
    if grant_now_ms.is_some() {
        run.grant.as_mut().unwrap().turns_started += 1;
    }
    run.revision += 1;
    Ok(run.clone())
}

pub fn record_submission(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    node_id: &str,
    request_key: &str,
    thread_id: Option<&str>,
) -> AppResult<Run> {
    let run = data
        .ao_runs
        .iter_mut()
        .find(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    let node = run
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id && node.state == State::Reserved)
        .ok_or_else(|| fail("AO node is not reserved"))?;
    let receipt = node
        .receipt
        .as_mut()
        .filter(|receipt| receipt.request_key == request_key && receipt.status == "reserved")
        .ok_or_else(|| fail("AO reservation changed"))?;
    if let Some(id) = thread_id {
        if !text(id, 128) || id.contains('/') {
            return Err(fail("Invalid native thread ID"));
        }
        receipt.thread_id = Some(id.into());
        receipt.status = "submitted".into();
        node.state = State::Running;
    } else {
        receipt.status = "held".into();
        receipt.error = Some("Native launch failed before a thread was returned".into());
        node.state = State::Held;
    }
    run.revision += 1;
    Ok(run.clone())
}

pub fn record_terminal(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    node_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    answer: Option<&str>,
    completed: bool,
    failure: Option<&str>,
) -> AppResult<Run> {
    let run = data
        .ao_runs
        .iter_mut()
        .find(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    let node = run
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id && node.state == State::Running)
        .ok_or_else(|| fail("AO node is not running"))?;
    let receipt = node
        .receipt
        .as_mut()
        .filter(|receipt| {
            receipt.status == "submitted" && receipt.thread_id.as_deref() == Some(thread_id)
        })
        .ok_or_else(|| fail("AO native thread identity changed"))?;
    let verdict = if node.role == Role::Reviewer {
        answer
            .and_then(|answer| {
                answer
                    .trim_start()
                    .split_whitespace()
                    .next()
                    .map(|word| word.trim_matches(['*', '`', ':']))
            })
            .and_then(|word| match word {
                "APPROVED" => Some("APPROVED"),
                "CHANGES_REQUIRED" | "CHANGES\\_REQUIRED" => Some("CHANGES_REQUIRED"),
                _ => None,
            })
    } else {
        None
    };
    receipt.turn_id = turn_id.filter(|id| text(id, 128) && !id.contains('/')).map(str::to_owned);
    if completed
        && !failure.is_some_and(|message| message.starts_with("Native approval declined"))
        && turn_id.is_some_and(|id| text(id, 128) && !id.contains('/'))
        && answer.is_some_and(|value| !value.trim().is_empty() && value.len() <= 12_000)
        && (node.role != Role::Reviewer || verdict == Some("APPROVED"))
    {
        receipt.turn_id = turn_id.map(str::to_owned);
        receipt.answer = answer.map(str::to_owned);
        receipt.verdict = verdict.map(str::to_owned);
        receipt.status = "completed".into();
        node.state = State::Finished;
    } else {
        if answer.is_some_and(|value| !value.trim().is_empty() && value.len() <= 12_000)
        {
            receipt.answer = answer.map(str::to_owned);
            receipt.verdict = verdict.map(str::to_owned);
        }
        receipt.status = "held".into();
        let mut error = failure.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| {
            if verdict == Some("CHANGES_REQUIRED") { "Reviewer requested changes" }
            else if completed { "Native turn returned no verifiable final answer" }
            else { "Native turn failed before a final answer" }
        }).to_owned();
        crate::tools::history::redact_text(&mut error);
        receipt.error = Some(error.chars().take(2048).collect());
        node.state = State::Held;
    }
    run.revision += 1;
    Ok(run.clone())
}

pub fn cancel(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
) -> AppResult<Run> {
    let run = data
        .ao_runs
        .iter_mut()
        .find(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    if run.revision != expected_revision {
        return Err(fail("AO run revision changed"));
    }
    run.cancelled = true;
    run.grant = None;
    for node in &mut run.nodes {
        if node.state == State::Pending {
            node.state = State::Cancelled;
        }
    }
    run.revision += 1;
    Ok(run.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ao_role_settings_survive_mission_serialization() {
        let node: Node = serde_json::from_value(json!({
            "id":"backend", "task_id":"task", "role":"worker", "parents":["planner"],
            "x":0,"y":1,"state":"pending", "route":{"harness_id":"codex-native",
                "provider_id":"cliproxyapi-antigravity","account_id":"shared-cpa-pool",
                "model":"gemini-3.8-flash-high","permission_profile":":read-only"},
            "settings":{"name":"Backend", "specialty":"implementation", "instructions":"Inspect the assigned API only.",
                "expected_output":"A concise proposal with evidence", "working_directory":"src", "revision":1},
            "template_role_id":"backend"
        })).expect("reusable role settings must be retained");
        let stored = serde_json::to_value(node).unwrap();
        assert_eq!(stored["settings"]["name"], "Backend");
        assert_eq!(stored["settings"]["working_directory"], "src");
        assert_eq!(stored["template_role_id"], "backend");
    }

    #[test]
    fn ao_harness_workers_need_the_exact_external_route() {
        let route = |harness: &str, provider: &str, permission: &str| -> Route {
            serde_json::from_value(json!({"harness_id":harness,"provider_id":provider,
                "account_id":EXTERNAL_ACCOUNT,"model":"default","permission_profile":permission})).unwrap()
        };
        assert_eq!(external_harness(&route("ao:claude-code", EXTERNAL_PROVIDER, EXTERNAL_PERMISSION)), Some("claude-code"));
        assert!(external_route_valid(&route("ao:opencode", EXTERNAL_PROVIDER, EXTERNAL_PERMISSION)));
        for bad in [
            route("ao:", EXTERNAL_PROVIDER, EXTERNAL_PERMISSION),
            route("ao:Claude", EXTERNAL_PROVIDER, EXTERNAL_PERMISSION),
            route("ao:../x", EXTERNAL_PROVIDER, EXTERNAL_PERMISSION),
            route("ao:codex", "cliproxyapi-antigravity", EXTERNAL_PERMISSION),
            route("ao:codex", EXTERNAL_PROVIDER, ":read-only"),
            route("codex-native", EXTERNAL_PROVIDER, EXTERNAL_PERMISSION),
        ] {
            assert!(!external_route_valid(&bad));
        }
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let run = |worker: serde_json::Value| -> Run {
            serde_json::from_value(json!({"id":"run","workspace_id":"qa","project_id":"p","revision":0,"nodes":[
                {"id":"planner","task_id":"t","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":web},
                {"id":"worker","task_id":"t","role":"worker","parents":["planner"],"x":0,"y":1,"state":"pending","route":worker},
                {"id":"reviewer","task_id":"t","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":web}
            ]})).unwrap()
        };
        assert!(validate(None, &run(json!({"harness_id":"ao:claude-code","provider_id":EXTERNAL_PROVIDER,
            "account_id":EXTERNAL_ACCOUNT,"model":"default","permission_profile":EXTERNAL_PERMISSION}))).is_ok());
        assert!(validate(None, &run(json!({"harness_id":"ao:claude-code","provider_id":"cliproxyapi-antigravity",
            "account_id":"shared-cpa-pool","model":"gemini-3.8-flash-high","permission_profile":":read-only"}))).is_err());
        // Any worker may use WebGPT, but only through the exact bridge route.
        assert!(validate(None, &run(web.clone())).is_ok());
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/other","permission_profile":":read-only"}))).is_err());
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
            "account_id":"shared-cpa-pool","model":"claude-sonnet-4-6","permission_profile":":read-only"}))).is_ok());
        // Every WebGPT tier the bridge serves is allowed, but only on Native Codex.
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/extra-high","permission_profile":":read-only"}))).is_ok());
        assert!(validate(None, &run(json!({"harness_id":"ao:codex","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/pro","permission_profile":":read-only"}))).is_err());
    }

    #[test]
    fn ao_orchestrator_and_reviewer_may_use_any_webgpt_tier_or_cpa_model_on_native_codex() {
        let worker = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let run = |lead: serde_json::Value| -> Run {
            serde_json::from_value(json!({"id":"run","workspace_id":"qa","project_id":"p","revision":0,"nodes":[
                {"id":"planner","task_id":"t","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":lead},
                {"id":"worker","task_id":"t","role":"worker","parents":["planner"],"x":0,"y":1,"state":"pending","route":worker},
                {"id":"reviewer","task_id":"t","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":lead}
            ]})).unwrap()
        };
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/medium","permission_profile":":read-only"}))).is_ok());
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
            "account_id":"shared-cpa-pool","model":"claude-sonnet-4-6","permission_profile":":read-only"}))).is_ok());
        assert!(validate(None, &run(json!({"harness_id":"ao:claude-code","provider_id":EXTERNAL_PROVIDER,
            "account_id":EXTERNAL_ACCOUNT,"model":"default","permission_profile":EXTERNAL_PERMISSION}))).is_err());
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/other","permission_profile":":read-only"}))).is_err());
    }

    #[test]
    fn ao_receipts_gate_all_parents_and_never_replay_a_reserved_card() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let mut data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),
                "tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{
                "id":"task","workspace_id":"qa","title":"Test AO",
                "description":"Give a short answer","state":"pending","step":0,
                "created_at":0,"updated_at":0,"clauses":[],"evidence":[]
            }]}
        }))
        .unwrap();
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let worker = json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
            "account_id":"shared-cpa-pool","model":"gemini-3.8-flash-high","permission_profile":":read-only"});
        let run: Run = serde_json::from_value(json!({
            "id":"run","workspace_id":"qa","project_id":"project","revision":0,
            "nodes":[
                {"id":"planner","task_id":"task","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":web},
                {"id":"worker","task_id":"task","role":"worker","parents":["planner"],"x":0,"y":1,"state":"pending","route":worker},
                {"id":"reviewer","task_id":"task","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":web}
            ]
        })).unwrap();
        create(&mut data, 1, run).unwrap();
        let sha = "a".repeat(64);
        let mut granted = data.clone();
        let grant = grant_run(&mut granted, "qa", "run", 1, &sha, 1_000).unwrap();
        assert_eq!(grant.grant.as_ref().unwrap().max_turns, 7);
        assert!(grant_valid(&granted, &grant, 1_001, &sha).is_ok());
        let mut moved_workspace = granted.clone();
        moved_workspace.profiles[0].path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(grant_valid(&moved_workspace, &grant, 1_001, &sha).is_err());
        let mut edited_task = granted.clone();
        edited_task.control_board.tasks[0].description = "Changed after approval".into();
        assert!(grant_valid(&edited_task, &grant, 1_001, &sha).is_err());
        let mut extended = granted.clone();
        extended.ao_runs[0].grant.as_mut().unwrap().expires_at_ms += 1;
        assert!(grant_valid(&extended, &extended.ao_runs[0], 1_001, &sha).is_err());
        assert!(grant_valid(&granted, &grant, 3_601_000, &sha).is_err());
        assert!(grant_valid(&granted, &grant, 1_001, &"b".repeat(64)).is_err());
        let started = reserve(
            &mut granted,
            "qa",
            "run",
            "planner",
            grant.revision,
            "grant-one".into(),
            Some(1_001),
        )
        .unwrap();
        assert_eq!(started.grant.as_ref().unwrap().turns_started, 1);
        let moved_active = update_graph(&mut granted, "qa", "run", started.revision,
            GraphChange::MoveNode { node_id: "planner".into(), x: 320, y: 80 }).unwrap();
        assert_eq!(moved_active.nodes[0].state, State::Reserved);
        assert!(grant_valid(&granted, &moved_active, 1_002, &sha).is_ok());
        let group_move = serde_json::from_value(json!({"operation":"move_nodes","positions":[
            {"node_id":"planner","x":400,"y":100}, {"node_id":"worker","x":400,"y":300}
        ]})).unwrap();
        let grouped = update_graph(&mut granted, "qa", "run", moved_active.revision, group_move).unwrap();
        assert_eq!((grouped.nodes[0].x, grouped.nodes[1].x), (400, 400));
        assert_eq!(grouped.revision, moved_active.revision + 1);
        assert!(grant_valid(&granted, &grouped, 1_002, &sha).is_ok());
        for positions in [
            json!([]),
            json!([{"node_id":"planner","x":0,"y":0},{"node_id":"missing","x":0,"y":0}]),
            json!([{"node_id":"worker","x":0,"y":0},{"node_id":"worker","x":1,"y":0}]),
            json!([{"node_id":"planner","x":10001,"y":0}]),
        ] {
            let change = serde_json::from_value(json!({"operation":"move_nodes","positions":positions})).unwrap();
            assert!(update_graph(&mut granted, "qa", "run", grouped.revision, change).is_err());
            assert_eq!(granted.ao_runs[0].revision, grouped.revision);
            assert_eq!(granted.ao_runs[0].nodes[0].x, 400);
        }
        let mut edited = data.clone();
        let grant = grant_run(&mut edited, "qa", "run", 1, &sha, 1_000).unwrap();
        let changed = update_graph(
            &mut edited,
            "qa",
            "run",
            grant.revision,
            GraphChange::MoveNode {
                node_id: "worker".into(),
                x: 10,
                y: 1,
            },
        )
        .unwrap();
        assert!(changed.grant.is_some());
        assert!(grant_valid(&edited, &changed, 1_001, &sha).is_ok());
        let mut cancelled = data.clone();
        let grant = grant_run(&mut cancelled, "qa", "run", 1, &sha, 1_000).unwrap();
        assert!(cancel(&mut cancelled, "qa", "run", grant.revision)
            .unwrap()
            .grant
            .is_none());
        let run = reserve(&mut data, "qa", "run", "planner", 1, "one".into(), None).unwrap();
        assert_eq!(run.nodes[0].receipt.as_ref().unwrap().status, "reserved");
        assert!(reserve(&mut data, "qa", "run", "planner", 2, "two".into(), None).is_err());
        assert!(reserve(&mut data, "qa", "run", "worker", 2, "three".into(), None).is_err());
        record_submission(&mut data, "qa", "run", "planner", "one", Some("thread-one")).unwrap();
        let mut failed = data.clone();
        let failed_run = record_terminal(&mut failed, "qa", "run", "planner", "thread-one", Some("failed-turn"), None, false, Some("407: Bearer private-test-token")).unwrap();
        assert_eq!(failed_run.nodes[0].receipt.as_ref().unwrap().turn_id.as_deref(), Some("failed-turn"));
        assert_eq!(failed_run.nodes[0].receipt.as_ref().unwrap().error.as_deref(), Some("407: Bearer [REDACTED]"));
        let mut denied = data.clone();
        let denied = record_terminal(&mut denied, "qa", "run", "planner", "thread-one", Some("denied-turn"),
            Some("The requested tool could not run."), true, Some("Native approval declined (unsupported request)")).unwrap();
        assert_eq!(denied.nodes[0].state, State::Held);
        assert_eq!(denied.nodes[0].receipt.as_ref().unwrap().answer.as_deref(), Some("The requested tool could not run."));
        let run = record_terminal(
            &mut data,
            "qa",
            "run",
            "planner",
            "thread-one",
            Some("turn-one"),
            Some("Plan answer"),
            true,
            None,
        )
        .unwrap();
        assert!(parents_finished(&run, "worker"));
        assert!(prompt_for_node(&data, &run, "worker")
            .unwrap()
            .contains("Plan answer"));
        let run = reserve(
            &mut data,
            "qa",
            "run",
            "worker",
            run.revision,
            "three".into(),
            None,
        )
        .unwrap();
        assert!(!parents_finished(&run, "reviewer"));
        record_submission(
            &mut data,
            "qa",
            "run",
            "worker",
            "three",
            Some("thread-two"),
        )
        .unwrap();
        let mut successful = data.clone();
        let run = record_terminal(
            &mut data,
            "qa",
            "run",
            "worker",
            "thread-two",
            Some("turn-two"),
            Some(""),
            true,
            None,
        )
        .unwrap();
        assert_eq!(run.nodes[1].state, State::Held);
        assert!(!parents_finished(&run, "reviewer"));
        assert!(reserve(
            &mut data,
            "qa",
            "run",
            "reviewer",
            run.revision,
            "four".into(),
            None
        )
        .is_err());
        let run = record_terminal(
            &mut successful,
            "qa",
            "run",
            "worker",
            "thread-two",
            Some("turn-two"),
            Some("Worker answer"),
            true,
            None,
        )
        .unwrap();
        let run = reserve(
            &mut successful,
            "qa",
            "run",
            "reviewer",
            run.revision,
            "four".into(),
            None,
        )
        .unwrap();
        assert!(prompt_for_node(&successful, &run, "reviewer")
            .unwrap()
            .contains("Worker answer"));
        record_submission(
            &mut successful,
            "qa",
            "run",
            "reviewer",
            "four",
            Some("thread-three"),
        )
        .unwrap();
        let mut approved = successful.clone();
        let run = record_terminal(
            &mut successful,
            "qa",
            "run",
            "reviewer",
            "thread-three",
            Some("turn-three"),
            Some("**CHANGES\\_REQUIRED**: revise"),
            true,
            None,
        )
        .unwrap();
        assert_eq!(run.nodes[2].state, State::Held);
        assert_eq!(
            run.nodes[2].receipt.as_ref().unwrap().verdict.as_deref(),
            Some("CHANGES_REQUIRED")
        );
        let mut rework = successful.clone();
        let fingerprint = graph_sha256(&rework, &rework.ao_runs[0]).unwrap();
        rework.ao_runs[0].grant = Some(RunGrant { graph_sha256: fingerprint, executable_sha256: sha.clone(),
            granted_at_ms: 1000, expires_at_ms: 3_601_000, max_turns: 7, turns_started: 3 });
        let mut unknown = rework.clone();
        unknown.ao_runs[0].nodes[2].receipt.as_mut().unwrap().turn_id = None;
        assert!(crate::integrations::ao_team::queue_rework(&mut unknown, "qa", "run", "reviewer", "four", 1001).unwrap().is_none());
        for round in 1..=2 {
            let key = rework.ao_runs[0].nodes[2].receipt.as_ref().unwrap().request_key.clone();
            let queued = crate::integrations::ao_team::queue_rework(&mut rework, "qa", "run", "reviewer", &key, 1001).unwrap().unwrap();
            assert_eq!(queued.review_rounds, round);
            assert_eq!(queued.nodes[1].state, State::Pending);
            assert_eq!(queued.nodes[1].history.len(), usize::from(round));
            assert!(prompt_for_node(&rework, &queued, "worker").unwrap().contains("review feedback"));
            assert!(reserve(&mut rework, "qa", "run", "worker", queued.revision, "three".into(), Some(1001)).is_err());
            for role in ["worker", "reviewer"] {
                let revision = rework.ao_runs[0].revision;
                let key = format!("rework-{round}-{role}");
                let thread = format!("thread-{key}");
                reserve(&mut rework, "qa", "run", role, revision, key.clone(), Some(1001)).unwrap();
                record_submission(&mut rework, "qa", "run", role, &key, Some(&thread)).unwrap();
                record_terminal(&mut rework, "qa", "run", role, &thread, Some(&format!("turn-{key}")),
                    Some(if role == "worker" { "Revised work" } else { "**CHANGES_REQUIRED**: verify once more" }), true, None).unwrap();
            }
        }
        let key = rework.ao_runs[0].nodes[2].receipt.as_ref().unwrap().request_key.clone();
        let held = crate::integrations::ao_team::queue_rework(&mut rework, "qa", "run", "reviewer", &key, 1001).unwrap().unwrap();
        assert_eq!(held.review_rounds, 2);
        assert_eq!(held.nodes[2].state, State::Held);
        assert!(held.nodes[2].receipt.as_ref().unwrap().error.as_ref().unwrap().contains("two rework rounds"));
        assert_eq!(held.grant.as_ref().unwrap().turns_started, 7);
        let run = record_terminal(
            &mut approved,
            "qa",
            "run",
            "reviewer",
            "thread-three",
            Some("turn-three"),
            Some("APPROVED: complete"),
            true,
            None,
        )
        .unwrap();
        assert_eq!(run.nodes[2].state, State::Finished);
    }
}

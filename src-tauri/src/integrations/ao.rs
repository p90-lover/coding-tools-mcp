//! AO mission graph and execution reservations. Task text stays in the workflow board.
use crate::{
    data::AppData,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
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
    pub state: State,
    pub route: Route,
    #[serde(default)]
    pub request_key: Option<String>,
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
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum GraphChange {
    MoveNode {
        node_id: String,
        x: i32,
        y: i32,
    },
    SetParents {
        node_id: String,
        parents: Vec<String>,
    },
}

fn validate(data: &AppData, run: &Run) -> AppResult<()> {
    if !text(&run.id, 80)
        || !text(&run.workspace_id, 128)
        || !text(&run.project_id, 128)
        || !(3..=24).contains(&run.nodes.len())
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
            || !text(&node.task_id, 128)
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
        if node.clause_id.as_deref().is_some_and(|id| !text(id, 128)) {
            return Err(fail("Invalid AO clause identity"));
        }
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
        match node.role {
            Role::Planner => {
                if planner.replace(node.id.as_str()).is_some() || !node.parents.is_empty() {
                    return Err(fail("AO requires one root planner"));
                }
            }
            Role::Worker => workers.push(node.id.as_str()),
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
        if matches!(node.role, Role::Planner | Role::Reviewer)
            && (node.route.harness_id != "codex-native"
                || node.route.provider_id != "chatgpt-web"
                || node.route.model != "chatgpt-web/high")
        {
            return Err(fail(
                "AO planner and reviewer require the exact WebGPT-on-Codex route",
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

pub fn create(data: &mut AppData, expected_board_revision: u64, mut run: Run) -> AppResult<Run> {
    if data.control_board.revision != expected_board_revision || run.revision != 0 || run.cancelled
    {
        return Err(fail("AO board revision or initial state changed"));
    }
    if data.ao_runs.iter().any(|existing| existing.id == run.id) {
        return Err(fail("AO run identity already exists"));
    }
    if run
        .nodes
        .iter()
        .any(|node| node.state != State::Pending || node.request_key.is_some())
    {
        return Err(fail("AO run cannot start with existing execution"));
    }
    validate(data, &run)?;
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
    if next.revision != expected_revision || next.cancelled {
        return Err(fail("AO run revision changed or run cancelled"));
    }
    let node_id = match &change {
        GraphChange::MoveNode { node_id, .. } | GraphChange::SetParents { node_id, .. } => node_id,
    };
    let node = next
        .nodes
        .iter_mut()
        .find(|node| &node.id == node_id)
        .ok_or_else(|| fail("AO node not found"))?;
    if node.state != State::Pending {
        return Err(fail("Active AO node cannot be rewired"));
    }
    match change {
        GraphChange::MoveNode { x, y, .. } => {
            node.x = x;
            node.y = y;
        }
        GraphChange::SetParents { parents, .. } => node.parents = parents,
    }
    validate(data, &next)?;
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
) -> AppResult<Run> {
    if !text(&request_key, 128) {
        return Err(fail("AO request key is invalid"));
    }
    let run = data
        .ao_runs
        .iter_mut()
        .find(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    if run.cancelled
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
        .any(|node| node.request_key.as_deref() == Some(&request_key))
    {
        return Err(fail("AO request key already belongs to a node"));
    }
    let node = run
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id && node.state == State::Pending)
        .ok_or_else(|| fail("AO node is not pending"))?;
    node.state = State::Reserved;
    node.request_key = Some(request_key);
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
    for node in &mut run.nodes {
        if node.state == State::Pending {
            node.state = State::Cancelled;
        }
    }
    run.revision += 1;
    Ok(run.clone())
}

//! AO mission graph and execution reservations. Task text stays in the workflow board.
use crate::{
    data::AppData,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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
    /// Command approver: checks the plan's commands before any worker starts.
    Approver,
    Worker,
    /// The main reviewer's first pass: splits the review across the sub-reviewers.
    ReviewSplit,
    /// Checks one part of the finished work and reports PART_OK or PART_FAILED.
    SubReviewer,
    /// The main reviewer's final pass: APPROVED, or CHANGES_REQUIRED with the workers to redo.
    Reviewer,
}

/// Rework rounds a mission allows by default, and the most it may allow.
pub const DEFAULT_REVIEW_ROUNDS: u8 = 3;
pub const MAX_REVIEW_ROUNDS: u8 = 10;
/// Times a command approver may send the plan back before a person must decide.
pub const MAX_PLAN_ROUNDS: u8 = 2;
/// Most sub-reviewers one mission may have.
pub const MAX_SUB_REVIEWERS: usize = 8;
/// Earlier attempts kept per card.
pub(crate) const HISTORY_LIMIT: usize = 12;

pub fn default_review_rounds() -> u8 {
    DEFAULT_REVIEW_ROUNDS
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

#[cfg(test)]
#[test]
fn native_permission_selection_round_trips_without_legacy_fingerprint_changes() {
    let legacy = serde_json::json!({"harness_id":"codex-native","provider_id":"chatgpt-web","account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":workspace"});
    let route: Route = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(route).unwrap(), legacy);
    let mut selected = legacy;
    selected["native_permission_profile"] = serde_json::json!(":workspace");
    selected["approval_policy"] = serde_json::json!("on-request");
    selected["approvals_reviewer"] = serde_json::json!("auto_review");
    let route: Route = serde_json::from_value(selected.clone()).unwrap();
    assert_eq!(serde_json::to_value(route).unwrap(), selected);
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub harness_id: String,
    pub provider_id: String,
    pub account_id: String,
    pub model: String,
    pub permission_profile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_permission_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,

    /// Reasoning effort for this card ("minimal" to "xhigh"); None keeps the model's default.
    /// Omitted when unset, so grants issued before this setting keep their fingerprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Context window in tokens for this card; None keeps the model's default. Native Codex
    /// applies it; AO harnesses have no such setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
}

/// Current Unix time in milliseconds (0 if the clock is before 1970).
fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Reasoning efforts a card may ask for (Codex's ReasoningEffort names).
pub const EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];
/// Context windows a card may ask for, in tokens.
pub const CONTEXT_WINDOWS: std::ops::RangeInclusive<u32> = 4_096..=2_000_000;

/// The route's tuning is one Codex knows, inside the allowed range.
fn route_tuning_valid(route: &Route) -> bool {
    route
        .approval_policy
        .as_deref()
        .is_none_or(|value| matches!(value, "on-request" | "never"))
        && route
            .approvals_reviewer
            .as_deref()
            .is_none_or(|value| matches!(value, "user" | "auto_review"))
        && !(route.approval_policy.as_deref() == Some("never")
            && route.approvals_reviewer.as_deref() == Some("auto_review"))
        && route
            .native_permission_profile
            .as_deref()
            .is_none_or(|value| text(value, 128) && value != EXTERNAL_PERMISSION)
        && route
            .effort
            .as_deref()
            .is_none_or(|effort| EFFORTS.contains(&effort))
        && route
            .context_window
            .is_none_or(|tokens| CONTEXT_WINDOWS.contains(&tokens))
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
    /// Tool requests the command approver decided during this attempt ("allowed · reason · request").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approvals: Vec<String>,
    /// When the card was reserved (Unix ms), so every view can show how long it has been running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Single,
    #[default]
    Team,
}
impl ExecutionMode {
    pub fn is_team(&self) -> bool {
        *self == Self::Team
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    #[serde(default, skip_serializing_if = "ExecutionMode::is_team")]
    pub execution_mode: ExecutionMode,
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
    /// Each worker's part of the plan, keyed by worker card id; parsed from the planner's answer.
    #[serde(default)]
    pub assignments: BTreeMap<String, Assignment>,
    /// Rework rounds the main reviewer may request before the mission holds for a person.
    #[serde(default = "default_review_rounds")]
    pub max_review_rounds: u8,
    /// Times the command approver has sent the plan back.
    #[serde(default)]
    pub plan_rounds: u8,
    /// Each sub-reviewer's part of the review, keyed by card id; parsed from the split pass.
    #[serde(default)]
    pub review_parts: BTreeMap<String, ReviewPart>,
    /// Worker cards that run again once their current turn finishes: work handed over from a
    /// removed card to a busy worker waits here instead of interrupting it.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub rerun_after: BTreeSet<String>,
    /// The orchestrator judged the mission simple and answered it alone; the other cards were
    /// skipped (finished without running).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub solo: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewPart {
    pub workers: Vec<String>,
    #[serde(default)]
    pub check: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub task: String,
    #[serde(default)]
    pub acceptance: String,
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
            && agent
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// The automatic tiers the WebGPT bridge serves (runtime-web chatgpt-web-models.ts); the
/// bridge itself falls back to a lower tier when the account lacks the chosen one.
pub(crate) const WEB_TIERS: &[&str] = &[
    "light",
    "medium",
    "high",
    "extra-high",
    "pro",
    "luna",
    "think",
];

/// WebGPT-on-Codex at any tier the bridge serves.
fn web_route_valid(route: &Route) -> bool {
    route.harness_id == "codex-native"
        && route.provider_id == "chatgpt-web"
        && route
            .model
            .strip_prefix("chatgpt-web/")
            .is_some_and(|tier| WEB_TIERS.contains(&tier))
}

/// The route asks for WebGPT: its provider, or a WebGPT model id directly or through the
/// local CPA gateway prefix an AO harness uses.
fn web_model_named(route: &Route) -> bool {
    route.provider_id == "chatgpt-web"
        || route
            .model
            .strip_prefix("cpa/")
            .unwrap_or(&route.model)
            .starts_with("chatgpt-web/")
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
    let mut scope = serde_json::json!({"run_id":run.id,"workspace_id":run.workspace_id,
        "workspace_root":workspace_root,"project_id":run.project_id,"nodes":nodes});
    if run.execution_mode == ExecutionMode::Single {
        scope["execution_mode"] = serde_json::json!("single");
    }
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
    // Boxed: a full Node is far larger than the other variants (clippy::large_enum_variant).
    // serde deserializes Box<Node> exactly like Node, so the API shape is unchanged.
    AddWorker {
        node: Box<Node>,
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
    /// Removes a card (never the orchestrator). Its children take over its links, and a worker's
    /// task is handed to another worker: a linked one first, an idle one before a busy one.
    RemoveNode {
        node_id: String,
    },
}

pub(super) fn validate(data: Option<&AppData>, run: &Run) -> AppResult<()> {
    if !text(&run.id, 80)
        || !text(&run.workspace_id, 128)
        || !text(&run.project_id, 128)
        || if run.execution_mode == ExecutionMode::Single {
            run.nodes.len() != 1
        } else {
            !(3..=24).contains(&run.nodes.len())
        }
        || !(1..=24).contains(&run.worker_limit)
        || !(1..=MAX_REVIEW_ROUNDS).contains(&run.max_review_rounds)
        || run.review_rounds > run.max_review_rounds
        || run.plan_rounds > MAX_PLAN_ROUNDS
    {
        return Err(fail("Invalid AO run identity or size"));
    }
    let mut ids = HashSet::new();
    let mut planner = None;
    let mut approver = None;
    let mut split = None;
    let mut sub_reviewers = Vec::new();
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
        if node.history.len() > HISTORY_LIMIT {
            return Err(fail("AO attempt history is too long"));
        }
        if node
            .template_role_id
            .as_deref()
            .is_some_and(|id| !text(id, 80))
        {
            return Err(fail("Invalid reusable role identity"));
        }
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
                || receipt.verdict.as_deref().is_some_and(|verdict| {
                    !matches!(
                        verdict,
                        "APPROVED" | "CHANGES_REQUIRED" | "PART_OK" | "PART_FAILED"
                    )
                })
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
                if node.route.harness_id.starts_with("ao:") && !external_route_valid(&node.route) {
                    return Err(fail("AO harness worker route is invalid"));
                }
                workers.push(node.id.as_str());
            }
            Role::Approver => {
                if approver.replace(node.id.as_str()).is_some() {
                    return Err(fail("AO allows one command approver"));
                }
            }
            Role::ReviewSplit => {
                if split.replace(node.id.as_str()).is_some() {
                    return Err(fail("AO allows one main-reviewer split pass"));
                }
            }
            Role::SubReviewer => sub_reviewers.push(node.id.as_str()),
            Role::Reviewer => {
                if reviewer.replace(node.id.as_str()).is_some() {
                    return Err(fail("AO requires one main reviewer"));
                }
            }
        }
    }
    if run.execution_mode == ExecutionMode::Single {
        if planner.is_none()
            || reviewer.is_some()
            || approver.is_some()
            || split.is_some()
            || !workers.is_empty()
            || !sub_reviewers.is_empty()
            || run.solo
            || run.plan_rounds != 0
            || run.review_rounds != 0
        {
            return Err(fail(
                "Single execution requires exactly one selected assistant without team phases",
            ));
        }
    } else {
        let (Some(_), Some(_)) = (planner, reviewer) else {
            return Err(fail("AO requires a planner and reviewer"));
        };
        if workers.is_empty() {
            return Err(fail("AO requires at least one worker"));
        }
    }
    if sub_reviewers.len() > MAX_SUB_REVIEWERS || split.is_some() != !sub_reviewers.is_empty() {
        return Err(fail(
            "Sub-reviewers need the main reviewer's split pass, and at most eight of them",
        ));
    }
    if run.review_parts.iter().any(|(id, part)| {
        !sub_reviewers.contains(&id.as_str())
            || part.check.len() > 2_000
            || part.workers.len() > 24
            || part
                .workers
                .iter()
                .any(|worker| !workers.contains(&worker.as_str()))
    }) {
        return Err(fail(
            "AO review part is outside this mission's sub-reviewers or workers",
        ));
    }
    if run
        .rerun_after
        .iter()
        .any(|id| !workers.contains(&id.as_str()))
    {
        return Err(fail("AO rerun queue names a card that is not a worker"));
    }
    if run
        .assignments
        .iter()
        .any(|(id, item)| !workers.contains(&id.as_str()) || !assignment_valid(item))
    {
        return Err(fail(
            "AO assignment is outside this mission's workers or invalid",
        ));
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
        // Links are free: the planner is the only card without inputs (so every card is reached
        // from it), a reviewer reviews whatever links into it, and a sub-reviewer still hangs
        // off the split pass that assigns its part.
        let depends_on = |id: &str| node.parents.iter().any(|parent| parent == id);
        let wired = match node.role {
            Role::Planner => true,
            Role::SubReviewer => split.is_some_and(&depends_on),
            _ => !node.parents.is_empty(),
        };
        if !wired {
            return Err(fail(match node.role {
                Role::SubReviewer => {
                    "AO sub-reviewer must depend on the main reviewer's split pass"
                }
                _ => "AO card needs at least one link; only the orchestrator starts on its own",
            }));
        }
        // WebGPT only works through the bridge on Native Codex, for every role; an AO harness
        // or the CPA pool cannot run it (not even as "cpa/chatgpt-web/...").
        if web_model_named(&node.route) && !web_route_valid(&node.route) {
            return Err(fail("AO WebGPT runs only on Native Codex"));
        }
        // Native Codex runs only WebGPT; other models run on an AO harness through the CPA
        // gateway. Cards that already ran keep their old route so older missions stay usable.
        if node.state == State::Pending
            && node.route.harness_id == "codex-native"
            && !web_route_valid(&node.route)
        {
            return Err(fail(
                "Native Codex runs only WebGPT models; choose an AO harness (Codex or Claude Code) for other models",
            ));
        }
        if !route_tuning_valid(&node.route) {
            return Err(fail(
                "AO card effort must be minimal, low, medium, high or xhigh, and its context window 4,096 to 2,000,000 tokens",
            ));
        }
        // Any role may run on any harness: WebGPT or a CPA model on Native Codex, or an AO harness.
        if node.role != Role::Worker
            && !web_route_valid(&node.route)
            && !cpa_route_valid(&node.route)
            && !external_route_valid(&node.route)
        {
            return Err(fail(
                "AO roles need WebGPT or a CPA model on Native Codex, or an AO harness",
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
        || grant.max_turns as usize
            > run.nodes.len()
                * (usize::from(run.max_review_rounds) + usize::from(MAX_PLAN_ROUNDS) + 1)
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
    if run.cancelled
        || run.paused
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
    let remaining_reworks = usize::from(run.max_review_rounds.saturating_sub(run.review_rounds));
    // The planner and approver re-run only when the approver sends the plan back.
    let replans = if run.nodes.iter().any(|node| node.role == Role::Approver) {
        usize::from(MAX_PLAN_ROUNDS.saturating_sub(run.plan_rounds))
    } else {
        0
    };
    let max_turns: usize = run
        .nodes
        .iter()
        .map(|node| match (&node.role, &node.state) {
            (Role::Planner | Role::Approver, State::Pending) => 1 + replans,
            (Role::Planner | Role::Approver, _) => replans,
            (Role::Reviewer, State::Finished) => 0,
            (_, State::Pending) => 1 + remaining_reworks,
            _ => remaining_reworks,
        })
        .sum();
    let max_turns = max_turns.min(usize::from(u8::MAX));
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

const ASSIGNMENTS_FENCE: &str = "```assignments";
/// Ends an orchestrator answer that completes a simple mission without the team.
const SOLO_FENCE: &str = "```solo";

/// At most `max` characters, cut on a character boundary.
fn clip(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &value[..end]),
        None => value.to_owned(),
    }
}

fn assignment_valid(item: &Assignment) -> bool {
    let clean = |value: &str| {
        !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    };
    !item.task.trim().is_empty()
        && item.task.len() <= 4_000
        && item.acceptance.len() <= 2_000
        && clean(&item.task)
        && clean(&item.acceptance)
}

/// The worker cards the planner splits the mission across, and the answer format it must use.
fn planner_roster(run: &Run) -> String {
    let mut roster =
        String::from("\nWorker cards (assign each one a distinct part; use the card id):\n");
    for worker in run.nodes.iter().filter(|node| node.role == Role::Worker) {
        let name = if worker.settings.name.is_empty() {
            "Worker"
        } else {
            &worker.settings.name
        };
        let specialty = if worker.settings.specialty.is_empty() {
            "general"
        } else {
            &worker.settings.specialty
        };
        let role = if worker.settings.role_name.is_empty() {
            String::new()
        } else {
            format!(" · role {}", worker.settings.role_name)
        };
        let effort = worker
            .route
            .effort
            .as_deref()
            .map(|effort| format!(" · effort {effort}"))
            .unwrap_or_default();
        roster.push_str(&format!(
            "- id `{}` · {name}{role} · specialty {specialty} · {} / {}{effort}\n",
            worker.id, worker.route.harness_id, worker.route.model
        ));
    }
    roster.push_str(&format!("\nEnd your answer with exactly one of these blocks.\n\
If you answered the whole mission yourself (simple):\n{SOLO_FENCE}\n{{\"difficulty\":\"simple\",\"reason\":\"why no workers are needed\"}}\n```\n\
If the workers are needed, give every worker card its own part:\n\
{ASSIGNMENTS_FENCE}\n[{{\"worker\":\"<card id>\",\"task\":\"what this worker must do\",\"acceptance\":\"how to tell it is done\"}}]\n```\n"));
    roster
}

/// The body of the last block labelled `label` in a card's answer, and where that block starts.
/// Accepts the fenced form (```label … ```) and the form the ChatGPT web bridge flattens it to:
/// the label alone on a line, then the body in backticks (`…` or ```…```) or as bare JSON.
pub(crate) fn labelled_block<'a>(answer: &'a str, label: &str) -> Option<(usize, &'a str)> {
    let fence = format!("```{label}");
    let fenced = answer.rfind(&fence).and_then(|start| {
        let body = &answer[start + fence.len()..];
        body.find("```").map(|end| (start, body[..end].trim()))
    });
    let mut flattened = None;
    let mut offset = 0;
    for line in answer.split_inclusive('\n') {
        if line.trim().eq_ignore_ascii_case(label) {
            flattened = Some((offset, offset + line.len()));
        }
        offset += line.len();
    }
    let flattened = flattened.and_then(|(start, body_start)| {
        let rest = answer[body_start..].trim_start();
        let body = if let Some(inner) = rest.strip_prefix("```") {
            // Skip an optional language tag on the opening line.
            let inner = inner.split_once('\n').map_or(inner, |(_, after)| after);
            inner.find("```").map(|end| inner[..end].trim())
        } else if let Some(inner) = rest.strip_prefix('`') {
            inner.find('`').map(|end| inner[..end].trim())
        } else if rest.starts_with('[') || rest.starts_with('{') {
            let mut values =
                serde_json::Deserializer::from_str(rest).into_iter::<serde_json::Value>();
            values
                .next()
                .and_then(Result::ok)
                .map(|_| rest[..values.byte_offset()].trim())
        } else {
            None
        };
        body.map(|body| (start, body))
    });
    match (fenced, flattened) {
        (Some(a), Some(b)) => Some(if b.0 > a.0 { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// Reads the planner's `assignments` block. Workers are matched by card id or by their name.
pub(crate) fn parse_assignments(
    answer: &str,
    run: &Run,
) -> Result<BTreeMap<String, Assignment>, &'static str> {
    #[derive(Deserialize)]
    struct Planned {
        worker: String,
        task: String,
        #[serde(default)]
        acceptance: String,
    }
    let (_, body) = labelled_block(answer, "assignments")
        .ok_or("The plan has no ```assignments block for the worker cards")?;
    let planned: Vec<Planned> = serde_json::from_str(body).map_err(|_| {
        "The plan's ```assignments block is not a JSON list of {worker, task, acceptance}"
    })?;
    let mut assignments = BTreeMap::new();
    for item in planned {
        let wanted = item.worker.trim().trim_matches('`');
        let worker = run
            .nodes
            .iter()
            .filter(|node| node.role == Role::Worker)
            .find(|node| {
                node.id == wanted
                    || (!node.settings.name.is_empty()
                        && node.settings.name.eq_ignore_ascii_case(wanted))
            })
            .ok_or("The plan assigns work to a card that is not a worker in this mission")?;
        let assignment = Assignment {
            task: item.task.trim().to_owned(),
            acceptance: item.acceptance.trim().to_owned(),
        };
        if !assignment_valid(&assignment) {
            return Err("A planned assignment is empty or too long");
        }
        if assignments.insert(worker.id.clone(), assignment).is_some() {
            return Err("The plan assigns the same worker twice");
        }
    }
    if assignments.is_empty() {
        return Err("The plan assigned no work to the worker cards");
    }
    Ok(assignments)
}

/// True when the orchestrator ended with a ```solo block (and no assignments after it): it
/// answered the mission itself.
pub(crate) fn is_solo_answer(answer: &str) -> bool {
    match (
        labelled_block(answer, "solo"),
        labelled_block(answer, "assignments"),
    ) {
        (Some((solo, _)), Some((plan, _))) => solo > plan,
        (Some(_), None) => true,
        _ => false,
    }
}

const REVIEW_PARTS_FENCE: &str = "```review-parts";

/// What each specialty concentrates on; added to that card's prompt.
pub fn specialty_guidance(specialty: &str) -> Option<&'static str> {
    Some(match specialty {
        "planning" => "break the goal into independent parts with clear owners, order and acceptance checks.",
        "research" => "find and cite the facts the work depends on (docs, code, versions) before anyone builds on them.",
        "architecture" => "decide the structure, interfaces and data flow first, and note the trade-offs.",
        "frontend" => "build the user interface, check it renders and behaves at the sizes it is used, and keep it accessible.",
        "backend" => "implement server logic and APIs with input validation, error handling and tests.",
        "database" => "design schema and queries, keep migrations reversible, and check data integrity.",
        "api" => "define and implement the contract (requests, responses, errors) and keep it backward compatible.",
        "devops" => "handle build, CI, packaging and deployment; make every step repeatable and say how to roll back.",
        "security" => "check input handling, authentication, secrets and permissions, and report every risk you find.",
        "testing" => "write and run the tests, and report the exact commands and their results.",
        "performance" => "measure before and after, and change only what the numbers show is slow.",
        "debugging" => "reproduce the failure, find the root cause with evidence, then fix it and show it is fixed.",
        "refactor" => "improve structure without changing behaviour, and prove behaviour is unchanged with tests.",
        "docs" => "write accurate, concise documentation for the people who will use or maintain this.",
        "ui-ux" => "make the flow clear and consistent, and check states such as empty, loading and error.",
        "mobile" => "check small screens, touch input and platform conventions.",
        "data-ml" => "validate the data and the model's results, and report the metrics you used.",
        "implementation" => "make the change completely and cleanly, and show it works.",
        "qa" => "exercise the finished feature like a user, including edge cases, and report what you verified.",
        "review" => "check correctness, completeness against each assignment, and evidence; do not edit the work.",
        "delivery" => "make sure everything is integrated, documented and ready to hand over.",
        _ => return None,
    })
}

/// The latest answer a card of this role gave in an earlier round.
fn last_answer(run: &Run, role: Role) -> Option<&str> {
    run.nodes
        .iter()
        .find(|node| node.role == role)
        .and_then(|node| node.history.last())
        .and_then(|receipt| receipt.answer.as_deref())
}

fn card_name(run: &Run, id: &str) -> String {
    run.nodes
        .iter()
        .find(|node| node.id == id)
        .map(|node| {
            if node.settings.name.is_empty() {
                id.to_owned()
            } else {
                format!("{} ({id})", node.settings.name)
            }
        })
        .unwrap_or_else(|| id.to_owned())
}

/// What each worker was asked to do, for the approver and reviewers.
fn assignment_summary(run: &Run) -> String {
    if run.assignments.is_empty() {
        return String::new();
    }
    let mut summary = String::from("\nWhat each worker was asked to do:\n");
    for (worker_id, item) in &run.assignments {
        summary.push_str(&format!(
            "- {}: {} / done when: {}\n",
            card_name(run, worker_id),
            clip(&item.task, 600),
            clip(&item.acceptance, 300)
        ));
    }
    summary
}

/// The sub-reviewers the split pass assigns, and the answer format it must use.
fn review_split_roster(run: &Run) -> String {
    let mut roster = String::from(
        "\nSub-reviewer cards (give each a part; together they must cover every worker):\n",
    );
    for sub in run
        .nodes
        .iter()
        .filter(|node| node.role == Role::SubReviewer)
    {
        let specialty = if sub.settings.specialty.is_empty() {
            "review"
        } else {
            &sub.settings.specialty
        };
        roster.push_str(&format!(
            "- id `{}` · {} · specialty {specialty}\n",
            sub.id,
            if sub.settings.name.is_empty() {
                "Sub-reviewer"
            } else {
                &sub.settings.name
            }
        ));
    }
    roster.push_str("Worker cards: ");
    roster.push_str(
        &run.nodes
            .iter()
            .filter(|node| node.role == Role::Worker)
            .map(|node| format!("`{}`", node.id))
            .collect::<Vec<_>>()
            .join(", "),
    );
    roster.push_str(&format!("\n\nEnd your answer with exactly one block in this form:\n{REVIEW_PARTS_FENCE}\n[{{\"sub_reviewer\":\"<card id>\",\"workers\":[\"<worker card id>\"],\"check\":\"what to verify\"}}]\n```\n"));
    roster
}

/// One sub-reviewer's part: the workers it checks, what they were asked to do, and their output.
fn sub_review_part(run: &Run, sub_id: &str) -> String {
    let part = run.review_parts.get(sub_id);
    let workers: Vec<&Node> = run
        .nodes
        .iter()
        .filter(|node| {
            node.role == Role::Worker && part.is_none_or(|part| part.workers.contains(&node.id))
        })
        .collect();
    let mut text = String::from("\nYour part of the review:\n");
    if let Some(check) = part
        .map(|part| part.check.as_str())
        .filter(|check| !check.is_empty())
    {
        text.push_str(&format!("Check: {check}\n"));
    }
    let budget = (10_000 / workers.len().max(1)).max(1_000);
    for worker in workers {
        text.push_str(&format!("\nWorker {}:\n", card_name(run, &worker.id)));
        if let Some(item) = run.assignments.get(&worker.id) {
            text.push_str(&format!(
                "Asked to: {} / done when: {}\n",
                clip(&item.task, 600),
                clip(&item.acceptance, 300)
            ));
        }
        let output = worker
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.answer.as_deref())
            .unwrap_or("(no output)");
        text.push_str(&format!("Output:\n{}\n", clip(output, budget)));
    }
    text
}

/// Reads the split pass's `review-parts` block. Sub-reviewers and workers match by id or name.
pub(crate) fn parse_review_parts(
    answer: &str,
    run: &Run,
) -> Result<BTreeMap<String, ReviewPart>, &'static str> {
    #[derive(Deserialize)]
    struct Planned {
        sub_reviewer: String,
        workers: Vec<String>,
        #[serde(default)]
        check: String,
    }
    let (_, body) = labelled_block(answer, "review-parts")
        .ok_or("The review split has no ```review-parts block for the sub-reviewers")?;
    let planned: Vec<Planned> = serde_json::from_str(body).map_err(|_| {
        "The ```review-parts block is not a JSON list of {sub_reviewer, workers, check}"
    })?;
    let card = |wanted: &str, role: Role| {
        run.nodes
            .iter()
            .filter(|node| node.role == role)
            .find(|node| {
                node.id == wanted
                    || (!node.settings.name.is_empty()
                        && node.settings.name.eq_ignore_ascii_case(wanted))
            })
            .map(|node| node.id.clone())
    };
    let mut parts = BTreeMap::new();
    for item in planned {
        let sub = card(
            item.sub_reviewer.trim().trim_matches('`'),
            Role::SubReviewer,
        )
        .ok_or("The review split names a card that is not a sub-reviewer")?;
        let workers = item
            .workers
            .iter()
            .map(|worker| card(worker.trim().trim_matches('`'), Role::Worker))
            .collect::<Option<Vec<_>>>()
            .ok_or("The review split names a card that is not a worker")?;
        if workers.is_empty() || item.check.len() > 2_000 {
            return Err("A review part has no workers or is too long");
        }
        if parts
            .insert(
                sub,
                ReviewPart {
                    workers,
                    check: item.check.trim().to_owned(),
                },
            )
            .is_some()
        {
            return Err("The review split assigns the same sub-reviewer twice");
        }
    }
    let covered: HashSet<&String> = parts
        .values()
        .flat_map(|part| part.workers.iter())
        .collect();
    if run
        .nodes
        .iter()
        .any(|node| node.role == Role::Worker && !covered.contains(&node.id))
    {
        return Err("The review split leaves a worker unchecked");
    }
    Ok(parts)
}

/// Workers the main reviewer asked to redo; empty means every worker.
pub(crate) fn parse_rework_targets(answer: &str, run: &Run) -> Vec<String> {
    let Some((_, body)) = labelled_block(answer, "rework") else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(body) else {
        return Vec::new();
    };
    let mut targets = Vec::new();
    for item in items {
        let wanted = item
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                item.get("worker")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        let wanted = wanted.trim().trim_matches('`');
        if let Some(worker) = run
            .nodes
            .iter()
            .filter(|node| node.role == Role::Worker)
            .find(|node| {
                node.id == wanted
                    || (!node.settings.name.is_empty()
                        && node.settings.name.eq_ignore_ascii_case(wanted))
            })
        {
            if !targets.contains(&worker.id) {
                targets.push(worker.id.clone());
            }
        }
    }
    targets
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
    if run.execution_mode == ExecutionMode::Single {
        let mut prompt = format!("Single assistant task: {}\nWorkspace: {}\nComplete the requested task yourself and report the result and verification. Do not spawn or delegate to other agents; there are no team planning or review stages.\n\nTask: {}\n{}\n", run.id, run.workspace_id, task.title, task.description);
        if !node.settings.instructions.is_empty() {
            prompt.push_str(&format!(
                "\nInstructions:\n{}\n",
                node.settings.instructions
            ));
        }
        if !node.settings.expected_output.is_empty() {
            prompt.push_str(&format!(
                "\nExpected output:\n{}\n",
                node.settings.expected_output
            ));
        }
        return Ok(prompt);
    }
    let responsibility = match node.role {
        Role::Planner => "First judge how difficult the mission is. If you can complete it fully and reliably yourself in this one turn with your own access \
(a question, an explanation, a short lookup or a small read-only check), do so: give the complete final answer and end with the solo block described below. \
Otherwise plan the mission and split it across the worker cards listed below; Coding Tools runs every worker on its own harness and model. \
Do not use your own sub-agent, spawn or delegation tools. When you plan, do not do the workers' work yourself, and do not simulate worker results or the reviewer's approval.",
        Role::Approver => "You are the command approver. Before any worker starts, check the plan and every assignment for commands that delete or overwrite data, \
force-push, install software, reach outside the workspace or the network, or handle secrets; also check for missing steps and unclear acceptance. \
Do not change the plan or do the work yourself.",
        Role::Worker => "Perform only your assigned work and report evidence. Do not speak for the orchestrator or approve your own work.",
        Role::ReviewSplit => "You are the main reviewer. First split the review of the finished work across the sub-reviewers listed below so that every worker's output is checked. \
Do not review the work yourself yet and do not edit anything.",
        Role::SubReviewer => "You are a sub-reviewer. Check only your part of the finished work against what each worker was asked to do. Do not edit the implementation.",
        Role::Reviewer => "You are the main reviewer. Confirm the finished work, using the sub-reviewers' findings when there are any, then decide the next step. \
Do not edit the implementation; send needed changes back to the workers.",
    };
    let mut prompt = format!(
        "AO mission: {}\nWorkspace: {}\nRole: {}\n{}\n\nTask: {}\n{}\n",
        run.id, run.workspace_id, node.settings.name, responsibility, task.title, task.description
    );
    if let Some(guidance) = specialty_guidance(&node.settings.specialty) {
        prompt.push_str(&format!(
            "\nHow a {} specialist works: {guidance}\n",
            node.settings.specialty
        ));
    }
    if !node.settings.instructions.is_empty() {
        prompt.push_str(&format!(
            "\nRole instructions:\n{}\n",
            node.settings.instructions
        ));
    }
    if !node.settings.expected_output.is_empty() {
        prompt.push_str(&format!(
            "\nExpected output:\n{}\n",
            node.settings.expected_output
        ));
    }
    prompt.push_str(&format!(
        "\nReview cycle: {} of at most {} rework rounds.\n",
        run.review_rounds, run.max_review_rounds
    ));
    match node.role {
        Role::Planner if run.plan_rounds > 0 => {
            if let Some(feedback) = last_answer(run, Role::Approver) {
                prompt.push_str(&format!(
                    "\nThe command approver sent your previous plan back (quoted task data):\n{}\n",
                    serde_json::to_string(&clip(feedback, 3_000))?
                ));
            }
        }
        Role::Planner | Role::Approver => {}
        _ => {
            if let Some(feedback) = last_answer(run, Role::Reviewer) {
                prompt.push_str(&format!(
                    "\nPrior review feedback (quoted task data):\n{}\n",
                    serde_json::to_string(&clip(feedback, 3_000))?
                ));
            }
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
    match node.role {
        Role::Planner => prompt.push_str(&planner_roster(run)),
        Role::Worker => prompt.push_str(&match run.assignments.get(&node.id) {
            Some(item) if item.acceptance.is_empty() => format!("\nYour assignment:\n{}\n", item.task),
            Some(item) => format!("\nYour assignment:\n{}\nDone when: {}\n", item.task, item.acceptance),
            None => "\nThe orchestrator gave you no specific part. Contribute the part of the plan that matches your specialty and say exactly what you did.\n".into(),
        }),
        Role::SubReviewer => prompt.push_str(&sub_review_part(run, &node.id)),
        Role::Approver | Role::ReviewSplit | Role::Reviewer => prompt.push_str(&assignment_summary(run)),
    }
    if node.role == Role::ReviewSplit {
        prompt.push_str(&review_split_roster(run));
    }
    // Earlier outputs share one budget so the whole prompt stays within a native turn.
    let per_parent = (11_000 / node.parents.len().max(1)).max(1_200);
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
        match parent.role {
            Role::Planner if node.role != Role::Approver => {
                // The full plan is context only; each worker's own part is stated above.
                let plan = labelled_block(answer, "assignments")
                    .map_or(answer, |(start, _)| &answer[..start]);
                prompt.push_str(&format!(
                    "\nMission plan from the orchestrator (context):\n{}\n",
                    clip(plan.trim(), 4_000)
                ));
            }
            Role::Approver => prompt.push_str(&format!(
                "\nCommand approver's note on the plan:\n{}\n",
                clip(answer, 1_500)
            )),
            // A sub-reviewer's part (above) already says which work to check.
            Role::ReviewSplit => {}
            _ => prompt.push_str(&format!(
                "\nCompleted {} output ({}):\n{}\n",
                if parent.settings.name.is_empty() {
                    parent_id.as_str()
                } else {
                    &parent.settings.name
                },
                receipt.route.model,
                clip(answer, per_parent)
            )),
        }
    }
    prompt.push_str(match node.role {
        Role::Approver => "\nReply with APPROVED or CHANGES_REQUIRED first, then a concise reason. With CHANGES_REQUIRED, say exactly what the orchestrator must change.\n",
        Role::SubReviewer => "\nReply with PART_OK or PART_FAILED first, then your findings with evidence (files, commands, results).\n",
        Role::Reviewer => "\nReply with APPROVED or CHANGES_REQUIRED first, then a concise reason. With CHANGES_REQUIRED, end with a ```rework block listing the worker card ids that must redo their work, for example:\n```rework\n[\"<card id>\"]\n```\n",
        _ => "",
    });
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
        node.state != State::Pending
            || node.request_key.is_some()
            || node.receipt.is_some()
            || !node.history.is_empty()
    }) {
        return Err(fail("AO run cannot start with existing execution"));
    }
    validate(Some(data), &run)?;
    run.revision = 1;
    data.ao_runs.push(run.clone());
    Ok(run)
}

/// Stops a card: its current attempt moves into its history and it waits to run again.
fn interrupt(node: &mut Node) {
    if let Some(receipt) = node.receipt.take() {
        node.history.push(receipt);
    }
    if node.history.len() > HISTORY_LIMIT {
        let excess = node.history.len() - HISTORY_LIMIT;
        node.history.drain(..excess);
    }
    node.request_key = None;
    node.state = State::Pending;
}

fn planner_id(run: &Run) -> AppResult<String> {
    run.nodes
        .iter()
        .find(|node| node.role == Role::Planner)
        .map(|node| node.id.clone())
        .ok_or_else(|| fail("AO orchestrator is missing"))
}

/// Removes a card. Its children inherit its links (the orchestrator when it had none), and a
/// worker's task goes to another worker: a linked one first, an idle one before a busy one. A
/// finished worker runs again with the extra task; a busy one runs it after its current turn.
fn remove_node(run: &mut Run, node_id: &str) -> AppResult<()> {
    let index = run
        .nodes
        .iter()
        .position(|node| node.id == node_id)
        .ok_or_else(|| fail("AO node not found"))?;
    if run.nodes[index].role == Role::Planner {
        return Err(fail("The orchestrator cannot be removed"));
    }
    let removed = run.nodes.remove(index);
    let planner = planner_id(run)?;
    for node in &mut run.nodes {
        if let Some(at) = node.parents.iter().position(|parent| parent == node_id) {
            node.parents.remove(at);
            for parent in &removed.parents {
                if parent != &node.id && !node.parents.contains(parent) {
                    node.parents.push(parent.clone());
                }
            }
            if node.parents.is_empty() && node.role != Role::Planner {
                node.parents.push(planner.clone());
            }
        }
    }
    run.rerun_after.remove(node_id);
    if removed.role != Role::Worker {
        return Ok(());
    }
    // Linked = a worker the removed card depended on, or one that depended on it.
    let linked = |node: &Node| {
        removed.parents.contains(&node.id)
            || node
                .parents
                .iter()
                .any(|parent| removed.parents.contains(parent) && parent != &planner)
    };
    let busy = |node: &Node| matches!(node.state, State::Reserved | State::Running);
    let mut candidates: Vec<&Node> = run
        .nodes
        .iter()
        .filter(|node| node.role == Role::Worker)
        .collect();
    if candidates.is_empty() {
        return Err(fail("AO requires at least one worker"));
    }
    // Idle before busy, then linked before unlinked; the sort is stable, so graph order breaks ties.
    candidates.sort_by_key(|node| (busy(node), !linked(node)));
    let target = candidates[0].id.clone();
    for part in run.review_parts.values_mut() {
        if let Some(at) = part.workers.iter().position(|worker| worker == node_id) {
            part.workers.remove(at);
            if !part.workers.contains(&target) {
                part.workers.push(target.clone());
            }
        }
    }
    let Some(task) = run.assignments.remove(node_id) else {
        return Ok(());
    };
    let merged = match run.assignments.remove(&target) {
        Some(mut own) => {
            own.task = format!(
                "{}

Also, handed over from {}: {}",
                own.task, removed.id, task.task
            )
            .chars()
            .take(4_000)
            .collect();
            if !task.acceptance.is_empty() {
                own.acceptance = format!(
                    "{}
{}",
                    own.acceptance, task.acceptance
                )
                .chars()
                .take(2_000)
                .collect();
            }
            own
        }
        None => task,
    };
    run.assignments.insert(target.clone(), merged);
    let node = run
        .nodes
        .iter_mut()
        .find(|node| node.id == target)
        .expect("target chosen from these nodes");
    match node.state {
        State::Reserved | State::Running => {
            run.rerun_after.insert(target);
        }
        State::Finished | State::Held => interrupt(node),
        _ => {}
    }
    Ok(())
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
    let layout_only = matches!(
        &change,
        GraphChange::MoveNode { .. } | GraphChange::MoveNodes { .. }
    );
    let policy_intact = next
        .grant
        .as_ref()
        .is_some_and(|grant| graph_sha256(data, &next).ok().as_ref() == Some(&grant.graph_sha256));
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
            same_scope = next
                .nodes
                .iter()
                .any(|existing| existing.role == Role::Worker && existing.route == node.route);
            extra_turns = 1 + next.max_review_rounds.saturating_sub(next.review_rounds);
            super::ao_team::attach_worker_role(&mut next, &mut node);
            if next.nodes.iter().any(|existing| {
                matches!(
                    existing.role,
                    Role::ReviewSplit | Role::SubReviewer | Role::Reviewer
                ) && existing.state != State::Pending
            }) {
                return Err(fail("AO review has already started"));
            }
            // The new worker feeds the review: the split pass when there are sub-reviewers, else the reviewer.
            if let Some(approver) = next
                .nodes
                .iter()
                .find(|existing| existing.role == Role::Approver)
            {
                if !node.parents.contains(&approver.id) {
                    node.parents.push(approver.id.clone());
                }
            }
            let review_entry = if next
                .nodes
                .iter()
                .any(|existing| existing.role == Role::ReviewSplit)
            {
                Role::ReviewSplit
            } else {
                Role::Reviewer
            };
            next.nodes
                .iter_mut()
                .find(|existing| existing.role == review_entry)
                .ok_or_else(|| fail("AO reviewer is missing"))?
                .parents
                .push(node.id.clone());
            next.nodes.push(*node);
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
                let node = next
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == position.node_id)
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
            if node.role == Role::Planner {
                if !parents.is_empty() {
                    return Err(fail(
                        "The orchestrator starts the mission and takes no links",
                    ));
                }
            } else {
                if matches!(node.state, State::Reserved | State::Running | State::Held) {
                    // Rewiring a working card stops it: the attempt is kept in its history and the
                    // card runs again from its new links (a late result is ignored).
                    interrupt(node);
                }
                node.parents = parents;
            }
            if node.parents.is_empty() && node.role != Role::Planner {
                let planner = planner_id(&next)?;
                next.nodes
                    .iter_mut()
                    .find(|node| node.id == node_id)
                    .expect("node found above")
                    .parents = vec![planner];
            }
        }
        GraphChange::RemoveNode { node_id } => remove_node(&mut next, &node_id)?,
    }
    validate(Some(data), &next)?;
    // Coordinates are presentation, not an expansion of the execution grant.
    if !layout_only {
        if policy_intact && same_scope {
            let fingerprint = graph_sha256(data, &next)?;
            let grant = next.grant.as_mut().unwrap();
            grant.graph_sha256 = fingerprint;
            grant.max_turns = grant.max_turns.saturating_add(extra_turns);
        } else {
            next.grant = None;
        }
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
    if run.cancelled
        || run.paused
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
    if run.nodes.iter().any(|node| {
        node.request_key.as_deref() == Some(&request_key)
            || node
                .history
                .iter()
                .any(|receipt| receipt.request_key == request_key)
    }) {
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
        approvals: Vec::new(),
        started_at_ms: Some(grant_now_ms.unwrap_or_else(unix_now_ms)),
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

// One terminal receipt names its run, node and turn plus the outcome fields; keeping them as
// explicit parameters matches the other AO receipt recorders.
#[allow(clippy::too_many_arguments)]
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
    // A finished plan must split the work across the workers, and a finished review split
    // must split the review across the sub-reviewers; otherwise the card holds.
    enum Split {
        Plan(BTreeMap<String, Assignment>),
        Review(BTreeMap<String, ReviewPart>),
        Solo,
    }
    let plan = match run
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .map(|node| &node.role)
    {
        Some(Role::Planner) if completed && run.execution_mode == ExecutionMode::Team => answer
            .map(|answer| {
                if is_solo_answer(answer) {
                    Ok(Split::Solo)
                } else {
                    parse_assignments(answer, run).map(Split::Plan)
                }
            }),
        Some(Role::ReviewSplit) if completed => {
            answer.map(|answer| parse_review_parts(answer, run).map(Split::Review))
        }
        _ => None,
    };
    // A card stopped by a graph change keeps its old attempt in history; that turn's late result
    // is ignored instead of failing the mission.
    if run.nodes.iter().any(|node| {
        node.id == node_id
            && node.state != State::Running
            && node
                .history
                .last()
                .and_then(|receipt| receipt.thread_id.as_deref())
                == Some(thread_id)
    }) {
        return Ok(run.clone());
    }
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
    let first_word = answer
        .and_then(|answer| answer.split_whitespace().next())
        .map(|word| word.trim_matches(['*', '`', ':', '.']).replace("\\_", "_"));
    let verdict = match (&node.role, first_word.as_deref()) {
        (Role::Reviewer | Role::Approver, Some("APPROVED")) => Some("APPROVED"),
        (Role::Reviewer | Role::Approver, Some("CHANGES_REQUIRED")) => Some("CHANGES_REQUIRED"),
        (Role::SubReviewer, Some("PART_OK")) => Some("PART_OK"),
        (Role::SubReviewer, Some("PART_FAILED")) => Some("PART_FAILED"),
        _ => None,
    };
    // Gates finish only on approval; a sub-reviewer finishes on either finding.
    let verdict_ok = match node.role {
        Role::Reviewer | Role::Approver => verdict == Some("APPROVED"),
        Role::SubReviewer => verdict.is_some(),
        _ => true,
    };
    receipt.turn_id = turn_id
        .filter(|id| text(id, 128) && !id.contains('/'))
        .map(str::to_owned);
    if completed
        && !failure.is_some_and(|message| message.starts_with("Native approval declined"))
        && turn_id.is_some_and(|id| text(id, 128) && !id.contains('/'))
        && answer.is_some_and(|value| !value.trim().is_empty() && value.len() <= 12_000)
        && verdict_ok
        && !matches!(plan, Some(Err(_)))
    {
        receipt.turn_id = turn_id.map(str::to_owned);
        receipt.answer = answer.map(str::to_owned);
        receipt.verdict = verdict.map(str::to_owned);
        receipt.status = "completed".into();
        node.state = State::Finished;
        let solo = matches!(plan, Some(Ok(Split::Solo)));
        match plan {
            Some(Ok(Split::Plan(assignments))) => run.assignments = assignments,
            Some(Ok(Split::Review(parts))) => run.review_parts = parts,
            _ => {}
        }
        if solo {
            // Every other card is skipped: finished without running, so the mission completes.
            run.solo = true;
            for other in run
                .nodes
                .iter_mut()
                .filter(|other| other.id != node_id && other.state == State::Pending)
            {
                other.state = State::Finished;
            }
        }
        // Work handed to this worker while it was busy runs now.
        if run.rerun_after.remove(node_id) {
            if let Some(node) = run.nodes.iter_mut().find(|node| node.id == node_id) {
                interrupt(node);
            }
        }
    } else {
        if answer.is_some_and(|value| !value.trim().is_empty() && value.len() <= 12_000) {
            receipt.answer = answer.map(str::to_owned);
            receipt.verdict = verdict.map(str::to_owned);
        }
        receipt.status = "held".into();
        let plan_error = match plan {
            Some(Err(message)) => Some(message),
            _ => None,
        };
        let mut error = failure
            .filter(|value| !value.trim().is_empty())
            .or(plan_error)
            .unwrap_or_else(|| {
                if verdict == Some("CHANGES_REQUIRED") && node.role == Role::Approver {
                    "Command approver sent the plan back"
                } else if verdict == Some("CHANGES_REQUIRED") {
                    "Reviewer requested changes"
                } else if completed && node.role == Role::SubReviewer {
                    "Sub-reviewer gave no PART_OK or PART_FAILED verdict"
                } else if completed {
                    "Native turn returned no verifiable final answer"
                } else {
                    "Native turn failed before a final answer"
                }
            })
            .to_owned();
        crate::tools::history::redact_text(&mut error);
        receipt.error = Some(error.chars().take(2048).collect());
        node.state = State::Held;
    }
    run.revision += 1;
    Ok(run.clone())
}

/// Records the command approver's decision on a running card's tool request, before it is
/// answered. Only a mission whose background grant is valid and whose approver has approved
/// the plan may decide this way; allowing also needs the approver's auto-decide setting.
#[allow(clippy::too_many_arguments)] // Mirrors the headless approval request's fields one to one.
pub fn record_approver_decision(
    data: &mut AppData,
    workspace_id: &str,
    run_id: &str,
    node_id: &str,
    allow: bool,
    reason: &str,
    request: &str,
    now_ms: u64,
) -> AppResult<()> {
    let index = data
        .ao_runs
        .iter()
        .position(|run| run.id == run_id && run.workspace_id == workspace_id)
        .ok_or_else(|| fail("AO run not found"))?;
    let executable = data.ao_runs[index]
        .grant
        .as_ref()
        .ok_or_else(|| fail("Automatic approval needs a running background grant"))?
        .executable_sha256
        .clone();
    grant_valid(data, &data.ao_runs[index], now_ms, &executable)?;
    let run = &mut data.ao_runs[index];
    let approver = run
        .nodes
        .iter()
        .find(|node| {
            node.role == Role::Approver
                && node.state == State::Finished
                && node
                    .receipt
                    .as_ref()
                    .and_then(|receipt| receipt.verdict.as_deref())
                    == Some("APPROVED")
        })
        .ok_or_else(|| fail("This mission has no command approver that approved the plan"))?;
    if allow && !approver.settings.auto_decide {
        return Err(fail(
            "The command approver only recommends; turn on auto-decide to let it allow requests",
        ));
    }
    let receipt = run
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id && node.state == State::Running)
        .and_then(|node| node.receipt.as_mut())
        .ok_or_else(|| fail("AO node has no active turn"))?;
    if receipt.approvals.len() >= 100 {
        receipt.approvals.remove(0);
    }
    let mut entry = format!(
        "{} · {} · {}",
        if allow { "allowed" } else { "denied" },
        clip(reason.trim(), 300),
        clip(request.trim(), 300)
    );
    crate::tools::history::redact_text(&mut entry);
    receipt.approvals.push(entry);
    run.revision += 1;
    Ok(())
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
    fn labelled_blocks_are_read_when_the_web_bridge_flattens_code_fences() {
        // Exactly what the WebGPT orchestrator returned in a live run: the ```solo fence came
        // back as a bare "solo" line followed by inline code.
        let live = "391\n\n17 multiplied by 23 equals 391.\n\nsolo\n\n`{\"difficulty\":\"simple\",\"reason\":\"arithmetic\"}`";
        assert!(is_solo_answer(live));
        let (_, body) = labelled_block(live, "solo").unwrap();
        assert!(body.contains("\"simple\""));
        // Fenced, flattened-with-fence, inline and bare JSON forms of a plan all read the same.
        let list = r#"[{"worker":"w","task":"t"}]"#;
        for form in [
            format!("Plan\n```assignments\n{list}\n```"),
            format!("Plan\nassignments\n```json\n{list}\n```"),
            format!("Plan\nassignments\n\n`{list}`"),
            format!("Plan\nassignments\n{list}\ntrailing words"),
        ] {
            assert_eq!(
                labelled_block(&form, "assignments").unwrap().1,
                list,
                "{form}"
            );
            assert!(!is_solo_answer(&form));
        }
        // The word on its own inside prose is not a block without a body after it.
        assert!(labelled_block("I chose solo\nbecause it is simple", "solo").is_none());
        assert!(labelled_block("rework\n\n`[\"w\"]`", "rework").is_some());
    }

    #[test]
    fn ao_planner_assignments_map_each_worker_card_once() {
        let route = json!({"harness_id":"ao:codex","provider_id":"agent-orchestrator",
            "account_id":"ao-local","model":"cpa/luna","permission_profile":":ao-default"});
        let mut run: Run = serde_json::from_value(json!({"id":"run","workspace_id":"qa","project_id":"p","revision":0,"nodes":[
            {"id":"planner","task_id":"t","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":route},
            {"id":"w1","task_id":"t","role":"worker","parents":["planner"],"x":0,"y":1,"state":"pending","route":route,
                "settings":{"name":"Frontend","specialty":"frontend"}},
            {"id":"w2","task_id":"t","role":"worker","parents":["planner"],"x":1,"y":1,"state":"pending","route":route},
            {"id":"reviewer","task_id":"t","role":"reviewer","parents":["w1","w2"],"x":0,"y":2,"state":"pending","route":route}
        ]})).unwrap();
        let block = |items: &str| format!("Plan.\n```assignments\n{items}\n```\nDone.");
        // Cards are matched by id or by name; text before and after the block is ignored.
        let parsed = parse_assignments(&block(r#"[{"worker":"Frontend","task":"Build the page","acceptance":"Renders"},{"worker":"`w2`","task":"Write tests"}]"#), &run).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed["w1"].acceptance, "Renders");
        assert_eq!(parsed["w2"].task, "Write tests");
        assert!(parse_assignments("No block here", &run).is_err());
        assert!(
            parse_assignments("```assignments\n[{\"worker\":\"w1\",\"task\":\"x\"}]", &run)
                .is_err(),
            "unclosed block"
        );
        assert!(
            parse_assignments(&block(r#"[{"worker":"planner","task":"x"}]"#), &run).is_err(),
            "only workers take assignments"
        );
        assert!(
            parse_assignments(
                &block(r#"[{"worker":"w1","task":"a"},{"worker":"w1","task":"b"}]"#),
                &run
            )
            .is_err(),
            "duplicate worker"
        );
        assert!(
            parse_assignments(&block(r#"[{"worker":"w1","task":"  "}]"#), &run).is_err(),
            "empty task"
        );
        assert!(parse_assignments(&block("[]"), &run).is_err());
        // Stored assignments must stay inside this mission's workers.
        run.assignments = parsed;
        assert!(validate(None, &run).is_ok());
        run.assignments.insert(
            "ghost".into(),
            Assignment {
                task: "x".into(),
                acceptance: String::new(),
            },
        );
        assert!(validate(None, &run).is_err());
    }

    #[test]
    fn ao_harness_workers_need_the_exact_external_route() {
        let route = |harness: &str, provider: &str, permission: &str| -> Route {
            serde_json::from_value(json!({"harness_id":harness,"provider_id":provider,
                "account_id":EXTERNAL_ACCOUNT,"model":"default","permission_profile":permission}))
            .unwrap()
        };
        assert_eq!(
            external_harness(&route(
                "ao:claude-code",
                EXTERNAL_PROVIDER,
                EXTERNAL_PERMISSION
            )),
            Some("claude-code")
        );
        assert!(external_route_valid(&route(
            "ao:opencode",
            EXTERNAL_PROVIDER,
            EXTERNAL_PERMISSION
        )));
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
        // Native Codex runs only WebGPT: a CPA model on it is refused for a card yet to start.
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
            "account_id":"shared-cpa-pool","model":"claude-sonnet-4-6","permission_profile":":read-only"}))).is_err());
        // Every WebGPT tier the bridge serves is allowed, but only on Native Codex.
        assert!(validate(None, &run(json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/extra-high","permission_profile":":read-only"}))).is_ok());
        assert!(validate(None, &run(json!({"harness_id":"ao:codex","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/pro","permission_profile":":read-only"}))).is_err());
    }

    #[test]
    fn ao_card_effort_and_context_window_are_checked_and_only_stored_when_set() {
        let run = |tuning: serde_json::Value| -> Run {
            let mut route = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
                "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
            route
                .as_object_mut()
                .unwrap()
                .extend(tuning.as_object().unwrap().clone());
            serde_json::from_value(json!({"id":"run","workspace_id":"qa","project_id":"p","revision":0,"nodes":[
                {"id":"planner","task_id":"t","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":route},
                {"id":"worker","task_id":"t","role":"worker","parents":["planner"],"x":0,"y":1,"state":"pending","route":route},
                {"id":"reviewer","task_id":"t","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":route}
            ]})).unwrap()
        };
        assert!(validate(None, &run(json!({}))).is_ok());
        assert!(validate(
            None,
            &run(json!({"effort":"xhigh","context_window":262_144}))
        )
        .is_ok());
        for bad in [
            json!({"effort":"max"}),
            json!({"effort":""}),
            json!({"context_window":1_024}),
            json!({"context_window":4_000_000}),
        ] {
            assert!(validate(None, &run(bad.clone())).is_err(), "{bad}");
        }
        // An untuned route serializes exactly as before, so existing grants keep their fingerprint.
        let plain = serde_json::to_value(&run(json!({})).nodes[0].route).unwrap();
        assert!(plain.get("effort").is_none() && plain.get("context_window").is_none());
    }

    #[test]
    fn ao_webgpt_runs_only_on_native_codex_for_every_role() {
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let external = |model: &str| {
            json!({"harness_id":"ao:codex","provider_id":EXTERNAL_PROVIDER,
            "account_id":EXTERNAL_ACCOUNT,"model":model,"permission_profile":EXTERNAL_PERMISSION})
        };
        let cpa = |model: &str| {
            json!({"harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
            "account_id":"shared-cpa-pool","model":model,"permission_profile":":read-only"})
        };
        let run = |lead: &serde_json::Value,
                   worker: &serde_json::Value,
                   reviewer: &serde_json::Value|
         -> Run {
            serde_json::from_value(json!({"id":"run","workspace_id":"qa","project_id":"p","revision":0,"nodes":[
                {"id":"planner","task_id":"t","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":lead},
                {"id":"worker","task_id":"t","role":"worker","parents":["planner"],"x":0,"y":1,"state":"pending","route":worker},
                {"id":"reviewer","task_id":"t","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":reviewer}
            ]})).unwrap()
        };
        assert!(validate(None, &run(&web, &web, &web)).is_ok());
        // An AO harness keeps its own models and every non-WebGPT CPA model.
        assert!(validate(
            None,
            &run(
                &external("default"),
                &external("cpa/gemini-3.8-flash-high"),
                &web
            )
        )
        .is_ok());
        for bad in [
            external("chatgpt-web/high"),
            external("cpa/chatgpt-web/high"),
            cpa("chatgpt-web/high"),
        ] {
            for nodes in [(&bad, &web, &web), (&web, &bad, &web), (&web, &web, &bad)] {
                let error = validate(None, &run(nodes.0, nodes.1, nodes.2)).unwrap_err();
                assert!(
                    error
                        .to_string()
                        .contains("WebGPT runs only on Native Codex"),
                    "{error}"
                );
            }
        }
    }

    #[test]
    fn ao_orchestrator_and_reviewer_may_use_any_webgpt_tier_on_native_codex_or_an_ao_harness() {
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
            "account_id":"shared-cpa-pool","model":"claude-sonnet-4-6","permission_profile":":read-only"}))).is_err());
        // The orchestrator and reviewer may also run on an AO harness such as Claude Code.
        assert!(validate(None, &run(json!({"harness_id":"ao:claude-code","provider_id":EXTERNAL_PROVIDER,
            "account_id":EXTERNAL_ACCOUNT,"model":"default","permission_profile":EXTERNAL_PERMISSION}))).is_ok());
        assert!(validate(
            None,
            &run(
                json!({"harness_id":"ao:claude-code","provider_id":EXTERNAL_PROVIDER,
            "account_id":EXTERNAL_ACCOUNT,"model":"default","permission_profile":":read-only"})
            )
        )
        .is_err());
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
        let worker = json!({"harness_id":"ao:codex","provider_id":"agent-orchestrator",
            "account_id":"ao-local","model":"cpa/gemini-3.8-flash-high","permission_profile":":ao-default"});
        let run: Run = serde_json::from_value(json!({
            "id":"run","workspace_id":"qa","project_id":"project","revision":0,"max_review_rounds":2,
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
        let moved_active = update_graph(
            &mut granted,
            "qa",
            "run",
            started.revision,
            GraphChange::MoveNode {
                node_id: "planner".into(),
                x: 320,
                y: 80,
            },
        )
        .unwrap();
        assert_eq!(moved_active.nodes[0].state, State::Reserved);
        assert!(grant_valid(&granted, &moved_active, 1_002, &sha).is_ok());
        let group_move = serde_json::from_value(json!({"operation":"move_nodes","positions":[
            {"node_id":"planner","x":400,"y":100}, {"node_id":"worker","x":400,"y":300}
        ]}))
        .unwrap();
        let grouped =
            update_graph(&mut granted, "qa", "run", moved_active.revision, group_move).unwrap();
        assert_eq!((grouped.nodes[0].x, grouped.nodes[1].x), (400, 400));
        assert_eq!(grouped.revision, moved_active.revision + 1);
        assert!(grant_valid(&granted, &grouped, 1_002, &sha).is_ok());
        for positions in [
            json!([]),
            json!([{"node_id":"planner","x":0,"y":0},{"node_id":"missing","x":0,"y":0}]),
            json!([{"node_id":"worker","x":0,"y":0},{"node_id":"worker","x":1,"y":0}]),
            json!([{"node_id":"planner","x":10001,"y":0}]),
        ] {
            let change =
                serde_json::from_value(json!({"operation":"move_nodes","positions":positions}))
                    .unwrap();
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
        let failed_run = record_terminal(
            &mut failed,
            "qa",
            "run",
            "planner",
            "thread-one",
            Some("failed-turn"),
            None,
            false,
            Some("407: Bearer private-test-token"),
        )
        .unwrap();
        assert_eq!(
            failed_run.nodes[0]
                .receipt
                .as_ref()
                .unwrap()
                .turn_id
                .as_deref(),
            Some("failed-turn")
        );
        assert_eq!(
            failed_run.nodes[0]
                .receipt
                .as_ref()
                .unwrap()
                .error
                .as_deref(),
            Some("407: Bearer [REDACTED]")
        );
        let mut denied = data.clone();
        let denied = record_terminal(
            &mut denied,
            "qa",
            "run",
            "planner",
            "thread-one",
            Some("denied-turn"),
            Some("The requested tool could not run."),
            true,
            Some("Native approval declined (unsupported request)"),
        )
        .unwrap();
        assert_eq!(denied.nodes[0].state, State::Held);
        assert_eq!(
            denied.nodes[0].receipt.as_ref().unwrap().answer.as_deref(),
            Some("The requested tool could not run.")
        );
        // The planner is told the worker roster and must not clone itself.
        let planner_prompt = prompt_for_node(&data, &data.ao_runs[0], "planner").unwrap();
        assert!(
            planner_prompt.contains("id `worker`") && planner_prompt.contains("```assignments")
        );
        assert!(planner_prompt.contains("Do not use your own sub-agent"));
        // A plan that does not split the work across the workers holds instead of finishing.
        let mut unsplit = data.clone();
        let unsplit = record_terminal(
            &mut unsplit,
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
        assert_eq!(unsplit.nodes[0].state, State::Held);
        assert!(unsplit.nodes[0]
            .receipt
            .as_ref()
            .unwrap()
            .error
            .as_deref()
            .unwrap()
            .contains("assignments"));
        // The orchestrator may judge the mission simple and answer it alone: every other card is
        // skipped, so the whole mission is finished without any worker or reviewer running.
        assert!(
            planner_prompt.contains("```solo") && planner_prompt.contains("judge how difficult")
        );
        let mut simple = data.clone();
        let solo = record_terminal(
            &mut simple,
            "qa",
            "run",
            "planner",
            "thread-one",
            Some("turn-one"),
            Some("The answer is 42.\n```solo\n{\"difficulty\":\"simple\",\"reason\":\"a direct question\"}\n```"),
            true,
            None,
        )
        .unwrap();
        assert!(solo.solo);
        assert!(solo.nodes.iter().all(|node| node.state == State::Finished));
        assert!(solo
            .nodes
            .iter()
            .filter(|node| node.id != "planner")
            .all(|node| node.receipt.is_none()));
        assert!(validate(Some(&simple), &solo).is_ok());
        // A solo block followed by an assignments block is a plan, not a solo answer.
        assert!(!is_solo_answer(
            "x\n```solo\n{}\n```\n```assignments\n[]\n```"
        ));
        let run = record_terminal(
            &mut data,
            "qa",
            "run",
            "planner",
            "thread-one",
            Some("turn-one"),
            Some("Plan answer\n```assignments\n[{\"worker\":\"worker\",\"task\":\"Write the short answer\",\"acceptance\":\"One sentence\"}]\n```"),
            true,
            None,
        )
        .unwrap();
        assert!(parents_finished(&run, "worker"));
        assert_eq!(run.assignments["worker"].task, "Write the short answer");
        let worker_prompt = prompt_for_node(&data, &run, "worker").unwrap();
        assert!(worker_prompt
            .contains("Your assignment:\nWrite the short answer\nDone when: One sentence"));
        assert!(worker_prompt.contains("Plan answer") && !worker_prompt.contains("```assignments"));
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
        rework.ao_runs[0].grant = Some(RunGrant {
            graph_sha256: fingerprint,
            executable_sha256: sha.clone(),
            granted_at_ms: 1000,
            expires_at_ms: 3_601_000,
            max_turns: 7,
            turns_started: 3,
        });
        let mut unknown = rework.clone();
        unknown.ao_runs[0].nodes[2]
            .receipt
            .as_mut()
            .unwrap()
            .turn_id = None;
        assert!(crate::integrations::ao_team::queue_rework(
            &mut unknown,
            "qa",
            "run",
            "reviewer",
            "four",
            1001
        )
        .unwrap()
        .is_none());
        for round in 1..=2 {
            let key = rework.ao_runs[0].nodes[2]
                .receipt
                .as_ref()
                .unwrap()
                .request_key
                .clone();
            let queued = crate::integrations::ao_team::queue_rework(
                &mut rework,
                "qa",
                "run",
                "reviewer",
                &key,
                1001,
            )
            .unwrap()
            .unwrap();
            assert_eq!(queued.review_rounds, round);
            assert_eq!(queued.nodes[1].state, State::Pending);
            assert_eq!(queued.nodes[1].history.len(), usize::from(round));
            assert!(prompt_for_node(&rework, &queued, "worker")
                .unwrap()
                .contains("review feedback"));
            assert!(reserve(
                &mut rework,
                "qa",
                "run",
                "worker",
                queued.revision,
                "three".into(),
                Some(1001)
            )
            .is_err());
            for role in ["worker", "reviewer"] {
                let revision = rework.ao_runs[0].revision;
                let key = format!("rework-{round}-{role}");
                let thread = format!("thread-{key}");
                reserve(
                    &mut rework,
                    "qa",
                    "run",
                    role,
                    revision,
                    key.clone(),
                    Some(1001),
                )
                .unwrap();
                record_submission(&mut rework, "qa", "run", role, &key, Some(&thread)).unwrap();
                record_terminal(
                    &mut rework,
                    "qa",
                    "run",
                    role,
                    &thread,
                    Some(&format!("turn-{key}")),
                    Some(if role == "worker" {
                        "Revised work"
                    } else {
                        "**CHANGES_REQUIRED**: verify once more"
                    }),
                    true,
                    None,
                )
                .unwrap();
            }
        }
        let key = rework.ao_runs[0].nodes[2]
            .receipt
            .as_ref()
            .unwrap()
            .request_key
            .clone();
        let held = crate::integrations::ao_team::queue_rework(
            &mut rework,
            "qa",
            "run",
            "reviewer",
            &key,
            1001,
        )
        .unwrap()
        .unwrap();
        assert_eq!(held.review_rounds, 2);
        assert_eq!(held.nodes[2].state, State::Held);
        assert!(held.nodes[2]
            .receipt
            .as_ref()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .contains("after 2 rework rounds"));
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

    #[test]
    fn ao_approver_and_review_hierarchy_send_back_only_what_needs_redoing() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .canonicalize()
            .unwrap();
        let mut data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":workspace.to_string_lossy(),
                "tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"task","workspace_id":"qa","title":"Ship it",
                "description":"Build and test","state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        })).unwrap();
        let web = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let cpa = json!({"harness_id":"ao:codex","provider_id":"agent-orchestrator",
            "account_id":"ao-local","model":"cpa/luna","permission_profile":":ao-default"});
        let node = |id: &str, role: &str, route: &serde_json::Value, name: &str| {
            json!({"id":id,"task_id":"task","role":role,
            "parents":[],"x":0,"y":0,"state":"pending","route":route,"settings":{"name":name}})
        };
        // The team lists roles only; the wiring (approver, split pass) is generated.
        let mut nodes: Vec<Node> = serde_json::from_value(json!([
            node("lead", "planner", &web, "Orchestrator"),
            node("gate", "approver", &cpa, "Command approver"),
            node("front", "worker", &cpa, "Frontend"),
            node("tests", "worker", &cpa, "Testing"),
            node("sub-a", "sub_reviewer", &cpa, "UI check"),
            node("sub-b", "sub_reviewer", &cpa, "Test check"),
            node("main", "reviewer", &web, "Main reviewer"),
        ]))
        .unwrap();
        crate::integrations::ao_team::normalize_roles(&mut nodes);
        let split_id = nodes
            .iter()
            .find(|node| node.role == Role::ReviewSplit)
            .expect("split pass generated")
            .id
            .clone();
        assert_eq!(
            nodes
                .iter()
                .find(|node| node.id == "front")
                .unwrap()
                .parents,
            vec!["lead", "gate"]
        );
        assert_eq!(
            nodes.iter().find(|node| node.id == "main").unwrap().parents,
            vec!["sub-a", "sub-b"]
        );
        let mut run: Run = serde_json::from_value(
            json!({"id":"run","workspace_id":"qa","project_id":"project","revision":0,"nodes":[]}),
        )
        .unwrap();
        run.nodes = nodes;
        assert_eq!(run.max_review_rounds, DEFAULT_REVIEW_ROUNDS);
        create(&mut data, 1, run).unwrap();
        let sha = "a".repeat(64);
        let granted = grant_run(&mut data, "qa", "run", 1, &sha, 1_000).unwrap();
        // planner 1+2, approver 1+2, 2 workers x(1+3), split, 2 subs, reviewer x(1+3) = 30
        assert_eq!(granted.grant.as_ref().unwrap().max_turns, 30);
        let mut key = 0;
        let mut turn = |data: &mut AppData, id: &str, answer: &str| -> Run {
            key += 1;
            let revision = data.ao_runs[0].revision;
            reserve(
                data,
                "qa",
                "run",
                id,
                revision,
                format!("k{key}"),
                Some(1_001),
            )
            .unwrap();
            record_submission(
                data,
                "qa",
                "run",
                id,
                &format!("k{key}"),
                Some(&format!("t{key}")),
            )
            .unwrap();
            record_terminal(
                data,
                "qa",
                "run",
                id,
                &format!("t{key}"),
                Some(&format!("turn{key}")),
                Some(answer),
                true,
                None,
            )
            .unwrap()
        };
        let plan = "Plan\n```assignments\n[{\"worker\":\"front\",\"task\":\"Build the page\"},{\"worker\":\"Testing\",\"task\":\"Test it\"}]\n```";
        turn(&mut data, "lead", plan);
        assert!(prompt_for_node(&data, &data.ao_runs[0], "gate")
            .unwrap()
            .contains("Build the page"));
        // The approver sends the plan back once; the planner sees why and plans again.
        let held = turn(
            &mut data,
            "gate",
            "CHANGES_REQUIRED: do not run rm -rf on the build folder",
        );
        assert_eq!(held.nodes[1].state, State::Held);
        let request = held.nodes[1].receipt.as_ref().unwrap().request_key.clone();
        let replanned = crate::integrations::ao_team::queue_rework(
            &mut data, "qa", "run", "gate", &request, 1_001,
        )
        .unwrap()
        .unwrap();
        assert_eq!(replanned.plan_rounds, 1);
        assert!(prompt_for_node(&data, &replanned, "lead")
            .unwrap()
            .contains("rm -rf"));
        turn(&mut data, "lead", plan);
        turn(&mut data, "gate", "APPROVED: safe");
        assert!(prompt_for_node(&data, &data.ao_runs[0], "front")
            .unwrap()
            .contains("Command approver's note"));
        // While a worker runs, the approver may deny on its own but allows only with auto-decide on.
        let revision = data.ao_runs[0].revision;
        reserve(
            &mut data,
            "qa",
            "run",
            "front",
            revision,
            "front-key".into(),
            Some(1_001),
        )
        .unwrap();
        record_submission(
            &mut data,
            "qa",
            "run",
            "front",
            "front-key",
            Some("front-thread"),
        )
        .unwrap();
        record_approver_decision(
            &mut data,
            "qa",
            "run",
            "front",
            false,
            "Touches .env",
            "cat .env token=sk-test-123456789012345678",
            1_001,
        )
        .unwrap();
        assert!(
            record_approver_decision(
                &mut data, "qa", "run", "front", true, "safe", "npm test", 1_001
            )
            .is_err(),
            "recommend-only approver cannot allow"
        );
        // Changing the approver's settings re-fingerprints the grant, as applying a team does.
        data.ao_runs[0]
            .nodes
            .iter_mut()
            .find(|node| node.id == "gate")
            .unwrap()
            .settings
            .auto_decide = true;
        let fingerprint = graph_sha256(&data, &data.ao_runs[0]).unwrap();
        data.ao_runs[0].grant.as_mut().unwrap().graph_sha256 = fingerprint;
        record_approver_decision(
            &mut data,
            "qa",
            "run",
            "front",
            true,
            "Runs the tests",
            "npm test",
            1_001,
        )
        .unwrap();
        let log = &data.ao_runs[0]
            .nodes
            .iter()
            .find(|node| node.id == "front")
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .approvals;
        assert_eq!(log.len(), 2);
        assert!(
            log[0].starts_with("denied · Touches .env") && !log[0].contains("sk-test-1234567890"),
            "secrets are redacted: {}",
            log[0]
        );
        assert!(log[1].starts_with("allowed · Runs the tests"));
        assert!(
            record_approver_decision(&mut data, "qa", "run", "tests", false, "x", "y", 1_001)
                .is_err(),
            "only running cards"
        );
        record_terminal(
            &mut data,
            "qa",
            "run",
            "front",
            "front-thread",
            Some("front-turn"),
            Some("Built the page"),
            true,
            None,
        )
        .unwrap();
        turn(&mut data, "tests", "Tests fail on Safari");
        // The split pass must cover every worker; then each sub-reviewer sees only its part.
        let parts = "Split\n```review-parts\n[{\"sub_reviewer\":\"sub-a\",\"workers\":[\"front\"],\"check\":\"layout\"},{\"sub_reviewer\":\"Test check\",\"workers\":[\"tests\"]}]\n```";
        let split = turn(&mut data, &split_id, parts);
        assert_eq!(split.review_parts["sub-a"].workers, vec!["front"]);
        let sub_a = prompt_for_node(&data, &split, "sub-a").unwrap();
        assert!(
            sub_a.contains("Built the page")
                && !sub_a.contains("Tests fail on Safari")
                && sub_a.contains("PART_OK")
        );
        turn(&mut data, "sub-a", "PART_OK layout matches");
        let sub_b = turn(&mut data, "sub-b", "**PART_FAILED** Safari tests fail");
        assert_eq!(
            sub_b
                .nodes
                .iter()
                .find(|node| node.id == "sub-b")
                .unwrap()
                .receipt
                .as_ref()
                .unwrap()
                .verdict
                .as_deref(),
            Some("PART_FAILED")
        );
        // The main reviewer sends back only the testing worker, plus the review chain.
        let reviewed = turn(
            &mut data,
            "main",
            "CHANGES_REQUIRED: Safari\n```rework\n[\"tests\"]\n```",
        );
        let request = reviewed
            .nodes
            .iter()
            .find(|node| node.id == "main")
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .request_key
            .clone();
        let rework = crate::integrations::ao_team::queue_rework(
            &mut data, "qa", "run", "main", &request, 1_001,
        )
        .unwrap()
        .unwrap();
        let state = |id: &str| {
            rework
                .nodes
                .iter()
                .find(|node| node.id == id)
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state("tests"), State::Pending);
        assert_eq!(
            state("front"),
            State::Finished,
            "untargeted workers keep their finished work"
        );
        assert_eq!(state("lead"), State::Finished);
        assert_eq!(state("gate"), State::Finished);
        for id in [split_id.as_str(), "sub-a", "sub-b", "main"] {
            assert_eq!(state(id), State::Pending);
        }
        assert_eq!(rework.review_rounds, 1);
        assert!(rework.review_parts.is_empty());
        assert!(prompt_for_node(&data, &rework, "tests")
            .unwrap()
            .contains("Prior review feedback"));
    }

    fn free_link_fixture(nodes: serde_json::Value) -> AppData {
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
        let run: Run = serde_json::from_value(json!({
            "id":"run","workspace_id":"qa","project_id":"project","revision":0,"max_review_rounds":2,
            "nodes":nodes
        }))
        .unwrap();
        create(&mut data, 1, run).unwrap();
        data
    }

    fn free_link_node(id: &str, role: &str, parents: &[&str]) -> serde_json::Value {
        let route = if role == "worker" {
            json!({"harness_id":"ao:codex","provider_id":"agent-orchestrator",
                "account_id":"ao-local","model":"cpa/gemini-3.8-flash-high","permission_profile":":ao-default"})
        } else {
            json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
                "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"})
        };
        json!({"id":id,"task_id":"task","role":role,"parents":parents,"x":0,"y":0,"state":"pending","route":route})
    }

    #[test]
    fn ao_links_are_free_but_the_orchestrator_stays_the_only_start() {
        // A chain the old fixed shape refused: the reviewer reviews only the last worker.
        let mut data = free_link_fixture(json!([
            free_link_node("planner", "planner", &[]),
            free_link_node("w1", "worker", &["planner"]),
            free_link_node("w2", "worker", &["w1"]),
            free_link_node("reviewer", "reviewer", &["w2"]),
        ]));
        // Unlinking every input of a card leaves it waiting on the orchestrator.
        let unlinked = update_graph(
            &mut data,
            "qa",
            "run",
            1,
            GraphChange::SetParents {
                node_id: "reviewer".into(),
                parents: vec![],
            },
        )
        .unwrap();
        let reviewer = unlinked
            .nodes
            .iter()
            .find(|node| node.id == "reviewer")
            .unwrap();
        assert_eq!(reviewer.parents, vec!["planner".to_string()]);
        // The orchestrator never takes links, and cycles are still refused.
        assert!(update_graph(
            &mut data,
            "qa",
            "run",
            unlinked.revision,
            GraphChange::SetParents {
                node_id: "planner".into(),
                parents: vec!["w1".into()]
            }
        )
        .is_err());
        assert!(update_graph(
            &mut data,
            "qa",
            "run",
            unlinked.revision,
            GraphChange::SetParents {
                node_id: "w1".into(),
                parents: vec!["w2".into()]
            }
        )
        .is_err());
        assert!(update_graph(
            &mut data,
            "qa",
            "run",
            unlinked.revision,
            GraphChange::RemoveNode {
                node_id: "planner".into()
            }
        )
        .is_err());
    }

    #[test]
    fn ao_removing_a_worker_hands_its_links_and_task_to_another_worker() {
        let mut data = free_link_fixture(json!([
            free_link_node("planner", "planner", &[]),
            free_link_node("w1", "worker", &["planner"]),
            free_link_node("w2", "worker", &["w1"]),
            free_link_node("reviewer", "reviewer", &["w2"]),
        ]));
        data.ao_runs[0].assignments.insert(
            "w1".into(),
            Assignment {
                task: "Fix the parser".into(),
                acceptance: "tests pass".into(),
            },
        );
        data.ao_runs[0].assignments.insert(
            "w2".into(),
            Assignment {
                task: "Update the docs".into(),
                acceptance: String::new(),
            },
        );
        let revision = data.ao_runs[0].revision;
        let removed = update_graph(
            &mut data,
            "qa",
            "run",
            revision,
            GraphChange::RemoveNode {
                node_id: "w1".into(),
            },
        )
        .unwrap();
        assert!(removed.nodes.iter().all(|node| node.id != "w1"));
        let w2 = removed.nodes.iter().find(|node| node.id == "w2").unwrap();
        assert_eq!(
            w2.parents,
            vec!["planner".to_string()],
            "w2 inherits w1's links"
        );
        let handed = &removed.assignments["w2"];
        assert!(handed.task.starts_with("Update the docs"));
        assert!(handed.task.contains("handed over from w1: Fix the parser"));
        assert!(handed.acceptance.contains("tests pass"));
        assert!(
            removed.rerun_after.is_empty(),
            "an idle worker takes the task at once"
        );
    }

    #[test]
    fn ao_a_busy_worker_queues_handed_over_work_and_a_rewired_card_stops() {
        let mut data = free_link_fixture(json!([
            free_link_node("planner", "planner", &[]),
            free_link_node("w1", "worker", &["planner"]),
            free_link_node("w2", "worker", &["planner"]),
            free_link_node("reviewer", "reviewer", &["w1", "w2"]),
        ]));
        data.ao_runs[0].assignments.insert(
            "w1".into(),
            Assignment {
                task: "Fix the parser".into(),
                acceptance: String::new(),
            },
        );
        // w2 is mid-turn on a native thread.
        {
            let w2 = data.ao_runs[0]
                .nodes
                .iter_mut()
                .find(|node| node.id == "w2")
                .unwrap();
            w2.state = State::Running;
            w2.request_key = Some("key-2".into());
            w2.receipt = Some(Receipt {
                request_key: "key-2".into(),
                status: "submitted".into(),
                thread_id: Some("thread-2".into()),
                turn_id: None,
                answer: None,
                verdict: None,
                error: None,
                settings: None,
                route: w2.route.clone(),
                approvals: vec![],
                started_at_ms: None,
            });
        }
        let revision = data.ao_runs[0].revision;
        let removed = update_graph(
            &mut data,
            "qa",
            "run",
            revision,
            GraphChange::RemoveNode {
                node_id: "w1".into(),
            },
        )
        .unwrap();
        assert!(
            removed.rerun_after.contains("w2"),
            "the only worker is busy, so the task waits for it"
        );
        assert_eq!(
            removed
                .nodes
                .iter()
                .find(|node| node.id == "w2")
                .unwrap()
                .state,
            State::Running
        );
        // Rewiring the busy card stops it; its old turn's late result is then ignored.
        let rewired = update_graph(
            &mut data,
            "qa",
            "run",
            removed.revision,
            GraphChange::SetParents {
                node_id: "w2".into(),
                parents: vec!["planner".into()],
            },
        )
        .unwrap();
        let w2 = rewired.nodes.iter().find(|node| node.id == "w2").unwrap();
        assert_eq!(w2.state, State::Pending);
        assert_eq!(
            w2.history
                .last()
                .and_then(|receipt| receipt.thread_id.as_deref()),
            Some("thread-2")
        );
        let late = record_terminal(
            &mut data,
            "qa",
            "run",
            "w2",
            "thread-2",
            Some("turn"),
            Some("done"),
            true,
            None,
        )
        .unwrap();
        assert_eq!(
            late.revision, rewired.revision,
            "a stopped turn's result changes nothing"
        );
    }
}

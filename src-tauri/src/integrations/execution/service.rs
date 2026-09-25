//! Shared GUI/MCP execution admission. Provider credentials are RAM-only and
//! supplied by local operator consent, never by MCP task arguments. Background
//! workers survive a dropped HTTP waiter; no failed write is auto-replayed.
use super::{
    book::{Binding, Entry, OrchestrationRecord},
    model::*,
    observation, protocol, transport,
};
use crate::{
    data::{AppData, DataStore},
    error::{AppError, AppResult},
    integrations::board_sync,
    tools::{registry, ToolContext},
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
fn fail(s: impl Into<String>) -> AppError {
    AppError::Message(s.into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn runtime() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
fn stamp(ctx: &ToolContext) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{:?}|{}", ctx.policy, ctx.tool_profile).as_bytes())
    )
}
pub fn scope(ctx: &ToolContext, data: &AppData) -> AppResult<String> {
    if !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth" | "api_key") {
        return Err(fail("Authenticated workspace access required"));
    }
    let id = ctx
        .workspace_id
        .as_deref()
        .ok_or_else(|| fail("Workspace-bound listener required"))?;
    let p = data
        .profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| fail("Workspace no longer exists"))?;
    if std::path::Path::new(&p.path).canonicalize()? != ctx.workspace.root() {
        return Err(fail("Workspace changed; execution denied"));
    }
    ctx.workspace
        .ensure_roots_current()
        .map_err(|e| fail(e.message()))?;
    Ok(id.into())
}
fn permit(ctx: &ToolContext, b: &Binding, write: bool) -> AppResult<()> {
    if !b.enabled
        || ctx.workspace_id.as_deref() != Some(&b.workspace_id)
        || std::path::Path::new(&b.root).canonicalize()? != ctx.workspace.root()
        || b.roots_revision != ctx.workspace.roots_revision()
    {
        return Err(fail(
            "Provider grant does not match current approved workspace roots",
        ));
    }
    if write
        && (ctx.permission_mode == "read-only"
            || !registry::exposed_tool_names(&ctx.tool_profile).contains(&"workflow_update")
            || b.policy_stamp != stamp(ctx))
    {
        return Err(fail("Execution policy changed or is read-only; locally reconnect this provider under current settings"));
    }
    Ok(())
}
#[derive(Clone)]
struct Connection {
    credential: Arc<String>,
    enabled: Arc<AtomicBool>,
}
fn vault() -> &'static Mutex<HashMap<String, Connection>> {
    static V: OnceLock<Mutex<HashMap<String, Connection>>> = OnceLock::new();
    V.get_or_init(Default::default)
}
fn key(b: &Binding) -> String {
    format!("{}:{}", b.id, b.generation)
}
fn connection(b: &Binding) -> AppResult<Connection> {
    vault()
        .lock()
        .map_err(|_| fail("Provider credential store unavailable"))?
        .get(&key(b))
        .filter(|c| c.enabled.load(Ordering::SeqCst))
        .cloned()
        .ok_or_else(|| {
            fail("Provider disconnected. Reconnect locally; stored missions are preserved")
        })
}
fn invalidate(id: &str) {
    if let Ok(mut v) = vault().lock() {
        for (k, c) in v.iter() {
            if k.starts_with(&format!("{id}:")) {
                c.enabled.store(false, Ordering::SeqCst);
            }
        }
        v.retain(|k, _| !k.starts_with(&format!("{id}:")));
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub id: Option<String>,
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
    pub confirm_external_execution: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestrationStage {
    pub binding_id: String,
    pub binding_generation: String,
    pub mission_id: String,
    pub request_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestrationReservation {
    pub workspace_id: String,
    pub id: String,
    pub task_id: String,
    pub expected_board_revision: u64,
    pub planner_prompt: String,
    pub planner: OrchestrationStage,
    pub workers: Vec<OrchestrationStage>,
    pub reviewer: OrchestrationStage,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrchestrationStatus {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: u64,
    pub status: String,
}
/// Call ONLY from a focused, visible main-window command. Changing the binding
/// invalidates old credential sessions; this function never starts a daemon.
pub fn configure(
    ctx: &ToolContext,
    expected: u64,
    s: Settings,
    credential: String,
) -> AppResult<Value> {
    if !s.confirm_external_execution {
        return Err(fail(
            "Explicit local acknowledgement of provider execution and costs is required",
        ));
    }
    if ctx.permission_mode == "read-only" {
        return Err(fail("Read-only workspace cannot enable external execution"));
    }
    if credential.len() > 4096 || credential.chars().any(char::is_control) {
        return Err(fail("Invalid provider credential"));
    }
    let _guard = ctx
        .policy_execution_guard()
        .map_err(|e| fail(e.message()))?;
    let binding = DataStore::update_file(|data| {
        let workspace = scope(ctx, data)?;
        let b = Binding {
            id: s.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            workspace_id: workspace,
            root: ctx.workspace.root_display(),
            roots_revision: ctx.workspace.roots_revision(),
            policy_stamp: stamp(ctx),
            generation: uuid::Uuid::new_v4().to_string(),
            engine: s.engine,
            endpoint: protocol::endpoint(s.engine, &s.endpoint)
                .map_err(fail)?
                .to_string(),
            provider: s.provider,
            model: s.model,
            account_id: s.account_id,
            route_id: s.route_id,
            mode: s.mode,
            project_id: s.project_id,
            repo_id: s.repo_id,
            assignee_id: s.assignee_id,
            max_duration_min: s.max_duration_min,
            allow_codex: s.allow_codex,
            enabled: true,
        };
        data.execution_book
            .configure(b.clone(), expected)
            .map_err(fail)?;
        Ok(b)
    })?;
    invalidate(&binding.id);
    vault()
        .lock()
        .map_err(|_| fail("Credential store unavailable; no work was started"))?
        .insert(
            key(&binding),
            Connection {
                credential: Arc::new(credential),
                enabled: Arc::new(AtomicBool::new(true)),
            },
        );
    view(ctx, None)
}
pub fn reconnect(
    ctx: &ToolContext,
    id: &str,
    credential: String,
    confirmed: bool,
) -> AppResult<Value> {
    if !confirmed || credential.len() > 4096 || credential.chars().any(char::is_control) {
        return Err(fail(
            "Confirm the existing provider connection locally with a valid credential",
        ));
    }
    let _guard = ctx
        .policy_execution_guard()
        .map_err(|e| fail(e.message()))?;
    let binding = DataStore::update_file(|data| {
        let workspace = scope(ctx, data)?;
        let b = data
            .execution_book
            .bindings
            .iter()
            .find(|b| b.id == id && b.workspace_id == workspace)
            .cloned()
            .ok_or_else(|| fail("Binding not found"))?;
        let mut candidate = b.clone();
        candidate.enabled = true;
        candidate.policy_stamp = stamp(ctx);
        permit(ctx, &candidate, true)?;
        let updated = data
            .execution_book
            .bindings
            .iter_mut()
            .find(|b| b.id == id)
            .unwrap();
        updated.enabled = true;
        updated.policy_stamp = candidate.policy_stamp.clone();
        data.execution_book.revision = data
            .execution_book
            .revision
            .checked_add(1)
            .ok_or_else(|| fail("Revision exhausted"))?;
        Ok(candidate)
    })?;
    invalidate(id);
    vault()
        .lock()
        .map_err(|_| fail("Credential store unavailable"))?
        .insert(
            key(&binding),
            Connection {
                credential: Arc::new(credential),
                enabled: Arc::new(AtomicBool::new(true)),
            },
        );
    view(ctx, None)
}
pub fn disable(ctx: &ToolContext, id: &str) -> AppResult<Value> {
    DataStore::update_file(|data| {
        let workspace = scope(ctx, data)?;
        data.execution_book.disable(&workspace, id).map_err(fail)
    })?;
    invalidate(id);
    view(ctx, None)
}

#[doc(hidden)]
pub fn reserve_orchestration_in_data(
    ctx: &ToolContext,
    data: &mut AppData,
    request: OrchestrationReservation,
) -> AppResult<OrchestrationRecord> {
    let workspace = scope(ctx, data)?;
    if request.workspace_id != workspace {
        return Err(fail("Orchestration workspace does not match this listener"));
    }
    for value in [&request.id, &request.task_id] {
        identifier(value).map_err(fail)?;
    }
    let planner_prompt = request.planner_prompt.trim();
    if planner_prompt.is_empty()
        || planner_prompt.len() > 8192
        || planner_prompt
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(fail(
            "Planner prompt is empty, oversized or contains controls",
        ));
    }
    if request.workers.is_empty() || request.workers.len() > 8 {
        return Err(fail("Orchestration requires 1..8 workers"));
    }
    if request.planner.binding_id != request.reviewer.binding_id
        || request.planner.binding_generation != request.reviewer.binding_generation
    {
        return Err(fail(
            "Planner and reviewer must use the same approved Web GPT binding",
        ));
    }
    let stages = std::iter::once(&request.planner)
        .chain(request.workers.iter())
        .chain(std::iter::once(&request.reviewer))
        .collect::<Vec<_>>();
    let mut mission_ids = HashSet::new();
    let mut request_keys = HashSet::new();
    for stage in &stages {
        for value in [
            &stage.binding_id,
            &stage.binding_generation,
            &stage.mission_id,
            &stage.request_key,
        ] {
            identifier(value).map_err(fail)?;
        }
        if !mission_ids.insert(stage.mission_id.as_str())
            || !request_keys.insert(stage.request_key.as_str())
        {
            return Err(fail(
                "Orchestration mission IDs and request keys must be unique",
            ));
        }
    }
    let parent = data
        .control_board
        .tasks
        .iter()
        .find(|task| task.id == request.task_id && task.workspace_id == workspace)
        .ok_or_else(|| fail("Parent task is not in this listener's approved workspace"))?;
    if parent.state == "archived" {
        return Err(fail("Parent task is archived"));
    }
    for (stage, provider, model) in stages.iter().enumerate().map(|(index, stage)| {
        if index == 0 || index + 1 == stages.len() {
            (*stage, "chatgpt-web", "chatgpt-web/high")
        } else {
            (*stage, "cliproxyapi-antigravity", "gemini-3.8-flash-high")
        }
    }) {
        let binding = data
            .execution_book
            .binding(&workspace, &stage.binding_id)
            .map_err(fail)?;
        if binding.generation != stage.binding_generation
            || binding.engine != Engine::Paseo
            || binding.provider != provider
            || binding.model != model
        {
            return Err(fail(
                "Orchestration binding identity or approved route changed",
            ));
        }
        permit(ctx, binding, true)?;
    }

    if let Some(existing) = data
        .execution_book
        .orchestrations
        .iter()
        .find(|record| record.id == request.id)
        .cloned()
    {
        let same = existing.workspace_id == workspace
            && existing.task_id == request.task_id
            && existing.planner_binding_id == request.planner.binding_id
            && existing.planner_binding_generation == request.planner.binding_generation
            && existing.planner_mission_id == request.planner.mission_id
            && existing.planner_request_key == request.planner.request_key
            && existing.worker_binding_ids
                == request
                    .workers
                    .iter()
                    .map(|stage| stage.binding_id.clone())
                    .collect::<Vec<_>>()
            && existing.worker_binding_generations
                == request
                    .workers
                    .iter()
                    .map(|stage| stage.binding_generation.clone())
                    .collect::<Vec<_>>()
            && existing.worker_mission_ids
                == request
                    .workers
                    .iter()
                    .map(|stage| stage.mission_id.clone())
                    .collect::<Vec<_>>()
            && existing.worker_request_keys
                == request
                    .workers
                    .iter()
                    .map(|stage| stage.request_key.clone())
                    .collect::<Vec<_>>()
            && existing.reviewer_binding_id == request.reviewer.binding_id
            && existing.reviewer_binding_generation == request.reviewer.binding_generation
            && existing.reviewer_mission_id == request.reviewer.mission_id
            && existing.reviewer_request_key == request.reviewer.request_key;
        let task_ids = std::iter::once(existing.planner_task_id.as_str())
            .chain(existing.worker_task_ids.iter().map(String::as_str))
            .chain(std::iter::once(existing.reviewer_task_id.as_str()))
            .collect::<Vec<_>>();
        let tasks_exist = task_ids.iter().all(|id| {
            data.control_board
                .tasks
                .iter()
                .any(|task| task.id == *id && task.workspace_id == workspace)
        });
        let prompt_matches = data
            .control_board
            .tasks
            .iter()
            .find(|task| task.id == existing.planner_task_id && task.workspace_id == workspace)
            .is_some_and(|task| task.description == planner_prompt);
        return if same && tasks_exist && prompt_matches {
            Ok(existing)
        } else {
            Err(fail(
                "Orchestration ID already identifies different durable work",
            ))
        };
    }
    if data.execution_book.orchestrations.iter().any(|record| {
        mission_ids.contains(record.planner_mission_id.as_str())
            || mission_ids.contains(record.reviewer_mission_id.as_str())
            || record
                .worker_mission_ids
                .iter()
                .any(|id| mission_ids.contains(id.as_str()))
            || request_keys.contains(record.planner_request_key.as_str())
            || request_keys.contains(record.reviewer_request_key.as_str())
            || record
                .worker_request_keys
                .iter()
                .any(|key| request_keys.contains(key.as_str()))
    }) || data.execution_book.missions.iter().any(|entry| {
        mission_ids.contains(entry.mission.spec.mission_id.as_str())
            || entry
                .mission
                .receipts
                .keys()
                .any(|key| request_keys.contains(key.as_str()))
    }) {
        return Err(fail(
            "Orchestration mission IDs and request keys must be unique across durable work",
        ));
    }
    if data.control_board.revision != request.expected_board_revision {
        return Err(fail("Board changed before orchestration reservation"));
    }

    let mut board = data.control_board.clone();
    let planner_task_id = board_sync::apply_scoped(
        &mut board,
        &workspace,
        request.expected_board_revision,
        board_sync::Update::Create {
            title: "Web GPT planner".into(),
            description: planner_prompt.into(),
            state: Some("backlog".into()),
        },
    )?;
    let mut worker_task_ids = Vec::with_capacity(request.workers.len());
    for index in 0..request.workers.len() {
        let revision = board.revision;
        worker_task_ids.push(board_sync::apply_scoped(
            &mut board,
            &workspace,
            revision,
            board_sync::Update::Create {
                title: format!("Gemini worker {}", index + 1),
                description: String::new(),
                state: Some("backlog".into()),
            },
        )?);
    }
    let revision = board.revision;
    let reviewer_task_id = board_sync::apply_scoped(
        &mut board,
        &workspace,
        revision,
        board_sync::Update::Create {
            title: "Web GPT reviewer".into(),
            description: String::new(),
            state: Some("backlog".into()),
        },
    )?;
    let record = OrchestrationRecord {
        id: request.id.clone(),
        workspace_id: workspace.clone(),
        task_id: request.task_id,
        planner_task_id,
        planner_binding_id: request.planner.binding_id,
        planner_binding_generation: request.planner.binding_generation,
        planner_mission_id: request.planner.mission_id,
        planner_request_key: request.planner.request_key,
        worker_binding_ids: request
            .workers
            .iter()
            .map(|stage| stage.binding_id.clone())
            .collect(),
        worker_binding_generations: request
            .workers
            .iter()
            .map(|stage| stage.binding_generation.clone())
            .collect(),
        worker_mission_ids: request
            .workers
            .iter()
            .map(|stage| stage.mission_id.clone())
            .collect(),
        worker_task_ids,
        worker_request_keys: request
            .workers
            .iter()
            .map(|stage| stage.request_key.clone())
            .collect(),
        reviewer_binding_id: request.reviewer.binding_id,
        reviewer_binding_generation: request.reviewer.binding_generation,
        reviewer_task_id,
        reviewer_mission_id: request.reviewer.mission_id,
        reviewer_request_key: request.reviewer.request_key,
        status: "planning".into(),
        revision: 0,
    };
    let mut book = data.execution_book.clone();
    book.save_orchestration(record, 0).map_err(fail)?;
    let saved = book
        .orchestration(&workspace, &request.id)
        .map_err(fail)?
        .clone();
    data.control_board = board;
    data.execution_book = book;
    Ok(saved)
}

pub fn reserve_orchestration(
    ctx: &ToolContext,
    request: OrchestrationReservation,
) -> AppResult<Value> {
    let record = DataStore::update_file(|data| reserve_orchestration_in_data(ctx, data, request))?;
    Ok(json!({
        "ok": true,
        "orchestration": record,
        "execution": view(ctx, None)?,
    }))
}

pub fn update_orchestration_status(
    ctx: &ToolContext,
    request: OrchestrationStatus,
) -> AppResult<Value> {
    let record = DataStore::update_file(|data| {
        let workspace = scope(ctx, data)?;
        if request.workspace_id != workspace {
            return Err(fail("Orchestration workspace does not match this listener"));
        }
        data.execution_book
            .advance_orchestration(
                &workspace,
                &request.id,
                request.expected_revision,
                &request.status,
            )
            .map_err(fail)
    })?;
    Ok(json!({
        "ok": true,
        "orchestration": record,
        "execution": view(ctx, None)?,
    }))
}

pub fn view(ctx: &ToolContext, mission: Option<&str>) -> AppResult<Value> {
    let mut result = DataStore::update_file(|data| {
        let id = scope(ctx, data)?;
        data.execution_book
            .recover(&id, runtime(), now())
            .map_err(fail)?;
        data.execution_book.view(&id, mission).map_err(fail)
    })?;
    if let Some(rows) = result["bindings"].as_array_mut() {
        for row in rows {
            let b: Binding =
                serde_json::from_value(row.clone()).map_err(|_| fail("Invalid stored binding"))?;
            row["connected"] = json!(connection(&b).is_ok());
            row["current_scope_valid"] = json!(permit(ctx, &b, false).is_ok());
        }
    }
    result["runtime_id"] = json!(runtime());
    Ok(result)
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    AgentPrepare {
        binding_id: String,
        task_id: String,
        mission_id: String,
    },
    AgentControl {
        mission_id: String,
        request_key: String,
        action: Action,
    },
    AgentReview {
        mission_id: String,
        note: String,
        evidence: Vec<String>,
        accepted: bool,
    },
}
pub fn change(ctx: &ToolContext, expected: u64, change: Change) -> AppResult<Value> {
    match change {
        Change::AgentPrepare {
            binding_id,
            task_id,
            mission_id,
        } => {
            DataStore::update_file(|data| {
                let workspace = scope(ctx, data)?;
                if data.control_board.revision != expected {
                    return Err(fail("Board changed before mission preparation"));
                }
                let task = data
                    .control_board
                    .tasks
                    .iter()
                    .find(|t| {
                        t.id == task_id && t.workspace_id == workspace && t.state != "archived"
                    })
                    .ok_or_else(|| fail("Select an existing task in this workspace"))?;
                let b = data
                    .execution_book
                    .binding(&workspace, &binding_id)
                    .map_err(fail)?;
                permit(ctx, b, true)?;
                connection(b)?;
                data.execution_book
                    .prepare(
                        &workspace,
                        &binding_id,
                        &task_id,
                        &mission_id,
                        &task.title,
                        &task.description,
                        now(),
                    )
                    .map_err(fail)
            })?;
            view(ctx, Some(&mission_id))
        }
        Change::AgentControl {
            mission_id,
            request_key,
            action,
        } => {
            if !action.writes() {
                return refresh(ctx, &mission_id);
            }
            submit(ctx, &mission_id, expected, &request_key, action)?;
            view(ctx, Some(&mission_id))
        }
        Change::AgentReview {
            mission_id,
            note,
            evidence,
            accepted,
        } => {
            DataStore::update_file(|data| {
                let workspace = scope(ctx, data)?;
                let b = data
                    .execution_book
                    .find(&workspace, &mission_id)
                    .map_err(fail)?;
                let binding = data
                    .execution_book
                    .binding(&workspace, &b.binding_id)
                    .map_err(fail)?;
                permit(ctx, binding, true)?;
                if b.mission.revision != expected
                    || b.observed_at
                        .is_none_or(|t| now().saturating_sub(t) > 30000)
                {
                    return Err(fail(
                        "Refresh source evidence before reviewing this revision",
                    ));
                }
                data.execution_book
                    .find_mut(&workspace, &mission_id)
                    .map_err(fail)?
                    .mission
                    .review("chatgpt-or-local-coordinator", &note, &evidence, accepted)
                    .map_err(fail)?;
                data.execution_book.size_check().map_err(fail)
            })?;
            view(ctx, Some(&mission_id))
        }
    }
}
struct Job {
    ctx: ToolContext,
    workspace: String,
    entry: Entry,
    binding: Binding,
    connection: Connection,
    key: String,
    action: Action,
    _slot: tokio::sync::OwnedSemaphorePermit,
}
fn slots(read: bool) -> AppResult<tokio::sync::OwnedSemaphorePermit> {
    static WRITES: OnceLock<Arc<Semaphore>> = OnceLock::new();
    static READS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let slots = if read { &READS } else { &WRITES };
    slots
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| fail("Execution control capacity is busy; no new operation was submitted"))
}
fn spawn(job: Job) -> AppResult<()> {
    let workspace = job.workspace.clone();
    let id = job.entry.mission.spec.mission_id.clone();
    let key = job.key.clone();
    let write = job.action.writes();
    #[cfg(test)]
    let test_file = crate::data::current_test_file();
    let started = std::thread::Builder::new()
        .name("mcp-provider-control".into())
        .spawn(move || {
            let execute = || {
                let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| fail("Provider transport runtime unavailable"))?
                        .block_on(process(&job))
                }));
                let error = match run {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e.to_string()),
                    Err(_) => Some("Provider control worker interrupted; outcome unknown".into()),
                };
                if let Some(error) = error {
                    let _ = DataStore::update_file(|data| {
                        if write {
                            data.execution_book
                                .uncertain(
                                    &job.workspace,
                                    &job.entry.mission.spec.mission_id,
                                    &job.key,
                                    &error.chars().take(240).collect::<String>(),
                                    now(),
                                )
                                .map_err(fail)?;
                        } else if let Ok(row) = data
                            .execution_book
                            .find_mut(&job.workspace, &job.entry.mission.spec.mission_id)
                        {
                            if row.mission.revision == job.entry.mission.revision {
                                row.last_error = Some(error.chars().take(240).collect());
                            }
                        }
                        Ok(())
                    });
                }
            };
            #[cfg(test)]
            if let Some(path) = test_file {
                crate::data::with_test_file(path, execute);
                return;
            }
            execute();
        });
    if started.is_err() {
        if write {
            DataStore::update_file(|d| {
                d.execution_book
                    .acknowledge(&workspace, &id, &key, Reply::Rejected, now())
                    .map_err(fail)
            })?;
        }
        return Err(fail(
            "Could not start provider transport; no source request was sent",
        ));
    }
    Ok(())
}
fn submit(ctx: &ToolContext, id: &str, expected: u64, key: &str, action: Action) -> AppResult<()> {
    let slot = slots(false)?;
    let work = DataStore::update_file(|data| {
        let workspace = scope(ctx, data)?;
        data.execution_book
            .recover(&workspace, runtime(), now())
            .map_err(fail)?;
        let entry = data
            .execution_book
            .find(&workspace, id)
            .map_err(fail)?
            .clone();
        if entry.mission.receipts.contains_key(key) {
            data.execution_book
                .reserve(&workspace, id, expected, key, runtime(), action)
                .map_err(fail)?;
            return Ok(None);
        }
        let b = data
            .execution_book
            .binding(&workspace, &entry.binding_id)
            .map_err(fail)?
            .clone();
        permit(ctx, &b, true)?;
        let connection = connection(&b)?;
        data.execution_book
            .reserve(&workspace, id, expected, key, runtime(), action)
            .map_err(fail)?;
        let entry = data
            .execution_book
            .find(&workspace, id)
            .map_err(fail)?
            .clone();
        Ok(Some(Job {
            ctx: ctx.clone(),
            workspace,
            entry,
            binding: b,
            connection,
            key: key.into(),
            action,
            _slot: slot,
        }))
    })?;
    if let Some(job) = work {
        spawn(job)?;
    }
    Ok(())
}
pub fn refresh(ctx: &ToolContext, id: &str) -> AppResult<Value> {
    let slot = slots(true)?;
    let job = DataStore::update_file(|data| {
        let workspace = scope(ctx, data)?;
        data.execution_book
            .recover(&workspace, runtime(), now())
            .map_err(fail)?;
        let entry = data
            .execution_book
            .find(&workspace, id)
            .map_err(fail)?
            .clone();
        if entry.mission.record_id.is_none() {
            return Err(fail(
                "No confirmed source ID yet; do not repeat an uncertain Create",
            ));
        }
        if entry
            .mission
            .pending
            .as_ref()
            .and_then(|k| entry.mission.receipts.get(k))
            .is_some_and(|r| r.state == ReceiptState::Reserved)
        {
            return Err(fail(
                "Source request is still pending; inspect its receipt before refreshing",
            ));
        }
        let b = data
            .execution_book
            .binding(&workspace, &entry.binding_id)
            .map_err(fail)?
            .clone();
        matching_binding_generation(&entry, &b)?;
        permit(ctx, &b, false)?;
        let connected = connection(&b)?;
        Ok(Job {
            ctx: ctx.clone(),
            workspace,
            entry,
            binding: b,
            connection: connected,
            key: uuid::Uuid::new_v4().to_string(),
            action: Action::Inspect,
            _slot: slot,
        })
    })?;
    spawn(job)?;
    let mut result = view(ctx, Some(id))?;
    result["refresh_requested"] = json!(true);
    Ok(result)
}
async fn inspect_source(job: &Job) -> AppResult<observation::Evidence> {
    let spec = &job.entry.mission.spec;
    let request = protocol::build(
        spec,
        job.entry.mission.record_id.as_deref(),
        job.entry.mission.run_id.as_deref(),
        Action::Inspect,
        &uuid::Uuid::new_v4().to_string(),
    )
    .map_err(fail)?;
    let response = transport::send(
        spec.engine,
        &job.binding.endpoint,
        &job.connection.credential,
        &request,
    )
    .await
    .map_err(|e| fail(e.to_string()))?;
    observation::inspect(spec, spec_record(&job.entry)?, &response.body).map_err(fail)
}
fn spec_record(e: &Entry) -> AppResult<&str> {
    e.mission
        .record_id
        .as_deref()
        .ok_or_else(|| fail("No confirmed provider record"))
}
fn matching_binding_generation(entry: &Entry, binding: &Binding) -> AppResult<()> {
    if entry.binding_generation != binding.generation {
        return Err(fail("Mission belongs to an older provider grant"));
    }
    Ok(())
}
async fn process(job: &Job) -> AppResult<()> {
    let current = job.ctx.for_request().map_err(|e| fail(e.message()))?;
    permit(&current, &job.binding, job.action.writes())?;
    if !job.connection.enabled.load(Ordering::SeqCst) {
        return Err(fail("Provider disconnected before source submission"));
    }
    DataStore::read_file(|d| {
        scope(&current, d)?;
        let b = d
            .execution_book
            .binding(&job.workspace, &job.binding.id)
            .map_err(fail)?;
        if b.generation != job.binding.generation {
            return Err(fail("Provider grant changed before submission"));
        }
        Ok(())
    })?;
    if job.action == Action::Inspect {
        let evidence = inspect_source(job).await?;
        let mut output = None;
        if job.binding.engine == Engine::Paseo
            && evidence.observation.quiescent
            && evidence.observation.status.eq_ignore_ascii_case("idle")
        {
            if let Some(start_key) = job.entry.start_message_id.as_deref() {
                let request = protocol::build(
                    &job.entry.mission.spec,
                    job.entry.mission.record_id.as_deref(),
                    job.entry.mission.run_id.as_deref(),
                    Action::Events,
                    &uuid::Uuid::new_v4().to_string(),
                )
                .map_err(fail)?;
                let response = transport::send(
                    Engine::Paseo,
                    &job.binding.endpoint,
                    &job.connection.credential,
                    &request,
                )
                .await
                .map_err(|e| fail(e.to_string()))?;
                output = super::result::parse_paseo_start_result(
                    &response.body,
                    spec_record(&job.entry)?,
                    start_key,
                )
                .map_err(fail)?;
            }
        }
        DataStore::update_file(|d| {
            scope(&current, d)?;
            let row = d
                .execution_book
                .find_mut(&job.workspace, &job.entry.mission.spec.mission_id)
                .map_err(fail)?;
            if row.mission.revision != job.entry.mission.revision {
                return Err(fail("Newer mission state supersedes this observation"));
            }
            observation::apply(row, evidence, now()).map_err(fail)?;
            if let Some(output) = output {
                row.output = Some(output);
            }
            d.execution_book.size_check().map_err(fail)
        })?;
        return Ok(());
    }
    if job.action != Action::Create {
        let evidence = inspect_source(job).await?;
        if matches!(job.action, Action::Start | Action::Resume | Action::Close)
            && !evidence.observation.quiescent
        {
            return Err(fail(
                "Source still has active work or pending permissions; no new command was sent",
            ));
        }
        if job.action == Action::Cancel
            && job.binding.engine == Engine::Anneal
            && evidence.observation.run_id != job.entry.mission.run_id
        {
            return Err(fail(
                "Owned Anneal run changed; refresh before cancellation",
            ));
        }
    }
    let spec = &job.entry.mission.spec;
    let request = protocol::build(
        spec,
        job.entry.mission.record_id.as_deref(),
        job.entry.mission.run_id.as_deref(),
        job.action,
        &job.key,
    )
    .map_err(fail)?;
    // The short policy fence ends at admission. External side effects already
    // transmitted cannot be undone by a later local setting change.
    {
        let latest = job.ctx.for_request().map_err(|e| fail(e.message()))?;
        let _guard = latest
            .policy_execution_guard()
            .map_err(|e| fail(e.message()))?;
        permit(&latest, &job.binding, true)?;
        if !job.connection.enabled.load(Ordering::SeqCst) {
            return Err(fail("Local provider access revoked before send"));
        }
    }
    let response = transport::send(
        spec.engine,
        &job.binding.endpoint,
        &job.connection.credential,
        &request,
    )
    .await
    .map_err(|e| fail(e.to_string()))?;
    let reply = match job.action {
        Action::Create => Reply::Created {
            record_id: response.body[if spec.engine == Engine::Paseo {
                "agentId"
            } else {
                "id"
            }]
            .as_str()
            .ok_or_else(|| fail("Missing created record ID"))?
            .into(),
        },
        Action::Start => Reply::Started {
            run_id: response.body["runId"].as_str().map(str::to_owned),
        },
        Action::Resume if spec.engine == Engine::Paseo => Reply::Started { run_id: None },
        // A chain resume is not proof of a started worker. Preserve an unknown
        // state and require fresh source evidence rather than inventing Running.
        Action::Resume => {
            return DataStore::update_file(|d| {
                d.execution_book
                    .uncertain(
                        &job.workspace,
                        &spec.mission_id,
                        &job.key,
                        "Anneal scheduling resume acknowledged; inspect actual run state",
                        now(),
                    )
                    .map_err(fail)
            });
        }
        Action::Hold | Action::Cancel => Reply::HoldAcknowledged {
            worker_stopped: false,
        },
        Action::Close => Reply::Closed,
        _ => return Err(fail("Unsupported background operation")),
    };
    DataStore::update_file(|data| {
        data.execution_book
            .acknowledge(&job.workspace, &spec.mission_id, &job.key, reply, now())
            .map_err(fail)
    })?;
    Ok(())
}

#[cfg(test)]
mod orchestration_reservation_tests {
    use super::*;
    use crate::{
        integrations::{board, execution::book::Book},
        workspace::WorkspaceProfile,
    };

    #[test]
    fn reservation_is_atomic_idempotent_and_preserves_the_parent_task() {
        let workspace = tempfile::tempdir().unwrap();
        let harness = tempfile::tempdir().unwrap();
        let mut ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .unwrap();
        ctx.bind_workspace_id("qa");
        ctx.auth.auth_type = "bearer".into();
        ctx.tool_profile = "advanced".into();

        let mut data = AppData::default();
        data.profiles.push(
            serde_json::from_value::<WorkspaceProfile>(json!({
                "id": "qa",
                "name": "QA",
                "path": workspace.path().to_string_lossy(),
                "tunnel": {},
                "auth": {"type": "bearer"},
                "runtime": {"permission_mode": "workspace-write", "tool_profile": "advanced"},
                "actions": {}
            }))
            .unwrap(),
        );
        data.control_board.tasks.push(board::Task {
            id: "parent-task".into(),
            workspace_id: "qa".into(),
            title: "User task".into(),
            description: "Do not replace this description".into(),
            state: "in_progress".into(),
            step: 0,
            created_at: 1,
            updated_at: 1,
            clauses: vec![],
            evidence: vec![],
        });
        let binding = |id: &str, generation: &str, provider: &str, model: &str| Binding {
            id: id.into(),
            workspace_id: "qa".into(),
            root: ctx.workspace.root_display(),
            roots_revision: ctx.workspace.roots_revision(),
            policy_stamp: stamp(&ctx),
            generation: generation.into(),
            engine: Engine::Paseo,
            endpoint: "ws://127.0.0.1:6768/ws".into(),
            provider: provider.into(),
            model: model.into(),
            account_id: Some(format!("{id}-account")),
            route_id: Some(format!("{id}-route")),
            mode: "full-access".into(),
            project_id: None,
            repo_id: None,
            assignee_id: None,
            max_duration_min: 10,
            allow_codex: false,
            enabled: true,
        };
        data.execution_book = Book {
            bindings: vec![
                binding("web", "web-generation", "chatgpt-web", "chatgpt-web/high"),
                binding(
                    "gemini",
                    "gemini-generation",
                    "cliproxyapi-antigravity",
                    "gemini-3.8-flash-high",
                ),
            ],
            ..Book::default()
        };
        let request = OrchestrationReservation {
            workspace_id: "qa".into(),
            id: "run-1".into(),
            task_id: "parent-task".into(),
            expected_board_revision: 0,
            planner_prompt: "{\"task\":\"plan only\"}".into(),
            planner: OrchestrationStage {
                binding_id: "web".into(),
                binding_generation: "web-generation".into(),
                mission_id: "planner-mission".into(),
                request_key: "planner-request".into(),
            },
            workers: vec![OrchestrationStage {
                binding_id: "gemini".into(),
                binding_generation: "gemini-generation".into(),
                mission_id: "worker-mission".into(),
                request_key: "worker-request".into(),
            }],
            reviewer: OrchestrationStage {
                binding_id: "web".into(),
                binding_generation: "web-generation".into(),
                mission_id: "reviewer-mission".into(),
                request_key: "reviewer-request".into(),
            },
        };

        let reserved = reserve_orchestration_in_data(&ctx, &mut data, request.clone()).unwrap();
        assert_eq!(reserved.status, "planning");
        assert_eq!(data.control_board.tasks.len(), 4);
        assert_eq!(
            data.control_board.tasks[0].description,
            "Do not replace this description"
        );
        assert_eq!(
            data.control_board
                .tasks
                .iter()
                .find(|task| task.id == reserved.planner_task_id)
                .unwrap()
                .description,
            request.planner_prompt
        );

        let replay = reserve_orchestration_in_data(&ctx, &mut data, request.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(replay).unwrap(),
            serde_json::to_value(&reserved).unwrap()
        );
        assert_eq!(data.control_board.tasks.len(), 4);

        let mut conflict = request;
        conflict.planner_prompt = "{\"task\":\"different\"}".into();
        let before = serde_json::to_value(&data).unwrap();
        assert!(reserve_orchestration_in_data(&ctx, &mut data, conflict).is_err());
        assert_eq!(serde_json::to_value(&data).unwrap(), before);
    }

    #[test]
    fn refresh_rejects_a_reconfigured_binding_generation() {
        let binding = Binding {
            id: "web".into(),
            workspace_id: "qa".into(),
            root: "C:/qa".into(),
            roots_revision: "roots".into(),
            policy_stamp: "policy".into(),
            generation: "new-generation".into(),
            engine: Engine::Paseo,
            endpoint: "ws://127.0.0.1:6768/ws".into(),
            provider: "chatgpt-web".into(),
            model: "chatgpt-web/high".into(),
            account_id: Some("web-account".into()),
            route_id: Some("web-route".into()),
            mode: "full-access".into(),
            project_id: None,
            repo_id: None,
            assignee_id: None,
            max_duration_min: 10,
            allow_codex: false,
            enabled: true,
        };
        let entry = Entry {
            binding_id: binding.id.clone(),
            binding_generation: "old-generation".into(),
            mission: Mission::new(binding.spec("mission", "task", "Read", "Read only")).unwrap(),
            owner_runtime: None,
            created_at: 1,
            updated_at: 1,
            observed_at: None,
            source_revision: None,
            last_error: None,
            observation: Value::Null,
            start_message_id: None,
            output: None,
        };

        assert!(matching_binding_generation(&entry, &binding).is_err());
    }
}

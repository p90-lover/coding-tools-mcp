//! Durable, scoped task intents. Model execution remains owned by the mission controller.
use super::{
    ao::{Run, State},
    ao_team::{self, Team},
    board, err,
};
use crate::{data::AppData, error::AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    #[default]
    Active,
    Archived,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconfigurePhase {
    Prepared,
    Stopped,
    Replaced,
    NeedsAttention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleState {
    Scheduled,
    Claimed,
    Started,
    Cancelled,
    Missed,
    NeedsAttention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptIdentity {
    pub node_id: String,
    pub request_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReconfigureIntent {
    pub id: String,
    pub previous_run_id: String,
    pub team_id: String,
    pub team_revision: u64,
    pub phase: ReconfigurePhase,
    pub replacement_run_id: Option<String>,
    pub handoff: String,
    pub required_attempts: Vec<AttemptIdentity>,
    pub team: Team,
    pub attention: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduledStart {
    pub id: String,
    pub run_id: String,
    pub due_at_ms: u64,
    pub revision: u64,
    pub team_id: String,
    pub team_revision: u64,
    pub state: ScheduleState,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskLifecycle {
    pub workspace_id: String,
    pub task_id: String,
    pub revision: u64,
    pub visibility: Visibility,
    pub reconfigure: Vec<ReconfigureIntent>,
    pub schedule: Option<ScheduledStart>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum LifecycleChange {
    PrepareReconfigure {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
        run_id: String,
        run_revision: u64,
        team_id: String,
        team_revision: u64,
    },
    FinishReconfigure {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
        replacement_run_id: String,
        stopped_attempts: Vec<AttemptIdentity>,
        handoff: String,
    },
    ReconfigureAttention {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
        message: String,
    },
    ReconfigureStopped {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
        stopped_attempts: Vec<AttemptIdentity>,
    },
    SetVisibility {
        task_id: String,
        expected_revision: u64,
        visibility: Visibility,
    },
    RestoreTask {
        task_id: String,
        expected_revision: u64,
    },
    ScheduleStart {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
        run_id: String,
        team_id: String,
        team_revision: u64,
        due_at_ms: u64,
    },
    ClaimSchedule {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
    },
    CancelSchedule {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
    },
    RecoverSchedule {
        task_id: String,
        intent_id: String,
        expected_revision: u64,
        action: String,
    },
}
impl LifecycleChange {
    fn scope(&self) -> (&str, u64) {
        match self {
            Self::PrepareReconfigure {
                task_id,
                expected_revision,
                ..
            }
            | Self::FinishReconfigure {
                task_id,
                expected_revision,
                ..
            }
            | Self::ReconfigureAttention {
                task_id,
                expected_revision,
                ..
            }
            | Self::ReconfigureStopped {
                task_id,
                expected_revision,
                ..
            }
            | Self::SetVisibility {
                task_id,
                expected_revision,
                ..
            }
            | Self::RestoreTask {
                task_id,
                expected_revision,
            }
            | Self::ScheduleStart {
                task_id,
                expected_revision,
                ..
            }
            | Self::ClaimSchedule {
                task_id,
                expected_revision,
                ..
            }
            | Self::CancelSchedule {
                task_id,
                expected_revision,
                ..
            }
            | Self::RecoverSchedule {
                task_id,
                expected_revision,
                ..
            } => (task_id, *expected_revision),
        }
    }
}
fn valid_id(id: &str) -> AppResult<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(err("Invalid task intent identity"));
    }
    Ok(())
}
fn active_work(data: &AppData, workspace_id: &str, task_id: &str) -> bool {
    data.ao_runs
        .iter()
        .filter(|run| run.workspace_id == workspace_id && run.project_id == task_id)
        .any(|run| {
            run.nodes
                .iter()
                .any(|n| matches!(n.state, State::Reserved | State::Running))
        })
}
/// Saved teams are shared by every workspace.
fn saved_team(data: &AppData, team_id: &str, revision: u64) -> AppResult<Team> {
    data.ao_teams
        .iter()
        .find(|team| team.id == team_id && team.revision == revision)
        .cloned()
        .ok_or_else(|| err("The selected saved team changed; refresh before retrying"))
}
fn run_for(data: &AppData, workspace_id: &str, task_id: &str, run_id: &str) -> AppResult<Run> {
    data.ao_runs
        .iter()
        .find(|run| {
            run.id == run_id && run.workspace_id == workspace_id && run.project_id == task_id
        })
        .cloned()
        .ok_or_else(|| err("Mission is not owned by this task and workspace"))
}
fn public_lifecycle(item: &TaskLifecycle) -> Value {
    let intents: Vec<_> = item
        .reconfigure
        .iter()
        .map(|intent| {
            let mut value = json!({"id":intent.id,"previous_run_id":intent.previous_run_id,
            "team_id":intent.team_id,"team_revision":intent.team_revision,"phase":intent.phase,
            "replacement_run_id":intent.replacement_run_id,"attention":intent.attention});
            if matches!(
                intent.phase,
                ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
            ) {
                value["required_attempts"] = json!(intent.required_attempts);
            }
            value
        })
        .collect();
    json!({"workspace_id":item.workspace_id,"task_id":item.task_id,"revision":item.revision,
        "visibility":item.visibility,"reconfigure":intents,"schedule":item.schedule})
}
/// Polling returns identities/status, not repeated role snapshots or quoted prompt payloads.
pub fn read_public_lifecycles(data: &AppData, workspace_id: &str, runs: &[Run]) -> Vec<Value> {
    let run_ids: std::collections::HashSet<_> = runs.iter().map(|run| run.id.as_str()).collect();
    data.control_board.tasks.iter().filter(|task| task.workspace_id == workspace_id).map(|task| {
        let mut value = match data.ao_task_lifecycle.iter().find(|item| item.workspace_id == workspace_id && item.task_id == task.id) {
            Some(item) => public_lifecycle(item),
            None => json!({"workspace_id":workspace_id,"task_id":task.id,"revision":0,
                "visibility":if task.state == "archived" {"archived"} else {"active"},"reconfigure":[],"schedule":null}),
        };
        value["title"] = json!(task.title);
        if runs.len() != 1 || runs[0].project_id != task.id {
            if let Some(intents) = value["reconfigure"].as_array_mut() {
                intents.retain(|intent| intent["phase"] != "replaced"
                    || intent["previous_run_id"].as_str().is_some_and(|id| run_ids.contains(id))
                    || intent["replacement_run_id"].as_str().is_some_and(|id| run_ids.contains(id)));
            }
        }
        value
    }).collect()
}

pub fn read_runs(data: &AppData, workspace_id: &str, run_id: Option<&str>) -> AppResult<Vec<Run>> {
    let mut scoped = data
        .ao_runs
        .iter()
        .filter(|run| run.workspace_id == workspace_id);
    if let Some(id) = run_id {
        return scoped
            .find(|run| run.id == id)
            .map(|run| vec![run.clone()])
            .ok_or_else(|| err("AO run not found in this workspace"));
    }
    Ok(newest_within(scoped.rev(), 100, RUNS_READ_BUDGET))
}

/// The most runs one chat's read returns (its newest), within `RUNS_READ_BUDGET`.
pub const CHAT_RUNS_LIMIT: usize = 200;

/// The most a read's runs may take, serialized. The app accepts at most 1 MiB from this service
/// and again over IPC to its window, and the same answer carries the project's lifecycles, teams
/// and the app's own additions (about 85 KB in the largest project seen). A count alone did not
/// bound it: on 2026-11-12 a 182-run goal chat's read passed 1 MiB, so that chat never opened,
/// and a 50-chat project's whole read stood at 863 KB.
pub const RUNS_READ_BUDGET: usize = 768 * 1024;

/// Counts what is written to it, so a run's serialized size is measured without building it.
struct ByteCount(usize);

impl std::io::Write for ByteCount {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The newest of `runs` (given newest first), oldest first: at most `limit` of them and, as a JSON
/// array, at most `budget` bytes. The newest is kept whatever its size, so a read is never empty.
fn newest_within<'a>(runs: impl Iterator<Item = &'a Run>, limit: usize, budget: usize) -> Vec<Run> {
    let mut kept = Vec::new();
    // The array's brackets, then each run with the comma before it (one too many: a margin).
    let mut used = 2;
    for run in runs.take(limit) {
        let mut size = ByteCount(1);
        let _ = serde_json::to_writer(&mut size, run);
        if !kept.is_empty() && used + size.0 > budget {
            break;
        }
        used += size.0;
        kept.push(run.clone());
    }
    kept.reverse();
    kept
}

/// One chat's runs, oldest first. The workspace read keeps the project's newest 100 runs, shared
/// by all of its chats: seen live (2026-11-02), four goal chats filled it, a 63-run chat showed
/// only its newest 26 replies and the project's 38 other chats opened with none.
pub fn read_chat_runs(data: &AppData, workspace_id: &str, task_id: &str) -> Vec<Run> {
    newest_within(
        data.ao_runs
            .iter()
            .rev()
            .filter(|run| run.workspace_id == workspace_id && run.project_id == task_id),
        CHAT_RUNS_LIMIT,
        RUNS_READ_BUDGET,
    )
}

pub fn handoff_for<'a>(data: &'a AppData, run: &Run) -> Option<&'a str> {
    data.ao_task_lifecycle
        .iter()
        .find(|item| item.workspace_id == run.workspace_id && item.task_id == run.project_id)
        .and_then(|item| {
            item.reconfigure
                .iter()
                .find(|intent| intent.replacement_run_id.as_deref() == Some(run.id.as_str()))
        })
        .map(|intent| intent.handoff.as_str())
        .filter(|text| !text.is_empty())
}
/// Execution refusals worded for the person; `ao::reservation_refusal` passes them to callers.
pub const ARCHIVED_REFUSAL: &str = "Archived tasks cannot execute; restore the mission first";
pub const HIDDEN_REFUSAL: &str = "Hidden tasks cannot execute; restore the mission first";
pub const RECONFIGURE_REFUSAL: &str =
    "Configuration replacement is pending; no new attempt may start on the old mission";
pub const SCHEDULE_REFUSAL: &str = "This delayed mission has not been claimed for execution";

pub fn ensure_execution_allowed(data: &AppData, run: &Run) -> AppResult<()> {
    if data.control_board.tasks.iter().any(|task| {
        task.workspace_id == run.workspace_id
            && (task.id == run.project_id || run.nodes.iter().any(|node| node.task_id == task.id))
            && task.state == "archived"
    }) {
        return Err(err(ARCHIVED_REFUSAL));
    }
    if let Some(item) = data
        .ao_task_lifecycle
        .iter()
        .find(|item| item.workspace_id == run.workspace_id && item.task_id == run.project_id)
    {
        if item.visibility != Visibility::Active {
            return Err(err(HIDDEN_REFUSAL));
        }
        if item.reconfigure.iter().any(|intent| {
            intent.previous_run_id == run.id
                && matches!(
                    intent.phase,
                    ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
                )
        }) {
            return Err(err(RECONFIGURE_REFUSAL));
        }
        if item.schedule.as_ref().is_some_and(|job| {
            job.run_id == run.id
                && !matches!(job.state, ScheduleState::Claimed | ScheduleState::Started)
        }) {
            return Err(err(SCHEDULE_REFUSAL));
        }
    }
    Ok(())
}

/// A failed mutation changes neither the caller's memory nor its eventual persisted payload.
pub fn apply_change(
    data: &mut AppData,
    workspace_id: &str,
    change: LifecycleChange,
    now_ms: u64,
) -> AppResult<Value> {
    let mut next = data.clone();
    let result = apply_inner(&mut next, workspace_id, change, now_ms)?;
    *data = next;
    Ok(result)
}
fn apply_inner(
    data: &mut AppData,
    workspace_id: &str,
    change: LifecycleChange,
    now_ms: u64,
) -> AppResult<Value> {
    let (task_id, expected_revision) = change.scope();
    let task_id = task_id.to_owned();
    valid_id(workspace_id)?;
    valid_id(&task_id)?;
    if !data
        .profiles
        .iter()
        .any(|profile| profile.id == workspace_id)
        || !data
            .control_board
            .tasks
            .iter()
            .any(|task| task.id == task_id && task.workspace_id == workspace_id)
    {
        return Err(err("Task is not registered in this workspace"));
    }
    let index = data
        .ao_task_lifecycle
        .iter()
        .position(|item| item.workspace_id == workspace_id && item.task_id == task_id);
    let mut item = index
        .map(|index| data.ao_task_lifecycle[index].clone())
        .unwrap_or(TaskLifecycle {
            workspace_id: workspace_id.into(),
            task_id: task_id.clone(),
            revision: 0,
            visibility: if data
                .control_board
                .tasks
                .iter()
                .any(|t| t.id == task_id && t.state == "archived")
            {
                Visibility::Archived
            } else {
                Visibility::Active
            },
            reconfigure: vec![],
            schedule: None,
        });
    // An exact repeat returns the original result even after the saved revision advanced.
    match &change {
        LifecycleChange::FinishReconfigure {
            intent_id,
            replacement_run_id,
            handoff,
            stopped_attempts,
            ..
        } => {
            if let Some(intent) = item.reconfigure.iter().find(|intent| {
                intent.id == *intent_id && intent.phase == ReconfigurePhase::Replaced
            }) {
                if intent.replacement_run_id.as_deref() != Some(replacement_run_id)
                    || intent.handoff != *handoff
                    || !same_attempts(&intent.required_attempts, stopped_attempts)
                {
                    return Err(err(
                        "A completed intent cannot be reused with different contents",
                    ));
                }
                let run = run_for(data, workspace_id, &task_id, replacement_run_id)?;
                return Ok(
                    json!({"ok":true,"lifecycle":public_lifecycle(&item),"run":run,"duplicate":true}),
                );
            }
        }
        LifecycleChange::PrepareReconfigure {
            intent_id,
            run_id,
            team_id,
            team_revision,
            ..
        } => {
            if let Some(intent) = item
                .reconfigure
                .iter()
                .find(|intent| intent.id == *intent_id)
            {
                if intent.previous_run_id != *run_id
                    || intent.team_id != *team_id
                    || intent.team_revision != *team_revision
                {
                    return Err(err("Task intent identity is already in use"));
                }
                return Ok(
                    json!({"ok":true,"lifecycle":public_lifecycle(&item),"intent":{"id":intent.id,"required_attempts":intent.required_attempts},"duplicate":true}),
                );
            }
        }
        _ => {}
    }
    if item.revision != expected_revision {
        return Err(err(
            "The mission changed in another operation; refresh before retrying",
        ));
    }
    let next_revision = item
        .revision
        .checked_add(1)
        .ok_or_else(|| err("Task lifecycle revision exhausted"))?;
    let mut output_run = None;
    match change {
        LifecycleChange::PrepareReconfigure {
            intent_id,
            run_id,
            run_revision,
            team_id,
            team_revision,
            ..
        } => {
            valid_id(&intent_id)?;
            if item.visibility != Visibility::Active
                || item.reconfigure.iter().any(|i| {
                    matches!(
                        i.phase,
                        ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
                    )
                })
            {
                return Err(err(
                    "Restore this task or resolve its previous replacement before editing",
                ));
            }
            let run = run_for(data, workspace_id, &task_id, &run_id)?;
            if run.revision != run_revision {
                return Err(err("Source mission revision changed"));
            }
            let team = saved_team(data, &team_id, team_revision)?;
            let mut required_attempts = vec![];
            for node in run
                .nodes
                .iter()
                .filter(|n| matches!(n.state, State::Reserved | State::Running))
            {
                let key = node
                    .request_key
                    .clone()
                    .filter(|key| !key.is_empty())
                    .ok_or_else(|| {
                        err("Active attempt identity is unknown; inspect it before replacing")
                    })?;
                required_attempts.push(AttemptIdentity {
                    node_id: node.id.clone(),
                    request_key: key,
                });
            }
            if item.reconfigure.len() >= 100 {
                return Err(err(
                    "Task replacement history limit reached; existing history was preserved",
                ));
            }
            item.reconfigure.push(ReconfigureIntent {
                id: intent_id,
                previous_run_id: run_id,
                team_id,
                team_revision,
                phase: ReconfigurePhase::Prepared,
                replacement_run_id: None,
                handoff: String::new(),
                required_attempts,
                team,
                attention: None,
            });
        }
        LifecycleChange::FinishReconfigure {
            intent_id,
            replacement_run_id,
            stopped_attempts,
            handoff,
            ..
        } => {
            valid_id(&replacement_run_id)?;
            if item.visibility != Visibility::Active
                || handoff.chars().count() > 8000
                || handoff
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(err("Visible handoff exceeds limits or task is hidden"));
            }
            let intent = item
                .reconfigure
                .iter_mut()
                .find(|i| i.id == intent_id)
                .ok_or_else(|| err("Replacement intent was not found"))?;
            let old = run_for(data, workspace_id, &task_id, &intent.previous_run_id)?;
            if !matches!(
                intent.phase,
                ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
            ) || !same_attempts(&intent.required_attempts, &stopped_attempts)
                || old
                    .nodes
                    .iter()
                    .any(|n| matches!(n.state, State::Reserved | State::Running))
                || (!old.cancelled && !old.nodes.iter().all(|n| n.state == State::Finished))
            {
                return Err(err("Owned attempts have not been acknowledged stopped; replacement was not started"));
            }
            let run = ao_team::create_run_with_snapshot(
                data,
                workspace_id,
                replacement_run_id.clone(),
                task_id.clone(),
                data.control_board.revision,
                intent.team.clone(),
                intent.team.worker_limit,
            )?;
            intent.phase = ReconfigurePhase::Replaced;
            intent.replacement_run_id = Some(replacement_run_id.clone());
            intent.handoff = handoff;
            intent.attention = None;
            if let Some(job) = item.schedule.as_mut().filter(|job| {
                job.run_id == old.id
                    && matches!(
                        job.state,
                        ScheduleState::Scheduled
                            | ScheduleState::Claimed
                            | ScheduleState::Missed
                            | ScheduleState::NeedsAttention
                            | ScheduleState::Cancelled
                    )
            }) {
                if job.state == ScheduleState::Claimed {
                    job.state = ScheduleState::NeedsAttention;
                }
                job.run_id = replacement_run_id;
                job.team_id = intent.team_id.clone();
                job.team_revision = intent.team_revision;
                job.revision = job
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| err("Schedule revision exhausted"))?;
            }
            output_run = Some(run);
        }
        LifecycleChange::ReconfigureAttention {
            intent_id, message, ..
        } => {
            if message.chars().count() > 500 {
                return Err(err("Attention notice exceeds limits"));
            }
            let intent = item
                .reconfigure
                .iter_mut()
                .find(|i| i.id == intent_id && i.phase != ReconfigurePhase::Replaced)
                .ok_or_else(|| err("Unfinished replacement intent was not found"))?;
            intent.phase = ReconfigurePhase::NeedsAttention;
            intent.attention = Some(message);
        }
        LifecycleChange::ReconfigureStopped {
            intent_id,
            stopped_attempts,
            ..
        } => {
            let intent = item
                .reconfigure
                .iter_mut()
                .find(|i| {
                    i.id == intent_id
                        && matches!(
                            i.phase,
                            ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
                        )
                })
                .ok_or_else(|| err("Unfinished replacement was not found"))?;
            let old = run_for(data, workspace_id, &task_id, &intent.previous_run_id)?;
            if !same_attempts(&intent.required_attempts, &stopped_attempts)
                || old
                    .nodes
                    .iter()
                    .any(|n| matches!(n.state, State::Reserved | State::Running))
                || (!old.cancelled && !old.nodes.iter().all(|n| n.state == State::Finished))
            {
                return Err(err(
                    "Exact owned stop acknowledgement is required before resolving this intent",
                ));
            }
            intent.phase = ReconfigurePhase::Stopped;
            intent.attention = None;
        }
        LifecycleChange::SetVisibility { visibility, .. } => {
            if visibility == Visibility::Active {
                return Err(err("Use Restore to make a hidden task active"));
            }
            if active_work(data, workspace_id, &task_id)
                || item.reconfigure.iter().any(|i| {
                    matches!(
                        i.phase,
                        ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
                    )
                })
            {
                return Err(err(
                    "Stop and acknowledge this task's owned attempts before hiding it",
                ));
            }
            // Archived -> deleted: the card was archived when the task was first hidden, and the
            // board refuses archiving it twice, so every delete of an archived chat failed.
            let archived = data
                .control_board
                .tasks
                .iter()
                .any(|t| t.id == task_id && t.state == "archived");
            if !archived {
                let board_revision = data.control_board.revision;
                board::apply(
                    &mut data.control_board,
                    board_revision,
                    board::Change::Archive {
                        id: task_id.clone(),
                    },
                )?;
            }
            item.visibility = visibility;
            cancel_pending(data, workspace_id, &task_id);
            if let Some(job) = item.schedule.as_mut() {
                job.state = ScheduleState::Cancelled;
                job.revision += 1;
            }
        }
        LifecycleChange::RestoreTask { .. } => {
            let board_revision = data.control_board.revision;
            board::apply(
                &mut data.control_board,
                board_revision,
                board::Change::Restore {
                    id: task_id.clone(),
                },
            )?;
            item.visibility = Visibility::Active;
        }
        LifecycleChange::ScheduleStart {
            intent_id,
            run_id,
            team_id,
            team_revision,
            due_at_ms,
            ..
        } => {
            valid_id(&intent_id)?;
            valid_id(&run_id)?;
            if now_ms == 0
                || due_at_ms <= now_ms
                || due_at_ms > 8_640_000_000_000_000
                || item.visibility != Visibility::Active
                || active_work(data, workspace_id, &task_id)
                || item.reconfigure.iter().any(|i| {
                    matches!(
                        i.phase,
                        ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
                    )
                })
                || item.schedule.as_ref().is_some_and(|job| {
                    matches!(job.state, ScheduleState::Scheduled | ScheduleState::Claimed)
                })
            {
                return Err(err(
                    "Choose a future deadline and stop conflicting work before scheduling",
                ));
            }
            let team = saved_team(data, &team_id, team_revision)?;
            cancel_pending(data, workspace_id, &task_id);
            let run = ao_team::create_run_with_snapshot(
                data,
                workspace_id,
                run_id.clone(),
                task_id.clone(),
                data.control_board.revision,
                team.clone(),
                team.worker_limit,
            )?;
            item.schedule = Some(ScheduledStart {
                id: intent_id,
                run_id,
                due_at_ms,
                revision: 1,
                team_id,
                team_revision,
                state: ScheduleState::Scheduled,
            });
            output_run = Some(run);
        }
        LifecycleChange::ClaimSchedule { intent_id, .. } => {
            let job = item
                .schedule
                .as_mut()
                .filter(|job| job.id == intent_id)
                .ok_or_else(|| err("Schedule intent was not found"))?;
            if item.visibility != Visibility::Active
                || job.state != ScheduleState::Scheduled
                || now_ms < job.due_at_ms
                || active_work(data, workspace_id, &task_id)
                || item.reconfigure.iter().any(|i| {
                    matches!(
                        i.phase,
                        ReconfigurePhase::Prepared | ReconfigurePhase::NeedsAttention
                    )
                })
            {
                return Err(err(
                    "Schedule is not ready, already claimed, or needs attention",
                ));
            }
            let run = run_for(data, workspace_id, &task_id, &job.run_id)?;
            if run.cancelled || run.nodes.iter().any(|n| n.state != State::Pending) {
                return Err(err("Scheduled run changed; inspect it before restarting"));
            }
            job.state = ScheduleState::Claimed;
            job.revision += 1;
            output_run = Some(run);
        }
        LifecycleChange::CancelSchedule { intent_id, .. } => {
            if active_work(data, workspace_id, &task_id) {
                return Err(err("Stop this task before cancelling a claimed schedule"));
            }
            let job = item
                .schedule
                .as_mut()
                .filter(|job| job.id == intent_id)
                .ok_or_else(|| err("Schedule intent was not found"))?;
            cancel_pending(data, workspace_id, &task_id);
            job.state = ScheduleState::Cancelled;
            job.revision += 1;
        }
        LifecycleChange::RecoverSchedule {
            intent_id, action, ..
        } => {
            let job = item
                .schedule
                .as_mut()
                .filter(|job| job.id == intent_id)
                .ok_or_else(|| err("Schedule intent was not found"))?;
            job.state = match (action.as_str(), &job.state) {
                ("started", ScheduleState::Claimed) => ScheduleState::Started,
                ("missed", ScheduleState::Scheduled) if now_ms >= job.due_at_ms => {
                    ScheduleState::Missed
                }
                ("needs_attention", ScheduleState::Claimed) => ScheduleState::NeedsAttention,
                _ => {
                    return Err(err(
                        "Schedule recovery cannot rewind or replay an uncertain start",
                    ))
                }
            };
            job.revision += 1;
        }
    }
    item.revision = next_revision;
    if let Some(index) = index {
        data.ao_task_lifecycle[index] = item.clone();
    } else {
        data.ao_task_lifecycle.push(item.clone());
    }
    Ok(json!({"ok":true,"lifecycle":public_lifecycle(&item),"run":output_run}))
}
fn same_attempts(a: &[AttemptIdentity], b: &[AttemptIdentity]) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|identity| b.iter().filter(|other| *other == identity).count() == 1)
}
fn cancel_pending(data: &mut AppData, workspace_id: &str, task_id: &str) {
    for run in data
        .ao_runs
        .iter_mut()
        .filter(|run| run.workspace_id == workspace_id && run.project_id == task_id)
    {
        if run.nodes.iter().all(|n| n.state == State::Finished) {
            continue;
        }
        run.cancelled = true;
        run.paused = true;
        run.grant = None;
        run.revision += 1;
        for node in &mut run.nodes {
            if node.state == State::Pending {
                node.state = State::Cancelled;
            }
        }
    }
}

/// Moves a chat (a board task with its runs and lifecycle) from `source` to the `target`
/// workspace, whose folder its next session then works in. Task and run ids are global, so they
/// stay: the chat keeps every message and reply. Only an idle chat moves: no card reserved or
/// running, nothing scheduled or being reconfigured, no execution mission of its own. A failed
/// move changes nothing.
pub fn move_chat(
    data: &mut AppData,
    source: &str,
    target: &str,
    task_id: &str,
    expected_board_revision: u64,
    now_ms: u64,
) -> AppResult<Value> {
    valid_id(source)?;
    valid_id(target)?;
    valid_id(task_id)?;
    if source == target {
        return Err(err("The chat is already in this project"));
    }
    if !data.profiles.iter().any(|profile| profile.id == target) {
        return Err(err("The target project does not exist"));
    }
    if data.control_board.revision != expected_board_revision {
        return Err(err("The board changed; refresh before moving the chat"));
    }
    let mut next = data.clone();
    let task = next
        .control_board
        .tasks
        .iter_mut()
        .find(|task| task.id == task_id && task.workspace_id == source)
        .ok_or_else(|| err("Task is not registered in this workspace"))?;
    if task.state == "archived" {
        return Err(err("An archived chat cannot move; restore it first"));
    }
    if active_work(data, source, task_id) {
        return Err(err(
            "The chat is still working; move it once its turn has ended",
        ));
    }
    if let Some(item) = data
        .ao_task_lifecycle
        .iter()
        .find(|item| item.workspace_id == source && item.task_id == task_id)
    {
        if item.visibility != Visibility::Active {
            return Err(err(
                "An archived or deleted chat cannot move; restore it first",
            ));
        }
        if !item.reconfigure.is_empty() {
            return Err(err(
                "The chat is being reconfigured; move it once that finishes",
            ));
        }
        if item.schedule.as_ref().is_some_and(|schedule| {
            matches!(
                schedule.state,
                ScheduleState::Scheduled | ScheduleState::Claimed
            )
        }) {
            return Err(err(
                "The chat has a scheduled start; cancel it before moving the chat",
            ));
        }
    }
    if data.execution_book.missions.iter().any(|entry| {
        entry.mission.spec.workspace_id == source && entry.mission.spec.task_id == task_id
    }) {
        return Err(err(
            "The chat has an execution mission, which stays with its project",
        ));
    }
    task.workspace_id = target.into();
    task.updated_at = now_ms;
    next.control_board.revision += 1;
    let mut runs = Vec::new();
    for run in next
        .ao_runs
        .iter_mut()
        .filter(|run| run.workspace_id == source && run.project_id == task_id)
    {
        run.workspace_id = target.into();
        // A settled run's grant was for the old folder; it is never spent again.
        run.grant = None;
        run.revision += 1;
        if let Some(team) = run.team.as_mut().filter(|team| team.workspace_id == source) {
            team.workspace_id = target.into();
        }
        runs.push(run.id.clone());
    }
    for item in next
        .ao_task_lifecycle
        .iter_mut()
        .filter(|item| item.workspace_id == source && item.task_id == task_id)
    {
        item.workspace_id = target.into();
        item.revision += 1;
    }
    let board_revision = next.control_board.revision;
    *data = next;
    Ok(
        json!({"ok":true,"task_id":task_id,"from":source,"to":target,
        "runs":runs,"board_revision":board_revision}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::{ao, ao_team};
    use serde_json::json;

    fn fixture() -> AppData {
        let mut data: AppData = serde_json::from_value(json!({
            "profiles":[{"id":"qa","name":"QA","path":env!("CARGO_MANIFEST_DIR"),
                "tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
            "control_board":{"revision":1,"tasks":[{"id":"goal","workspace_id":"qa",
                "title":"Original mission","description":"Original user input","state":"backlog",
                "step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
        }))
        .unwrap();
        let route = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/high","permission_profile":":read-only"});
        let team = serde_json::from_value(json!({"id":"team","workspace_id":"qa","name":"Team",
            "revision":0,"worker_limit":2,"nodes":[
            {"id":"lead","task_id":"","role":"planner","parents":[],"x":0,"y":0,"state":"pending","route":route},
            {"id":"worker","task_id":"","role":"worker","parents":["lead"],"x":0,"y":1,"state":"pending","route":route},
            {"id":"review","task_id":"","role":"reviewer","parents":["worker"],"x":0,"y":2,"state":"pending","route":route}
        ]})).unwrap();
        ao_team::save(&mut data, "qa", 0, team).unwrap();
        ao_team::create_run(&mut data, "qa", "old".into(), "goal".into(), 1, 1, None, 2).unwrap();
        data
    }
    fn change(data: &mut AppData, body: Value, now_ms: u64) -> AppResult<Value> {
        apply_change(data, "qa", serde_json::from_value(body).unwrap(), now_ms)
    }
    fn prepare(data: &mut AppData, revision: u64, run_id: &str) -> Value {
        let run_revision = data
            .ao_runs
            .iter()
            .find(|r| r.id == run_id)
            .unwrap()
            .revision;
        change(
            data,
            json!({"operation":"prepare_reconfigure","task_id":"goal","intent_id":"edit",
            "expected_revision":revision,"run_id":run_id,"run_revision":run_revision,
            "team_id":"team","team_revision":1}),
            100,
        )
        .unwrap()
    }
    fn finish(attempts: Value, revision: u64) -> Value {
        json!({"operation":"finish_reconfigure","task_id":"goal","intent_id":"edit",
            "expected_revision":revision,"replacement_run_id":"new",
            "stopped_attempts":attempts,"handoff":"Verified file A; remaining work B."})
    }
    #[test]
    fn newest_run_window_retains_the_latest_replacement_and_direct_old_history() {
        let mut data = fixture();
        let original = data.ao_runs[0].clone();
        for index in 1..=105 {
            let mut run = original.clone();
            run.id = format!("replacement-{index}");
            data.ao_runs.push(run);
        }
        let listed = read_runs(&data, "qa", None).unwrap();
        assert_eq!(listed.len(), 100);
        assert_eq!(listed.last().unwrap().id, "replacement-105");
        assert_eq!(read_runs(&data, "qa", Some("old")).unwrap()[0].id, "old");
        assert!(read_runs(&data, "foreign", Some("old")).is_err());
    }

    #[test]
    fn a_chat_reads_its_own_runs_after_other_chats_fill_the_workspace_window() {
        let mut data = fixture();
        let original = data.ao_runs[0].clone();
        let other = |index: usize| {
            let mut run = original.clone();
            run.id = format!("other-{index}");
            run.project_id = "other".into();
            run
        };
        let added: Vec<_> = (1..=105).map(other).collect();
        data.ao_runs.extend(added);
        assert!(read_runs(&data, "qa", None)
            .unwrap()
            .iter()
            .all(|run| run.id != "old"));
        let chat = read_chat_runs(&data, "qa", "goal");
        assert_eq!(
            chat.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
            ["old"]
        );
        assert!(read_chat_runs(&data, "foreign", "goal").is_empty());
        assert_eq!(read_chat_runs(&data, "qa", "other").len(), 105);
        // A chat's history is capped at its newest runs, oldest first.
        let added: Vec<_> = (106..=CHAT_RUNS_LIMIT + 10).map(other).collect();
        data.ao_runs.extend(added);
        let capped = read_chat_runs(&data, "qa", "other");
        assert_eq!(capped.len(), CHAT_RUNS_LIMIT);
        assert_eq!(capped[0].id, "other-11");
        assert_eq!(
            capped.last().unwrap().id,
            format!("other-{}", CHAT_RUNS_LIMIT + 10)
        );
    }

    #[test]
    fn a_read_of_long_replies_fits_the_budget_and_keeps_the_newest() {
        // 2026-11-12: a 182-run goal chat's read passed the app's 1 MiB, so that chat never opened.
        let mut data = fixture();
        let original = data.ao_runs[0].clone();
        let long = |index: usize| {
            let mut run = original.clone();
            run.id = format!("long-{index:03}-{}", "x".repeat(16 * 1024));
            run
        };
        data.ao_runs.extend((1..=182).map(long));
        let size = |runs: &[Run]| serde_json::to_vec(runs).unwrap().len();
        // The newest runs, oldest first, with none skipped.
        let newest_in_order = |runs: &[Run]| {
            runs.windows(2).all(|pair| pair[0].id < pair[1].id)
                && runs
                    .last()
                    .is_some_and(|run| run.id.starts_with("long-182-"))
        };
        let chat = read_chat_runs(&data, "qa", "goal");
        assert!(size(&chat) <= RUNS_READ_BUDGET, "{} bytes", size(&chat));
        assert!(chat.len() >= 20 && chat.len() < 182, "{} runs", chat.len());
        assert!(newest_in_order(&chat));
        let project = read_runs(&data, "qa", None).unwrap();
        assert!(
            size(&project) <= RUNS_READ_BUDGET,
            "{} bytes",
            size(&project)
        );
        assert!(newest_in_order(&project));
        // One run past the budget on its own still comes back: a read is never empty.
        let mut huge = original.clone();
        huge.id = format!("huge-{}", "y".repeat(RUNS_READ_BUDGET));
        huge.project_id = "solo".into();
        data.ao_runs.push(huge);
        assert_eq!(read_chat_runs(&data, "qa", "solo").len(), 1);
    }

    #[test]
    fn public_polling_metadata_omits_snapshot_payloads_and_retains_legacy_archive_identity() {
        let mut data = fixture();
        prepare(&mut data, 0, "old");
        let public = read_public_lifecycles(&data, "qa", &data.ao_runs);
        assert_eq!(public[0]["title"], "Original mission");
        assert!(public[0]["reconfigure"][0].get("team").is_none());
        assert!(public[0]["reconfigure"][0].get("handoff").is_none());
        assert_eq!(public[0]["reconfigure"][0]["required_attempts"], json!([]));
        data.ao_task_lifecycle.clear();
        data.control_board.tasks[0].state = "archived".into();
        assert_eq!(
            read_public_lifecycles(&data, "qa", &data.ao_runs)[0]["visibility"],
            "archived"
        );
    }

    #[test]
    fn uncertain_replacement_must_resolve_exact_stop_identities_before_hiding_or_another_edit() {
        let mut data = fixture();
        prepare(&mut data, 0, "old");
        change(
            &mut data,
            json!({"operation":"reconfigure_attention","task_id":"goal","intent_id":"edit",
            "expected_revision":1,"message":"Owned stop unknown"}),
            101,
        )
        .unwrap();
        ao_team::control(&mut data, "qa", "old", "stop").unwrap();
        assert!(change(
            &mut data,
            json!({"operation":"set_visibility","task_id":"goal","expected_revision":2,
            "visibility":"archived"}),
            102
        )
        .is_err());
        change(
            &mut data,
            json!({"operation":"reconfigure_stopped","task_id":"goal","intent_id":"edit",
            "expected_revision":2,"stopped_attempts":[]}),
            103,
        )
        .unwrap();
        assert!(change(
            &mut data,
            json!({"operation":"set_visibility","task_id":"goal","expected_revision":3,
            "visibility":"archived"}),
            104
        )
        .is_ok());
    }

    #[test]
    fn reconfigured_recovery_jobs_keep_their_hold_and_retarget_without_replay() {
        for state in ["missed", "needs_attention", "cancelled", "claimed"] {
            let mut data = fixture();
            change(
                &mut data,
                json!({"operation":"schedule_start","task_id":"goal","intent_id":"job",
                "expected_revision":0,"run_id":"delayed","team_id":"team","team_revision":1,
                "due_at_ms":1000}),
                100,
            )
            .unwrap();
            let mut saved = serde_json::to_value(&data).unwrap();
            saved["ao_task_lifecycle"][0]["schedule"]["state"] = json!(state);
            data = serde_json::from_value(saved).unwrap();
            prepare(&mut data, 1, "delayed");
            ao_team::control(&mut data, "qa", "delayed", "stop").unwrap();
            change(&mut data, finish(json!([]), 2), 200).unwrap();
            let result = serde_json::to_value(&data).unwrap();
            assert_eq!(result["ao_task_lifecycle"][0]["schedule"]["run_id"], "new");
            assert_eq!(
                result["ao_task_lifecycle"][0]["schedule"]["state"],
                if state == "claimed" {
                    "needs_attention"
                } else {
                    state
                }
            );
            assert_eq!(
                result["ao_task_lifecycle"][0]["schedule"]["due_at_ms"],
                1000
            );
            let run = data.ao_runs.last().unwrap().clone();
            assert!(
                ao::grant_run(&mut data, "qa", &run.id, run.revision, &"a".repeat(64), 201)
                    .is_err()
            );
        }
    }

    #[test]
    fn legacy_data_defaults_to_an_empty_lifecycle_collection() {
        let data: AppData = serde_json::from_value(json!({"profiles":[]})).unwrap();
        assert_eq!(
            serde_json::to_value(data).unwrap()["ao_task_lifecycle"],
            json!([])
        );
    }
    #[test]
    fn replacement_is_scoped_idempotent_and_preserves_input_and_history() {
        let mut data = fixture();
        prepare(&mut data, 0, "old");
        ao_team::control(&mut data, "qa", "old", "stop").unwrap();
        let body = finish(json!([]), 1);
        let result = change(&mut data, body.clone(), 200).unwrap();
        assert_eq!(result["run"]["id"], "new");
        let snapshot = serde_json::to_value(&data).unwrap();
        assert_eq!(change(&mut data, body, 201).unwrap()["run"]["id"], "new");
        assert_eq!(serde_json::to_value(&data).unwrap(), snapshot);
        assert_eq!(
            data.control_board.tasks[0].description,
            "Original user input"
        );
        assert_eq!(data.ao_runs.len(), 2);
        assert!(data.ao_runs[0].cancelled);
        let new = data.ao_runs.last().unwrap();
        let prompt = ao::prompt_for_node(&data, new, &new.nodes[0].id).unwrap();
        assert!(prompt.contains("Original user input"));
        assert!(prompt.contains("quoted visible work"));
        assert!(prompt.contains("Verified file A"));
    }
    #[test]
    fn stale_or_foreign_changes_do_not_mutate_saved_state() {
        let mut data = fixture();
        let before = serde_json::to_value(&data).unwrap();
        for body in [
            json!({"operation":"prepare_reconfigure","task_id":"goal","intent_id":"edit",
                "expected_revision":9,"run_id":"old","run_revision":0,"team_id":"team","team_revision":1}),
            json!({"operation":"prepare_reconfigure","task_id":"foreign","intent_id":"edit",
                "expected_revision":0,"run_id":"old","run_revision":0,"team_id":"team","team_revision":1}),
        ] {
            assert!(change(&mut data, body, 100).is_err());
            assert_eq!(serde_json::to_value(&data).unwrap(), before);
        }
        assert!(apply_change(
            &mut data,
            "foreign",
            serde_json::from_value(finish(json!([]), 0)).unwrap(),
            100
        )
        .is_err());
        assert_eq!(serde_json::to_value(&data).unwrap(), before);
    }
    #[test]
    fn active_attempt_requires_exact_stop_acknowledgement_before_replacement() {
        let mut data = fixture();
        let run = data.ao_runs[0].clone();
        let granted =
            ao::grant_run(&mut data, "qa", "old", run.revision, &"a".repeat(64), 1).unwrap();
        let reserved = ao::reserve(
            &mut data,
            "qa",
            "old",
            &run.nodes[0].id,
            granted.revision,
            "attempt-one".into(),
            Some(2),
        )
        .unwrap();
        prepare(&mut data, 0, "old");
        assert!(change(&mut data, finish(json!([]), 1), 200).is_err());
        ao_team::control(&mut data, "qa", "old", "stop").unwrap();
        ao_team::control(&mut data, "qa", "old", "stopped").unwrap();
        let before = serde_json::to_value(&data).unwrap();
        assert!(change(
            &mut data,
            finish(
                json!([{"node_id":"foreign","request_key":"attempt-one"}]),
                1
            ),
            200
        )
        .is_err());
        assert_eq!(serde_json::to_value(&data).unwrap(), before);
        let stopped = json!([{"node_id":reserved.nodes[0].id,"request_key":"attempt-one"}]);
        assert!(change(&mut data, finish(stopped, 1), 201).is_ok());
    }
    #[test]
    fn hidden_tasks_cannot_be_granted_and_restore_retains_the_original_input() {
        let mut data = fixture();
        change(
            &mut data,
            json!({"operation":"set_visibility","task_id":"goal",
            "expected_revision":0,"visibility":"archived"}),
            100,
        )
        .unwrap();
        let run = data.ao_runs[0].clone();
        assert!(ao::grant_run(&mut data, "qa", "old", run.revision, &"a".repeat(64), 101).is_err());
        change(
            &mut data,
            json!({"operation":"restore_task","task_id":"goal","expected_revision":1}),
            102,
        )
        .unwrap();
        assert_eq!(
            data.control_board.tasks[0].description,
            "Original user input"
        );
        assert_ne!(data.control_board.tasks[0].state, "archived");
    }
    #[test]
    fn an_archived_task_can_be_deleted_and_restored() {
        let mut data = fixture();
        for (revision, visibility) in [(0, "archived"), (1, "deleted")] {
            change(
                &mut data,
                json!({"operation":"set_visibility","task_id":"goal",
                "expected_revision":revision,"visibility":visibility}),
                100 + revision,
            )
            .unwrap();
        }
        assert_eq!(data.control_board.tasks[0].state, "archived");
        change(
            &mut data,
            json!({"operation":"restore_task","task_id":"goal","expected_revision":2}),
            102,
        )
        .unwrap();
        assert_ne!(data.control_board.tasks[0].state, "archived");
    }
    #[test]
    fn schedule_claims_once_and_restart_recovery_never_replays_unknown_work() {
        let mut data = fixture();
        change(
            &mut data,
            json!({"operation":"schedule_start","task_id":"goal","intent_id":"job",
            "expected_revision":0,"run_id":"delayed","team_id":"team","team_revision":1,
            "due_at_ms":1000}),
            100,
        )
        .unwrap();
        let claim = json!({"operation":"claim_schedule","task_id":"goal","intent_id":"job","expected_revision":1});
        assert!(change(&mut data, claim.clone(), 999).is_err());
        assert_eq!(
            change(&mut data, claim.clone(), 1000).unwrap()["run"]["id"],
            "delayed"
        );
        assert!(change(&mut data, claim, 1001).is_err());
        change(
            &mut data,
            json!({"operation":"recover_schedule","task_id":"goal","intent_id":"job",
            "expected_revision":2,"action":"needs_attention"}),
            1002,
        )
        .unwrap();
        assert!(change(
            &mut data,
            json!({"operation":"claim_schedule","task_id":"goal","intent_id":"job",
            "expected_revision":3}),
            1003
        )
        .is_err());
    }
    #[test]
    fn editing_a_scheduled_task_preserves_its_deadline_without_starting_it() {
        let mut data = fixture();
        change(
            &mut data,
            json!({"operation":"schedule_start","task_id":"goal","intent_id":"job",
            "expected_revision":0,"run_id":"delayed","team_id":"team","team_revision":1,
            "due_at_ms":1000}),
            100,
        )
        .unwrap();
        prepare(&mut data, 1, "delayed");
        ao_team::control(&mut data, "qa", "delayed", "stop").unwrap();
        change(&mut data, finish(json!([]), 2), 200).unwrap();
        let saved = serde_json::to_value(&data).unwrap();
        assert_eq!(saved["ao_task_lifecycle"][0]["schedule"]["due_at_ms"], 1000);
        assert_eq!(saved["ao_task_lifecycle"][0]["schedule"]["run_id"], "new");
        assert_eq!(
            saved["ao_task_lifecycle"][0]["schedule"]["state"],
            "scheduled"
        );
        assert!(data
            .ao_runs
            .last()
            .unwrap()
            .nodes
            .iter()
            .all(|n| n.state == ao::State::Pending));
    }

    fn with_second_project(mut data: AppData) -> AppData {
        data.profiles.push(
            serde_json::from_value(json!({"id":"qb","name":"QB",
            "path":env!("CARGO_MANIFEST_DIR"),"tunnel":{},"auth":{"type":"bearer"},
            "runtime":{},"actions":{}}))
            .unwrap(),
        );
        data
    }

    #[test]
    fn an_idle_chat_moves_with_its_runs_and_lifecycle() {
        let mut data = with_second_project(fixture());
        // Archived and restored: the chat has a lifecycle record to move too.
        change(
            &mut data,
            json!({"operation":"set_visibility","task_id":"goal","expected_revision":0,"visibility":"archived"}),
            50,
        )
        .unwrap();
        change(
            &mut data,
            json!({"operation":"restore_task","task_id":"goal","expected_revision":1}),
            60,
        )
        .unwrap();
        assert_eq!(data.ao_task_lifecycle.len(), 1);
        let revision = data.control_board.revision;
        let moved = move_chat(&mut data, "qa", "qb", "goal", revision, 100).unwrap();
        assert_eq!(moved["runs"], json!(["old"]));
        assert_eq!(moved["board_revision"], revision + 1);
        let task = &data.control_board.tasks[0];
        assert_eq!((task.workspace_id.as_str(), task.updated_at), ("qb", 100));
        let run = data.ao_runs.iter().find(|run| run.id == "old").unwrap();
        assert_eq!(run.workspace_id, "qb");
        assert!(run.grant.is_none());
        assert_eq!(run.team.as_ref().unwrap().workspace_id, "qb");
        assert!(data
            .ao_task_lifecycle
            .iter()
            .all(|item| item.workspace_id == "qb"));
        assert!(read_runs(&data, "qa", None).unwrap().is_empty());
        assert_eq!(read_runs(&data, "qb", None).unwrap().len(), 1);
    }

    #[test]
    fn a_chat_moves_only_when_idle_to_another_known_project() {
        let base = with_second_project(fixture());
        let revision = base.control_board.revision;
        let refused = |data: &mut AppData, target: &str, revision: u64| {
            let before = serde_json::to_value(&*data).unwrap();
            let error = move_chat(data, "qa", target, "goal", revision, 1)
                .unwrap_err()
                .to_string();
            assert_eq!(
                serde_json::to_value(&*data).unwrap(),
                before,
                "a refused move changes nothing"
            );
            error
        };
        let mut data = base.clone();
        assert!(refused(&mut data, "qa", revision).contains("already in this project"));
        assert!(refused(&mut data, "nowhere", revision).contains("does not exist"));
        assert!(refused(&mut data, "qb", revision + 1).contains("board changed"));
        data.ao_runs[0].nodes[0].state = ao::State::Running;
        assert!(refused(&mut data, "qb", revision).contains("still working"));
        let mut data = base.clone();
        change(
            &mut data,
            json!({"operation":"schedule_start","task_id":"goal","intent_id":"job",
            "expected_revision":0,"run_id":"delayed","team_id":"team","team_revision":1,
            "due_at_ms":1000}),
            10,
        )
        .unwrap();
        let revision = data.control_board.revision;
        assert!(refused(&mut data, "qb", revision).contains("scheduled start"));
        let mut data = base;
        change(
            &mut data,
            json!({"operation":"set_visibility","task_id":"goal","expected_revision":0,"visibility":"archived"}),
            10,
        )
        .unwrap();
        let revision = data.control_board.revision;
        assert!(refused(&mut data, "qb", revision).contains("archived"));
    }
}

//! An operator-driven Anneal-style checklist, never an unattended agent scheduler.
use super::{err, now};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
pub const STEPS: [&str; 12] = [
    "Specification",
    "Plan",
    "Plan review",
    "Revise plan",
    "Implementation",
    "Code review",
    "Independent review",
    "Apply fixes",
    "Documentation",
    "Verification",
    "Merge readiness",
    "Delivery",
];
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct Board {
    pub revision: u64,
    pub tasks: Vec<Task>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub state: String,
    pub step: usize,
    pub created_at: u64,
    pub updated_at: u64,
    pub evidence: Vec<Evidence>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub step: usize,
    pub note: String,
    pub recorded_at: u64,
    pub source: String,
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    Create {
        workspace_id: String,
        title: String,
        description: String,
    },
    Start {
        id: String,
    },
    RecordStep {
        id: String,
        note: String,
    },
    Block {
        id: String,
    },
    Resume {
        id: String,
    },
    Archive {
        id: String,
    },
    Restore {
        id: String,
    },
}
fn clean(s: &str, max: usize) -> AppResult<String> {
    let s = s.trim();
    if s.len() > max
        || s.chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(err(
            "Text exceeds limits or contains unsupported control characters",
        ));
    }
    Ok(s.into())
}
pub fn apply(b: &mut Board, revision: u64, change: Change) -> AppResult<()> {
    if b.revision != revision {
        return Err(err(
            "The board changed in another window. Refresh before retrying.",
        ));
    }
    let stamp = now();
    match change {
        Change::Create {
            workspace_id,
            title,
            description,
        } => {
            if b.tasks.len() >= 250 {
                return Err(err("Local board limit reached (250 retained tasks). Existing records were preserved."));
            }
            let title = clean(&title, 240)?;
            if title.is_empty() {
                return Err(err("Enter a task title"));
            }
            b.tasks.push(Task {
                id: uuid::Uuid::new_v4().to_string(),
                workspace_id,
                title,
                description: clean(&description, 8192)?,
                state: "backlog".into(),
                step: 0,
                created_at: stamp,
                updated_at: stamp,
                evidence: vec![],
            });
        }
        other => {
            let id = match &other {
                Change::Start { id }
                | Change::RecordStep { id, .. }
                | Change::Block { id }
                | Change::Resume { id }
                | Change::Archive { id }
                | Change::Restore { id } => id,
                Change::Create { .. } => unreachable!(),
            };
            let t = b
                .tasks
                .iter_mut()
                .find(|t| &t.id == id)
                .ok_or_else(|| err("Task no longer exists"))?;
            match other {
                Change::Start { .. } if t.state == "backlog" => t.state = "in_progress".into(),
                Change::RecordStep { note, .. }
                    if t.state == "in_progress" && t.step < STEPS.len() =>
                {
                    let note = clean(&note, 4096)?;
                    if note.is_empty() {
                        return Err(err("Record evidence or an explicit operator attestation before completing this step"));
                    }
                    t.evidence.push(Evidence {
                        step: t.step,
                        note,
                        recorded_at: stamp,
                        source: "operator_attestation".into(),
                    });
                    t.step += 1;
                    if t.step == STEPS.len() {
                        t.state = "done".into();
                    }
                }
                Change::Block { .. } if t.state == "in_progress" => t.state = "blocked".into(),
                Change::Resume { .. } if t.state == "blocked" => t.state = "in_progress".into(),
                Change::Archive { .. } if t.state != "archived" => t.state = "archived".into(),
                Change::Restore { .. } if t.state == "archived" => {
                    t.state = if t.step == STEPS.len() {
                        "done"
                    } else {
                        "backlog"
                    }
                    .into()
                }
                _ => {
                    return Err(err(
                        "This task transition is not available in the current state",
                    ))
                }
            }
            t.updated_at = stamp;
        }
    }
    b.revision = b
        .revision
        .checked_add(1)
        .ok_or_else(|| err("Board revision exhausted"))?;
    Ok(())
}

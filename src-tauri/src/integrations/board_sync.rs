//! Authenticated MCP changes to the same board as the local UI, never human attestations.
use super::{
    board::{self, Board, Change, Evidence},
    err, now,
};
use crate::error::AppResult;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Update {
    Create {
        title: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        state: Option<String>,
    },
    Move {
        id: String,
        state: String,
        #[serde(default)]
        before_id: Option<String>,
    },
    Edit {
        id: String,
        title: String,
        description: String,
    },
    Observe {
        id: String,
        note: String,
    },
    Archive {
        id: String,
    },
    Restore {
        id: String,
    },
}
impl Update {
    fn id(&self) -> Option<&str> {
        match self {
            Self::Create { .. } => None,
            Self::Move { id, .. }
            | Self::Edit { id, .. }
            | Self::Observe { id, .. }
            | Self::Archive { id }
            | Self::Restore { id } => Some(id),
        }
    }
}
fn own<'a>(b: &'a Board, workspace: &str, id: &str) -> AppResult<&'a board::Task> {
    b.tasks
        .iter()
        .find(|t| t.workspace_id == workspace && t.id == id)
        .ok_or_else(|| err("Task is not in this listener's approved workspace"))
}
fn text(s: &str, max: usize, required: bool) -> AppResult<String> {
    let s = s.trim();
    if (required && s.is_empty())
        || s.len() > max
        || s.chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(err(
            "Text is empty, oversized or contains unsupported controls",
        ));
    }
    Ok(s.into())
}
pub fn apply_scoped(
    b: &mut Board,
    workspace: &str,
    revision: u64,
    update: Update,
) -> AppResult<String> {
    if workspace.is_empty() || b.revision != revision {
        return Err(err(
            "Workflow revision changed; read before retrying. Nothing was saved.",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    if b.tasks.iter().any(|t| !ids.insert(t.id.as_str())) {
        return Err(err(
            "Ambiguous task IDs; preserve the board and resolve duplicate records locally",
        ));
    }
    let next = revision
        .checked_add(1)
        .ok_or_else(|| err("Board revision exhausted"))?;
    if let Some(id) = update.id() {
        own(b, workspace, id)?;
    }
    if let Update::Move {
        before_id: Some(id),
        ..
    } = &update
    {
        own(b, workspace, id)?;
    }
    // Commit the validated clone only. Unknown/stale/foreign requests are all atomic.
    let mut draft = b.clone();
    let id = match update {
        Update::Create {
            title,
            description,
            state,
        } => {
            board::apply(
                &mut draft,
                revision,
                Change::Create {
                    workspace_id: workspace.into(),
                    title,
                    description,
                    state,
                },
            )?;
            draft
                .tasks
                .last()
                .ok_or_else(|| err("Task creation returned no task"))?
                .id
                .clone()
        }
        Update::Move {
            id,
            state,
            before_id,
        } => {
            board::apply(
                &mut draft,
                revision,
                Change::Move {
                    id: id.clone(),
                    state,
                    before_id,
                },
            )?;
            id
        }
        Update::Archive { id } => {
            board::apply(&mut draft, revision, Change::Archive { id: id.clone() })?;
            id
        }
        Update::Restore { id } => {
            board::apply(&mut draft, revision, Change::Restore { id: id.clone() })?;
            id
        }
        Update::Edit {
            id,
            title,
            description,
        } => {
            let title = text(&title, 240, true)?;
            let description = text(&description, 8192, false)?;
            let t = draft
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.workspace_id == workspace)
                .ok_or_else(|| err("Task changed"))?;
            t.title = title;
            t.description = description;
            t.updated_at = now();
            draft.revision = next;
            id
        }
        Update::Observe { id, note } => {
            let note = text(&note, 4096, true)?;
            let t = draft
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.workspace_id == workspace)
                .ok_or_else(|| err("Task changed"))?;
            if t.state == "archived" || t.evidence.len() >= 256 {
                return Err(err(
                    "Restore this task or preserve existing evidence; observation capacity reached",
                ));
            }
            // Observations can be reviewed by humans, but never advance a review checkpoint.
            t.evidence.push(Evidence {
                step: t.step.min(board::STEPS.len() - 1),
                note,
                recorded_at: now(),
                source: "mcp_observation".into(),
            });
            t.updated_at = now();
            draft.revision = next;
            id
        }
    };
    *b = draft;
    Ok(id)
}
pub fn view(
    b: &Board,
    workspace: &str,
    task_id: Option<&str>,
    offset: usize,
    limit: usize,
    include_archived: bool,
) -> AppResult<Value> {
    if workspace.is_empty() || limit == 0 || limit > 100 {
        return Err(err("Invalid workflow scope or page size"));
    }
    if let Some(id) = task_id {
        let t = own(b, workspace, id)?;
        let evidence = t.evidence.iter().skip(offset).take(20).collect::<Vec<_>>();
        let next = offset.saturating_add(evidence.len());
        Ok(
            json!({"workspace_id":workspace,"revision":b.revision,"steps":board::STEPS,
            "task":{"id":t.id,"workspace_id":workspace,"title":t.title,"description":t.description,
                "state":t.state,"step":t.step,"created_at":t.created_at,"updated_at":t.updated_at,"evidence":evidence},
            "evidence_count":t.evidence.len(),"next_offset":if next<t.evidence.len(){Some(next)}else{None},
            "model_calls":false,"review_steps_require_human_attestation":true}),
        )
    } else {
        let scoped = b
            .tasks
            .iter()
            .filter(|t| t.workspace_id == workspace && (include_archived || t.state != "archived"))
            .collect::<Vec<_>>();
        let tasks=scoped.iter().skip(offset).take(limit).map(|t|json!({"id":t.id,"workspace_id":workspace,
            "title":t.title,"state":t.state,"step":t.step,"updated_at":t.updated_at,"evidence_count":t.evidence.len()})).collect::<Vec<_>>();
        let next = offset.saturating_add(tasks.len());
        Ok(
            json!({"workspace_id":workspace,"revision":b.revision,"steps":board::STEPS,"tasks":tasks,
            "total":scoped.len(),"next_offset":if next<scoped.len(){Some(next)}else{None},"model_calls":false}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn update(b: &mut Board, w: &str, v: Value) -> AppResult<String> {
        apply_scoped(b, w, b.revision, serde_json::from_value(v).unwrap())
    }
    #[test]
    fn workflow_043_scope_revision_and_observations_are_atomic() {
        let mut b = Board::default();
        let a = update(
            &mut b,
            "a",
            json!({"operation":"create","title":"A","state":"blocked"}),
        )
        .unwrap();
        let x = update(
            &mut b,
            "b",
            json!({"operation":"create","title":"PRIVATE","state":"blocked"}),
        )
        .unwrap();
        let before = serde_json::to_value(&b).unwrap();
        for bad in [
            json!({"operation":"archive","id":x}),
            json!({"operation":"move","id":a,"state":"blocked","before_id":x}),
        ] {
            assert!(update(&mut b, "a", bad).is_err());
            assert_eq!(serde_json::to_value(&b).unwrap(), before);
        }
        assert!(apply_scoped(&mut b, "a", 0, Update::Archive { id: a.clone() }).is_err());
        assert!(!view(&b, "a", None, 0, 50, false)
            .unwrap()
            .to_string()
            .contains("PRIVATE"));
        assert!(view(&b, "a", Some(&x), 0, 50, false).is_err());
        update(&mut b,"a",json!({"operation":"observe","id":a,"note":"Observed failing test; awaiting human review."})).unwrap();
        let task = own(&b, "a", &a).unwrap();
        assert_eq!(task.step, 0);
        assert_eq!(task.state, "blocked");
        assert_eq!(task.evidence[0].source, "mcp_observation");
        assert!(serde_json::from_value::<Update>(
            json!({"operation":"record_step","id":a,"note":"spoofed"})
        )
        .is_err());
        assert!(serde_json::from_value::<Update>(
            json!({"operation":"create","workspace_id":"b","title":"escape"})
        )
        .is_err());
        update(
            &mut b,
            "a",
            json!({"operation":"move","id":a,"state":"done"}),
        )
        .unwrap();
        assert_eq!(own(&b, "a", &a).unwrap().step, 0);
        let restored: Board = serde_json::from_slice(&serde_json::to_vec(&b).unwrap()).unwrap();
        assert_eq!(
            view(&restored, "a", Some(&a), 0, 1, false).unwrap()["evidence_count"],
            1
        );
    }
}

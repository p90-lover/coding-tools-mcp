//! Idempotent task/run acceptance; harness dispatch remains a separate operation.
use super::{ao, ao_team, board_sync, err};
use crate::data::AppData;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RECEIPT_LIMIT: usize = 100_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub workspace_id: String,
    pub input_id: String,
    pub digest: String,
    pub task_id: String,
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accept {
    pub input_id: String,
    pub expected_board_revision: u64,
    #[serde(default)]
    pub task_id: Option<String>,
    pub title: String,
    pub description: String,
    pub message: String,
    pub run_id: String,
    pub worker_limit: u8,
    #[serde(default)]
    pub execution_mode: Option<ao::ExecutionMode>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub team_revision: Option<u64>,
    #[serde(default)]
    pub single_route: Option<ao::Route>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_'))
}

pub fn lookup(data: &AppData, workspace: &str, input_id: &str) -> AppResult<Value> {
    if !valid_id(input_id) {
        return Err(err("Invalid chat input identity"));
    }
    match data
        .chat_input_receipts
        .iter()
        .find(|receipt| receipt.workspace_id == workspace && receipt.input_id == input_id)
    {
        Some(receipt) => {
            let run = data
                .ao_runs
                .iter()
                .find(|run| run.workspace_id == workspace && run.id == receipt.run_id)
                .ok_or_else(|| err("Accepted chat input has no retained run; do not resend it"))?;
            Ok(
                json!({"ok":true,"found":true,"duplicate":true,"input_id":input_id,"task_id":receipt.task_id,"run_id":receipt.run_id,"run":run}),
            )
        }
        None => Ok(json!({"ok":true,"found":false})),
    }
}

pub fn accept(data: &mut AppData, workspace: &str, request: Accept) -> AppResult<Value> {
    if workspace.is_empty()
        || !valid_id(&request.input_id)
        || !valid_id(&request.run_id)
        || request.message.trim().is_empty()
        || request.message.len() > 8192
    {
        return Err(err("Invalid chat input identity or message"));
    }
    let semantic = json!({"workspace":workspace,"input_id":request.input_id,"task_id":request.task_id,
        "message":request.message,"title":request.title,"worker_limit":request.worker_limit,
        "execution_mode":request.execution_mode,"team_id":request.team_id,"team_revision":request.team_revision,
        "single_route":request.single_route});
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&semantic)?));
    if let Some(previous) = data
        .chat_input_receipts
        .iter()
        .find(|receipt| receipt.workspace_id == workspace && receipt.input_id == request.input_id)
    {
        if previous.digest != digest {
            return Err(err("Chat input identity belongs to different content"));
        }
        return lookup(data, workspace, &request.input_id);
    }
    if data.chat_input_receipts.len() >= RECEIPT_LIMIT {
        return Err(err(
            "Chat input receipt capacity reached; existing input identities were preserved",
        ));
    }
    let mut board = data.control_board.clone();
    let change = match request.task_id {
        Some(id) => board_sync::Update::Edit {
            id,
            title: request.title,
            description: request.description,
        },
        None => board_sync::Update::Create {
            title: request.title,
            description: request.description,
            state: None,
        },
    };
    let task_id = board_sync::apply_scoped(
        &mut board,
        workspace,
        request.expected_board_revision,
        change,
    )?;
    let revision = board.revision;
    let previous_board = std::mem::replace(&mut data.control_board, board);
    let created = ao_team::create_selected_run(
        data,
        workspace,
        request.run_id.clone(),
        task_id.clone(),
        revision,
        request.worker_limit,
        ao_team::CreateSelection {
            execution_mode: request.execution_mode,
            team_id: request.team_id,
            team_revision: request.team_revision,
            single_route: request.single_route,
        },
    );
    let run = match created {
        Ok(run) => run,
        Err(error) => {
            data.control_board = previous_board;
            return Err(error);
        }
    };
    data.chat_input_receipts.push(Receipt {
        workspace_id: workspace.into(),
        input_id: request.input_id.clone(),
        digest,
        task_id: task_id.clone(),
        run_id: run.id.clone(),
    });
    Ok(
        json!({"ok":true,"found":true,"duplicate":false,"input_id":request.input_id,"task_id":task_id,"run_id":run.id,"run":run}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> Accept {
        serde_json::from_value(json!({"input_id":id,"expected_board_revision":0,"title":"Fixture task","description":"hello","message":"hello",
            "run_id":"run-one","worker_limit":1,"execution_mode":"single",
            "single_route":{"harness_id":"ao:codex","provider_id":"agent-orchestrator","account_id":"ao-local","model":"fixture","permission_profile":":ao-default"}})).unwrap()
    }
    #[test]
    fn atomic_chat_input_rolls_back_board_when_run_validation_fails() {
        let mut data = AppData::default();
        let before = serde_json::to_value(&data).unwrap();
        let mut invalid = request("first");
        invalid.worker_limit = 0;
        assert!(accept(&mut data, "workspace", invalid).is_err());
        assert_eq!(serde_json::to_value(&data).unwrap(), before);
        assert!(data.chat_input_receipts.is_empty());
    }
    #[test]
    fn atomic_chat_input_duplicate_returns_original_ids_after_board_changes() {
        let mut data = AppData::default();
        let first = accept(&mut data, "workspace", request("same")).unwrap();
        data.control_board.revision += 1;
        let mut repeated = request("same");
        repeated.run_id = "another-proposed-run".into();
        repeated.description = "stale proposal must not overwrite".into();
        let duplicate = accept(&mut data, "workspace", repeated).unwrap();
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["task_id"], first["task_id"]);
        assert_eq!(duplicate["run_id"], first["run_id"]);
        assert_eq!(data.control_board.tasks.len(), 1);
        assert_eq!(data.ao_runs.len(), 1);
        assert_eq!(data.control_board.tasks[0].description, "hello");
        assert_eq!(
            lookup(&data, "other-workspace", "same").unwrap()["found"],
            false
        );
    }
    #[test]
    fn atomic_chat_input_old_state_defaults_to_empty_receipts() {
        let data: AppData = serde_json::from_value(json!({})).unwrap();
        assert!(data.chat_input_receipts.is_empty());
        assert_eq!(
            lookup(&data, "workspace", "unknown").unwrap()["found"],
            false
        );
    }
    #[test]
    fn atomic_chat_input_conflict_preserves_data_before_revision_check() {
        let mut data = AppData::default();
        data.chat_input_receipts.push(Receipt {
            workspace_id: "workspace".into(),
            input_id: "first".into(),
            digest: "different".into(),
            task_id: "task".into(),
            run_id: "run".into(),
        });
        let before = serde_json::to_value(&data).unwrap();
        let error = accept(&mut data, "workspace", request("first"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("different content"));
        assert_eq!(serde_json::to_value(&data).unwrap(), before);
    }
}

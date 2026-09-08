//! Local planning and read-only upstream control-plane integrations. No agent runner.
mod adapters;
use crate::data::DataStore;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::WebviewWindow;

fn failure(message: &str) -> AppError {
    AppError::Message(message.into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn visible_main(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main"
        || !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
    {
        return Err(failure(
            "Open the local control center before changing connections or tasks.",
        ));
    }
    Ok(())
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Paseo,
    Anneal,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub enabled: bool,
    pub url: String,
}
impl Connection {
    fn initial(url: &str) -> Self {
        Self {
            enabled: false,
            url: url.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CenterData {
    pub paseo: Connection,
    pub anneal: Connection,
    pub tasks: Vec<LocalTask>,
}
impl Default for CenterData {
    fn default() -> Self {
        Self {
            paseo: Connection::initial("ws://127.0.0.1:6767/ws"),
            anneal: Connection::initial("http://127.0.0.1:5173/api"),
            tasks: Vec::new(),
        }
    }
}
impl CenterData {
    fn connection(&self, provider: Provider) -> &Connection {
        match provider {
            Provider::Paseo => &self.paseo,
            Provider::Anneal => &self.anneal,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Stage {
    BACKLOG,
    TODO,
    DOING,
    REVIEW,
    DONE,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalTask {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub status: Stage,
    pub priority: String,
    pub review_note: String,
    pub verification_note: String,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub archived: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskDraft {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub status: Stage,
    pub priority: String,
    pub review_note: String,
    pub verification_note: String,
    pub archived: bool,
}
fn validate_draft(d: &TaskDraft) -> AppResult<()> {
    if d.title.trim().is_empty()
        || d.title.len() > 240
        || d.description.len() > 16_384
        || d.review_note.len() > 4096
        || d.verification_note.len() > 4096
        || d.workspace_id.len() > 128
        || !["low", "normal", "high"].contains(&d.priority.as_str())
    {
        return Err(failure(
            "Use a title up to 240 bytes, a bounded description, and a valid priority.",
        ));
    }
    if d.status == Stage::DONE
        && (d.review_note.trim().is_empty() || d.verification_note.trim().is_empty())
    {
        return Err(failure("Add review and verification notes before marking a local task Done. This does not merge code."));
    }
    Ok(())
}
fn apply_task(tasks: &mut Vec<LocalTask>, d: TaskDraft) -> AppResult<LocalTask> {
    validate_draft(&d)?;
    let index = match &d.id {
        Some(id) => Some(
            tasks
                .iter()
                .position(|t| &t.id == id)
                .ok_or_else(|| failure("Task no longer exists. Refresh the board."))?,
        ),
        None => None,
    };
    let (id, created_at, revision) = if let Some(i) = index {
        if Some(tasks[i].revision) != d.expected_revision {
            return Err(failure(
                "Task changed in another view. Refresh before saving; nothing was overwritten.",
            ));
        }
        if tasks[i].workspace_id != d.workspace_id {
            return Err(failure("A task cannot be reassigned to another workspace."));
        }
        (
            tasks[i].id.clone(),
            tasks[i].created_at,
            tasks[i]
                .revision
                .checked_add(1)
                .ok_or_else(|| failure("Task revision limit reached"))?,
        )
    } else {
        if d.expected_revision.is_some() || tasks.len() >= 2000 {
            return Err(failure(
                "Local task limit reached or invalid new-task revision.",
            ));
        }
        (uuid::Uuid::new_v4().to_string(), now(), 1)
    };
    let result = LocalTask {
        id,
        workspace_id: d.workspace_id,
        title: d.title.trim().into(),
        description: d.description,
        status: d.status,
        priority: d.priority,
        review_note: d.review_note,
        verification_note: d.verification_note,
        revision,
        created_at,
        updated_at: now(),
        archived: d.archived,
    };
    if let Some(i) = index {
        tasks[i] = result.clone();
    } else {
        tasks.push(result.clone());
    }
    Ok(result)
}
// Credentials never enter persisted AppData or the returned control-center snapshot.
// Epoch checks prevent an in-flight sync returning data after disconnect/reconfigure.
#[derive(Clone)]
struct Credential {
    url: String,
    token: String,
    epoch: String,
}
static CREDENTIALS: OnceLock<Mutex<HashMap<Provider, Credential>>> = OnceLock::new();
fn credentials() -> &'static Mutex<HashMap<Provider, Credential>> {
    CREDENTIALS.get_or_init(|| Mutex::new(HashMap::new()))
}
static REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[tauri::command]
pub fn center_load(window: WebviewWindow) -> AppResult<serde_json::Value> {
    visible_main(&window)?;
    let data = DataStore::read_file(|d| Ok(d.control_center.clone()))?;
    let guard = credentials()
        .lock()
        .map_err(|_| failure("Connection credentials are unavailable"))?;
    Ok(
        serde_json::json!({"data":data,"paseo_has_token":guard.get(&Provider::Paseo).is_some_and(|c|!c.token.is_empty()),
        "anneal_has_token":guard.get(&Provider::Anneal).is_some_and(|c|!c.token.is_empty()),"execution":"observation_only","codex_invoked":false}),
    )
}
#[tauri::command]
pub fn center_save_connection(
    window: WebviewWindow,
    provider: Provider,
    url: String,
    enabled: bool,
    token: Option<String>,
    clear_token: bool,
) -> AppResult<()> {
    visible_main(&window)?;
    let url = adapters::normalize_endpoint(provider, &url)?;
    let token = token.filter(|s| !s.is_empty());
    if let Some(ref secret) = token {
        if secret.len() > 1024
            || !secret.bytes().all(|b| b.is_ascii_graphic())
            || (provider == Provider::Paseo
                && !secret
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)))
        {
            return Err(failure("The connection password/token must fit the upstream authentication format (no whitespace)."));
        }
    }
    // Consistent credentials -> DataStore lock order in all configuration/read paths.
    let mut secrets = credentials()
        .lock()
        .map_err(|_| failure("Connection credentials are unavailable"))?;
    let old = secrets.get(&provider).cloned();
    DataStore::update_file(|d| {
        let connection = Connection {
            enabled,
            url: url.clone(),
        };
        match provider {
            Provider::Paseo => d.control_center.paseo = connection,
            Provider::Anneal => d.control_center.anneal = connection,
        }
        Ok(())
    })?;
    let kept = old
        .filter(|c| c.url == url && !clear_token && enabled)
        .map(|c| c.token)
        .unwrap_or_default();
    secrets.insert(
        provider,
        Credential {
            url,
            token: if enabled && !clear_token {
                token.unwrap_or(kept)
            } else {
                String::new()
            },
            epoch: uuid::Uuid::new_v4().to_string(),
        },
    );
    Ok(())
}
#[tauri::command]
pub fn center_save_task(window: WebviewWindow, draft: TaskDraft) -> AppResult<LocalTask> {
    visible_main(&window)?;
    DataStore::update_file(|d| {
        if !d.profiles.iter().any(|p| p.id == draft.workspace_id) {
            return Err(failure("Choose an existing workspace first."));
        }
        apply_task(&mut d.control_center.tasks, draft)
    })
}
#[tauri::command]
pub async fn center_sync(
    window: WebviewWindow,
    provider: Provider,
    cursor: Option<String>,
) -> AppResult<serde_json::Value> {
    visible_main(&window)?;
    let _permit = REQUESTS
        .try_acquire()
        .map_err(|_| failure("A connection refresh is already in progress. Try again shortly."))?;
    let (connection, auth) = {
        let mut guard = credentials()
            .lock()
            .map_err(|_| failure("Connection credentials are unavailable"))?;
        let connection =
            DataStore::read_file(|d| Ok(d.control_center.connection(provider).clone()))?;
        if !connection.enabled {
            return Err(failure("Connect this integration in Connections first."));
        }
        let auth = guard
            .entry(provider)
            .or_insert_with(|| Credential {
                url: connection.url.clone(),
                token: String::new(),
                epoch: uuid::Uuid::new_v4().to_string(),
            })
            .clone();
        (connection, auth)
    };
    if cursor.as_ref().is_some_and(|s| s.len() > 2048)
        || (provider == Provider::Anneal && cursor.is_some())
    {
        return Err(failure("Invalid directory cursor."));
    }
    let url = adapters::normalize_endpoint(provider, &connection.url)?;
    let token = if auth.url == url {
        auth.token.clone()
    } else {
        String::new()
    };
    let mut result = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        match provider {
            Provider::Paseo => adapters::paseo(&url, &token, cursor).await,
            Provider::Anneal => adapters::anneal(&url, &token).await,
        }
    })
    .await
    .map_err(|_| {
        failure("Connection timed out. No agents were started and no external tasks were changed.")
    })??;
    let guard = credentials()
        .lock()
        .map_err(|_| failure("Connection credentials are unavailable"))?;
    if !guard
        .get(&provider)
        .is_some_and(|c| c.epoch == auth.epoch && c.url == url)
    {
        return Err(failure(
            "Connection changed during refresh; stale response discarded.",
        ));
    }
    result["observed_at"] = serde_json::json!(now());
    result["read_only"] = serde_json::json!(true);
    result["codex_invoked"] = serde_json::json!(false);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft() -> TaskDraft {
        TaskDraft {
            id: None,
            expected_revision: None,
            workspace_id: "workspace".into(),
            title: "A real task".into(),
            description: String::new(),
            status: Stage::BACKLOG,
            priority: "normal".into(),
            review_note: String::new(),
            verification_note: String::new(),
            archived: false,
        }
    }
    #[test]
    fn center_task_revisions_and_completion_gate_are_enforced() {
        let mut tasks = Vec::new();
        let created = apply_task(&mut tasks, draft()).unwrap();
        let mut change = draft();
        change.id = Some(created.id);
        change.expected_revision = Some(0);
        assert!(apply_task(&mut tasks, change.clone()).is_err());
        assert_eq!(tasks[0].revision, 1);
        change.expected_revision = Some(1);
        change.status = Stage::DONE;
        assert!(apply_task(&mut tasks, change.clone()).is_err());
        change.review_note = "Reviewed by operator".into();
        change.verification_note = "Checked expected result".into();
        assert_eq!(apply_task(&mut tasks, change).unwrap().status, Stage::DONE);
        assert!(serde_json::from_str::<Stage>("\"RUNNING\"").is_err());
    }
}

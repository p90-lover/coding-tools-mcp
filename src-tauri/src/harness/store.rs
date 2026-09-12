use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use super::model::{HarnessEvent, OperationRecord, TaskSession, WorkspaceHarnessState};

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct HarnessError {
    code: &'static str,
    message: String,
}

fn validate_id(value: &str) -> HarnessResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(HarnessError::new(
            "INVALID_TASK_ID",
            "Task/project IDs must be bounded identifiers, not paths",
        ));
    }
    Ok(())
}

impl HarnessError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

pub type HarnessResult<T> = Result<T, HarnessError>;

#[derive(Debug, Clone)]
pub struct HarnessStore {
    root: PathBuf,
}

impl HarnessStore {
    pub fn new(root: PathBuf) -> HarnessResult<Self> {
        fs::create_dir_all(&root)
            .map_err(|e| HarnessError::new("STORE_UNAVAILABLE", e.to_string()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Short metadata transaction. OS lock also coordinates separate listeners/processes.
    pub fn lock_metadata(&self, workspace_id: &str) -> HarnessResult<File> {
        validate_id(workspace_id)?;
        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(io_error)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("metadata.lock"))
            .map_err(io_error)?;
        fs2::FileExt::lock_exclusive(&file).map_err(io_error)?;
        Ok(file)
    }

    fn workspace_dir(&self, workspace_id: &str) -> PathBuf {
        self.root.join("workspaces").join(workspace_id)
    }

    fn tasks_dir(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join("tasks")
    }

    fn events_dir(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join("events")
    }

    fn operations_path(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join("operations.jsonl")
    }

    pub fn save_task(&self, task: &TaskSession) -> HarnessResult<()> {
        validate_id(&task.workspace_id)?;
        validate_id(&task.id)?;
        let dir = self.tasks_dir(&task.workspace_id);
        fs::create_dir_all(&dir).map_err(io_error)?;
        atomic_write_json(&dir.join(format!("{}.json", task.id)), task)
    }

    pub fn load_task(&self, workspace_id: &str, task_id: &str) -> HarnessResult<TaskSession> {
        validate_id(workspace_id)?;
        validate_id(task_id)?;
        let task: TaskSession =
            read_json(&self.tasks_dir(workspace_id).join(format!("{task_id}.json")))?;
        if task.id != task_id || task.workspace_id != workspace_id {
            return Err(HarnessError::new(
                "STORE_CORRUPT",
                "Stored task identity does not match its project/path",
            ));
        }
        Ok(task)
    }

    pub fn list_tasks(&self, workspace_id: &str) -> HarnessResult<Vec<TaskSession>> {
        validate_id(workspace_id)?;
        let dir = self.tasks_dir(workspace_id);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut tasks: Vec<TaskSession> = Vec::new();
        for entry in fs::read_dir(dir).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).ok_or_else(|| {
                HarnessError::new("STORE_CORRUPT", "Invalid task record filename")
            })?;
            tasks.push(self.load_task(workspace_id, id)?);
        }
        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(tasks)
    }

    pub fn save_workspace_state(
        &self,
        workspace_id: &str,
        state: &WorkspaceHarnessState,
    ) -> HarnessResult<()> {
        validate_id(workspace_id)?;
        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(io_error)?;
        atomic_write_json(&dir.join("state.json"), state)
    }

    pub fn append_event_for_workspace(
        &self,
        workspace_id: &str,
        event: &HarnessEvent,
    ) -> HarnessResult<()> {
        validate_id(workspace_id)?;
        validate_id(&event.task_id)?;
        let dir = self.events_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(io_error)?;
        let path = dir.join(format!("{}.jsonl", event.task_id));
        let mut file = OpenOptions::new()
            .read(true)
            .create(true)
            .append(true)
            .open(path)
            .map_err(io_error)?;
        let line = serde_json::to_string(event)
            .map_err(|e| HarnessError::new("STORE_SERIALIZE_FAILED", e.to_string()))?;
        fs2::FileExt::lock_exclusive(&file).map_err(io_error)?;
        writeln!(file, "{line}").map_err(io_error)
    }

    pub fn append_operation(
        &self,
        workspace_id: &str,
        operation: &OperationRecord,
    ) -> HarnessResult<()> {
        validate_id(workspace_id)?;
        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(io_error)?;
        let mut file = OpenOptions::new()
            .read(true)
            .create(true)
            .append(true)
            .open(self.operations_path(workspace_id))
            .map_err(io_error)?;
        let line = serde_json::to_string(operation)
            .map_err(|e| HarnessError::new("STORE_SERIALIZE_FAILED", e.to_string()))?;
        fs2::FileExt::lock_exclusive(&file).map_err(io_error)?;
        writeln!(file, "{line}").map_err(io_error)
    }

    pub fn list_operations(
        &self,
        workspace_id: &str,
        offset: usize,
        limit: usize,
    ) -> HarnessResult<Vec<OperationRecord>> {
        validate_id(workspace_id)?;
        let path = self.operations_path(workspace_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(path).map_err(io_error)?;
        let mut operations = Vec::new();
        for line in BufReader::new(file).lines().skip(offset).take(limit.max(1)) {
            let line = line.map_err(io_error)?;
            match serde_json::from_str(&line) {
                Ok(operation) => operations.push(operation),
                Err(_) => break,
            }
        }
        Ok(operations)
    }

    pub fn list_events(
        &self,
        workspace_id: &str,
        task_id: &str,
        offset: usize,
        limit: usize,
    ) -> HarnessResult<Vec<HarnessEvent>> {
        validate_id(workspace_id)?;
        validate_id(task_id)?;
        let path = self
            .events_dir(workspace_id)
            .join(format!("{task_id}.jsonl"));
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(path).map_err(io_error)?;
        let mut events = Vec::new();
        for line in BufReader::new(file).lines().skip(offset).take(limit.max(1)) {
            let line = line.map_err(io_error)?;
            match serde_json::from_str(&line) {
                Ok(event) => events.push(event),
                Err(_) => break,
            }
        }
        Ok(events)
    }
}

fn io_error(error: std::io::Error) -> HarnessError {
    HarnessError::new("STORE_IO_FAILED", error.to_string())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> HarnessResult<T> {
    let bytes = fs::read(path).map_err(io_error)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| HarnessError::new("STORE_CORRUPT", format!("{}: {e}", path.display())))
}

fn atomic_write_json<T: serde::Serialize>(path: &Path, value: &T) -> HarnessResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| HarnessError::new("STORE_SERIALIZE_FAILED", e.to_string()))?;
    let scratch = path
        .parent()
        .ok_or_else(|| HarnessError::new("STORE_IO_FAILED", "Missing record parent"))?
        .join("aiTemp");
    fs::create_dir_all(&scratch).map_err(io_error)?;
    let temp = scratch.join(format!("{}.json.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    fs::rename(&temp, path).map_err(io_error)
}

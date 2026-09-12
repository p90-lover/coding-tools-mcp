use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::tools::workspace::{tool_ok, WorkspaceError};
use serde_json::{json, Value};

pub const COMMAND_BUFFER_BYTES: usize = super::ram_cache::STREAM_BYTES;
pub const COMPLETED_COMMAND_RETENTION_SECONDS: u64 = super::ram_cache::TTL_SECONDS;

fn authorized_poll<T>(
    ctx: Option<&crate::tools::ToolContext>,
    poll: impl FnOnce() -> std::task::Poll<std::io::Result<T>>,
) -> std::task::Poll<std::io::Result<T>> {
    let _policy = match ctx
        .map(|context| context.policy_execution_guard())
        .transpose()
    {
        Ok(guard) => guard,
        Err(error) => {
            return std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                error.to_string(),
            )))
        }
    };
    // The authorization fence covers submission only; a pending pipe must not
    // retain a synchronous policy lock while its future waits to be woken.
    poll()
}

#[derive(Default)]
pub struct SessionStore {
    sessions: Mutex<HashMap<String, Arc<ExecSession>>>,
    maintenance_started: AtomicBool,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: ExecSession) -> Arc<ExecSession> {
        self.maintain_completed(Instant::now());
        let arc = Arc::new(session);
        self.sessions
            .lock()
            .expect("sessions lock")
            .insert(arc.session_id.clone(), arc.clone());
        arc
    }

    pub fn get(&self, session_id: &str) -> Result<Arc<ExecSession>, WorkspaceError> {
        self.maintain_completed(Instant::now());
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(session_id)
            .cloned()
            .ok_or_else(|| WorkspaceError::Tool {
                code: "SESSION_NOT_FOUND",
                message: format!("Session not found: {session_id}"),
                category: "not_found",
                retryable: false,
            })
    }

    pub(crate) fn maintain_completed(&self, now: Instant) {
        let mut sessions = self.sessions.lock().expect("sessions lock");
        let mut terminal: Vec<_> = sessions
            .iter()
            .filter_map(|(id, session)| {
                if !session.has_exited() || !session.finalized.load(Ordering::Acquire) {
                    return None;
                }
                session
                    .finished_at
                    .lock()
                    .expect("finished timestamp lock")
                    .map(|at| (id.clone(), at))
            })
            .collect();
        terminal.sort_by_key(|(_, at)| *at);
        let excess = terminal.len().saturating_sub(128);
        for (index, (id, at)) in terminal.into_iter().enumerate() {
            if index < excess
                || now.saturating_duration_since(at).as_secs()
                    >= COMPLETED_COMMAND_RETENTION_SECONDS
            {
                sessions.remove(&id);
            }
        }
    }

    pub(crate) fn start_cache_maintenance(self: &Arc<Self>) {
        if self.maintenance_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let Some(store) = weak.upgrade() else { break };
                store.maintain_completed(Instant::now());
            }
        });
    }

    pub fn revoke_for_policy_change(&self) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .values()
            .cloned()
            .collect();
        for session in sessions {
            if !session.has_exited() {
                session.policy_revoked.store(true, Ordering::SeqCst);
                session.mark_termination_reason("permission_changed");
                tauri::async_runtime::spawn(async move {
                    session.kill_and_wait().await;
                });
            }
        }
    }

    pub fn remove(&self, session_id: &str) {
        self.sessions
            .lock()
            .expect("sessions lock")
            .remove(session_id);
    }
}

pub struct ExecSession {
    pub session_id: String,
    pub(crate) child: AsyncMutex<Child>,
    pub stdin: AsyncMutex<Option<ChildStdin>>,
    stdin_open: Mutex<bool>,
    interactive: bool,
    output_cache: Arc<super::ram_cache::OutputCache>,
    output_keys: [String; 2],
    pub(crate) runtime_limit_ms: Option<u64>,
    pub started_at: Instant,
    pub exit_code: Mutex<Option<i32>>,
    exited: AtomicBool,
    finished_elapsed_ms: Mutex<Option<u64>>,
    finished_at: Mutex<Option<Instant>>,
    task_owner: Mutex<Option<(crate::harness::Harness, String)>>,
    project_root: Mutex<Option<std::path::PathBuf>>,
    execution_lease: Mutex<Option<Arc<crate::harness::resource_lease::ResourceLease>>>,
    finalizing: AtomicBool,
    finalized: AtomicBool,
    reconciliation_error: Mutex<Option<String>>,
    process_tree: Mutex<Option<super::process_tree::ProcessTree>>,
    monitor_started: AtomicBool,
    policy_revoked: AtomicBool,
    termination_reason: Mutex<Option<String>>,
    reader_tasks: AsyncMutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}

impl ExecSession {
    pub(crate) fn owner_project_root(&self) -> Option<std::path::PathBuf> {
        self.project_root.lock().expect("project root lock").clone()
    }

    fn check_access(
        &self,
        ctx: &crate::tools::ToolContext,
        writing: bool,
    ) -> Result<(), WorkspaceError> {
        if self.policy_revoked.load(Ordering::Acquire) {
            return Err(WorkspaceError::Tool {
                code: "COMMAND_PERMISSION_REVOKED",
                message: "This command belongs to a revoked permission snapshot. Retained output and further input are not available through the new scope.".into(),
                category: "permission", retryable: false,
            });
        }
        if let Some(root) = self
            .project_root
            .lock()
            .expect("project root lock")
            .as_ref()
        {
            if ctx.workspace.approved_scope_root(root).is_none() {
                return Err(WorkspaceError::path_outside_workspace());
            }
            let resolved = ctx
                .workspace
                .resolve_existing(&ctx.workspace.display_path(root))?;
            if writing && ctx.workspace.is_read_only_path(&resolved.path) {
                return Err(WorkspaceError::Tool {
                    code: "READ_ONLY_PROJECT",
                    message: "This command project is now read-only.".into(),
                    category: "permission",
                    retryable: false,
                });
            }
        }
        Ok(())
    }

    pub fn new(child: Child) -> Self {
        Self::new_with_mode(child, false)
    }

    pub fn new_with_mode(mut child: Child, interactive: bool) -> Self {
        let session_id = Uuid::new_v4().to_string();
        let stdin = child.stdin.take();
        let stdin_open = stdin.is_some();
        let output_keys = [
            format!("{session_id}:stdout"),
            format!("{session_id}:stderr"),
        ];
        Self {
            session_id,
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
            stdin_open: Mutex::new(stdin_open),
            interactive,
            output_cache: super::ram_cache::output_cache(),
            output_keys,
            runtime_limit_ms: None,
            started_at: Instant::now(),
            exit_code: Mutex::new(None),
            exited: AtomicBool::new(false),
            finished_elapsed_ms: Mutex::new(None),
            finished_at: Mutex::new(None),
            task_owner: Mutex::new(None),
            project_root: Mutex::new(None),
            execution_lease: Mutex::new(None),
            finalizing: AtomicBool::new(false),
            finalized: AtomicBool::new(false),
            reconciliation_error: Mutex::new(None),
            process_tree: Mutex::new(None),
            monitor_started: AtomicBool::new(false),
            policy_revoked: AtomicBool::new(false),
            termination_reason: Mutex::new(None),
            reader_tasks: AsyncMutex::new(Vec::new()),
        }
    }

    pub async fn spawn_readers(self: &Arc<Self>) {
        let stdout = {
            let mut guard = self.child.lock().await;
            guard.stdout.take()
        };
        let stderr = {
            let mut guard = self.child.lock().await;
            guard.stderr.take()
        };
        if let Some(stream) = stdout {
            let session = Arc::clone(self);
            let task = tauri::async_runtime::spawn(async move {
                session.read_stream(stream, true).await;
            });
            self.reader_tasks.lock().await.push(task);
        }
        if let Some(stream) = stderr {
            let session = Arc::clone(self);
            let task = tauri::async_runtime::spawn(async move {
                session.read_stream(stream, false).await;
            });
            self.reader_tasks.lock().await.push(task);
        }
    }

    pub async fn wait_for_readers(&self) {
        let mut tasks = self.reader_tasks.lock().await;
        while let Some(task) = tasks.pop() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), task).await;
        }
    }

    async fn read_stream<T>(&self, mut stream: T, is_stdout: bool)
    where
        T: tokio::io::AsyncRead + Unpin,
    {
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    self.output_cache
                        .append(&self.output_keys[usize::from(!is_stdout)], chunk);
                }
                Err(_) => break,
            }
        }
    }

    pub async fn kill_and_wait(&self) {
        if let Some(tree) = self
            .process_tree
            .lock()
            .expect("process tree lock")
            .as_ref()
        {
            let _ = tree.terminate();
        }
        let status = {
            let mut child = self.child.lock().await;
            let _ = child.start_kill();
            tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
                .await
                .ok()
                .and_then(Result::ok)
        };
        if let Some(status) = status {
            if self.tree_empty() {
                self.record_exit_status(status);
            }
        }
    }

    pub async fn refresh_status(&self) {
        let mut child = self.child.lock().await;
        if let Ok(Some(status)) = child.try_wait() {
            if self.tree_empty() {
                self.record_exit_status(status);
            }
        }
    }

    fn tree_empty(&self) -> bool {
        self.process_tree
            .lock()
            .expect("process tree lock")
            .as_ref()
            .map(|tree| tree.is_empty().unwrap_or(false))
            .unwrap_or(true)
    }
    pub(crate) fn bind_tree(&self, tree: super::process_tree::ProcessTree) {
        *self.process_tree.lock().expect("process tree lock") = Some(tree);
    }
    pub(crate) fn begin_monitor(&self) -> bool {
        !self.monitor_started.swap(true, Ordering::AcqRel)
    }

    pub(crate) async fn write_input(
        &self,
        text: &str,
        close: bool,
        ctx: Option<&crate::tools::ToolContext>,
    ) -> Result<(), WorkspaceError> {
        use std::{future::poll_fn, pin::Pin};
        use tokio::io::AsyncWrite;
        if text.len() > 1024 * 1024 {
            return Err(WorkspaceError::invalid_argument(
                "stdin is limited to 1 MiB per request; use an approved input file for large data",
            ));
        }
        let write = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut guard = self.stdin.lock().await;
            let stdin = guard
                .as_mut()
                .ok_or_else(|| std::io::Error::other("stdin closed"))?;
            let mut remaining = text.as_bytes();
            while !remaining.is_empty() {
                let count = poll_fn(|cx| {
                    authorized_poll(ctx, || Pin::new(&mut *stdin).poll_write(cx, remaining))
                })
                .await?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "stdin accepted no bytes",
                    ));
                }
                remaining = &remaining[count..];
            }
            poll_fn(|cx| authorized_poll(ctx, || Pin::new(&mut *stdin).poll_flush(cx))).await?;
            if close {
                poll_fn(|cx| authorized_poll(ctx, || Pin::new(&mut *stdin).poll_shutdown(cx)))
                    .await?;
                guard.take();
                self.mark_stdin_closed();
            }
            Ok::<(), std::io::Error>(())
        })
        .await;
        if matches!(write, Ok(Ok(()))) {
            return Ok(());
        }
        self.mark_termination_reason("input_write_unconfirmed");
        self.kill_and_wait().await;
        self.stdin.lock().await.take();
        self.mark_stdin_closed();
        Err(WorkspaceError::ToolDetails {
            code:"INPUT_WRITE_UNCONFIRMED",message:"Input delivery failed or exceeded two seconds. The owned process was stopped; partial input may have been consumed. Do not replay automatically.".into(),
            category:"runtime",retryable:false,details:json!({"command":self.snapshot(4096),"safe_to_retry":false,"partial_input_possible":true})
        })
    }

    fn record_exit_status(&self, status: std::process::ExitStatus) {
        let mut elapsed = self
            .finished_elapsed_ms
            .lock()
            .expect("finished clock lock");
        if elapsed.is_none() {
            *self.finished_at.lock().expect("finished timestamp lock") = Some(Instant::now());
            *elapsed = Some(self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64);
        }
        drop(elapsed);
        *self.exit_code.lock().expect("exit_code lock") = status.code();
        self.exited.store(true, Ordering::Release);
        *self.stdin_open.lock().expect("stdin_open lock") = false;
        let mut reason = self.termination_reason.lock().expect("termination lock");
        if reason.is_none() {
            *reason = Some("exited".into());
        }
    }

    pub(crate) fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    pub(crate) fn bind_owner(
        &self,
        harness: crate::harness::Harness,
        task_id: Option<String>,
        lease: Option<Arc<crate::harness::resource_lease::ResourceLease>>,
    ) {
        *self.project_root.lock().expect("project root lock") =
            Some(harness.workspace_root().to_path_buf());
        *self.execution_lease.lock().expect("execution lease lock") = lease;
        *self.task_owner.lock().expect("task owner lock") = task_id.map(|id| (harness, id));
    }

    pub(crate) async fn finalize_owner(&self) {
        if !self.has_exited() || self.finalizing.swap(true, Ordering::AcqRel) {
            return;
        }
        let owner = self.task_owner.lock().expect("task owner lock").clone();
        if let Some((harness, id)) = owner {
            let command_id = self.session_id.clone();
            let snapshot = self.snapshot(0);
            let result = tokio::task::spawn_blocking(move || {
                let reconciled = if snapshot["command_ok"] == true { harness.refresh_expected_state(&id).map(|_| ()) } else { Ok(()) };
                let _ = harness.record_event(&id,"command_finished",Some("exec_command"),json!({"command_id":command_id}),
                    json!({"status":snapshot["status"],"command_ok":snapshot["command_ok"],"exit_code":snapshot["exit_code"],"elapsed_ms":snapshot["elapsed_ms"],"reconciled":snapshot["command_ok"] == true && reconciled.is_ok()}));
                reconciled.map_err(|e|e.to_string())
            }).await;
            if let Err(error) = result.unwrap_or_else(|e| Err(e.to_string())) {
                *self
                    .reconciliation_error
                    .lock()
                    .expect("reconciliation lock") = Some(error);
            }
        }
        self.process_tree.lock().expect("process tree lock").take();
        self.execution_lease
            .lock()
            .expect("execution lease lock")
            .take();
        self.finalized.store(true, Ordering::Release);
    }

    pub fn mark_termination_reason(&self, reason: &str) {
        *self.termination_reason.lock().expect("termination lock") = Some(reason.to_string());
    }

    pub(crate) fn mark_stdin_closed(&self) {
        *self.stdin_open.lock().expect("stdin_open lock") = false;
    }

    pub async fn is_running(&self) -> bool {
        self.refresh_status().await;
        !self.has_exited()
    }

    pub fn retained_stream_bytes(&self, stream: &str) -> (Vec<u8>, usize) {
        self.output_cache.tail(
            &self.output_keys[usize::from(stream == "stderr")],
            COMMAND_BUFFER_BYTES,
        )
    }

    pub fn snapshot(&self, max_output_bytes: usize) -> Value {
        let max_output_bytes = max_output_bytes.min(COMMAND_BUFFER_BYTES);
        let (stdout_bytes, stdout_total) = self
            .output_cache
            .tail(&self.output_keys[0], max_output_bytes);
        let (stderr_bytes, stderr_total) = self
            .output_cache
            .tail(&self.output_keys[1], max_output_bytes);
        let stdout = truncate_tail(&stdout_bytes, max_output_bytes);
        let stderr = truncate_tail(&stderr_bytes, max_output_bytes);
        let exit_code = *self.exit_code.lock().expect("exit_code lock");
        let termination_reason = self
            .termination_reason
            .lock()
            .expect("termination lock")
            .clone();
        let status = if self.has_exited() {
            "exited"
        } else {
            "running"
        };
        let reason = termination_reason.as_deref().unwrap_or("running");
        let command_ok = match reason {
            "exited" => Some(exit_code.is_some_and(|code| code == 0)),
            "running" => None,
            _ => Some(false),
        };
        json!({
            "command_id": self.session_id,
            "session_id": self.session_id,
            "interactive": self.interactive,
            "stdin_open": *self.stdin_open.lock().expect("stdin_open lock"),
            "status": status,
            "termination_reason": reason,
            "recoverable": matches!(reason, "timeout" | "killed" | "spawn_failed" | "server_restart"),
            "suggestion": match reason {
                "timeout" => "Read retained output and inspect partial effects; never automatically replay the command.",
                "killed" => "确认终止原因后重新执行命令",
                "exited" => "检查 exit_code 和 stderr",
                "crashed" => "检查 stderr 后重试或恢复工作区",
                _ => "继续读取 command 或等待进程结束",
            },
            "exit_code": exit_code,
            "transport_ok": true,
            "command_ok": command_ok,
            "finalization_pending": self.has_exited() && !self.finalized.load(Ordering::Acquire),
            "reconciliation_error": self.reconciliation_error.lock().expect("reconciliation lock").clone(),
            "process_tree_managed": self.process_tree.lock().expect("process tree lock").is_some(),
            "survives_server_restart": false,
            "max_runtime_ms": self.runtime_limit_ms,
            "cache_storage": "ram_only",
            "cache_max_age_seconds": super::ram_cache::TTL_SECONDS,
            "output_may_expire_while_running": true,
            "stdout": stdout.content,
            "stderr": stderr.content,
            "stdout_truncated": stdout.truncated || stdout_total > stdout_bytes.len(),
            "stderr_truncated": stderr.truncated || stderr_total > stderr_bytes.len(),
            "stdout_total_bytes": stdout_total,
            "stderr_total_bytes": stderr_total,
            "elapsed_ms": self.finished_elapsed_ms.lock().expect("finished clock lock").unwrap_or_else(|| self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64),
            "observation_age_ms": self.started_at.elapsed().as_millis(),
            "output_refs": {
                "stdout": format!("command:{}:stdout", self.session_id),
                "stderr": format!("command:{}:stderr", self.session_id)
            },
            "legacy_output_refs": {
                "stdout": format!("session:{}:stdout", self.session_id),
                "stderr": format!("session:{}:stderr", self.session_id)
            },
            "retention_seconds": COMPLETED_COMMAND_RETENTION_SECONDS
        })
    }
}

impl Drop for ExecSession {
    fn drop(&mut self) {
        for key in &self.output_keys {
            self.output_cache.forget(key);
        }
    }
}

struct Truncated {
    content: String,
    truncated: bool,
}

fn truncate_tail(bytes: &[u8], max_bytes: usize) -> Truncated {
    let truncated = bytes.len() > max_bytes;
    let take = bytes.len().min(max_bytes);
    Truncated {
        content: String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(take)..]).into_owned(),
        truncated,
    }
}

pub fn read_output(store: &SessionStore, args: &Value) -> Result<Value, WorkspaceError> {
    let output_ref = args
        .get("output_ref")
        .and_then(Value::as_str)
        .ok_or_else(|| WorkspaceError::invalid_argument("output_ref is required"))?;
    let parts: Vec<&str> = output_ref.split(':').collect();
    if parts.len() != 3 || (parts[0] != "command" && parts[0] != "session") {
        return Err(WorkspaceError::invalid_argument(
            "output_ref must look like command:<id>:stdout or command:<id>:stderr; legacy session:<id>:... references remain accepted",
        ));
    }
    let command_id = parts[1];
    let ref_stream = parts[2];
    if ref_stream != "stdout" && ref_stream != "stderr" && ref_stream != "full" {
        return Err(WorkspaceError::invalid_argument(
            "output_ref stream must be stdout or stderr",
        ));
    }
    let session = store.get(command_id)?;
    tauri::async_runtime::block_on(session.refresh_status());

    let requested_stream = args.get("stream").and_then(Value::as_str).unwrap_or("");
    let stream = if ref_stream == "stdout" || ref_stream == "stderr" {
        ref_stream
    } else if requested_stream == "stdout" || requested_stream == "stderr" {
        requested_stream
    } else {
        "stdout"
    };

    let (data, total_stream_bytes) = session.retained_stream_bytes(stream);
    let requested_offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(4096)
        .clamp(1, 1_048_576) as usize;
    let retained_start = total_stream_bytes.saturating_sub(data.len());
    let absolute_offset = requested_offset.max(retained_start).min(total_stream_bytes);
    let buffer_offset = absolute_offset.saturating_sub(retained_start);
    let chunk = &data[buffer_offset..data.len().min(buffer_offset + limit)];
    let next_offset = if buffer_offset + chunk.len() < data.len() {
        Some((absolute_offset + chunk.len()) as u64)
    } else {
        None
    };

    let mut warnings = Vec::<String>::new();
    if parts[0] == "session" {
        warnings.push(
            "Legacy session:<id>:... output_ref accepted; prefer command:<command_id>:stdout|stderr."
                .into(),
        );
    }
    if ref_stream == "full" {
        warnings.push(
            "Legacy full output_ref defaults to stdout; use a per-stream command output_ref."
                .into(),
        );
    }

    Ok(tool_ok(json!({
        "command_id": command_id,
        "session_id": command_id,
        "output_ref": output_ref,
        "stream_output_ref": format!("command:{command_id}:{stream}"),
        "legacy_stream_output_ref": format!("session:{command_id}:{stream}"),
        "stream": stream,
        "offset": absolute_offset,
        "retained_start_offset": retained_start,
        "next_read_offset": absolute_offset + chunk.len(),
        "dropped_before_offset": retained_start,
        "output_gap": requested_offset < retained_start,
        "requested_offset": requested_offset,
        "limit": limit,
        "content": String::from_utf8_lossy(chunk),
        "next_offset": next_offset,
        "total_retained_bytes": data.len(),
        "total_stream_bytes": total_stream_bytes,
        "truncated": next_offset.is_some(),
        "retention_seconds": COMPLETED_COMMAND_RETENTION_SECONDS,
        "warnings": warnings
    })))
}

fn command_id_argument(args: &Value) -> Result<&str, WorkspaceError> {
    args.get("command_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            args.get("session_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| {
            WorkspaceError::invalid_argument(
                "command_id is required; legacy session_id remains accepted",
            )
        })
}

pub fn write_stdin(store: &SessionStore, args: &Value) -> Result<Value, WorkspaceError> {
    write_stdin_inner(store, args, None)
}

pub fn read_output_current(
    ctx: &crate::tools::ToolContext,
    args: &Value,
) -> Result<Value, WorkspaceError> {
    let id = args
        .get("output_ref")
        .and_then(Value::as_str)
        .and_then(|r| r.split(':').nth(1))
        .ok_or_else(|| {
            WorkspaceError::invalid_argument("A command output reference is required")
        })?;
    ctx.sessions.get(id)?.check_access(ctx, false)?;
    read_output(&ctx.sessions, args)
}

pub fn kill_command_current(
    ctx: &crate::tools::ToolContext,
    args: &Value,
) -> Result<Value, WorkspaceError> {
    let session = ctx.sessions.get(command_id_argument(args)?)?;
    session.check_access(ctx, false)?;
    kill_command(&ctx.sessions, args)
}

pub(crate) fn mark_roots_revoked(session: &ExecSession) {
    session.policy_revoked.store(true, Ordering::Release);
    session.mark_termination_reason("permission_changed");
}

pub fn write_stdin_current(
    ctx: &crate::tools::ToolContext,
    args: &Value,
) -> Result<Value, WorkspaceError> {
    write_stdin_inner(&ctx.sessions, args, Some(ctx))
}

fn write_stdin_inner(
    store: &SessionStore,
    args: &Value,
    ctx: Option<&crate::tools::ToolContext>,
) -> Result<Value, WorkspaceError> {
    let command_id = command_id_argument(args)?;
    let session = store.get(command_id)?;
    let chars = args.get("chars").and_then(Value::as_str).unwrap_or("");
    if let Some(ctx) = ctx {
        session.check_access(ctx, !chars.is_empty())?;
    }
    let max_output_bytes = args
        .get("max_output_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(65_536) as usize;

    let running = tauri::async_runtime::block_on(session.is_running());
    if !running {
        if !chars.is_empty() {
            return Err(WorkspaceError::Tool {
                code: "SESSION_CLOSED",
                message: "Session is closed; stdin write blocked.".into(),
                category: "runtime",
                retryable: false,
            });
        }
        return Ok(tool_ok(session.snapshot(max_output_bytes)));
    }

    if !chars.is_empty() {
        if session.policy_revoked.load(Ordering::SeqCst) {
            return Err(WorkspaceError::Tool { code: "COMMAND_PERMISSION_REVOKED", message: "Permission changed; this command cannot receive further input. Do not replay its prior actions.".into(), category: "permission", retryable: false });
        }
        tauri::async_runtime::block_on(session.write_input(chars, false, ctx))?;
    }

    let yield_ms = args
        .get("yield_time_ms")
        .and_then(Value::as_u64)
        .unwrap_or(1000)
        .min(30_000);
    let until = Instant::now() + std::time::Duration::from_millis(yield_ms.min(1000));
    while !session.has_exited() && Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(20));
        tauri::async_runtime::block_on(session.refresh_status());
    }
    tauri::async_runtime::block_on(session.refresh_status());
    Ok(tool_ok(session.snapshot(max_output_bytes)))
}

pub fn kill_session(store: &SessionStore, args: &Value) -> Result<Value, WorkspaceError> {
    let command_id = command_id_argument(args)?;
    let session = store.get(command_id)?;
    let max_output_bytes = args
        .get("max_output_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(65_536) as usize;
    let wait_ms = args
        .get("wait_ms")
        .and_then(Value::as_u64)
        .unwrap_or(5000)
        .min(30_000);
    let signal = args.get("signal").and_then(Value::as_str).unwrap_or("TERM");

    let running = tauri::async_runtime::block_on(session.is_running());
    let mut killed = false;
    let mut status = "exited";
    let mut evicted = false;

    if running {
        session.mark_termination_reason("killed");
        tauri::async_runtime::block_on(async {
            if session
                .process_tree
                .lock()
                .expect("process tree lock")
                .is_some()
            {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(wait_ms.max(100)),
                    session.kill_and_wait(),
                )
                .await;
                return;
            }
            let pid = {
                let child = session.child.lock().await;
                child.id()
            };
            if let Some(pid) = pid {
                send_session_signal(pid, signal);
            } else {
                let mut child = session.child.lock().await;
                let _ = child.start_kill();
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(wait_ms), async {
                let mut child = session.child.lock().await;
                let _ = child.wait().await;
            })
            .await;
        });
        tauri::async_runtime::block_on(session.refresh_status());
        if tauri::async_runtime::block_on(session.is_running()) {
            status = "terminating";
            evicted = false;
        } else {
            killed = true;
            status = "killed";
        }
    }

    let mut payload = session.snapshot(max_output_bytes);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("killed".into(), json!(killed));
        obj.insert("status".into(), json!(status));
        obj.insert("evicted".into(), json!(evicted));
        if status == "terminating" {
            obj.insert(
                "warnings".into(),
                json!(["Process did not exit after kill; command retained for retry"]),
            );
        }
    }

    // The existing command watcher owns bounded eviction. Cancellation must not
    // discard the output required to investigate partial side effects.

    Ok(tool_ok(payload))
}

pub fn kill_command(store: &SessionStore, args: &Value) -> Result<Value, WorkspaceError> {
    kill_session(store, args)
}

#[cfg(unix)]
fn send_session_signal(pid: u32, signal: &str) {
    let sig = match signal {
        "KILL" => libc::SIGKILL,
        "INT" => libc::SIGINT,
        _ => libc::SIGTERM,
    };
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

#[cfg(windows)]
fn send_session_signal(pid: u32, _signal: &str) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

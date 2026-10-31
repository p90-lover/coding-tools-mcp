use std::path::Path;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde_json::{json, Value};
use tokio::process::Command;

use std::sync::Arc;

use crate::tools::context::ToolContext;
use crate::tools::session::{
    ExecSession, SessionStore, COMMAND_BUFFER_BYTES, COMPLETED_COMMAND_RETENTION_SECONDS,
};
use crate::tools::workspace::{tool_ok, Workspace, WorkspaceError};

pub fn exec_command(ctx: &ToolContext, args: &Value) -> Result<Value, WorkspaceError> {
    let profile =
        crate::tools::exec_profile::resolve(args).map_err(WorkspaceError::invalid_argument)?;
    let cmd = args
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or_else(|| WorkspaceError::invalid_argument("cmd is required"))?;
    let workdir_raw = args
        .get("workdir")
        .or_else(|| args.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let workdir = ctx
        .workspace
        .resolve_existing_at(&ctx.default_cwd_path(), workdir_raw)?;
    if !workdir.path.starts_with(ctx.harness.workspace_root()) {
        return Err(WorkspaceError::Tool {code:"TASK_PROJECT_MISMATCH",message:"The command workdir is outside its selected task project. Select the matching project explicitly.".into(),category:"validation",retryable:false});
    }
    if args
        .get("stdin")
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() > 1024 * 1024)
    {
        return Err(WorkspaceError::invalid_argument(
            "stdin is limited to 1 MiB; use an approved input file",
        ));
    }
    if !workdir.path.is_dir() {
        return Err(WorkspaceError::not_a_directory(
            "workdir is not a directory",
        ));
    }
    let filesystem_scope = args
        .get("filesystem_scope")
        .and_then(Value::as_str)
        .unwrap_or("workspace")
        .to_string();
    validate_child_process_scope(ctx, args)?;
    let max_output = args
        .get("max_output_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(65_536) as usize;
    if let Some(result) = run_native_diagnostic(ctx, cmd, &workdir.path, max_output)? {
        let mut result = result;
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "filesystem_scope".into(),
                Value::String(filesystem_scope.clone()),
            );
            object.insert("sandbox_enforced".into(), Value::Bool(false));
            object.insert(
                "execution_boundary".into(),
                Value::String("policy_only".into()),
            );
            object.insert("child_process".into(), Value::Bool(false));
            object.insert("transport_ok".into(), Value::Bool(true));
            object.insert("command_ok".into(), Value::Bool(true));
        }
        return Ok(tool_ok(result));
    }
    let timeout_ms = profile.timeout_ms;
    let yield_ms = profile.yield_time_ms;
    let tty = args.get("tty").and_then(Value::as_bool).unwrap_or(false);
    let stdin_text = args.get("stdin").and_then(Value::as_str).unwrap_or("");

    let result = tauri::async_runtime::block_on(async {
        run_command(
            ctx,
            cmd,
            &workdir.path,
            timeout_ms.map(Duration::from_millis),
            Duration::from_millis(yield_ms),
            max_output,
            tty,
            stdin_text,
        )
        .await
    });

    match result {
        Ok(mut out) => {
            let running_id = (out.get("status").and_then(Value::as_str) == Some("running"))
                .then(|| {
                    out.get("command_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .flatten();
            if let Some(object) = out.as_object_mut() {
                object.insert("max_runtime_ms".into(), json!(profile.timeout_ms));
                object.insert(
                    "effective_yield_time_ms".into(),
                    json!(profile.yield_time_ms),
                );
                object.insert("safe_to_retry".into(), json!(false));
                object.insert(
                    "supervision_scope".into(),
                    json!("current server runtime; no automatic replay after restart"),
                );
                if let Some(id) = running_id {
                    object.insert("next_action".into(), json!({"tool": "write_stdin", "arguments": {
                        "command_id": id, "chars": "", "yield_time_ms": 1000, "max_output_bytes": 16384 },
                        "instruction": "Poll this command handle. Do not relaunch the command merely because it is quiet or an HTTP call timed out."}));
                }
                object.insert("filesystem_scope".into(), Value::String(filesystem_scope));
                object.insert("sandbox_enforced".into(), Value::Bool(false));
                object.insert(
                    "execution_boundary".into(),
                    Value::String("policy_only".into()),
                );
                object.insert("child_process".into(), Value::Bool(true));
            }
            Ok(tool_ok(out))
        }
        Err(error) => match execution_failure_result(&error, cmd, &workdir.path) {
            Some(result) => Ok(tool_ok(result)),
            None => Err(error),
        },
    }
}

fn validate_child_process_scope(_ctx: &ToolContext, args: &Value) -> Result<(), WorkspaceError> {
    let scope = args
        .get("filesystem_scope")
        .and_then(Value::as_str)
        .unwrap_or("workspace");
    match scope {
        "workspace" => Ok(()),
        "host" => Err(WorkspaceError::ToolDetails {
            code: "EXTERNAL_EXECUTION_NOT_ALLOWED",
            message: "exec_command 只允许在 Workspace 内执行，Workspace 外执行已禁用。".into(),
            category: "permission",
            retryable: false,
            details: json!({
                "stage": "policy",
                "filesystem_scope": "host",
                "sandbox_enforced": false,
                "recoverable": false,
                "suggestion": "将 filesystem_scope 设置为 workspace，并在当前 Workspace 内执行"
            }),
        }),
        _ => Err(WorkspaceError::invalid_argument(
            "filesystem_scope must be workspace",
        )),
    }
}

fn run_native_diagnostic(
    ctx: &ToolContext,
    cmd: &str,
    cwd: &Path,
    max_output: usize,
) -> Result<Option<Value>, WorkspaceError> {
    let parts = crate::tools::policy::split_command(cmd)
        .map_err(|_| WorkspaceError::invalid_argument("Invalid command syntax"))?;
    if parts.is_empty() {
        return Ok(None);
    }

    let command = parts[0].to_ascii_lowercase();
    let stdout = match command.as_str() {
        "pwd" if parts.len() == 1 => Some(format!("{}\n", cwd.display())),
        "ls" | "dir" => Some(list_directory(ctx, cwd, &parts[1..])?),
        "which" if parts.len() == 2 => {
            let path = which::which(&parts[1]).map_err(|_| WorkspaceError::Tool {
                code: "COMMAND_NOT_FOUND",
                message: format!("Program not found on PATH: {}", parts[1]),
                category: "runtime",
                retryable: false,
            })?;
            Some(format!("{}\n", path.display()))
        }
        "echo" => Some(format!("{}\n", parts[1..].join(" "))),
        _ => None,
    };

    Ok(stdout.map(|mut stdout| {
        let max_output = max_output.min(COMMAND_BUFFER_BYTES);
        let stdout_truncated = stdout.len() > max_output;
        if stdout_truncated {
            let mut start = stdout.len() - max_output;
            while !stdout.is_char_boundary(start) {
                start += 1;
            }
            stdout = stdout.split_off(start);
        }
        json!({
            "command": cmd,
            "resolved_cwd": cwd.display().to_string(),
            "status": "exited",
            "termination_reason": "exited",
            "recoverable": false,
            "suggestion": "命令已完成",
            "exit_code": 0,
            "stdout": stdout,
            "stderr": "",
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": false,
            "duration_ms": 0,
            "elapsed_ms": 0,
            "execution_mode": "native_builtin",
            "command_runner": "native_builtin",
            "warnings": ["native diagnostic without child process"]
        })
    }))
}

fn list_directory(
    ctx: &ToolContext,
    cwd: &Path,
    args: &[String],
) -> Result<String, WorkspaceError> {
    let target = match args {
        [] => cwd.to_path_buf(),
        [path] => ctx.workspace.resolve_existing(path)?.path,
        _ => {
            return Err(WorkspaceError::invalid_argument(
                "ls/dir accepts at most one directory path",
            ))
        }
    };
    if !target.is_dir() {
        return Err(WorkspaceError::not_a_directory(
            "ls/dir target is not a directory",
        ));
    }

    let mut entries = std::fs::read_dir(target)
        .map_err(|error| WorkspaceError::ToolDetails {
            code: "DIRECTORY_READ_FAILED",
            message: format!("Failed to read directory: {error}"),
            category: "runtime",
            retryable: true,
            details: json!({
                "stage": "native_builtin",
                "reason": "directory_read_failed",
                "retryable": true
            }),
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    entries.sort_unstable();
    Ok(if entries.is_empty() {
        String::new()
    } else {
        format!("{}\n", entries.join("\n"))
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_command(
    ctx: &ToolContext,
    cmd: &str,
    cwd: &Path,
    limit: Option<Duration>,
    yield_time: Duration,
    max_output: usize,
    tty: bool,
    stdin_text: &str,
) -> Result<Value, WorkspaceError> {
    let (program, args) = parse_and_resolve(cmd, cwd, &ctx.workspace, &ctx.policy)?;
    let task_owner = ctx
        .harness
        .current_task()
        .map_err(|e| WorkspaceError::Tool {
            code: e.code(),
            message: e.to_string(),
            category: "validation",
            retryable: false,
        })?
        .map(|task| task.id);
    let start = Instant::now();

    let mut command = command_for_program(&program, &args);
    // PowerShell -File waits on an unused piped stdin instead of running the script,
    // which shows up on hosted Windows runners as TIMEOUT with empty stdout/stderr.
    let stdin = if should_close_unused_stdin(&program, tty, stdin_text) {
        std::process::Stdio::null()
    } else {
        std::process::Stdio::piped()
    };
    command
        .current_dir(platform_command_path(cwd))
        .kill_on_drop(true)
        .stdin(stdin)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONLEGACYWINDOWSSTDIO", "0");
    remove_secret_env(command.as_std_mut());

    let mut process_tree =
        super::process_tree::ProcessTree::prepare(&mut command).map_err(|e| {
            WorkspaceError::Tool {
                code: "COMMAND_CONTAINMENT_FAILED",
                message: e.to_string(),
                category: "runtime",
                retryable: false,
            }
        })?;
    let admitted = {
        let _policy = ctx.policy_execution_guard()?;
        // Only the spawn holds the gate (resource_lease::spawn_gate), never what follows it.
        let spawned = {
            let _gate = crate::harness::resource_lease::spawn_gate();
            command.spawn()
        };
        let mut child = spawned.map_err(|e| WorkspaceError::ToolDetails {
            code: "COMMAND_SPAWN_FAILED",
            message: format!("Failed to start command: {e}"),
            category: "runtime",
            retryable: true,
            details: json!({
                "termination_reason": "spawn_failed",
                "recoverable": true,
                "suggestion": "检查命令路径、权限和运行时环境后重试"
            }),
        })?;

        if let Err(error) = process_tree.admit(&child) {
            let _ = child.start_kill();
            Err((child, error))
        } else {
            let mut session = ExecSession::new_with_mode(child, tty);
            session.runtime_limit_ms = limit.map(|value| value.as_millis() as u64);
            session.bind_tree(process_tree);
            session.bind_owner(ctx.harness.clone(), task_owner, ctx.execution_lease.clone());
            Ok(ctx.sessions.insert(session))
        }
    };
    let session = match admitted {
        Ok(session) => session,
        Err((mut child, error)) => {
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Err(WorkspaceError::Tool {
                code: "COMMAND_CONTAINMENT_FAILED",
                message: error.to_string(),
                category: "runtime",
                retryable: false,
            });
        }
    };
    session.spawn_readers().await;
    // Compare elapsed durations; no fabricated far-future Instant and no day cap.
    // The owner watchdog is live before stdin, so a pipe error cannot abandon a child.
    spawn_timeout_monitor(
        ctx.sessions.clone(),
        session.clone(),
        start,
        limit,
        ctx.workspace.clone(),
    );

    if !tty && !stdin_text.is_empty() {
        session.write_input(stdin_text, true, Some(ctx)).await?;
    }

    if yield_time.is_zero() {
        let snapshot = session.snapshot(max_output);
        spawn_timeout_monitor(
            ctx.sessions.clone(),
            session.clone(),
            start,
            limit,
            ctx.workspace.clone(),
        );
        return Ok(merge_exec_result(snapshot, start, cmd, cwd, true));
    }

    loop {
        session.refresh_status().await;
        if session.has_exited() {
            session.wait_for_readers().await;
            session.finalize_owner().await;
            let snapshot = session.snapshot(max_output);
            schedule_session_eviction(
                ctx.sessions.clone(),
                session.session_id.clone(),
                Duration::from_secs(COMPLETED_COMMAND_RETENTION_SECONDS),
            );
            return Ok(merge_exec_result(snapshot, start, cmd, cwd, false));
        }
        if !tty && limit.is_some_and(|limit| start.elapsed() >= limit) {
            session.mark_termination_reason("timeout");
            session.kill_and_wait().await;
            session.refresh_status().await;
            session.wait_for_readers().await;
            let snapshot = session.snapshot(max_output);
            session.finalize_owner().await;
            // Snapshot is embedded; schedule eviction so abandoned timeouts do not linger.
            schedule_session_eviction(
                ctx.sessions.clone(),
                session.session_id.clone(),
                COMMAND_EVICT_AFTER_TIMEOUT,
            );
            return Err(WorkspaceError::ToolDetails {
                code: "TIMEOUT",
                message: "Command timed out.".into(),
                category: "runtime",
                retryable: false,
                details: json!({
                    "termination_reason": "timeout",
                    "recoverable": true,
                    "safe_to_retry": false,
                    "suggestion": "Read retained output and inspect partial effects. A new execution requires an explicit new request; never automatically replay a timeout.",
                    "command": snapshot.clone(),
                    "session": snapshot
                }),
            });
        }
        if Instant::now() - start >= yield_time || tty {
            let snapshot = session.snapshot(max_output);
            spawn_timeout_monitor(
                ctx.sessions.clone(),
                session.clone(),
                start,
                limit,
                ctx.workspace.clone(),
            );
            return Ok(merge_exec_result(snapshot, start, cmd, cwd, true));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether an environment variable carries one of the app's own secrets: the headless control
/// token file and descriptor (a bearer for `/api/v1/tools/call`, unrooted, and `codex_*`), the
/// local UI channel, and the proxy and service keys. Every `CODING_TOOLS_*` name with one of these
/// markers counts, so a secret added later is covered too.
pub(crate) fn is_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let Some(rest) = upper.strip_prefix("CODING_TOOLS_") else {
        return false;
    };
    [
        "TOKEN",
        "KEY",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "AUTH",
        "DESCRIPTOR",
        "PROXY",
        "LOCAL_UI",
    ]
    .iter()
    .any(|marker| rest.contains(marker))
}

/// A process started for a tool call (a command, git) never inherits the app's secrets from this
/// process: whoever drives the tool must not be able to read them with `set` or `env`.
pub(crate) fn remove_secret_env(command: &mut std::process::Command) {
    for (name, _) in std::env::vars_os() {
        if is_secret_env_name(&name.to_string_lossy()) {
            command.env_remove(&name);
        }
    }
}

/// How long a timed-out / background session stays readable before map eviction.
const COMMAND_EVICT_AFTER_TIMEOUT: Duration =
    Duration::from_secs(COMPLETED_COMMAND_RETENTION_SECONDS);

fn spawn_timeout_monitor(
    sessions: Arc<SessionStore>,
    session: Arc<ExecSession>,
    started: Instant,
    limit: Option<Duration>,
    workspace: Workspace,
) {
    if !session.begin_monitor() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut roots_checked = Instant::now();
        loop {
            if roots_checked.elapsed() >= Duration::from_secs(1) {
                let current = workspace.clone();
                let valid =
                    tokio::task::spawn_blocking(move || current.ensure_roots_current()).await;
                if !matches!(valid, Ok(Ok(()))) {
                    crate::tools::session::mark_roots_revoked(&session);
                    session.kill_and_wait().await;
                }
                roots_checked = Instant::now();
            }
            session.refresh_status().await;
            if session.has_exited() {
                session.wait_for_readers().await;
                session.finalize_owner().await;
                schedule_session_eviction(
                    sessions,
                    session.session_id.clone(),
                    Duration::from_secs(COMPLETED_COMMAND_RETENTION_SECONDS),
                );
                break;
            }
            let remaining = limit.map(|limit| limit.saturating_sub(started.elapsed()));
            if remaining.is_some_and(|remaining| remaining.is_zero()) {
                session.mark_termination_reason("timeout");
                session.kill_and_wait().await;
                session.refresh_status().await;
                session.wait_for_readers().await;
                session.finalize_owner().await;
                if !session.has_exited() {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                schedule_session_eviction(
                    sessions,
                    session.session_id.clone(),
                    COMMAND_EVICT_AFTER_TIMEOUT,
                );
                break;
            }
            let interval = if started.elapsed() < Duration::from_secs(10) {
                Duration::from_millis(250)
            } else {
                Duration::from_secs(1)
            };
            tokio::time::sleep(remaining.unwrap_or(interval).min(interval)).await;
        }
    });
}

fn schedule_session_eviction(
    sessions: Arc<SessionStore>,
    _command_id: String,
    _retention: Duration,
) {
    // One weak maintenance task per store, not a 90-minute sleeper per command.
    sessions.maintain_completed(Instant::now());
    sessions.start_cache_maintenance();
}

pub fn exec_health_check(ctx: &ToolContext) -> Result<Value, WorkspaceError> {
    let start = Instant::now();
    let cwd = ctx.workspace.root().to_path_buf();
    #[cfg(windows)]
    let probe = r#"cmd.exe /d /c "echo exec-health && echo exec-health-stderr 1>&2""#;
    #[cfg(not(windows))]
    let probe = r#"sh -c "printf exec-health; printf exec-health-stderr >&2""#;

    let result = tauri::async_runtime::block_on(run_command(
        ctx,
        probe,
        &cwd,
        Some(Duration::from_secs(5)),
        Duration::from_secs(5),
        16_384,
        false,
        "",
    ));

    let mut response = json!({
        "worker": {"alive": true},
        "session_create": false,
        "command_run": false,
        "stdout_capture": false,
        "stderr_capture": false,
        "duration_ms": start.elapsed().as_millis(),
        "next_actions": []
    });

    match result {
        Ok(snapshot) => {
            let session_created = snapshot.get("session_id").is_some();
            let command_run = snapshot.get("exit_code").and_then(Value::as_i64) == Some(0);
            let stdout_capture = snapshot
                .get("stdout")
                .and_then(Value::as_str)
                .is_some_and(|value| value.contains("exec-health"));
            let stderr_capture = snapshot
                .get("stderr")
                .and_then(Value::as_str)
                .is_some_and(|value| value.contains("exec-health-stderr"));
            let healthy = session_created && command_run && stdout_capture && stderr_capture;
            response["session_create"] = Value::Bool(session_created);
            response["command_run"] = Value::Bool(command_run);
            response["stdout_capture"] = Value::Bool(stdout_capture);
            response["stderr_capture"] = Value::Bool(stderr_capture);
            response["status"] = Value::String(if healthy { "success" } else { "error" }.into());
            response["summary"] = Value::String(if healthy {
                "exec worker、session、命令执行和 stdout/stderr 捕获均正常".into()
            } else {
                "exec health check 未通过，请查看 probe 结果".into()
            });
            response["probe"] = snapshot;
            if !healthy {
                response["next_actions"] = json!(["检查 exec worker 日志", "重启运行时"]);
            }
        }
        Err(error) => {
            response["status"] = Value::String("error".into());
            response["summary"] = Value::String("exec session 创建或探针执行失败".into());
            response["error"] = error.to_error_value();
            response["next_actions"] = json!(["检查 exec worker 日志", "重启运行时"]);
        }
    }
    response["duration_ms"] = json!(start.elapsed().as_millis());
    Ok(tool_ok(response))
}

fn execution_failure_result(error: &WorkspaceError, command: &str, cwd: &Path) -> Option<Value> {
    let code = match &error {
        WorkspaceError::Tool { code, .. } | WorkspaceError::ToolDetails { code, .. } => *code,
    };
    if !matches!(
        code,
        "COMMAND_REJECTED" | "COMMAND_SPAWN_FAILED" | "TIMEOUT"
    ) {
        return None;
    }

    let error_value = error.to_error_value();
    let details = error_value
        .get("details")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut result = details
        .get("command")
        .or_else(|| details.get("session"))
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "status": "spawn_failed",
                "termination_reason": "spawn_failed",
                "recoverable": error_value["retryable"].as_bool().unwrap_or(false),
                "exit_code": Value::Null,
                "stdout": "",
                "stderr": "",
                "stdout_truncated": false,
                "stderr_truncated": false
            })
        });
    if let Some(object) = result.as_object_mut() {
        object.insert("command".into(), json!(command));
        object.insert("resolved_cwd".into(), json!(cwd.display().to_string()));
        object.insert("execution_mode".into(), json!("direct"));
        object.insert("filesystem_scope".into(), json!("workspace"));
        object.insert("sandbox_enforced".into(), Value::Bool(false));
        object.insert("execution_boundary".into(), json!("policy_only"));
        object.insert("child_process".into(), Value::Bool(true));
        object.insert("transport_ok".into(), Value::Bool(true));
        object.insert("command_ok".into(), Value::Bool(false));
        object.insert("error".into(), error_value);
        if code == "TIMEOUT" {
            object.insert("termination_reason".into(), json!("timeout"));
        } else {
            object.insert("status".into(), json!("spawn_failed"));
            object.insert("termination_reason".into(), json!("spawn_failed"));
        }
    }
    Some(result)
}

fn merge_exec_result(
    mut snapshot: Value,
    start: Instant,
    command: &str,
    cwd: &Path,
    keep_session: bool,
) -> Value {
    if let Some(obj) = snapshot.as_object_mut() {
        let duration_ms = start.elapsed().as_millis();
        obj.insert("command".into(), json!(command));
        obj.insert("resolved_cwd".into(), json!(cwd.display().to_string()));
        obj.insert("exec_dispatch_ms".into(), json!(duration_ms));
        let process_duration = obj
            .get("elapsed_ms")
            .cloned()
            .unwrap_or_else(|| json!(duration_ms));
        obj.insert("duration_ms".into(), process_duration);
        // Keep the process clock supplied by ExecSession. Dispatch/reconciliation
        // time must not overwrite a completed command's frozen elapsed time.
        obj.entry("elapsed_ms")
            .or_insert_with(|| json!(duration_ms));
        obj.insert("transport_ok".into(), Value::Bool(true));
        let command_ok = match obj
            .get("termination_reason")
            .and_then(Value::as_str)
            .unwrap_or("running")
        {
            "exited" => obj
                .get("exit_code")
                .and_then(Value::as_i64)
                .map(|exit_code| exit_code == 0)
                .or(Some(false)),
            "running" => None,
            _ => Some(false),
        };
        obj.insert(
            "command_ok".into(),
            command_ok.map(Value::Bool).unwrap_or(Value::Null),
        );
        obj.insert("execution_mode".into(), json!("direct"));
        obj.insert(
            "warnings".into(),
            json!(if keep_session {
                vec!["command retained for read_output/write_stdin/kill_command; legacy kill_session remains accepted"]
            } else {
                vec!["completed command output retained for reconnect-safe read_output"]
            }),
        );
    }
    snapshot
}

fn parse_and_resolve(
    cmd: &str,
    cwd: &Path,
    workspace: &Workspace,
    policy: &crate::tools::policy::PolicySettings,
) -> Result<(String, Vec<String>), WorkspaceError> {
    let parts = crate::tools::policy::split_command(cmd)
        .map_err(|_| WorkspaceError::invalid_argument("Invalid command syntax"))?;
    if parts.is_empty() {
        return Err(WorkspaceError::invalid_argument("Empty command"));
    }

    let program = resolve_program(&parts[0], cwd, workspace, policy)?;
    Ok((program, parts[1..].to_vec()))
}

fn resolve_program(
    raw: &str,
    cwd: &Path,
    workspace: &Workspace,
    policy: &crate::tools::policy::PolicySettings,
) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::invalid_argument("Empty program"));
    }

    let explicit_path = trimmed.contains(['/', '\\']);
    let candidate = if Path::new(trimmed).is_absolute() {
        Path::new(trimmed).to_path_buf()
    } else {
        cwd.join(trimmed)
    };
    if candidate.is_file() {
        let resolved = candidate.canonicalize().map_err(|_| WorkspaceError::Tool {
            code: "COMMAND_REJECTED",
            message: format!("Program not found: {trimmed}"),
            category: "runtime",
            retryable: false,
        })?;
        if !workspace.is_safe_existing_path(&resolved) {
            return Err(WorkspaceError::Tool {
                code: "EXECUTABLE_OUTSIDE_WORKSPACE",
                message: format!("Workspace/linked project 外可执行文件被拒绝: {trimmed}"),
                category: "security",
                retryable: false,
            });
        }
        let extension = resolved
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_ascii_lowercase()))
            .unwrap_or_default();
        if policy.workspace_local_entries
            && (extension.is_empty() || policy.workspace_script_extensions.contains(&extension))
        {
            return Ok(resolved.to_string_lossy().into_owned());
        }
        return Err(WorkspaceError::Tool {
            code: "COMMAND_REJECTED",
            message: format!("Workspace 本地入口未获允许: {trimmed}"),
            category: "policy",
            retryable: false,
        });
    }

    if explicit_path {
        return Err(WorkspaceError::Tool {
            code: "COMMAND_REJECTED",
            message: format!("Program not found: {trimmed}"),
            category: "runtime",
            retryable: false,
        });
    }

    which::which(trimmed)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| WorkspaceError::Tool {
            code: "COMMAND_REJECTED",
            message: format!("Program not found on PATH: {trimmed}"),
            category: "runtime",
            retryable: false,
        })
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use crate::tools::context::ToolContext;
    use crate::tools::dispatch::call_tool;
    use serde_json::json;
    use tempfile::tempdir;

    fn assert_failure_result(error: WorkspaceError, expected_code: &str) {
        let result = execution_failure_result(&error, "missing-command", Path::new("C:/workspace"))
            .expect("应转换为统一执行结果");
        assert_eq!(result["transport_ok"], true);
        assert_eq!(result["command_ok"], false);
        assert_eq!(result["status"], "spawn_failed");
        assert_eq!(result["error"]["code"], expected_code);
    }

    #[test]
    fn 程序不存在时返回统一执行结果() {
        assert_failure_result(
            WorkspaceError::Tool {
                code: "COMMAND_REJECTED",
                message: "Program not found on PATH: missing-command".into(),
                category: "runtime",
                retryable: false,
            },
            "COMMAND_REJECTED",
        );
    }

    #[test]
    fn 启动失败时返回统一执行结果() {
        assert_failure_result(
            WorkspaceError::ToolDetails {
                code: "COMMAND_SPAWN_FAILED",
                message: "Failed to start command".into(),
                category: "runtime",
                retryable: true,
                details: json!({"recoverable": true}),
            },
            "COMMAND_SPAWN_FAILED",
        );
    }

    #[test]
    fn the_apps_secrets_are_recognised_by_name() {
        for name in [
            "CODING_TOOLS_CONTROL_TOKEN_FILE",
            "CODING_TOOLS_CONTROL_DESCRIPTOR_FILE",
            "CODING_TOOLS_LOCAL_UI_STDIN",
            "CODING_TOOLS_CPA_KEY",
            "CODING_TOOLS_CPA_MANAGEMENT_KEY",
            "CODING_TOOLS_CPA_PROXY_API_KEY",
            "CODING_TOOLS_CPA_OUTBOUND_PROXY_URL",
            "CODING_TOOLS_AO_WEB_KEY",
            "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY",
            "coding_tools_control_token_file",
        ] {
            assert!(is_secret_env_name(name), "{name}");
        }
        for name in [
            "PATH",
            "CODING_TOOLS_APP_DATA_DIR",
            "CODING_TOOLS_HOME",
            "GITHUB_TOKEN",
        ] {
            assert!(!is_secret_env_name(name), "{name}");
        }
    }

    #[test]
    fn a_child_command_is_built_without_the_apps_secrets() {
        // A name of its own, so no other test sees it; it carries the same marker.
        std::env::set_var("CODING_TOOLS_TEST_STRIP_TOKEN_FILE", "fake-token-path.txt");
        let mut command = std::process::Command::new("child");
        remove_secret_env(&mut command);
        assert!(command.get_envs().any(|(name, value)| {
            name == "CODING_TOOLS_TEST_STRIP_TOKEN_FILE" && value.is_none()
        }));
        std::env::remove_var("CODING_TOOLS_TEST_STRIP_TOKEN_FILE");
    }

    #[cfg(windows)]
    #[test]
    fn exec_command_children_do_not_inherit_the_control_token_file() {
        std::env::set_var(
            "CODING_TOOLS_TEST_EXEC_TOKEN_FILE",
            r"C:\fake\headless-control\token.txt",
        );
        std::env::set_var("CODING_TOOLS_TEST_EXEC_VISIBLE", "visible-marker");
        let workspace = tempdir().expect("workspace");
        let harness = tempdir().expect("harness");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");
        let output = call_tool(
            &ctx,
            "exec_command",
            // Under a loaded full test run a cold cmd.exe can take several seconds to start.
            &json!({ "cmd": "cmd /d /c set CODING_TOOLS_TEST_EXEC", "timeout_ms": 30_000, "yield_time_ms": 30_000 }),
        );
        std::env::remove_var("CODING_TOOLS_TEST_EXEC_TOKEN_FILE");
        std::env::remove_var("CODING_TOOLS_TEST_EXEC_VISIBLE");
        let stdout = output["stdout"].as_str().unwrap_or_default();
        assert!(
            stdout.contains("CODING_TOOLS_TEST_EXEC_VISIBLE=visible-marker"),
            "{output}"
        );
        assert!(!stdout.contains("TOKEN_FILE"), "{output}");
    }

    #[test]
    fn resolves_an_arbitrarily_named_workspace_local_entry() {
        let workspace = tempdir().expect("workspace");
        let entry = workspace.path().join("scripts").join("anything.cmd");
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("scripts");
        std::fs::write(&entry, "echo test").expect("entry");
        let workspace_model =
            Workspace::new(workspace.path().to_path_buf()).expect("workspace model");
        let resolved = resolve_program(
            "scripts/anything.cmd",
            workspace.path(),
            &workspace_model,
            &crate::tools::policy::PolicySettings::default(),
        )
        .expect("workspace entry resolves");
        assert_eq!(
            std::path::Path::new(&resolved),
            entry.canonicalize().unwrap()
        );
    }

    #[test]
    fn audit_native_directory_output_honors_the_requested_byte_limit() {
        let workspace = tempdir().unwrap();
        let harness = tempdir().unwrap();
        std::fs::write(workspace.path().join("a.txt"), "a").unwrap();
        std::fs::write(workspace.path().join("b.txt"), "b").unwrap();
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .unwrap();
        for command in ["ls", "dir"] {
            let result = call_tool(
                &ctx,
                "exec_command",
                &json!({"cmd": command, "max_output_bytes": 7}),
            );
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(result["stdout"], "\nb.txt\n", "{result}");
            assert_eq!(result["stdout_truncated"], true, "{result}");
            assert_eq!(result["stderr_truncated"], false, "{result}");
            assert_eq!(result["child_process"], false, "{result}");
        }
    }

    #[test]
    fn audit_native_output_limits_preserve_utf8_at_zero_and_character_boundaries() {
        let workspace = tempdir().unwrap();
        let harness = tempdir().unwrap();
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .unwrap();
        for (limit, expected) in [
            (0, ""),
            (1, "\n"),
            (2, "z\n"),
            (3, "z\n"),
            (6, "😊z\n"),
            (8, "é😊z\n"),
            (9, "aé😊z\n"),
        ] {
            let result = call_tool(
                &ctx,
                "exec_command",
                &json!({"cmd": "echo aé😊z", "max_output_bytes": limit}),
            );
            assert_eq!(result["ok"], true, "{result}");
            let stdout = result["stdout"].as_str().unwrap();
            assert_eq!(stdout, expected, "limit {limit}: {result}");
            assert!(stdout.len() <= limit, "limit {limit}: {result}");
            assert_eq!(result["stdout_truncated"], limit < 9, "{result}");
        }
    }

    #[test]
    fn closes_unused_stdin_only_for_noninteractive_powershell_files() {
        assert!(should_close_unused_stdin(
            r"C:\workspace\any-name.ps1",
            false,
            ""
        ));
        assert!(should_close_unused_stdin("any-name.PS1", false, ""));
        assert!(!should_close_unused_stdin(
            r"C:\workspace\any-name.ps1",
            true,
            ""
        ));
        assert!(!should_close_unused_stdin(
            r"C:\workspace\any-name.ps1",
            false,
            "keep-open"
        ));
        assert!(!should_close_unused_stdin(
            r"C:\workspace\any-name.cmd",
            false,
            ""
        ));
        assert!(!should_close_unused_stdin("python.exe", false, ""));
    }

    #[cfg(windows)]
    #[test]
    fn windows_hidden_creation_flags_match_frpc_no_window_pattern() {
        assert_eq!(
            windows_hidden_creation_flags(),
            0x0000_0200 | 0x0800_0000,
            "must keep CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_scripts_use_their_platform_runners() {
        let batch = command_for_program("C:/workspace/run-anything.cmd", &[]);
        assert_eq!(batch.as_std().get_program().to_string_lossy(), "cmd.exe");
        assert!(batch.as_std().get_args().any(|arg| arg == "/c"));
        assert_eq!(
            windows_batch_command_line(
                r"\\?\C:\workspace\Life Brain\run & tooling.cmd",
                &["argument & value".to_string()]
            ),
            r#"call "C:\workspace\Life Brain\run & tooling.cmd" "argument & value""#
        );

        let script = command_for_program("C:/workspace/run-anything.ps1", &[]);
        let runner = script
            .as_std()
            .get_program()
            .to_string_lossy()
            .to_ascii_lowercase();
        assert!(
            runner.contains("powershell") || runner.contains("pwsh"),
            "{runner}"
        );
        if which::which("powershell").is_ok() {
            assert!(
                !runner.contains("pwsh"),
                "workspace .ps1 files must prefer Windows PowerShell over pwsh: {runner}"
            );
        }
        let args: Vec<String> = script
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|arg| arg == "-File"));
        assert!(args.iter().any(|arg| arg == "-NonInteractive"));
        assert!(args.iter().any(|arg| arg == "-NoProfile"));

        // Ensure console-subsystem programs (python.exe) also go through the
        // hidden-window flag path; Command does not expose creation_flags for
        // direct assertion, so this only verifies construction still succeeds.
        let python =
            command_for_program("C:/Python312/python.exe", &["-c".into(), "print(1)".into()]);
        assert_eq!(
            python.as_std().get_program().to_string_lossy(),
            "C:/Python312/python.exe"
        );
    }

    /// Starts Windows PowerShell once, untimed, before a test times PowerShell commands. Its first
    /// start on a hosted runner (a cold .NET load scanned by Defender, while the rest of the suite
    /// runs in parallel) can outlast a 30 s exec limit with no output, which read as a hung `.ps1`.
    /// The timed calls still go through exec_command's own launch, so a launch that hangs still fails.
    #[cfg(windows)]
    fn warm_windows_powershell() {
        let Ok(shell) = which::which("powershell").or_else(|_| which::which("pwsh")) else {
            return;
        };
        let mut child = std::process::Command::new(shell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "exit 0",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(windows_hidden_creation_flags())
            .spawn()
            .expect("start Windows PowerShell");
        let started = Instant::now();
        while child
            .try_wait()
            .expect("wait for Windows PowerShell")
            .is_none()
        {
            if started.elapsed() >= Duration::from_secs(120) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Windows PowerShell did not start and exit within 120 s on this machine");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_workspace_scripts_and_python_unicode_execute_successfully() {
        let workspace = tempdir().expect("workspace");
        let harness = tempdir().expect("harness");
        std::fs::write(
            workspace.path().join("any-name.cmd"),
            "@echo tooling-cmd-ok\r\n",
        )
        .expect("cmd script");
        std::fs::write(
            workspace.path().join("any-name.ps1"),
            "[Console]::Out.WriteLine('tooling-powershell-ok')\r\n",
        )
        .expect("powershell script");
        std::fs::write(
            workspace.path().join("workflow_probe.py"),
            "print('workflow-ok')\n",
        )
        .expect("python module");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");
        warm_windows_powershell();

        for command in [
            "any-name.cmd",
            "any-name.ps1",
            "cmd /c echo tooling-cmd-ok",
            "powershell -NoProfile -Command \"Write-Output tooling-powershell-ok\"",
            "python -c \"print('中文输出正常 ✅')\"",
        ] {
            let output = call_tool(
                &ctx,
                "exec_command",
                // Cold PowerShell startup on hosted Windows runners can exceed ten seconds.
                &json!({ "cmd": command, "timeout_ms": 30_000, "yield_time_ms": 30_000 }),
            );
            assert_eq!(output["ok"], true, "{command}: {output}");
            assert_eq!(output["command_ok"], true, "{command}: {output}");
        }

        for _ in 0..10 {
            let output = call_tool(
                &ctx,
                "exec_command",
                // Wait for the exit, as above: with the default one-second yield a slow start
                // (the Python install manager's shim, a busy disk) read as still running.
                &json!({ "cmd": "python -m workflow_probe", "timeout_ms": 10_000, "yield_time_ms": 10_000 }),
            );
            assert_eq!(output["command_ok"], true, "{output}");
            assert!(output["stdout"]
                .as_str()
                .unwrap_or_default()
                .contains("workflow-ok"));
        }
    }

    #[test]
    fn a_store_keeping_a_command_is_not_idle() {
        // A cache of tool contexts may drop only an idle one: a kept command (running, or finished
        // with its output retained for read_output) would otherwise vanish from later calls.
        let workspace = tempdir().expect("workspace");
        let harness = tempdir().expect("harness");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");
        assert!(ctx.sessions.is_idle(), "a fresh store holds nothing");
        // A spawned, allowlisted process on every host (plain `echo` is answered natively, without
        // one, and `sh` is not on the command allowlist).
        let output = call_tool(
            &ctx,
            "exec_command",
            &json!({ "cmd": "git --version", "timeout_ms": 30_000 }),
        );
        assert_eq!(output["ok"], true, "{output}");
        assert!(
            !ctx.sessions.is_idle(),
            "the finished command's output is kept, so the store is in use"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_batch_scripts_preserve_space_paths_and_arguments() {
        let parent = tempdir().expect("workspace parent");
        let workspace = parent.path().join("Life Brain 中文");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let harness = tempdir().expect("harness");
        let ctx = ToolContext::for_test(workspace.clone(), harness.path().to_path_buf())
            .expect("context");

        for extension in ["cmd", "bat"] {
            let script_name = format!("run & tooling.{extension}");
            std::fs::write(
                workspace.join(&script_name),
                "@echo off\r\nif not \"%~1\"==\"argument & value\" exit /b 7\r\necho tooling-space-path-ok\r\n",
            )
            .expect("batch script");

            let command = format!(r#""{script_name}" "argument & value""#);
            let output = call_tool(
                &ctx,
                "exec_command",
                &json!({ "cmd": command, "timeout_ms": 10_000, "yield_time_ms": 10_000 }),
            );
            assert_eq!(output["command_ok"], true, "{script_name}: {output}");
            let stdout = output["stdout"].as_str().unwrap_or_default();
            assert!(
                stdout.contains("tooling-space-path-ok"),
                "{script_name}: {output}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_workspace_scripts_preserve_space_paths_and_arguments() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempdir().expect("workspace parent");
        let workspace = parent.path().join("Life Brain 中文");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let harness = tempdir().expect("harness");
        let script_name = "run tooling";
        let script_path = workspace.join(script_name);
        std::fs::write(
            &script_path,
            "#!/bin/sh\nprintf 'tooling-space-path-ok\\n'\nprintf 'argument=[%s]\\n' \"$1\"\n",
        )
        .expect("shell script");
        let mut permissions = std::fs::metadata(&script_path)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).expect("script executable");

        let ctx = ToolContext::for_test(workspace, harness.path().to_path_buf()).expect("context");
        let command = format!(r#""{script_name}" "argument with spaces""#);
        let output = call_tool(
            &ctx,
            "exec_command",
            &json!({ "cmd": command, "timeout_ms": 10_000, "yield_time_ms": 10_000 }),
        );
        assert_eq!(output["command_ok"], true, "{output}");
        let stdout = output["stdout"].as_str().unwrap_or_default();
        assert!(stdout.contains("tooling-space-path-ok"), "{output}");
        assert!(
            stdout.contains("argument=[argument with spaces]"),
            "{output}"
        );
    }
}

#[cfg(windows)]
fn windows_hidden_creation_flags() -> u32 {
    // Match frpc/cloudflared: hide console-subsystem children (python/cmd/powershell)
    // so remote exec_command does not flash a console or steal focus.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
}

fn should_close_unused_stdin(program: &str, tty: bool, stdin_text: &str) -> bool {
    !tty && stdin_text.is_empty()
        && Path::new(program)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("ps1"))
}

fn command_for_program(program: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let extension = Path::new(program)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("bat") | Some("cmd") => {
                let mut command = Command::new("cmd.exe");
                command.args(["/d", "/s", "/c"]);
                command
                    .as_std_mut()
                    .raw_arg(windows_batch_command_line(program, args));
                command.creation_flags(windows_hidden_creation_flags());
                return command;
            }
            Some("ps1") => {
                // Prefer Windows PowerShell. GitHub-hosted runners also ship pwsh,
                // whose first launch with CREATE_NO_WINDOW + an open stdin pipe
                // can sit until the exec timeout with no output.
                let shell = which::which("powershell")
                    .or_else(|_| which::which("pwsh"))
                    .unwrap_or_else(|_| std::path::PathBuf::from("powershell.exe"));
                let mut command = Command::new(shell);
                command
                    .env("POWERSHELL_TELEMETRY_OPTOUT", "1")
                    .env("POWERSHELL_UPDATECHECK", "Off")
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        windows_command_path(program).as_str(),
                    ])
                    .args(args);
                command.creation_flags(windows_hidden_creation_flags());
                return command;
            }
            _ => {}
        }
    }

    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(windows_hidden_creation_flags());
    command
}

#[cfg(windows)]
fn windows_batch_command_line(program: &str, args: &[String]) -> String {
    let mut command_line = String::from("call ");
    command_line.push_str(&windows_batch_token(&windows_command_path(program)));
    for arg in args {
        command_line.push(' ');
        command_line.push_str(&windows_batch_token(arg));
    }
    command_line
}

#[cfg(windows)]
fn windows_batch_token(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn platform_command_path(path: &Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        std::path::PathBuf::from(windows_command_path(&path.to_string_lossy()))
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

#[cfg(windows)]
fn windows_command_path(path: &str) -> String {
    path.strip_prefix("\\\\?\\").unwrap_or(path).to_string()
}

use std::path::Path;

use serde_json::{json, Value};

use crate::tools::context::ToolContext;
use crate::tools::policy::{validate_tool_arguments_for_workspace, PolicyError};
use crate::tools::workspace::{tool_err, tool_err_code, tool_ok, WorkspaceError};
use crate::tools::{
    exec, file, git, history, image_tool, patch, project_context, screen_tool, session,
};

fn policy_tool_err(err: PolicyError) -> Value {
    let dangerous = err
        .0
        .strip_prefix("DANGEROUS_OPERATION_REQUIRES_CONFIRMATION: ");
    let protected = err.0.strip_prefix("PROTECTED_REPOSITORY_ASSET: ");
    let elevation = err.0.strip_prefix("ELEVATION_NOT_ALLOWED: ");
    let read_only = err.0.strip_prefix("READ_ONLY_SANDBOX: ");
    let code = if read_only.is_some() {
        "READ_ONLY_SANDBOX"
    } else if protected.is_some() {
        "PROTECTED_REPOSITORY_ASSET"
    } else if elevation.is_some() {
        "ELEVATION_NOT_ALLOWED"
    } else if dangerous.is_some() {
        "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION"
    } else {
        "POLICY_REJECTED"
    };
    let message = read_only
        .or(protected)
        .or(elevation)
        .or(dangerous)
        .unwrap_or(&err.0)
        .to_string();
    let (reason, suggestion) = if read_only.is_some() {
        (
            "read_only_sandbox",
            "改用读取工具，或将 Sandbox mode 切换为 workspace-write",
        )
    } else if dangerous.is_some() {
        (
            "confirmation_required",
            "为危险操作补充 confirm=true，确认后再重试",
        )
    } else if message.contains("allowlisted") {
        ("command_rejected", "改用允许的命令，或调整工作区命令白名单")
    } else if message.contains("Shell chaining") {
        (
            "shell_syntax_rejected",
            "移除未加引号的 shell 操作符；引号内的程序参数可以保留",
        )
    } else {
        ("policy_rejected", "根据错误信息修正参数后重试")
    };
    tool_err(WorkspaceError::ToolDetails {
        code,
        message,
        category: "policy",
        retryable: false,
        details: json!({
            "stage": "policy",
            "reason": reason,
            "recoverable": reason != "confirmation_required",
            "suggestion": suggestion
        }),
    })
}

/// **唯一工具执行入口**。MCP `tools/call` 与 Actions `POST /actions/{tool}` 必须且只能调用此函数。
/// 策略校验、分发、错误格式在此统一，两路传输层不得另做执行前校验（Actions 仅允许额外的暴露层 `validate_actions_exposure`）。
pub fn call_tool(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    call_current(ctx, name, args, false)
}
pub fn call_tool_mcp(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    call_current(ctx, name, args, true)
}
fn call_current(ctx: &ToolContext, name: &str, args: &Value, enforce_profile: bool) -> Value {
    let request_started = std::time::Instant::now();
    let snapshot = match ctx.for_request().and_then(|fresh| {
        if matches!(name, "apply_patch" | "patch_check") {
            Ok(fresh)
        } else {
            fresh.scope_request(name, args)
        }
    }) {
        Ok(value) => value,
        Err(error) => return tool_err(error),
    };
    let ctx = &snapshot;
    if enforce_profile
        && !crate::tools::registry::exposed_tool_names(&ctx.tool_profile).contains(&name)
    {
        return tool_err_code(
            "TOOL_PROFILE_RESTRICTED",
            "The current live tool profile does not permit this tool",
            "permission",
        );
    }
    let _policy_guard = if crate::tools::live_policy::fence_entire_call(name) {
        match ctx.policy_execution_guard() {
            Ok(guard) => Some(guard),
            Err(error) => return tool_err(error),
        }
    } else {
        None
    };
    let mut result = call_tool_snapshot(ctx, name, args);
    if crate::tools::live_policy::refreshable_observation(name)
        && ctx.current_policy_revision().ok() != Some(ctx.policy_revision)
    {
        return tool_err_code("PERMISSION_CHANGED_DURING_READ","Live permissions changed during this observation; its result was withheld. Reassess under the new policy.","permission");
    }
    if let Err(error) = ctx.workspace.ensure_roots_current() {
        return tool_err(error);
    }

    if (name.starts_with("computer_")
        || matches!(
            name,
            "capture_screenshot" | "capture_window" | "list_windows" | "list_displays"
        ))
        && ctx.current_policy_revision().ok() != Some(ctx.policy_revision)
    {
        return tool_err_code(
            "CAPTURE_PERMISSION_CHANGED",
            "Permissions changed during the operation; any frame was discarded. An input may already have been submitted: inspect state and do not automatically replay it.",
            "permission",
        );
    }
    if name == "server_info" {
        result["workspace_refresh"] = json!({"supported":true,"roots_revision":ctx.workspace.roots_revision(),"scope":"primary workspace and explicitly linked projects","reconnect_required":false,"new_root_access_inherits_live_policy":true,"external_process_revocation_on_manual_mapping_edit":false});
        result["long_task_limits"] = json!({"baseline_file_bytes":33554432,"baseline_total_bytes":134217728,"baseline_entries":20000,"baseline_cooperative_deadline_seconds":8,"use_command_id_for_long_processes":true,"automatic_operation_replay":false});
        result["long_task_limits"]["scoped_baseline"] = json!({"explicit_baseline_roots":true,"file_bytes":8589934592_u64,"total_bytes":68719476736_u64,"entries":100000,"read_chunk_bytes":262144});
        result["long_task_limits"]["execution"] = json!({"default_timeout_ms":null,"maximum_timeout_ms":null,"separate_mode_required":false,"default_post_launch_wait_ms":1000,"survives_server_restart":false,"owned_process_tree_cancellation":true});
        result["runtime_cache"] = super::ram_cache::output_cache().policy();
        result["live_permissions"] = json!({"supported":true,"revision":ctx.policy_revision,
            "permission_mode":ctx.permission_mode,"approval_mode":ctx.policy.approval_mode,
            "screen_capture_allowed":ctx.policy.allow_screen_capture,"tool_profile":ctx.tool_profile,
            "permission_restart_required":false,"permission_relink_required":false,
            "catalog_refresh_may_be_needed_for_tool_profile_change":true});
    }
    let instructions_revision = result.pointer("/project_instructions/revision").cloned();
    let displayed_root = ctx.workspace.display_path(ctx.harness.workspace_root());
    let project_root = if displayed_root.is_empty() {
        ".".to_string()
    } else {
        displayed_root
    };
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "server_dispatch_ms".into(),
            json!(request_started.elapsed().as_millis()),
        );
        object.entry("project_scope").or_insert_with(
            || json!({"root":project_root,"workspace_id":ctx.harness.workspace_id()}),
        );
        if object.get("status").and_then(Value::as_str) == Some("running") {
            if let Some(id) = object
                .get("command_id")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                let mut arguments = json!({"command_id":id,"chars":"","yield_time_ms":1000,"max_output_bytes":4096,"project_root":project_root});
                if let Some(revision) = instructions_revision {
                    arguments["known_project_instructions_revision"] = revision;
                }
                object.insert(
                    "next_action".into(),
                    json!({"tool":"write_stdin","arguments":arguments,"relaunch":false}),
                );
            }
        }
    }
    result
}

fn call_tool_snapshot(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    let mut effective_args = apply_default_cwd(ctx, name, args);
    // Run policy once before approval to surface only non-overridable hard
    // boundaries such as protected paths, host scope, shell escapes, and
    // administrator elevation. A confirmation-only destructive result is the
    // soft gate handled by the scoped approval store below.
    if let Err(e) = validate_tool_arguments_for_workspace(
        name,
        &effective_args,
        &ctx.policy,
        Some(&ctx.workspace),
    ) {
        if !e
            .0
            .starts_with("DANGEROUS_OPERATION_REQUIRES_CONFIRMATION:")
        {
            return attach_project_instructions(ctx, name, &effective_args, policy_tool_err(e));
        }
    }
    if name != "request_permissions" {
        if let Err(error) = ctx.approvals.preflight(
            name,
            &mut effective_args,
            &ctx.policy.approval_mode,
            &ctx.permission_mode,
        ) {
            return attach_project_instructions(
                ctx,
                name,
                &effective_args,
                tool_err(error.into_workspace_error()),
            );
        }
    }
    // Re-run the complete policy after approval. A consumed grant injects the
    // exact-operation confirmation flag, while every hard boundary remains
    // enforced and cannot be weakened by an approval token.
    if let Err(e) = validate_tool_arguments_for_workspace(
        name,
        &effective_args,
        &ctx.policy,
        Some(&ctx.workspace),
    ) {
        return attach_project_instructions(ctx, name, &effective_args, policy_tool_err(e));
    }

    if crate::harness::tools::TOOL_NAMES.contains(&name) {
        let output = match crate::harness::tools::call(ctx, name, args) {
            Ok(value) => value,
            Err(error) => attach_harness_status(ctx, tool_err(error), false),
        };
        return attach_project_instructions(ctx, name, &effective_args, output);
    }

    // Policy and scoped approval run before target resolution for patches.
    let mut execution = if matches!(name, "apply_patch" | "patch_check") {
        match ctx.scope_request(name, &effective_args) {
            Ok(scoped) => scoped,
            Err(error) => {
                return attach_project_instructions(ctx, name, &effective_args, tool_err(error))
            }
        }
    } else {
        ctx.clone()
    };
    let lease_context = execution.clone();
    let ctx = &lease_context;
    if requires_write_baseline(name, &effective_args) {
        match crate::harness::resource_lease::ResourceLease::acquire(
            ctx.harness.store_root(),
            ctx.harness.workspace_root(),
        ) {
            Ok(lease) => execution.execution_lease = Some(std::sync::Arc::new(lease)),
            Err(error) => {
                return attach_project_instructions(
                    ctx,
                    name,
                    &effective_args,
                    tool_err_code(error.code(), error.to_string(), "concurrency"),
                )
            }
        }
    }
    let ctx = &execution;
    let task_id = if requires_write_baseline(name, &effective_args) {
        let task = match ctx.harness.current_task() {
            Ok(task) => task,
            Err(error) => {
                return attach_project_instructions(
                    ctx,
                    name,
                    &effective_args,
                    tool_err_code(error.code(), error.to_string(), "permission"),
                )
            }
        };
        if let Some(task) = task {
            if let Err(error) = ctx.harness.check_baseline(&task.id) {
                let output = attach_harness_status(
                    ctx,
                    tool_err_code(error.code(), error.to_string(), "permission"),
                    false,
                );
                return attach_project_instructions(ctx, name, &effective_args, output);
            }
            let _ = ctx.harness.record_event(
                &task.id,
                "operation_started",
                Some(name),
                operation_input(args),
                json!({"ok": true, "tracking": "task"}),
            );
            Some(task.id)
        } else {
            None
        }
    } else {
        None
    };

    let operation = if should_log_operation(name) {
        ctx.harness
            .record_operation(
                None,
                task_id.as_deref(),
                name,
                "started",
                json!({"arguments_present": !args.is_null()}),
                json!({"ok": true}),
            )
            .ok()
    } else {
        None
    };

    let ws = &ctx.workspace;
    let result = match name {
        "mcp_operation_status" => ctx
            .operations
            .query_in_scope(
                &effective_args,
                ctx.policy_revision,
                &crate::tools::registry::exposed_tool_names(&ctx.tool_profile),
                &ctx.workspace.roots_revision(),
            )
            .map_err(|message| WorkspaceError::Tool {
                code: "OPERATION_QUERY_REJECTED",
                message,
                category: "validation",
                retryable: false,
            }),
        "workflow_list" | "workflow_update" => {
            crate::tools::workflow::call(ctx, name, &effective_args)
        }
        "codex_runtime_status"
        | "codex_agent_read"
        | "codex_agent_control"
        | "codex_command_exec" => crate::tools::codex_runtime::call(ctx, name, &effective_args),
        "codex_tools_status" | "tool_search" | "get_current_time" | "get_plan" | "update_plan" => {
            crate::tools::local_tools::call(ctx, name, &effective_args)
        }
        "history_session_bootstrap" => history::bootstrap(ctx, &effective_args),
        "history_session_checkpoint" => history::checkpoint(ctx, &effective_args),
        "history_session_validate" => history::validate(ctx, &effective_args),
        "history_session_search" => history::search(ctx, &effective_args),
        "history_session_read" => history::read(ctx, &effective_args),
        "server_info" => server_info(ctx),
        "check_exec_environment" => check_exec_environment(ctx),
        "exec_health_check" => exec::exec_health_check(ctx),
        "get_default_cwd" => get_default_cwd(ctx),
        "set_default_cwd" => set_default_cwd(ctx, &effective_args),
        "read_file" => file::read_file(ws, &effective_args),
        "list_dir" => file::list_dir(ws, &effective_args),
        "list_files" => file::list_files(ws, &effective_args),
        "search_text" | "grep_text" | "grep" => file::search_text(ws, &effective_args),
        "patch_check" => patch::patch_check(ctx, &effective_args),
        "apply_patch" => patch::apply_patch(ctx, &effective_args),
        "exec_command" => exec::exec_command(ctx, &effective_args),
        "read_output" => session::read_output_current(ctx, &effective_args),
        "write_stdin" => session::write_stdin_current(ctx, &effective_args),
        "kill_command" | "kill_session" => session::kill_command_current(ctx, &effective_args),
        "git_status" => git::git_status(ws, &effective_args),
        "git_diff" => git::git_diff(ws, &effective_args),
        "git_log" => git::git_log(ws, &effective_args),
        "git_show" => git::git_show(ws, &effective_args),
        "git_blame" => git::git_blame(ws, &effective_args),
        "view_image" => image_tool::view_image(ws, &effective_args),
        "image_info" => image_tool::image_info(ws, &effective_args),
        "compare_images" => image_tool::compare_images(ws, &effective_args),
        name if crate::tools::native_sandbox::NAMES.contains(&name) => {
            crate::tools::native_sandbox::call(ctx, name, &effective_args)
        }
        name if crate::tools::computer::schema::NAMES.contains(&name) => {
            crate::tools::computer::call(ctx, name, &effective_args)
        }
        "vision_status" => screen_tool::status(ctx),
        "list_displays" => screen_tool::list_displays(ctx),
        "list_windows" => screen_tool::list_windows(ctx, &effective_args),
        "capture_screenshot" => screen_tool::capture_screenshot(ctx, &effective_args),
        "capture_window" => screen_tool::capture_window(ctx, &effective_args),
        "request_permissions" => {
            let request_id = effective_args
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkspaceError::invalid_argument("request_id is required"));
            match request_id {
                Ok(request_id) => {
                    let scope = effective_args
                        .get("scope")
                        .and_then(Value::as_str)
                        .unwrap_or("once");
                    let confirmed = effective_args
                        .get("confirm")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    ctx.approvals
                        .grant(request_id, scope, confirmed)
                        .map(tool_ok)
                        .map_err(|error| error.into_workspace_error())
                }
                Err(error) => Err(error),
            }
        }
        _ => {
            let output = tool_err_code(
                "INVALID_ARGUMENT",
                format!("Unknown tool: {name}"),
                "validation",
            );
            return attach_project_instructions(ctx, name, &effective_args, output);
        }
    };
    let mut output = match result {
        Ok(v) => v,
        Err(e) => tool_err(e),
    };
    if task_id.is_none()
        && standalone_operation(name)
        && output.get("ok") == Some(&Value::Bool(true))
    {
        attach_standalone_metadata(
            &mut output,
            "当前操作已在 standalone 模式完成；如需继续，直接调用下一个开发工具。",
        );
    }
    if let Some(operation) = operation.as_ref() {
        if let Some(object) = output.as_object_mut() {
            object.insert("operation_id".into(), Value::String(operation.id.clone()));
        }
    }
    if output.get("ok").and_then(Value::as_bool) == Some(false) {
        output = attach_harness_status(ctx, output, task_id.is_none());
    }
    if let Some(task_id) = task_id.as_deref() {
        let succeeded = output.get("ok").and_then(Value::as_bool) == Some(true);
        let _ = ctx.harness.record_event(
            task_id,
            "operation_finished",
            Some(name),
            operation_input(args),
            json!({"ok": succeeded, "tool": name}),
        );
        if succeeded && name != "exec_command" {
            let _ = ctx.harness.refresh_expected_state(task_id);
        }
    }
    if let Some(operation) = operation {
        let succeeded = output.get("ok").and_then(Value::as_bool) == Some(true);
        let _ = ctx.harness.record_operation(
            Some(&operation.id),
            task_id.as_deref(),
            name,
            if succeeded { "completed" } else { "failed" },
            operation_input(args),
            json!({
                "ok": succeeded,
                "tool": name,
                "affected_files": output.get("affected_files")
            }),
        );
    }
    let displayed_root = ctx.workspace.display_path(ctx.harness.workspace_root());
    output["project_scope"] = json!({"root":if displayed_root.is_empty(){"."}else{&displayed_root},"workspace_id":ctx.harness.workspace_id()});
    attach_project_instructions(ctx, name, &effective_args, output)
}

fn attach_project_instructions(
    ctx: &ToolContext,
    name: &str,
    effective_args: &Value,
    mut output: Value,
) -> Value {
    if let Some(object) = output.as_object_mut() {
        object.insert(
            "project_instructions".into(),
            project_context::for_tool(ctx, name, effective_args),
        );
    }
    output
}

fn apply_default_cwd(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    let base = if ctx.default_cwd_path() == ctx.workspace.root() {
        ".".to_string()
    } else {
        ctx.default_cwd_display()
    };
    if base == "." {
        return args.clone();
    }

    let mut effective = args.clone();
    match name {
        "exec_command" if effective.get("workdir").is_none() && effective.get("cwd").is_none() => {
            effective["workdir"] = Value::String(".".into());
        }
        "list_dir" | "list_files" | "git_status" | "git_log" => {
            let path = effective.get("path").and_then(Value::as_str).unwrap_or(".");
            effective["path"] = Value::String(prefix_relative_path(&base, path));
        }
        "read_file" | "search_text" | "grep_text" | "grep" | "git_blame" | "view_image"
        | "image_info" => {
            if let Some(path) = effective.get("path").and_then(Value::as_str) {
                effective["path"] = Value::String(prefix_relative_path(&base, path));
            }
        }
        "compare_images" => {
            for key in ["before_path", "after_path"] {
                if let Some(path) = effective.get(key).and_then(Value::as_str) {
                    effective[key] = Value::String(prefix_relative_path(&base, path));
                }
            }
        }
        "git_diff" => {
            if let Some(path) = effective.get("path").and_then(Value::as_str) {
                effective["path"] = Value::String(prefix_relative_path(&base, path));
            }
            if let Some(paths) = effective.get("paths").and_then(Value::as_array).cloned() {
                effective["paths"] = Value::Array(
                    paths
                        .iter()
                        .map(|path| {
                            path.as_str()
                                .map(|value| Value::String(prefix_relative_path(&base, value)))
                                .unwrap_or_else(|| path.clone())
                        })
                        .collect(),
                );
            }
        }
        "apply_patch" | "patch_check" => {
            if let Some(patch) = effective.get("patch").and_then(Value::as_str) {
                effective["patch"] = Value::String(prefix_patch_paths(&base, patch));
            }
        }
        _ => {}
    }
    effective
}

fn prefix_relative_path(base: &str, path: &str) -> String {
    if path == "." || path.is_empty() {
        return base.to_string();
    }
    if Path::new(path).is_absolute() || path.starts_with("..") || path.starts_with('@') {
        return path.to_string();
    }
    format!("{base}/{}", path.trim_start_matches("./"))
}

fn prefix_patch_paths(base: &str, patch: &str) -> String {
    patch
        .lines()
        .map(|line| {
            for marker in [
                "--- a/",
                "+++ b/",
                "*** Add File: ",
                "*** Update File: ",
                "*** Delete File: ",
            ] {
                if let Some(path) = line.strip_prefix(marker) {
                    if Path::new(path).is_absolute()
                        || path.starts_with("..")
                        || path.starts_with('@')
                    {
                        return line.to_string();
                    }
                    return format!("{marker}{base}/{}", path.trim_start_matches("./"));
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn requires_write_baseline(name: &str, args: &Value) -> bool {
    match name {
        "exec_command" => true,
        "apply_patch" => !args
            .get("dry_run")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        _ => false,
    }
}

fn standalone_operation(name: &str) -> bool {
    matches!(name, "patch_check" | "apply_patch" | "exec_command")
}

fn should_log_operation(name: &str) -> bool {
    standalone_operation(name)
        || matches!(
            name,
            "git_status" | "git_diff" | "git_log" | "git_show" | "git_blame"
        )
}

fn operation_input(args: &Value) -> Value {
    json!({
        "arguments_present": !args.is_null(),
        "reason": args.get("reason")
    })
}

fn attach_harness_status(ctx: &ToolContext, mut output: Value, standalone: bool) -> Value {
    // Never turn a quick error or a baseline timeout into another full scan.
    let task = ctx.harness.current_task().ok().flatten();
    if let Some(object) = output.as_object_mut() {
        object.insert("harness".into(),json!({"task_id":task.as_ref().map(|t|&t.id),"baseline_matches":null,"writable":null,"status":"not_rescanned","reason":"Error recovery does not rescan the entire project. Inspect the original error or existing operation receipt.","next_actions":filter_exposed_actions(ctx,vec!["task_context".into(),"mcp_operation_status".into()])}));
    }
    if standalone {
        attach_standalone_metadata(&mut output,"Inspect the recorded error or command output; do not repeat an unchanged failing operation.");
    }

    output
}

fn attach_standalone_metadata(output: &mut Value, recovery_hint: &str) {
    if let Some(object) = output.as_object_mut() {
        object.insert("harness_mode".into(), Value::String("standalone".into()));
        object.insert("task_required".into(), Value::Bool(false));
        object.insert("next_actions".into(), json!([]));
        object.insert(
            "recovery_hint".into(),
            Value::String(recovery_hint.to_string()),
        );
    }
}

fn filter_exposed_actions(ctx: &ToolContext, actions: Vec<String>) -> Vec<String> {
    let exposed = crate::tools::registry::exposed_tool_names(&ctx.tool_profile);
    actions
        .into_iter()
        .filter(|action| exposed.contains(&action.as_str()))
        .collect()
}

pub fn server_info(ctx: &ToolContext) -> Result<Value, WorkspaceError> {
    let tools = crate::tools::registry::exposed_tool_names(&ctx.tool_profile);
    Ok(tool_ok(json!({
        "server": "coding-tools-mcp",
        "title": "Coding Tools MCP",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": crate::mcp::server::LEGACY_PROTOCOLS[0],
        "supported_protocol_versions": crate::mcp::server::SUPPORTED_PROTOCOLS,
        "protocol_version_basis": "default_legacy_version_not_request_negotiation",
        "workspace": ctx.workspace.root_display(),
        "linked_projects": ctx.workspace.linked_projects(),
        "permission_mode": ctx.permission_mode,
        "default_cwd": ctx.default_cwd_display(),
        "network_allowed": ctx.policy.network_allowed(),
        "tool_profile": ctx.tool_profile,
        "auth_enabled": ctx.auth.auth_enabled(),
        "auth_type": ctx.auth.auth_type,
        "endpoint_path": "/mcp",
        "upstream_compatibility": {
            "repository": "xyTom/coding-tools-mcp",
            "version": "0.3.0",
            "commit": "ed85e41999b0cf840d6e45f2bed11ac7f52eab3f",
            "canonical_command_handle": "command_id",
            "legacy_session_aliases": true
        },
        "output_retention": {
            "completed_command_seconds": session::COMPLETED_COMMAND_RETENTION_SECONDS,
            "buffer_bytes_per_stream": session::COMMAND_BUFFER_BYTES
        },
        "vision": {"screen_capture_enabled": ctx.policy.allow_screen_capture, "storage": "memory_only", "model_calls": false},
        "local_tool_engine": {"implementation": "embedded_rust", "codex_agent": false, "model_calls": false, "os_sandbox": false},
        "tools": tools,
        "tool_count": tools.len(),
        "tool_catalog": crate::tools::catalog::describe_current(ctx)
    })))
}

pub fn check_exec_environment(ctx: &ToolContext) -> Result<Value, WorkspaceError> {
    Ok(tool_ok(json!({
        "workspace": ctx.workspace.root_display(),
        "linked_projects": ctx.workspace.linked_projects(),
        "permission_mode": ctx.permission_mode,
        "network_allowed": ctx.policy.network_allowed(),
        "landlock_enabled": false,
        "filesystem_sandbox": {
            "available": false,
            "enforced": false,
            "default_scope": "workspace",
            "host_scope_available": false
        },
        "global_tmp_write": if ctx.permission_mode == "dangerous" { "allowed" } else { "tmp-prefix" },
        "workspace_exec_available": true,
        "workspace_exec_sandbox_enforced": false,
        "workspace_exec_boundary": "policy_only",
        "system_command_allowlist": ctx.policy.allowed_commands.iter().cloned().collect::<Vec<_>>(),
        "workspace_local_entries": {
            "enabled": ctx.policy.workspace_local_entries,
            "script_extensions": ctx.policy.workspace_script_extensions.iter().cloned().collect::<Vec<_>>(),
            "resolution": "workdir_first"
        },
        // Backward-compatible alias for older MCP clients.
        "allowed_commands": ctx.policy.allowed_commands.iter().cloned().collect::<Vec<_>>(),
        "warnings": ["Workspace 子进程当前允许执行，但尚未启用操作系统级文件系统沙箱"]
    })))
}

pub fn get_default_cwd(ctx: &ToolContext) -> Result<Value, WorkspaceError> {
    Ok(tool_ok(json!({
        "workspace": ctx.workspace.root_display(),
        "linked_projects": ctx.workspace.linked_projects(),
        "default_cwd": ctx.default_cwd_display(),
        "resolved_cwd": ctx.default_cwd_path().display().to_string()
    })))
}

pub fn set_default_cwd(ctx: &ToolContext, args: &Value) -> Result<Value, WorkspaceError> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let resolved = ctx.workspace.resolve_existing(path)?;
    if !resolved.path.is_dir() {
        return Err(WorkspaceError::not_a_directory(
            "Default cwd must be a directory",
        ));
    }
    ctx.set_default_cwd(resolved.path.clone());
    Ok(tool_ok(json!({
        "workspace": ctx.workspace.root_display(),
        "default_cwd": resolved.display,
        "resolved_cwd": resolved.path.display().to_string()
    })))
}

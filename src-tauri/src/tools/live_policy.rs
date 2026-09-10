//! Live authorization is independent of listener/OAuth/tunnel identity.
//! Updates are local-only, persisted before publication, and fenced against
//! short operations and command admission. No provider or agent is invoked.
use crate::error::{AppError, AppResult};
use crate::tools::workspace::WorkspaceError;
use crate::tools::{PolicySettings, ToolContext};
use std::sync::{Arc, RwLockReadGuard};

#[derive(Clone)]
pub struct LivePolicy {
    pub policy: PolicySettings,
    pub tool_profile: String,
    pub revision: u64,
}

fn unavailable() -> WorkspaceError {
    WorkspaceError::Tool {
        code: "LIVE_POLICY_UNAVAILABLE",
        message: "Live permission state cannot be read; execution is blocked.".into(),
        category: "permission",
        retryable: false,
    }
}
impl ToolContext {
    pub fn for_request(&self) -> Result<Self, WorkspaceError> {
        let live = self.live_policy.read().map_err(|_| unavailable())?;
        let mut request = self.clone();
        if let Some(value) = live.as_ref() {
            request.policy = value.policy.clone();
            request.tool_profile = value.tool_profile.clone();
            request.policy_revision = value.revision;
        }
        request.permission_mode = request.policy.canonical_permission_mode().into();
        Ok(request)
    }

    /// Hold only while committing a short operation or admitting a process.
    /// A stale snapshot cannot authorize a new side effect after an update.
    pub fn policy_execution_guard(
        &self,
    ) -> Result<RwLockReadGuard<'_, Option<LivePolicy>>, WorkspaceError> {
        let guard = self.live_policy.read().map_err(|_| unavailable())?;
        if guard.as_ref().map_or(0, |p| p.revision) != self.policy_revision {
            return Err(WorkspaceError::Tool {
                code: "PERMISSION_CHANGED_BEFORE_EXECUTION",
                message: "Permissions changed before this operation was submitted. Read server_info and reassess it under the current policy.".into(),
                category: "permission", retryable: false,
            });
        }
        Ok(guard)
    }

    pub fn current_policy_revision(&self) -> Result<u64, WorkspaceError> {
        self.live_policy
            .read()
            .map(|p| p.as_ref().map_or(0, |p| p.revision))
            .map_err(|_| unavailable())
    }
}

pub fn fence_entire_call(name: &str) -> bool {
    !name.starts_with("computer_")
        && !matches!(
            name,
            "codex_agent_control"
                | "sandbox_exec"
                | "codex_command_exec"
                | "exec_command"
                | "exec_health_check"
                | "write_stdin"
                | "capture_screenshot"
                | "capture_window"
                | "view_image"
                | "compare_images"
        )
}

/// Acquire all changed contexts first, then persist, then publish. The runtime
/// supervisor serializes local updates. Busy calls cause an explicit retry,
/// never a partial save, hidden restart or privilege fallback.
pub fn commit_updates(
    updates: Vec<(Arc<ToolContext>, PolicySettings, String)>,
    persist: impl FnOnce() -> AppResult<()>,
) -> AppResult<()> {
    let mut changes = Vec::new();
    for (context, policy, profile) in updates {
        let before = context
            .for_request()
            .map_err(|e| AppError::Message(e.message()))?;
        let profile = crate::tools::registry::normalize_tool_profile(&profile).to_string();
        if before.policy != policy || before.tool_profile != profile {
            let revision = before
                .policy_revision
                .checked_add(1)
                .ok_or_else(|| AppError::Message("Permission revision exhausted".into()))?;
            changes.push((
                context,
                before,
                LivePolicy {
                    policy,
                    tool_profile: profile,
                    revision,
                },
            ));
        }
    }
    let mut guards = Vec::new();
    for (context, _, _) in &changes {
        guards.push(context.live_policy.try_write().map_err(|_| AppError::Message(
            "LIVE_POLICY_BUSY: A short local operation is finishing. Retry Save; no restart or MCP relink is required and nothing was partially saved.".into()
        ))?);
    }
    persist()?;
    if !changes.is_empty() {
        crate::tools::native_sandbox::cancel_active();
    }
    for ((context, before, after), guard) in changes.iter().zip(guards.iter_mut()) {
        **guard = Some(after.clone());
        context.approvals.revoke_all();
        context.codex_bridge.cancel("workspace_policy_changed");
        // Existing process outcomes are not replayable. Preserve their output,
        // immediately deny further stdin and request termination of owned children.
        context.sessions.revoke_for_policy_change();
        if before.policy.allow_screen_capture
            && (!after.policy.allow_screen_capture
                || after.policy.canonical_permission_mode() == "read-only"
                || !crate::tools::registry::exposed_tool_names(&after.tool_profile)
                    .contains(&"computer_action"))
        {
            crate::tools::computer::stop_workspace(context.workspace.root());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn context() -> Arc<ToolContext> {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/live-policy-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        Arc::new(ToolContext::for_test(root.join("."), root.join("harness")).unwrap())
    }
    #[test]
    fn live_policy_same_context_updates_denies_and_preserves_shared_state() {
        let ctx = context();
        let other = context();
        let sessions = ctx.sessions.clone();
        let initial = ctx.for_request().unwrap();
        let mut policy = initial.policy.clone();
        policy.permission_mode = "read-only".into();
        commit_updates(vec![(ctx.clone(), policy, "core".into())], || Ok(())).unwrap();
        assert_eq!(ctx.for_request().unwrap().permission_mode, "read-only");
        assert_eq!(ctx.for_request().unwrap().policy_revision, 1);
        assert_eq!(
            other.for_request().unwrap().permission_mode,
            "workspace-write"
        );
        assert!(initial.policy_execution_guard().is_err());
        assert!(Arc::ptr_eq(&sessions, &ctx.for_request().unwrap().sessions));
        let patch =
            json!({"patch":"*** Begin Patch\n*** Add File: live.txt\n+live\n*** End Patch\n"});
        let denied = crate::tools::call_tool(&ctx, "apply_patch", &patch);
        assert_eq!(denied["ok"], false, "{denied}");
        assert!(!ctx.workspace.root().join("live.txt").exists());
        let mut writable = ctx.for_request().unwrap().policy.clone();
        writable.permission_mode = "workspace-write".into();
        commit_updates(vec![(ctx.clone(), writable, "core".into())], || Ok(())).unwrap();
        let applied = crate::tools::call_tool(&ctx, "apply_patch", &patch);
        assert_eq!(applied["ok"], true, "{applied}");
        assert_eq!(ctx.for_request().unwrap().policy_revision, 2);
        let unchanged = ctx.for_request().unwrap();
        commit_updates(
            vec![(ctx.clone(), unchanged.policy, unchanged.tool_profile)],
            || Ok(()),
        )
        .unwrap();
        assert_eq!(ctx.for_request().unwrap().policy_revision, 2);
        assert_eq!(
            std::fs::read_to_string(ctx.workspace.root().join("live.txt"))
                .unwrap()
                .trim(),
            "live"
        );
    }
    #[test]
    fn live_policy_busy_or_failed_save_cannot_publish_partial_updates() {
        let ctx = context();
        let initial = ctx.for_request().unwrap();
        let mut policy = initial.policy.clone();
        policy.permission_mode = "read-only".into();
        let failed = commit_updates(vec![(ctx.clone(), policy.clone(), "core".into())], || {
            Err(AppError::Message("storage unavailable".into()))
        });
        assert!(failed.is_err());
        assert_eq!(ctx.current_policy_revision().unwrap(), 0);
        let guard = initial.policy_execution_guard().unwrap();
        let persisted = std::sync::atomic::AtomicBool::new(false);
        assert!(
            commit_updates(vec![(ctx.clone(), policy, "core".into())], || {
                persisted.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .is_err()
        );
        assert!(!persisted.load(std::sync::atomic::Ordering::SeqCst));
        drop(guard);
        assert_eq!(ctx.current_policy_revision().unwrap(), 0);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_policy_change_revokes_approval_grants_and_owned_command_input() {
        use crate::tools::session::ExecSession;
        let ctx = context();
        let mut args =
            json!({"patch":"*** Begin Patch\n*** Add File: grant.txt\n+ok\n*** End Patch\n"});
        let failure = ctx
            .approvals
            .preflight("apply_patch", &mut args, "ask", "workspace-write")
            .unwrap_err()
            .into_workspace_error();
        let request_id = match failure {
            WorkspaceError::ToolDetails { details, .. } => {
                details["request_id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected approval request"),
        };
        let granted = ctx.approvals.grant(&request_id, "session", true).unwrap();
        args["approval_token"] = granted["approval_token"].clone();
        #[cfg(windows)]
        let mut command = {
            let mut c = tokio::process::Command::new("cmd.exe");
            c.args(["/d", "/c", "set /p live_policy_fixture="]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", "read live_policy_fixture"]);
            c
        };
        let child = command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let session = ctx.sessions.insert(ExecSession::new_with_mode(child, true));
        let mut policy = ctx.for_request().unwrap().policy;
        policy.approval_mode = "ask".into();
        commit_updates(vec![(ctx.clone(), policy, "core".into())], || Ok(())).unwrap();
        assert!(
            ctx.approvals
                .preflight("apply_patch", &mut args, "ask", "workspace-write")
                .is_err(),
            "Old grant must not survive a policy revision"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !session.has_exited() && std::time::Instant::now() < deadline {
            session.refresh_status().await;
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            session.has_exited(),
            "Owned command must receive termination"
        );
        assert!(
            ctx.sessions.get(&session.session_id).is_ok(),
            "Output retention survives revocation"
        );
        let id = session.session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::tools::session::write_stdin_current(
                &ctx.for_request().unwrap(),
                &json!({"command_id":id,"chars":"not permitted"}),
            )
        })
        .await
        .unwrap();
        assert!(result.is_err(), "Revoked command cannot accept input");
    }
}

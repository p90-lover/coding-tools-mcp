from __future__ import annotations

import re
import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "frp-restore-fail-closed"
    / str(time.time_ns())
)


def checked_file(relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"unsafe repository path: {relative}")
    candidate = ROOT / path
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {relative}")
    resolved = candidate.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise RuntimeError(f"not a regular file: {relative}")
    return resolved


def backup(relative: str) -> None:
    source = checked_file(relative)
    target = BACKUP_ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def replace_regex(relative: str, pattern: str, replacement: str, label: str) -> None:
    target = checked_file(relative)
    text = target.read_text(encoding="utf-8")
    if replacement in text:
        print(f"already applied: {label}")
        return
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected one reviewed match, found {count}")
    backup(relative)
    target.write_text(updated, encoding="utf-8")
    print(f"applied: {label}")


RESTORE_REPLACEMENT = r'''    pub fn restore_active_frp_routes(
        &mut self,
        profiles: &[WorkspaceProfile],
        active_runtime_keys: &HashSet<(String, TunnelServiceKind)>,
        settings: &AppSettings,
    ) -> HashSet<String> {
        let desired_routes: Vec<((String, TunnelServiceKind), WorkspaceProfile)> = profiles
            .iter()
            .flat_map(|profile| {
                [TunnelServiceKind::Mcp, TunnelServiceKind::Actions]
                    .into_iter()
                    .filter_map(move |kind| {
                        let key = (profile.id.clone(), kind);
                        if validate_public_tunnel_auth(profile, kind).is_err()
                            || tunnel_type_for(profile, kind) != "frp"
                            || !active_runtime_keys.contains(&key)
                        {
                            return None;
                        }
                        Some((key, profile.clone()))
                    })
            })
            .collect();
        let desired_keys: HashSet<_> = desired_routes
            .iter()
            .map(|(key, _)| key.clone())
            .collect();
        let stale_keys: Vec<_> = self
            .frp_routes
            .keys()
            .filter(|key| !desired_keys.contains(*key))
            .cloned()
            .collect();
        let mut changed_workspaces = HashSet::new();

        for key in stale_keys {
            self.frp_routes.remove(&key);
            self.sessions.remove(&key);
            changed_workspaces.insert(key.0);
        }

        for (key, profile) in desired_routes {
            let workspace_id = key.0.clone();
            let kind = key.1;
            match self.frp_routes.get_mut(&key) {
                Some(route) => {
                    route.profile = profile;
                    route.kind = kind;
                }
                None => {
                    self.frp_routes
                        .insert(key, FrpRoute { profile, kind });
                }
            }
            changed_workspaces.insert(workspace_id);
        }

        changed_workspaces.extend(self.frpc.keys().cloned());
        for workspace_id in &changed_workspaces {
            let pid = self.frpc.get(workspace_id).and_then(|process| process.pid);
            self.sync_frp_sessions_for_workspace(settings, workspace_id, pid);
        }
        changed_workspaces
    }

    pub async fn reconcile_restored_frp_routes(
        &mut self,
        workspace_ids: &HashSet<String>,
        settings: &AppSettings,
    ) -> AppResult<()> {
        for workspace_id in workspace_ids {
            if let Err(error) = self
                .ensure_frpc_matches_routes(workspace_id, settings)
                .await
            {
                let stop_result = self
                    .stop_workspace_frpc_fail_closed(workspace_id, settings)
                    .await;
                return match stop_result {
                    Ok(()) => Err(AppError::Message(format!(
                        "failed to reconcile restored FRP routes for {workspace_id}; stopped the workspace FRP process fail-closed: {error}"
                    ))),
                    Err(stop_error) => Err(AppError::Message(format!(
                        "failed to reconcile restored FRP routes for {workspace_id}: {error}; fail-closed shutdown also failed: {stop_error}"
                    ))),
                };
            }
        }
        Ok(())
    }

    async fn stop_workspace_frpc_fail_closed(
        &mut self,
        workspace_id: &str,
        settings: &AppSettings,
    ) -> AppResult<()> {
        let mut errors = Vec::new();
        if let Some(process) = self.frpc.remove(workspace_id) {
            let pid = process.pid;
            if let Err(error) = cloudflare::stop_child(process.child, pid).await {
                errors.push(error.to_string());
                if let Some(pid) = pid {
                    if let Err(error) = platform().terminate_process_tree(pid) {
                        errors.push(error.to_string());
                    }
                }
            }
            frp::clear_managed_frpc_pid(workspace_id);
        }
        if let Err(error) = frp::stop_recorded_frpc_instance(workspace_id).await {
            errors.push(error.to_string());
        }
        self.sync_frp_sessions_for_workspace(settings, workspace_id, None);
        if errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(errors.join("; ")))
        }
    }
'''

replace_regex(
    "src-tauri/src/tunnel/supervisor.rs",
    r"    pub fn restore_active_frp_routes\(.*?\n    fn validate_frp_route_compatibility\(",
    RESTORE_REPLACEMENT + "\n    fn validate_frp_route_compatibility(",
    "remove stale unauthenticated FRP routes and reconcile live frpc",
)

replace_regex(
    "src-tauri/src/tunnel/access.rs",
    r"    guard\.restore_active_frp_routes\(&profiles, &active_runtime_keys, &settings\);\n    Ok\(\(\)\)",
    '''    let changed_workspaces =
        guard.restore_active_frp_routes(&profiles, &active_runtime_keys, &settings);
    guard
        .reconcile_restored_frp_routes(&changed_workspaces, &settings)
        .await''',
    "await fail-closed reconciliation after route restore",
)

supervisor = checked_file("src-tauri/src/tunnel/supervisor.rs").read_text(encoding="utf-8")
access = checked_file("src-tauri/src/tunnel/access.rs").read_text(encoding="utf-8")
required = (
    "let stale_keys: Vec<_>",
    "let kind = key.1;",
    "pub async fn reconcile_restored_frp_routes(",
    "stop_workspace_frpc_fail_closed",
    "failed to reconcile restored FRP routes",
)
for marker in required:
    if marker not in supervisor:
        raise RuntimeError(f"missing FRP restore hardening marker: {marker}")
if ".reconcile_restored_frp_routes(&changed_workspaces, &settings)" not in access:
    raise RuntimeError("access layer does not await restored-route reconciliation")
print("FRP restore lifecycle hardening applied with recoverable backups")

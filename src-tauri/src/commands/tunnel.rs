use tauri::State;

use crate::app_state::AppState;
use crate::error::{AppError, AppResult};
use crate::platform::platform;
use crate::tunnel::{
    frp_snippet, supervisor, sync_managed_runtime_routes, TunnelServiceKind, TunnelStatus,
};
use crate::workspace::resources::{validate_service_start, WorkspaceService};

fn profile_by_id(state: &AppState, id: &str) -> AppResult<crate::workspace::WorkspaceProfile> {
    state.with_workspaces(|store| {
        store
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Message(format!("workspace not found: {id}")))
    })
}

fn validate_tunnel_start_resources(
    state: &AppState,
    id: &str,
    kind: TunnelServiceKind,
) -> AppResult<()> {
    let service = match kind {
        TunnelServiceKind::Mcp => WorkspaceService::Mcp,
        TunnelServiceKind::Actions => WorkspaceService::Actions,
    };
    state.with_workspaces(|store| validate_service_start(store.list(), id, service))
}

fn persist_public_url(
    state: &AppState,
    id: &str,
    kind: TunnelServiceKind,
    public_url: &str,
) -> AppResult<()> {
    if public_url.is_empty() {
        return Ok(());
    }
    state.with_workspaces(|store| {
        let Some(mut profile) = store.get(id).cloned() else {
            return Ok(());
        };
        match kind {
            TunnelServiceKind::Mcp => profile.tunnel.public_url = public_url.to_string(),
            TunnelServiceKind::Actions => profile.actions.public_url = public_url.to_string(),
        }
        store.update(profile)?;
        Ok(())
    })
}

async fn sync_tunnel_routes_from_runtime(state: &AppState) -> AppResult<()> {
    let active_keys = state.with_runtime(|runtime| Ok(runtime.active_tunnel_service_keys()))?;
    sync_managed_runtime_routes(active_keys).await
}

fn restore_tunnel_config(
    state: &AppState,
    id: &str,
    kind: TunnelServiceKind,
    failed: &crate::workspace::WorkspaceProfile,
    restored: &crate::workspace::WorkspaceProfile,
) -> AppResult<()> {
    state.with_workspaces(|store| {
        let Some(mut current) = store.get(id).cloned() else {
            return Ok(());
        };
        let unchanged_since_failure = match kind {
            TunnelServiceKind::Mcp => mcp_tunnel_matches(&current, failed),
            TunnelServiceKind::Actions => actions_tunnel_matches(&current, failed),
        };
        if !unchanged_since_failure {
            return Err(AppError::Message(
                "检测到更新的隧道配置，已拒绝用旧请求覆盖。".into(),
            ));
        }
        match kind {
            TunnelServiceKind::Mcp => current.tunnel = restored.tunnel.clone(),
            TunnelServiceKind::Actions => {
                current.actions.public_url = restored.actions.public_url.clone();
                current.actions.tunnel_type = restored.actions.tunnel_type.clone();
                current.actions.frp_server = restored.actions.frp_server.clone();
                current.actions.frp_subdomain = restored.actions.frp_subdomain.clone();
                current.actions.frp_profile_id = restored.actions.frp_profile_id.clone();
                current.actions.frp_server_port = restored.actions.frp_server_port;
                current.actions.cloudflare_mode = restored.actions.cloudflare_mode.clone();
                current.actions.cloudflare_token = restored.actions.cloudflare_token.clone();
                current.actions.use_proxy = restored.actions.use_proxy;
            }
        }
        store.update(current)
    })
}

fn mcp_tunnel_matches(
    left: &crate::workspace::WorkspaceProfile,
    right: &crate::workspace::WorkspaceProfile,
) -> bool {
    left.tunnel.tunnel_type == right.tunnel.tunnel_type
        && left.tunnel.public_url == right.tunnel.public_url
        && left.tunnel.frp_server == right.tunnel.frp_server
        && left.tunnel.frp_subdomain == right.tunnel.frp_subdomain
        && left.tunnel.frp_profile_id == right.tunnel.frp_profile_id
        && left.tunnel.frp_server_port == right.tunnel.frp_server_port
        && left.tunnel.cloudflare_mode == right.tunnel.cloudflare_mode
        && left.tunnel.use_proxy == right.tunnel.use_proxy
}

fn actions_tunnel_matches(
    left: &crate::workspace::WorkspaceProfile,
    right: &crate::workspace::WorkspaceProfile,
) -> bool {
    left.actions.public_url == right.actions.public_url
        && left.actions.tunnel_type == right.actions.tunnel_type
        && left.actions.frp_server == right.actions.frp_server
        && left.actions.frp_subdomain == right.actions.frp_subdomain
        && left.actions.frp_profile_id == right.actions.frp_profile_id
        && left.actions.frp_server_port == right.actions.frp_server_port
        && left.actions.cloudflare_mode == right.actions.cloudflare_mode
        && left.actions.cloudflare_token == right.actions.cloudflare_token
        && left.actions.use_proxy == right.actions.use_proxy
}

fn tunnel_type_for(profile: &crate::workspace::WorkspaceProfile, kind: TunnelServiceKind) -> &str {
    match kind {
        TunnelServiceKind::Mcp => profile.tunnel.tunnel_type.as_str(),
        TunnelServiceKind::Actions => profile.actions.tunnel_type.as_str(),
    }
}

#[tauri::command]
pub fn get_frp_snippet(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<String> {
    let profile = profile_by_id(&state, &id)?;
    let kind = TunnelServiceKind::parse(&service)?;
    Ok(frp_snippet(&profile, kind))
}

#[tauri::command]
pub async fn restart_tunnel(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<TunnelStatus> {
    let profile = profile_by_id(&state, &id)?;
    let kind = TunnelServiceKind::parse(&service)?;
    validate_tunnel_start_resources(&state, &id, kind)?;
    sync_tunnel_routes_from_runtime(&state).await?;
    let settings = state.with_settings(|store| Ok(store.settings()))?;

    let result = {
        let mut guard = supervisor().lock().await;
        let was_running = guard.status(&profile, kind, &settings).state == "running";
        let tunnel_type = tunnel_type_for(&profile, kind);
        if was_running && tunnel_type == "frp" {
            // FRP 必须走 supervisor 的原子替换流程。它会暂存当前工作区旧 route，
            // 新 subdomain 启动成功后才释放旧线路；失败时恢复旧 route。
            guard
                .start(&profile, kind, &settings)
                .await
                .map_err(|error| (error, guard.route_profile(&id, kind)))
        } else if was_running {
            match guard.stop(&profile, kind, &settings).await {
                Ok(()) => guard
                    .start(&profile, kind, &settings)
                    .await
                    .map_err(|error| (error, None)),
                Err(error) => Err((error, None)),
            }
        } else {
            Ok(guard.status(&profile, kind, &settings))
        }
    };

    let status = match result {
        Ok(status) => status,
        Err((error, restored)) => {
            if let Some(restored) = restored {
                if let Err(rollback_error) =
                    restore_tunnel_config(&state, &id, kind, &profile, &restored)
                {
                    return Err(AppError::Message(format!(
                        "FRP 线路已恢复，但配置回滚失败：{error}; rollback: {rollback_error}"
                    )));
                }
            }
            return Err(error);
        }
    };

    persist_public_url(&state, &id, kind, &status.public_url)?;
    Ok(status)
}

#[tauri::command]
pub async fn start_tunnel(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<TunnelStatus> {
    let profile = profile_by_id(&state, &id)?;
    let kind = TunnelServiceKind::parse(&service)?;
    validate_tunnel_start_resources(&state, &id, kind)?;
    sync_tunnel_routes_from_runtime(&state).await?;
    let settings = state.with_settings(|store| Ok(store.settings()))?;

    let status = {
        let mut guard = supervisor().lock().await;
        guard.start(&profile, kind, &settings).await?
    };

    persist_public_url(&state, &id, kind, &status.public_url)?;
    Ok(status)
}

#[tauri::command]
pub async fn stop_tunnel(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<TunnelStatus> {
    let profile = profile_by_id(&state, &id)?;
    let kind = TunnelServiceKind::parse(&service)?;
    let settings = state.with_settings(|store| Ok(store.settings()))?;
    let mut guard = supervisor().lock().await;
    guard.stop(&profile, kind, &settings).await?;
    Ok(guard.status(&profile, kind, &settings))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelTestResult {
    pub success: bool,
    pub public_url: String,
    pub kept_running: bool,
    pub message: String,
}

fn local_service_listening(
    profile: &crate::workspace::WorkspaceProfile,
    kind: TunnelServiceKind,
) -> AppResult<bool> {
    let port = match kind {
        TunnelServiceKind::Mcp => profile.runtime.local_port,
        TunnelServiceKind::Actions => profile.actions.local_port,
    };
    Ok(platform().find_pid_listening_on_port(port)?.is_some())
}

/// Inspect the existing endpoint; never restart a healthy tunnel just to test it.
#[tauri::command]
pub async fn test_tunnel(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<TunnelTestResult> {
    let profile = profile_by_id(&state, &id)?;
    let kind = TunnelServiceKind::parse(&service)?;
    validate_tunnel_start_resources(&state, &id, kind)?;
    let settings = state.with_settings(|store| Ok(store.settings()))?;
    if !local_service_listening(&profile, kind)? {
        return Ok(TunnelTestResult { success: false, public_url: String::new(), kept_running: false,
            message: "Start the local service before testing. No tunnel was started or restarted. / 請先啟動本機服務；隧道未被變更。".into() });
    }
    let status = {
        let mut guard = supervisor().lock().await;
        let current = guard.status(&profile, kind, &settings);
        if current.state == "running" {
            current
        } else {
            guard.start(&profile, kind, &settings).await?
        }
    };
    // Commit the new trusted origin before reading OAuth discovery from that origin.
    persist_public_url(&state, &id, kind, &status.public_url)?;
    let oauth = match kind {
        TunnelServiceKind::Mcp => profile.auth.auth_type == "oauth",
        TunnelServiceKind::Actions => profile.actions.auth_type == "oauth",
    };
    let check =
        crate::tunnel::connection::probe_public_service(&status.public_url, kind, oauth, &settings)
            .await;
    Ok(TunnelTestResult { success: check.is_ok(), public_url: status.public_url, kept_running: status.state == "running",
        message: match check {
            Ok(()) => "Public discovery and configured OAuth metadata verified. Existing tunnel retained; no model or credentials sent. / 公開端點及 OAuth 探索已驗證；原連線保持不變。".into(),
            Err(e) => format!("{e}; tunnel left unchanged / 隧道保持不變"),
        } })
}

#[tauri::command]
pub async fn get_tunnel_connection_status(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<serde_json::Value> {
    let profile = profile_by_id(&state, &id)?;
    let kind = TunnelServiceKind::parse(&service)?;
    let settings = state.with_settings(|store| Ok(store.settings()))?;
    let guard = supervisor().lock().await;
    Ok(
        serde_json::json!({"tunnel":guard.status(&profile, kind, &settings),"recovery":guard.cloudflare_recovery_status(&id, kind)}),
    )
}

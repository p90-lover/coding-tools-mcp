from __future__ import annotations

import shutil
import time
from pathlib import Path


ROOT = Path.cwd().resolve()
TARGET_RELATIVE = Path("src-tauri/src/tunnel/supervisor.rs")
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "public-tunnel-auth-hardening"
    / str(time.time_ns())
)

AUTH_HELPER = r'''fn validate_public_tunnel_auth(
    profile: &WorkspaceProfile,
    kind: TunnelServiceKind,
) -> AppResult<()> {
    let (auth_type, oauth_client_id, required_modes) = match kind {
        TunnelServiceKind::Mcp => (
            profile.auth.auth_type.as_str(),
            profile.auth.oauth_client_id.as_str(),
            "oauth 或 bearer",
        ),
        TunnelServiceKind::Actions => (
            profile.actions.auth_type.as_str(),
            profile.actions.oauth_client_id.as_str(),
            "api_key 或 oauth",
        ),
    };
    let supported = match kind {
        TunnelServiceKind::Mcp => matches!(auth_type, "oauth" | "bearer"),
        TunnelServiceKind::Actions => matches!(auth_type, "api_key" | "oauth"),
    };
    if !supported {
        return Err(AppError::Message(format!(
            "拒绝启动公网 {} 隧道：认证模式必须为 {}。",
            tunnel_service_label(kind),
            required_modes
        )));
    }
    if auth_type == "oauth" && oauth_client_id.trim().is_empty() {
        return Err(AppError::Message(format!(
            "拒绝启动公网 {} 隧道：OAuth Client ID 不能为空。",
            tunnel_service_label(kind)
        )));
    }
    Ok(())
}

'''


def checked_target() -> Path:
    if TARGET_RELATIVE.is_absolute() or ".." in TARGET_RELATIVE.parts:
        raise RuntimeError("unsafe supervisor path")
    candidate = ROOT / TARGET_RELATIVE
    if candidate.is_symlink():
        raise RuntimeError("refusing to modify a symlinked supervisor")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError("supervisor is missing or escapes the repository") from error
    if not resolved.is_file():
        raise RuntimeError("supervisor is not a regular file")
    return resolved


def replace_once(text: str, before: str, after: str, label: str) -> str:
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    return text.replace(before, after, 1)


def main() -> None:
    target = checked_target()
    text = target.read_text(encoding="utf-8")
    if (
        "fn validate_public_tunnel_auth(" in text
        and "validate_public_tunnel_auth(profile, kind)?;" in text
        and "failed to stop an existing unauthenticated tunnel" in text
    ):
        print("public tunnel auth hardening is already applied")
        return

    helper_marker = "fn validate_tunnel_requirements(\n"
    if text.count(helper_marker) != 1:
        raise RuntimeError("public tunnel auth helper insertion point is ambiguous")
    text = text.replace(helper_marker, AUTH_HELPER + helper_marker, 1)

    validate_before = '''fn validate_tunnel_requirements(
    profile: &WorkspaceProfile,
    kind: TunnelServiceKind,
    settings: &AppSettings,
) -> AppResult<()> {
    let tunnel_type = tunnel_type_for(profile, kind);
'''
    validate_after = '''fn validate_tunnel_requirements(
    profile: &WorkspaceProfile,
    kind: TunnelServiceKind,
    settings: &AppSettings,
) -> AppResult<()> {
    validate_public_tunnel_auth(profile, kind)?;
    let tunnel_type = tunnel_type_for(profile, kind);
'''
    text = replace_once(
        text,
        validate_before,
        validate_after,
        "enforce authentication in tunnel preflight",
    )

    start_before = '''    ) -> AppResult<TunnelStatus> {
        let key = (profile.id.clone(), kind);
        let tunnel_type = tunnel_type_for(profile, kind);
        if self.session_is_running(&key) && tunnel_type != "frp" {
'''
    start_after = '''    ) -> AppResult<TunnelStatus> {
        let key = (profile.id.clone(), kind);
        if let Err(auth_error) = validate_public_tunnel_auth(profile, kind) {
            if self.frp_routes.contains_key(&key) || self.sessions.contains_key(&key) {
                if let Err(stop_error) = self.stop_internal(&profile.id, kind, settings).await {
                    return Err(AppError::Message(format!(
                        "{auth_error}; failed to stop an existing unauthenticated tunnel: {stop_error}"
                    )));
                }
            }
            return Err(auth_error);
        }
        let tunnel_type = tunnel_type_for(profile, kind);
        if self.session_is_running(&key) && tunnel_type != "frp" {
'''
    text = replace_once(
        text,
        start_before,
        start_after,
        "fail closed before reusing a running public tunnel",
    )

    restore_before = '''                let key = (profile.id.clone(), kind);
                if tunnel_type_for(profile, kind) != "frp" || !active_runtime_keys.contains(&key) {
                    continue;
                }
'''
    restore_after = '''                let key = (profile.id.clone(), kind);
                if validate_public_tunnel_auth(profile, kind).is_err() {
                    continue;
                }
                if tunnel_type_for(profile, kind) != "frp" || !active_runtime_keys.contains(&key) {
                    continue;
                }
'''
    text = replace_once(
        text,
        restore_before,
        restore_after,
        "skip restoring unauthenticated managed routes",
    )

    required = (
        "fn validate_public_tunnel_auth(",
        'matches!(auth_type, "oauth" | "bearer")',
        'matches!(auth_type, "api_key" | "oauth")',
        "validate_public_tunnel_auth(profile, kind)?;",
        "failed to stop an existing unauthenticated tunnel",
        "if validate_public_tunnel_auth(profile, kind).is_err()",
    )
    for marker in required:
        if marker not in text:
            raise RuntimeError(f"public tunnel auth hardening is missing: {marker}")

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text, encoding="utf-8")
    print("applied public tunnel auth hardening with recoverable backup")


if __name__ == "__main__":
    main()

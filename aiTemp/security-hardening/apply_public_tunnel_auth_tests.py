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
    / "public-tunnel-auth-tests"
    / str(time.time_ns())
)

TESTS = r'''

    #[test]
    fn public_tunnel_auth_requires_supported_mcp_modes_and_skips_restore() {
        let settings = AppSettings::default();
        let mut profile = frp_profile("mcp-auth", "mcp-auth");

        for denied in ["noauth", "", "OAuth", "unexpected"] {
            profile.auth.auth_type = denied.into();
            assert!(validate_public_tunnel_auth(&profile, TunnelServiceKind::Mcp).is_err());
        }

        profile.auth.auth_type = "oauth".into();
        profile.auth.oauth_client_id.clear();
        assert!(validate_public_tunnel_auth(&profile, TunnelServiceKind::Mcp).is_err());

        profile.auth.oauth_client_id = "chatgpt-client-test".into();
        for allowed in ["oauth", "bearer"] {
            profile.auth.auth_type = allowed.into();
            assert!(validate_public_tunnel_auth(&profile, TunnelServiceKind::Mcp).is_ok());
        }

        profile.auth.auth_type = "noauth".into();
        let active = HashSet::from([(profile.id.clone(), TunnelServiceKind::Mcp)]);
        let mut supervisor = TunnelSupervisor::new();
        supervisor.restore_active_frp_routes(&[profile], &active, &settings);
        assert!(supervisor.frp_routes.is_empty());
        assert!(supervisor.sessions.is_empty());
    }

    #[test]
    fn public_tunnel_auth_requires_supported_actions_modes_and_skips_restore() {
        let settings = AppSettings::default();
        let mut profile = frp_profile("actions-auth", "mcp-auth");
        profile.actions.tunnel_type = "frp".into();
        profile.actions.frp_server = "frp.example.com".into();
        profile.actions.frp_server_port = 7000;
        profile.actions.frp_subdomain = "actions-auth".into();

        for denied in ["none", "", "OAuth", "unexpected"] {
            profile.actions.auth_type = denied.into();
            assert!(validate_public_tunnel_auth(&profile, TunnelServiceKind::Actions).is_err());
        }

        profile.actions.auth_type = "oauth".into();
        profile.actions.oauth_client_id.clear();
        assert!(validate_public_tunnel_auth(&profile, TunnelServiceKind::Actions).is_err());

        profile.actions.oauth_client_id = "chatgpt-actions-test".into();
        for allowed in ["api_key", "oauth"] {
            profile.actions.auth_type = allowed.into();
            assert!(validate_public_tunnel_auth(&profile, TunnelServiceKind::Actions).is_ok());
        }

        profile.actions.auth_type = "none".into();
        let active = HashSet::from([(profile.id.clone(), TunnelServiceKind::Actions)]);
        let mut supervisor = TunnelSupervisor::new();
        supervisor.restore_active_frp_routes(&[profile], &active, &settings);
        assert!(supervisor.frp_routes.is_empty());
        assert!(supervisor.sessions.is_empty());
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


def main() -> None:
    target = checked_target()
    text = target.read_text(encoding="utf-8")
    marker = "fn public_tunnel_auth_requires_supported_mcp_modes_and_skips_restore()"
    if marker in text:
        print("public tunnel auth regression tests are already applied")
        return
    if not text.rstrip().endswith("}"):
        raise RuntimeError("supervisor test module closing brace was not found")

    insertion = text.rfind("\n}")
    if insertion < 0:
        raise RuntimeError("supervisor test module insertion point was not found")
    updated = text[:insertion] + TESTS + text[insertion:]

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(updated, encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    required = (
        marker,
        "fn public_tunnel_auth_requires_supported_actions_modes_and_skips_restore()",
        "validate_public_tunnel_auth(&profile, TunnelServiceKind::Mcp)",
        "validate_public_tunnel_auth(&profile, TunnelServiceKind::Actions)",
    )
    for value in required:
        if value not in verified:
            raise RuntimeError(f"public tunnel auth test insertion is missing: {value}")
    print("applied public tunnel auth regression tests with recoverable backup")


if __name__ == "__main__":
    main()

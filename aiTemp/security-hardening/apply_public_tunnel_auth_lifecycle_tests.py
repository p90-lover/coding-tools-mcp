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
    / "public-tunnel-auth-lifecycle-tests"
    / str(time.time_ns())
)

TESTS = r'''

    #[test]
    fn public_tunnel_auth_restore_removes_stale_insecure_route_and_requests_reconcile() {
        let settings = AppSettings::default();
        let mut profile = frp_profile("stale-auth", "stale-auth");
        profile.auth.auth_type = "noauth".into();
        let key = (profile.id.clone(), TunnelServiceKind::Mcp);
        let active = HashSet::from([key.clone()]);
        let mut supervisor = TunnelSupervisor::new();
        supervisor.frp_routes.insert(
            key.clone(),
            FrpRoute {
                profile: profile.clone(),
                kind: TunnelServiceKind::Mcp,
            },
        );
        supervisor.sessions.insert(
            key.clone(),
            TunnelSession {
                public_url: "https://stale-auth.frp.example.com".into(),
                pid: None,
                child: None,
            },
        );

        let reconcile = supervisor.restore_active_frp_routes(&[profile.clone()], &active, &settings);

        assert!(reconcile.contains(&profile.id));
        assert!(!supervisor.frp_routes.contains_key(&key));
        assert!(!supervisor.sessions.contains_key(&key));
    }

    #[tokio::test]
    async fn public_tunnel_auth_profile_update_stops_insecure_managed_sessions() {
        let settings = AppSettings::default();
        let mut profile = frp_profile("auth-transition", "auth-transition");
        profile.auth.auth_type = "oauth".into();
        profile.auth.oauth_client_id = "chatgpt-client-test".into();
        profile.actions.tunnel_type = "cloudflare".into();
        profile.actions.auth_type = "api_key".into();
        let mcp_key = (profile.id.clone(), TunnelServiceKind::Mcp);
        let actions_key = (profile.id.clone(), TunnelServiceKind::Actions);
        let mut supervisor = TunnelSupervisor::new();
        for key in [mcp_key.clone(), actions_key.clone()] {
            supervisor.sessions.insert(
                key,
                TunnelSession {
                    public_url: "https://managed.example.com".into(),
                    pid: None,
                    child: None,
                },
            );
        }

        supervisor
            .enforce_profile_public_tunnel_auth(&profile, &settings)
            .await
            .expect("valid auth should preserve managed sessions");
        assert!(supervisor.sessions.contains_key(&mcp_key));
        assert!(supervisor.sessions.contains_key(&actions_key));

        profile.auth.auth_type = "noauth".into();
        profile.actions.auth_type = "none".into();
        supervisor
            .enforce_profile_public_tunnel_auth(&profile, &settings)
            .await
            .expect("insecure managed sessions should stop cleanly");
        assert!(!supervisor.sessions.contains_key(&mcp_key));
        assert!(!supervisor.sessions.contains_key(&actions_key));
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
    marker = "fn public_tunnel_auth_restore_removes_stale_insecure_route_and_requests_reconcile()"
    if marker in text:
        print("public tunnel auth lifecycle tests are already applied")
        return
    if not text.rstrip().endswith("}"):
        raise RuntimeError("supervisor test module closing brace was not found")

    insertion = text.rfind("\n}")
    if insertion < 0:
        raise RuntimeError("supervisor lifecycle test insertion point was not found")
    updated = text[:insertion] + TESTS + text[insertion:]

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(updated, encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    required = (
        marker,
        "fn public_tunnel_auth_profile_update_stops_insecure_managed_sessions()",
        "let reconcile = supervisor.restore_active_frp_routes",
        ".enforce_profile_public_tunnel_auth(&profile, &settings)",
    )
    for value in required:
        if value not in verified:
            raise RuntimeError(f"public tunnel auth lifecycle test insertion is missing: {value}")
    print("applied public tunnel auth lifecycle tests with recoverable backup")


if __name__ == "__main__":
    main()

from __future__ import annotations

import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
BACKUP = ROOT / "aiTemp" / "Trash" / "defense-in-depth-tests" / str(time.time_ns())


def append_module(relative: str, block: str) -> None:
    path = ROOT / relative
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"not a regular source file: {relative}")
    path.resolve(strict=True).relative_to(ROOT)
    source = path.read_text(encoding="utf-8")
    if "mod release_hardening_checks {" in source:
        print(f"security regressions already present: {relative}")
        return
    dest = BACKUP / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
    path.write_text(source.rstrip() + "\n\n" + block.strip() + "\n", encoding="utf-8")


append_module("src-tauri/src/tools/policy.rs", r'''
#[cfg(test)]
mod release_hardening_checks {
    use super::*;

    #[test]
    fn release_hardening_unknown_sandbox_is_read_only() {
        for value in ["", "workspace-writ", "invalid", "full-access"] {
            assert_eq!(SandboxMode::parse(value), SandboxMode::ReadOnly, "{value:?}");
        }
    }
}
''')

append_module("src-tauri/src/tools/approval.rs", r'''
#[cfg(test)]
mod release_hardening_checks {
    use super::*;

    #[test]
    fn release_hardening_unknown_approval_requires_asking() {
        for value in ["", "invalid", "on-reques"] {
            assert_eq!(ApprovalMode::parse(value).as_str(), "ask", "{value:?}");
        }
    }
}
''')

append_module("src-tauri/src/auth/oauth_flow.rs", r'''
#[cfg(test)]
mod release_hardening_checks {
    use super::*;

    fn runtime() -> OAuthRuntime {
        OAuthRuntime::new(
            "release-security-test".into(),
            "registered-client".into(),
            None,
            "local-test-password".into(),
            "local-test-signing-secret-with-at-least-32-bytes".into(),
        )
    }

    #[test]
    fn release_hardening_unregistered_redirect_is_rejected() {
        let oauth = runtime();
        assert!(!oauth.redirect_uri_allowed("https://attacker.invalid/callback"));
        assert!(!oauth.redirect_uri_allowed("https://chatgpt.com.attacker.invalid/connector_platform/oauth/callback"));
        assert!(oauth.redirect_uri_allowed("https://chatgpt.com/connector_platform/oauth/callback"));
    }

    #[test]
    fn release_hardening_empty_signing_key_cannot_authenticate() {
        let mut oauth = runtime();
        oauth.token_secret.clear();
        let now = unix_now() as i64;
        let claims = TokenClaims {
            iss: oauth.issuer(),
            aud: oauth.profile_id.clone(),
            wid: oauth.profile_id.clone(),
            iat: now,
            exp: now + 300,
            scope: "mcp".into(),
        };
        let forged = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b""),
        ).expect("construct weak-key regression fixture");
        assert!(!oauth.verify_access_token(&forged, "https://server.invalid"));
    }

    #[test]
    fn release_hardening_token_errors_are_not_cacheable() {
        let response = token_error("invalid_client", "test error");
        assert_eq!(
            response.headers().get("cache-control").and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
        assert_eq!(
            response.headers().get("pragma").and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );
    }
}
''')
print("Five focused release security regressions materialized with recoverable backups")

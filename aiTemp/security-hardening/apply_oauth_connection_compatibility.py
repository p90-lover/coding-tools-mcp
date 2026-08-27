from __future__ import annotations

import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "security-hardening"
    / "oauth-connection-compatibility"
    / str(time.time_ns())
)


def checked_file(path: str) -> Path:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe source path: {path}")
    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {path}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"source path is missing or escapes the repository: {path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"source path is not a regular file: {path}")
    return resolved


def backup(path: str) -> None:
    source = checked_file(path)
    target = BACKUP_ROOT / Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def replace_once(path: str, before: str, after: str, label: str) -> None:
    target = checked_file(path)
    text = target.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {label}")
        return
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    backup(path)
    target.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


def remove_once(path: str, block: str, sentinel: str, label: str) -> None:
    target = checked_file(path)
    text = target.read_text(encoding="utf-8")
    if block not in text:
        if sentinel in text:
            raise RuntimeError(f"{label}: partial or drifted source state")
        print(f"already applied: {label}")
        return
    if text.count(block) != 1:
        raise RuntimeError(f"{label}: expected one source match")
    backup(path)
    target.write_text(text.replace(block, "", 1), encoding="utf-8")
    print(f"applied: {label}")


replace_once(
    "src-tauri/src/auth/oauth_flow.rs",
    '''pub const OAUTH_MAX_REDIRECT_URI_BYTES: usize = 2_048;
pub const OAUTH_MAX_PENDING_CODES: usize = 128;
''',
    '''pub const OAUTH_MAX_REDIRECT_URI_BYTES: usize = 2_048;
pub const OAUTH_MAX_PENDING_CODES: usize = 128;
pub const OAUTH_MAX_DYNAMIC_CLIENT_ID_BYTES: usize = 256;
''',
    "bound dynamic OAuth client IDs",
)

replace_once(
    "src-tauri/src/auth/oauth_flow.rs",
    '''        if self.client_id.is_empty() {
            return false;
        }
        constant_time_eq_str(client_id, &self.client_id)
''',
    '''        if self.client_id.is_empty() {
            return valid_dynamic_client_id(client_id);
        }
        constant_time_eq_str(client_id, &self.client_id)
''',
    "preserve bounded dynamic public-client compatibility",
)

replace_once(
    "src-tauri/src/auth/oauth_flow.rs",
    '''fn redirect_uri_allowed(value: &str) -> bool {
''',
    '''fn valid_dynamic_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= OAUTH_MAX_DYNAMIC_CLIENT_ID_BYTES
        && value.is_ascii()
        && value.bytes().all(|byte| {
            byte.is_ascii_graphic()
                && !matches!(byte, b'&' | b'=' | b'<' | b'>' | b'"' | b'\'')
        })
}

fn redirect_uri_allowed(value: &str) -> bool {
''',
    "validate dynamic public-client identifiers",
)

replace_once(
    "src-tauri/src/auth/oauth_flow.rs",
    '''    #[test]
    fn empty_configured_client_id_does_not_authorize_arbitrary_clients() {
        let oauth = OAuthRuntime::new(
            "workspace:mcp".into(),
            String::new(),
            None,
            "password".into(),
            "token-secret".into(),
        );
        assert!(!oauth.client_id_allowed("attacker-client"));
        assert!(!oauth.client_id_allowed(""));
    }
''',
    '''    #[test]
    fn dynamic_public_client_mode_is_bounded_and_well_formed() {
        let oauth = OAuthRuntime::new(
            "workspace:mcp".into(),
            String::new(),
            None,
            "password".into(),
            "token-secret".into(),
        );
        assert!(oauth.client_id_allowed("chatgpt-public-client-01"));
        assert!(oauth.client_id_allowed("https://chatgpt.com/connectors/client"));
        assert!(!oauth.client_id_allowed(""));
        assert!(!oauth.client_id_allowed("contains whitespace"));
        assert!(!oauth.client_id_allowed("contains=<markup>"));
        assert!(!oauth.client_id_allowed(&"x".repeat(OAUTH_MAX_DYNAMIC_CLIENT_ID_BYTES + 1)));
    }
''',
    "test safe dynamic public-client compatibility",
)

remove_once(
    "src-tauri/src/runtime/supervisor.rs",
    '''                if auth.oauth_enabled() {
                    auth.oauth_client_id = stable_oauth_client_id(
                        &profile.id,
                        &auth.oauth_client_id,
                        use_shared,
                        "mcp",
                    );
                }
''',
    "auth.oauth_client_id = stable_oauth_client_id(",
    "remove hidden MCP client-ID substitution",
)

replace_once(
    "src-tauri/src/runtime/supervisor.rs",
    '''                    stable_oauth_client_id(
                        &profile.id,
                        &profile.actions.oauth_client_id,
                        use_shared,
                        "actions",
                    ),
''',
    '''                    profile.actions.oauth_client_id.clone(),
''',
    "remove hidden Actions client-ID substitution",
)

remove_once(
    "src-tauri/src/runtime/supervisor.rs",
    '''fn stable_oauth_client_id(
    profile_id: &str,
    configured: &str,
    use_shared: bool,
    service: &str,
) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    if use_shared {
        format!("coding-tools-{service}-shared")
    } else {
        format!("coding-tools-{service}-{profile_id}")
    }
}

''',
    "fn stable_oauth_client_id(",
    "remove unused runtime client-ID generator",
)

remove_once(
    "src-tauri/src/runtime/supervisor.rs",
    '''
#[cfg(test)]
mod oauth_client_id_hardening_tests {
    use super::*;

    #[test]
    fn generated_oauth_client_ids_are_stable_non_empty_and_service_scoped() {
        let mcp = stable_oauth_client_id("workspace-1", "", false, "mcp");
        let actions = stable_oauth_client_id("workspace-1", "", false, "actions");
        assert_eq!(mcp, stable_oauth_client_id("workspace-1", "", false, "mcp"));
        assert!(!mcp.is_empty());
        assert!(!actions.is_empty());
        assert_ne!(mcp, actions);
        assert_eq!(
            stable_oauth_client_id("workspace-1", " configured ", false, "mcp"),
            "configured"
        );
    }
}
''',
    "mod oauth_client_id_hardening_tests",
    "remove obsolete synthetic client-ID tests",
)

remove_once(
    "src-tauri/src/mcp/listener.rs",
    '''        if auth.oauth_client_id.trim().is_empty() {
            return Err("MCP OAuth client ID is not configured".into());
        }
''',
    "MCP OAuth client ID is not configured",
    "retain dynamic MCP public-client mode",
)

remove_once(
    "src-tauri/src/actions/listener.rs",
    '''        if oauth_client_id.trim().is_empty() {
            return Err("Actions OAuth client ID is not configured".into());
        }
''',
    "Actions OAuth client ID is not configured",
    "retain dynamic Actions public-client mode",
)


def verify() -> None:
    oauth = checked_file("src-tauri/src/auth/oauth_flow.rs").read_text(encoding="utf-8")
    supervisor = checked_file("src-tauri/src/runtime/supervisor.rs").read_text(encoding="utf-8")
    mcp = checked_file("src-tauri/src/mcp/listener.rs").read_text(encoding="utf-8")
    actions = checked_file("src-tauri/src/actions/listener.rs").read_text(encoding="utf-8")
    required = (
        "return valid_dynamic_client_id(client_id);",
        "fn valid_dynamic_client_id(",
        "dynamic_public_client_mode_is_bounded_and_well_formed",
        "redirect_uri_allowed(&params.redirect_uri)",
        "redirect_uri_allowed(&form.redirect_uri)",
    )
    missing = [marker for marker in required if marker not in oauth]
    if missing:
        raise RuntimeError(f"OAuth compatibility verification failed: {missing}")
    if "stable_oauth_client_id(" in supervisor:
        raise RuntimeError("hidden synthetic OAuth client-ID substitution remains")
    if "OAuth client ID is not configured" in mcp + actions:
        raise RuntimeError("dynamic public-client mode is still rejected by a listener")


verify()
print("OAuth connection compatibility hardening applied successfully")

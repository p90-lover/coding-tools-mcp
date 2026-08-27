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
    / "security-hardening"
    / "post-rc1"
    / str(time.time_ns())
)


def checked_existing_file(path: str) -> Path:
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


def checked_new_file(path: str) -> Path:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe destination path: {path}")
    candidate = ROOT / relative
    parent = candidate.parent
    parent.mkdir(parents=True, exist_ok=True)
    if candidate.is_symlink() or parent.is_symlink():
        raise RuntimeError(f"refusing to write through a symlink: {path}")
    resolved_parent = parent.resolve(strict=True)
    try:
        resolved_parent.relative_to(ROOT)
    except ValueError as error:
        raise RuntimeError(f"destination escapes the repository: {path}") from error
    return candidate


def backup(path: str) -> None:
    source = checked_existing_file(path)
    target = BACKUP_ROOT / Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def write_existing(path: str, text: str, label: str) -> None:
    target = checked_existing_file(path)
    current = target.read_text(encoding="utf-8")
    if current == text:
        print(f"unchanged: {label}")
        return
    backup(path)
    target.write_text(text, encoding="utf-8")
    print(f"applied: {label}")


def write_file(path: str, text: str, label: str) -> None:
    target = checked_new_file(path)
    if target.exists():
        existing = checked_existing_file(path).read_text(encoding="utf-8")
        if existing == text:
            print(f"already applied: {label}")
            return
        backup(path)
    target.write_text(text, encoding="utf-8")
    print(f"applied: {label}")


def replace_once(text: str, before: str, after: str, label: str) -> str:
    if after in text:
        print(f"already applied: {label}")
        return text
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    print(f"prepared: {label}")
    return text.replace(before, after, 1)


def insert_before_once(text: str, marker: str, insertion: str, sentinel: str, label: str) -> str:
    if sentinel in text:
        print(f"already applied: {label}")
        return text
    count = text.count(marker)
    if count != 1:
        raise RuntimeError(f"{label}: expected one insertion marker, found {count}")
    print(f"prepared: {label}")
    return text.replace(marker, insertion + marker, 1)


def append_once(text: str, addition: str, sentinel: str, label: str) -> str:
    if sentinel in text:
        print(f"already applied: {label}")
        return text
    print(f"prepared: {label}")
    return text.rstrip() + "\n\n" + addition.strip() + "\n"


TRASH_SOURCE = r'''use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) fn move_file_to_recovery_trash(path: impl AsRef<Path>) -> io::Result<()> {
    move_path_to_recovery_trash(path.as_ref(), ExpectedKind::File)
}

pub(crate) fn move_dir_to_recovery_trash(path: impl AsRef<Path>) -> io::Result<()> {
    move_path_to_recovery_trash(path.as_ref(), ExpectedKind::Directory)
}

#[derive(Clone, Copy)]
enum ExpectedKind {
    File,
    Directory,
}

fn move_path_to_recovery_trash(source: &Path, expected: ExpectedKind) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to move a symlink into recovery Trash",
        ));
    }
    match expected {
        ExpectedKind::File if !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "recovery Trash expected a regular file",
            ));
        }
        ExpectedKind::Directory if !metadata.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "recovery Trash expected a directory",
            ));
        }
        _ => {}
    }

    let canonical = source.canonicalize()?;
    let root = recovery_root(&canonical)?;
    if canonical == root {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to move the workspace root",
        ));
    }
    let trash_root = root.join("aiTemp").join("Trash");
    if canonical.starts_with(&trash_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to recursively move recovery Trash",
        ));
    }
    let relative = canonical.strip_prefix(&root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "source escaped its recovery root",
        )
    })?;
    let operation = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        uuid::Uuid::new_v4().simple()
    );
    let destination = trash_root.join("apply-patch").join(operation).join(relative);
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "recovery destination has no parent")
    })?;
    fs::create_dir_all(parent)?;
    fs::rename(&canonical, destination)
}

fn recovery_root(source: &Path) -> io::Result<PathBuf> {
    for ancestor in source.ancestors().skip(1) {
        if ancestor.join(".git").exists() {
            return Ok(ancestor.to_path_buf());
        }
    }
    source.parent().map(Path::to_path_buf).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "source path has no recoverable parent",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "coding-tools-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn deleted_file_is_preserved_under_ai_temp_trash() {
        let root = unique_root("trash-file");
        fs::create_dir_all(root.join(".git")).expect("git marker");
        let source = root.join("notes.txt");
        fs::write(&source, "recover me").expect("fixture");

        move_file_to_recovery_trash(&source).expect("move to Trash");

        assert!(!source.exists());
        let trash = root.join("aiTemp").join("Trash").join("apply-patch");
        let operation = fs::read_dir(trash)
            .expect("Trash directory")
            .next()
            .expect("operation")
            .expect("operation entry")
            .path();
        assert_eq!(
            fs::read_to_string(operation.join("notes.txt")).expect("recovered bytes"),
            "recover me"
        );
    }

    #[test]
    fn deleted_directory_is_preserved_under_ai_temp_trash() {
        let root = unique_root("trash-directory");
        fs::create_dir_all(root.join(".git")).expect("git marker");
        let source = root.join("generated");
        fs::create_dir_all(&source).expect("fixture directory");
        fs::write(source.join("artifact.txt"), "recover directory").expect("fixture");

        move_dir_to_recovery_trash(&source).expect("move directory to Trash");

        assert!(!source.exists());
        let trash = root.join("aiTemp").join("Trash").join("apply-patch");
        let operation = fs::read_dir(trash)
            .expect("Trash directory")
            .next()
            .expect("operation")
            .expect("operation entry")
            .path();
        assert_eq!(
            fs::read_to_string(operation.join("generated").join("artifact.txt"))
                .expect("recovered bytes"),
            "recover directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_rejected_instead_of_followed() {
        use std::os::unix::fs::symlink;

        let root = unique_root("trash-symlink");
        fs::create_dir_all(root.join(".git")).expect("git marker");
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        fs::write(&target, "do not follow").expect("fixture");
        symlink(&target, &link).expect("symlink");

        let error = move_file_to_recovery_trash(&link).expect_err("symlink must fail");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(target.exists());
        assert!(link.exists());
    }
}
'''


def patch_trash_support() -> None:
    write_file(
        "src-tauri/src/tools/trash.rs",
        TRASH_SOURCE,
        "add atomic recoverable Trash moves",
    )

    mod_path = "src-tauri/src/tools/mod.rs"
    mod_text = checked_existing_file(mod_path).read_text(encoding="utf-8")
    if "mod trash;" not in mod_text:
        marker = "mod workspace;"
        if marker not in mod_text:
            raise RuntimeError("tools module marker changed")
        mod_text = mod_text.replace(marker, "pub(crate) mod trash;\n" + marker, 1)
    write_existing(mod_path, mod_text, "enable recoverable Trash module")

    replacements = 0
    for source_path in ("src-tauri/src/tools/patch.rs", "src-tauri/src/tools/file.rs"):
        text = checked_existing_file(source_path).read_text(encoding="utf-8")
        production, marker, tests = text.partition("#[cfg(test)]")
        original = production
        for before, after in (
            ("std::fs::remove_file(", "crate::tools::trash::move_file_to_recovery_trash("),
            ("fs::remove_file(", "crate::tools::trash::move_file_to_recovery_trash("),
            ("std::fs::remove_dir_all(", "crate::tools::trash::move_dir_to_recovery_trash("),
            ("fs::remove_dir_all(", "crate::tools::trash::move_dir_to_recovery_trash("),
        ):
            count = production.count(before)
            replacements += count
            production = production.replace(before, after)
        if production != original:
            write_existing(
                source_path,
                production + marker + tests,
                f"route destructive operations in {source_path} to recovery Trash",
            )
        elif "move_file_to_recovery_trash(" in production or "move_dir_to_recovery_trash(" in production:
            print(f"already applied: recoverable deletion in {source_path}")
    if replacements == 0:
        current = "\n".join(
            checked_existing_file(path).read_text(encoding="utf-8").partition("#[cfg(test)]")[0]
            for path in ("src-tauri/src/tools/patch.rs", "src-tauri/src/tools/file.rs")
        )
        if "move_file_to_recovery_trash(" not in current and "move_dir_to_recovery_trash(" not in current:
            raise RuntimeError("no destructive file operation was found for recovery hardening")


def patch_oauth() -> None:
    path = "src-tauri/src/auth/oauth_flow.rs"
    text = checked_existing_file(path).read_text(encoding="utf-8")

    text = replace_once(
        text,
        '''#[allow(dead_code)]
pub const OAUTH_MAX_BODY_BYTES: usize = 8_192;
''',
        '''#[allow(dead_code)]
pub const OAUTH_MAX_BODY_BYTES: usize = 8_192;
pub const OAUTH_MAX_REDIRECT_URI_BYTES: usize = 2_048;
pub const OAUTH_MAX_PENDING_CODES: usize = 128;
''',
        "bound OAuth redirect and pending state",
    )

    text = replace_once(
        text,
        '''        if self.client_id.is_empty() {
            return true;
        }
        constant_time_eq_str(client_id, &self.client_id)
''',
        '''        if self.client_id.is_empty() {
            return false;
        }
        constant_time_eq_str(client_id, &self.client_id)
''',
        "make empty OAuth client ID fail closed",
    )

    get_marker = '''    if params.code_challenge_method != "S256" || params.code_challenge.is_empty() {
'''
    get_insert = '''    if !redirect_uri_allowed(&params.redirect_uri) {
        return html_error(
            "redirect_uri must use HTTPS or loopback HTTP without user information or fragments",
            StatusCode::BAD_REQUEST,
        );
    }
'''
    get_start = text.find("pub fn authorize_get(")
    get_end = text.find("pub fn authorize_post(", get_start)
    if get_start < 0 or get_end < 0:
        raise RuntimeError("authorize_get boundary changed")
    get_slice = text[get_start:get_end]
    if "redirect_uri_allowed(&params.redirect_uri)" not in get_slice:
        if get_slice.count(get_marker) != 1:
            raise RuntimeError("authorize_get PKCE marker changed")
        get_slice = get_slice.replace(get_marker, get_insert + get_marker, 1)
        text = text[:get_start] + get_slice + text[get_end:]

    post_start = text.find("pub fn authorize_post(")
    post_end = text.find("pub fn token_exchange(", post_start)
    if post_start < 0 or post_end < 0:
        raise RuntimeError("authorize_post boundary changed")
    post_slice = text[post_start:post_end]
    post_marker = '''    if form.code_challenge_method != "S256" || form.code_challenge.is_empty() {
'''
    post_insert = '''    if !redirect_uri_allowed(&form.redirect_uri) {
        return html_error(
            "redirect_uri must use HTTPS or loopback HTTP without user information or fragments",
            StatusCode::BAD_REQUEST,
        );
    }
'''
    if "redirect_uri_allowed(&form.redirect_uri)" not in post_slice:
        if post_slice.count(post_marker) != 1:
            raise RuntimeError("authorize_post PKCE marker changed")
        post_slice = post_slice.replace(post_marker, post_insert + post_marker, 1)
        text = text[:post_start] + post_slice + text[post_end:]

    text = replace_once(
        text,
        '''        pending.retain(|_, value| value.expires_at >= now);
        pending.insert(
''',
        '''        if !prune_pending_codes(&mut pending, now) {
            return html_error(
                "Too many pending authorization requests; retry shortly",
                StatusCode::TOO_MANY_REQUESTS,
            );
        }
        pending.insert(
''',
        "bound pending OAuth authorization codes",
    )

    oauth_helpers = r'''fn redirect_uri_allowed(value: &str) -> bool {
    if value.is_empty()
        || value.len() > OAUTH_MAX_REDIRECT_URI_BYTES
        || value.contains('#')
    {
        return false;
    }
    let Ok(uri) = value.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    if authority.as_str().contains('@') {
        return false;
    }
    let host = authority.host();
    match scheme {
        "https" => !host.is_empty(),
        "http" => matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]"),
        _ => false,
    }
}

fn prune_pending_codes(pending: &mut HashMap<String, PendingCode>, now: u64) -> bool {
    pending.retain(|_, value| value.expires_at >= now);
    pending.len() < OAUTH_MAX_PENDING_CODES
}

'''
    text = insert_before_once(
        text,
        "fn token_success(",
        oauth_helpers,
        "fn redirect_uri_allowed(",
        "add OAuth redirect and capacity guards",
    )

    oauth_tests = r'''
#[cfg(test)]
mod security_hardening_tests {
    use super::*;

    #[test]
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

    #[test]
    fn redirect_uri_rejects_unsafe_schemes_user_info_and_fragments() {
        assert!(redirect_uri_allowed("https://chatgpt.com/oauth/callback"));
        assert!(redirect_uri_allowed("http://127.0.0.1:3210/callback"));
        assert!(redirect_uri_allowed("http://localhost:3210/callback"));
        assert!(!redirect_uri_allowed("http://example.com/callback"));
        assert!(!redirect_uri_allowed("javascript:alert(1)"));
        assert!(!redirect_uri_allowed("file:///tmp/callback"));
        assert!(!redirect_uri_allowed("https://user@example.com/callback"));
        assert!(!redirect_uri_allowed("https://example.com/callback#fragment"));
    }

    #[test]
    fn pending_authorization_state_is_bounded_and_expired_entries_are_pruned() {
        let now = 100;
        let mut pending = HashMap::new();
        for index in 0..OAUTH_MAX_PENDING_CODES {
            pending.insert(
                format!("code-{index}"),
                PendingCode {
                    code_challenge: "challenge".into(),
                    client_id: "client".into(),
                    redirect_uri: "https://example.com/callback".into(),
                    state: String::new(),
                    expires_at: now + 60,
                },
            );
        }
        assert!(!prune_pending_codes(&mut pending, now));
        pending.get_mut("code-0").expect("entry").expires_at = now - 1;
        assert!(prune_pending_codes(&mut pending, now));
        assert_eq!(pending.len(), OAUTH_MAX_PENDING_CODES - 1);
    }
}
'''
    text = append_once(
        text,
        oauth_tests,
        "mod security_hardening_tests",
        "test fail-closed OAuth identity and bounded state",
    )
    write_existing(path, text, "harden persistent OAuth authorization")


def patch_supervisor_client_ids() -> None:
    path = "src-tauri/src/runtime/supervisor.rs"
    text = checked_existing_file(path).read_text(encoding="utf-8")
    shared_block = '''                if use_shared {
                    if let Some(client_id) = SecretStore::get_shared("oauth_client_id")? {
                        auth.oauth_client_id = client_id;
                    }
                }
'''
    hardened_block = shared_block + '''                if auth.oauth_enabled() {
                    auth.oauth_client_id = stable_oauth_client_id(
                        &profile.id,
                        &auth.oauth_client_id,
                        use_shared,
                        "mcp",
                    );
                }
'''
    text = replace_once(
        text,
        shared_block,
        hardened_block,
        "derive stable fail-closed MCP OAuth client ID",
    )

    text = replace_once(
        text,
        '''                    profile.actions.oauth_client_id.clone(),
''',
        '''                    stable_oauth_client_id(
                        &profile.id,
                        &profile.actions.oauth_client_id,
                        use_shared,
                        "actions",
                    ),
''',
        "derive stable fail-closed Actions OAuth client ID",
    )

    helper = r'''fn stable_oauth_client_id(
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

'''
    if "fn stable_oauth_client_id(" not in text:
        marker = "fn resolve_secret("
        if marker not in text:
            marker = "fn endpoints("
        text = insert_before_once(
            text,
            marker,
            helper,
            "fn stable_oauth_client_id(",
            "add deterministic OAuth client ID fallback",
        )

    tests = r'''
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
'''
    text = append_once(
        text,
        tests,
        "mod oauth_client_id_hardening_tests",
        "test deterministic OAuth client IDs",
    )
    write_existing(path, text, "provide stable OAuth identity at runtime boundary")


def patch_mcp_listener() -> None:
    path = "src-tauri/src/mcp/listener.rs"
    text = checked_existing_file(path).read_text(encoding="utf-8")
    text = replace_once(
        text,
        "use axum::extract::{Form, Query, State};\n",
        "use axum::extract::{DefaultBodyLimit, Form, Query, State};\n",
        "enable MCP body limit",
    )
    text = replace_once(
        text,
        "use tokio::sync::oneshot;\n",
        "use tokio::sync::{oneshot, Semaphore};\n",
        "enable MCP request semaphore",
    )
    text = text.replace("use tower_http::cors::CorsLayer;\n", "")
    text = replace_once(
        text,
        "pub type ShutdownSender = oneshot::Sender<()>;\n",
        "pub type ShutdownSender = oneshot::Sender<()>;\n\nconst MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;\nconst MAX_IN_FLIGHT_REQUESTS: usize = 16;\nconst REQUEST_QUEUE_WAIT_SECONDS: u64 = 2;\n",
        "define bounded MCP request limits",
    )
    text = replace_once(
        text,
        "    oauth_client_secret: Option<String>,\n}",
        "    oauth_client_secret: Option<String>,\n    request_slots: Arc<Semaphore>,\n}",
        "store MCP request slots",
    )

    validation_marker = "    let configured_public_url = public_base_url.trim().to_string();\n"
    validation = '''    if auth.oauth_enabled() {
        if auth.oauth_client_id.trim().is_empty() {
            return Err("MCP OAuth client ID is not configured".into());
        }
        if oauth_password.as_ref().is_none_or(String::is_empty) {
            return Err("MCP OAuth password is not configured".into());
        }
        if oauth_token_secret.as_ref().is_none_or(String::is_empty) {
            return Err("MCP OAuth token secret is not configured".into());
        }
    }
'''
    text = insert_before_once(
        text,
        validation_marker,
        validation,
        "MCP OAuth client ID is not configured",
        "reject incomplete MCP OAuth runtime",
    )
    text = replace_once(
        text,
        "        oauth_client_secret,\n    };",
        "        oauth_client_secret,\n        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),\n    };",
        "initialize MCP request slots",
    )
    text = replace_once(
        text,
        "        .with_state(state)\n        .layer(CorsLayer::permissive());",
        "        .with_state(state)\n        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES));",
        "remove permissive MCP CORS and bound body size",
    )

    permit = '''    let permit = match tokio::time::timeout(
        std::time::Duration::from_secs(REQUEST_QUEUE_WAIT_SECONDS),
        state.request_slots.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "server_busy",
                    "detail": "MCP request capacity is temporarily exhausted"
                })),
            )
                .into_response();
        }
    };
'''
    text = insert_before_once(
        text,
        "    let method = body\n",
        permit,
        "MCP request capacity is temporarily exhausted",
        "bound authenticated MCP work",
    )
    text = replace_once(
        text,
        "    let result = tokio::task::spawn_blocking(move || handle_request(&mcp, &body)).await;",
        "    let result = tokio::task::spawn_blocking(move || {\n        let _permit = permit;\n        handle_request(&mcp, &body)\n    })\n    .await;",
        "hold MCP capacity for blocking tool work",
    )
    write_existing(path, text, "bound MCP listener exposure and concurrency")


def patch_actions_listener() -> None:
    path = "src-tauri/src/actions/listener.rs"
    text = checked_existing_file(path).read_text(encoding="utf-8")
    text = replace_once(
        text,
        "        extract::{Form, Path, Query, State},\n",
        "        extract::{DefaultBodyLimit, Form, Path, Query, State},\n",
        "enable Actions body limit",
    )
    text = replace_once(
        text,
        "use tokio::sync::{oneshot, Mutex, RwLock};\n",
        "use tokio::sync::{oneshot, Mutex, RwLock, Semaphore};\n",
        "enable Actions request semaphore",
    )
    text = text.replace("use tower_http::cors::CorsLayer;\n", "")
    text = replace_once(
        text,
        "pub type ShutdownSender = oneshot::Sender<()>;\n",
        "pub type ShutdownSender = oneshot::Sender<()>;\n\nconst MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;\nconst MAX_IN_FLIGHT_REQUESTS: usize = 16;\nconst REQUEST_QUEUE_WAIT_SECONDS: u64 = 2;\n",
        "define bounded Actions request limits",
    )
    text = replace_once(
        text,
        "    write_lock: Arc<Mutex<()>>,\n}",
        "    write_lock: Arc<Mutex<()>>,\n    request_slots: Arc<Semaphore>,\n}",
        "store Actions request slots",
    )
    text = insert_before_once(
        text,
        '''        if oauth_password.as_ref().is_none_or(String::is_empty) {
''',
        '''        if oauth_client_id.trim().is_empty() {
            return Err("Actions OAuth client ID is not configured".into());
        }
''',
        "Actions OAuth client ID is not configured",
        "reject incomplete Actions OAuth identity",
    )
    text = replace_once(
        text,
        "        write_lock: Arc::new(Mutex::new(())),\n    };",
        "        write_lock: Arc::new(Mutex::new(())),\n        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),\n    };",
        "initialize Actions request slots",
    )
    text = replace_once(
        text,
        "        .with_state(state)\n        .layer(CorsLayer::permissive());",
        "        .with_state(state)\n        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES));",
        "remove permissive Actions CORS and bound body size",
    )

    permit = '''    let permit = match tokio::time::timeout(
        std::time::Duration::from_secs(REQUEST_QUEUE_WAIT_SECONDS),
        state.request_slots.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "detail": "Actions request capacity is temporarily exhausted"
                })),
            )
                .into_response();
        }
    };

'''
    text = insert_before_once(
        text,
        "    if let Err(err) = tools::policy::validate_actions_exposure(&tool_name) {\n",
        permit,
        "Actions request capacity is temporarily exhausted",
        "bound authenticated Actions work",
    )

    old_call = '''    let structured = if tools::registry::MUTATING_TOOLS.contains(&tool_name.as_str()) {
        let _guard = state.write_lock.lock().await;
        tools::call_tool(state.ctx.as_ref(), &tool_name, &arguments)
    } else {
        tools::call_tool(state.ctx.as_ref(), &tool_name, &arguments)
    };
'''
    new_call = '''    let write_guard = if tools::registry::MUTATING_TOOLS.contains(&tool_name.as_str()) {
        Some(state.write_lock.clone().lock_owned().await)
    } else {
        None
    };
    let ctx = state.ctx.clone();
    let worker_tool_name = tool_name.clone();
    let structured = match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _write_guard = write_guard;
        tools::call_tool(ctx.as_ref(), &worker_tool_name, &arguments)
    })
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "detail": "Actions worker failed" })),
            )
                .into_response();
        }
    };
'''
    text = replace_once(
        text,
        old_call,
        new_call,
        "move Actions tool work off the async reactor",
    )
    write_existing(path, text, "bound Actions listener exposure and concurrency")


def verify() -> None:
    oauth = checked_existing_file("src-tauri/src/auth/oauth_flow.rs").read_text(encoding="utf-8")
    supervisor = checked_existing_file("src-tauri/src/runtime/supervisor.rs").read_text(
        encoding="utf-8"
    )
    mcp = checked_existing_file("src-tauri/src/mcp/listener.rs").read_text(encoding="utf-8")
    actions = checked_existing_file("src-tauri/src/actions/listener.rs").read_text(
        encoding="utf-8"
    )
    trash = checked_existing_file("src-tauri/src/tools/trash.rs").read_text(encoding="utf-8")
    required = {
        "OAuth fail closed": "return false;" in oauth and "fn redirect_uri_allowed(" in oauth,
        "OAuth pending cap": "OAUTH_MAX_PENDING_CODES" in oauth and "prune_pending_codes" in oauth,
        "stable client IDs": supervisor.count("stable_oauth_client_id(") >= 3,
        "MCP body/concurrency": "DefaultBodyLimit::max" in mcp and "request_slots" in mcp,
        "Actions body/concurrency": "DefaultBodyLimit::max" in actions and "spawn_blocking" in actions,
        "permissive CORS removed": "CorsLayer::permissive" not in mcp + actions,
        "recoverable Trash": "move_path_to_recovery_trash" in trash,
    }
    failed = [name for name, ok in required.items() if not ok]
    if failed:
        raise RuntimeError(f"security hardening verification failed: {failed}")
    for source_path in ("src-tauri/src/tools/patch.rs", "src-tauri/src/tools/file.rs"):
        production = checked_existing_file(source_path).read_text(encoding="utf-8").partition(
            "#[cfg(test)]"
        )[0]
        if re.search(r"(?:std::)?fs::remove_(?:file|dir_all)\(", production):
            raise RuntimeError(f"irreversible deletion remains in {source_path}")


patch_trash_support()
patch_oauth()
patch_supervisor_client_ids()
patch_mcp_listener()
patch_actions_listener()
verify()
print("post-RC1 security and heavy-usage hardening applied successfully")

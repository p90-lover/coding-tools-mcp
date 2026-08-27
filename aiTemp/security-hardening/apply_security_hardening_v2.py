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
    / "security-hardening-v2"
    / str(time.time_ns())
)


def checked_file(path: str, *, must_exist: bool = True) -> Path:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe repository path: {path}")
    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {path}")
    if not candidate.exists():
        if must_exist:
            raise RuntimeError(f"required source file is missing: {path}")
        candidate.parent.mkdir(parents=True, exist_ok=True)
        return candidate
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(ROOT)
    except ValueError as error:
        raise RuntimeError(f"source path escapes the repository: {path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"source path is not a regular file: {path}")
    return resolved


def backup(path: str) -> None:
    source = checked_file(path)
    target = BACKUP_ROOT / Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def write_text(path: str, text: str, label: str) -> None:
    target = checked_file(path, must_exist=False)
    current = target.read_text(encoding="utf-8") if target.exists() else None
    if current == text:
        print(f"already applied: {label}")
        return
    if target.exists():
        backup(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    print(f"applied: {label}")


def transform(path: str, function, label: str) -> None:
    target = checked_file(path)
    before = target.read_text(encoding="utf-8")
    after = function(before)
    if after == before:
        print(f"already applied: {label}")
        return
    backup(path)
    target.write_text(after, encoding="utf-8")
    print(f"applied: {label}")


def replace_once(text: str, before: str, after: str, label: str) -> str:
    if after in text:
        return text
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one source match, found {count}")
    return text.replace(before, after, 1)


def insert_before_once(text: str, marker: str, addition: str, label: str) -> str:
    if addition in text:
        return text
    count = text.count(marker)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one marker, found {count}")
    return text.replace(marker, addition + marker, 1)


def ensure_cargo(text: str) -> str:
    lines = text.splitlines()
    dependency_start = next(
        (index for index, line in enumerate(lines) if line.strip() == "[dependencies]"),
        None,
    )
    if dependency_start is None:
        raise RuntimeError("Cargo.toml has no [dependencies] section")
    next_section = next(
        (
            index
            for index in range(dependency_start + 1, len(lines))
            if lines[index].startswith("[")
        ),
        len(lines),
    )
    dependency_lines = lines[dependency_start + 1 : next_section]

    def set_dependency(name: str, value: str) -> None:
        nonlocal lines, next_section, dependency_lines
        pattern = re.compile(rf"^\s*{re.escape(name)}\s*=")
        for offset, line in enumerate(dependency_lines):
            if pattern.match(line):
                lines[dependency_start + 1 + offset] = f"{name} = {value}"
                dependency_lines[offset] = f"{name} = {value}"
                return
        lines.insert(next_section, f"{name} = {value}")
        dependency_lines.append(f"{name} = {value}")
        next_section += 1

    set_dependency("url", '"2"')
    set_dependency("tower", '{ version = "0.5", features = ["limit", "util"] }')

    tower_http_pattern = re.compile(r"^\s*tower-http\s*=.*$")
    found_tower_http = False
    for index, line in enumerate(lines):
        if tower_http_pattern.match(line):
            found_tower_http = True
            version = re.search(r'version\s*=\s*"([^"]+)"', line)
            chosen = version.group(1) if version else "0.6"
            lines[index] = (
                f'tower-http = {{ version = "{chosen}", '
                'features = ["cors", "timeout"] }}'
            )
            break
    if not found_tower_http:
        lines.insert(
            next_section,
            'tower-http = { version = "0.6", features = ["cors", "timeout"] }',
        )

    dev_header = next(
        (index for index, line in enumerate(lines) if line.strip() == "[dev-dependencies]"),
        None,
    )
    if dev_header is None:
        lines.extend(["", "[dev-dependencies]", 'tempfile = "3"'])
    else:
        dev_end = next(
            (
                index
                for index in range(dev_header + 1, len(lines))
                if lines[index].startswith("[")
            ),
            len(lines),
        )
        if not any(
            re.match(r"^\s*tempfile\s*=", line)
            for line in lines[dev_header + 1 : dev_end]
        ):
            lines.insert(dev_end, 'tempfile = "3"')
    return "\n".join(lines) + "\n"


def harden_oauth(text: str) -> str:
    text = replace_once(
        text,
        "pub const OAUTH_CODE_TTL_SECONDS: u64 = 300;\n",
        "pub const OAUTH_CODE_TTL_SECONDS: u64 = 300;\n"
        "pub const OAUTH_MAX_PENDING_CODES: usize = 256;\n",
        "bound pending OAuth authorization codes",
    )
    text = replace_once(
        text,
        "        if self.client_id.is_empty() {\n            return true;\n        }\n",
        "        if self.client_id.is_empty() {\n            return false;\n        }\n",
        "fail closed when OAuth client ID is empty",
    )
    redirect_method = '''
    pub fn redirect_uri_allowed(&self, redirect_uri: &str) -> bool {
        let Ok(uri) = url::Url::parse(redirect_uri) else {
            return false;
        };
        if !uri.username().is_empty() || uri.password().is_some() || uri.fragment().is_some() {
            return false;
        }
        match uri.scheme() {
            "https" => uri.host_str().is_some(),
            "http" => matches!(
                uri.host_str(),
                Some("127.0.0.1") | Some("localhost") | Some("::1")
            ),
            _ => false,
        }
    }

'''
    text = insert_before_once(
        text,
        "    pub fn verify_access_token(&self, token: &str, _server_url: &str) -> bool {\n",
        redirect_method,
        "install redirect URI validation",
    )
    get_client = '''    if !oauth.client_id_allowed(&params.client_id) {
        return html_error("Unknown client_id", StatusCode::BAD_REQUEST);
    }
'''
    get_client_hardened = get_client + '''    if !oauth.redirect_uri_allowed(&params.redirect_uri) {
        return html_error("redirect_uri is not allowed", StatusCode::BAD_REQUEST);
    }
'''
    text = replace_once(
        text,
        get_client,
        get_client_hardened,
        "validate authorization GET redirect URI",
    )
    post_client = '''    if !oauth.client_id_allowed(&form.client_id) {
        return Html(login_page(
            &form.client_id,
            &form.redirect_uri,
            &form.code_challenge,
            &form.code_challenge_method,
            &form.state,
            "Invalid client",
            None,
        ))
        .into_response();
    }
'''
    post_client_hardened = post_client + '''    if !oauth.redirect_uri_allowed(&form.redirect_uri) {
        return html_error("redirect_uri is not allowed", StatusCode::BAD_REQUEST);
    }
'''
    text = replace_once(
        text,
        post_client,
        post_client_hardened,
        "validate authorization POST redirect URI",
    )
    pending = '''        let mut pending = oauth.pending.lock().expect("oauth pending lock");
        pending.retain(|_, value| value.expires_at >= now);
        pending.insert(
'''
    pending_hardened = '''        let mut pending = oauth.pending.lock().expect("oauth pending lock");
        pending.retain(|_, value| value.expires_at >= now);
        if pending.len() >= OAUTH_MAX_PENDING_CODES {
            return html_error(
                "Too many pending authorization requests",
                StatusCode::TOO_MANY_REQUESTS,
            );
        }
        pending.insert(
'''
    text = replace_once(
        text,
        pending,
        pending_hardened,
        "bound pending OAuth map",
    )
    tests = '''    #[test]
    fn empty_configured_client_id_is_rejected() {
        let oauth = runtime("workspace:oauth");
        let empty = OAuthRuntime::new(
            "workspace:oauth".into(),
            String::new(),
            None,
            "password".into(),
            "token-secret".into(),
        );
        assert!(oauth.client_id_allowed("client"));
        assert!(!empty.client_id_allowed("client"));
    }

    #[test]
    fn redirect_uri_policy_rejects_untrusted_destinations() {
        let oauth = runtime("workspace:oauth");
        assert!(oauth.redirect_uri_allowed("https://chatgpt.com/aip/oauth/callback"));
        assert!(oauth.redirect_uri_allowed("http://127.0.0.1:53682/callback"));
        assert!(oauth.redirect_uri_allowed("http://localhost:53682/callback"));
        assert!(!oauth.redirect_uri_allowed("http://example.com/callback"));
        assert!(!oauth.redirect_uri_allowed("javascript:alert(1)"));
        assert!(!oauth.redirect_uri_allowed("https://user:pass@example.com/callback"));
        assert!(!oauth.redirect_uri_allowed("https://example.com/callback#fragment"));
    }

'''
    text = insert_before_once(
        text,
        "    #[test]\n    fn pkce_round_trip() {\n",
        tests,
        "test fail-closed OAuth client and redirect handling",
    )
    return text


def harden_mcp_listener(text: str) -> str:
    if "use std::time::Duration;" not in text:
        text = text.replace(
            "use std::sync::Arc;\n",
            "use std::sync::Arc;\nuse std::time::Duration;\n",
            1,
        )
    text = text.replace(
        "use axum::extract::{Form, Query, State};",
        "use axum::extract::{DefaultBodyLimit, Form, Query, State};",
        1,
    )
    if "use tower::limit::ConcurrencyLimitLayer;" not in text:
        text = text.replace(
            "use tokio::sync::oneshot;\n",
            "use tokio::sync::oneshot;\n"
            "use tower::limit::ConcurrencyLimitLayer;\n"
            "use tower::ServiceBuilder;\n",
            1,
        )
    text = text.replace("use tower_http::cors::CorsLayer;\n", "")
    if "use tower_http::timeout::TimeoutLayer;" not in text:
        marker = "use tower::ServiceBuilder;\n"
        text = text.replace(
            marker,
            marker + "use tower_http::timeout::TimeoutLayer;\n",
            1,
        )
    guard_marker = "    let configured_public_url = public_base_url.trim().to_string();\n"
    guard = '''    if auth.oauth_enabled() && auth.oauth_client_id.trim().is_empty() {
        return Err("MCP OAuth client ID is not configured".into());
    }
'''
    text = insert_before_once(
        text,
        guard_marker,
        guard,
        "refuse MCP OAuth startup without client ID",
    )
    old_layer = "        .with_state(state)\n        .layer(CorsLayer::permissive());\n"
    new_layer = '''        .with_state(state)
        .layer(
            ServiceBuilder::new()
                .layer(TimeoutLayer::new(Duration::from_secs(120)))
                .layer(ConcurrencyLimitLayer::new(64)),
        )
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024));
'''
    text = replace_once(
        text,
        old_layer,
        new_layer,
        "bound MCP body, concurrency, and execution time",
    )
    return text


def harden_actions_listener(text: str) -> str:
    if "use std::time::Duration;" not in text:
        text = text.replace(
            "use std::sync::Arc;\n",
            "use std::sync::Arc;\nuse std::time::Duration;\n",
            1,
        )
    text = text.replace(
        "extract::{Form, Path, Query, State},",
        "extract::{DefaultBodyLimit, Form, Path, Query, State},",
        1,
    )
    if "use tower::limit::ConcurrencyLimitLayer;" not in text:
        text = text.replace(
            "use tokio::sync::{oneshot, Mutex, RwLock};\n",
            "use tokio::sync::{oneshot, Mutex, RwLock};\n"
            "use tower::limit::ConcurrencyLimitLayer;\n"
            "use tower::ServiceBuilder;\n",
            1,
        )
    text = text.replace("use tower_http::cors::CorsLayer;\n", "")
    if "use tower_http::timeout::TimeoutLayer;" not in text:
        text = text.replace(
            "use tower::ServiceBuilder;\n",
            "use tower::ServiceBuilder;\nuse tower_http::timeout::TimeoutLayer;\n",
            1,
        )
    oauth_guard_marker = '''    if auth_type == "oauth" {
        if oauth_password.as_ref().is_none_or(String::is_empty) {
'''
    oauth_guard = '''    if auth_type == "oauth" {
        if oauth_client_id.trim().is_empty() {
            return Err("Actions OAuth client ID is not configured".into());
        }
        if oauth_password.as_ref().is_none_or(String::is_empty) {
'''
    text = replace_once(
        text,
        oauth_guard_marker,
        oauth_guard,
        "refuse Actions OAuth startup without client ID",
    )
    old_layer = "        .with_state(state)\n        .layer(CorsLayer::permissive());\n"
    new_layer = '''        .with_state(state)
        .layer(
            ServiceBuilder::new()
                .layer(TimeoutLayer::new(Duration::from_secs(120)))
                .layer(ConcurrencyLimitLayer::new(32)),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024));
'''
    text = replace_once(
        text,
        old_layer,
        new_layer,
        "bound Actions body, concurrency, and execution time",
    )
    return text


def workspace_root_expression(text: str) -> str:
    candidates = (
        "ctx.workspace.root()",
        "context.workspace.root()",
        "workspace.root()",
        "ctx.workspace.path()",
        "context.workspace.path()",
        "workspace.path()",
    )
    for candidate in candidates:
        if candidate in text:
            return candidate
    receiver = re.search(r"([A-Za-z_][A-Za-z0-9_\.]*)\.resolve(?:_path)?\(", text)
    if receiver:
        return f"{receiver.group(1)}.root()"
    parameter = re.search(
        r"fn\s+[A-Za-z0-9_]+\s*\([^)]*?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*&Workspace",
        text,
        re.DOTALL,
    )
    if parameter:
        return f"{parameter.group(1)}.root()"
    raise RuntimeError("unable to identify the workspace root expression in patch.rs")


def harden_patch_deletion(text: str) -> str:
    production, separator, tests = text.partition("#[cfg(test)]")
    if "fn move_to_trash(" not in production:
        root_expression = workspace_root_expression(production)
        helper = '''
fn move_to_trash(
    workspace_root: impl AsRef<std::path::Path>,
    target: impl AsRef<std::path::Path>,
) -> std::io::Result<std::path::PathBuf> {
    let workspace_root = workspace_root.as_ref();
    let target = target.as_ref();
    let relative = target.strip_prefix(workspace_root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move a path outside the workspace",
        )
    })?;
    if relative.as_os_str().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move the workspace root",
        ));
    }
    if relative.starts_with(std::path::Path::new("aiTemp").join("Trash")) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move an existing Trash item again",
        ));
    }
    let metadata = std::fs::symlink_metadata(target)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move a symbolic link",
        ));
    }
    let destination = workspace_root
        .join("aiTemp")
        .join("Trash")
        .join("deleted-files")
        .join(uuid::Uuid::new_v4().to_string())
        .join(relative);
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid Trash destination")
    })?;
    std::fs::create_dir_all(parent)?;
    std::fs::rename(target, &destination)?;
    Ok(destination)
}

'''
        marker_match = re.search(r"(?m)^(?:pub\s+)?fn\s+", production)
        if not marker_match:
            raise RuntimeError("patch.rs has no function marker for Trash helper insertion")
        production = production[: marker_match.start()] + helper + production[marker_match.start() :]
        remove_pattern = re.compile(r"std::fs::remove_(?:file|dir_all)\(([^\n;]+)\)|fs::remove_(?:file|dir_all)\(([^\n;]+)\)")
        replacements = 0

        def substitute(match: re.Match[str]) -> str:
            nonlocal replacements
            argument = match.group(1) or match.group(2)
            replacements += 1
            return f"move_to_trash({root_expression}, {argument})"

        production = remove_pattern.sub(substitute, production)
        if replacements == 0:
            raise RuntimeError("no production deletion call was found in patch.rs")
    result = production + (separator + tests if separator else "")
    trash_test = '''
    #[test]
    fn move_to_trash_preserves_content() {
        let root = tempfile::tempdir().expect("workspace");
        let target = root.path().join("notes.txt");
        std::fs::write(&target, "preserve me").expect("write fixture");
        let destination = move_to_trash(root.path(), &target).expect("move to Trash");
        assert!(!target.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read Trash copy"),
            "preserve me"
        );
        assert!(destination.starts_with(root.path().join("aiTemp").join("Trash")));
    }

'''
    if "fn move_to_trash_preserves_content()" not in result:
        if not separator:
            raise RuntimeError("patch.rs has no test module")
        test_marker = re.search(r"(?m)^\s*#\[test\]\s*$", result[result.index(separator) :])
        if not test_marker:
            raise RuntimeError("patch.rs test module has no test marker")
        absolute = result.index(separator) + test_marker.start()
        result = result[:absolute] + trash_test + result[absolute:]
    return result


CONTRACT_TEST = r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OAuth rejects unconfigured clients and unsafe redirects", async () => {
  const source = await read("src-tauri/src/auth/oauth_flow.rs");
  assert.match(source, /OAUTH_MAX_PENDING_CODES/);
  assert.match(source, /redirect_uri_allowed/);
  assert.match(source, /if self\.client_id\.is_empty\(\)[\s\S]*?return false;/);
  assert.doesNotMatch(source, /if self\.client_id\.is_empty\(\)[\s\S]*?return true;/);
});

test("listeners are bounded and do not expose permissive CORS", async () => {
  for (const path of [
    "src-tauri/src/mcp/listener.rs",
    "src-tauri/src/actions/listener.rs",
  ]) {
    const source = await read(path);
    assert.match(source, /DefaultBodyLimit/);
    assert.match(source, /ConcurrencyLimitLayer/);
    assert.match(source, /TimeoutLayer/);
    assert.doesNotMatch(source, /CorsLayer::permissive/);
  }
});

test("patch deletion is reversible", async () => {
  const source = await read("src-tauri/src/tools/patch.rs");
  const production = source.split("#[cfg(test)]", 1)[0];
  assert.match(production, /fn move_to_trash/);
  assert.match(production, /aiTemp/);
  assert.match(production, /deleted-files/);
  assert.doesNotMatch(production, /(?:std::)?fs::remove_file/);
  assert.doesNotMatch(production, /(?:std::)?fs::remove_dir_all/);
});
'''

transform("src-tauri/Cargo.toml", ensure_cargo, "add direct hardening dependencies")
transform("src-tauri/src/auth/oauth_flow.rs", harden_oauth, "harden OAuth authorization")
transform("src-tauri/src/mcp/listener.rs", harden_mcp_listener, "bound MCP listener")
transform("src-tauri/src/actions/listener.rs", harden_actions_listener, "bound Actions listener")
transform("src-tauri/src/tools/patch.rs", harden_patch_deletion, "make patch deletion reversible")
write_text(
    "tests/security-hardening-contract.test.mjs",
    CONTRACT_TEST,
    "install security hardening source-contract tests",
)

for path in (
    "src-tauri/src/auth/oauth_flow.rs",
    "src-tauri/src/mcp/listener.rs",
    "src-tauri/src/actions/listener.rs",
    "src-tauri/src/tools/patch.rs",
):
    text = checked_file(path).read_text(encoding="utf-8")
    if path.endswith("oauth_flow.rs"):
        required = ("OAUTH_MAX_PENDING_CODES", "redirect_uri_allowed")
    elif path.endswith("patch.rs"):
        required = ("move_to_trash", "deleted-files", "aiTemp")
    else:
        required = ("DefaultBodyLimit", "ConcurrencyLimitLayer", "TimeoutLayer")
        if "CorsLayer::permissive" in text:
            raise RuntimeError(f"permissive CORS remains in {path}")
    for marker in required:
        if marker not in text:
            raise RuntimeError(f"missing {marker} in {path}")

print("security hardening source materialized without deleting files")

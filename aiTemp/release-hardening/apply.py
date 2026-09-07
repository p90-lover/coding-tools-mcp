from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Callable

ROOT = Path.cwd().resolve()
BACKUP = ROOT / "aiTemp" / "Trash" / "defense-in-depth" / str(time.time_ns())
MARKER = "// Defense-in-depth release hardening v1."


def exact(text: str, old: str, new: str, count: int = 1) -> str:
    if text.count(old) != count:
        raise RuntimeError(f"Expected {count} reviewed anchors, got {text.count(old)}: {old[:140]!r}")
    return text.replace(old, new)


def between(text: str, start: str, end: str, replacement: str) -> str:
    if text.count(start) != 1:
        raise RuntimeError(f"Ambiguous start: {start!r}")
    a = text.index(start)
    b = text.index(end, a + len(start))
    return text[:a] + replacement.rstrip() + "\n\n" + text[b:]


def update(relative: str, transform: Callable[[str], str]) -> None:
    target = ROOT / relative
    if target.is_symlink() or not target.is_file():
        raise RuntimeError(f"Not a regular source file: {relative}")
    target.resolve(strict=True).relative_to(ROOT)
    source = target.read_text(encoding="utf-8")
    if MARKER in source:
        print(f"Already hardened: {relative}")
        return
    changed = transform(source)
    if changed == source:
        raise RuntimeError(f"No changes produced: {relative}")
    dest = BACKUP / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, dest)
    target.write_text(changed.rstrip() + "\n\n" + MARKER + "\n", encoding="utf-8")
    print(f"Hardened: {relative}")


def policy(text: str) -> str:
    text = exact(text, "_ => Self::WorkspaceWrite,", "_ => Self::ReadOnly,")
    text = exact(text, '_ => "on-request",', '"on-request" | "auto-workspace" => "on-request",\n        _ => "ask",')
    text = exact(text, "        if read_only_command_allowed(command) {", '''        if network_command_pattern().is_match(command) {
            return Err(PolicyError(
                "READ_ONLY_SANDBOX: Network-looking commands are unavailable in read-only mode".into(),
            ));
        }
        if read_only_command_allowed(command) {''')
    text = exact(text, "    let base_name = executable.rsplit(['/', '\\\\']).next().unwrap_or(executable);", '''    // Never treat a workspace executable named echo/pwd as a native diagnostic.
    if executable.contains(['/', '\\\\', ':']) {
        return false;
    }
    let base_name = executable.as_str();''')
    return text


def approval(text: str) -> str:
    return exact(text, "_ => Self::AutoWorkspace,", "_ => Self::Ask,")


OAUTH_METHODS = r'''    pub fn with_redirect_uris(mut self, redirect_uris: Vec<String>) -> Result<Self, String> {
        if redirect_uris.is_empty() || redirect_uris.len() > 16 {
            return Err("Configure 1–16 exact OAuth callback URLs from the client settings".into());
        }
        if redirect_uris.iter().any(|uri| !valid_redirect_uri(uri)) {
            return Err("OAuth callbacks require exact HTTPS URLs (or explicit loopback HTTP URLs), without credentials, fragments, or wildcards".into());
        }
        self.redirect_uris = redirect_uris;
        Ok(self)
    }

    pub fn redirect_uri_allowed(&self, redirect_uri: &str) -> bool {
        valid_redirect_uri(redirect_uri)
            && self.redirect_uris.iter().any(|registered| registered == redirect_uri)
    }

    pub fn credentials_valid(&self) -> bool {
        !self.profile_id.trim().is_empty()
            && !self.client_id.trim().is_empty()
            && !self.password.trim().is_empty()
            && self.token_secret.len() >= 32
            && self.client_secret.as_ref().is_none_or(|secret| !secret.trim().is_empty())
    }

    fn allow_login_attempt(&self) -> bool {
        // One bounded, shared bucket per OAuth runtime; never trust forwarded IP headers.
        let Ok(mut window) = self.login_window.lock() else { return false; };
        let now = std::time::Instant::now();
        if now.duration_since(window.0).as_secs() >= 60 {
            *window = (now, 0);
        }
        if window.1 >= 30 { return false; }
        window.1 += 1;
        true
    }
'''

OAUTH_HELPERS = r'''fn valid_redirect_uri(value: &str) -> bool {
    if value.is_empty() || value.len() > 2048
        || value.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        || value.contains(['\\', '*'])
    {
        return false;
    }
    let Ok(uri) = url::Url::parse(value) else { return false; };
    if !uri.username().is_empty() || uri.password().is_some() || uri.fragment().is_some() {
        return false;
    }
    match uri.scheme() {
        "https" => uri.host_str().is_some(),
        "http" => matches!(uri.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1")),
        _ => false,
    }
}

fn valid_pkce_challenge(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD.decode(value).is_ok_and(|decoded| decoded.len() == 32)
}

fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response.headers_mut().insert("cache-control", axum::http::HeaderValue::from_static("no-store"));
    response.headers_mut().insert("pragma", axum::http::HeaderValue::from_static("no-cache"));
    response
}

pub async fn security_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut response = no_store(next.run(request).await);
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"),
    ] {
        response.headers_mut().insert(name, axum::http::HeaderValue::from_static(value));
    }
    response
}

'''


def oauth(text: str) -> str:
    text = exact(text, "    pending: Arc<Mutex<HashMap<String, PendingCode>>>,", "    pending: Arc<Mutex<HashMap<String, PendingCode>>>,\n    redirect_uris: Vec<String>,\n    login_window: Arc<Mutex<(std::time::Instant, u32)>>,")
    text = exact(text, "            pending: Arc::new(Mutex::new(HashMap::new())),", "            pending: Arc::new(Mutex::new(HashMap::new())),\n            redirect_uris: Vec::new(),\n            login_window: Arc::new(Mutex::new((std::time::Instant::now(), 0))),")
    text = between(text, "    pub fn redirect_uri_allowed(", "    pub fn verify_access_token(", OAUTH_METHODS)
    text = exact(text, '    pub fn verify_access_token(&self, token: &str, _server_url: &str) -> bool {', '''    pub fn verify_access_token(&self, token: &str, _server_url: &str) -> bool {
        if !self.credentials_valid() || token.is_empty() || token.len() > 8192 {
            return false;
        }''')
    text = exact(text, '        .map(|decoded| constant_time_eq_str(&decoded.claims.wid, &self.profile_id))', '''        .map(|decoded| {
            constant_time_eq_str(&decoded.claims.wid, &self.profile_id)
                && decoded.claims.scope.split_whitespace().any(|scope| scope == "mcp")
        })''')
    text = exact(text, "pub fn verify_oauth_bearer_header(", OAUTH_HELPERS + "pub fn verify_oauth_bearer_header(")
    text = exact(text, "    let Some(header_value) = headers.get(AUTHORIZATION) else {", '''    if headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return Some((StatusCode::UNAUTHORIZED, "Expected one Authorization header").into_response());
    }
    let Some(header_value) = headers.get(AUTHORIZATION) else {''')
    text = exact(text, '''    if params.response_type != "code" {''', '''    if !oauth.credentials_valid() {
        return html_error("OAuth credentials are incomplete; repair them in the desktop app", StatusCode::SERVICE_UNAVAILABLE);
    }
    if params.state.len() > 1024 || params.client_id.len() > 2048 {
        return html_error("OAuth request is too large", StatusCode::BAD_REQUEST);
    }
    if params.response_type != "code" {''')
    text = exact(text, 'params.code_challenge.is_empty()', '!valid_pkce_challenge(&params.code_challenge)')
    text = exact(text, 'form.code_challenge.is_empty()', '!valid_pkce_challenge(&form.code_challenge)')
    text = exact(text, 'pub fn authorize_post(oauth: &OAuthRuntime, form: AuthorizeForm, _server_url: &str) -> Response {', '''pub fn authorize_post(oauth: &OAuthRuntime, form: AuthorizeForm, _server_url: &str) -> Response {
    if !oauth.credentials_valid() {
        return html_error("OAuth credentials are incomplete; repair them in the desktop app", StatusCode::SERVICE_UNAVAILABLE);
    }
    if form.state.len() > 1024 || form.client_id.len() > 2048 || form.password.len() > 1024 {
        return html_error("OAuth request is too large", StatusCode::BAD_REQUEST);
    }''')
    text = exact(text, '    if !constant_time_eq_str(&form.password, &oauth.password) {', '''    if !oauth.allow_login_attempt() {
        return no_store((StatusCode::TOO_MANY_REQUESTS, [("retry-after", "60")], "Too many login attempts; retry after 60 seconds"));
    }
    if !constant_time_eq_str(&form.password, &oauth.password) {''')
    text = exact(text, '        let mut pending = oauth.pending.lock().expect("oauth pending lock");', '''        let Ok(mut pending) = oauth.pending.lock() else {
            return html_error("OAuth is temporarily unavailable", StatusCode::SERVICE_UNAVAILABLE);
        };''')
    start = text.index('pub fn token_exchange(')
    body = text.index(') -> Response {', start) + len(') -> Response {')
    text = text[:body] + '''
    if !oauth.credentials_valid() {
        return no_store((StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"error": "server_error", "error_description": "OAuth credentials are incomplete"}))));
    }
    if headers.get_all(AUTHORIZATION).iter().count() > 1 {
        return token_error("invalid_request", "Multiple authorization headers are not allowed");
    }
''' + text[body:]
    start = text.index('pub fn authorize_get(')
    end = text.index('pub fn authorize_post(', start)
    part = text[start:end]
    part = exact(part, 'workspace_path: Option<&str>', '_workspace_path: Option<&str>')
    part = exact(part, '        workspace_path,', '        None,')
    text = text[:start] + part + text[end:]
    start = text.index('fn token_success(')
    end = text.index('fn create_access_token(', start)
    part = text[start:end]
    part = exact(part, 'Ok(access_token) => (', 'Ok(access_token) => no_store((')
    part = exact(part, ')\n            .into_response()', '))')
    text = text[:start] + part + text[end:]
    start = text.index('fn create_access_token(')
    body = text.index('{', start) + 1
    text = text[:body] + '\n    if token_secret.len() < 32 { return Err(()); }\n' + text[body:]
    start = text.index('fn token_error(')
    end = text.index('fn html_error(', start)
    text = text[:start] + '''fn token_error(error: &str, description: &str) -> Response {
    no_store((StatusCode::BAD_REQUEST, axum::Json(json!({
        "error": error, "error_description": description
    }))))
}

''' + text[end:]
    text = exact(text, '''            "token-signing-secret-that-is-long-enough".into(),
        )''', '''            "token-signing-secret-that-is-long-enough".into(),
        ).with_redirect_uris(vec![
            "https://chatgpt.com/connector/oauth/test".into(),
            "https://chatgpt.com/aip/oauth/callback".into(),
            "http://127.0.0.1:53682/callback".into(),
            "http://localhost:53682/callback".into(),
        ]).expect("register exact fixture callbacks")''')
    text = exact(text, '''            "local-test-signing-secret-with-at-least-32-bytes".into(),
        )''', '''            "local-test-signing-secret-with-at-least-32-bytes".into(),
        ).with_redirect_uris(vec![
            "https://chatgpt.com/connector_platform/oauth/callback".into(),
        ]).expect("register an exact callback fixture")''')
    return text


def models(text: str) -> str:
    text = exact(text, '    pub oauth_client_id: String,', '    pub oauth_client_id: String,\n    #[serde(default)]\n    pub oauth_redirect_uris: Vec<String>,', 2)
    text = exact(text, '            oauth_client_id: default_oauth_client_id(),', '            oauth_client_id: default_oauth_client_id(),\n            oauth_redirect_uris: Vec::new(),', 2)
    return text


WORKERS = r'''fn tool_worker_slots() -> &'static Arc<tokio::sync::Semaphore> {
    static WORKERS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    WORKERS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(16)))
}

'''


def mcp(text: str) -> str:
    text = exact(text, '            token_secret,\n        )))', '''            token_secret,
        ).with_redirect_uris(auth.oauth_redirect_uris.clone())?))''')
    text = exact(text, '    let state = ListenerState {', '''    if oauth.as_ref().is_some_and(|runtime| !runtime.credentials_valid()) {
        return Err("OAuth requires a password and a signing key of at least 32 bytes".into());
    }
    let state = ListenerState {''')
    text = exact(text, '        .with_state(state)', '        .layer(axum::middleware::from_fn(crate::auth::oauth_flow::security_headers))\n        .with_state(state)')
    text = exact(text, '    let result = tokio::task::spawn_blocking(move || handle_request(&mcp, &body)).await;', '''    let Ok(permit) = tool_worker_slots().clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response();
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        handle_request(&mcp, &body)
    }).await;''')
    text = exact(text, 'async fn mcp_post(', WORKERS + 'async fn mcp_post(')
    return text


def actions(text: str) -> str:
    text = exact(text, '    oauth_client_id: String,', '    oauth_client_id: String,\n    oauth_redirect_uris: Vec<String>,')
    text = exact(text, '            oauth_token_secret.unwrap_or_default(),\n        )))', '''            oauth_token_secret.unwrap_or_default(),
        ).with_redirect_uris(oauth_redirect_uris)?))''')
    text = exact(text, '    let listener = bind_listener(actions_port)?;', '''    if oauth.as_ref().is_some_and(|runtime| !runtime.credentials_valid()) {
        return Err("OAuth requires a password and a signing key of at least 32 bytes".into());
    }
    let listener = bind_listener(actions_port)?;''')
    text = exact(text, '        .with_state(state)', '        .layer(axum::middleware::from_fn(crate::auth::oauth_flow::security_headers))\n        .with_state(state)')
    start = text.index('    let structured = if tools::registry::MUTATING_TOOLS')
    end = text.index('\n    let ', start + len('    let structured = '))
    text = text[:start] + '''    let Ok(permit) = tool_worker_slots().clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response();
    };
    let guard = if tools::registry::MUTATING_TOOLS.contains(&tool_name.as_str()) {
        Some(state.write_lock.clone().lock_owned().await)
    } else { None };
    let ctx = Arc::clone(&state.ctx);
    let tool = tool_name.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _guard = guard;
        tools::call_tool(ctx.as_ref(), &tool, &arguments)
    }).await;
    let structured = match result {
        Ok(structured) => structured,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Tool worker failed; verify operation state before retrying").into_response(),
    };
''' + text[end:]
    text = exact(text, 'async fn execute_action(', WORKERS + 'async fn execute_action(')
    text = exact(text, '"workspace": state.workspace_path,', '"workspace": if state.workspace_path.is_empty() { "unconfigured" } else { "configured" },')
    return text


def supervisor(text: str) -> str:
    return exact(text, '                    profile.actions.oauth_client_id.clone(),', '                    profile.actions.oauth_client_id.clone(),\n                    profile.actions.oauth_redirect_uris.clone(),')


def secrets(text: str) -> str:
    return between(text, '    pub fn get_or_regenerate(', '    pub fn get_app(', r'''    pub fn get_or_regenerate(
        profile_id: &str,
        key: &str,
        use_shared: bool,
    ) -> AppResult<String> {
        DataStore::update_file(|data| {
            let secrets = if use_shared {
                &mut data.shared_secrets
            } else {
                data.workspace_secrets.entry(profile_id.to_string()).or_default()
            };
            let value = secrets.entry(key.to_string()).or_default();
            if value.is_empty() {
                *value = random_secret();
            }
            Ok(value.clone())
        })
    }
''')


for path, transform in [
    ("src-tauri/src/tools/policy.rs", policy),
    ("src-tauri/src/tools/approval.rs", approval),
    ("src-tauri/src/auth/oauth_flow.rs", oauth),
    ("src-tauri/src/workspace/model.rs", models),
    ("src-tauri/src/mcp/listener.rs", mcp),
    ("src-tauri/src/actions/listener.rs", actions),
    ("src-tauri/src/runtime/supervisor.rs", supervisor),
    ("src-tauri/src/secret/keyring_store.rs", secrets),
]:
    update(path, transform)
print("Defense-in-depth production fixes applied with recoverable backups")

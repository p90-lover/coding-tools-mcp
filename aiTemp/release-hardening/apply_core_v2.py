from __future__ import annotations
from pathlib import Path
import shutil
import time

ROOT = Path.cwd().resolve()
BACKUP = ROOT / 'aiTemp/Trash/core-security-v2' / str(time.time_ns())

def checked(path: str) -> Path:
    relative = Path(path)
    if relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError(f'unsafe path: {path}')
    target = ROOT / relative
    for candidate in (target, *target.parents):
        if candidate == ROOT: break
        if candidate.is_symlink(): raise RuntimeError(f'refusing symlink: {candidate}')
    target.resolve().relative_to(ROOT)
    return target

def write(path: str, text: str) -> None:
    p = checked(path)
    if p.exists():
        if p.read_text(encoding='utf-8') == text: return
        target = BACKUP / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')

def read(path: str) -> str:
    return checked(path).read_text(encoding='utf-8')

def replace(text: str, before: str, after: str, count: int = 1) -> str:
    actual = text.count(before)
    if actual != count:
        raise RuntimeError(f'reviewed source mismatch: {before[:100]!r}, {actual} != {count}')
    return text.replace(before, after)

p = 'src-tauri/src/tools/policy.rs'; t = read(p)
t = replace(t, '            _ => Self::WorkspaceWrite,', '            _ => Self::ReadOnly,')
t = replace(t, '        _ => "on-request",', '        "on-request" | "auto-workspace" => "on-request",\n        _ => "ask",')
t = replace(t, '''        if read_only_command_allowed(command) {
            return Ok(());
        }''', '''        if network_command_pattern().is_match(command) {
            return Err(PolicyError("Network-looking commands are blocked by READ_ONLY_SANDBOX".into()));
        }
        if read_only_command_allowed(command) { return Ok(()); }''')
start = t.index('    let base_name = executable.rsplit', t.index('fn read_only_command_allowed'))
end = t.index('    match stem.as_str() {', start)
t = t[:start] + '''    // Match exact native builtins, not paths or executable suffixes.
    let stem = executable.to_ascii_lowercase();

''' + t[end:]
t = replace(t, '        "which" => parts.len() >= 2,', '        "which" => parts.len() == 2,')
write(p, t)
p = 'src-tauri/src/tools/approval.rs'
write(p, replace(read(p), '            _ => Self::AutoWorkspace,', '            _ => Self::Ask,'))

write('src-tauri/src/auth/redirects.rs', r'''//! Explicit per-workspace callback registration; requests cannot expand it.
pub const MAX_REDIRECT_URI_BYTES: usize = 2_048;
pub const MAX_REGISTERED_REDIRECT_URIS: usize = 32;

pub fn default_oauth_redirect_uris() -> Vec<String> {
    ["https://chatgpt.com/connector_platform/oauth/callback",
     "https://chatgpt.com/connector_platform_oauth_redirect"]
        .into_iter().map(str::to_owned).collect()
}

pub fn redirect_uri_syntax_allowed(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_REDIRECT_URI_BYTES
        || value.chars().any(|ch| ch.is_control() || ch.is_whitespace())
        || value.contains(['\\', '*']) { return false; }
    let Ok(uri) = url::Url::parse(value) else { return false; };
    if !uri.username().is_empty() || uri.password().is_some() || uri.fragment().is_some() { return false; }
    match uri.scheme() {
        "https" => uri.host().is_some(),
        "http" => match uri.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        },
        _ => false,
    }
}

pub fn validate_redirect_uris(uris: &[String]) -> Result<(), String> {
    if uris.is_empty() || uris.len() > MAX_REGISTERED_REDIRECT_URIS {
        return Err("Register 1 to 32 exact OAuth callback URLs in authentication settings".into());
    }
    if uris.iter().any(|uri| !redirect_uri_syntax_allowed(uri)) {
        return Err("OAuth callbacks require HTTPS (or explicitly registered loopback HTTP), without credentials, whitespace, fragments or wildcards; maximum 2048 bytes per URL".into());
    }
    Ok(())
}
''')
p = 'src-tauri/src/auth/mod.rs'
write(p, replace(read(p), 'mod refresh_tokens;', 'mod refresh_tokens;\nmod redirects;\npub use redirects::{default_oauth_redirect_uris, validate_redirect_uris};'))
p = 'src-tauri/src/auth/oauth_flow.rs'; t = read(p)
t = replace(t, 'use super::refresh_tokens::RefreshTokenStore;', '''use super::refresh_tokens::RefreshTokenStore;
use super::redirects::{default_oauth_redirect_uris, redirect_uri_syntax_allowed, validate_redirect_uris};''')
t = replace(t, 'pub const OAUTH_MAX_BODY_BYTES: usize = 8_192;', '''pub const OAUTH_MAX_BODY_BYTES: usize = 8_192;
const MIN_SIGNING_KEY_BYTES: usize = 32;
const MAX_TOKEN_BYTES: usize = 8_192;
const MAX_STATE_BYTES: usize = 2_048;''')
t = replace(t, '    pub token_secret: String,', '    pub token_secret: String,\n    redirect_uris: Vec<String>,')
t = replace(t, '            token_secret,\n            pending:', '            token_secret,\n            redirect_uris: default_oauth_redirect_uris(),\n            pending:')
start = t.index('    pub fn redirect_uri_allowed('); end = t.index('    pub fn verify_access_token(', start)
t = t[:start] + '''    pub fn with_redirect_uris(mut self, uris: Vec<String>) -> Result<Self, String> {
        validate_redirect_uris(&uris)?;
        self.redirect_uris = uris;
        Ok(self)
    }

    pub fn validate_configuration(&self) -> Result<(), String> {
        if self.profile_id.trim().is_empty() || self.client_id.trim().is_empty() || self.client_id.len() > 256 {
            return Err("OAuth profile or client ID is missing or too long".into());
        }
        if self.password.len() < 12 || self.password.len() > 4096 {
            return Err("OAuth authorization password must contain at least 12 bytes; regenerate it in authentication settings".into());
        }
        if !(MIN_SIGNING_KEY_BYTES..=4096).contains(&self.token_secret.len()) {
            return Err("OAuth signing key must contain at least 32 bytes; regenerate it in authentication settings".into());
        }
        if self.client_secret.as_deref().is_some_and(|secret| secret.trim().is_empty() || secret.len() > 4096) {
            return Err("OAuth client secret must be nonempty when confidential-client authentication is enabled".into());
        }
        validate_redirect_uris(&self.redirect_uris)
    }

    pub fn redirect_uri_allowed(&self, redirect_uri: &str) -> bool {
        redirect_uri_syntax_allowed(redirect_uri)
            && self.redirect_uris.iter().any(|registered| registered == redirect_uri)
    }

''' + t[end:]
t = replace(t, '    pub fn verify_access_token(&self, token: &str, _server_url: &str) -> bool {\n        let issuer', '''    pub fn verify_access_token(&self, token: &str, _server_url: &str) -> bool {
        if !(MIN_SIGNING_KEY_BYTES..=4096).contains(&self.token_secret.len())
            || token.is_empty() || token.len() > MAX_TOKEN_BYTES { return false; }
        let issuer''')
t = replace(t, '        let mut validation = Validation::new(Algorithm::HS256);', '''        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);''')
t = replace(t, '        .map(|decoded| constant_time_eq_str(&decoded.claims.wid, &self.profile_id))', '''        .map(|decoded| {
            constant_time_eq_str(&decoded.claims.wid, &self.profile_id)
                && decoded.claims.scope == "mcp"
                && decoded.claims.iat <= unix_now() as i64 + 30
                && decoded.claims.exp > decoded.claims.iat
        })''')
t = replace(t, '    let Some(header_value) = headers.get(AUTHORIZATION) else {', '''    if headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return Some((StatusCode::UNAUTHORIZED, "Exactly one Authorization header is required").into_response());
    }
    let Some(header_value) = headers.get(AUTHORIZATION) else {''')
t = replace(t, '    if params.response_type != "code" {', '''    if oauth.validate_configuration().is_err() {
        return html_error("OAuth configuration needs repair in the desktop app", StatusCode::SERVICE_UNAVAILABLE);
    }
    if params.state.len() > MAX_STATE_BYTES || params.client_id.len() > 256 {
        return html_error("Authorization parameters are too long", StatusCode::BAD_REQUEST);
    }
    if params.response_type != "code" {''')
t = replace(t, 'params.code_challenge_method != "S256" || params.code_challenge.is_empty()', 'params.code_challenge_method != "S256" || !valid_code_challenge(&params.code_challenge)')
t = replace(t, 'pub fn authorize_post(oauth: &OAuthRuntime, form: AuthorizeForm, _server_url: &str) -> Response {', '''pub fn authorize_post(oauth: &OAuthRuntime, form: AuthorizeForm, _server_url: &str) -> Response {
    if oauth.validate_configuration().is_err() {
        return html_error("OAuth configuration needs repair in the desktop app", StatusCode::SERVICE_UNAVAILABLE);
    }
    if form.state.len() > MAX_STATE_BYTES || form.client_id.len() > 256 || form.password.len() > 4096 {
        return html_error("Authorization parameters are too long", StatusCode::BAD_REQUEST);
    }''')
t = replace(t, 'form.code_challenge_method != "S256" || form.code_challenge.is_empty()', 'form.code_challenge_method != "S256" || !valid_code_challenge(&form.code_challenge)')
t = replace(t, '        let mut pending = oauth.pending.lock().expect("oauth pending lock");', '''        let Ok(mut pending) = oauth.pending.lock() else {
            return html_error("Authorization state is unavailable; restart the service", StatusCode::SERVICE_UNAVAILABLE);
        };''', 2)
idx = t.index('fn exchange_authorization_code(')
t = t[:idx] + t[idx:].replace('return html_error("Authorization state is unavailable; restart the service", StatusCode::SERVICE_UNAVAILABLE);', 'return token_error("server_error", "Authorization state is unavailable; restart the service");', 1)
t = replace(t, '''    if let Some((id, secret)) = basic_auth_credentials(headers) {
        if form.client_id.is_empty() {''', '''    if oauth.validate_configuration().is_err() {
        return token_error("server_error", "OAuth configuration needs repair in the desktop app");
    }
    if headers.get_all(AUTHORIZATION).iter().count() > 1
        || form.client_id.len() > 256 || form.client_secret.len() > 4096
        || form.code.len() > 256 || form.refresh_token.len() > MAX_TOKEN_BYTES {
        return token_error("invalid_request", "Ambiguous or oversized token request");
    }
    let credentials = basic_auth_credentials(headers);
    if headers.contains_key(AUTHORIZATION) && credentials.is_none() {
        return token_error("invalid_client", "Invalid HTTP client authentication");
    }
    if let Some((id, secret)) = credentials {
        if (!form.client_id.is_empty() && form.client_id != id)
            || (!form.client_secret.is_empty() && !constant_time_eq_str(&form.client_secret, &secret)) {
            return token_error("invalid_client", "Conflicting client credentials");
        }
        if form.client_id.is_empty() {''')
t = replace(t, '''        Ok(access_token) => (
            StatusCode::OK,''', '''        Ok(access_token) => (
            StatusCode::OK,
            [("cache-control", "no-store"), ("pragma", "no-cache")],''')
t = replace(t, '''    let now = unix_now() as i64;
    let claims = TokenClaims {''', '''    if !(MIN_SIGNING_KEY_BYTES..=4096).contains(&token_secret.len()) || ttl <= 0 { return Err(()); }
    let now = unix_now() as i64;
    let claims = TokenClaims {''')
t = replace(t, 'fn verify_pkce(code_verifier: &str, code_challenge: &str) -> bool {', '''fn valid_code_challenge(challenge: &str) -> bool {
    challenge.len() == 43 && URL_SAFE_NO_PAD.decode(challenge).is_ok_and(|bytes| bytes.len() == 32)
}

fn verify_pkce(code_verifier: &str, code_challenge: &str) -> bool {''')
t = replace(t, '    let encoded = header.strip_prefix("Basic ")?;', '    let encoded = header.strip_prefix("Basic ")?;\n    if encoded.len() > MAX_TOKEN_BYTES { return None; }')
t = replace(t, '''fn token_error(error: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,''', '''fn token_error(error: &str, description: &str) -> Response {
    (
        if error == "server_error" { StatusCode::INTERNAL_SERVER_ERROR } else { StatusCode::BAD_REQUEST },
        [("cache-control", "no-store"), ("pragma", "no-cache")],''')
t = replace(t, '''    (status, Html(format!("<h2>Error</h2><p>{message}</p>"))).into_response()''', '''    (status, [("cache-control", "no-store"), ("pragma", "no-cache")],
     Html(format!("<h2>Error</h2><p>{}</p>", html_escape(message)))).into_response()''')
t = replace(t, '''            "token-signing-secret-that-is-long-enough".into(),
        )''', '''            "token-signing-secret-that-is-long-enough".into(),
        ).with_redirect_uris(vec![
            "https://chatgpt.com/connector/oauth/test".into(),
            "https://chatgpt.com/aip/oauth/callback".into(),
            "http://127.0.0.1:53682/callback".into(),
            "http://localhost:53682/callback".into(),
        ]).expect("register exact test callbacks")''')
write(p, t)

p = 'src-tauri/src/auth/bearer.rs'; t = read(p)
t = replace(t, 'pub fn verify_bearer_header(headers: &HeaderMap, expected: &str) -> Option<Response> {', '''pub fn verify_bearer_header(headers: &HeaderMap, expected: &str) -> Option<Response> {
    if expected.trim().is_empty() || headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return Some((StatusCode::UNAUTHORIZED, "Bearer authentication is not configured or is ambiguous").into_response());
    }''')
t = replace(t, '    if !constant_time_eq_str(token, expected) {', '    if token.is_empty() || token.len() > 8192 || !constant_time_eq_str(token, expected) {')
write(p, t)
p = 'src-tauri/src/actions/auth.rs'; t = read(p)
t = replace(t, '        let Some(expected) = auth.api_key.as_ref() else {', '        let Some(expected) = auth.api_key.as_ref().filter(|key| !key.trim().is_empty()) else {')
t = replace(t, '        let Some(header_value) = request.headers().get(AUTHORIZATION) else {', '''        if request.headers().get_all(AUTHORIZATION).iter().count() != 1 {
            return (StatusCode::UNAUTHORIZED, "Exactly one Authorization header is required").into_response();
        }
        let Some(header_value) = request.headers().get(AUTHORIZATION) else {''')
t = replace(t, '        if !constant_time_eq(token.as_bytes(), expected.as_bytes()) {', '        if token.is_empty() || token.len() > 8192 || !constant_time_eq(token.as_bytes(), expected.as_bytes()) {')
write(p, t)

p = 'src-tauri/src/workspace/model.rs'; t = read(p)
t = replace(t, '    pub oauth_client_id: String,', '''    pub oauth_client_id: String,
    #[serde(default = "crate::auth::default_oauth_redirect_uris")]
    pub oauth_redirect_uris: Vec<String>,''', 2)
t = replace(t, '            oauth_client_id: default_oauth_client_id(),', '            oauth_client_id: default_oauth_client_id(),\n            oauth_redirect_uris: crate::auth::default_oauth_redirect_uris(),')
t = replace(t, '            oauth_client_id: default_actions_oauth_client_id(),', '            oauth_client_id: default_actions_oauth_client_id(),\n            oauth_redirect_uris: crate::auth::default_oauth_redirect_uris(),')
write(p, t)
p = 'src-tauri/src/mcp/listener.rs'; t = read(p)
t = replace(t, '    let workspace_display = workspace_path.display().to_string();', '''    if !matches!(auth.auth_type.as_str(), "noauth" | "bearer" | "oauth") {
        return Err("Unsupported MCP authentication type; refusing to start".into());
    }
    let workspace_display = workspace_path.display().to_string();''')
t = replace(t, '''        Some(Arc::new(OAuthRuntime::new(
            format!("{}:mcp", workspace_id),''', '''        let oauth = OAuthRuntime::new(
            format!("{}:mcp", workspace_id),''')
t = replace(t, '''            token_secret,
        )))''', '''            token_secret,
        ).with_redirect_uris(auth.oauth_redirect_uris.clone())?;
        oauth.validate_configuration()?;
        Some(Arc::new(oauth))''')
t = replace(t, '    if auth.oauth_enabled() && auth.oauth_client_id.trim().is_empty() {', '''    if auth.bearer_enabled() && bearer_token.as_deref().is_none_or(|token| token.trim().is_empty()) {
        return Err("MCP Bearer token is not configured".into());
    }
    if auth.oauth_enabled() && auth.oauth_client_id.trim().is_empty() {''')
t = replace(t, '''    if state.auth.oauth_enabled() {
        if let Some(oauth) = state.oauth.as_ref() {
            let server_url = resolve_oauth_base(state, headers);
            return verify_oauth_bearer_header(headers, oauth, &server_url);
        }
    }
    None''', '''    if state.auth.oauth_enabled() {
        if let Some(oauth) = state.oauth.as_ref() {
            let server_url = resolve_oauth_base(state, headers);
            return verify_oauth_bearer_header(headers, oauth, &server_url);
        }
    }
    if state.auth.auth_type == "noauth" { None } else {
        Some((StatusCode::SERVICE_UNAVAILABLE, "Authentication configuration is unavailable").into_response())
    }''')
write(p, t)
p = 'src-tauri/src/actions/listener.rs'; t = read(p)
t = replace(t, '    oauth_client_id: String,\n    oauth_client_secret:', '    oauth_client_id: String,\n    oauth_redirect_uris: Vec<String>,\n    oauth_client_secret:')
t = replace(t, '    if auth_type == "api_key" && api_key.as_ref().is_none_or(String::is_empty) {', '''    if !matches!(auth_type.as_str(), "none" | "api_key" | "oauth") {
        return Err("Unsupported Actions authentication type; refusing to start".into());
    }
    if auth_type == "api_key" && api_key.as_ref().is_none_or(|key| key.trim().is_empty()) {''')
t = replace(t, '''        Some(Arc::new(OAuthRuntime::new(
            format!("{workspace_id}:actions"),''', '''        let oauth = OAuthRuntime::new(
            format!("{workspace_id}:actions"),''')
t = replace(t, '''            oauth_token_secret.unwrap_or_default(),
        )))''', '''            oauth_token_secret.unwrap_or_default(),
        ).with_redirect_uris(oauth_redirect_uris)?;
        oauth.validate_configuration()?;
        Some(Arc::new(oauth))''')
write(p, t)
p = 'src-tauri/src/runtime/supervisor.rs'
write(p, replace(read(p), '                    profile.actions.oauth_client_id.clone(),', '                    profile.actions.oauth_client_id.clone(),\n                    profile.actions.oauth_redirect_uris.clone(),'))
p = 'src-tauri/src/commands/workspace.rs'
write(p, replace(read(p), "pub fn update_workspace(state: State<'_, AppState>, profile: WorkspaceProfile) -> AppResult<()> {", '''pub fn update_workspace(state: State<'_, AppState>, profile: WorkspaceProfile) -> AppResult<()> {
    if !matches!(profile.auth.auth_type.as_str(), "noauth" | "bearer" | "oauth")
        || !matches!(profile.actions.auth_type.as_str(), "none" | "api_key" | "oauth") {
        return Err(AppError::Message("Unsupported authentication type".into()));
    }
    if profile.auth.auth_type == "oauth" {
        crate::auth::validate_redirect_uris(&profile.auth.oauth_redirect_uris).map_err(AppError::Message)?;
    }
    if profile.actions.auth_type == "oauth" {
        crate::auth::validate_redirect_uris(&profile.actions.oauth_redirect_uris).map_err(AppError::Message)?;
    }'''))

for p in ['src/lib/components/RuntimePolicyForm.svelte', 'src/lib/components/ActionsPolicyForm.svelte']:
    t = replace(read(p), '''    return "workspace-write";
  }''', '''    if (value === "trusted" || value === "workspace-write") return "workspace-write";
    return "read-only";
  }''')
    if 'RuntimePolicy' in p:
        t = replace(t, '    { value: "on-request", label: "按需批准（Codex）" },', '    { value: "ask", label: "每次變更都詢問" },\n    { value: "on-request", label: "按需批准（Codex）" },')
        t = replace(t, '    return value === "never" ? "never" : "on-request";', '''    if (value === "never") return "never";
    if (value === "on-request" || value === "auto-workspace") return "on-request";
    return "ask";''')
    write(p, t)

write('src/lib/auth-config.ts', r'''export const DEFAULT_OAUTH_REDIRECT_URIS = [
  "https://chatgpt.com/connector_platform/oauth/callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];

/** Preserve exact spelling; never infer trusted callbacks from an incoming login. */
export function parseOAuthRedirectUris(text: string): string[] {
  const values = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  if (values.length === 0 || values.length > 32) {
    throw new Error("請登記 1 至 32 個完整 OAuth Callback URL，每行一個。");
  }
  for (const value of values) {
    let uri: URL;
    try { uri = new URL(value); } catch { throw new Error("OAuth Callback URL 格式無效。"); }
    const loopback = uri.hostname === "localhost" || uri.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(uri.hostname);
    if (new TextEncoder().encode(value).length > 2048 || /[\s\u0000-\u001f\u007f\\*]/.test(value)
      || uri.username || uri.password || uri.hash
      || (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback))) {
      throw new Error("Callback 必須使用 HTTPS；已登記的本機 loopback 可用 HTTP。不得含帳密、空白、fragment 或萬用字元。");
    }
  }
  return values;
}
''')
p = 'src/lib/types.ts'; t = 'import { DEFAULT_OAUTH_REDIRECT_URIS } from "./auth-config";\n\n' + read(p)
t = replace(t, '  oauth_client_id: string;', '  oauth_client_id: string;\n  oauth_redirect_uris?: string[];')
t = replace(t, '  oauth_client_id?: string;', '  oauth_client_id?: string;\n  oauth_redirect_uris?: string[];')
t = replace(t, '    auth_type: "api_key",', '    auth_type: "api_key",\n    oauth_redirect_uris: [...DEFAULT_OAUTH_REDIRECT_URIS],')
t = replace(t, '  oauthClientId: string;', '  oauthClientId: string;\n  oauthRedirectUris: string[];')
write(p, t)
p = 'src/lib/components/AuthConfigForm.svelte'; t = read(p)
t = replace(t, '<script lang="ts">', '<script lang="ts">\n  import { DEFAULT_OAUTH_REDIRECT_URIS, parseOAuthRedirectUris } from "$lib/auth-config";')
t = replace(t, '  let draft = $state<AuthConfig>', '  let draftRedirectUris = $state("");\n  let secretsLoadError = $state("");\n  let loadingSecrets = $state(true);\n  let draft = $state<AuthConfig>')
t = replace(t, '      draft.use_shared_secrets !== !!auth.use_shared_secrets ||', '      draftRedirectUris.trim() !== (auth.oauth_redirect_uris ?? DEFAULT_OAUTH_REDIRECT_URIS).join("\\n") ||\n      draft.use_shared_secrets !== !!auth.use_shared_secrets ||')
t = replace(t, '    draft = { type: auth.type, oauth_client_id: auth.oauth_client_id, use_shared_secrets: !!auth.use_shared_secrets };', '''    draft = { ...auth, use_shared_secrets: !!auth.use_shared_secrets };
    draftRedirectUris = (auth.oauth_redirect_uris ?? DEFAULT_OAUTH_REDIRECT_URIS).join("\\n");''')
t = replace(t, '    const seq = ++secretsLoadSeq;', '''    const seq = ++secretsLoadSeq;
    loadingSecrets = true;
    secretsLoadError = "";
    secrets = {};
    try {''')
t = replace(t, '    loadedSecrets = Object.fromEntries(loaded);\n  }', '''    loadedSecrets = Object.fromEntries(loaded);
    } catch (error) {
      if (seq === secretsLoadSeq) secretsLoadError = `讀取認證資料失敗：${String(error)}`;
    } finally {
      if (seq === secretsLoadSeq) loadingSecrets = false;
    }
  }''')
t = replace(t, '    if (saving || !dirty) return;', '    if (saving || !dirty || loadingSecrets || secretsLoadError) return;')
t = replace(t, '      await onSaveProfile({ ...draft }, { skipRuntimeRestart: sharedSecretChanged });', '''      const oauthRedirectUris = draft.type === "oauth"
        ? parseOAuthRedirectUris(draftRedirectUris) : (auth.oauth_redirect_uris ?? DEFAULT_OAUTH_REDIRECT_URIS);
      await onSaveProfile({ ...draft, oauth_redirect_uris: oauthRedirectUris }, { skipRuntimeRestart: sharedSecretChanged });''')
t = replace(t, '  {#if showOAuth}', '''  {#if secretsLoadError}
    <p role="alert" class="text-sm text-[var(--color-danger)]">{secretsLoadError}</p>
  {/if}

  {#if showOAuth}
    <label class="grid gap-1">
      <span class="text-xs text-[var(--color-text-muted)]">已登記的 OAuth Callback URL（每行一個）</span>
      <textarea rows="3" class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-xs" bind:value={draftRedirectUris} spellcheck="false" />
    </label>
    <p class="text-xs text-[var(--color-text-muted)]">從 ChatGPT 或其他用戶端複製完整 Callback URL。只接受精確匹配；不支援萬用字元，也不會自動信任登入請求提供的網址。</p>''')
t = replace(t, '      disabled={saving || !dirty}', '      disabled={saving || !dirty || loadingSecrets || !!secretsLoadError}')
write(p, t)
p = 'src/lib/components/ActionsAuthForm.svelte'; t = read(p)
t = replace(t, '<script lang="ts">', '<script lang="ts">\n  import { DEFAULT_OAUTH_REDIRECT_URIS, parseOAuthRedirectUris } from "$lib/auth-config";')
t = replace(t, '    oauthScopes: string;', '    oauthScopes: string;\n    oauthRedirectUris?: string[];')
t = replace(t, '    oauthScopes,', '    oauthScopes,\n    oauthRedirectUris = DEFAULT_OAUTH_REDIRECT_URIS,')
t = replace(t, '  let draftOauthScopes = $state("");', '  let draftOauthScopes = $state("");\n  let draftRedirectUris = $state("");\n  let secretsLoadError = $state("");')
t = replace(t, '      draftOauthScopes !== oauthScopes ||', '      draftOauthScopes !== oauthScopes ||\n      draftRedirectUris.trim() !== oauthRedirectUris.join("\\n") ||')
t = replace(t, '    draftOauthScopes = oauthScopes;', '    draftOauthScopes = oauthScopes;\n    draftRedirectUris = oauthRedirectUris.join("\\n");')
t = replace(t, '    const seq = ++secretsLoadSeq;', '    const seq = ++secretsLoadSeq;\n    secretsLoadError = "";')
t = replace(t, '      loadedOauthTokenSecret = tokenSecret ?? "";\n    } finally {', '''      loadedOauthTokenSecret = tokenSecret ?? "";
    } catch (error) {
      if (seq === secretsLoadSeq) {
        secretsLoadError = `讀取認證資料失敗：${String(error)}`;
        apiKey = oauthClientSecret = oauthPassword = oauthTokenSecret = "";
      }
    } finally {''')
t = replace(t, '    if (saving || !dirty) return;', '    if (saving || !dirty || loadingKey || secretsLoadError) return;')
t = replace(t, '        oauthScopes: draftOauthScopes.trim(),', '''        oauthScopes: draftOauthScopes.trim(),
        oauthRedirectUris: draftAuthType === "oauth" ? parseOAuthRedirectUris(draftRedirectUris) : oauthRedirectUris,''')
t = replace(t, '  {#if showApiKey}', '''  {#if secretsLoadError}
    <p role="alert" class="text-sm text-[var(--color-danger)]">{secretsLoadError}</p>
  {/if}

  {#if showApiKey}''')
t = replace(t, '  {:else if showOAuth}', '''  {:else if showOAuth}
    <label class="grid gap-1">
      <span class="text-xs text-[var(--color-text-muted)]">已登記的 OAuth Callback URL（每行一個）</span>
      <textarea rows="3" class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-xs" bind:value={draftRedirectUris} spellcheck="false" />
    </label>''')
t = replace(t, '''      GPT 编辑器会生成 Callback URL（<code>https://chatgpt.com/aip/g-…/oauth/callback</code>），无需在本应用配置。Token
      交换方式选默认即可。''', '''      將 GPT 編輯器顯示的完整 Callback URL 貼到上方清單並儲存。網址、路徑及參數必須精確匹配；不會自動信任未登記的 callback。''')
t = replace(t, '      disabled={saving || !dirty}', '      disabled={saving || !dirty || loadingKey || !!secretsLoadError}')
write(p, t)
p = 'src/routes/workspace/[id]/+page.svelte'; t = read(p)
t = replace(t, '        oauth_scopes: draft.oauthScopes,', '        oauth_scopes: draft.oauthScopes,\n        oauth_redirect_uris: draft.oauthRedirectUris,')
t = replace(t, '                oauthScopes={actions.oauth_scopes ?? ""}', '                oauthScopes={actions.oauth_scopes ?? ""}\n                oauthRedirectUris={actions.oauth_redirect_uris}')
write(p, t)
p = 'src-tauri/src/data/migrate.rs'; t = replace(read(p), 'use std::fs::{self, File};', 'use std::fs::{self, OpenOptions};')
t = replace(t, '        let mut file = File::create(&temp_path)?;', '''        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp_path)?;
        restrict_file_permissions(&temp_path)?;''')
write(p, t)
print('Reviewed core security and authentication UI integration applied with recoverable backups')

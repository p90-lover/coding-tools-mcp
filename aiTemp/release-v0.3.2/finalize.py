"""Apply reviewed finalization after the three native RED regressions."""
from pathlib import Path
import shutil
import time

ROOT = Path.cwd().resolve()
BACKUP = ROOT / 'aiTemp/Trash/finalization' / str(time.time_ns())

def write(rel, text):
    p = ROOT / rel
    p.resolve().relative_to(ROOT)
    if p.is_symlink():
        raise RuntimeError(f'refusing source symlink: {rel}')
    if p.exists():
        if p.read_text() == text:
            return
        b = BACKUP / rel
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, b)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')
    print('updated', rel)

def exact(text, old, new, count=1):
    if text.count(old) != count:
        raise RuntimeError(f'anchor count mismatch {text.count(old)} != {count}: {old[:100]!r}')
    return text.replace(old, new)

def replace_region(text, start, end, new):
    a = text.index(start)
    b = text.index(end, a + len(start))
    return text[:a] + new + '\n\n' + text[b:]

p = 'src-tauri/src/data/store.rs'
s = (ROOT / p).read_text()
s = exact(s, '    data: AppData,\n}', '    data: AppData,\n    baseline: serde_json::Value,\n}')
s = exact(s, '        let store = Self { data };', '        let baseline = serde_json::to_value(&data)?;\n        let store = Self { data, baseline };')
s = exact(s, '            store.persist_unlocked()?;', '            save(&store.data)?;')
s = exact(s, '        Ok(store)', '        crate::auth::sync_trusted_origins(&store.data);\n        Ok(store)')
s = exact(s, '''        let mut data = load_or_migrate()?;
        let result = f(&mut data)?;
        save(&data)?;
        Ok(result)''', '''        let mut data = load_or_migrate()?;
        let before = serde_json::to_value(&data)?;
        let result = f(&mut data)?;
        if serde_json::to_value(&data)? != before { save(&data)?; }
        crate::auth::sync_trusted_origins(&data);
        Ok(result)''')
s = replace_region(s, '    pub fn save(&self)', '    pub fn settings(', r'''    pub fn refresh(&mut self) -> AppResult<()> {
        let _guard = lock_data_file()?;
        let data = load_or_migrate()?;
        self.baseline = serde_json::to_value(&data)?;
        self.data = data;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }

    pub fn save(&mut self) -> AppResult<()> {
        let _guard = lock_data_file()?;
        let latest = load_or_migrate()?;
        let latest_value = serde_json::to_value(&latest)?;
        let local = serde_json::to_value(&self.data)?;
        let merged = match merge_local_changes(&self.baseline, &local, &latest_value) {
            Ok(value) => value,
            Err(error) => {
                self.baseline = latest_value;
                self.data = latest;
                return Err(error);
            }
        };
        let data: AppData = serde_json::from_value(merged.clone())?;
        if merged != latest_value { save(&data)?; }
        self.data = data;
        self.baseline = merged;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }''')
s = exact(s, 'fn lock_data_file()', r'''// Persist only locally changed fields. A stale UI snapshot must not erase
// background refresh-token rotation or credential generation.
fn merge_local_changes(
    base: &serde_json::Value,
    local: &serde_json::Value,
    latest: &serde_json::Value,
) -> AppResult<serde_json::Value> {
    if local == base { return Ok(latest.clone()); }
    if latest == base || latest == local { return Ok(local.clone()); }
    if let (Some(base), Some(local), Some(latest)) =
        (base.as_object(), local.as_object(), latest.as_object()) {
        let mut merged = latest.clone();
        let keys: std::collections::BTreeSet<_> = base.keys().chain(local.keys()).collect();
        for key in keys {
            let b = base.get(key);
            let l = local.get(key);
            let r = latest.get(key);
            if b == l { continue; }
            match (b, l, r) {
                (Some(b), Some(l), Some(r)) => { merged.insert(key.clone(), merge_local_changes(b, l, r)?); }
                (_, Some(value), _) if r == b || r == l => { merged.insert(key.clone(), value.clone()); }
                (_, None, _) if r == b => { merged.remove(key); }
                _ => return Err(concurrent_update_error()),
            }
        }
        return Ok(serde_json::Value::Object(merged));
    }
    Err(concurrent_update_error())
}

fn concurrent_update_error() -> AppError {
    AppError::Message("Configuration changed concurrently; reload settings and retry".into())
}

fn lock_data_file()''')
write(p, s)
p = 'src-tauri/src/app_state.rs'
s = (ROOT / p).read_text()
s = exact(s, '        f(&mut guard)', '        guard.refresh()?;\n        f(&mut guard)', 1) if s.count('        f(&mut guard)') == 1 else s.replace('        f(&mut guard)', '        guard.refresh()?;\n        f(&mut guard)', 1)
write(p, s)
p = 'src-tauri/src/secret/keyring_store.rs'
s = (ROOT / p).read_text()
s = replace_region(s, '    pub fn get_or_regenerate(', '    pub fn get_app(', r'''    pub fn get_or_regenerate(profile_id: &str, key: &str, use_shared: bool) -> AppResult<String> {
        DataStore::update_file(|data| {
            let secrets = if use_shared { &mut data.shared_secrets }
                else { workspace_secret_map(data, profile_id) };
            let value = secrets.entry(key.to_owned()).or_default();
            if value.is_empty() { *value = random_secret(); }
            Ok(value.clone())
        })
    }''')
write(p, s)

p = 'src-tauri/src/auth/oauth.rs'
s = (ROOT / p).read_text()
s = replace_region(s, '/// Resolve the external OAuth/MCP base URL', 'fn token_endpoint_auth_methods(', r'''// Request headers are untrusted; only desktop-managed configuration selects
// the issuer. Tunnel changes are propagated from the serialized data store.
type OriginMap = std::collections::HashMap<(String, bool), String>;
static TRUSTED_ORIGINS: std::sync::OnceLock<std::sync::RwLock<OriginMap>> = std::sync::OnceLock::new();

pub fn sync_trusted_origins(data: &crate::data::AppData) {
    let settings = crate::settings::AppSettings::from_data(data);
    let mut origins = OriginMap::new();
    for profile in &data.profiles {
        origins.insert((profile.id.clone(), false), profile.effective_public_url_with(&settings));
        origins.insert((profile.id.clone(), true), profile.actions_effective_public_url_with(&settings));
    }
    let lock = TRUSTED_ORIGINS.get_or_init(Default::default);
    if let Ok(mut current) = lock.write() { *current = origins; }
}

pub fn trusted_external_base_url(id: &str, actions: bool, port: u16, configured: &str) -> String {
    let lock = TRUSTED_ORIGINS.get_or_init(Default::default);
    let Ok(origins) = lock.read() else { return format!("http://127.0.0.1:{port}"); };
    let configured = origins.get(&(id.to_owned(), actions)).map(String::as_str).unwrap_or(configured);
    external_base_url(&HeaderMap::new(), port, configured)
}

pub fn external_base_url(_headers: &HeaderMap, bind_port: u16, configured_url: &str) -> String {
    let value = configured_url.trim_end_matches('/');
    if !value.is_empty() && value.len() <= 2048
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        && !value.contains('\\') {
        if let Ok(url) = url::Url::parse(value) {
            let loopback = match url.host() {
                Some(url::Host::Domain("localhost")) => true,
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            };
            if (url.scheme() == "https" || (url.scheme() == "http" && loopback))
                && url.host().is_some() && url.username().is_empty() && url.password().is_none()
                && url.query().is_none() && url.fragment().is_none() && url.path() == "/" {
                return url.origin().ascii_serialization();
            }
        }
    }
    format!("http://127.0.0.1:{bind_port}")
}''')
s = exact(s, 'fn external_base_url_uses_forwarded_host()', 'fn external_base_url_ignores_unregistered_forwarded_host()')
s = exact(s, 'fn external_base_url_uses_host_header()', 'fn external_base_url_ignores_unregistered_host_header()')
s = exact(s, 'external_base_url(&headers, 28767, ""),\n            "https://lb.frp-tx1.evwali.com"', 'external_base_url(&headers, 28767, ""),\n            "http://127.0.0.1:28767"', 2)
write(p, s)

p = 'src-tauri/src/auth/oauth_flow.rs'
s = (ROOT / p).read_text()
s = exact(s, '    pending: Arc<Mutex<HashMap<String, PendingCode>>>,', '    pending: Arc<Mutex<HashMap<String, PendingCode>>>,\n    consents: Arc<Mutex<HashMap<String, (String, u64)>>>,')
s = exact(s, '            pending: Arc::new(Mutex::new(HashMap::new())),', '            pending: Arc::new(Mutex::new(HashMap::new())),\n            consents: Arc::new(Mutex::new(HashMap::new())),')
s = exact(s, '    pub password: String,\n}', '    pub password: String,\n    #[serde(default)]\n    pub consent_nonce: String,\n}')
start = s.index('pub fn authorize_get(')
end = s.index('\npub fn authorize_post(', start)
a = s[start:end]
a = exact(a, 'workspace_path: Option<&str>', 'server_url: Option<&str>')
a = exact(a, '    Html(login_page(', r'''    let nonce = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let fingerprint = consent_fingerprint(&params.client_id, &params.redirect_uri,
        &params.code_challenge, &params.code_challenge_method, &params.state);
    {
        let Ok(mut pending) = oauth.consents.lock() else {
            return html_error("Authorization unavailable", StatusCode::SERVICE_UNAVAILABLE);
        };
        let now = unix_now();
        pending.retain(|_, (_, expires)| *expires > now);
        if pending.len() >= OAUTH_MAX_PENDING_CODES {
            return html_error("Too many pending consent pages", StatusCode::TOO_MANY_REQUESTS);
        }
        pending.insert(nonce.clone(), (fingerprint, now + OAUTH_CODE_TTL_SECONDS));
    }
    let page = login_page(''')
a = exact(a, '''        workspace_path,
    ))
    .into_response()''', r'''        None,
    );
    let page = page.replace("</form>", &format!("<input type='hidden' name='consent_nonce' value='{nonce}'></form>"));
    let mut response = super::http_security::secure_response(Html(page).into_response());
    let secure = if server_url.is_some_and(|url| url.starts_with("https://")) { "; Secure" } else { "" };
    let cookie = format!("{}={nonce}; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=300{secure}", consent_cookie_name(oauth));
    let Ok(cookie) = axum::http::HeaderValue::from_str(&cookie) else {
        return html_error("Authorization unavailable", StatusCode::SERVICE_UNAVAILABLE);
    };
    response.headers_mut().insert("set-cookie", cookie);
    response''')
s = s[:start] + a + s[end:]
s = exact(s, 'pub fn authorize_post(oauth:', 'fn authorize_post(oauth:')
s = exact(s, 'fn authorize_post(oauth:', r'''fn consent_cookie_name(oauth: &OAuthRuntime) -> String {
    let digest = hex::encode(Sha256::digest(oauth.profile_id.as_bytes()));
    format!("mcp_consent_{}", &digest[..16])
}

fn consent_fingerprint(client: &str, redirect: &str, challenge: &str, method: &str, state: &str) -> String {
    let mut hash = Sha256::new();
    for field in [client, redirect, challenge, method, state] {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
}

pub fn authorize_post_browser(oauth: &OAuthRuntime, headers: &HeaderMap, form: AuthorizeForm, server_url: &str) -> Response {
    let name = consent_cookie_name(oauth);
    let mut cookies = Vec::new();
    for header in headers.get_all("cookie") {
        let Ok(header) = header.to_str() else {
            return html_error("Invalid consent cookie", StatusCode::FORBIDDEN);
        };
        for item in header.split(';') {
            if let Some((key, value)) = item.trim().split_once('=') {
                if key == name { cookies.push(value); }
            }
        }
    }
    let nonce = &form.consent_nonce;
    if cookies.len() != 1 || nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
        || !constant_time_eq_str(cookies[0], nonce) {
        return html_error("Consent expired or missing. Return to the client and authorize again.", StatusCode::FORBIDDEN);
    }
    let fingerprint = consent_fingerprint(&form.client_id, &form.redirect_uri,
        &form.code_challenge, &form.code_challenge_method, &form.state);
    let consent = oauth.consents.lock().ok().and_then(|mut pending| pending.remove(nonce));
    if !consent.is_some_and(|(expected, expires)| expires > unix_now() && constant_time_eq_str(&expected, &fingerprint)) {
        return html_error("Consent expired or changed. Return to the client and authorize again.", StatusCode::FORBIDDEN);
    }
    let response = authorize_post(oauth, form, server_url);
    let response = if response.status() == StatusCode::SEE_OTHER { response } else {
        html_error("Authorization failed. Return to the client to retry.", response.status())
    };
    let mut response = super::http_security::secure_response(response);
    let secure = if server_url.starts_with("https://") { "; Secure" } else { "" };
    if let Ok(cookie) = axum::http::HeaderValue::from_str(&format!("{name}=; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=0{secure}")) {
        response.headers_mut().insert("set-cookie", cookie);
    }
    response
}

fn authorize_post(oauth:''')
s = exact(s, '            AuthorizeForm {', '            AuthorizeForm {\n                consent_nonce: String::new(),')
write(p, s)

# Shared admission control stays outside routing layers, with one process-wide
# budget and worker permits owned by the actual blocking tasks.
write('src-tauri/src/auth/http_security.rs', r'''use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use axum::{extract::{Request, State}, http::{HeaderValue, StatusCode}, middleware::Next, response::{IntoResponse, Response}};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone)]
pub struct HttpSecurity {
    workspace_id: String,
    actions: bool,
    port: u16,
    configured: String,
    slots: Arc<Semaphore>,
    login: Arc<Mutex<(Instant, u32)>>,
    token: Arc<Mutex<(Instant, u32)>>,
}

impl HttpSecurity {
    pub fn new(workspace_id: String, actions: bool, port: u16, configured: String, slots: usize) -> Self {
        Self { workspace_id, actions, port, configured, slots: Arc::new(Semaphore::new(slots)),
            login: Arc::new(Mutex::new((Instant::now(), 0))), token: Arc::new(Mutex::new((Instant::now(), 0))) }
    }
    fn allowed_origin(&self, origin: &str) -> bool {
        [format!("http://127.0.0.1:{}", self.port), format!("http://localhost:{}", self.port),
            super::trusted_external_base_url(&self.workspace_id, self.actions, self.port, &self.configured)]
            .iter().any(|allowed| origin == allowed)
    }
}

fn budget(window: &Mutex<(Instant, u32)>, limit: u32) -> bool {
    let Ok(mut window) = window.lock() else { return false; };
    if window.0.elapsed() >= Duration::from_secs(60) { *window = (Instant::now(), 0); }
    if window.1 >= limit { return false; }
    window.1 += 1;
    true
}

pub fn secure_response(mut response: Response) -> Response {
    for (name, value) in [
        ("cache-control", "no-store"), ("pragma", "no-cache"),
        ("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"),
    ] { response.headers_mut().insert(name, HeaderValue::from_static(value)); }
    response
}

pub fn acquire_tool_worker() -> Result<OwnedSemaphorePermit, Response> {
    static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    WORKERS.get_or_init(|| Arc::new(Semaphore::new(16))).clone().try_acquire_owned()
        .map_err(|_| secure_response((StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response()))
}

pub async fn guard(State(security): State<HttpSecurity>, request: Request, next: Next) -> Response {
    static REQUESTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let global = REQUESTS.get_or_init(|| Arc::new(Semaphore::new(128))).clone().try_acquire_owned();
    let local = security.slots.clone().try_acquire_owned();
    let (Ok(_global), Ok(_local)) = (global, local) else {
        return secure_response((StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Request capacity reached").into_response());
    };
    let origins = request.headers().get_all("origin");
    if origins.iter().count() > 1 || origins.iter().any(|value| !value.to_str().is_ok_and(|value| security.allowed_origin(value))) {
        return secure_response((StatusCode::FORBIDDEN, "Untrusted request origin").into_response());
    }
    let path = request.uri().path();
    let permitted = match path {
        "/oauth/authorize" => budget(&security.login, 30),
        "/oauth/token" => budget(&security.token, 120),
        _ => true,
    };
    if !permitted {
        return secure_response((StatusCode::TOO_MANY_REQUESTS, [("retry-after", "60")], "OAuth request rate exceeded").into_response());
    }
    let response = match tokio::time::timeout(Duration::from_secs(120), next.run(request)).await {
        Ok(response) => response,
        Err(_) => (StatusCode::REQUEST_TIMEOUT, "Request timed out; an accepted operation may still finish. Inspect state before retrying.").into_response(),
    };
    secure_response(response)
}
''')

p = 'src-tauri/src/auth/mod.rs'
s = (ROOT / p).read_text()
s = 'pub(crate) mod http_security;\n' + s
s = exact(s, '    authorize_get, authorize_post, token_exchange,', '    authorize_get, authorize_post_browser, token_exchange,')
s += '\npub(crate) use oauth::{sync_trusted_origins, trusted_external_base_url};\n'
write(p, s)

for p, actions in [('src-tauri/src/mcp/listener.rs', False), ('src-tauri/src/actions/listener.rs', True)]:
    s = (ROOT / p).read_text()
    s = exact(s, 'use std::time::Duration;\n', '')
    s = exact(s, 'use tower::limit::ConcurrencyLimitLayer;\nuse tower::ServiceBuilder;\nuse tower_http::timeout::TimeoutLayer;\n', '')
    s = exact(s, 'authorize_get, authorize_post, external_base_url,', 'authorize_get, authorize_post_browser, trusted_external_base_url,')
    s = exact(s, 'fn resolve_oauth_base(state: &'+('AppState' if actions else 'ListenerState')+', headers: &HeaderMap)', 'fn resolve_oauth_base(state: &'+('AppState' if actions else 'ListenerState')+', _headers: &HeaderMap)')
    s = exact(s, '    external_base_url(headers, state.bind_port, &state.configured_public_url)', f'    trusted_external_base_url(&state.workspace_id, {str(actions).lower()}, state.bind_port, &state.configured_public_url)')
    s = exact(s, '    authorize_get(oauth, params, Some(state.workspace_path.as_str()))', '    let base = resolve_oauth_base(&state, &HeaderMap::new());\n    authorize_get(oauth, params, Some(&base))')
    s = exact(s, '    authorize_post(oauth, form, &resolve_oauth_base(&state, &headers))', '    authorize_post_browser(oauth, &headers, form, &resolve_oauth_base(&state, &headers))')
    s = exact(s, '            get(oauth_authorize_get).post(oauth_authorize_post),', '            get(oauth_authorize_get).post(oauth_authorize_post).layer(DefaultBodyLimit::max(8192)),')
    s = exact(s, '.route("/oauth/token", post(oauth_token_post))', '.route("/oauth/token", post(oauth_token_post).layer(DefaultBodyLimit::max(8192)))')
    s = exact(s, '    let app = Router::new()', f'''    let security = crate::auth::http_security::HttpSecurity::new(
        state.workspace_id.clone(), {str(actions).lower()}, state.bind_port, state.configured_public_url.clone(), {32 if actions else 64});
    let app = Router::new()''')
    start = s.index('        .layer(\n            ServiceBuilder::new()')
    end = s.index('        .layer(DefaultBodyLimit::max(', start)
    s = s[:start]+s[end:]
    limit = '1024 * 1024' if actions else '4 * 1024 * 1024'
    s = exact(s, f'.layer(DefaultBodyLimit::max({limit}));', f'.layer(DefaultBodyLimit::max({limit}))\n        .layer(axum::middleware::from_fn_with_state(security, crate::auth::http_security::guard));')
    if actions:
        s = exact(s, '    workspace_path: String,', '    workspace_id: String,')
        s = exact(s, '        workspace_path: ctx.workspace_path(),', '        workspace_id: profile_id.to_string(),')
        s = exact(s, '        "workspace": state.workspace_path,', '        "workspace": "configured",')
        s = exact(s, '    Json(state.openapi.read().await.clone())', '''    let mut schema = state.openapi.read().await.clone();
    schema["servers"] = json!([{ "url": resolve_oauth_base(&state, &HeaderMap::new()) }]);
    Json(schema)''')
        s = replace_region(s, '    let structured = if tools::registry::MUTATING_TOOLS', '    let result = wrap_tool_result(structured);', r'''    let permit = match crate::auth::http_security::acquire_tool_worker() {
        Ok(permit) => permit, Err(response) => return response,
    };
    let guard = if tools::registry::MUTATING_TOOLS.contains(&tool_name.as_str()) {
        Some(state.write_lock.clone().lock_owned().await)
    } else { None };
    let ctx = Arc::clone(&state.ctx);
    let tool = tool_name.clone();
    let structured = match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _guard = guard;
        tools::call_tool(ctx.as_ref(), &tool, &arguments)
    }).await {
        Ok(value) => value,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Tool worker failed; inspect operation state before retrying").into_response(),
    };''')
    else:
        s = exact(s, '    workspace_path: String,\n', '')
        s = exact(s, '    let workspace_display = workspace_path.display().to_string();\n', '')
        s = exact(s, '        workspace_path: workspace_display,\n', '')
        s = exact(s, 'use axum::extract::{DefaultBodyLimit, Form, Query, State};', 'use axum::extract::{DefaultBodyLimit, Form, FromRequest, Query, State, Request};')
        s = exact(s, '''    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(response) = require_mcp_auth(&state, &headers) {
        return response;
    }''', '''    request: Request,
) -> Response {
    if let Some(response) = require_mcp_auth(&state, request.headers()) {
        return response;
    }
    let Json(body) = match Json::<Value>::from_request(request, &state).await {
        Ok(body) => body, Err(error) => return error.into_response(),
    };''')
        s = exact(s, '    let result = tokio::task::spawn_blocking(move || handle_request(&mcp, &body)).await;', '''    let permit = match crate::auth::http_security::acquire_tool_worker() {
        Ok(permit) => permit, Err(response) => return response,
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        handle_request(&mcp, &body)
    }).await;''')
        s = exact(s, '"retryable": true,', '"retryable": false,')
        s = exact(s, '"suggestion": "重试请求或重启 MCP 运行时"', '"suggestion": "先检查操作状态，再决定是否重试；已接受的操作可能仍会完成"')
    write(p, s)
print('Finalization applied; original source remains in aiTemp/Trash.')

# Update the existing source contract for the shared guard.
p = 'tests/security-hardening-contract.test.mjs'
s = (ROOT / p).read_text()
s = exact(s, '    assert.match(source, /ConcurrencyLimitLayer/);\n    assert.match(source, /TimeoutLayer/);', '    assert.match(source, /http_security::guard/);\n    assert.match(source, /http_security::acquire_tool_worker/);')
s = exact(s, 'test("patch deletion is reversible",', '''test("shared HTTP guard enforces admission, origins and timeout", async () => {
  const source = await read("src-tauri/src/auth/http_security.rs");
  assert.match(source, /try_acquire_owned/);
  assert.match(source, /tokio::time::timeout/);
  assert.match(source, /allowed_origin/);
  assert.match(source, /secure_response/);
});

test("patch deletion is reversible",''')
write(p, s)

# Prevent the desktop webview from loading remote executable content.
import json
p = 'src-tauri/tauri.conf.json'
config = json.loads((ROOT / p).read_text())
config['app']['security']['csp'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; frame-src 'none'"
config['app']['security']['devCsp'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1421; object-src 'none'; base-uri 'self'; frame-src 'none'"
write(p, json.dumps(config, ensure_ascii=False, indent=2) + '\n')

# A single grouped test validates independent admission and rate budgets.
p = 'src-tauri/src/auth/http_security.rs'
s = (ROOT / p).read_text() + r'''
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_finalization_admission_and_origins_are_bounded() {
        let guard = HttpSecurity::new("isolated-guard".into(), false, 28767, "https://trusted.example".into(), 2);
        assert!(guard.allowed_origin("https://trusted.example"));
        assert!(!guard.allowed_origin("https://trusted.example.attacker.invalid"));
        assert!(!guard.allowed_origin("null"));
        let first = guard.slots.clone().try_acquire_owned().unwrap();
        let second = guard.slots.clone().try_acquire_owned().unwrap();
        assert!(guard.slots.clone().try_acquire_owned().is_err());
        drop(first);
        assert!(guard.slots.clone().try_acquire_owned().is_ok());
        drop(second);
        for _ in 0..30 { assert!(budget(&guard.login, 30)); }
        assert!(!budget(&guard.login, 30));
        assert!(budget(&guard.token, 120));
    }
}
'''
write(p, s)

p = 'src-tauri/src/auth/oauth_flow.rs'
s = (ROOT / p).read_text() + r'''
#[cfg(test)]
mod consent_security_checks {
    use super::*;
    #[test]
    fn release_finalization_consent_rejects_tampering_and_replay() {
        let oauth = OAuthRuntime::new("consent-security".into(), "client".into(), None,
            "test-password-long-enough".into(), "test-signing-key-with-more-than-32-bytes".into());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(b"dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo"));
        let callback = "https://chatgpt.com/connector_platform_oauth_redirect";
        let render = || authorize_get(&oauth, AuthorizeParams {
            response_type: "code".into(), client_id: "client".into(), redirect_uri: callback.into(),
            code_challenge: challenge.clone(), code_challenge_method: "S256".into(), state: "original".into(),
        }, Some("https://trusted.example"));
        let form = |nonce: String, state: &str| AuthorizeForm {
            client_id: "client".into(), redirect_uri: callback.into(), code_challenge: challenge.clone(),
            code_challenge_method: "S256".into(), state: state.into(), password: "test-password-long-enough".into(), consent_nonce: nonce,
        };
        let response = render();
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.contains("HttpOnly") && cookie.contains("Secure") && cookie.contains("SameSite=Lax"));
        let pair = cookie.split(';').next().unwrap();
        let nonce = pair.split_once('=').unwrap().1.to_string();
        let mut headers = HeaderMap::new();
        headers.insert("cookie", pair.parse().unwrap());
        assert_eq!(authorize_post_browser(&oauth, &headers, form(nonce.clone(), "tampered"), "https://trusted.example").status(), StatusCode::FORBIDDEN);
        assert_eq!(authorize_post_browser(&oauth, &headers, form(nonce, "original"), "https://trusted.example").status(), StatusCode::FORBIDDEN);
        let response = render();
        let pair = response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap();
        let nonce = pair.split_once('=').unwrap().1.to_string();
        headers.insert("cookie", pair.parse().unwrap());
        assert_eq!(authorize_post_browser(&oauth, &headers, form(nonce.clone(), "original"), "https://trusted.example").status(), StatusCode::SEE_OTHER);
        assert_eq!(authorize_post_browser(&oauth, &headers, form(nonce, "original"), "https://trusted.example").status(), StatusCode::FORBIDDEN);
    }
}
'''
write(p, s)

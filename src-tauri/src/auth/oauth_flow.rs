use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::bearer::constant_time_eq_str;
use super::redirects::{
    default_oauth_redirect_uris, is_trusted_chatgpt_oauth_redirect, redirect_uri_syntax_allowed,
    validate_redirect_uris,
};
use super::refresh_tokens::RefreshTokenStore;

pub const OAUTH_CODE_TTL_SECONDS: u64 = 300;
pub const OAUTH_MAX_PENDING_CODES: usize = 256;
pub const OAUTH_TOKEN_TTL_SECONDS: i64 = 60 * 60;
#[allow(dead_code)]
pub const OAUTH_MAX_BODY_BYTES: usize = 8_192;
const MIN_SIGNING_KEY_BYTES: usize = 32;
const MAX_TOKEN_BYTES: usize = 8_192;
const MAX_STATE_BYTES: usize = 2_048;

#[derive(Clone)]
pub struct OAuthRuntime {
    profile_id: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub password: String,
    pub token_secret: String,
    redirect_uris: Vec<String>,
    refresh_tokens: RefreshTokenStore,
    pending: Arc<Mutex<HashMap<String, PendingCode>>>,
    consents: Arc<Mutex<HashMap<String, (String, u64)>>>,
}

#[derive(Clone)]
#[allow(dead_code)]
struct PendingCode {
    code_challenge: String,
    client_id: String,
    redirect_uri: String,
    state: String,
    expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenClaims {
    iss: String,
    aud: String,
    wid: String,
    iat: i64,
    exp: i64,
    scope: String,
}

impl OAuthRuntime {
    pub fn new(
        profile_id: String,
        client_id: String,
        client_secret: Option<String>,
        password: String,
        token_secret: String,
    ) -> Self {
        Self {
            refresh_tokens: RefreshTokenStore::new(profile_id.clone()),
            profile_id,
            client_id,
            client_secret,
            password,
            token_secret,
            redirect_uris: default_oauth_redirect_uris(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            consents: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn issuer(&self) -> String {
        format!("urn:coding-tools-mcp:{}", self.profile_id)
    }

    pub fn client_id_allowed(&self, client_id: &str) -> bool {
        if client_id.is_empty() {
            return false;
        }
        if self.client_id.is_empty() {
            return false;
        }
        constant_time_eq_str(client_id, &self.client_id)
    }

    pub fn with_redirect_uris(mut self, uris: Vec<String>) -> Result<Self, String> {
        validate_redirect_uris(&uris)?;
        self.redirect_uris = uris;
        Ok(self)
    }

    pub fn validate_configuration(&self) -> Result<(), String> {
        if self.profile_id.trim().is_empty()
            || self.client_id.trim().is_empty()
            || self.client_id.len() > 256
        {
            return Err("OAuth profile or client ID is missing or too long".into());
        }
        if self.password.len() < 12 || self.password.len() > 4096 {
            return Err("OAuth authorization password must contain at least 12 bytes; regenerate it in authentication settings".into());
        }
        if !(MIN_SIGNING_KEY_BYTES..=4096).contains(&self.token_secret.len()) {
            return Err("OAuth signing key must contain at least 32 bytes; regenerate it in authentication settings".into());
        }
        if self
            .client_secret
            .as_deref()
            .is_some_and(|secret| secret.trim().is_empty() || secret.len() > 4096)
        {
            return Err("OAuth client secret must be nonempty when confidential-client authentication is enabled".into());
        }
        validate_redirect_uris(&self.redirect_uris)
    }

    pub fn redirect_uri_allowed(&self, redirect_uri: &str) -> bool {
        if !redirect_uri_syntax_allowed(redirect_uri) {
            return false;
        }
        if self
            .redirect_uris
            .iter()
            .any(|registered| registered == redirect_uri)
        {
            return true;
        }
        // ChatGPT rotates the callback id on every Connect; exact profile lists go stale.
        is_trusted_chatgpt_oauth_redirect(redirect_uri)
    }

    pub fn verify_access_token(&self, token: &str, _server_url: &str) -> bool {
        if !(MIN_SIGNING_KEY_BYTES..=4096).contains(&self.token_secret.len())
            || token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
        {
            return false;
        }
        let issuer = self.issuer();
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);
        validation.set_audience(&[self.profile_id.as_str()]);
        validation.set_issuer(&[issuer.as_str()]);
        decode::<TokenClaims>(
            token,
            &DecodingKey::from_secret(self.token_secret.as_bytes()),
            &validation,
        )
        .map(|decoded| {
            constant_time_eq_str(&decoded.claims.wid, &self.profile_id)
                && decoded.claims.scope == "mcp"
                && decoded.claims.iat <= unix_now() as i64 + 30
                && decoded.claims.exp > decoded.claims.iat
        })
        .unwrap_or(false)
    }
}

pub fn verify_oauth_bearer_header(
    headers: &HeaderMap,
    oauth: &OAuthRuntime,
    server_url: &str,
) -> Option<Response> {
    if headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                "Exactly one Authorization header is required",
            )
                .into_response(),
        );
    }
    let Some(header_value) = headers.get(AUTHORIZATION) else {
        return Some((StatusCode::UNAUTHORIZED, "Missing Authorization header").into_response());
    };
    let Ok(header_str) = header_value.to_str() else {
        return Some((StatusCode::UNAUTHORIZED, "Invalid Authorization header").into_response());
    };
    let Some(token) = header_str.strip_prefix("Bearer ").map(str::trim) else {
        return Some((StatusCode::UNAUTHORIZED, "Invalid bearer token").into_response());
    };
    if oauth.verify_access_token(token, server_url) {
        None
    } else {
        Some((StatusCode::UNAUTHORIZED, "Invalid bearer token").into_response())
    }
}

#[derive(Debug, Deserialize)]
pub struct AuthorizeParams {
    pub response_type: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    #[serde(default)]
    pub state: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthorizeForm {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    #[serde(default)]
    pub state: String,
    pub password: String,
    #[serde(default)]
    pub consent_nonce: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct TokenForm {
    #[serde(default)]
    pub grant_type: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub redirect_uri: String,
    #[serde(default)]
    pub code_verifier: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub refresh_token: String,
}

pub fn authorize_get(
    oauth: &OAuthRuntime,
    params: AuthorizeParams,
    server_url: Option<&str>,
) -> Response {
    if oauth.validate_configuration().is_err() {
        return html_error(
            "OAuth configuration needs repair in the desktop app",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    }
    if params.state.len() > MAX_STATE_BYTES || params.client_id.len() > 256 {
        return html_error(
            "Authorization parameters are too long",
            StatusCode::BAD_REQUEST,
        );
    }
    if params.response_type != "code" {
        return html_error("response_type must be 'code'", StatusCode::BAD_REQUEST);
    }
    if !oauth.client_id_allowed(&params.client_id) {
        return html_error("Unknown client_id", StatusCode::BAD_REQUEST);
    }
    if !oauth.redirect_uri_allowed(&params.redirect_uri) {
        return html_error("redirect_uri is not allowed", StatusCode::BAD_REQUEST);
    }
    if params.code_challenge_method != "S256" || !valid_code_challenge(&params.code_challenge) {
        return html_error(
            "code_challenge_method must be S256 and code_challenge is required",
            StatusCode::BAD_REQUEST,
        );
    }
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let fingerprint = consent_fingerprint(
        &params.client_id,
        &params.redirect_uri,
        &params.code_challenge,
        &params.code_challenge_method,
        &params.state,
    );
    {
        let Ok(mut pending) = oauth.consents.lock() else {
            return html_error("Authorization unavailable", StatusCode::SERVICE_UNAVAILABLE);
        };
        let now = unix_now();
        pending.retain(|_, (_, expires)| *expires > now);
        if pending.len() >= OAUTH_MAX_PENDING_CODES {
            return html_error(
                "Too many pending consent pages",
                StatusCode::TOO_MANY_REQUESTS,
            );
        }
        pending.insert(nonce.clone(), (fingerprint, now + OAUTH_CODE_TTL_SECONDS));
    }
    let page = login_page(
        &params.client_id,
        &params.redirect_uri,
        &params.code_challenge,
        &params.code_challenge_method,
        &params.state,
        "",
        None,
    );
    let page = page.replace(
        "</form>",
        &format!("<input type='hidden' name='consent_nonce' value='{nonce}'></form>"),
    );
    let mut response = super::http_security::secure_response(Html(page).into_response());
    let secure = if server_url.is_some_and(|url| url.starts_with("https://")) {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{}={nonce}; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=300{secure}",
        consent_cookie_name(oauth)
    );
    let Ok(cookie) = axum::http::HeaderValue::from_str(&cookie) else {
        return html_error("Authorization unavailable", StatusCode::SERVICE_UNAVAILABLE);
    };
    response.headers_mut().insert("set-cookie", cookie);
    response
}

fn consent_cookie_name(oauth: &OAuthRuntime) -> String {
    let digest = format!("{:x}", Sha256::digest(oauth.profile_id.as_bytes()));
    format!("mcp_consent_{}", &digest[..16])
}

fn consent_fingerprint(
    client: &str,
    redirect: &str,
    challenge: &str,
    method: &str,
    state: &str,
) -> String {
    let mut hash = Sha256::new();
    for field in [client, redirect, challenge, method, state] {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

pub fn authorize_post_browser(
    oauth: &OAuthRuntime,
    headers: &HeaderMap,
    form: AuthorizeForm,
    server_url: &str,
) -> Response {
    let name = consent_cookie_name(oauth);
    let mut cookies = Vec::new();
    for header in headers.get_all("cookie") {
        let Ok(header) = header.to_str() else {
            return html_error("Invalid consent cookie", StatusCode::FORBIDDEN);
        };
        for item in header.split(';') {
            if let Some((key, value)) = item.trim().split_once('=') {
                if key == name {
                    cookies.push(value);
                }
            }
        }
    }
    let nonce = &form.consent_nonce;
    if cookies.len() != 1
        || nonce.len() != 64
        || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
        || !constant_time_eq_str(cookies[0], nonce)
    {
        return html_error(
            "Consent expired or missing. Return to the client and authorize again.",
            StatusCode::FORBIDDEN,
        );
    }
    let fingerprint = consent_fingerprint(
        &form.client_id,
        &form.redirect_uri,
        &form.code_challenge,
        &form.code_challenge_method,
        &form.state,
    );
    let consent = oauth
        .consents
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(nonce));
    if !consent.is_some_and(|(expected, expires)| {
        expires > unix_now() && constant_time_eq_str(&expected, &fingerprint)
    }) {
        return html_error(
            "Consent expired or changed. Return to the client and authorize again.",
            StatusCode::FORBIDDEN,
        );
    }
    let response = authorize_post(oauth, form, server_url);
    let response = if response.status() == StatusCode::SEE_OTHER {
        response
    } else {
        html_error(
            "Authorization failed. Return to the client to retry.",
            response.status(),
        )
    };
    let mut response = super::http_security::secure_response(response);
    let secure = if server_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    if let Ok(cookie) = axum::http::HeaderValue::from_str(&format!(
        "{name}=; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=0{secure}"
    )) {
        response.headers_mut().insert("set-cookie", cookie);
    }
    response
}

fn authorize_post(oauth: &OAuthRuntime, form: AuthorizeForm, _server_url: &str) -> Response {
    if oauth.validate_configuration().is_err() {
        return html_error(
            "OAuth configuration needs repair in the desktop app",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    }
    if form.state.len() > MAX_STATE_BYTES
        || form.client_id.len() > 256
        || form.password.len() > 4096
    {
        return html_error(
            "Authorization parameters are too long",
            StatusCode::BAD_REQUEST,
        );
    }
    if !oauth.client_id_allowed(&form.client_id) {
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
    if !oauth.redirect_uri_allowed(&form.redirect_uri) {
        return html_error("redirect_uri is not allowed", StatusCode::BAD_REQUEST);
    }
    if form.code_challenge_method != "S256" || !valid_code_challenge(&form.code_challenge) {
        return Html(login_page(
            &form.client_id,
            &form.redirect_uri,
            &form.code_challenge,
            &form.code_challenge_method,
            &form.state,
            "Invalid PKCE parameters",
            None,
        ))
        .into_response();
    }
    if !constant_time_eq_str(&form.password, &oauth.password) {
        return (
            StatusCode::UNAUTHORIZED,
            Html(login_page(
                &form.client_id,
                &form.redirect_uri,
                &form.code_challenge,
                &form.code_challenge_method,
                &form.state,
                "Invalid password",
                None,
            )),
        )
            .into_response();
    }

    let code = uuid::Uuid::new_v4().to_string().replace('-', "");
    let now = unix_now();
    {
        let Ok(mut pending) = oauth.pending.lock() else {
            return html_error(
                "Authorization state is unavailable; restart the service",
                StatusCode::SERVICE_UNAVAILABLE,
            );
        };
        pending.retain(|_, value| value.expires_at >= now);
        if pending.len() >= OAUTH_MAX_PENDING_CODES {
            return html_error(
                "Too many pending authorization requests",
                StatusCode::TOO_MANY_REQUESTS,
            );
        }
        pending.insert(
            code.clone(),
            PendingCode {
                code_challenge: form.code_challenge.clone(),
                client_id: form.client_id.clone(),
                redirect_uri: form.redirect_uri.clone(),
                state: form.state.clone(),
                expires_at: now + OAUTH_CODE_TTL_SECONDS,
            },
        );
    }

    let mut qs = format!("code={}", urlencoding_encode(&code));
    if !form.state.is_empty() {
        qs.push_str(&format!("&state={}", urlencoding_encode(&form.state)));
    }
    let sep = if form.redirect_uri.contains('?') {
        '&'
    } else {
        '?'
    };
    Redirect::to(&format!("{}{}{}", form.redirect_uri, sep, qs)).into_response()
}

pub fn token_exchange(
    oauth: &OAuthRuntime,
    headers: &HeaderMap,
    mut form: TokenForm,
    _server_url: &str,
) -> Response {
    if oauth.validate_configuration().is_err() {
        return token_error(
            "server_error",
            "OAuth configuration needs repair in the desktop app",
        );
    }
    if headers.get_all(AUTHORIZATION).iter().count() > 1
        || form.client_id.len() > 256
        || form.client_secret.len() > 4096
        || form.code.len() > 256
        || form.refresh_token.len() > MAX_TOKEN_BYTES
    {
        return token_error("invalid_request", "Ambiguous or oversized token request");
    }
    let credentials = basic_auth_credentials(headers);
    if headers.contains_key(AUTHORIZATION) && credentials.is_none() {
        return token_error("invalid_client", "Invalid HTTP client authentication");
    }
    if let Some((id, secret)) = credentials {
        if (!form.client_id.is_empty() && form.client_id != id)
            || (!form.client_secret.is_empty()
                && !constant_time_eq_str(&form.client_secret, &secret))
        {
            return token_error("invalid_client", "Conflicting client credentials");
        }
        if form.client_id.is_empty() {
            form.client_id = id;
        }
        if form.client_secret.is_empty() {
            form.client_secret = secret;
        }
    }

    if !oauth.client_id_allowed(&form.client_id) {
        return token_error("invalid_client", "Unknown client_id");
    }
    if let Some(expected) = oauth.client_secret.as_deref() {
        if !constant_time_eq_str(&form.client_secret, expected) {
            return token_error("invalid_client", "Invalid client_secret");
        }
    }

    match form.grant_type.as_str() {
        "authorization_code" => exchange_authorization_code(oauth, &form),
        "refresh_token" => exchange_refresh_token(oauth, &form),
        _ => token_error(
            "unsupported_grant_type",
            "Only authorization_code and refresh_token are supported",
        ),
    }
}

fn exchange_authorization_code(oauth: &OAuthRuntime, form: &TokenForm) -> Response {
    if form.code.is_empty() {
        return token_error("invalid_grant", "code is required");
    }
    if !valid_code_verifier(&form.code_verifier) {
        return token_error("invalid_grant", "Invalid code_verifier");
    }
    let code_data = {
        let Ok(mut pending) = oauth.pending.lock() else {
            return token_error(
                "server_error",
                "Authorization state is unavailable; restart the service",
            );
        };
        pending.remove(&form.code)
    };
    let Some(code_data) = code_data else {
        return token_error(
            "invalid_grant",
            "Unknown or already-used authorization code",
        );
    };
    if unix_now() > code_data.expires_at {
        return token_error("invalid_grant", "Authorization code expired");
    }
    if !constant_time_eq_str(&code_data.client_id, &form.client_id) {
        return token_error("invalid_grant", "client_id mismatch");
    }
    if !constant_time_eq_str(&code_data.redirect_uri, &form.redirect_uri) {
        return token_error("invalid_grant", "redirect_uri mismatch");
    }
    if !verify_pkce(&form.code_verifier, &code_data.code_challenge) {
        return token_error("invalid_grant", "PKCE verification failed");
    }

    let refresh_token = match oauth.refresh_tokens.issue(&form.client_id, unix_now()) {
        Ok(token) => token,
        Err(_) => return token_error("server_error", "Failed to persist refresh token"),
    };
    token_success(oauth, refresh_token)
}

fn exchange_refresh_token(oauth: &OAuthRuntime, form: &TokenForm) -> Response {
    if form.refresh_token.is_empty() {
        return token_error("invalid_grant", "refresh_token is required");
    }
    let rotated =
        match oauth
            .refresh_tokens
            .rotate(&form.refresh_token, &form.client_id, unix_now())
        {
            Ok(value) => value,
            Err(_) => return token_error("server_error", "Failed to rotate refresh token"),
        };
    let Some(refresh_token) = rotated else {
        return token_error(
            "invalid_grant",
            "Refresh token is invalid, expired, or already used",
        );
    };
    token_success(oauth, refresh_token)
}

fn token_success(oauth: &OAuthRuntime, refresh_token: String) -> Response {
    match create_access_token(
        &oauth.issuer(),
        &oauth.profile_id,
        &oauth.token_secret,
        OAUTH_TOKEN_TTL_SECONDS,
    ) {
        Ok(access_token) => (
            StatusCode::OK,
            [("cache-control", "no-store"), ("pragma", "no-cache")],
            axum::Json(json!({
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_type": "Bearer",
                "expires_in": OAUTH_TOKEN_TTL_SECONDS,
                "scope": "mcp"
            })),
        )
            .into_response(),
        Err(_) => token_error("server_error", "Failed to issue access token"),
    }
}

fn create_access_token(
    issuer: &str,
    profile_id: &str,
    token_secret: &str,
    ttl: i64,
) -> Result<String, ()> {
    if !(MIN_SIGNING_KEY_BYTES..=4096).contains(&token_secret.len()) || ttl <= 0 {
        return Err(());
    }
    let now = unix_now() as i64;
    let claims = TokenClaims {
        iss: issuer.to_string(),
        aud: profile_id.to_string(),
        wid: profile_id.to_string(),
        iat: now,
        exp: now + ttl,
        scope: "mcp".into(),
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(token_secret.as_bytes()),
    )
    .map_err(|_| ())
}

fn valid_code_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && URL_SAFE_NO_PAD
            .decode(challenge)
            .is_ok_and(|bytes| bytes.len() == 32)
}

fn verify_pkce(code_verifier: &str, code_challenge: &str) -> bool {
    let digest = Sha256::digest(code_verifier.as_bytes());
    let expected = URL_SAFE_NO_PAD.encode(digest);
    constant_time_eq_str(&expected, code_challenge)
}

fn valid_code_verifier(verifier: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~'))
}

fn basic_auth_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let encoded = header.strip_prefix("Basic ")?;
    if encoded.len() > MAX_TOKEN_BYTES {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let (id, secret) = text.split_once(':')?;
    Some((id.to_string(), secret.to_string()))
}

fn token_error(error: &str, description: &str) -> Response {
    (
        if error == "server_error" {
            StatusCode::INTERNAL_SERVER_ERROR
        } else {
            StatusCode::BAD_REQUEST
        },
        [("cache-control", "no-store"), ("pragma", "no-cache")],
        axum::Json(json!({
            "error": error,
            "error_description": description
        })),
    )
        .into_response()
}

fn html_error(message: &str, status: StatusCode) -> Response {
    (
        status,
        [("cache-control", "no-store"), ("pragma", "no-cache")],
        Html(format!("<h2>Error</h2><p>{}</p>", html_escape(message))),
    )
        .into_response()
}

fn login_page(
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    code_challenge_method: &str,
    state: &str,
    error: &str,
    workspace_path: Option<&str>,
) -> String {
    let error_block = if error.is_empty() {
        String::new()
    } else {
        format!("<p style=\"color:red\">{}</p>", html_escape(error))
    };
    let workspace_block = workspace_path
        .filter(|path| !path.is_empty())
        .map(|path| format!("<p>Workspace: <code>{}</code></p>", html_escape(path)))
        .unwrap_or_default();
    format!(
        "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>\
        <title>Authorize MCP Server</title>\
        <style>body{{font-family:sans-serif;max-width:380px;margin:4rem auto;padding:1rem}}\
        input{{width:100%;padding:.5rem;margin:.4rem 0;box-sizing:border-box}}\
        button{{width:100%;padding:.7rem;background:#0066cc;color:#fff;border:none;cursor:pointer}}</style>\
        </head><body>\
        <h2>Authorize Coding Tools MCP</h2>\
        {workspace_block}\
        <p>Client: <strong>{}</strong></p>\
        <p>Redirect URI: <code>{}</code></p>\
        {error_block}\
        <form method='POST' action='/oauth/authorize'>\
        <input type='hidden' name='client_id' value='{}'>\
        <input type='hidden' name='redirect_uri' value='{}'>\
        <input type='hidden' name='code_challenge' value='{}'>\
        <input type='hidden' name='code_challenge_method' value='{}'>\
        <input type='hidden' name='state' value='{}'>\
        <label>Password<input type='password' name='password' autocomplete='current-password' required></label>\
        <button type='submit'>Authorize</button>\
        </form></body></html>",
        html_escape(client_id),
        html_escape(redirect_uri),
        html_escape(client_id),
        html_escape(redirect_uri),
        html_escape(code_challenge),
        html_escape(code_challenge_method),
        html_escape(state),
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn urlencoding_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(profile_id: &str) -> OAuthRuntime {
        OAuthRuntime::new(
            profile_id.into(),
            "chatgpt-client-test".into(),
            None,
            "test-password".into(),
            "token-signing-secret-that-is-long-enough".into(),
        )
        .with_redirect_uris(vec![
            "https://chatgpt.com/connector/oauth/test".into(),
            "https://chatgpt.com/aip/oauth/callback".into(),
            "http://127.0.0.1:53682/callback".into(),
            "http://localhost:53682/callback".into(),
        ])
        .expect("register exact test callbacks")
    }

    #[test]
    fn token_exchange_without_client_secret() {
        let oauth = runtime(&format!("test-{}", uuid::Uuid::new_v4()));
        let verifier = "dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let redirect_uri = "https://chatgpt.com/connector/oauth/test";
        let redirect = authorize_post(
            &oauth,
            AuthorizeForm {
                consent_nonce: String::new(),
                client_id: "chatgpt-client-test".into(),
                redirect_uri: redirect_uri.into(),
                code_challenge: challenge,
                code_challenge_method: "S256".into(),
                state: "state".into(),
                password: "test-password".into(),
            },
            "https://old-tunnel.example.com",
        );
        assert_eq!(redirect.status(), StatusCode::SEE_OTHER);
        let code = {
            let pending = oauth.pending.lock().expect("lock");
            pending.keys().next().cloned().unwrap()
        };

        let response = token_exchange(
            &oauth,
            &HeaderMap::new(),
            TokenForm {
                grant_type: "authorization_code".into(),
                code,
                redirect_uri: redirect_uri.into(),
                code_verifier: verifier.into(),
                client_id: "chatgpt-client-test".into(),
                ..TokenForm::default()
            },
            "https://new-tunnel.example.com",
        );
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn access_token_remains_valid_when_public_tunnel_url_changes() {
        let oauth = runtime("workspace-stable:mcp");
        let token =
            create_access_token(&oauth.issuer(), &oauth.profile_id, &oauth.token_secret, 60)
                .expect("access token");
        assert!(oauth.verify_access_token(&token, "https://first.example.com"));
        assert!(oauth.verify_access_token(&token, "https://second.example.com"));

        let other = runtime("other-workspace:mcp");
        assert!(!other.verify_access_token(&token, "https://second.example.com"));
    }

    #[test]
    fn empty_configured_client_id_is_rejected() {
        let oauth = runtime("workspace:oauth");
        let empty = OAuthRuntime::new(
            "workspace:oauth".into(),
            String::new(),
            None,
            "password".into(),
            "token-secret".into(),
        );
        assert!(oauth.client_id_allowed("chatgpt-client-test"));
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

    #[test]
    fn pkce_round_trip() {
        let verifier = "dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert!(verify_pkce(verifier, &challenge));
    }
}

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
        assert!(!oauth.redirect_uri_allowed(
            "https://chatgpt.com.attacker.invalid/connector_platform/oauth/callback"
        ));
        assert!(oauth.redirect_uri_allowed("https://chatgpt.com/connector_platform/oauth/callback"));
        assert!(oauth.redirect_uri_allowed("https://chatgpt.com/connector/oauth/s3c1Lza4oLC"));
        assert!(oauth.redirect_uri_allowed("https://chatgpt.com/oauth/callback/connector/oauth/z3x1Lza4sDLC"));
        assert!(!oauth.redirect_uri_allowed("https://chatgpt.com/connector/oauth/evil/extra"));
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
        )
        .expect("construct weak-key regression fixture");
        assert!(!oauth.verify_access_token(&forged, "https://server.invalid"));
    }

    #[test]
    fn release_hardening_token_errors_are_not_cacheable() {
        let response = token_error("invalid_client", "test error");
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
        assert_eq!(
            response
                .headers()
                .get("pragma")
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );
    }
}

#[cfg(test)]
mod release_finalization_regressions {
    use super::*;
    #[test]
    fn release_finalization_browser_consent_sets_cookie() {
        let oauth = OAuthRuntime::new(
            "consent-test".into(),
            "client".into(),
            None,
            "test-password-long-enough".into(),
            "test-signing-key-with-more-than-32-bytes".into(),
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo",
        ));
        let response = authorize_get(
            &oauth,
            AuthorizeParams {
                response_type: "code".into(),
                client_id: "client".into(),
                redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect".into(),
                code_challenge: challenge,
                code_challenge_method: "S256".into(),
                state: "state".into(),
            },
            None,
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers().contains_key("set-cookie"),
            "browser consent must be bound to an HttpOnly cookie"
        );
    }
}

#[cfg(test)]
mod consent_security_checks {
    use super::*;
    #[test]
    fn release_finalization_consent_rejects_tampering_and_replay() {
        let oauth = OAuthRuntime::new(
            "consent-security".into(),
            "client".into(),
            None,
            "test-password-long-enough".into(),
            "test-signing-key-with-more-than-32-bytes".into(),
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo",
        ));
        let callback = "https://chatgpt.com/connector_platform_oauth_redirect";
        let render = || {
            authorize_get(
                &oauth,
                AuthorizeParams {
                    response_type: "code".into(),
                    client_id: "client".into(),
                    redirect_uri: callback.into(),
                    code_challenge: challenge.clone(),
                    code_challenge_method: "S256".into(),
                    state: "original".into(),
                },
                Some("https://trusted.example"),
            )
        };
        let form = |nonce: String, state: &str| AuthorizeForm {
            client_id: "client".into(),
            redirect_uri: callback.into(),
            code_challenge: challenge.clone(),
            code_challenge_method: "S256".into(),
            state: state.into(),
            password: "test-password-long-enough".into(),
            consent_nonce: nonce,
        };
        let response = render();
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert!(
            cookie.contains("HttpOnly")
                && cookie.contains("Secure")
                && cookie.contains("SameSite=Lax")
        );
        let pair = cookie.split(';').next().unwrap();
        let nonce = pair.split_once('=').unwrap().1.to_string();
        let mut headers = HeaderMap::new();
        headers.insert("cookie", pair.parse().unwrap());
        assert_eq!(
            authorize_post_browser(
                &oauth,
                &headers,
                form(nonce.clone(), "tampered"),
                "https://trusted.example"
            )
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            authorize_post_browser(
                &oauth,
                &headers,
                form(nonce, "original"),
                "https://trusted.example"
            )
            .status(),
            StatusCode::FORBIDDEN
        );
        let response = render();
        let pair = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let nonce = pair.split_once('=').unwrap().1.to_string();
        headers.insert("cookie", pair.parse().unwrap());
        assert_eq!(
            authorize_post_browser(
                &oauth,
                &headers,
                form(nonce.clone(), "original"),
                "https://trusted.example"
            )
            .status(),
            StatusCode::SEE_OTHER
        );
        assert_eq!(
            authorize_post_browser(
                &oauth,
                &headers,
                form(nonce, "original"),
                "https://trusted.example"
            )
            .status(),
            StatusCode::FORBIDDEN
        );
    }
}

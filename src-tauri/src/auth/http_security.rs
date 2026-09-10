use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
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
    pub fn new(
        workspace_id: String,
        actions: bool,
        port: u16,
        configured: String,
        slots: usize,
    ) -> Self {
        Self {
            workspace_id,
            actions,
            port,
            configured,
            slots: Arc::new(Semaphore::new(slots)),
            login: Arc::new(Mutex::new((Instant::now(), 0))),
            token: Arc::new(Mutex::new((Instant::now(), 0))),
        }
    }
    fn allowed_request_origin(
        &self,
        origin: &str,
        method: &axum::http::Method,
        path: &str,
    ) -> bool {
        // Browser OAuth entry is distinct from authorization to call MCP tools.
        // The consent handler still validates client, redirect, PKCE, password,
        // request-bound nonce and cookie. Never trust caller-supplied Host or Forwarded.
        self.allowed_origin(origin)
            || (path == "/oauth/authorize"
                && matches!(method.as_str(), "GET" | "POST")
                && matches!(
                    origin,
                    "https://chatgpt.com" | "https://chat.openai.com" | "https://www.chatgpt.com"
                ))
    }

    fn allowed_origin(&self, origin: &str) -> bool {
        [
            format!("http://127.0.0.1:{}", self.port),
            format!("http://localhost:{}", self.port),
            super::trusted_external_base_url(
                &self.workspace_id,
                self.actions,
                self.port,
                &self.configured,
            ),
        ]
        .iter()
        .any(|allowed| origin == allowed)
    }
}

fn budget(window: &Mutex<(Instant, u32)>, limit: u32) -> bool {
    let Ok(mut window) = window.lock() else {
        return false;
    };
    if window.0.elapsed() >= Duration::from_secs(60) {
        *window = (Instant::now(), 0);
    }
    if window.1 >= limit {
        return false;
    }
    window.1 += 1;
    true
}

// A response-only marker cannot be supplied by a request header. Only the OAuth
// handler calls this after validating the complete redirect URI against its policy.
#[derive(Clone)]
struct OAuthFormRedirect(HeaderValue);

pub(super) fn with_oauth_form_redirect(mut response: Response, callback: &url::Url) -> Response {
    if matches!(callback.scheme(), "https" | "http")
        && callback.host().is_some()
        && callback.username().is_empty()
        && callback.password().is_none()
        && callback.fragment().is_none()
    {
        // Serializing only the origin excludes query data, wildcards and header injection.
        let policy = format!("default-src 'none'; style-src 'unsafe-inline'; form-action 'self' {}; frame-ancestors 'none'; base-uri 'none'", callback.origin().ascii_serialization());
        if let Ok(policy) = HeaderValue::from_str(&policy) {
            response.extensions_mut().insert(OAuthFormRedirect(policy));
        }
    }
    secure_response(response)
}

pub fn secure_response(mut response: Response) -> Response {
    for (name, value) in [
        ("cache-control", "no-store"), ("pragma", "no-cache"),
        ("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"),
    ] { response.headers_mut().insert(name, HeaderValue::from_static(value)); }
    // The outer HTTP guard reapplies security headers; retain the trusted OAuth
    // form target without accepting a caller-provided CSP or widening other pages.
    if let Some(policy) = response
        .extensions()
        .get::<OAuthFormRedirect>()
        .map(|value| value.0.clone())
    {
        response
            .headers_mut()
            .insert("content-security-policy", policy);
    }
    response
}

pub fn acquire_tool_worker() -> Result<OwnedSemaphorePermit, Box<Response>> {
    static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    WORKERS
        .get_or_init(|| Arc::new(Semaphore::new(16)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            Box::new(secure_response(
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    [("retry-after", "1")],
                    "Tool worker capacity reached",
                )
                    .into_response(),
            ))
        })
}

pub async fn guard(State(security): State<HttpSecurity>, request: Request, next: Next) -> Response {
    static REQUESTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let global = REQUESTS
        .get_or_init(|| Arc::new(Semaphore::new(128)))
        .clone()
        .try_acquire_owned();
    let local = security.slots.clone().try_acquire_owned();
    let (Ok(_global), Ok(_local)) = (global, local) else {
        return secure_response(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [("retry-after", "1")],
                "Request capacity reached",
            )
                .into_response(),
        );
    };
    let path = request.uri().path();
    let origins = request.headers().get_all("origin");
    if origins.iter().count() > 1
        || origins.iter().any(|value| {
            !value
                .to_str()
                .is_ok_and(|value| security.allowed_request_origin(value, request.method(), path))
        })
    {
        return secure_response(
            (StatusCode::FORBIDDEN, "Untrusted request origin").into_response(),
        );
    }
    let permitted = match path {
        "/oauth/authorize" => budget(&security.login, 30),
        "/oauth/token" => budget(&security.token, 120),
        _ => true,
    };
    if !permitted {
        return secure_response(
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "60")],
                "OAuth request rate exceeded",
            )
                .into_response(),
        );
    }
    let response = match tokio::time::timeout(Duration::from_secs(120), next.run(request)).await {
        Ok(response) => response,
        Err(_) => (StatusCode::REQUEST_TIMEOUT, "Request timed out; an accepted operation may still finish. Inspect state before retrying.").into_response(),
    };
    secure_response(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_finalization_admission_and_origins_are_bounded() {
        let guard = HttpSecurity::new(
            "isolated-guard".into(),
            false,
            28767,
            "https://trusted.example".into(),
            2,
        );
        assert!(guard.allowed_origin("https://trusted.example"));
        assert!(!guard.allowed_origin("https://chatgpt.com"));
        assert!(guard.allowed_request_origin(
            "https://chatgpt.com",
            &axum::http::Method::GET,
            "/oauth/authorize"
        ));
        assert!(!guard.allowed_origin("https://unregistered.trycloudflare.com"));
        assert!(!guard.allowed_origin("https://trusted.example.attacker.invalid"));
        assert!(!guard.allowed_origin("null"));
        let first = guard.slots.clone().try_acquire_owned().unwrap();
        let second = guard.slots.clone().try_acquire_owned().unwrap();
        assert!(guard.slots.clone().try_acquire_owned().is_err());
        drop(first);
        assert!(guard.slots.clone().try_acquire_owned().is_ok());
        drop(second);
        for _ in 0..30 {
            assert!(budget(&guard.login, 30));
        }
        assert!(!budget(&guard.login, 30));
        assert!(budget(&guard.token, 120));
    }
}

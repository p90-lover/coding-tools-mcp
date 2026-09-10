//! Runs the actual HTTP guard. The terminal handler only marks successful admission.
use crate::auth::http_security::{guard, HttpSecurity};
use axum::{body::Body, http::{Request, StatusCode}, middleware, Router};
use tower::ServiceExt;

async fn admitted(method: &str, path: &str, origins: &[&str], host: &str) -> StatusCode {
    let app = Router::new().fallback(|| async { StatusCode::NO_CONTENT })
        .layer(middleware::from_fn_with_state(
            HttpSecurity::new("isolated-popup-policy".into(), false, 28888, "https://trusted.example".into(), 8), guard));
    let mut request = Request::builder().method(method).uri(path)
        .header("Host", host).header("X-Forwarded-Host", host)
        .header("Forwarded", format!("host={host};proto=https"));
    for origin in origins { request = request.header("Origin", *origin); }
    app.oneshot(request.body(Body::empty()).unwrap()).await.unwrap().status()
}

#[tokio::test]
async fn oauth_popup_origin_allows_authorization_entry_only() {
    for origin in ["https://chatgpt.com", "https://chat.openai.com", "https://www.chatgpt.com"] {
        assert_eq!(admitted("GET", "/oauth/authorize?response_type=code&state=fixture", &[origin], "trusted.example").await,
            StatusCode::NO_CONTENT, "POPUP_ORIGIN_BLOCKED: {origin}");
    }
    assert_eq!(admitted("POST", "/oauth/authorize", &["https://trusted.example"], "trusted.example").await, StatusCode::NO_CONTENT);
    assert_eq!(admitted("GET", "/oauth/authorize", &[], "trusted.example").await, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn oauth_popup_origin_must_not_trust_caller_selected_host() {
    for origin in ["https://attacker.invalid", "http://attacker.invalid", "https://chatgpt.com.attacker.invalid", "null", "https://chatgpt.com/", "https://chatgpt.com:444"] {
        let host = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://")).unwrap_or(origin);
        for path in ["/oauth/authorize", "/mcp"] {
            assert_eq!(admitted("GET", path, &[origin], host).await, StatusCode::FORBIDDEN,
                "HOST_MUST_NOT_SELECT_TRUST: {origin} {path}");
        }
    }
    assert_eq!(admitted("GET", "/oauth/authorize", &["https://chatgpt.com", "https://chatgpt.com"], "trusted.example").await, StatusCode::FORBIDDEN);
    assert_eq!(admitted("GET", "/oauth/authorize", &["https://chatgpt.com, https://attacker.invalid"], "trusted.example").await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn oauth_popup_origin_does_not_broaden_mcp_or_token_routes() {
    for path in ["/mcp", "/oauth/token", "/.well-known/oauth-protected-resource", "/actions/exec_command", "/oauth/authorize/extra"] {
        assert_eq!(admitted("POST", path, &["https://chatgpt.com"], "trusted.example").await, StatusCode::FORBIDDEN,
            "POPUP_EXCEPTION_ESCAPED_AUTH_ROUTE: {path}");
        assert_eq!(admitted("POST", path, &["https://trusted.example"], "trusted.example").await, StatusCode::NO_CONTENT);
        assert_eq!(admitted("POST", path, &[], "trusted.example").await, StatusCode::NO_CONTENT);
    }
}

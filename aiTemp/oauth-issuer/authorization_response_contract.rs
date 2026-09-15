use axum::http::{
    header::{COOKIE, LOCATION, SET_COOKIE},
    HeaderMap, StatusCode,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    authorization_server_metadata, authorize_get, authorize_post_browser, AuthorizeForm,
    AuthorizeParams, OAuthRuntime,
};

fn begin_consent(
    oauth: &OAuthRuntime,
    callback: &str,
    state: &str,
    issuer: &str,
) -> (HeaderMap, String, String) {
    let verifier = "dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let consent = authorize_get(
        oauth,
        AuthorizeParams {
            response_type: "code".into(),
            client_id: "chatgpt-client-test".into(),
            redirect_uri: callback.into(),
            code_challenge: challenge.clone(),
            code_challenge_method: "S256".into(),
            state: state.into(),
        },
        Some(issuer),
    );
    assert_eq!(consent.status(), StatusCode::OK);
    let cookie = consent
        .headers()
        .get(SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .expect("consent cookie");
    let cookie_pair = cookie.split(';').next().expect("cookie pair");
    let nonce = cookie_pair
        .split_once('=')
        .map(|(_, value)| value.to_string())
        .expect("consent nonce");
    let mut headers = HeaderMap::new();
    headers.insert(COOKIE, cookie_pair.parse().expect("cookie header"));
    (headers, nonce, challenge)
}

fn authorization_form(
    callback: &str,
    state: &str,
    nonce: String,
    challenge: String,
) -> AuthorizeForm {
    AuthorizeForm {
        client_id: "chatgpt-client-test".into(),
        redirect_uri: callback.into(),
        code_challenge: challenge,
        code_challenge_method: "S256".into(),
        state: state.into(),
        password: "test-password-long-enough".into(),
        consent_nonce: nonce,
    }
}

#[test]
fn authorization_response_identifies_the_public_issuer() {
    let oauth = OAuthRuntime::new(
        "authorization-response-issuer".into(),
        "chatgpt-client-test".into(),
        None,
        "test-password-long-enough".into(),
        "test-signing-secret-with-at-least-32-bytes".into(),
    );
    let callback = "https://chatgpt.com/connector_platform/oauth/callback";
    let issuer = "https://trusted.example";
    let (headers, nonce, challenge) = begin_consent(&oauth, callback, "state", issuer);

    let response = authorize_post_browser(
        &oauth,
        &headers,
        authorization_form(callback, "state", nonce, challenge),
        issuer,
    );
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .expect("authorization redirect");
    let redirect = url::Url::parse(location).expect("parse authorization redirect");
    let issuers: Vec<_> = redirect
        .query_pairs()
        .filter(|(key, _)| key == "iss")
        .map(|(_, value)| value.into_owned())
        .collect();

    assert_eq!(issuers, vec![issuer.to_string()]);
}

#[test]
fn authorization_response_preserves_registered_query_bytes() {
    let callback = concat!(
        "https://client.example/callback?flag&space=%20&slash=%2f&opaque=%FF",
        "&%69ss=https%3A%2F%2Fevil.example"
    );
    let oauth = OAuthRuntime::new(
        "authorization-response-query-bytes".into(),
        "chatgpt-client-test".into(),
        None,
        "test-password-long-enough".into(),
        "test-signing-secret-with-at-least-32-bytes".into(),
    )
    .with_redirect_uris(vec![callback.into()])
    .expect("register exact callback");
    let issuer = "https://trusted.example";
    let (headers, nonce, challenge) = begin_consent(&oauth, callback, "raw-state", issuer);

    let response = authorize_post_browser(
        &oauth,
        &headers,
        authorization_form(callback, "raw-state", nonce, challenge),
        issuer,
    );
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .expect("authorization redirect");

    assert!(location
        .starts_with("https://client.example/callback?flag&space=%20&slash=%2f&opaque=%FF&code="));
    assert!(!location.contains("evil.example"));
    let redirect = url::Url::parse(location).expect("parse authorization redirect");
    let issuers: Vec<_> = redirect
        .query_pairs()
        .filter(|(key, _)| key == "iss")
        .map(|(_, value)| value.into_owned())
        .collect();
    assert_eq!(issuers, vec![issuer.to_string()]);
}

#[test]
fn authorization_metadata_advertises_issuer_response_support() {
    let metadata = authorization_server_metadata("https://trusted.example", None);
    assert_eq!(
        metadata["authorization_response_iss_parameter_supported"],
        json!(true)
    );
}

#[test]
fn invalid_issuer_does_not_consume_the_one_time_consent() {
    let oauth = OAuthRuntime::new(
        "authorization-response-issuer-retry".into(),
        "chatgpt-client-test".into(),
        None,
        "test-password-long-enough".into(),
        "test-signing-secret-with-at-least-32-bytes".into(),
    );
    let callback = "https://chatgpt.com/connector_platform/oauth/callback";
    let issuer = "https://trusted.example";
    let (headers, nonce, challenge) = begin_consent(&oauth, callback, "retry-state", issuer);

    let invalid = authorize_post_browser(
        &oauth,
        &headers,
        authorization_form(callback, "retry-state", nonce.clone(), challenge.clone()),
        "https://trusted.example/not-an-origin",
    );
    assert_eq!(invalid.status(), StatusCode::SERVICE_UNAVAILABLE);

    let retry = authorize_post_browser(
        &oauth,
        &headers,
        authorization_form(callback, "retry-state", nonce, challenge),
        issuer,
    );
    assert_eq!(retry.status(), StatusCode::SEE_OTHER);
    let location = retry
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .expect("authorization redirect after retry");
    let redirect = url::Url::parse(location).expect("parse authorization redirect");
    let issuers: Vec<_> = redirect
        .query_pairs()
        .filter(|(key, _)| key == "iss")
        .map(|(_, value)| value.into_owned())
        .collect();
    assert_eq!(issuers, vec![issuer.to_string()]);
}

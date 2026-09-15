use axum::http::{
    header::{COOKIE, LOCATION, SET_COOKIE},
    HeaderMap, StatusCode,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

use super::{authorize_get, authorize_post_browser, AuthorizeForm, AuthorizeParams, OAuthRuntime};

#[test]
fn authorization_response_identifies_the_public_issuer() {
    let oauth = OAuthRuntime::new(
        "authorization-response-issuer".into(),
        "chatgpt-client-test".into(),
        None,
        "test-password-long-enough".into(),
        "test-signing-secret-with-at-least-32-bytes".into(),
    );
    let verifier = "dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let callback = "https://chatgpt.com/connector_platform/oauth/callback";
    let issuer = "https://trusted.example";

    let consent = authorize_get(
        &oauth,
        AuthorizeParams {
            response_type: "code".into(),
            client_id: "chatgpt-client-test".into(),
            redirect_uri: callback.into(),
            code_challenge: challenge.clone(),
            code_challenge_method: "S256".into(),
            state: "state".into(),
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

    let response = authorize_post_browser(
        &oauth,
        &headers,
        AuthorizeForm {
            client_id: "chatgpt-client-test".into(),
            redirect_uri: callback.into(),
            code_challenge: challenge,
            code_challenge_method: "S256".into(),
            state: "state".into(),
            password: "test-password-long-enough".into(),
            consent_nonce: nonce,
        },
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

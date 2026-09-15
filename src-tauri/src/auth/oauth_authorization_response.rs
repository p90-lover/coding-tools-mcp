use axum::{
    http::{header::LOCATION, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};

use super::oauth_flow::{self, AuthorizeForm, OAuthRuntime};

pub fn authorize_post_browser(
    oauth: &OAuthRuntime,
    headers: &HeaderMap,
    form: AuthorizeForm,
    server_url: &str,
) -> Response {
    let Some(issuer) = canonical_issuer(server_url) else {
        return invalid_issuer_response();
    };
    let response = oauth_flow::authorize_post_browser(oauth, headers, form, &issuer);
    with_authorization_server_issuer(response, &issuer)
}

fn with_authorization_server_issuer(mut response: Response, issuer: &str) -> Response {
    if response.status() != StatusCode::SEE_OTHER {
        return response;
    }

    let Some(location) = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
    else {
        return invalid_issuer_response();
    };
    let Ok(mut redirect) = url::Url::parse(location) else {
        return invalid_issuer_response();
    };

    // Registered callback URLs may already contain query parameters. Preserve
    // all of them except a caller-selected issuer, then append one trusted iss.
    let query: Vec<(String, String)> = redirect
        .query_pairs()
        .filter(|(key, _)| key != "iss")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    redirect.set_query(None);
    {
        let mut pairs = redirect.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(&key, &value);
        }
        pairs.append_pair("iss", issuer);
    }

    let Ok(location) = HeaderValue::from_str(redirect.as_str()) else {
        return invalid_issuer_response();
    };
    response.headers_mut().insert(LOCATION, location);
    response
}

fn canonical_issuer(server_url: &str) -> Option<String> {
    let candidate = server_url.trim_end_matches('/');
    if candidate.is_empty()
        || candidate.len() > 2_048
        || candidate
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }

    let parsed = url::Url::parse(candidate).ok()?;
    let loopback = match parsed.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        _ => false,
    };
    if !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback))
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    Some(parsed.origin().ascii_serialization())
}

fn invalid_issuer_response() -> Response {
    super::http_security::secure_response(
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "OAuth issuer configuration is invalid",
        )
            .into_response(),
    )
}

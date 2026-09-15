use axum::{
    http::{header::LOCATION, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;

use super::oauth_flow::{self, AuthorizeForm, OAuthRuntime};

pub fn authorization_server_metadata(base_url: &str, client_secret: Option<&str>) -> Value {
    let mut metadata = super::oauth::authorization_server_metadata(base_url, client_secret);
    if let Some(object) = metadata.as_object_mut() {
        object.insert(
            "authorization_response_iss_parameter_supported".into(),
            Value::Bool(true),
        );
    }
    metadata
}

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
    let Some(location) = append_authorization_server_issuer(location, issuer) else {
        return invalid_issuer_response();
    };
    let Ok(location) = HeaderValue::from_str(&location) else {
        return invalid_issuer_response();
    };
    response.headers_mut().insert(LOCATION, location);
    response
}

fn append_authorization_server_issuer(location: &str, issuer: &str) -> Option<String> {
    // Validate the generated redirect without serializing it again. Re-parsing
    // through query_pairs() would decode and re-encode a registered callback's
    // raw query bytes, which can invalidate signed or byte-sensitive callbacks.
    url::Url::parse(location).ok()?;

    let fragment_at = location.find('#').unwrap_or(location.len());
    let (head, fragment) = location.split_at(fragment_at);
    let (base, raw_query) = head.split_once('?').unwrap_or((head, ""));
    let segments: Vec<&str> = raw_query.split('&').collect();
    let has_untrusted_issuer = segments
        .iter()
        .any(|segment| query_segment_key_is_issuer(segment));
    let retained_query = if has_untrusted_issuer {
        segments
            .into_iter()
            .filter(|segment| !query_segment_key_is_issuer(segment))
            .collect::<Vec<_>>()
            .join("&")
    } else {
        raw_query.to_owned()
    };

    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("iss", issuer);
    let issuer_pair = serializer.finish();

    let mut result = String::with_capacity(
        base.len() + retained_query.len() + issuer_pair.len() + fragment.len() + 2,
    );
    result.push_str(base);
    result.push('?');
    if !retained_query.is_empty() {
        result.push_str(&retained_query);
        result.push('&');
    }
    result.push_str(&issuer_pair);
    result.push_str(fragment);
    Some(result)
}

fn query_segment_key_is_issuer(segment: &str) -> bool {
    let raw_key = segment
        .split_once('=')
        .map_or(segment, |(key, _value)| key);
    let bytes = raw_key.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len().min(4));
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                hexadecimal_nibble(bytes[index + 1]),
                hexadecimal_nibble(bytes[index + 2]),
            ) {
                decoded.push((high << 4) | low);
                index += 3;
                if decoded.len() > 3 {
                    return false;
                }
                continue;
            }
        }
        decoded.push(if byte == b'+' { b' ' } else { byte });
        index += 1;
        if decoded.len() > 3 {
            return false;
        }
    }
    decoded == b"iss"
}

fn hexadecimal_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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

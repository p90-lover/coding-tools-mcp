//! Explicit per-workspace callback registration; requests cannot expand it.
pub const MAX_REDIRECT_URI_BYTES: usize = 2_048;
pub const MAX_REGISTERED_REDIRECT_URIS: usize = 32;

pub fn default_oauth_redirect_uris() -> Vec<String> {
    [
        "https://chatgpt.com/connector_platform/oauth/callback",
        "https://chatgpt.com/connector_platform_oauth_redirect",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

pub fn redirect_uri_syntax_allowed(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_REDIRECT_URI_BYTES
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
        || value.contains(['\\', '*'])
    {
        return false;
    }
    let Ok(uri) = url::Url::parse(value) else {
        return false;
    };
    if !uri.username().is_empty() || uri.password().is_some() || uri.fragment().is_some() {
        return false;
    }
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

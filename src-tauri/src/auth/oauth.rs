use axum::http::HeaderMap;
use serde_json::{json, Value};

use crate::workspace::AuthConfig;

impl AuthConfig {
    pub fn oauth_enabled(&self) -> bool {
        self.auth_type == "oauth"
    }

    pub fn bearer_enabled(&self) -> bool {
        self.auth_type == "bearer"
    }

    pub fn auth_enabled(&self) -> bool {
        self.auth_type != "noauth"
    }
}

// Request headers are untrusted; only desktop-managed configuration selects
// the issuer. Tunnel changes are propagated from the serialized data store.
type OriginMap = std::collections::HashMap<(String, bool), String>;
static TRUSTED_ORIGINS: std::sync::OnceLock<std::sync::RwLock<OriginMap>> =
    std::sync::OnceLock::new();

// Data-store fixtures run on independent Rust test threads but production owns
// one process-wide store. Keep each fixture's latest synchronized view local to
// its thread so an unrelated parallel fixture cannot erase an in-flight HTTP
// flow's issuer. The production registry and behavior remain unchanged.
#[cfg(test)]
thread_local! {
    static TEST_TRUSTED_ORIGINS: std::cell::RefCell<Option<OriginMap>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_trusted_origin(id: &str, actions: bool) -> Option<Option<String>> {
    TEST_TRUSTED_ORIGINS.with(|current| {
        current
            .borrow()
            .as_ref()
            .map(|origins| origins.get(&(id.to_owned(), actions)).cloned())
    })
}

pub fn sync_trusted_origins(data: &crate::data::AppData) {
    let settings = crate::settings::AppSettings::from_data(data);
    let mut origins = OriginMap::new();
    for profile in &data.profiles {
        origins.insert(
            (profile.id.clone(), false),
            profile.effective_public_url_with(&settings),
        );
        origins.insert(
            (profile.id.clone(), true),
            profile.actions_effective_public_url_with(&settings),
        );
    }
    #[cfg(test)]
    TEST_TRUSTED_ORIGINS.with(|current| *current.borrow_mut() = Some(origins.clone()));
    let lock = TRUSTED_ORIGINS.get_or_init(Default::default);
    if let Ok(mut current) = lock.write() {
        *current = origins;
    }
}

pub fn trusted_external_base_url(id: &str, actions: bool, port: u16, configured: &str) -> String {
    #[cfg(test)]
    if let Some(test_configured) = test_trusted_origin(id, actions) {
        return external_base_url(
            &HeaderMap::new(),
            port,
            test_configured.as_deref().unwrap_or(configured),
        );
    }

    let lock = TRUSTED_ORIGINS.get_or_init(Default::default);
    let Ok(origins) = lock.read() else {
        return format!("http://127.0.0.1:{port}");
    };
    let configured = origins
        .get(&(id.to_owned(), actions))
        .map(String::as_str)
        .unwrap_or(configured);
    external_base_url(&HeaderMap::new(), port, configured)
}

pub fn external_base_url(_headers: &HeaderMap, bind_port: u16, configured_url: &str) -> String {
    let value = configured_url.trim_end_matches('/');
    if !value.is_empty()
        && value.len() <= 2048
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        && !value.contains('\\')
    {
        if let Ok(url) = url::Url::parse(value) {
            let loopback = match url.host() {
                Some(url::Host::Domain("localhost")) => true,
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            };
            if (url.scheme() == "https" || (url.scheme() == "http" && loopback))
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path() == "/"
            {
                return url.origin().ascii_serialization();
            }
        }
    }
    format!("http://127.0.0.1:{bind_port}")
}

fn token_endpoint_auth_methods(client_secret: Option<&str>) -> Vec<&'static str> {
    match client_secret {
        Some(secret) if !secret.is_empty() => {
            vec!["client_secret_post", "client_secret_basic"]
        }
        _ => vec!["none"],
    }
}

pub fn authorization_server_metadata(base_url: &str, client_secret: Option<&str>) -> Value {
    let base = base_url.trim_end_matches('/');
    let methods = token_endpoint_auth_methods(client_secret);
    json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        // OpenAI custom apps inspect authorization-server metadata before
        // requesting durable access. Advertise offline_access here, not in
        // protected-resource metadata, because it controls refresh issuance
        // rather than access to the MCP resource itself.
        "scopes_supported": ["mcp", "offline_access"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": methods,
    })
}

pub fn protected_resource_metadata(base_url: &str) -> Value {
    let base = base_url.trim_end_matches('/');
    json!({
        "resource": base,
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_enabled_only_for_oauth_type() {
        let mut auth = AuthConfig::default();
        assert!(auth.oauth_enabled());
        auth.auth_type = "bearer".into();
        assert!(!auth.oauth_enabled());
        auth.auth_type = "noauth".into();
        assert!(!auth.oauth_enabled());
    }

    #[test]
    fn authorization_metadata_includes_token_auth_methods() {
        let meta = authorization_server_metadata("https://example.com", None);
        assert_eq!(
            meta["token_endpoint_auth_methods_supported"],
            json!(["none"])
        );
        assert_eq!(
            meta["grant_types_supported"],
            json!(["authorization_code", "refresh_token"])
        );
        assert_eq!(meta["scopes_supported"], json!(["mcp", "offline_access"]));
        let meta = authorization_server_metadata("https://example.com", Some("secret"));
        assert_eq!(
            meta["token_endpoint_auth_methods_supported"],
            json!(["client_secret_post", "client_secret_basic"])
        );
    }

    #[test]
    fn protected_resource_metadata_lists_authorization_servers() {
        let meta = protected_resource_metadata("https://example.com");
        assert_eq!(
            meta["authorization_servers"],
            json!(["https://example.com"])
        );
        assert!(meta.get("scopes_supported").is_none());
    }

    #[test]
    fn external_base_url_prefers_configured_url() {
        let headers = HeaderMap::new();
        assert_eq!(
            external_base_url(&headers, 28767, "https://lb.frp-tx1.evwali.com"),
            "https://lb.frp-tx1.evwali.com"
        );
    }

    #[test]
    fn external_base_url_ignores_unregistered_forwarded_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "lb.frp-tx1.evwali.com".parse().unwrap());
        assert_eq!(
            external_base_url(&headers, 28767, ""),
            "http://127.0.0.1:28767"
        );
    }

    #[test]
    fn external_base_url_ignores_unregistered_host_header() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "lb.frp-tx1.evwali.com".parse().unwrap());
        assert_eq!(
            external_base_url(&headers, 28767, ""),
            "http://127.0.0.1:28767"
        );
    }

    #[test]
    fn fixture_origin_survives_unrelated_parallel_sync() {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/oauth-origin-isolation")
            .join(uuid::Uuid::new_v4().to_string());
        crate::data::with_test_file(root.join("profiles.json"), || {
            let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
            let (continue_tx, continue_rx) = std::sync::mpsc::sync_channel(1);
            let profile_id = format!("fixture-{}", uuid::Uuid::new_v4());
            let worker_id = profile_id.clone();
            let worker = std::thread::spawn(move || {
                let mut data = crate::data::AppData::default();
                let mut profile =
                    crate::workspace::WorkspaceProfile::new("fixture-workspace".into(), None);
                profile.id = worker_id.clone();
                profile.tunnel.public_url = "https://new-popup.example".into();
                data.profiles.push(profile);
                sync_trusted_origins(&data);
                ready_tx.send(()).unwrap();
                continue_rx.recv().unwrap();
                assert_eq!(
                    trusted_external_base_url(
                        &worker_id,
                        false,
                        28767,
                        "https://old-popup.example",
                    ),
                    "https://new-popup.example"
                );
            });

            ready_rx.recv().unwrap();
            // Deterministically erase the process-wide map from another thread.
            // The worker must retain its own fixture view until its HTTP flow ends.
            sync_trusted_origins(&crate::data::AppData::default());
            continue_tx.send(()).unwrap();
            worker.join().unwrap();
        });
    }
}

#[cfg(test)]
mod release_finalization_regressions {
    use super::*;
    #[test]
    fn release_finalization_forwarded_headers_cannot_choose_issuer() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-host", "attacker.invalid".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("host", "attacker.invalid".parse().unwrap());
        assert_eq!(
            external_base_url(&headers, 28767, ""),
            "http://127.0.0.1:28767"
        );
        assert_eq!(
            external_base_url(&headers, 28767, "https://trusted.example"),
            "https://trusted.example"
        );
    }
}

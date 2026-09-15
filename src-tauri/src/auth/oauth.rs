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

// Production owns one process-wide data store. Rust tests can run several
// independent fixture stores in one process, so retain each fixture's latest
// synchronized origin map by its active data-file identity. A refresh from
// another thread using the same fixture updates the same shared entry, while a
// nested or unrelated fixture selects a different entry. Production behavior is
// unchanged because this registry exists only in test builds.
#[cfg(test)]
type TestOriginMaps = std::collections::HashMap<std::path::PathBuf, OriginMap>;
#[cfg(test)]
static TEST_TRUSTED_ORIGINS: std::sync::OnceLock<std::sync::RwLock<TestOriginMaps>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn sync_test_trusted_origins(origins: &OriginMap) {
    let Some(path) = crate::data::test_data_file_path() else {
        return;
    };
    let lock = TEST_TRUSTED_ORIGINS.get_or_init(Default::default);
    if let Ok(mut fixtures) = lock.write() {
        fixtures.insert(path, origins.clone());
    }
}

#[cfg(test)]
fn test_trusted_origin(id: &str, actions: bool) -> Result<Option<String>, ()> {
    let path = crate::data::test_data_file_path().ok_or(())?;
    let lock = TEST_TRUSTED_ORIGINS.get_or_init(Default::default);
    let fixtures = lock.read().map_err(|_| ())?;
    Ok(fixtures
        .get(&path)
        .and_then(|origins| origins.get(&(id.to_owned(), actions)))
        .cloned())
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
    sync_test_trusted_origins(&origins);
    let lock = TRUSTED_ORIGINS.get_or_init(Default::default);
    if let Ok(mut current) = lock.write() {
        *current = origins;
    }
}

pub fn trusted_external_base_url(id: &str, actions: bool, port: u16, configured: &str) -> String {
    #[cfg(test)]
    if let Ok(test_configured) = test_trusted_origin(id, actions) {
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

    fn fixture_data(profile_id: &str, public_url: &str) -> crate::data::AppData {
        let mut data = crate::data::AppData::default();
        let mut profile = crate::workspace::WorkspaceProfile::new("fixture-workspace".into(), None);
        profile.id = profile_id.into();
        profile.tunnel.public_url = public_url.into();
        data.profiles.push(profile);
        data
    }

    fn fixture_path(label: &str) -> std::path::PathBuf {
        std::env::current_dir()
            .unwrap()
            .join("aiTemp/oauth-origin-isolation")
            .join(format!("{label}-{}", uuid::Uuid::new_v4()))
            .join("profiles.json")
    }

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
        let profile_id = format!("fixture-{}", uuid::Uuid::new_v4());
        crate::data::with_test_file(fixture_path("outer"), || {
            sync_trusted_origins(&fixture_data(&profile_id, "https://new-popup.example"));
            let worker = std::thread::spawn(|| {
                sync_trusted_origins(&crate::data::AppData::default());
            });
            worker.join().unwrap();
            assert_eq!(
                trusted_external_base_url(&profile_id, false, 28767, "https://old-popup.example",),
                "https://new-popup.example"
            );
        });
    }

    #[test]
    fn same_fixture_cross_thread_refresh_is_visible() {
        let file = fixture_path("shared");
        let profile_id = format!("fixture-{}", uuid::Uuid::new_v4());
        crate::data::with_test_file(file.clone(), || {
            sync_trusted_origins(&fixture_data(&profile_id, "https://old-popup.example"));
            let worker_file = file.clone();
            let worker_id = profile_id.clone();
            let worker = std::thread::spawn(move || {
                crate::data::with_test_file(worker_file, || {
                    sync_trusted_origins(&fixture_data(&worker_id, "https://new-popup.example"));
                });
            });
            worker.join().unwrap();
            assert_eq!(
                trusted_external_base_url(&profile_id, false, 28767, "https://old-popup.example",),
                "https://new-popup.example"
            );
        });
    }

    #[test]
    fn nested_fixture_scope_restores_outer_origin_view() {
        let outer_file = fixture_path("outer-nested");
        let inner_file = fixture_path("inner-nested");
        let profile_id = format!("fixture-{}", uuid::Uuid::new_v4());
        crate::data::with_test_file(outer_file, || {
            sync_trusted_origins(&fixture_data(&profile_id, "https://outer-popup.example"));
            crate::data::with_test_file(inner_file, || {
                sync_trusted_origins(&fixture_data(&profile_id, "https://inner-popup.example"));
                assert_eq!(
                    trusted_external_base_url(
                        &profile_id,
                        false,
                        28767,
                        "https://configured.example",
                    ),
                    "https://inner-popup.example"
                );
            });
            assert_eq!(
                trusted_external_base_url(&profile_id, false, 28767, "https://configured.example",),
                "https://outer-popup.example"
            );
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

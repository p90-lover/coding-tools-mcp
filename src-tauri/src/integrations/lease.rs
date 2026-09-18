//! Durable keep-alive leases for Paseo, Anneal and CommandCode Proxy.
use super::{err, now};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const PASEO_STALE_SECS: u64 = 90;
pub const HTTP_STALE_SECS: u64 = 120;
pub const STABLE_RESET_SECS: u64 = 120;
pub const PING_SECS: u64 = 20;
pub const POLL_SECS: u64 = 30;
const BACKOFF_CAP_SECS: u64 = 60;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LivePhase {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Stale,
    Error,
}

impl LivePhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Stale => "stale",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IntegrationLease {
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub web_ui: String,
    #[serde(default)]
    pub keep_alive: bool,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub last_ok_at: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub reconnect_attempts: u32,
    #[serde(default)]
    pub commandcode_bin: Option<String>,
}

impl Default for IntegrationLease {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            web_ui: String::new(),
            keep_alive: false,
            client_id: None,
            last_ok_at: None,
            last_error: None,
            status: LivePhase::Disconnected.as_str().into(),
            reconnect_attempts: 0,
            commandcode_bin: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct IntegrationLeases {
    #[serde(default)]
    pub paseo: IntegrationLease,
    #[serde(default)]
    pub anneal: IntegrationLease,
    #[serde(default)]
    pub commandcode: IntegrationLease,
}

impl IntegrationLeases {
    pub fn get(&self, key: &str) -> &IntegrationLease {
        match key {
            "paseo" => &self.paseo,
            "anneal" => &self.anneal,
            _ => &self.commandcode,
        }
    }
    pub fn get_mut(&mut self, key: &str) -> &mut IntegrationLease {
        match key {
            "paseo" => &mut self.paseo,
            "anneal" => &mut self.anneal,
            _ => &mut self.commandcode,
        }
    }
}

pub fn backoff_delay(attempts: u32) -> Duration {
    let exp = 1u64
        .checked_shl(attempts.min(6))
        .unwrap_or(BACKOFF_CAP_SECS);
    let base = exp.clamp(1, BACKOFF_CAP_SECS);
    let jitter = (now().wrapping_mul(17) + u64::from(attempts)) % (base / 5).max(1) + 1;
    Duration::from_secs((base + jitter).min(BACKOFF_CAP_SECS + base / 5))
}

pub fn classify(
    last_ok_at: Option<u64>,
    stale_after: u64,
    error: bool,
    keep_alive: bool,
) -> LivePhase {
    let now = now();
    if error && !keep_alive {
        return LivePhase::Error;
    }
    match last_ok_at {
        Some(ok) if now.saturating_sub(ok) > stale_after => LivePhase::Stale,
        Some(_) if error => LivePhase::Reconnecting,
        Some(_) => LivePhase::Connected,
        None if keep_alive => LivePhase::Connecting,
        None if error => LivePhase::Error,
        None => LivePhase::Disconnected,
    }
}

pub fn clip_error(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(512)
        .collect()
}

pub fn observer_client_id(existing: Option<&str>) -> String {
    if let Some(id) = existing.filter(|v| v.starts_with("coding-tools-observer-") && v.len() <= 80)
    {
        return id.to_string();
    }
    format!("coding-tools-observer-{}", uuid::Uuid::new_v4())
}

pub fn parse_web_ui(value: &str) -> AppResult<url::Url> {
    if value.is_empty() {
        return Err(err("Specify a loopback web UI URL"));
    }
    if value.len() > 512
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || value.contains('\\')
    {
        return Err(err(
            "Use a literal loopback web UI without whitespace or credentials",
        ));
    }
    let u = url::Url::parse(value).map_err(|_| err("Invalid web UI URL"))?;
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() {
        return Err(err(
            "Credentials and query parameters are not allowed in web UI URLs",
        ));
    }
    match u.host() {
        Some(url::Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => {}
        Some(url::Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => {}
        _ => {
            return Err(err(
                "Web UI must be 127.0.0.1 or [::1]. Remote services require a user-managed local port forward.",
            ))
        }
    }
    if u.port().is_none() {
        return Err(err("Specify the web UI port"));
    }
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(err("Web UI uses HTTP(S) on loopback"));
    }
    Ok(u)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_caps_and_grows() {
        let first = backoff_delay(0);
        let later = backoff_delay(8);
        assert!(first >= Duration::from_secs(1));
        assert!(later <= Duration::from_secs(72));
        assert!(later >= first);
    }

    #[test]
    fn classify_marks_stale_after_threshold() {
        let old = now().saturating_sub(PASEO_STALE_SECS + 5);
        assert_eq!(
            classify(Some(old), PASEO_STALE_SECS, false, true),
            LivePhase::Stale
        );
        assert_eq!(
            classify(Some(now()), PASEO_STALE_SECS, false, true),
            LivePhase::Connected
        );
    }

    #[test]
    fn observer_id_is_stable_when_present() {
        let id = observer_client_id(Some("coding-tools-observer-abc"));
        assert_eq!(id, "coding-tools-observer-abc");
        assert!(observer_client_id(None).starts_with("coding-tools-observer-"));
    }
}

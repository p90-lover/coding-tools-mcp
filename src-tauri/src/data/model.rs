use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::settings::{DownloadConfig, FrpProfile, ProxyConfig};
use crate::workspace::WorkspaceProfile;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthRefreshTokenRecord {
    pub token_hash: String,
    pub client_id: String,
    pub family_id: String,
    pub generation: u32,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// Unified on-disk payload stored in `data/profiles.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppData {
    #[serde(default)]
    pub frp_profiles: Vec<FrpProfile>,
    #[serde(default)]
    pub last_workspace_id: String,
    #[serde(default)]
    pub download: DownloadConfig,
    #[serde(default)]
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub shared_secrets: HashMap<String, String>,
    #[serde(default)]
    pub workspace_secrets: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub app_secrets: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub oauth_refresh_tokens: HashMap<String, Vec<OAuthRefreshTokenRecord>>,
    #[serde(default)]
    pub profiles: Vec<WorkspaceProfile>,
}

/// Legacy `{ "profiles": [...] }` file at the app root.
#[derive(Debug, Deserialize)]
pub struct LegacyProfilesOnlyFile {
    pub profiles: Vec<WorkspaceProfile>,
}

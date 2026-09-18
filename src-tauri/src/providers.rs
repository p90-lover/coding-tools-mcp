use crate::{
    data::{AppData, DataStore},
    error::{AppError, AppResult},
};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

fn fail(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCategory {
    ApiKey,
    OAuth,
    Browser,
    ReverseProxy,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuth {
    ApiKey,
    OAuth,
    BrowserSession,
    LocalProxy,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    OpenAiChat,
    OpenAiResponses,
    AnthropicMessages,
    GeminiNative,
    ImageApi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    Text,
    Reasoning,
    Tools,
    Vision,
    ImageGeneration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub template_id: String,
    pub category: ProviderCategory,
    pub auth: ProviderAuth,
    pub protocol: ProviderProtocol,
    pub base_url: Option<String>,
    pub models_endpoint: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<ProviderCapability>,
    #[serde(default)]
    pub paseo_enabled: bool,
    #[serde(default)]
    pub anneal_enabled: bool,
    #[serde(default)]
    pub direct_enabled: bool,
    #[serde(default)]
    pub image_enabled: bool,
    #[serde(default)]
    pub priority: u16,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub generation: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub template_id: String,
    pub category: ProviderCategory,
    pub auth: ProviderAuth,
    pub protocol: ProviderProtocol,
    pub base_url: Option<String>,
    pub models_endpoint: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<ProviderCapability>,
    #[serde(default)]
    pub paseo_enabled: bool,
    #[serde(default)]
    pub anneal_enabled: bool,
    #[serde(default)]
    pub direct_enabled: bool,
    #[serde(default)]
    pub image_enabled: bool,
    #[serde(default)]
    pub priority: u16,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealthStatus {
    Unknown,
    Ready,
    Error,
    NeedsAuthentication,
    ManagedExternally,
    Disabled,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderHealth {
    pub provider_id: String,
    pub status: ProviderHealthStatus,
    pub checked_at: Option<u64>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub models: Vec<String>,
}

#[derive(Clone)]
struct ProviderConnection {
    credential: Arc<String>,
    generation: String,
}

fn connection_vault() -> &'static Mutex<HashMap<String, ProviderConnection>> {
    static VAULT: OnceLock<Mutex<HashMap<String, ProviderConnection>>> = OnceLock::new();
    VAULT.get_or_init(Default::default)
}

fn health_store() -> &'static Mutex<HashMap<String, ProviderHealth>> {
    static HEALTH: OnceLock<Mutex<HashMap<String, ProviderHealth>>> = OnceLock::new();
    HEALTH.get_or_init(Default::default)
}

fn bounded(value: &str, max: usize, label: &str, required: bool) -> AppResult<()> {
    if (required && value.trim().is_empty())
        || value.len() > max
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(fail(format!("Invalid {label}")));
    }
    Ok(())
}

fn identifier(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(fail(format!(
            "{label} must contain 1..128 letters, digits, hyphens, underscores, dots or colons"
        )));
    }
    Ok(())
}

fn normalize_base_url(value: Option<String>) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    bounded(value, 2_048, "provider base URL", true)?;
    if value.chars().any(char::is_whitespace) {
        return Err(fail("Provider base URL must not contain whitespace"));
    }
    let mut url = Url::parse(value).map_err(|_| fail("Provider base URL is invalid"))?;
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(fail(
            "Remote provider URLs require HTTPS; plain HTTP is limited to loopback",
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail(
            "Provider base URL must not contain credentials, query parameters or fragments",
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(Some(url.to_string().trim_end_matches('/').to_string()))
}

fn normalize_models_endpoint(value: Option<String>) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 256
        || value == "/"
        || !value.starts_with('/')
        || value.contains("..")
        || value.contains('?')
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
    {
        return Err(fail(
            "Models endpoint must be a bounded absolute path without query or traversal",
        ));
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

fn normalize_models(models: Vec<String>) -> AppResult<Vec<String>> {
    if models.len() > 512 {
        return Err(fail("Provider model list exceeds 512 entries"));
    }
    let mut seen = BTreeSet::new();
    for model in models {
        let model = model.trim();
        bounded(model, 256, "provider model", true)?;
        seen.insert(model.to_string());
    }
    Ok(seen.into_iter().collect())
}

fn normalize_capabilities(
    capabilities: Vec<ProviderCapability>,
) -> AppResult<Vec<ProviderCapability>> {
    let capabilities: BTreeSet<_> = capabilities.into_iter().collect();
    if capabilities.is_empty() {
        return Err(fail("Select at least one provider capability"));
    }
    Ok(capabilities.into_iter().collect())
}

impl ProviderProfile {
    pub fn validate(&self) -> AppResult<()> {
        identifier(&self.id, "Provider profile ID")?;
        identifier(&self.template_id, "Provider template ID")?;
        bounded(&self.name, 120, "provider profile name", true)?;
        if let Some(url) = &self.base_url {
            normalize_base_url(Some(url.clone()))?;
        }
        if let Some(endpoint) = &self.models_endpoint {
            normalize_models_endpoint(Some(endpoint.clone()))?;
        }
        normalize_models(self.models.clone())?;
        let capabilities = normalize_capabilities(self.capabilities.clone())?;
        if self.image_enabled && !capabilities.contains(&ProviderCapability::ImageGeneration) {
            return Err(fail(
                "Image routing requires the image_generation provider capability",
            ));
        }
        if self.priority > 10_000 {
            return Err(fail("Provider priority must be at most 10000"));
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn template(
    id: &str,
    name: &str,
    category: ProviderCategory,
    auth: ProviderAuth,
    protocol: ProviderProtocol,
    base_url: Option<&str>,
    models_endpoint: Option<&str>,
    capabilities: &[ProviderCapability],
    priority: u16,
) -> ProviderProfile {
    ProviderProfile {
        id: id.into(),
        name: name.into(),
        template_id: id.into(),
        category,
        auth,
        protocol,
        base_url: base_url.map(str::to_owned),
        models_endpoint: models_endpoint.map(str::to_owned),
        models: vec![],
        capabilities: capabilities.to_vec(),
        paseo_enabled: true,
        anneal_enabled: true,
        direct_enabled: true,
        image_enabled: capabilities.contains(&ProviderCapability::ImageGeneration),
        priority,
        enabled: true,
        archived: false,
        generation: "builtin-template".into(),
        revision: 0,
        updated_at: 0,
    }
}

pub fn builtin_templates() -> Vec<ProviderProfile> {
    use ProviderCapability::{ImageGeneration, Reasoning, Text, Tools, Vision};
    vec![
        template(
            "openai-api",
            "OpenAI API",
            ProviderCategory::ApiKey,
            ProviderAuth::ApiKey,
            ProviderProtocol::OpenAiResponses,
            Some("https://api.openai.com/v1"),
            Some("/models"),
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            10,
        ),
        template(
            "anthropic-api",
            "Anthropic API",
            ProviderCategory::ApiKey,
            ProviderAuth::ApiKey,
            ProviderProtocol::AnthropicMessages,
            Some("https://api.anthropic.com/v1"),
            Some("/models"),
            &[Text, Reasoning, Tools, Vision],
            20,
        ),
        template(
            "gemini-api",
            "Gemini API",
            ProviderCategory::ApiKey,
            ProviderAuth::ApiKey,
            ProviderProtocol::GeminiNative,
            Some("https://generativelanguage.googleapis.com/v1beta"),
            Some("/models"),
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            30,
        ),
        template(
            "codex-oauth",
            "Codex OAuth",
            ProviderCategory::OAuth,
            ProviderAuth::OAuth,
            ProviderProtocol::OpenAiResponses,
            None,
            None,
            &[Text, Reasoning, Tools, Vision],
            40,
        ),
        template(
            "claude-oauth",
            "Claude OAuth",
            ProviderCategory::OAuth,
            ProviderAuth::OAuth,
            ProviderProtocol::AnthropicMessages,
            None,
            None,
            &[Text, Reasoning, Tools, Vision],
            50,
        ),
        template(
            "chatgpt-web",
            "ChatGPT Web GPT",
            ProviderCategory::Browser,
            ProviderAuth::BrowserSession,
            ProviderProtocol::OpenAiResponses,
            None,
            None,
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            60,
        ),
        template(
            "ai-studio-browser",
            "AI Studio Browser Session",
            ProviderCategory::Browser,
            ProviderAuth::BrowserSession,
            ProviderProtocol::GeminiNative,
            None,
            None,
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            70,
        ),
        template(
            "ai-studio-reverse-proxy",
            "AI Studio Reverse Proxy",
            ProviderCategory::ReverseProxy,
            ProviderAuth::BrowserSession,
            ProviderProtocol::GeminiNative,
            None,
            Some("/models"),
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            80,
        ),
        template(
            "gemini-reverse-proxy",
            "Gemini Reverse Proxy",
            ProviderCategory::ReverseProxy,
            ProviderAuth::LocalProxy,
            ProviderProtocol::GeminiNative,
            None,
            Some("/models"),
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            90,
        ),
        template(
            "aistudio-to-api",
            "AIStudioToAPI",
            ProviderCategory::ReverseProxy,
            ProviderAuth::LocalProxy,
            ProviderProtocol::OpenAiChat,
            Some("http://127.0.0.1:7860/v1"),
            Some("/models"),
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            100,
        ),
        template(
            "cliproxyapi-antigravity",
            "CLIProxyAPI / Antigravity",
            ProviderCategory::ReverseProxy,
            ProviderAuth::LocalProxy,
            ProviderProtocol::OpenAiResponses,
            None,
            Some("/models"),
            &[Text, Reasoning, Tools, Vision, ImageGeneration],
            110,
        ),
        template(
            "commandcode-proxy",
            "CommandCode Proxy",
            ProviderCategory::ReverseProxy,
            ProviderAuth::LocalProxy,
            ProviderProtocol::OpenAiChat,
            Some("http://127.0.0.1:3050/v1"),
            Some("/models"),
            &[Text, Reasoning, Tools],
            120,
        ),
        template(
            "custom-compatible",
            "Custom compatible provider",
            ProviderCategory::Custom,
            ProviderAuth::ApiKey,
            ProviderProtocol::OpenAiResponses,
            None,
            Some("/models"),
            &[Text],
            500,
        ),
    ]
}

fn health_for(profile: &ProviderProfile) -> ProviderHealth {
    if !profile.enabled || profile.archived {
        return ProviderHealth {
            provider_id: profile.id.clone(),
            status: ProviderHealthStatus::Disabled,
            checked_at: None,
            latency_ms: None,
            error: None,
            models: profile.models.clone(),
        };
    }
    if let Ok(health) = health_store().lock() {
        if let Some(health) = health.get(&profile.id) {
            return health.clone();
        }
    }
    let connected = connection_vault()
        .lock()
        .ok()
        .and_then(|vault| vault.get(&profile.id).cloned())
        .is_some_and(|connection| connection.generation == profile.generation);
    let status = if connected {
        ProviderHealthStatus::Unknown
    } else if matches!(
        profile.auth,
        ProviderAuth::OAuth | ProviderAuth::BrowserSession
    ) && profile.base_url.is_none()
    {
        ProviderHealthStatus::ManagedExternally
    } else {
        ProviderHealthStatus::NeedsAuthentication
    };
    ProviderHealth {
        provider_id: profile.id.clone(),
        status,
        checked_at: None,
        latency_ms: None,
        error: None,
        models: profile.models.clone(),
    }
}

fn view(data: &AppData) -> Value {
    let profiles: Vec<_> = data
        .provider_profiles
        .iter()
        .filter(|profile| !profile.archived)
        .cloned()
        .collect();
    let health: Vec<_> = profiles.iter().map(health_for).collect();
    json!({
        "revision": data.provider_registry_revision,
        "templates": builtin_templates(),
        "profiles": profiles,
        "health": health,
    })
}

pub fn read() -> AppResult<Value> {
    DataStore::read_file(|data| Ok(view(data)))
}

pub fn save(
    expected_revision: u64,
    input: ProviderProfileInput,
    credential: Option<String>,
) -> AppResult<Value> {
    if credential.as_ref().is_some_and(|value| {
        value.len() > 8_192 || value.chars().any(|character| character.is_control())
    }) {
        return Err(fail("Provider credential is invalid"));
    }
    let saved = DataStore::update_file(|data| {
        if data.provider_registry_revision != expected_revision {
            return Err(fail("Provider registry changed; refresh before saving"));
        }
        let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        identifier(&id, "Provider profile ID")?;
        let current = data
            .provider_profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned();
        let profile = ProviderProfile {
            id: id.clone(),
            name: input.name.trim().to_string(),
            template_id: input.template_id.trim().to_string(),
            category: input.category,
            auth: input.auth,
            protocol: input.protocol,
            base_url: normalize_base_url(input.base_url)?,
            models_endpoint: normalize_models_endpoint(input.models_endpoint)?,
            models: normalize_models(input.models)?,
            capabilities: normalize_capabilities(input.capabilities)?,
            paseo_enabled: input.paseo_enabled,
            anneal_enabled: input.anneal_enabled,
            direct_enabled: input.direct_enabled,
            image_enabled: input.image_enabled,
            priority: input.priority,
            enabled: input.enabled,
            archived: false,
            generation: uuid::Uuid::new_v4().to_string(),
            revision: current
                .as_ref()
                .map_or(0, |profile| profile.revision.saturating_add(1)),
            updated_at: now(),
        };
        profile.validate()?;
        if let Some(index) = data
            .provider_profiles
            .iter()
            .position(|provider| provider.id == id)
        {
            data.provider_profiles[index] = profile.clone();
        } else {
            if data.provider_profiles.len() >= 128 {
                return Err(fail(
                    "Provider profile limit reached; existing profiles were retained",
                ));
            }
            data.provider_profiles.push(profile.clone());
        }
        data.provider_registry_revision = data
            .provider_registry_revision
            .checked_add(1)
            .ok_or_else(|| fail("Provider registry revision exhausted"))?;
        Ok(profile)
    })?;
    invalidate_connection(&saved.id);
    if let Some(credential) = credential {
        connection_vault()
            .lock()
            .map_err(|_| fail("Provider credential vault unavailable"))?
            .insert(
                saved.id.clone(),
                ProviderConnection {
                    credential: Arc::new(credential),
                    generation: saved.generation.clone(),
                },
            );
    }
    read()
}

pub fn connect(id: &str, credential: String) -> AppResult<Value> {
    if credential.len() > 8_192 || credential.chars().any(char::is_control) {
        return Err(fail("Provider credential is invalid"));
    }
    let profile = DataStore::update_file(|data| {
        let profile = data
            .provider_profiles
            .iter_mut()
            .find(|profile| profile.id == id && !profile.archived)
            .ok_or_else(|| fail("Provider profile not found"))?;
        profile.enabled = true;
        profile.updated_at = now();
        data.provider_registry_revision = data
            .provider_registry_revision
            .checked_add(1)
            .ok_or_else(|| fail("Provider registry revision exhausted"))?;
        Ok(profile.clone())
    })?;
    invalidate_connection(id);
    connection_vault()
        .lock()
        .map_err(|_| fail("Provider credential vault unavailable"))?
        .insert(
            id.to_string(),
            ProviderConnection {
                credential: Arc::new(credential),
                generation: profile.generation,
            },
        );
    read()
}

pub fn disable(id: &str) -> AppResult<Value> {
    DataStore::update_file(|data| {
        let profile = data
            .provider_profiles
            .iter_mut()
            .find(|profile| profile.id == id && !profile.archived)
            .ok_or_else(|| fail("Provider profile not found"))?;
        profile.enabled = false;
        profile.updated_at = now();
        data.provider_registry_revision = data
            .provider_registry_revision
            .checked_add(1)
            .ok_or_else(|| fail("Provider registry revision exhausted"))?;
        Ok(())
    })?;
    invalidate_connection(id);
    read()
}

pub fn archive(id: &str) -> AppResult<Value> {
    DataStore::update_file(|data| {
        let profile = data
            .provider_profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| fail("Provider profile not found"))?;
        profile.enabled = false;
        profile.archived = true;
        profile.updated_at = now();
        data.provider_registry_revision = data
            .provider_registry_revision
            .checked_add(1)
            .ok_or_else(|| fail("Provider registry revision exhausted"))?;
        Ok(())
    })?;
    invalidate_connection(id);
    read()
}

fn invalidate_connection(id: &str) {
    if let Ok(mut vault) = connection_vault().lock() {
        vault.remove(id);
    }
    if let Ok(mut health) = health_store().lock() {
        health.remove(id);
    }
}

fn endpoint_url(profile: &ProviderProfile) -> AppResult<Url> {
    let base = profile
        .base_url
        .as_deref()
        .ok_or_else(|| fail("Configure a provider base URL before testing it"))?;
    let mut url = Url::parse(base).map_err(|_| fail("Provider base URL is invalid"))?;
    let endpoint = profile.models_endpoint.as_deref().unwrap_or("/models");
    let base_path = url.path().trim_end_matches('/');
    let endpoint = endpoint.trim_start_matches('/');
    url.set_path(&format!("{base_path}/{endpoint}"));
    Ok(url)
}

fn request_headers(profile: &ProviderProfile, credential: &str) -> AppResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("application/json"));
    if credential.is_empty() {
        return Ok(headers);
    }
    let bearer = HeaderValue::from_str(&format!("Bearer {credential}"))
        .map_err(|_| fail("Provider credential cannot be encoded"))?;
    headers.insert(AUTHORIZATION, bearer);
    match profile.protocol {
        ProviderProtocol::AnthropicMessages => {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(credential)
                    .map_err(|_| fail("Provider credential cannot be encoded"))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        ProviderProtocol::GeminiNative => {
            headers.insert(
                "x-goog-api-key",
                HeaderValue::from_str(credential)
                    .map_err(|_| fail("Provider credential cannot be encoded"))?,
            );
        }
        _ => {}
    }
    Ok(headers)
}

fn model_ids(value: &Value) -> Vec<String> {
    let mut ids = BTreeSet::new();
    {
        let mut collect = |candidate: &Value| {
            let id = candidate
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    candidate
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| {
                    candidate
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| {
                    candidate
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            if let Some(id) = id {
                let id = id.trim().trim_start_matches("models/");
                if !id.is_empty() && id.len() <= 256 {
                    ids.insert(id.to_string());
                }
            }
        };
        if let Some(data) = value.get("data").and_then(Value::as_array) {
            for candidate in data {
                collect(candidate);
            }
        }
        if let Some(models) = value.get("models").and_then(Value::as_array) {
            for candidate in models {
                collect(candidate);
            }
        }
        if let Some(array) = value.as_array() {
            for candidate in array {
                collect(candidate);
            }
        }
    }
    ids.into_iter().take(512).collect()
}

pub async fn probe(id: &str, discover_models: bool) -> AppResult<Value> {
    let profile = DataStore::read_file(|data| {
        data.provider_profiles
            .iter()
            .find(|profile| profile.id == id && !profile.archived)
            .cloned()
            .ok_or_else(|| fail("Provider profile not found"))
    })?;
    if !profile.enabled {
        return Err(fail("Provider profile is disabled"));
    }
    if profile.base_url.is_none() {
        let health = ProviderHealth {
            provider_id: profile.id.clone(),
            status: ProviderHealthStatus::ManagedExternally,
            checked_at: Some(now()),
            latency_ms: None,
            error: None,
            models: profile.models.clone(),
        };
        health_store()
            .lock()
            .map_err(|_| fail("Provider health store unavailable"))?
            .insert(profile.id.clone(), health);
        return read();
    }
    let credential = connection_vault()
        .lock()
        .map_err(|_| fail("Provider credential vault unavailable"))?
        .get(id)
        .filter(|connection| connection.generation == profile.generation)
        .map(|connection| connection.credential.as_str().to_string())
        .unwrap_or_default();
    let url = endpoint_url(&profile)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("Provider probe client unavailable"))?;
    let started = std::time::Instant::now();
    let response = client
        .get(url)
        .headers(request_headers(&profile, &credential)?)
        .send()
        .await;
    let checked_at = now();
    let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let health = match response {
        Ok(response) if response.status().is_success() => {
            let value = response.json::<Value>().await.unwrap_or(Value::Null);
            let models = model_ids(&value);
            if discover_models && !models.is_empty() {
                DataStore::update_file(|data| {
                    let profile = data
                        .provider_profiles
                        .iter_mut()
                        .find(|profile| profile.id == id && !profile.archived)
                        .ok_or_else(|| fail("Provider profile changed during discovery"))?;
                    profile.models = models.clone();
                    profile.updated_at = checked_at;
                    data.provider_registry_revision = data
                        .provider_registry_revision
                        .checked_add(1)
                        .ok_or_else(|| fail("Provider registry revision exhausted"))?;
                    Ok(())
                })?;
            }
            ProviderHealth {
                provider_id: id.to_string(),
                status: ProviderHealthStatus::Ready,
                checked_at: Some(checked_at),
                latency_ms: Some(latency_ms),
                error: None,
                models: if models.is_empty() {
                    profile.models.clone()
                } else {
                    models
                },
            }
        }
        Ok(response) => ProviderHealth {
            provider_id: id.to_string(),
            status: if response.status() == reqwest::StatusCode::UNAUTHORIZED
                || response.status() == reqwest::StatusCode::FORBIDDEN
            {
                ProviderHealthStatus::NeedsAuthentication
            } else {
                ProviderHealthStatus::Error
            },
            checked_at: Some(checked_at),
            latency_ms: Some(latency_ms),
            error: Some(format!(
                "Provider returned HTTP {}",
                response.status().as_u16()
            )),
            models: profile.models.clone(),
        },
        Err(error) => ProviderHealth {
            provider_id: id.to_string(),
            status: ProviderHealthStatus::Error,
            checked_at: Some(checked_at),
            latency_ms: Some(latency_ms),
            error: Some(error.to_string().chars().take(240).collect()),
            models: profile.models.clone(),
        },
    };
    health_store()
        .lock()
        .map_err(|_| fail("Provider health store unavailable"))?
        .insert(id.to_string(), health);
    read()
}

pub fn profile(data: &AppData, id: &str) -> AppResult<ProviderProfile> {
    data.provider_profiles
        .iter()
        .find(|profile| profile.id == id && profile.enabled && !profile.archived)
        .cloned()
        .ok_or_else(|| fail("Provider profile is not enabled"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_http_is_rejected_but_loopback_http_is_allowed() {
        assert!(normalize_base_url(Some("http://example.com/v1".into())).is_err());
        assert_eq!(
            normalize_base_url(Some("http://127.0.0.1:3050/v1/".into())).unwrap(),
            Some("http://127.0.0.1:3050/v1".into())
        );
    }

    #[test]
    fn builtin_catalog_contains_requested_provider_families() {
        let ids: BTreeSet<_> = builtin_templates()
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        for id in [
            "codex-oauth",
            "claude-oauth",
            "chatgpt-web",
            "ai-studio-reverse-proxy",
            "gemini-reverse-proxy",
            "aistudio-to-api",
            "cliproxyapi-antigravity",
            "commandcode-proxy",
        ] {
            assert!(ids.contains(id), "missing provider template {id}");
        }
    }

    #[test]
    fn persisted_profiles_do_not_contain_credentials() {
        let profile = template(
            "test",
            "Test",
            ProviderCategory::Custom,
            ProviderAuth::ApiKey,
            ProviderProtocol::OpenAiResponses,
            Some("https://example.com/v1"),
            Some("/models"),
            &[ProviderCapability::Text],
            1,
        );
        let encoded = serde_json::to_string(&profile).unwrap();
        assert!(!encoded.contains("credential"));
        assert!(!encoded.contains("secret"));
    }
}

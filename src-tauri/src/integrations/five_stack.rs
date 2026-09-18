//! Managed original UI + lifecycle for CPA, Codex Router, CommandCode, Paseo, and Anneal.
//! Observation adapters in the parent module stay GET/WebSocket read-only.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use url::Url;

const LOOPBACK: [&str; 3] = ["127.0.0.1", "::1", "localhost"];
const MAX_BYTES: usize = 2 * 1024 * 1024;

fn err(s: &str) -> AppError {
    AppError::Message(s.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolId {
    Cpa,
    #[serde(rename = "codex-router")]
    CodexRouter,
    #[serde(rename = "commandcode-proxy")]
    CommandCodeProxy,
    Paseo,
    Anneal,
}

impl ToolId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpa => "cpa",
            Self::CodexRouter => "codex-router",
            Self::CommandCodeProxy => "commandcode-proxy",
            Self::Paseo => "paseo",
            Self::Anneal => "anneal",
        }
    }

    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "cpa" => Ok(Self::Cpa),
            "codex-router" => Ok(Self::CodexRouter),
            "commandcode-proxy" => Ok(Self::CommandCodeProxy),
            "paseo" => Ok(Self::Paseo),
            "anneal" => Ok(Self::Anneal),
            _ => Err(err("Unknown managed original UI")),
        }
    }

    pub fn all() -> [Self; 5] {
        [
            Self::CodexRouter,
            Self::Cpa,
            Self::CommandCodeProxy,
            Self::Paseo,
            Self::Anneal,
        ]
    }
}

#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub id: ToolId,
    pub name: &'static str,
    pub default_endpoint: &'static str,
    pub health_path: &'static str,
    pub sections: &'static [&'static str],
    pub section_paths: &'static [(&'static str, &'static str)],
    pub original_window: bool,
    pub home_env: &'static str,
}

pub const TOOLS: [ToolSpec; 5] = [
    ToolSpec {
        id: ToolId::CodexRouter,
        name: "Codex Router",
        default_endpoint: "http://127.0.0.1:4202/",
        health_path: "/",
        sections: &[
            "dashboard",
            "usage",
            "status",
            "models",
            "local",
            "harness",
            "context",
            "settings",
        ],
        section_paths: &[
            ("dashboard", "/"),
            ("usage", "/"),
            ("status", "/"),
            ("models", "/"),
            ("local", "/"),
            ("harness", "/"),
            ("context", "/"),
            ("settings", "/"),
        ],
        original_window: true,
        home_env: "CODING_TOOLS_CODEX_ROUTER_HOME",
    },
    ToolSpec {
        id: ToolId::Cpa,
        name: "CPA / CLIProxyAPI",
        default_endpoint: "http://127.0.0.1:8317/",
        health_path: "/management.html",
        sections: &[
            "dashboard",
            "ai-providers",
            "auth-files",
            "oauth",
            "quota",
            "config",
            "logs",
            "system",
            "plugins",
        ],
        section_paths: &[
            ("dashboard", "/management.html#/dashboard"),
            ("ai-providers", "/management.html#/ai-providers"),
            ("auth-files", "/management.html#/auth-files"),
            ("oauth", "/management.html#/oauth"),
            ("quota", "/management.html#/quota"),
            ("config", "/management.html#/config"),
            ("logs", "/management.html#/logs"),
            ("system", "/management.html#/system"),
            ("plugins", "/management.html#/plugins"),
        ],
        original_window: false,
        home_env: "CODING_TOOLS_CPA_HOME",
    },
    ToolSpec {
        id: ToolId::CommandCodeProxy,
        name: "CommandCode Proxy",
        default_endpoint: "http://127.0.0.1:9090/",
        health_path: "/",
        sections: &["banner"],
        section_paths: &[("banner", "/")],
        original_window: false,
        home_env: "CODING_TOOLS_COMMANDCODE_HOME",
    },
    ToolSpec {
        id: ToolId::Paseo,
        name: "Paseo",
        default_endpoint: "http://127.0.0.1:6768/",
        health_path: "/",
        sections: &[
            "agents",
            "sessions",
            "workspaces",
            "providers",
            "plugins",
            "voice",
            "settings",
        ],
        section_paths: &[
            ("agents", "/sessions"),
            ("sessions", "/sessions"),
            ("workspaces", "/open-project"),
            ("providers", "/settings"),
            ("plugins", "/settings"),
            ("voice", "/settings"),
            ("settings", "/settings"),
        ],
        original_window: false,
        home_env: "CODING_TOOLS_PASEO_HOME",
    },
    ToolSpec {
        id: ToolId::Anneal,
        name: "Anneal",
        default_endpoint: "http://127.0.0.1:5173/",
        health_path: "/",
        sections: &[
            "tasks",
            "projects",
            "agents",
            "sessions",
            "inbox",
            "automations",
            "triggers",
            "costs",
            "goals",
            "connections",
            "settings",
        ],
        section_paths: &[
            ("tasks", "#/tasks"),
            ("projects", "#/projects"),
            ("agents", "#/agents"),
            ("sessions", "#/sessions"),
            ("inbox", "#/inbox"),
            ("automations", "#/automations"),
            ("triggers", "#/triggers"),
            ("costs", "#/costs"),
            ("goals", "#/goals"),
            ("connections", "#/connections"),
            ("settings", "#/settings"),
        ],
        original_window: false,
        home_env: "CODING_TOOLS_ANNEAL_HOME",
    },
];

pub fn spec(id: ToolId) -> &'static ToolSpec {
    TOOLS
        .iter()
        .find(|tool| tool.id == id)
        .expect("five-stack catalog is complete")
}

#[derive(Clone, Serialize, Debug)]
pub struct ToolSnapshot {
    pub id: ToolId,
    pub name: String,
    pub endpoint: String,
    pub status: String,
    pub sections: Vec<String>,
    pub pid: Option<u32>,
    pub owned: bool,
    pub original_chrome: bool,
    pub install_state: String,
    pub error: Option<String>,
    pub health: Option<serde_json::Value>,
}

#[derive(Clone, Serialize, Debug)]
pub struct Catalog {
    pub version: u32,
    pub tools: Vec<ToolSnapshot>,
}

#[derive(Clone, Serialize, Debug)]
pub struct OpenResult {
    pub tool: ToolSnapshot,
    pub section: String,
    pub url: String,
    pub original_window: bool,
}

fn canonical_host(value: &str) -> String {
    let host = value.to_ascii_lowercase();
    if let Some(inner) = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        inner.to_string()
    } else {
        host
    }
}

pub fn normalize_loopback_endpoint(value: &str) -> AppResult<Url> {
    if value.len() > 512
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || value.contains('\\')
    {
        return Err(err(
            "Original UI endpoints must be literal loopback HTTP(S) without credentials",
        ));
    }
    let mut parsed = Url::parse(value).map_err(|_| err("Invalid original UI endpoint"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(err("Original UI endpoints must use HTTP or HTTPS"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(err("Original UI endpoints must not contain credentials"));
    }
    let host = canonical_host(parsed.host_str().unwrap_or_default());
    if !LOOPBACK.contains(&host.as_str()) {
        return Err(err(
            "Original UI endpoints are restricted to 127.0.0.1 or [::1]",
        ));
    }
    parsed.set_query(None);
    Ok(parsed)
}

pub fn section_url(id: ToolId, endpoint: Option<&str>, section: &str) -> AppResult<String> {
    let tool = spec(id);
    let path = tool
        .section_paths
        .iter()
        .find(|(name, _)| *name == section)
        .map(|(_, path)| *path)
        .ok_or_else(|| err(&format!("Unsupported {} section: {section}", tool.name)))?;
    let mut base = normalize_loopback_endpoint(endpoint.unwrap_or(tool.default_endpoint))?;
    if path.starts_with('#') {
        base.set_path("/");
        base.set_fragment(Some(path.trim_start_matches('#')));
        return Ok(base.to_string());
    }
    let (pathname, fragment) = path
        .split_once('#')
        .map(|(head, rest)| (head, Some(rest)))
        .unwrap_or((path, None));
    base.set_path(pathname);
    base.set_fragment(fragment);
    let host = canonical_host(base.host_str().unwrap_or_default());
    if !LOOPBACK.contains(&host.as_str()) {
        return Err(err("Original UI section URL escaped the loopback boundary"));
    }
    Ok(base.to_string())
}

pub fn cpa_runtime_yaml(management_key: &str, proxy_api_key: &str, state: &Path) -> String {
    let auth = state.join("auth");
    let _logs = state.join("logs");
    format!(
        "host: \"127.0.0.1\"\nport: 8317\nauth-dir: {}\napi-keys:\n  - {}\nremote-management:\n  allow-remote: false\n  secret-key: {}\n  disable-control-panel: false\ndebug: false\nrequest-log: false\nlogging-to-file: true\nlogs-max-total-size-mb: 100\nusage-statistics-enabled: true\n",
        json_string(&auth.to_string_lossy()),
        json_string(proxy_api_key),
        json_string(management_key),
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

pub fn verify_sha256(bytes: &[u8], expected: &str) -> AppResult<()> {
    let digest = hex_encode(&Sha256::digest(bytes));
    if digest != expected.to_ascii_lowercase() {
        return Err(err("Checksum mismatch for managed CPA archive"));
    }
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn processes() -> &'static Mutex<HashMap<String, Vec<Child>>> {
    static PROCESSES: OnceLock<Mutex<HashMap<String, Vec<Child>>>> = OnceLock::new();
    PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn data_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("coding-tools-mcp")
        .join("managed-components")
}

fn components_root() -> PathBuf {
    data_root().join("components")
}

fn state_root() -> PathBuf {
    data_root().join("state")
}

fn trash_root() -> PathBuf {
    data_root().join("Trash").join("managed-components")
}

#[allow(dead_code)]
pub fn move_to_trash(source: &Path, id: &str) -> AppResult<()> {
    if !source.exists() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = trash_root().join(id).join(stamp.to_string());
    fs::create_dir_all(dest.parent().unwrap_or(Path::new(".")))?;
    fs::rename(source, &dest).map_err(|_| err("Could not retain replaced files in Trash"))?;
    Ok(())
}

fn home_dir(id: ToolId) -> Option<PathBuf> {
    let tool = spec(id);
    std::env::var(tool.home_env)
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists())
        .or_else(|| {
            let current = components_root().join(id.as_str()).join("current");
            current.exists().then_some(current)
        })
}

fn secret_path() -> PathBuf {
    data_root().join("managed-components.secrets.json")
}

fn load_secrets() -> serde_json::Value {
    fs::read_to_string(secret_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({"version":1,"components":{}}))
}

fn store_secrets(value: &serde_json::Value) -> AppResult<()> {
    fs::create_dir_all(data_root())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut file = fs::File::create(secret_path())?;
        file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_mode(0o600);
        file.set_permissions(permissions)?;
    }
    #[cfg(not(unix))]
    {
        fs::write(secret_path(), serde_json::to_string_pretty(value)?)?;
    }
    Ok(())
}

fn generated_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple()
    )
}

fn missing_secret(entry: &serde_json::Value, key: &str) -> bool {
    entry
        .get(key)
        .and_then(|value| value.as_str())
        .is_none_or(|value| value.len() < 32)
}

fn ensure_secrets(id: ToolId) -> AppResult<serde_json::Value> {
    let mut secrets = load_secrets();
    let components = secrets
        .get_mut("components")
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| err("Managed secrets store is invalid"))?;
    let entry = components
        .entry(id.as_str().to_string())
        .or_insert_with(|| serde_json::json!({}));
    match id {
        ToolId::Cpa => {
            if missing_secret(entry, "managementKey") {
                entry["managementKey"] = generated_secret().into();
            }
            if missing_secret(entry, "proxyApiKey") {
                entry["proxyApiKey"] = generated_secret().into();
            }
        }
        ToolId::CommandCodeProxy if missing_secret(entry, "proxyApiKey") => {
            entry["proxyApiKey"] = generated_secret().into();
        }
        _ => {}
    }
    store_secrets(&secrets)?;
    Ok(secrets["components"][id.as_str()].clone())
}

pub fn cpa_management_key() -> AppResult<String> {
    let secrets = ensure_secrets(ToolId::Cpa)?;
    secrets
        .get("managementKey")
        .and_then(|value| value.as_str())
        .filter(|value| value.len() >= 32)
        .map(str::to_string)
        .ok_or_else(|| err("CPA management key is unavailable"))
}

fn owned_pid(id: ToolId) -> Option<u32> {
    let mut guard = processes().lock().ok()?;
    let children = guard.get_mut(id.as_str())?;
    children.retain_mut(|child| child.try_wait().ok().flatten().is_none());
    children.first().map(|child| child.id())
}

fn record_child(id: ToolId, child: Child) {
    if let Ok(mut guard) = processes().lock() {
        guard.entry(id.as_str().into()).or_default().push(child);
    }
}

pub async fn inspect(id: ToolId) -> ToolSnapshot {
    let tool = spec(id);
    let endpoint = tool.default_endpoint.to_string();
    let pid = owned_pid(id);
    let install_state = if home_dir(id).is_some() {
        "installed"
    } else {
        "not-installed"
    };
    let health = probe(&endpoint, tool.health_path, id).await;
    let (status, error, health_value) = match health {
        Ok(value) => ("ready".into(), None, Some(value)),
        Err(message) => {
            if pid.is_some() {
                ("starting".into(), Some(message), None)
            } else {
                ("offline".into(), Some(message), None)
            }
        }
    };
    ToolSnapshot {
        id,
        name: tool.name.into(),
        endpoint,
        status,
        sections: tool
            .sections
            .iter()
            .map(|section| (*section).into())
            .collect(),
        pid,
        owned: pid.is_some(),
        original_chrome: true,
        install_state: install_state.into(),
        error,
        health: health_value,
    }
}

pub async fn snapshot() -> Catalog {
    let mut tools = Vec::new();
    for id in ToolId::all() {
        tools.push(inspect(id).await);
    }
    Catalog { version: 1, tools }
}

async fn probe(endpoint: &str, health_path: &str, id: ToolId) -> Result<serde_json::Value, String> {
    let mut url = normalize_loopback_endpoint(endpoint).map_err(|error| error.to_string())?;
    url.set_path(health_path);
    url.set_fragment(None);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .header("Accept", "application/json, text/html;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|_| format!("{} is not reachable on loopback", spec(id).name))?;
    let status = response.status().as_u16();
    if status >= 500 {
        return Err(format!("{} returned HTTP {status}", spec(id).name));
    }
    let bytes = response.bytes().await.unwrap_or_default();
    if bytes.len() > MAX_BYTES {
        return Err("Health response exceeds the observation limit".into());
    }
    let body = String::from_utf8_lossy(&bytes);
    if id == ToolId::CommandCodeProxy {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
            return Ok(value);
        }
    }
    Ok(serde_json::json!({
        "httpStatus": status,
        "reachable": true,
        "bytes": bytes.len(),
    }))
}

fn spawn_managed(
    id: ToolId,
    executable: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> AppResult<u32> {
    if !executable.is_absolute() {
        return Err(err("Managed executable must be an absolute path"));
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = command
        .spawn()
        .map_err(|error| err(&format!("Could not start {}: {error}", spec(id).name)))?;
    let pid = child.id();
    record_child(id, child);
    Ok(pid)
}

pub async fn start(id: ToolId) -> AppResult<ToolSnapshot> {
    let current = inspect(id).await;
    if current.status == "ready" {
        return Ok(current);
    }
    match id {
        ToolId::Cpa => start_cpa().await?,
        ToolId::CommandCodeProxy => start_commandcode()?,
        ToolId::Paseo => start_npm(id, &["start"])?,
        ToolId::Anneal => start_npm(id, &["run", "dev:web"])?,
        ToolId::CodexRouter => start_codex_router()?,
    }
    Ok(inspect(id).await)
}

fn npm_executable() -> PathBuf {
    which::which("npm").unwrap_or_else(|_| PathBuf::from("npm"))
}

fn start_npm(id: ToolId, args: &[&str]) -> AppResult<()> {
    let home = home_dir(id).ok_or_else(|| {
        err(&format!(
            "Install {} first or set {}",
            spec(id).name,
            spec(id).home_env
        ))
    })?;
    let mut command = Command::new(npm_executable());
    command
        .args(args)
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if id == ToolId::Paseo {
        command.env("PASEO_LISTEN", "127.0.0.1:6768");
    }
    let child = command
        .spawn()
        .map_err(|error| err(&format!("Could not start {}: {error}", spec(id).name)))?;
    record_child(id, child);
    Ok(())
}

fn start_commandcode() -> AppResult<()> {
    let home = home_dir(ToolId::CommandCodeProxy).ok_or_else(|| {
        err("Install CommandCode Proxy first or set CODING_TOOLS_COMMANDCODE_HOME")
    })?;
    let entry = home.join("proxy.mjs");
    if !entry.is_file() {
        return Err(err("CommandCode Proxy entry proxy.mjs is missing"));
    }
    let runtime = which::which("node").unwrap_or_else(|_| PathBuf::from("node"));
    let secrets = ensure_secrets(ToolId::CommandCodeProxy)?;
    let key = secrets
        .get("proxyApiKey")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let mut command = Command::new(runtime);
    command
        .arg(&entry)
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PROXY_HOST", "127.0.0.1")
        .env("PROXY_PORT", "9090")
        .env("PROXY_API_KEY", key);
    let child = command
        .spawn()
        .map_err(|error| err(&format!("Could not start CommandCode Proxy: {error}")))?;
    record_child(ToolId::CommandCodeProxy, child);
    Ok(())
}

fn start_codex_router() -> AppResult<()> {
    let home = home_dir(ToolId::CodexRouter)
        .ok_or_else(|| err("Install Codex Router first or set CODING_TOOLS_CODEX_ROUTER_HOME"))?;
    let entry = home.join("src").join("foreground-start.mjs");
    if !entry.is_file() {
        return Err(err("Codex Router foreground-start.mjs is missing"));
    }
    let runtime = which::which("node").unwrap_or_else(|_| PathBuf::from("node"));
    let mut command = Command::new(runtime);
    command
        .arg(&entry)
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|error| err(&format!("Could not start Codex Router: {error}")))?;
    record_child(ToolId::CodexRouter, child);
    Ok(())
}

async fn start_cpa() -> AppResult<()> {
    let home = match home_dir(ToolId::Cpa) {
        Some(home) => home,
        None => return Err(err("Install CPA first or set CODING_TOOLS_CPA_HOME")),
    };
    let marker = home.join("runtime").join("CPA_RUNTIME.json");
    let executable = if marker.is_file() {
        let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(&marker)?)?;
        home.join("runtime").join(
            parsed
                .get("executable")
                .and_then(|value| value.as_str())
                .ok_or_else(|| err("CPA runtime marker is invalid"))?,
        )
    } else {
        find_cpa_binary(&home.join("runtime")).or_else(|_| find_cpa_binary(&home))?
    };
    if !executable.is_file() {
        return Err(err("CPA runtime binary is missing"));
    }
    let secrets = ensure_secrets(ToolId::Cpa)?;
    let management_key = secrets["managementKey"].as_str().unwrap_or_default();
    let proxy_api_key = secrets["proxyApiKey"].as_str().unwrap_or_default();
    let state = state_root().join("cpa");
    fs::create_dir_all(state.join("auth"))?;
    fs::create_dir_all(state.join("logs"))?;
    let config = state.join("config.yaml");
    fs::write(
        &config,
        cpa_runtime_yaml(management_key, proxy_api_key, &state),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&config)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&config, permissions)?;
    }
    let config_path = config.to_string_lossy().into_owned();
    spawn_managed(
        ToolId::Cpa,
        &executable,
        &["--config", &config_path, "--no-browser"],
        Some(&state),
    )?;
    Ok(())
}

fn find_cpa_binary(root: &Path) -> AppResult<PathBuf> {
    let mut matches = Vec::new();
    visit_files(root, &mut matches)?;
    if matches.len() != 1 {
        return Err(err(
            "CPA runtime must contain exactly one cli-proxy-api binary",
        ));
    }
    Ok(matches.remove(0))
}

fn visit_files(root: &Path, matches: &mut Vec<PathBuf>) -> AppResult<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(err("CPA runtime contains a symbolic link"));
        }
        if metadata.is_dir() {
            visit_files(&path, matches)?;
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name == "cli-proxy-api" || name == "cli-proxy-api.exe" {
            matches.push(path);
        }
    }
    Ok(())
}

pub fn stop(id: ToolId) -> AppResult<ToolSnapshot> {
    if let Ok(mut guard) = processes().lock() {
        if let Some(mut children) = guard.remove(id.as_str()) {
            for child in children.iter_mut().rev() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    Ok(ToolSnapshot {
        pid: None,
        owned: false,
        status: "offline".into(),
        ..poll_sync(id)
    })
}

fn poll_sync(id: ToolId) -> ToolSnapshot {
    let tool = spec(id);
    ToolSnapshot {
        id,
        name: tool.name.into(),
        endpoint: tool.default_endpoint.into(),
        status: "offline".into(),
        sections: tool
            .sections
            .iter()
            .map(|section| (*section).into())
            .collect(),
        pid: None,
        owned: false,
        original_chrome: true,
        install_state: if home_dir(id).is_some() {
            "installed".into()
        } else {
            "not-installed".into()
        },
        error: None,
        health: None,
    }
}

pub async fn restart(id: ToolId) -> AppResult<ToolSnapshot> {
    let _ = stop(id);
    start(id).await
}

pub async fn bootstrap() -> AppResult<Catalog> {
    for id in ToolId::all() {
        let _ = start(id).await;
    }
    Ok(snapshot().await)
}

pub fn open_target(id: ToolId, section: Option<&str>) -> AppResult<OpenResult> {
    let tool = spec(id);
    let selected = section
        .filter(|value| !value.is_empty())
        .unwrap_or(tool.sections[0]);
    Ok(OpenResult {
        tool: poll_sync(id),
        section: selected.into(),
        url: section_url(id, None, selected)?,
        original_window: tool.original_window || id != ToolId::CommandCodeProxy,
    })
}

pub fn window_label(id: ToolId) -> String {
    format!("original-ui-{}", id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_section_urls_match_upstream_contracts() {
        assert_eq!(
            section_url(ToolId::Cpa, None, "dashboard").unwrap(),
            "http://127.0.0.1:8317/management.html#/dashboard"
        );
        assert_eq!(
            section_url(ToolId::Paseo, None, "agents").unwrap(),
            "http://127.0.0.1:6768/sessions"
        );
        assert_eq!(
            section_url(ToolId::Paseo, None, "workspaces").unwrap(),
            "http://127.0.0.1:6768/open-project"
        );
        assert_eq!(
            section_url(ToolId::Anneal, None, "tasks").unwrap(),
            "http://127.0.0.1:5173/#/tasks"
        );
        assert_eq!(
            section_url(ToolId::CommandCodeProxy, None, "banner").unwrap(),
            "http://127.0.0.1:9090/"
        );
        assert!(section_url(ToolId::Cpa, Some("https://example.com/"), "dashboard").is_err());
        assert!(normalize_loopback_endpoint("http://user:pass@127.0.0.1:8317/").is_err());
    }

    #[test]
    fn cpa_keeps_original_management_panel() {
        let yaml = cpa_runtime_yaml(
            &"k".repeat(32),
            &"p".repeat(32),
            Path::new("/tmp/cpa-state"),
        );
        assert!(yaml.contains("host: \"127.0.0.1\""));
        assert!(yaml.contains("port: 8317"));
        assert!(yaml.contains("disable-control-panel: false"));
        assert!(yaml.contains("allow-remote: false"));
        assert!(!yaml.contains("disable-control-panel: true"));
    }

    #[test]
    fn checksum_and_trash_retention_hold() {
        let bytes = b"coding-tools-cpa";
        let digest = hex_encode(&Sha256::digest(bytes));
        assert!(verify_sha256(bytes, &digest).is_ok());
        assert!(verify_sha256(bytes, "00").is_err());
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("keep.txt"), "x").unwrap();
        let previous = std::env::var("HOME").ok();
        // data_root uses dirs; trash path is still constructed without deleting source in place.
        assert!(trash_root().ends_with(Path::new("Trash/managed-components")));
        drop(previous);
        let _ = source;
    }

    #[test]
    fn catalog_covers_all_five_stacks() {
        assert_eq!(ToolId::all().len(), 5);
        assert_eq!(TOOLS.len(), 5);
        assert!(TOOLS
            .iter()
            .any(|tool| tool.id == ToolId::CodexRouter && tool.original_window));
        assert_eq!(spec(ToolId::CommandCodeProxy).health_path, "/");
    }
}

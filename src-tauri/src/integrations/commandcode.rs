//! Loopback-only CommandCode Proxy observation and non-secret registration apply.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const MAX_BYTES: usize = 2 * 1024 * 1024;

fn err(s: &str) -> AppError {
    AppError::Message(s.into())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Serialize, Debug)]
pub struct CommandCodeBanner {
    pub version: Option<String>,
    pub listen: String,
    pub cursor_base_url: String,
    pub anthropic_base_url: String,
}

#[derive(Clone, Serialize, Debug)]
pub struct CommandCodeProxyStatus {
    pub endpoint: String,
    pub checked_at: u64,
    pub reachable: bool,
    pub http_status: Option<u16>,
    pub model_count: Option<usize>,
    pub read_only: bool,
    pub health: Option<String>,
    pub banner: Option<CommandCodeBanner>,
    pub owned_process: bool,
}

#[derive(Serialize, Debug)]
pub struct CommandCodeProxyApplyStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Debug)]
pub struct CommandCodeProxyApplyResult {
    pub endpoint: String,
    pub credential_prompt_required: bool,
    pub steps: Vec<CommandCodeProxyApplyStep>,
}

pub fn parse_loopback_http(value: &str) -> AppResult<Url> {
    if value.len() > 512
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || value.contains('\\')
    {
        return Err(err(
            "Use a literal loopback endpoint without whitespace or credentials",
        ));
    }
    let u = Url::parse(value).map_err(|_| err("Invalid CommandCode Proxy endpoint"))?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(err(
            "Credentials and query parameters are not allowed in endpoint URLs",
        ));
    }
    match u.host() {
        Some(url::Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => {}
        Some(url::Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => {}
        _ => {
            return Err(err(
                "Use 127.0.0.1 or [::1]. Remote services require a user-managed secure local port forward.",
            ))
        }
    }
    if u.port().is_none() {
        return Err(err("Specify the CommandCode Proxy port"));
    }
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(err("CommandCode Proxy uses HTTP(S) on loopback"));
    }
    Ok(u)
}

fn models_url(mut u: Url) -> Url {
    let path = u.path().trim_end_matches('/').to_string();
    if path.is_empty() || path == "/" {
        u.set_path("/v1/models");
    } else if path.ends_with("/models") {
        u.set_path(&path);
    } else {
        u.set_path(&format!("{path}/models"));
    }
    u
}

fn count_models(body: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(data) = value.get("data").and_then(|v| v.as_array()) {
        return Some(data.len().min(200));
    }
    if let Some(models) = value.get("models").and_then(|v| v.as_array()) {
        return Some(models.len().min(200));
    }
    None
}

fn origin_urls(parsed: &Url) -> (String, String) {
    let mut cursor = parsed.clone();
    let path = cursor.path().trim_end_matches('/').to_string();
    if path.is_empty() || path == "/" {
        cursor.set_path("/v1");
    } else if !path.ends_with("/v1") {
        cursor.set_path(&format!("{path}/v1"));
    }
    let mut anthropic = parsed.clone();
    anthropic.set_path("/");
    (
        cursor.to_string().trim_end_matches('/').to_string(),
        anthropic.to_string().trim_end_matches('/').to_string(),
    )
}

fn health_url(parsed: &Url) -> Url {
    let mut u = parsed.clone();
    u.set_path("/health");
    u.set_query(None);
    u
}

fn banner_for(parsed: &Url, version: Option<String>) -> CommandCodeBanner {
    let (cursor_base_url, anthropic_base_url) = origin_urls(parsed);
    CommandCodeBanner {
        version,
        listen: parsed.to_string(),
        cursor_base_url,
        anthropic_base_url,
    }
}

static OWNED: Mutex<Option<std::process::Child>> = Mutex::new(None);

pub fn owned_running() -> bool {
    let mut guard = OWNED.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return true,
            _ => *guard = None,
        }
    }
    false
}

pub async fn status(raw: &str) -> AppResult<CommandCodeProxyStatus> {
    let parsed = parse_loopback_http(raw)?;
    let endpoint = parsed.to_string();
    let target = models_url(parsed.clone());
    let health_target = health_url(&parsed);
    let banner = banner_for(&parsed, None);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| err("Cannot initialize CommandCode Proxy probe"))?;
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        let health = match client.get(health_target).send().await {
            Ok(response) if response.status().as_u16() < 500 => {
                let body = response.text().await.unwrap_or_default();
                Some(body.chars().filter(|c| !c.is_control()).take(32).collect())
            }
            _ => None,
        };
        match client
            .get(target)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(response) => {
                let http_status = response.status().as_u16();
                let reachable = http_status < 500 || health.is_some();
                let model_count = if http_status == 200 {
                    let bytes = response.bytes().await.unwrap_or_default();
                    if bytes.len() <= MAX_BYTES {
                        count_models(&String::from_utf8_lossy(&bytes))
                    } else {
                        None
                    }
                } else {
                    None
                };
                Ok(CommandCodeProxyStatus {
                    endpoint,
                    checked_at: now(),
                    reachable,
                    http_status: Some(http_status),
                    model_count,
                    read_only: true,
                    health,
                    banner: Some(banner),
                    owned_process: owned_running(),
                })
            }
            Err(_) => Ok(CommandCodeProxyStatus {
                endpoint,
                checked_at: now(),
                reachable: health.is_some(),
                http_status: None,
                model_count: None,
                read_only: true,
                health,
                banner: Some(banner),
                owned_process: owned_running(),
            }),
        }
    })
    .await;
    result.map_err(|_| err("CommandCode Proxy probe timed out"))?
}

fn safe_cli(value: &str, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return Err(err(&format!("{label} path is required")));
    }
    if trimmed.contains("..")
        || !trimmed.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '@' | '=')
        })
    {
        return Err(err(&format!(
            "{label} must be a simple executable name or absolute path"
        )));
    }
    Ok(trimmed.to_string())
}

fn normalize_base_url(raw: &str) -> AppResult<String> {
    let mut u = parse_loopback_http(raw)?;
    let path = u.path().trim_end_matches('/').to_string();
    if path.is_empty() {
        u.set_path("/v1");
    } else {
        u.set_path(&path);
    }
    let mut rendered = u.to_string();
    while rendered.ends_with('/') {
        rendered.pop();
    }
    Ok(rendered)
}

fn is_loopback_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|u| u.host().map(|h| h.to_string()))
        .map(|host| host == "127.0.0.1" || host == "localhost" || host == "::1")
        .unwrap_or(false)
}

pub fn non_secret_commands(
    base_url: &str,
    router_cli: &str,
    curate_cli: &str,
) -> AppResult<Vec<(String, Vec<String>)>> {
    let router = safe_cli(router_cli, "Codex Router CLI")?;
    let curate = safe_cli(curate_cli, "Codex Router curate-models")?;
    let normalized = normalize_base_url(base_url)?;
    let mut add = vec![
        router.clone(),
        "codex".into(),
        "providers".into(),
        "generic".into(),
        "add".into(),
        "commandcode-proxy".into(),
        "--name".into(),
        "CommandCode Proxy".into(),
        "--base-url".into(),
        normalized,
        "--adapter".into(),
        "openai-chat".into(),
    ];
    if is_loopback_url(base_url) {
        add.push("--allow-private".into());
    }
    Ok(vec![
        ("add".into(), add),
        (
            "enable".into(),
            vec![
                router,
                "codex".into(),
                "providers".into(),
                "generic".into(),
                "enable".into(),
                "commandcode-proxy".into(),
            ],
        ),
        ("curate".into(), vec![curate, "commandcode-proxy".into()]),
    ])
}

fn run_step(name: &str, command: &[String]) -> CommandCodeProxyApplyStep {
    let mut child = match std::process::Command::new(&command[0])
        .args(&command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CommandCodeProxyApplyStep {
                name: name.into(),
                ok: false,
                detail: format!(
                    "{} is not runnable ({error}). Copy the plan and run it where Codex Router CLI is installed.",
                    command[0]
                ),
            };
        }
    };
    match child.wait() {
        Ok(status) if status.success() => CommandCodeProxyApplyStep {
            name: name.into(),
            ok: true,
            detail: format!("{name} completed"),
        },
        Ok(status) => CommandCodeProxyApplyStep {
            name: name.into(),
            ok: false,
            detail: format!("{name} exited with {status}"),
        },
        Err(error) => CommandCodeProxyApplyStep {
            name: name.into(),
            ok: false,
            detail: error.to_string(),
        },
    }
}

pub fn apply(
    base_url: &str,
    router_cli: &str,
    curate_cli: &str,
) -> AppResult<CommandCodeProxyApplyResult> {
    let commands = non_secret_commands(base_url, router_cli, curate_cli)?;
    if commands
        .iter()
        .any(|(_, argv)| argv.iter().any(|part| part == "credential"))
    {
        return Err(err(
            "Credential commands cannot be applied from Coding Tools",
        ));
    }
    Ok(CommandCodeProxyApplyResult {
        endpoint: normalize_base_url(base_url)?,
        credential_prompt_required: true,
        steps: commands
            .into_iter()
            .map(|(name, argv)| run_step(&name, &argv))
            .collect(),
    })
}

#[derive(Clone, Serialize, Debug)]
pub struct CommandCodeProcessResult {
    pub ok: bool,
    pub action: String,
    pub detail: String,
    pub owned_process: bool,
}

pub fn control(action: &str, endpoint: &str, bin: &str) -> AppResult<CommandCodeProcessResult> {
    match action {
        "start" => start(endpoint, bin),
        "stop" => stop(),
        "restart" => {
            let _ = stop();
            start(endpoint, bin)
        }
        _ => Err(err(
            "CommandCode process action must be start, stop or restart",
        )),
    }
}

fn start(endpoint: &str, bin: &str) -> AppResult<CommandCodeProcessResult> {
    if owned_running() {
        return Ok(CommandCodeProcessResult {
            ok: true,
            action: "start".into(),
            detail: "Owned CommandCode Proxy is already running".into(),
            owned_process: true,
        });
    }
    let parsed = parse_loopback_http(endpoint)?;
    let port = parsed
        .port()
        .ok_or_else(|| err("Specify the CommandCode Proxy port"))?;
    let exe = safe_cli(bin, "CommandCode Proxy binary")?;
    let mut command = if exe.ends_with(".mjs") || exe.ends_with(".js") {
        let mut c = std::process::Command::new("node");
        c.arg(&exe);
        c
    } else {
        std::process::Command::new(&exe)
    };
    command
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.spawn() {
        Ok(child) => {
            *OWNED.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
            Ok(CommandCodeProcessResult {
                ok: true,
                action: "start".into(),
                detail: format!("Started owned proxy on 127.0.0.1:{port}"),
                owned_process: true,
            })
        }
        Err(error) => Ok(CommandCodeProcessResult {
            ok: false,
            action: "start".into(),
            detail: format!("Cannot start CommandCode Proxy ({error})"),
            owned_process: false,
        }),
    }
}

fn stop() -> AppResult<CommandCodeProcessResult> {
    let mut guard = OWNED.lock().unwrap_or_else(|p| p.into_inner());
    match guard.take() {
        Some(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            Ok(CommandCodeProcessResult {
                ok: true,
                action: "stop".into(),
                detail: "Stopped the owned CommandCode Proxy process".into(),
                owned_process: false,
            })
        }
        None => Ok(CommandCodeProcessResult {
            ok: false,
            action: "stop".into(),
            detail: "No owned CommandCode Proxy process. Stop it where it was started.".into(),
            owned_process: false,
        }),
    }
}

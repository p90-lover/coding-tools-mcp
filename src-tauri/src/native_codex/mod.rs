//! Locally enabled official Codex runtime. Legacy MCP tools cannot bypass this profile.
pub mod commands;
pub mod protocol;
mod session;
mod transport;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

use crate::app_state::AppState;
use crate::data::DataStore;
use crate::tools::workspace::{tool_err_code, tool_ok};
use crate::tools::ToolContext;
use crate::workspace::WorkspaceProfile;
use protocol::{EmptyArgs, NativePolicy, PromptArgs, StatusArgs};
use session::NativeSession;
use transport::Wire;

#[derive(Clone)]
pub(crate) struct Binding {
    pub profile: String,
    pub instance: String,
    pub service: String,
}
struct Slot {
    generation: String,
    session: Option<Arc<NativeSession>>,
    instances: Vec<String>,
}
static SLOTS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
static BINDINGS: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
fn slots() -> &'static Mutex<HashMap<String, Slot>> {
    SLOTS.get_or_init(Mutex::default)
}
fn bindings() -> &'static Mutex<HashMap<(String, String), String>> {
    BINDINGS.get_or_init(Mutex::default)
}

pub(crate) fn bind_context(ctx: &mut ToolContext, profile: &str, service: &str) {
    let instance = uuid::Uuid::new_v4().to_string();
    if let Ok(mut bindings) = bindings().lock() {
        bindings.insert((profile.into(), service.into()), instance.clone());
    }
    ctx.native_binding = Some(Binding {
        profile: profile.into(),
        instance,
        service: service.into(),
    });
}

fn profile(id: &str) -> Result<WorkspaceProfile, String> {
    DataStore::read_file(|data| {
        data.profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| crate::error::AppError::Message("Workspace not found".into()))
    })
    .map_err(|e| e.to_string())
}
fn fingerprint(profile: &WorkspaceProfile) -> Result<String, String> {
    // Ignore rotating public tunnel URLs; bind only authorization and execution state.
    let links =
        crate::workspace::linked_projects::list_linked_projects_for_root(Path::new(&profile.path));
    let state = json!({"id":profile.id,"path":profile.path,"runtime":profile.runtime,
        "auth":profile.auth,"actions_auth":profile.actions.auth_type,
        "actions_client":profile.actions.oauth_client_id,"actions_shared":profile.actions.use_shared_secrets,
        "actions_port":profile.actions.local_port,"links":links});
    let bytes = serde_json::to_vec(&state).map_err(|_| "Cannot fingerprint workspace settings")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn get_session(id: &str) -> Result<Arc<NativeSession>, String> {
    slots()
        .lock()
        .map_err(|_| "Native connections unavailable")?
        .get(id)
        .and_then(|slot| slot.session.clone())
        .ok_or("Enable the native Codex connection in the local desktop window first".into())
}

pub fn invalidate(id: &str) {
    if let Ok(mut map) = bindings().lock() {
        map.retain(|(profile, _), _| profile != id);
    }
    let old = slots().lock().ok().and_then(|mut slots| slots.remove(id));
    if let Some(session) = old.and_then(|s| s.session) {
        session.close("Workspace settings changed or connection was disabled. Reconnect locally; no task was replayed");
    }
}
pub fn shutdown_all() {
    let sessions: Vec<_> = slots()
        .lock()
        .map(|mut s| s.drain().filter_map(|(_, s)| s.session).collect())
        .unwrap_or_default();
    if let Ok(mut map) = bindings().lock() {
        map.clear();
    }
    for session in sessions {
        session.close("Desktop application exited");
    }
}

fn connect(
    app: tauri::AppHandle,
    id: String,
    binary: String,
    network: bool,
    approved_fingerprint: String,
) -> Result<Value, String> {
    let config = profile(&id)?;
    if fingerprint(&config)? != approved_fingerprint {
        return Err("Settings changed after local consent; consent must be obtained again".into());
    }
    if config.runtime.tool_profile != "codex-native" {
        return Err("Save the codex-native tool profile before connecting".into());
    }
    let cwd = PathBuf::from(&config.path)
        .canonicalize()
        .map_err(|_| "Workspace is unavailable")?;
    let mut roots = Vec::new();
    for linked in crate::workspace::linked_projects::list_linked_projects_for_root(&cwd) {
        if !linked.read_only() {
            let path = linked
                .root_path()
                .canonicalize()
                .map_err(|_| "An approved linked root is unavailable")?;
            if path.is_dir() && !roots.contains(&path) {
                roots.push(path);
            }
        }
    }
    if roots.len() > 32 {
        return Err("Native mode supports at most 32 locally approved writable roots".into());
    }
    let binary_path = PathBuf::from(binary.trim());
    if !binary_path.is_absolute() || !binary_path.is_file() {
        return Err(
            "Select an absolute path to the trusted official native Codex executable".into(),
        );
    }
    let binary = binary_path
        .canonicalize()
        .map_err(|_| "Cannot resolve the native Codex executable")?;
    if binary.starts_with(&cwd) || roots.iter().any(|root| binary.starts_with(root)) {
        return Err("Codex must be installed outside writable project roots; project-controlled executables are not trusted".into());
    }
    #[cfg(windows)]
    if binary
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("exe"))
    {
        return Err("Select the native Codex .exe, not a PowerShell or npm .cmd wrapper".into());
    }
    let policy = NativePolicy::new(
        &config.runtime.permission_mode,
        &config.runtime.approval_mode,
        network,
        cwd.clone(),
        roots,
    );
    let signature = fingerprint(&config)?;
    let generation = uuid::Uuid::new_v4().to_string();
    {
        let mut map = slots()
            .lock()
            .map_err(|_| "Native connections unavailable")?;
        if map.contains_key(&id) {
            return Err("Disconnect the current native connection before starting another".into());
        }
        if map.len() >= 4 {
            return Err(
                "Maximum four native workspace connections; disconnect an idle workspace".into(),
            );
        }
        map.insert(
            id.clone(),
            Slot {
                generation: generation.clone(),
                session: None,
                instances: Vec::new(),
            },
        );
    }
    let outcome = (|| {
        let kill: Arc<dyn Fn(u32) + Send + Sync> = Arc::new(|pid| {
            let _ = crate::platform::platform().terminate_process_tree(pid);
            #[cfg(unix)]
            // All children inherit this process group. Never target another session.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        });
        let (wire, incoming) = Wire::spawn(&binary, &cwd, kill)?;
        let event_id = id.clone();
        let event_generation = generation.clone();
        let notify = Arc::new(move || {
            let _ = app.emit_to(
                "main",
                "native-codex-update",
                json!({"workspaceId":event_id,"generation":event_generation}),
            );
        });
        let session = NativeSession::new(
            wire,
            incoming,
            policy,
            signature.clone(),
            generation.clone(),
            notify,
        );
        if let Err(error) = session.initialize() {
            session.close("Native initialization failed; legacy execution was not used");
            return Err(error);
        }
        if profile(&id).and_then(|p| fingerprint(&p)).as_deref() != Ok(signature.as_str()) {
            session.close("Workspace changed during native initialization");
            return Err(
                "Workspace changed while connecting; reconnect with current settings".into(),
            );
        }
        let current_instances = bindings()
            .lock()
            .map_err(|_| "Native listener bindings unavailable")?
            .iter()
            .filter(|((profile, _), _)| profile == &id)
            .map(|(_, instance)| instance.clone())
            .collect();
        let mut map = slots()
            .lock()
            .map_err(|_| "Native connection state unavailable")?;
        let Some(slot) = map.get_mut(&id).filter(|s| s.generation == generation) else {
            session.close("Native connection invalidated during initialization");
            return Err("Connection was invalidated; no execution is enabled".into());
        };
        slot.instances = current_instances;
        slot.session = Some(session.clone());
        session.snapshot(StatusArgs::default(), true)
    })();
    if outcome.is_err() {
        if let Ok(mut map) = slots().lock() {
            if map.get(&id).is_some_and(|s| s.generation == generation) {
                map.remove(&id);
            }
        }
    }
    outcome
}

/// Called before legacy policy, approval, history or task execution.
pub(crate) fn route(ctx: &ToolContext, name: &str, args: &Value) -> Option<Value> {
    let native_name = name.starts_with("codex_");
    let stored = match ctx
        .native_binding
        .as_ref()
        .map(|b| profile(&b.profile))
        .transpose()
    {
        Ok(stored) => stored,
        Err(_) => {
            return Some(tool_err_code(
                "NATIVE_CONFIG_UNAVAILABLE",
                "Cannot verify current workspace policy; execution refused",
                "permission",
            ))
        }
    };
    let native_now = stored
        .as_ref()
        .is_some_and(|p| p.runtime.tool_profile == "codex-native");
    if ctx.tool_profile != "codex-native" && !native_now && !native_name {
        return None;
    }
    let result = (|| {
        if ctx.tool_profile != "codex-native" || !native_now {
            return Err(
                "Native profile changed or unavailable; restart the listener and reconnect locally"
                    .into(),
            );
        }
        if !crate::tools::registry::NATIVE_CODEX_TOOLS.contains(&name) {
            return Err("Legacy direct execution and remote self-approval are unavailable in native Codex mode".into());
        }
        let binding = ctx
            .native_binding
            .as_ref()
            .ok_or("Native listener lacks a trusted workspace binding")?;
        let config = stored.ok_or("Workspace configuration unavailable")?;
        let expected_auth = if binding.service == "actions" {
            config.actions.auth_type.as_str()
        } else {
            config.auth.auth_type.as_str()
        };
        if !matches!(ctx.auth.auth_type.as_str(), "oauth" | "bearer" | "api_key")
            || ctx.auth.auth_type != expected_auth
        {
            return Err(
                "Native HTTP tools require current OAuth, bearer or API-key authentication".into(),
            );
        }
        let session = get_session(&binding.profile)?;
        let allowed = slots()
            .lock()
            .map_err(|_| "Native bindings unavailable")?
            .get(&binding.profile)
            .is_some_and(|s| s.instances.contains(&binding.instance));
        if !allowed
            || fingerprint(&config)? != session.fingerprint
            || !protocol::same_path(ctx.workspace.root(), Path::new(&config.path))
        {
            return Err("Listener or workspace changed since local consent; restart the listener and reconnect locally".into());
        }
        invoke(&session, name, args)
    })();
    Some(match result {
        Ok(v) => tool_ok(v),
        Err(e) => tool_err_code("NATIVE_CODEX_REJECTED", e, "permission"),
    })
}
fn invoke(session: &NativeSession, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "codex_start" | "codex_continue" => {
            session.turn(PromptArgs::parse(args)?, name == "codex_continue")
        }
        "codex_status" => session.snapshot(
            serde_json::from_value(args.clone())
                .map_err(|_| "Expected only cursor and max_events")?,
            false,
        ),
        "codex_interrupt" => {
            let _: EmptyArgs = serde_json::from_value(args.clone())
                .map_err(|_| "codex_interrupt takes no arguments")?;
            session.interrupt()
        }
        _ => Err("Unknown native tool".into()),
    }
}

fn local_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "Cannot establish the local window origin")?;
    let production = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none());
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1420);
    if window.label() != "main" || !(production || development) {
        return Err("Native control requires the trusted local main window".into());
    }
    Ok(())
}
fn local_config(app: &tauri::AppHandle, id: &str) -> Result<WorkspaceProfile, String> {
    app.state::<AppState>()
        .with_data(|store| {
            store
                .get(id)
                .cloned()
                .ok_or_else(|| crate::error::AppError::Message("Workspace not found".into()))
        })
        .map_err(|e| e.to_string())
}

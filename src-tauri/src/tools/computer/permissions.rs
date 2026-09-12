//! Explicit local per-application grants. Only metadata is persisted, never pixels.
use super::{error, native, Result, Target};
use crate::data::DataStore;
use crate::error::{AppError, AppResult};
use crate::workspace::WorkspaceProfile;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

static ACTIVE_WORKSPACE: Mutex<Option<String>> = Mutex::new(None);
static RESTORE_BLOCKED: AtomicBool = AtomicBool::new(false);
static REVOCATION_SAVED: AtomicBool = AtomicBool::new(true);
static STOP_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AppIdentity {
    pub executable: PathBuf,
    pub sha256: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SavedPermission {
    pub workspace_id: String,
    pub root: PathBuf,
    pub configuration: String,
    pub apps: Vec<AppIdentity>,
    pub preferred_app: Option<AppIdentity>,
    pub preferred_title: String,
    pub discovery_enabled: bool,
    pub restore_on_start: bool,
    pub start_at_login: bool,
    pub suspended: bool,
}
impl SavedPermission {
    pub fn valid_for(&self, root: &Path, configuration: &str) -> bool {
        self.root == root
            && self.configuration == configuration
            && !self.apps.is_empty()
            && self.apps.len() <= 16
            && self.apps.iter().all(|a| {
                a.executable.is_absolute()
                    && a.sha256.len() == 64
                    && a.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            })
    }
    pub fn can_restore(&self, root: &Path, configuration: &str) -> bool {
        self.restore_on_start
            && !self.suspended
            && self.valid_for(root, configuration)
            && self
                .preferred_app
                .as_ref()
                .is_some_and(|app| self.apps.contains(app))
    }
    pub fn allows(&self, identity: &AppIdentity) -> bool {
        self.apps.contains(identity)
    }
    pub fn summary(&self) -> Value {
        json!({"remembered":!self.apps.is_empty(),"restore_on_start":self.restore_on_start,
            "start_at_login":self.start_at_login,"suspended":self.suspended,
            "discovery_enabled":self.discovery_enabled,"approved_apps":self.apps,
            "restore_scope":"same workspace, unchanged executable hash and security configuration"})
    }
}
pub fn configuration(profile: &WorkspaceProfile) -> String {
    // Deliberately exclude rotating public URLs; authentication settings/policy remain pinned.
    let value = json!({"id":profile.id,"root":profile.path,"auth":profile.auth,
        "runtime":profile.runtime,"tunnel_type":profile.tunnel.tunnel_type,
        "cloudflare_mode":profile.tunnel.cloudflare_mode});
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
pub fn epoch() -> u64 {
    STOP_EPOCH.load(Ordering::SeqCst)
}
pub fn restore_blocked() -> bool {
    RESTORE_BLOCKED.load(Ordering::SeqCst)
}
pub fn set_active(id: &str) {
    *ACTIVE_WORKSPACE.lock().unwrap_or_else(|p| p.into_inner()) = Some(id.into());
}
pub fn block_restore() {
    STOP_EPOCH.fetch_add(1, Ordering::SeqCst);
    RESTORE_BLOCKED.store(true, Ordering::SeqCst);
}
pub fn suspend_active() {
    block_restore();
    let id = ACTIVE_WORKSPACE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(id) = id {
        // Revocation in memory is immediate even if storage fails. Do not auto-rearm in this process.
        if DataStore::update_file(|data| {
            if let Some(grant) = data
                .computer_permissions
                .iter_mut()
                .find(|g| g.workspace_id == id)
            {
                grant.suspended = true;
            }
            Ok(())
        })
        .is_err()
        {
            REVOCATION_SAVED.store(false, Ordering::SeqCst);
            let _ = native::set_login_startup(false);
            eprintln!("Could not persist suspended computer permission; automatic sign-in startup disabled where possible");
        } else {
            REVOCATION_SAVED.store(true, Ordering::SeqCst);
        }
    }
}
pub fn resume_active(expected_epoch: u64) -> AppResult<()> {
    if epoch() != expected_epoch {
        return Err(AppError::Message("Stop cancelled resume".into()));
    }
    let id = ACTIVE_WORKSPACE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(id) = id {
        DataStore::update_file(|data| {
            if let Some(grant) = data
                .computer_permissions
                .iter_mut()
                .find(|g| g.workspace_id == id)
            {
                if epoch() != expected_epoch {
                    return Err(AppError::Message("Stop cancelled resume".into()));
                }
                grant.suspended = false;
            }
            Ok(())
        })?;
    }
    if epoch() != expected_epoch {
        suspend_active();
        return Err(AppError::Message("Stop cancelled resume".into()));
    }
    RESTORE_BLOCKED.store(false, Ordering::SeqCst);
    if epoch() != expected_epoch {
        suspend_active();
        return Err(AppError::Message("Stop cancelled resume".into()));
    }
    Ok(())
}
pub fn get(id: &str) -> AppResult<Option<SavedPermission>> {
    DataStore::read_file(|data| {
        Ok(data
            .computer_permissions
            .iter()
            .find(|g| g.workspace_id == id)
            .cloned())
    })
}
pub fn for_root(root: &Path) -> AppResult<Option<SavedPermission>> {
    DataStore::read_file(|data| {
        Ok(data
            .computer_permissions
            .iter()
            .find(|g| {
                g.root == root
                    && data
                        .profiles
                        .iter()
                        .any(|p| p.id == g.workspace_id && g.valid_for(root, &configuration(p)))
            })
            .cloned())
    })
}
pub fn save_local(
    profile: &WorkspaceProfile,
    root: PathBuf,
    target: &Target,
    restore_on_start: bool,
    start_at_login: bool,
    discovery_enabled: bool,
    expected_epoch: u64,
) -> AppResult<()> {
    let identity =
        native::process_identity(target.pid).map_err(|e| AppError::Message(e.message()))?;
    let config = configuration(profile);
    DataStore::update_file(|data| {
        if epoch() != expected_epoch {
            return Err(AppError::Message("Stop cancelled permission saving".into()));
        }
        let live = data
            .profiles
            .iter()
            .find(|p| p.id == profile.id)
            .ok_or_else(|| {
                AppError::Message("Workspace disappeared before approval was saved".into())
            })?;
        if configuration(live) != config {
            return Err(AppError::Message(
                "Workspace security configuration changed; approve again".into(),
            ));
        }
        if data.computer_permissions.len() >= 32
            && !data
                .computer_permissions
                .iter()
                .any(|g| g.workspace_id == profile.id)
        {
            return Err(AppError::Message(
                "At most 32 saved workspace permission sets are supported".into(),
            ));
        }
        if restore_on_start {
            // One desktop/monitor owner. Do not restore multiple workspace controllers at login.
            for g in &mut data.computer_permissions {
                if g.workspace_id != profile.id {
                    g.restore_on_start = false;
                    g.start_at_login = false;
                }
            }
        }
        let index = match data
            .computer_permissions
            .iter()
            .position(|g| g.workspace_id == profile.id)
        {
            Some(i) => i,
            None => {
                data.computer_permissions.push(SavedPermission::default());
                data.computer_permissions.len() - 1
            }
        };
        let g = &mut data.computer_permissions[index];
        if g.configuration != config {
            g.apps.clear();
        }
        if !g.apps.contains(&identity) {
            if g.apps.len() >= 16 {
                return Err(AppError::Message(
                    "At most 16 applications may be remembered per workspace".into(),
                ));
            }
            g.apps.push(identity.clone());
        }
        g.workspace_id = profile.id.clone();
        g.root = root;
        g.configuration = config;
        g.preferred_app = Some(identity);
        g.preferred_title = target.title.clone();
        g.discovery_enabled = discovery_enabled;
        g.restore_on_start = restore_on_start;
        g.start_at_login = start_at_login;
        g.suspended = false;
        Ok(())
    })?;
    if epoch() != expected_epoch {
        suspend_active();
        return Err(AppError::Message(
            "Stop cancelled saved permission activation".into(),
        ));
    }
    set_active(&profile.id);
    RESTORE_BLOCKED.store(false, Ordering::SeqCst);
    if epoch() != expected_epoch {
        suspend_active();
        return Err(AppError::Message(
            "Stop cancelled saved permission activation".into(),
        ));
    }
    Ok(())
}
pub fn forget_local(id: &str) -> AppResult<()> {
    DataStore::update_file(|data| {
        // Preserve the record in profile backups; revoke permissions without deleting files.
        if let Some(g) = data
            .computer_permissions
            .iter_mut()
            .find(|g| g.workspace_id == id)
        {
            g.apps.clear();
            g.preferred_app = None;
            g.restore_on_start = false;
            g.start_at_login = false;
            g.suspended = true;
            g.discovery_enabled = false;
        }
        Ok(())
    })
}
pub fn is_approved(root: &Path, target: &Target) -> Result<bool> {
    let Some(grant) = for_root(root).map_err(|_| {
        error(
            "PERMISSION_STORE_UNAVAILABLE",
            "Cannot read local remembered permissions",
        )
    })?
    else {
        return Ok(false);
    };
    Ok(!grant.suspended && grant.allows(&native::process_identity(target.pid)?))
}

/// Read current handles each time. Never reuse a persisted PID/HWND or focus a candidate.
pub fn restore_target(g: &SavedPermission) -> Result<Option<Target>> {
    native::require_unlocked_desktop()?;
    let Some(preferred) = &g.preferred_app else {
        return Ok(None);
    };
    if !g.apps.contains(preferred) {
        return Ok(None);
    }
    let mut matches = Vec::new();
    let mut identities = std::collections::HashMap::new();
    for target in native::targets()? {
        // Cache only for this bounded enumeration, never across process lifetimes.
        let identity = identities.entry(target.pid).or_insert_with(|| {
            let path = native::executable_path(target.pid)
                .ok()?
                .canonicalize()
                .ok()?;
            if path != preferred.executable {
                return None;
            }
            native::process_identity(target.pid).ok()
        });
        if identity.as_ref() == Some(preferred) {
            matches.push(target);
        }
    }
    if matches.len() == 1 {
        return Ok(matches.pop());
    }
    let exact: Vec<_> = matches
        .into_iter()
        .filter(|t| t.title == g.preferred_title)
        .collect();
    Ok(if exact.len() == 1 {
        exact.into_iter().next()
    } else {
        None
    })
}
pub fn login_startup(enabled: bool) -> AppResult<()> {
    native::set_login_startup(enabled).map_err(|e| AppError::Message(e.message()))
}

pub fn revocation_saved() -> bool {
    REVOCATION_SAVED.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_remembered_permission_requires_exact_scope_and_executable() {
        let root = std::env::current_dir().unwrap();
        let app = AppIdentity {
            executable: root.join("fixture.exe"),
            sha256: "a".repeat(64),
        };
        let mut g = SavedPermission {
            root: root.clone(),
            configuration: "auth-and-policy".into(),
            apps: vec![app.clone()],
            preferred_app: Some(app.clone()),
            restore_on_start: true,
            ..Default::default()
        };
        assert!(g.can_restore(&root, "auth-and-policy"));
        assert!(!g.can_restore(&root, "different-auth"));
        assert!(!g.can_restore(&root.join("other"), "auth-and-policy"));
        assert!(g.allows(&app));
        assert!(!g.allows(&AppIdentity {
            sha256: "b".repeat(64),
            ..app.clone()
        }));
        g.suspended = true;
        assert!(!g.can_restore(&root, "auth-and-policy"));
        let saved = serde_json::to_vec(&g).unwrap();
        let restored: SavedPermission = serde_json::from_slice(&saved).unwrap();
        assert!(restored.suspended && !restored.can_restore(&root, "auth-and-policy"));
        assert!(!String::from_utf8(saved).unwrap().contains("base64"));
    }
}

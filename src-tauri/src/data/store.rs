use std::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::settings::AppSettings;
use crate::workspace::legacy_import::import_legacy_profiles_if_empty;
use crate::workspace::WorkspaceProfile;

use super::migrate::{data_file_path, load_or_migrate, maybe_backup_legacy_files, save};
use super::model::AppData;

static DATA_FILE_LOCK: Mutex<()> = Mutex::new(());

const SHARED_KEYS: &[&str] = &[
    "oauth_client_id",
    "bearer_token",
    "oauth_client_secret",
    "oauth_password",
    "oauth_token_secret",
    "actions_api_key",
    "actions_oauth_client_secret",
    "actions_oauth_password",
    "actions_oauth_token_secret",
];

#[derive(Debug)]
pub struct DataStore {
    data: AppData,
    baseline: serde_json::Value,
}

impl DataStore {
    pub fn load() -> AppResult<Self> {
        let _guard = lock_data_file()?;
        let path = data_file_path()?;
        let existed_before = path.exists();
        let mut data = load_or_migrate()?;
        let imported = import_legacy_profiles_if_empty(&mut data)?;
        let baseline = serde_json::to_value(&data)?;
        let store = Self { data, baseline };
        if !existed_before || imported > 0 {
            save(&store.data)?;
        }
        if !existed_before {
            maybe_backup_legacy_files(&path)?;
        }
        crate::auth::sync_trusted_origins(&store.data);
        Ok(store)
    }

    pub fn read_file<R>(f: impl FnOnce(&AppData) -> AppResult<R>) -> AppResult<R> {
        let _guard = lock_data_file()?;
        let data = load_or_migrate()?;
        f(&data)
    }

    pub fn update_file<R>(f: impl FnOnce(&mut AppData) -> AppResult<R>) -> AppResult<R> {
        let _guard = lock_data_file()?;
        let mut data = load_or_migrate()?;
        let before = serde_json::to_value(&data)?;
        let result = f(&mut data)?;
        if serde_json::to_value(&data)? != before {
            save(&data)?;
        }
        crate::auth::sync_trusted_origins(&data);
        Ok(result)
    }

    pub fn data(&self) -> &AppData {
        &self.data
    }

    pub fn refresh(&mut self) -> AppResult<()> {
        let _guard = lock_data_file()?;
        let data = load_or_migrate()?;
        self.baseline = serde_json::to_value(&data)?;
        self.data = data;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }

    pub fn save(&mut self) -> AppResult<()> {
        let _guard = lock_data_file()?;
        let latest = load_or_migrate()?;
        let latest_value = serde_json::to_value(&latest)?;
        let local = serde_json::to_value(&self.data)?;
        let merged = match merge_local_changes(&self.baseline, &local, &latest_value) {
            Ok(value) => value,
            Err(error) => {
                self.baseline = latest_value;
                self.data = latest;
                return Err(error);
            }
        };
        let data: AppData = serde_json::from_value(merged.clone())?;
        if merged != latest_value {
            save(&data)?;
        }
        self.data = data;
        self.baseline = merged;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }

    pub fn settings(&self) -> AppSettings {
        AppSettings::from_data(&self.data)
    }

    pub fn update_settings(&mut self, settings: AppSettings) -> AppResult<()> {
        settings.apply_to(&mut self.data);
        self.save()
    }

    pub fn list(&self) -> &[WorkspaceProfile] {
        &self.data.profiles
    }

    pub fn get(&self, id: &str) -> Option<&WorkspaceProfile> {
        self.data.profiles.iter().find(|profile| profile.id == id)
    }

    pub fn add(&mut self, profile: WorkspaceProfile) -> AppResult<()> {
        self.data.profiles.push(profile);
        self.save()
    }

    pub fn update(&mut self, profile: WorkspaceProfile) -> AppResult<()> {
        let Some(index) = self
            .data
            .profiles
            .iter()
            .position(|item| item.id == profile.id)
        else {
            return Err(AppError::Message(format!(
                "workspace not found: {}",
                profile.id
            )));
        };
        self.data.profiles[index] = profile;
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> AppResult<Option<WorkspaceProfile>> {
        let Some(index) = self.data.profiles.iter().position(|item| item.id == id) else {
            return Ok(None);
        };
        let removed = self.data.profiles.remove(index);
        self.data.workspace_secrets.remove(id);
        self.save()?;
        Ok(Some(removed))
    }

    pub fn init_workspace_secrets(&mut self, profile_id: &str) -> AppResult<()> {
        // oauth_client_secret is optional for MCP OAuth (ChatGPT PKCE); not auto-generated.
        self.set_workspace_secret(profile_id, "oauth_password", &random_secret())?;
        self.set_workspace_secret(profile_id, "oauth_token_secret", &random_secret())?;
        self.set_workspace_secret(profile_id, "bearer_token", &random_secret())?;
        self.set_workspace_secret(profile_id, "actions_api_key", &random_secret())?;
        self.set_workspace_secret(profile_id, "actions_oauth_client_secret", &random_secret())?;
        self.set_workspace_secret(profile_id, "actions_oauth_password", &random_secret())?;
        self.set_workspace_secret(profile_id, "actions_oauth_token_secret", &random_secret())?;
        Ok(())
    }

    pub fn init_shared_secrets(&mut self) -> AppResult<()> {
        let mut changed = false;
        for key in SHARED_KEYS {
            if !self.data.shared_secrets.contains_key(*key) {
                self.data
                    .shared_secrets
                    .insert(key.to_string(), shared_value_for_key(key));
                changed = true;
            }
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }

    pub fn get_workspace_secret(&self, profile_id: &str, key: &str) -> AppResult<Option<String>> {
        Ok(self
            .data
            .workspace_secrets
            .get(profile_id)
            .and_then(|secrets| secrets.get(key))
            .filter(|value| !value.is_empty())
            .cloned())
    }

    pub fn set_workspace_secret(
        &mut self,
        profile_id: &str,
        key: &str,
        value: &str,
    ) -> AppResult<()> {
        self.data
            .workspace_secrets
            .entry(profile_id.to_string())
            .or_default()
            .insert(key.to_string(), value.to_string());
        self.save()
    }

    pub fn regenerate_workspace_secret(
        &mut self,
        profile_id: &str,
        key: &str,
    ) -> AppResult<String> {
        let value = shared_value_for_key(key);
        self.set_workspace_secret(profile_id, key, &value)?;
        Ok(value)
    }

    pub fn remove_workspace_secrets(&mut self, profile_id: &str) -> AppResult<()> {
        self.data.workspace_secrets.remove(profile_id);
        self.save()
    }

    pub fn get_shared_secret(&self, key: &str) -> Option<String> {
        self.data.shared_secrets.get(key).cloned()
    }

    pub fn set_shared_secret(&mut self, key: &str, value: &str) -> AppResult<()> {
        self.data
            .shared_secrets
            .insert(key.to_string(), value.to_string());
        self.save()
    }

    pub fn regenerate_shared_secret(&mut self, key: &str) -> AppResult<String> {
        let value = random_secret();
        self.set_shared_secret(key, &value)?;
        Ok(value)
    }

    pub fn get_app_secret(&self, scope: &str, item_id: &str) -> Option<String> {
        self.data
            .app_secrets
            .get(scope)
            .and_then(|items| items.get(item_id))
            .filter(|value| !value.is_empty())
            .cloned()
    }

    pub fn set_app_secret(&mut self, scope: &str, item_id: &str, value: &str) -> AppResult<()> {
        self.data
            .app_secrets
            .entry(scope.to_string())
            .or_default()
            .insert(item_id.to_string(), value.to_string());
        self.save()
    }

    pub fn delete_app_secret(&mut self, scope: &str, item_id: &str) -> AppResult<()> {
        if let Some(items) = self.data.app_secrets.get_mut(scope) {
            items.remove(item_id);
            if items.is_empty() {
                self.data.app_secrets.remove(scope);
            }
        }
        self.save()
    }
}

// Persist only locally changed fields. A stale UI snapshot must not erase
// background refresh-token rotation or credential generation.
fn merge_local_changes(
    base: &serde_json::Value,
    local: &serde_json::Value,
    latest: &serde_json::Value,
) -> AppResult<serde_json::Value> {
    if local == base {
        return Ok(latest.clone());
    }
    if latest == base || latest == local {
        return Ok(local.clone());
    }
    if let (Some(base), Some(local), Some(latest)) =
        (base.as_object(), local.as_object(), latest.as_object())
    {
        let mut merged = latest.clone();
        let keys: std::collections::BTreeSet<_> = base.keys().chain(local.keys()).collect();
        for key in keys {
            let b = base.get(key);
            let l = local.get(key);
            let r = latest.get(key);
            if b == l {
                continue;
            }
            match (b, l, r) {
                (Some(b), Some(l), Some(r)) => {
                    merged.insert(key.clone(), merge_local_changes(b, l, r)?);
                }
                (_, Some(value), _) if r == b || r == l => {
                    merged.insert(key.clone(), value.clone());
                }
                (_, None, _) if r == b => {
                    merged.remove(key);
                }
                _ => return Err(concurrent_update_error()),
            }
        }
        return Ok(serde_json::Value::Object(merged));
    }
    Err(concurrent_update_error())
}

fn concurrent_update_error() -> AppError {
    AppError::Message("Configuration changed concurrently; reload settings and retry".into())
}

fn lock_data_file() -> AppResult<std::sync::MutexGuard<'static, ()>> {
    DATA_FILE_LOCK
        .lock()
        .map_err(|_| AppError::Message("data file lock poisoned".into()))
}

fn random_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).replace('-', "")
}

fn shared_value_for_key(key: &str) -> String {
    if key == "oauth_client_id" {
        format!("chatgpt-client-{}", &uuid::Uuid::new_v4().to_string()[..12])
    } else {
        random_secret()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_secret_roundtrip() {
        let id = uuid::Uuid::new_v4().to_string().replace('-', "");
        let mut store = DataStore::load().expect("load");
        store
            .set_workspace_secret(&id, "oauth_client_secret", "roundtrip-secret")
            .expect("set");
        let loaded = store
            .get_workspace_secret(&id, "oauth_client_secret")
            .expect("get");
        assert_eq!(loaded.as_deref(), Some("roundtrip-secret"));
        store.remove_workspace_secrets(&id).expect("remove");
    }

    #[test]
    fn shared_oauth_client_id_uses_client_id_format() {
        let value = shared_value_for_key("oauth_client_id");
        assert!(value.starts_with("chatgpt-client-"));
        assert_eq!(value.len(), "chatgpt-client-".len() + 12);
    }
}

#[cfg(test)]
mod release_finalization_regressions {
    use super::*;
    #[test]
    fn release_finalization_desktop_save_preserves_background_credentials() {
        let key = format!("release-regression-{}", uuid::Uuid::new_v4());
        let mut desktop = DataStore::load().expect("desktop snapshot");
        DataStore::update_file(|data| {
            data.shared_secrets
                .insert(key.clone(), "newly-rotated-secret".into());
            Ok(())
        })
        .expect("background rotation");
        desktop
            .update_settings(desktop.settings())
            .expect("desktop settings save");
        let actual =
            DataStore::read_file(|data| Ok(data.shared_secrets.get(&key).cloned())).unwrap();
        assert_eq!(actual.as_deref(), Some("newly-rotated-secret"));
    }
}

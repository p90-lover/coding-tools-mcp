use crate::data::DataStore;
use crate::error::AppResult;

pub struct SecretStore;

impl SecretStore {
    #[cfg(test)]
    pub fn remove_workspace_secrets(profile_id: &str) -> AppResult<()> {
        DataStore::update_file(|data| {
            data.workspace_secrets.remove(profile_id);
            Ok(())
        })
    }

    pub fn set(profile_id: &str, key: &str, value: &str) -> AppResult<()> {
        DataStore::update_file(|data| {
            workspace_secret_map(data, profile_id).insert(key.to_string(), value.to_string());
            Ok(())
        })
    }

    pub fn get(profile_id: &str, key: &str) -> AppResult<Option<String>> {
        DataStore::read_file(|data| {
            Ok(data
                .workspace_secrets
                .get(profile_id)
                .and_then(|secrets| secrets.get(key))
                .filter(|value| !value.is_empty())
                .cloned())
        })
    }

    pub fn regenerate(profile_id: &str, key: &str) -> AppResult<String> {
        let value = random_secret();
        Self::set(profile_id, key, &value)?;
        Ok(value)
    }

    pub fn get_shared(key: &str) -> AppResult<Option<String>> {
        DataStore::read_file(|data| {
            Ok(data
                .shared_secrets
                .get(key)
                .filter(|value| !value.is_empty())
                .cloned())
        })
    }

    pub fn get_or_regenerate(profile_id: &str, key: &str, use_shared: bool) -> AppResult<String> {
        DataStore::update_file(|data| {
            let secrets = if use_shared {
                &mut data.shared_secrets
            } else {
                workspace_secret_map(data, profile_id)
            };
            let value = secrets.entry(key.to_owned()).or_default();
            if value.is_empty() {
                *value = random_secret();
            }
            Ok(value.clone())
        })
    }

    pub fn get_app(scope: &str, item_id: &str) -> AppResult<Option<String>> {
        DataStore::read_file(|data| {
            Ok(data
                .app_secrets
                .get(scope)
                .and_then(|items| items.get(item_id))
                .filter(|value| !value.is_empty())
                .cloned())
        })
    }

    #[cfg(test)]
    pub fn set_app(scope: &str, item_id: &str, value: &str) -> AppResult<()> {
        DataStore::update_file(|data| {
            data.app_secrets
                .entry(scope.to_string())
                .or_default()
                .insert(item_id.to_string(), value.to_string());
            Ok(())
        })
    }
}

fn workspace_secret_map<'a>(
    data: &'a mut crate::data::AppData,
    profile_id: &str,
) -> &'a mut std::collections::HashMap<String, String> {
    data.workspace_secrets
        .entry(profile_id.to_string())
        .or_default()
}

fn random_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).replace('-', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_secret_is_non_empty() {
        assert!(random_secret().len() > 32);
    }

    #[test]
    fn missing_workspace_secret_is_regenerated_and_persisted() {
        let fixture = std::env::current_dir()
            .unwrap()
            .join("aiTemp/isolated-store-tests")
            .join(uuid::Uuid::new_v4().to_string())
            .join("profiles.json");
        crate::data::with_test_file(fixture, || {
            let id = uuid::Uuid::new_v4().to_string().replace('-', "");
            let value = SecretStore::get_or_regenerate(&id, "oauth_token_secret", false)
                .expect("regenerate");
            assert!(!value.is_empty());
            assert_eq!(
                SecretStore::get(&id, "oauth_token_secret")
                    .expect("read")
                    .as_deref(),
                Some(value.as_str())
            );
            let _ = SecretStore::remove_workspace_secrets(&id);
        });
    }

    #[test]
    fn workspace_secret_roundtrip() {
        let fixture = std::env::current_dir()
            .unwrap()
            .join("aiTemp/isolated-store-tests")
            .join(uuid::Uuid::new_v4().to_string())
            .join("profiles.json");
        crate::data::with_test_file(fixture, || {
            let id = uuid::Uuid::new_v4().to_string().replace('-', "");
            SecretStore::set(&id, "oauth_client_secret", "roundtrip-secret").expect("set");
            let loaded = SecretStore::get(&id, "oauth_client_secret").expect("get");
            assert_eq!(loaded.as_deref(), Some("roundtrip-secret"));
            let _ = SecretStore::remove_workspace_secrets(&id);
        });
    }
}

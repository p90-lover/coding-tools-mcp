//! Durable MCP event subscriptions. The file holds webhook signing secrets, so it is
//! written atomically next to the other Coding Tools secrets with owner-only access.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const FILE_NAME: &str = "subscriptions.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StoredSubscription {
    pub id: String,
    /// Workspace profile whose authenticated MCP listener created the subscription.
    pub principal: String,
    pub name: String,
    pub arguments: Map<String, Value>,
    pub url: String,
    pub secret: String,
    pub created_at_ms: u64,
    pub refreshed_at_ms: u64,
    pub expires_at_ms: u64,
    pub verified_at_ms: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    subscriptions: Vec<StoredSubscription>,
}

pub struct SubscriptionFile {
    path: PathBuf,
}

impl SubscriptionFile {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A missing file is an empty store; an unreadable one is reported, never overwritten
    /// silently, so a transient read error cannot wipe every subscription.
    pub fn load(&self) -> Result<Vec<StoredSubscription>, String> {
        let raw = match fs::read(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("MCP event subscriptions are unreadable: {error}")),
        };
        let file: StoreFile = serde_json::from_slice(&raw)
            .map_err(|error| format!("MCP event subscriptions are invalid: {error}"))?;
        if file.version != SCHEMA_VERSION {
            return Err("MCP event subscription store version is unsupported".into());
        }
        Ok(file.subscriptions)
    }

    pub fn save(&self, subscriptions: &[StoredSubscription]) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or("MCP event store has no directory")?;
        create_private_dir(directory)?;
        let body = serde_json::to_vec_pretty(&StoreFile {
            version: SCHEMA_VERSION,
            subscriptions: subscriptions.to_vec(),
        })
        .map_err(|error| error.to_string())?;
        let temp = directory.join(format!(
            ".{FILE_NAME}.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let written = (|| -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            file.write_all(&body)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = written.and_then(|_| fs::rename(&temp, &self.path)) {
            let _ = fs::remove_file(&temp);
            return Err(format!(
                "MCP event subscriptions could not be saved: {error}"
            ));
        }
        Ok(())
    }
}

fn create_private_dir(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> StoredSubscription {
        StoredSubscription {
            id: id.into(),
            principal: "workspace-a".into(),
            name: "coding_tools.bridge.down".into(),
            arguments: Map::new(),
            url: "https://example.test/hook".into(),
            secret: "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD".into(),
            created_at_ms: 1,
            refreshed_at_ms: 1,
            expires_at_ms: 2,
            verified_at_ms: 1,
        }
    }

    #[test]
    fn round_trips_and_treats_a_missing_file_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = SubscriptionFile::new(&dir.path().join("mcp-events"));
        assert!(store.load().unwrap().is_empty());
        store.save(&[sample("sub_1"), sample("sub_2")]).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded, vec![sample("sub_1"), sample("sub_2")]);
        store.save(&[sample("sub_2")]).unwrap();
        assert_eq!(store.load().unwrap(), vec![sample("sub_2")]);
        let leftovers = fs::read_dir(dir.path().join("mcp-events"))
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_corrupt_store_is_an_error_not_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = SubscriptionFile::new(dir.path());
        fs::write(store.path(), b"{not json").unwrap();
        assert!(store.load().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = SubscriptionFile::new(dir.path());
        store.save(&[sample("sub_1")]).unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

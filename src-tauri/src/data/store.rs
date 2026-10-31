use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::error::{AppError, AppResult};
use crate::settings::AppSettings;
use crate::workspace::legacy_import::import_legacy_profiles_if_empty;
use crate::workspace::resources::assign_free_workspace_ports;
use crate::workspace::WorkspaceProfile;

use super::migrate::{
    data_file_path, data_writes, load_or_migrate, maybe_backup_legacy_files, save,
};
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
const WORKSPACE_SECRET_KEYS: &[&str] = &[
    "oauth_password",
    "oauth_token_secret",
    "bearer_token",
    "actions_api_key",
    "actions_oauth_client_secret",
    "actions_oauth_password",
    "actions_oauth_token_secret",
];

fn create_workspace_in_data(
    data: &mut AppData,
    path: &str,
    name: Option<String>,
) -> AppResult<WorkspaceProfile> {
    let canonical = Path::new(path.trim())
        .canonicalize()
        .map_err(|_| AppError::Message("Workspace must be an existing directory".into()))?;
    if !canonical.is_dir() {
        return Err(AppError::Message("Workspace must be a directory".into()));
    }
    let duplicate = data.profiles.iter().any(|profile| {
        let Ok(existing) = Path::new(&profile.path).canonicalize() else {
            return false;
        };
        if cfg!(windows) {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&canonical.to_string_lossy())
        } else {
            existing == canonical
        }
    });
    if duplicate {
        return Err(AppError::Message(
            "Workspace path is already registered".into(),
        ));
    }
    let mut profile = WorkspaceProfile::new(canonical.to_string_lossy().into_owned(), name);
    assign_free_workspace_ports(&data.profiles, &mut profile)?;
    let secrets = data
        .workspace_secrets
        .entry(profile.id.clone())
        .or_default();
    for key in WORKSPACE_SECRET_KEYS {
        secrets.insert((*key).into(), random_secret());
    }
    data.profiles.push(profile.clone());
    Ok(profile)
}

/// What identifies one version of the data file: this process's write count (see data_writes)
/// and the file's times and size, which change with a write from another process too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    writes: u64,
    modified: std::time::SystemTime,
    created: Option<std::time::SystemTime>,
    len: u64,
    #[cfg(unix)]
    inode: (u64, u64),
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let writes = data_writes(path);
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        writes,
        modified: metadata.modified().ok()?,
        created: metadata.created().ok(),
        len: metadata.len(),
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        },
    })
}

/// One version of the data file as parsed, with its stamp. A request refreshed the store several
/// times and each refresh parsed the whole file again (hundreds of KB) under the global lock;
/// while the stamp is unchanged its parsed copy is reused instead.
#[derive(Debug)]
struct Parsed {
    stamp: FileStamp,
    data: AppData,
    value: serde_json::Value,
}

/// The data file as last parsed or written in this process, by path and version. The store's
/// refresh and save and the read_file/update_file calls share it: headless makes those calls on
/// every harness, run and control request, and each read and parsed the whole file again
/// (3.8 MB, about nine times a minute while a chat was busy on the hard disk, 2026-10-31), while
/// each of their writes made the store's next refresh parse it once more.
static PARSED: Mutex<Option<HashMap<PathBuf, Parsed>>> = Mutex::new(None);

/// Keeps `data` and its JSON form as the parsed copy of `path` at version `stamp`; no stamp (no
/// file) forgets the copy.
fn remember_file(path: &Path, stamp: Option<FileStamp>, data: &AppData, value: serde_json::Value) {
    let mut slot = PARSED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parsed = slot.get_or_insert_with(HashMap::new);
    match stamp {
        Some(stamp) => {
            parsed.insert(
                path.to_path_buf(),
                Parsed {
                    stamp,
                    data: data.clone(),
                    value,
                },
            );
        }
        None => {
            parsed.remove(path);
        }
    }
}

/// Runs `take` on the data file's current contents, their JSON form and the stamp they belong to:
/// the parsed copy while the file is the version it was parsed from, otherwise read again.
/// Callers hold the data file lock.
fn from_file_on_disk<R>(
    take: impl FnOnce(&AppData, &serde_json::Value, Option<FileStamp>) -> R,
) -> AppResult<R> {
    let path = data_file_path()?;
    // Stamped before reading: a write landing in between leaves an older stamp on the newer data,
    // so the next call reads again, never the other way round.
    let stamp = file_stamp(&path);
    if let Some(stamp) = stamp {
        let slot = PARSED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(parsed) = slot.as_ref().and_then(|parsed| parsed.get(&path)) {
            if parsed.stamp == stamp {
                return Ok(take(&parsed.data, &parsed.value, Some(stamp)));
            }
        }
    }
    let data = load_or_migrate()?;
    let value = serde_json::to_value(&data)?;
    let result = take(&data, &value, stamp);
    remember_file(&path, stamp, &data, value);
    Ok(result)
}

#[derive(Debug)]
pub struct DataStore {
    data: AppData,
    baseline: serde_json::Value,
    persistent: bool,
    /// The file version `data` and `baseline` were last set from (a load, a refresh, a save).
    /// While the file still has it, a refresh has nothing to do. Every change to `data` goes
    /// through save(), which clears it first, so a save that fails leaves the next refresh to
    /// read the file again.
    synced: Option<FileStamp>,
}

impl DataStore {
    pub fn load() -> AppResult<Self> {
        let _guard = lock_data_file()?;
        let path = data_file_path()?;
        let existed_before = path.exists();
        let read_stamp = file_stamp(&path);
        let mut data = load_or_migrate()?;
        let imported = import_legacy_profiles_if_empty(&mut data)?;
        let baseline = serde_json::to_value(&data)?;
        let mut store = Self {
            data,
            baseline,
            persistent: true,
            synced: None,
        };
        let wrote = !existed_before || imported > 0;
        if wrote {
            save(&store.data)?;
        }
        if !existed_before {
            maybe_backup_legacy_files(&path)?;
        }
        // Read: the stamp from before reading (see latest_on_disk). Written: the file just saved.
        store.remember_parsed(if wrote { file_stamp(&path) } else { read_stamp })?;
        crate::auth::sync_trusted_origins(&store.data);
        Ok(store)
    }

    /// Construct an isolated store for tests and migration probes.
    ///
    /// This constructor performs no disk IO, never synchronizes trusted
    /// origins, and keeps later save/refresh calls inside this in-memory state.
    pub fn from_data(data: AppData) -> AppResult<Self> {
        let baseline = serde_json::to_value(&data)?;
        Ok(Self {
            data,
            baseline,
            persistent: false,
            synced: None,
        })
    }

    /// Keeps the store's current data, just loaded or written, as the parsed copy of the file
    /// version `stamp` names. Its JSON form is built from the data, as reading the file would.
    fn remember_parsed(&mut self, stamp: Option<FileStamp>) -> AppResult<()> {
        self.synced = stamp;
        let value = serde_json::to_value(&self.data)?;
        remember_file(&data_file_path()?, stamp, &self.data, value);
        Ok(())
    }

    /// The data file's current contents, their JSON form and the stamp they belong to (see
    /// from_file_on_disk). Callers hold the data file lock.
    fn latest_on_disk(&mut self) -> AppResult<(AppData, serde_json::Value, Option<FileStamp>)> {
        from_file_on_disk(|data, value, stamp| (data.clone(), value.clone(), stamp))
    }

    pub fn read_file<R>(f: impl FnOnce(&AppData) -> AppResult<R>) -> AppResult<R> {
        let _guard = lock_data_file()?;
        let data = from_file_on_disk(|data, _, _| data.clone())?;
        f(&data)
    }

    pub fn update_file<R>(f: impl FnOnce(&mut AppData) -> AppResult<R>) -> AppResult<R> {
        let _guard = lock_data_file()?;
        let (mut data, before) = from_file_on_disk(|data, value, _| (data.clone(), value.clone()))?;
        let result = f(&mut data)?;
        let after = serde_json::to_value(&data)?;
        if after != before {
            save(&data)?;
            // What was just written is the file now; nothing needs to read it back.
            let path = data_file_path()?;
            remember_file(&path, file_stamp(&path), &data, after);
        }
        crate::auth::sync_trusted_origins(&data);
        Ok(result)
    }

    pub fn data(&self) -> &AppData {
        &self.data
    }

    /// True only for a store loaded from the configured application-data file.
    pub fn is_persistent(&self) -> bool {
        self.persistent
    }

    /// Forgets that `data` is a copy of the file, so the next refresh reads it again: for a store
    /// recovered after a panic, which may have stopped between changing `data` and saving it.
    pub fn forget_sync(&mut self) {
        self.synced = None;
    }

    pub fn refresh(&mut self) -> AppResult<()> {
        if !self.persistent {
            self.baseline = serde_json::to_value(&self.data)?;
            return Ok(());
        }
        let _guard = lock_data_file()?;
        // The file is the version this store already holds: nothing to copy. Each request
        // refreshed several times, and each refresh deep-copied the whole data and its JSON form
        // (every run, node and answer, often MBs) while a chat's polls asked several times a
        // second; coding-tools-headless sat at a third of a core.
        let current = file_stamp(&data_file_path()?);
        if current.is_some() && current == self.synced {
            return Ok(());
        }
        let (data, value, stamp) = self.latest_on_disk()?;
        self.baseline = value;
        self.data = data;
        self.synced = stamp;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }

    pub fn save(&mut self) -> AppResult<()> {
        if !self.persistent {
            self.baseline = serde_json::to_value(&self.data)?;
            return Ok(());
        }
        let _guard = lock_data_file()?;
        // `data` holds an edit not on disk yet: until this save lands, a refresh reads the file.
        self.synced = None;
        let (latest, latest_value, stamp) = self.latest_on_disk()?;
        let local = serde_json::to_value(&self.data)?;
        let merged = match merge_local_changes(&self.baseline, &local, &latest_value) {
            Ok(value) => value,
            Err(error) => {
                self.baseline = latest_value;
                self.data = latest;
                self.synced = stamp;
                return Err(error);
            }
        };
        let data: AppData = serde_json::from_value(merged.clone())?;
        let wrote = merged != latest_value;
        if wrote {
            save(&data)?;
        }
        self.data = data;
        self.baseline = merged;
        if !wrote {
            // Nothing to write: the store now holds the file's version as it is.
            self.synced = stamp;
        } else {
            // What was just written is the file now; nothing needs to read it back.
            self.remember_parsed(file_stamp(&data_file_path()?))?;
        }
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

    pub fn create_workspace(
        &mut self,
        path: String,
        name: Option<String>,
    ) -> AppResult<WorkspaceProfile> {
        if self.persistent {
            let profile = Self::update_file(|data| create_workspace_in_data(data, &path, name))?;
            self.refresh()?;
            Ok(profile)
        } else {
            let mut next = self.data.clone();
            let profile = create_workspace_in_data(&mut next, &path, name)?;
            self.data = next;
            self.save()?;
            Ok(profile)
        }
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

struct DataFileLock {
    _file: std::fs::File,
    _process: std::sync::MutexGuard<'static, ()>,
}

fn lock_data_file() -> AppResult<DataFileLock> {
    // The lock guards no data of its own (every holder reads the file afresh), so a panic while
    // it was held leaves nothing half done here. Refusing it from then on failed every read and
    // write of the data file until the service restarted.
    let process = DATA_FILE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = data_file_path()?.with_extension("lock");
    std::fs::create_dir_all(path.parent().expect("data file parent"))?;
    // Keep the OS lock on a stable sidecar: saving replaces the JSON file itself.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    fs2::FileExt::lock_exclusive(&file)?;
    Ok(DataFileLock {
        _file: file,
        _process: process,
    })
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
    fn profile_lock_failure_does_not_run_the_update() {
        let file = isolated_fixture();
        std::fs::create_dir_all(file.with_extension("lock")).unwrap();
        let mut called = false;
        crate::data::with_test_file(file, || {
            let result = DataStore::update_file(|_| {
                called = true;
                Ok(())
            });
            assert!(matches!(result, Err(AppError::Io(_))));
        });
        assert!(!called);
    }

    #[test]
    fn profile_process_writer_child() {
        let Some(path) = std::env::var_os("CODING_TOOLS_PROFILE_PROCESS_FIXTURE") else {
            return;
        };
        crate::data::with_test_file(path.into(), || {
            for _ in 0..25 {
                DataStore::update_file(|data| {
                    data.provider_registry_revision += 1;
                    Ok(())
                })
                .expect("child update");
            }
        });
    }

    #[test]
    fn separate_processes_preserve_all_profile_updates() {
        let file = std::env::var_os("CARGO_TARGET_DIR")
            .map(|root| {
                std::path::PathBuf::from(root)
                    .join("aiTemp/store-process-lock")
                    .join(uuid::Uuid::new_v4().to_string())
                    .join("profiles.json")
            })
            .unwrap_or_else(isolated_fixture);
        crate::data::with_test_file(file.clone(), || {
            DataStore::update_file(|data| {
                data.last_workspace_id = "seed".into();
                Ok(())
            })
            .unwrap();
        });
        let executable = std::env::current_exe().unwrap();
        let canonical_file = std::fs::canonicalize(&file).unwrap();
        let mut children = Vec::new();
        for index in 0..3 {
            children.push(
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "data::store::tests::profile_process_writer_child",
                        "--nocapture",
                    ])
                    .env(
                        "CODING_TOOLS_PROFILE_PROCESS_FIXTURE",
                        if index == 1 { &canonical_file } else { &file },
                    )
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .expect("start writer child"),
            );
        }
        let statuses: Vec<_> = children
            .iter_mut()
            .map(|child| child.wait().expect("writer exit"))
            .collect();
        assert!(
            statuses.iter().all(|status| status.success()),
            "all writers must finish: {statuses:?}"
        );
        crate::data::with_test_file(file, || {
            assert_eq!(
                DataStore::read_file(|data| Ok(data.provider_registry_revision)).unwrap(),
                75
            );
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
            let mut store = DataStore::load().expect("load");
            store
                .set_workspace_secret(&id, "oauth_client_secret", "roundtrip-secret")
                .expect("set");
            let loaded = store
                .get_workspace_secret(&id, "oauth_client_secret")
                .expect("get");
            assert_eq!(loaded.as_deref(), Some("roundtrip-secret"));
            store.remove_workspace_secrets(&id).expect("remove");
        });
    }

    fn isolated_fixture() -> std::path::PathBuf {
        std::env::current_dir()
            .unwrap()
            .join("aiTemp/isolated-store-tests")
            .join(uuid::Uuid::new_v4().to_string())
            .join("profiles.json")
    }

    #[test]
    fn refresh_sees_other_writers_and_still_drops_unsaved_edits() {
        crate::data::with_test_file(isolated_fixture(), || {
            let mut store = DataStore::load().expect("load");
            DataStore::update_file(|data| {
                data.last_workspace_id = "written-elsewhere".into();
                Ok(())
            })
            .expect("another writer");
            store.data.last_workspace_id = "unsaved".into();
            store.refresh().expect("refresh after a write");
            assert_eq!(store.data().last_workspace_id, "written-elsewhere");
            // An edit whose save failed (here: one that never reached save) is dropped too: the
            // store is no longer known to hold the file's version, so the refresh reads it.
            store.data.last_workspace_id = "unsaved-again".into();
            store.synced = None;
            store.refresh().expect("refresh from the parsed copy");
            assert_eq!(store.data().last_workspace_id, "written-elsewhere");
            store.data.last_workspace_id = "saved-here".into();
            store.save().expect("save");
            store.refresh().expect("refresh after own save");
            assert_eq!(store.data().last_workspace_id, "saved-here");
            let on_disk = DataStore::read_file(|data| Ok(data.last_workspace_id.clone())).unwrap();
            assert_eq!(on_disk, "saved-here");
        });
    }

    #[test]
    fn refresh_of_an_unchanged_file_copies_nothing() {
        crate::data::with_test_file(isolated_fixture(), || {
            let mut store = DataStore::load().expect("load");
            store.data.last_workspace_id = "kept".into();
            store.save().expect("save");
            // The same allocation after refreshing: the data was not replaced by a copy.
            let held = store.data().last_workspace_id.as_ptr();
            for _ in 0..3 {
                store.refresh().expect("refresh");
            }
            assert_eq!(store.data().last_workspace_id.as_ptr(), held);
            assert_eq!(store.data().last_workspace_id, "kept");
            // A save with nothing new to write keeps the store in step as well.
            store.save().expect("save without changes");
            let held = store.data().last_workspace_id.as_ptr();
            store.refresh().expect("refresh");
            assert_eq!(store.data().last_workspace_id.as_ptr(), held);
            // Another writer: the next refresh reads its version.
            DataStore::update_file(|data| {
                data.last_workspace_id = "theirs".into();
                Ok(())
            })
            .expect("another writer");
            store.refresh().expect("refresh after a write");
            assert_eq!(store.data().last_workspace_id, "theirs");
        });
    }

    #[test]
    fn refresh_reads_the_file_again_only_when_its_stamp_changes() {
        crate::data::with_test_file(isolated_fixture(), || {
            let mut store = DataStore::load().expect("load");
            store.data.last_workspace_id = "aaaa".into();
            store.save().expect("save");
            let path = data_file_path().unwrap();
            let before = std::fs::metadata(&path).unwrap();
            // Same length, other contents, original modification time: nothing a stamp sees.
            let mut changed = store.data().clone();
            changed.last_workspace_id = "bbbb".into();
            let text = serde_json::to_string_pretty(&changed).unwrap() + "\n";
            assert_eq!(text.len() as u64, before.len());
            std::fs::write(&path, &text).unwrap();
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(before.modified().unwrap()).unwrap();
            drop(file);
            store.refresh().expect("refresh");
            assert_eq!(
                store.data().last_workspace_id,
                "aaaa",
                "an unchanged stamp reuses the parsed copy"
            );
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(before.modified().unwrap() + std::time::Duration::from_secs(5))
                .unwrap();
            drop(file);
            store.refresh().expect("refresh");
            assert_eq!(
                store.data().last_workspace_id,
                "bbbb",
                "a new stamp reads the file"
            );
        });
    }

    #[test]
    fn read_file_and_update_file_read_the_file_again_only_when_its_stamp_changes() {
        crate::data::with_test_file(isolated_fixture(), || {
            DataStore::update_file(|data| {
                data.last_workspace_id = "aaaa".into();
                Ok(())
            })
            .expect("write");
            let path = data_file_path().unwrap();
            let before = std::fs::metadata(&path).unwrap();
            // Same length, other contents, original modification time: nothing a stamp sees.
            let mut changed = DataStore::read_file(|data| Ok(data.clone())).unwrap();
            changed.last_workspace_id = "bbbb".into();
            let text = serde_json::to_string_pretty(&changed).unwrap() + "\n";
            assert_eq!(text.len() as u64, before.len());
            std::fs::write(&path, &text).unwrap();
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(before.modified().unwrap()).unwrap();
            drop(file);
            let seen = DataStore::read_file(|data| Ok(data.last_workspace_id.clone())).unwrap();
            assert_eq!(seen, "aaaa", "an unchanged stamp reuses the parsed copy");
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(before.modified().unwrap() + std::time::Duration::from_secs(5))
                .unwrap();
            drop(file);
            let seen = DataStore::read_file(|data| Ok(data.last_workspace_id.clone())).unwrap();
            assert_eq!(seen, "bbbb", "a new stamp reads the file");
            // An update starts from the file's version, and the next read sees what it wrote.
            DataStore::update_file(|data| {
                assert_eq!(data.last_workspace_id, "bbbb");
                data.last_workspace_id = "cccc".into();
                Ok(())
            })
            .expect("update");
            let seen = DataStore::read_file(|data| Ok(data.last_workspace_id.clone())).unwrap();
            assert_eq!(seen, "cccc");
            // A store's refresh shares the copy update_file left: nothing to read back.
            let mut store = DataStore::load().expect("load");
            assert_eq!(store.data().last_workspace_id, "cccc");
            store.refresh().expect("refresh");
            assert_eq!(store.data().last_workspace_id, "cccc");
        });
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
        let fixture = std::env::current_dir()
            .unwrap()
            .join("aiTemp/isolated-store-tests")
            .join(uuid::Uuid::new_v4().to_string())
            .join("profiles.json");
        crate::data::with_test_file(fixture, || {
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
        });
    }
}

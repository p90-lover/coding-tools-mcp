use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use crate::platform::platform;
use crate::settings::AppSettings;

use super::model::{AppData, LegacyProfilesOnlyFile};

const LEGACY_PROFILES_FILE: &str = "profiles.json";
const LEGACY_SETTINGS_FILE: &str = "app_settings.json";

#[cfg(test)]
thread_local! { static TEST_DATA_FILE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) }; }

// Fixtures that replace the process-wide trusted-origin registry or saturate
// process-wide HTTP admission must own that shared resource, even when the Rust
// runner schedules unrelated tests in parallel. Production admission is unchanged.
#[cfg(test)]
fn shared_test_slots() -> std::sync::Arc<tokio::sync::Semaphore> {
    static SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    SLOTS
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
}
#[cfg(test)]
pub(crate) async fn shared_http_test_guard() -> tokio::sync::OwnedSemaphorePermit {
    shared_test_slots()
        .acquire_owned()
        .await
        .expect("shared fixture admission")
}

#[cfg(test)]
fn shared_test_file_guard(path: &Path) -> std::sync::Arc<tokio::sync::OwnedSemaphorePermit> {
    use std::sync::{Arc, Mutex, Weak};
    type ActiveScope = Option<(PathBuf, Weak<tokio::sync::OwnedSemaphorePermit>)>;
    static ACTIVE: Mutex<ActiveScope> = Mutex::new(None);
    loop {
        {
            let mut active = ACTIVE.lock().expect("test fixture scope lock");
            if let Some((owner, weak)) = active.as_ref() {
                if owner == path {
                    if let Some(lease) = weak.upgrade() {
                        return lease;
                    }
                }
            }
            if let Ok(permit) = shared_test_slots().try_acquire_owned() {
                let lease = Arc::new(permit);
                *active = Some((path.to_path_buf(), Arc::downgrade(&lease)));
                return lease;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(test)]
pub(crate) fn with_test_file<R>(path: PathBuf, f: impl FnOnce() -> R) -> R {
    let _shared = if TEST_DATA_FILE.with(|v| v.borrow().is_none()) {
        Some(shared_test_file_guard(&path))
    } else {
        None
    };
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_DATA_FILE.with(|v| *v.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(TEST_DATA_FILE.with(|v| v.replace(Some(path))));
    f()
}

#[cfg(test)]
#[test]
fn fixture_worker_can_share_parent_store_without_cross_fixture_admission() {
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/fixture-lease")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&base).unwrap();
    let file = base.join("profiles.json");
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let (other_tx, other_rx) = std::sync::mpsc::sync_channel(1);
    let (worker, other, observed, crossed) = with_test_file(file.clone(), || {
        let child_file = file.clone();
        let worker = std::thread::spawn(move || {
            with_test_file(child_file, || {
                let _ = tx.send(data_file_path().unwrap());
            });
        });
        let other_file = base.join("other-profiles.json");
        let other = std::thread::spawn(move || {
            with_test_file(other_file, || {
                let _ = other_tx.send(());
            });
        });
        let observed = rx.recv_timeout(std::time::Duration::from_millis(800));
        let crossed = other_rx.try_recv().is_ok();
        (worker, other, observed, crossed)
    });
    // Release the parent before joining even on failure: the regression must not hang.
    worker.join().unwrap();
    other.join().unwrap();
    assert_eq!(
        observed.expect("child fixture waited on its parent's own lease"),
        file
    );
    assert!(
        !crossed,
        "a different fixture entered while the parent held its lease"
    );
}

pub fn data_file_path() -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(path) = TEST_DATA_FILE.with(|v| v.borrow().clone()) {
        return Ok(path);
    }
    Ok(platform()
        .app_config_dir()?
        .join("data")
        .join("profiles.json"))
}

pub fn load_or_migrate() -> AppResult<AppData> {
    let path = data_file_path()?;
    let app_root = app_root_for(&path)?;
    if path.exists() {
        return load_or_recover_at(&path, &app_root);
    }
    if let Some(mut data) = latest_valid_backup(&app_root)? {
        suspend_recovered_permissions(&mut data);
        write_data_at(&path, &app_root, &data)?;
        return Ok(data);
    }

    let mut data = AppData::default();
    let legacy_profiles = app_root.join(LEGACY_PROFILES_FILE);
    if legacy_profiles.exists() {
        let raw = fs::read_to_string(&legacy_profiles)?;
        if let Ok(file) = serde_json::from_str::<LegacyProfilesOnlyFile>(&raw) {
            data.profiles = file.profiles;
        }
    }

    let legacy_settings = app_root.join(LEGACY_SETTINGS_FILE);
    if legacy_settings.exists() {
        let raw = fs::read_to_string(&legacy_settings)?;
        if let Ok(settings) = serde_json::from_str::<AppSettings>(&raw) {
            merge_settings(&mut data, settings);
        }
    }

    Ok(data)
}

pub fn save(data: &AppData) -> AppResult<()> {
    let path = data_file_path()?;
    let app_root = app_root_for(&path)?;
    write_data_at(&path, &app_root, data)
}

fn app_root_for(path: &Path) -> AppResult<PathBuf> {
    path.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::Message("invalid application data path".into()))
}

fn load_or_recover_at(path: &Path, app_root: &Path) -> AppResult<AppData> {
    match read_valid_data(path) {
        Ok(data) => Ok(data),
        Err(error) => {
            preserve_corrupt_file(path, app_root)?;
            let Some(mut data) = latest_valid_backup(app_root)? else {
                return Err(AppError::Message(format!(
                    "profile data is invalid and no valid backup is available: {error}"
                )));
            };
            suspend_recovered_permissions(&mut data);
            write_data_at(path, app_root, &data)?;
            Ok(data)
        }
    }
}

fn read_valid_data(path: &Path) -> AppResult<AppData> {
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(AppError::from)
}

/// Writes this process made to each data file. File times can be as coarse as a clock tick, so
/// two saves of the same length inside one tick look alike on disk; the count tells them apart.
static DATA_WRITES: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, u64>>> =
    std::sync::Mutex::new(None);

pub(super) fn data_writes(path: &Path) -> u64 {
    let counts = DATA_WRITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    counts
        .as_ref()
        .and_then(|counts| counts.get(path).copied())
        .unwrap_or(0)
}

fn count_data_write(path: &Path) {
    let mut counts = DATA_WRITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *counts
        .get_or_insert_with(Default::default)
        .entry(path.to_path_buf())
        .or_insert(0) += 1;
}

fn profile_io(stage: &str, error: std::io::Error) -> AppError {
    AppError::Io(std::io::Error::new(
        error.kind(),
        format!("Profile persistence ({stage}): {error}"),
    ))
}

fn write_data_at(path: &Path, app_root: &Path, data: &AppData) -> AppResult<()> {
    // Counted before anything moves, so a reader that saw the old count reads the file again.
    count_data_write(path);
    let Some(parent) = path.parent() else {
        return Err(AppError::Message("profile data path has no parent".into()));
    };
    fs::create_dir_all(parent).map_err(|error| profile_io("data directory", error))?;
    let temp_dir = app_root.join("aiTemp").join("data-write");
    fs::create_dir_all(&temp_dir).map_err(|error| profile_io("temporary directory", error))?;
    let temp_path = temp_dir.join(unique_name("profiles", "tmp"));
    let text = serde_json::to_string_pretty(data)?;
    {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|error| profile_io("create temporary file", error))?;
        restrict_file_permissions(&temp_path)?;
        file.write_all(text.as_bytes())
            .map_err(|error| profile_io("write temporary file", error))?;
        file.write_all(b"\n")
            .map_err(|error| profile_io("write temporary file", error))?;
        file.sync_all()
            .map_err(|error| profile_io("sync temporary file", error))?;
    }

    let previous_backup = if path.exists() {
        Some(move_to_trash(
            path,
            app_root,
            "data-backups",
            "profiles",
            "json",
        )?)
    } else {
        None
    };

    if let Err(error) = fs::rename(&temp_path, path) {
        if !path.exists() {
            if let Some(backup) = previous_backup.as_ref() {
                let _ = fs::copy(backup, path);
            }
        }
        return Err(profile_io("install data file", error));
    }
    restrict_file_permissions(path)?;
    copy_valid_backup(path, app_root)?;
    prune_backups(&app_root.join("Trash").join("data-backups"), KEPT_BACKUPS);
    Ok(())
}

/// Backups kept of the data file. Every save added two full copies and none was ever removed:
/// one install held 2,429 (456 MB). Recovery reads only the newest valid one.
const KEPT_BACKUPS: usize = 40;

/// Removes all but the newest `keep` backups; best effort, a backup that cannot go stays.
fn prune_backups(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut backups = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            (modified, entry.path())
        })
        .collect::<Vec<_>>();
    if backups.len() <= keep {
        return;
    }
    backups.sort_by_key(|backup| std::cmp::Reverse(backup.0));
    for (_, path) in backups.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

fn copy_valid_backup(path: &Path, app_root: &Path) -> AppResult<PathBuf> {
    let dir = app_root.join("Trash").join("data-backups");
    fs::create_dir_all(&dir)?;
    let target = dir.join(unique_name("profiles-valid", "json"));
    fs::copy(path, &target).map_err(|error| profile_io("copy valid backup", error))?;
    restrict_file_permissions(&target)?;
    Ok(target)
}

fn preserve_corrupt_file(path: &Path, app_root: &Path) -> AppResult<PathBuf> {
    move_to_trash(
        path,
        app_root,
        "data-corruption",
        "profiles-corrupt",
        "json",
    )
}

fn move_to_trash(
    path: &Path,
    app_root: &Path,
    category: &str,
    prefix: &str,
    extension: &str,
) -> AppResult<PathBuf> {
    let dir = app_root.join("Trash").join(category);
    fs::create_dir_all(&dir)?;
    let target = dir.join(unique_name(prefix, extension));
    fs::rename(path, &target).map_err(|error| profile_io("archive previous data", error))?;
    Ok(target)
}

fn latest_valid_backup(app_root: &Path) -> AppResult<Option<AppData>> {
    let dir = app_root.join("Trash").join("data-backups");
    if !dir.exists() {
        return Ok(None);
    }
    let mut entries = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    for entry in entries.into_iter().rev() {
        if let Ok(data) = read_valid_data(&entry.path()) {
            return Ok(Some(data));
        }
    }
    Ok(None)
}

fn unique_name(prefix: &str, extension: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{prefix}-{timestamp}-{}.{}",
        uuid::Uuid::new_v4().simple(),
        extension
    )
}

fn restrict_file_permissions(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn maybe_backup_legacy_files(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let app_root = platform().app_config_dir()?;
    for name in [LEGACY_PROFILES_FILE, LEGACY_SETTINGS_FILE] {
        let legacy = app_root.join(name);
        if legacy.exists() {
            let prefix = format!("legacy-{}", name.trim_end_matches(".json"));
            let _ = move_to_trash(&legacy, &app_root, "legacy-config", &prefix, "json")?;
        }
    }
    Ok(())
}

fn merge_settings(data: &mut AppData, settings: AppSettings) {
    data.frp_profiles = settings.frp_profiles;
    data.last_workspace_id = settings.last_workspace_id;
    data.download = settings.download;
    data.proxy = settings.proxy;
    data.shared_secrets = settings.shared_secrets;
    data.workspace_secrets = settings.workspace_secrets;
    data.app_secrets = settings.app_secrets;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_profile_write_identifies_stage_without_disclosing_path() {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/profile-write-errors")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("aiTemp"), "blocks the temporary directory").unwrap();
        let failure = write_data_at(&root.join("data/profiles.json"), &root, &AppData::default())
            .unwrap_err();
        let message = failure.to_string();
        assert!(matches!(failure, AppError::Io(_)));
        assert!(message.contains("Profile persistence (temporary directory)"));
        assert!(!message.contains(&root.to_string_lossy().to_string()));
        let AppError::Io(error) = profile_io(
            "create temporary file",
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
        ) else {
            panic!("IO kind must remain IO");
        };
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(error.to_string().contains("create temporary file"));
    }

    #[test]
    fn atomic_write_keeps_valid_backups_without_deleting_previous_data() {
        let root = tempfile::tempdir().expect("app root");
        let path = root.path().join("data/profiles.json");
        let first = AppData {
            last_workspace_id: "first".into(),
            ..AppData::default()
        };
        write_data_at(&path, root.path(), &first).expect("first write");

        let mut second = first.clone();
        second.last_workspace_id = "second".into();
        write_data_at(&path, root.path(), &second).expect("second write");

        assert_eq!(read_valid_data(&path).unwrap().last_workspace_id, "second");
        let backup_count = fs::read_dir(root.path().join("Trash/data-backups"))
            .expect("backups")
            .filter_map(Result::ok)
            .count();
        assert!(
            backup_count >= 3,
            "expected first valid copy, moved previous file, and second valid copy"
        );
    }

    #[test]
    fn backups_are_pruned_to_the_newest_and_recovery_still_finds_the_latest() {
        let root = tempfile::tempdir().expect("app root");
        let path = root.path().join("data/profiles.json");
        for index in 0..(KEPT_BACKUPS + 15) {
            let data = AppData {
                last_workspace_id: format!("write-{index}"),
                ..AppData::default()
            };
            write_data_at(&path, root.path(), &data).expect("write");
        }
        let kept = fs::read_dir(root.path().join("Trash/data-backups"))
            .expect("backups")
            .filter_map(Result::ok)
            .count();
        assert_eq!(kept, KEPT_BACKUPS);
        let latest = latest_valid_backup(root.path()).unwrap().expect("a backup");
        assert_eq!(
            latest.last_workspace_id,
            format!("write-{}", KEPT_BACKUPS + 14)
        );
    }

    #[test]
    fn malformed_current_file_is_preserved_and_latest_valid_backup_is_restored() {
        let root = tempfile::tempdir().expect("app root");
        let path = root.path().join("data/profiles.json");
        let expected = AppData {
            last_workspace_id: "recover-me".into(),
            ..AppData::default()
        };
        write_data_at(&path, root.path(), &expected).expect("valid write");
        fs::write(&path, "{not-json").expect("corrupt current");

        let recovered = load_or_recover_at(&path, root.path()).expect("recover");
        assert_eq!(recovered.last_workspace_id, "recover-me");
        assert_eq!(
            read_valid_data(&path).unwrap().last_workspace_id,
            "recover-me"
        );
        assert!(fs::read_dir(root.path().join("Trash/data-corruption"))
            .expect("corruption archive")
            .filter_map(Result::ok)
            .any(|entry| entry.path().is_file()));
    }
}

/// Backups preserve documents, not live authority. A recovered consent needs local approval.
fn suspend_recovered_permissions(data: &mut AppData) {
    data.execution_book.suspend_recovered();
    for grant in &mut data.sandbox_permissions {
        grant.enabled = false;
    }
    for grant in &mut data.computer_permissions {
        grant.suspended = true;
    }
}
#[cfg(test)]
mod computer_recovery_tests {
    use super::*;
    #[test]
    fn computer_profile_recovery_never_reactivates_old_consent() {
        let mut data = AppData::default();
        data.computer_permissions
            .push(crate::tools::computer::permissions::SavedPermission {
                restore_on_start: true,
                suspended: false,
                ..Default::default()
            });
        suspend_recovered_permissions(&mut data);
        assert!(data.computer_permissions[0].suspended);
    }
}

#[cfg(test)]
pub(crate) fn current_test_file() -> Option<PathBuf> {
    TEST_DATA_FILE.with(|v| v.borrow().clone())
}

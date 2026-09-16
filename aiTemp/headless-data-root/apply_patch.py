#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_migrate() -> None:
    replace_once(
        "src-tauri/src/data/migrate.rs",
        '''pub fn data_file_path() -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(path) = TEST_DATA_FILE.with(|v| v.borrow().clone()) {
        return Ok(path);
    }
    Ok(platform()
        .app_config_dir()?
        .join("data")
        .join("profiles.json"))
}''',
        '''pub(crate) fn data_file_path_for_app_data_dir(app_data_dir: &Path) -> AppResult<PathBuf> {
    if !app_data_dir.is_absolute() {
        return Err(AppError::Message(
            "configured application data directory must be absolute".into(),
        ));
    }
    Ok(app_data_dir.join("data").join("profiles.json"))
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
}''',
        "configured data-file path",
    )
    replace_once(
        "src-tauri/src/data/migrate.rs",
        '''pub fn load_or_migrate() -> AppResult<AppData> {
    let path = data_file_path()?;
    let app_root = app_root_for(&path)?;''',
        '''pub fn load_or_migrate() -> AppResult<AppData> {
    let path = data_file_path()?;
    load_or_migrate_at(&path)
}

pub(crate) fn load_or_migrate_at(path: &Path) -> AppResult<AppData> {
    let app_root = app_root_for(path)?;''',
        "path-aware data loading",
    )
    replace_once(
        "src-tauri/src/data/migrate.rs",
        '''pub fn save(data: &AppData) -> AppResult<()> {
    let path = data_file_path()?;
    let app_root = app_root_for(&path)?;
    write_data_at(&path, &app_root, data)
}''',
        '''pub fn save(data: &AppData) -> AppResult<()> {
    let path = data_file_path()?;
    save_at(&path, data)
}

pub(crate) fn save_at(path: &Path, data: &AppData) -> AppResult<()> {
    let app_root = app_root_for(path)?;
    write_data_at(path, &app_root, data)
}''',
        "path-aware data saving",
    )


def patch_store() -> None:
    replace_once(
        "src-tauri/src/data/store.rs",
        "use std::sync::Mutex;",
        "use std::path::{Path, PathBuf};\nuse std::sync::Mutex;",
        "path imports",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''use super::migrate::{data_file_path, load_or_migrate, maybe_backup_legacy_files, save};''',
        '''use super::migrate::{
    data_file_path, data_file_path_for_app_data_dir, load_or_migrate, load_or_migrate_at,
    maybe_backup_legacy_files, save, save_at,
};''',
        "path-aware migrate imports",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''pub struct DataStore {
    data: AppData,
    baseline: serde_json::Value,
    persistent: bool,
}''',
        '''pub struct DataStore {
    data: AppData,
    baseline: serde_json::Value,
    persistent_path: Option<PathBuf>,
}''',
        "persistent data path",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''    pub fn load() -> AppResult<Self> {
        let _guard = lock_data_file()?;
        let path = data_file_path()?;
        let existed_before = path.exists();
        let mut data = load_or_migrate()?;
        let imported = import_legacy_profiles_if_empty(&mut data)?;
        let baseline = serde_json::to_value(&data)?;
        let store = Self {
            data,
            baseline,
            persistent: true,
        };
        if !existed_before || imported > 0 {
            save(&store.data)?;
        }
        if !existed_before {
            maybe_backup_legacy_files(&path)?;
        }
        crate::auth::sync_trusted_origins(&store.data);
        Ok(store)
    }''',
        '''    pub fn load() -> AppResult<Self> {
        let path = data_file_path()?;
        Self::load_at(path, true)
    }

    /// Load state from the caller-selected application-data root without
    /// consulting or importing the user's normal desktop profile.
    pub fn load_from_app_data_dir(app_data_dir: &Path) -> AppResult<Self> {
        let path = data_file_path_for_app_data_dir(app_data_dir)?;
        Self::load_at(path, false)
    }

    fn load_at(path: PathBuf, import_legacy_home: bool) -> AppResult<Self> {
        let _guard = lock_data_file()?;
        let existed_before = path.exists();
        let mut data = load_or_migrate_at(&path)?;
        let imported = if import_legacy_home {
            import_legacy_profiles_if_empty(&mut data)?
        } else {
            0
        };
        let baseline = serde_json::to_value(&data)?;
        let store = Self {
            data,
            baseline,
            persistent_path: Some(path.clone()),
        };
        if !existed_before || imported > 0 {
            save_at(&path, &store.data)?;
        }
        if !existed_before && import_legacy_home {
            maybe_backup_legacy_files(&path)?;
        }
        crate::auth::sync_trusted_origins(&store.data);
        Ok(store)
    }''',
        "configured DataStore loading",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''        Ok(Self {
            data,
            baseline,
            persistent: false,
        })''',
        '''        Ok(Self {
            data,
            baseline,
            persistent_path: None,
        })''',
        "in-memory store marker",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''    pub fn is_persistent(&self) -> bool {
        self.persistent
    }''',
        '''    pub fn is_persistent(&self) -> bool {
        self.persistent_path.is_some()
    }''',
        "persistent path predicate",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''    pub fn refresh(&mut self) -> AppResult<()> {
        if !self.persistent {
            self.baseline = serde_json::to_value(&self.data)?;
            return Ok(());
        }
        let _guard = lock_data_file()?;
        let data = load_or_migrate()?;
        self.baseline = serde_json::to_value(&data)?;
        self.data = data;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }''',
        '''    pub fn refresh(&mut self) -> AppResult<()> {
        let Some(path) = self.persistent_path.clone() else {
            self.baseline = serde_json::to_value(&self.data)?;
            return Ok(());
        };
        let _guard = lock_data_file()?;
        let data = load_or_migrate_at(&path)?;
        self.baseline = serde_json::to_value(&data)?;
        self.data = data;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }''',
        "path-aware refresh",
    )
    replace_once(
        "src-tauri/src/data/store.rs",
        '''    pub fn save(&mut self) -> AppResult<()> {
        if !self.persistent {
            self.baseline = serde_json::to_value(&self.data)?;
            return Ok(());
        }
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
    }''',
        '''    pub fn save(&mut self) -> AppResult<()> {
        let Some(path) = self.persistent_path.clone() else {
            self.baseline = serde_json::to_value(&self.data)?;
            return Ok(());
        };
        let _guard = lock_data_file()?;
        let latest = load_or_migrate_at(&path)?;
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
            save_at(&path, &data)?;
        }
        self.data = data;
        self.baseline = merged;
        crate::auth::sync_trusted_origins(&self.data);
        Ok(())
    }''',
        "path-aware save",
    )


def patch_core() -> None:
    replace_once(
        "rust-core/coding-tools-core/src/lib.rs",
        "use std::sync::Mutex;",
        "use std::path::Path;\nuse std::sync::Mutex;",
        "CoreState path import",
    )
    replace_once(
        "rust-core/coding-tools-core/src/lib.rs",
        '''    pub fn load() -> AppResult<Self> {
        let mut data = DataStore::load()?;
        data.init_shared_secrets()?;
        Ok(Self {
            data: Mutex::new(data),
            runtime: Mutex::new(RuntimeSupervisor::default()),
        })
    }

    /// Create isolated state for tests and migration probes without touching a''',
        '''    pub fn load() -> AppResult<Self> {
        let mut data = DataStore::load()?;
        data.init_shared_secrets()?;
        Ok(Self {
            data: Mutex::new(data),
            runtime: Mutex::new(RuntimeSupervisor::default()),
        })
    }

    /// Load state from an explicit application-data root. This is used by the
    /// Electron sidecar so development, production, and test profiles cannot
    /// read or overwrite one another.
    pub fn load_from_app_data_dir(app_data_dir: &Path) -> AppResult<Self> {
        let mut data = DataStore::load_from_app_data_dir(app_data_dir)?;
        data.init_shared_secrets()?;
        Ok(Self {
            data: Mutex::new(data),
            runtime: Mutex::new(RuntimeSupervisor::default()),
        })
    }

    /// Create isolated state for tests and migration probes without touching a''',
        "configured CoreState loading",
    )


def patch_headless() -> None:
    replace_once(
        "rust-core/coding-tools-headless/src/lib.rs",
        '''        let core = Arc::new(CoreState::load().map_err(text_error)?);''',
        '''        let core = Arc::new(
            CoreState::load_from_app_data_dir(&config.app_data_dir).map_err(text_error)?,
        );''',
        "headless configured CoreState",
    )
    replace_once(
        "rust-core/coding-tools-headless/tests/control_api.rs",
        '''    let service = HeadlessService::start(config)
        .await
        .expect("headless service starts");
    let endpoint = service.endpoint().to_string();''',
        '''    let service = HeadlessService::start(config)
        .await
        .expect("headless service starts");
    assert!(
        app_data_dir.join("data/profiles.json").is_file(),
        "headless state must be created inside ServiceConfig.app_data_dir"
    );
    let endpoint = service.endpoint().to_string();''',
        "configured data-root regression",
    )


def main() -> None:
    patch_migrate()
    patch_store()
    patch_core()
    patch_headless()
    print("Applied configured headless data-root isolation patch.")


if __name__ == "__main__":
    main()

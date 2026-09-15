//! Reusable Coding Tools state and tool-contract API.
//!
//! This first extraction stage establishes one tested API over the published
//! v0.4.10 implementation while the modules are moved out of the Tauri package
//! in dependency order. It does not start a window, tray, listener, model, or
//! provider process. Later extraction commits invert the remaining package
//! dependency without changing this public contract.

use std::sync::Mutex;

pub use coding_tools_mcp_desktop_lib::{data, error, runtime, tools};

use data::{AppData, DataStore};
use error::{AppError, AppResult};
use runtime::RuntimeSupervisor;

/// Shared application state used by both the retained Tauri adapter and the
/// future headless service. In-memory fixtures never read or overwrite the
/// user's application-data file.
pub struct CoreState {
    data: Mutex<DataStore>,
    runtime: Mutex<RuntimeSupervisor>,
}

impl CoreState {
    /// Load the current Coding Tools application state from its normal data
    /// location and initialize required shared secrets exactly as v0.4.10 did.
    pub fn load() -> AppResult<Self> {
        let mut data = DataStore::load()?;
        data.init_shared_secrets()?;
        Ok(Self {
            data: Mutex::new(data),
            runtime: Mutex::new(RuntimeSupervisor::default()),
        })
    }

    /// Create isolated state for tests and migration probes without touching a
    /// profile on disk.
    pub fn from_data(data: AppData) -> AppResult<Self> {
        Ok(Self {
            data: Mutex::new(DataStore::from_data(data)?),
            runtime: Mutex::new(RuntimeSupervisor::default()),
        })
    }

    pub fn with_data<R>(&self, f: impl FnOnce(&mut DataStore) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self
            .data
            .lock()
            .map_err(|_| AppError::Message("data store poisoned".into()))?;
        f(&mut guard)
    }

    pub fn with_runtime<R>(
        &self,
        f: impl FnOnce(&mut RuntimeSupervisor) -> AppResult<R>,
    ) -> AppResult<R> {
        let mut guard = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    }
}

impl Default for CoreState {
    fn default() -> Self {
        Self::load().expect("failed to initialize Coding Tools core state")
    }
}

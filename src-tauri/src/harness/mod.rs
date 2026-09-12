pub mod model;
pub mod state;
pub mod store;
pub mod tools;
pub(crate) mod monitor;

pub use model::{ProjectState, TaskSession, TaskStatus};
pub use state::Harness;
pub use store::{HarnessError, HarnessResult, HarnessStore};

pub(crate) mod bounded_scan;
#[cfg(test)]
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../aiTemp/live-refresh/scan_contract.rs"
));

pub(crate) mod context_view;

#[cfg(test)]
include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../aiTemp/task-monitor/monitor_contract.rs"));

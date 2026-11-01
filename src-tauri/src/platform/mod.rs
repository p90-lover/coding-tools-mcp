use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::error::AppResult;

/// Cross-platform OS primitives used by the desktop runtime.
///
/// Windows uses `windows-rs`. macOS and Linux live in dedicated modules.
#[allow(dead_code)]
pub trait Platform: Send + Sync {
    fn os_name(&self) -> &'static str;

    fn app_config_dir(&self) -> AppResult<PathBuf>;

    fn find_pid_listening_on_port(&self, port: u16) -> AppResult<Option<u32>>;

    /// Best-effort reclaim of a TCP listener on the given port. Windows uses
    /// `SetTcpEntry`; other platforms return `Ok(false)`.
    fn reclaim_listening_port(&self, port: u16) -> AppResult<bool> {
        let _ = port;
        Ok(false)
    }

    fn process_image_path(&self, pid: u32) -> AppResult<Option<String>>;

    fn is_process_alive(&self, pid: u32) -> bool;

    fn terminate_process_tree(&self, pid: u32) -> AppResult<()>;

    /// 清理由应用管理的同一路径进程；默认平台不做处理。
    fn terminate_processes_by_image_path(&self, _image_path: &Path) -> AppResult<usize> {
        Ok(0)
    }

    fn resolve_executable(&self, name: &str) -> Option<PathBuf>;

    fn cloudflared_candidates(&self) -> Vec<PathBuf>;

    fn frpc_candidates(&self) -> Vec<PathBuf>;
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

mod open;
mod paths;

pub use open::{is_allowed_url, open_path_in_file_manager, open_url};

#[cfg(target_os = "linux")]
pub use linux::LinuxPlatform;
#[cfg(target_os = "macos")]
pub use macos::MacPlatform;
#[cfg(target_os = "windows")]
pub use windows::WindowsPlatform;

static PLATFORM: std::sync::OnceLock<Box<dyn Platform>> = std::sync::OnceLock::new();

pub fn platform() -> &'static dyn Platform {
    PLATFORM.get_or_init(|| create_platform()).as_ref()
}

fn create_platform() -> Box<dyn Platform> {
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsPlatform)
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(MacPlatform)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxPlatform)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        struct Unsupported;
        impl Platform for Unsupported {
            fn os_name(&self) -> &'static str {
                "unsupported"
            }
            fn app_config_dir(&self) -> AppResult<PathBuf> {
                Err(crate::error::AppError::Message(
                    "unsupported operating system".into(),
                ))
            }
            fn find_pid_listening_on_port(&self, _port: u16) -> AppResult<Option<u32>> {
                Ok(None)
            }
            fn process_image_path(&self, _pid: u32) -> AppResult<Option<String>> {
                Ok(None)
            }
            fn is_process_alive(&self, _pid: u32) -> bool {
                false
            }
            fn terminate_process_tree(&self, _pid: u32) -> AppResult<()> {
                Ok(())
            }
            fn resolve_executable(&self, name: &str) -> Option<PathBuf> {
                paths::resolve_from_path(name)
            }
            fn cloudflared_candidates(&self) -> Vec<PathBuf> {
                paths::resolve_from_path("cloudflared")
                    .into_iter()
                    .collect()
            }
            fn frpc_candidates(&self) -> Vec<PathBuf> {
                paths::resolve_from_path("frpc").into_iter().collect()
            }
        }
        Box::new(Unsupported)
    }
}

// Return ancestors before descendants so callers can terminate in reverse order.
fn descendant_pids(root_pid: u32, records: &[(u32, u32)]) -> Vec<u32> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, parent) in records {
        children_by_parent.entry(parent).or_default().push(pid);
    }
    let mut pending = VecDeque::from([root_pid]);
    let mut seen = HashSet::from([root_pid]);
    let mut ordered = Vec::new();
    while let Some(parent) = pending.pop_front() {
        if let Some(children) = children_by_parent.get(&parent) {
            for &pid in children {
                if seen.insert(pid) {
                    ordered.push(pid);
                    pending.push_back(pid);
                }
            }
        }
    }
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendant_walk_handles_reversed_and_mixed_snapshots() {
        for records in [
            vec![(20, 10), (30, 20), (40, 10), (50, 40)],
            vec![(50, 40), (40, 10), (30, 20), (20, 10)],
            vec![(30, 20), (50, 40), (20, 10), (40, 10)],
        ] {
            let found = descendant_pids(10, &records);
            assert_eq!(
                found.iter().copied().collect::<HashSet<_>>(),
                HashSet::from([20, 30, 40, 50])
            );
            for &(child, parent) in &records {
                if parent != 10 {
                    let parent_at = found.iter().position(|pid| *pid == parent).unwrap();
                    let child_at = found.iter().position(|pid| *pid == child).unwrap();
                    assert!(parent_at < child_at, "ancestors must precede descendants");
                }
            }
        }
    }

    #[test]
    fn descendant_walk_deduplicates_and_breaks_cycles() {
        let records = [
            (30, 20),
            (20, 10),
            (20, 10),
            (10, 30),
            (20, 30),
            (70, 80),
            (80, 70),
            (99, 1),
        ];
        assert_eq!(descendant_pids(10, &records), vec![20, 30]);
        assert!(descendant_pids(10, &[]).is_empty());
        assert!(descendant_pids(10, &[(99, 1), (70, 80), (80, 70)]).is_empty());
    }
}

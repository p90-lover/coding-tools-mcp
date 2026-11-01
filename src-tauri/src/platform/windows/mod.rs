mod net;
mod paths;
pub(crate) mod process;

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::platform::paths as shared_paths;
use crate::platform::Platform;

pub struct WindowsPlatform;

fn configured_state_dir(value: Option<std::ffi::OsString>) -> AppResult<Option<PathBuf>> {
    match value {
        None => Ok(None),
        Some(value) => {
            let directory = PathBuf::from(value);
            if !directory.is_absolute() {
                return Err(AppError::Message(
                    "CODING_TOOLS_STATE_DIR must be an absolute directory".into(),
                ));
            }
            Ok(Some(canonical_state_dir(directory)?))
        }
    }
}

// Exclusive file creation through a Windows junction can report ERROR_FILE_EXISTS
// for a nonexistent child. Resolve existing state roots before deriving write paths.
fn canonical_state_dir(directory: PathBuf) -> AppResult<PathBuf> {
    match directory.canonicalize() {
        Ok(directory) => Ok(directory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(directory),
        Err(error) => Err(error.into()),
    }
}

impl Platform for WindowsPlatform {
    fn os_name(&self) -> &'static str {
        "windows"
    }

    fn app_config_dir(&self) -> AppResult<PathBuf> {
        if let Some(directory) = configured_state_dir(std::env::var_os("CODING_TOOLS_STATE_DIR"))? {
            return Ok(directory);
        }
        canonical_state_dir(paths::roaming_app_data()?.join("coding-tools-mcp-desktop"))
    }

    fn find_pid_listening_on_port(&self, port: u16) -> AppResult<Option<u32>> {
        net::find_pid_listening_on_port(port)
    }

    fn reclaim_listening_port(&self, port: u16) -> AppResult<bool> {
        net::reclaim_listening_port(port)
    }

    fn process_image_path(&self, pid: u32) -> AppResult<Option<String>> {
        process::process_image_path(pid)
    }

    fn is_process_alive(&self, pid: u32) -> bool {
        process::is_process_alive(pid)
    }

    fn terminate_process_tree(&self, pid: u32) -> AppResult<()> {
        process::terminate_process_tree(pid)
    }

    fn terminate_processes_by_image_path(&self, image_path: &Path) -> AppResult<usize> {
        process::terminate_processes_by_image_path(image_path)
    }

    fn resolve_executable(&self, name: &str) -> Option<PathBuf> {
        shared_paths::resolve_from_path(name)
    }

    fn cloudflared_candidates(&self) -> Vec<PathBuf> {
        paths::cloudflared_candidates()
    }

    fn frpc_candidates(&self) -> Vec<PathBuf> {
        paths::frpc_candidates()
    }
}

#[cfg(test)]
mod state_directory_tests {
    use super::*;

    #[test]
    fn existing_default_and_configured_roots_resolve_junctions_before_writing() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .join(format!(
                "windows-state-root-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        let roaming = root.join("physical-roaming");
        let physical = roaming.join("coding-tools-mcp-desktop");
        let alias = root.join("roaming-alias");
        std::fs::create_dir_all(&physical).unwrap();
        let junction = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(alias.to_string_lossy().replace('/', "\\"))
            .arg(roaming.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(
            junction.status.success(),
            "junction fixture: {:?}: {}",
            junction.status,
            String::from_utf8_lossy(&junction.stderr)
        );
        let default_root = alias.join("coding-tools-mcp-desktop");
        let expected = physical.canonicalize().unwrap();
        let default = canonical_state_dir(default_root.clone()).unwrap();
        let configured = configured_state_dir(Some(default_root.into_os_string()))
            .unwrap()
            .unwrap();
        assert_eq!(default, expected);
        assert_eq!(configured, expected);
        let probe = configured.join("new-profile.tmp");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .unwrap();
        drop(file);
        assert!(physical.join("new-profile.tmp").is_file());
        std::fs::remove_dir(&alias).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn absent_state_root_is_returned_without_creating_it() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp")
            .join(format!(
                "missing-windows-state-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        assert!(!root.exists());
        assert_eq!(canonical_state_dir(root.clone()).unwrap(), root);
        assert_eq!(
            configured_state_dir(Some(root.clone().into_os_string())).unwrap(),
            Some(root.clone())
        );
        assert!(!root.exists());
    }

    #[test]
    fn explicit_test_state_directory_does_not_change_the_production_default() {
        assert_eq!(configured_state_dir(None).unwrap(), None);
        assert!(configured_state_dir(Some("relative-state".into())).is_err());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../aiTemp/isolated-state")
            .join(format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        assert_eq!(
            configured_state_dir(Some(root.clone().into_os_string())).unwrap(),
            Some(root)
        );
    }
}

mod net;
mod paths;
pub(crate) mod process;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use crate::error::{AppError, AppResult};
use crate::platform::paths as shared_paths;
use crate::platform::Platform;

pub struct WindowsPlatform;

/// The configured state folder alone (the tests' view of configured_state_root).
#[cfg(test)]
fn configured_state_dir(value: Option<OsString>) -> AppResult<Option<PathBuf>> {
    Ok(configured_state_root(value)?.map(|(directory, _)| directory))
}

/// The configured state folder and whether it resolved (see resolve_state_root).
fn configured_state_root(value: Option<OsString>) -> AppResult<Option<(PathBuf, bool)>> {
    match value {
        None => Ok(None),
        Some(value) => {
            let directory = PathBuf::from(value);
            if !directory.is_absolute() {
                return Err(AppError::Message(
                    "CODING_TOOLS_STATE_DIR must be an absolute directory".into(),
                ));
            }
            Ok(Some(resolve_state_root(directory)?))
        }
    }
}

/// The folder alone (the tests' view of resolve_state_root).
#[cfg(test)]
fn canonical_state_dir(directory: PathBuf) -> AppResult<PathBuf> {
    resolve_state_root(directory).map(|(directory, _)| directory)
}

// Exclusive file creation through a Windows junction can report ERROR_FILE_EXISTS
// for a nonexistent child. Resolve existing state roots before deriving write paths.
/// The folder by its final path and `true`, or, while it does not exist yet, as given and `false`.
fn resolve_state_root(directory: PathBuf) -> AppResult<(PathBuf, bool)> {
    match directory.canonicalize() {
        Ok(directory) => Ok((directory, true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((directory, false)),
        Err(error) => Err(error.into()),
    }
}

/// The state folder as resolved for a CODING_TOOLS_STATE_DIR value (None: the default).
type StateRootMemo = Mutex<Option<(Option<OsString>, PathBuf)>>;

/// Resolving the state folder is a canonicalize through the user's AppData junction: 17 file-system
/// calls on the user's machine (2026-11-10). The data store asked for it twice on every refresh and
/// coding-tools-headless refreshes several times per request, so a chat's run read cost about 240
/// such calls. A folder that resolved keeps its final path for the life of the process.
static STATE_ROOT: StateRootMemo = Mutex::new(None);

/// `resolve`'s folder for `configured`, remembered in `memo` once it resolved. One that does not
/// exist yet is resolved again on the next call, so it is never kept in its unresolved form after
/// it is created; an error is never kept.
fn remembered_state_root(
    memo: &StateRootMemo,
    configured: Option<OsString>,
    resolve: impl FnOnce(Option<OsString>) -> AppResult<(PathBuf, bool)>,
) -> AppResult<PathBuf> {
    {
        let known = memo.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((key, directory)) = known.as_ref() {
            if *key == configured {
                return Ok(directory.clone());
            }
        }
    }
    let (directory, resolved) = resolve(configured.clone())?;
    if resolved {
        *memo.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((configured, directory.clone()));
    }
    Ok(directory)
}

fn state_root(configured: Option<OsString>) -> AppResult<(PathBuf, bool)> {
    match configured_state_root(configured)? {
        Some(root) => Ok(root),
        None => resolve_state_root(paths::roaming_app_data()?.join("coding-tools-mcp-desktop")),
    }
}

impl Platform for WindowsPlatform {
    fn os_name(&self) -> &'static str {
        "windows"
    }

    fn app_config_dir(&self) -> AppResult<PathBuf> {
        remembered_state_root(
            &STATE_ROOT,
            std::env::var_os("CODING_TOOLS_STATE_DIR"),
            state_root,
        )
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

    /// A resolver that counts its calls and answers G:\final\<value, or "default">.
    fn counted(
        calls: &std::cell::Cell<usize>,
        resolved: bool,
    ) -> impl FnOnce(Option<OsString>) -> AppResult<(PathBuf, bool)> + '_ {
        move |configured| {
            calls.set(calls.get() + 1);
            let name = configured.unwrap_or_else(|| OsString::from("default"));
            Ok((PathBuf::from(r"G:\final").join(name), resolved))
        }
    }

    #[test]
    fn a_resolved_state_root_is_remembered_per_configured_value_and_an_unresolved_one_is_not() {
        let memo: StateRootMemo = Mutex::new(None);
        let calls = std::cell::Cell::new(0);
        // Not there yet: asked again every time, so it is not kept unresolved once it is created.
        for _ in 0..2 {
            assert_eq!(
                remembered_state_root(&memo, None, counted(&calls, false)).unwrap(),
                PathBuf::from(r"G:\final\default")
            );
        }
        assert_eq!(calls.get(), 2);
        // Resolved: asked once, then served from the memo.
        for _ in 0..3 {
            assert_eq!(
                remembered_state_root(&memo, None, counted(&calls, true)).unwrap(),
                PathBuf::from(r"G:\final\default")
            );
        }
        assert_eq!(calls.get(), 3);
        // Another CODING_TOOLS_STATE_DIR value is resolved for itself, and replaces the memo.
        assert_eq!(
            remembered_state_root(&memo, Some("other".into()), counted(&calls, true)).unwrap(),
            PathBuf::from(r"G:\final\other")
        );
        assert_eq!(calls.get(), 4);
        assert_eq!(
            remembered_state_root(&memo, Some("other".into()), counted(&calls, true)).unwrap(),
            PathBuf::from(r"G:\final\other")
        );
        assert_eq!(calls.get(), 4);
        // An error is returned as it is and never kept.
        let failing = |_: Option<OsString>| -> AppResult<(PathBuf, bool)> {
            Err(AppError::Message(
                "CODING_TOOLS_STATE_DIR must be an absolute directory".into(),
            ))
        };
        assert!(remembered_state_root(&memo, Some("relative".into()), failing).is_err());
        assert_eq!(
            remembered_state_root(&memo, Some("other".into()), counted(&calls, true)).unwrap(),
            PathBuf::from(r"G:\final\other")
        );
        assert_eq!(calls.get(), 4);
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

use std::fs;
use std::path::Path;

use crate::error::{AppError, AppResult};

pub fn is_process_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).is_dir()
}

pub fn process_image_path(pid: u32) -> AppResult<Option<String>> {
    let exe = Path::new("/proc").join(pid.to_string()).join("exe");
    match fs::read_link(exe) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(_) => Ok(None),
    }
}

pub fn terminate_process_tree(root_pid: u32) -> AppResult<()> {
    let children = collect_child_pids(root_pid)?;
    for pid in children.iter().copied().rev() {
        signal_pid(pid, libc::SIGTERM)?;
    }
    signal_pid(root_pid, libc::SIGTERM)?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    for pid in &children {
        if is_process_alive(*pid) {
            let _ = signal_pid(*pid, libc::SIGKILL);
        }
    }
    if is_process_alive(root_pid) {
        signal_pid(root_pid, libc::SIGKILL)?;
    }
    Ok(())
}

fn collect_child_pids(root_pid: u32) -> AppResult<Vec<u32>> {
    let mut records = Vec::new();
    let proc = Path::new("/proc");

    for entry in fs::read_dir(proc)
        .map_err(|err| AppError::Message(format!("read /proc failed: {err}")))?
        .flatten()
    {
        let file_name = entry.file_name();
        let Some(pid_str) = file_name.to_str() else {
            continue;
        };
        if !pid_str.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        let Some(parent) =
            parent_pid_from_stat_read(fs::read_to_string(entry.path().join("stat")))?
        else {
            continue;
        };
        records.push((pid, parent));
    }
    Ok(crate::platform::descendant_pids(root_pid, &records))
}

fn parent_pid_from_stat_read(result: std::io::Result<String>) -> AppResult<Option<u32>> {
    match result {
        Ok(stat) => Ok(parent_pid_from_stat(&stat)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::Message(format!("read stat failed: {error}"))),
    }
}

fn parent_pid_from_stat(stat: &str) -> Option<u32> {
    let end = stat.rfind(')')?;
    let rest = stat.get(end + 2..)?;
    let parent = rest.split_whitespace().nth(1)?;
    parent.parse().ok()
}

fn signal_pid(pid: u32, signal: i32) -> AppResult<()> {
    let result = unsafe { libc::kill(pid as i32, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(AppError::Message(format!(
        "kill({pid}, {signal}) failed: {error}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_process_stat_is_skipped_without_hiding_other_read_errors() {
        assert_eq!(
            parent_pid_from_stat_read(Err(std::io::ErrorKind::NotFound.into())).unwrap(),
            None
        );
        let error = parent_pid_from_stat_read(Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fixture",
        )))
        .unwrap_err();
        assert!(
            matches!(error, AppError::Message(message) if message == "read stat failed: fixture")
        );
        assert_eq!(
            parent_pid_from_stat_read(Ok("20 (fixture) S 10".into())).unwrap(),
            Some(10)
        );
        assert_eq!(
            parent_pid_from_stat_read(Ok("malformed stat".into())).unwrap(),
            None
        );
    }

    #[test]
    fn signal_probe_treats_an_absent_process_as_cleaned_up() {
        signal_pid(i32::MAX as u32, 0).expect("an absent process is already cleaned up");
    }
}

use std::mem;
use std::process::Command;

use crate::error::{AppError, AppResult};

#[link(name = "proc")]
extern "C" {
    fn proc_listallpids(buffer: *mut libc::c_void, buffersize: i32) -> i32;
}

pub fn find_pid_listening_on_port(port: u16) -> AppResult<Option<u32>> {
    let output = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|err| AppError::Message(format!("lsof failed: {err}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return Ok(None);
    }

    let pid = first_line
        .parse::<u32>()
        .map_err(|err| AppError::Message(format!("invalid lsof pid output: {err}")))?;
    Ok(Some(pid))
}

pub fn parent_pid(pid: u32) -> AppResult<Option<u32>> {
    let mut info = mem::MaybeUninit::<libc::proc_bsdshortinfo>::uninit();
    let expected_size = mem::size_of::<libc::proc_bsdshortinfo>() as i32;
    let size = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size,
        )
    };
    if size != expected_size {
        return Ok(None);
    }
    let info = unsafe { info.assume_init() };
    Ok(Some(info.pbsi_ppid))
}

pub fn all_pids() -> AppResult<Vec<i32>> {
    let mut buffer = vec![0u8; 32 * 1024];
    let count = unsafe { proc_listallpids(buffer.as_mut_ptr().cast(), buffer.len() as i32) };
    if count <= 0 {
        return Err(AppError::Message("proc_listallpids failed".into()));
    }
    let capacity = buffer.len() / mem::size_of::<i32>();
    let pid_count = (count as usize).min(capacity);
    let pids = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<i32>(), pid_count) };
    Ok(pids.iter().copied().filter(|pid| *pid > 0).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_pid_reads_current_process_parent() {
        let expected = unsafe { libc::getppid() } as u32;
        assert_eq!(parent_pid(std::process::id()).unwrap(), Some(expected));
    }
}

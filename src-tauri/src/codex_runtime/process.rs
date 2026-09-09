//! Own only the child process tree created for this local connection.
//! Process ownership is lifecycle control, not a command/OS sandbox.
use std::{
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

pub struct OwnedProcess {
    child: Mutex<Child>,
    stopped: AtomicBool,
    #[cfg(windows)]
    job: Mutex<Option<usize>>,
}
impl OwnedProcess {
    pub fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW; no elevation.
        }
        let mut child = command
            .spawn()
            .map_err(|_| "RUNTIME_START_FAILED".to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{
                Foundation::{CloseHandle, HANDLE},
                System::JobObjects::*,
            };
            let setup = (|| -> Result<usize, String> {
                let job =
                    unsafe { CreateJobObjectW(None, None) }.map_err(|_| "RUNTIME_JOB_FAILED")?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = unsafe {
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                        std::mem::size_of_val(&info) as u32,
                    )
                    .and_then(|_| AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())))
                };
                if ok.is_err() {
                    let _ = unsafe { CloseHandle(job) };
                    return Err("RUNTIME_JOB_FAILED".into());
                }
                Ok(job.0 as usize)
            })();
            let job = match setup {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };
            return Ok(Self {
                child: Mutex::new(child),
                stopped: AtomicBool::new(false),
                job: Mutex::new(Some(job)),
            });
        }
        #[cfg(not(windows))]
        Ok(Self {
            child: Mutex::new(child),
            stopped: AtomicBool::new(false),
        })
    }
    pub fn pipes(
        &self,
    ) -> Result<
        (
            std::process::ChildStdin,
            std::process::ChildStdout,
            std::process::ChildStderr,
        ),
        String,
    > {
        let mut child = self.child.lock().map_err(|_| "RUNTIME_LOCK_FAILED")?;
        Ok((
            child.stdin.take().ok_or("RUNTIME_STDIN_MISSING")?,
            child.stdout.take().ok_or("RUNTIME_STDOUT_MISSING")?,
            child.stderr.take().ok_or("RUNTIME_STDERR_MISSING")?,
        ))
    }
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        if let Ok(mut job) = self.job.lock() {
            if let Some(bits) = job.take() {
                let _ = unsafe {
                    windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                        bits as *mut std::ffi::c_void,
                    ))
                };
            }
        }
        if let Ok(mut child) = self.child.lock() {
            // Signal once, before reaping the leader, so its process-group id cannot be reused.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

//! Own only the selected app-server process. This is lifecycle supervision, not a sandbox.
use std::process::{Child, Command};

pub struct OwnedProcess {
    child: Child,
    stopped: bool,
    #[cfg(windows)]
    job: usize,
}
impl OwnedProcess {
    pub fn configure(command: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never elevate.
        }
    }
    pub fn attach(mut child: Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{
                Foundation::{CloseHandle, HANDLE},
                System::JobObjects::*,
            };
            let result = (|| {
                let handle = unsafe { CreateJobObjectW(None, None) }.map_err(|_| ())?;
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let assigned = unsafe {
                    SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                        std::mem::size_of_val(&limits) as u32,
                    )
                    .and_then(|_| AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle())))
                };
                if assigned.is_err() {
                    let _ = unsafe { CloseHandle(handle) };
                    return Err(());
                }
                Ok(handle.0 as usize)
            })();
            match result {
                Ok(job) => Ok(Self {
                    child,
                    job,
                    stopped: false,
                }),
                Err(()) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    Err(
                        "Cannot supervise the native process; no model request was submitted"
                            .into(),
                    )
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = &mut child;
            Ok(Self {
                child,
                stopped: false,
            })
        }
    }
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        #[cfg(windows)]
        if self.job != 0 {
            use windows::Win32::{
                Foundation::{CloseHandle, HANDLE},
                System::JobObjects::TerminateJobObject,
            };
            // The owned HANDLE is represented as usize solely to allow a mutex-protected owner
            // to move across threads. It is closed once, only under exclusive &mut self access.
            let handle = HANDLE(self.job as *mut std::ffi::c_void);
            let _ = unsafe { TerminateJobObject(handle, 1) };
            let _ = unsafe { CloseHandle(handle) };
            self.job = 0;
        }
        #[cfg(unix)]
        {
            // The unreaped direct child owns this process-group identity. Escaped sessions
            // are outside this supervision guarantee; no process-name-wide cleanup is used.
            let _ = unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

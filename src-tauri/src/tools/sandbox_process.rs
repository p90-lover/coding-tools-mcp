//! OS-owned lifecycle for the adapter and inherited descendants; no shell cleanup commands.
use crate::error::{AppError, AppResult};
#[cfg(windows)]
mod native {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::*,
    };
    pub struct Job(HANDLE);
    impl Drop for Job {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    pub fn assign(child: &std::process::Child) -> AppResult<Job> {
        let handle = unsafe { CreateJobObjectW(None, None) }
            .map_err(|_| AppError::Message("Cannot create sandbox helper process group".into()))?;
        let job = Job(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|_| AppError::Message("Cannot enforce helper process-tree termination".into()))?;
        unsafe { AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle())) }.map_err(
            |_| {
                AppError::Message(
                    "Cannot attach helper to process-tree supervision; no command submitted".into(),
                )
            },
        )?;
        Ok(job)
    }
}
#[cfg(windows)]
pub use native::assign;
#[cfg(not(windows))]
pub struct Job;
#[cfg(not(windows))]
impl Drop for Job {
    fn drop(&mut self) {}
}
#[cfg(not(windows))]
pub fn assign(_child: &std::process::Child) -> AppResult<Job> {
    Err(AppError::Message(
        "Native sandbox lifecycle is Windows-only".into(),
    ))
}

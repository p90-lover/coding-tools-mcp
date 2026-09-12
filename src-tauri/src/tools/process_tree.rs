//! Own only the process tree admitted by this command. This is lifecycle control,
//! not a filesystem/network sandbox and never attaches to a user-supplied PID.
use std::io;
use tokio::process::{Child, Command};

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, mem::size_of};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                    THREADENTRY32,
                },
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW,
                    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
                    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
                    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        },
    };

    #[derive(Debug)]
    pub struct ProcessTree(usize);
    fn error(e: windows::core::Error) -> io::Error {
        io::Error::other(e.to_string())
    }
    impl ProcessTree {
        pub fn prepare(command: &mut Command) -> io::Result<Self> {
            // Launch suspended so user code cannot spawn outside the job before assignment.
            command.creation_flags(0x08000000 | 0x00000200 | 0x00000004);
            unsafe {
                let handle = CreateJobObjectW(None, PCWSTR::null()).map_err(error)?;
                let owner = Self(handle.0 as usize);
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(error)?;
                Ok(owner)
            }
        }
        fn handle(&self) -> HANDLE {
            HANDLE(self.0 as *mut c_void)
        }
        pub fn admit(&mut self, child: &Child) -> io::Result<()> {
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("Owned child exited before admission"))?;
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("Owned process handle unavailable"))?;
            unsafe {
                AssignProcessToJobObject(self.handle(), HANDLE(process)).map_err(error)?;
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(error)?;
                let mut entry = THREADENTRY32 {
                    dwSize: size_of::<THREADENTRY32>() as u32,
                    ..Default::default()
                };
                let mut next = Thread32First(snapshot, &mut entry);
                let mut result = Err(io::Error::other(
                    "Owned suspended thread could not be located",
                ));
                let started = std::time::Instant::now();
                while next.is_ok() && started.elapsed() < std::time::Duration::from_secs(1) {
                    if entry.th32OwnerProcessID == pid {
                        result = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                            .map_err(error)
                            .and_then(|thread| {
                                let previous = ResumeThread(thread);
                                let _ = CloseHandle(thread);
                                if previous == u32::MAX {
                                    Err(io::Error::last_os_error())
                                } else {
                                    Ok(())
                                }
                            });
                        break;
                    }
                    next = Thread32Next(snapshot, &mut entry);
                }
                let _ = CloseHandle(snapshot);
                result
            }
        }
        pub fn terminate(&self) -> io::Result<()> {
            unsafe { TerminateJobObject(self.handle(), 1).map_err(error) }
        }
        pub fn is_empty(&self) -> io::Result<bool> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(self.handle()),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut c_void,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    None,
                )
                .map_err(error)?;
            }
            Ok(info.ActiveProcesses == 0)
        }
    }
    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle());
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    #[derive(Debug)]
    pub struct ProcessTree(Option<u32>);
    impl ProcessTree {
        pub fn prepare(command: &mut Command) -> io::Result<Self> {
            command.process_group(0);
            Ok(Self(None))
        }
        pub fn admit(&mut self, child: &Child) -> io::Result<()> {
            self.0 = Some(
                child
                    .id()
                    .ok_or_else(|| io::Error::other("Owned child exited before admission"))?,
            );
            Ok(())
        }
        pub fn terminate(&self) -> io::Result<()> {
            if let Some(pid) = self.0 {
                if unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } != 0 {
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() != Some(libc::ESRCH) {
                        return Err(e);
                    }
                }
            }
            Ok(())
        }
        pub fn is_empty(&self) -> io::Result<bool> {
            let Some(pid) = self.0 else {
                return Ok(true);
            };
            if unsafe { libc::kill(-(pid as i32), 0) } == 0 {
                return Ok(false);
            }
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::ESRCH) {
                Ok(true)
            } else {
                Err(e)
            }
        }
    }
}
pub use platform::ProcessTree;

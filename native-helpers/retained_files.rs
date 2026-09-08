//! Preserve owned maintenance files by handle-relative rename, never permanent deletion.
//! The protected parent ACL stays intact; reparse points and replacement are refused.
use anyhow::{Context, Result};
use rand::RngCore;
use std::ffi::OsStr;
use std::io;
use std::mem::{offset_of, size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::{HANDLE, NTSTATUS, RtlNtStatusToDosError};
use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE};
use windows_sys::Win32::System::IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0};
use crate::no_reparse_dir::{DirectoryOpenDisposition, open_directory_no_reparse, open_no_reparse, validate_local_directory_path};

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSetInformationFile(handle: HANDLE, status: *mut IO_STATUS_BLOCK, info: *const std::ffi::c_void, len: u32, class: i32) -> NTSTATUS;
}

/// Move an already-owned writable handle to a unique entry in its parent's Trash.
/// Holding the parent/destination directory handles avoids path substitution.
pub(crate) fn preserve_open_file(parent: &Path, file: BorrowedHandle<'_>) -> Result<()> {
    let _parent = open_directory_no_reparse(parent, FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, DirectoryOpenDisposition::OpenExisting)?;
    let trash = open_directory_no_reparse(&parent.join("Trash"), FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, DirectoryOpenDisposition::OpenOrCreate)?;
    let mut random = [0u8; 16];
    rand::rngs::OsRng.try_fill_bytes(&mut random).context("Generate unique retention name")?;
    let name = format!("retained-{:032x}.bin", u128::from_le_bytes(random));
    let name: Vec<u16> = OsStr::new(&name).encode_wide().collect();
    let size = size_of::<FILE_RENAME_INFO>() + size_of_val(name.as_slice());
    let mut buffer = vec![0usize; size.div_ceil(size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let mut status = IO_STATUS_BLOCK { Anonymous: IO_STATUS_BLOCK_0 { Status: 0 }, Information: 0 };
    unsafe {
        (*info).Anonymous.ReplaceIfExists = 0;
        (*info).RootDirectory = trash.as_raw_handle() as HANDLE;
        (*info).FileNameLength = u32::try_from(size_of_val(name.as_slice()))?;
        let filename = buffer.as_mut_ptr().cast::<u8>().add(offset_of!(FILE_RENAME_INFO, FileName)).cast::<u16>();
        std::ptr::copy_nonoverlapping(name.as_ptr(), filename, name.len());
        let result = NtSetInformationFile(file.as_raw_handle() as HANDLE, &mut status, info.cast(), u32::try_from(size)?, 10);
        if result < 0 { return Err(io::Error::from_raw_os_error(RtlNtStatusToDosError(result) as i32).into()); }
    }
    Ok(())
}

/// Used only at the pinned upstream's known stale-file maintenance call sites.
/// Missing files retain NotFound semantics; unknown directories/links fail closed.
pub fn preserve_owned_file(path: &Path) -> io::Result<()> {
    fn run(path: &Path) -> Result<()> {
        validate_local_directory_path(path)?;
        let parent = path.parent().context("Maintenance file must have a parent")?;
        let directory = open_directory_no_reparse(parent, FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, DirectoryOpenDisposition::OpenExisting)?;
        let mut name: Vec<u16> = path.file_name().context("Maintenance file must have a name")?.encode_wide().chain(Some(0)).collect();
        let file = open_no_reparse(directory.as_raw_handle() as HANDLE, &mut name,
            DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, 1, 0x40)?;
        use std::os::windows::io::AsHandle;
        preserve_open_file(parent, file.as_handle())
    }
    run(path).map_err(|e| match e.downcast_ref::<io::Error>() {
        Some(error) => match error.raw_os_error() {
            Some(code) => io::Error::from_raw_os_error(code),
            None => io::Error::new(error.kind(), error.to_string()),
        },
        None => io::Error::other(e.to_string()),
    })
}

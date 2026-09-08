//! Additional AppContainer boundary for read isolation. No capabilities or broker.
use anyhow::{bail, Context, Result};
use std::{collections::HashMap, ffi::c_void, mem::size_of, path::Path, ptr};
use windows_sys::Win32::{Foundation::GetLastError, Security::{FreeSid, GetLengthSid}, System::Threading::UpdateProcThreadAttribute};
use crate::{proc_thread_attr::ProcThreadAttributeList, token::LocalSid};
pub const ENV_SID: &str = "CODING_TOOLS_READ_CONTAINER_SID";
#[repr(C)]
struct SecurityCapabilities { sid: *mut c_void, capabilities: *mut c_void, count: u32, reserved: u32 }
#[link(name="userenv")]
unsafe extern "system" {
    fn CreateAppContainerProfile(name:*const u16, display:*const u16, description:*const u16, capabilities:*const c_void, count:u32, sid:*mut *mut c_void)->i32;
    fn DeriveAppContainerSidFromAppContainerName(name:*const u16, sid:*mut *mut c_void)->i32;
}
/// Only the controller calls this. Keep the per-workspace profile; no deletion.
pub fn prepare(root:&Path, home:&Path)->Result<String> {
    // The pinned upstream generates S-1-5-21 workspace SIDs, not S-1-9.
    let cap=crate::workspace_cap_sid_for_cwd(home,root)?;
    let suffix=cap.strip_prefix("S-1-5-21-").context("Invalid workspace capability")?;
    if suffix.is_empty() || !suffix.bytes().all(|c|c.is_ascii_digit()||c==b'-') {
        bail!("Invalid workspace capability name");
    }
    let name=format!("ctmcp.{suffix}");
    if name.len()>64 {bail!("Read-container name exceeds Windows limit");}
    let name=crate::to_wide(name);
    let label=crate::to_wide("Coding Tools MCP read-only commands");
    let mut sid=ptr::null_mut();
    let status=unsafe{CreateAppContainerProfile(name.as_ptr(),label.as_ptr(),label.as_ptr(),ptr::null(),0,&mut sid)};
    if status as u32==0x800700b7 {
        let derived=unsafe{DeriveAppContainerSidFromAppContainerName(name.as_ptr(),&mut sid)};
        if derived<0 {bail!("Cannot resolve read-container SID: {derived:#x}");}
    } else if status<0 {bail!("Cannot create read-container profile: {status:#x}");}
    if sid.is_null(){bail!("Missing read-container SID");}
    let result=(|| -> Result<String> {
        let bytes=unsafe{std::slice::from_raw_parts(sid as *const u8,GetLengthSid(sid) as usize)};
        let text=crate::string_from_sid_bytes(bytes).map_err(anyhow::Error::msg)?;
        // Read/execute only. The pinned helper applies OBJECT/CONTAINER inheritance.
        let helper=std::env::current_exe()?.parent().context("Missing helper directory")?.canonicalize()?;
        for path in [root,helper.as_path()] {
            unsafe{crate::ensure_allow_mask_aces(path,&[sid],0x001200a9)}?;
        }
        Ok(text)
    })();
    unsafe{FreeSid(sid)};
    result
}
pub(crate) struct Boundary { _sid:LocalSid, capabilities:SecurityCapabilities }
impl Boundary {
    pub(crate) fn from_env(env:&HashMap<String,String>)->Result<Self> {
        let text=env.get(ENV_SID).context("Missing mandatory read-container boundary; no unrestricted fallback")?;
        if !text.starts_with("S-1-15-2-")||text.len()>256 {bail!("Invalid read-container SID");}
        let sid=LocalSid::from_string(text)?;
        let capabilities=SecurityCapabilities{sid:sid.as_ptr(),capabilities:ptr::null_mut(),count:0,reserved:0};
        Ok(Self{_sid:sid,capabilities})
    }
    pub(crate) fn install(&mut self, attrs:&mut ProcThreadAttributeList)->Result<()> {
        let ok=unsafe{UpdateProcThreadAttribute(attrs.as_mut_ptr(),0,0x00020009,
            (&mut self.capabilities as *mut SecurityCapabilities).cast(),size_of::<SecurityCapabilities>(),ptr::null_mut(),ptr::null_mut())};
        if ok==0 {bail!("Cannot install read-container boundary: {}",unsafe{GetLastError()});}
        Ok(())
    }
}

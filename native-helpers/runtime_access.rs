//! Local elevated provisioning of a fixed, read-only Windows runtime allowlist.
//! Existing owners, deny ACEs and protected-DACL flags are preserved. No file data changes.
use anyhow::{ensure, Context, Result};
use codex_windows_sandbox::{to_wide, workspace_write_cap_sid_for_root, LocalSid};
use std::{collections::BTreeSet, ffi::c_void, mem::{size_of, zeroed}, os::windows::{ffi::OsStringExt, fs::MetadataExt}, path::{Path, PathBuf}, ptr::{null, null_mut}};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, LocalFree, SetLastError, HANDLE, INVALID_HANDLE_VALUE},
    Security::{AdjustTokenPrivileges, LookupPrivilegeValueW, TOKEN_PRIVILEGES, TOKEN_ADJUST_PRIVILEGES, TOKEN_QUERY, DACL_SECURITY_INFORMATION, ACL,
        Authorization::{GetSecurityInfo, SetSecurityInfo, SetEntriesInAclW, EXPLICIT_ACCESS_W, TRUSTEE_W, TRUSTEE_IS_SID, GRANT_ACCESS, SE_FILE_OBJECT, SE_REGISTRY_KEY}},
    Storage::FileSystem::{CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_DIRECTORY, OPEN_EXISTING, FILE_READ_ATTRIBUTES, READ_CONTROL, WRITE_DAC, FILE_GENERIC_READ, FILE_GENERIC_EXECUTE},
    System::{Registry::{RegOpenKeyExW, RegCloseKey, HKEY_LOCAL_MACHINE, HKEY, KEY_READ}, Threading::GetCurrentProcess},
};
#[link(name="advapi32")]
unsafe extern "system" { fn OpenProcessToken(process: HANDLE, access:u32, token:*mut HANDLE)->i32; }
#[link(name="kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buffer:*mut u16,size:u32)->u32;
    fn GetSystemPreferredUILanguages(flags:u32,count:*mut u32,buffer:*mut u16,size:*mut u32)->i32;
    fn GetUserPreferredUILanguages(flags:u32,count:*mut u32,buffer:*mut u16,size:*mut u32)->i32;
}
const FILES:&[&str]=&["bcrypt.dll","cmd.exe","dnsapi.dll","kernelbase.dll","msvcrt.dll","mswsock.dll","napinsp.dll","nsi.dll","ntdll.dll","rpcrt4.dll","sspicli.dll","winrnr.dll","ws2_32.dll","wshbth.dll","wshtcpip.dll"];
const KEYS:&[(&str,u32)]=&[
    (r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters",2),
    (r"SYSTEM\CurrentControlSet\Services\WinSock\Parameters",2),
    (r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",0),
    (r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Winsock",0),
    (r"SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters",0),
    (r"SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Winsock",0),
    (r"SYSTEM\CurrentControlSet\Services\Winsock\Setup Migration\Providers",2),
    (r"SYSTEM\CurrentControlSet\Services\vmbus\Parameters\Winsock",0),
    (r"SYSTEM\CurrentControlSet\Services\Psched\Parameters\Winsock",0),
    (r"SYSTEM\CurrentControlSet\Services\afunix\Parameters\Winsock",0),
    (r"SYSTEM\CurrentControlSet\Services\RFCOMM\Parameters\Winsock",0),
];
struct Handle(HANDLE);
impl Drop for Handle {fn drop(&mut self){unsafe {CloseHandle(self.0);}}}
struct Allocation(*mut c_void);
impl Drop for Allocation {fn drop(&mut self){if !self.0.is_null(){unsafe {LocalFree(self.0 as _);}}}}
struct Key(HKEY);
impl Drop for Key {fn drop(&mut self){unsafe {RegCloseKey(self.0);}}}
struct RestorePrivilege {token:Handle, previous:TOKEN_PRIVILEGES}
impl RestorePrivilege {
    fn acquire()->Result<Self>{unsafe{
        let mut token=0;
        ensure!(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_ADJUST_PRIVILEGES,&mut token)!=0,"Cannot open local provisioning token: {}",GetLastError());
        let token=Handle(token);
        let mut desired:TOKEN_PRIVILEGES=zeroed();desired.PrivilegeCount=1;
        ensure!(LookupPrivilegeValueW(null(),to_wide("SeRestorePrivilege").as_ptr(),&mut desired.Privileges[0].Luid)!=0,"Cannot resolve restore privilege");
        desired.Privileges[0].Attributes=2;
        let mut previous:TOKEN_PRIVILEGES=zeroed();let mut size=0;
        SetLastError(0);
        let ok=AdjustTokenPrivileges(token.0,0,&desired,size_of::<TOKEN_PRIVILEGES>() as u32,&mut previous,&mut size);
        ensure!(ok!=0 && GetLastError()==0,"Runtime ACL preparation requires explicit local elevation");
        Ok(Self {token,previous})
    }}
}
impl Drop for RestorePrivilege {fn drop(&mut self){unsafe {AdjustTokenPrivileges(self.token.0,0,&self.previous,0,null_mut(),null_mut());}}}
fn append_read(handle:HANDLE,kind:i32,sid:*mut c_void,mask:u32,inheritance:u32)->Result<()> {unsafe{
    let mut acl:*mut ACL=null_mut();let mut descriptor=null_mut();
    let code=GetSecurityInfo(handle,kind,DACL_SECURITY_INFORMATION,null_mut(),null_mut(),&mut acl,null_mut(),&mut descriptor);
    let _descriptor=Allocation(descriptor);
    ensure!(code==0 && !acl.is_null(),"Runtime security descriptor unavailable: {code}");
    let entry=EXPLICIT_ACCESS_W {grfAccessPermissions:mask,grfAccessMode:GRANT_ACCESS,grfInheritance:inheritance,Trustee:TRUSTEE_W{pMultipleTrustee:null_mut(),MultipleTrusteeOperation:0,TrusteeForm:TRUSTEE_IS_SID,TrusteeType:0,ptstrName:sid.cast()}};
    let mut merged=null_mut();let code=SetEntriesInAclW(1,&entry,acl,&mut merged);
    let _merged=Allocation(merged.cast());
    ensure!(code==0,"Cannot merge runtime read capability: {code}");
    // DACL-only: never change owner, integrity label, deny ACEs or inheritance protection.
    let code=SetSecurityInfo(handle,kind,DACL_SECURITY_INFORMATION,null_mut(),null_mut(),merged,null_mut());
    ensure!(code==0,"Cannot apply runtime read capability: {code}");Ok(())
}}
fn normal_directory(path:&Path)->Result<PathBuf>{
    let metadata=std::fs::symlink_metadata(path)?;
    ensure!(metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT==0,"Runtime directory must not be a reparse point");
    dunce::canonicalize(path).context("Cannot resolve runtime directory")
}
fn grant_file(path:&Path,sid:*mut c_void)->Result<()> {
    let metadata=match std::fs::symlink_metadata(path){Ok(m)=>m,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(e.into())};
    ensure!(metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT==0,"Unexpected runtime file type: {}",path.display());
    let real=dunce::canonicalize(path)?;
    ensure!(real.parent()==Some(normal_directory(path.parent().context("Runtime file parent missing")?)?.as_path()),"Runtime file escaped its fixed directory");
    let handle=unsafe {CreateFileW(to_wide(path).as_ptr(),READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES,7,null(),OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,0)};
    ensure!(handle!=0 && handle!=INVALID_HANDLE_VALUE,"Cannot open runtime ACL: {}",unsafe {GetLastError()});
    let handle=Handle(handle);let mut info:BY_HANDLE_FILE_INFORMATION=unsafe {zeroed()};
    ensure!(unsafe {GetFileInformationByHandle(handle.0,&mut info)}!=0 && info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)==0,"Runtime file changed while opening");
    append_read(handle.0,SE_FILE_OBJECT,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,0)
}
fn languages()->Result<BTreeSet<String>> {
    let mut names=BTreeSet::from(["en-US".to_string()]);
    for api in [GetSystemPreferredUILanguages as unsafe extern "system" fn(u32,*mut u32,*mut u16,*mut u32)->i32,GetUserPreferredUILanguages] {
        let mut count=0;let mut size=0;
        ensure!(unsafe {api(8,&mut count,null_mut(),&mut size)}!=0 && (1..=4096).contains(&size) && count<=32,"Cannot query bounded runtime languages");
        let mut buffer=vec![0u16;size as usize];let capacity=size;
        ensure!(unsafe {api(8,&mut count,buffer.as_mut_ptr(),&mut size)}!=0 && size<=capacity && count<=32,"Runtime languages changed during query");
        for value in buffer[..size as usize].split(|c|*c==0).filter(|v|!v.is_empty()) {
            let name=String::from_utf16(value)?;
            ensure!(name.len()<36 && name.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'),"Invalid runtime language name");
            names.insert(name);
        }
    }
    ensure!(names.len()<=65,"Too many runtime languages");Ok(names)
}
pub(super) fn provision(home:&Path,cwd:&Path)->Result<()> {
    let mut buffer=vec![0u16;32768];let n=unsafe {GetSystemDirectoryW(buffer.as_mut_ptr(),buffer.len() as u32)};
    ensure!(n>0 && (n as usize)<buffer.len(),"Cannot locate the native Windows runtime");
    let runtime=normal_directory(&PathBuf::from(std::ffi::OsString::from_wide(&buffer[..n as usize])))?;
    let cap=workspace_write_cap_sid_for_root(home,cwd,&runtime)?;let sid=LocalSid::from_string(&cap)?;
    let _restore=RestorePrivilege::acquire()?;
    for name in FILES {grant_file(&runtime.join(name),sid.as_ptr())?;}
    for language in languages()? {
        let directory=runtime.join(language);
        if !directory.exists(){continue;}
        normal_directory(&directory)?;
        for name in FILES {grant_file(&directory.join(format!("{name}.mui")),sid.as_ptr())?;}
    }
    for (path,inheritance) in KEYS {
        let mut key=0;let code=unsafe {RegOpenKeyExW(HKEY_LOCAL_MACHINE,to_wide(path).as_ptr(),8,KEY_READ|WRITE_DAC,&mut key)};
        if code==2 {continue;}
        ensure!(code==0,"Cannot open fixed runtime registry key: {code}");
        let key=Key(key);append_read(key.0,SE_REGISTRY_KEY,sid.as_ptr(),KEY_READ,*inheritance)?;
    }
    Ok(())
}

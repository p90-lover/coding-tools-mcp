//! Isolated diagnostic only: reports Windows runtime access, never network traffic.
use std::{ffi::c_void,ptr,path::PathBuf,fs};
#[link(name="kernel32")]
unsafe extern "system" {fn LoadLibraryW(name:*const u16)->*mut c_void;fn FreeLibrary(h:*mut c_void)->i32;fn GetLastError()->u32;}
#[link(name="advapi32")]
unsafe extern "system" {
 fn RegOpenKeyExW(key:*mut c_void,path:*const u16,options:u32,access:u32,out:*mut *mut c_void)->i32;
 fn RegCloseKey(key:*mut c_void)->i32;
 fn RegEnumKeyExW(key:*mut c_void,index:u32,name:*mut u16,len:*mut u32,reserved:*mut u32,class:*mut u16,class_len:*mut u32,time:*mut c_void)->i32;
}
#[link(name="ws2_32")]
unsafe extern "system" {
 fn WSAStartup(version:u16,data:*mut c_void)->i32;fn WSACleanup()->i32;fn WSAGetLastError()->i32;
 fn WSAEnumProtocolsW(protocols:*const i32,buffer:*mut c_void,bytes:*mut u32)->i32;
 fn socket(af:i32,kind:i32,protocol:i32)->usize;fn closesocket(s:usize)->i32;
}
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
#[repr(align(8))]struct Buffer([u8;65536]);
fn main(){unsafe{
 let runtime=PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32");
 for name in ["mswsock.dll","dnsapi.dll","nsi.dll","ws2_32.dll","rpcrt4.dll","bcrypt.dll","bcryptprimitives.dll","sechost.dll","sspicli.dll"] {
  let p=runtime.join(name);let h=LoadLibraryW(wide(&p.to_string_lossy()).as_ptr());let error=GetLastError();
  println!("dll {name}: load={} error={error} read={:?}",!h.is_null(),fs::read(&p).map(|b|b.len()).map_err(|e|e.raw_os_error()));
  if !h.is_null(){FreeLibrary(h);}
 }
 for path in [r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters",r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9",r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9\Catalog_Entries64",r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9\Catalog_Entries64\000000000001",r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\NameSpace_Catalog5",r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters"] {
  let mut h=ptr::null_mut();let rc=RegOpenKeyExW((-2147483646isize) as *mut c_void,wide(path).as_ptr(),0,0x20019,&mut h);
  println!("registry {path}: open={rc}");
  if rc==0 {for i in 0..24 {let mut name=[0u16;256];let mut len=256;let rc=RegEnumKeyExW(h,i,name.as_mut_ptr(),&mut len,ptr::null_mut(),ptr::null_mut(),ptr::null_mut(),ptr::null_mut());
   if rc!=0{println!("  enumerate rc={rc}");break;}println!("  child {}",String::from_utf16_lossy(&name[..len as usize]));}RegCloseKey(h);}
 }
 let mut b=Buffer([0;65536]);let rc=WSAStartup(0x202,b.0.as_mut_ptr().cast());println!("WSAStartup={rc}");
 if rc==0 {let mut len=65536;let count=WSAEnumProtocolsW(ptr::null(),b.0.as_mut_ptr().cast(),&mut len);println!("WSAEnumProtocols count={count} bytes={len} error={}",WSAGetLastError());
  let s=socket(2,1,6);println!("socket valid={} error={}",s!=usize::MAX,WSAGetLastError());if s!=usize::MAX{closesocket(s);}WSACleanup();}
}}

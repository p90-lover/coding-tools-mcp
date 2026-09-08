"""Inspect Winsock catalog/provider initialization with existing read grants."""
from pathlib import Path
source=Path('aiTemp/release-verification/runtime_dependency_probe.py').read_text(encoding='utf-8')
prefix=source.split("source=Path('aiTemp/release-verification/runtime_acl_probe.py')",1)[0]
exec(compile(prefix,'dependency_functions','exec'),globals())
base=Path('aiTemp/release-verification/runtime_acl_probe.py').read_text(encoding='utf-8')
base=base.replace("files=[runtime/n for n in names if (runtime/n).is_file()]","files=dependency_closure(runtime,names)")
base=base.split("# Compile the normal focused probe",1)[0]
exec(compile(base,'acl_functions','exec'),globals())
raw=Path('aiTemp/release-verification/sandbox_native.py').read_text(encoding='utf-8')
start=raw.index("probe_source.write_text(r'''")+len("probe_source.write_text(r'''")
end=raw.index("''', encoding='utf-8')",start)
native=r'''
use std::{env,fs,io::{self,Write},net::{SocketAddr,TcpStream},time::Duration};
#[link(name="ws2_32")]
unsafe extern "system" {
 fn WSAStartup(version:u16,data:*mut u8)->i32;
 fn WSAGetLastError()->i32;
 fn WSAEnumProtocolsW(filter:*const i32,buffer:*mut u8,len:*mut u32)->i32;
 fn socket(af:i32,kind:i32,protocol:i32)->usize;
 fn closesocket(s:usize)->i32;
}
#[link(name="kernel32")]
unsafe extern "system" {
 fn LoadLibraryExW(file:*const u16,reserved:usize,flags:u32)->usize;
 fn GetLastError()->u32;
 fn FreeLibrary(h:usize)->i32;
}
fn main(){
 let a:Vec<String>=env::args().collect();
 if a.get(1).map(String::as_str)==Some("network") {
  unsafe {
   let mut data=[0usize;64];println!("startup {}",WSAStartup(0x202,data.as_mut_ptr().cast()));
   for name in ["mswsock.dll","fwpuclnt.dll","rasadhlp.dll"] {
    let file:Vec<u16>=format!("{}\\System32\\{}",env::var("SystemRoot").unwrap(),name).encode_utf16().chain(Some(0)).collect();
    let lib=LoadLibraryExW(file.as_ptr(),0,0x800);let error=GetLastError();
    println!("load {} success={} error={}",name,lib!=0,error);if lib!=0 {FreeLibrary(lib);}
   }
   let mut buffer=[0usize;16384];let mut len=(buffer.len()*8) as u32;
   let protocols=WSAEnumProtocolsW(std::ptr::null(),buffer.as_mut_ptr().cast(),&mut len);
   println!("catalog protocols={} error={} bytes={}",protocols,WSAGetLastError(),len);
   if protocols>0 {
    let bytes=std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(),len as usize);
    for record in bytes.chunks_exact(628).take(protocols as usize) {
     let af=i32::from_le_bytes(record[76..80].try_into().unwrap());
     let kind=i32::from_le_bytes(record[88..92].try_into().unwrap());
     let proto=i32::from_le_bytes(record[92..96].try_into().unwrap());
     let text:Vec<u16>=record[116..628].chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).take_while(|v|*v!=0).collect();
     println!("protocol af={} kind={} proto={} name={}",af,kind,proto,String::from_utf16_lossy(&text));
    }
   }
   for (af,kind,protocol) in [(2,1,6),(2,1,0),(23,1,6)] {
    let s=socket(af,kind,protocol);println!("socket af={} kind={} protocol={} valid={} error={}",af,kind,protocol,s!=usize::MAX,WSAGetLastError());if s!=usize::MAX {closesocket(s);}
   }
  }
  return;
 }
 match a.get(1).map(String::as_str){
  Some("read")=>print!("{}",fs::read_to_string(&a[2]).unwrap()),
  _=>panic!("diagnostic mode required")
 }
}
'''
raw=raw[:start]+native+raw[end:]
raw=raw.split("assert subprocess.check_output([str(probe),'read',str(inside)])",1)[0]
raw+='\nsubprocess.run([str(probe),"network","unused"],check=True)\nassert request("setup")["ready"]\ngrant_runtime(home)\nresult=run("network","unused")\nassert result["ok"],result\n'
exec(compile(raw,'socket_diagnostic','exec'),globals())

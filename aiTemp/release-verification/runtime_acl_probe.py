"""Fixture-only additive runtime ACL experiment, never used as release evidence."""
import ctypes as c
from ctypes import wintypes as w
import json, os, subprocess, sys
from pathlib import Path

k=c.WinDLL('kernel32',use_last_error=True);a=c.WinDLL('advapi32',use_last_error=True)
P=c.c_void_p
class LUID(c.Structure):_fields_=[('low',w.DWORD),('high',w.LONG)]
class TP(c.Structure):_fields_=[('count',w.DWORD),('luid',LUID),('attrs',w.DWORD)]
class TRUSTEE(c.Structure):_fields_=[('multiple',P),('operation',c.c_int),('form',c.c_int),('type',c.c_int),('name',P)]
class EA(c.Structure):_fields_=[('access',w.DWORD),('mode',c.c_int),('inheritance',w.DWORD),('trustee',TRUSTEE)]
def bind(lib,name,args,result):
 fn=getattr(lib,name);fn.argtypes=args;fn.restype=result;return fn
bind(k,'GetCurrentProcess',[],w.HANDLE)
bind(k,'CloseHandle',[w.HANDLE],w.BOOL)
bind(k,'LocalFree',[P],P)
bind(k,'CreateFileW',[w.LPCWSTR,w.DWORD,w.DWORD,P,w.DWORD,w.DWORD,w.HANDLE],w.HANDLE)
bind(a,'OpenProcessToken',[w.HANDLE,w.DWORD,c.POINTER(w.HANDLE)],w.BOOL)
bind(a,'LookupPrivilegeValueW',[w.LPCWSTR,w.LPCWSTR,c.POINTER(LUID)],w.BOOL)
bind(a,'AdjustTokenPrivileges',[w.HANDLE,w.BOOL,c.POINTER(TP),w.DWORD,c.POINTER(TP),c.POINTER(w.DWORD)],w.BOOL)
bind(a,'ConvertStringSidToSidW',[w.LPCWSTR,c.POINTER(P)],w.BOOL)
bind(a,'GetSecurityInfo',[w.HANDLE,c.c_int,w.DWORD,P,P,c.POINTER(P),P,c.POINTER(P)],w.DWORD)
bind(a,'SetSecurityInfo',[w.HANDLE,c.c_int,w.DWORD,P,P,P,P],w.DWORD)
bind(a,'SetEntriesInAclW',[w.ULONG,c.POINTER(EA),P,c.POINTER(P)],w.DWORD)
bind(a,'RegOpenKeyExW',[w.HANDLE,w.LPCWSTR,w.DWORD,w.DWORD,c.POINTER(w.HANDLE)],w.LONG)
bind(a,'RegCloseKey',[w.HANDLE],w.LONG)
bind(a,'GetSecurityDescriptorControl',[P,c.POINTER(w.WORD),c.POINTER(w.DWORD)],w.BOOL)

def checked(value,label):
 if not value:raise OSError(c.get_last_error(),label)

def append_read(handle,kind,sid,mask,flags,label):
 old=P();sd=P();new=P()
 code=a.GetSecurityInfo(handle,kind,4,None,None,c.byref(old),None,c.byref(sd));assert code==0,(label,code)
 try:
  control=w.WORD();revision=w.DWORD();checked(a.GetSecurityDescriptorControl(sd,c.byref(control),c.byref(revision)),'SD control')
  print('original ACL',label,'protected=',bool(control.value&0x1000),flush=True)
  ea=EA(mask,1,flags,TRUSTEE(None,0,0,0,sid.value))
  code=a.SetEntriesInAclW(1,c.byref(ea),old,c.byref(new));assert code==0,(label,code)
  code=a.SetSecurityInfo(handle,kind,4,None,None,new,None);assert code==0,(label,code)
  print('read capability granted',label,flush=True)
 finally:
  if new.value:k.LocalFree(new)
  if sd.value:k.LocalFree(sd)

def grant_runtime(home):
 caps=json.loads((home/'cap_sid').read_text())
 runtime=Path(os.environ['SystemRoot'])/'System32'
 key=runtime.resolve().as_posix().lower()
 sid=P();checked(a.ConvertStringSidToSidW(caps['writable_root_by_path'][key],c.byref(sid)),'runtime SID')
 token=w.HANDLE();checked(a.OpenProcessToken(k.GetCurrentProcess(),0x28,c.byref(token)),'open setup token')
 privilege=TP();privilege.count=1
 checked(a.LookupPrivilegeValueW(None,'SeRestorePrivilege',c.byref(privilege.luid)),'restore privilege')
 privilege.attrs=2;previous=TP();length=w.DWORD()
 c.set_last_error(0)
 checked(a.AdjustTokenPrivileges(token,False,c.byref(privilege),c.sizeof(previous),c.byref(previous),c.byref(length)),'enable restore')
 assert c.get_last_error()==0
 try:
  names=['cmd.exe','kernelbase.dll','mswsock.dll','nsi.dll','ws2_32.dll','wshbth.dll','winrnr.dll','NapiNSP.dll','pnrpnsp.dll','wshtcpip.dll']
  files=[runtime/n for n in names if (runtime/n).is_file()]
  files.extend(p/'cmd.exe.mui' for p in runtime.iterdir() if p.is_dir() and not p.is_symlink() and '-' in p.name and (p/'cmd.exe.mui').is_file())
  for path in files:
   handle=k.CreateFileW(str(path),0x60000,7,None,3,0x02000000,None)
   assert handle not in (None,c.c_void_p(-1).value),(str(path),c.get_last_error())
   try:append_read(handle,1,sid,0x1200a9,0,str(path))
   finally:k.CloseHandle(handle)
  for path in [r'SYSTEM\CurrentControlSet\Services\WinSock2\Parameters',r'SYSTEM\CurrentControlSet\Services\WinSock\Parameters']:
   handle=w.HANDLE();code=a.RegOpenKeyExW(w.HANDLE(-2147483646),path,0,0x60000|0x20019,c.byref(handle))
   print('registry open',path,code,flush=True)
   assert code==0
   try:append_read(handle,4,sid,0x20019,2,path)
   finally:a.RegCloseKey(handle)
 finally:
  a.AdjustTokenPrivileges(token,False,c.byref(previous),0,None,None)
  k.CloseHandle(token);k.LocalFree(sid)

# Compile the normal focused probe into an isolated fixture and run every
# original assertion. Modify only setup completion to grant the intended OS
# runtime resources; keep localized output and network negative checks intact.
source=Path('aiTemp/release-verification/sandbox_native.py').read_text(encoding='utf-8')
anchor="assert request('setup').get('ready') is True"
assert source.count(anchor)==1
source=source.replace(anchor,anchor+'\ngrant_runtime(home)')
source=source.replace("Path('aiTemp/evidence/sandbox-proof.json')","Path('aiTemp/evidence/runtime-experiment-proof.json')")
exec(compile(source,'runtime_acl_experiment','exec'),globals())

"""Resolve bounded runtime resources identified by native tracing; retain isolation checks."""
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path('aiTemp/release-verification').resolve()))
from pe_dependencies import runtime_dependencies

def preferred_locales(runtime):
    names={'en-US'}
    for api_name in ('GetSystemPreferredUILanguages','GetUserPreferredUILanguages'):
        fn=bind(k,api_name,[w.DWORD,c.POINTER(w.DWORD),w.LPWSTR,c.POINTER(w.DWORD)],w.BOOL)
        count=w.DWORD();size=w.DWORD()
        checked(fn(8,c.byref(count),None,c.byref(size)),api_name)
        assert 0<size.value<=4096 and count.value<=32
        buffer=c.create_unicode_buffer(size.value)
        checked(fn(8,c.byref(count),buffer,c.byref(size)),api_name)
        for name in buffer[:size.value].split('\0'):
            if name:
                assert len(name)<36 and all(ch.isascii() and (ch.isalnum() or ch=='-') for ch in name)
                names.add(name)
    print('ACTIVE RUNTIME LANGUAGES',sorted(names),flush=True)
    return [runtime/name for name in sorted(names) if (runtime/name).is_dir()]

def grant_provider_keys(home):
    import ctypes as c
    from ctypes import wintypes as w
    import json, os
    caps=json.loads((home/'cap_sid').read_text())
    key=(Path(os.environ['SystemRoot'])/'System32').resolve().as_posix().lower()
    sid=P();checked(a.ConvertStringSidToSidW(caps['writable_root_by_path'][key],c.byref(sid)),'runtime SID')
    paths=[r'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters',r'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Winsock',r'SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters',r'SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Winsock',r'SYSTEM\CurrentControlSet\Services\Winsock\Setup Migration\Providers',r'SYSTEM\CurrentControlSet\Services\vmbus\Parameters\Winsock',r'SYSTEM\CurrentControlSet\Services\Psched\Parameters\Winsock',r'SYSTEM\CurrentControlSet\Services\afunix\Parameters\Winsock',r'SYSTEM\CurrentControlSet\Services\RFCOMM\Parameters\Winsock']
    try:
        for path in paths:
            handle=w.HANDLE();code=a.RegOpenKeyExW(w.HANDLE(-2147483646),path,0,0x60000|0x20019,c.byref(handle))
            if code==2:
                print('optional provider configuration absent',path,flush=True);continue
            assert code==0,(path,code)
            try:append_read(handle,4,sid,0x20019,2 if path.endswith('Setup Migration\\Providers') else 0,path)
            finally:a.RegCloseKey(handle)
    finally:k.LocalFree(sid)

def probe_runtime(request, root, home):
    executable = root / 'runtime-probe.exe'
    subprocess.run(['rustc', '--edition', '2021', 'aiTemp/release-verification/winsock_resource_probe.rs', '-o', str(executable)], check=True)
    grant_provider_keys(home)
    result = request('exec', [str(executable)])
    assert result['ok'], result
    print('NETWORK HELPER RESULT',result['stdout'],flush=True)

path = Path('aiTemp/release-verification/runtime_acl_probe.py')
source = path.read_text(encoding='utf-8')
old = "source=source.replace(anchor,anchor+'\\ngrant_runtime(home)')"
new = "source=source.replace(anchor,anchor+'\\ngrant_runtime(home)\\nprobe_runtime(request,root,home)')"
assert source.count(old) == 1
source=source.replace(old,new)
old="files=[runtime/n for n in names if (runtime/n).is_file()]"
new="files=runtime_dependencies(runtime,names+['dnsapi.dll','bcrypt.dll','sspicli.dll'])\n  print('READ-ONLY OS IMPORT CLOSURE',[p.name for p in files],flush=True)"
assert source.count(old)==1
source=source.replace(old,new)
old="files.extend(p/'cmd.exe.mui' for p in runtime.iterdir() if p.is_dir() and not p.is_symlink() and '-' in p.name and (p/'cmd.exe.mui').is_file())"
new="""locales=preferred_locales(runtime)
  localized=[directory/(file.name+'.mui') for directory in locales for file in files if (directory/(file.name+'.mui')).is_file()]
  assert len(localized)<=1024
  files.extend(localized)"""
assert source.count(old)==1
source=source.replace(old,new)
exec(compile(source,str(path),'exec'),globals())

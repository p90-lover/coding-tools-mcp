"""Resolve bounded OS runtime dependencies; retain all original isolation assertions."""
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path('aiTemp/release-verification').resolve()))
from pe_dependencies import runtime_dependencies

def grant_provider_keys(home):
    import ctypes as c
    from ctypes import wintypes as w
    import json, os
    caps=json.loads((home/'cap_sid').read_text())
    key=(Path(os.environ['SystemRoot'])/'System32').resolve().as_posix().lower()
    sid=P();checked(a.ConvertStringSidToSidW(caps['writable_root_by_path'][key],c.byref(sid)),'runtime SID')
    try:
        for path in [r'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters',r'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Winsock',r'SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters',r'SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Winsock']:
            handle=w.HANDLE();code=a.RegOpenKeyExW(w.HANDLE(-2147483646),path,0,0x60000|0x20019,c.byref(handle))
            if code==2:
                print('optional provider configuration absent',path,flush=True);continue
            assert code==0,(path,code)
            try:append_read(handle,4,sid,0x20019,0,path)
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
new="""locales=[p for p in runtime.iterdir() if p.is_dir() and not p.is_symlink() and '-' in p.name and len(p.name)<36]
  assert len(locales)<=64
  localized=[directory/(file.name+'.mui') for directory in locales for file in files if (directory/(file.name+'.mui')).is_file()]
  assert len(localized)<=1024
  files.extend(localized)"""
assert source.count(old)==1
source=source.replace(old,new)
exec(compile(source,str(path),'exec'),globals())

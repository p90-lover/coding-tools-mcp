"""Extend the isolated runtime experiment; no production gates are weakened."""
from pathlib import Path
import subprocess

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
    print('PROVIDER POSITIVE CONTROL', flush=True)
    subprocess.run([str(executable)], check=True)
    print('TCP HELPER CONFIGURATION READ-ONLY GRANTS',flush=True)
    grant_provider_keys(home)
    result = request('exec', [str(executable)])
    assert result['ok'], result
    print('NETWORK HELPER RESULT',result['stdout'],flush=True)

path = Path('aiTemp/release-verification/runtime_acl_probe.py')
source = path.read_text(encoding='utf-8')
old = "source=source.replace(anchor,anchor+'\\ngrant_runtime(home)')"
new = "source=source.replace(anchor,anchor+'\\ngrant_runtime(home)\\nprobe_runtime(request,root,home)')"
assert source.count(old) == 1
exec(compile(source.replace(old,new),str(path),'exec'),globals())

"""Extend the existing isolated runtime experiment with provider diagnostics."""
from pathlib import Path
import subprocess

def probe_runtime(request, root):
    executable = root / 'runtime-probe.exe'
    subprocess.run(['rustc', '--edition', '2021', 'aiTemp/release-verification/winsock_resource_probe.rs', '-o', str(executable)], check=True)
    print('PROVIDER POSITIVE CONTROL', flush=True)
    subprocess.run([str(executable)], check=True)
    print('SANDBOXED PROVIDERS AFTER NARROW GRANTS', flush=True)
    result = request('exec', [str(executable)])
    assert result['ok'], result

path = Path('aiTemp/release-verification/runtime_acl_probe.py')
source = path.read_text(encoding='utf-8')
old = "source=source.replace(anchor,anchor+'\\ngrant_runtime(home)')"
new = "source=source.replace(anchor,anchor+'\\ngrant_runtime(home)\\nprobe_runtime(request,root)')"
assert source.count(old) == 1
exec(compile(source.replace(old,new),str(path),'exec'),globals())

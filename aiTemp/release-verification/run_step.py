"""Run one explicit, checked build stage from the existing release workflow.

The production source is already materialized. This runner never applies staged
payloads or publishes anything, and preserves each expanded script in aiTemp.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys

names = {
    'frontend': 'Frontend and RAM-only source contract',
    'helpers': 'Build only the native sandbox helpers and verify isolation',
    'policy': 'Focused policy, vision and catalog checks',
    'desktop': 'Real Windows background observation and input fixture',
    'installer': 'Build and inspect exact installer including native resources',
}
key = sys.argv[1]
assert key in names
source = Path('.github/workflows/remembered-control-release.yml').read_text(encoding='utf-8')
marker = '      - name: ' + names[key] + '\n'
assert source.count(marker) == 1
block = source.split(marker, 1)[1].split('\n      - ', 1)[0]
body = block.split('        run: |\n', 1)[1]
lines = body.splitlines()
assert all(not line or line.startswith('          ') for line in lines)
script = '\n'.join(line[10:] if line else '' for line in lines) + '\n'
if key == 'helpers':
    # Keep compilation unchanged; the old .NET-based check is replaced by the
    # separate native probe stage, without disabling PowerShell language policy.
    cut = 'python - "$PWD/src-tauri/aiTemp/native-sandbox/coding-tools-codex-sandbox.exe"'
    assert script.count(cut) == 1
    script = script.split(cut, 1)[0]
path = Path('aiTemp/expanded-build') / (key + '.sh')
path.parent.mkdir(parents=True, exist_ok=True)
with path.open('x', encoding='utf-8', newline='\n') as output:
    output.write(script)
# Windows also supplies System32/bash.exe, which launches WSL rather than Git
# Bash. Resolve the intended tool explicitly; never install a WSL distribution.
if os.name == 'nt':
    bash = Path(os.environ['ProgramFiles']) / 'Git' / 'bin' / 'bash.exe'
    assert bash.is_file(), 'The Git Bash installation is required'
else:
    found = shutil.which('bash')
    assert found, 'bash is required'
    bash = Path(found)
subprocess.run([str(bash), '--noprofile', '--norc', '-n', path.as_posix()], check=True)
subprocess.run([str(bash), '--noprofile', '--norc', path.as_posix()], check=True)

"""Run one explicit, checked build stage from the existing release workflow.

Production source is already materialized. The helper stage applies the reviewed
source-only adapters to a pinned upstream checkout, never launches a Codex agent,
and preserves every expanded build script under aiTemp.
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
    # Replace the old constrained-PowerShell test with the separate native probe.
    # The compiled helper itself retains all OS restrictions.
    cut = 'python - "$PWD/src-tauri/aiTemp/native-sandbox/coding-tools-codex-sandbox.exe"'
    assert script.count(cut) == 1
    script = script.split(cut, 1)[0]
    prepare = 'python native-helpers/prepare_upstream.py "$GITHUB_WORKSPACE/aiTemp/upstream" "$PWD/native-helpers/codex_sandbox_bridge.rs"'
    assert script.count(prepare) == 1
    script = script.replace(prepare, prepare + '\npython native-helpers/prepare_network.py "$GITHUB_WORKSPACE/aiTemp/upstream"')
path = Path('aiTemp/expanded-build') / (key + '.sh')
path.parent.mkdir(parents=True, exist_ok=True)
with path.open('x', encoding='utf-8', newline='\n') as output:
    output.write(script)
# System32/bash.exe launches WSL, not Git Bash. Never install or invoke WSL here.
if os.name == 'nt':
    bash = Path(os.environ['ProgramFiles']) / 'Git' / 'bin' / 'bash.exe'
    assert bash.is_file(), 'The Git Bash installation is required'
else:
    found = shutil.which('bash')
    assert found, 'bash is required'
    bash = Path(found)
subprocess.run([str(bash), '--noprofile', '--norc', '-n', path.as_posix()], check=True)
subprocess.run([str(bash), '--noprofile', '--norc', path.as_posix()], check=True)

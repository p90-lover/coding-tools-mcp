"""Materialize reviewed source; preserve originals, never erase credentials or files."""
from pathlib import Path, PurePosixPath
import base64
import hashlib
import lzma
import os
import re
import shutil
import subprocess

encoded = ''.join(Path(f'aiTemp/release-043/source.patch.xz.b64.part{i}').read_text().strip() for i in (1, 2))
data = lzma.decompress(base64.b64decode(encoded, validate=True))
assert len(data) == 96223
assert hashlib.sha256(data).hexdigest() == '65c3d275f3028b79a0112bd8ff231ac1aac04d61f0c25d433de9b4616433127c'
assert not re.search(rb'^(deleted file mode|rename |copy |old mode|new mode|\+\+\+ /dev/null)', data, re.M)
paths = [p.decode() for p in re.findall(rb'^\+\+\+ b/(.+)$', data, re.M)]
assert len(paths) == len(set(paths)) == 37
for name in paths:
    p = PurePosixPath(name)
    assert not p.is_absolute() and '..' not in p.parts and '\\' not in name
    assert name.startswith(('src/', 'src-tauri/', 'docs/features/', 'docs/releases/', 'aiTemp/release-043/', 'aiTemp/release-verification/')) or name in ('README.md', 'README.en.md', 'package.json', 'package-lock.json')
    assert not Path(name).is_symlink()
Path('aiTemp/evidence').mkdir(parents=True, exist_ok=True)
patch = Path('aiTemp/release-043/materialized-input.patch')
patch.write_bytes(data)
if not Path('src-tauri/src/codex_bridge/native_command.rs').exists():
    subprocess.run(['git', 'apply', '--check', str(patch)], check=True)
    for name in paths:
        p = Path(name)
        if p.exists():
            backup = Path('aiTemp/Trash/before-workflow-sync') / os.environ['GITHUB_RUN_ID'] / name
            backup.parent.mkdir(parents=True, exist_ok=True)
            assert not backup.exists()
            shutil.copy2(p, backup)
    subprocess.run(['git', 'apply', str(patch)], check=True)
for name in paths:
    if name.endswith('.rs'):
        subprocess.run(['rustfmt', '--edition', '2021', '--config', 'skip_children=true', name], check=True)
subprocess.run(['git', 'add', '--', *paths], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
assert not subprocess.check_output(['git', 'diff', '--cached', '--diff-filter=D', '--name-only']).strip()
Path('aiTemp/evidence/preparation.txt').write_text(
    subprocess.check_output(['git', 'diff', '--cached', '--stat'], text=True) + '\nSource payload SHA256: ' + hashlib.sha256(data).hexdigest() + '\n', encoding='utf-8')

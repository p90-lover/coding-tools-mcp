"""Materialize only reviewed additive fixes; never delete files or overwrite concurrent work."""
from pathlib import Path
import ast
import hashlib
import json
import os
import shutil
import subprocess

BASE = '07faa97255e6b60d909f956fa2cebd3b829bbf97'
FILE_SOURCE = 'ad7a74f80bd6b4cc446058b3b3d462b97d08ebe7'
OLD_VERSION = '0.4.3-rc.3'
VERSION = '0.4.3-rc.4'
changed = []
run = os.environ['GITHUB_RUN_ID']
assert run.isdecimal()

def show(ref, path):
    return subprocess.check_output(['git', 'show', ref + ':' + path])

def save(name, data):
    path = Path(name)
    if isinstance(data, str):
        data = data.encode('utf-8')
    assert not path.is_symlink(), name
    if path.exists():
        if path.read_bytes() == data:
            return
        backup = Path('aiTemp/Trash/main-preservation-before') / run / name
        backup.parent.mkdir(parents=True, exist_ok=True)
        assert not backup.exists(), str(backup)
        shutil.copy2(path, backup)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    changed.append(name)

def once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new, 1)

subprocess.run(['git', 'fetch', '--no-tags', 'origin', BASE, FILE_SOURCE], check=True)
marker = 'const MAX_TEXT_READ_INPUT_BYTES: u64 = 16 * 1024 * 1024;'
if marker not in Path('src-tauri/src/tools/file.rs').read_text():
    for name in ['src-tauri/src/tools/file.rs', 'src-tauri/src/tools/patch.rs']:
        assert Path(name).read_bytes() == show(BASE, name), 'Unexpected concurrent source: ' + name
        data = show(FILE_SOURCE, name)
        if name.endswith('/file.rs'):
            text = data.decode('utf-8')
            text = once(text, '    let metadata =\n        fs::metadata(&resolved.path).map_err(|_| WorkspaceError::not_found("File not found"))?;', '    let input = File::open(&resolved.path).map_err(|_| WorkspaceError::not_found("File not found"))?;\n    let metadata = input.metadata().map_err(|_| WorkspaceError::not_found("File not found"))?;')
            old = '    let data = fs::read(&resolved.path).map_err(|_| WorkspaceError::not_found("File not found"))?;'
            new = '''    // Enforce the cap on the actual open handle as well as its initial size.
    // A file growing after metadata inspection must not trigger an unbounded read.
    let mut data = Vec::new();
    input.take(MAX_TEXT_READ_INPUT_BYTES + 1).read_to_end(&mut data)
        .map_err(|_| WorkspaceError::not_found("File could not be read"))?;
    if data.len() as u64 > MAX_TEXT_READ_INPUT_BYTES {
        return Err(WorkspaceError::Tool {
            code: "FILE_TOO_LARGE",
            message: "Text file exceeded the 16 MiB input limit during reading.".into(),
            category: "validation",
            retryable: false,
        });
    }'''
            data = once(text, old, new)
        save(name, data)
else:
    assert 'input.take(MAX_TEXT_READ_INPUT_BYTES + 1)' in Path('src-tauri/src/tools/file.rs').read_text().replace('\n        ', '')
    assert 'ensure_internal_directory' in Path('src-tauri/src/tools/patch.rs').read_text()

save('aiTemp/main-preservation/file_regressions.rs', show(FILE_SOURCE, 'aiTemp/sandbox-audit/file_regressions.rs'))
name = 'src-tauri/src/tools/mod.rs'
text = Path(name).read_text(encoding='utf-8')
if 'mod main_preservation_file_regressions;' not in text:
    save(name, text + '\n#[cfg(test)]\n#[path = "../../../aiTemp/main-preservation/file_regressions.rs"]\nmod main_preservation_file_regressions;\n')

for name in ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'README.md', 'README.en.md']:
    text = Path(name).read_text(encoding='utf-8')
    assert OLD_VERSION in text or VERSION in text, name
    save(name, text.replace(OLD_VERSION, VERSION))

# Existing publisher re-downloads and hashes assets before a non-forced main update.
name = 'aiTemp/oauth-popup/publish.py'
text = Path(name).read_text(encoding='utf-8')
text = text.replace('verified rc.3 bytes', 'verified rc.4 bytes').replace('fix/oauth-popup-0.4.3-rc.3', 'fix/main-preservation-0.4.3-rc.4').replace(OLD_VERSION, VERSION)
text = text.replace('OAuth popup and callback repair', 'Preserved features, OAuth and file-safety repair')
if "proof['file_safety_regressions_passed']" not in text:
    text = once(text, "assert not proof['codex_executable_invoked'] and proof['model_requests']==0", "assert not proof['codex_executable_invoked'] and proof['model_requests']==0\nassert proof['file_safety_regressions_passed']==3\nassert '3 passed; 0 failed' in (root/'windows/file-safety.txt').read_text()")
    text = once(text, "assert [(c['case'],c['callback_reached'])", "assert browser['external_network_blocked'] and browser['screenshots_written']==0\nassert [(c['case'],c['callback_reached'])")
save(name, text)

name = 'aiTemp/oauth-popup/package.py'
text = Path(name).read_text(encoding='utf-8')
if "'file_safety_regressions_passed':3" not in text:
    text = once(text, "proof.update({'scope':", "assert '3 passed; 0 failed' in (root/'file-safety.txt').read_text(encoding='utf-8')\nproof.update({'file_safety_regressions_passed':3,'read_file_input_cap_bytes':16777216,'scope':")
save(name, text)

for name in ['src-tauri/src/tools/file.rs', 'src-tauri/src/tools/patch.rs', 'aiTemp/main-preservation/file_regressions.rs']:
    subprocess.run(['rustfmt', '--edition', '2021', '--config', 'skip_children=true', name], check=True)
    if name not in changed:
        changed.append(name)
for name in ['aiTemp/oauth-popup/package.py', 'aiTemp/oauth-popup/publish.py', 'aiTemp/oauth-popup/browser_test.py']:
    ast.parse(Path(name).read_text(encoding='utf-8'))
subprocess.run(['git', 'add', '--', *changed], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
assert not subprocess.check_output(['git', 'diff', '--cached', '--diff-filter=D', '--name-only']).strip()
Path('aiTemp/evidence').mkdir(parents=True, exist_ok=True)
Path('aiTemp/evidence/preparation.txt').write_text(subprocess.check_output(['git', 'diff', '--cached', '--stat'], text=True), encoding='utf-8')
print('Prepared additive rc.4 source; existing features, files, releases and credentials preserved.')

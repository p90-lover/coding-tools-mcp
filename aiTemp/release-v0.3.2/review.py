"""Apply finalization, then explicit compilation-review corrections."""
from pathlib import Path
import runpy
import shutil
import time

root = Path.cwd().resolve()
runpy.run_path(str(root / 'aiTemp/release-v0.3.2/finalize.py'), run_name='__main__')
backup_root = root / 'aiTemp/Trash/compilation-review' / str(time.time_ns())

def replace_file(relative, replacements):
    path = root / relative
    path.resolve(strict=True).relative_to(root)
    if path.is_symlink():
        raise RuntimeError(f'refusing source symlink: {relative}')
    source = path.read_text(encoding='utf-8')
    for old, new, count in replacements:
        if source.count(old) != count:
            raise RuntimeError(f'expected {count} reviewed anchors: {old}')
        source = source.replace(old, new)
    backup = backup_root / relative
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)
    path.write_text(source, encoding='utf-8')
    print('reviewed', relative)

replace_file('src-tauri/src/auth/oauth_flow.rs', [
    ('hex::encode(Sha256::digest(oauth.profile_id.as_bytes()))', 'format!("{:x}", Sha256::digest(oauth.profile_id.as_bytes()))', 1),
    ('hex::encode(hash.finalize())', 'format!("{:x}", hash.finalize())', 1),
])
replace_file('src-tauri/src/auth/http_security.rs', [
    ('Result<OwnedSemaphorePermit, Response>', 'Result<OwnedSemaphorePermit, Box<Response>>', 1),
    ('.map_err(|_| secure_response((StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response()))', '.map_err(|_| Box::new(secure_response((StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response())))', 1),
])
for relative in ['src-tauri/src/mcp/listener.rs', 'src-tauri/src/actions/listener.rs']:
    replace_file(relative, [('Ok(permit) => permit, Err(response) => return response,', 'Ok(permit) => permit, Err(response) => return *response,', 1)])
replace_file('src-tauri/tauri.conf.json', [('connect-src ipc:', "connect-src 'self' ipc:", 2)])
print('Applied compilation and desktop CSP compatibility corrections without disabling checks.')

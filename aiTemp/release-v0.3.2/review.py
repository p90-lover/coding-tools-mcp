"""Apply finalization, then explicit compilation-review corrections."""
from pathlib import Path
import runpy
import shutil
import time

root = Path.cwd().resolve()
runpy.run_path(str(root / 'aiTemp/release-v0.3.2/finalize.py'), run_name='__main__')
path = root / 'src-tauri/src/auth/oauth_flow.rs'
source = path.read_text(encoding='utf-8')
replacements = {
    'hex::encode(Sha256::digest(oauth.profile_id.as_bytes()))': 'format!("{:x}", Sha256::digest(oauth.profile_id.as_bytes()))',
    'hex::encode(hash.finalize())': 'format!("{:x}", hash.finalize())',
}
for old, new in replacements.items():
    if source.count(old) != 1:
        raise RuntimeError(f'expected exactly one reviewed formatting anchor: {old}')
    source = source.replace(old, new, 1)
backup = root / 'aiTemp/Trash/compilation-review' / str(time.time_ns()) / path.relative_to(root)
backup.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(path, backup)
path.write_text(source, encoding='utf-8')
print('Applied SHA256 formatting correction without adding dependencies.')

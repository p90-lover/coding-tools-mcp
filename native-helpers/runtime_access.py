"""Provision fixed OS runtime read capabilities during explicit elevated setup only."""
from pathlib import Path
import shutil, sys
crate=Path(sys.argv[1]).resolve()
source=Path(__file__).with_suffix('.rs')
target=crate/'src/bin/setup_main/win/runtime_access.rs'
assert not target.exists()
shutil.copy2(source,target)
path=crate/'src/bin/setup_main/win.rs'
text=path.read_text(encoding='utf-8')
anchor='mod firewall;\n'
assert text.count(anchor)==1
text=text.replace(anchor,anchor+'mod runtime_access;\n')
anchor='    let users = vec![\n        payload.offline_username.clone(),\n        payload.online_username.clone(),\n    ];'
assert text.count(anchor)==1
text=text.replace(anchor,'    runtime_access::provision(&payload.codex_home, &payload.command_cwd)?;\n'+anchor)
backup=crate.parents[1]/'aiTemp/Trash/runtime-access-originals/src/bin/setup_main/win.rs'
backup.parent.mkdir(parents=True,exist_ok=True)
assert not backup.exists();shutil.copy2(path,backup)
path.write_text(text,encoding='utf-8')
print('Added fixed Windows runtime read grants to explicit elevated provisioning')

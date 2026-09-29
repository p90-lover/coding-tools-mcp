"""Repair only the reproduced invalid optional Paseo enum, preserving the old file."""
from pathlib import Path
import os,shutil,subprocess
path=Path('src-tauri/src/integrations/execution/protocol.rs')
text=path.read_text(encoding='utf-8');old=',"activeTurnBehavior":"reject"'
assert text.count(old)==1,'Expected the exact rejected protocol value'
backup=Path('aiTemp/Trash/paseo-wire-before')/os.environ['GITHUB_RUN_ID']/path
backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists() and not path.is_symlink()
shutil.copy2(path,backup);path.write_text(text.replace(old,'',1),encoding='utf-8')
subprocess.run(['git','add','--',str(path)],check=True)
print('PASEO_WIRE_REPAIR: omitted unsupported optional enum; no interrupt or steer behavior invented')

"""Wire the bounded catalog repair. Retain originals and never widen saved profiles."""
from pathlib import Path
import os,re,shutil,subprocess
patch=Path('aiTemp/tool-exposure/existing-files.patch')
text=patch.read_text(encoding='utf-8')
expected={'README.en.md','README.md','package-lock.json','package.json','src-tauri/Cargo.lock','src-tauri/Cargo.toml','src-tauri/src/commands/mod.rs','src-tauri/src/lib.rs','src-tauri/src/tools/dispatch.rs','src-tauri/src/tools/mod.rs','src-tauri/tauri.conf.json','src/lib/components/ChatGptSetup.svelte','src/lib/components/RuntimePolicyForm.svelte'}
paths=re.findall(r'^\+\+\+ b/(.+)$',text,re.M)
assert len(paths)==len(expected) and set(paths)==expected
assert not re.search(r'^(deleted file mode|rename |copy |old mode|new mode|\+\+\+ /dev/null)',text,re.M)
if 'commands::get_tool_catalog_status,' not in Path('src-tauri/src/lib.rs').read_text():
    subprocess.run(['git','apply','--check',str(patch)],check=True)
    for name in paths:
        path=Path(name);assert path.is_file() and not path.is_symlink()
        backup=Path('aiTemp/Trash/catalog-before')/os.environ['GITHUB_RUN_ID']/path
        backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists();shutil.copy2(path,backup)
    subprocess.run(['git','apply',str(patch)],check=True)
for name in ['src-tauri/src/tools/catalog.rs','src-tauri/src/commands/tool_catalog.rs']:
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*paths,'src-tauri/src/tools/catalog.rs','src-tauri/src/commands/tool_catalog.rs'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
Path('aiTemp/evidence/preparation.txt').write_text(subprocess.check_output(['git','diff','--cached','--stat'],text=True),encoding='utf-8')

"""Canonicalize the nearest existing ancestor, not a nonexistent target.
Preserve the exact protected-path, read-only, containment and symlink checks.
"""
from pathlib import Path
import os,shutil,subprocess
path=Path('src-tauri/src/tools/workspace.rs')
text=path.read_text(encoding='utf-8')
marker='// Keep new linked targets in the same canonical spelling as their root.'
if marker not in text:
    old='''        Ok(ResolvedPath {
            display: self.display_path(&candidate),
            path: candidate,
            existed: false,
        })'''
    new='''        // Keep new linked targets in the same canonical spelling as their root.
        // On Windows linked mappings intentionally show D:\\... while canonical
        // storage roots use the verbatim prefix. Existing targets were already
        // canonicalized above; new targets need their existing ancestor resolved.
        let candidate = Self::normalize_path_from_existing_ancestor(&candidate);
        self.ensure_inside_workspace(&candidate, &candidate)?;
        Ok(ResolvedPath {
            display: self.display_path(&candidate),
            path: candidate,
            existed: false,
        })'''
    assert text.count(old)==1,text.count(old)
    backup=Path('aiTemp/Trash/linked-write-before')/os.environ['GITHUB_RUN_ID']/path
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path,backup)
    path.write_text(text.replace(old,new,1),encoding='utf-8')
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',str(path)],check=True)
    subprocess.run(['git','add','--',str(path)],check=True)
    subprocess.run(['git','diff','--cached','--check'],check=True)
print('LINKED_WRITE_PATCH: new target canonical spelling repaired; root boundary and staging checks unchanged')

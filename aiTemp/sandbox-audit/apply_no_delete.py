"""Replace permanent deletion in shipping Rust source with recoverable moves.
All replaced files are copied under aiTemp/Trash before this script edits them.
"""
from pathlib import Path
import os, shutil, subprocess


def preserve(path: Path):
    target=Path('aiTemp/Trash/no-delete-before')/os.environ['GITHUB_RUN_ID']/path
    target.parent.mkdir(parents=True,exist_ok=True);assert not target.exists();shutil.copy2(path,target)

def once(text,old,new):
    assert text.count(old)==1,(old[:100],text.count(old));return text.replace(old,new,1)

# Shared app-config retirement helper.
path=Path('src-tauri/src/platform/trash.rs')
assert not path.exists()
path.write_text(r'''use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Move an application-managed file or directory into the persistent app Trash.
/// Refuses paths outside the app config root and never falls back to deletion.
pub fn move_to_app_trash(path: &Path, category: &str) -> AppResult<Option<PathBuf>> {
    if !path.exists() && !path.is_symlink() {
        return Ok(None);
    }
    if category.is_empty()
        || !category
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(AppError::Message("Invalid Trash category".into()));
    }
    let app_root = super::platform().app_config_dir()?;
    std::fs::create_dir_all(&app_root)?;
    let canonical_root = app_root.canonicalize()?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Message("Managed path has no parent".into()))?;
    let canonical_parent = parent.canonicalize()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(AppError::Message(
            "Refusing to retire a path outside the application config directory".into(),
        ));
    }
    let trash = app_root.join("Trash").join(category);
    std::fs::create_dir_all(&trash)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let target = trash.join(format!("{}-{}-{name}", unix_millis(), uuid::Uuid::new_v4()));
    std::fs::rename(path, &target)?;
    Ok(Some(target))
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
''',encoding='utf-8')

path=Path('src-tauri/src/platform/mod.rs');preserve(path);s=path.read_text(encoding='utf-8')
s=once(s,'mod paths;\n','mod paths;\nmod trash;\n')
s=once(s,'pub use open::{is_allowed_url, open_path_in_file_manager, open_url};\n','pub use open::{is_allowed_url, open_path_in_file_manager, open_url};\npub use trash::move_to_app_trash;\n')
path.write_text(s,encoding='utf-8')

path=Path('src-tauri/src/tunnel/software.rs');preserve(path);s=path.read_text(encoding='utf-8')
s=once(s,'use crate::platform::platform;\n','use crate::platform::{move_to_app_trash, platform};\n')
s=once(s,'        std::fs::remove_file(&path)?;\n','        move_to_app_trash(&path, "software")?;\n')
s=once(s,'            let _ = std::fs::remove_dir_all(&downloads);\n','            if downloads.exists() {\n                move_to_app_trash(&downloads, "software-downloads")?;\n            }\n')
path.write_text(s,encoding='utf-8')

path=Path('src-tauri/src/tunnel/frp/client.rs');preserve(path);s=path.read_text(encoding='utf-8')
s=once(s,'use crate::platform::platform;\n','use crate::platform::{move_to_app_trash, platform};\n')
s=once(s,'    _file: std::fs::File,\n','    file: Option<std::fs::File>,\n')
s=once(s,'impl Drop for FrpcOperationLock {\n    fn drop(&mut self) {\n        let _ = std::fs::remove_file(&self.path);\n    }\n}\n','impl Drop for FrpcOperationLock {\n    fn drop(&mut self) {\n        // Windows cannot rename the lock while our own handle is open.\n        drop(self.file.take());\n        let _ = move_to_app_trash(&self.path, "frpc-locks");\n    }\n}\n')
s=once(s,'                return Ok(FrpcOperationLock { path, _file: file });\n','                return Ok(FrpcOperationLock { path, file: Some(file) });\n')
s=once(s,'                    let _ = std::fs::remove_file(&path);\n                    continue;\n','                    move_to_app_trash(&path, "frpc-locks")?;\n                    continue;\n')
s=once(s,'        let _ = std::fs::remove_file(path);\n','        let _ = move_to_app_trash(&path, "frpc-pids");\n')
path.write_text(s,encoding='utf-8')

# History writes use project aiTemp, and failed temp bytes are retained in project Trash.
path=Path('src-tauri/src/tools/history/storage.rs');preserve(path);s=path.read_text(encoding='utf-8')
s=once(s,'pub fn write_markdown(path: &Path, content: &str) -> WorkspaceResult<()> {\n    atomic_write(path, content.as_bytes())\n}\n','pub fn write_markdown(workspace_root: &Path, path: &Path, content: &str) -> WorkspaceResult<()> {\n    atomic_write(workspace_root, path, content.as_bytes())\n}\n')
s=once(s,'pub fn write_index(history_dir: &Path, index: &HistoryIndex) -> WorkspaceResult<()> {\n    write_json(&history_dir.join("index.json"), index, "history index")\n}\n','pub fn write_index(workspace_root: &Path, history_dir: &Path, index: &HistoryIndex) -> WorkspaceResult<()> {\n    write_json(workspace_root, &history_dir.join("index.json"), index, "history index")\n}\n')
s=once(s,'pub fn write_manifest(history_dir: &Path, manifest: &MemoryManifest) -> WorkspaceResult<()> {\n    write_json(\n        &memory_dir(history_dir).join("manifest.json"),\n','pub fn write_manifest(workspace_root: &Path, history_dir: &Path, manifest: &MemoryManifest) -> WorkspaceResult<()> {\n    write_json(\n        workspace_root,\n        &memory_dir(history_dir).join("manifest.json"),\n')
s=once(s,'pub fn write_state(history_dir: &Path, state: &MemoryState) -> WorkspaceResult<()> {\n    write_json(\n        &memory_dir(history_dir).join("state.json"),\n','pub fn write_state(workspace_root: &Path, history_dir: &Path, state: &MemoryState) -> WorkspaceResult<()> {\n    write_json(\n        workspace_root,\n        &memory_dir(history_dir).join("state.json"),\n')
s=once(s,'fn write_json<T: serde::Serialize>(path: &Path, value: &T, label: &str) -> WorkspaceResult<()> {\n','fn write_json<T: serde::Serialize>(workspace_root: &Path, path: &Path, value: &T, label: &str) -> WorkspaceResult<()> {\n')
s=once(s,'    atomic_write(path, &content)\n}\n\nfn atomic_write(target: &Path, content: &[u8]) -> WorkspaceResult<()> {\n','    atomic_write(workspace_root, path, &content)\n}\n\nfn atomic_write(workspace_root: &Path, target: &Path, content: &[u8]) -> WorkspaceResult<()> {\n')
s=once(s,'    ensure_directory(parent)?;\n    let temp = parent.join(format!(".history-tmp-{}", uuid::Uuid::new_v4()));\n','    ensure_directory(parent)?;\n    let temp_dir = workspace_root.join("aiTemp").join("history-write");\n    ensure_directory(&temp_dir)?;\n    let temp = temp_dir.join(format!("history-{}.tmp", uuid::Uuid::new_v4()));\n')
s=once(s,'    if result.is_err() {\n        let _ = fs::remove_file(&temp);\n    }\n','    if result.is_err() && temp.exists() {\n        let failed_dir = workspace_root.join("Trash").join("history-write-failed");\n        if ensure_directory(&failed_dir).is_ok() {\n            let target = failed_dir.join(format!("history-{}.tmp", uuid::Uuid::new_v4()));\n            let _ = fs::rename(&temp, target);\n        }\n    }\n')
path.write_text(s,encoding='utf-8')

# Propagate workspace root to the bounded history writers.
path=Path('src-tauri/src/tools/history/mod.rs');preserve(path);s=path.read_text(encoding='utf-8')
s=s.replace('storage::write_markdown(\n                        &history_dir.join', 'storage::write_markdown(\n                        ctx.workspace.root(),\n                        &history_dir.join')
s=s.replace('storage::write_markdown(&history_dir.join', 'storage::write_markdown(ctx.workspace.root(), &history_dir.join')
s=s.replace('storage::write_markdown(\n            &history_dir.join', 'storage::write_markdown(\n            ctx.workspace.root(),\n            &history_dir.join')
s=s.replace('storage::write_index(&history_dir,', 'storage::write_index(ctx.workspace.root(), &history_dir,')
s=s.replace('storage::write_manifest(&history_dir,', 'storage::write_manifest(ctx.workspace.root(), &history_dir,')
s=s.replace('storage::write_state(&history_dir,', 'storage::write_state(ctx.workspace.root(), &history_dir,')
# Exact count protects against silently missing a future call site in this source revision.
assert 'storage::write_markdown(&history_dir' not in s
assert 'storage::write_index(&history_dir' not in s
assert 'storage::write_manifest(&history_dir' not in s
assert 'storage::write_state(&history_dir' not in s
path.write_text(s,encoding='utf-8')

files=['src-tauri/src/platform/trash.rs','src-tauri/src/platform/mod.rs','src-tauri/src/tunnel/software.rs','src-tauri/src/tunnel/frp/client.rs','src-tauri/src/tools/history/storage.rs','src-tauri/src/tools/history/mod.rs']
subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',*files],check=True)
subprocess.run(['git','add','--',*files],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()

"""Apply only the three file-safety fixes proven red by the persisted audit tests.
Replaced source is copied into aiTemp/Trash first; nothing is deleted.
"""
from pathlib import Path
import os, shutil, subprocess


def preserve(path: Path):
    target = Path('aiTemp/Trash/file-safety-before') / os.environ['GITHUB_RUN_ID'] / path
    target.parent.mkdir(parents=True, exist_ok=True)
    assert not target.exists()
    shutil.copy2(path, target)


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, (old[:120], text.count(old))
    return text.replace(old, new, 1)

# 1. Reject oversized text inputs before allocation/UTF-8 decoding.
path = Path('src-tauri/src/tools/file.rs')
preserve(path)
s = path.read_text(encoding='utf-8')
s = replace_once(
    s,
    'const DEFAULT_SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;\nconst BINARY_PEEK_BYTES: usize = 8192;\n',
    'const DEFAULT_SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;\n'
    '/// Hard input cap for the text reader. `max_bytes` remains the response cap.\n'
    'const MAX_TEXT_READ_INPUT_BYTES: u64 = 16 * 1024 * 1024;\n'
    'const BINARY_PEEK_BYTES: usize = 8192;\n',
)
s = replace_once(
    s,
    '''    if resolved.path.is_dir() {\n        return Err(WorkspaceError::Tool {\n            code: "IS_DIRECTORY",\n            message: "Path is a directory.".into(),\n            category: "validation",\n            retryable: false,\n        });\n    }\n    let max_bytes = args\n''',
    '''    if resolved.path.is_dir() {\n        return Err(WorkspaceError::Tool {\n            code: "IS_DIRECTORY",\n            message: "Path is a directory.".into(),\n            category: "validation",\n            retryable: false,\n        });\n    }\n    let metadata = fs::metadata(&resolved.path)\n        .map_err(|_| WorkspaceError::not_found("File not found"))?;\n    if metadata.len() > MAX_TEXT_READ_INPUT_BYTES {\n        return Err(WorkspaceError::Tool {\n            code: "FILE_TOO_LARGE",\n            message: format!(\n                "Text file is {} bytes; the read_file input limit is {} bytes. Use search_text or a bounded external reader instead.",\n                metadata.len(), MAX_TEXT_READ_INPUT_BYTES\n            ),\n            category: "validation",\n            retryable: false,\n        });\n    }\n    let max_bytes = args\n''',
)
path.write_text(s, encoding='utf-8')

# 2/3. Internal staging/Trash paths must never traverse symlinks/reparse points;
#      an Add/Update must never replace an existing directory with a file.
path = Path('src-tauri/src/tools/patch.rs')
preserve(path)
s = path.read_text(encoding='utf-8')
insert = r'''
fn ensure_internal_directory(
    storage_root: &std::path::Path,
    directory: &std::path::Path,
) -> std::io::Result<()> {
    use std::io::ErrorKind;
    let canonical_root = storage_root.canonicalize()?;
    let relative = directory.strip_prefix(storage_root).map_err(|_| {
        std::io::Error::new(ErrorKind::PermissionDenied, "internal directory escaped storage root")
    })?;
    let mut current = storage_root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(std::io::Error::new(
                        ErrorKind::PermissionDenied,
                        "internal directory contains a symbolic link/reparse file or non-directory",
                    ));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                std::fs::create_dir(&current)?;
            }
            Err(error) => return Err(error),
        }
        let canonical = current.canonicalize()?;
        if !canonical.starts_with(&canonical_root) {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "internal directory resolves outside the approved storage root",
            ));
        }
    }
    Ok(())
}

'''
s = replace_once(s, 'fn move_to_trash(\n', insert + 'fn move_to_trash(\n')
s = replace_once(
    s,
    '    std::fs::create_dir_all(parent)?;\n    std::fs::rename(target, &destination)?;\n',
    '    ensure_internal_directory(storage_root, parent)?;\n    std::fs::rename(target, &destination)?;\n',
)
s = replace_once(
    s,
    '''        let path = resolved.path.clone();\n        backups.insert(\n''',
    '''        let path = resolved.path.clone();\n        if content.is_some() {\n            if let Ok(metadata) = fs::symlink_metadata(&path) {\n                if metadata.file_type().is_symlink() || !metadata.is_file() {\n                    return Err(patch_failed(format!(\n                        "Refusing to replace a non-regular file or directory: {}", resolved.display\n                    )));\n                }\n            }\n        }\n        backups.insert(\n''',
)
s = replace_once(
    s,
    '''            if let Some(parent) = path.parent() {\n                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;\n            }\n            let storage_root = approved_storage_root(ws, &resolved.display, &path)?;\n''',
    '''            let storage_root = approved_storage_root(ws, &resolved.display, &path)?;\n            if let Some(parent) = path.parent() {\n                // User targets have already passed workspace path validation; creating\n                // ordinary target parents remains allowed. Internal control paths below\n                // get the stricter canonical ancestry check.\n                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;\n            }\n''',
)
s = replace_once(
    s,
    '''            if let Some(parent) = temp.parent() {\n                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;\n            }\n            staging_roots.insert(staging_root.clone(), storage_root.clone());\n''',
    '''            if let Some(parent) = temp.parent() {\n                ensure_internal_directory(&storage_root, parent)\n                    .map_err(|err| patch_failed(format!("Unsafe staging directory: {err}")))?;\n            }\n            staging_roots.insert(staging_root.clone(), storage_root.clone());\n''',
)
path.write_text(s, encoding='utf-8')

subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',
                'src-tauri/src/tools/file.rs','src-tauri/src/tools/patch.rs'], check=True)
subprocess.run(['git','add','--','src-tauri/src/tools/file.rs','src-tauri/src/tools/patch.rs'], check=True)
subprocess.run(['git','diff','--cached','--check'], check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()

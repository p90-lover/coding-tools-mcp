from __future__ import annotations

import shutil
import time
from pathlib import Path

ROOT = Path.cwd()
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "secure-auto-approval-persistent-auth"
    / "generated-source-hygiene"
    / str(time.time_ns())
)


def backup(path: str) -> None:
    source = ROOT / path
    if not source.exists():
        return
    target = BACKUP_ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def replace_once(path: str, before: str, after: str, label: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {label}")
        return
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    backup(path)
    target.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


def remove_once(path: str, block: str, remaining_marker: str, label: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if block not in text:
        if remaining_marker in text:
            raise RuntimeError(f"{label}: source changed and requires explicit review")
        print(f"already applied: {label}")
        return
    if text.count(block) != 1:
        raise RuntimeError(f"{label}: expected one source match")
    backup(path)
    target.write_text(text.replace(block, "", 1), encoding="utf-8")
    print(f"applied: {label}")


def verify() -> None:
    migration = (ROOT / "src-tauri/src/data/migrate.rs").read_text(encoding="utf-8")
    refresh_tokens = (ROOT / "src-tauri/src/auth/refresh_tokens.rs").read_text(
        encoding="utf-8"
    )
    forbidden = (
        'let mut first = AppData::default();\n        first.last_workspace_id = "first".into();',
        'let mut expected = AppData::default();\n        expected.last_workspace_id = "recover-me".into();',
    )
    if any(pattern in migration for pattern in forbidden):
        raise RuntimeError("generated migration tests still violate Clippy defaults")
    if "pub fn revoke_all(" in refresh_tokens:
        raise RuntimeError("unused refresh-token revocation API is still present")


replace_once(
    "src-tauri/src/data/migrate.rs",
    '''        let mut first = AppData::default();
        first.last_workspace_id = "first".into();
''',
    '''        let first = AppData {
            last_workspace_id: "first".into(),
            ..AppData::default()
        };
''',
    "construct first migration fixture without field reassignment",
)

replace_once(
    "src-tauri/src/data/migrate.rs",
    '''        let mut expected = AppData::default();
        expected.last_workspace_id = "recover-me".into();
''',
    '''        let expected = AppData {
            last_workspace_id: "recover-me".into(),
            ..AppData::default()
        };
''',
    "construct recovery fixture without field reassignment",
)

remove_once(
    "src-tauri/src/auth/refresh_tokens.rs",
    '''    pub fn revoke_all(&self) -> AppResult<()> {
        DataStore::update_file(|data| {
            data.oauth_refresh_tokens.remove(&self.profile_id);
            Ok(())
        })
    }

''',
    "pub fn revoke_all(",
    "remove unused refresh-token revocation API",
)

verify()
print("generated secure source hygiene applied successfully")

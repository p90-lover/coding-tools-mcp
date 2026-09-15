"""Prevent isolated CoreState fixtures from ever persisting through DataStore.

Every replaced source is retained under Trash/ and staged with the repair.
"""
from pathlib import Path
import os
import shutil
import subprocess

ROOT = Path.cwd()
BACKUP = ROOT / "Trash" / "rust-core-in-memory" / os.environ.get("GITHUB_RUN_ID", "local")
changed: list[Path] = []
backups: list[Path] = []


def save(path_text: str, text: str) -> None:
    path = ROOT / path_text
    current = path.read_text(encoding="utf-8")
    if current == text:
        return
    if path not in changed:
        backup = BACKUP / path_text
        backup.parent.mkdir(parents=True, exist_ok=True)
        if backup.exists():
            raise RuntimeError(f"refusing to overwrite retained original: {backup}")
        if path.is_symlink():
            raise RuntimeError(f"refusing to rewrite symlink: {path}")
        shutil.copy2(path, backup)
        changed.append(path)
        backups.append(backup)
    path.write_text(text, encoding="utf-8")


def replace_once(path_text: str, old: str, new: str) -> None:
    path = ROOT / path_text
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path_text}, found {count}: {old!r}")
    save(path_text, text.replace(old, new, 1))


store = "src-tauri/src/data/store.rs"
replace_once(
    store,
    """pub struct DataStore {\n    data: AppData,\n    baseline: serde_json::Value,\n}\n""",
    """pub struct DataStore {\n    data: AppData,\n    baseline: serde_json::Value,\n    persistent: bool,\n}\n""",
)
replace_once(
    store,
    """        let store = Self { data, baseline };\n""",
    """        let store = Self {\n            data,\n            baseline,\n            persistent: true,\n        };\n""",
)
replace_once(
    store,
    """        Ok(Self { data, baseline })\n""",
    """        Ok(Self {\n            data,\n            baseline,\n            persistent: false,\n        })\n""",
)
replace_once(
    store,
    """    pub fn data(&self) -> &AppData {\n        &self.data\n    }\n\n    pub fn refresh(&mut self) -> AppResult<()> {\n""",
    """    pub fn data(&self) -> &AppData {\n        &self.data\n    }\n\n    /// True only for a store loaded from the configured application-data file.\n    pub fn is_persistent(&self) -> bool {\n        self.persistent\n    }\n\n    pub fn refresh(&mut self) -> AppResult<()> {\n        if !self.persistent {\n            self.baseline = serde_json::to_value(&self.data)?;\n            return Ok(());\n        }\n""",
)
replace_once(
    store,
    """    pub fn save(&mut self) -> AppResult<()> {\n        let _guard = lock_data_file()?;\n""",
    """    pub fn save(&mut self) -> AppResult<()> {\n        if !self.persistent {\n            self.baseline = serde_json::to_value(&self.data)?;\n            return Ok(());\n        }\n        let _guard = lock_data_file()?;\n""",
)

core = "rust-core/coding-tools-core/src/lib.rs"
replace_once(
    core,
    """        let mut guard = self\n            .data\n            .lock()\n            .map_err(|_| AppError::Message(\"data store poisoned\".into()))?;\n        f(&mut guard)\n""",
    """        let mut guard = self\n            .data\n            .lock()\n            .map_err(|_| AppError::Message(\"data store poisoned\".into()))?;\n        guard.refresh()?;\n        f(&mut guard)\n""",
)

workflow = ".github/workflows/rust-core-cross-platform.yml"
replace_once(
    workflow,
    """    paths: [.github/workflows/rust-core-cross-platform.yml]\n""",
    """    paths:\n      - .github/workflows/rust-core-cross-platform.yml\n      - rust-core/coding-tools-core/**\n      - src-tauri/src/lib.rs\n      - src-tauri/src/data/store.rs\n""",
)

for path in changed:
    if path.suffix == ".rs":
        subprocess.run(
            ["rustfmt", "--edition", "2021", "--config", "skip_children=true", str(path)],
            check=True,
        )

subprocess.run(
    ["git", "add", "--", *(str(path) for path in changed), *(str(path) for path in backups)],
    check=True,
)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
removed = subprocess.check_output(
    ["git", "diff", "--cached", "--diff-filter=D", "--name-only"], text=True
).strip()
if removed:
    raise RuntimeError(f"deletions are forbidden: {removed}")

print(
    "IN_MEMORY_STORE_ISOLATED: fixture saves and refreshes remain in RAM; "
    "persistent desktop stores keep the existing disk/merge behavior; originals retained"
)

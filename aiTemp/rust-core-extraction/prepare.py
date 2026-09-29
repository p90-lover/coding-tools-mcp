"""Expose the tested v0.4.10 core contract while preserving every original.

This is the first dependency-inversion stage. It adds no listener, window,
provider, model, tunnel, permission, or release behavior.
"""
from pathlib import Path
import os
import shutil
import subprocess

ROOT = Path.cwd()
BACKUP = ROOT / "Trash" / "rust-core-extraction" / os.environ.get("GITHUB_RUN_ID", "local")
changed: list[Path] = []


def save(path_text: str, text: str) -> None:
    path = ROOT / path_text
    current = path.read_text(encoding="utf-8")
    if current == text:
        return
    backup = BACKUP / path_text
    if path not in changed:
        backup.parent.mkdir(parents=True, exist_ok=True)
        if backup.exists():
            raise RuntimeError(f"refusing to overwrite retained original: {backup}")
        if path.is_symlink():
            raise RuntimeError(f"refusing to rewrite symlink: {path}")
        shutil.copy2(path, backup)
        changed.append(path)
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


for module in ("data", "error", "runtime"):
    replace_once("src-tauri/src/lib.rs", f"mod {module};", f"pub mod {module};")

replace_once(
    "src-tauri/src/data/store.rs",
    """    pub fn read_file<R>(f: impl FnOnce(&AppData) -> AppResult<R>) -> AppResult<R> {\n""",
    """    /// Construct an isolated store for tests and migration probes.\n    ///\n    /// This constructor performs no disk IO and never synchronizes trusted\n    /// origins. Persisting it still requires an explicit ordinary store path.\n    pub fn from_data(data: AppData) -> AppResult<Self> {\n        let baseline = serde_json::to_value(&data)?;\n        Ok(Self { data, baseline })\n    }\n\n    pub fn read_file<R>(f: impl FnOnce(&AppData) -> AppResult<R>) -> AppResult<R> {\n""",
)

for path in changed:
    if path.suffix == ".rs":
        subprocess.run(
            ["rustfmt", "--edition", "2021", "--config", "skip_children=true", str(path)],
            check=True,
        )

if changed:
    subprocess.run(["git", "add", "--", *(str(path) for path in changed)], check=True)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
removed = subprocess.check_output(
    ["git", "diff", "--cached", "--diff-filter=D", "--name-only"], text=True
).strip()
if removed:
    raise RuntimeError(f"deletions are forbidden: {removed}")

print(
    "RUST_CORE_PREPARED: public compatibility modules and in-memory DataStore constructor staged; "
    "Tauri/runtime behavior unchanged; originals retained under Trash/"
)

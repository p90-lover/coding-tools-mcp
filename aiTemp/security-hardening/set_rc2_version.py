from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
VERSION = "0.3.0-rc2"
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "security-hardening"
    / "rc2-version"
    / str(time.time_ns())
)


def checked_file(path: str) -> Path:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe release-version path: {path}")
    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {path}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"release-version path is missing or escapes the repository: {path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"release-version path is not a regular file: {path}")
    return resolved


def backup(path: str) -> None:
    source = checked_file(path)
    target = BACKUP_ROOT / Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def write_json(path: str, transform) -> None:
    target = checked_file(path)
    data = json.loads(target.read_text(encoding="utf-8"))
    updated = transform(data)
    rendered = json.dumps(updated, indent=2, ensure_ascii=False) + "\n"
    if target.read_text(encoding="utf-8") == rendered:
        print(f"already synchronized: {path}")
        return
    backup(path)
    target.write_text(rendered, encoding="utf-8")
    print(f"synchronized: {path}")


def replace_exact(path: str, pattern: str, replacement: str, label: str) -> None:
    target = checked_file(path)
    text = target.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        if replacement in text:
            print(f"already synchronized: {label}")
            return
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    if updated == text:
        print(f"already synchronized: {label}")
        return
    backup(path)
    target.write_text(updated, encoding="utf-8")
    print(f"synchronized: {label}")


def update_package(data: dict) -> dict:
    data["version"] = VERSION
    return data


def update_package_lock(data: dict) -> dict:
    data["version"] = VERSION
    packages = data.setdefault("packages", {})
    root = packages.setdefault("", {})
    root["version"] = VERSION
    return data


def update_tauri(data: dict) -> dict:
    data["version"] = VERSION
    return data


write_json("package.json", update_package)
write_json("package-lock.json", update_package_lock)
write_json("src-tauri/tauri.conf.json", update_tauri)
replace_exact(
    "src-tauri/Cargo.toml",
    r'(?ms)(\[package\]\s+name\s*=\s*"coding-tools-mcp-desktop"\s+version\s*=\s*)"[^"]+"',
    rf'\1"{VERSION}"',
    "Cargo package version",
)
replace_exact(
    "src-tauri/Cargo.lock",
    r'(?ms)(\[\[package\]\]\s+name\s*=\s*"coding-tools-mcp-desktop"\s+version\s*=\s*)"[^"]+"',
    rf'\1"{VERSION}"',
    "Cargo lock package version",
)

app_version = ROOT / "src/lib/app-version.ts"
if app_version.exists():
    replace_exact(
        "src/lib/app-version.ts",
        r'(?m)(APP_VERSION\s*=\s*)["\'][^"\']+["\']',
        rf'\1"{VERSION}"',
        "frontend application version",
    )


def verify() -> None:
    package = json.loads(checked_file("package.json").read_text(encoding="utf-8"))
    package_lock = json.loads(checked_file("package-lock.json").read_text(encoding="utf-8"))
    tauri = json.loads(checked_file("src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    observed = {
        "package.json": package.get("version"),
        "package-lock.json": package_lock.get("version"),
        "package-lock root": package_lock.get("packages", {}).get("", {}).get("version"),
        "tauri.conf.json": tauri.get("version"),
    }
    mismatches = {name: value for name, value in observed.items() if value != VERSION}
    expected = f'name = "coding-tools-mcp-desktop"\nversion = "{VERSION}"'
    for cargo_path in ("src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
        if expected not in checked_file(cargo_path).read_text(encoding="utf-8"):
            mismatches[cargo_path] = "mismatch"
    if app_version.exists() and VERSION not in checked_file("src/lib/app-version.ts").read_text(encoding="utf-8"):
        mismatches["src/lib/app-version.ts"] = "mismatch"
    if mismatches:
        raise RuntimeError(f"release version synchronization failed: {mismatches}")


verify()
print(f"release version synchronized to {VERSION}")

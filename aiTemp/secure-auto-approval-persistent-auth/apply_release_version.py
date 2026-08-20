from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path.cwd()
VERSION_FILE = ROOT / "aiTemp/secure-auto-approval-persistent-auth/release_version.txt"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")


def load_version() -> str:
    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not SEMVER.fullmatch(version):
        raise RuntimeError(f"invalid release version: {version!r}")
    return version


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def update_package_json(version: str) -> None:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    write_json(path, data)


def update_package_lock(version: str) -> None:
    path = ROOT / "package-lock.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    packages = data.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        packages[""]["version"] = version
    write_json(path, data)


def replace_exactly_once(path: Path, pattern: str, replacement: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    path.write_text(updated, encoding="utf-8")


def update_cargo_toml(version: str) -> None:
    replace_exactly_once(
        ROOT / "src-tauri/Cargo.toml",
        r'(?m)^(name\s*=\s*"coding-tools-mcp-desktop"\s*\nversion\s*=\s*)"[^"]+"',
        rf'\1"{version}"',
        "Cargo.toml package version",
    )


def update_cargo_lock(version: str) -> None:
    replace_exactly_once(
        ROOT / "src-tauri/Cargo.lock",
        r'(?m)^(name\s*=\s*"coding-tools-mcp-desktop"\s*\nversion\s*=\s*)"[^"]+"',
        rf'\1"{version}"',
        "Cargo.lock package version",
    )


def update_tauri_config(version: str) -> None:
    path = ROOT / "src-tauri/tauri.conf.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    write_json(path, data)


def verify(version: str) -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    tauri = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    cargo_toml = (ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
    cargo_lock = (ROOT / "src-tauri/Cargo.lock").read_text(encoding="utf-8")

    observed = {
        "package.json": package.get("version"),
        "package-lock.json": package_lock.get("version"),
        "package-lock root": package_lock.get("packages", {}).get("", {}).get("version"),
        "tauri.conf.json": tauri.get("version"),
    }
    mismatches = {name: value for name, value in observed.items() if value != version}
    if mismatches:
        raise RuntimeError(f"version mismatch: {mismatches}")

    expected = f'name = "coding-tools-mcp-desktop"\nversion = "{version}"'
    if expected not in cargo_toml:
        raise RuntimeError("Cargo.toml version verification failed")
    if expected not in cargo_lock:
        raise RuntimeError("Cargo.lock version verification failed")


def main() -> None:
    version = load_version()
    update_package_json(version)
    update_package_lock(version)
    update_cargo_toml(version)
    update_cargo_lock(version)
    update_tauri_config(version)
    verify(version)
    print(f"release version synchronized: {version}")


if __name__ == "__main__":
    main()

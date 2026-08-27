from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import time
from pathlib import Path

SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
VERSION_FILE = "aiTemp/secure-auto-approval-persistent-auth/release_version.txt"
VERSIONED_PATHS = (
    "package.json",
    "package-lock.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
)
VERSIONED_CARGO = (
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
)


class ReleaseVersionSynchronizer:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise RuntimeError(f"repository root is not a directory: {self.root}")
        run_id = str(time.time_ns())
        self.backup_root_relative = (
            Path("aiTemp")
            / "Trash"
            / "secure-auto-approval-persistent-auth"
            / "release-version"
            / run_id
        )
        self.staging_root_relative = Path("aiTemp") / "release-version-staging" / run_id
        self._backed_up: set[str] = set()

    @staticmethod
    def checked_relative(relative_path: str | Path) -> Path:
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"unsafe release-version path: {relative_path}")
        if not relative.parts:
            raise RuntimeError("release-version path cannot be empty")
        return relative

    def reject_symlink_components(self, relative: Path) -> None:
        current = self.root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise RuntimeError(f"refusing symlink path component: {relative}")

    def ensure_directory(self, relative_path: str | Path) -> Path:
        relative = self.checked_relative(relative_path)
        current = self.root
        for part in relative.parts:
            current /= part
            if current.exists():
                if current.is_symlink():
                    raise RuntimeError(f"refusing symlink directory component: {relative}")
                if not current.is_dir():
                    raise RuntimeError(f"release-version directory component is not a directory: {current}")
            else:
                current.mkdir()
            try:
                current.resolve(strict=True).relative_to(self.root)
            except ValueError as error:
                raise RuntimeError(f"release-version directory escapes repository: {relative}") from error
        return current

    def checked_file(self, relative_path: str) -> Path:
        relative = self.checked_relative(relative_path)
        self.reject_symlink_components(relative)
        candidate = self.root / relative
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(self.root)
        except (FileNotFoundError, ValueError) as error:
            raise RuntimeError(
                f"release-version path is missing or escapes the repository: {relative_path}"
            ) from error
        if not resolved.is_file():
            raise RuntimeError(f"release-version path is not a regular file: {relative_path}")
        return resolved

    def read_text(self, relative_path: str) -> str:
        return self.checked_file(relative_path).read_text(encoding="utf-8")

    def load_version(self) -> str:
        version = self.read_text(VERSION_FILE).strip()
        if not SEMVER.fullmatch(version):
            raise RuntimeError(f"invalid release version: {version!r}")
        return version

    @staticmethod
    def json_text(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, indent=2) + "\n"

    def plan_updates(self, version: str) -> dict[str, str]:
        package = json.loads(self.read_text("package.json"))
        if not isinstance(package, dict):
            raise RuntimeError("package.json root must be an object")
        package["version"] = version

        package_lock = json.loads(self.read_text("package-lock.json"))
        if not isinstance(package_lock, dict):
            raise RuntimeError("package-lock.json root must be an object")
        packages = package_lock.get("packages")
        if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
            raise RuntimeError("package-lock.json is missing the root package entry")
        package_lock["version"] = version
        packages[""]["version"] = version

        tauri = json.loads(self.read_text("src-tauri/tauri.conf.json"))
        if not isinstance(tauri, dict):
            raise RuntimeError("tauri.conf.json root must be an object")
        tauri["version"] = version

        updates = {
            "package.json": self.json_text(package),
            "package-lock.json": self.json_text(package_lock),
            "src-tauri/tauri.conf.json": self.json_text(tauri),
        }
        pattern = re.compile(
            r'(?m)^(name\s*=\s*"coding-tools-mcp-desktop"\s*\nversion\s*=\s*)"[^"]+"'
        )
        for relative_path in VERSIONED_CARGO:
            text = self.read_text(relative_path)
            matches = pattern.findall(text)
            if len(matches) != 1:
                raise RuntimeError(
                    f"{relative_path} package version: expected exactly one match, "
                    f"found {len(matches)}"
                )
            updates[relative_path] = pattern.sub(rf'\1"{version}"', text, count=1)

        self.verify_contents(version, updates)
        return updates

    @staticmethod
    def verify_contents(version: str, contents: dict[str, str]) -> None:
        package = json.loads(contents["package.json"])
        package_lock = json.loads(contents["package-lock.json"])
        tauri = json.loads(contents["src-tauri/tauri.conf.json"])
        observed = {
            "package.json": package.get("version"),
            "package-lock.json": package_lock.get("version"),
            "package-lock root": package_lock.get("packages", {}).get("", {}).get("version"),
            "tauri.conf.json": tauri.get("version"),
        }
        mismatches = {name: value for name, value in observed.items() if value != version}
        expected = f'name = "coding-tools-mcp-desktop"\nversion = "{version}"'
        for path in VERSIONED_CARGO:
            if expected not in contents[path]:
                mismatches[path] = "mismatch"
        if mismatches:
            raise RuntimeError(f"version mismatch: {mismatches}")

    def verify(self, version: str) -> None:
        self.verify_contents(version, {path: self.read_text(path) for path in VERSIONED_PATHS})

    def backup(self, relative_path: str) -> Path:
        relative = self.checked_relative(relative_path)
        if relative_path in self._backed_up:
            return self.backup_root_path(relative)
        source = self.checked_file(relative_path)
        target_parent = self.ensure_directory(self.backup_root_relative / relative.parent)
        target = target_parent / relative.name
        if target.exists() or target.is_symlink():
            raise RuntimeError(f"refusing to overwrite release-version backup: {target}")
        shutil.copy2(source, target)
        self._backed_up.add(relative_path)
        return target

    def backup_root_path(self, relative: Path) -> Path:
        return self.root / self.backup_root_relative / relative

    def stage_text(self, relative_path: str, content: str, *, rollback: bool = False) -> Path:
        relative = self.checked_relative(relative_path)
        prefix = self.staging_root_relative / ("rollback" if rollback else "updates")
        staged_parent = self.ensure_directory(prefix / relative.parent)
        staged = staged_parent / relative.name
        if staged.exists() or staged.is_symlink():
            raise RuntimeError(f"refusing to overwrite staged release-version file: {staged}")
        with staged.open("x", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        return staged

    def commit_updates(self, updates: dict[str, str]) -> None:
        changed = {
            path: content
            for path, content in updates.items()
            if self.read_text(path) != content
        }
        if not changed:
            return

        backups = {path: self.backup(path) for path in changed}
        staged = {path: self.stage_text(path, content) for path, content in changed.items()}
        replaced: list[str] = []
        try:
            for path, staged_path in staged.items():
                target = self.checked_file(path)
                os.replace(staged_path, target)
                replaced.append(path)
        except Exception:
            rollback_errors: list[str] = []
            for path in reversed(replaced):
                try:
                    rollback_text = backups[path].read_text(encoding="utf-8")
                    rollback_stage = self.stage_text(path, rollback_text, rollback=True)
                    os.replace(rollback_stage, self.checked_file(path))
                except Exception as rollback_error:  # pragma: no cover - emergency path
                    rollback_errors.append(f"{path}: {rollback_error}")
            if rollback_errors:
                raise RuntimeError(
                    "release-version update failed and rollback was incomplete: "
                    + "; ".join(rollback_errors)
                )
            raise

    def synchronize(self) -> str:
        version = self.load_version()
        updates = self.plan_updates(version)
        self.commit_updates(updates)
        self.verify(version)
        return version

    def check(self) -> str:
        version = self.load_version()
        self.verify(version)
        return version


def synchronize(root: Path) -> str:
    return ReleaseVersionSynchronizer(root).synchronize()


def check(root: Path) -> str:
    return ReleaseVersionSynchronizer(root).check()


def main() -> None:
    parser = argparse.ArgumentParser(description="Synchronize the desktop release version safely")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify synchronized versions without modifying files",
    )
    args = parser.parse_args()
    synchronizer = ReleaseVersionSynchronizer(Path.cwd())
    version = synchronizer.check() if args.check else synchronizer.synchronize()
    action = "verified" if args.check else "synchronized"
    print(f"release version {action}: {version}")


if __name__ == "__main__":
    main()

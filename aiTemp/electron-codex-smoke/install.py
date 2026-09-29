"""Install one pinned official Codex test binary under aiTemp.

This is a verification-only fixture. It never authenticates, invokes an OpenAI
model, or writes outside aiTemp. The subagent smoke directs it to a local scripted
Responses server.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile
import urllib.request

TAG = "rust-v0.154.0"
ASSET = "codex-x86_64-unknown-linux-musl.tar.gz"
SHA256 = "d7e18b2597ae8f242f5f31ee9e90deef48dbc9edd634d9868fb6435d08c07f02"
URL = f"https://github.com/openai/codex/releases/download/{TAG}/{ASSET}"

root = Path.cwd().resolve()
install_root = root / "aiTemp" / "codex-smoke" / TAG
archive = install_root / ASSET
extract_root = install_root / "extracted"
install_root.mkdir(parents=True, exist_ok=True)
extract_root.mkdir(parents=True, exist_ok=True)


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


if not archive.exists():
    temporary = install_root / f"{ASSET}.partial-{os.getpid()}"
    if temporary.exists():
        raise RuntimeError(f"Refusing to overwrite retained partial download: {temporary}")
    request = urllib.request.Request(URL, headers={"User-Agent": "coding-tools-mcp-verification"})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if digest(temporary) != SHA256:
        raise RuntimeError("Downloaded Codex archive failed its pinned SHA-256 check")
    temporary.rename(archive)

if digest(archive) != SHA256:
    raise RuntimeError("Retained Codex archive no longer matches the pinned SHA-256")

with tarfile.open(archive, "r:gz") as bundle:
    files = []
    for member in bundle.getmembers():
        name = PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts:
            raise RuntimeError(f"Unsafe path in Codex archive: {member.name}")
        if member.issym() or member.islnk() or member.isdev():
            raise RuntimeError(f"Unsupported linked/device member in Codex archive: {member.name}")
        if member.isfile():
            files.append(member)
    candidates = [member for member in files if Path(member.name).name.startswith("codex")]
    if len(candidates) != 1:
        raise RuntimeError(f"Expected exactly one Codex executable, found {len(candidates)}")
    member = candidates[0]
    destination = extract_root / Path(member.name).name
    source = bundle.extractfile(member)
    if source is None:
        raise RuntimeError("Codex executable member could not be read")
    if destination.exists():
        retained = digest(destination)
        extracted = hashlib.sha256(source.read()).hexdigest()
        if retained != extracted:
            raise RuntimeError(f"Refusing to replace a different retained Codex binary: {destination}")
    else:
        with destination.open("xb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
    destination.chmod(destination.stat().st_mode | stat.S_IXUSR)

print(destination.resolve())
print(f"PINNED_CODEX_SMOKE {TAG} {SHA256}", file=sys.stderr)

from __future__ import annotations

import base64
import hashlib
import io
import tarfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD_ROOT = ROOT / "aiTemp" / "provider-console-saas"
PARTS = [PAYLOAD_ROOT / f"payload.part{index:02d}" for index in range(5)]
EXPECTED_ARCHIVE_SHA256 = "3de956852d75375ae89dcca213510a190d50dcb97bb98381da932f99195bf313"
EXPECTED_FILES = {
    "src/features/ProviderHubSaasSurface.tsx": (
        ROOT / "desktop-electron" / "src" / "features" / "ProviderHubSaasSurface.tsx",
        "ccb5728bfe34968bab811f73ef1a4d9acb291fc635a8d0b3503fbf87fa5b8f38",
    ),
    "src/features/provider-hub-saas.css": (
        ROOT / "desktop-electron" / "src" / "features" / "provider-hub-saas.css",
        "5ee479a03765b6e5f38a96ec73cd7c70fe713c95544d83d5c491d7abf57554a9",
    ),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


for part in PARTS:
    if not part.is_file():
        raise SystemExit(f"Missing provider console payload part: {part.relative_to(ROOT)}")

encoded = "".join(part.read_text(encoding="utf-8").strip() for part in PARTS)
try:
    archive = base64.b64decode(encoded, validate=True)
except ValueError as error:
    raise SystemExit(f"Provider console payload is not valid base64: {error}") from error

actual_archive_sha = sha256(archive)
if actual_archive_sha != EXPECTED_ARCHIVE_SHA256:
    raise SystemExit(
        "Provider console archive checksum mismatch: "
        f"expected {EXPECTED_ARCHIVE_SHA256}, got {actual_archive_sha}"
    )

materialized: dict[str, bytes] = {}
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
    for member in bundle.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe provider console archive path: {member.name}")
        if member.isdir():
            continue
        if not member.isfile() or member.name not in EXPECTED_FILES:
            raise SystemExit(f"Unexpected provider console archive member: {member.name}")
        extracted = bundle.extractfile(member)
        if extracted is None:
            raise SystemExit(f"Unable to read provider console archive member: {member.name}")
        materialized[member.name] = extracted.read()

if set(materialized) != set(EXPECTED_FILES):
    missing = sorted(set(EXPECTED_FILES) - set(materialized))
    raise SystemExit(f"Provider console archive is incomplete: {missing}")

for archive_path, (target, expected_sha) in EXPECTED_FILES.items():
    content = materialized[archive_path]
    actual_sha = sha256(content)
    if actual_sha != expected_sha:
        raise SystemExit(
            f"Provider console source checksum mismatch for {archive_path}: "
            f"expected {expected_sha}, got {actual_sha}"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)

app_path = ROOT / "desktop-electron" / "src" / "App.tsx"
old_import = 'import { ProviderCenterSurface } from "./features/ProviderHubSurface";'
new_import = 'import { ProviderCenterSurface } from "./features/ProviderHubSaasSurface";'
app_text = app_path.read_text(encoding="utf-8")
if new_import in app_text:
    pass
elif old_import in app_text:
    app_path.write_text(app_text.replace(old_import, new_import, 1), encoding="utf-8")
else:
    raise SystemExit("Provider Center import anchor was not found")

print("PROVIDER_CONSOLE_SAAS_APPLIED")
print(f"archive_sha256={actual_archive_sha}")
for archive_path, (_, expected_sha) in EXPECTED_FILES.items():
    print(f"source_sha256 {archive_path} {expected_sha}")

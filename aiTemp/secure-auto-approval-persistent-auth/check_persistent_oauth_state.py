from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path.cwd().resolve()
REVIEWED_REFRESH_TOKEN_BLOB_SHA1 = "ed106509aced5697ba78ffc72686eedfa2c5c6eb"
REFRESH_TOKEN_PATH = "src-tauri/src/auth/refresh_tokens.rs"
REFRESH_TOKEN_MARKERS = ("pub struct RefreshTokenStore", "pub fn rotate(")


def checked_bytes(path: str, *, allow_missing: bool = False) -> bytes | None:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe OAuth state path: {path}")

    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to inspect a symlink: {path}")
    if not candidate.exists():
        if allow_missing:
            return None
        raise RuntimeError(f"OAuth state path is missing: {path}")

    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except ValueError as error:
        raise RuntimeError(f"OAuth state path escapes the repository: {path}") from error

    if not resolved.is_file():
        raise RuntimeError(f"OAuth state path is not a regular file: {path}")
    return resolved.read_bytes()


def checked_text(path: str, *, allow_missing: bool = False) -> str | None:
    payload = checked_bytes(path, allow_missing=allow_missing)
    if payload is None:
        return None
    return payload.decode("utf-8")


def git_blob_sha1(payload: bytes) -> str:
    header = f"blob {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload, usedforsecurity=False).hexdigest()


checks: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("src-tauri/src/auth/mod.rs", ("mod refresh_tokens;",)),
    (
        "src-tauri/src/auth/oauth.rs",
        ('"grant_types_supported": ["authorization_code", "refresh_token"]',),
    ),
    (
        "src-tauri/src/auth/oauth_flow.rs",
        (
            "use super::refresh_tokens::RefreshTokenStore;",
            '"refresh_token" => exchange_refresh_token',
            "access_token_remains_valid_when_public_tunnel_url_changes",
        ),
    ),
    (
        "src-tauri/src/mcp/listener.rs",
        ('format!("{}:mcp", workspace_id)',),
    ),
    (
        "src-tauri/src/actions/listener.rs",
        ('format!("{workspace_id}:actions")',),
    ),
    (
        "src-tauri/src/secret/keyring_store.rs",
        (
            "pub fn get_or_regenerate(",
            "missing_workspace_secret_is_regenerated_and_persisted",
        ),
    ),
)

present = 0
expected = sum(len(markers) for _, markers in checks) + len(REFRESH_TOKEN_MARKERS) + 1
missing: list[str] = []

for path, markers in checks:
    try:
        text = checked_text(path)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
    assert text is not None
    for marker in markers:
        if marker in text:
            present += 1
        else:
            missing.append(f"{path}: {marker}")

try:
    refresh_payload = checked_bytes(REFRESH_TOKEN_PATH, allow_missing=True)
except RuntimeError as error:
    print(str(error), file=sys.stderr)
    raise SystemExit(1) from error

refresh_present = 0
refresh_exact = False
if refresh_payload is None:
    missing.extend(f"{REFRESH_TOKEN_PATH}: {marker}" for marker in REFRESH_TOKEN_MARKERS)
else:
    try:
        refresh_text = refresh_payload.decode("utf-8")
    except UnicodeDecodeError as error:
        print(f"OAuth seed is not UTF-8: {REFRESH_TOKEN_PATH}", file=sys.stderr)
        raise SystemExit(1) from error
    refresh_exact = git_blob_sha1(refresh_payload) == REVIEWED_REFRESH_TOKEN_BLOB_SHA1
    for marker in REFRESH_TOKEN_MARKERS:
        if marker in refresh_text:
            refresh_present += 1
            present += 1
        else:
            missing.append(f"{REFRESH_TOKEN_PATH}: {marker}")

try:
    supervisor = checked_text("src-tauri/src/runtime/supervisor.rs")
except RuntimeError as error:
    print(str(error), file=sys.stderr)
    raise SystemExit(1) from error
assert supervisor is not None
regeneration_calls = supervisor.count("SecretStore::get_or_regenerate(")
if regeneration_calls >= 5:
    present += 1
else:
    missing.append(
        "src-tauri/src/runtime/supervisor.rs: at least five OAuth secret regeneration calls"
    )

if present == expected:
    print("persistent OAuth source is fully materialized; safe to skip generator")
    raise SystemExit(0)

if present == 0:
    print("persistent OAuth source is not materialized; generator is required")
    raise SystemExit(10)

non_seed_present = present - refresh_present
if (
    non_seed_present == 0
    and regeneration_calls == 0
    and refresh_present == len(REFRESH_TOKEN_MARKERS)
    and refresh_exact
):
    print(
        "exact reviewed refresh-token seed is present and all other OAuth markers are absent; "
        "generator is required"
    )
    raise SystemExit(10)

if refresh_payload is not None and not refresh_exact and non_seed_present == 0:
    missing.append(
        f"{REFRESH_TOKEN_PATH}: exact reviewed blob {REVIEWED_REFRESH_TOKEN_BLOB_SHA1}"
    )

print("refusing to reapply persistent OAuth over a partial or drifted source state", file=sys.stderr)
for item in missing:
    print(f"missing: {item}", file=sys.stderr)
raise SystemExit(1)

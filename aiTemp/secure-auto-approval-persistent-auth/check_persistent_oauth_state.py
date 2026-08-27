from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path.cwd().resolve()


def checked_text(path: str) -> str:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe OAuth state path: {path}")

    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to inspect a symlink: {path}")

    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"OAuth state path is missing or escapes the repository: {path}") from error

    if not resolved.is_file():
        raise RuntimeError(f"OAuth state path is not a regular file: {path}")
    return resolved.read_text(encoding="utf-8")


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
        "src-tauri/src/auth/refresh_tokens.rs",
        ("pub struct RefreshTokenStore", "pub fn rotate("),
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
expected = sum(len(markers) for _, markers in checks) + 1
missing: list[str] = []

for path, markers in checks:
    try:
        text = checked_text(path)
    except RuntimeError:
        missing.extend(f"{path}: {marker}" for marker in markers)
        continue
    for marker in markers:
        if marker in text:
            present += 1
        else:
            missing.append(f"{path}: {marker}")

try:
    supervisor = checked_text("src-tauri/src/runtime/supervisor.rs")
except RuntimeError:
    supervisor = ""
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

print("refusing to reapply persistent OAuth over a partial or drifted source state", file=sys.stderr)
for item in missing:
    print(f"missing: {item}", file=sys.stderr)
raise SystemExit(1)

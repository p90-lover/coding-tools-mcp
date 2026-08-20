# Secure Auto-Approval and Persistent OAuth Design

## Goal

Make normal workspace-scoped MCP development operations run with Codex-like low-friction approval behavior, while preserving hard security boundaries for destructive, network-sensitive, elevated, protected-repository, and outside-workspace activity. Keep ChatGPT OAuth connected across application restarts and public tunnel changes by adding refresh-token rotation, stable workspace token identity, durable secret recovery, and atomic application-data persistence.

## Scope

This design applies to the Rust/Tauri desktop implementation on branch `integration/xyTom-v0.3.0` and its Svelte UI. The pinned Python `old/` snapshot remains read-only reference material. No file is deleted; replaced or diagnostic artifacts remain under `aiTemp/Trash/`.

## Approval architecture

The existing `permission_mode` remains the server-side execution capability boundary (`safe`, `trusted`, `dangerous`). A new `approval_mode` controls how often a caller must obtain a scoped approval:

- `ask`: every mutating command or patch requires a scoped approval grant.
- `auto-workspace` (default): routine commands and transactional patches confined to an approved writable workspace root run automatically; sensitive operations require a scoped grant.
- `never`: routine workspace work runs, but any operation classified as requiring approval is rejected instead of prompting.

The existing `request_permissions` MCP tool becomes a real approval endpoint. A sensitive attempt returns `APPROVAL_REQUIRED` with a short-lived `request_id`, risk classification, human-readable summary, and arguments fingerprint. `request_permissions` accepts the request and returns a one-time or session grant token. Replayed, expired, mismatched, or cross-tool grants are rejected. Grants live only in memory and never weaken hard policy checks.

Operations requiring approval include destructive command patterns, network-looking commands, interpreter-driven file mutation, and explicit elevation attempts (`sudo`, `doas`, `pkexec`, `runas`, or PowerShell `-Verb RunAs`). Protected `.git`/`.github` destruction, host filesystem scope, read-only linked-project execution, path escape, and unapproved outside-root writes remain hard denials even in dangerous mode.

MCP tool annotations are corrected so routine `exec_command` and transactional `apply_patch` are no longer globally advertised as destructive/open-world. `request_permissions` remains destructive/open-world, so ChatGPT can reserve its approval card for the operations that actually need it. This reduces prompts but does not attempt to bypass ChatGPT account-level app permission settings.

## OAuth architecture

OAuth access tokens remain signed JWTs, but their issuer and audience become stable workspace identifiers rather than the current tunnel URL. The public metadata URL may change without invalidating existing tokens.

The authorization-code exchange returns:

- a 30-day access token;
- a rotating 180-day refresh token;
- `scope=mcp` and `token_type=Bearer`.

Only SHA-256 hashes of refresh tokens are persisted. Refresh-token exchange atomically consumes the old token, writes a replacement hash, and returns a new access/refresh pair. Replay of a rotated token returns `invalid_grant`. Per-workspace refresh tokens are revoked when the workspace is removed or its OAuth token secret is regenerated.

Missing OAuth signing secrets and authorization passwords are generated and persisted before the listener starts; the server never silently signs with an empty key.

## Durable storage and recovery

`profiles.json` is parsed strictly. A malformed existing file is preserved under the application data `Trash/` directory and recovery attempts the newest valid backup. If no valid backup exists, startup returns a visible error instead of silently replacing all profiles and secrets with defaults.

Writes use a same-directory temporary file, flush it, preserve a timestamped last-known-good backup, and replace the destination. Windows uses `ReplaceFileW`; Unix uses atomic rename. Temporary files are placed beneath an `aiTemp/` directory inside the application data root.

## Security hardening

The implementation also adds:

- redirect URI binding to the exact URI captured with each authorization code;
- strict client ID validation (empty configured IDs are rejected);
- no-store, frame-deny, nosniff, and restrictive CSP headers on OAuth pages and token responses;
- refresh-token request body and lifetime bounds;
- constant-time token hash comparison where applicable;
- structured authentication status diagnostics without exposing secrets;
- secret-pattern and dependency checks in CI;
- a repository security report documenting validated findings, fixes, and residual risks.

## UI

Workspace policy settings gain an `Approval mode` selector with Codex-like labels and explanations. The authentication panel gains a persistence status summary showing stable-token identity, refresh-token support, access-token lifetime, and whether the current public URL can change without forcing reauthorization.

## Testing

Required verification before merge:

- focused approval classifier and grant replay/expiry tests;
- protected-path, outside-root, read-only, network, destructive, and elevation tests;
- authorization-code plus refresh-token rotation/replay tests;
- token survival across listener restart and tunnel URL change;
- missing-secret repair and corrupt-data recovery tests;
- Rust formatting, full tests, and Clippy on Linux, Windows, and macOS;
- Svelte checks, production build, and Node tests;
- Windows NSIS build with the `.exe` uploaded to a GitHub Release.

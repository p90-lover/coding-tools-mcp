# Post-RC1 security and heavy-usage hardening plan

## Goal

Harden the dependent post-release branch without changing the already validated RC1 tree. Prevent fail-open OAuth identity handling, unsafe redirect schemes, unbounded authorization state, browser-wide CORS exposure, unbounded synchronous request execution, and irreversible patch deletion.

## Safety invariants

- Never delete repository files or branches.
- Back up every modified existing file under `aiTemp/Trash/security-hardening/<run-id>/` before replacement.
- Reject absolute paths, `..` traversal, symlinks, repository escapes, partial patch state, and unexpected source shapes.
- Stop whenever Git reports a deleted file.
- Keep the release branch and RC1 tag immutable.
- Run source code only in jobs with read-only credentials; grant write permission only to the final verified-source commit step.

## Implementation sequence

1. Add failing focused tests for OAuth client identity, redirect URI safety, pending-code capacity, and recoverable Trash moves.
2. Make empty configured OAuth client IDs fail closed while deriving stable non-empty IDs at the supervisor boundary for existing profiles.
3. Permit redirect URIs only when they are bounded, have no user information, and use HTTPS or loopback HTTP.
4. Bound pending authorization codes per workspace and return an overload response rather than growing memory indefinitely.
5. Remove permissive CORS from MCP and Actions listeners, add an 8 MiB body limit, and bound authenticated work to 16 concurrent requests with a short queue timeout.
6. Move patch-deleted regular files into `<workspace>/aiTemp/Trash/apply-patch/<operation>/...` using same-filesystem rename; reject symlinks and non-regular files.
7. Run focused security tests, complete locked Rust tests, strict Clippy, frontend checks/build, and Node tests.
8. Commit only after the entire matrix is green; then open a draft dependent PR without merging it into RC1.

## Verification evidence

- Empty configured client ID does not authorize arbitrary clients.
- Stable generated MCP and Actions client IDs are deterministic and non-empty.
- `javascript:`, `file:`, user-info URLs, fragments, and non-loopback HTTP redirect URIs are rejected.
- Pending OAuth code storage cannot exceed the configured cap.
- No `CorsLayer::permissive()` remains in public listeners.
- Oversized request bodies are rejected before tool execution.
- Authenticated tool work is bounded by a semaphore and Actions work runs outside the async reactor.
- A normal patch deletion removes the original path but preserves the exact bytes under `aiTemp/Trash`.
- Protected `.git` deletion remains always rejected; protected root files still require explicit confirmation.
- `git diff --name-status` contains no `D` entries.

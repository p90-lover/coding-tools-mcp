# Post-RC1 hardening amendment: secure connection compatibility

This amendment replaces the earlier proposal to synthesize an OAuth client ID only inside the runtime.

A runtime-only fallback would not be visible in the desktop configuration UI and could break existing zero-configuration ChatGPT connector setups. The implemented policy therefore keeps two explicit modes:

- When an OAuth client ID is configured, it must match exactly using constant-time comparison.
- When it is intentionally blank, the listener operates as a dynamic public-client endpoint. The presented client ID must be non-empty, ASCII, bounded to 256 bytes, and free of whitespace, markup delimiters, and form separators.

Both modes still require all authorization controls: a non-empty persisted password, PKCE S256, a one-use authorization code bound to the exact client ID and redirect URI, bounded HTTPS or loopback-HTTP redirect URIs, workspace-bound access-token issuer/audience claims, rotating persisted refresh tokens, and replay rejection.

The deletion design is also tightened beyond the original plan:

- normal file and directory removal is converted to an atomic same-filesystem move under `aiTemp/Trash/apply-patch/`;
- `.git` internals are rejected again inside the Trash layer, independently of tool policy;
- the workspace root, `aiTemp` as a parent of the recovery destination, and recovery Trash itself cannot be moved;
- existing symlink components in the recovery destination are rejected and the created destination is canonicalized back under the workspace before rename;
- no source branch, file, tag, or release is deleted or overwritten.

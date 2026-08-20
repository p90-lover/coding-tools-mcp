# Secure Auto-Approval and Persistent OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex-like scoped auto-approval, rotating persistent OAuth, storage recovery, security fixes, full cross-platform verification, and a Windows release executable.

**Architecture:** Keep hard workspace policy enforcement unchanged, then add an in-memory approval layer before normal dispatch. Replace tunnel-bound OAuth token identity with a stable workspace identity and persist only hashed rotating refresh tokens through strict, atomic application-data storage. Expose the new settings in Svelte and validate everything with focused tests plus the existing full matrix.

**Tech Stack:** Rust 2021, Tauri 2, Axum 0.8, Svelte 5, TypeScript, GitHub Actions, Windows NSIS.

**Spec:** `docs/superpowers/specs/2026-08-20-secure-auto-approval-persistent-auth-design.md`

## Global Constraints

- Never delete files; preserve replaced and diagnostic material under `aiTemp/Trash/`.
- Put temporary build and patch material under `aiTemp/`.
- Do not weaken `.git`, `.github`, workspace-root, linked-project, read-only, or host-scope protections.
- Do not store raw refresh tokens.
- Do not claim completion until frontend, Rust Linux/Windows/macOS, security checks, and Windows NSIS build all pass.

---

### Task 1: Approval classifier and scoped grants

**Files:**
- Create: `src-tauri/src/tools/approval.rs`
- Modify: `src-tauri/src/tools/mod.rs`
- Modify: `src-tauri/src/tools/context.rs`
- Modify: `src-tauri/src/tools/dispatch.rs`
- Modify: `src-tauri/src/tools/policy.rs`
- Modify: `src-tauri/src/tools/registry.rs`
- Test: unit tests colocated in the files above

**Interfaces:**
- Produces: `ApprovalMode`, `ApprovalRisk`, `ApprovalStore::preflight`, `ApprovalStore::grant`, and structured `APPROVAL_REQUIRED` errors.
- Consumes: existing `PolicySettings`, `Workspace`, `ToolContext`, and `request_permissions` dispatch route.

- [ ] Write failing tests for routine auto-workspace execution, ask mode, never mode, network/destructive/elevation classification, one-time grant consumption, grant mismatch, expiry, and hard-policy precedence.
- [ ] Run focused Rust tests and confirm the new cases fail before implementation.
- [ ] Implement the approval module and wire it into `ToolContext` and dispatch before execution.
- [ ] Update `request_permissions` to issue scoped grants and keep dangerous mode as a soft-gate bypass only.
- [ ] Correct MCP annotations for `exec_command`, `apply_patch`, and `request_permissions`.
- [ ] Run focused tests, full Rust tests, and Clippy.
- [ ] Commit the approval feature.

### Task 2: Persistent OAuth refresh-token rotation

**Files:**
- Create: `src-tauri/src/auth/refresh_tokens.rs`
- Modify: `src-tauri/src/auth/mod.rs`
- Modify: `src-tauri/src/auth/oauth.rs`
- Modify: `src-tauri/src/auth/oauth_flow.rs`
- Modify: `src-tauri/src/mcp/listener.rs`
- Modify: `src-tauri/src/runtime/supervisor.rs`
- Modify: `src-tauri/src/data/model.rs`
- Modify: `src-tauri/src/data/store.rs`
- Test: auth and runtime unit tests

**Interfaces:**
- Produces: persisted `OAuthRefreshTokenRecord`, `RefreshTokenStore`, stable workspace token issuer/audience, and `refresh_token` grant handling.
- Consumes: `workspace_id`, existing OAuth secrets, and `DataStore` locking.

- [ ] Write failing tests for authorization-code token issuance, refresh rotation, replay rejection, expiry, client mismatch, stable validation after public URL change, and restart persistence.
- [ ] Run focused auth tests and confirm failure.
- [ ] Add refresh-token records to `AppData` with serde defaults and workspace cleanup.
- [ ] Implement hash-only refresh token storage and atomic consume-and-rotate semantics.
- [ ] Extend OAuth metadata and token endpoint to support `refresh_token`.
- [ ] Generate missing OAuth password/signing secrets before listener startup and reject empty client IDs.
- [ ] Add security headers to OAuth responses.
- [ ] Run focused tests, full Rust tests, and Clippy.
- [ ] Commit persistent OAuth.

### Task 3: Strict atomic data persistence and recovery

**Files:**
- Modify: `src-tauri/src/data/migrate.rs`
- Modify: `src-tauri/src/data/store.rs`
- Modify: `src-tauri/src/platform/mod.rs`
- Modify: `src-tauri/src/platform/windows/mod.rs`
- Create or modify: Windows atomic replacement helper under `src-tauri/src/platform/windows/`
- Test: data migration/recovery unit tests

**Interfaces:**
- Produces: `load_strict_or_recover` and `atomic_replace_with_backup` behavior.
- Consumes: platform app-config directory and existing serialized `AppData`.

- [ ] Write failing tests for malformed JSON preservation, valid-backup recovery, no-backup failure, and successful atomic round-trip.
- [ ] Implement same-directory temporary writes under application-data `aiTemp/`.
- [ ] Preserve last-known-good and corrupt files under application-data `Trash/` without deletion.
- [ ] Use Unix rename and Windows `ReplaceFileW` for destination replacement.
- [ ] Run focused tests, full Rust tests, and Clippy on all platforms.
- [ ] Commit storage recovery.

### Task 4: Svelte settings and authentication status

**Files:**
- Modify: `src-tauri/src/workspace/model.rs`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/components/RuntimePolicyForm.svelte`
- Modify: `src/lib/components/AuthConfigForm.svelte`
- Modify: `src/routes/workspace/[id]/+page.svelte`
- Test: `tests/*.test.mjs` and Svelte checks

**Interfaces:**
- Produces: persisted `runtime.approval_mode` and visible OAuth persistence summary.
- Consumes: existing workspace update APIs.

- [ ] Add failing frontend contract tests for approval-mode serialization and labels.
- [ ] Add `approval_mode` with `auto-workspace` default and backwards-compatible serde behavior.
- [ ] Add Codex-style approval mode selector and explanatory safety copy.
- [ ] Add authentication persistence/status text without displaying secrets.
- [ ] Run `npm run check`, `npm run build`, and Node tests.
- [ ] Commit UI changes.

### Task 5: Standard security audit and remediation report

**Files:**
- Create: `docs/security/2026-08-20-codex-security-scan.md`
- Modify as required by validated findings only
- Modify: `.github/workflows/ci.yml` or a focused security workflow

**Interfaces:**
- Produces: source-backed findings with severity, attack path, fix, validation, and residual risk.

- [ ] Audit authentication, authorization, token lifecycle, command policy, path resolution, tunnel exposure, data persistence, secret handling, update/release flow, and CI.
- [ ] Search for committed credential patterns and unsafe secret logging.
- [ ] Validate each plausible finding against direct callers and tests.
- [ ] Fix validated findings at the narrowest shared boundary and add regression tests.
- [ ] Add secret-pattern scanning and dependency advisory checks that do not upload secrets.
- [ ] Write the report and run the complete validation matrix.
- [ ] Commit security findings and fixes.

### Task 6: Documentation, versioning, merge, EXE, and Release

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json` if versioned there
- Modify: `.github/workflows/release.yml` as needed

**Interfaces:**
- Produces: user documentation, release notes, version tag, Windows NSIS `.exe`, and GitHub Release assets.

- [ ] Document approval modes, which prompts remain controlled by ChatGPT, refresh-token persistence, tunnel URL changes, recovery paths, and security boundaries.
- [ ] Bump all product versions consistently.
- [ ] Run frontend checks/build/tests and Rust formatting/build/tests/Clippy on Linux, Windows, and macOS.
- [ ] Open and review a PR into `integration/xyTom-v0.3.0`, then merge only after all checks pass.
- [ ] Open and merge the validated integration branch into `main`.
- [ ] Create the release tag and run the release workflow.
- [ ] Verify the Windows `.exe` exists in the GitHub Release and record its artifact name and release URL.

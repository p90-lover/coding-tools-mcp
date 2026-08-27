# Secure Release Validation and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the divergent release PR on the verified secure source, prove Windows NSIS and universal macOS DMG builds before merge, and prevent unauthorized or accidental release publication.

**Architecture:** A fresh release branch starts at the green secure-authentication head. A read-only validation workflow builds installers without publishing, while a separate self-materialization workflow may write only reviewed source/version paths on same-repository push events. The production release workflow publishes from a main-contained commit and refuses existing-release overwrite.

**Tech Stack:** GitHub Actions, Rust/Cargo, Tauri, Node.js 20, Python 3, PowerShell, Bash, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-20-secure-auto-approval-persistent-auth-design.md`

## Global Constraints

- Never delete repository files; fail if Git reports a deletion.
- Store applicator backups and staging under `aiTemp/` and `aiTemp/Trash/`.
- Do not weaken UAC/elevation blocking, scoped approvals, OAuth rotation, or strict Clippy checks.
- Release publication must originate from a commit contained in `main`.
- Existing GitHub Releases and assets are immutable in this workflow.

---

### Task 1: Rebuild the release branch without history destruction

**Files:**
- Create branch: `automation/secure-source-v0.3.0-rc1-v2`
- Preserve: `automation/secure-source-v0.3.0-rc1`

**Interfaces:**
- Consumes: verified PR #4 head commit.
- Produces: a non-diverged branch that can target `feature/secure-auto-approval-persistent-auth`.

- [ ] Create the replacement branch from the exact green head SHA.
- [ ] Copy only the five reviewed release files, plus the dedicated validation workflow and this plan.
- [ ] Keep the old PR and branch intact until the replacement is verified.

### Task 2: Make version materialization recoverable and fail closed

**Files:**
- Modify: `aiTemp/secure-auto-approval-persistent-auth/apply_release_version.py`
- Create: `aiTemp/secure-auto-approval-persistent-auth/release_version.txt`

**Interfaces:**
- Consumes: a SemVer release version and the five desktop version files.
- Produces: `synchronize(root: Path) -> str`, `check(root: Path) -> str`, CLI `--check`.

- [ ] Prove the applicator synchronizes all versions and creates backups under `aiTemp/Trash/`.
- [ ] Prove check mode rejects mismatches without changing files.
- [ ] Prove symlink targets are rejected.
- [ ] Stage writes under `aiTemp/` and atomically replace only regular repository files.

### Task 3: Separate read-only validation from write-capable materialization

**Files:**
- Modify: `.github/workflows/apply-secure-approval.yml`

**Interfaces:**
- Consumes: reviewed applicators and the release-version file.
- Produces: read-only full validation on PRs and a push-only write job after validation.

- [ ] Run full Rust, Clippy, security, frontend, and OAuth checks with `contents: read`.
- [ ] Permit `contents: write` only in the same-repository push commit job.
- [ ] Reject tracked deletions and changes outside `package*.json`, `src/`, and `src-tauri/`.
- [ ] Rebase and push with three non-destructive retries.

### Task 4: Prove installer builds before merge

**Files:**
- Create: `.github/workflows/secure-release-validation.yml`

**Interfaces:**
- Consumes: fully materialized source.
- Produces: Windows NSIS and universal macOS DMG artifacts with SHA-256 files.

- [ ] Verify OAuth and release-version state without modifying the checkout.
- [ ] Build and upload Windows NSIS artifacts.
- [ ] Build and upload universal macOS DMG artifacts.
- [ ] Cancel stale read-only validation runs and retain artifacts for seven days.

### Task 5: Harden release authorization and publication

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `.github/workflows/release-request.yml`

**Interfaces:**
- Consumes: a validated release tag and a commit contained in `main`.
- Produces: one immutable GitHub Release with Windows/macOS installers and checksums.

- [ ] Require manual dispatch from `main` or a consistent tag push.
- [ ] Require the release commit to be contained in `origin/main`.
- [ ] Refuse publication when the release tag already exists.
- [ ] Replace third-party release publication with the GitHub CLI.
- [ ] Restrict release-request dispatch to the repository owner and `release/<tag>` branch.

### Task 6: Integrate in dependency order

**Files:**
- Update PR metadata only; do not delete branches or files.

**Interfaces:**
- Consumes: green materialization and installer validation checks.
- Produces: replacement release PR merged into PR #4, then PR #4 merged into the integration branch.

- [ ] Open the replacement release PR as draft.
- [ ] Verify all materialization and installer checks are green.
- [ ] Merge the replacement PR into the PR #4 head branch.
- [ ] Verify PR #4 reruns the full matrix and installer builds successfully.
- [ ] Mark PR #4 ready and merge only at the verified head SHA.
- [ ] Close PR #5 as superseded, preserving its branch and history.

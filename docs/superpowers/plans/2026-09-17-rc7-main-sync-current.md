# rc.7 Current-Base Main Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the 42 commits currently unique to `main` while retaining the complete verified rc.6 Provider Hub, Codex Router, Paseo, Anneal, proxy, OAuth, localization, installer-migration, and release work.

**Architecture:** Start from exact rc.6 SHA `c1c5594fb9b0490c49acc44fecda87c5893b123c`, integrate `main` through an isolated current-base branch, and promote only after exact-head validation. Resolve conflicts by preserving rc.6 product/runtime behavior while importing main's security, OAuth, listener, native Codex, version-alignment, and stable-release improvements. Existing branches and retained evidence remain intact.

**Tech Stack:** GitHub pull requests and Actions, Rust/Tauri core, Electron/React renderer, Node/Bun contract tests, NSIS Windows packaging.

**Spec:** User-requested complete GitHub consolidation of coding-tools-mcp without deleting files or branches.

## Global Constraints

- Do not delete project files, branches, tags, releases, or retained evidence.
- Place all temporary or diagnostic material under `aiTemp/`; move obsolete material under `aiTemp/Trash/`.
- Do not mutate the published `v0.7.0-rc.6` tag or replace its assets.
- Preserve encrypted main-process provider credentials and renderer secret isolation.
- Preserve exact Provider Hub account routing through Codex Router, Paseo, Anneal, and subagents.
- Preserve the rc.6 legacy Tauri-to-Electron installer migration and no-elevation behavior.
- Run a focused exact-head matrix before any promotion or new release.

---

### Task 1: Establish the current-base integration lane

**Files:**
- Create: `docs/superpowers/plans/2026-09-17-rc7-main-sync-current.md`

**Interfaces:**
- Consumes: rc.6 SHA `c1c5594fb9b0490c49acc44fecda87c5893b123c`, `main` SHA `546fbb37a82bd2e57ec019d8c361813af7615447`.
- Produces: branch `integration/v0.7.0-rc.7-main-sync-current` and a current-base synchronization PR.

- [x] **Step 1: Create the isolated branch from the exact rc.6 SHA.**
- [x] **Step 2: Record this implementation plan on the isolated branch.**
- [ ] **Step 3: Open a PR from `main` into the isolated branch and inspect GitHub mergeability.**
- [ ] **Step 4: If GitHub can merge cleanly, merge with an exact expected-head guard. If not, record the conflicting paths and resolve only those paths.**

### Task 2: Preserve rc.6 behavior while importing main-only changes

**Files potentially requiring three-way resolution:**
- `.github/workflows/ci.yml`
- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/auth/http_security.rs`
- `src-tauri/src/auth/mod.rs`
- `src-tauri/src/auth/oauth.rs`
- `src-tauri/src/codex_bridge/mod.rs`
- `src-tauri/src/codex_bridge/native_command.rs`
- `src-tauri/src/data/mod.rs`
- `src-tauri/src/mcp/listener.rs`
- `src-tauri/src/mcp/transport.rs`
- `src-tauri/src/tools/registry_definitions.rs`
- `src-tauri/src/tunnel/connection.rs`
- `src-tauri/tauri.conf.json`
- `src/lib/components/CodexRuntimePanel.svelte`

**Interfaces:**
- Consumes: current rc.6 implementation plus main-only security and release commits.
- Produces: a combined branch containing both histories and behaviors.

- [ ] **Step 1: Preserve rc.6 Electron package identity, Provider Hub, Codex Router, and installer migration where overlapping files differ.**
- [ ] **Step 2: Import main's OAuth authorization-response parsing, RFC 9728 resource metadata, transient listener recovery, native Codex long-session repair, tunnel fixes, and version-alignment checks.**
- [ ] **Step 3: Keep stable-release workflows inert until the combined branch has passed the rc.7 exact-head gates.**
- [ ] **Step 4: Commit conflict resolutions as one auditable integration repair.**

### Task 3: Exact-head verification

**Files:**
- Reuse existing tests and workflows; create a narrowly scoped rc.7 integration workflow only if no existing workflow covers the combined branch.

**Interfaces:**
- Consumes: combined integration SHA.
- Produces: immutable workflow evidence tied to that SHA.

- [ ] **Step 1: Run Provider Hub, provider execution, proxy, Paseo, Anneal, Antigravity OAuth, renderer, and no-deletion contracts.**
- [ ] **Step 2: Run strict TypeScript and production renderer build.**
- [ ] **Step 3: Run Rust formatting, focused auth/listener/Codex tests, and strict Clippy where supported.**
- [ ] **Step 4: Run Windows package smoke and legacy uninstall-to-reinstall fixture.**
- [ ] **Step 5: Confirm no raw credentials appear in renderer snapshots, logs, plans, or artifacts.**

### Task 4: Promotion and repository cleanup without deletion

**Files:**
- Update PR metadata and release documentation only after Task 3 is green.

**Interfaces:**
- Consumes: exact verified combined SHA.
- Produces: one canonical promotion PR and no stale open synchronization PRs.

- [ ] **Step 1: Close obsolete PR #134 with a supersession note while retaining its branch.**
- [ ] **Step 2: Open the canonical promotion PR from the verified current-base branch to `main`.**
- [ ] **Step 3: Require exact-head checks and merge only after green evidence.**
- [ ] **Step 4: Advance release identity to rc.7 rather than modifying rc.6, then build and publish exact-source Windows assets.**

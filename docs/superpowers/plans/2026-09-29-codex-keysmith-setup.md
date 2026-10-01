# Optional Codex Keysmith Setup Implementation Plan

> **For agentic workers:** use the reviewed [design](../../specs/codex-keysmith-setup/design.md) and implement these tasks in order. The main agent owns shared Setup/IPC/package files; the GPT-6 Sol worker owns only the new host module and its focused test.

**Goal:** Add a working optional fourth Setup step for verified codex-keysmith v0.6.0 using user-selected Markdown and preserved Codex hooks.

**Architecture:** A bundled pinned Python script is invoked by an Electron main-process host. A narrow trusted-renderer bridge exposes status, file selection, preview, confirmed apply, and confirmed removal to an optional Setup panel. Existing Codex setup and model routes are untouched.

**Tech stack:** React/TypeScript, Electron 41, Node test runner, Python 3.10+ and pinned MIT Keysmith v0.6.0.

**Spec:** [requirements](../../specs/codex-keysmith-setup/requirements.md), [design](../../specs/codex-keysmith-setup/design.md), [delivery checklist](../../specs/codex-keysmith-setup/tasks.md).

## Global constraints

- The only mutating install mode has `--codex-dir HOME --file REVIEWED.md --name coding-tools-keysmith --skip-hooks-isolation --yes` and a main-owned confirmation. The default upstream prompt is never selected.
- Keysmith is optional. `coreSetupComplete`, catalog verification, browser smoke, and MCP status do not depend on it.
- No real Codex home writes in automated tests. Do not stop Codex, replace proxy settings, rotate credentials, or touch unrelated dirty files.
- Keep all task scratch under `aiTemp/keysmith-setup/`; preserve the pinned release and license as packaged product assets only after verifying SHA-256.
- Use UAT for repo reads and commands; use the environment-required patch tool for exact authored edits. Run GitNexus impact on existing symbols before each edit and treat UNKNOWN as unresolved.

## Review focus

1. Missing `--file` or hook-preservation flag must prevent an install even if a renderer calls IPC directly.
2. Preview must be invalidated if Markdown content or selected Codex home changes before apply.
3. A native dialog cancellation must send no `--yes` command.
4. An existing `hooks.json` and unrelated `config.toml` settings must survive isolated apply and uninstall.
5. A missing Python runtime or failed script cannot turn optional Step 4 into a core setup failure.

### Task 1: Verify and bundle the exact upstream release

**Files:** `desktop-electron/assets/keysmith/codex-instruct-v0.6.0.py`, `desktop-electron/assets/keysmith/LICENSE`, `desktop-electron/package.json`.

**Interface:** The runner uses a stable absolute script path derived from the packaged `extraResources/codex-keysmith` folder; development resolves the source asset. The expected SHA-256 is `837ec25713851a2fb6d8646dd078ee03a2e23fe17b19e97e093cedb02349979d`.

- [ ] Write a focused packaging test that fails because the pinned resource is absent from the current manifest.
- [ ] Run that test and verify the expected failure.
- [ ] Copy only the byte-verified release script and upstream MIT license into product assets and add one `extraResources` entry. Never execute the bundled default install mode.
- [ ] Recheck script hash, product manifest, and focused test.

### Task 2: Implement the constrained main-process runner

**Files:** Create `desktop-electron/electron/keysmith-managed.cjs`; create `desktop-electron/tests/keysmith-managed.test.cjs`. Owner: GPT-6 Sol worker. No shared-file edits.

**Interface:** `createKeysmithManaged({ scriptPath, pythonExecutable, codexDir, instructionFile, expectedScriptSha256 })` exposes `status()`, `preview()`, `apply({ confirmed })`, `previewUninstall()`, and `uninstall({ confirmed })`. Results include bounded status/output and no secret material.

- [ ] Write a red test against the absent host for fixed script hash, absolute paths, required custom file and hook-preservation flags, no shell, bounded output/time, and no `--yes` before explicit confirmation.
- [ ] Run the test and confirm the failure is the missing behavior, not a syntax/test-harness error.
- [ ] Implement the smallest runner using Python `-I -B` and argument arrays. Validate the pinned asset before each call and ensure writes never use the bundled default instructions.
- [ ] Run green test plus one isolated real dry-run/apply/uninstall fixture under `aiTemp/keysmith-setup`, asserting hooks and unrelated config stay byte-identical. No real Codex home writes.

### Task 3: Add the narrow trusted launcher API

**Files:** `desktop-electron/electron/main.cjs`, `desktop-electron/electron/preload.cjs`, `desktop-electron/src/types.ts`. Owner: main agent. Focused IPC test only if it exercises the real trusted-sender/confirmation boundary.

**Interface:** `codexWebLauncher` methods for status, choose local Markdown, preview, apply and uninstall. Renderer can never supply executable, command line or Codex-home path. Main derives Codex home from the existing profile and stores the selected file/preview in memory.

- [ ] Impact-check the exact `registerIpc` symbol and inspect all matching launcher IPC handlers before editing.
- [ ] Add an IPC regression check that a cancelled native confirmation never reaches Keysmith apply and the response never exposes a credential.
- [ ] Register the minimal status/read/preview/write handlers. Guard mutations with existing trusted/focused-window checks and native confirmation. Recheck file bytes and preview identity before any apply.
- [ ] Add matching typed preload methods. Run the focused IPC check; preserve all unrelated existing handlers and staged changes.

### Task 4: Show optional Step 4 and useful detail controls

**Files:** `desktop-electron/src/App.tsx`, `desktop-electron/src/features/KeysmithSetupPanel.tsx`, scoped CSS if needed, `desktop-electron/src/i18n.ts`. Owner: main agent.

**Interface:** Setup row index 4 opens a panel for status, local Markdown selection/preview, dry-run, apply, and removal. The panel uses the launcher API from Task 3.

- [ ] Impact-check `SetupSurface`, inspect its current three rows and the `SetupRow` contract, and add a bounded row behavior check that fails while Step 4 is absent.
- [ ] Add the optional row after Install into Codex. Ensure its state does not feed core/MCP readiness and that manual mode stays legible.
- [ ] Add minimal detail UI with accessible controls, visible preview errors, and no implicit installation or default prompt option.
- [ ] Run the row check and React typecheck. Inspect the rendered full and narrow Setup page, including cancellation and absence of Python.

### Task 5: Package, review and verify the non-DEV app

**Files:** Reviewed changes from Tasks 1–4 and existing packaging/test commands. No unrelated package rebuilds or new Git worktree.

- [ ] Run the few affected tests, typecheck, renderer build, and package integrity checks. Broaden only for a concrete failed gate.
- [ ] Review the exact diff, GitNexus change analysis if committing, and confirm no default-refusal prompt or hook-isolation path is reachable through Step 4.
- [ ] Build the normal Windows app once if space permits, preserve a recoverable program backup, install and restart only Coding Tools, and verify the installed Step 4 UI and read-only status/preview. Keep Codex open.
- [ ] Record whether real global apply/uninstall was deliberately left unrun pending the user's in-app confirmation. Do not call a static test an installed runtime check.

## Estimate and handoff

One developer, 8 story points. Optimistic 6 hours, normal 10, pessimistic 18; PERT expectation 10.7 hours. Main risks: shared dirty files, pinned upstream script behavior on Windows, and installer/package version parity. Implementation is authorized by the user's “keep going add the codex-keysmith”; the only later approval is the app-owned confirmation before an actual global Codex config write.

# Optional Codex Keysmith setup: design

Date: 2026-09-29. Covers FR-1 through FR-4 and NFR-1 through NFR-5 from [requirements.md](./requirements.md).

## 概述 / Overview and technical choice

Use the current `desktop-electron` React/Electron app. Setup keeps its three existing rows and adds a fourth optional Keysmith row with a small detail panel. The main process owns a constrained runner for the pinned upstream script. Codex's current model provider, hooks, and MCP settings remain outside this feature's writes.

```text
Setup row 4 (optional) → Keysmith detail panel
  → trusted desktop IPC → pinned v0.6.0 runner
  → status / dry-run / explicit apply / uninstall
  → resolved existing Codex home
```

The upstream bundled default prompt is not an install option. An informational GitHub link alone would not satisfy the requested integration. A custom-file path is supported by upstream and avoids disabling the user's hooks.

## 技术方案 / Source evidence and architecture

- `desktop-electron/src/App.tsx`: `SetupSurface` renders the numbered first three rows; `SetupRow` already supports an action and repeated opening.
- `desktop-electron/electron/main.cjs`, `preload.cjs`, `src/types.ts`: trusted launcher IPC, narrow renderer bridge, and typed API. These files contain preexisting user edits; new changes must be scoped to Keysmith lines.
- `desktop-electron/package.json`: release packaging and `extraResources` patterns; include the Python script and MIT license as usable files outside ASAR.
- Upstream v0.6.0: `--file` selects custom Markdown, `--skip-hooks-isolation` preserves hooks with explicit `--codex-dir`, `--status` and `--dry-run` are inspection operations, and `--yes` is the mutating confirmation path.
- Upstream README warns Windows fresh deployments are beta; show the actual Python/platform status rather than claiming universal support.

## Data model and file ownership

Keysmith remains the owner of any Codex home backup/manifest it creates. Coding Tools should not invent another format for its global instructions. The detail panel holds only transient selected-file path/content and latest preview state. It does not persist Markdown content, default prompts, or CLI output into Coding Tools profiles.

| Data | Owner | Constraint |
|---|---|---|
| Script and license | Installed Coding Tools resources | Exact v0.6.0 release bytes and checksum |
| Target home | Existing Codex home resolver | Absolute canonical directory |
| Selected Markdown | User-selected local file | Regular bounded UTF-8 Markdown, no symlink surprise |
| Preview | Renderer state | Invalidated on file/target/script drift |
| Keysmith manifest and backup | Upstream CLI under Codex home | Recovered only by its supported uninstall path |

The custom Markdown may be shown to the local owner in the detail panel. It is not sent to a model, MCP, AO, or external service by this feature.

## API and command boundary

Use a desktop-only launcher API for `status`, `selectFile`, `preview`, `apply`, and `remove`. The main process resolves the pinned script and Codex home itself. Renderer input is a selected-file handle/preview decision, never an arbitrary executable, command, Codex home, or CLI argument list. Do not expose these operations through the generic app-handler/MCP/AO catalog.

| Operation | Upstream CLI command shape | Effect |
|---|---|---|
| Status | `py -3 script --codex-dir HOME --status` | Read-only |
| Preview | `py -3 script --codex-dir HOME --file REVIEWED.md --skip-hooks-isolation --dry-run` | Read-only |
| Apply | Same exact reviewed args with `--yes` replacing `--dry-run` | Explicit write after confirmation |
| Remove preview | `py -3 script --codex-dir HOME --uninstall` | Review only if upstream reports a plan without writing |
| Remove | `py -3 script --codex-dir HOME --uninstall --yes` | Explicit restoration after confirmation |

The implementation must verify actual upstream behavior of each command in an isolated test home before enabling an action. An unknown or ambiguous CLI result is a visible failure. Spawn uses argument arrays, no shell, a fixed script path, timeout/output caps, one operation at a time, and sanitized errors. Before apply, recheck the reviewed file bytes, target home, script digest, and preview identity. No default-install call is reachable.

Keysmith may write its own backup/manifest during a confirmed operation. The app must not edit `config.toml` itself or strip the user's other settings. A separate native confirmation is the final write gate; the default button is Cancel.

## Visual design

Keep the existing restrained dark Setup design. Add Step 4 after Install into Codex, labeled **Codex Keysmith · Optional** with an action that opens its details. Show current status, selected Markdown, a bounded readable preview, and an explicit change preview. The Apply and Remove buttons are only available after the corresponding preview. Errors stay in the panel and remain distinguishable from Step 3 catalog/bridge failures.

Step 4 contributes no value to `coreSetupComplete`, `codexCatalogVerified`, `smokePassed`, or `mcpSetupComplete`. Status requests are scoped to opening Setup/Keysmith, not app startup. In manual interaction mode, it remains optional and keeps the existing numbering convention.

## 文件结构 / File boundaries

Expected existing touch points: `desktop-electron/src/App.tsx`, `src/types.ts`, `src/i18n.ts`, `electron/preload.cjs`, `electron/main.cjs`, `package.json`, and its focused tests. Expected new owned components: a Keysmith detail panel, a small main-process runner, its focused regression test, and the pinned script/license resource. The reviewed implementation plan must name exact paths after GitNexus impact and source inspection. No generic provider or account feature is needed.

## Test and installation strategy

Start with a failing focused test showing that the host rejects a missing custom file or hook-preservation flag. Test status/dry-run/apply/remove against a disposable Codex home under the task's `aiTemp`, with benign Markdown and existing hooks/config as fixtures. Assert that dry-run leaves files byte-identical and apply/restore preserve hooks and unrelated settings. Exercise UI Step 4 at full and narrow window sizes, then typecheck/build and verify a normal non-DEV install. Product runtime checks must be separated from isolated test results.

## Risks and containment

| Risk | Control |
|---|---|
| Default prompt attempts to override refusals | Require custom reviewed file; never pass an omitted `--file` to mutating install |
| Upstream defaults isolate hooks | Always pass `--skip-hooks-isolation` with exact `--codex-dir` |
| Global config damage | Upstream dry-run, one native confirmation, Keysmith backup, verified uninstall |
| Running unknown downloaded code | Bundle and hash-check fixed release artifact; no mutable runtime download |
| Other work in dirty checkout | Narrow patches, read-before-edit, no broad replacements or new worktree |

This design is the implementation boundary for optional Step 4; it does not claim the feature is already installed or tested.

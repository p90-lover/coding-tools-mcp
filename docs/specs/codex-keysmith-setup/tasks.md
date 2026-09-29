# Optional Codex Keysmith setup: delivery checklist

The user authorized implementing an optional Setup Step 4. This checklist links the design to acceptance. The implementation plan locks exact file edits and commands separately.

## 交付物清单 / Scope lock

- Documentation deliverables: `requirements.md`, `design.md`, `tasks.md` in this directory.
- Product deliverables: one optional Setup row/detail surface, a desktop-only Keysmith runner/IPC, a pinned MIT release resource, and a focused regression test.
- Expected new product files: runner, panel, test, script, license. Expected existing files touched: the Setup renderer, typed API, preload, main IPC, localization, and package manifest. No extra app, worktree, remote service, or account integration.
- Function count/line budgets and exact owner files will be confirmed in the implementation plan after impact analysis. This checklist itself does not authorize a global config change.

## 任务列表 / Tasks

- [x] T1: Verify the exact upstream project, custom-file/hook-preserving flags, MIT license, and release hash.
  - Evidence: `Jia-Ethan/codex-keysmith` v0.6.0 README/source, SHA256SUMS match, Python 3.14.6.
  - Requirements: FR-2–FR-4. Design: Source evidence and command boundary.
- [x] T2: Inspect current Setup row, launcher API and package seams without replacing unrelated dirty edits.
  - Evidence: `desktop-electron/src/App.tsx:1400–1512`, `electron/preload.cjs:21–72`, `src/types.ts`, and `package.json`.
  - Requirements: FR-1–FR-4. Design: File boundaries.
- [ ] T3: Complete the reviewed implementation plan and GitNexus impact for shared Setup/IPC edits.
  - Evidence: plan file and authoritative impact target IDs; verify source call sites when the graph reports UNKNOWN.
  - Requirements: FR-1–FR-4, NFR-1–NFR-5. Design: Architecture and risks.
- [ ] T4: Write a failing focused test for safe custom-file invocation, hook preservation, preview gating, and isolated Codex home.
  - Evidence: real red run for the intended missing behavior, not a mock-only success.
  - Requirements: FR-2–FR-4. Design: Command boundary and test strategy.
- [ ] T5: Bundle the verified release, implement the minimal runner/IPC and the optional Setup panel.
  - Evidence: reviewed source diff and green focused test, Step 4 independent of core/MCP completion flags.
  - Requirements: FR-1–FR-4. Design: API, data model, visual design.
- [ ] T6: Typecheck/build, inspect the installed non-DEV UI, and run a safe status/preview with no real Codex config writes.
  - Evidence: exact commands, exit codes, narrow/full-size UI proof, installed package/source hash, and retained recovery state.
  - Requirements: all FR/NFR. Design: Test and installation strategy.

## 需求覆盖矩阵 / Coverage

| Requirement | Design area | Tasks |
|---|---|---|
| FR-1 | Visual design / non-gating state | T2, T5, T6 |
| FR-2 | Runner/status / source evidence | T1, T4, T5, T6 |
| FR-3 | File selection / dry-run | T1, T4, T5, T6 |
| FR-4 | Apply/recovery | T1, T4, T5, T6 |
| NFR-1–NFR-5 | Data model / risks / verification | T3–T6 |

## 文件变更清单 / Current changes

| File | Operation | Scope |
|---|---|---|
| `docs/specs/codex-keysmith-setup/requirements.md` | New | Acceptance criteria |
| `docs/specs/codex-keysmith-setup/design.md` | New | Safe runtime and UI boundary |
| `docs/specs/codex-keysmith-setup/tasks.md` | New | Delivery checklist |

No product code has changed as part of this documentation step. The verified upstream script is staged under `aiTemp/keysmith-setup` and has not been executed.

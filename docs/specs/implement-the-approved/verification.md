# Runtime AO company canvas — verification checkpoint

Date: 2026-09-28. Status: installed; native worker-command acceptance is waiting for a human-approved test. This is not an all-tools completion claim.

## Installed result

Normal, non-DEV Coding Tools 0.7.0-rc.14 is installed at `C:/Users/simon/AppData/Local/Programs/Coding Tools`. Only Coding Tools was restarted; Codex stayed open. Latest core backup: `aiTemp/Trash/company-before-install-20260928-002555`.

Installed headless SHA-256: `5e0629a01d999c4d9b60120601c7b00a22d4651326d0784b5fd340053df55c14`.

Runtime bundle: `6d618a08db1c136584d57f88c4430fdce9df2bbb10d4d52c260398a6cc36bb8d`.

Runtime → Agent Orchestrator provides the workspace Board and Team canvas. The board uses upstream AO board/card components and project bindings with the existing durable host mission store as the single authority; it does not duplicate missions into a second database. More → Agent Orchestrator preserves the original management interface.

The canvas supports free positions, Shift/Ctrl-click multi-selection, group dragging/arrow movement, alignment, zoom/Fit, dependency connections, activity animation and reduced motion. Group layout updates are atomic and do not widen execution grants. Role settings, attempt history, worker ceilings, pause/stop and two bounded review-rework rounds are persisted.

## Real model execution

Run `c72022f3-2cfe-4ec0-8c20-c55fc8008668` in isolated workspace `c3ef81784fc444a7bf9fb74495c577be` completed:

| Stage | Actual model | Native turn | Result |
|---|---|---|---|
| Planning | `chatgpt-web/high` | `01a0e294-599a-74b1-94c6-3ac81897d86e` | Supplied worker assignment and independent-review criteria |
| Worker | `gemini-3.8-flash-high` | `01a0e294-efa6-75d0-9252-2184d973df66` | Calculated 17 + 25 = 42 |
| Review | `chatgpt-web/high` | `01a0e295-26c0-7772-9711-cc4eb2de503f` | APPROVED |

This was a text-only mission. Its receipts survived restart without resubmission. Shared CPA account selection may vary, as explicitly accepted by the user.

## Native command approval

The user approved adding Allow once / Deny controls. These are limited to AO worker command callbacks, with exact command, canonical local working directory, requested permissions, ownership checks and a 120-second expiry. Only a local confirmed decision can return `accept`; session-wide/persistent approval is never returned. Planner/reviewer and generic Native Codex permissions were not widened. A one-time native command can exceed the default read-only sandbox; the panel and confirmation explain this explicitly.

The live mismatch was proven by run `76b6a701-0802-42d2-b93c-ffbe0104b8e7`: Codex supplied `environmentId=local`, while the initial parser accepted only an omitted environment. Both local forms are now accepted; remote environments remain rejected. Windows canonical-path handling was also corrected. Denied/expired/unsupported approvals now hold the card with its explanation instead of being treated as successful worker work.

Run `075eebfd-8491-49d1-a368-2a292f6f67df` (`company-worker-approval-v3`) then proved the repaired path: WebGPT planned, Gemini requested `Get-Content -LiteralPath tool-check.txt`, native status reported a pending command, and the installed GUI displayed the exact request with Allow once / Deny. The verification helper did not click either button. No human decision arrived before expiry; the worker is held and the reviewer remains pending. Do not replay this run automatically.

Evidence: `aiTemp/work/ao-company-canvas/installed-command-approval.png`, `approval-ui-proof.cjs`, and `aiTemp/ao-live-mission-state-company-worker-approval-v3.json`.

The user subsequently reported approval after v3 expired. One explicitly announced fresh probe, v4 (`0a591e5a-bd54-4b70-a0d2-ab4a1fb06fc5`), again reached the exact pending request but expired before the native bridge recorded acceptance. The user also reported approving v4. A subsequent GUI inspection confirmed the correct mission was selected, with no pending request or visible error remaining. This does not establish whether both in-app confirmation buttons were clicked before expiry; clarify that before another probe. Neither command executed, and neither held run was replayed.

## Focused checks

- Canvas/graph checks: 5 passed, including preserving group offsets at bounds.
- AO Rust checks: 6 passed, covering layouts, immutable active settings, capacity, receipt preservation, bounded rework and approval parsing. The explicit `local` regression also passed after its live diagnosis.
- Native bridge checks: 9 passed; 1 explicit live-binary fixture was intentionally ignored.
- Electron workflow checks: 14 passed, including no automatic tool approval and scoped local confirmation.
- Host typecheck/build and headless release build passed. Package validation passed; installation compared copied files against the candidate.
- Packaged GUI: saved role edits, free/group positions, alignment, Board/canvas identity and desktop/narrow layouts passed. The isolated GUI helper confirmed production task data remained byte-identical.
- Accounts/CPA navigation passed its repeated login checks. Local tunnel/Responses health was observed, but health alone is not connector proof.

## Remaining acceptance boundaries

1. A fresh native file-read probe requires the user to be present and approve that exact request. No successful command execution is claimed yet.
2. An earlier WebGPT remote-connector test returned 404/429. WebGPT computer/vision/MCP tool execution remains unverified; proxy settings were not changed to evade restrictions.
3. Responsibility changes must preserve the current single-lead/single-reviewer graph. Arbitrary planner/reviewer swaps are not verified and should not be advertised as unrestricted team rewiring.
4. No commit or push was made. Pre-existing staged deletions, untracked replacements and unrelated edits remain untouched. No independent GPT-6 Sol review occurred because that model was unavailable; scoped review was performed inline.

Generated package replacements were moved into recoverable project Trash. Existing application data, credentials and backups were preserved.

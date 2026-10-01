# Runtime Email: specification delivery checklist

This is the specification's acceptance/delivery checklist, not the executable implementation plan. The written spec must be reviewed before the separate implementation plan is produced or product code is changed.

## 概述 / Scope lock

Deliver Runtime → Email for the existing `leung-mail-worker` connection. Include browsing/preview, address creation, and confirmed message/inbox/mailbox management. Exclude outbound mail, agent access, Cloudflare deployment/DNS changes, and changes to the reference registration projects.

## 交付物清单 / Deliverables

Current phase creates exactly three documentation files and changes no product files:

1. `docs/specs/runtime-cloudflare-email/requirements.md`
2. `docs/specs/runtime-cloudflare-email/design.md`
3. `docs/specs/runtime-cloudflare-email/tasks.md`

Later phases deliver a reviewed implementation plan, native Email surface, desktop-only authenticated client/bridge, focused tests, verification evidence, and a verified non-DEV app update. Product file/function counts and line budgets belong to that plan and are not approved implementation instructions here.

## 任务列表 / Delivery stages

- [x] T1: Trace the existing Worker and verify read-only authenticated access.
  - Evidence: reference Worker `src/worker.ts` and `src/admin_api/index.ts`; both live settings/statistics GETs returned 200 on 2026-09-28.
  - Scope: reference files are read-only; no product code or remote data changes.
  - Requirements: FR-2, FR-3. Design: Architecture and Worker contract.
- [x] T2: Capture the approved management scope and write this specification.
  - Evidence: user approved the full-pane design, address creation, and explicitly confirmed destructive actions; `address_api.ts` establishes the removal cascade.
  - Scope: the three documentation files above.
  - Requirements: FR-1 through FR-6. Design: all sections.
- [ ] T3: Obtain written-spec review, then write and review the implementation plan.
  - Evidence to carry forward: inspected current Electron navigation/preload/IPC paths and existing unrelated dirty changes.
  - Scope: planning documents and GitNexus impact checks before any product-function edits.
  - Requirements: FR-1 through FR-6, NFR-1 through NFR-5.
- [x] T4: Implement the approved native reader and guarded management boundary.
  - Evidence: `electron/email-host.cjs` (credential + admin client, secret-stripping normalizers), `electron/email-mime.cjs` (dependency-free MIME parse + HTML sanitizer floor), `electron/main.cjs` (`getEmailHost` + `launcher:email-*` handlers, focus-guarded), `electron/preload.cjs` (bridge), `src/features/EmailSurface.tsx` + `email.css`, `src/types.ts`, `src/icons.tsx` (mail icon), `src/App.tsx` (sidebar + render).
  - Credential change from spec: the credential is entered once in-app at connect time (verified read-only, then stored via safeStorage), NOT auto-imported from reg-machine. The credential-scan boundary correctly blocked auto-discovery, and in-app entry keeps the app out of the user's credential stores.
  - Open decision: the HTML sanitizer element/attribute allowlist is a `TODO(human)` in `email-mime.cjs` (safety floor already enforced regardless).
  - Requirements: FR-1 through FR-6. Design: normalized contracts, credential entry, layout, preview, confirmations.
- [~] T5: Verify focused tests, rendered behavior, and the live read-only mailbox path.
  - Done: `tests/email-host.test.cjs` (8 passing) — origin validation, id/page bounds, secret-stripping, MIME multipart decode, sanitizer floor, connect verify-before-persist + rollback, redirect-as-error, encrypted-at-rest. Renderer `tsc --noEmit` clean; main-process `node --check` clean.
  - Pending: rendered desktop/narrow-window checks in the running app, and a live read-only mailbox/preview against the real Worker (needs the connected credential). No live mutations performed.
  - Requirements: all FR/NFR. Design: Verification.
- [ ] T6: Build, verify, and install the non-DEV update without disrupting Codex.
  - Evidence to require: package checks, preserved user data, installed Runtime → Email entry, and truthful remaining live-test gaps.
  - Scope: existing Coding Tools installation and a recoverable update; no new worktree or cloud service.
  - Requirements: FR-1, FR-2, NFR-5. Design: Verification and Risks.

## 需求覆盖矩阵 / Coverage

| Requirement | Design section | Delivery stages |
|---|---|---|
| FR-1 | Visual layout / implementation boundaries | T2–T6 |
| FR-2 | Credential import / desktop contract | T1–T6 |
| FR-3 | Worker contract / visual layout | T1–T5 |
| FR-4 | Safe preview | T2–T5 |
| FR-5 | Worker contract / management confirmations | T2–T5 |
| FR-6 | Management confirmations / risks | T2–T5 |
| NFR-1–NFR-5 | Architecture / verification / risks | T3–T6 |

## 检查点 / Completion gates

- [ ] Written specification approved; implementation plan separately reviewed.
- [ ] Required impact analysis and focused tests completed with actual evidence.
- [ ] No secrets or email content leaked through logs, IPC metadata, or test artifacts.
- [ ] Live read/preview verified; mutation checks accurately distinguish mocked tests from approved live tests.
- [ ] Installed non-DEV UI verified; no assertion that unfinished functionality is complete.

## 文件变更清单 / Current file changes

| File | Operation | Scope |
|---|---|---|
| `docs/specs/runtime-cloudflare-email/requirements.md` | New | Approved scope and measurable acceptance criteria |
| `docs/specs/runtime-cloudflare-email/design.md` | New | Verified API, native layout, credentials, and management boundaries |
| `docs/specs/runtime-cloudflare-email/tasks.md` | New | Specification deliverables, acceptance stages, and coverage |

No product source, package, credential file, reference-project file, or Cloudflare configuration is changed in this specification phase.

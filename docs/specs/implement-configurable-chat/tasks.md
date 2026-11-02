# Tasks: configurable chat pages

## 交付物清单 / Scope and evidence
Eleven implementation/test paths are expected, plus these three specification files. Keep new production modules below 350 lines each and integrate into existing large components with small changes.
Current evidence: App.tsx:1031 mounts one AgentOrchestratorSurface. Surface:1888 holds its split panes; :2014 and :2023 persist one SPLIT_STORE. ChatSettingsPage:115 exposes the existing Settings primitives. page-visibility.ts exports the hidden-screen context and hook. No existing renderer shortcut parser or page store was found.

## 任务列表 / Tasks
- [x] 1. Inspect current main, related PRs 888/891, existing layout and visibility contracts. FR-1, FR-3; design Architecture and Ownership.
- [x] 2. Implement bounded page preferences, shortcut validation and the page owner registry. New chat-pages.ts and focused tests. FR-1 to FR-3; design Data model and Ownership.
- [x] 3. Add the persistent page host and existing-style Settings controls. ChatPages.tsx, chat-pages.css, App.tsx and ChatSettingsPage.tsx. FR-1, FR-2; design UI and styling.
- [x] 4. Isolate page routes, split persistence, draft scopes and hidden-page input/polling. Small integrations in AgentOrchestratorSurface.tsx and ChatThreadList.tsx. FR-1, FR-3; design Data model and Ownership.
- [x] 5. Run focused tests and TypeScript; verify the rendered flow, rebindings, wheel scoping and draft retention. FR-1 to FR-3; design Test strategy.
- [x] 6. Review the scoped diff and attempt graph change analysis, recording its unavailable coverage below. No automatic merge or installed-app change. All requirements.

## 需求覆盖矩阵 / Coverage matrix
| Requirement | Design | Tasks | Status |
| --- | --- | --- | --- |
| FR-1 | Architecture, Data model, UI | 2, 3, 4, 5 | Verified |
| FR-2 | Ownership and input, UI | 2, 3, 5 | Verified |
| FR-3 | Ownership and input, Risks | 1, 2, 4, 5 | Verified |

## Checkpoints
- Specifications validate before implementation.
- Current-source call sites supplement unresolved stale graph results.
- Focused behavior and real rendered interaction evidence precede completion.
- Only task files are committed and published in the PR; task scratch and test processes are cleaned.

## 文件变更清单 / File changes
The implementation and test files are enumerated in design.md under 文件结构. These three specification documents are the remaining delivery artifacts. Existing large components retain their current structure; only page integration and hidden-page guards are added.

## Verification
The focused Node group covers 431 checks, including production callback regressions for removed projects, late hidden restores and hidden retention scans. Renderer TypeScript checking passes. A disposable Electron renderer using the actual components and fixture backend verifies drafts across pages, default and rebound keys, navigation toggles, wheel scoping and throttling, owner-page reuse, removed-project recovery and the tab bar at 640 px. It does not exercise the installed app or live providers.

The shared October 1 graph index is stale. A local refresh failed in native code, its bounded single-worker retry timed out, and both CLI and explicit-worktree change-analysis attempts failed to return results. Current source callers and ownership flows were reviewed directly; these failures are not a clean graph check. The delivery PR records this remaining verification limit.

# Implementation and verification tasks

## 交付物清单

Seven deliverables: pinned runtime build, local-only lifecycle, typed handler operations, isolated original renderer bridge, More navigation surface, verified Runtime mission flow, and rollback-safe installed package.

## 任务列表

## 1. Pin and build the real runtime

- [x] Read upstream README, DESIGN, renderer tokens, preview bridge, daemon config, and local module manifest. Verify checkout SHA 73473d45f0c18f3a81f66f150868459e3098ca35.
- [x] Clone the upstream repository to module/agent-orchestrator, pin the reviewed commit, and make this the integration source. No standalone AO installation.
- [x] Compile the unmodified pinned backend baseline using the portable Go toolchain. This is a build check, not an installed AO app or a verified local-only runtime.
- [x] Build and test the integration from module/agent-orchestrator with preview data disabled; stage in aiTemp and publish verified package resources.
- [x] Document copied assets, build recipe, pin, daemon hash, and upstream license in the package resource manifest.

Evidence: upstream frontend/scripts/dev-web.mjs sets VITE_NO_ELECTRON; frontend/src/renderer/lib/bridge.ts reports an unavailable desktop bridge. backend/internal/config/config.go fixes LoopbackHost to 127.0.0.1. Requirements FR-1, FR-4, FR-6; design Runtime and bridge, Packaging and rollback.

## 2. Implement managed lifecycle and handler operations

- [x] Run graph impact for existing controller/handler symbols before editing; manually trace dynamic and unindexed boundaries.
- [x] Extend the AO service and handler with explicit lifecycle and upstream API operations, bounded errors, validation, and mutation confirmation.
- [x] Prevent secondary LAN/mobile/tunnel activation, not merely the primary bind address.
- [x] Omit undefined task in board responses and cover the strict JSON boundary with a regression test.

Evidence: app-handler/agent-orchestrator/handler.cjs delegates to context.services.agentOrchestrator and unconditionally emits task in successful board results. desktop-electron/electron/original-ui.cjs normalizes loopback endpoints. Requirements FR-3, FR-4, FR-7; design Existing boundaries, Runtime and bridge. Expected source changes: handler, service/controller, lifecycle module, bridge module and focused tests; new modules under 400 lines each.

## 3. Embed original UI and preserve mission navigation

- [x] Add More > Agent Orchestrator using isolated upstream renderer and real daemon status.
- [x] Keep Runtime > Agent Orchestrator as the mission panel, preserving existing workspace/role routing and mission records without automatic migration.
- [ ] Verify keyboard access, resize behavior, loading/errors, long names, and theme isolation against upstream source.

Evidence: desktop-electron/src/features/AgentOrchestratorSurface.tsx currently owns missions, task clauses, model routing, and workflow actions. Requirements FR-1, FR-2; design Source and visual direction. Expected files: App navigation, navigation types/state, embedded surface, isolated bridge and stylesheet; do not merge upstream CSS into the global app stylesheet.

## 4. Verify mission and security

- [x] Run focused handler/IPC/lifecycle tests, host UI typecheck/build, and original renderer build.
- [ ] Verify actual WebGPT route and exact Gemini 3.8 Flash catalog ID. Run one bounded mission with execution receipts, retaining existing approval rules.
- [x] Inspect owned listening sockets and test rejection of public destinations and remote activation.
- [x] Verify both rendered screens, not just processes or file hashes.

Requirements FR-1 through FR-7; design Mission routing. Missing auth/model availability must be reported as blocked evidence.

## 5. Package, install, and reopen

- [x] Build staged package including actual daemon/renderer and bridge dependencies.
- [x] Exercise packaged startup with a prevalidated runtime before replacement; preserve existing program/runtime backups. Fresh runtime-directory rename remains an environmental verification limitation.
- [x] Install and restart only Coding Tools-owned processes. Verify critical installed hashes and both navigation entries in the visible app.

## Current blocker

The current installed app now verifies an authenticated Temporary Chat session, and CPA exposes `gemini-3.8-flash-high`. Runtime now opens the original AO project board as requested, and the redundant embedded-UI POST confirmation is removed. The real WebGPT-led mission still has no completed execution/review receipt, so FR-5 remains incomplete. See verification.md for current evidence; another sign-in is not presently required.

Requirements FR-6; design Packaging and rollback. No release or completion claim before installed runtime verification.

## 需求覆盖矩阵

- FR-1: tasks 1, 3, 4, 5, original renderer and runtime.
- FR-2: tasks 3, 4, mission navigation and durable state.
- FR-3: tasks 2, 4, typed handlers and confirmations.
- FR-4: tasks 1, 2, 4, listener and remote-activation boundaries.
- FR-5: task 4, exact-model live execution receipts.
- FR-6: tasks 1, 5, reproducible package and installation.
- FR-7: tasks 2, 4, JSON-safe board response.

## 文件变更清单

Three specification files are new. Planned source files: app-handler/agent-orchestrator/handler.cjs and module.json; desktop-electron/electron/agent-orchestrator-workflow.cjs; desktop-electron/src/App.tsx and navigation state/type definitions; package resource preparation and verification. New modules: managed upstream lifecycle, isolated upstream bridge, and embedded original UI surface, each capped at 400 lines. Extend adjacent handler, lifecycle, package, and UI tests only where they exercise these requirements. Final file count must be reconciled against the actual implementation before installation.

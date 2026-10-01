# Design: native upstream AO

## 概述

Reference: Untrivial-ai/agent-orchestrator commit 73473d45f0c18f3a81f66f150868459e3098ca35. Apache-2.0 repository license; preserve component-specific notices as well. Authoritative integration checkout: module/agent-orchestrator. The earlier aiTemp checkout is retained only as a build/reference artifact.

The user explicitly requested source integration from this Git checkout, not installation of the standalone AO application. Do not run AO installers or `ao start`, which can fetch and launch a standalone desktop app.

Visual thesis: use the original compact dark operational shell, Geist typography, subdued hairlines, and semantic status colors. Content prioritizes project selection, live sessions, intervention, then detail. Interaction follows original upstream controls and reduced-motion behavior rather than new animation. CSS strategy: upstream Tailwind and tokens inside an isolated renderer; existing Coding Tools CSS remains outside it.

## Existing boundaries

`app-handler/agent-orchestrator/handler.cjs` dispatches operation names through `context.services.agentOrchestrator`. `AgentOrchestratorSurface.tsx` owns the current mission UI. `original-ui.cjs` has loopback URL normalization but currently supports CPA only. Reuse registry, confirmation, resource resolution, and window ownership rather than granting upstream content the Coding Tools renderer bridge.

The upstream `dev:web` script sets VITE_NO_ELECTRON=1. `renderer/lib/preview-mode.ts` enables fixture data, and `renderer/lib/bridge.ts` supplies a stopped mock daemon without its preload. This mode cannot satisfy FR-1.

## 技术方案

Build the actual Go daemon and production renderer from the pin. The daemon's config fixes its primary host to 127.0.0.1. A Coding Tools-owned lifecycle controller must use a separate data directory, verify readiness/identity, bound logs and timeouts, and stop only its own child. A dedicated isolated upstream renderer bridge supplies daemon status and supported desktop operations. Native features that cannot be implemented must return explicit unavailability, never fake success.

Route supported typed operations through an allowlist at the handler boundary. Keep URL/port selection internal. Block redirects and host overrides. Preserve upstream Host/Origin checks. Loopback is not authentication: protect the integration's privileged control surface and do not export its control token to unrelated renderers.

Upstream also includes LAN/mobile APIs. A primary loopback binding alone does not satisfy local-only requirements: disable those routes and startup restore paths, and verify no secondary public listener can be activated. Do not enable telemetry or cloud endpoints as an integration side effect.

## Mission routing

Preserve Coding Tools mission records and approvals. Inventory actual WebGPT/native Codex and CPA catalogs before mapping upstream orchestrator and worker configuration. Test one small non-destructive mission, with exact role/model receipts and bounded runtime. Never mark a connection as route-verified solely because a process exists.

## Packaging and rollback

Keep build outputs in aiTemp and publish verified runtime resources through the existing package preparation pipeline. Include license/pin/hash metadata and reject missing bridge/daemon/renderer dependencies. Do not overwrite a working installation until the staged package opens. Retain prior archive and runtime artifacts for rollback.

## Known baseline defects

The earlier startup fix defers a source-only Paseo helper import; keep that fix. The mission board handler currently adds `task: undefined`, which violates the strict apps.call JSON response contract. Omit absent optional data or return null explicitly; do not relax IPC schema validation.

## 文件结构

Existing entry points: app-handler/agent-orchestrator/handler.cjs, desktop-electron/electron/agent-orchestrator-workflow.cjs, desktop-electron/src/App.tsx, desktop-electron/src/features/AgentOrchestratorSurface.tsx, and desktop-electron/scripts/prepare-package-resources.cjs.

Separate new lifecycle, upstream renderer bridge, and embedded surface modules from mission execution. Work on upstream source in module/agent-orchestrator; keep generated build outputs under aiTemp until verified publication into Coding Tools package resources. Tests belong beside existing app-handler, original-UI, package-boundary, and renderer tests. Avoid adding another generic RPC transport.

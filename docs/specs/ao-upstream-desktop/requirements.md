# Native upstream AO integration

## 功能概述

The user selected the actual Untrivial-ai/agent-orchestrator UI and backend, not an imitation of its visual design. New services must remain local-only. Verify WebGPT as orchestrator and Gemini 3.8 Flash as workers, then build, install, and restart Coding Tools.

Source-location correction: clone and develop AO in `module/agent-orchestrator` within this repository. Do not install AO as a separate application. Any final installation/restart refers only to the integrated Coding Tools build.

## 需求列表

- FR-1: More > Agent Orchestrator embeds the actual pinned upstream renderer backed by its real daemon. Browser preview fixtures are prohibited.
- FR-2: Runtime > Agent Orchestrator retains the mission graph, selected workspace, durable state, approvals, and receipts. Navigation must distinguish this panel from the upstream dashboard.
- FR-3: Expose supported upstream operations through the existing app-handler registry. Validate operation arguments and JSON responses; require focused confirmation for mutations and never offer an arbitrary URL proxy.
- FR-4: Own daemon startup, readiness, shutdown, logs, and isolated state. Bind listeners only to 127.0.0.1. Block LAN/mobile listener activation, cloud tunnels, public bind addresses, and remote-host forwarding in this integration.
- FR-5: Resolve exact configured model identities. A live bounded mission must demonstrate a WebGPT orchestrator and Gemini 3.8 Flash workers with execution receipts. Missing authentication/model availability is a blocker, not permission to substitute a model.
- FR-6: Package the pinned daemon, renderer, bridge, licenses, and runtime assets. Preserve installed program/runtime backups; verify the installed build and both visible panels after restart.
- FR-7: Fix the existing board response that includes an undefined task property, without weakening global IPC JSON validation.

## Acceptance

WHEN the user opens either navigation entry, the system SHALL render real connected content or an actionable unavailable state. WHEN a mission completes, the system SHALL retain receipts identifying the requested roles and models. WHEN the daemon runs, the system SHALL expose only loopback listeners. WHEN the installation is replaced, the system SHALL preserve prior program/runtime artifacts and verify packaged startup first.

## 非功能需求

Empty, loading, disconnected, error, and long-title states remain usable. No fabricated sessions appear. Handler tests cover read operations, invalid arguments, mutation confirmation, and unavailable services. Existing app data and unrelated source changes remain intact. Privileged requests are bounded and confirmed; CSS and preload capabilities are isolated.

## 依赖关系

Pinned upstream Go 1.27.1 backend, locked frontend dependencies, Electron renderer bridge, existing Coding Tools app-handler and package resource pipeline, authenticated WebGPT and CPA Gemini 3.8 Flash routes.

## Non-goals

No public hosting, mobile pairing, remote daemon registration, tunnel, cloud-agent rollout, global credential rewrite, automatic tool approval, source-history rewrite, or silent replacement of the requested models.

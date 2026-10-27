# Design: owned chats and shared host tools

## 概述 / Architecture

### 技术方案 / Shared native transport

FR-1 keeps `runtime-web/src/adapters/chatgpt-web/mcp-server.ts` inventory and exact dispatch as the authority for host tools. Prompt guidance permits the ChatGPT capabilities actually supplied by that chat, alongside local MCP tools. It does not synthesize desktop-only capabilities.

FR-2 extends the existing native control contract with optional model/effort selection on start, stores the selection on each owned thread, and exposes bounded `model/list` through the existing status tool. Sends use the stored selection, rather than resetting every thread to the connection default.

FR-3 uses persisted native threads instead of `ephemeral: true`. A small ownership journal in the dedicated Codex home stores workspace, permission profile, executable identity, thread/model state and bounded request receipts. Native initialization restores owned threads with `thread/resume`; native history supplies the terminal result. Recovery never submits the old user prompt. The launcher already stores the exact native-thread/conversation-key/connector/ChatGPT-URL mapping.

The native resume, bounded history and model-catalog calls follow the [OpenAI app-server protocol](https://learn.chatgpt.com/docs/app-server).

FR-4 makes native stopped/unknown outcomes terminal incomplete AO receipts. Electron reconciles the existing receipt before deciding that a chat is still running. A saved WebGPT connection may be rejoined only under the saved, still-valid AO grant; CPA secret material is not persisted to accomplish this.

```text
MCP / Native panel / AO
  -> authenticated native control
  -> owned thread + selected model
  -> native persisted rollout
  -> stable native thread ID
  -> existing launcher conversation registry
  -> original ChatGPT conversation
```

## Data and API

The journal is scoped to canonical workspace, dedicated home, executable digest and permission profile. It is versioned, bounded for JSON-escaped answers and receipts, and written through a private staging file under the store's `aiTemp/`. Credential configuration and approval decisions are not stored in it. An exclusive ownership lease prevents concurrent writers. Existing MCP request IDs remain the replay boundary.

`codex_agent_control` accepts model and effort only for a new chat. `codex_runtime_status` retains its empty-argument behavior and adds a bounded model-catalog view. Native ownership and permission mismatches are errors, not reasons to create a replacement thread. Background initialization exposes `initializing` so status polls stay responsive. A definite pre-submission reconnect rejection requires a fresh operation ID after readiness because the outer service retains failed receipts too.

## 文件结构 / Files

- `src-tauri/src/codex_bridge/mod.rs` and a cohesive session-persistence module under that directory.
- `src-tauri/src/tools/codex_runtime.rs` and `registry_definitions.rs` for the public contract.
- `rust-core/coding-tools-headless/src/lib.rs` for AO observation/rejoin.
- `desktop-electron/electron/agent-orchestrator-workflow.cjs` for chat receipt reconciliation.
- `runtime-web/src/adapters/chatgpt-web/prompt.ts` and `mcp-server.ts` for shared tool guidance.
- Existing native, desktop workflow and bridge harness tests for regression coverage.

## Verification and risks

Use focused native contract tests, existing exact-registry MCP tests, and desktop chat/workflow tests. The shared native control path is used by all three surfaces; permission and replay checks are mandatory. Native catalog availability does not prove account inference access. Installed-app validation is separate from source tests and will be reported precisely.

Explicitly approved configuration changes archive an incompatible previous journal under the native store's Trash directory. Automatic recovery retains strict scope checks. Native result hydration uses the live message assembly logic, and AO terminal recording checks the request identity under the same reservation fence that retires its connection. Startup observation has its own cancellation generation and cannot create retry grants.

# WebGPT tool reliability and app consent

## 功能概述
Improve the native WebGPT MCP bridge in repository source. Preserve the current sandbox and native tool approvals. Composer, context compaction, rendering and installed applications belong to separate work.

## 需求列表
- FR-1: Inventory queries match whitespace-separated keywords across names and descriptions, with small explicit aliases. Preserve native and nested schemas when supplied; label missing schemas honestly.
- FR-2: A long native tool invocation returns a pending receipt before the transport deadline. Polling retrieves the original result without resubmission. An optional request ID deduplicates identical calls within one live turn and rejects changed arguments.
- FR-3: An explicit app-call tool requests human confirmation showing the exact wire name and arguments before dispatch. Decline, cancellation or unavailable elicitation executes nothing. Native runtime permissions still apply.
- FR-4: Tool status exposes queued, dispatched and completed states only within the authenticated turn. Registry presence is never reported as execution proof.

## Acceptance
The bridge SHALL satisfy all four functional requirements through the controlled MCP acceptance scenarios below.
Exercise the real MCP stdio protocol against the native broker with controlled tools. Check keyword queries, exact/fallback schemas, pending completion, request-ID conflicts, turn isolation, consent rejection and approval. Run the existing broker lifecycle and native/safe MCP contract regressions plus TypeScript checking.

## 非功能需求
No new dependencies. Bound receipt retention to a live turn. Never automatically retry a mutating operation after an unknown outcome. No installed runtime changes or real external app writes during tests.

## 依赖关系
Existing MCP SDK form elicitation, native Codex tool registry and turn broker. No third-party app installation is included.

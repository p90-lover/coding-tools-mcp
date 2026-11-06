# Design: long-horizon terminal parity

## 概述

Covers FR-1 through FR-5. Keep the existing terminal and preview interfaces. Fix discrepancies in their actual implementation rather than adding redundant aliases or disabling safety controls.

## 技术方案

### 架构设计

Chat tool call -> existing scoped consent/ownership guard -> runSandboxed -> createSandboxRunner -> owned Codex sandbox child. The runner owns optional deadline timers and bounded output. Preview consent never trusts terminal output as authorization; remove the ignored servedHere probe entirely, preserving the existing decision and avoiding unrelated terminal reads.

### 数据模型

Runtime-only command record gains explicit timeout metadata and one cancellable deadline timer. No default deadline. Output retains absolute byte totals and a capped suffix. Responses add truncation and retry/supervision facts; existing IDs and aliases remain compatible. Do not persist output or invent restart recovery.

### API 设计

Existing exec_command timeout_ms is forwarded and validated as null/zero or a nonnegative safe integer. Node timers are armed in bounded slices for large deadlines and cleared on close/explicit stop. Snapshot status distinguishes termination from stream finalization; failure cannot become success merely because a wrapper exits zero. Poll/read the existing command instead of replaying it.

Existing previewOriginDecision requires bypass or an upstream-reviewed call to avoid another prompt. servedHere is explicitly ignored because stdout can be fabricated. Remove that unused asynchronous probe before the decision; keep local-only targets, per-chat origin grants and all approval behavior unchanged.

### 文件结构

Modify desktop-electron/electron/chat-sandbox.cjs and chat-agent-tools.cjs, plus their existing regression files. Add a focused long-horizon regression file only if needed for fixture separation. Add docs/audits/tool-parity-long-horizon-2026-11-06.md and these specifications. No renderer or Rust production changes are required.

### Owned command discovery (FR-5)

Add the chat-owned read-only `list_commands` definition to the existing terminal group, not the Rust/headless catalog. It returns bounded pages of this credential owner's command handles, output references, timestamps and explicitly last-observed state. It reads only the existing entry.commands map and never probes processes, exposes raw command strings or performs inference. Existing root/lease/group validation precedes listing. An accepted command whose yield failed stays in that map and can be polled using its discovered handle. A process-stop error resets its tracked running state and surfaces failure so an explicit second Stop can retry.

## 设计决策

Keep no default runtime deadline: changing yield alone must never terminate a multi-day job. Honor an explicitly requested timeout, rather than silently ignoring it on Windows. Keep output RAM-only and bounded even under bursty output. Preserve an accepted command on turn cancellation; explicit Stop/timeout remains its owner. Do not implement hosted tools without an authorized backend or pretend ordinary pipes are a PTY.

## 测试策略

First capture failing regressions for ignored timeout, oversized output, UTF-8 tail, termination truth and sandbox preview detection. Use fake child events and controlled timers, plus a real local Node child lifecycle smoke test without account/model access. Run full chat-agent-tools/chat-sandbox suites and adjacent lifecycle/preview suites; verify syntax/whitespace and current task graph changes. No GUI changes or credentialed browser test is needed for these backend fixes.

## 风险评估

Existing createSandboxRunner graph is HIGH and reaches main startup/terminal creation; callTool/preview consent paths are similarly sensitive. Refresh a task-scoped graph due to stale global index and low disk space. Dynamic object dispatch means empty edges are not unused-code evidence; text-check callbacks and run integration regressions. Never infer private ChatGPT logic from UI similarity.

## 检查清单

- [x] Every requirement maps to runtime or documentation changes.
- [x] Long-task behavior retains security and ownership boundaries.

# 需求文档：remake-coding-tools

## 功能概述
Replace the independent Windows computer-input implementation with the locally installed Codex `@oai/sky` Windows engine, including the native engine's visible control feedback. The user explicitly selected reuse of the installed Codex engine rather than a standalone imitation. Existing Coding Tools consent, workspace boundaries, replay protection and emergency Stop remain authoritative.

## 历史经验与坑
- Exact reference parity means using the actual implementation, not changing labels on an unrelated UI.
- Codex's documented Windows surface is the window2 API. Read its installed `computer-use/docs/api.md`; do not confuse it with the older macOS tools.
- The shared checkout contains unrelated changes. Deliver only this feature in a scoped PR. Do not install or restart the app.
- No scratch, test profiles or persistent helper state may default to C:. Images and helper output remain in memory.

## 术语定义
- **Sky**: the installed Codex `@oai/sky` JavaScript package and its Windows native helper.
- **Grant**: the user-created, workspace-bound local computer-control lease.
- **Window**: Codex's `{app, id, title?}` identifier for a currently open application window.

## 范围边界
In scope: installed-runtime discovery and validation; a private owned Sky worker; documented window2 actions; existing tool compatibility; native feedback; fail-closed Stop and cancellation; regression coverage; scoped PR delivery.
Out of scope: redistributing Codex binaries, downloading unsigned replacement helpers, joining an existing Codex pipe/session, recording screenshots, remote consent, browser automation, locked-desktop access, app installation/restart.

## 需求列表
### FR-1: Use the actual installed Windows engine
**优先级:** Must
**用户故事:** As a user I want Codex's real Windows actions and native feedback instead of an approximate implementation.
1. WHEN a locally enabled session requests a computer action THEN the system SHALL use a validated installed Sky runtime and its own helper process.
2. IF the installation is absent or incompatible THEN the system SHALL return an actionable error without silently falling back to SendInput.
3. WHILE the worker is active THE system SHALL not connect to another Codex session or copy its executables into the project.

### FR-2: Preserve the window2 action contract and existing tools
**优先级:** Must
**用户故事:** As an agent client I want the documented Codex window-state, click, drag, scroll, keyboard, typing and accessibility methods, without breaking current computer tools.
1. WHEN a supported window2 method is requested THEN the system SHALL forward validated method parameters and return the actual native result.
2. WHEN an existing single-step action is requested THEN the system SHALL translate it to the same engine while preserving request-id replay protection.
3. IF a request targets an unapproved window or changes its executable identity THEN the system SHALL reject it before native input.

### FR-3: Keep local control and visible feedback authoritative
**优先级:** Must
**用户故事:** As a user I want the real engine's feedback while retaining a visible Stop and control over my computer.
1. WHEN local Stop, emergency Stop, pause, grant expiry or monitor loss revokes input THEN the system SHALL cancel owned native work and prevent automatic replay.
2. IF the engine requests approval outside the locally approved application THEN the system SHALL deny it rather than auto-accepting unrelated authority.
3. WHILE a session is active THE monitor SHALL identify the actual Codex engine and report real action/state, not fabricated screenshots or status.

## 非功能需求
- **NFR-1（性能）**: Reuse one worker per local grant; do not spawn a helper per poll or action. Bound requests and responses; no unbounded queues.
- **NFR-2（安全）**: Never persist screenshots or print secrets. Reject unknown methods. Stop must not wait on the in-flight operation's mutex. Preserve authenticated, capture-enabled and non-read-only policies.
- **NFR-3（兼容性）**: Support Windows only with explicit unsupported-platform errors. Keep the current ten computer-tool names and legacy action shape compatible.

## 依赖关系
Existing Rust computer lease and native identity checks; local IPC control monitor; installed Codex Windows runtime and its documented window2 API. The current graph is stale and its risk results require current-source verification.

## 检查清单
- [x] User selected installed-engine reuse.
- [x] Stable FR identifiers and measurable error/Stop contracts.
- [x] Scope, dependencies, security and compatibility recorded.

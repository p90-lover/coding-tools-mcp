# Requirements: Codex permission and readiness parity

## 功能概述
Provide a real Codex-compatible permission menu in mission chat for all roles. Preserve every existing saved permission unless the operator explicitly changes it. Include the app's distinct workspace/MCP and OS-app consent surfaces without conflating their scope. WebGPT admission must require fresh authenticated readiness before a role is connected or dispatched.

## 历史经验与坑（来自记忆库）
- Reuse actual native profiles and decision payloads, not a cosmetic permission dropdown.
- Preserve unrelated active checkout work; implementation is isolated at base 64976204ca9485630bfbb410472cf0bb6159cbbf.
- Source investigation found native permissions, own MCP approvals, shared model/command grants and OS-app grants are separate layers.
- The screenshot does not uniquely identify the pending request type; do not automatically grant or reclassify commands based on their text.

## 范围边界
- In Scope: role policy persistence, native effective policy, chat controls, typed native/MCP consent, existing app permission controls, WebGPT admission, focused regressions and a scoped PR.
- Out of Scope: global credential/config changes, automatic login, blanket elevation, active mission interruption, app restart, purchases, changing unrelated files, rewriting the existing app policy engine.
- Keep legacy grant fingerprints/receipts compatible when the new optional selection is absent.
- Do not advertise policy parity for a harness that cannot enforce it; show its capability limit.

## 需求列表
### FR-1: Preserve role policies
**优先级:** Must
**用户故事:** As Ethan, I want all roles to retain their saved scope until I change it.
1. WHEN chat or role UI mounts THEN it SHALL not write policy defaults.
2. WHEN a harness/model is changed and changed back THEN the saved native permission selection SHALL round-trip without becoming read-only.
3. IF saved values are unknown or mixed THEN the UI SHALL show them honestly and require explicit selection.

### FR-2: Apply native Codex permissions
**优先级:** Must
**用户故事:** As Ethan, I want menu selection to control the actual native execution policy.
1. WHEN a native profile is selected THEN its exact profile ID, approval policy and reviewer SHALL reach thread/start and every turn/start.
2. IF the runtime or managed policy rejects a profile THEN no turn SHALL be submitted under a substitute profile.
3. WHEN automatic review is selected THEN the same sandbox SHALL remain active with on-request and auto_review.
4. Full access SHALL require an explicit selection/confirmation and SHALL not silently change MCP/app consent.

### FR-3: Expose a functional chat menu
**优先级:** Must
**用户故事:** As Ethan, I want a chat-menu permission switch for planner, workers, reviewers and helper roles.
1. WHEN a saved chat is selected THEN controls SHALL derive from that chat's own mission/team snapshot.
2. WHEN an all-role selection is explicitly applied THEN every supported role SHALL receive it through revision-checked persistence.
3. Running attempts SHALL retain their current effective policy; queued/future application SHALL be visibly distinguished.
4. Cancelling or encountering a stale revision SHALL not report application success.

### FR-4: Handle native tool consent
**优先级:** Must
**用户故事:** As Ethan, I want native shell, file, filesystem/network and MCP/app requests to be answerable in chat.
1. Modern native command/file/permissions requests, requestUserInput and MCP elicitation SHALL have typed UI data and method-specific replies.
2. Granted filesystem/network permissions SHALL be only the requested subset with explicit turn/session scope.
3. Offered authoritative command decisions SHALL not be replaced by a blanket boolean or fabricated allowlist.
4. Unsupported runtime requests SHALL produce an actionable visible error, not an indefinite pending label.

### FR-5: Keep app policy scopes distinct
**优先级:** Must
**用户故事:** As Ethan, I want the menu to expose existing app permissions without changing unrelated grants.
1. Workspace MCP filesystem/approval/catalog/capture controls SHALL use their existing confirmed API, saved raw values and restart requirement.
2. Shared native model/standalone-command grants and computer/snapshot permissions SHALL be separately scoped and use their existing consent workflows.
3. A role selection SHALL not silently change workspace-wide or shared-client rights.
4. A saved configuration SHALL not be labelled effective until its real runtime readback confirms it.

### FR-6: Gate every WebGPT role before dispatch
**优先级:** Must
**用户故事:** As Ethan, I want signed-out WebGPT roles to require sign-in rather than start working.
1. Before connect AND before dispatch on both manual and background paths, every WebGPT role SHALL require fresh authenticated session and bridge readiness evidence.
2. Signed-out, missing host or unknown evidence SHALL hold admission with an actionable reason, before reservation/submission.
3. Non-WebGPT routes SHALL not be blocked by this gate.
4. Probing SHALL not navigate active browser tabs, perform login or reveal credentials.

## 非功能需求
- NFR-1: No new global permission defaults or credential changes.
- NFR-2: All task-only files and test data stay under this worktree's aiTemp.
- NFR-3: Native runtime capability/managed restrictions remain authoritative.
- NFR-4: Use existing policy/API/protocol infrastructure; no duplicate authorization engine.
- NFR-5: Functional tests must prove saved and effective changes, plus deny/cancel/stale paths.

## 依赖关系
Installed Codex CLI 0.159.3; native app-server permissionProfile/list and thread/turn policy API; existing scoped app APIs; React/TypeScript renderer and Rust bridge.

## References
- https://learn.chatgpt.com/docs/permissions
- https://learn.chatgpt.com/docs/sandboxing/auto-review
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/extend/mcp

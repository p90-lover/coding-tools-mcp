# 设计文档：separate-chat-tooling

## 概述

**对应需求:** FR-1, FR-2, FR-3, NFR-1, NFR-2, NFR-3.

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|---|---|---|---|
| Chat UI | React add-on picker and settings | Keep optional panels out of composer code and duplicate Settings rows | FR-1 |
| Registration | Fixed local CJS group registry | Preserve public tool names and dispatch guards | FR-2 |
| Diagnostics | Existing in-memory launch log | No files, clocks that poll, or credentials | FR-3 |

### 架构设计

`AgentOrchestratorChat` owns the draft, delivery and approvals, and opens `ChatWorkbench` on demand. The panel launcher defines panel labels and categories separately. `PluginsSurface` provides a slot for `ChatAddonSettings`, which applies the existing preferences and shows recent conflicts from the existing log store.

The backend registers ownership once and resolves `groupOf` both for listing and dispatch. Only existing groups and tool definitions are used. A cross-group duplicate is unavailable rather than defaulting to policy based on order. A duplicate listing is reduced to the first eligible entry. Deliberate app-versus-headless overrides are reserved as before; they are not warnings. SDK MCP namespaces stay separate: only a server name already taken in the same session is rejected. No extra MCP probes are made.

## 数据模型

| 实体/字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| Add-on conflict | kind, add-on ID, owner ID, capability | fixed enums, known tool names, or a validated configured MCP entry ID | Never include data from credentials, URLs, prompts or tool arguments |
| Cooldown | bounded map | at most 128 recent identities; 60 seconds per repeated conflict | Process lifetime only |

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|---|---|---|---|---|
| createChatToolRegistry | electron/chat-tool-addons.cjs | existing groups with their tool sets | stable groups, owner lookup and conflicts | FR-2 |
| createChatAddonConflictReporter | electron/chat-tool-addons.cjs | logger and clock | bounded sanitized warning reporter | FR-3 |
| ChatAddonSettings | src/features/ChatAddonSettings.tsx | snapshot, existing preference callbacks, server-name lookup | typed grouped settings and recent warning rows | FR-1, FR-3 |
| ChatAddonPicker | src/features/ChatAddonPicker.tsx | available session/plan, open callback, recent pages | optional panel options grouped by purpose | FR-1 |

## 文件结构

- New: Electron chat-tool registry and conflict reporter; React add-on settings and picker (including the shared panel-tab metadata); tests and feature notes.
- Updated: `chat-agent-tools.cjs`, `chat-mcp-servers.cjs`, `logging.cjs`, `backend-bundle.cjs`, `App.tsx`, `ChatWorkbench.tsx`, and `AgentOrchestratorChat.tsx`.

## 设计决策

### 决策 1: Separate tools, not authority（关联需求: FR-1, FR-2, FR-3）

**问题:** Optional panels and MCP tools are mixed with core Chat, and duplicate namespace rejection is hidden.

**决策:** Use built-in add-on descriptors and the existing user-MCP adapter instead of introducing a new plugin loader or rewriting chat delivery.

**理由:** A missing add-on can never take the send path down, and a conflict cannot fall back to another privilege group.

## 测试策略

- Verify the current tool catalog and compatibility with existing approval tests. Inject a harmless duplicate and assert deterministic suppression.
- Check that an MCP name collision is skipped case-insensitively, is shown once per cooldown, and never contains its URL, command or headers.
- Verify memory-only warning behavior even when persistent logging is enabled. Render the add-on picker and settings, follow the open action, and preserve existing chat behavior in regression tests.

## 风险评估

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Tool group registration affects authorization | High | Preserve lease groups and all existing call gates; ambiguous owners fail closed |
| Add-on assets missing from a packaged backend | High | Include new dependency in backend bundle and test the dependency closure |
| Conflict spam or sensitive payload | Medium | Explicit diagnostic fields, cooldown and existing bounded log |

## 检查清单

- [x] Design covers all three feature requirements and keeps existing security boundaries.

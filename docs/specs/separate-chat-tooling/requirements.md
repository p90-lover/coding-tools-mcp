# 需求文档：separate-chat-tooling

## 功能概述

Make Chat a conversation shell with a single add-on launcher for optional panels. Move built-in tool categories to Plugins and make runtime name conflicts visible without adding disk logs.

## 历史经验与坑（来自记忆库）

Chat panels and tools must not poll or persist diagnostics merely because a chat exists. Reuse the bounded Activity log and do not change approval or worktree routing.

## 术语定义

- **Chat core:** conversation, composer, drafts, delivery, and approvals.
- **Add-on:** a built-in tool group or optional panel registered by the app; a user MCP is an external server configured on the Plugins page.

## 范围边界

**In Scope:** registration, discovery, settings, and runtime name-conflict diagnosis for chat tools; a single chat panel launcher.

**Out of Scope:** a new executable extension format, third-party downloads, changing permission boundaries, draft or queue rewrites, and migration of old messages.

## 需求列表

### FR-1: Keep tool categories out of the conversation

**优先级:** Must
**用户故事:** As a Chat user, I want one add-on launcher and a single place to manage tool categories so Chat is easy to use.

#### 验收标准（EARS）

1. WHEN a user opens a chat THEN the app SHALL show the composer and conversation independently of the optional panel launcher.
2. WHEN a user opens Plugins > Chat add-ons THEN the app SHALL show the existing built-in tool settings grouped by purpose, with the same saved preferences.
3. WHEN a user opens Chat add-ons in a chat THEN the app SHALL offer the optional panels without changing the current draft or starting an agent.

### FR-2: Register chat tools through isolated groups

**优先级:** Must
**用户故事:** As a maintainer, I want one registry for tool ownership so a registration mistake cannot change another tool's policy.

#### 验收标准（EARS）

1. WHEN a session lists or calls a tool THEN the app SHALL use the same group ownership and existing policy checks.
2. IF the same tool is declared under two policy groups THEN the app SHALL omit and refuse that specific tool, leaving other tools and Chat working.

### FR-3: Diagnose conflicts at runtime

**优先级:** Must
**用户故事:** As a Chat user, I want to see which add-on was skipped or disabled and why.

#### 验收标准（EARS）

1. WHEN a configured MCP server wants a namespace already attached to the chat THEN the app SHALL keep the existing server, skip the competing one, and show a bounded diagnostic in Plugins and Activity.
2. IF the same attach conflict repeats THEN the app SHALL suppress repeated warnings within the cooldown and SHALL NOT record message text, arguments, config values, credentials, or files for it.

## 非功能需求

- **NFR-1（性能）:** No additional background polling, processes, or catalog network requests. Conflict logging is rate-limited and stays in memory.
- **NFR-2（安全）:** Existing opt-ins, approval gates, lease revocation, and worktree confinement remain authoritative.
- **NFR-3（兼容性）:** No settings migration and no rename of MCP tools, aliases, or wire groups.

## 依赖关系

Electron chat tool service and MCP registry, React workbench, existing Activity buffer, and backend resource selection.

## 检查清单

- [x] Acceptance criteria cover normal, duplicate, and unavailable tools.
- [x] Feature does not widen privileges or load untrusted modules.

# Codex chat sessions

## 功能概述
The user approved a bounded read-only MCP tool to automatically find Codex chat storage and retrieve saved conversations across all their projects. Returned pages may be sent to the requesting WebGPT conversation.

## 历史经验与坑
The existing rollout resolver authenticates the active turn; it is not a history browser. Coding Tools' history_session tools read its own Markdown archives, not Codex rollouts. Preserve both. Installed catalog availability is not proof of a remote ChatGPT call.

## 术语定义
- Session: a Codex rollout whose first session_meta record matches its canonical filename UUID.
- Visible message: a user message or assistant final/commentary message, excluding internal reasoning, system/developer records and tool payloads.

## 范围边界
In scope: discover, list and paginated read; active/archived chats; configured Codex home; authenticated requests; all-project access explicitly enabled locally for this user. Out of scope: resume, write/delete/archive, new databases, model calls, arbitrary-path reads, GUI redesign or Git publication.

## 需求列表
### FR-1: Discover configured storage
Must. WHEN discover is called with valid turn authentication THEN the tool SHALL reuse CODEX_HOME/default-home resolution and report active/archived paths and their availability without creating directories.
### FR-2: List and read real sessions
Must. WHEN list/read is called THEN the tool SHALL return deterministic bounded pages, verified session identity, source paths and visible messages from active or archived files. IF an ID is ambiguous, missing or out of scope THEN it SHALL fail explicitly rather than choose a different chat.
### FR-3: Preserve privacy and boundaries
Must. WHEN an operation is requested THEN existing claimed-turn authentication SHALL run before file access. The local codexHistoryScope setting SHALL default to workspace; only the exact value all enables all-project access. Arbitrary paths, symlink escapes, invalid cursors and oversized records SHALL be rejected. Common credential patterns SHALL be redacted; no auth files or hidden reasoning SHALL be returned.
### FR-4: Verify the actual MCP route
Must. Tests SHALL exercise discovery, active/archive pagination, redaction and denied access. A real local MCP call SHALL validate the deployed tool; private chat bodies and capability tokens SHALL not be printed during verification. Remote connector validation SHALL be reported separately.

## 非功能需求
- Bounded directory traversal, JSONL record size, read work and output text; UTF-8-safe continuation.
- Additive configuration and MCP contract; no change to AO, model routing, proxy or existing turn authority checks.
- Temporary fixtures and build/verification artifacts remain under aiTemp; preserve dirty-worktree changes and backups.

## 依赖关系
Existing Bun/Node filesystem APIs, getCodexHome, runtime configuration, MCP SDK and TurnBroker.

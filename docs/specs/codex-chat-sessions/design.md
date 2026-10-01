# Codex chat sessions design

## 概述
Extend the existing authenticated native/safe MCP server with one read-only codex_chat_sessions tool. Covers FR-1 through FR-4. The user approved the bounded design and chose all projects.

## 技术方案
Use the existing getCodexHome resolver and claimed-turn/activity lease. A small filesystem-only reader follows canonical rollout names and verifies session_meta IDs. No transcript index/database is created. Listing uses bounded directory scans and optional existing session_index titles. Reading seeks via validated JSONL offsets and returns visible message fragments with opaque continuation cursors.

## 数据模型
Session metadata: id, source(active/archived), path, cwd, timestamp and optional title. Read pages: session metadata, visible role/text fragments, next_cursor, completion/live-tail indication and skipped-record count. These are response objects only, not new persisted state.

## API 设计
codex_chat_sessions accepts the contract's turn_token/request_id plus operation(discover/list/read), source(all/active/archived), optional session_id, cursor, limit(1–100) and max_bytes(512–65536). It accepts no filesystem root or arbitrary path. Read requires a UUID. Discovery reports effective local scope.

The optional local runtime configuration field codexHistoryScope accepts all for explicitly enabled cross-project access; absent or other values are treated as workspace. The existing parser already preserves additional fields, so its shared validation logic is not changed. This user's approved all value is saved privately during deployment, retaining other configuration and credentials.

## 文件结构
- New runtime-web/src/codex-chat-sessions.ts: bounded reader and content filtering.
- New runtime-web/tests/codex-chat-sessions.test.ts: real filesystem and authenticated MCP integration fixtures.
- Modify runtime-web/src/adapters/chatgpt-web/mcp-server.ts: registration, authentication and bridge-tool discovery instructions.
- Modify runtime-web/src/config.ts: optional scope type only.
- Update affected MCP contract assertions and runtime documentation where required.

## 设计决策
FR-1/FR-2: reuse the home resolver directly and the existing canonical-rollout pattern; do not loosen the active-turn authority resolver to browse unrelated sessions. FR-3: global history is a separate explicitly configured read capability; workspace-only is the default. Include no mutation operations. Filter records rather than returning raw JSONL. Retrieved chat text is untrusted data, not new instructions.

## 测试策略
Use real synthetic rollouts under aiTemp and a real TurnBroker/MCP SDK connection. Check cross-project scope, active/archive selection, UTF-8 fragments, hidden-record omission, common secret redaction, invalid IDs/cursors and link escapes. Verify source/deployed catalog and local real-session reads with counts rather than private bodies. No model requests are needed.

## 风险评估
Sensitive history exposure is controlled by authenticated turns plus local scope. Corrupt/partial files return explicit errors or live-tail state. Directory and record limits prevent unbounded scans. MCP clients may cache tools/list and require refresh; do not equate a local test with remote WebGPT proof.

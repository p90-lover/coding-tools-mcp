# Bounded command watches and tool discovery

## 范围
Known-handle watch/list/cancel tools and terminal wait guidance.

## 需求回链
FR-1, FR-2, FR-3.

## 验收标准（EARS）
1. WHEN terminal/continuation services are enabled THEN each supported MCP harness SHALL list callable watch tools; disabled/preview-only/subagent sessions SHALL not gain them.
2. WHEN an owned handle is watched THEN the system SHALL return identity/state, deduplicate, observe without launching/writing/killing and produce one terminal outcome within the deadline.
3. WHEN observation hangs/fails or cancellation occurs THEN slots SHALL be bounded and late delivery suppressed.
4. WHEN output/history grows THEN metadata/output SHALL remain bounded; non-owner handles SHALL be refused.

## 涉及文件
chat-command-watches.cjs, chat-agent-tools.cjs, backend-bundle.cjs and focused tests.

## 不做项
No arbitrary processes, file logs, PTY or restart-survival promises.

## 设计要点
Reuse existing snapshots/output reads and empty write_stdin. A watch deadline stops observation only.

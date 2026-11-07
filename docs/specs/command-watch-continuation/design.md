# Design: command-watch-continuation

## 概述
FR-1 through FR-6 connect a bounded owned-command observer to an actual follow-up, not a final-answer promise.

## 技术方案
The tool server owns in-memory watches beside known command handles. A small module validates/deduplicates observations and deadlines. Inspection uses sandbox snapshots or rooted headless output reads; it launches nothing and never sends stdin. A workflow registration captures chat/run ownership before reporting success. Completion waits outside model inference until the parent turn settles, then uses serialized chatSend and followUpSelection.

watch_command accepts command_id, reason and timeout_ms (default30minutes, maximum24hours). list_command_watches exposes only this chat's bounded records. cancel_command_watch cancels observation and pending delivery, not the process. Watch expiry is not a command timeout. Unknown send outcomes are not replayed. Related watch follow-ups may share lineage; newer user turns never do.

## 文件结构
chat-command-watches.cjs, chat-agent-tools.cjs, agent-orchestrator-workflow.cjs, main.cjs and backend-bundle.cjs, plus lifecycle/MCP/workflow tests. Existing command aliases remain valid.

## 设计决策
Keep state/output in memory, preserve per-chat roots and consent, stop stale work, and make registration verifiable. No automatic inference solely from future-tense text.

Public Codex commit2f742f58856618deaaa86fa7f7048aad57c972a9 uses exec_command/write_stdin and an exit watcher. async_watcher emits command events; that file alone does not prove automatic model-turn resumption. Preserve its wait/output lifecycle and implement the app's explicit completion-to-turn bridge, not an invented native Codex watch API. Source: https://github.com/openai/codex/tree/2f742f58856618deaaa86fa7f7048aad57c972a9/codex-rs/core/src/unified_exec

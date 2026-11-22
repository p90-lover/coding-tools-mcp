# Design: silent chat automation

## 概述

FR-1 and FR-2: mark only native background follow-ups at the send boundary. Suppress the prompt at transcript projection, not at model delivery.

## 技术方案

An internal send option annotates the persisted follow-up header. All routing, timing, cancellation and authorization remain on the existing chat-send path. Parse the origin as part of the stored message, keeping its position and date for run alignment. Older unmarked messages still show.

## 数据模型

`Follow-up (automatic YYYY-MM-DD HH:mm UTC):` records origin in the existing separator without changing the prompt body. Readers recognize an automatic header at the beginning as well when deletion removes the opening human message. Steer notes remain separate from the hidden prompt.

## API 设计

No IPC or MCP schema changes. The workflow's internal automation callers opt into the record annotation; public compose/steer calls do not.

## 文件结构

Electron: `agent-orchestrator-workflow.cjs`, `chat-edits.cjs`, `chat-history.cjs`, and `chat-redaction.cjs`. Renderer: `ao-chat.ts`, `AgentOrchestratorChat.tsx`, `AgentOrchestratorSurface.tsx`, and `chat-window.tsx`.

## 设计决策

Keep the record and run aligned instead of dropping a stored prompt. One bit of durable provenance is safer than matching prompt words or keeping a separate per-run file. Omit automation prompts from user-facing transcript and shared copies, retaining real steers and agent replies.

## 测试策略

Verify the wake/watch/monitor and schedule workflow, the actual renderer and its read-only copies, and round-trip message deletion/steer handling with an automatic turn between human messages.

## 风险评估

Message edits and rollover depend on the existing record format. Preserve positions and parse headers consistently; test a hidden turn promoted to the first stored record. Do not change approval presentation.

## 检查清单

- [x] FR-1 and FR-2 covered.

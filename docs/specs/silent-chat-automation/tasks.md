# Tasks: silent chat automation

## 概述

One Electron chat workflow and transcript presentation feature.

## 交付物清单（Scope-lock）

Three specification files; eight existing core source files listed in design; focused workflow and transcript tests in the existing Electron test suite. No new runtime service or disk state.

## 任务列表

- [x] 1.1 Record trusted automated sends with a header annotation and preserve the same prompt and send guards.
  - **证据块**: `agent-orchestrator-workflow.cjs` records each accepted follow-up before creating its run; wake, watch, monitor, goal, loop, schedule and adopt flows all call that function.
  - **涉及文件**: `agent-orchestrator-workflow.cjs`, `chat-edits.cjs`, `chat-redaction.cjs`; under 100 changed lines per file.
  - _需求: FR-1, FR-2_ ｜ _设计: 技术方案, 数据模型_
- [x] 1.2 Suppress only automated prompt text in normal and read-only transcripts, without dropping real steers, replies or edit positions.
  - **证据块**: `ao-chat.ts` pairs raw records with runs by index; `AgentOrchestratorChat.tsx` and `chat-window.tsx` draw `turn.user`.
  - **涉及文件**: `ao-chat.ts`, `AgentOrchestratorChat.tsx`, `AgentOrchestratorSurface.tsx`, `chat-window.tsx`, `chat-history.cjs`; under 100 changed lines per file.
  - _需求: FR-1, FR-2_ ｜ _设计: 设计决策_
- [x] 2.1 Verify actual background delivery, message alignment and rendered transcript.
  - **证据块**: Existing wake/watch/monitor fixtures capture task writes; transcript fixtures render the real chat component and assert user bubbles and replies.
  - **涉及文件**: Scoped desktop Electron tests; under 150 added lines per file.
  - _需求: FR-1, FR-2_ ｜ _设计: 测试策略_

## 检查点

Validate the spec before coding; run affected cases and inspect the diff before pushing.

## 需求覆盖矩阵

| ID | Design | Tasks |
| --- | --- | --- |
| FR-1 | 技术方案, 设计决策 | 1.1, 1.2, 2.1 |
| FR-2 | 数据模型, 设计决策 | 1.1, 1.2, 2.1 |

## 文件变更清单

See the design's two file groups and the test files above.

## 检查清单

- [x] Defined scope, evidence, and acceptance for both requirements.

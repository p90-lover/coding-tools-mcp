# Tasks

## 交付物清单

Scoped response-style store and controls, reactive renderer integration, input-driven follow repair, focused regressions and verification receipt.

## 任务列表

- [x] Read instructions/context and trace shared style/follow behavior. (FR-1, FR-3, FR-5)
- [x] Define scopes, inheritance, migration and no-network acceptance. (FR-1–FR-5)
- [ ] Pass check_spec/estimate and current-source impact before editing. (FR-1–FR-5)
- [ ] Implement validated reactive preference module and focused tests. (FR-2, FR-3)
- [ ] Add Automatic/DeepSeek resolution, scoped Response style menu and Settings editor. (FR-1, FR-2, FR-4)
- [ ] Reuse and verify input-driven follow repair and checkpoint/layout/streaming cases. (FR-5)
- [ ] Run focused checks, review diff and graph changes; record receipts. (FR-1–FR-5)
- [ ] Commit/push, coordinate PR/release and verify supported local update; checkpoint before restart. (FR-1–FR-5)

## 需求覆盖矩阵

| Requirement | Implementation | Verification |
| --- | --- | --- |
| FR-1 | Style choices and renderer | Explicit DeepSeek/Transcript/Automatic render cases |
| FR-2 | Resolver and exact identity | Precedence, provider/model/chat isolation and reset |
| FR-3 | Storage and events | Legacy migration, corrupt data, session fallback and mounted subscribers |
| FR-4 | Menu and Settings editor | Scoped controls, source labels and unchanged route |
| FR-5 | Follow repair | Streaming, clicks/checkpoints, layout, input pause and resume |

## 文件变更清单

chat-response-style.ts; ResponseStyleSettings.tsx; AgentOrchestratorChat.tsx; ChatSettingsPage.tsx; chat-reply-plan.ts; ChatReplyPlan.tsx; focused style/scroll/render tests; this specification. No unrelated files, provider credentials or private artifacts.

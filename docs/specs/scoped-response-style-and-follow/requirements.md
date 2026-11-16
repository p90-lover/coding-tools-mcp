# Scoped response style and latest-response following

## 功能概述

Fix the Response style action not updating all open chats. Add global, provider, exact-model and per-chat presentation defaults, including DeepSeek as an explicit choice. Keep streaming output in view instead of anchoring at an old checkpoint, while preserving intentional reading of older messages.

## 需求列表

- FR-1: The application SHALL offer Automatic (model default), DeepSeek, Transcript, Plan card, Step timeline, Focus and Cascade. Styles change rendering only, not the model, provider, instructions or output text.
- FR-2: The application SHALL resolve chat override > exact provider/model override > provider default > global default > Automatic. Automatic keeps the current DeepSeek-model appearance and transcript for other models. Explicit choices override model-name heuristics.
- FR-3: The application SHALL persist validated preferences on this computer, migrate the old global style, and notify every open pane/window. Wider defaults preserve narrower overrides. Reset-to-inherited and effective-source labels SHALL be available. Storage failure SHALL retain a session choice or report failure without claiming persistence.
- FR-4: The chat menu SHALL contain Response style with chat/model/provider/global scope actions. Settings SHALL provide a Response style page with global choice and provider/model rules. Provider identity SHALL isolate CPA subproviders; missing routes cannot create wildcard rules.
- FR-5: The transcript SHALL follow streamed message/step/DOM growth instantly while following. Clicking work/checkpoints and layout scroll events SHALL NOT pause it. Deliberate wheel-up, touch navigation, scrollbar dragging or navigation keys SHALL pause following. Bottom/jump-to-latest/send/chat switch SHALL restore it. New approvals SHALL NOT steal a paused reader's position.

## 验收标准

1. FR-1/FR-3: Global changes SHALL update all inheriting mounted panes, including DeepSeek panes, without remounting.
2. FR-2/FR-3: Conflicting provider/model/chat rules SHALL resolve in the stated order; reset SHALL reveal current inheritance. Invalid storage SHALL be safely ignored and old valid global picks retained.
3. FR-1/FR-2: Explicit Transcript on DeepSeek SHALL disable model-forced DeepSeek work/approval rendering; explicit DeepSeek on another model SHALL enable it. Automatic SHALL preserve old defaults.
4. FR-4: Rendered controls SHALL save the intended scope without changing the route/model, and SHALL expose the effective source.
5. FR-5: Synthetic input/layout/streaming/checkpoint tests SHALL prove that only deliberate navigation pauses follow, and returning to bottom resumes it.
6. FR-1–FR-5: Focused preference/render/scroll checks, required impact and graph change analysis SHALL pass before commit. Existing valid receipts SHALL be reused; no live provider account requests.

## 非功能需求

No background polling, provider calls or disk logs. Single assistant, no spawned agents. No unrelated worktree edits or unready peer changes. Honor actual permission denials and the old MCP delivery hold. Current standing delivery covers coordinated PR/release and supported local update with checkpoint before restart.

## 依赖关系

Existing React chat/menu/settings components, localStorage and window events, route metadata already in memory, and the existing auto-follow patch5361d72c1. No new package or provider API dependency.

# Completion delivery and next-turn ownership

## 范围
Registered watches actually continue the chat with explicit ownership and discoverable status.

## 需求回链
FR-4, FR-5, FR-6.

## 验收标准（EARS）
1. WHEN a registered watch completes after its parent turn THEN the system SHALL create one real follow-up on the same model/account/permission route.
2. WHILE the parent turn works THEN completion SHALL wait without model polling and deliver after settlement.
3. WHEN Stop/cancellation/disposal/archive/delete or a newer unrelated turn occurs THEN a late completion SHALL not send.
4. WHEN watches finish concurrently THEN serialized delivery SHALL avoid duplicate starts; unknown send outcomes SHALL not be resent.
5. WHEN registration succeeds THEN the model SHALL receive identity/state and guidance that promises alone schedule nothing.

## 涉及文件
agent-orchestrator-workflow.cjs, main.cjs, chat-agent-tools.cjs and workflow tests.

## 不做项
No live install/restart or runtime-loss notification guarantee; existing timed wake-ups remain separate.

## 设计要点
Use sessionChat/followUpSelection/chatSend and a fresh expected-parent fence. No model fallback, command replay or prose-triggered autonomy.

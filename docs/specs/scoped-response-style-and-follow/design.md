# Design

## 概述

Corresponding requirements: FR-1, FR-2, FR-3, FR-4, FR-5.
The old chat menu writes CHAT_STYLE_KEY but updates only local React state. Other panes never subscribe. DeepSeek work rendering separately checks model names and bypasses an explicit style. Follow mode can be stopped by click-driven growth or browser scroll anchoring. Existing commit5361d72c1 has an input-driven repair and regression harness to reuse.

## 技术方案

### Preferences (FR-1, FR-2, FR-3)

Add a pure chat-response-style.ts module with version1 global/provider/model/chat maps. Validate bounded identifiers, style values and own-property lookups. Model keys are JSON tuples of provider plus exact model ID. Explicit Automatic differs from absent/inherit. Migrate the old global key only when no current global choice exists. Keep a per-session fallback on storage failure. Local custom events and native storage events notify mounted consumers and clean up subscriptions.

Resolve chat > provider+model > provider > global > Automatic. Automatic resolves to DeepSeek for DeepSeek model IDs, transcript otherwise. Return source/scope with the style. CPA model routes cpa/provider/model use the CPA subprovider, otherwise route provider_id or stable route prefixes. No provider request is necessary. Use each turn's own route for mixed-model history, and active route for menu/approvals. Memoized transcript depends on the preference snapshot.

### UI (FR-1, FR-4)

Response style in the header contains This chat, This model, All models from provider, and Global default submenus with values/source. Narrow scopes include Use inherited default. Settings adds a Response style page with global choice, provider/model rule editor and existing rules/removal. Presentation-only behavior is explicit; no model switch or route mutation.

### Following (FR-5)

Use the existing imperative following ref, paused synchronously by user navigation rather than geometry deltas or clicks. Follow React turn changes and ResizeObserver growth. Keep smooth jump-to-latest and instant streaming follow. New approvals follow only when already following. Reuse wheel/touch/keyboard/scrollbar and click/layout/streaming race tests.

## 文件结构

- chat-response-style.ts: persistence, migration, identity, resolution and subscriptions (FR-1–FR-3).
- ResponseStyleSettings.tsx: scoped editor reusable in Settings (FR-4).
- AgentOrchestratorChat.tsx: reactive scoped menu, effective per-turn rendering and follow repair (FR-1–FR-5).
- ChatSettingsPage.tsx, chat-reply-plan.ts and ChatReplyPlan.tsx: Settings entry and style choices (FR-1, FR-4).
- Focused preference/menu/render/scroll tests and specification documents (FR-1–FR-5).

## 风险与验证

Main chat/settings exports have UNKNOWN caller sets in the small graph; actual React callers are confirmed in AgentOrchestratorSurface. They are shared components, not unused. The style validator and plan renderer have LOW direct impact. Scoped process discovery is sampled and is not whole-repo proof. Preserve routes, narrowing overrides and model-specific history. Settings changes resize content and must not pause follow. Use synthetic preference/render/input tests, then scoped graph analysis; no provider traffic. Reuse valid receipts and do not reset dirty shared/old auto-follow worktrees.

## 交付与回滚

Use one G-only task branch. Deliver through the authorized coordinated PR/release and supported local update, with checkpoint before restart and account/settings preservation. Failed gates or refused actions remain blockers. Presentation preferences can be reset to inherited defaults without affecting conversations or agents.

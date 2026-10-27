# CodexBridge and Coding Tools session parity

## 功能概述 / Scope

Make the existing native bridge usable for host tools and model-selected chats, and preserve owned native/chat identities across process restarts. The user confirmed that AO, Native Codex and ChatGPT Desktop/GPT Browser are affected. Reuse their shared transport and existing browser conversation registry. Publication and restarting the installed app require a later explicit action.

## 需求列表 / Functional requirements

- **FR-1 (Must): Host tool access.** When the active host supplies computer, browser, connected-app or chat-management tools, the bridge shall discover and dispatch those exact tools and preserve their native approvals and outputs. It shall preserve ChatGPT's available first-party tools alongside local tools. Missing host capabilities shall remain unavailable.
- **FR-2 (Must): Model-selected chats.** When a client starts an owned native chat with an available model and supported effort, the bridge shall use and report that selection for that chat. Later sends shall preserve it. Clients shall be able to read the native model catalog without consuming an inference turn.
- **FR-3 (Must): Durable identity.** When the bridge reconnects to the same approved workspace and dedicated Codex home, it shall restore only its own saved native thread IDs and their model selections using native resume. The existing browser registry shall then recover the ChatGPT URL for that same identity. A restart shall not silently replay the original prompt or renew expired permissions.
- **FR-4 (Must): Stopped-turn recovery.** When an owned AO thread stops or its connection disappears, observation shall settle it as incomplete or recover its saved native thread; it shall not leave an unobservable thread running forever. Chat follow-ups shall reconcile saved active receipts before refusing a new message.

## 非功能需求 / Nonfunctional requirements

- **NFR-1:** Preserve local permission profiles, authentication, request limits, consent expiry and executable verification during recovery. Never restore approvals or automatically replay unknown commands.
- **NFR-2:** Bound persisted state and native model/history pages. Use atomic writes and reject corrupt or mismatched ownership records.
- **NFR-3:** Preserve unrelated worktree changes and existing public fields. Verify with focused native, bridge and desktop checks; report the exact boundary of live validation.

## Acceptance

1. Exact native registry inventory/dispatch tests still pass for browser, app and computer tools (FR-1).
2. Separate native threads retain different model selections through subsequent sends and saved-state recovery (FR-2, FR-3).
3. Restart recovery restores the original thread, does not submit a new prompt, and rejects another workspace or changed permissions (FR-3, NFR-1).
4. A stopped AO thread cannot remain in the running set and prevent all later chat messages (FR-4).

## 依赖关系 / Dependencies

Existing Codex app-server RPC, workspace authentication/policy, native executable, launcher browser host and its thread-to-conversation registry. Host tools and account model access depend on the actual host/account catalog.

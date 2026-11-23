# Runtime > Chats (experimental)

**Chat** still uses Agent Orchestrator (AO) and keeps its existing sessions. **Chats** is a new, separate text-chat surface for the independent Orchestrator. The Electron renderer calls `window.codingTools.runtime.chats` on the main frame. The main process owns the runtime, workspace and provider binding. No operation in this route switches an existing chat's engine or falls back to AO.

## Isolated development use

The tab is visible, but the runtime is disabled in packaged and normal profiles. To activate it, an operator must authorize a separately launched **unpackaged development profile**, a private workspace and the exact model binding. Don't patch or restart a running installation to do this.

Use `--dev-profile` with a fresh `CODING_TOOLS_DEV_HOME` on a suitable data drive. Create `launcher/chats-workspace` inside that profile. Do not share the production profile or copy live AO data or settings. The source host accepts the following explicitly provisioned launch bindings:

| Name | Meaning |
| --- | --- |
| `CODING_TOOLS_CHATS_SOURCE` | Absolute path to the trusted independent Orchestrator checkout containing `src/chats-provider.cjs`, contract version 1. Pin and record its source commit. |
| `CODING_TOOLS_CHATS_PROTOCOL` | `openai-completions`. No other protocol is supported in this pilot. |
| `CODING_TOOLS_CHATS_ENDPOINT` | Approved no-cost, log-compatible API base URL, without a credential, query, fragment or `/chat/completions` suffix. HTTPS is required except on explicit `127.0.0.1` loopback. |
| `CODING_TOOLS_CHATS_MODEL` | Exact model ID on that endpoint. No default model/account is selected. |
| `CODING_TOOLS_CHATS_TOKEN` | Optional credential from an approved local binding. Do not put it in source, a command line, chat or logs. The host removes it from the process environment before starting other services. |

**Open native Chats** opens only the dedicated worker-owned `launcher/native-chats` store. Only pressing **Send** may call the bound model. Pending input stays in the editor until the native transaction commits; loss of the response exposes **Check receipt**, which never resends. Draft typing is kept in the open view, not durable across an app restart. An accepted transcript is stored separately from AO. Model context is bounded and in memory; reopened native conversations are read-only, not automatically reattached. Use **New chat** for a new provider session. The pilot does not support attachments, Team, tool execution, steering or confirmed remote cancellation.

## Verification

Use the independent `tests/chats.test.cjs` for disposable SQLite, exact input identity, no replay, scope checks and a deterministic loopback provider. The app's `desktop-electron/tests/native-chats-host.test.cjs` checks the separate navigation and narrow IPC route. These checks, and a synthetic Preview, do not establish authorized live model or installed app parity. No AO runtime, build or storage dependency is being removed in this slice.

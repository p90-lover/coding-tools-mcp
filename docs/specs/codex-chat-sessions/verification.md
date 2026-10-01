# Codex chat-session reader verification

Date: 2026-09-28. Local implementation, installation and MCP readback passed. Remote ChatGPT connector refresh is awaiting the user's response; no remote end-to-end call is claimed.

## Findings before implementation

The installed native MCP catalog had ten tools, none providing saved Codex session discovery/list/read. The existing current-turn rollout reader supplies authenticated execution context, `codex_agent_read` reads an owned live native connection, and `history_session_*` reads Coding Tools' separate Markdown archives. The upstream AO transcript/history adapters are not this MCP browsing API.

## Implemented boundary

- `runtime-web/src/codex-chat-sessions.ts`: canonical active/archive discovery, metadata/visible-message pagination, scope checks and common-secret filtering.
- `runtime-web/src/adapters/chatgpt-web/mcp-server.ts`: one authenticated native/safe tool, `codex_chat_sessions`, with discover/list/read; existing activity leases are retained.
- `runtime-web/src/config.ts`: optional local scope type only. The shared parser was not changed; absent/unknown scope remains workspace-only in the reader.
- The user's approved all-project scope is saved in `C:/Users/simon/.coding-tools/config.json`. Private comparison verified every other setting unchanged. No Codex config, provider credential, proxy setting or source transcript was modified.

## Test evidence

1. The new real-MCP integration test first failed because the tool was absent. Native and safe variants now pass on the installed Bun 1.4.0: **2 tests, 130 assertions**. They cover authentication, workspace/all scope, active/archive pages, UTF-8 fragments, hidden-record omission, credential filtering, symlink/traversal rejection, growing incomplete logs, replaced files and unchanged transcript contents.
2. Additional failing cases caught raw invalid timestamp metadata and HTTP cookie/Basic-auth credential leakage before correction.
3. The affected outer-native stdio contract test passes. Its expected catalog now includes the already-installed Coding Tools tools and the new reader. Public contract hash: `4912226d6dbfe351ceae176642832059980956d7fbcbe0db8007b8d2b451dc09`.
4. `bun run typecheck` exits 0. Only focused mission-relevant tests were run; this is not a whole-repository regression claim.

## Installed and live-local proof

Normal non-DEV Coding Tools was restarted; Codex stayed open. Runtime bundle: `166742f94b3e516c606b22561061bd9ad58fc58ddfbdd8bad3b2193f4aabb875`. CLI SHA-256: `2999a6e380098a36cd2a5eeb82984a47f958c3780e8b024f1ced37686033c044`. The browser helper remained byte-identical.

The virtual baseline build matched the installed files before each update. The installer verified copied hashes in both the program and active-version runtime directories. Recoverable backup: `aiTemp/Trash/codex-sessions-secrets-selectors-20260928-082035`.

A real MCP SDK connection to the installed CLI, using a temporary local test broker, discovered:

- Codex home: `C:/Users/simon/.codex`
- Active chats: `C:/Users/simon/.codex/sessions`
- Archived chats: `C:/Users/simon/.codex/archived_sessions`
- Complete readable catalog: **1,809 sessions**
- Two consecutive pages from an actual current-project chat: **2,048 text bytes**, without printing private bodies. No model requests were made by the probe.

Artifacts: `aiTemp/work/codex-sessions/live-verification.json`, `scoped-runtime-verification.json`, and the corresponding local smoke scripts. The installed tools/list now exposes eleven tools including `codex_chat_sessions`.

## Release and review notes

The current source CPA pin is 8.0.2, while the installed/staged application base pins 7.3.7. Full current-source package verification therefore failed its CPA-version gate. No failed full package was installed. This was a runtime-only patch: the installed application's own CPA pin/payload was independently verified, and every non-runtime package component matched the installed baseline. CPA and its source changes were preserved.

GitNexus traced MCP registration through the CLI with LOW impact. The newly created reader was not indexed (UNKNOWN); source search confirmed its only production consumer. The optional managed graph installer failed; the existing GitNexus CLI remained usable. Inline review checked path/identity bounds, authentication before file access, local-only scope opt-in, read budgets/cursors, hidden-content omission and no transcript mutation. No independent subagent review or Git commit/push was performed.

This ongoing chat still advertises its previous loaded six-tool Native2 surface. The user has been asked to approve refreshing the existing connector's tools, including previously installed workspace/AO entries. No connector, tunnel, authentication or tool-approval setting has been changed.

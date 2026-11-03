# Editable Browser address navigation

## Report and root cause

The Browser surface shown in the user's screenshot rendered `.browser-address` as a globe plus a text span. It had no input or submit handler. Its existing preload/main IPC forwarded `navigateBrowser` to the BrowserHost method, whose helper accepted only Back, Forward and Reload. This is a missing navigation path, independent of the page's Cloudflare/loading state or VPN.

The unrelated standalone `GptBrowserSurface` already has its own address field; the old closed rescue PR #851 targeted that component, not this screenshot's BrowserSurface. This patch is based on main `5806f3f82a2133242f7b02a36f712f88e75d692a`, reusing the existing task source workspace without modifying the shared dirty checkout.

## Fix

- A small BrowserAddressBar component replaces the read-only label. Focus selects the full URL; Enter submits through the existing preload IPC; Escape restores the displayed location. URL text is retained while background browser snapshots arrive. IME Enter does not submit.
- Bare domains default to HTTPS; explicit HTTP/HTTPS URLs preserve path, query and fragment. Non-web schemes, empty/malformed URLs and embedded credentials are refused before loading.
- Each address submission carries the actual WebContents identity from the snapshot. A tab, account or auth-view change rejects the stale request instead of navigating another page. The editor is keyed by this identity to discard another target's draft.
- Existing automated-turn and manual-operation locks remain. Separate user tabs retain their existing ability to navigate while an automated turn runs elsewhere.
- Pending page loads do not disable URL editing. A different address can replace a stalled load, duplicate submissions of the same pending draft are ignored, and an older completion/error cannot erase newer input or affect a remounted editor.
- No privilege, WebContents sandbox, popup policy, TLS policy or external-protocol handler was weakened.

## Verification

Five of the first six regression checks failed against the original source; unsafe schemes were already refused only because every URL action was unknown. With the repair, all ten focused tests pass, covering the actual component handlers and host method through the existing navigation helper.

The four affected suites pass **222 tests, zero failures**: browser host (including standalone-host behavior), address navigation/editor, browser-surface IPC and renderer wiring. The renderer TypeScript check and production Vite build pass. The build retains the existing unresolved `$app/tsconfig` and large-chunk warnings. Fake Electron and dummy URLs were used; no user account or installed browser was navigated.

The browser MCP tools are disconnected in this session, so an interactive Preview/visual comparison and installed-app navigation are not verified. No installation, patch, restart or live conversation mutation was performed. The optional gentest helper command was declined and not retried; regression tests were written and run directly instead.

## Impact and limits

The repository graph is 1,460 commits behind the shared checkout. Pre-edit impact reports BrowserSurface LOW, navigateBrowser LOW/lower-bound, BrowserHost.navigate UNKNOWN and BrowserHost.snapshot CRITICAL/lower-bound (67 symbols, including IPC startup and turn-content event flows). The snapshot change is one additive field. Current source confirms `launcher:browser-navigate` calls the host method and the preload passes the action unchanged. UNKNOWN is not treated as unused; the CRITICAL snapshot warning is not waived by the small diff or passing tests. New component/helper/test symbols are not yet represented in the stale index.

Final `detect-changes --scope all --limit 2000` inspected exactly eight task files without a capped/partial warning: ten mapped symbols, zero affected processes, LOW reported risk. Several current hunks map to obsolete symbols such as SetupSurface/signalManualTerminal rather than their actual current owners. This is not a clean safety result and does not waive the CRITICAL snapshot warning. Source review and the 222 passing checks supplement, not erase, that limitation.

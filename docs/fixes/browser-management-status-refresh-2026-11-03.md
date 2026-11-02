# Browser management status and unwanted refreshes

## Confirmed defects and fixes

- Authentication probing required a new-chat composer, so an authenticated saved conversation could be reported signed out. Session authentication now stands on verified session evidence; turn preparation still owns its own surface-readiness checks. Explicit login continues to normalize its destination as before.
- A saved-session refresh navigated any non-new-chat page back to the homepage. Verification now preserves an existing ChatGPT page and opens ChatGPT only from idle/off-origin content.
- A probe started for one account could complete after the host switched to another account. Its result is now fenced to the same WebContents, partition, and document URL, including explicit login handoffs.
- Automatic Cloudflare recovery checked for running work before a delay but not after it. A task, inspection, account switch, or navigation could take ownership meanwhile and still get reloaded. Recovery now rechecks ownership and busy state before loading and before publishing its result. An abandoned recovery does not leave a false loading state or overwrite a newer task's error/status.
- Any healthy backend response rearmed automatic recovery, including responses unrelated to the blocked endpoint. Mixed healthy/challenged requests could therefore keep reloading the page. Recovery now has one attempt per externally navigated document; its own reload and SPA routes do not reset that budget. Only a successful response from the challenged endpoint proves recovery.
- Management treated the active page's false/unavailable authentication result as authoritative over its partition's saved sign-in evidence. It now uses the same per-partition evidence as other accounts and preserves unknown status. This is a saved-session indication, not proof that a live provider request will succeed.
- Tabs missing an explicit account ID were attributed to the account on screen. Their native thread's binding now determines the owner; unknown other-account tabs are not invented as active-account tabs.
- Session inventory reads could overlap, update a superseded/hidden page, and miss same-count account replacements or tab rebindings. The new single-flight poll refreshes on account/tab identity, stops while this page is inactive, and ignores late results after cleanup.

## Verification

- Ten intended assertions failed before the fixes; the initial host test fixture needed a writable override for the host's derived `activeTraceId` getter before it exercised the real failures.
- Final selected browser/account/workspace/readiness/IPC/proxy/thread suites: **292 passed, zero failures or skips**. Includes failed inventory-read retry, no overlap/stale publication, saved-page authentication, owner transfer, delayed recovery races, endpoint-specific recovery evidence, and bounded reload behavior.
- Desktop TypeScript, backend syntax, and task whitespace checks pass.
- Real React management component rendered in an isolated offscreen Electron fixture using synthetic accounts only. Verified two partition sign-ins, one unknown account, one native task on the second account, stable overview after an authentication update, and no renderer errors. Screenshot inspected. No live account, session token, or provider request was used.
- Current-source scoped GitNexus impact marks authentication probing **CRITICAL** through login/logout/startup consumers. Recovery is LOW; some management/IPC outer callers are UNKNOWN and were checked in current source. Change analysis covers both production files without partial/truncated result flags; flow-catalog bounds and newly added helper edges remain limits, not evidence of unused code.

## Scope and limits

The PR does not claim every external account/plan/connector field has been live recaptured. Existing strict workspace/plan metadata validation and manual-mode inspection restrictions are unchanged. A task's existing one-time stale-connector-catalog recovery is also unchanged; the fix prevents the confirmed idle-home recovery loop and ownership races, not all justified navigations.

No installed app patch, install, restart, live database read, or account/proxy mutation was performed. Prior local auto-review and message-tick changes are excluded from the PR.

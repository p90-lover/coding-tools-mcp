# CPA panel quota refresh pacing

## AI Studio authentication

The same Google account can sign into AI Studio, but an existing Antigravity OAuth credential is not a supported AI Studio Build relay login. CPA's native AI Studio executor sends requests through a connected WebSocket relay session, identified by its session auth ID; it does not use the Antigravity OAuth credential as a replacement. The Build relay must be signed in and running. This change does not refresh, convert or migrate OAuth tokens.

## Request delay

The injected CPA panel script now shares a single queue between native quota `/v0/management/api-call` XHR requests and its Codex credit-usage fetches. Only one of these upstream reads runs at once. The next starts **2 seconds after the previous request finishes**, including failures. Queue waiting does not consume the native request's transport timeout.

- Cached quota answers remain immediate.
- Native quota requests made by a manual refresh also use the queue, while retaining their existing cache-bypass behavior.
- Non-quota management operations, sign-in and model inference are not queued.
- Cancelled queued XHRs are not sent; cancelling an active request releases the queue.
- Credit fetches receive an eight-second transport timeout so a failed connection does not indefinitely block the queue.
- The existing two-minute refresh cycle and five-minute cycle after a 429 remain unchanged. These cycle intervals are separate from the gap between individual requests.

The app-launch environment variable `CODING_TOOLS_CPA_QUOTA_REFRESH_DELAY_MS` can override the gap, for example `5000` for five seconds. Values from 250 through 60000 milliseconds are accepted; invalid values fall back to 2000. Code callers/tests may also pass `{ refreshDelayMs }` to `quotaPageScript`. No installed app configuration or live CPA state was changed by this patch; a rebuilt application must use the patched module for the change to take effect.

## Verification and limits

The focused VM tests reproduced the missing pacing before the fix (5 failed, 2 passed). After the fix, 58 targeted tests passed across `cpa-panel-refresh-delay`, `cpa-panel-session`, `cpa-quota`, `cpa-usage` and `cpa-provider-usage-bridge`. They cover serialization, completion-to-start timing, failure recovery, abort/reopen behavior, cache replay, non-quota bypass, configuration, the shared credit/XHR queue, authentication scoping and 429 backoff. Node syntax checks and the scoped whitespace check also passed.

This establishes and fixes missing request pacing. It does not prove the cause of the screenshot's separate eight-second manual reset-expiry failures, and it does not claim those failures or a live Google-account generation are resolved. No live browser/app check was available during this follow-up.

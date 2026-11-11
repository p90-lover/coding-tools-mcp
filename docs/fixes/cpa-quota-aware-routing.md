# CPA quota-aware account routing

Coding Tools bundles CPA Helper 0.2.0, built from merged source [`0b7178b8b46ededfd7cf67fd0bdb1df11a99a68f`](https://github.com/p90-lover/cpa-helper-plugin/commit/0b7178b8b46ededfd7cf67fd0bdb1df11a99a68f).

Previously, CPA Helper displayed quota and offered an optional account keeper, but did not register a native request scheduler. An ordinary Codex model request without an explicit Provider Manager route therefore did not use those quota readings to choose an account.

The helper now registers `scheduler.pick`. Among the compatible accounts CPA supplies, it prefers the account with the most remaining quota in its most-constrained five-hour or weekly window. Confirmed exhausted windows are skipped; when both windows are exhausted, their later reset determines that account's known recovery time. Expired readings require a fresh check and are not assumed to be full.

## Boundaries

- CPA's model/provider eligibility, disabled state and cooldown filtering still apply. Explicit account pins and the highest eligible priority tier remain binding; the helper does not silently cross those restrictions.
- CPA continues to own upstream 429/retry/cooldown handling. Quota selection cannot guarantee that the provider will accept the next request, and it never replays inference or a partly delivered stream.
- Explicit Provider Manager model routes keep their existing ownership. Other providers retain their existing routing; unknown quota is not invented from a different provider's limits.
- Missing, stale or failed quota is unknown. An all-unknown pool delegates to CPA; an eligible unknown account can be a fallback when measured accounts are exhausted.
- A bounded background refresh reads at most four due enabled Codex accounts per pass, with one-minute successful and five-minute failed-check backoffs. Request selection itself performs no credential reads, network requests or file operations. A nonblocking snapshot avoids waiting for keeper persistence.
- `quota_routing_enabled: false` opts out of both automatic selection and its quota refresh. The optional keeper remains separate and disabled by default. Automatic routing does not change account priorities or disabled flags.

## Bundled artifact and verification

The Windows x64 artifact is `cpa-helper-v0.2.0.dll`, 850,432 bytes, SHA-256:

```text
b7e780535ef0ceb998cfba94ed482a8a2a53957b5cc4d6f66c15ce03432769a3
```

The helper's 40 Rust tests, strict all-target Clippy, release build and five actual Windows DLL ABI smoke checks passed. App integration tests check the installed DLL against the bundle's hash, size and source provenance, replacement of an older checked helper update, preservation of a newer checked update, and recovery after a newer file is modified.

Publishing or bundling this artifact does not authorize installing over or restarting a running app. No live inference, account sign-in, runtime patch or restart was used for this verification.

# Fast mode: design

## Data path (mirrors the reasoning effort)

Renderer route `fast_mode?: true` → `chat_send` single route (`allowed`, `SINGLE_ROUTE_FIELDS`,
`ROUTE_IDENTITY`) → headless run store `Route.fast_mode: Option<bool>` (Some(true) only, AO
harnesses only) → `aoLaunchArgs` → `harnessService().spawn({ fastMode })` → AO
`POST /api/v1/sessions { fastMode: true }` → `AgentConfig.FastMode` → driver:

- Codex app-server: `serviceTier: "fast"` on `thread/start` and `thread/resume`.
- Claude ACP: `options.settings.fastMode = true` (Agent SDK flag settings), direct sign-in only;
  AO clears it for a gateway Claude session.

`aoLaunchArgs` sends it for Codex (native or CPA) and Claude Code on a direct sign-in; any other
route carrying it launches without it and logs `ao.fast_mode_dropped`.

## Capability

`modelCapabilities` sets `fast: true`:
- Codex own models: AO's `supportsFastMode` (Codex catalog `serviceTiers` / `additionalSpeedTiers`).
- CPA models on Codex: the CPA catalog's `fastTier` (`cpaFastTier`: listed fast/priority tier, or
  provider `codex`).
- Claude Code own models: `claudeFastModel(model)`.
`routeTuning` returns `fast` (never for Native Codex). `withTuning` drops `fast_mode` on a model
change; `tunedRoute` restores the saved pick or the provider default.

## Provider default

`provider-network.json` gains `fastMode: { "codex-oauth"?: true, "claude-oauth"?: true }`
(same store version; unknown/false entries dropped on load). IPC `launcher:provider-fast-mode` →
`store.setProviderFastMode`. The composer reads the snapshot once and follows
`onProviderNetworkChanged`; `fastProvider(route)` maps `ao:codex` → `codex-oauth`,
`ao:claude-code` → `claude-oauth`.

## UI

- Provider Manager (`ProviderCenterSurface`): a switch under the provider's badges, Codex and
  Claude only, with a tooltip stating where it works.
- Composer effort chip: a `role="switch"` Fast row under the efforts; the chip reads
  "High · Fast" when on.

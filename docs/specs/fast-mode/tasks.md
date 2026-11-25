# Fast mode: tasks

- [x] AO: `fastMode` on spawn, `AgentConfig.FastMode`, persisted for resume; Codex `serviceTier`;
      Claude Code `fastMode` setting (direct sign-in); `supportsFastMode` from Codex's catalog
      (branch `feat/fast-mode` in p90-lover/agent-orchestrator).
- [x] App: route field in every route list, launch arg, model capability, CPA fast tier.
- [x] Composer: Fast switch in the effort menu, per-model saved pick, provider default.
- [x] Provider Manager: "Fast mode for new chats" switch on Codex and Claude, stored in
      provider-network.json.
- [x] Rust run store: `Route.fast_mode` (AO harnesses, Some(true) only).
- [x] Claude Code model eligibility (`claudeFastModel`): Opus only; through CPA via
      `CLAUDE_CODE_EXTRA_BODY` on Anthropic upstreams.
- [ ] Tests: app focused suites, AO focused packages, Rust (CI).
- [ ] Deliver: AO PR on the fork, app batch with the AO pin, release, local update.

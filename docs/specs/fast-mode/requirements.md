# Fast mode: requirements

User request (2026-11-25): add fast mode for Codex and Claude, which support it, in the Provider
Manager, and add fast mode to the effort level.

User decisions:
- Provider Manager: a "Fast mode for new chats" switch on the Codex and Claude provider rows. It
  sets the starting value for new chats on that provider's models; the effort menu overrides it per
  chat.
- Codex models reached through CPA get fast mode too, where CPA passes the tier on (it does:
  CPA 8.1.2 maps `service_tier: "fast"` to OpenAI's `priority` for its Codex upstream).

Requirements:
1. The composer's effort menu shows a Fast switch only for a model that can run fast:
   - Codex: a model whose Codex catalog lists a fast service tier, or a CPA model served by CPA's
     Codex upstream (or whose CPA entry lists a fast/priority tier), on the Codex harness.
   - Claude Code: a Claude model on a direct Claude sign-in. Behind a gateway Claude Code turns
     fast mode off itself (`not_first_party`), so CPA Claude models never offer it.
2. Fast on adds `fast_mode: true` to the chat's route; off removes it. Routes without it compare,
   warm, serialize and fingerprint exactly as before.
3. Changing fast mode on an open chat behaves like an effort change: the next message starts a new
   agent with the chat so far. An automatic fit never adds fast mode to an open chat's agent.
4. Each model remembers the person's explicit pick (on, or off); with no pick, the provider's
   Provider Manager default applies to a new chat.
5. AO launches carry `fastMode: true` only where it can work; AO applies Codex `serviceTier:
   "fast"` and Claude Code's `fastMode` flag setting.
6. The Provider Manager setting survives restarts, writes only when it changes, and keeps only
   known providers' `true` entries.

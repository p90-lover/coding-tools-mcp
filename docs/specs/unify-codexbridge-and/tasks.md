# Tasks: CodexBridge and Coding Tools session recovery

- [x] Discover and dispatch only the exact host tools exposed to the current chat; keep the public tool-list contract unchanged.
- [x] Allow a new native chat to select its model and effort; retain those choices on later sends.
- [x] Persist scoped native identities, selected models and bounded request receipts without replaying prompts or approvals.
- [x] Restore only the original unexpired grant and authentication scope; preserve its absolute deadline and request budget.
- [x] Reconcile saved native/AO receipts before treating persisted running state as liveness.
- [x] Make automatic startup observation independent of retry and grant-creation workflows.
- [x] Make Stop revoke recovery before publication, during initialization and after load, including legacy saved scopes.
- [x] Reject stale attempt observations and coordinate connection retirement with reservation.
- [x] Preserve complete bounded answers after recovery and allow newly approved configuration/model changes.
- [x] Add focused regressions for session identity, ownership, models, grants, Stop and receipt reconciliation.

## Focused verification

Run from the repository root unless a working directory is shown:

```text
node --test desktop-electron/tests/agent-orchestrator-workflow.test.cjs desktop-electron/tests/browser-host.test.cjs desktop-electron/tests/codex-chat-lifecycle-sync.test.cjs desktop-electron/tests/bridge-auth-startup.test.cjs
cd runtime-web && bun test tests/chatgpt-web-harness.test.ts tests/retained-compaction.test.ts
cargo test --lib --offline --locked --no-default-features --manifest-path src-tauri/Cargo.toml --target-dir aiTemp/session-check-target -- codex_bridge:: integrations::ao:: --test-threads=1
cargo check --offline --locked --manifest-path rust-core/coding-tools-headless/Cargo.toml --target-dir aiTemp/session-check-target
```

The opt-in native restart regression uses an explicitly selected native executable and a synthetic loopback provider. It checks the original thread IDs, different models, stored receipts, request budget, absolute grant deadline, follow-up model and Stop revocation without account inference.

## Delivery boundaries

This is a source change. Installing or restarting the packaged application is a separate action. Tool access remains subject to the host's supplied capabilities and local permissions. Recovery resumes saved identities and observes existing results; interrupted work waits for explicit continuation. Previously lost ephemeral history cannot be recreated.

An explicitly approved Connect with a different executable, home or permission/reviewer scope archives the previous journal before creating a fresh one. Automatic recovery cannot replace that scope. Superseded terminal ownership in a dedicated AO role home can be retired when its model changes; native rollout history remains on disk.

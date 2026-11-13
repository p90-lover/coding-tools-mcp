# Tasks: Silent chat continuations

## Implementation

- [x] Lock the confirmed silent behavior and preserve real user sends (FR-1).
- [x] Persist typed controller context and validate its captured parent (FR-2, FR-3).
- [x] Bind controller context into prompts and grants without truncating user instructions (FR-2, FR-3).
- [x] Migrate Goal, Wake, watches, loops and schedules to internal continuation dispatch (FR-1, FR-3).
- [x] Register and wire the dedicated Continue action (FR-1, FR-3).
- [x] Preserve message pairing and continuation descendant ownership (FR-2).

## Verification and delivery

- [x] New focused Node regressions for history, typed sends, Continue admission and handler routing.
- [x] Preview interaction of actual renderer control/helpers against an offline fixture.
- [x] Scoped Rust formatting and JavaScript syntax checks.
- [x] Existing automatic-trigger and guard regressions updated and verified.
- [ ] Required native compilation and CI integration gates passed.
- [ ] Task-scoped source merged and included in a verified published release.

No full local suite or installer build is required separately for this task. Honor the repository's required CI/release gates, coordinate one release owner and do not install, patch or restart the running app without a separate request.

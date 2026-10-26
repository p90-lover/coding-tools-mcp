# WebGPT continuation prompt recovery

## Continuation invariant

A selected ChatGPT connector does not prove the composer is empty. Before attaching a new prompt, the worker must inspect the owned editor, clear any previous draft through the verified native cleanup path, and reselect the exact connector if cleanup removed it. An empty composer with the correct connector selected can be reused immediately.

## Failure boundary

Prompt insertion appends after the selected connector. Reusing a failed draft would therefore combine old instructions with a new continuation. Exact prompt verification must still reject any combined or truncated input before Send; disabling that guard is not a recovery strategy.

A large continuation prompt by itself does not show that summary generation failed. Prompt attachment, remote compaction and trusted environment resolution have separate success conditions.

Native rollout recovery and pre-turn compaction tests protect the separate trusted-`cwd` boundary. Recovery must never derive filesystem permissions from arbitrary history or another chat.

## Verification

- `runtime-web/tests/composer-insert.test.ts` exercises real selection and attachment methods with a large failed draft and verifies exact replacement.
- `runtime-web/tests/browser-worker-contract.test.ts` covers empty selected connectors, native cleanup, cancellation, attachment integrity and compaction retry boundaries.
- `runtime-web/tests/environment.test.ts` and `retained-compaction.test.ts` protect native authority and context continuity.

Source tests do not validate or update an installed Coding Tools build. Until the fixed build is installed, an affected chat can use an available working provider when the user authorizes that change.

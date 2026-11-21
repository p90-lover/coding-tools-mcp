# Durable input recovery: accepted input is not a new draft

Status: verified host-side regression fix on the native-Orchestrator development branch. This is not native-engine parity, an installed-app check, or authorization to remove AO.

## Observed incident

The actual `AgentOrchestratorChat` component was served in the supported Preview pane with the real isolated `chat-input-service` SQLite journal and a deterministic host-receipt fixture. No provider, production settings, or live AO database was used.

1. Submit a message and commit its input ID to the journal.
2. Let the fixture accept the host run, then lose its acknowledgement.
3. The composer restored the already accepted message as editable text; the journal separately showed `Delivery unknown`.
4. Reload the renderer, then recover the original receipt.
5. Press ordinary Send on the restored text. A different input ID and another host execution were created.

The duplicate was not a transport retry. It arose because accepted outbox data was converted back into a fresh draft after the renderer lost the in-memory submission association.

## Correction

When a durable input ID and pending-input recovery are available, a delivery failure leaves that input in the outbox instead of restoring or prepending it to the composer. Newer typing is preserved. Failure before acceptance still keeps the composer editable. Legacy callers without pending-input recovery retain their prior restoration behavior.

A queued pending input is hidden only when the current chat queue already represents its exact input ID. An unrelated queued entry must not hide its recovery controls. No message-text matching is used for this decision.

## Verification

- `node --test --test-isolation=none --test-concurrency=1 desktop-electron/tests/chat-input-delivery.test.cjs`: six passed, exit 0, Node 26.12.1. The test executes the actual extracted delivery callback and covers failed acceptance, lost acknowledgement, newer typing, exact-ID recovery, legacy callers, and queued-card identity.
- Existing `ao-chat-ui.test.cjs` with `--test-name-pattern="an unsent draft"`: one passed, exit 0.
- `node desktop-electron/node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false --project desktop-electron/tsconfig.json`: exit 0. A previous invocation used the absent root-level TypeScript path and failed before typechecking; that invocation is not a pass. The later simplification only removed a redundant notice branch and restored the original notice-clear expression; the six focused cases were rerun on the final patch.
- Preview: queued input survived renderer reload; sending it preserved newer typing. Lost acknowledgement showed `Delivery unknown`; after the fix the composer stayed empty across reload, receipt recovery did not add an execution, and newer typing remained. Unknown input had no discard button. Queued input could be discarded. Failed pending reads showed an error and a working Retry action. An injected draft-write failure showed `Not saved` and retained the text.
- Preview fault injection deliberately returned HTTP 400. Hot reload emitted duplicate `createRoot` warnings in the scratch harness before explicit renderer reloads; these are not reported as a clean console or as native runtime failures.

The isolated UI harness is a local task fixture, not a product integration or supported native provider implementation. Host-receipt fixtures are in memory; this run proves renderer-reload behavior, not process-restart receipt persistence. Earlier SQLite/Rust persistence receipts remain separate evidence.

## Scope and outstanding gates

Pre-edit GitNexus impact for `deliver` was CRITICAL: five direct callers and six affected processes, including submission, queue dispatch and Send now. Verification is deliberately limited to the changed behavior; no full-product all-clear is asserted.

The development baseline is host commit `d444f4188` on `refactor/orchestrator-handler`. A non-mutating merge check against `origin/main` at `976958a4f` found conflicts in `agent-orchestrator-workflow.cjs`, `main.cjs` and `AgentOrchestratorSurface.tsx`. No conflicting merge was applied.

The independent native adapter remains experimental. Real provider/tool/permission/steering/history compatibility, supported installed-chat invocation, offline history import and rollback, AO-free packaging, security/CI and coordinated publication remain unfinished. The native evidence register already exists at `docs/reliability-evidence.md` in the companion repository; the specified history importer and migration tests do not yet exist. Synthetic tests cannot replace these gates.

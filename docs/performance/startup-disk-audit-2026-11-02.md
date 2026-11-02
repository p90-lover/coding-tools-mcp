# Startup and disk-work audit — 2026-11-02

Baseline: `73ab7c3d` (current main when this audit began). Changes target the Electron app's active launch and persistence paths; they do not patch the installed app or change conversation storage.

## Method and coverage

- Inventoried all 137 tracked Electron CommonJS modules. A literal scan found 163 synchronous filesystem sites across 59 files. This is a search inventory, not proof that every site is a hot path.
- Scanned native filesystem sites across the Rust/headless sources (41 matching files, including tests). Did not equate test fixture reads, user-requested file operations, or durable saves with avoidable polling.
- Traced the launch coordinator, runtime manifest and checksum checks, version-copy transactions, retention cleanup, logging, state writers, backend bundle polling, and native-service launch guards.
- Used small throwaway bundles and instrumented filesystem operations. Tests run serially at Below Normal CPU / Low I/O priority on the same drive as the project; all temp roots are explicit. No live database was opened.
- The graph index is stale. Graph context/impact was attempted, but new helpers were unresolved; current source references and regression coverage supply the missing evidence. An empty graph result is not a safety clearance.

## Confirmed causes and changes

### 1. Two complete checks on an unchanged launch

`main.start` awaited `waitForPackagedRuntimeSource`, then awaited `ensurePackagedRuntimeAsync`. The first call walked the packaged source even when the installer needed only its manifest and could run a whole installed copy. It discarded the useful preflight result.

The launch now calls `preparePackagedRuntime` once. It preserves bounded retries for incomplete package materialization, validates the installed bundle against this package's manifest, and checks/copies the source only when needed. Device/copy/rename failures are not retried as materialization failures or repeated synchronously on main.

Warm-launch operation budget: one installed-tree check, no packaged-source walk, no copy, and no checksum payload reads when the existing stat signature is unchanged. The fixture verifies **40 → 20 file-stat checks**, and **one → zero source walks**.

The inspected installed manifest contains 6,149 files totaling 200,122,541 bytes; the largest file is 115,281,496 bytes. Avoiding one redundant source check removes thousands of metadata operations. This is not a claim of a measured 50% wall-clock launch improvement.

### 2. A third installed-copy check after a successful move

A first installation checked the staging tree, checked the moved destination, then checked that same destination again after cleanup/directory chmod. The last operation did not change runtime file contents.

The transaction now returns the already validated moved root. Source checks, staging checks, **post-move validation**, restoration on post-move failure, side bundles for busy runtimes, and the verified-source ENOSPC fallback remain. The new fixture requires exactly source + staging + destination checks (three tree checks, instead of the previous launch path's five).

### 3. Whole-file checksum buffers

Async hashing previously used `readFile` for each payload, with four hash jobs in flight. A Bun executable alone can exceed 100 MB.

Checksums now consume stream chunks capped at 256 KiB and at the declared file size (minimum one byte), still with bounded hash concurrency. Tiny dependency files do not allocate a full 256 KiB buffer each. SHA-256, file listing, size/mtime/ctime signature checks, path validation and symlink-escape checks are unchanged. A regression prohibits whole-payload `readFile` calls while requiring complete validation to succeed.

### 4. Cleanup competed with startup

Runtime pruning began before the window was created. Its async function initially performed synchronous directory/stat/rename operations, then started all recursive deletions together.

The launcher now schedules pruning 30 seconds after `ready-to-show`. Its metadata/rename operations are async, and old runtime trees are removed serially. Current-version copies, side bundles, the newest rollback version, and fresh temporary folders retain their existing protections. A retirement refused by the OS is never followed by recursive deletion.

### 5. Routine diagnostics wrote continuously

The launcher restored up to 512 KiB of old log content at startup and batched every event into a disk append every 250 ms. This is optional diagnostic work, not state needed to resume a chat.

The app now explicitly uses memory-only launcher activity and stream-error guards by default. Its redacted, bounded Activity ring and event publication remain. **Export diagnostics** writes a sanitized snapshot only after the user chooses a file; its suggested location is the app's data directory, not the OS Documents/temp drive.

For deliberate persistent troubleshooting, launch with `CODING_TOOLS_PERSIST_LOGS=1`; the existing disk logger and tail restore remain supported. The generic logger API's existing default is retained for other consumers. Memory-only activity does not survive process exit; export it or enable persistent diagnostics when history across restarts is needed. This change does not claim that Chromium, providers, or conversation persistence perform no disk writes.

A regression records **zero log filesystem calls for 1,000 memory-only events**, including restore/flush and a failed diagnostic pipe, and verifies bounded storage plus sanitized explicit export.

### 6. Identical durable state was flushed again

The async state writer coalesced bursts to the first and latest request, even when their strings were identical, and rewrote an already committed string later.

It now remembers a string only after both its flushed primary and backup succeeded. Starting another write invalidates that acknowledgment. Primary or backup failures therefore allow identical requests to retry, and a failed newer write cannot make an older remembered value suppress a repair. Mutable Buffers are never deduplicated by reference.

The fixture requests the same state 40 times and verifies **one primary write/flush plus its backup**, then verifies that distinct newer values still land. No initial on-disk file is trusted or skipped because of a value remembered by an earlier process.

## Areas deliberately not changed

- Settings already suppress no-op updates; backend incoming polling is already async and coalesced. Replacing those paths again would add risk without evidence of a gain.
- Native descriptor/token checks, user-requested file reads, migration transactions, durable primary flushes and recovery backups are necessary work, not candidates for blanket removal.
- AO SQLite work needs workload-specific profiling and query-plan evidence. No live database scans, speculative indexes, or submodule changes are included.
- Cross-version runtime deduplication is a separate migration/rollback design. Sharing writable hard links between releases would let damage to one copy affect rollback or a running bridge; it is not a safe substitute for independent verified copies.
- This is a cross-codebase I/O inventory and targeted hot-path audit, not an exhaustive correctness review of every function. It cannot promise the fastest possible launch on every filesystem or under unrelated disk contention.

## Verification

New regression fixtures cover operation budgets, unchanged launches, first installs, same-size content repair, damaged-source fallback, materializing packages, bounded retry errors, ENOSPC fallback, streaming hashes, memory-only logging/export, duplicate saves, primary/backup failure repair, mutable Buffers, and serial nonblocking cleanup with busy-folder protection. Existing integrity, update-recovery, atomic-state and startup/IPC suites are run before PR delivery.

The first broad serial run passed 166 of 168 tests. One wiring assertion still referred to the replaced startup expression; it was updated to assert the awaited preparation still precedes ports/window/browser creation, and all 35 wiring tests passed. An unchanged update-worker child exceeded its existing 30-second timeout under disk load; an isolated rerun passed in 7.7 seconds without changing its timeout or production code.

The final broad run, including one added log-sink wiring regression, passed **168 of 169 tests**. A different unchanged rollback-worker case hit the same child-process timeout; its isolated rerun passed (30.1 seconds for the whole case, which invokes multiple workers). All 169 cases have therefore passed across the final run and isolated rerun, but a single completely green broad run was not obtained under the shared disk load. No worker timeout or production update code was relaxed. Syntax checks for all four changed production modules and the scoped diff whitespace check passed.

After refining stream buffers to the declared size of tiny files, the complete runtime integrity suite and launch-I/O suite were rerun: **27/27 passed**, including the buffer-budget assertion.

Scoped GitNexus change analysis reports eight files and low risk, with no partial/truncated result. Its symbols remain stale, so that result is supplementary, not an exhaustive graph clearance.

An installed-build before/after startup measurement remains a deployment check. No end-to-end launch-time or physical-disk byte reduction is claimed from process I/O counters alone; those counters can include pipes.

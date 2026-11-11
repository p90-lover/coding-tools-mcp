# Agents could not start: AO's writer held for minutes, and the main process frozen on one file read

Two separate stalls on 2026-11-11 (0.8.108 and 0.8.110), both on the busy hard disk.

## 1. AO: cleanup held the single database writer

The running app logged `ao.writer_held` once a minute: `heldMs` 9 275 up to 309 275 with 8 to 14 writes waiting, holder `PruneChangeLogToMaxRows`. Approval answers, messages and session creates queued behind one delete; launches took 5 to 6 minutes, then failed. It came back on the janitor's 15-minute cycle.

AO #28 (agent-orchestrator 30f30365d, pinned here): a background write gives the writer back once a foreground write has waited 750 ms (20 s with none waiting). SQLite rolls the interrupted statement back. The janitor then retries in 1 minute with a quarter of the batch (floor 100) and grows back as deletes finish.

Measured in the running app after a daemon built from that commit was swapped in at 15:58: the longest hold in the next 15 minutes was 3 to 15 s (before: 163 to 309 s), and a launch took 55 s (before: 336 to 393 s). The remaining holds are foreground writes that are slow themselves while cleanup's reads compete for the disk.

## 2. Main process: a start read the proxy settings synchronously

`launcher.main_stalled {"ms":46971,"cpuMs":437}`, blocked in `readFileSync provider-network.json` under `resolveCpaProxyRoute < resolveManagedProxyEnvironment < resolveCrossUseEnvironment`. While CPA's recovery kept restarting it, each start read the saved proxy settings on the main thread. With main frozen no IPC was answered: 34 `launcher.ipc_failed` at once ("Headless request timed out", "HEADLESS_CAPACITY: request admission is full").

The services controller already keeps those routes in memory, read off the main thread whenever the files change. A start now uses that copy (`routeForStart`) and reads the disk itself only when the copy may be behind: never read, a read under way or due, or the folder's watch not in place.

Not changed: the Antigravity CLI launch (`antigravityProxyEnvironment` in main.cjs) still reads the settings synchronously.

## Verification

- AO: new store tests (a write waiting behind a delete that never ends gets the writer; rollback; hold limit; caller cancel is not a yield) and janitor tests (shrink, retry within a minute, grow back). The full `storage/sqlite/store` package passes.
- App: `cpa-outbound-proxy.test.cjs` covers `routeForStart`.

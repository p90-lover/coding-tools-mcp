# AO stability plan (2026-11-11)

Goal: AO (the Agent Orchestrator daemon) stays up, answers quickly on this machine's busy hard disk, and recovers by itself. This plan comes from three read-only audits (AO's SQLite layer, the daemon's lifecycle, the app's supervision of AO) plus the running app's log on 2026-11-11. Each item says where it stands.

One fact drives most of it: AO has **one database writer** on a **slow, nearly full disk**. Anything that holds the writer, or makes the disk busier at the wrong moment, turns into minutes of waiting for every chat. And the app's reaction to a slow AO has been to kill and restart it, which repeats the slow work.

## Phase 1: stop the stalls and the restart loop

| # | Problem | Fix | State |
|---|---|---|---|
| 1 | Cleanup held the writer 163 to 309 s; chat writes waited | Background writes yield to a waiting write, retry smaller (AO#28) | Merged in AO; pinned by #1212; running live (3 to 15 s) |
| 2 | The app killed a daemon that was alive and still starting (90/180/360 s), so the next start redid the work: 5 starts, 28 min | A live daemon is waited for up to 15 min; only a dead or never-ready one is ended | #1212 |
| 3 | Every AO call restarted a failed AO at once | A failed start pauses the next one: 5 s, doubling to 5 min; a stop clears it | #1212 |
| 4 | Main process froze 46.5 s on a synchronous proxy-settings read at each service start | Starts use the copy already read off the main thread | #1212 |
| 5 | Commits copy the write-ahead log (it reached 483 MB); the first write of a start took minutes | `wal_autocheckpoint(0)` and a background PASSIVE checkpoint (AO#29, another session) | Open; needs rebase onto AO main and a pin |
| 6 | Change-log cleanup deletes 10k rows at a time | 1k rows with a pause (AO#27, another session) | Open; needs rebase onto AO#28 |

## Phase 2: AO keeps chats alive through a slow moment

| # | Problem (file) | Fix | State |
|---|---|---|---|
| 7 | A chat stops projecting after 3 store errors 20 ms apart, so one 5 s busy timeout detaches a live chat (`service/chat/controller.go`) | Retry busy and deadline errors with backoff before detaching | AO#30 open: ten tries over about a minute |
| 8 | A chat whose 30 s recovery budget ran out is neither exited nor live: "unavailable" for good, because the fallback reuses the expired context (`session_manager/manager.go`) | Fresh short context for the fallback; retry failed recoveries with backoff | Tried and dropped: a test of it passes on main too, so the cause is not shown. Needs a live "unavailable" chat to trace |
| 9 | A 1 s handshake to an existing chat host is final (`persistenthost/host.go`) | 5 to 10 s, retried | Tried and dropped: two tests pin "a silent host holds recovery up at most 2 s". Needs a measured late hello first |
| 10 | One store error in the boot reconcile marks every session "unavailable" for the daemon's whole run (`manager.go`, `status_readiness.go`) | Retry the reconcile; track failure per session | Not started |
| 11 | Queued turns are sent only when an event happens; a failed read leaves them queued forever (`controller.go`) | Periodic re-drain for conversations with queued turns; a deadline on SendTurn | Not started |
| 12 | A panic in any background goroutine ends the daemon | A `safeGo` helper that recovers, logs and restarts the loop | Not started |

## Phase 3: AO starts fast and answers honestly

| # | Problem | Fix |
|---|---|---|
| 13 | Boot does slow work (reconciles, reviewer relaunches, skill installs) before the server answers, and `/readyz` always says ready | Serve right after the store opens; `/readyz` reports phases; move the rest after ready |
| 14 | Reviewer chats are relaunched one by one, unbounded, before ready | Background, with a per-reviewer limit |
| 15 | Foreground writes wait on a lock that cannot be cancelled (161 call sites) | `LockContext` in `conversationWriter` and the store's write paths |
| 16 | A provider handoff imports a whole transcript in one write transaction | Stage it in bounded transactions |
| 17 | Usage ingestion, cost backfill and legacy repair never yield the writer and re-read transcripts | Route their writes through `maintain`; rate-limit; remember checked sources |
| 18 | Shutdown waits without bound, so the app hard-kills AO and the next start pays for the leftover log | One shutdown deadline; checkpoint before close |
| 19 | The per-project workspace lock is held across git work and agent launches and cannot time out | Context-aware lock, released before the relaunch |

## Phase 4: the app stops amplifying a slow AO

| # | Problem | Fix |
|---|---|---|
| 20 | The database compaction before AO starts is spawned on the main thread and can leave a log AO must recover | Spawn off-thread; skip it after a slow start |
| 21 | A hung but alive AO is never noticed; chats just time out | A status-only `/readyz` heartbeat and a clear "AO is not answering" state (no automatic kill) |
| 22 | Backend hot-update and "refresh AO" restart AO under running chats | Wait until no session is working |
| 23 | The 4-minute launch stall stop kills cold starts that are merely slow | Extend it while start stages keep arriving |
| 24 | Everything hits AO at once when it becomes ready (warm spawns, catalog refresh) | Hold warm spawns and the catalog refresh back for a minute |
| 25 | The headless host fails every call together when the disk stalls | Start cooldown; longer limit for reads than for controls |
| 26 | Large conversation replies are parsed on the main thread about once a second per chat | Parse in the fetch worker |
| 27 | Synchronous file calls on the spawn path (dependency links, manifest, Antigravity's proxy read) | Async, with capped stat concurrency |

## How to tell it worked

Read the running app's log (`codexWebLauncher.logs()` over the DevTools port) for a day:

- `ao.writer_held`: no hold over 20 s. Before: 163 to 309 s.
- `ao.start_failed` "timed out getting ready": none while the daemon was alive. `ao.start_waiting` shows the starts that used to be killed.
- `ao.launch_timing` `launchMs`: under 60 s cold. Before: 336 to 393 s.
- `launcher.main_stalled`: none from `provider-network.json`.
- `launcher.ipc_failed` bursts ("Headless request timed out"): none.

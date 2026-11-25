# Design: AO chat database retention

## 概述

`cdc.HistoryRetention` is one background worker in the AO daemon. Each pass does three things in order, one at a time, so they never compete for the single writer:

1. archive sweep (FR-1)
2. card trim (FR-2)
3. vacuum steps (FR-3)

## 技术方案

**Cutoff by id.** Archive ids are AUTOINCREMENT and stamped with the receive time, and activity rowids grow with inserts. So "older than N days" becomes an id bound found by binary search: each probe reads a single row's time. This keeps the age test off every row, because `received_at` and `created_at` follow the bulky payload columns and reading them per row walks overflow chains.

**Archive sweep.**
- Read `id, conversation_id, provider_event_id` in id order on a read connection, up to the cutoff id. These columns come before the payload.
- Classify each row in Go: empty and `acp-host:` ids are deleted; other ids are kept and have their payload emptied.
- Write by id list under `maintain`, re-checking the open-turn condition in SQL.
- The cursor lives in memory. Rows below it are gone or already emptied, so a restart rereads only the small emptied rows.

**Card trim.**
- Read rowids up to the cutoff whose `octet_length(detail_json)` or `octet_length(command_output)` exceeds the cap. `octet_length` reads only the record header.
- Load those rows' text, trim in Go, and write them back by rowid under `maintain` without touching `revision`.
- JSON is decoded with `UseNumber` and re-encoded without HTML escaping. Key order becomes sorted, which consumers do not depend on.

**Vacuum.**
- Read `PRAGMA auto_vacuum` and `freelist_count`.
- While the free space is above 16 MB and the pass has freed less than its budget, run `PRAGMA incremental_vacuum(n)` under `maintain`, with `n` sized by the yielding batch.

## 数据模型

No schema change. Archive rows keep their dedupe key `(conversation_id, provider_event_id)`; emptied payloads are `''`.

## API 设计

New store methods (sqlite.Store):
- `ProviderEventIDReceivedBefore`
- `SweepProviderEventArchive`
- `ActivityRowIDCreatedBefore`
- `TrimActivityBodies`
- `IncrementalVacuumStep`
- `FreePageBytes`

No HTTP API change.

## 文件结构

- `backend/internal/storage/sqlite/store/history_retention.go` (+ test)
- `backend/internal/cdc/history_retention.go` (+ test)
- `backend/internal/daemon/cdc_wiring.go` (start/stop the worker)

## 设计决策

- **Keep history-id rows, empty their payload.** A history replay re-sends the same ids, and deleting them would duplicate cards.
- **Open-turn guard.** It is kept although 7 days makes a replay very unlikely.
- **A skipped row is retried after the next AO restart, not on every pass.** This avoids pinning the cursor and rereading days of rows every 15 minutes, the 2026-11-13 read storm.
- **Trim by text length, not field names.** It covers every harness's detail shape; each long text keeps its first 4 KB.

## 测试策略

Store tests on a real SQLite file:
- old acp-host and empty-id rows are deleted;
- history ids keep their row and lose their payload;
- young rows and open-turn rows stay;
- a replayed history event is still deduplicated;
- old cards are trimmed and young cards are unchanged;
- no change_log row is added;
- the vacuum shrinks `page_count`.

A cdc test with a fake store checks pass ordering, yielding and the cursor.

## 风险评估

- **First pass reads the backlog once.** That is about 3-4 GB of leaf pages, paced by batches.
- **Vacuum relocates live pages.** It is random I/O on the HDD, bounded per pass.
- **Old cards lose text beyond 4 KB per field.** The user approved this.

## 检查清单

- [x] FR-1, FR-2 and FR-3 covered.

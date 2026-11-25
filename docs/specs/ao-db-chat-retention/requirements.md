# Requirements: AO chat database retention

## 功能概述

AO's `ao.db` held 6.6 GB on 2026-11-24 and grew about 0.22 GB a day on the shared G:/H: hard disk. When G: fills, the app cannot write.

Measured on a copy:
- The raw provider-event archive is 4.33 GB (66%) and grows ~154 MB/day. No screen reads it.
- Tool-card bodies in `conversation_activities` are 1.87 GB (28%) and grow ~60 MB/day.
- Chat text is 0.11 GB.

The user chose (2026-11-24):
- keep 7 days of the raw archive;
- trim tool-card bodies older than 30 days to about 4 KB;
- have AO give freed space back to the disk in paced steps.

## 范围边界

In scope: the AO fork (`module/agent-orchestrator`, backend Go) and the app's AO pin.

Out of scope:
- messages (chat text), turns and usage records;
- reasoning text;
- lossless deduplication of the repeated detail fields;
- the launcher's own start-time compaction (unchanged).

## 需求列表

### FR-1: Keep 7 days of the raw provider-event archive

Delete or empty archive rows older than 7 days whose replay can no longer matter.

#### 验收标准（EARS）

1. WHEN an archive row is older than 7 days, its conversation has no queued or running turn, and its event id is empty or a persistent host's (`acp-host:`), AO SHALL delete the row.
2. WHEN such a row carries any other non-empty event id (history replays such as `acp-history:`), AO SHALL keep the row and its id and SHALL empty only its payload, so a later history replay is still recognised as already applied.
3. WHEN a row is younger than 7 days, or its conversation has a queued or running turn, AO SHALL leave it unchanged.
4. Cleanup SHALL read rows by id range without reading payloads to decide age, SHALL delete in small batches that give the single writer back to chat writes, and SHALL NOT reread the processed archive on every pass.

### FR-2: Trim tool-card bodies older than 30 days

Cut old cards' bulky text and leave the rest of the card readable.

#### 验收标准（EARS）

1. WHEN a conversation activity was created more than 30 days ago and its stored command output or any text value inside its detail is longer than 4 KB, AO SHALL keep the first 4 KB of each such text, end it with a visible trim note, and mark command output as truncated.
2. AO SHALL leave each card's kind, status, summary, ids, order, the remaining detail fields, chat messages and every card younger than 30 days unchanged.
3. The trim SHALL NOT bump the activity revision, so no change event is emitted.

### FR-3: Give freed space back to the disk

Return freed pages to G: gradually instead of only at app start.

#### 验收标准（EARS）

1. WHEN `ao.db` is in incremental auto-vacuum mode and its free pages exceed a threshold, AO SHALL run `PRAGMA incremental_vacuum` in small steps that yield the writer to chat writes, with a bounded amount per pass.
2. WHEN the database is not in incremental mode, AO SHALL not vacuum and SHALL not fail.

## 非功能需求

- One background worker, starting 10 minutes after AO starts so it stays clear of startup and the chunk janitor's first pass.
- No new startup migration and no new index over the archive tables.
- Every write goes through `maintain`, which yields to a waiting chat write after 750 ms.

## 依赖关系

- `cdc.ProviderRetentionJanitor` patterns (yielding batches, start delay).
- `Store.maintain`.
- The launcher's `ao-db-maintenance.cjs`, which keeps its 32 MB per start cap.

# Tasks: AO chat database retention

## 概述

Implement the user-approved ao.db retention in the AO fork, then pin it in the app's release batch.

## 交付物清单（Scope-lock）

- AO branch `ao/db-retention` (fork `p90-lover/agent-orchestrator`), merged to fork main.
- The app's AO gitlink bump in the next release batch.

## 任务列表

- [ ] 1.1 Store: id cutoffs, archive sweep, card trim, vacuum step, free-page bytes.
- [ ] 1.2 cdc: `HistoryRetention` worker with yielding batches and in-memory cursors.
- [ ] 1.3 Daemon wiring (start 10 min after AO start, stop on shutdown).
- [ ] 2.1 Store tests (FR-1..FR-3 acceptance) and cdc worker tests.
- [ ] 2.2 Focused `go test` for the store, cdc and daemon packages, plus `go vet`.
- [ ] 3.1 PR to fork main, merge, bump the app pin, join the release batch.

## 检查点

- After 2.2: all focused tests pass on Windows.
- After 3.1: fork main contains the commit and the app's pin names it.

## 需求覆盖矩阵

| Requirement | Tasks |
|---|---|
| FR-1 | 1.1, 1.2, 2.1 |
| FR-2 | 1.1, 1.2, 2.1 |
| FR-3 | 1.1, 1.2, 2.1 |

## 文件变更清单

- `backend/internal/storage/sqlite/store/history_retention.go` + `_test.go`
- `backend/internal/cdc/history_retention.go` + `_test.go`
- `backend/internal/daemon/cdc_wiring.go`

## 检查清单

- [x] Scope, evidence and acceptance defined for FR-1..FR-3.

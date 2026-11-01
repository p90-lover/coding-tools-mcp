# 任务清单：WebGPT rich output

## 交付物清单

Implement the three child specifications and retain a verified response-family matrix. No installed application changes are included.

## 任务列表

1. Capture and transport response references.
2. Preserve native tool envelopes and metadata privacy.
3. Verify native-compatible output, source preview interaction and lifecycle regressions.

## 需求覆盖矩阵

| FR ID | 子规格 | 任务引用 | 状态 |
|---|---|---|---|
| FR-1 | response-capture | response-capture/1.1 | Completed |
| FR-2 | response-capture | response-capture/1.1 | Completed |
| FR-6 | response-capture | response-capture/1.2 | Completed |
| FR-4 | native-tool-envelope | native-tool-envelope/1.1 | Completed |
| FR-5 | native-tool-envelope | native-tool-envelope/1.2 | Completed |
| FR-3 | codex-presentation | codex-presentation/1.1 | Completed |
| FR-7 | codex-presentation | codex-presentation/1.2 | Completed |

## 文件变更清单

Runtime source and focused existing tests named by the child specifications; this spec directory. Pinned vendor snapshots remain unchanged.

## 子规格任务覆盖矩阵

| 子任务 | Deliverable |
|---|---|
| response-capture/1.1 | Typed rich reference capture before Markdown cleanup |
| response-capture/1.2 | Helper/turn transport and deduplication |
| native-tool-envelope/1.1 | Canonical descriptor/result preservation |
| native-tool-envelope/1.2 | Private metadata and approval regressions |
| codex-presentation/1.1 | Compatible presentation/source fallback |
| codex-presentation/1.2 | End-to-end response matrix and browser evidence |

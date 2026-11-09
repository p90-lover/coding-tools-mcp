# 设计文档：Reset-aligned CPA usage

## 概述
Covers FR-1, FR-2, NFR-1, NFR-2 and NFR-3. Reuse CPA Helper's persisted request history; no new usage journal or upstream calls.

## 技术方案
### 架构设计
Add session/week usage ranges beside existing rolling ranges. Read sanitized Codex windows from the local Helper account cache for all listed accounts (not the chat meter's capped subset). For each valid window query rankings grouped by model with auth/from/to. Use the existing cost aggregation so model pricing and partial totals remain consistent. Bound concurrency to three and cache per range, expiring no later than a limit reset.

Flow: local Helper quota cache and auth-file list -> window validation -> scoped rankings -> existing aggregation -> explicit bridge projection -> matching Auth Files card.

## 数据模型
Each current-window account adds window: {from: number, to: number} or null, and usageAvailable: boolean. from and to are Unix milliseconds. A null window denotes no confirmed active reset window, never an implicit rolling fallback. No new persisted backend state; a versioned card cache holds only projected counters and window bounds.

## API 设计
cpa_usage accepts range session or week in addition to 5h/24h/7d/30d/all. Current-window replies retain account/model/count/cost contracts and add the two safe fields above. Upstream query to is capped at captured now; displayed window.to is the actual reset so it expires predictably.

## 文件结构
- desktop-electron/electron/cpa-usage.cjs: current-window loading and cache gate.
- desktop-electron/electron/cpa-panel-session.cjs: reset-aware Codex rows and versioned cache, retaining rolling history for every provider.
- desktop-electron/src/features/cpa-usage.ts: range and metadata types.
- desktop-electron/src/features/cpa-provider-usage-bridge.ts: allowlisted ranges and safe projection.
- desktop-electron/tests/cpa-reset-usage.test.cjs: window/query/cache boundaries.
- desktop-electron/tests/cpa-card-usage.test.cjs and cpa-provider-usage-bridge.test.cjs: rendering/privacy coverage.

## 设计决策
### Use provider windows rather than local-clock buckets (FR-1)
A rolling five-hour or seven-day range includes a prior quota cycle. The provider's reset and duration determine the start. Validate positive finite timestamps, active bounds and freshness. Never extrapolate future resets from stale metadata. A new account can use persisted request history only when its current quota start is known.
### Reuse list-price estimation (FR-2)
Dollar values remain API-price equivalents, not subscription fees or balances. Unpriced requests show Null, and partial prices retain their suffix. No credentials or arbitrary future backend fields are projected.

## 测试策略
Test before/at/after the start, separate accounts with matching labels, distinct reset times, missing and stale metadata, weekly/session independence, zero and unknown costs, failed reads, cache expiry and boundary rollover. Run affected and full Electron tests plus typecheck. Render the actual injected script in the chat preview with synthetic data, checking narrow cards and expired/reloaded cache states.

## 风险评估
Unknown indexed dynamic callers require text confirmation. The usage backend also serves chat turn stats; preserve default paths and run their regressions. Per-account model queries may be expensive; cap concurrency and reuse the existing twenty-second cache. Incomplete Helper history cannot be fabricated and remains explicitly unavailable when the query fails.

## 检查清单
- [x] Existing architecture, privacy boundary, API contracts and test cases are covered.

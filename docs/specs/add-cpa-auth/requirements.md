# 需求文档：Reset-aligned CPA usage

## 功能概述
Show each CPA Codex Auth Files card's request, token and estimated dollar totals for its current short-hour and weekly limit windows, counted only from the provider's last limit reset. Add Current 5 h / Current week rows alongside the existing rolling Last 5 h / Last 7 days history. Only Codex cards receive the new rows; other providers retain their existing history.

## 历史经验与坑
Reuse CPA Helper rankings and the sanitized frame bridge. Usage source values can be API keys; never expose them. Keep unknown prices as Null. The main checkout contains unrelated edits and must remain untouched.

## 术语定义
- Current hour usage: the active short-hour quota window (5 hours for the screenshot's Codex accounts), not the current wall-clock hour.
- Window start: provider reset timestamp minus its reported window duration.

## 范围边界
In scope: Codex account current-window totals, reset-aware caching, safe bridge metadata, card display and regression tests.
Out of scope: changing quota/credits, plugin binaries, installing or restarting the app, calendar-hour totals, unrelated prior fixes.

## 需求列表
### FR-1: Count only within each provider limit window
Priority: Must. As a CPA user I want totals since each account's reset, not a rolling lookback.
1. WHEN a valid reset and duration describe an active window THEN the system SHALL count only that account's requests from reset minus duration until the captured read time.
2. IF reset metadata is missing, expired or describes a future window THEN the system SHALL show Waiting for limit reset, not fabricated zero or rolling totals.
3. WHEN the provider advances a reset THEN the system SHALL discard previous-window totals, independently for short-hour and weekly windows.
### FR-2: Display honest, private totals
Priority: Must. As a CPA user I want request counts, tokens and estimated dollar value without exposing credentials.
1. WHEN totals are available THEN each card SHALL match by auth file name and show Current 5 h and Current week with a since-reset tooltip.
2. IF price is unknown THEN the system SHALL show Null; IF history cannot be read THEN it SHALL show usage unavailable rather than No requests.
3. WHILE displaying cached totals the system SHALL expire them at their window end, including after reload or network failure.

## 非功能需求
- NFR-1: At most three local history queries in flight, shared cached reads, no additional upstream quota probes.
- NFR-2: Management key and raw auth IDs remain in the main process; no raw API errors cross the frame boundary.
- NFR-3: Existing rolling ranges and chat turn stats remain compatible; hidden CPA panels do not poll.

## 依赖关系
CPA Helper codex/accounts and rankings APIs; cpa-usage.cjs; the existing cpm:usage frame bridge and Auth Files injection.

## 检查清单
- [x] Scope, boundary behavior and privacy acceptance are explicit.
- [x] Requirements are stable and independently testable.

# 设计文档：build-a-cpa

## 概述
Implement FR-1, FR-2, FR-3 and NFR-1 through NFR-3 as an in-process CPA plugin using the existing ABI.

## 技术方案
### 技术选型
Go standard library plus the existing C ABI wrapper; a small HTML management page following the existing plugin pattern. No new runtime dependency.
### 架构设计
Exact review model -> plugin model router self target -> plugin executor -> host.model.execute or execute_stream with forced_provider codex and exact auth_id.
Other models -> Handled false -> existing CPA routing.

Pinned upstream API evidence: router-for-me/CLIProxyAPI v8.0.32 sdk/pluginapi/types.go HostModelExecutionRequest and sdk/pluginabi/types.go. Host callbacks preserve AuthID; auth conductor filters single, mixed and retry candidate sets by pinned ID. The host skips the originating router on forwarded execution.

## 数据模型
Selection JSON contains selectedAuthId only. Its path is under plugin ConfigFields data-dir; save atomically. The current request snapshots the ID once. Credentials remain entirely with CPA.

## API 设计
- GET /v0/management/codex-review-account-selector/accounts: sanitized id, label, email, refresh timestamp, disabled/unavailable status for codex only.
- GET /v0/management/codex-review-account-selector/settings: selectedAuthId.
- PUT same settings path: validate selected account, save selectedAuthId.
- Management resource index.html: account select, refresh and save controls; clear status text; existing management authentication applies.

## 文件结构
- desktop-electron/vendor/cpa-plugins/codex-review-account-selector/plugin.go
- desktop-electron/vendor/cpa-plugins/codex-review-account-selector/abi.go
- desktop-electron/vendor/cpa-plugins/codex-review-account-selector/plugin_test.go
- desktop-electron/vendor/cpa-plugins/codex-review-account-selector/web/index.html
- desktop-electron/vendor/cpa-plugins/codex-review-account-selector/go.mod
- desktop-electron/vendor/cpa-plugins/codex-review-account-selector/README.md
- desktop-electron/vendor/bundled/cpa-plugins/BUNDLE.json
- desktop-electron/vendor/bundled/cpa-plugins/windows/amd64/codex-review-account-selector-v0.1.0-codingtools.4.dll

## 设计决策
Use a self-target router and exact-ID host execution rather than scheduler heuristics. This preserves review model identity and prevents account fallback, meeting FR-2. The model ID is a constant; no unrelated model picker is added.

## 测试策略
FR-1: list filtering, secret-field absence, valid/invalid saves, atomic persistence.
FR-2: exact-model matching, forced provider, pinned auth, streaming parity, missing/disabled/unavailable account refusal, other-model pass-through.
FR-3: Go tests/build, bundle digest verification, local synthetic live request with one explicitly enabled account.

## 风险评估
Account pin can be unavailable; return an error and let Approve for me ask the user. Plugin installation may require CPA reload; preserve active requests and backups. Never enable other accounts automatically.
## 检查清单
- [x] API, account boundary, no-fallback behavior, tests and packaging are specified.

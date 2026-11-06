# Antigravity coding filter tasks

## 交付物清单

One vendored Go plugin directory (ABI, filter, tests, module files, license and README), one Windows DLL, its existing BUNDLE manifest record, a small cpa-managed.cjs integration, one Node regression test and these three specification files.

## 任务列表

- [ ] 1. Add a native provider-scoped request interceptor with configurable system-text mappings (FR-1, FR-2; design: Interception).
  - Evidence: upstream main.go registers request_interceptor and defaults to block; CPA v8 sdk/pluginapi/types.go exposes request.intercept_after and a Terminate/StatusCode response. cpa-managed.cjs:254 already installs versioned DLLs.
  - Files: vendor/cpa-plugins/antigravity-coding-filter/abi.go (100 lines), filter.go (350 lines), plugin.go (180 lines), module files, README and MIT license. Each implementation file remains under 500 lines.
- [ ] 2. Bundle and enable rewrite mode while retaining user configuration (FR-3; design: Integration).
  - Evidence: cpa-managed.cjs:301 generates runtime YAML; its managed plugin entries currently replace saved entries wholesale. BUNDLE.json contains existing versioned Windows plugin metadata.
  - Files: cpa-managed.cjs (20 added lines), BUNDLE.json (one record), Windows DLL.
- [ ] 3. Verify matching, provider isolation, request preservation, registration and refresh persistence (FR-4; design: Verification).
  - Evidence: cpa-cline-switcher.test.cjs already hashes and installs bundled DLLs. Reuse its installer fixture pattern and existing temporary-directory cleanup.
  - Files: plugin_test.go (200 lines), desktop-electron/tests/cpa-antigravity-filter.test.cjs (130 lines). Use at most three focused check commands.
- [ ] 4. Review the scoped diff, run graph change analysis and deliver a commit and PR (FR-4).

## 文件变更清单

Plugin source directory: new; bundled Windows DLL: new; BUNDLE.json: one record; cpa-managed.cjs: defaults and config merge; Node test: new; specification directory: new. Source line budgets appear in tasks 1-3.

## 需求覆盖矩阵

| Requirement | Design | Tasks |
| --- | --- | --- |
| FR-1 | Interception | 1, 3 |
| FR-2 | Interception | 1, 3 |
| FR-3 | Integration | 2, 3 |
| FR-4 | Verification | 3, 4 |

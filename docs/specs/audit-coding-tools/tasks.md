# Tasks: audit-coding-tools

## 概述

Audit capabilities, reproduce terminal/preview blockers, repair narrowly and deliver with regression evidence.

## 交付物清单（Scope-lock）

Production: two existing backend files, chat-sandbox.cjs and chat-agent-tools.cjs. Tests: their existing Node suites and one focused new suite if fixture separation is needed. Documentation: one audit and three specifications. No new runtime dependencies, UI modules, Rust tool names or provider integration.

## 任务列表

- [x] 1.1 Compare current served tool sets to pinned public Codex source and official product docs; identify local versus hosted/OS-gated features.
  - **证据块**: chat-agent-tools.cjs:95-103 lists core tools; lines299-307 terminal/desktop; lines63-65 add preview, subagents and history.
  - Files: audit document under200lines. Requirements: FR-1. Design: Overview.
- [x] 2.1 Reproduce and repair explicit timeout forwarding, safe large deadlines and truthful termination without an implicit deadline.
  - **证据块**: chat-agent-tools.cjs:2282 calls sandbox.start without timeout_ms; chat-sandbox.cjs:218 accepts no deadline. Headless exec_profile.rs:15-24 already defines null/zero as unlimited.
  - Files: sandbox+tool wiring under100addedlines each; tests under200addedlines. Requirements: FR-2. Design: API.
- [x] 2.2 Reproduce and repair oversized stream retention and truncated UTF-8 tails while preserving byte cursors.
  - **证据块**: chat-sandbox.cjs:198 trims only while chunks.length>1; lines298-301 decode a raw tail without scalar-boundary protection.
  - Files: sandbox and regression tests, no new production module. Requirements: FR-3. Design: Data model.
- [x] 2.3 Remove ignored preview-output probes while preserving new-origin and foreign-chat consent.
  - **证据块**: chat-agent-tools.cjs:2325 invokes headless read_output for every command; previewOriginDecision:1201 explicitly ignores servedHere. Therefore these requests cannot authorize preview and are unnecessary.
  - Files: tool wiring under20addedlines and tests. Requirements: FR-4. Design: API.
- [x] 2.4 Add read-only per-chat paginated command discovery and preserve retryable ownership after stop failure.
  - **证据块**: chat-agent-tools.cjs:2224 tracks accepted commands before yield, but the exposed terminal set has no command listing. chat-sandbox.cjs kill ignores taskkill callback errors and changes status before stop succeeds.
  - Files: same two backend modules and tests; listing under50lines, stop error path under20lines. Requirements: FR-5. Design: Owned command discovery.
- [x] 3.1 Run failing-before/passing-after regressions, full affected suites, real child smoke, syntax and graph checks; self-review exact candidate.
  - **证据块**: chat-sandbox.test.cjs provides fake child streams; chat-agent-tools.test.cjs:977 provides scoped fake sandbox and real MCP HTTP fixtures.
  - Files: tests and final audit evidence. Requirements: FR-1 through FR-4. Design: Test strategy.
- [ ] 3.2 Publish a scoped PR, follow required checks and repository release policy; never live-patch or restart the installed app.
  - **证据块**: AGENTS.md Delivery requires PR, green checks, merge and shared CI release unless already underway.
  - Files: task commit/PR and release metadata only when needed. Requirements: FR-1 through FR-4. Design: Risk.

## 检查点

- [x] Specifications pass before production edits.
- [x] Failures reproduced before fixes.
- [x] Exact final candidate passes regressions and graph analysis.
- [ ] PR delivery verified independently of local tests.

## 需求覆盖矩阵

FR-1:1.1,3.1,3.2. FR-2:2.1,3.1. FR-3:2.2,3.1. FR-4:2.3,3.1. FR-5:2.4,3.1.

## 文件变更清单

Two production backends, two or three test files, one audit and these three specs. Existing large tool-dispatch file receives wiring only; no unrelated extraction.

## 检查清单

- [x] Tasks have code evidence and explicit requirement links.
- [x] Live-model and unattended/restart limitations remain explicit.

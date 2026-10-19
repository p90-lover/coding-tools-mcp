# 设计文档：Chat harness performance and quality
## 概述
对应需求: FR-1, FR-2, FR-3, FR-4, NFR-1, NFR-2, NFR-3.
Extend existing controllers and receipts; do not replace the runtime or import the research framework.
## 技术方案
### 技术选型
Use dependency-free CJS metrics and existing AO SSE watchers for FR-1/FR-2. Use existing Rust workspace safe-open/path validation and SHA256 for FR-3. Extend existing assignment parsing and review coverage for FR-4.
### 架构设计
Persisted run/receipt observations feed a bounded timing aggregator exposed through run_status and the UI. Existing session watchers invalidate shared observation tails; current-turn cache is display optimization, never sufficient proof of completion.
Planner assignments carry either normal task/acceptance or explicit skip_reason. Optional checks are artifact_sha256 checks. Host-computed evidence records identity and digest, and final review revalidates it.
## 数据模型
- Metrics: version, timing_basis, current-instance scope, observed wall time, summed active-node time, startup/approval waits, counts, explicit nulls for unavailable provider/tool/token timings.
- Assignment: optional skip_reason and checks. Host-only planner_request_key binds checked assignments.
- Receipt: optional bounded acceptance_evidence with expected/observed digest, planner/worker request keys, verified timestamp, pass/failure.
- Caches: bounded session/attempt/generation keys; pending coalescing and event/TTL invalidation.
## API 设计
Existing run_status adds metrics without changing authorization. Existing run payloads carry optional assignment/evidence fields. No new network listener or unsafe verifier execution endpoint.
## 文件结构
- desktop-electron/electron/agent-orchestrator-metrics.cjs: bounded observational aggregation.
- desktop-electron/electron/agent-orchestrator-workflow.cjs: integration, shared reads and snapshot reporting.
- desktop-electron/electron/agent-orchestrator-upstream.cjs: shared session observations and conversation cache.
- src-tauri/src/integrations/ao.rs and ao_team.rs: selection, review coverage, receipt gates.
- src-tauri/src/integrations/ao_acceptance.rs: scoped digest verification when existing helpers cannot contain it cleanly.
- desktop-electron/src/features/AgentOrchestratorSurface.tsx and corresponding types/chat mapping: visible metrics, skipped cards and verifier evidence.
- Matching Rust/Node tests, small offline benchmark, and these specification files.
## 设计决策
### 决策 1: Retain authoritative lifecycle gates (FR-2)
Cache active observations briefly; force fresh terminal evidence. Existing ownership, turn identity, cancellation, revision and unknown-send checks remain authoritative.
### 决策 2: Verify bytes without executing acceptance prose (FR-3)
Initial typed check is artifact_sha256 only. Arbitrary test commands, API requests and human attestations are not automatically converted into verified checks. Host-safe reads prevent path escape. AO-backed typed checks additionally bind the reported session root to the registered canonical project folder; unknown or differing roots fail closed. This first verifier does not expand reads into isolated/shared AO worktrees. Native execution keeps its controller-owned root.
### 决策 3: Explicit skip reasons (FR-4)
Skip only explicitly selected omissions, not silently missing assignments. Preserve user-configured mandatory review roles and reject excluded dependency ancestors.
## 测试策略
Use focused production-controller Node tests with fake IO and clocks, Rust tests for path/binding/selection/review compatibility, Unicode/legacy serialization and disconnect/mutation cases. Run rustfmt and relevant frontend static checks locally. Full Rust test/clippy and frontend contracts run in GitHub CI; report local limits honestly.
Offline comparison measures requests/bytes and deterministic timing behavior for equivalent fixture outputs, not real-model intelligence or wall-time claims.
## 风险评估
- HIGH: Shared observation and adaptive dependencies can affect completion/dispatch. Preserve exact attempt identity and test cancellation/reconnect.
- MEDIUM: Artifact checks could escape workspace or become stale. Reuse safe-open APIs, bound size/count and reverify at approval.
- MEDIUM: Observed timing is partial. Explicitly label basis/scope and unavailable measurements.
## 检查清单
All requirements map to production changes and regression checks; optional fields preserve compatibility.

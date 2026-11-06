# 设计文档：remake-coding-tools

## 概述
**对应需求:** FR-1, FR-2, FR-3, NFR-1, NFR-2, NFR-3.
Use the installed Codex Windows engine behind the existing Rust computer-control boundary. Do not copy vendor code, inject into Codex, or share its active pipe.

## 技术方案
| 类别 | 选择 | 理由 | 关联需求 |
|---|---|---|---|
| Execution | Owned Node worker importing installed Sky | Actual engine and native feedback, not a visual imitation | FR-1 |
| Transport | Bounded private stdin/stdout JSON | No public listener or remote consent endpoint | FR-1, NFR-2 |
| Authorization | Existing Rust lease, selected target, monitor heartbeat and identity validation | Reuse established local authority | FR-2, FR-3 |
| Compatibility | Translate existing actions; extend computer_action with documented Sky method and params | Keep existing tool names and request replay protection | FR-2 |
| Observation | Real Sky window state and bounded in-memory images | Preserve exact native action coordinates and screenshot identifiers | FR-1, FR-2 |

### 架构设计
Local consent → workspace-bound lease → validated action/request receipt → private Sky worker → installed native helper → approved window.
Local Stop/pause/expiry → independent worker cancellation → no automatic replay.
The local monitor remains the consent/Stop surface; native visual feedback belongs to the actual helper.

## 数据模型
| 实体/字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| Runtime | absolute paths | Existing Codex node, Sky entry point and native helper | Discovered once; fail closed on missing components |
| Worker | child + response channel | One local grant; bounded output and request deadline | No disk output |
| Native call | method + params | Allowlisted window2 methods; window must match approved target | No arbitrary JavaScript execution |
| Receipt | existing request-id/fingerprint | Identical retries cannot resubmit input | Existing semantics retained |

## API 设计
Existing computer tool names remain unchanged. `computer_action` gains an alternative `{session_id, request_id, method, params}` shape for `get_window_state`, `click`, `press_key`, `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action`, `activate_window`, and `get_window`. `step` remains supported; mixing the forms is invalid. The server supplies or verifies the approved Window binding. Discovery and session enablement remain local-policy controlled, not arbitrary app launch.

## 文件结构
- `src-tauri/src/tools/computer/codex.rs`: private runtime/worker bridge.
- `src-tauri/src/tools/computer/codex-bridge.mjs`: original integration code importing installed Sky.
- `src-tauri/src/tools/computer/mod.rs`: lifecycle, native method dispatch and compatibility.
- `src-tauri/src/tools/computer/schema.rs`: additive action input shape.
- `src-tauri/src/tools/computer/capture.rs`: native-engine agent-frame normalization; the optional local-only GDI preview deliberately does not alter Sky's screenshot/index cache.
- `src-tauri/src/tools/computer/native.rs`, `unsupported.rs`: retain identity/UIA/physical-input guards and remove the independent SendInput fallback.
- `src-tauri/src/tools/registry_definitions.rs`: truthful installed-engine tool descriptions.
- `tests/codex-computer-bridge.test.mjs`: CI-discovered contract/lifecycle regressions.
- `src/lib/components/ComputerOverlay.svelte`, `src/lib/computer-view.js`: truthful engine/status presentation.
- Focused Rust/Node/frontend contract tests and these three specification documents.

## 设计决策
### 决策 1: Reuse, do not reproduce vendor code (FR-1)
The user chose an installed-runtime dependency over an independent imitation. Load it from its existing installation; never vendor proprietary executables or connect to another session's approval pipe.
### 决策 2: Local authority remains ours (FR-2, FR-3)
Sky parameters do not grant new windows, arbitrary app launch, audio recording or persistent consent. Any approval event must match the already-approved executable/window and current lease. Existing authenticated access and monitor heartbeat remain required.
### 决策 3: Fail closed on uncertain input (FR-3)
Timeout, process exit or Stop is not a retry signal. Record an uncertain outcome and require fresh observation or local re-enablement.

## 测试策略
Mock the imported Sky API to prove forwarding, validation, approval denial, bounded output and close behavior without real desktop input. Exercise runtime discovery fixtures and missing/incompatible runtime errors. Preserve existing Rust replay/lease/policy tests. Run frontend checks and build. Native smoke probes may enumerate windows but must not type/click into real applications without separate explicit test authorization. If no visual preview tool is attached, report visual verification as blocked rather than claiming parity by inspection.

## 风险评估
| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Codex runtime changes private integration details | High | Validate version/layout; use documented API; actionable failure, no silent fallback |
| Stop races an in-flight helper call | High | Independent owned-worker termination; native helper parent lifetime; no replay |
| Window title/app identifiers are untrusted | High | Bind native identity locally; never trust title as authority |
| Exact native feedback differs by installed version | Medium | Use that installed engine; report actual version and verify visibly when tooling permits |

## 检查清单
- [x] All FRs mapped to runtime, compatibility and lifecycle design.
- [x] Paths verified against the current project.
- [x] No external executable redistribution or ambient session reuse.
- [x] Test and verification limitations explicit.

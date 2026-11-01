# 任务清单：build-a-cpa
## 概述
Implement one exact-model account selector using the existing plugin ABI.
## 交付物清单（Scope-lock）
Expected new production files: seven including the Windows DLL. Expected modified production files: one bundle manifest. Three specification files are included. Keep plugin.go below 500 lines; isolate ABI transport in abi.go.
## 任务列表
### 阶段 1: 准备工作
- [x] 1.1 Verify pinned host execution honors auth_id for normal, streaming and retry paths.
  - 证据块: CPA v8.0.32 sdk/pluginapi/types.go HostModelExecutionRequest; host_callbacks.go forwards AuthID and ForcedProvider; conductor_selection.go filters pinned IDs.
  - 涉及文件: this specification; no host patch.
  - 需求: FR-2 | 设计: 架构设计
### 阶段 2: 核心实现
- [x] 2.1 Implement exact model router and pinned native execution with unavailable-account refusal.
  - 证据块: existing Cline plugin exports the supported C ABI; host.model.execute accepts forced_provider and auth_id.
  - 涉及文件: plugin.go 450 lines, abi.go 300 lines, go.mod 10 lines.
  - 需求: FR-2 | 设计: 技术方案
- [x] 2.2 Add authenticated management account picker and atomic opaque-ID selection storage.
  - 证据块: existing Cline plugin uses ConfigFields data-dir and management resources.
  - 涉及文件: plugin.go within the same 450-line budget, web/index.html 180 lines, README.md 80 lines.
  - 需求: FR-1, FR-3 | 设计: 数据模型、API 设计
### 阶段 3: 集成测试
- [x] 3.1 Verify all acceptance cases and build the Windows amd64 DLL into the existing plugin bundle.
  - 证据块: desktop-electron/vendor/bundled/cpa-plugins/BUNDLE.json already pins plugin artifacts by digest.
  - 涉及文件: plugin_test.go 450 lines, BUNDLE.json append one entry, one requested DLL artifact.
  - 需求: FR-1, FR-2, FR-3 | 设计: 测试策略
## 检查点
- Spec gate must pass before implementation.
- Tests must prove another model is unaffected and another account is never a fallback.
- Live inference uses only the one user-approved enabled account; restore no credentials.
## 需求覆盖矩阵
| 需求 ID | 设计章节 | 任务编号 | 状态 |
| FR-1 | 数据模型、API 设计 | 2.2, 3.1 | passed |
| FR-2 | 架构设计 | 1.1, 2.1, 3.1 | passed |
| FR-3 | 文件结构、测试策略 | 2.2, 3.1 | passed |
## 文件变更清单
The eight production paths are listed exactly in design.md. The requested related app fixes also update managed plugin registration, the exact-prefix panel auth bridge, review workflow/UI, terminal sessions and Windows profile resolution; these are separately tested in the same isolated checkout.
## 检查清单
- [x] Each FR has an implementation and verification task; evidence and line budgets are recorded.

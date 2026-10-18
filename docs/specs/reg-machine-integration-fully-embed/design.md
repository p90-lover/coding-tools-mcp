# 设计文档：reg-machine-integration-fully-embed

## 概述
Cover FR-1, FR-2, FR-3 and NFR-1 through NFR-3 by preserving the full application and adding a narrow host adapter.

## 技术方案
### 技术选型
| Category | Choice | Reason | Requirement |
|---|---|---|---|
| Frontend | Existing React application | Preserve every existing screen | FR-1 |
| Backend | Existing FastAPI with managed entrypoint | Preserve routes and validation | FR-2 |
| Packaging | PyInstaller executable and Vite assets | No manual runtime setup | FR-3 |
| App API | Existing generic apps.call | Existing mutation/focus checks | FR-2 |

### 架构设计
Runtime Register -> reg-machine app handler -> managed service -> owned loopback FastAPI -> isolated SQLite.
Original UI uses its own authenticated origin for API, binary downloads and task SSE. Auxiliary customer portal retains separate JWT/RBAC and private generated bootstrap credentials.

## 数据模型
Reuse all source SQLModel tables. Set ACCOUNT_MANAGER_DATABASE_URL and PORTAL_DATABASE_URL into the app-owned register data directory. Never load source-project configuration or account databases. Generated host authentication stays outside renderer snapshots.

## API 设计
| Method | Contract | Input | Output | Requirement |
|---|---|---|---|---|
| inspect/status | apps.call reg-machine | None | Runtime/artifact state | FR-2 |
| start/stop/restart | apps.call reg-machine | None | Owned lifecycle state | FR-2 |
| API operations | Known-route operation catalog | Validated path/query/body | Sanitized API response | FR-2 |
| ui-open | apps.call reg-machine | Known section | Owned loopback URL | FR-1 |

No arbitrary host, URL, filesystem path or authorization header is accepted from the renderer. HTTP methods alone do not determine read-only metadata: token-refresh, probe/check and external side-effect GET routes are mutations.

## 文件结构
- app-handler/reg-machine/source/: allowlisted source snapshot and SHA256 manifest
- app-handler/reg-machine/handler.cjs and module.json: app module
- desktop-electron/electron/reg-machine-managed.cjs: lifecycle and known API dispatch
- desktop-electron/src/features/RegisterSurface.tsx: full original UI hosting
- desktop-electron/scripts/build-reg-machine.cjs: self-contained release preparation
- desktop-electron/src/App.tsx, electron/main.cjs, app-handler/host.cjs and handler-registry.cjs: narrow wiring
- desktop-electron/tests/reg-machine-managed.test.cjs: isolated regression checks

## 设计决策
### Preserve original app behind owned loopback (FR-1, FR-2)
Rewriting existing screens would omit capabilities and duplicate business rules. An owned loopback origin preserves downloads and event streams. Backend authentication remains enabled; secrets are supplied only by the trusted host.
### Freeze source provenance (FR-1)
The local project contains uncommitted features. Vendor its allowlisted source, not just upstream HEAD, and record a hash inventory without private runtime files.

## 测试策略
Verify source hash inventory and denied paths, handler mutation metadata, lifecycle concurrency/cleanup, known-route rejection, authenticated isolated FastAPI health/platform APIs, original SPA and release resource completeness. Do not contact external registration or SMS providers.

## 风险评估
| Risk | Impact | Mitigation |
|---|---|---|
| Dynamic Python imports omitted from executable | High | Collect source packages and real frozen executable smoke |
| Existing source startup creates background services | High | New isolated database, disable automatic solver, explicit lifecycle ownership |
| Source includes private artifacts | High | Allowlisted source inventory and secret scan |
| Browser dependencies increase release size | Medium | Bundle required runtimes once and verify paths |

## 检查清单
- [x] All FR covered.
- [x] Existing generic module contracts reused.
- [x] No installed app or source-project mutation.

# Design: add-a-register

## 概述
**对应需求:** FR-1, FR-2, FR-3, NFR-1, NFR-2, NFR-3, NFR-4.
Use reg-machine as a local service and host its actual UI in a dedicated native content view. No rewritten registration screens or business APIs.

## 技术方案
| Area | Choice | Reason | Requirements |
|---|---|---|---|
| UI | RegisterSurface plus existing original-ui toolbar styles | Matches current Runtime host vocabulary | FR-1 |
| Embedded content | WebContentsView, isolated persistent partition, no preload | Preserves same-origin cookie/SSE auth | FR-1, FR-3 |
| Service | New register-host.cjs, fixed loopback port8000 | Reuses upstream health/start contract | FR-2 |
| Settings | Small private runtime-register.json containing projectRoot | Preserves upstream settings and secrets | FR-2, FR-3 |
| IPC | Explicit typed launcher methods and main-frame/focus guards | No generic code execution bridge | FR-2, FR-3 |

### 架构设计
Runtime Register -> RegisterSurface -> focused/trusted launcher IPC -> RegisterHost.
RegisterHost probes or starts the local service, creates its isolated view, and attaches it to the existing mainWindow.contentView only while active. The native page talks directly to the service origin using upstream /api routes.

## 数据模型
RegisterStatus: projectRoot:string, origin:string, ready:boolean, owned:boolean, starting:boolean, error:string|null.
Persistent configuration contains projectRoot only. Browser session stores upstream auth normally. No account credentials enter launcher state.
Geometry is finite x/y/width/height from the content slot, scaled by renderer zoom and clamped before native placement.

## API 设计
| Launcher method | Input | Output | Requirements |
|---|---|---|---|
| registerStatus | none | RegisterStatus | FR-2 |
| configureRegister | canonicalizable projectRoot | RegisterStatus | FR-2 |
| startRegister | none | RegisterStatus | FR-2 |
| stopRegister | none | RegisterStatus | FR-3 |
| reloadRegister | none | RegisterStatus | FR-1 |
| setRegisterSurfaceActive | boolean | RegisterStatus | FR-1 |
| setRegisterBounds | finite rectangle | boolean | FR-1 |
| onRegisterChanged | listener | unsubscribe | FR-1 |

Reuse chooseFolder for project selection. Main resolves default Documents/ChatGPT/reg-machine and permits the test host to inject a fixture root. Start validates main.py, frontend static index and .venv Python without reading saved DB or credentials.

## 文件结构
New: desktop-electron/electron/register-host.cjs, desktop-electron/src/features/RegisterSurface.tsx, desktop-electron/tests/register-host.test.cjs, desktop-electron/tests/native/register.cjs.
Modify: main.cjs, preload.cjs, src/types.ts, src/App.tsx, src/i18n.ts, features/original-ui.css, relevant existing renderer/preload/quit tests.
Specification: docs/specs/add-a-register/{requirements,design,tasks}.md.

## 设计决策
### Reuse native hosting rather than iframe (FR-1, FR-3)
SameSite=Strict authentication would be fragile in a cross-site iframe under the packaged file origin. Use the existing native attach/bounds pattern. Navigation does not focus the view.
### Explicit startup and strict ownership (FR-2, FR-3)
Backend startup initializes SQLite and starts maintenance; therefore merely opening Register only probes health. Matching existing services stay externally owned. Never clear APP_PASSWORD or call start-nova.ps1.
### Keep upstream functions intact (FR-1)
Host /register and its existing internal routes. Preserve bearer/cookie auth, downloads and permitted same-origin navigation without exposing Electron APIs.

## 测试策略
- Focused host behavior tests: identity mismatch, missing project/runtime, concurrent starts, startup error/timeout, stop during start, attached-vs-owned shutdown, view detach/reload/navigation and bounds.
- Existing preload/navigation/quit contracts plus TypeScript and renderer build.
- Native Electron regression: real isolated view, cookie/SSE retention, content boundary, hide/show, cleanup.
- Actual reg-machine static/health/UI smoke with fresh ACCOUNT_MANAGER_DATABASE_URL, disabled solver and lifespan-off for health/static/read-only APIs; explicitly identify simulated background startup boundaries.
- Render desktop and compact Register states, inspect console/overlay, exercise service/view controls. No live registrations or provider mutations.

## 风险评估
| Risk | Impact | Mitigation |
|---|---|---|
| Backend startup changes saved jobs/maintenance | High | Explicit Start only; no production startup in verification |
| Other app owns port8000 | Medium | Require exact health identity and never kill a port owner |
| Native content covers sidebar/modals | High | Existing active/overlay gate and measured slot, detach on hide |
| Late startup outlives shutdown | High | Owned-child teardown and generation/disposal checks |
| Upstream source/static changes concurrently | Medium | Read-only source and one frozen static snapshot for QA |
| Local dependencies unavailable on another machine | Medium | Project picker and actionable missing-dependency state |

## 检查清单
- [x] Every requirement maps to a concrete component/contract and test.
- [x] No provider credentials, live account operations or production restarts are needed.

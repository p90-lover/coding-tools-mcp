# Requirements: add-a-register

## 功能概述
Add Register under Coding Tools Runtime and host the existing reg-machine interface at /register. Preserve its own navigation, settings, account views and task controls. The existing local project was verified from Codex history. The default location is Documents/ChatGPT/reg-machine; the folder picker supports another installation path.

## 历史经验与坑
- Reuse the existing native GPT Browser surface ownership/bounds pattern and focused main-renderer IPC boundary.
- Reg-machine startup mutates task state and starts maintenance. Navigation must never implicitly launch it.
- Authenticated SSE uses a SameSite=Strict cookie; use a top-level sandboxed native view with its own partition.

## 术语定义
- Owned service: the Python child spawned by this Coding Tools host.
- Attached service: an existing loopback service whose public health response identifies account-manager-v2.
- Register view: a sandboxed WebContentsView without launcher preload.

## 范围边界
In scope: Runtime navigation, complete existing web interface, project selection/persistence, read-only discovery, explicit managed start, view reload, owned stop and shutdown.
Out of scope: changing reg-machine business logic, credential migration, live registration/login/SMS/provider/CPA operations during verification, installing runtimes, publication and restarting the production desktop.

## 需求列表
### FR-1: Open the real Register workspace
**优先级:** Must
**用户故事:** As a Coding Tools user I want Register under Runtime so I can use reg-machine inside the app.
#### 验收标准（EARS）
1. WHEN Register is selected THEN the app SHALL render its service controls and the existing /register UI when healthy.
2. WHEN another surface or an app overlay is shown THEN the native view SHALL detach without losing its session or taking focus.
3. WHEN the viewport or zoom changes THEN the view SHALL follow the measured content slot without covering app chrome.

### FR-2: Attach or explicitly start the local service
**优先级:** Must
**用户故事:** As a user I want service status and an explicit start so page navigation does not change accounts or jobs.
#### 验收标准（EARS）
1. WHEN status is requested THEN the host SHALL only probe 127.0.0.1:8000/api/health and require ok=true and service=account-manager-v2.
2. IF a matching service exists THEN the host SHALL attach without spawning or acquiring shutdown ownership.
3. WHEN Start is clicked in the focused main window THEN the host SHALL validate the configured project and Python environment and start uvicorn on loopback using argument arrays.
4. IF the port belongs to another service, dependencies are missing, startup fails or times out THEN the host SHALL show an actionable error and allow retry.
5. WHEN the project is changed THEN the host SHALL persist only its canonical path and reject changes while its own service is running.

### FR-3: Preserve service ownership and authentication
**优先级:** Must
**用户故事:** As a user I want my existing sessions and processes preserved.
#### 验收标准（EARS）
1. WHEN the workspace loads THEN authentication SHALL remain in reg-machine's own UI and isolated browser session, with no credential injection or clearing.
2. WHEN Stop or app shutdown occurs THEN only the owned Python child tree SHALL be terminated; attached services SHALL remain running.
3. IF stop/dispose happens during startup THEN late completion SHALL not recreate a view or orphan a child.
4. WHEN embedded content navigates or opens a popup THEN the app SHALL enforce the local service boundary and deny privileged launcher access.

## 非功能需求
- NFR-1: Health requests bounded to 2 seconds; startup bounded to 30 seconds; status responses exclude credentials and raw service logs.
- NFR-2: Native content uses context isolation, sandboxing and nodeIntegration=false, with a dedicated partition and no preload.
- NFR-3: Match existing toolbar/container CSS, preserve original frontend visuals, support existing app locales and compact layout.
- NFR-4: Verify offline with task-owned fixture data; production reg-machine DB/config/services and original dirty Coding Tools checkout remain untouched.

## 依赖关系
Existing local reg-machine project, .venv Python with uvicorn, built static UI, current Electron WebContentsView API, existing launcher IPC and folder picker.

## 检查清单
- [x] Requirements have stable IDs and testable EARS acceptance.
- [x] Startup, auth, process ownership, error/retry and visual boundaries are covered.

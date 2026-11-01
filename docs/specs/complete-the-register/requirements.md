# Requirements: Complete Register and CPA Integration

## 功能概述

Register must ship as a working Coding Tools runtime, including the existing application's real frontend, backend and Python dependencies. Opening Register must not require choosing an external checkout or creating a virtual environment. The CPA plugin `register_plugins` connects to a restricted local handler for OAuth import and noninteractive account renewal.

## 历史经验与坑

The original host only validates an external project and its `.venv`; this is the incomplete behavior shown by the user. The upstream project has important local fixes and untracked runtime modules. Preserve those sources without copying private databases, exports, configuration or the separate reg-factory project. Existing manual refresh may open login; scheduled refresh must use token-only renewal.

## 术语定义

- Managed runtime: packaged Register executable, static UI and dependencies owned by Coding Tools.
- Bridge: private authenticated loopback API callable by the CPA plugin, separate from browser control.
- Source account: explicit positive account ID in Register's application-owned database.

## 范围边界

In scope: bundled runtime and frontend, application-owned writable data, trusted launcher wiring, restricted handler, native CPA plugin console, optional automatic OAuth import and refresh, fixture tests and GitHub PR.

Out of scope: live registration, SMS purchases, production login, production token mutation or credential upload, migrating a user's existing private database, publishing a release or installing/restarting their app. Preserve original dirty checkouts.

## 需求列表

### FR-1: Launch a self-contained Register workspace

**优先级:** Must
**用户故事:** A Coding Tools user can open Register without a source checkout or Python setup.

#### 验收标准（EARS）

1. WHEN Register opens THEN Coding Tools SHALL launch its packaged executable and render the real registration UI without choosing a project path.
2. WHILE the executable runs THE system SHALL keep databases, configuration and runtime state under application-owned writable data.
3. IF the runtime is missing or fails THEN the UI SHALL show an actionable error and retry rather than ask for an external checkout.

### FR-2: Expose a restricted authenticated Register handler

**优先级:** Must
**用户故事:** CPA can obtain selected OAuth exports and request noninteractive renewal without launcher-wide access.

#### 验收标准（EARS）

1. WHEN an authenticated plugin requests explicit account IDs THEN the handler SHALL return only the selected accounts' exports or sanitized renewal results.
2. IF credentials, method, origin, body size or account IDs are invalid THEN the handler SHALL reject the request without executing account operations.
3. WHILE a refresh cannot renew without login THE system SHALL report that boundary and SHALL NOT open a login or registration flow.

### FR-3: Provide the native CPA register_plugins console

**优先级:** Must
**用户故事:** A CPA administrator can enable automatic Register OAuth import and scheduled refresh from a usable plugin page.

#### 验收标准（EARS）

1. WHEN CPA loads the bundled plugin THEN it SHALL register a working Register menu and authenticated settings, status, sync and refresh routes.
2. WHEN automatic import is enabled THEN it SHALL import eligible source accounts using host.auth.save and skip unchanged source revisions.
3. WHEN automatic refresh is enabled THEN it SHALL renew only eligible managed accounts, preserve disabled accounts, and synchronize successful rotations without overwriting unrelated or newer CPA credentials.
4. IF a job fails or the plugin stops THEN jobs SHALL remain bounded, avoid overlap and cleanly cancel; console responses SHALL exclude credentials.

## 非功能需求

- NFR-1: Health/startup, requests and timers have bounded time and payload limits.
- NFR-2: A separate rotating bridge token stays private; no broad browser descriptor, secrets in renderer/logs, arbitrary forwarding, or external binding.
- NFR-3: Retain upstream license, complete source provenance and rebuildable package inputs; exclude private files and cached artifacts.

## 依赖关系

Existing Register host lifecycle, reg-machine exports and token renewal, native CPA ABI 1/RPC schema 6, package preparation and existing UI language support.

## 检查清单

- [x] Requirements, measurable EARS acceptance, boundaries and dependencies are explicit.
- [x] All FR IDs are covered by design and tasks.

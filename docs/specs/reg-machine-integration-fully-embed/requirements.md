# 需求文档：reg-machine-integration-fully-embed

## 功能概述
Embed the existing local reg-machine project into Coding Tools with a Runtime Register screen, the original complete frontend, managed backend lifecycle and app-handler APIs. Preserve the current local source including uncommitted features.

## 历史经验与坑（来自记忆库）
Preserve the dirty source tree; offline verification is separate from live account creation, token mutation, SMS rental or deployment. Never bundle existing accounts, credentials, vaults or browser profiles.

## 术语定义
- Register: the Coding Tools Runtime navigation entry for reg-machine.
- Owned backend: a loopback-only child process started and stopped by this app.
- Source snapshot: allowlisted source files with SHA256 provenance, excluding all private runtime data.

## 范围边界
In Scope: all existing local backend/frontend features, auxiliary customer portal APIs, isolated storage, lifecycle, app-handler operations, packaging and verification.
Out of Scope: live registration, provider login, token changes, purchases, existing data migration, installed app patching and source-project changes.

## 需求列表
### FR-1: Preserve complete source and original UI
**优先级:** Must
**用户故事:** As a Coding Tools user, I want every existing reg-machine feature available inside Runtime Register.
#### 验收标准（EARS）
1. WHEN Register opens THEN the system SHALL display the complete original frontend.
2. WHEN snapshotting source THEN the system SHALL preserve source provenance and AGPL license without importing private data.
3. IF frontend or backend artifacts are missing THEN the system SHALL report the actual missing dependency.

### FR-2: Manage isolated backend and complete APIs
**优先级:** Must
**用户故事:** As an app user, I want register APIs and processes managed by Coding Tools.
#### 验收标准（EARS）
1. WHEN Register starts THEN the system SHALL own a loopback backend with a fresh isolated database and private authentication.
2. WHEN a known API operation is invoked THEN the system SHALL enforce its actual mutation metadata and preserve backend authorization.
3. WHEN binary downloads or task events are used THEN the system SHALL preserve binary data and event streams.
4. WHEN the app exits THEN the system SHALL stop only its own backend children.
5. IF runtime startup fails THEN the system SHALL show a bounded actionable error without exposing secrets.

### FR-3: Ship a self-contained release
**优先级:** Must
**用户故事:** As a portable app user, I want Register to work without installing Python manually.
#### 验收标准（EARS）
1. WHEN release packaging runs THEN the system SHALL bundle the backend executable, frontend, required browser runtimes and source/license.
2. WHEN package verification runs THEN the system SHALL verify local lifecycle, UI, API contracts and missing-artifact behavior.

## 非功能需求
- NFR-1: Startup is bounded to 45 seconds; failed startup leaves no owned child running.
- NFR-2: No credential or database source data is copied; backend binds only 127.0.0.1 with generated credentials.
- NFR-3: Existing app modules and user work remain unchanged; verify Windows target plus platform packaging paths.

## 依赖关系
Existing generic apps.call IPC, handler registry, managed lifecycle conventions, FastAPI/SQLModel, React/Vite, PyInstaller and provider browser dependencies.

## 检查清单
- [x] Requirements have stable IDs and explicit exclusions.
- [x] Existing source is read-only and tests use isolated storage.

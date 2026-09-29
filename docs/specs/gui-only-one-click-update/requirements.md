# 需求文档：gui-only-one-click-update

## 功能概述

Add a one-click GUI update to Coding Tools. A verified renderer bundle replaces the visible GUI in place while the existing Electron process, MCP runtime, Codex Bridge, and Proxy Bridge continue running.

## 历史经验与坑（来自记忆库）

Current source confirms the full installer calls requestQuit, which shuts down runtime services. The new action must bypass that path. Preserve the existing dirty worktree.

## 术语定义

- GUI bundle: compiled index.html and renderer assets, with no executable, preload, runtime, or bridge files.
- Shell version: the installed Electron application version and IPC implementation.
- GUI revision: a positive integer released independently for one shell version.

## 范围边界

In Scope: compatible GUI release discovery, one-click download/apply, renderer reload, recovery, settings/sidebar copy, bundle packaging and an opt-in release workflow.

Out of Scope: whole-app installation, restarting or updating MCP/bridges, changing their routes, publishing a release in this session, broad GUI restyling.

## 需求列表

### FR-1: One-click GUI update

**优先级:** Must
**用户故事:** As a desktop user, I want one update action that checks, downloads and applies a GUI build.

#### 验收标准（EARS）

1. WHEN Update GUI is clicked THEN the system SHALL check for the newest compatible GUI revision and apply it in one action.
2. WHILE downloading or applying THE system SHALL show progress and prevent duplicate installations.
3. IF no newer compatible revision exists THEN the system SHALL show that the GUI is current.

### FR-2: Preserve service continuity and recovery

**优先级:** Must
**用户故事:** As a user with active services, I want GUI updates without service restarts.

#### 验收标准（EARS）

1. WHEN a GUI update is applied THEN the system SHALL reload only the renderer, without requestQuit, an installer worker, route restoration, or service lifecycle calls.
2. IF verification or loading fails THEN the system SHALL retain the previous GUI and leave services running.
3. WHEN the app next starts THEN the system SHALL restore the last successful compatible GUI bundle.

### FR-3: Compatible verified release artifacts

**优先级:** Must
**用户故事:** As a release author, I want to ship GUI revisions without distributing backend changes.

#### 验收标准（EARS）

1. WHEN a release is selected THEN the system SHALL require the matching shell version, GUI bundle and SHA256SUMS.txt.
2. IF the checksum, shell fingerprint, revision or file paths are invalid THEN the system SHALL reject the bundle.
3. WHEN the GUI release workflow publishes THEN it SHALL require an explicit publish input and unchanged backend source relative to the shell tag.

## 非功能需求

- NFR-1: Bound decoded bundle data to 64 MiB and 256 files.
- NFR-2: Preserve context isolation, sandbox and renderer navigation restrictions.
- NFR-3: Use Node builtins and the existing update helpers; add no dependency.
- NFR-4: Keep the existing utility layout and support English and Traditional Chinese compact states.

## 依赖关系

GitHub Releases for p90-lover/coding-tools-mcp; the installed shell must contain this updater. The first shell adoption is a later installation, while later GUI revisions use the in-place path.

## 检查清单

- [x] Core and failure paths have measurable acceptance criteria.
- [x] FR IDs, boundaries and compatibility constraints are explicit.

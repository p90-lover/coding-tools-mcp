# 需求文档：add-codex-cli

## 功能概述

Show and update the official stable Codex CLI from Coding Tools' App Plugins on Windows x64 and arm64 without replacing a running installation.

## 历史经验与坑

Use the existing per-item auto-update scheduler. A global npm Codex can be in use by the local bridge and must not be overwritten during an app update.

## 术语定义

- Managed Codex: a verified version stored under Coding Tools' tools directory.
- Stable: a plain x.y.z release advertised by OpenAI's npm package `latest` tag.

## 范围边界

**In Scope:** version display, manual install/update, opt-in scheduled updates, and selection of the checked binary for default native launches and for the next AO daemon start.

**Out of Scope:** replacing the global npm install or an explicit executable override, copying credentials, interrupting chats, or changing approval routing. Codex 0.171's experimental shell review is a separate investigation, not a feature of this updater.

## 需求列表

### FR-1: Show and install a stable CLI

**优先级:** Must. **用户故事:** As a user, I can see the installed and latest versions and install updates manually or turn on auto-update for Codex alone.

#### 验收标准（EARS）

1. WHEN App Plugins checks for updates THEN it SHALL show the official stable Codex version and whether it can be installed.
2. WHILE the Codex auto-update toggle is off THE scheduler SHALL leave Codex unchanged.
3. WHEN the toggle is on and a newer supported version is found THEN the scheduled pass SHALL install it.

### FR-2: Preserve the existing installation and sessions

**优先级:** Must. **用户故事:** As a user, I can leave Codex chats running while an update is staged and verified.

#### 验收标准（EARS）

1. WHEN a version is installed THEN the app SHALL verify the official platform package checksum and binary version before publishing it in its own tools directory.
2. IF download, extraction, or version validation fails THEN the app SHALL keep the previously usable copy and never select the failed build.
3. WHEN default native Codex is selected or AO starts a daemon after installation THEN it SHALL prefer the verified managed CLI without changing sign-in state or active Codex processes.

## 非功能需求

- NFR-1: Do network, archive, and binary checks off Electron's main thread; enforce download and command bounds.
- NFR-2: No credentials in registry requests, no install scripts, no in-place replacement, and no metered review fallback.
- NFR-3: Keep other updater entries and explicit selections working.

## 依赖关系

Existing App Plugins updater and settings, Windows tar, the public npm registry, and the pinned AO daemon build.

## 检查清单

- [x] Scope, acceptance and preserved permission boundaries are explicit.

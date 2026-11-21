# 设计文档：add-codex-cli

## 概述

App Plugins uses the same manual and scheduled entry points as other tools, with a versioned Codex installer. Covers FR-1, FR-2 and NFR-1 through NFR-3.

## 技术方案

### 技术选型

Use Electron's off-main remote fetch, exact official OpenAI npm platform tarballs, SHA-512 integrity, and Windows tar. Execute only `--version` on a checksum-verified staged binary.

### 架构设计

App Plugins calls one Codex CLI service for status, the stable version, and install. A checked install is published by renaming its staging directory into a versioned tools folder. The native resolver reads the service's current binary; the AO daemon receives the absolute binary path on startup. The bundled Go build applies the resolver change through an overlay so the checked-in submodule is not edited.

## 数据模型

The existing per-item settings store holds `autoUpdate["codex-cli"]`. Immutable directories are named by a stable version; incomplete staging directories are not considered installed.

## API 设计

`createCodexCli` supplies `status()`, `latest()`, `install(release)`, and a read-only managed executable getter. App Plugins uses the existing list/update/setAutoUpdate operations. `CODING_TOOLS_MANAGED_CODEX_EXE` is set by the Electron launcher for a newly started AO daemon.

## 文件结构

`desktop-electron/electron/codex-cli.cjs` implements the installer. `app-plugins.cjs` and `main.cjs` wire it in. `desktop-electron/scripts/build-agent-orchestrator.cjs` applies the overlay from `desktop-electron/patches/agent-orchestrator/managed-codex.patch`. Focused tests are in `desktop-electron/tests`.

## 设计决策

### 决策 1: Use side-by-side packages (FR-2)

The global CLI is outside the app's ownership and can be in use. Install in the app's own folder without changing npm, system PATH, or the Codex home. An already started daemon and its chats keep their existing binaries.

## 测试策略

Use synthetic npm registry responses and archives, verify good install/atomic swap, reject mismatch and unsafe package entries, test opt-in and version display, and check the overlay against the pinned source.

## 风险评估

An invalid or partial package must never be launched. Verify the exact registry URL and identity, bound the stream, verify checksum and tar entries, and validate its version before publication. Preserve old executable paths that active sessions might still need.

## 检查清单

- [x] Both requirements are covered without redefining Guardian or account permissions.

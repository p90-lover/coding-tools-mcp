# Design: CPA Accounts integration

## 对应需求

FR-1 through FR-6.

## 概述

### Existing flow
Runtime > OAuth Accounts opens ProviderCenterSurface; More > CPA embeds CPA's original UI. CommandCode uses a separate in-tree Node proxy and an existing main-process browser login or CLI auth import. Codex Router is a separate managed module with many callers.

## 技术方案

### UI
Rename the Runtime OAuth entry to Accounts and use the existing CPA OriginalUiSurface, opening its Auth Files section by default. Keep More > Providers and More > CPA for advanced views. Remove the API Models and Codex Router entries. Map old persisted surface IDs to a live destination.

### CPA
Extend `runtimeConfiguration` in `cpa-managed.cjs` with persistent plugin settings. Keep the current generated management/proxy keys and auth directory. Bundle the verified Go-plan plugin and a Studio Provider API plugin, each exposing its own CPA OAuth login option. Keep their auth files separate by provider key. Use the existing CommandCode browser callback pattern and CLI auth-file import; CPA persists the selected credential and routes its models through the matching executor. Do not expose a raw key to the renderer.

### Migration
Remove Codex Router's active backend, discovery, startup, routing selection, and packaging references. Route surviving Codex OAuth traffic directly to CPA and keep only state-reading migration code necessary for existing profiles. Move the in-tree CommandCode module and bundled source to recoverable Trash after CPA registration and a real local request succeed. A failed plugin install leaves the old module operational.

## 文件结构

- `desktop-electron/src/App.tsx`, `OriginalUiSurface.tsx`: navigation and CPA auth view.
- `desktop-electron/electron/cpa-managed.cjs`, `provider-network.cjs`: plugin config and credential import.
- `desktop-electron/electron/*external-services*`, `modules/`, `app-handler/`, package scripts: module removal.
- `desktop-electron/tests/`: focused regression coverage.

## Verification
Check generated CPA YAML, plugin registration/effectiveness, model discovery and one authenticated local inference. Run focused navigation, CPA config, account login, and module-catalog tests plus the frontend build. Review the change against the current dirty worktree.

# Coding Tools rc.9 One-App Tabbed UI Amendment

## Status

Approved amendment to `docs/superpowers/specs/2026-09-18-one-app-managed-five-stack-design.md`.

This amendment supersedes any wording that permits a managed engine to open as a separate desktop application or that hides the five managed engines as independent sidebar pages under a generic “More” group.

## Product rule

Coding Tools uses **one main window and one persistent app-tab workspace**. The managed engines are first-class tabs inside that window:

1. CPA / CLIProxyAPI
2. Codex Router
3. CommandCode Proxy
4. Paseo
5. Anneal

The user changes engines by selecting a tab. They do not launch, arrange, or manage separate windows.

## Navigation model

The left sidebar is reserved for product-level navigation:

- Browser
- Setup
- MCP
- Managed Apps
- Activity
- Settings

Selecting **Managed Apps** opens the persistent engine tab strip. The tab strip remains visible while an engine tab is active and carries per-engine health, install, and action-required status.

Existing deep links to Provider Center, Integrations, Paseo, Anneal, or Network remain accepted for compatibility, but user-facing navigation routes them into the appropriate Managed Apps tab instead of creating fragmented pages.

## Tab behavior

Each tab has:

- a stable identifier;
- localized English and Traditional Chinese label;
- health indicator;
- install or repair indicator;
- running or stopped indicator;
- action-required indicator;
- retained active-tab state across ordinary navigation and application restart;
- a tab header action area for install, repair, start, stop, restart, refresh, and diagnostics when applicable.

Tabs are fixed product tabs rather than disposable browser-style tabs. They cannot be accidentally closed. Engine processes continue running when the user switches tabs unless the user explicitly stops them.

## Embedded upstream interfaces

- **CPA:** embed the original `management.html` interface inside the CPA tab. Provider Hub account controls may appear as a native subtab, but there is no second CPA window.
- **Codex Router:** host the original Control Center renderer in an isolated `WebContentsView` attached to the Coding Tools main window. The upstream `routerControl` API is provided through a purpose-specific preload bridge. Do not spawn a second Electron application.
- **CommandCode Proxy:** render the app-managed lifecycle, account/session, endpoint, model, and CLI identity controls in its tab because the pinned upstream has no HTML dashboard.
- **Paseo:** embed the original interface using real upstream routes inside its tab, with native orchestration controls available as a subpanel.
- **Anneal:** embed the original hash-routed interface inside its tab, with native task/orchestrator controls available as a subpanel.

No upstream tab receives the complete Coding Tools preload API. Every embedded interface receives only its bounded bridge.

## Layout

The Managed Apps workspace has three layers:

1. a sticky engine tab strip;
2. an optional compact engine toolbar for lifecycle and diagnostics;
3. a full-height content viewport for the selected original or native interface.

The layout must remain usable at narrow widths. The tab strip may scroll horizontally, but engine content must not be compressed into an unusable card column.

## State and lifecycle

The renderer persists only the active tab identifier and non-secret presentation state. The Electron main process remains the authority for component installation, secrets, processes, and health.

Switching tabs must not:

- restart an engine;
- recreate its account store;
- lose an OAuth flow;
- unload a long-running Paseo or Anneal task;
- expose credentials to renderer state.

An embedded view may be hidden when inactive, but its durable service state and task state remain managed by the main process.

## Acceptance criteria

The amendment is complete when a user can open Coding Tools, choose **Managed Apps**, and operate CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal by switching tabs in the same window. No engine requires a separately launched desktop window, and no primary engine is hidden behind multiple unrelated sidebar pages.
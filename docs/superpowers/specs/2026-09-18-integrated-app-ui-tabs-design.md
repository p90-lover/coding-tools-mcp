# Integrated App UI Tabs Design

## Goal

Expose the five integrated application experiences—CPA / Provider Hub, Codex Router, CommandCode Proxy, Paseo, and Anneal—inside one Coding Tools workspace surface, with one dedicated tab per application.

## Product decision

The sidebar keeps the stable Coding Tools shell and adds one primary **Apps** entry. Selecting Apps opens a full-height tab workspace with these tabs:

1. CPA / Accounts
2. Codex Router
3. CommandCode Proxy
4. Paseo
5. Anneal

The existing Provider Hub, managed-service controls, and upstream tool surfaces remain the implementation authority. This change reorganizes them into a predictable tabbed workspace instead of adding a second runtime or duplicating business logic.

## Architecture

### Apps workspace

Create `IntegratedAppsSurface.tsx` as the tab coordinator. It owns only the selected tab and delegates all service behavior to existing components.

- `cpa`: `ProviderCenterSurface`
- `codex-router`: focused `ExternalServicesSurface`
- `commandcode-proxy`: focused `ExternalServicesSurface`
- `paseo`: `UpstreamToolSurface` plus `PaseoOrchestratorSurface`
- `anneal`: `UpstreamToolSurface` plus `AnnealTasksSurface`

The selected tab is persisted in renderer local storage as a non-secret UI preference. Unknown values fall back to `cpa`.

### Shell integration

Add `apps` to the `Surface` union. Replace the separate Providers, Integrations, Paseo, and Anneal sidebar entries with one Apps entry. Keep the legacy surface values and render branches temporarily for compatibility with existing callbacks and tests; they are no longer primary navigation items.

The native ChatGPT browser surface must be disabled before entering Apps, exactly like all other non-browser surfaces.

### Focused service mode

Extend `ExternalServicesSurface` with an optional `focusServiceId` property. When supplied:

- initialize and keep selection on that service;
- hide the all-services summary cards;
- show the selected service editor and lifecycle controls only;
- keep the same install, start, stop, restart, repair, health, and secure credential behavior.

No runtime logic is duplicated in the tab coordinator.

### Paseo and Anneal routes

Use the real upstream routes:

- Paseo: `/sessions`, `/open-project`, and `/settings`.
- Anneal: hash routes such as `#/tasks`, `#/projects`, and `#/settings`.

When a service is already ready, its first upstream section opens automatically inside the tab. Connection controls remain available and do not cover the embedded UI.

## Interaction and accessibility

- Use a semantic `role="tablist"`, `role="tab"`, and `role="tabpanel"` structure.
- Left and right arrow keys move between tabs; Home and End jump to the first and last tab.
- Active tab state is visible and announced with `aria-selected`.
- The tab strip scrolls horizontally on narrow windows.
- Each panel owns its vertical scrolling; no action may be clipped below the workspace.
- English and Traditional Chinese labels are provided for every new control.

## Security and retention

- No provider secret, OAuth token, proxy key, or orchestrator credential is stored in local storage.
- The tab preference contains only one allowed tab ID.
- Existing encrypted main-process credential boundaries remain unchanged.
- No project file, branch, release, or retained evidence is deleted.
- Temporary validation material stays under `aiTemp/` or `aiTemp/Trash/`.

## Acceptance criteria

1. One Apps sidebar item opens a workspace containing all five app tabs.
2. Every tab is reachable by mouse and keyboard.
3. Switching tabs never leaves the native browser view over the app surface.
4. CPA renders account management, Codex Router and CommandCode render focused service controls, and Paseo/Anneal render their actual embedded interfaces.
5. The selected tab survives an app renderer reload.
6. Existing provider, service lifecycle, routing, and upstream tool tests remain green.
7. TypeScript and production renderer builds pass.
8. A focused contract proves all five tab IDs and shell wiring.

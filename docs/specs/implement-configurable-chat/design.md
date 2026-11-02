# Design: configurable chat pages

## 概述 / Architecture
Add ChatPages at the existing App chat entry. It lazily mounts AgentOrchestratorSurface for visited page numbers, keeps their React keys stable and combines the parent visibility context with each page's visibility. The current single-page experience remains the default.

## 技术方案 / Data model and persistence
A bounded, validated renderer preference record stores whether tabs, keyboard and wheel navigation are enabled, page count, and the two shortcuts. A small shared external store publishes local changes to Settings and the page host. The active page is saved independently. Per-page storage keys retain the legacy workspace and split keys for page 1, and suffix them for later pages. A separate selection record restores the primary chat only after its project's board and runs are loaded. New-chat draft scopes include the page number.

## Ownership and input
A page registry maps each mounted page to its displayed chats and pane-focus callback. Cross-page opens reveal the existing owner. Registry cleanup only removes the registration it created, including React StrictMode replacement. Existing chat task and session IDs remain unchanged. Native queue execution remains backend-owned.
Keyboard handling checks focus, composition, modifiers, editable ancestors and dialogs. A non-passive wheel listener is attached only to the tab list. Existing global chat shortcuts and root polling consult useSurfaceHidden so an inactive page cannot act on the current page's keys.

## UI and styling
Reuse the app's quiet monochrome surfaces, existing button shapes, typography and Settings rows. Use plain CSS, matching the current renderer. Tabs have accessible names, selected states, tabpanel relationships and arrow-key navigation. No decorative animation is added.

## 文件结构 / File structure
New renderer files: desktop-electron/src/features/chat-pages.ts, ChatPages.tsx and chat-pages.css. Integrate through App.tsx, AgentOrchestratorSurface.tsx, ChatSettingsPage.tsx and ChatThreadList.tsx. Add desktop-electron/tests/chat-pages.test.cjs and update only affected wiring expectations.

## Design decisions
Keep visited pages mounted to preserve in-flight UI state and drafts. Add pages explicitly rather than imposing a new page on every message. Hide page tabs without closing sessions. Keep normal wheel behavior outside the tab list. Reuse local layout persistence rather than introducing backend configuration or native keyboard registration.

## Test strategy
对应需求: FR-1, FR-2, FR-3.
One focused Node test group covers preference validation, shortcuts, ownership and persistence helpers, plus existing split/Settings/wiring regressions. Run renderer TypeScript checking. A disposable renderer harness verifies add/select, draft retention, settings/rebinding, wheel scoping, disabled navigation and narrow layout using real browser input.

## Risks
Global shortcuts and polling from hidden roots must be fenced. A corrupt or missing saved route must resolve to a usable new chat. The current GitNexus index lacks the new chat components; graph UNKNOWN results require current-source caller checks and must not be described as a clean impact result. No installed-runtime performance or live provider inference claim is made from renderer checks.

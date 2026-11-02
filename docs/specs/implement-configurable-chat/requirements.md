# Configurable chat pages

## 功能概述 / Overview
Give Coding Tools Chat more independent places for chat sessions without replacing its existing split layout. Pages are an optional renderer feature; running chats stay owned by the existing backend.

## 需求列表 / Functional requirements
### FR-1: Open and retain chat pages
Settings > Chat can show or hide page tabs and add pages, up to 12. The tab bar can also add a page. Each visited page keeps its mounted chat and split panes, drafts, current project and session selection. Fresh additional pages start with a new chat, rather than selecting another page's current chat. Hiding the tabs keeps the current page and running chats intact.
Acceptance: the renderer SHALL retain different drafts and split layouts when switching between two added pages. It SHALL restore the saved selection and per-page project, chat and layout after relaunch, preserving first-page storage compatibility.

### FR-2: Configurable navigation
Settings independently enable keyboard and wheel navigation. Next defaults to Shift+E; previous defaults to Shift+R. Both key combinations can be recorded again and cannot conflict. Keyboard navigation ignores typing, IME composition, repeats, AltGr, and active dialogs. The wheel changes pages only over the page tabs, as explicitly selected by the user, and is throttled per gesture. Navigation wraps at either end.
Acceptance: both defaults and changed bindings SHALL navigate only when enabled. Message scrolling and normal uppercase input SHALL remain unchanged.

### FR-3: Isolate inactive pages
Inactive pages use the existing SurfaceHiddenContext, stay mounted after a visit, and perform no UI polling or chat keyboard actions. Opening a chat already displayed on another page reveals that page and focuses its pane, preserving the existing session instead of opening a duplicate view.
Acceptance: the registry SHALL preserve distinct workspaces, reject stale unregister callbacks and reveal duplicate requests on the owning page. Hidden pages SHALL ignore chat shortcuts, and page switches SHALL make no cancel, restart or credential calls.

## 非功能需求 / Non-functional requirements
Reuse existing React, split-view helpers, visibility context, Settings primitives and plain CSS tokens. No new dependencies, native routes, credentials, release/version changes or installed-app modification. Retain unrelated work in the shared checkout. Deliver an isolated commit and PR; do not merge it.

## 依赖关系 / Dependencies and scope
Page tabs, local renderer preferences, per-page view persistence, necessary hidden-page input/poll guards, focused regression tests and renderer interaction verification. Page deletion and automatic public releases are outside this change.

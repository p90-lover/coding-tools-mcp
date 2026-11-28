# Requirements: UI settings mirror

## 功能概述

Coding Tools keeps its window's own settings in the renderer's `localStorage`: the split view (panes, column weights, row split), chat pages and their selection, open projects, project order, chat sections, the image toolbar, the agy terminal, the last chat route, the response style and about forty more.

On 2026-11-27 Bitdefender's ATC quarantined two files of `G:\AppData\Coding Tools\Local Storage\leveldb`. Chromium found the store damaged and started an empty one, so every one of those settings was lost. The user could not restore the quarantined files and no other copy existed.

This feature keeps a copy of the app's own keys in a JSON file under userData and puts them back, before the UI reads them, when Chromium hands the app an empty store.

## 历史经验与坑（来自记忆库）

- **可复用经验**:
  - `atomic-file.cjs` `writePrivateFileAtomicAsync` (temp file + rename, retried on Windows locks, queued per file) and the `saving`/`saveAgain` + last-written-text pattern of `app-layout.cjs`.
  - Renderer modules are tested by transpiling them with `typescript` and running them in a `vm` with fake globals (`chat-response-style.test.cjs`); the Surface split view by `surfaceComposer` in `ao-chat.test.cjs`.
- **必须规避的坑**:
  - Never write what hasn't changed, and never flush synchronously on Electron main (AGENTS.md, disk space).
  - `ipcRenderer.sendSync` blocks the page until main sets `event.returnValue`; a handler that is missing or throws first leaves the window frozen.
  - A file the app writes can be quarantined in the same ATC rollback as the store (window-state.json was, on 2026-11-27).
  - A new `electron/*.cjs` that only `main.cjs` requires ships in app.asar and needs no `BACKEND_MODULES` entry.

## 术语定义

- **App key**: a `localStorage` key the app itself writes for its own settings (`coding-tools:*`, `coding-tools-*`, `native-codex:*`, `email.read.*`, `cdx-image-toolbar-position`).
- **Mirror**: `ui-settings-mirror.json` in userData, holding the app keys and their string values.
- **Empty store**: a `localStorage` with none of the app keys.

## 范围边界

**In Scope**
- Mirroring app keys from the main window's `localStorage` to the mirror file.
- Restoring them from the mirror into an empty store before any screen reads it.
- Keeping secrets out of the mirror.

**Out of Scope**
- `sessionStorage` (per run by design) and other origins (browser panes, sites).
- Settings main already keeps in files (window-state.json, chat drafts, goals, app layout).
- Partial loss inside a store that still has some app keys (Chromium either keeps the store or replaces it whole).
- Protection from an antivirus rollback that also takes the mirror file (see design, risks).

## 需求列表

### FR-1: Keep a copy of the app keys

**优先级:** Must
**用户故事:** As the person using Coding Tools, I want my layout and settings copied outside Chromium's store, so that a damaged store does not lose them.

#### 验收标准（EARS）

1. WHEN the page sets, removes or clears app keys THEN the app SHALL write the current app keys to the mirror within a few seconds, coalescing a burst of changes into one write.
2. WHEN the page is hidden or unloaded with a change pending THEN the app SHALL send the pending copy at once.
3. WHEN the app keys are the same as in the mirror THEN the app SHALL NOT rewrite the file.
4. The mirror SHALL be written with `writePrivateFileAtomicAsync` (temp file and rename, off the main thread).
5. WHEN a key that is not an app key changes THEN the app SHALL NOT write the mirror.

### FR-2: Restore an emptied store before the UI reads it

**优先级:** Must
**用户故事:** As the person using Coding Tools, I want the app to bring back my split view and other settings by itself after its store was reset.

#### 验收标准（EARS）

1. WHEN the page starts with an empty store and the mirror holds entries THEN the app SHALL put every mirrored app key back into `localStorage` before any screen module runs.
2. WHEN the store already holds app keys THEN the app SHALL NOT read the mirror and SHALL NOT change the store.
3. IF the store is empty and the mirror cannot be read (busy, locked, refused) THEN the app SHALL leave the store as it is and SHALL NOT overwrite the mirror during that run.
4. IF the mirror is missing THEN the app SHALL start mirroring from the current store. IF it is damaged (not JSON or the wrong shape) THEN the app SHALL treat it as missing and replace it on the next change.
5. WHEN a restored store is used by the chat Surface THEN the split view's panes, weights and row split SHALL come back as saved.

### FR-3: Never mirror secrets

**优先级:** Must
**用户故事:** As the person using Coding Tools, I want no secret copied into a plain file.

#### 验收标准（EARS）

1. The app SHALL mirror only app keys, and SHALL drop any key whose name mentions a secret, token, password, credential, API key, cookie, bearer or private key, in the page and again in main.
2. Main SHALL accept a copy only from the main window's top frame, and SHALL drop non-string values and oversized entries.
3. WHEN a key is read back from the mirror THEN the app SHALL restore it only if it still passes the same rule.

## 非功能需求

- **NFR-1 (cost):** no IPC and no file read at start while the store is intact; one small sync read only after a reset.
- **NFR-2 (disk):** at most one write per burst (1.5 s quiet, at most every 10 s while changes continue), none when nothing changed.
- **NFR-3 (safety):** the sync load always answers, so a failure can never freeze the window.
- **NFR-4 (limits):** values up to 256 KiB, the whole copy up to 2 MiB; above that the largest values are left out so the small settings still fit.

## 依赖关系

- `desktop-electron/electron/atomic-file.cjs` (`writePrivateFileAtomicAsync`).
- The minimal pre-renderer IPC in `main.cjs` (`registerMinimalPreRendererIpc`), which runs before the renderer loads.
- The preload's `codexWebLauncher` bridge (context isolation, sandboxed preload bundled by `scripts/build-preload.cjs`).
- Release: 0.8.172 (#1377) is closed to new work, so this joins 0.8.173 on top of `release/0.8.172` (14832dd05).

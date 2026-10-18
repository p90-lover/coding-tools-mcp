# Register

Coding Tools hosts the complete reg-machine frontend under **Runtime → Register**, with its own managed backend and private account store. The frontend includes accounts, registration, task history and events, authenticator, proxies and settings. The original registration APIs and auxiliary customer-portal APIs are exposed through the existing in-process apps handler.

## App API

Use `codingTools.apps.catalog()` to enumerate the module's lifecycle operations and all 144 named API routes. Call `start` or `ui-open` before API operations:

```js
await codingTools.apps.call({ moduleId: "reg-machine", operation: "start" });
await codingTools.apps.call({
  moduleId: "reg-machine",
  operation: "accounts_list_accounts",
  arguments: { query: { page: 1, page_size: 20 } },
});
```

Route operations accept `parameters` for named path segments, `query` for scalar query values, and `body` for the original JSON request body. The original backend validates each request. Responses retain HTTP status and content type; binary exports use `dataBase64` and `disposition`. Event operations return a custom-origin URL suitable for EventSource.

The customer portal keeps its original authentication and role checks. `portal_auth_login` accepts the original `account` and `password` body and returns an opaque desktop `sessionId`. Pass that as `portalSession` on subsequent API operations. Refresh and logout use the same opaque session; raw JWT and refresh credentials remain in the main process. Portal event URLs carry an opaque desktop capability which the protocol removes before forwarding.

`portal-owner-session` is an explicit mutating operation for signing in as the local app owner. It does not run automatically during reads, and customer sessions do not gain owner permissions.

## Runtime and storage

The app owns the backend child and binds it to 127.0.0.1 on an allocated port. The original UI, JSON requests, binary downloads and SSE streams use `coding-tools-register://app`; backend authentication stays in the main process. This avoids sharing authentication cookies across unrelated localhost ports.

Data lives under the app's user-data `register/` directory. Existing reg-machine account databases, credentials, vaults and browser profiles are not imported. The optional solver starts only after an explicit authenticated action. Desktop adapters refuse an unowned solver listener and stop only the recorded child.

## Build and verification

`desktop-electron/scripts/build-reg-machine.cjs` prepares a private virtual environment, builds the original frontend, bundles Playwright/Patchright/Camoufox browser resources and freezes the complete backend with PyInstaller. Release packaging runs this step and ships its resources; portable users do not install Python manually.

All build caches and outputs default to the repository's `aiTemp/reg-machine-build/`. `REG_MACHINE_BUILD_ROOT` can point to another task-owned scratch directory. The builder resolves Windows junctions before invoking Vite.

The focused Node regression covers source hashes, API metadata, origin/path validation, private portal sessions and permissions, all six event streams, binary responses, credential persistence failures and startup/shutdown races. `scripts/smoke-reg-machine.cjs` checks the frozen browser runtimes on offline data pages, isolated account CRUD/export, portal authentication and the rendered original frontend. It performs no provider registrations, login, SMS rental or payment actions.

## Source and license

`source/` preserves 312 allowlisted files from the existing local working tree, including uncommitted features, plus the local authenticator helper's source/public files. `SOURCE_SNAPSHOT.json` records upstream HEAD, the working-tree inventory and each file's SHA256. Build overlays are kept in the desktop builder and entrypoint; the source snapshot remains unchanged.

The original reg-machine source is **AGPL-3.0**. Its complete license is retained in [source/LICENSE](source/LICENSE). Environment files, account databases, exports, runtime state, private vaults, tokens, cookies and browser profiles are excluded.

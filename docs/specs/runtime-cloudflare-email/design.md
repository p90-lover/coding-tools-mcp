# Runtime Email: design

Date: 2026-09-28. Written-spec review draft. Covers FR-1 through FR-6 and NFR-1 through NFR-5 in [requirements.md](./requirements.md).

## 概述 / Approved outcome

A native **Runtime → Email** panel reads and manages the owner's existing Cloudflare mailbox service. It does not embed the Cloudflare dashboard, require dashboard cookies, deploy a Worker, or grant agents access to mail.

## 技术方案 / Architecture

Use the current `desktop-electron` React/Electron app, not the older Tauri-only architecture described in the repository's dated overview.

```text
Runtime → Email (trusted React renderer)
  → narrow, validated desktop-only Email IPC
  → Electron main-process mail client and encrypted credential
  → existing outbound network policy / normal TLS
  → https://mail-api.leunghongyu.com
  → existing Worker and D1 mailbox data
```

The Email IPC surface must not be registered in the generic app-handler/MCP/AO catalogs. Previewed email content gets no access to this bridge. Read operations require the trusted main renderer but do not prompt merely because the user opens the panel; mutations retain the existing trusted/focused-window boundary.

### Options considered

1. **Native Email panel, selected:** preserves Coding Tools' layout, keeps the admin credential in the main process, and limits management to the approved actions.
2. **Embed the upstream Vue admin interface:** less bespoke UI, but exposes unrelated settings and requires a separate credential/origin integration. Not selected.
3. **Deploy another Worker or change its API:** unnecessary for the approved operations and outside scope.

### Existing source evidence

Reference project, read-only: `C:/Users/simon/Documents/ChatGPT/reg-machine`.

- `aiTemp/cfmail-staging/worker/wrangler.toml`: `name = "leung-mail-worker"`, entry `src/worker.ts`, domain `leunghongyu.com`.
- `worker/src/worker.ts`: admin middleware checks `x-admin-auth`; optional site authentication uses `x-custom-auth`.
- `worker/src/admin_api/index.ts`: the approved routes below.
- `worker/src/admin_api/admin_mail_api.ts`: paginated mail listing and message read/delete.
- `worker/src/admin_api/address_api.ts`: address listing/creation and the permanent removal cascade.
- `reg-factory/common/temp_email.py`: existing Python adapter for this API family.
- `core/base_mailbox.py`: current client and regression test explicitly configured for the selected custom domain.

The live read-only probe returned HTTP 200 for public settings and authenticated statistics. It reported version `v1.12.0`, 18 messages, and 2 addresses. No message bodies were requested. Sending, synchronized read status, address-password login, and S3 attachment storage are currently disabled. Public user-create/delete flags do not remove the authenticated admin routes.

## API 设计 / Worker contract

All privileged calls attach `x-admin-auth` in the main process only, reject redirects, and use the verified origin. No credential is placed in a URL or renderer storage.

| Operation | Existing endpoint | Contract |
|---|---|---|
| Public capabilities | `GET /open_api/settings` | Feature flags and configured domains |
| Connection check | `GET /admin/statistics` | Counts only, no mailbox mutation |
| Mailboxes | `GET /admin/address` | `limit`, `offset`, optional `query`; `{ results, count }` |
| Messages | `GET /admin/mails` | `limit`, `offset`, optional exact `address`; `{ results, count }` |
| Message detail | `GET /admin/mails/:id` | Raw message row or `null` |
| Create address | `POST /admin/new_address` | Validated `name`, configured `domain`, explicit prefix behavior |
| Delete message | `DELETE /admin/mails/:id` | Confirmation required; verify returned success |
| Clear inbox | `DELETE /admin/clear_inbox/:id` | Confirmation required; address ID, not arbitrary address text |
| Remove mailbox | `DELETE /admin/delete_address/:id` | Confirmation required; permanent cascade described below |

Do not expose generic HTTP URLs, arbitrary paths, arbitrary headers, password-reset endpoints, JWT-display endpoints, database migration routes, webhook settings, or outbound send routes through Email IPC.

### Normalized desktop contracts

- `status`: configured/authenticated/error, origin, domain, capability flags, last successful refresh. No secret fields.
- `mailboxes`: validated ID, address, creation/update time, received/sent counts, total and pagination information. Strip password and token fields.
- `messages`: ID, mailbox, parsed sender/subject/date and bounded preview text. Drop raw MIME before crossing IPC for a list result.
- `message`: ID, normalized headers, bounded decoded text and sanitized HTML inputs, attachment names/types/sizes only. Do not automatically open/download attachments.
- Writes return a discriminated success/cancelled/error/unknown-outcome result, not a raw upstream response.

IDs must be positive bounded integers; pagination is bounded; address creation must use a domain supplied by the verified Worker's settings. Network errors must be translated without including auth headers or email content.

## 数据模型 / Local state and credential import

The Worker remains the source of truth. Do not add a second mailbox database or copy the existing D1 database.

- One-time importer reads only the necessary fields from the already identified private local mail-service configuration: API origin, domain, and admin credential. It does not change the source or copy the JWT signing secret.
- Validate the endpoint against the approved Worker before sending credentials. Verify access with the read-only statistics endpoint before accepting the connection.
- Persist the imported admin credential with Electron `safeStorage` and existing atomic/private-file conventions under the normal app user-data directory. If OS-backed encryption is unavailable, do not persist a plaintext fallback.
- Retain only non-sensitive view preferences, such as selected mailbox and pane widths. Message content is held transiently for the open view, not saved in logs or an automatic disk cache.
- Reopening the app loads the encrypted connection and refreshes reads; it never replays a create/delete request.

This separates mailbox access from Cloudflare dashboard login and removes any ongoing dependency on reg-factory or its generated build tree.

## Visual layout and interactions

Visual direction: Coding Tools' existing restrained dark utility UI, using its tokens and compact controls. No new decorative theme or additional application chrome.

```text
Coding Tools sidebar | Email · connection status · mailbox picker · New address
                     | Mailbox search / Refresh / loaded-message filter
                     | Message list                 | Message headers
                     | sender / subject / date      | HTML | Plain text
                     |                              | readable content
                     | Load more                    | message actions
```

- Fill the available main pane. Keep header controls compact; list and preview have independent, bounded scrolling.
- At narrow widths, show one pane at a time with a visible Back to inbox control; mailbox management remains reachable.
- Mailbox creation uses a name field and the configured domain, not an editable arbitrary API hostname.
- Selected-message highlighting is not presented as a server-synchronized unread flag.
- Message search explicitly covers loaded messages because the current Worker has no full-text message-search parameter. A server-side mailbox-address search and Load more remain available.
- Status communicates connecting, ready, loading, empty inbox, authentication failure, network failure, and uncertain write outcome distinctly.

### Safe preview

Reuse the MIME parsing and sanitizing approach already present in the matching upstream source: `postal-mime` and `DOMPurify`. Verify/pin package versions in the reviewed implementation plan rather than importing the entire Vue application or writing a MIME parser.

Sanitize HTML, then render it in a sandboxed, script-disabled iframe with a restrictive content policy: no network resources, forms, scripts, top navigation, or Electron bridge. Remote images/tracking and automatic link navigation are disabled. Offer plain text as an equal, accessible reading mode. Attachment execution and automatic download are not included.

### Management confirmations

Creation is authorized by the user's explicit form submission. Reads never open generic permission dialogs.

Deletion/clearing/removal each have one main-process-owned confirmation with Cancel as default. Resolve the target from current Worker data and show its real address/message and relevant current counts, not only an internal ID. Prevent duplicate submissions while pending.

Removing a mailbox permanently deletes `raw_mails`, `address_sender`, `sendbox`, `auto_reply_mails`, `users_address`, and the address row associated with it. The current Worker provides no Trash/restore endpoint. The UI must say **permanently removes** and disclose that the change affects every client of this mailbox service. Do not imply a local undo.

On timeout or an interrupted response, reconcile the affected list before allowing a retry. Never automatically retry a destructive operation or mark it complete merely because the request was sent.

## 文件结构 / Implementation boundaries

Existing, inspected integration points:

- `desktop-electron/src/App.tsx`: Runtime navigation and surface switching.
- `desktop-electron/src/types.ts`: surface union and typed launcher API.
- `desktop-electron/src/i18n.ts`, `icons.tsx`, `tokens.css`, `styles.css`: existing presentation vocabulary.
- `desktop-electron/electron/main.cjs`: IPC registration and trusted/focused-window checks.
- `desktop-electron/electron/preload.cjs`, `ipc-schema.cjs`: narrow bridge and schemas.
- `desktop-electron/electron/provider-network.cjs`, `atomic-file.cjs`: existing outbound-policy and file-write conventions.
- `desktop-electron/package.json`, `bun.lock`: reviewed parser/sanitizer dependencies and packaging.
- `desktop-electron/tests/`: established Node test suite and preload/IPC boundary checks.

Proposed new feature boundaries are an `EmailSurface` with scoped CSS, one desktop-only mail host/client, and focused feature tests. Exact file/function changes and impact analysis are reserved for the implementation plan. Do not grow the already large app shell or main process with the full mail implementation.

The source files listed above already have unrelated staged/unstaged changes at baseline `9daf0a6852f779a092962f5ea45fa1b8c2c9981d`; preserve them and check for concurrent edits before implementation.

## 测试策略 / Verification

Use three focused groups: (1) API/auth/pagination/error and mutation-confirmation tests with synthetic fixtures, (2) MIME/HTML and IPC boundary tests, (3) rendered navigation, full-pane, and narrow-window checks. Check that cancelled writes send no remote request and that email previews cannot invoke the bridge or load remote resources.

Live acceptance first uses read-only connection, mailbox listing, and user-selected message preview. Live creation/deletion tests require separately approved disposable targets; do not use the existing real mailboxes as test fixtures. Mock success is not live mutation proof.

Build and verify the normal non-DEV app and its installed Email entry after the reviewed implementation plan. Preserve unrelated package payloads, data, and rollback files, and keep Codex open. No package or installation success is claimed by this document.

## 风险评估 / Risks

| Risk | Mitigation |
|---|---|
| Picking the legacy incompatible Cloudflare client | Use the verified Worker source and admin routes above |
| Credential or email leakage | Main-process credential, normalized IPC, redacted errors, no content logging |
| Malicious email markup | Maintained sanitizer plus isolated, network-disabled preview |
| Permanent deletion mistaken for local cleanup | Explicit target/impact confirmation and no false undo claim |
| Retrying an uncertain mutation | Reconcile before retry; no automatic write replay |
| Older architecture docs or unrelated dirty files | Use current Electron source and preserve existing changes |

## 检查清单 / Review

- [x] Existing API, authentication, permanent-delete semantics, and live capability flags checked.
- [x] Scope matches the user's approved mailbox-management design.
- [x] No secrets, placeholder requirements, or claims of completed implementation included.
- [ ] User review of this written specification.

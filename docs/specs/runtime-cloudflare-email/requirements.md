# Runtime Email: requirements

Date: 2026-09-28. Status: design approved in conversation; written specification awaiting review. Product implementation has not started.

## 功能概述 / Purpose

Add **Runtime → Email** to the normal, non-DEV Coding Tools app so the owner can read and manage the existing Cloudflare mailbox service without switching applications. Reuse `leung-mail-worker` at `https://mail-api.leunghongyu.com`; do not create another Worker or change email routing.

## 历史经验与坑 / Evidence and reuse

- The deployed service has a matching local Wrangler source tree in the user-approved reg-machine reference project. Its Python mail adapter already implements the correct admin-header contract.
- A read-only probe on 2026-09-28 returned HTTP 200 from both `/open_api/settings` and authenticated `/admin/statistics`: version `v1.12.0`, 18 messages, 2 mailboxes. These are a snapshot, not hard-coded UI values or proof of a completed inbox UI.
- The unrelated legacy Node mail adapter uses `/latest`, `/emails`, and `x-api-key`; those are not the selected Worker's contract. Do not copy its disabled TLS verification.
- Cloudflare dashboard sign-in is not the Worker's mailbox credential. Reuse the existing local mail credential privately; no password, API token, mailbox JWT, or message body belongs in this specification, logs, or chat.

## 术语定义 / Terms

- **Mailbox:** an address record managed by this Worker on `leunghongyu.com`.
- **Message:** one received message stored by the existing Worker.
- **Management action:** explicit address creation, message deletion, inbox clearing, or mailbox removal initiated by the user in the Email panel.

## 范围边界 / Scope

In scope: connection/import status, mailbox selection and address search, paginated received messages, message filtering, safe HTML/plain-text preview, address creation, and confirmed destructive management actions.

Out of scope: outbound mail/replies, forwarding or auto-reply configuration, DNS/routing changes, Worker redeployment, new accounts, credential rotation, new MCP/AO email tools, automatic AI processing of email, automatic attachment opening, and changes to reg-machine/reg-factory or unrelated Coding Tools modules.

## 需求列表 / Requirements

### FR-1: Native full-pane Email entry

Priority: Must. As the owner, I can find my mailbox under Runtime rather than More.

- WHEN Email is selected, Coding Tools SHALL display a native full-main-pane inbox to the right of its existing sidebar.
- WHEN navigating from Browser, CPA, or AO, the existing native embedded view SHALL not cover the Email panel.
- WHEN the window is narrow, the list and message preview SHALL switch to a navigable single-pane layout rather than clipping controls or producing horizontal scroll traps.

### FR-2: Reuse the private connection

Priority: Must. As the owner, I can reuse the working mail configuration without pasting a key into chat.

- WHEN the approved existing configuration is imported, the main process SHALL validate the exact HTTPS origin and domain, verify access, and persist only the required mail credential using OS-backed encryption.
- The importer SHALL leave the original configuration unchanged and SHALL not copy its JWT signing secret.
- The renderer SHALL receive status and normalized mail data, never credentials. IF secure storage or authentication fails, the UI SHALL show a clear error without falling back to anonymous or plaintext operation.
- After import, normal operation SHALL not depend on reg-machine, its running services, or its `aiTemp` source tree.

### FR-3: Browse and search mail

Priority: Must. As the owner, I can select a mailbox, refresh messages, and find the message to open.

- WHEN the page opens, the app SHALL load mailbox metadata and the selected inbox without a permission dialog or remote mutation.
- Lists SHALL use pagination, explicit loading/empty/error states, and cancellation or stale-response rejection when the selected mailbox changes.
- Mailbox search SHALL use the existing server-side address query. Message filtering SHALL be clearly labeled **Search loaded messages**; loading another page extends the available results. It SHALL not falsely claim a full-server text search.
- The app SHALL not display a synchronized unread state: this Worker's read-status feature is currently disabled.

### FR-4: Read safe message content

Priority: Must. As the owner, I can inspect sender, recipients, subject, date, HTML, and plain text.

- WHEN a message is opened, the app SHALL parse MIME using a maintained parser, not registration-code extraction regular expressions.
- HTML SHALL be sanitized and rendered in an isolated, script-disabled preview without Node, preload, forms, automatic navigation, or remote tracking resources.
- Email text SHALL be treated as untrusted content, never as instructions to Coding Tools or an agent.
- Malformed or oversized messages SHALL produce a clear preview error and retain access to the message list; the UI SHALL not silently claim a complete preview.

### FR-5: Create mailbox addresses

Priority: Must. As the owner, I can create an address on the existing configured domain.

- WHEN the user submits the address-creation form, the main process SHALL validate the name and allowlisted domain and invoke the existing admin creation endpoint once.
- IF creation fails or its network outcome is uncertain, the app SHALL not blindly retry the write. It SHALL reconcile the address list before offering another attempt.
- The response SHALL discard generated mailbox JWTs and return only the address data needed by the UI.

### FR-6: Confirm destructive management

Priority: Must. As the owner, I can delete selected messages, empty a selected inbox, and remove an address deliberately.

- BEFORE a destructive request, the app SHALL show one app-owned confirmation identifying the Worker, address/message, and affected data, with Cancel as the default.
- Mailbox removal SHALL disclose that the Worker permanently removes the address, received messages, sent records, sender settings, auto-reply records, and user-address links. These changes affect other clients using the same Worker too.
- Cancellation SHALL send no destructive request. Approval SHALL authorize only the displayed action and target, not future deletions.
- IF a write times out, the UI SHALL report an uncertain outcome and reconcile state; it SHALL not automatically repeat the write or report success prematurely.

## 非功能需求 / Non-functional requirements

- **NFR-1:** default page size 20, maximum 50; network requests have a 15-second timeout and a 10 MiB response/inline-message limit. Fail visibly when a limit is exceeded.
- **NFR-2:** use standard TLS validation and Coding Tools' selected outbound route. Never change proxy configuration or silently bypass a selected proxy to make Email connect.
- **NFR-3:** no secrets, raw messages, or headers in application logs, error telemetry, Git, or test artifacts. Test fixtures use synthetic mail.
- **NFR-4:** preserve the app's existing typography, colors, focus treatment, and keyboard navigation. Verify normal desktop, narrower window, and increased text/zoom states.
- **NFR-5:** builds and installation must preserve Codex, AO, CPA, MCP, browser sessions, and existing user data. No additional Git worktree or cloud deployment is required.

## 依赖关系 / Dependencies

The existing Worker and D1 data, the local private mail configuration for one-time import, Electron's secure storage and trusted-renderer IPC checks, the existing outbound proxy policy, and a small maintained MIME parser/HTML sanitizer.

## 检查清单 / Acceptance state

- [x] User approved the expanded management scope and full-pane design.
- [x] Worker identity, API source, and read-only authenticated connection verified.
- [ ] Written specification reviewed by the user.
- [ ] Separate implementation plan reviewed and execution method selected.
- [ ] Implementation, focused tests, installed UI, and real message preview verified.

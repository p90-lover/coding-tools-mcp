# CPA Accounts integration

## 功能概述
Make CPA the account-management view under Runtime > Accounts, replace the local CommandCode proxy with CPA plugins for both CLI/Go-plan and Studio Provider API accounts, and remove Codex Router as a Coding Tools module.

## 需求列表
1. **FR-1** Runtime has one **Accounts** entry. It opens CPA's Auth Files view with access to CPA's login controls. Runtime no longer has **API Models**. General provider configuration remains reachable under More > Providers.
2. **FR-2** CPA plugin support is enabled in its managed configuration with an absolute, persistent, writable plugin directory. Existing CPA auth files, keys, outbound proxy settings, and management access remain intact.
3. **FR-3** CPA's OAuth Login view offers working CommandCode login choices for both CLI/Go-plan and Studio Provider API accounts. Credentials remain in CPA auth files or the main process and never appear in renderer state. The Go-plan plugin routes `/alpha/generate`; the Studio plugin uses the Provider API. Preserve text streaming, reasoning, and tool calls.
4. **FR-4** Install both Windows-compatible CommandCode CPA plugins and prove each registers, is effective, exposes login, lists its models, and completes a local authenticated request before retiring the local CommandCode proxy module. If installation or live verification fails, keep the old module available.
5. **FR-5** Remove the Codex Router backend, sidebar, app module catalog, managed startup, routing selection, and package inputs; direct remaining Codex account traffic to CPA without a Codex Router plugin. Preserve existing user account data and unrelated worktree edits; retain only compatibility code required to read existing state.
6. **FR-6** Removed routes or old saved navigation values resolve to Accounts or Providers without a blank screen.

## 验收标准

- WHEN the user opens Runtime > Accounts and CPA OAuth Login, the application SHALL show working Go-plan and Studio CommandCode login options.
- WHEN CPA starts with its managed config, the runtime SHALL enable plugins from an absolute persistent directory without changing existing credentials.
- WHEN CommandCode CPA plugin registration and a local authenticated inference succeed, the migration SHALL move the old module to Trash.
- WHEN a legacy route is opened, the application SHALL navigate to Accounts or Providers.

## Acceptance
- Runtime > Accounts shows CPA auth files and a CommandCode login option; API Models and Codex Router are absent.
- A fresh CPA config includes `plugins.enabled: true` and an absolute plugin directory.
- CPA reports both CommandCode plugins registered and effective; each account type can select and use its own model through CPA.
- The local CommandCode module is moved to Trash only after the plugin verification succeeds.
- Focused Electron/CPA tests and frontend build pass; no existing accounts or credential files are rewritten during source migration.

## 非功能需求
The worktree contains unrelated in-progress changes. Use exact edits and recoverable Trash moves. The managed CPA runtime is currently pinned at 7.3.7; check its plugin ABI before installation. A running desktop app is not restarted without the user's separate confirmation.

## 依赖关系

Depends on CPA 7.3.7's Windows plugin ABI, the Go-plan `/alpha/generate` path, and the Studio Provider API path. The existing Go-plan plugin does not support image input; report that limitation explicitly if it remains at cutover.

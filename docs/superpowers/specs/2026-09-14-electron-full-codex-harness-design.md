# Electron-first Full Codex Harness Migration

**Status:** Approved architecture; implementation has not started  
**Date:** 2026-09-14  
**Target branch:** `feature/electron-full-codex-harness-0.6.0`  
**Base:** `coding-tools-mcp` main at `233867d0e556aad5f299f980c3f81145a12e3662`  
**Pinned upstream baseline:** `miuuyy/codex-chatgpt-web` v5.0.6 / `e85e3693fdb4e3e033348c08df0298c20fcdb612`

## 1. Decision

Replace the current Tauri desktop shell with an Electron desktop shell derived from the pinned `codex-chatgpt-web` launcher, while retaining the existing Coding Tools Rust implementation as a supervised, headless sidecar service.

The Electron application becomes the product entry point, model/router owner, embedded ChatGPT browser owner, Codex integration manager, process supervisor, updater, diagnostics surface, and unified GUI. The Rust service remains the authority for Coding Tools workspaces, local tools, permissions, approvals, long-running commands, computer-use, history, native Codex App Server integration, and existing integration adapters.

The release target is full production-feature parity with the pinned upstream `codex-chatgpt-web` v5.0.6 baseline plus preservation of the verified Coding Tools v0.4.10 capabilities. “Full” refers to the pinned baseline, not unknown future upstream changes, unsupported account entitlements, or bypassing ChatGPT/Codex policy.

## 2. Why this architecture

`codex-chatgpt-web` already owns the difficult Codex-facing lifecycle:

- Responses-compatible routing through ChatGPT Web;
- ChatGPT Web models inside Codex’s native model picker;
- embedded persistent ChatGPT login profile;
- task-bound Temporary Chat browser surfaces;
- Codex-native context compilation, image attachment, tracing, and tool presentation;
- native context compaction and retained task continuation;
- Browser-only, Full Harness, and Zero Risk interaction modes;
- turn-scoped MCP capabilities;
- official outbound OpenAI tunnel-client integration;
- Codex subagent compatibility modes;
- bounded process, browser, tunnel, and update lifecycle management.

Coding Tools already owns the stronger local-control layer:

- workspace and linked-root authorization;
- filesystem, patch, search, Git, shell, command input/output, and long-running command handles;
- live permission updates and operation-scoped approvals;
- window capture, image inspection, remembered computer-control approval, emergency stop, and permission revocation;
- project/history sessions and checkpoint contracts;
- native Codex App Server bridge;
- local work board, task monitor, Paseo/Anneal read adapters, and existing diagnostics.

Rewriting either side loses mature behavior. A supervised Rust sidecar preserves the security-sensitive local core while the upstream Electron launcher preserves the complete browser/Codex harness.

## 3. Goals

1. Preserve every production user-facing capability in pinned `codex-chatgpt-web` v5.0.6.
2. Preserve every verified, published Coding Tools v0.4.10 capability.
3. Provide one Electron GUI, one installer, one startup lifecycle, one update mechanism, and one diagnostics experience.
4. Expose Coding Tools tools to Full Harness only through the active Codex turn’s scoped capability.
5. Keep Browser-only and Zero Risk modes usable without granting local tools.
6. Keep computer-use approval independent from Codex/model-use consent.
7. Keep all uncertain remote or local operations non-replayable until reconciled.
8. Preserve existing application data and provide a rollback path to the Tauri desktop.
9. Ship a verified Windows x64 installer first, followed by macOS and Linux parity.
10. Preserve upstream licensing, attribution, source pins, checksums, and reproducible build evidence.

## 4. Non-goals

- Bypassing ChatGPT plans, usage limits, workspace policy, Developer Mode restrictions, connector restrictions, action confirmations, or model eligibility.
- Silently copying cookies or browser state from Chrome, Edge, another app, or another OS account.
- Treating remembered computer approval as permission to use a model, spend provider quota, approve arbitrary tools, or operate outside the selected application/window.
- Automatically recreating or deleting ChatGPT connectors during reconnect.
- Claiming OS sandbox equivalence for external Codex, Paseo, Anneal, browser, or provider processes.
- Automatically replaying an operation whose response, tool result, or process outcome is unknown.
- Deleting the current Tauri implementation, old releases, project files, or migration backups.
- Promising parity with later `codex-chatgpt-web` releases without a separate reviewed upstream update.
- Completing autonomous Paseo/Anneal execution in this migration unless separately specified, implemented, and verified.

## 5. Source, licensing, and repository layout

### 5.1 Source pinning

The first implementation pins:

- `miuuyy/codex-chatgpt-web` v5.0.6 at `e85e3693fdb4e3e033348c08df0298c20fcdb612`;
- the tunnel-client version and checksums referenced by that pinned source;
- the current Coding Tools base commit named above.

The build must fail if the fetched or vendored upstream source differs from its manifest. An upstream update is a reviewed import, not an unbounded package upgrade.

### 5.2 License handling

The upstream MIT license and copyright notice must remain attached to all copied or bundled upstream source and substantial runtime portions. Coding Tools’ own source remains under its declared project license. The assembled application must include:

- root project license information;
- upstream `codex-chatgpt-web` MIT license;
- upstream and transitive third-party notices;
- generated dependency/license inventory for the Electron/Bun and Rust components;
- source commit and build provenance.

### 5.3 Proposed layout

```text
coding-tools-mcp/
├── desktop-electron/                 # Primary Electron product shell
│   ├── launcher/                     # Forked/adapted upstream launcher
│   ├── renderer/                     # Unified React UI
│   ├── electron/                     # Main/preload/supervisor processes
│   └── packaging/
├── runtime-web/                      # Pinned upstream Responses/browser runtime
├── src-tauri/                        # Existing Rust source retained during migration
├── rust-core/                        # Extracted headless Coding Tools binary/crates
├── vendor/
│   └── codex-chatgpt-web-v5.0.6/     # Exact pinned upstream source or verified source bundle
├── third_party/
│   ├── LICENSES/
│   └── THIRD_PARTY_NOTICES.md
├── migration/                        # Versioned data migration logic
├── aiTemp/                           # All temporary imports/build/probes
└── Trash/                            # Retained replaced originals; never permanent deletion
```

The implementation plan may adjust directory names to match existing build conventions, but the ownership boundaries must remain.

## 6. System architecture

```text
Codex app / CLI
      │ Responses API over loopback
      ▼
Electron-owned ChatGPT Web runtime
  ├─ official model catalogue passthrough
  ├─ ChatGPT Web model rows
  ├─ Responses/SSE bridge
  ├─ browser worker and task-bound tabs
  ├─ compaction/checkpoint coordinator
  ├─ Search/Image forwarding owned by upstream contract
  ├─ capability broker
  └─ official OpenAI tunnel-client
            │ turn-scoped capability
            ▼
Headless Coding Tools Rust service
  ├─ workspace and linked-root policy
  ├─ files, search, patch, Git, shell
  ├─ long-running command ownership
  ├─ live permissions and approvals
  ├─ history/checkpoints
  ├─ computer observation/input/vision
  ├─ native Codex App Server bridge
  ├─ board/task monitor
  └─ Paseo/Anneal adapters
```

### 6.1 Electron launcher

The Electron process is the sole top-level supervisor. It owns:

- the main GUI window;
- the private persistent ChatGPT browser partition;
- allowed login-provider popup adoption;
- browser task leases and tab limits;
- Responses daemon lifecycle;
- official tunnel-client lifecycle;
- Rust core lifecycle;
- drain, restart, crash budget, shutdown, and update orchestration;
- authenticated local IPC for renderer requests;
- release/update checks and rollback selection.

### 6.2 ChatGPT Web runtime

The pinned upstream runtime remains structurally recognizable to ease future updates. Integration changes should be adapters around stable boundaries rather than broad rewrites.

It must retain:

- native model catalogue passthrough plus fixed ChatGPT Web model rows;
- account-observed model/effort availability;
- browser submission and logical turn binding;
- Temporary Chat task ownership;
- complete Codex context and image attachment flow;
- native streaming/tracing/tool-result projection;
- retained task chats across sequential messages;
- compaction boundaries and checkpoint handoff;
- fail-closed behavior on UI/schema drift;
- Browser-only, Full, and Zero Risk modes;
- subagent Compatibility V1 and Native modes;
- launcher doctor and diagnostics;
- at most five task-bound browser tabs unless a separately verified setting changes the limit.

### 6.3 Rust core service

The Tauri-coupled backend must be extracted into reusable crates plus a headless executable. The legacy Tauri binary remains buildable during the migration until the Electron release passes all replacement gates.

The headless service must expose a private lifecycle/control API and the existing MCP/Actions surfaces. It must preserve:

- current DataStore schema and migrations;
- workspace isolation and linked-root aliases;
- listener auth and OAuth behavior;
- live policy revisioning;
- operation receipts and approval fingerprints;
- command handles and bounded output retention;
- computer-control local-consent boundary;
- screenshot RAM-only rules;
- history session contracts;
- optional native Codex bridge boundaries;
- existing tool schemas unless a versioned connector identity is introduced.

### 6.4 Capability broker

The upstream turn-scoped capability broker becomes the only automatic path from ChatGPT Web to the active Codex task and Coding Tools tools.

Each Full Harness turn must bind:

- exact Codex task/thread identity;
- current turn and compaction epoch;
- cwd and approved roots;
- Codex sandbox/approval metadata;
- Coding Tools workspace ID and current policy revision;
- exact exposed tool catalogue hash;
- random, single-turn capability token;
- expiration and terminal state.

The broker must reject:

- tools absent from the active outer Codex turn;
- Coding Tools tools hidden by the selected local profile;
- stale workspace roots or policy revisions;
- completed, expired, duplicate-conflict, foreign-task, or wrong-epoch capabilities;
- raw recursive broker invocation;
- silent fallback to a legacy connector identity.

A Coding Tools call still passes through the Rust policy engine. A turn capability narrows authority; it never broadens local permissions.

## 7. Full Codex Harness parity target

The migration is complete only when the following pinned-v5.0.6 behavior is present and verified.

### 7.1 Model and route integration

- Keep Codex’s built-in OpenAI provider.
- Install a loopback Responses route transactionally.
- Preserve and restore the prior Codex configuration byte-for-byte on disconnect/uninstall.
- Append ChatGPT Web models only under the integration-owned namespace.
- Detect available ChatGPT effort/model controls from the signed-in account.
- Keep automatic model rows immutable with respect to the selected browser effort.
- Preserve official Voice/realtime routing instead of sending it to the Responses-only bridge.
- Fail explicitly on route conflicts unless the user approves replacement.

### 7.2 Browser-only mode

- Open ChatGPT Web in a launcher-owned persistent Electron partition.
- Route the selected Codex task through the browser.
- Preserve Codex context, images, streaming, tracing, and response shape.
- Do not start Full Harness broker, tunnel, or local tool capability.
- Display an explicit local-tools-unavailable warning.

### 7.3 Full Harness mode

- Start and verify the pinned official `openai/tunnel-client`.
- Use an explicit current connector identity and migration rule; do not silently reuse incompatible schemas.
- Attach one turn-scoped capability to every eligible ChatGPT Web effort.
- Expose current Codex tools and approved Coding Tools tools for that exact turn.
- Keep all tool rounds inside the same ChatGPT response.
- Preserve direct, structured exact-name, code-mode gateway, and native freeform execution paths where the active Codex harness exposes them.
- Preserve bounded `wait_agent` behavior and release the serialized MCP channel between nonterminal polls.
- Keep approvals fail-closed; automatic per-call approval stays opt-in and must not create a permanent grant.

### 7.4 Zero Risk mode

- Never read or mutate the ChatGPT message DOM to submit the task.
- Prepare and copy the exact compiled prompt.
- Let the user choose the visible model, effort, and connector and manually paste/send.
- Preserve turn routing, connector capability, compaction handoff, and explicit confirmation deadlines.
- Keep Zero Risk distinct in UI, diagnostics, telemetry, and cancellation.

### 7.5 Context and compaction

- Preserve native Codex context compilation and image references.
- Preserve model-specific context limits and compaction reserve.
- Preserve supported larger-context partitioning and hard composer bounds.
- Use the retained task-bound browser agent for checkpoint compaction when available.
- Fall back to a dedicated read-only chat built from canonical Codex history when required.
- Never parse ordinary assistant prose as a structured checkpoint.
- Start a fresh Temporary Chat after a compaction epoch.

### 7.6 Subagents

- Preserve Compatibility V1 and Native protocol selections.
- Preserve managed Codex configuration journaling and exact restoration.
- Keep protocol selection explicit and require a Codex restart/new task when needed.
- Preserve the plaintext marker rules and encrypted-payload rejection behavior described by the pinned upstream.
- Keep child/grandchild tool capabilities scoped to their exact native tasks.

### 7.7 Lifecycle and diagnostics

- Keep Activity and Doctor diagnostics.
- Distinguish active HTTP requests from active browser/tool sessions.
- Drain before stop, replacement, update, or uninstall.
- Resume the prior runtime if a controlled lifecycle operation fails before commit.
- Permit explicit retained-turn cancellation.
- Bound automatic crash recovery and surface crash loops as errors.
- Verify runtime file manifests before launch.
- Preserve separate production and DEV profiles.

### 7.8 Developer functions

The pinned upstream development launcher, named DEV chats, compaction lab, smoke tests, source verification, and isolated connector identity must remain available to repository developers. They do not need to appear as normal end-user controls, but must continue to work in an isolated development profile.

## 8. Coding Tools capability preservation

### 8.1 Local tools

Preserve the current tool catalogue and aliases, including file/list/search/patch, Git, commands, incremental output, input, cancellation, plans, permissions, images, computer tools, history sessions, board/task monitoring, and native Codex bridge tools.

### 8.2 Long-running commands

- Missing, null, or zero timeout continues to mean no automatic process deadline.
- Start once and poll the same command handle.
- Preserve next-action hints, output offsets, output-gap disclosure, finalization state, write leases, and project recovery from the handle.
- Do not replay after an unknown RPC or input-delivery outcome.
- Keep the desktop running requirement explicit unless durable process reattachment is separately implemented and verified.

### 8.3 Live permissions

- Permission changes update the running Rust context without replacing the listener, tunnel, OAuth state, or browser login.
- Old operation approvals are revoked.
- Owned commands receive existing policy-change handling.
- Tool-profile/schema changes may require a client catalogue refresh and potentially a new versioned connector identity.

### 8.4 Computer use

“Always enabled” means a remembered, locally approved target under unchanged safety settings. It does not mean unconditional or invisible access.

Required behavior:

- explicit initial local approval;
- selected executable/window identity binding;
- restore after application restart when configured;
- visible monitoring and emergency Stop;
- pause, revoke, policy-change, executable-change, or target-change invalidation;
- no automatic grant to other windows or applications;
- no automatic grant of Codex/provider model use;
- adaptive or demand-driven capture rather than unnecessary continuous preview capture;
- exact disclosure when background input is unsupported or not independently verified.

### 8.5 Native Codex bridge

Retain the optional native `codex app-server` bridge as a separate integration. It is not replaced by ChatGPT Web routing. Its model-use consent, executable hash, dedicated Codex home, request limits, thread ownership, review, compact, interrupt, and close contracts remain independent.

### 8.6 Paseo and Anneal

Preserve current read-only management/observation adapters and local board surfaces. Full autonomous execution, provider scheduling, review engines, and merge automation remain outside this migration unless a later approved spec adds them.

## 9. Unified GUI

The React/Electron renderer becomes the only primary desktop UI. It must include:

1. **Overview** — runtime health, active turns, active commands, workspaces, tunnel, and actionable failures.
2. **ChatGPT Web** — embedded sign-in, account/model detection, browser smoke test, tab/session visibility, and sign-out/revoke.
3. **Models & Codex Route** — Browser-only, Full Harness, Zero Risk, context options, subagent mode, install/remove/repair.
4. **Harness & Tunnel** — connector identity, official tunnel-client installation, health, verification, turn capabilities, and migration warnings.
5. **Workspaces** — approved roots, aliases, default cwd, profiles, runtime state, and project instructions.
6. **Permissions** — live policy, approvals, command rules, screen capture, and tool-profile catalogue evidence.
7. **Computer Control** — target selection, remembered approval, exact/live view, pause/stop, emergency state, and restoration controls.
8. **Tasks & History** — long-running command handles, task monitor, output paging, history sessions, and checkpoints.
9. **Native Codex Sessions** — existing optional App Server bridge.
10. **Paseo / Anneal** — existing source snapshots and board integrations.
11. **Activity & Doctor** — browser, daemon, tunnel, Rust service, Codex config, connector, permissions, and release diagnostics.
12. **Updates & Recovery** — drain status, backups, rollback, update verification, and retained legacy Tauri launcher.

English and Traditional Chinese must cover all new controls and error states.

## 10. Process and IPC boundaries

### 10.1 Electron renderer to main

Use a narrow typed preload API. The renderer cannot spawn processes, read arbitrary files, inspect browser cookies, or call the Rust service directly.

### 10.2 Electron main to web runtime

Use internal functions or authenticated loopback lifecycle endpoints. Lifecycle endpoints require an application-owned random bearer token stored with user-only permissions.

### 10.3 Electron main to Rust core

Use one of:

- a user-scoped named pipe/domain socket with mutual session nonce; or
- a loopback listener with a random bearer token and strict originless/native-client contract.

The implementation plan must select one after platform feasibility tests. In both cases:

- no secret appears in command-line arguments or logs;
- the Rust process is an owned child/job/process group;
- all responses are size/time bounded;
- lifecycle and tool APIs are separate;
- the main process authenticates every control call;
- renderer input is schema validated before forwarding.

### 10.4 Full Harness broker to Rust core

The broker receives only a short-lived turn capability. It maps that capability to a private Rust session and invokes exact advertised tool names. It never exposes Rust lifecycle tokens, browser credentials, provider credentials, or internal workspace handles to ChatGPT.

## 11. Data, migration, and rollback

### 11.1 Application homes

The Electron product uses a versioned application home with user-only permissions. It contains launcher settings, manifests, route journal, browser partition, diagnostics, and sidecar state references. Rust workspace data may remain at its current location initially, referenced by a migration journal.

### 11.2 Migration

First launch must:

1. detect the existing Coding Tools data path;
2. make a timestamped retained backup without deleting the source;
3. validate the current schema;
4. migrate through existing Rust DataStore migrations;
5. write a migration journal containing source path, destination path, version, hashes, and completion state;
6. keep the old Tauri app and source data available for rollback;
7. fail closed before changing routes or launching models if migration is incomplete.

### 11.3 Browser profile

Create a new launcher-owned ChatGPT profile. Do not import cookies from the user’s current browser or old connector popup. Existing upstream Electron profile migration may be supported only when its exact ownership and manifest are verified.

### 11.4 Rollback

Rollback must drain active work, restore Codex configuration from the route journal, stop owned processes, and allow launching the retained Tauri app against its compatible data. Rollback must not silently downgrade a data schema that the old app cannot read; in that case use the retained pre-migration backup.

## 12. Error handling and recovery

### Browser/UI drift

Fail the affected browser turn explicitly. Do not silently switch model, effort, connector, transport, or mode. Preserve diagnostic evidence without storing sensitive page content by default.

### Tunnel unavailable

Keep local runtime and browser state intact. Distinguish binary missing, credential missing, tunnel unhealthy, connector missing, connector stale, and platform tool-ineligible states. Do not delete/recreate the connector automatically.

### Rust service unavailable

Browser-only turns may continue. Full Harness local tools must fail explicitly and must not be represented as available. Restart the Rust child only under a bounded crash budget and only after proving no conflicting external process owns the endpoint.

### Responses daemon unavailable

Reject new routed Codex turns. Keep native Codex models unaffected. Doctor must report exact ownership/version/health rather than attempting an unbounded restart loop.

### Unknown operation outcome

Persist an unknown receipt/checkpoint. Do not submit the same semantic action under a new ID automatically. Require observation or user decision.

### Update while busy

Drain new work, wait for both active request and active browser/tool counters to reach zero, checkpoint supported long-running work, and block the update when uncheckpointed work remains. Never terminate work merely to satisfy an updater timeout.

## 13. Security model

1. Browser login state is a sensitive user-scoped artifact.
2. Loopback is not a hostile-local-process boundary; lifecycle controls still require authentication.
3. Turn-scoped tokens grant only the exact outer Codex task capability.
4. Rust policy remains authoritative for Coding Tools operations.
5. Model/provider consent is separate from computer-control consent.
6. Full Harness exposes only the active turn’s current tool inventory.
7. Repository text, web pages, tool output, and agent output are untrusted content.
8. Credentials never enter prompts, logs, CLI arguments, repository files, or build artifacts.
9. Screenshots remain RAM-only unless the user explicitly saves an approved artifact.
10. Updates are verified by manifest and checksum before execution.
11. Automatic approval remains off by default and never creates a permanent ChatGPT grant.
12. Same-user compromise, compromised Electron/Rust/Codex binaries, and provider-side processing remain outside the guaranteed boundary and must be documented.

## 14. Packaging and release

### Windows-first package

The Windows x64 NSIS installer bundles:

- Electron application;
- pinned Bun runtime;
- pinned ChatGPT Web runtime;
- Rust headless core executable and native helpers;
- pinned official tunnel-client;
- manifests and checksums;
- licenses/notices;
- migration and rollback tools.

The installer remains per-user and must not require elevation unless a future separately approved feature genuinely needs it. SmartScreen may warn until code signing is configured.

### Identity and versioning

The Electron product receives a new product/app identity under Coding Tools ownership. It must not impersonate the upstream app ID. The initial integrated line is expected to be `0.6.0-rc.1`, with release notes clearly identifying the pinned upstream version.

A connector schema incompatible with the existing public connector must use a new explicit identity rather than refreshing or replacing the existing connector in place.

### Release gates

- source pin and license verification;
- dependency lock and audit;
- renderer typecheck/build/tests;
- upstream runtime verification and smoke suite;
- Rust fmt, Clippy, full tests, security/audit checks;
- native helper identity tests;
- route installation/removal/restore tests;
- browser lifecycle and model-free fixtures;
- Full Harness broker and turn-scope tests;
- Coding Tools tool/permission/computer/history compatibility tests;
- installer content manifest and binary version checks;
- clean Windows VM install, repair, upgrade, rollback, and uninstall tests;
- final release asset download/readback checksum verification.

Live account/browser acceptance remains a distinct manual gate because fixture success cannot prove account eligibility or current ChatGPT UI compatibility.

## 15. Testing strategy

### Unit tests

- capability creation, claim, expiry, conflict, and terminal rejection;
- route journal transactions;
- config migration and exact restoration;
- data migration and rollback journals;
- supervisor crash budgets and drain state machine;
- IPC schemas and size limits;
- permission/model/computer-consent separation;
- updater manifest verification.

### Integration tests

- fake ChatGPT browser worker with deterministic logical turn IDs;
- fake Codex Responses client and SSE consumer;
- fake official tunnel runtime and connector verification;
- actual Rust core child over authenticated IPC;
- Full Harness tool round from fake ChatGPT response to a scoped Rust fixture tool;
- long-running command continuation after HTTP response completion;
- live permission revision during an active session;
- remembered computer approval restoration and revocation;
- native Codex bridge coexistence;
- browser-only behavior when Rust is absent.

### End-to-end release tests

- install → sign-in fixture → model installation → Codex restart → routed task;
- Browser-only, Full, and Zero Risk;
- image attachment and context compaction;
- subagent Compatibility V1 and Native fixtures;
- drain/update/repair/rollback;
- legacy Tauri data migration;
- crash/restart without duplicate turn or tool execution;
- no-delete artifact preservation checks.

## 16. Delivery decomposition

This migration is too large for a single undifferentiated implementation pass. It is delivered through the following ordered workstreams, each with its own tests and review checkpoint:

1. **Source/vendor and licensing foundation** — pin, import, notices, manifests, reproducible runtime build.
2. **Headless Rust core extraction** — remove GUI coupling without changing tool behavior; private authenticated lifecycle API.
3. **Electron product shell** — rename/rebrand upstream launcher, unified supervisor, updater, application home, rollback.
4. **Existing Coding Tools GUI migration** — React pages and typed IPC for workspaces, permissions, computer use, tasks, history, native Codex, and integrations.
5. **Turn-scoped Coding Tools broker** — map active Codex turn capabilities to the Rust tool catalogue and policy.
6. **Full upstream parity** — Browser-only, Full, Zero Risk, model routes, compaction, subagents, diagnostics, DEV profile.
7. **Migration, compatibility, and release** — old data, old Tauri rollback, Windows installer, evidence, prerelease, acceptance.

No workstream may claim the whole migration is complete. `main` and public releases advance only after the full replacement gate passes; intermediate branches and artifacts remain available for review.

## 17. Acceptance criteria

The first integrated prerelease is acceptable only when all of the following are true:

1. The Electron app is the primary desktop UI and starts all owned runtimes.
2. The old Tauri app remains available as a rollback artifact and no files were permanently deleted.
3. A user can sign in through the embedded ChatGPT profile without cookie copying.
4. Codex shows the eligible ChatGPT Web model rows and preserves native models.
5. Browser-only mode runs a complete routed turn without local tools.
6. Full mode completes a turn containing at least one Codex-native tool and one scoped Coding Tools tool.
7. Zero Risk completes its manual send/confirm flow with the same task capability contract.
8. Context/image handling and one full compaction epoch pass.
9. A sequential task message reuses the correct retained task-bound chat; a different task cannot access it.
10. Coding Tools workspace roots, permissions, approvals, long-running commands, history, and computer controls pass compatibility tests.
11. Computer “Always enabled” restores only the approved target and remains revocable without granting model use.
12. Native Codex App Server integration remains independently usable.
13. An unknown response does not cause automatic replay after reconnect or restart.
14. Drain prevents update/restart while active browser/tool work remains.
15. Migration and rollback succeed on a clean copy of v0.4.10 data.
16. Windows installer assets, source commit, manifests, licenses, checksums, and downloaded bytes all match.
17. Release notes state the precise upstream pin, verified capabilities, account-dependent limits, unsigned status, and remaining boundaries.

## 18. Traditional Chinese summary / 繁體中文摘要

本設計正式採用方案 C：以 `codex-chatgpt-web` 嘅 Electron launcher 作為主要桌面程式，保留 Coding Tools Rust 核心做受監管 sidecar。目標係完整保留固定版本 v5.0.6 嘅 ChatGPT Web／Codex Harness 生產功能，同時保留 Coding Tools v0.4.10 已驗證嘅工作區、權限、長時間命令、computer-use、歷史、原生 Codex bridge 同整合功能。

Electron 會負責 ChatGPT 登入、Codex model picker、Responses／SSE bridge、Temporary Chat 任務分頁、context／compaction、官方 tunnel-client、Full／Browser-only／Zero Risk、更新同診斷。Rust 仍然係本機工具及權限嘅最終權威。Full Harness 只會透過當前 Codex turn 嘅短期 capability 呼叫已批准工具，唔會因為 ChatGPT Web 已登入就自動放寬工作區或 computer-use 權限。

「Always enabled」只代表記住本機批准目標，仍然可以 Stop／Pause／撤銷，權限或程式身分改變後會失效，而且唔等於批准 Codex 模型或供應商配額。舊 Tauri app、舊資料、舊 Release 同被取代原件全部保留；臨時檔案只放 `aiTemp/`，唔會使用永久刪除流程。

整合會分成固定上游及授權、Rust headless core、Electron shell、GUI 遷移、turn-scoped broker、完整上游功能對等、資料遷移及 Windows 發佈七個工作流。只有所有驗收條件通過，先可以合併到 `main` 並公開 Windows EXE。

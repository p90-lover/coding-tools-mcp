# Native AO Orchestrator in Coding Tools

Status: written design for user review, September 25, 2026. The in-chat architecture, display, and safety rules were approved. This document does not authorize a model run, tool approval, credential change, installation, or publication.

## Outcome

Replace the current Runtime "Structured Orchestrator" and Anneal task screens with a durable Agent Orchestrator (AO). Decommission the standalone Paseo, Codex Router, CommandCode Proxy, and Anneal integrations first: AO is the only task/orchestration board, and its GUI must say "execution unavailable" until it can complete a real run. Keep CPA, MCP, and native Codex. Web GPT plans and reviews through the existing Coding Tools browser bridge. Every other model, including the initial Gemini 3.8 Flash worker, launches through the harness, provider, and model explicitly selected in AO. For CPA workers, the user approved the shared connected-account pool on September 25, 2026; CPA may switch accounts, and AO must never label a pool route as an exact account.

One run belongs to one workspace and project. The user can create another run without mixing its tasks into the previous board. The system collects actual planner, worker, and reviewer output with source identities; a healthy catalog or reserved mission is not a completed run.

## Current code and migration boundary

- The live Structured Orchestrator in `ProviderOrchestratorSurfaces.tsx` saves profiles in renderer localStorage and prepares Anneal missions. Its `WorkflowEngine`, `AgentRegistry`, and provider adapter are planning utilities with no production harness launcher.
- The current durable workflow board has workspace-scoped tasks and revisions. The execution reservation and `paseo_plan/run/review` paths require Paseo and cannot serve as the new dispatcher unchanged. Retire those paths without erasing their saved records.
- The existing `agent-orchestrator` app handler and renderer currently draft CPA clauses and update that board. They do not provide Web GPT planning/review, AO harness selection, or worker execution; do not advertise that UI as a working orchestrator.
- The current checkout already has `src-tauri/src/integrations/ao.rs` with `Run`, `Node`, `Route`, revisioned graph edits, parent-join checks, reservation, and cancellation. It has no owned session/turn receipt, running/finished transition, or model dispatch. Extend this source; do not create a second AO graph or rename its saved serde fields.
- The Web GPT Responses bridge requires trusted native turn metadata and an owned tool/approval loop. A bare HTTP `{ model, input }` request is not a valid replacement.
- CPA's in-process chat-completion handler can make one inference request. It is not an AO harness session or a computer/vision tool executor.
- Anneal tasks live in a separate Docker Postgres volume, not AO's local `control_board`. Preserve that volume for recovery; do not pretend its rows are already AO tasks or auto-run/import them.
- CPA's CommandCode Go/Studio OAuth plugins and accounts are CPA providers, not the standalone CommandCode Proxy being retired. Preserve them.
- Preserve the old localStorage profiles for explicit import or export. Never silently run or discard one while switching screens.

## Runtime ownership

Extend the existing headless workspace task book with AO run and step records. Do not add a second database or public service. The host owns scheduler decisions, model sessions, output provenance, and private route resolution. The renderer edits and observes through bounded, authenticated APIs.

Each run stores stable IDs, a workspace and project, graph revision, selected route identities, dependency edges, node positions, statuses, request keys, and bounded output references. Each step records its actual harness session, model turn, tool permission state, and result. Secrets, cookies, proxy credentials, and raw control tokens stay in their existing private stores.

The scheduler starts a queued card only when **all** of its parent cards finished successfully. It rejects cycles and cross-run edges. A running or completed card cannot have its execution dependencies silently changed. It keeps one potentially writing step per workspace; independent read-only steps may overlap only when their selected harness and permission policy allow it.

On restart, the host reads the saved run and reconciles its existing session and request keys. An unknown Create, tool call, or send receipt becomes held for inspection. Refreshing or reopening the screen never replays that action. Cancel prevents future dispatch and preserves already sent actions in the history. Delete is a recoverable archive, not an erased receipt.

## Model and harness routes

Web GPT is the default planner and distinct reviewer. Any Web GPT card uses the existing private browser bridge with valid turn metadata, the selected account, and the current Codex tool/approval boundary. It never falls back to a native subscription model or another Web GPT effort.

Every non-Web-GPT card selects an AO harness configuration with exact harness ID, provider, model, tools/capabilities, approval policy, timeout, and turn budget. The initial CPA Gemini worker selects the explicit `shared-cpa-pool` account policy, not an individual OAuth account; the pool can fail over. AO validates the selected route against the live catalog, then launches through that harness's real session API. A provider execution plan alone is not proof that a harness can run. The initial worker preset is Gemini 3.8 Flash High; other models use the same explicit selector, not a hardcoded CPA fallback. If CPA exposes the actual auth index for a turn, record it; otherwise show account provenance as unknown.

No model may choose its own credentials, workspace, route, harness, or permission mode from prompt text. Tool calls go through the selected harness's existing sandbox and user approvals. The Orchestrator never grants automatic approval. Computer use and vision appear only when that harness advertises them and the user has granted their separate requirements; otherwise the card shows an unavailable capability. The design must verify the exact AO Gemini route before claiming workers or tools function.

The new path does not import, call, start, or require any retired standalone module. Paseo, Codex Router, CommandCode Proxy, and Anneal are decommissioned before AO execution is ready: remove their navigation, auto-start, handler/API dispatch, and packaged runtimes, while retaining read-only decoding of legacy records and private, recoverable archives. No component may silently fall back to a retired module. AO must pass its live acceptance run with all four retired services stopped.

## Legacy-module decommission and recovery

Archive the exact pre-change shared external-service configuration and encryption key, each retired module's private daemon/component state and required key, and the complete Rust profile store in app-private, access-restricted locations with source paths and restoration notes. Electron userData and Rust roaming AppData are separate roots on Windows; verify both archives. Anneal's dedicated Docker Postgres volume contains its actual tasks and must be preserved or exported before its runtime is removed; its `.env` directory alone is not a task backup. Copy within each existing private root so its ACL is inherited, then verify that ACL before the live migration; the current Rust backup helper does not set one on Windows. The shared profile/config/secret stores also contain CPA, AO, and provider accounts; never move or blank them wholesale, print their contents, or place them in public project Trash. Preserve old installed package/runtime archives and source under recoverable project Trash. Do not delete `old/`, which is a pinned upstream snapshot.

Disable all four retired modules' auto-start and keep-alive, then stop only their verified managed processes. Remove their user-facing navigation, app-handler catalog, service controls, proxy targets, shared mesh routes, and package inputs. After archiving the original encrypted shared files and keys, prune only retired service entries from live normalized config/secrets; keep CPA entries. Reject retired IDs even when a caller supplies a custom bootstrap component list. Retain shared controllers and CPA/MCP/native Codex behavior; remove only retired-module branches. Archive retired source/runtime rather than permanently deleting it. Keep legacy records readable but non-runnable, and provide a recovery path that never auto-resumes old jobs. Old Anneal database tasks remain archived and are not silently copied into AO's distinct board.

The interim AO screen must show board data and an explicit unavailable-execution state; it must not let the user start a run that would dispatch to a retired module or claim completion from a CPA planning draft. Verify no retired process, listener, handler, or packaged runtime remains active while CPA, MCP, and native Codex still work. If a shared-service regression occurs, restore from the archive; do not restore a retired module as an unnoticed fallback.

## Workspace creation

The Electron app currently lists workspaces but cannot register one. Add a guarded local create operation that reuses the existing Tauri workspace creation rules: validate the resolved path and ownership, allocate free ports, bootstrap the profile, and save through the authoritative DataStore. Do not edit profile files directly or reuse an unrelated registered workspace for tests.

The first live test uses a dedicated workspace rooted under this project's `aiTemp/`. No Git worktree is required. Test artifacts remain there; cleanup moves them to recoverable Trash. The real project workspace and its legacy bindings stay recoverable and inactive.

## Full-pane display

Replace the current Runtime entry's Anneal form with the earlier top-to-bottom tree. The tree fills the main pane to the right of Coding Tools' sidebar. A compact translucent drop bar opens an overlaid preview; there is no permanent bottom strip or introductory explanation. Each project/run has its own board and selector.

Cards can be moved and combined. Dropping a card onto a branch changes both its saved position and its execution dependencies. A card with two parents waits for both. Nearby branches and leaves respond gently to dragging; reduced-motion settings remove that effect without removing the drag target or focus feedback. Keyboard and pointer users can create and inspect the same dependencies.

Pending, running, and review states stay prominent by default. Finished and held cards remain visible with lower emphasis. Cancelled and archived cards are available through filters. The selected card's preview shows route identity, status, permission request, actual output and provenance, reviewer verdict, and any required confirmation. Manual notes remain labeled as user-authored and cannot satisfy a model result.

The Settings "Repair Coding Tools" entry may open a run on this board. It diagnoses and proposes first. Source changes require explicit approval of affected files and tests; installed-runtime replacement and restart require their own approval and backup.

## Failure behavior and acceptance

- Missing browser login, harness route, workspace, permission, or exact model stops before dispatch with a specific action. No fallback model or account is substituted.
- Planner output is validated against the user's scope. AO workers receive bounded assignments. Review starts only after every required current worker output exists and uses a different Web GPT turn.
- Empty output, denied permission, a failed worker, an uncertain receipt, or a failed review cannot mark the run finished.
- A real isolated run shows a Web GPT planning response, at least one AO-selected Gemini worker response with a different session/turn, and a separate Web GPT review with a verdict. The worker receipt identifies the shared CPA pool and does not claim an exact OAuth account unless observed. A catalog check, HTTP health, or reserved mission alone does not count.
- Reopening the GUI after restart shows the same run and card states without duplicate Create, send, or tool calls. All four standalone modules remain decommissioned throughout this proof.
- The full-pane tree is checked at the installed desktop size and a narrower window, including drag/drop, keyboard access, state filters, and reduced motion.
- A harmless read-only tool call proves any advertised tool route separately. Computer use and vision require their own capability and consent checks; neither is inferred from the model run.

## Implementation gates

1. Privately archive Paseo, Codex Router, CommandCode Proxy, and Anneal state (including Anneal's Postgres volume) and the installed package, then decommission their integrations without deleting mixed CPA/AO profile data. Make AO the only visible task/orchestration entry and show that execution is unavailable until proven.
2. Verify the production Web GPT bridge and the selected AO Gemini harness can run exact no-fallback turns with their required metadata and permission handling. If Gemini's selected harness cannot launch, stop and report that route instead of substituting direct text-only CPA calls.
3. Add the guarded workspace-create API and durable graph/run schema with focused compatibility tests. Preserve existing task and legacy records.
4. Connect the AO-selected harness executor, Web GPT planning/review, receipt reconciliation, and tool approvals. Test parent joins, cancellation, unknown receipts, and restart observation before a live task.
5. Replace the Runtime screen, retaining old profiles for explicit import/export. Build and install only after source and installed archives are compared, active turns are safe, and backups are made. Keep Codex open.

Current separate issues remain visible: CPA's first-load auto-login sometimes returns 401, and the existing Paseo test has an invalid-mode failure. This design does not count those as fixed or mistake removal of old tests for AO execution proof.

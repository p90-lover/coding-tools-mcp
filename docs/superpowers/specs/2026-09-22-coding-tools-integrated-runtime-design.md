# Coding Tools: original Router UI and real orchestration

Status: proposed written design for user review. The user approved proceeding with the shared integration approach on September 22, 2026. This document does not authorize new credential reuse, external access, publication, or unattended approval of tools.

## Outcome and boundaries

The installed, non-DEV Coding Tools must host working original app interfaces in one window. The Orchestrator must actually assign work to subagents, collect their real responses, and perform a distinct model review. Native Codex and ChatGPT Web remain selectable without silently substituting a model or account.

Keep Codex open. Preserve the installed MCP connector, native/web model routes, existing user changes, private credentials, and the recently repaired runtime lifecycle. Do not replace the installed renderer with an older checkout build. Do not add another general execution engine, a public listener, or a separate Router window.

The full goal also includes Anneal's real task board, CommandCode authentication/functionality, and the previously requested Fast Access integration. Their unresolved prerequisites are recorded below; they are not dropped from completion criteria.

## Current evidence

- CPA and Router model catalogs returned HTTP 200 after the production restart. Paseo's original UI connected to its local daemon and its Settings navigation worked. These checks do not prove inference or orchestration.
- Router's original renderer loads in an iframe but reports that its Electron bridge is unavailable. It expects `window.routerControl`; the existing module facade exposes only lifecycle, OpenAI-compatible operations, and catalog sync.
- The pinned Router preload has 72 calls matched by its existing `registerIpcHandlers` table, plus operation and navigation events. That table is reusable; rewriting those functions is unnecessary.
- `five-stack-control-plane.cjs::run` currently records synthetic dispatch state with `liveModelCompletion:false`. Its review aggregates manual results instead of invoking an orchestrator model.
- The existing Rust mission engine already prepares tasks, owns execution bindings, issues real Paseo controls, and tracks receipts. Its authenticated context, task-list connection, output retrieval, and route plumbing need repair.
- A read-only reproduction of `selectBinding` requested `chatgpt-web/high` but selected a same-provider binding with a different model. The UI must not make that substitution.
- Paseo's native Codex provider already launches per-session `codex app-server` children and accepts explicit model and creation environment. Arbitrary model-provider settings are not accepted by its native provider-options schema, and creation environment is not automatically reused on resume.

## 1. Original Router UI

### Selected approach

Keep the original renderer in the existing iframe. Supply its original `routerControl` contract before React starts, relay named requests through Coding Tools' existing preload/apps interface, and execute the pinned upstream handler table in one Router-scoped worker.

The alternative is a new embedded WebContentsView with the upstream preload. That also preserves one window but adds another view lifecycle and privileged IPC integration. The selected approach retains the already-working iframe surface and changes only its missing backend connection.

### Host and lifecycle

- Initialize the worker with the existing managed Router environment, private Router state and Codex home, source root, and stable Python binary. Never change the launcher's global environment to configure Router.
- Reuse the pinned handler registration table and mutation queue. Supply only the window/event services its handlers require; window actions target the existing Coding Tools surface.
- Use the existing packaged runtime and verify the actual worker can load required built-ins, including `node:sqlite`. Worker boot and handler execution must pass in the installed app, not only in Node fixtures.
- Start it on demand after bridge readiness, retain it while the module is in use, and dispose it through the repaired owner lifecycle. Reject new requests after disposal; fail pending requests explicitly on worker exit.
- Route start, stop, restart and repair through Coding Tools' managed component services, including Control Center-initiated lifecycle actions.

### Contract and trust boundary

- Keep an explicit mapping of original method names, argument shapes and read/write classification. No arbitrary IPC-channel invocation, shell command, module import or filesystem path from an iframe message.
- Bind messages to the currently selected Router iframe and its verified managed local URL. Revoke the binding on navigation, replacement or disposal.
- Install the bridge before the compiled renderer script runs. Preserve the original CSP and use a local bootstrap asset or specifically hashed bootstrap.
- Unwrap the apps envelope into the response shape expected by the original renderer. Backend refusal and `softFail` become rejected promises, not successful empty data.
- Relay operation progress and navigation events with request identity. Bound payload sizes and listener lifetimes.
- Preserve focus/visibility checks and existing confirmation requirements. Credential changes, harness installation/update and other consequential actions require their specific user confirmation; approval of this design is not blanket execution consent.
- Keep secrets inside existing private stores and host-side resolution. Do not send credentials, control tokens, arbitrary environment maps or caller-secret URLs to the original renderer or logs.

## 2. Real Orchestrator execution and review

### Reuse the existing mission engine

Use the existing workflow board, execution book, approved bindings, action receipts and Paseo transport. Connect the current `paseo_plan`, `paseo_run` and `paseo_review` surfaces to that engine instead of maintaining a second in-memory execution system.

1. Validate the selected workspace and approved route. Populate the authenticated headless `ToolContext` with the validated workspace identity.
2. Obtain a real planning response using the selected orchestrator binding. Validate proposed child tasks against the user's requested scope and existing task limits. Model output cannot select credentials, routes or permissions.
3. Prepare local workflow tasks and child missions. Read the current board, execution-book and mission revisions from their authoritative records; never substitute a default zero revision.
4. Issue Create and then Start through the existing control API. Reconcile acknowledged/unknown receipts with stable request keys; do not create a second agent merely because observation timed out.
5. Run writing children sequentially, preserving the existing one-potentially-writing-mission-per-workspace lock. Parallelism is not required for success.
6. Collect bounded, ownership-checked assistant output from the actual child timeline. Associate it with mission, agent, turn and sequence/cursor identity. Older messages or copied task text are not child results.
7. After all required child results exist, create a distinct review mission under the exact selected orchestrator binding. Its prompt contains the requested checks and actual child results. Save its real response and verdict with provenance.

### Route and account identity

- Match the resolved approved binding exactly, including engine/provider, model and account/route identity. Remove provider-only and model-only fallback from execution selection. Planning may offer a fallback, but execution must use the route the user accepted.
- Extend existing settings/binding/spec plumbing only with the route information needed to preserve that identity and reasoning/safety options. A displayed account label is not evidence of authentication.
- Resolve route references to approved private launch configuration in the host. Do not accept a renderer-supplied environment map or provider configuration.
- Preserve explicit `config.model` and use Paseo's existing per-agent launch path. `OPENAI_BASE_URL` alone is not routing proof because Codex also loads its configured provider.
- Make approved launch context survive resume/import/refresh through narrow existing-adapter plumbing. Persist nonsecret route identity, re-resolve private values when launching, and do not modify global Codex configuration or copy unrelated account credentials.
- If the requested account/route cannot be resolved, report a connection requirement. Do not run a different model or claim that the requested model ran.

### UI and failure behavior

Show real states: planning, ready to dispatch, executing, waiting for permission, reviewing, complete, cancelled and failed. Display the selected route, actual child identities, latest status, collected outputs and review response.

Manual notes remain visibly user-authored and never satisfy automated completion. Incomplete, denied or failed children prevent a successful review status. A failed review retains child results and supports a receipt-aware retry. Permission requests stay requests; no automatic approval is added.

Restart recovery uses the execution book and receipts. Reopening the GUI resumes observation; it does not silently dispatch another task or replay a mutation.

## 3. Shared task and Anneal boundaries

Repair the shared task-list API to read actual workflow tasks instead of returning an empty-page stub. Do not mix Coding Tools workspace/task IDs with Anneal project/task IDs.

The subsequent Anneal board change must use the real `/api/projects` and project-scoped `/api/tasks?view=board&archived=false` responses, fetch details on selection, and preserve each card's advertised move targets. An agent Doing transition uses Start when advertised, not a fabricated PATCH. A review handoff is successful only after Anneal returns a real created task ID.

Anneal setup must validate or generate persistent configuration using its pinned `setup-local.mjs --directory` path, never copy `.env.example` as a working configuration. Valid saved config and database state remain unchanged. Fresh WSL staging must use Linux dependencies, not bundled Windows native packages. Credentials and unverified WSL/Docker/filesystem prerequisites remain explicit gates; do not bypass a refused tool operation or reset a database to make a test pass.

## Delivery and preservation

- Reconcile production-only navigation and features into the source before replacing the whole renderer. Preserve Function Call Orchestrator, OAuth, API models, Tasks, Instant MCP Tools and the current module surfaces.
- Keep original upstream layouts. This is an integration/state repair, not a redesign.
- Use recoverable backups and task artifacts under `aiTemp`. Apply only reviewed app/handler/worker/build changes to the non-DEV installation.
- Reload/restart Coding Tools only when its active work is safely drained. Do not restart Codex. Keep the currently working native/web routing and MCP setup intact.
- No commits, pushes, publication, new persistent external access or credential changes are included in this design approval.

## Verification required for completion

| Requirement | Required proof |
|---|---|
| Router API parity | Every original preload method maps to an existing handler or an explicit permission/lifecycle operation; no unimplemented success responses. |
| Router live GUI | Installed dashboard reads live Router data; Status, Models and Settings work; operation/navigation events reach the same embedded UI. |
| Router boundary | Foreign/stale frame requests fail; read/write classification, cancellation, disposal and secret redaction are exercised. |
| Exact route | A missing web-GPT binding is refused. Native and web model runs each show their actual selected route; reconnect preserves it. |
| Real orchestration | In a dedicated registered `aiTemp` QA workspace, a real child performs a harmless read, its actual output is collected, and a distinct orchestrator model reviews that output. |
| Honest failure | Denied permission, child error, missing output, reviewer failure and repeated requests cannot produce fabricated completion or duplicate work. |
| GUI lifecycle | Progress and results are visible; app restart resumes observation without replay; no extra app GUI or orphaned owned process remains. |
| Regression | Existing installed navigation, CPA, Paseo UI, native Codex, ChatGPT Web and a harmless read-only MCP tool call remain functional. |
| Full-goal follow-through | Anneal real board CRUD, CommandCode authenticated completion, and the separately approved Fast Access workflow still require their own live proof before the overall goal can be complete. |

Prefer a few focused behavioral checks and targeted live flows. Passing catalog/health checks or mocked execution tests alone does not satisfy the live requirements.

## Remaining user decisions

Review this written design before implementation planning. Anneal still needs the dedicated-token versus explicitly authorized existing-credential choice; CommandCode still needs its own login. Keep those credentials out of chat. Fast Access connector creation/deletion retains its separate confirmation boundary.

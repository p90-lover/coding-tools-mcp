# Runtime integration review - 2026-09-22

## Scope and status

This is a focused review of the Electron shell, Responses WebSocket adapter,
Paseo/Anneal control plane, CPA module handlers, and installed startup diagnostics.
It is **not** an exhaustive audit of the Rust, Svelte, Python, all vendored
upstreams, or every existing worktree change. No installed binaries, credentials,
Codex configuration, or account state were modified in this pass.

## Findings and source corrections

| Severity | Finding | Disposition |
| --- | --- | --- |
| Critical | Installed launcher fails bundle validation: `Runtime bundle file size mismatch` for `resources/runtime/app/cli.js`. No listener on port 17841 during inspection. | Deployment blocker, not a browser UI bug. Preserve validation; replace the complete bundle through the packaging/install pipeline. |
| High | `paseo_run` labelled in-memory records as dispatched without invoking an executor. `paseo_review` merely collected supplied findings. | Records now explicitly say `awaiting_dispatch`, expose `dispatchRequired`, and identify findings as requiring an orchestrator review. Automatic execution is still not implemented. |
| High | Opening a runtime task did not create any task visible to the task board. | A run now has a corresponding local board record; submitted results move it to REVIEW, not DONE. These records remain in-memory. |
| High | `ok: false` worker results without an issues array were treated as returned successfully. | Generate a failure finding and preserve failure status. |
| High | Result submission, review, and Anneal handoff lacked the workspace check already used by run/preview. | Reject mismatched workspace contexts. Omitted context remains supported for trusted internal callers. |
| High | Anneal `board` / `listTasks` always returned an empty success based only on bundled source presence. | Read the managed Anneal API; report unavailable without a runtime or database. `activity` now calls the activity endpoint rather than preview. |
| High | Anneal handoff could report `posted: true` without a returned task ID. | Require a successful acknowledgement with an ID. |
| High | UI execution-binding lookup could silently substitute a different provider or model after route selection. | Require an exact provider/model match on a connected, approved binding. |
| Medium | One failed task source prevented every other board source from rendering. | Independent settled reads, partial-source notice, and stale-workspace response protection. |
| Medium | Runtime OAuth and Tasks used substitute forms rather than the original CPA/Anneal views. | Runtime pages host the original upstream views and offer a separate Coding Tools controls tab. OAuth opens the CPA OAuth section. |
| Medium | Web GPT disappeared from the orchestrator selector when no account was connected; fallback was enabled by default. | Always expose Web GPT, explain required account linking, and disable implicit fallback by default. This does not fabricate an authenticated account. |
| Medium | Added control screens used undefined theme tokens and browser-default form styling. | Bridge their tokens to shell tokens; style controls and align the model/provider form. Remove Function Call from the displayed Orchestrator name. |
| Medium | Non-JSON Responses errors consumed the body twice and replaced useful diagnostics with a body-used exception. | Read once, preserve HTTP status, do not relay arbitrary private upstream text. |
| Medium | Provider catalog header inference caused renderer typecheck failures. | Explicitly type provider definition arrays. |

## CPA handler contract

The existing `codingTools.apps` host and catalog now expose:

- `authFiles`: account identity/status only, not credential content.
- `authFileModels`: models for a named auth file.
- `oauthStart`, `oauthStatus`, `oauthCancel`: bounded, allowlisted management
  calls. User authorization remains an explicit manual step.
- `plugins`, `pluginStore`: read-only catalogs; no arbitrary plugin execution.

The management key is resolved by the main-process service context, never supplied
by the renderer. See `app-handler/cpa/README.md` for invocation examples.
`modules/cpa/handlers.cjs` delegates to this canonical handler rather than creating
a second implementation.

## Required workflow still to implement

Do not equate the record/status fixes above with the requested automatic loop.
The production path still needs all of the following, backed by one durable
mission store rather than separate ephemeral maps:

1. Persist mission, approved workspace, orchestrator account/model, worker
   bindings, and an idempotency key before dispatch.
2. Have the selected orchestrator generate structured tasks. Create actual
   Anneal tasks and store local/remote task IDs. A local workspace ID must not be
   assumed to be an existing Anneal project ID.
3. Start real Paseo/native coding-agent sessions using approved bindings.
   An RPC acknowledgement is not task completion. Observe completion, capture
   outputs and verification evidence, handle cancellation and permission prompts.
4. Deliver each completed result to the same orchestrator conversation. For Web
   GPT use the managed Responses bridge and real browser ownership, not a fake
   completion or a separate unowned browser profile.
5. Ask the orchestrator for a structured final verdict. Worker success alone
   cannot mark the mission accepted.
6. On a rejected verdict, create corrective tasks and repeat, counting completed
   execution/review rounds. Allow at most five worker rounds in total.
7. After round five fails, switch to a bounded orchestrator-owned repair stage
   using the same workspace permissions. This means repairing the mission's
   work, **not** rewriting the orchestration engine or bypassing approvals.
   Review once more; if still unsuccessful, stop in `needs_attention` rather
   than looping forever.
8. On restart, resume from persisted state without repeating side effects or
   resubmitting prompts. Task UIs subscribe to this store.

Acceptance requires live evidence for worker invocation, callback/result delivery,
corrective rounds, the fifth-round transition, cancellation, and restart recovery.
None of those end-to-end claims is established by a prewarm-only WebSocket test.

## Managed app installation/update work still outstanding

There are already pinned source manifests, build scripts, managed child services,
and a shared handler registry. A handler being loaded does not mean its upstream
service is running. Some `inspect` operations describe source presence only.

A complete in-app module updater still needs a single documented source-of-truth
layout for versioned module payloads, pinned GitHub release/commit metadata,
checksum validation, staging, dependency checks, rollback, and atomic activation.
Handlers and the UI should consume the activated version's capability/schema
catalog. Do not download and execute arbitrary latest code during UI mount or
silently redirect calls to an unrelated provider when a module is unavailable.

## Validation and deployment

- Desktop and runtime TypeScript checks passed.
- Renderer production build succeeded in `desktop-electron/build/renderer-verification`
  without overwriting the existing tracked `dist` output. Vite reported its
  existing parent Svelte config warning and a large JavaScript chunk warning.
- 78 focused desktop tests passed across CPA, module-host, control-plane,
  task normalization/binding, original-UI, and runtime-install coverage.
- 38 WebSocket/server-lifecycle tests passed using production-pinned Bun 1.4.0:
  `bun test tests/responses-websocket.test.ts tests/server-lifecycle.test.ts`.
- The system Bun is 1.4.2 while runtime packaging pins 1.4.0. The first build
  correctly refused the wrong version.
- Rebuilding with the existing installed Bun 1.4.0 completed compilation and
  manifest validation. Windows then rejected publication with `EPERM` on renaming
  the staged directory to `desktop-electron/build/runtime`.
- The validated staged bundle was retained at
  `aiTemp/work/runtime-bundle/2026-09-22T08-12-20-620Z-26348-cccdcd8c`.
  Resolve the filesystem permission/lock issue before retrying publication.
- No rebuilt app was installed and no authenticated live browser turn was run.
  Original-app iframe rendering and visual fidelity still require an interactive
  check with the managed services running.

# Chat harness performance and acceptance

The chat harness shares simultaneous observations and caches active conversation tails briefly. Existing session events invalidate the cache. Missed events reconcile within 1.5 seconds; terminal, unknown, or nonworking states read authoritative conversation data. The backend's paging contract is unchanged.

Open **Run evidence** from the chat header or mission controls to inspect coordinator-observed wall time, startup wait, approval wait, summed agent time, retained attempts, explicit worker skips, and artifact checks. Timing covers the current app instance and can be incomplete. Parallel agent time is summed separately from wall time. Model execution, tool execution, provider latency, and token counts are not inferred from these timings; existing provider accounting remains separate.

## Adaptive worker selection

The planner chooses from the already configured workers. An unused worker needs an explicit nonempty skip_reason in the assignments block. Missing assignments retain their legacy behavior. At least one worker must receive work; a selected worker or control role cannot depend on a skipped worker. Explicit clause owners cannot be skipped. Approval and review roles remain mandatory.

```json
[
  {
    "worker": "writer",
    "task": "Create marker.txt as an empty file",
    "acceptance": "The marker exists and is empty",
    "checks": [
      {
        "kind": "artifact_sha256",
        "path": "marker.txt",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }
    ]
  },
  {
    "worker": "researcher",
    "skip_reason": "The requested marker needs no research"
  }
]
```

Use the actual configured card IDs. Optional checks must specify known expected bytes, not a hash invented to certify an unknown result. The controller fills planner attempt identity, reads the current artifact safely inside the workspace, and binds evidence to the current worker attempt. Final approval rechecks the bytes and bindings. Missing, failed, changed or stale evidence cannot satisfy a typed check.

For AO-backed workers, typed checks require runtime confirmation that the session root is the registered project folder. Different isolated/shared worktree roots or unavailable workspace metadata hold the check as unsupported; the controller never substitutes another checkout. Native execution uses its controller-owned project root. Prose-only worktree tasks are unchanged.

The first check type is artifact_sha256 only: at most eight relative paths, each a regular file of at most 1 MiB. Commands are not executed from acceptance data. Digest verification proves specified bytes at a checkpoint; it does not establish semantic correctness, test success, or later file contents. Existing prose acceptance and review remain available without typed checks.

## Repeatable offline comparison

Run from the repository root:

```sh
node desktop-electron/scripts/benchmark-chat-harness.cjs
```

The script compares the pinned baseline with the current production observation helpers using controlled runtime IO. It asserts identical final answers, current-turn behavior, event updates, reconciliation, follow-ups and interruption. JSON output records source hashes, request counts, conversation reads and response bytes. Its clock is simulated; results are not a live model or end-to-end latency benchmark. It makes no model or network request.

## Verification

Focused Node tests cover metrics, session observations, cancellation/ownership and evidence display. Rust controller/verifier tests cover explicit skips, replan activation, dependency/review preservation, path bounds, special files, attempt binding and changed artifact content. Full Rust tests/clippy and frontend checks remain CI gates. Installing these source changes requires a separately built application.

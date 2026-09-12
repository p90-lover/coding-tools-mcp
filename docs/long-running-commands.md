# Long-running commands without misleading progress

## What the clocks mean

`elapsed_ms` is the observed process lifetime and stops changing after terminal status.
`server_dispatch_ms` measures this server's work for the current tool call, including
admission and response assembly. `observation_age_ms` can continue increasing after
completion because it describes how old the retained command is. None of these alone
measures ChatGPT inference, client queuing or the complete network round trip.

In the development evidence, a cold dependency build took 442.642 seconds while a
cached check took 15.050 seconds. These were different cache conditions, not an
optimization benchmark. Another test command took 29.814 seconds, but the old elapsed
counter read 172.714 seconds when polled later. The latter included observation delay.

Avoid repeated full workspace listings, retries of an unchanged baseline failure,
duplicate process launches and large repeated output pages. An RPC receipt completing
only proves the tool returned; a process may still be running.

## Select the project and source scope once

Use an already approved root or linked-project alias. For example, in a project with
the shown existing paths:

```json
{
  "objective": "Train and compare a detector without changing unrelated projects",
  "project_root": "@detector",
  "baseline_roots": ["src", "scripts/train.py", "config"]
}
```

Call `start_task` with that object, then retain its exact `task.id`. Source scope is
not a grant to access new paths. Inputs, weights and generated output need their own
approved locations; excluded data is not represented as verified source coverage.
Existing task baselines are not silently migrated or accepted after external changes.

## Start once, then poll the same handle

```json
{
  "cmd": "python scripts/train.py",
  "project_root": "@detector",
  "workdir": ".",
  "task_id": "TASK_ID_RETURNED_BY_START_TASK",
  "yield_time_ms": 1000,
  "max_output_bytes": 4096
}
```

No separate execution mode is required. Missing, null or zero `timeout_ms` means
no automatic process deadline. Seven days is not a ceiling. A positive timeout is
an optional caller-requested stop condition, distinct from the HTTP response wait.
The example returns after approximately the requested 1,000 ms wait while the
owned command can continue. Cancellation and permission checks remain active.

For `status: "running"`, copy `next_action.arguments` into the indicated `write_stdin`
call. Empty `chars` polls without typing. Follow-up calls recover the project from the
owned handle; a conflicting explicit project is rejected. `command_ok: null` means
not finished, not failure. Wait for terminal status and any `finalization_pending`
state to clear. Inspect a non-null reconciliation error before further writes.

Use `read_output` and `next_read_offset` for incremental output. Offsets are absolute
per-stream byte positions. When `output_gap` is true, earlier bytes have left the
bounded retained tail; do not claim the entire log was retrieved. Use durable program
logs for a complete training record.

`PROJECT_WRITE_BUSY` means an overlapping owned writer has not released its lease.
Read-only monitoring and a separate approved project can continue. Do not close an
unrelated task, change the shared default directory or rebaseline another project's
record to get around it.

## Cancellation, permissions and restarts

`kill_command` targets only the admitted command tree, not arbitrary desktop processes.
On Windows it uses a Job Object assigned before user code starts. Root-policy changes
are checked during supervised work. No filesystem or network sandbox equivalence is
implied by process ownership; inspect `execution_boundary` and `sandbox_enforced`.

If input delivery is unconfirmed, the process may have consumed a prefix. The response
sets `safe_to_retry: false`; read the evidence and checkpoint the application state
before deciding whether another command is safe. Similarly, never infer nonexecution
from an unknown or expired RPC receipt.

The app must remain running. An application restart does not resume old processes,
recover all output or automatically replay actions. Stop/checkpoint long work before
an update. Workspace history remains a separate durable journal and still needs the
explicit per-turn checkpoint contract.

## RAM cache policy

Output payloads and recovery response bodies are stored in RAM, not in application
cache files. The shared output pool admits at most 64 MiB of payload, with at most
1 MiB per stream. Timestamp metadata and temporary response copies have additional
bounded overhead; this is not a claim that total application RSS is 64 MiB.

Expiry uses the original insertion age (up to 90 minutes), never extends on reads,
and releases old allocations even when clients stop polling. Under capacity
pressure, the oldest payload chunks go first. New output from an older running
command is treated as new data, not penalized because its command began days ago.
Old data can be evicted before 90 minutes when the byte or metadata budget fills.
An expiry does not remove the running command handle or its write lease.

Completed process metadata retains at most 128 finalized commands per store;
operation receipts retain at most 128 records and 256 KiB per result per listener.
Both prefer the newest completed records and expire terminal records at 90 minutes
(idle metadata sweep runs every 30 seconds; every read also checks expiry). Active
operations are not evicted to make space. Missing receipts mean unknown outcome,
never permission to replay an action automatically.

Source files, task history, authentication, checkpoints and build artifacts are not
disposable runtime cache. Child tools still own their own cache settings. This
release does not mount a RAM disk, alter Windows paging, or move/delete existing
compiler/download caches. `server_info.runtime_cache` reports the output pool's
actual retained payload and eviction counters.

After installing an updated desktop, refresh the ChatGPT connector's tool catalogue
before relying on the changed timeout schema. Do not install or restart the desktop
while an uncheckpointed command is running.

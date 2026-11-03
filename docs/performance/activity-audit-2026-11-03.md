# Activity sample and AO hot-path fixes

## Read-only live observations

The active Electron main process was PID 53832. `app.getVersion()` reported **0.8.73**; the Windows executable's native version resource still reported 0.8.60, so the native file label was not used as the running application version.

A 31.28-second process sample beginning at 2026-11-03 07:07:34 UTC measured:

| Process | CPU, percent of one core | Private memory |
| --- | ---: | ---: |
| Renderer | 118.08% | 958.7 MiB |
| GPU | 67.33% | 431.6 MiB |
| Main, including its workers | 66.78% | 769.2 MiB |
| CPA | 53.60% | 904.3 MiB |
| AO daemon | 40.91% | 295.9 MiB |
| Headless | 13.14% | 133.0 MiB |

These are process counters, not per-thread CPU measurements. Transfer counters include pipes/network traffic and are **not physical disk throughput**. Multiple additional AO processes were chat hosts, not assumed to be duplicate daemons.

The in-memory Activity ring retained 300 entries spanning 06:54:03–07:08:05 UTC: 140 approval reviews, 142 decisions, ten main-stall events of approximately 2.25–4.04 seconds, and one watchdog restart. The old launcher log file was not used to infer an absence of stalls.

A separate 15-second V8 main-thread profile sampled 15,158 ms, including 13,872 ms marked idle. Direct TCP connection work and AO `requestApi` appeared in the active samples. The higher process CPU therefore cannot be attributed entirely to main-thread JavaScript, and this short profile does not establish the cause of every earlier stall. The temporary inspector was closed after its original PID was verified; port 9229 was then confirmed not listening.

## Confirmed code gaps fixed

1. `chatHostGone`, `chatHostAlive`, and startup survivor inventory still connected/destroyed host sockets on main. They now use the existing `probeTcpOffThread` implementation. Concurrent checks for the same address share an in-flight probe; the existing positive-reuse TTL and fresh ownership-check behavior remain. Only refusal proves a host gone, timeout handling remains caller-specific, and malformed or out-of-range addresses are rejected without opening a socket. Survivor metadata reads are asynchronous too.
2. AO `requestApi` checked its response budget only after the worker had buffered/transferred the complete response and main had read its text. It now supplies the existing 900,000-byte, 16 MiB conversation, or explicit 32 MiB recovery budget to the worker. An oversized response retains the existing handler-limit error text, so smaller-page/raw-approval recovery remains compatible. The post-read UTF-8 check remains as defense for transports ignoring the worker option.

The shared probe's existing worker-unavailable fallback is unchanged. Its socket timeout remains 1.5 seconds, with the shared worker's existing answer grace; this is not a promise that no native socket can ever run on main under every fallback condition.

## Verification

- Thirteen permanent regression cases: twelve failed before the fix, all thirteen pass afterward. They forbid main-thread host sockets and synchronous inventory reads, verify refusal/timeout/error distinctions, positive reuse/fresh checks, changed addresses, malformed records, three concurrent checks becoming one probe, worker byte budgets, and stable size-limit recovery errors.
- Final selected suite: **613 passed, zero failures or skips**. Includes AO upstream, workflow, gateway, headless, worker execution, actual worker fetch/probe behavior, and the new cases.
- One existing source-sliced survivor fixture initially omitted the new shared probe helper; the fixture was corrected. The earlier broad run had 129 passes and that one fixture failure, followed by a clean 130-case rerun and the final 613-case run.
- Node syntax and task whitespace checks passed.
- A fresh scoped pre-edit graph reported `chatHostGone` HIGH and `requestApi` CRITICAL through observation, continuation, restore, startup and API paths. Survivor's exported function reference is a lower-bound boundary; the startup caller was confirmed in source. Structured change analysis reported CRITICAL with no partial/truncated/error flags. Newly added helper edges and bounded flow catalogs remain limits, not evidence of no impact.

## Limits and work deliberately left alone

No installed app patch, install, restart, live database access, persistent logging enablement, account/proxy mutation, or approval-policy change occurred. No post-install CPU/latency improvement is claimed. Response caps protect oversized reads; they do not by themselves prove a reduction in normal traffic.

The renderer's long-transcript/entrance-animation work belongs to another active task and was not changed. Browser 429/authentication-loop work is already covered by PR #1017 and was not duplicated. The observed watchdog event and remaining stalls are findings for subsequent validation, not claimed fixed by this patch.

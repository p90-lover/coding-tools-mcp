# Live permissions and local tool compatibility

## Permission changes without MCP reconnection

The MCP/Actions runtime keeps a shared per-listener authorization state. Each tool
request uses a coherent policy revision. Local workspace saves publish permission
mode, approval mode, command rules, patch limits and screen-capture permission into
active contexts without stopping either listener or Cloudflare. Authentication
objects, bearer/OAuth secrets, listener ports and existing history/default-directory
state are not replaced by a permission-only save.

Short operations and process admission are revision-fenced. A busy short operation
may return LIVE_POLICY_BUSY to the local Save action; nothing is partially saved,
and Save can be retried without a restart or relink. The saved configuration is
committed before live policies become visible. Stale snapshots cannot admit a new
side effect. All prior approval grants are revoked on a changed policy. Active owned
command sessions reject subsequent input and receive a termination request; their
output stays readable. Already submitted OS input or subprocess side effects cannot
be undone. This is not a process-tree/OS-sandbox guarantee.

Disabling screen capture, selecting read-only, or removing computer-action exposure
revokes control for that workspace. A capture completing across a policy revision
is discarded rather than returned. Expanding a policy does not silently grant new
application consent. Remembered application grants remain pinned to their approved
security configuration; changing that configuration may require local reapproval,
not MCP reconnection. Unchanged policy saves do not end commands or increment the
revision.

`server_info.live_permissions` reports the applied revision and current policy.
There is no remote tool to edit persistent permission settings. Permission-only
changes keep the tool schemas unchanged. Changing the tool-profile/catalog is a
separate action: the server updates immediately, but a caching client can need a
tool-list refresh to discover new tools. Port, workspace-root and authentication
identity changes still use their existing service lifecycle, not this hot path.

## Local Codex-style tools

Existing actual local handlers include exec_command/write_stdin/read_output,
file listing/reading/search, transactional apply_patch, scoped request_permissions,
image viewing, and the separate Windows computer_* tools. This release adds:

* update_plan and get_plan: bounded in-memory steps, at most one in-progress step,
  optimistic revision checking, no automatic execution.
* tool_search: searches real schemas in the current permitted local catalog.
* get_current_time: local system-clock Unix timestamps.
* codex_tools_status: explicit supported and unsupported capability inventory.

These are local counterparts, not a promise that every internal Codex tool can run
outside its model/session runtime. Codex inference, AI reviewers, subagents, cloud
search, account/plugin installation and model-context APIs are not invoked or
bundled. The unverified native command sandbox remains unavailable with no fallback.
The existing exec_command boundary is policy_only, not an OS sandbox.

## Retained features and scope

The v0.4.0 control-center redesign and read-only Paseo/Anneal management adapters
are retained, together with their license notices. Their full agent runners,
voice/mobile relay, autonomous reviews and merge engines are not included. No new
provider usage is started by this release. Screenshots and exact-agent/live previews
remain memory-only; no screenshot files or image logs are introduced. OS paging,
crash dumps and receiving-client retention are outside that application guarantee.

Remembered Always enabled, approved background observation, local monitor and Stop
are retained. Input is Windows foreground input. Silent creation/reauthorization
of a ChatGPT connector is not claimed. Cloudflare recovery and assisted setup are
unchanged; a rotating origin still requires a client-side endpoint update.

## Focused verification

The release gate runs a real authenticated HTTP MCP fixture on one listener,
changes read-only to workspace-write, checks denied/allowed patch execution, checks
identical catalogs and the same bearer token, and checks unauthenticated requests
remain rejected. Separate small tests cover failed/busy atomic saves, workspace
isolation, stale snapshots, and local tool round trips. The existing isolated
Windows background-observation/real-input fixture and installer-byte verification
are rerun. This does not constitute a test of the user's actual ChatGPT connection.

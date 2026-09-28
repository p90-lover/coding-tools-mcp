# Offline snapshot permission integration

Base: 35b13594ddb3ba70011b2c47cec840e6a0dba3e1 (rc.5). User request: continue sandbox and permissions after the MCP repair.

The prior snapshot helper c402cba passed three isolated native groups (34464568479). The actual released local_setup stub was called in a dependency harness and its expected refusal reproduced (34471789541). Neither proves app integration; new Windows tests must execute the integrated Rust entry, actual helper, scoped grants and live revocation.

Critical execution boundary. Native entry -> current policy -> exact workspace grant -> bounded explicit file snapshot -> byte-checked embedded helper -> outer kill-on-close job/handshake -> suspended AppContainer child/verified SID -> nested limits. Only sandbox_exec is changed. No host fallback or model inference. Regular command/GUI routes remain outside this isolation.

Impact: native_sandbox callers are local Tauri sandbox commands, registry/schema, dispatch, application init, computer Stop and now live-policy/runtime Stop. DataStore persists helper-bound grants; backup recovery already suspends enabled grants. live_policy::fence_entire_call must exclude sandbox_exec so revocation does not wait for the command to finish. approval::classify_operation treats it as routine mutation; read-only mutation checking includes it. The shared policy lock is held during admission only, then revision/epoch/grant checks continue during execution. UI responses carry a generation and workspace ID so late status/approval responses never affect the newly selected workspace.

GitNexus/mcp-probe-kit searches returned no matching connected tools. Offline local mcp-probe-kit@4.0.0-rc.20 lookup returned ENOTCACHED and outbound GitHub DNS is unavailable; repository graph notes also report Rust resolution limitations. Direct caller tracing and exact diff inspection used; no fabricated graph assessment. No upstream OAuth, PKCE, refresh-token or extension source edits.

Verification groups: three native boundary cases (positive operations and real negative filesystem/network boundary; process-tree timeout; bounded pipes); three Rust integrated contract groups (grant/file boundaries; shared approvals; actual native execution and live revocation). Existing rc.5 manual/extension browser->real Rust authentication and catalog packaging gates preserved. Windows build/installer exact-source evidence required before main/release. Everything retained under aiTemp; retired source bytes preserved under Trash; no automatic file or AppContainer-profile deletion.

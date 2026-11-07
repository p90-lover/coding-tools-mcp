# Coding Tools, Codex and ChatGPT desktop: tool parity and long-task audit

Date: 2026-11-06. Local baseline: `f77a24bbc`. Public Codex source pinned to `ddd1812a51f4aded35c3ec5446672474d5cb546b`.

## Scope and evidence limits

This compares callable tools and observable local code with public Codex source and official product documentation. It is not an inspection of ChatGPT's proprietary implementation, nor a claim that every model, subscription or operating system receives every product capability. Some Help Center pages refused direct fetching (HTTP 403); their official indexed summaries were used with that limitation. New product navigation alone was not treated as a tool contract.

A name absent from Coding Tools' MCP list does not necessarily mean the capability is missing. Agent-native tools and the unified file-tools server deliberately replace duplicate names. Terminal, desktop, preview, subagent and history groups depend on settings, agent support and permission grants.

## Capability comparison

| Capability | Coding Tools implementation | Difference or remaining gap |
|---|---|---|
| Read, find and search project files | Headless read_file/list_dir/list_files/search_text; unified Read/Grep/Glob for supported sessions; native harness tools when present | Equivalent operations under different names. Hidden duplicate definitions are intentional, not missing tools. |
| Apply edits and inspect Git changes | apply_patch/patch_check and scoped git_status/diff/log/show/blame; unified Edit/Write; native harness Git | Keep scope checks and patch approval. No need to expose a second patch alias for parity. |
| Execute commands and send stdin | exec_command/write_stdin/read_output/kill_command, owned handles, optional Codex Windows sandbox | The Windows wrapper used pipes, not a true PTY. This audit does not implement a PTY or claim full-screen interactive-editor parity. |
| Plan and continue goals | update_plan/get_plan; goal tools, schedule_wakeup, native agent resume/compaction | Plans/goals are not permission grants. A persistent model conversation is not proof that a process survives an app/OS restart. |
| Rediscover a command after losing its reply | Added read-only, paginated list_commands in the terminal group | Returns only this chat's known handles and last-observed metadata, never raw commands, fresh probes or another chat's IDs. An empty list is not proof an unknown side effect never happened. |
| Images, screenshots and computer interaction | view_image, image metadata/diff, OCR, own-app view, opt-in desktop capture/UIA/window actions | Platform- and permission-dependent. No extra approval bypass is justified by another product's computer-use feature. |
| Browser/preview | Chat-local localhost preview and separate GPT Browser/account surfaces | Preview is deliberately not an unrestricted browser. ChatGPT's built-in browser/site tools use their own permissions and product runtime. Generic remote web search, research and WebMCP site tools are not exposed by this chat MCP allowlist; native harnesses may supply separate web tools. |
| Delegation | Explicit app subagents, model/provider-dependent native collaboration | Access depends on configuration and authorization. This audit launches no other agent. |
| Voice, image generation, hosted research and data-analysis sessions | Not implemented as local chat MCP tools in the audited allowlists; local code analysis can use installed command-line tools | These require appropriate model/services and user permissions. A Python shell is not a hosted persistent analysis kernel; a screenshot tool is not image generation. No fabricated aliases were added. |
| Desktop app/file integration | Project folders and explicit window/desktop tools | ChatGPT's Work-with-Apps/native integrations and browser sessions are product-specific. macOS and Windows features are not assumed identical. |

## Confirmed failures and changes

### 1. Explicit process deadlines were ignored by the sandbox wrapper

Headless already defines omitted/null/zero timeout as unlimited. Its sandbox wrapper did not forward timeout_ms at all, so a caller could request an end time that was never enforced.

The wrapper now validates and supervises the caller's explicit deadline on the same owned process tree. Omitted/null/zero still has no automatic runtime deadline. Very large deadlines are armed in bounded Node timer slices, avoiding the overflow that otherwise converts a delay over 2^31-1 ms into roughly one millisecond. Completion and explicit stop clear the timer. A quiet command or yielded call is never replayed.

### 2. Large output could exceed the claimed memory bound

The retention loop dropped complete chunks only while more than one chunk remained. A single eight-MiB write therefore stayed whole despite a four-MiB limit. Oversized chunks now retain a copied, bounded suffix, releasing their oversized backing storage. Absolute byte totals, output-gap cursors and read_output references remain usable.

### 3. Response-tail truncation could corrupt valid UTF-8

Starting a tail inside a multibyte scalar produced false replacement characters. Response tails now start after the complete scalar and expose per-stream truncation. This is byte/pixel-independent and does not change explicit raw-offset reads, including their existing incomplete-scalar retry contract.

### 4. A killed wrapper could be reported successful

An exit code of zero overrode a killed terminal state. Success now requires an actual completed normal exit. Incomplete stream finalization remains explicit; timeout and user stop are not inferred as success. Failed process-tree stop retains live ownership, returns a visible error and permits an explicit retry rather than leaving an unreachable falsely-killed handle.

### 5. Preview approval waited for ignored command-output probes

Before asking about a new origin, the app read every running command's streams through headless, including IDs owned by the separate sandbox. But previewOriginDecision explicitly ignores this evidence: the agent could forge it by echoing a URL.

Those unused reads are removed. Existing local-origin restrictions, already-reviewed/bypass behavior and per-chat user consent are unchanged. No printed URL becomes permission to open a site.

### 6. A lost tool reply could hide a still-owned handle

The sandbox command is tracked before its initial yield, but no model-callable operation listed that tracked metadata. Added list_commands lets the agent find a known accepted command and poll it instead of launching a duplicate. Listing is paginated, terminal-group gated, read-only and explicitly labels state as last-observed. It cannot inspect another chat's commands or expose raw command text/credentials. The original read_output/write_stdin ownership checks still apply.

## Long-horizon operating contract

- No default process deadline. Supply timeout_ms only when a real runtime bound is wanted; yield_time_ms controls waiting, not process lifetime.
- Keep and reuse command_id. Use list_commands to recover known handles, then read_output with its absolute cursor for long logs. write_stdin returns a bounded snapshot, not a persistent shell session history.
- Output is RAM-only and bounded; old bytes can expire and are reported as gaps. Live handles are not discarded merely to retain more completed output.
- No automatic replay after HTTP failure, quiet output, model compaction or an app restart. Inspect the existing handle or report uncertainty.
- App/OS restarts, sleep, expired credentials, provider quota, network outages and required safety approvals can still interrupt work. These fixes do not promise obstacle-free unattended execution.
- Terminal pipes do not supply a true PTY. Use noninteractive program flags and explicit stdin where possible; do not assume a GUI launched on Codex's private Windows desktop is visible to the user.
- No new runtime dependencies, disk output logs, polling service or live account changes.

## Verification

Failing baseline captured seven supervisor regressions, two timeout/preview integration failures, two missing-command-list failures and a failed-stop ownership failure. Existing no-implicit-timeout behavior was preserved, not represented as a newly discovered timeout bug.

Controlled-clock tests cover eight-day unlimited runs and a 30-day explicit deadline without actually waiting days. A real local Node parent/descendant smoke test verifies Windows process-tree timeout and retained output without a model/account call. Existing full terminal/MCP suites cover pre-spawn cancellation, accepted children, credential renewal, cross-chat isolation, path/symlink guards and approval behavior. Final counts and CI/release status are recorded with the PR; simulated elapsed time is not a claim of a real multi-day soak test.

Local verification: **298/298** checks passed across eleven Node suites, with no skips. Runtime syntax and whitespace checks passed. The final task-scoped graph includes eight changed files, 111 symbols and 27 affected flows at CRITICAL aggregate risk. Its dynamic/cross-module boundaries are not treated as evidence that code is unused; factory and ownership references were checked against current source. A local self-review was used after external review submission was refused.

## Sources

- [Codex CLI documentation](https://learn.chatgpt.com/docs/codex/cli).
- [Codex long-running work guidance](https://learn.chatgpt.com/codex/long-running-work).
- [Codex approvals and security](https://learn.chatgpt.com/codex/agent-approvals-security).
- [Pinned Codex exec arguments](https://github.com/openai/codex/blob/ddd1812a51f4aded35c3ec5446672474d5cb546b/codex-rs/core/src/tools/handlers/unified_exec.rs).
- [Pinned Codex process/wait configuration](https://github.com/openai/codex/blob/ddd1812a51f4aded35c3ec5446672474d5cb546b/codex-rs/core/src/unified_exec/mod.rs).
- [Pinned Codex handler categories](https://github.com/openai/codex/blob/ddd1812a51f4aded35c3ec5446672474d5cb546b/codex-rs/core/src/tools/handlers/mod.rs).
- [ChatGPT Windows app](https://help.openai.com/en/articles/9982051-using-the-chatgpt-windows-app).
- [ChatGPT desktop built-in browser](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app).
- [ChatGPT site tools](https://help.openai.com/en/articles/20001423-using-site-tools-in-the-chatgpt-desktop-app).
- [Work with Apps on macOS](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos).
- [ChatGPT Voice](https://help.openai.com/en/articles/20001274-chatgpt-voice).
- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275).

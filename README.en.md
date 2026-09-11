# Coding Tools MCP

[繁體中文](README.md) · **English** · [Releases and Windows installer](https://github.com/p90-lover/coding-tools-mcp/releases) · [AI + human workflow](docs/guides/ai-human-workflow.en.md)

A local desktop control center for AI-assisted development: the human defines the goal and permissions, the connected AI reasons about the task, and the app executes approved local tools and returns evidence. Project history helps the next conversation continue from verified work rather than reconstructing it from memory.

**Release line: `v0.4.4-rc.4` — scoped OAuth popup origin repair.** Read the [release notes](docs/releases/v0.4.4-rc.4.md) and the published release's validation evidence. A version in source code is not proof that a build passed. This is a release candidate, not a certified security sandbox.

## Optional native Codex bridge

The current candidate adds an explicitly opted-in native App Server bridge, separate from the released model-free tools. `codex_runtime_status`, `codex_agent_read` and `codex_agent_control` provide owned text sessions, native review, native compaction, interruption and unsubscribe. Model-use consent, trusted executable SHA-256, request/lifetime limits and Stop are local desktop controls. [Read setup, workflow and exact limits](docs/features/native-codex-runtime.md). Source presence is not proof of a published or provider-verified build.

## Download and start

Get `Coding.Tools.MCP_0.4.4-rc.4_x64-setup.exe` from the [versioned release page](https://github.com/p90-lover/coding-tools-mcp/releases/tag/v0.4.4-rc.4). This focused Windows release provides SHA-256 checksums, source provenance and validation logs. The prior `v0.4.3-rc.1` release retains the Apple Silicon `.dmg`. Windows is publisher-unsigned; macOS uses ad-hoc signing and is not notarized. Verify the source and checksum before opening a downloaded installer.

Install and open the app, add your project directory as a workspace, select its authentication and permission settings, and start MCP. For a remote client, configure the supported FRP or Cloudflare connection and copy the displayed HTTPS `/mcp` endpoint. Complete the client-side authorization and tool scan. Start with `server_info`, `codex_tools_status`, `get_default_cwd` and `git_status` before making changes.

For ChatGPT, use the account/workspace's available Apps/developer-mode setup. Availability, action approval and tool refresh are controlled by the client and its administrators; this app cannot grant a ChatGPT account access or suppress client approvals. Consult [OpenAI's current setup guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta). Do not use old menu screenshots as authoritative instructions. The app offers assisted setup, not silent connector creation or reauthorization.

## Why ChatGPT may not show every tool

The saved tool catalog and execution permissions are different settings. This build fixes Core/Advanced/full-alias selection, and ChatGPT setup now shows the running listener's exact advertised names, profile-hidden names and metadata fingerprint. `server_info.tool_catalog` exposes the same evidence. It never claims to know which tools your ChatGPT chat has loaded. [Follow the tool-exposure guide](docs/guides/tool-exposure.en.md).

## What is in the product

| Area | Implemented behavior |
| --- | --- |
| Control center | Workspace/service overview, searchable navigation, sessions, integration settings, local delivery board, light/dark themes and English/Traditional Chinese controls. Some retained advanced forms use their existing language. |
| Local coding | File reading/listing/search, transactional patches, commands, bounded command output and stdin, Git inspection, scoped approval requests and project instructions. |
| Live permissions | Permission-only saves update running MCP/Actions contexts without restarting listeners, rotating tunnel addresses or recreating authentication state. |
| Computer observation | Windows window discovery and observation of approved, supported non-minimized background windows without activating them by default. |
| Computer input | Selected-application foreground mouse/keyboard execution with local consent, visible monitoring, retry protection and emergency Stop. Not invisible background input. |
| Remembered approval | Always enabled until stopped, optional remembered exact executable approval, restart restoration and Windows sign-in startup. Security configuration and executable identity remain checked. |
| Vision | Screenshot/window capture, image viewing/inspection/comparison and exact-agent/live previews. Screenshot pixels stay in application memory. |
| Paseo + Anneal | Read-only adapters for existing local instances, reused attributed status/ordering logic, and an operator-driven twelve-stage delivery checklist. Not bundled autonomous agent engines. |

Details: [computer use](docs/features/local-computer-use.md), [remembered control](docs/features/remembered-control.md), [vision](docs/features/local-vision.md), [Paseo/Anneal integration](docs/features/paseo-anneal-control-center.md).

## Change permissions without reconnecting MCP

Open the workspace's permission panel, change **Permission mode**, **Approval mode**, command rules or screen-capture permission, and save. The next admitted request uses the published policy revision. `server_info.live_permissions` reports that revision and the effective settings.

A permission-only save does not replace the listener, endpoint, bearer token or OAuth runtime. Existing history and the current directory remain shared. Old operation grants are revoked. Active owned command sessions reject further input and receive a termination request; their output remains readable. A short operation already committing may produce `LIVE_POLICY_BUSY`: retry Save, not service restart. A failed save does not partially apply the change. Already submitted OS actions cannot be undone.

**Permission mode is not tool-profile selection.** A changed tool profile can expose different schemas, so a client may need to refresh its tool catalog. Authentication, port or workspace-root changes are separate lifecycle changes. Quick Tunnel origin changes still need the client endpoint updated; a fixed hostname avoids address rotation. Remembered app consent is security-configuration-bound and may need local reapproval after a security change, but not MCP relinking.

[Read the live-policy contract](docs/features/live-permissions.md).

## Which Codex-style tools are inside MCP?

These are **actual local counterparts**, using the schemas returned by `tools/list`, not a copied Codex agent runtime. `tool_search` searches the current catalog; `codex_tools_status` reports its implemented and excluded capabilities.

| Tool family | MCP tools / boundary |
| --- | --- |
| Execute and inspect | `exec_command`, `write_stdin`, `read_output`, `kill_command`; legacy `session_id` and `kill_session` remain compatible. |
| Files and patches | `read_file`, `list_dir`, `list_files`, `search_text`, `grep_text`, `apply_patch`; additional tools depend on the selected profile. |
| Plan and discover | `update_plan`, `get_plan`, `tool_search`, `get_current_time`. Plans are bounded listener-local RAM state, not an autonomous scheduler or durable task archive. |
| Permissions | `request_permissions` for an exact operation. Persistent policy settings remain a local UI responsibility. |
| Images and desktop | `view_image`, `image_info`, `compare_images`, `capture_screenshot`, `capture_window`, and the `computer_*` tools. |
| Durable context | `history_session_bootstrap`, `history_session_search`, `history_session_read`, `history_session_checkpoint`, `history_session_validate`. |
| Optional native runtime candidate | `codex_runtime_status`, `codex_agent_read`, `codex_agent_control`; the separate local opt-in bridge can invoke installed Codex for text turns, review and native compaction. |
| Not bundled | Complete internal Codex tool parity, cloud web-search/account/plugin APIs, Paseo/Anneal autonomous engines and the retired upstream-derived native command sandbox. The separately opted-in AppContainer snapshot executor is included. |

**Not every internal Codex tool is included.** Tool-only execution does not invoke Codex or spend a Codex inference quota. Your chosen AI client still has its own usage, and external Paseo/Anneal agents may independently consume their providers' quotas. The released model-free path does not launch those agents or an AI reviewer. The separately opted-in native bridge can start model work and native review; it must not be described as quota-free.

## Work together: human → AI → tools → evidence

```text
Human: goal, allowed scope, acceptance criteria and risk limits
  → AI: inspect project instructions and restore bounded history
  → Human + AI: agree on a small plan and the relevant checks
  → App: authorize each tool call against the current policy
  → Tools: inspect / patch / execute / observe
  → AI: compare actual results with the acceptance criteria
  → Human: review changes, resolve uncertainty, accept or request revision
  → History: preserve evidence and the exact handoff target
  → Explicitly authorized delivery: verified source + installer + checksums
```

The local board records Specification → Plan → Plan review → Revise plan → Implementation → Code review → Independent review → Apply fixes → Documentation → Verification → Merge readiness → Delivery. These are operator-managed checkpoints: advancing a card does not run code, perform an independent review, or merge a pull request.

Use [the bilingual workflow guides](docs/guides/ai-human-workflow.en.md) for a worked example, session prompts and a learning-note template. The intended improvement is a tighter, inspectable feedback loop: fewer repeated explanations, smaller reviewable changes and explicit evidence. No speed or quality improvement is guaranteed without measuring your own workflow.

## How AI and humans learn from the work

The human reviews the hypothesis, predicts an outcome, checks the result and explains the correction. The AI can read approved project instructions and prior verified notes in the next session, so it has better task context. Neither a history checkpoint nor a board card retrains the model or changes its weights.

Keep learning notes factual: symptom, hypothesis, smallest useful check, result, cause, fix, regression risk and reusable lesson. Separate observed facts from speculation, and retain failed hypotheses. Store durable lessons as reviewed project Markdown or history; never store credentials or screenshots in those notes. Suggested measures are repeated regressions, review rework, unknown-outcome retries and handoff time—not unverified claims that the AI is getting smarter.

## Safety and privacy boundaries

Screen capture is locally opt-in. The monitor shows real frames, not generated previews; **Exact agent frame** uses the last image bytes returned to the client. **Pause**, **Stop** and **Ctrl + Alt + Esc** remain available. Always enabled is not always recording, approval for every window, or permission to unlock Windows. Protected/minimized windows may not be capturable.

Screenshots are not written as image files, thumbnails, recordings or disk screenshot caches by the app. The OS can page memory or create crash dumps, and a receiving client can retain images. Screen pixels are not automatically secret-redacted.

Use `aiTemp/` for temporary work and preserve unwanted files under `Trash/` rather than deleting them. Patch deletion is implemented as a move to the approved root's `aiTemp/Trash/`. **Arbitrary child processes are not covered by a universal no-deletion or filesystem sandbox guarantee.** The command boundary is `policy_only`, with `sandbox_enforced: false`; the unverified sandbox executor remains disabled, with no unrestricted fallback. Do not interpret full-access policy as administrator privileges or OS isolation.

## Develop and verify

The app uses Rust, Tauri 2 and SvelteKit. Use the versions pinned in the lockfiles and release workflow, plus [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run check
npm run build
npm run desktop
```

For a live-permission change, prioritize the same-listener HTTP regression, policy atomicity/revocation checks and local tool round trips. For a computer-use change, also run the isolated Windows input/capture fixture. A frontend preview alone does not verify native IPC, authorization or desktop input. Release gates inspect the actual packaged binary, version and bundled license notices and re-download assets for SHA-256 verification.

The source is organized under `src/` (UI), `src-tauri/src/tools/` (shared execution), and `src-tauri/src/mcp/`, `actions/`, `tunnel/`, and `integrations/` for transports, connections and management adapters. `old/` preserves the pinned upstream snapshot. Previous README copies are retained under `aiTemp/Trash/readme-before-live-permissions/` as historical documentation, not current setup guidance.

## License and attribution

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Upstream details and bundled license notices: [Paseo/Anneal notices](third_party/CONTROL_CENTER_NOTICES.md). This project is not an official OpenAI/Codex product.

## Shared workflow and model-free native commands

`workflow_list` and `workflow_update` connect the authenticated MCP workspace to the same local task board. Remote observations are not human approvals. `codex_command_exec` uses the pinned native command API with separate local consent and no model turns. Permission-only updates still need no MCP relink/restart. See [the bilingual workflow/command guide](docs/features/workflow-native-commands.md) for scope, paging, examples, quotas and remaining boundaries.

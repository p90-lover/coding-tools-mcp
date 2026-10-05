# Codex chat composer: approved design
Status: visual design approved by Ethan on 2026-10-05; PR-only, no installed-app changes.
Reference: Ethan's approved five-panel Codex light chat mockup supplied in the task on 2026-10-05.

## Required behavior
1. Header Team opens the existing team graph/editor; Mission Board opens the existing board. Keep the original node/connection/zoom/editing behavior with scoped Codex light-theme styling, not a replacement flat role list.
2. Composer starts in red Single mode. It shows the Model selector and hides Team/Orchestrator selector. Green Team mode shows the configured Team/Orchestrator selector and hides the standalone Model selector. Switching is an explicit user action, does not rewrite a running attempt, and does not send a message.
3. Model popup is independent of saved Team selection: searchable current runtime models, harness, effort, and context window. Default new non-WebGPT harness is Claude Code. Choosing WebGPT pins Native Codex and disables the other harness choices. Explicit valid non-WebGPT harness choices and saved permissions survive model changes.
4. Robot Team popup contains only reusable setups read from Runtime Team in the selected workspace. Never show fabricated presets or manufacture a team when opening a selector. Existing legacy single-team responses remain supported.
5. Permission popup contains only three icon rows: Ask for approval (hand), Approve for me (shield-code), Full access (bolt). No scope/shared-app footer or extra settings panel. Preserve actual backend permission boundaries; enabling Full access retains normal confirmation, and invalid/managed/unavailable capabilities cannot be faked.
6. Default native tuple: workspace/on-request/user. Automatic review: workspace/on-request/auto_review. Full access: danger-full-access/never/user. Existing custom/mixed raw settings remain untouched until an explicit mode selection.
7. Single mode must execute one selected model only, not silently run the full team; Team mode executes the chosen saved configuration with optimistic revision and scope checks.
8. Unsupported effort/context on an adapter remains visible but disabled with accurate reason, until its real runtime supports it. Never claim a budget is an inherent model context limit.
9. Keep native typed approvals, current running role permissions, old mission snapshots, browser authentication admission and shared app/MCP authorization from PR252.
10. Restarting a settled Single attempt consumes only its explicit deferred permission intent; never revive historical broader permissions or rewrite its old receipt/model/harness.

## Runtime capability boundaries
- Native Codex presets require actual consented runtime metadata and effective policy acknowledgement. A draft menu never connects a role.
- AO Claude Code/Codex preset tuples are explicit adapter requests, not Native OS-sandbox readback or shared MCP/app/OS grants. Ask uses accept-edits (Claude acceptEdits; Codex workspace-write/on-request chat), Auto uses auto, Full uses bypass-permissions. No preset uses inherited default mode.
- Codex workspace presets are unavailable on TUI-only configurations, and unavailable chat drivers never fall back to an unverified TUI sandbox. Legacy routes with no explicit tuple keep their existing harness mode.
- Remembered custom/read-only policies that an adapter cannot honor fail closed until an explicit supported preset is chosen.

## Implementation constraints
- Update PR252 source only. No app patch/restart/install, credentials/global-config edits, unrelated primary work, new product dependencies or fake UI-only execution toggle.
- Build from isolated PR worktree. Reuse existing canvas, role editor, route helpers and APIs.
- Verify default/locked harness, mode exclusivity, flat request compatibility, real single/team dispatch, stale saved config, three permission actions, popup keyboard access and responsive screenshots.

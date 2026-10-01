# Runtime AO: workspace mission canvas

Status: approved for implementation. The user approved the remaining recommended answers and instructed implementation and a real WebGPT/Gemini test. Live execution is not yet verified.

## Outcome and settled decisions

Runtime > Agent Orchestrator has two coordinated views: **Board**, using AO's own workspace/project mission board, and **Team canvas**, the editable company-role graph. They share the selected AO project, tasks/sessions, status and execution receipts. Do not build a lookalike board with an independent task store. More > Agent Orchestrator retains the upstream application/management view.

The main pane fills the space beside Coding Tools' left sidebar, without another application sidebar or a permanent bottom bar. Reuse the original AO board component through the source integration, not its entire nested desktop shell.

Keep the previously approved defaults: one workspace/project per mission, separate mission boards, top-to-bottom initial layout, freely movable cards, real dependencies, and all required parents finishing before a child starts. WebGPT High coordinates and reviews; Gemini 3.8 Flash High runs workers through an explicitly selected AO harness and the shared CPA pool. Never substitute another model silently.

Reuse the current checkout. Do not automatically create Git worktrees. Credentials remain in their private host stores; model/account selectors display connection state, not keys.

## Proposed company model

Confirmed: reusable role blocks with mission-specific task queues and execution receipts. A role can work on multiple assignments over time; a role definition is not a permanently shared model conversation.

| Role | Responsibility | Default model | Required handoff |
|---|---|---|---|
| Owner | Sets the goal, workspace, constraints and definition of done | User | Mission brief |
| Orchestrator | Decomposes work, assigns owners, schedules dependencies and manages limits | WebGPT High | Assignments and current plan |
| Planner / technical lead | Defines approach, interfaces, acceptance checks and file ownership | WebGPT High, optional separate block | Reviewed plan |
| Researcher | Finds evidence and records uncertainties before implementation | Gemini worker | Findings and sources |
| Engineer | Implements one bounded assignment | Gemini worker | Change summary, patch and evidence |
| QA / tester | Checks acceptance criteria and regressions independently | Gemini worker | Test results and failures |
| Reviewer | Reviews the actual outputs and requests specific rework | Separate WebGPT High session | APPROVED or CHANGES_REQUIRED with reasons |
| Integrator | Resolves approved changes, checks conflicts and prepares delivery | Configurable worker | Combined result and final checks |

Provide two templates: a lean orchestrator/workers/reviewer team, and a company team with optional research, planning, QA and integration. Do not run extra roles merely because a template contains them. Users can rename, duplicate, group and reassign role blocks.

Reporting hierarchy and execution dependencies are different. Department groups express ownership; directional handoff connections control task readiness. A reviewer must not silently approve its own implementation output.

## Workspace and mission behavior

- The top bar selects workspace/project, mission and saved team template. New mission, Start, Pause and Stop remain visible.
- Each block inherits the mission workspace. Additional linked workspaces must already be approved and show their access scope explicitly.
- Switching projects restores that project's mission, layout, zoom and selection. It never starts or replays work.
- Map Coding Tools workspace IDs to canonical AO project IDs. AO's own project/session/board APIs remain authoritative. The canvas controls those records through the named handlers rather than maintaining a parallel board.
- Team templates can be reused between projects, but task inputs, results, credentials and conversation history remain workspace-scoped.
- Workspace paths, model routes, prompts and graph revisions are captured in each run. A reusable team template is not the live run record.
- Parallel workers receive non-overlapping file ownership where possible. Conflicting writes queue; integration is a deliberate step. Shared-checkout work must preserve unrelated user edits.

## Canvas and connections

Use a pannable, zoomable canvas with top-to-bottom automatic layout, free placement, multi-select, alignment and Fit controls. Keep controls compact and floating rather than reserving a bottom strip.

Dragging a card body changes its position. Dragging a connector, or deliberately dropping onto a highlighted branch target, previews a real dependency and applies it on drop. Show invalid/cyclic connections before accepting them. A two-parent join waits for both parents.

Connections react gently to nearby dragging: slight bending, spring settling and a visible magnetic drop target. During execution, small directional pulses represent actual handoffs or active work. Queued lines remain still, paused lines stop moving, and failed handoffs show an error marker. Do not animate every line continuously or use animation as fake progress. Respect reduced-motion settings.

Use solid links for execution, subtle grouping for departments, and distinct review-return links. A review return schedules a new versioned attempt rather than introducing a deadlocking cycle into the current execution DAG.

Pending, running and review states remain prominent. Finished and held cards are quieter but readable. Cancelled and archived cards are filterable; archive preserves receipts. State must be communicated by text and icon as well as color.

## Clicking and editing a block

Click selects a card and opens a right-side inspector over the canvas. The inspector is dismissible and does not replace the board. Provide Settings, Tasks, Output and History tabs.

Editable settings:

- Name, role and department.
- Exact model, effort, AO harness and account/pool selection.
- Instructions, expected output and acceptance criteria.
- Workspace/file scope and capabilities supported by that harness.
- Incoming dependencies, outgoing handoffs and join rules.
- Concurrency, timeout, turn budget and retry policy.

A running attempt retains its captured configuration. Users may move its card visually, inspect it, or edit a draft for future work; changing model, instructions or dependencies must not silently modify an already submitted attempt. The inspector clearly distinguishes current-run values from draft changes.

Undo/redo covers draft graph and layout edits. It cannot undo a sent prompt, consumed quota or executed command. Stop prevents future dispatch and requests cancellation of active work; completion is shown only after a terminal receipt is observed.

## Execution and automation

1. The user selects the workspace and enters a mission brief.
2. AO validates the exact selected models, connected accounts, harness capabilities and workspace scope.
3. Start captures the mission revision and grants bounded execution. Routine setup should not repeat the user's confirmation in native dialogs.
4. WebGPT plans and assigns tasks through the AO tools. Ready workers launch only after their required inputs exist.
5. QA and review inspect actual outputs. A rejection automatically returns to the assigned worker for at most two rework rounds, then becomes held with a visible reason. Reviewers do not edit implementation files; they return changes to workers.
6. A mission finishes only when required work has successful receipts, required checks pass, and the independent review approves. Empty answers, held turns and missing evidence cannot count as success.

The existing `coding_tools_agent_orchestrator` MCP tool exposes creation, graph updates, start, progress and observation. It must not expose a way for an agent to approve its own pending tool request. Normal harness permissions continue to govern file changes, commands and computer input.

The inspector must distinguish a listed capability from a verified working capability. Computer use and vision are enabled only when the selected harness actually provides them and their requirements have been met.

## Confirmed staffing limits

WebGPT may allocate extra workers automatically within the approved workspace and model routes. The limit is configurable, not hardcoded at three. Provide an app-wide maximum in Settings and a per-mission maximum on the board; effective capacity is bounded by both. Use three as the initial default.

All worker specializations and nested delegated workers count toward the same limits. A waiting task does not become an extra untracked agent. Lowering a limit lets existing work settle and prevents new starts until capacity is available; it does not abruptly terminate active work. Multiple projects share the global pool.

## Failure and recovery requirements

Show the exact failed stage, a bounded/redacted cause, the last successful event, and the action needed to recover. Preserve native thread/turn IDs and failure evidence before releasing a harness. A stale or missing session becomes held; reopening the board never resubmits it automatically.

The current isolated live test reached a WebGPT planner thread but became held before a final answer. Gemini and review did not start. Resolve that execution problem before claiming this redesigned board completes missions. Native plugin path warnings were observed, but they are not yet a confirmed cause.

## Implementation sequence

1. **Execution foundation:** preserve failure reasons, resolve the held planner path, and obtain a real WebGPT > Gemini > independent WebGPT review receipt in the isolated test workspace.
2. **Data ownership:** integrate with the AO module's existing projects, sessions and board persistence, adding only required team-template/role metadata and draft/run revision separation. Map Coding Tools workspace and harness bindings to those records. Preserve legacy Coding Tools mission records for explicit migration/readback. One scheduler owns each job; never let old and new dispatchers execute it twice. Do not add another task database.
3. **Canvas:** reuse the existing React mission surface and graph validation. Add pan/zoom, movable positions, connection editing, joins and accessible keyboard alternatives.
4. **Inspector:** bind role/model/instruction/scope settings to real host APIs. Show actual task queues, outputs and provenance.
5. **Coordination:** add bounded staffing and review-return attempts using the agreed policies. Enforce file ownership and model/permission limits.
6. **Motion and polish:** add state-aware line animation, drag response, reduced motion and responsive inspector behavior.
7. **Acceptance and delivery:** verify actual GUI create/start/edit flows, workspace isolation, joins, cancellation, restart recovery, CPA account navigation, and live model execution. Package and install the non-DEV build with recoverable backups; keep Codex open.

Primary existing modules: `desktop-electron/src/features/AgentOrchestratorSurface.tsx`, `agent-orchestrator.css`, `desktop-electron/electron/agent-orchestrator-workflow.cjs`, `src-tauri/src/integrations/ao.rs`, `rust-core/coding-tools-headless/src/lib.rs`, and `runtime-web/src/adapters/chatgpt-web/mcp-server.ts`.

## Interview frontier

- **Q1 — confirmed:** reusable roles with per-mission queues and receipts.
- **Q2 — confirmed:** automatic return to the assigned worker for up to two rework rounds, then hold with the reason.
- **Q3 — confirmed:** automatic staffing; the user can configure the maximum.
- **Q4 — confirmed:** global and per-mission limits.
- **Q5 — confirmed:** independent review; implementation edits return to workers.
- **Q6 — confirmed:** Apply changes to queued work explicitly; active attempts retain their original configuration.

The interview is complete and implementation is authorized. Routine implementation decisions should be recorded, not sent back as repeated approval requests.

## Visual concept

[GPT Image concept](../../../aiTemp/ao-runtime-company-canvas-20260927.png) · [Generation prompt](../../../aiTemp/ao-runtime-company-canvas-20260927.prompt.md)

The image depicts Team canvas. Board is AO's own workspace board, not a replacement imitation. This is a static design concept: spring motion, connection pulses and editing are planned interactions, not functionality demonstrated by the image. The built-in GPT Image tool was used; its interface did not expose a selectable or verifiable 2.5 model version.

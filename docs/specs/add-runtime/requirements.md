# Orchestrator Team presets

## 功能概述
Add Runtime > Orchestrator Team to the existing Electron desktop. Ethan approved the board-style role editor, multiple named teams, a default team and a new-chat team selector. Teams remain workspace-specific, matching current storage.

## 需求列表
### FR-1: Runtime entry and board
- Add Orchestrator Team under Runtime.
- Reuse the Overview Board canvas, drag/move, role selection and role inspector.
- Configure built-in and custom roles, routes, instructions, connections and worker/review limits.
### FR-2: Saved teams and default
- Save more than one named team per registered workspace.
- Support creating, duplicating and renaming a team and selecting one default.
- Persist teams, layout and the default across reloads.
- Preserve existing single-team data as the workspace default without discarding it.
### FR-3: New mission selection
- New chats select the workspace default initially and offer other saved teams.
- Create each mission from the selected team ID and revision, not an ambiguous revision alone.
### FR-4: Existing mission isolation
- Saving or choosing a default must not change existing mission snapshots or running attempts.
- Existing role editing must resolve the mission's own team, not another default with the same revision.

## Acceptance criteria
- AC1: Runtime navigation opens the team canvas; blocks can be added, edited and positioned.
- AC2: Two teams survive save/reload and exactly one is presented as the default.
- AC3: Creating a chat with the non-default team uses its roles and routes.
- AC4: Changing the default does not alter an existing mission.
- AC5: Stale revisions, foreign workspace teams and invalid graphs are rejected.

### FR-5: Bounded automatic Retry role
- A team MAY contain one configurable Retry sidecar, linked only to its orchestrator.
- Automatic recovery SHALL be limited to two retries per worker and SHALL preserve healthy workers, their grants and partial results.
- Exhausted account/model requests SHALL retain their failed state, error, partial work and attempt evidence and SHALL be forwarded to review without claiming success.

### FR-6: Responsive automatic chat startup
- Sending a new chat SHALL immediately display its task title and user message.
- Task/run IDs SHALL return before slow startup, while existing approval and executable checks remain authoritative.
- Startup failures SHALL remain visible and retryable; normal startup detail SHALL not be labelled as a failed launch.

### FR-7: Ready sibling concurrency
- The scheduler SHALL submit all ready siblings without waiting for a healthy sibling's output, subject to existing dependency, worker-capacity, revision and grant checks.

### FR-8: Live role details
- Opening a working role SHALL show current step/activity and bounded current output when the owned runtime exposes it.
- Polling SHALL be scoped, visibility-aware and coalesced; no output or progress SHALL be invented.

## 非功能需求
The implementation SHALL preserve workspace, revision, model, graph and execution-receipt validation. It SHALL reuse existing components and use no new runtime dependency.

## 依赖关系
Existing AppData.ao_teams, AO headless read/update API, Electron module bridge and overview canvas/role inspector.

## Out of scope
No new harness/provider or unrelated changes. Ethan subsequently authorized the matching app patch and scoped GitHub sync.

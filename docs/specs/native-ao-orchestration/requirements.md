# Requirements: Native AO orchestration

## 功能概述

Coding Tools users need one AO task/orchestration board instead of the standalone Paseo, Codex Router, CommandCode Proxy, and Anneal modules. Those integrations are decommissioned first and their private state archived. CPA, MCP, and native Codex remain. AO then gains a durable top-to-bottom task tree and a real Web GPT planner, selected AO harness worker, and distinct Web GPT reviewer. Until that execution works, the AO screen reports it as unavailable.

The authoritative design is [Native AO Orchestrator](../../superpowers/specs/2026-09-25-native-ao-orchestrator-design.md). This file supplies stable requirement IDs for the project specification gate.

## Previous experience and risks

- The existing AO handler only drafts CPA clauses and updates the plan board; it is not an executor.
- The retired modules share service, mesh, and profile structures with CPA and AO. Removing entire shared functions or the mixed profile store would lose unrelated behavior or data.
- Anneal's old tasks live in a separate Docker Postgres volume, not AO's local task board; preserve the volume and do not silently migrate or run its rows.
- Model catalog, health, and a browser smoke test do not prove a completed three-stage run.

## Terms

- **AO:** Agent Orchestrator, the only active Coding Tools task/orchestration board after decommission.
- **Run receipt:** durable identity and result of an actual selected harness/model turn, not a planning draft.

## Scope

In scope: private archive and active-integration removal for Paseo, Codex Router, CommandCode Proxy, and Anneal; retained legacy read compatibility; AO board/tree and harness selection; guarded workspace registration; real planner, worker, review, approvals, recovery, and installed-app verification.

Out of scope: deleting old user data, changing proxy credentials, automatic tool approvals, restoring retired modules as a fallback, publishing, and removing CPA's distinct CommandCode Go/Studio OAuth providers.

## 需求列表

### FR-1: Decommission legacy modules without losing data

**Priority:** Must. **Story:** As a Coding Tools user, I want only AO as the task/orchestration board while old Paseo, Router, CommandCode Proxy, and Anneal settings and runs remain recoverable.

1. WHEN Coding Tools retires any of the four modules, THEN it SHALL archive original private configuration, required encryption keys, daemon/component state, and Anneal's Postgres task volume before normalization or runtime removal, prune retired entries from live shared service config/secrets while keeping CPA, disable startup and dispatch even for caller-injected IDs, and retain legacy records for reading.
2. WHILE AO execution is incomplete, the UI SHALL label it unavailable rather than show a successful run.
3. IF the private archive fails, THEN it SHALL stop before changing the live configuration.

### FR-2: Persist an editable AO task tree

**Priority:** Must. **Story:** As a user, I want separate run boards with top-to-bottom draggable dependencies and durable status.

1. WHEN a card is dropped onto a branch, THEN AO SHALL save both its position and dependency edges with revision checks.
2. WHEN a card has two parents, THEN it SHALL wait for both to finish successfully.
3. IF a change creates a cycle, crosses runs, or edits a running dependency, THEN AO SHALL reject it without partial writes.

### FR-3: Execute exact selected model routes

**Priority:** Must. **Story:** As a user, I want Web GPT to plan and review while workers use the harness, account, and model I chose in AO.

1. WHEN an approved run starts, THEN AO SHALL collect an owned Web GPT planning turn, one or more actual AO-selected worker turns, and a distinct Web GPT review before marking completion.
2. IF the selected harness, account, model, permission, or Web GPT session is unavailable, THEN AO SHALL hold the run without substituting another route or starting a retired module.
3. WHEN a tool requests approval, THEN the existing explicit approval gate SHALL decide; AO SHALL not approve automatically.

### FR-4: Recover and verify without replay

**Priority:** Must. **Story:** As a user, I want reopening Coding Tools to preserve state without sending a task twice.

1. WHEN Coding Tools restarts, THEN AO SHALL reconcile saved request keys and receipts before advancing a stage.
2. IF a send outcome is uncertain, THEN AO SHALL hold the card without replaying it under a new key.
3. WHEN the installed non-DEV app is tested, THEN a real isolated Web GPT → selected Gemini worker → Web GPT review SHALL finish while all four retired modules remain absent.

## 非功能需求

- **NFR-1:** Secrets, cookies, keys, proxy passwords, and raw control tokens remain in existing private stores and never appear in renderer state, logs, or the project archive.
- **NFR-2:** The board fills the main pane, supports keyboard and reduced-motion interaction, and keeps cancelled/archived states inspectable.
- **NFR-3:** CPA, MCP, native Codex model routes, and CPA-owned CommandCode Go/Studio OAuth providers remain usable; no new Git worktrees or per-task commits are created.

## 依赖关系

Existing workflow board and profile DataStore; Electron app-handler/preload; Web GPT browser bridge; selected AO Codex-native harness; managed CPA; guarded workspace creation; existing tool approval UI. Exact route availability is a hard acceptance gate, not an assumed dependency success.

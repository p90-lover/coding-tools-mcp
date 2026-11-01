"use strict";

const { presentTask } = require("./kanban.cjs");

const SPECS = Object.freeze({
  archive_task: { readOnly: false, description: "Stop and archive exactly one task; preserve recoverable history." },
  delete_task: { readOnly: false, description: "Confirm recoverable logical deletion of exactly one task." },
  restore_task: { readOnly: false, description: "Restore a hidden task without replaying its schedule." },
  // Read-only for the focus guard: the list's background refresh (hourly, and after a chat is
  // archived) failed whenever the window was not in front, so the Archived section went stale. The
  // one change it makes, an archived chat past its days moving to recoverable deletion, is decided
  // here by the archive date and the days setting, never by the caller.
  archived_chats: { readOnly: true, description: "List the archived and deleted chats of the given projects; archived chats past their days move to recoverable deletion first." },
  archive_settings: { readOnly: false, description: "Read or set how many days an archived chat stays before recoverable deletion (0 keeps it)." },
  schedule_start: { readOnly: false, description: "Save and authorize one delayed start while the app remains running." },
  cancel_schedule: { readOnly: false, description: "Revoke the captured task's delayed start." },
  recover_schedule: { readOnly: false, description: "Explicitly cancel or set a new delay for a missed or uncertain start." },
  reconfigure_run: { readOnly: false, description: "Apply captured mission configuration after confirmed owned stop; preserve original task and history." },
  upstream_status: { readOnly: true, description: "Inspect the source-built local-only AO daemon." },
  upstream_start: { readOnly: false, description: "Start the bundled source-built AO daemon on loopback." },
  upstream_stop: { readOnly: false, description: "Stop the owned AO daemon after local confirmation." },
  upstream_show: { readOnly: false, description: "Embed the original AO renderer in the Coding Tools window." },
  upstream_hide: { readOnly: false, description: "Hide the embedded original AO renderer without ending sessions." },
  upstream_bounds: { readOnly: false, description: "Resize the embedded AO renderer within the host window." },
  upstream_projects: { readOnly: true, description: "List actual upstream AO projects." },
  upstream_bind_workspace: { readOnly: false, description: "Bind a registered local workspace to AO by its canonical directory without creating repositories or worktrees." },
  upstream_dependency_links: { readOnly: true, description: "Read whether new AO worktrees reuse the project's installed node_modules (a hard-link farm, `enabled`) and share its .venv/venv (`python`)." },
  upstream_set_dependency_links: { readOnly: false, description: "Turn reusing the project's installed node_modules (`enabled`) or sharing its .venv/venv (`python`) in new AO worktrees on or off." },
  dependency_link_info: { readOnly: true, description: "Read the repo-relative folders new worktrees of a workspace's AO project share with the project (`shared`) or get as hard-link farms (`farmed`)." },
  upstream_sessions: { readOnly: true, description: "List actual upstream AO sessions." },
  upstream_agents: { readOnly: true, description: "List upstream harness availability." },
  upstream_orchestrators: { readOnly: true, description: "List upstream project orchestrators." },
  upstream_create_project: { readOnly: false, description: "Create an upstream AO project after local confirmation." },
  upstream_create_session: { readOnly: false, description: "Create an upstream AO worker session after local confirmation." },
  upstream_create_orchestrator: { readOnly: false, description: "Create an upstream project orchestrator after local confirmation." },
  upstream_send: { readOnly: false, description: "Send a message to an upstream session after local confirmation." },
  inspect: { readOnly: true, description: "Inspect the in-process source-integrated Agent Orchestrator module." },
  board: { readOnly: true, description: "Read the old Coding Tools plan board with nested clauses." },
  models: { readOnly: true, description: "List models for one worker harness: CPA for Native Codex, or the AO agent's own catalog, with each model's points from finished Team rounds." },
  model_scores: { readOnly: true, description: "Read each model's points from finished Team rounds (simple process, frontend, backend, Android app, understanding, handling, command follow): average, recent, best and last per category, optionally for one role, with the latest scored rounds." },
  model_scores_clear: { readOnly: false, description: "Delete every saved model score; the model picker's hints start again from the next finished Team round." },
  subagents_config: { readOnly: true, description: "Read the Subagents page: whether chat agents may start subagents, their limits and permissions, the default model, and each saved subagent (name, purpose, model, instructions)." },
  subagents_save: { readOnly: false, description: "Save the Subagents page's settings and subagents." },
  subagents_runs: { readOnly: true, description: "List the subagents chat agents started: state, task, elapsed time and report." },
  subagents_stop: { readOnly: false, description: "Stop one running subagent for the user." },
  harnesses: { readOnly: true, description: "List worker harnesses: Native Codex plus installed upstream AO agents." },
  runs: { readOnly: true, description: "Read durable AO mission graphs in one workspace." },
  update_run: { readOnly: false, description: "Create, edit, or cancel a revisioned AO mission without repeating the caller's confirmation." },
  team_update: { readOnly: false, description: "Save reusable roles, apply settings to queued jobs, or change worker ceilings from the local GUI." },
  harness_status: { readOnly: true, description: "Inspect an AO-owned WebGPT-on-Codex connection; connected is not route verified." },
  permission_profiles: { readOnly: true, description: "Read actual managed native permission profiles for a consented AO connection without connecting or dispatching a turn." },
  connect_harness: { readOnly: false, description: "Connect one saved WebGPT or CPA worker node through the selected Codex executable after local confirmation." },
  stop_harness: { readOnly: false, description: "Stop one AO-owned Codex connection after local confirmation." },
  observe: { readOnly: true, description: "Read and reconcile one reserved AO card without submitting another turn." },
  advance: { readOnly: false, description: "Run one ready AO card, or observe an active reservation, with local approval and no automatic replay." },
  start_run: { readOnly: false, description: "Validate browser readiness and the saved AO graph before granting background execution with its saved role policies; tool approvals remain separate." },
  restart_run: { readOnly: false, description: "Stop a stuck or settled mission (kept in history) and start a fresh run of the same task with the current team." },
  control_run: { readOnly: false, description: "Pause queued work, resume a paused mission, or stop only that mission's owned harnesses from the local GUI." },
  activity: { readOnly: true, description: "Read what each working card of a run is doing now: start time, current step and last activity." },
  turn_timeline: { readOnly: true, description: "Read a finished card's thinking, tool calls (with their arguments and output) and messages back from its AO session." },
  run_status: { readOnly: true, description: "Read background AO run progress and held state." },
  approve_harness: { readOnly: false, description: "Respond to one visible native consent request with its typed decision and exact thread/turn scope after local confirmation; legacy Allow/Deny remains supported." },
  next: { readOnly: true, description: "Return the next actionable plan clause for the active Codex harness." },
  chat_send: { readOnly: false, description: "Send a chat message: create the chat's task (or append a follow-up) and start a team run on it." },
  chat_prewarm: { readOnly: false, description: "Start an AO agent for the new chat's selected model (or its team's orchestrator) ahead of the first message, so it does not launch on send." },
  chat_steer: { readOnly: false, description: "Hand a message to the chat's running AO agent at once (steer), without waiting for its turn to end." },
  chat_goal: { readOnly: false, description: "Pause, resume, edit or clear a chat's goal (/goal); a resumed goal starts its next round." },
  chat_queue: { readOnly: false, description: "Add, remove, clear or list a chat's queued messages; the app sends the next one when the chat's turn settles, with the chat closed too." },
  chat_wakeup: { readOnly: false, description: "Edit (its note, the minutes from now) or cancel the wake-up a chat's agent scheduled to resume itself later." },
  chat_loop: { readOnly: false, description: "Start or stop a chat's loop (/loop): a prompt it runs now and again every interval, or whenever its agent schedules the next round." },
  chat_auto_retry: { readOnly: false, description: "Read or set \"Retry automatically\": a failed single-model step runs again by itself, up to three times." },
  chat_model_judges: { readOnly: false, description: "Read or set \"Let the model judge\": requests the command reviewer would hand to you, and goal rounds that end needing you or failed, are judged by the model, which may also end the goal." },
  chat_auto_compact: { readOnly: false, description: "Read or set auto-compact (/autocompact): whether a chat compacts itself, and at what share (20-100%) of its size limit before its next message." },
  compact_chat: { readOnly: false, description: "Replace a settled chat's context with a handoff summary (/compact), focused as optional instructions say." },
  chat_delete_message: { readOnly: false, description: "Delete one message of a settled chat with its reply: the message leaves the task, its run is hidden from the chat, and the next turn starts a fresh agent session." },
  chat_diff: { readOnly: true, description: "Read the project's uncommitted git changes (/diff)." },
  codex_executable: { readOnly: true, description: "Locate the installed Codex desktop app's codex.exe used to run missions." },
  chat_processes: { readOnly: true, description: "List the commands a chat's agents started through the app's terminal (the chat's Terminal pane), with whether each still runs." },
  chat_process_output: { readOnly: true, description: "Read one of a chat's commands' output (stdout or stderr) from an offset." },
  chat_process_stop: { readOnly: false, description: "Stop one of a chat's running commands for the user." },
  chat_process_input: { readOnly: false, description: "Type the user's input into one of a chat's running commands." },
  chat_preview_state: { readOnly: true, description: "Read what each of a chat's agents shows in its preview browser (URL, title, errors)." },
  chat_preview_show: { readOnly: false, description: "Draw one chat agent's preview browser in the chat's Preview pane at the given bounds." },
  chat_preview_hide: { readOnly: false, description: "Take the chat's preview browser out of the Preview pane; it keeps running for the agent." },
  chat_preview_snapshot: { readOnly: true, description: "Read a still of the page shown in the chat's Preview pane, drawn in its place while the chat pet passes over it." },
  chat_preview_navigate: { readOnly: false, description: "The user's own navigation in a chat agent's preview: back, forward, reload or a localhost URL." },
  workspace_mode: { readOnly: false, description: "Read or set where a project's chats work: each in its own git worktree, one shared worktree, or the project folder itself (the Edit project dialog)." },
  chat_context: { readOnly: true, description: "Read how full each of a chat's agent sessions' context is, its token spend, rate limits and tool servers (the composer's context meter)." },
  cpa_quota: { readOnly: true, description: "Read each CPA Codex account's 5-hour and weekly usage limits, as CPA Helper last checked them (the context meter's plan usage limits)." },
  cpa_usage: { readOnly: true, description: "Read each CPA account's tokens, requests and estimated cost over a range (24h, 7d, 30d or all) from CPA Helper's usage log, with its quota where one is known (Codex windows; Cline Pass key activity)." },
  chat_turn_stats: { readOnly: true, description: "Read a chat turn's model requests through CPA from CPA Helper's log: steps, model time, time to first token, output speed, cache hits and tokens (the line under the chat box, and each ended turn's foot)." },
  chat_terminal_start: { readOnly: false, description: "Start the user's own shell in a chat agent's worktree (the side panel's Terminal tab)." },
  chat_changes: { readOnly: true, description: "Read a chat agent's worktree changes: git status with new files and the diff (the side panel's Changes tab)." },
  chat_files: { readOnly: true, description: "List one folder of a chat agent's worktree (the side panel's Files tab)." },
  chat_file: { readOnly: true, description: "Read one file of a chat agent's worktree as text (the side panel's Files tab)." },
  chat_branches: { readOnly: true, description: "List a project's git branches, the worktree each is checked out in, and which one the project folder and the chat are on (the composer's branch bar)." },
  chat_switch_branch: { readOnly: false, description: "Check out an existing branch in a project's folder, where its chats work (the branch bar's choice). Creates nothing; refuses uncommitted changes and a branch another worktree holds." },

  create: { readOnly: false, description: "Create a task for the Coding Tools mission board at its expected revision." },
  append: { readOnly: false, description: "Append reviewed clauses to the old plan board with its expected revision." },
  task_rename: { readOnly: false, description: "Rename a chat (its board task); the chat's messages are kept." },
  move_task: { readOnly: false, description: "Move one plan task after local confirmation." },
  move_clause: { readOnly: false, description: "Move one plan clause after local confirmation." },
});

// Operations served by the AO runtime service although their names do not start with "upstream_".
const UPSTREAM_OPERATIONS = new Set(["dependency_link_info", "workspace_mode", "chat_processes", "chat_process_output", "chat_process_stop",
  "chat_process_input", "chat_preview_state", "chat_preview_show", "chat_preview_hide", "chat_preview_snapshot", "chat_preview_navigate", "chat_context",
  "cpa_quota", "cpa_usage", "chat_turn_stats", "chat_terminal_start", "chat_changes", "chat_files", "chat_file", "chat_branches", "chat_switch_branch"]);

module.exports = Object.freeze({
  operations: Object.freeze(Object.keys(SPECS)),
  module: Object.freeze({
    id: "agent-orchestrator",
    name: "Agent Orchestrator",
    operations: Object.freeze(Object.entries(SPECS).map(([name, spec]) => ({ name, ...spec }))),
  }),
  isReadOnly(operation) {
    return SPECS[operation]?.readOnly === true;
  },
  async invoke(operation, args = {}, context = {}) {
    if (!Object.hasOwn(SPECS, operation)) throw new Error("Unknown Agent Orchestrator operation");
    const call = operation.startsWith("upstream_") || UPSTREAM_OPERATIONS.has(operation)
      ? context.services?.agentOrchestratorUpstream
      : context.services?.agentOrchestrator;
    if (typeof call !== "function") {
      return { ok: false, status: "unavailable", reason: "Coding Tools workflow service is unavailable" };
    }
    const result = await call(operation, args);
    if (operation !== "board" || result?.ok !== true) return result;
    return {
      ...result,
      tasks: Array.isArray(result.tasks) ? result.tasks.map(presentTask) : [],
      task: result.task ? presentTask(result.task) : null,
    };
  },
});

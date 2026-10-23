"use strict";

// Subagents (Runtime > Subagents): helpers a chat's agent starts for a piece of its work. The user
// sets them up (name, what each is for, its harness and model, instructions) and the limits they
// run under; a chat agent gets subagent_* tools to start one with a task, check on it and collect
// its report. Each is an AO session in the chat's project on that route, started in the
// background like a chat.
//
// - Unattended: nobody watches a subagent's session, so its requests are answered as "Approve for
//   me" answers them (allowed once, but whatever the command approver's safety rules block is
//   denied), a plan is accepted with edits allowed, and a question gets its recommended answer.
//   "Full access" starts it with permissions bypassed instead.
// - One level: a subagent's own session gets no subagent tools (chat-agent-tools.cjs).
// - A chat agent sees only the subagents it started.

const fs = require("node:fs");
const path = require("node:path");

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const PERMISSIONS = new Set(["auto", "full"]);
// The user, 2026-10-22: "it should allow me to use as many subagents on a chat and globally" (the cap was 10).
const LIMITS = Object.freeze({ maxConcurrent: [1, 100], maxPerChat: [1, 100], timeoutMinutes: [1, 240] });
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, maxConcurrent: 3, maxPerChat: 3, timeoutMinutes: 30, permission: "auto", releaseWhenDone: true, defaultRoute: null,
});
const MAX_AGENTS = 24;
const MAX_TASK = 16_000;
const MAX_INSTRUCTIONS = 8_000;
const MAX_REPORT = 24_000;
const MAX_RUNS = 200;
const POLL_MS = 2_000;
const MAX_WAIT_SECONDS = 60;
// The longest request answered for a subagent; a longer one is denied (the workflow's autoVerdict).
const MAX_CHECKED_REQUEST = 1500;
const TERMINAL_TURN = new Set(["completed", "failed", "interrupted", "cancelled", "recovered"]);
const ACTIVE = new Set(["starting", "running"]);

// Ready to use once a default model is chosen; the user edits or removes them.
const STARTERS = Object.freeze([
  { id: "explorer", name: "Explorer", enabled: true, route: null,
    description: "Reads the codebase to answer a question: finds the files involved, traces how something works, and reports with file paths. Changes nothing.",
    instructions: "You are a read-only explorer. Investigate the codebase to answer the task. Do not edit files and do not run commands that change anything. Report concisely, citing file paths and line numbers." },
  { id: "implementer", name: "Implementer", enabled: true, route: null,
    description: "Makes one well-defined change (a function, a component, a fix) and runs the relevant tests.",
    instructions: "You implement exactly the change the task describes, matching the surrounding code's style. Run the relevant tests or checks. Report what you changed (files) and the test results." },
  { id: "reviewer", name: "Reviewer", enabled: true, route: null,
    description: "Reviews changes for bugs, edge cases and missing tests, and reports findings by severity. Changes nothing.",
    instructions: "You review code for correctness: bugs, edge cases, error handling, security and missing tests. Do not edit files. Report findings ordered by severity, each with file, line and a concrete suggestion." },
]);

// A subagent whose model, effort or window the chat agent picks itself always runs on Claude Code.
const PICKED_HARNESS = "ao:claude-code";
// A team's task becomes its chat's first message, which the board keeps to 8 KB.
const MAX_TEAM_TASK = 7_000;
const MAX_MODELS_LISTED = 200;
const MAX_INSPECT_ITEMS = 60;

const SUBAGENT_TOOL_DEFS = Object.freeze([
  { name: "subagent_list", title: "List subagents",
    description: "The subagents the user set up for you (Runtime > Subagents): each one's id, what it is for and its model, the saved teams you can run as a subagent, plus how many may run at once. Start one with subagent_start.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "subagent_models", title: "List subagent models",
    description: "The models a subagent can run on when you pick one (subagent_start's model), each with its reasoning efforts and the context windows it accepts. Picked models always run on Claude Code.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "subagent_start", title: "Start a subagent",
    description: "Start a subagent (or a saved team) on a self-contained task. It works on its own in this project (it cannot see this conversation, so give it everything it needs: goal, files, constraints, what to report) and ends with a report you read with subagent_result. Several can run in parallel; keep working while they do. "
      + "Optionally pick its model, effort and context window (from subagent_models); it then runs on Claude Code. Give `team` instead of `agent` to have a saved team (subagent_list) do the task as one subagent.",
    inputSchema: { type: "object", additionalProperties: false, required: ["task"], properties: {
      agent: { type: "string", description: "The subagent's id (from subagent_list). May be left out when you pick a model: it then has no role instructions beyond the task" },
      team: { type: "string", description: "A saved team's id or name (from subagent_list), instead of agent; the team runs with its own models" },
      task: { type: "string", description: "The complete task for the subagent" },
      model: { type: "string", description: "Run it on this model (an id from subagent_models), on Claude Code" },
      effort: { type: "string", enum: [...EFFORTS], description: "Its reasoning effort (one the model offers, from subagent_models); runs it on Claude Code" },
      context_window: { type: "integer", minimum: 4096, description: "Its context window in tokens (within the model's range, from subagent_models); runs it on Claude Code" },
      wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, description: "Wait up to this long for its report (default 0: return at once)" },
    } } },
  { name: "subagent_message", title: "Message a subagent",
    description: "Send a subagent you started a message. While it works, the message steers its current turn; once it has finished (or was stopped), it continues the same session with the message as a new turn, keeping everything it did, and its next report replaces the last one (returned here as previous_report). A team takes a message only once it has finished.",
    inputSchema: { type: "object", additionalProperties: false, required: ["subagent_id", "message"], properties: {
      subagent_id: { type: "string" },
      message: { type: "string", description: "What to tell it: a correction, more detail, or the next task" },
      wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, description: "Wait up to this long for its report (default 0)" },
    } } },
  { name: "subagent_inspect", title: "Inspect a subagent",
    description: "What a subagent is doing now: its turn state, its latest steps (messages, reasoning, commands, edits, tool calls), how long since it last did anything, a tool call still running, requests waiting on an answer, and its live output. For a team: each role's state and the answers so far.",
    inputSchema: { type: "object", additionalProperties: false, required: ["subagent_id"], properties: {
      subagent_id: { type: "string" },
      items: { type: "integer", minimum: 1, maximum: MAX_INSPECT_ITEMS, description: "How many of its latest steps to show (default 20)" },
    } } },
  { name: "subagent_result", title: "Get a subagent's result",
    description: "A subagent's state and, once it has finished, its report. Waits up to wait_seconds (default 30) for it to finish.",
    inputSchema: { type: "object", additionalProperties: false, required: ["subagent_id"], properties: {
      subagent_id: { type: "string" },
      wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS },
    } } },
  { name: "subagent_status", title: "List started subagents",
    description: "The subagents you started in this chat, each with its state (running, completed, failed, stopped, timed_out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "subagent_stop", title: "Stop a subagent",
    description: "Stop a subagent you started that is still running.",
    inputSchema: { type: "object", additionalProperties: false, required: ["subagent_id"], properties: { subagent_id: { type: "string" } } } },
]);
const SUBAGENT_TOOLS = new Set(SUBAGENT_TOOL_DEFS.map((tool) => tool.name));

const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const clampInt = (value, [min, max], fallback) => (Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** A saved route a subagent may run on (an AO agent harness), or null. Throws for a malformed one. */
function cleanRoute(route) {
  if (route === null || route === undefined) return null;
  if (!route || typeof route !== "object" || Array.isArray(route)) throw new Error("A subagent's model must be an object");
  const harness = text(route.harness_id, 64);
  const model = text(route.model, 256);
  if (!/^ao:[a-z0-9-]{1,40}$/.test(harness)) throw new Error("Subagents run on an Agent Orchestrator agent (Claude Code, Codex or opencode), not Native Codex");
  if (!model || model === "default") throw new Error("Choose a model for the subagent");
  if (model.replace(/^cpa\//, "").startsWith("chatgpt-web/")) throw new Error("WebGPT models run only on Native Codex and cannot be used by a subagent");
  const clean = { harness_id: harness, model };
  if (typeof route.provider_id === "string" && route.provider_id) clean.provider_id = route.provider_id.slice(0, 80);
  if (route.effort !== undefined && route.effort !== null) {
    if (!EFFORTS.has(route.effort)) throw new Error("Choose a supported reasoning effort");
    clean.effort = route.effort;
  }
  if (route.context_window !== undefined && route.context_window !== null) {
    if (!Number.isSafeInteger(route.context_window) || route.context_window <= 0) throw new Error("A context window must be a positive whole number");
    clean.context_window = route.context_window;
  }
  return clean;
}

/** The settings and subagents as saved, made whole and valid; throws for input that is not. */
function cleanConfig(input) {
  const settings = input?.settings && typeof input.settings === "object" ? input.settings : {};
  const cleanSettings = {
    enabled: settings.enabled !== false,
    maxConcurrent: clampInt(settings.maxConcurrent, LIMITS.maxConcurrent, DEFAULT_SETTINGS.maxConcurrent),
    maxPerChat: clampInt(settings.maxPerChat, LIMITS.maxPerChat, DEFAULT_SETTINGS.maxPerChat),
    timeoutMinutes: clampInt(settings.timeoutMinutes, LIMITS.timeoutMinutes, DEFAULT_SETTINGS.timeoutMinutes),
    permission: PERMISSIONS.has(settings.permission) ? settings.permission : DEFAULT_SETTINGS.permission,
    releaseWhenDone: settings.releaseWhenDone !== false,
    defaultRoute: cleanRoute(settings.defaultRoute ?? null),
  };
  const list = Array.isArray(input?.agents) ? input.agents : [];
  if (list.length > MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} subagents`);
  const seen = new Set();
  const agents = list.map((agent) => {
    const name = text(agent?.name, 60);
    if (!name) throw new Error("Every subagent needs a name");
    const id = text(agent?.id, 40).toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error(`"${name}" needs an id of letters, digits and dashes`);
    if (seen.has(id)) throw new Error(`Two subagents share the id "${id}"`);
    seen.add(id);
    return { id, name, enabled: agent?.enabled !== false, description: text(agent?.description, 400),
      instructions: text(agent?.instructions, MAX_INSTRUCTIONS), route: cleanRoute(agent?.route ?? null) };
  });
  return { settings: cleanSettings, agents };
}

/**
 * The service. `launchArgs(workspaceId, route, name)` gives AO's spawn arguments for a route (the
 * workflow's, so a subagent's model is honoured as a chat card's is); `harness()` is AO's harness
 * service (spawn, observe, resolveApproval, resolveInput, interrupt, exitAgent); `blockedRequest`
 * and `recommendedAnswer` are the workflow's (agent-orchestrator-workflow.cjs). `models(workspaceId)`
 * is the workflow's model catalog for Claude Code (a picked model is checked against it), and
 * `teams()` the workflow's subagentTeams (list, start, followUp, state, stop).
 */
function createSubagents({ statePath = null, launchArgs, harness, blockedRequest = () => true, recommendedAnswer = () => ({ action: "decline" }),
  models = null, teams = () => null, logger = console, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let config = null;
  const runs = new Map(); // AO session id -> run
  const launching = []; // the parent chat of each start AO has not answered yet
  const pendingLaunches = new Map();
  const stopGenerations = new Map();
  let poller = null;
  let polling = false;
  const answered = new Set(); // approval ids already answered

  function read() {
    if (config) return config;
    let saved = null;
    try { saved = statePath ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null; } catch { saved = null; }
    try { config = cleanConfig(saved ?? { agents: STARTERS }); }
    catch (error) {
      logger?.warn?.("subagents.config_invalid", { message: String(error?.message ?? error).slice(0, 200) });
      config = cleanConfig({ agents: STARTERS });
    }
    return config;
  }
  function save(input) {
    const next = cleanConfig(input);
    if (statePath) {
      // Written whole, then renamed over the old file, so a crash never leaves half a file.
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const temporary = `${statePath}.tmp-${process.pid}-${now()}`;
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, statePath);
    }
    config = next;
    return next;
  }

  const routeOf = (agent) => agent.route ?? read().settings.defaultRoute;
  const enabledAgents = () => read().agents.filter((agent) => agent.enabled);
  /** What the chat agent's instructions say about its subagents (chat-agent-tools.cjs). */
  function describe() {
    const agents = enabledAgents().filter((agent) => routeOf(agent));
    return agents.map((agent) => `${agent.id} (${agent.description || agent.name})`).join("; ");
  }

  const view = (run) => ({
    subagent_id: run.id, ...(run.kind === "team" ? { team: run.agentId } : { agent: run.agentId }), name: run.agentName,
    ...(run.model ? { model: run.model } : {}), state: run.state, task: run.task.slice(0, 200),
    elapsed_seconds: Math.round(((run.endedAt ?? now()) - run.startedAt) / 1000), ...(run.turns > 1 ? { turns: run.turns } : {}),
    ...(run.report ? { report: run.report } : {}), ...(run.error ? { error: run.error } : {}), ...(run.stopping ? { stopping: true } : {}),
  });
  const active = () => [...runs.values()].filter((run) => ACTIVE.has(run.state));

  function remember(run) {
    runs.set(run.id, run);
    while (runs.size > MAX_RUNS) {
      const oldest = [...runs.values()].filter((item) => !ACTIVE.has(item.state)).sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldest) break;
      runs.delete(oldest.id);
    }
    schedule();
  }

  function schedule() {
    if (poller || !active().length) return;
    poller = setTimer(() => { poller = null; void poll(); }, POLL_MS);
    poller.unref?.();
  }

  function release(run) {
    // A team's agents belong to its run, which settles (or is stopped) as a whole.
    if (run.kind === "team") run.released = true;
    if (run.released === true) return Promise.resolve({ ok: true });
    if (!run.releasePromise) {
      const retained = !ACTIVE.has(run.state);
      run.releasePromise = Promise.resolve().then(() => harness()?.exitAgent?.(run.id)).catch(error => {
        // A retained report can outlive a session the user already removed.
        if (!retained || !/\b(?:SESSION_NOT_FOUND|SESSION_TERMINATED)\b/.test(String(error?.message))) throw error;
        return { ok: true };
      }).then(outcome => {
        if (outcome?.ok !== true) throw new Error(`Subagent ${run.id} shutdown is unconfirmed`);
        run.released = true;
        return outcome;
      }).finally(() => { run.releasePromise = null; });
    }
    return run.releasePromise;
  }

  function finish(run, state, fields = {}) {
    if (!ACTIVE.has(run.state)) return;
    Object.assign(run, { state, stopping: false, endedAt: now(), ...fields });
    logger?.info?.("subagents.finished", { agent: run.agentId, state, seconds: Math.round((run.endedAt - run.startedAt) / 1000) });
    if (read().settings.releaseWhenDone && !fields.released) {
      // The session, worktree and conversation stay for inspection; only its agent process goes.
      void release(run).catch(() => undefined);
    }
  }

  /** Answers the requests a subagent raised, as "Approve for me" would (see the header). */
  async function answer(run, approvals) {
    const service = harness();
    for (const approval of approvals) {
      if (!ACTIVE.has(run.state) || run.stopping) return;
      const id = approval?.approval_id;
      if (!id) continue;
      const key = JSON.stringify([run.id, id]);
      if (answered.has(key)) continue;
      answered.add(key);
      if (answered.size > 2000) answered.delete(answered.values().next().value);
      try {
        if (approval.kind === "question") {
          const reply = recommendedAnswer(approval);
          await service.resolveInput(run.id, id, reply.action, reply.content).catch(error => {
            if (!ACTIVE.has(run.state) || run.stopping) throw error;
            return service.resolveInput(run.id, id, "decline");
          });
          continue;
        }
        const decisions = Array.isArray(approval.decisions) ? approval.decisions : [];
        const request = [approval.kind, approval.tool, approval.command, approval.path, approval.toolInput].filter(Boolean).join(" · ");
        let decision;
        if (approval.kind === "plan") {
          decision = decisions.find((item) => /acceptEdits/i.test(item.id)) ?? decisions.find((item) => item.kind === "allow_once");
        } else if (Buffer.byteLength(request, "utf8") >= MAX_CHECKED_REQUEST || blockedRequest(request)) {
          // Too long to be sure of (AO's upstream cuts a tool's input at 1500 bytes and a command
          // at 4000, so the blocked part may sit past the cut): denied, as "Approve for me" does.
          decision = decisions.find((item) => item.kind === "reject_once") ?? decisions.find((item) => item.kind === "reject_always");
          logger?.info?.("subagents.request_denied", { agent: run.agentId, tool: String(approval.tool ?? "").slice(0, 80) });
        } else {
          decision = decisions.find((item) => item.kind === "allow_once");
        }
        if (decision) await service.resolveApproval(run.id, id, decision.id);
        else answered.delete(key);
      } catch (error) {
        answered.delete(key);
        logger?.warn?.("subagents.answer_failed", { agent: run.agentId, message: String(error?.message ?? error).slice(0, 200) });
      }
    }
  }

  const settled = (observation) => observation?.exited === true || (TERMINAL_TURN.has(observation?.turnState)
    && !["working", "running", "starting"].includes(observation?.status));
  /**
   * "API error 429 (attempt 3 of 10)" when the agent is backing off from its model refusing requests
   * (Claude Code's own retry notice is the newest thing on its timeline, at its third try or later);
   * otherwise null. A 5xx or a lost connection is left to its own retries.
   */
  function refusedModel(observation) {
    const timeline = Array.isArray(observation?.timeline) ? observation.timeline : [];
    const last = timeline[timeline.length - 1];
    if (!last || last.kind !== "system" || last.status !== "running") return null;
    const text = String(last.text ?? "");
    const attempt = text.match(/^Retrying\b.*?attempt (\d+) of (\d+)/i);
    if (!attempt || Number(attempt[1]) < 3 || !/API error 429/i.test(text)) return null;
    return `API error 429, attempt ${attempt[1]} of ${attempt[2]}`;
  }

  /** A team run's progress: settled with its closing answers as the report, or still going. */
  async function checkTeam(run) {
    let seen;
    try { seen = await teams()?.state({ workspaceId: run.workspaceId, runId: run.runId }); }
    catch (error) {
      if (!ACTIVE.has(run.state) || run.stopping) return;
      run.misses = (run.misses ?? 0) + 1;
      if (run.misses >= 5) {
        run.stopState = "failed";
        run.error = `The team's run cannot be read: ${String(error?.message ?? error).slice(0, 300)}; awaiting confirmed settlement`;
        await stop(run.id).catch(() => undefined);
      }
      return;
    }
    if (!seen || !ACTIVE.has(run.state)) return;
    run.misses = 0;
    if (run.stopping) {
      if (seen.settled) await stop(run.id).catch(() => undefined);
      return;
    }
    if (run.state === "starting") run.state = "running";
    if (!seen.settled) return;
    const report = (Array.isArray(seen.answers) ? seen.answers : []).join("\n\n---\n\n").slice(0, MAX_REPORT);
    if (seen.cancelled) finish(run, "stopped", report ? { report } : {});
    else if (seen.failed) finish(run, "failed", { error: String(seen.detail || "A role in the team failed").slice(0, 1000), ...(report ? { report } : {}) });
    else finish(run, "completed", { report: report || "(The team finished without a written report.)" });
  }

  async function check(run) {
    if (!ACTIVE.has(run.state)) return;
    const service = harness();
    // A follow-up turn gets the whole time limit again.
    if (!run.stopping && now() - (run.turnStartedAt ?? run.startedAt) > read().settings.timeoutMinutes * 60_000) {
      run.stopState = "timed_out";
      run.error = `Stopped after ${read().settings.timeoutMinutes} minutes (the Subagents page's time limit); awaiting confirmed settlement`;
      await stop(run.id).catch(() => undefined);
      return;
    }
    if (run.stopping && !run.stopAcknowledged && !run.stopPromise) {
      await stop(run.id).catch(() => undefined);
      return;
    }
    if (run.kind === "team") return checkTeam(run);
    if (!service) return;
    let observed;
    // Pinned to the turn it is on: after a message, the previous turn's report is not this one's.
    try { observed = await service.observe(run.id, run.turnId); }
    catch (error) {
      if (!ACTIVE.has(run.state) || run.stopping) return;
      run.misses = (run.misses ?? 0) + 1;
      // A read failure does not prove the agent stopped. Retain capacity while cancellation settles.
      if (run.misses >= 5) {
        run.stopState = "failed";
        run.error = `The subagent's session cannot be read: ${String(error?.message ?? error).slice(0, 300)}; awaiting confirmed settlement`;
        await stop(run.id).catch(() => undefined);
      }
      return;
    }
    if (!ACTIVE.has(run.state)) return;
    if (run.stopping) {
      if (settled(observed)) await stop(run.id).catch(() => undefined);
      return;
    }
    run.misses = 0;
    const state = observed?.turnState;
    if (run.state === "starting" && state && state !== "queued") run.state = "running";
    if (observed?.exited && !TERMINAL_TURN.has(state)) {
      finish(run, "failed", { error: "The subagent's session ended before it finished" });
      return;
    }
    if (TERMINAL_TURN.has(state)) {
      if (!settled(observed)) return;
      const report = String(observed.answer || "").slice(0, MAX_REPORT);
      if (state === "completed") finish(run, "completed", { report: report || "(The subagent finished without a written report.)" });
      else finish(run, "failed", { error: String(observed.error || `The subagent's turn ended (${state})`).slice(0, 1000), ...(report ? { report } : {}) });
      return;
    }
    // Its model keeps refusing requests: Claude Code backs off from a 429 up to ten times, about 20
    // minutes, while the chat that started it waits on its report. Seen live: an explorer on Gemini
    // through Antigravity got "Resource has been exhausted" from every Google account for 20 minutes
    // and its chat looked stuck. From the third refusal it stops and tells the chat why, so the chat
    // goes on (on its own, or with another subagent).
    const refused = refusedModel(observed);
    if (refused) {
      run.stopState = "failed";
      run.error = `Its model keeps refusing requests (${refused}); it was stopped so you can go on. `
        + "Do the task yourself, or the user can give this subagent another model on the Subagents page.";
      logger?.info?.("subagents.model_refused", { agent: run.agentId });
      await stop(run.id).catch(() => undefined);
      return;
    }
    if (Array.isArray(observed?.approvals) && observed.approvals.length) await answer(run, observed.approvals);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await Promise.all(active().map((run) => check(run).catch((error) => logger?.warn?.("subagents.check_failed",
        { message: String(error?.message ?? error).slice(0, 200) }))));
    } finally {
      polling = false;
      schedule();
    }
  }

  const sleep = (ms) => new Promise((resolve) => { const timer = setTimer(resolve, ms); timer?.unref?.(); });
  async function waitFor(run, seconds) {
    const deadline = now() + Math.max(0, Math.min(MAX_WAIT_SECONDS, seconds)) * 1000;
    // Read at least once, so a result asked for without waiting is current.
    for (;;) {
      if (ACTIVE.has(run.state)) await check(run).catch(() => undefined);
      if (!ACTIVE.has(run.state) || now() >= deadline) return;
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
  }

  /**
   * Throws when another subagent for `parent` would pass a limit. Starts and messages still waiting
   * on AO count too: a chat agent calls tools in parallel, and each start checked the limits before
   * any of them was running, so all of them went ahead.
   */
  function checkRoom(parent, settings) {
    const holders = [...active().map((run) => run.parent), ...launching];
    if (holders.length >= settings.maxConcurrent) throw new Error(`${settings.maxConcurrent} subagents are already running (the limit); wait for one with subagent_result`);
    if (holders.filter((holder) => holder === parent).length >= settings.maxPerChat) {
      throw new Error(`This chat already runs ${settings.maxPerChat} subagents (the limit per chat); wait for one with subagent_result`);
    }
  }

  /** Claude Code's model catalog as the model pickers read it, or null when it cannot be read. */
  const catalogFor = (workspaceId) => Promise.resolve().then(() => models?.(workspaceId) ?? null).catch(() => null);

  /**
   * The route a subagent runs on: its saved one, or, when the chat agent picked a model, effort or
   * context window, Claude Code with those (the harness is never the chat agent's to pick). A pick
   * the catalog does not offer is refused here, naming what is; an unreadable catalog leaves the
   * launch's own check as the backstop.
   */
  async function pickedRoute(workspaceId, saved, { model, effort, context_window: contextWindow }) {
    // Only effort or window: keep a saved Claude Code route's model (and its provider).
    const inherit = (model === undefined || model === null) && saved?.harness_id === PICKED_HARNESS;
    let id = inherit ? saved.model : text(model, 256);
    if (!id) throw new Error("Name the model to run it on (subagent_models lists them); a picked effort or window runs on Claude Code");
    const catalog = await catalogFor(workspaceId);
    const offered = Array.isArray(catalog?.models) ? catalog.models : null;
    if (offered && !offered.includes(id) && offered.includes(`cpa/${id}`)) id = `cpa/${id}`;
    if (offered && offered.length && !catalog.stale && !offered.includes(id)) {
      const why = catalog.unavailable?.[id] ?? catalog.unavailable?.[`cpa/${id}`];
      throw new Error(`${id.replace(/^cpa\//, "")} is not offered to Claude Code${why ? ` (${String(why).slice(0, 200)})` : ""}; subagent_models lists the ones that are`);
    }
    const capabilities = catalog?.capabilities?.[id];
    const chosenEffort = effort ?? (inherit ? saved.effort : undefined);
    const chosenWindow = contextWindow ?? (inherit ? saved.context_window : undefined);
    if (effort !== undefined && effort !== null && capabilities) {
      const efforts = Array.isArray(capabilities.efforts) ? capabilities.efforts : [];
      if (!efforts.length) throw new Error(`${id.replace(/^cpa\//, "")} takes no reasoning effort: ${String(capabilities.effortReason || "none is offered").slice(0, 200)}`);
      if (!efforts.includes(effort)) throw new Error(`${id.replace(/^cpa\//, "")} offers the efforts ${efforts.join(", ")}`);
    }
    if (contextWindow !== undefined && contextWindow !== null && capabilities) {
      const range = capabilities.contextWindow;
      if (!range) throw new Error(`${id.replace(/^cpa\//, "")} takes no context window: ${String(capabilities.contextReason || "none is offered").slice(0, 200)}`);
      if (!Number.isSafeInteger(contextWindow) || contextWindow < range.min || contextWindow > range.max) {
        throw new Error(`${id.replace(/^cpa\//, "")} takes a context window from ${range.min} to ${range.max} tokens`);
      }
    }
    return cleanRoute({ harness_id: PICKED_HARNESS, model: id, ...(inherit && saved.provider_id ? { provider_id: saved.provider_id } : {}),
      ...(chosenEffort !== undefined && chosenEffort !== null ? { effort: chosenEffort } : {}),
      ...(chosenWindow !== undefined && chosenWindow !== null ? { context_window: chosenWindow } : {}) });
  }

  /** Starts a subagent for the chat session `parent` (an AO session id) in `workspaceId`. */
  async function start(parent, workspaceId, { agent: wanted, team: wantedTeam, task, ...picks } = {}) {
    const generation = stopGenerations.get(parent) ?? 0;
    const { settings } = read();
    if (!settings.enabled) throw new Error("Subagents are turned off on the Subagents page");
    const brief = text(task, MAX_TASK);
    if (!brief) throw new Error("Give the subagent a task");
    if (wantedTeam !== undefined && wantedTeam !== null) {
      if (wanted !== undefined || Object.values(picks).some((value) => value !== undefined && value !== null)) {
        throw new Error("A team runs with its own roles and models; give team without agent, model, effort or context_window");
      }
      return startTeam(parent, workspaceId, wantedTeam, brief, settings, generation);
    }
    let agent;
    if (wanted === undefined || wanted === null || wanted === "") {
      if (picks.model === undefined || picks.model === null) throw new Error("Name a subagent (subagent_list), a team, or a model to run it on");
      agent = { id: "custom", name: "Custom", instructions: "", route: null };
    } else {
      const key = text(wanted, 60).toLowerCase();
      agent = enabledAgents().find((item) => item.id === key || item.name.toLowerCase() === key);
      if (!agent) throw new Error(`No enabled subagent "${wanted}"; subagent_list shows the ones you can start`);
    }
    if (!routeOf(agent) && (picks.model === undefined || picks.model === null)) {
      throw new Error(`"${agent.name}" has no model: the user sets one on the Subagents page (its own, or the default model), or pick one (subagent_models)`);
    }
    checkRoom(parent, settings);
    // The place is taken and the launch registered before anything is awaited, so a parallel
    // start sees it and a parent stop waits for it, while a picked model is checked.
    launching.push(parent);
    const picked = Object.values(picks).some((value) => value !== undefined && value !== null);
    const pending = picked
      ? pickedRoute(workspaceId, routeOf(agent), picks).then((route) => launch(parent, workspaceId, agent, route, brief, settings, generation))
      : launch(parent, workspaceId, agent, routeOf(agent), brief, settings, generation);
    if (!pendingLaunches.has(parent)) pendingLaunches.set(parent, new Set());
    pendingLaunches.get(parent).add(pending);
    try { return await pending; }
    finally {
      launching.splice(launching.indexOf(parent), 1);
      pendingLaunches.get(parent).delete(pending);
      if (!pendingLaunches.get(parent).size) pendingLaunches.delete(parent);
    }
  }

  async function launch(parent, workspaceId, agent, route, brief, settings, generation) {
    const permissions = settings.permission === "full"
      ? { permission_profile: ":danger-full-access", approval_policy: "never", approvals_reviewer: "user" }
      : { permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
    // AO honours an explicit permission mode only on Claude Code and Codex; opencode keeps its own.
    const explicit = ["ao:claude-code", "ao:codex"].includes(route.harness_id);
    const args = launchArgs(workspaceId, { ...route, ...(explicit ? permissions : {}) }, `Subagent · ${agent.name}`);
    const prompt = [agent.instructions, SUBAGENT_NOTE, REPORT_NOTE, `Task:\n${brief}`].filter(Boolean).join("\n\n");
    const service = harness();
    if (!service) throw new Error("Agent Orchestrator is not running");
    const id = await service.spawn({ ...args, prompt, plain: true, subagent: true });
    const run = { id, parent, workspaceId, agentId: agent.id, agentName: agent.name, model: route.model.replace(/^cpa\//, ""), task: brief,
      startedAt: now(), endedAt: null, state: "starting", report: "", error: "", turns: 1 };
    remember(run);
    await stopIfParentStopped(run, parent, generation);
    logger?.info?.("subagents.started", { agent: agent.id, harness: route.harness_id });
    return run;
  }

  /** A start whose chat was stopped while AO created it is stopped at once (stopParent). */
  async function stopIfParentStopped(run, parent, generation) {
    if ((stopGenerations.get(parent) ?? 0) === generation) return;
    const outcomes = await Promise.allSettled([stop(run.id, parent), stopParent(run.id)]);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed) throw failed.reason;
  }

  const SUBAGENT_NOTE = "You are a subagent: the main chat agent gave you the task below. Nobody can answer questions while you work, so when something is ambiguous make a reasonable choice and say so in your report.";
  const REPORT_NOTE = "End with a concise report for the main agent: what you found or changed (files), commands you ran and their results, and anything left undone.";

  /** Starts a saved team on the task as one subagent: its run is a chat of its own (subagentTeams). */
  async function startTeam(parent, workspaceId, wanted, brief, settings, generation) {
    const service = teams();
    if (!service) throw new Error("Agent Orchestrator is not running");
    if (brief.length > MAX_TEAM_TASK) throw new Error(`A team's task can be at most ${MAX_TEAM_TASK} characters (it becomes its chat's first message)`);
    const key = text(wanted, 80).toLowerCase();
    const team = (await service.list(workspaceId)).find((item) => item.id.toLowerCase() === key || item.name.toLowerCase() === key);
    if (!team) throw new Error(`No saved team "${wanted}" with a model for every role; subagent_list shows the teams`);
    checkRoom(parent, settings);
    launching.push(parent);
    const pending = (async () => {
      const message = [SUBAGENT_NOTE.replace("You are a subagent", "Your team is working as a subagent"), REPORT_NOTE, `Task:\n${brief}`].join("\n\n");
      const started = await service.start({ workspaceId, teamId: team.id, title: `Subagent team · ${team.name}`.slice(0, 120), message });
      const run = { id: `team-${started.runId}`, kind: "team", runId: started.runId, taskId: started.taskId, parent, workspaceId,
        agentId: team.id, agentName: team.name, task: brief, startedAt: now(), endedAt: null, state: "starting", report: "", error: "", turns: 1 };
      remember(run);
      await stopIfParentStopped(run, parent, generation);
      logger?.info?.("subagents.team_started", { roles: team.roles.length });
      return run;
    })();
    if (!pendingLaunches.has(parent)) pendingLaunches.set(parent, new Set());
    pendingLaunches.get(parent).add(pending);
    try { return await pending; }
    finally {
      launching.splice(launching.indexOf(parent), 1);
      pendingLaunches.get(parent).delete(pending);
      if (!pendingLaunches.get(parent).size) pendingLaunches.delete(parent);
    }
  }

  async function stop(id, parent = null, includeRetained = false) {
    const run = runs.get(id);
    if (!run || (parent !== null && run.parent !== parent)) throw new Error("No such subagent");
    if (run.released === true) return run;
    const active = ACTIVE.has(run.state);
    if (!active && !includeRetained) return run;
    if (run.stopPromise) return run.stopPromise;
    run.stopping = true;
    run.stopPromise = Promise.resolve().then(async () => {
      const service = harness();
      if (active && run.kind === "team") {
        // The workflow's mission Stop: no more work starts and its owned agents are interrupted.
        const owner = teams();
        if (!owner) throw new Error("Agent Orchestrator is not running; the team's stop was not confirmed");
        if (!run.stopAcknowledged) {
          await owner.stop({ workspaceId: run.workspaceId, runId: run.runId });
          run.stopAcknowledged = true;
        }
        const seen = await owner.state({ workspaceId: run.workspaceId, runId: run.runId });
        if (!seen?.settled) throw new Error("Stop requested; the team is finishing turns it already sent");
        if (!run.report && Array.isArray(seen.answers) && seen.answers.length) run.report = seen.answers.join("\n\n---\n\n").slice(0, MAX_REPORT);
      } else if (active) {
        if (typeof service?.interrupt !== "function") throw new Error("Agent Orchestrator is not running; the subagent's stop was not confirmed");
        if (!run.stopAcknowledged) {
          await service.interrupt(run.id);
          run.stopAcknowledged = true;
        }
        const observed = await service.observe(run.id);
        if (!settled(observed)) throw new Error("Stop requested; the subagent is still working or its settlement is unconfirmed");
      }
      await release(run);
      if (ACTIVE.has(run.state)) finish(run, run.stopState ?? "stopped", { ...(run.stopState ? {} : { error: "" }), released: true });
      else run.stopping = false;
      return run;
    }).catch(error => {
      if (ACTIVE.has(run.state) && !run.stopState) run.error = String(error?.message ?? error).slice(0, 500);
      throw error;
    }).finally(() => { run.stopPromise = null; });
    return run.stopPromise;
  }

  async function stopParent(parent) {
    stopGenerations.set(parent, (stopGenerations.get(parent) ?? 0) + 1);
    const children = [...runs.values()].filter(run => run.parent === parent);
    const outcomes = await Promise.allSettled([
      ...children.flatMap(run => [stop(run.id, parent, true), stopParent(run.id)]),
      ...(pendingLaunches.get(parent) ?? []),
    ]);
    const failures = outcomes.filter(outcome => outcome.status === "rejected").map(outcome => String(outcome.reason?.message || outcome.reason));
    if (failures.length) throw new Error(failures.join("; "));
  }

  const ownRun = (parent, id) => {
    const run = runs.get(String(id ?? ""));
    if (!run || run.parent !== parent) throw new Error("No such subagent in this chat; subagent_status lists the ones you started.");
    return run;
  };

  /**
   * A message from the chat agent: it steers the subagent's running turn, or, once the subagent
   * has finished, continues the same session (its released agent resumed) as a new turn. A team
   * takes one only once its run has settled, as a new run of the same chat.
   */
  async function message(parent, id, words) {
    const run = ownRun(parent, id);
    const body = text(words, MAX_TASK);
    if (!body) throw new Error("Write the message for the subagent");
    if (run.stopping) throw new Error("This subagent is stopping; message it once subagent_result shows it stopped");
    if (run.resuming) throw new Error("This subagent is already taking a message; wait for it");
    const messageId = () => `subagent:${run.id}:${(run.messages = (run.messages ?? 0) + 1)}`;
    // Read first: one that finished since the last poll takes a new turn, not a steer.
    if (ACTIVE.has(run.state)) await check(run).catch(() => undefined);
    if (run.stopping) throw new Error("This subagent is stopping; message it once subagent_result shows it stopped");
    if (ACTIVE.has(run.state)) {
      if (run.kind === "team") throw new Error("A team takes a message only once it has finished; read its progress with subagent_inspect, or stop it");
      if (run.state === "starting") throw new Error("This subagent has not begun its turn yet; message it once subagent_inspect shows it running");
      const service = harness();
      if (!service) throw new Error("Agent Orchestrator is not running");
      const steered = await service.steer(run.id, body, messageId());
      if (steered?.steered) return { delivered: "steered", ...view(run) };
      // The turn ended as the message arrived: its report is collected before the next turn.
      await check(run).catch(() => undefined);
      if (ACTIVE.has(run.state)) throw new Error("The subagent's turn is ending; collect its report with subagent_result, then message it again");
    }
    const { settings } = read();
    if (!settings.enabled) throw new Error("Subagents are turned off on the Subagents page");
    checkRoom(parent, settings);
    launching.push(parent);
    run.resuming = true;
    try {
      const previous = run.report;
      let turn = {};
      if (run.kind === "team") {
        const owner = teams();
        if (!owner) throw new Error("Agent Orchestrator is not running");
        const next = await owner.followUp({ workspaceId: run.workspaceId, taskId: run.taskId, teamId: run.agentId, message: body });
        turn = { runId: next.runId };
      } else {
        // A released agent is resumed first; finish() may still be releasing it.
        if (run.releasePromise) await run.releasePromise.catch(() => undefined);
        const service = harness();
        if (!service) throw new Error("Agent Orchestrator is not running");
        if (!await service.continuable(run.id)) throw new Error("This subagent's session can no longer continue (removed, or its agent could not resume); start a new one with subagent_start");
        const sent = await service.send(run.id, body, messageId());
        turn = { turnId: sent.turnId };
      }
      Object.assign(run, turn, { state: "starting", released: false, turnStartedAt: now(), endedAt: null, report: "", error: "", stopState: undefined,
        stopAcknowledged: false, misses: 0, turns: (run.turns ?? 1) + 1 });
      schedule();
      logger?.info?.("subagents.continued", { agent: run.agentId, turns: run.turns });
      return { delivered: "new_turn", ...view(run), ...(previous ? { previous_report: previous } : {}) };
    } finally {
      run.resuming = false;
      launching.splice(launching.indexOf(parent), 1);
    }
  }

  const snippet = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  /** What a subagent is doing now, read from AO (or, for a team, from its run). */
  async function inspect(parent, id, items) {
    const run = ownRun(parent, id);
    if (ACTIVE.has(run.state)) await check(run).catch(() => undefined);
    if (run.kind === "team") {
      const seen = await teams()?.state({ workspaceId: run.workspaceId, runId: run.runId });
      if (!seen) throw new Error("Agent Orchestrator is not running");
      return { ...view(run), roles: seen.roles, ...(seen.detail ? { detail: seen.detail } : {}),
        ...(ACTIVE.has(run.state) && seen.answers?.length ? { answers_so_far: seen.answers.map((answer) => snippet(answer, 2000)) } : {}) };
    }
    const service = harness();
    if (!service) throw new Error("Agent Orchestrator is not running");
    const seen = await service.observe(run.id, run.turnId);
    const count = Number.isSafeInteger(items) ? Math.min(MAX_INSPECT_ITEMS, Math.max(1, items)) : 20;
    const timeline = (Array.isArray(seen?.timeline) ? seen.timeline : []).slice(-count).map((item) => ({
      kind: item.kind, status: item.status, ...(item.label ? { label: snippet(item.label, 120) } : {}), text: snippet(item.text, 600),
      ...(Array.isArray(item.files) && item.files.length ? { files: item.files.slice(0, 20).map((file) => String(file?.path ?? "")) } : {}),
    }));
    const ago = (stamp) => Math.max(0, Math.round((now() - stamp) / 1000));
    return {
      ...view(run), session_status: seen?.status ?? null, turn_state: seen?.turnState ?? null,
      ...(Number.isFinite(seen?.lastActivityAt) ? { last_activity_seconds_ago: ago(seen.lastActivityAt) } : {}),
      ...(Number.isFinite(seen?.toolSince) ? { tool_running_seconds: ago(seen.toolSince) } : {}),
      needs_input: seen?.needsInput === true,
      // Answered for it on the next poll (see answer()); shown so a stall waiting on one is visible.
      pending_requests: (Array.isArray(seen?.approvals) ? seen.approvals : []).map((approval) => ({ kind: approval.kind,
        ...(approval.tool ? { tool: snippet(approval.tool, 80) } : {}), ...(approval.command ? { command: snippet(approval.command, 300) } : {}) })),
      ...(ACTIVE.has(run.state) && seen?.liveOutput ? { live_output: String(seen.liveOutput).slice(-2000) } : {}),
      timeline,
    };
  }

  /** The models a chat agent may pick for a subagent: Claude Code's catalog, with efforts and windows. */
  async function modelList(workspaceId) {
    const catalog = await catalogFor(workspaceId);
    if (!Array.isArray(catalog?.models)) throw new Error("Claude Code's model list cannot be read right now; try again shortly");
    const list = catalog.models.slice(0, MAX_MODELS_LISTED).map((id) => {
      const capabilities = catalog.capabilities?.[id] ?? {};
      return { id: id.replace(/^cpa\//, ""), ...(Array.isArray(capabilities.efforts) && capabilities.efforts.length ? { efforts: capabilities.efforts } : {}),
        ...(capabilities.contextWindow ? { context_window: { min: capabilities.contextWindow.min, max: capabilities.contextWindow.max } } : {}),
        ...(capabilities.contextLimit ? { context_limit: capabilities.contextLimit } : {}) };
    });
    return { harness: "Claude Code (picked models always run on it)", models: list,
      ...(catalog.models.length > MAX_MODELS_LISTED ? { more: catalog.models.length - MAX_MODELS_LISTED } : {}), ...(catalog.stale ? { stale: true } : {}) };
  }

  /** One subagent tool call from the chat session `parent` (an AO session id) in `workspaceId`. */
  async function call(parent, workspaceId, name, args = {}) {
    if (!parent) return failure("This chat's session is not ready yet; try again in a moment.");
    try {
      switch (name) {
        case "subagent_list": {
          const { settings } = read();
          // An unreadable team list (AO not up yet) leaves the subagents listed.
          const saved = await Promise.resolve().then(() => teams()?.list(workspaceId) ?? []).catch(() => []);
          return textResult({ enabled: settings.enabled, max_running: settings.maxConcurrent, max_per_chat: settings.maxPerChat,
            time_limit_minutes: settings.timeoutMinutes,
            subagents: enabledAgents().map((agent) => ({ id: agent.id, name: agent.name, description: agent.description,
              model: routeOf(agent)?.model ?? null, ready: Boolean(routeOf(agent)) })),
            teams: saved.map((team) => ({ id: team.id, name: team.name, roles: team.roles })),
            pick_a_model: "subagent_start takes model, effort and context_window (subagent_models lists them); a picked model runs on Claude Code" });
        }
        case "subagent_models": return textResult(await modelList(workspaceId));
        case "subagent_start": {
          const run = await start(parent, workspaceId, { agent: args.agent, team: args.team, task: args.task,
            model: args.model, effort: args.effort, context_window: args.context_window });
          if (Number.isSafeInteger(args.wait_seconds) && args.wait_seconds > 0) await waitFor(run, args.wait_seconds);
          return textResult(view(run));
        }
        case "subagent_message": {
          const sent = await message(parent, args.subagent_id, args.message);
          const run = runs.get(sent.subagent_id);
          if (run && Number.isSafeInteger(args.wait_seconds) && args.wait_seconds > 0) {
            await waitFor(run, args.wait_seconds);
            return textResult({ ...sent, ...view(run) });
          }
          return textResult(sent);
        }
        case "subagent_inspect": return textResult(await inspect(parent, args.subagent_id, args.items));
        case "subagent_result": {
          const run = runs.get(String(args.subagent_id ?? ""));
          if (!run || run.parent !== parent) return failure("No such subagent in this chat; subagent_status lists the ones you started.");
          await waitFor(run, Number.isSafeInteger(args.wait_seconds) ? args.wait_seconds : 30);
          return textResult(view(run));
        }
        case "subagent_status":
          return textResult({ subagents: [...runs.values()].filter((run) => run.parent === parent).map((run) => {
            const { report, ...rest } = view(run);
            return { ...rest, ...(report ? { has_report: true } : {}) };
          }) });
        case "subagent_stop":
          return textResult(view(await stop(String(args.subagent_id ?? ""), parent)));
        default: return failure(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return failure(String(error?.message ?? error).slice(0, 500));
    }
  }

  return Object.freeze({
    enabled: () => read().settings.enabled,
    describe,
    call,
    config: () => read(),
    save,
    runs: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((run) => ({ ...view(run), workspace_id: run.workspaceId })),
    stop: (id) => stop(id).then(view),
    stopParent,
    dispose() { if (poller) clearTimer(poller); poller = null; },
  });
}

module.exports = { createSubagents, cleanConfig, SUBAGENT_TOOL_DEFS, SUBAGENT_TOOLS, STARTERS };

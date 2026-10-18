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

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const PERMISSIONS = new Set(["auto", "full"]);
const LIMITS = Object.freeze({ maxConcurrent: [1, 10], maxPerChat: [1, 10], timeoutMinutes: [1, 240] });
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

const SUBAGENT_TOOL_DEFS = Object.freeze([
  { name: "subagent_list", title: "List subagents",
    description: "The subagents the user set up for you (Runtime > Subagents): each one's id, what it is for and its model, plus how many may run at once. Start one with subagent_start.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "subagent_start", title: "Start a subagent",
    description: "Start a subagent on a self-contained task. It works on its own in this project (it cannot see this conversation, so give it everything it needs: goal, files, constraints, what to report) and ends with a report you read with subagent_result. Several can run in parallel; keep working while they do.",
    inputSchema: { type: "object", additionalProperties: false, required: ["agent", "task"], properties: {
      agent: { type: "string", description: "The subagent's id (from subagent_list)" },
      task: { type: "string", description: "The complete task for the subagent" },
      wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, description: "Wait up to this long for its report (default 0: return at once)" },
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
 * and `recommendedAnswer` are the workflow's (agent-orchestrator-workflow.cjs).
 */
function createSubagents({ statePath = null, launchArgs, harness, blockedRequest = () => true, recommendedAnswer = () => ({ action: "decline" }),
  logger = console, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let config = null;
  const runs = new Map(); // AO session id -> run
  const launching = []; // the parent chat of each start AO has not answered yet
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
    subagent_id: run.id, agent: run.agentId, name: run.agentName, state: run.state, task: run.task.slice(0, 200),
    elapsed_seconds: Math.round(((run.endedAt ?? now()) - run.startedAt) / 1000),
    ...(run.report ? { report: run.report } : {}), ...(run.error ? { error: run.error } : {}),
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

  function finish(run, state, fields = {}) {
    if (!ACTIVE.has(run.state)) return;
    Object.assign(run, { state, endedAt: now(), ...fields });
    logger?.info?.("subagents.finished", { agent: run.agentId, state, seconds: Math.round((run.endedAt - run.startedAt) / 1000) });
    if (read().settings.releaseWhenDone) {
      // The session, worktree and conversation stay for inspection; only its agent process goes.
      Promise.resolve().then(() => harness()?.exitAgent?.(run.id)).catch(() => undefined);
    }
  }

  /** Answers the requests a subagent raised, as "Approve for me" would (see the header). */
  async function answer(run, approvals) {
    const service = harness();
    for (const approval of approvals) {
      const id = approval?.approval_id;
      if (!id || answered.has(id)) continue;
      answered.add(id);
      if (answered.size > 2000) answered.delete(answered.values().next().value);
      try {
        if (approval.kind === "question") {
          const reply = recommendedAnswer(approval);
          await service.resolveInput(run.id, id, reply.action, reply.content).catch(() => service.resolveInput(run.id, id, "decline"));
          continue;
        }
        const decisions = Array.isArray(approval.decisions) ? approval.decisions : [];
        const request = [approval.kind, approval.tool, approval.command, approval.path, approval.toolInput].filter(Boolean).join(" · ");
        let decision;
        if (approval.kind === "plan") {
          decision = decisions.find((item) => /acceptEdits/i.test(item.id)) ?? decisions.find((item) => item.kind === "allow_once");
        } else if (blockedRequest(request)) {
          decision = decisions.find((item) => item.kind === "reject_once") ?? decisions.find((item) => item.kind === "reject_always");
          logger?.info?.("subagents.request_denied", { agent: run.agentId, tool: String(approval.tool ?? "").slice(0, 80) });
        } else {
          decision = decisions.find((item) => item.kind === "allow_once");
        }
        if (decision) await service.resolveApproval(run.id, id, decision.id);
      } catch (error) {
        logger?.warn?.("subagents.answer_failed", { agent: run.agentId, message: String(error?.message ?? error).slice(0, 200) });
      }
    }
  }

  async function check(run) {
    const service = harness();
    if (!service) return;
    if (now() - run.startedAt > read().settings.timeoutMinutes * 60_000) {
      await service.interrupt?.(run.id).catch?.(() => undefined);
      finish(run, "timed_out", { error: `Stopped after ${read().settings.timeoutMinutes} minutes (the Subagents page's time limit)` });
      return;
    }
    let observed;
    try { observed = await service.observe(run.id); }
    catch (error) {
      run.misses = (run.misses ?? 0) + 1;
      // A session AO no longer knows (deleted, or its daemon lost it) ends the run; a passing failure is retried.
      if (run.misses >= 5) finish(run, "failed", { error: `The subagent's session cannot be read: ${String(error?.message ?? error).slice(0, 300)}` });
      return;
    }
    run.misses = 0;
    if (Array.isArray(observed?.approvals) && observed.approvals.length) await answer(run, observed.approvals);
    const state = observed?.turnState;
    if (run.state === "starting" && state && state !== "queued") run.state = "running";
    if (!TERMINAL_TURN.has(state)) return;
    const report = String(observed.answer || "").slice(0, MAX_REPORT);
    if (state === "completed") finish(run, "completed", { report: report || "(The subagent finished without a written report.)" });
    else if (state === "interrupted" && run.stopping) finish(run, "stopped", report ? { report } : {});
    else finish(run, "failed", { error: String(observed.error || `The subagent's turn ended (${state})`).slice(0, 1000), ...(report ? { report } : {}) });
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

  /** Starts a subagent for the chat session `parent` (an AO session id) in `workspaceId`. */
  async function start(parent, workspaceId, { agent: wanted, task } = {}) {
    const { settings } = read();
    if (!settings.enabled) throw new Error("Subagents are turned off on the Subagents page");
    const key = text(wanted, 60).toLowerCase();
    const agent = enabledAgents().find((item) => item.id === key || item.name.toLowerCase() === key);
    if (!agent) throw new Error(`No enabled subagent "${wanted}"; subagent_list shows the ones you can start`);
    const route = routeOf(agent);
    if (!route) throw new Error(`"${agent.name}" has no model: the user sets one on the Subagents page (its own, or the default model)`);
    const brief = text(task, MAX_TASK);
    if (!brief) throw new Error("Give the subagent a task");
    // Starts still waiting on AO count too: a chat agent calls tools in parallel, and each start
    // checked the limits before any of them was running, so all of them went ahead.
    const holders = [...active().map((run) => run.parent), ...launching];
    if (holders.length >= settings.maxConcurrent) throw new Error(`${settings.maxConcurrent} subagents are already running (the limit); wait for one with subagent_result`);
    if (holders.filter((holder) => holder === parent).length >= settings.maxPerChat) {
      throw new Error(`This chat already runs ${settings.maxPerChat} subagents (the limit per chat); wait for one with subagent_result`);
    }
    launching.push(parent);
    try { return await launch(parent, workspaceId, agent, route, brief, settings); }
    finally { launching.splice(launching.indexOf(parent), 1); }
  }

  async function launch(parent, workspaceId, agent, route, brief, settings) {
    const permissions = settings.permission === "full"
      ? { permission_profile: ":danger-full-access", approval_policy: "never", approvals_reviewer: "user" }
      : { permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
    // AO honours an explicit permission mode only on Claude Code and Codex; opencode keeps its own.
    const explicit = ["ao:claude-code", "ao:codex"].includes(route.harness_id);
    const args = launchArgs(workspaceId, { ...route, ...(explicit ? permissions : {}) }, `Subagent · ${agent.name}`);
    const prompt = [
      agent.instructions,
      "You are a subagent: the main chat agent gave you the task below. Nobody can answer questions while you work, so when something is ambiguous make a reasonable choice and say so in your report.",
      "End with a concise report for the main agent: what you found or changed (files), commands you ran and their results, and anything left undone.",
      `Task:\n${brief}`,
    ].filter(Boolean).join("\n\n");
    const service = harness();
    if (!service) throw new Error("Agent Orchestrator is not running");
    const id = await service.spawn({ ...args, prompt, plain: true, subagent: true });
    const run = { id, parent, workspaceId, agentId: agent.id, agentName: agent.name, task: brief, startedAt: now(), endedAt: null,
      state: "starting", report: "", error: "" };
    remember(run);
    logger?.info?.("subagents.started", { agent: agent.id, harness: route.harness_id });
    return run;
  }

  async function stop(id, parent = null) {
    const run = runs.get(id);
    if (!run || (parent !== null && run.parent !== parent)) throw new Error("No such subagent");
    if (!ACTIVE.has(run.state)) return run;
    run.stopping = true;
    await harness()?.interrupt?.(run.id)?.catch?.(() => undefined);
    finish(run, "stopped");
    return run;
  }

  /** One subagent tool call from the chat session `parent` (an AO session id) in `workspaceId`. */
  async function call(parent, workspaceId, name, args = {}) {
    if (!parent) return failure("This chat's session is not ready yet; try again in a moment.");
    try {
      switch (name) {
        case "subagent_list": {
          const { settings } = read();
          return textResult({ enabled: settings.enabled, max_running: settings.maxConcurrent, max_per_chat: settings.maxPerChat,
            time_limit_minutes: settings.timeoutMinutes,
            subagents: enabledAgents().map((agent) => ({ id: agent.id, name: agent.name, description: agent.description,
              model: routeOf(agent)?.model ?? null, ready: Boolean(routeOf(agent)) })) });
        }
        case "subagent_start": {
          const run = await start(parent, workspaceId, { agent: args.agent, task: args.task });
          if (Number.isSafeInteger(args.wait_seconds) && args.wait_seconds > 0) await waitFor(run, args.wait_seconds);
          return textResult(view(run));
        }
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
    dispose() { if (poller) clearTimer(poller); poller = null; },
  });
}

module.exports = { createSubagents, cleanConfig, SUBAGENT_TOOL_DEFS, SUBAGENT_TOOLS, STARTERS };

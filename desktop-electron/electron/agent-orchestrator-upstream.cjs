"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createAgentOrchestratorGateway } = require("./agent-orchestrator-gateway.cjs");
const { createAoWorkspaceBoard } = require("./agent-orchestrator-workspace.cjs");
const { readCpaCatalog, collectMissionAccounting } = require("./agent-orchestrator-accounting.cjs");
const { createAoSessionEvents } = require("./ao-session-events.cjs");
const { createAoDependencyLinks } = require("./ao-dependency-links.cjs");

const API_OPERATIONS = Object.freeze({
  upstream_projects: { method: "GET", endpoint: "/api/v1/projects" },
  upstream_sessions: { method: "GET", endpoint: "/api/v1/sessions" },
  upstream_agents: { method: "GET", endpoint: "/api/v1/agents" },
  upstream_orchestrators: { method: "GET", endpoint: "/api/v1/orchestrators" },
  upstream_create_project: { method: "POST", endpoint: "/api/v1/projects" },
  upstream_create_session: { method: "POST", endpoint: "/api/v1/sessions" },
  upstream_create_orchestrator: { method: "POST", endpoint: "/api/v1/orchestrators" },
  upstream_send: { method: "POST", endpoint: "/api/v1/sessions/:id/send" },
});

// Agents without an AO chat controller run in their own terminal UI and report here.
// How often the harness list re-runs AO's install checks, so a newly installed CLI shows up.
const AGENT_RECHECK_MS = 60_000;

// A plain GET lists only the agents whose install check has finished, which right after the
// daemon starts is often just one; the list was then read once and Codex, opencode and others
// stayed "not installed". A refresh waits for fresh checks; re-check at most once a minute.
function createAgentInventory(api, { now = Date.now, recheckMs = AGENT_RECHECK_MS } = {}) {
  let checkedAt = -Infinity;
  return async function agentInventory() {
    if (now() - checkedAt >= recheckMs) {
      try {
        const inventory = await api("POST", "/api/v1/agents/refresh");
        checkedAt = now();
        return inventory;
      } catch { /* an older daemon without refresh still answers the plain list */ }
    }
    return api("GET", "/api/v1/agents");
  };
}

// AO install checks that have not finished: right after AO starts most agents are "not_checked".
const PENDING_INSTALL_CHECKS = new Set(["checking", "not_checked"]);

/**
 * The harness list from AO's inventory. AO lists only agents its latest check proved installed; a
 * check that is unfinished, timed out or failed leaves an agent "unknown", which AO calls advisory,
 * not missing. An unknown agent is offered only with evidence: it was installed last time
 * (`lastInstalled`: id → auth status) or AO found its binary and is confirming it. One whose check
 * hasn't finished is marked `checking` (not offered yet) so the list is read again once it has.
 */
function agentCatalog({ inventory, settings, readiness = null, lastInstalled = new Map() }) {
  const chat = new Set(Array.isArray(settings?.chatHarnesses) ? settings.chatHarnesses : []);
  const installed = new Map((inventory?.installed ?? []).map(item => [item?.id, item]));
  const checks = new Map((Array.isArray(readiness?.agents) ? readiness.agents : []).map(agent => [agent?.id, agent?.installation ?? {}]));
  return (inventory?.supported ?? []).filter(item => typeof item?.id === "string" && /^[a-z0-9-]{1,40}$/.test(item.id)).map(item => {
    const check = checks.get(item.id);
    const unknown = !installed.has(item.id) && check?.state !== "not_installed";
    const offered = installed.has(item.id) || (unknown && (lastInstalled.has(item.id) || check?.reasonCode === "install_identity_pending"));
    return {
      id: item.id, label: String(item.label || item.id).slice(0, 80), installed: offered,
      authStatus: installed.get(item.id)?.authStatus || (offered && lastInstalled.get(item.id)) || "unknown", chat: chat.has(item.id),
      ...(!offered && unknown && check?.state === "unknown" && PENDING_INSTALL_CHECKS.has(check.reasonCode) ? { checking: true } : {}),
    };
  });
}

const TUI_RESULT_FILE = "AO_RESULT.md";
/** How long a terminal agent AO lost the signal of may sit idle before its card is settled as failed. */
const TUI_SILENT_MS = 30 * 60_000;
// AO conversation turn states after which a turn can no longer change.
const TERMINAL_TURN_STATES = new Set(["completed", "failed", "interrupted", "cancelled", "recovered"]);
const TUI_RESULT_INSTRUCTION = `When the assignment is finished, write your complete final report (what you did and the evidence) to ${TUI_RESULT_FILE} at the root of your working directory, then stop and wait.`;

const CLIPBOARD_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write"]);
const TRUSTED_TERMINAL_LINK_HOSTS = new Set(["accounts.google.com", "antigravity.google"]);

function safeOrigin(value) {
  try { return new URL(String(value || "")).origin; } catch { return ""; }
}

async function allocatePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function createAgentOrchestratorUpstream({ resourceRoot, dataRoot, confirm, getWindow, WebContentsView, dialog, shell, openAuth, getWorkspaces, missionCall, getCpaPricesPath = () => null, extraPath = () => null, extraEnv = () => ({}), agentTools = null, logger = console }) {
  let child = null;
  let gateway = null;
  let view = null;
  let attached = false;
  let visibleRequested = false;
  let starting = null;
  let stopping = null;
  let lifecycleGeneration = 0;
  let showGeneration = 0;
  let daemonPort = 0;
  let gatewayOrigin = "";
  let openUrl = "";
  let state = "stopped";
  let error = null;
  let logTail = "";
  let missionSelection = null;
  let originalPath = "/";

  // AO terminals open clicked links with window.open (e.g. agy's Google sign-in URL). The view
  // always denies the new window; Google sign-in stays inside the proxy-routed browser.
  async function openTerminalLink(rawUrl) {
    let url;
    try { url = new URL(String(rawUrl || "")); } catch { return false; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
    // Terminal output is untrusted: only the sign-in hosts agy prints open without asking.
    const trusted = url.protocol === "https:" && TRUSTED_TERMINAL_LINK_HOSTS.has(url.hostname);
    if (!trusted && !(await confirm({ message: "Open this link from the terminal?", detail: url.toString() }))) return false;
    if (trusted) {
      if (typeof openAuth !== "function") throw new Error("Proxy-routed Antigravity sign-in is unavailable");
      await openAuth(url.toString());
    } else await shell.openExternal(url.toString());
    return true;
  }
  // Gives each new worktree the project's installed node_modules (AO hardLinkFarms) and, when
  // the user allows it, its .venv/venv (AO symlinks).
  const dependencyLinks = createAoDependencyLinks({
    file: path.join(dataRoot, "coding-tools-dependency-links.json"),
    request: (method, endpoint, body) => internalApi(method, endpoint, body), logger,
  });
  const workspaceBoard = typeof getWorkspaces === "function" && typeof missionCall === "function"
    ? createAoWorkspaceBoard({
      listWorkspaces: getWorkspaces, missionCall,
      syncProject: (project, folder) => dependencyLinks.sync(project.id, folder),
      readAccounting: async scope => collectMissionAccounting({
        ...scope, catalog: readCpaCatalog(getCpaPricesPath()),
        readSession: async id => {
          const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`);
          if (record?.session?.id !== id || record.session.projectId !== scope.projectId) return record;
          const [normalized, conversation] = await Promise.all([
            internalApi("GET", `/api/v1/usage/sessions/${sessionId(id)}`).catch(() => null),
            internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=1`).catch(() => null),
          ]);
          return { session: record.session, normalized, conversation: { usage: conversation?.usage } };
        },
      }),
      listProjects: async () => {
        await start();
        const result = await requestApi("GET", "/api/v1/projects");
        if (!result.ok || !Array.isArray(result.data.projects)) throw new Error("AO project catalog is unavailable");
        return result.data.projects;
      },
      createProject: async body => {
        const result = await requestApi("POST", "/api/v1/projects", JSON.stringify(body));
        if (!result.ok) throw new Error(result.data.error?.message || "AO project registration failed");
        return result.data.project;
      },
    }) : null;

  async function requestApi(method, endpoint, body) {
    if (state !== "ready") throw new Error("Start the source-integrated AO runtime first");
    if (body?.length > 65536) throw new Error("AO API request exceeds 64 KiB");
    const response = await fetch(`http://127.0.0.1:${daemonPort}${endpoint}`, { method, headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(method === "GET" ? 30000 : 180000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 900000) throw new Error(`AO response exceeds the handler limit (${method} ${endpoint.split("?")[0]})`);
    // AO answers some failures with an empty or non-JSON body; keep the status instead of
    // failing on JSON.parse and losing it.
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = response.ok ? {} : { error: { message: text.slice(0, 300) } }; }
    }
    return { ok: response.ok, status: response.status, data };
  }

  // AO's error envelope is { error: <kind>, code, message }; the message says what was wrong.
  function aoErrorMessage(result) {
    const data = result.data;
    const message = data?.error?.message || data?.message || (typeof data?.error === "string" && data.error)
      || `AO request failed (${result.status})`;
    const code = typeof data?.code === "string" && data.code ? ` (${data.code})` : "";
    return `${message}${code}`.slice(0, 300);
  }
  /**
   * Whether the chat host recorded for an AO session (dataRoot/chat-hosts/<id>/host.json) is
   * gone. A missing or unreadable record is not treated as gone. The recorded loopback address
   * is probed rather than the PID: Windows reuses PIDs, so a dead host's PID can belong to an
   * unrelated process (seen: the restarted AO daemon itself).
   */
  async function chatHostGone(id) {
    let address;
    try { address = JSON.parse(fs.readFileSync(path.join(dataRoot, "chat-hosts", sessionId(id), "host.json"), "utf8")).address; }
    catch { return false; }
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(String(address));
    if (!match) return false;
    return new Promise(resolve => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(match[1]) });
      const settle = gone => { socket.destroy(); resolve(gone); };
      socket.setTimeout(1500, () => settle(false));
      socket.once("connect", () => settle(false));
      socket.once("error", error => settle(error?.code === "ECONNREFUSED"));
    });
  }
  /**
   * The newest items of a session's conversation. AO counts messages and tool activities alike,
   * and a tool's output can be tens of KB (an MCP browser tool's page dumps), so 100 items reached
   * 1 MB and every poll failed on the response limit. A response that is too big is read again
   * with fewer items; the chat shows only the newest 40 anyway.
   */
  async function conversationTail(id, limits = [100, 40, 10]) {
    for (let at = 0; ; at += 1) {
      try {
        return await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=${limits[at]}`);
      } catch (error) {
        if (at === limits.length - 1 || !/exceeds the handler limit/.test(String(error?.message))) throw error;
      }
    }
  }
  /**
   * The current turn as a Codex-style transcript: assistant messages, reasoning and tool calls
   * in AO sequence order. Bounded to the newest 40 items so a long turn stays a small IPC frame;
   * the prompt (user message) is left out because the chat already shows it.
   */
  function turnTimeline(conversation, turnId) {
    if (typeof turnId !== "string") return [];
    const items = [
      ...(Array.isArray(conversation?.messages) ? conversation.messages : [])
        .filter(message => message.turnId === turnId && message.role === "assistant" && typeof message.text === "string" && message.text.trim())
        .map(message => ({ id: String(message.id), sequence: Number(message.sequence) || 0, kind: "message",
          status: message.streaming ? "running" : "completed", text: utf8Prefix(message.text.trim(), 4096) })),
      ...(Array.isArray(conversation?.activities) ? conversation.activities : [])
        .filter(activity => activity.turnId === turnId && typeof activity.activityKind === "string")
        .map(activity => activity.activityKind === "system" && activity.detail?.event === "steer" && typeof activity.detail.text === "string"
          // AO records a steer as a system row tagged event "steer"; it is the user's own words.
          ? { id: String(activity.id), sequence: Number(activity.sequence) || 0, kind: "steer", status: "completed",
            text: utf8Prefix(activity.detail.text.trim(), 4096) }
          : timelineActivity(activity)),
    ];
    return items.sort((a, b) => a.sequence - b.sequence).slice(-40);
  }
  // claude-agent-acp reports every tool call, its own Read/Grep/PowerShell included, as AO's
  // "mcp_tool"; the ACP tool kind says what it did. A real MCP server's tool is named mcp__<server>__.
  const TOOL_LABELS = { read: "Read", search: "Search", edit: "Edit", delete: "Delete", move: "Move", fetch: "Fetch",
    think: "Thought", switch_mode: "Plan", execute: "Command", other: "Tool" };
  function toolLabel(detail, summary) {
    const name = String(detail?.toolName || "");
    if (/^mcp__(?!acp__)/.test(name) || /^mcp__(?!acp__)/.test(summary)) return "MCP";
    return TOOL_LABELS[detail?.toolKind] || "Tool";
  }
  /** How long AO's chat drivers wait for a tool approval before giving up on it (approvalWait). */
  const APPROVAL_WAIT_MS = 30 * 60_000;
  function timelineActivity(activity) {
    const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
    const input = detail.input && typeof detail.input === "object" ? detail.input : {};
    const base = { id: String(activity.id), sequence: Number(activity.sequence) || 0, status: String(activity.status || "").slice(0, 32) };
    const summary = String(activity.summary || "");
    // A shell call (Bash, PowerShell) shows as the command it ran, like Codex.
    if (activity.activityKind === "mcp_tool" && typeof input.command === "string" && input.command.trim()) {
      return { ...base, kind: "command", text: utf8Prefix(input.command.trim(), 400) };
    }
    if (activity.activityKind === "mcp_tool") {
      return { ...base, kind: "tool", label: toolLabel(detail, summary), text: utf8Prefix(summary || detail.toolKind || "tool", 400) };
    }
    // The model's reasoning summary: AO streams it into the activity's text (detail.text); its
    // summary is only the word "Reasoning".
    if (activity.activityKind === "reasoning") {
      return { ...base, kind: "reasoning", text: utf8Prefix(typeof detail.text === "string" ? detail.text.trim() : "", 4096) };
    }
    // A request nobody answered: AO marks it resolved by the provider when its 30-minute wait runs
    // out, or when the turn ends first. The agent then only says it was "blocked by permissions",
    // so the timeline says what really happened.
    if (activity.activityKind === "approval" && activity.status !== "pending" && detail.resolvedBy === "provider") {
      const open = Date.parse(activity.updatedAt ?? "") - Date.parse(activity.createdAt ?? "");
      const timedOut = Number.isFinite(open) && open >= APPROVAL_WAIT_MS - 60_000;
      return { ...base, kind: "approval", label: timedOut ? "Approval timed out" : "Approval cancelled",
        text: utf8Prefix(`${timedOut ? "Nobody answered within 30 minutes, so the agent could not run it" : "The turn ended before this was answered"}${summary ? `: ${summary}` : ""}. Send a follow-up to try again.`, 400) };
    }
    return { ...base, kind: activity.activityKind.slice(0, 32), text: utf8Prefix(summary || activity.activityKind, 400) };
  }
  /**
   * The session's tool requests waiting on an answer (Claude Code's ACP permission requests, parked
   * by AO). Each keeps AO's request id and the provider's own offered decisions, so an answer is
   * always one of those; a Bash call is a "command", other tools a "permission".
   */
  function pendingApprovals(conversation) {
    return (Array.isArray(conversation?.activities) ? conversation.activities : [])
      .filter(activity => activity.activityKind === "approval" && activity.status === "pending" && typeof activity.requestId === "string")
      .map(activity => {
        const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
        const input = detail.input && typeof detail.input === "object" ? detail.input : {};
        const decisions = (Array.isArray(detail.decisions) ? detail.decisions : [])
          .filter(decision => typeof decision?.id === "string" && typeof decision?.kind === "string")
          .map(decision => ({ id: decision.id.slice(0, 200), kind: decision.kind.slice(0, 40), label: String(decision.label || decision.kind).slice(0, 120) }));
        const command = typeof input.command === "string" && input.command.trim() ? input.command : "";
        const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
        // Claude Code's ExitPlanMode asks to leave plan mode with the plan it wrote; each offered
        // decision is a different way to go on (auto, accept edits, ask for edits, keep planning).
        const plan = typeof input.plan === "string" && input.plan.trim() ? utf8Prefix(input.plan, 20000) : "";
        // An MCP tool's arguments (read_file's path, search_text's pattern) are what it will do; the card
        // and the reviewer need them. Shown as JSON, so control characters arrive escaped.
        const toolName = String(detail.toolName || "");
        const toolInput = /^mcp__/.test(toolName) && Object.keys(input).length ? utf8Prefix(JSON.stringify(input), 1500) : "";
        return {
          approval_id: activity.requestId.slice(0, 200), source: "ao", kind: plan ? "plan" : command ? "command" : "permission",
          ...(plan ? { plan } : {}),
          ...(toolInput ? { toolInput } : {}),
          ...(typeof activity.createdAt === "string" ? { since: activity.createdAt } : {}),
          ...(command ? { command: utf8Prefix(command, 4000) } : {}), ...(path ? { path: utf8Prefix(path, 1000) } : {}),
          ...(typeof input.description === "string" ? { reason: utf8Prefix(input.description, 500) } : {}),
          // The tool's own name when AO has it; otherwise its summary ("PowerShell") rather than ACP's "other".
          tool: String(detail.toolName || (detail.toolKind && detail.toolKind !== "other" ? detail.toolKind : activity.summary) || "tool").slice(0, 80),
          summary: utf8Prefix(String(activity.summary || ""), 500), turn_id: typeof activity.turnId === "string" ? activity.turnId : undefined,
          decisions,
        };
      })
      .filter(approval => approval.decisions.length);
  }
  /** A chat start that failed only for time (the persistent host's startup window, a deadline). */
  const TRANSIENT_CHAT_START = /persistent (ACP )?host|timed out|timeout|deadline exceeded|context canceled/i;
  const CHAT_RETRY_PAUSE_MS = 2000;
  /** The longest prefix of `text` that is at most `maxBytes` of UTF-8 (AO limits prompts in bytes). */
  function utf8Prefix(text, maxBytes) {
    const value = String(text);
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    let end = Math.min(value.length, maxBytes);
    while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end = Math.floor(end * 0.95);
    while (end < value.length && Buffer.byteLength(value.slice(0, end + 1), "utf8") <= maxBytes) end += 1;
    // Never end on the first half of a surrogate pair.
    const last = value.charCodeAt(end - 1);
    if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return value.slice(0, end);
  }

  // Mission-owned AO calls. The run grant already covers them, so no extra dialog.
  async function internalApi(method, endpoint, body) {
    await start();
    const result = await requestApi(method, endpoint, body === undefined ? undefined : JSON.stringify(body));
    if (!result.ok) throw new Error(aoErrorMessage(result));
    return result.data;
  }
  const agentId = (value) => {
    if (typeof value !== "string" || !/^[a-z0-9-]{1,40}$/.test(value)) throw new Error("Choose a valid AO harness");
    return value;
  };
  const sessionId = (value) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("A valid AO session ID is required");
    return value;
  };
  async function projectFor(workspaceId) {
    if (!workspaceBoard) throw new Error("Coding Tools mission service is unavailable");
    const binding = await workspaceBoard.bind(workspaceId);
    if (!binding.projectId) throw new Error("AO harness workers need this workspace to be a git repository registered in AO");
    return binding.projectId;
  }
  /**
   * The app's own tools for one chat session about to be spawned (its own credential, rooted at
   * the worktree AO creates for it), or null. Never fails a launch: without them the agent starts
   * without them.
   */
  async function chatTools(agent, workspaceId, approvalMode) {
    if (!agentTools) return null;
    try {
      // The session's permission mode goes with its credential: only a session launched to
      // bypass permissions runs terminal commands without the user confirming each one.
      const lease = await agentTools.lease({ agent, workspaceId, ...(approvalMode ? { approvalMode } : {}) });
      return Array.isArray(lease?.servers) && lease.servers.length ? lease : null;
    } catch (cause) {
      logger.warn?.("ao.agent_tools_unavailable", { agent, message: String(cause?.message || cause).slice(0, 200) });
      return null;
    }
  }
  const agentInventory = createAgentInventory(internalApi);
  // Agents the last catalog listed as installed, with their auth status.
  let lastInstalled = new Map();
  // Watching never starts AO; it connects (with backoff) once the runtime is ready.
  const sessionEvents = createAoSessionEvents({ port: async () => { if (state !== "ready") throw new Error("AO is not running"); return daemonPort; }, logger });
  const harness = Object.freeze({
    /** Live AO session changes ({ sessionId, type, conversation }) pushed by the daemon; returns unsubscribe. */
    watch(listener) { return sessionEvents.subscribe(listener); },
    async catalog() {
      const [inventory, settings] = await Promise.all([agentInventory(), internalApi("GET", "/api/v1/settings")]);
      const proven = new Set((inventory?.installed ?? []).map(item => item?.id));
      // AO's readiness (its cached snapshots; no new checks) tells an unproven agent from a missing one.
      const readiness = (inventory?.supported ?? []).some(item => !proven.has(item?.id))
        ? await internalApi("GET", "/api/v1/agents/readiness").catch(() => null) : null;
      const catalog = agentCatalog({ inventory, settings, readiness, lastInstalled });
      lastInstalled = new Map(catalog.filter(item => item.installed).map(item => [item.id, item.authStatus]));
      return catalog;
    },
    async models(agent, workspaceId) {
      const projectId = workspaceId ? await projectFor(workspaceId).catch(() => "") : "";
      const catalog = await internalApi("GET", `/api/v1/agents/${agentId(agent)}/models${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
      return (Array.isArray(catalog?.models) ? catalog.models : []).filter(model => typeof model?.id === "string" && model.id.length <= 128)
        .slice(0, 100).map(model => ({ id: model.id, label: String(model.label || model.id).slice(0, 128), isDefault: model.isDefault === true,
          efforts: Array.isArray(model.efforts) ? model.efforts.filter(value => typeof value === "string" && value.length <= 32).slice(0, 16) : [] }));
    },
    async spawn({ workspaceId, agent, model, prompt, name, gateway = null, effort = null, contextWindow = null, approvalMode = null, plain = false, warm = false }) {
      if (approvalMode !== null && !["default", "accept-edits", "auto", "bypass-permissions"].includes(approvalMode)) throw new Error("Unsupported AO permission mode");
      const projectId = await projectFor(workspaceId);
      const settings = await internalApi("GET", "/api/v1/settings");
      // Chat-capable agents return their answer as a conversation turn. Every other
      // installed agent runs in its own terminal UI and hands back a result file.
      const chat = Array.isArray(settings?.chatHarnesses) && settings.chatHarnesses.includes(agentId(agent));
      // A pre-warmed session must be a chat: it takes its first message later, which a terminal session cannot.
      if (warm && !chat) throw new Error("Only a chat agent can be pre-warmed");
      const codexWorkspace = agent === "codex" && ["accept-edits", "auto"].includes(approvalMode);
      if (codexWorkspace && !chat) throw new Error("Codex workspace permissions require its capable chat driver; TUI sandbox settings cannot be verified.");
      // AO caps prompts at 16 KiB of UTF-8; leave room for the TUI result instruction.
      const brief = utf8Prefix(prompt, 16384 - Buffer.byteLength(TUI_RESULT_INSTRUCTION, "utf8") - 2);
      const launch = async (mode) => {
        // Chat sessions only: a terminal launch has no controller to attach tool servers to. Each
        // attempt gets its own credential, bound to the session it creates and to nothing else.
        const tools = mode === "chat" ? await chatTools(agent, workspaceId, approvalMode) : null;
        let created;
        try {
          created = await launchSession(mode, tools?.servers ?? []);
        } catch (error) {
          tools?.release();
          throw error;
        }
        if (tools && !tools.bind(created?.session?.id)) tools.release();
        return created;
      };
      const launchSession = (mode, mcpServers) => internalApi("POST", "/api/v1/sessions", {
        projectId, kind: "worker", harness: agentId(agent), mode,
        ...(approvalMode ? { approvalMode } : {}),
        ...(brief ? { prompt: mode === "chat" ? brief : `${brief}\n\n${TUI_RESULT_INSTRUCTION}` } : {}),
        ...(model && model !== "default" ? { model: String(model).slice(0, 256) } : {}),
        ...(effort && !gateway ? { effort: String(effort).slice(0, 32) } : {}),
        ...(contextWindow != null ? { contextWindow } : {}),
        // A single-model chat is a plain assistant: AO adds none of its worker/orchestrator prompt.
        ...(plain ? { plainPrompt: true } : {}),
        // A CPA model runs through the local gateway; AO adds the key from its own environment.
        ...(gateway?.provider === "cpa" && typeof gateway.model === "string" ? { gateway: { provider: "cpa", model: gateway.model.slice(0, 256) } } : {}),
        ...(mcpServers.length ? { mcpServers } : {}),
        displayName: String(name || "AO worker").slice(0, 100),
      });
      let data;
      try {
        data = await launch(chat ? "chat" : "tui");
      } catch (error) {
        // Chat mode needs AO's packaged ACP runtime (Claude's chat driver). Without it the agent
        // still runs in its own terminal and hands back a result file.
        if (!chat || codexWorkspace || !/CHAT_DRIVER_UNAVAILABLE/.test(String(error?.message))) throw error;
        if (warm) throw error;
        if (TRANSIENT_CHAT_START.test(String(error?.message))) {
          // A chat host that was merely slow to start (a busy machine) is retried as chat: a terminal
          // session cannot show progress, take approvals or be steered. A second failure is reported.
          await new Promise((resolve) => setTimeout(resolve, CHAT_RETRY_PAUSE_MS));
          data = await launch("chat");
        } else data = await launch("tui");
      }
      return sessionId(data?.session?.id);
    },
    async observe(id, expectedTurn) {
      const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`);
      if (record?.session?.mode === "tui") return observeTui(id, record.session.status, record.session.activity);
      const [session, conversation] = [record, await conversationTail(id)];
      const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
      // A follow-up sent into a live session is pinned to its own turn: until AO shows it, the
      // previous, completed turn must not be read as this card's answer.
      const turn = typeof expectedTurn === "string" && expectedTurn ? turns.find(entry => entry.id === expectedTurn) : turns[turns.length - 1];
      if (typeof expectedTurn === "string" && expectedTurn && !turn) {
        return { status: session?.session?.status, turnId: expectedTurn, turnState: "queued", needsInput: false, exited: false,
          answer: "", liveOutput: "", timeline: [], approvals: [] };
      }
      const answer = (Array.isArray(conversation?.messages) ? conversation.messages : [])
        .filter(message => message.role === "assistant" && message.turnId === turn?.id && !message.streaming)
        .map(message => message.text).join("\n\n").trim();
      // Streaming is display-only evidence for this owned session's current turn.
      const liveOutput = (Array.isArray(conversation?.messages) && typeof turn?.id === "string" ? conversation.messages : [])
        .filter(message => message.role === "assistant" && message.turnId === turn.id && typeof message.text === "string")
        .map(message => message.text).join("\n\n").trim();
      const status = session?.session?.status;
      const timeline = turnTimeline(conversation, turn?.id);
      // A chat turn whose host process is gone (e.g. killed with the app during an update) stays
      // "running" in AO forever. Settle it through AO's own interrupt path so the card can retry.
      // The reason is reported again for a turn already settled that way (a display-only read may
      // have sent the interrupt), so the card's saved failure says why; a turn the user stopped
      // keeps its live host and stays a plain interruption.
      const settling = turn && !TERMINAL_TURN_STATES.has(turn.state);
      const settled = turn?.state === "interrupted" && !turn.errorMessage;
      if ((settling || settled) && await chatHostGone(id)) {
        if (settling) await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/interrupt`, {}).catch(() => undefined);
        return {
          status, turnId: turn.id, turnState: "interrupted",
          error: "The agent's process ended before it finished (the app restarted); retry this card.",
          needsInput: false, exited: false, answer: "", liveOutput: utf8Prefix(liveOutput, 4096), timeline,
        };
      }
      return {
        status, turnId: turn?.id, turnState: turn?.state, error: turn?.errorMessage,
        needsInput: status === "needs_input", exited: ["exited", "terminated"].includes(status),
        answer: answer.slice(0, 12000), liveOutput: utf8Prefix(liveOutput, 4096), timeline,
        approvals: pendingApprovals(conversation),
      };
    },
    /**
     * Whether a chat session can take another turn: it exists, runs as a chat, and its host is up.
     * A follow-up then continues it instead of starting a new session and worktree.
     */
    async continuable(id) {
      const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`).catch(() => null);
      const status = record?.session?.status;
      if (!record?.session || record.session.mode === "tui" || record.session.isTerminated || ["terminated", "killed", "errored"].includes(status)) return false;
      if (status === "exited") {
        // An agent released while idle (exitAgent) keeps its session, worktree and conversation:
        // bring it back (a few seconds) rather than start over and replay the whole chat.
        const resumed = await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/resume-agent`, {}).catch(() => null);
        if (resumed?.ok !== true) return false;
      }
      return !(await chatHostGone(id));
    },
    /**
     * Stops a session's agent (its chat host and model process) but keeps the session, worktree and
     * provider conversation; continuable() resumes it on the next message.
     */
    async exitAgent(id) {
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/exit-agent`, {});
      return { ok: true };
    },
    /**
     * Chat sessions whose agent is up but idle, with their last turn finished at least `idleMs`
     * ago. Sessions that never ran a turn (pre-warmed ones) and terminal sessions are left out.
     */
    async idleChatSessions(idleMs, now = Date.now()) {
      const list = await internalApi("GET", "/api/v1/sessions");
      const sessions = [...(Array.isArray(list?.sessions) ? list.sessions : []), ...(Array.isArray(list?.items) ? list.items : [])];
      const candidates = sessions.filter(session => session?.mode === "chat" && session.status === "idle" && !session.isTerminated);
      const idle = await Promise.all(candidates.map(async session => {
        const conversation = await internalApi("GET", `/api/v1/sessions/${sessionId(session.id)}/conversation?limit=1`).catch(() => null);
        const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
        const last = turns[turns.length - 1];
        if (!last || !TERMINAL_TURN_STATES.has(last.state)) return null;
        // The newest sign of use; the session's activity time restarts with its host and says nothing.
        const used = Math.max(...[last.completedAt, last.startedAt, last.requestedAt, session.lastUserMessageAt]
          .map(stamp => Date.parse(stamp ?? "")).filter(Number.isFinite));
        return Number.isFinite(used) && now - used >= idleMs ? String(session.id) : null;
      }));
      return idle.filter(Boolean);
    },
    /** Sends a follow-up as a new turn of the same session; AO de-duplicates by client message id. */
    async send(id, text, clientMessageId) {
      const data = await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/messages`,
        { text: utf8Prefix(String(text), 64 * 1024), ...(clientMessageId ? { clientMessageId: String(clientMessageId).slice(0, 200) } : {}) });
      if (typeof data?.turnId !== "string" || !data.turnId) throw new Error("AO did not start a turn for the follow-up");
      return { turnId: data.turnId, state: data.state };
    },
    /**
     * Hands guidance to the running turn at once (ACP steering). If the turn already ended, AO
     * returns the text instead of starting a detached turn, and this reports `steered: false`.
     */
    async steer(id, text, clientMessageId) {
      try {
        const data = await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/steer`,
          { text: utf8Prefix(String(text), 64 * 1024), ...(clientMessageId ? { clientMessageId: String(clientMessageId).slice(0, 200) } : {}) });
        return { steered: true, turnId: data?.providerTurnId ?? null };
      } catch (error) {
        // AO answers CHAT_NO_ACTIVE_TURN when the turn ended before the guidance arrived.
        if (/CHAT_NO_ACTIVE_TURN|no turn in flight|no active turn/i.test(String(error?.message))) return { steered: false };
        throw error;
      }
    },
    /** Ends a session and its agent (a pre-warmed one nobody used). */
    async kill(id) {
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/kill`, {});
      agentTools?.forgetSession?.(id);
      return { ok: true };
    },
    /**
     * Where a chat session's app tools may act: its own worktree once AO has made it, `ready:
     * false` before that, `ended` once the session is gone. Never starts AO; the path stays in
     * the main process.
     */
    async sessionWorkspace(id) {
      const record = await requestApi("GET", `/api/v1/sessions/${sessionId(id)}`);
      if (record.status === 404) return { ended: true };
      if (!record.ok) throw new Error(aoErrorMessage(record));
      const session = record.data?.session;
      if (session?.id !== id) throw new Error("AO returned another session");
      if (session.isTerminated === true || ["terminated", "killed"].includes(session.status) || session.provisionState === "failed") return { ended: true };
      const location = await requestApi("GET", `/api/v1/desktop/sessions/${sessionId(id)}/workspace`);
      if (location.status === 404) return { ready: false };
      if (!location.ok) throw new Error(aoErrorMessage(location));
      const root = location.data?.workspacePath;
      return typeof root === "string" && path.isAbsolute(root) ? { root } : { ready: false };
    },
    /**
     * Live sessions with this display name that never ran a turn: pre-warmed ones nobody used,
     * e.g. left from an earlier run. One that took a chat keeps the name but has turns.
     */
    async warmSessions(name) {
      const list = await internalApi("GET", "/api/v1/sessions");
      const sessions = [...(Array.isArray(list?.sessions) ? list.sessions : []), ...(Array.isArray(list?.items) ? list.items : [])];
      const candidates = sessions.filter(session => session?.displayName === name && !session.isTerminated && session.status !== "working");
      const unused = await Promise.all(candidates.map(async session => {
        const conversation = await internalApi("GET", `/api/v1/sessions/${sessionId(session.id)}/conversation?limit=1`).catch(() => null);
        return conversation && Array.isArray(conversation.turns) && conversation.turns.length === 0 ? String(session.id) : null;
      }));
      return unused.filter(Boolean);
    },
    /** Answers one parked tool request with one of the decisions AO offered for it. */
    async resolveApproval(id, requestId, decisionId) {
      if (typeof requestId !== "string" || !requestId || typeof decisionId !== "string" || !decisionId) throw new Error("Choose an offered decision");
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/approvals/${encodeURIComponent(requestId)}/resolve`, { decisionId });
      return { ok: true };
    },
    async interrupt(id) {
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/interrupt`, {}).catch(() => undefined);
    },
    // A standalone AO terminal running one program (e.g. the Antigravity CLI) with
    // proxy-only environment additions; AO rejects any other variable.
    async openTerminal({ executable, env = {}, workspaceId }) {
      if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("Terminal program must be an absolute path");
      const projectId = workspaceId ? await projectFor(workspaceId).catch(() => "") : "";
      const data = await internalApi("POST", "/api/v1/shell-terminals", {
        shell: executable, env, ...(projectId ? { projectId } : {}),
      });
      const terminal = data?.shellTerminal;
      if (typeof terminal?.handleId !== "string" || !/^[\w:.-]{1,200}$/.test(terminal.handleId)) throw new Error("AO did not open the terminal");
      return { handle: terminal.handleId, generation: String(terminal.createdAt || terminal.handleId), workingDir: terminal.workingDir };
    },
    async closeTerminal(handle) {
      if (typeof handle !== "string" || !/^[\w:.-]{1,200}$/.test(handle)) throw new Error("A valid terminal handle is required");
      await internalApi("DELETE", `/api/v1/shell-terminals/${encodeURIComponent(handle)}`);
    },
  });

  async function observeTui(id, status, activity = null, now = Date.now()) {
    const waiting = ["idle", "needs_input"].includes(status);
    // AO lost the terminal's signal (e.g. its pty host restarted with the app) and the agent has
    // sat idle since: it will not write a report, and its card would read "working" forever.
    const lostSince = Date.parse(activity?.lastActivityAt ?? "");
    const silent = status === "no_signal" && activity?.state === "idle" && Number.isFinite(lostSince) && now - lostSince >= TUI_SILENT_MS;
    const ended = ["exited", "terminated"].includes(status) || silent;
    if (!waiting && !ended) return { status, needsInput: false, exited: false, answer: "" };
    let answer = "";
    try {
      const file = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/workspace/file?path=${encodeURIComponent(TUI_RESULT_FILE)}`);
      if (!file?.deleted && !file?.binary) answer = String(file?.content || "").trim().slice(0, 12000);
    } catch { /* The agent has not written its report yet. */ }
    if (answer) return { status, turnId: `tui-${id}`, turnState: "completed", answer, needsInput: false, exited: ended };
    if (silent) {
      return { status, turnId: `tui-${id}`, turnState: "failed", answer: "", exited: true,
        error: `The terminal agent stopped reporting and has been idle since ${new Date(lostSince).toISOString()} without ${TUI_RESULT_FILE}; send a follow-up to continue in a new session` };
    }
    if (ended) return { status, turnId: `tui-${id}`, turnState: "failed", error: `AO session ended without ${TUI_RESULT_FILE}`, answer: "", exited: true };
    // Idle without a report: the agent is waiting for the user in its terminal.
    return { status, needsInput: true, exited: false, answer: "" };
  }

  function snapshot() {
    return { ok: state !== "error", state, pid: child?.pid ?? null, port: daemonPort || null, localOnly: true, source: "module/agent-orchestrator", error, missionSelection };
  }

  function hide() {
    const parent = getWindow();
    const restoreFocus = attached && view?.webContents.isFocused?.() && parent?.isFocused?.();
    visibleRequested = false;
    showGeneration += 1;
    view?.setVisible(false);
    if (view && attached) { getWindow()?.contentView.removeChildView(view); attached = false; }
    if (restoreFocus && !parent.isDestroyed()) parent.webContents.focus();
    return { ok: true };
  }

  async function cleanup() {
    view?.setVisible(false);
    if (view && attached) getWindow()?.contentView.removeChildView(view);
    attached = false;
    view?.webContents.close(); view = null;
    const closingGateway = gateway;
    gateway = null; gatewayOrigin = ""; openUrl = "";
    await closingGateway?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const stoppingChild = child;
      try { await fetch(`http://127.0.0.1:${daemonPort}/shutdown`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000) }); } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(() => { stoppingChild.kill(); resolve(); }, 5000);
        stoppingChild.once("exit", () => { clearTimeout(timer); resolve(); });
        if (stoppingChild.exitCode !== null || stoppingChild.signalCode !== null) { clearTimeout(timer); resolve(); }
      });
    }
    child = null; daemonPort = 0;
  }

  async function stop() {
    if (stopping) return stopping;
    lifecycleGeneration += 1;
    hide();
    state = "stopping";
    stopping = (async () => {
      try {
        // Startup owns its pending resources until it observes cancellation.
        await starting?.catch(() => {});
        await cleanup();
        state = "stopped"; error = null;
        return snapshot();
      } finally { stopping = null; }
    })();
    return stopping;
  }

  async function desktopRequest(operation, args) {
    if (operation === "mission_board") {
      if (!workspaceBoard) throw new Error("Coding Tools mission service is unavailable");
      return workspaceBoard.readWorkspace(args.workspaceId, args.runId);
    }
    if (operation === "mission_action") {
      if (!workspaceBoard || !["archive","delete","restore","cancel_schedule"].includes(args.action)) throw new Error("Invalid mission action");
      const board = await workspaceBoard.readWorkspace(args.workspaceId,args.runId);
      const mission = board.runs.find(run=>run.id===args.runId && run.workspace_id===board.workspaceId);
      if (!mission) throw new Error("Mission is outside this workspace");
      const parent=getWindow();
      if (parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()) parent.webContents.focus();
      return missionCall(args.action==="cancel_schedule" ? args.action : `${args.action}_task`,
        {workspaceId:board.workspaceId,taskId:mission.project_id});
    }
    if (operation === "mission_open") {
      if (!workspaceBoard || !["open", "chat", "start", "resume", "restart", "schedule"].includes(args.intent)) throw new Error("Invalid mission navigation request");
      const board = await workspaceBoard.readWorkspace(args.workspaceId, args.runId);
      if (!board.runs.some(run => run.id === args.runId)) throw new Error("Mission is outside this workspace");
      // The board owns keyboard focus; return it before the main controller requests consent.
      const parent = getWindow();
      if (args.intent !== "open" && attached && view && !view.webContents.isDestroyed()
        && view.webContents.isFocused() && parent && !parent.isDestroyed()
        && parent.isVisible() && !parent.isMinimized() && parent.isFocused()) {
        parent.webContents.focus();
      }
      missionSelection = { id: crypto.randomUUID(), workspaceId: board.workspaceId, runId: args.runId, intent: args.intent };
      return { ok: true };
    }
    if (operation === "version") return "0.13.0 (Coding Tools source integration)";
    if (operation === "choose_directory") {
      const selected = await dialog.showOpenDialog(getWindow(), { title: "Add an Agent Orchestrator project", properties: ["openDirectory"] });
      return selected.canceled ? null : selected.filePaths[0];
    }
    if (operation === "check_repository" || operation === "repository_branch") {
      if (typeof args.directory !== "string" || !path.isAbsolute(args.directory)) throw new Error("An absolute local project directory is required");
      const result = spawnSync("git", ["-C", args.directory, "rev-parse", operation === "check_repository" ? "--is-inside-work-tree" : "--abbrev-ref", ...(operation === "repository_branch" ? ["HEAD"] : [])], { encoding: "utf8", timeout: 5000, windowsHide: true });
      return operation === "check_repository" ? result.status === 0 && result.stdout.trim() === "true" : result.status === 0 ? result.stdout.trim() : null;
    }
    if (operation === "open_external") {
      const url = new URL(args.url);
      if (url.protocol !== "https:" || !["github.com", "docs.aoagents.dev"].includes(url.hostname) || url.username || url.password) throw new Error("External destination is not allowed");
      if (await confirm({ message: "Open this external page?", detail: url.toString() })) await shell.openExternal(url.toString());
      return null;
    }
    throw new Error("This desktop operation is unavailable; manage runtime lifecycle from the Coding Tools host bar");
  }

  async function start() {
    if (stopping) await stopping;
    if (state === "ready") return snapshot();
    if (starting) return starting;
    const startupGeneration = ++lifecycleGeneration;
    function checkStartup() {
      if (startupGeneration !== lifecycleGeneration) throw new Error("AO startup was cancelled");
      if (state === "error") throw new Error(error);
    }
    starting = (async () => {
      try {
        state = "starting"; error = null;
        if (child || gateway || view) {
          await cleanup();
          checkStartup();
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(resourceRoot, "manifest.json"), "utf8"));
        if (manifest.localOnly !== true || manifest.standaloneInstall !== false) throw new Error("AO local-only source bundle is required");
        const executable = path.join(resourceRoot, process.platform === "win32" ? "ao-daemon.exe" : "ao-daemon");
        const digest = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
        if (digest !== manifest.daemonSha256) throw new Error("AO daemon does not match its build manifest");
        fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
        const allocatedPort = await allocatePort();
        checkStartup();
        daemonPort = allocatedPort;
        gateway = createAgentOrchestratorGateway({ rendererRoot: path.join(resourceRoot, "renderer"), daemonPort, getStatus: snapshot, desktopRequest });
        const endpoint = await gateway.listen();
        checkStartup();
        gatewayOrigin = endpoint.origin; openUrl = endpoint.openUrl;
        const environment = { ...process.env };
        for (const key of Object.keys(environment)) if (key.startsWith("AO_")) delete environment[key];
        // Coding Tools-managed CLIs (e.g. agy) are found by AO's harness probes without a global install.
        // Tool-scoped values (e.g. the agy proxy) live only in the daemon's memory.
        Object.assign(environment, extraEnv());
        const toolBin = extraPath();
        if (toolBin) {
          const pathKey = Object.keys(environment).find(key => key.toUpperCase() === "PATH") || "PATH";
          environment[pathKey] = [toolBin, environment[pathKey]].filter(Boolean).join(path.delimiter);
        }
          // The AO CLI build answers the daemon command and the internal commands the daemon
          // relaunches itself with (pty-host, chat-host, agent-process); a daemon-only build cannot.
          child = spawn(executable, ["daemon"], {
          cwd: resourceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...environment, AO_PORT: String(daemonPort), AO_DATA_DIR: dataRoot, AO_RUN_FILE: path.join(dataRoot, "running.json"), AO_ALLOWED_ORIGINS: gatewayOrigin, AO_TELEMETRY_EVENTS: "off", AO_TELEMETRY_METRICS: "off", AO_TELEMETRY_REMOTE: "off", AO_SENTRY_DSN: "" },
        });
        const currentChild = child;
        logTail = "";
        for (const output of [child.stdout, child.stderr]) output.on("data", (chunk) => { logTail = (logTail + chunk.toString()).slice(-16384); });
        child.once("error", (cause) => { if (child === currentChild && startupGeneration === lifecycleGeneration) { error = cause.message; state = "error"; } });
        child.once("exit", (code) => { if (child === currentChild && startupGeneration === lifecycleGeneration) { state = "error"; error = `AO exited (${code})`; } });
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          checkStartup();
          try {
            const response = await fetch(`http://127.0.0.1:${daemonPort}/readyz`, { redirect: "error", signal: AbortSignal.timeout(1000) });
            checkStartup();
            const ready = await response.json();
            checkStartup();
            if (response.ok && ready.pid === currentChild.pid && ready.status === "ready") { state = "ready"; return snapshot(); }
          } catch { checkStartup(); }
          await new Promise((resolve) => setTimeout(resolve, 200));
          checkStartup();
        }
        throw new Error(`AO readiness timed out. ${logTail.slice(-1500)}`);
      } catch (cause) {
        // Do not call stop here: stop waits for this startup to settle.
        await cleanup();
        if (startupGeneration === lifecycleGeneration) {
          state = "error"; error = cause.message;
          logger.warn?.("ao.start_failed", { message: error });
        }
        throw cause;
      } finally { starting = null; }
    })();
    return starting;
  }

  function setBounds(bounds) {
    if (!view || !getWindow()) return { ok: true };
    const parent = getWindow().getContentBounds();
    const next = {};
    for (const field of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(bounds?.[field])) throw new Error("Invalid AO panel bounds");
      next[field] = Math.max(0, Math.round(bounds[field]));
    }
    next.x = Math.min(next.x, parent.width); next.y = Math.min(next.y, parent.height);
    next.width = Math.min(next.width, parent.width - next.x); next.height = Math.min(next.height, parent.height - next.y);
    view.setBounds(next);
    return { ok: true };
  }

  async function show(bounds, projectBoard = false, workspaceId, terminal = null) {
    const showRequest = ++showGeneration;
    visibleRequested = true;
    await start();
    const binding = projectBoard && workspaceId && workspaceBoard ? await workspaceBoard.bind(workspaceId) : null;
    if (showRequest !== showGeneration || !visibleRequested || state !== "ready") return snapshot();
    const parent = getWindow();
    if (!parent || parent.isDestroyed()) throw new Error("Coding Tools window is unavailable");
    const needsLoad = !view;
    if (needsLoad) {
      view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: `ao-local-${crypto.randomUUID()}` } });
      view.webContents.setWindowOpenHandler(({ url }) => {
        void openTerminalLink(url).catch((cause) => logger.warn?.("ao.link_open_failed", { message: String(cause?.message || cause) }));
        return { action: "deny" };
      });
      // Without AO's own preload, its terminal copies and pastes through navigator.clipboard, so
      // the gateway page (and nothing else) may use the clipboard; every other permission stays denied.
      const clipboardAllowed = (permission, origin) => CLIPBOARD_PERMISSIONS.has(permission) && Boolean(gatewayOrigin) && origin === gatewayOrigin;
      view.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
        callback(clipboardAllowed(permission, safeOrigin(details?.requestingUrl)));
      });
      view.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => clipboardAllowed(permission, safeOrigin(requestingOrigin)));
      view.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== gatewayOrigin) event.preventDefault(); });
      view.webContents.on("console-message", (_event, _level, message) => logger.warn?.("ao.renderer", { message: String(message).slice(0, 1000) }));
      // Clicking this child view does not reliably move keyboard focus into it on Windows, so
      // typing would still go to the main window. Focus it on mouse-down so AO terminals (agy)
      // and inputs receive keys.
      const created = view;
      created.webContents.on("before-mouse-event", (_event, mouse) => {
        if (mouse.type === "mouseDown" && !created.webContents.isDestroyed() && !created.webContents.isFocused()) {
          created.webContents.focus();
        }
      });
    }
    const showingView = view;
    const viewGeneration = lifecycleGeneration;
    if (!attached) { parent.contentView.addChildView(view); attached = true; }
    setBounds(bounds);
    view.setVisible(true);
    if (needsLoad) {
      try { await showingView.webContents.loadURL(openUrl); }
      catch (cause) {
        if (showRequest === showGeneration && viewGeneration === lifecycleGeneration && view === showingView) throw cause;
      }
    }
    const navigate = async (destination) => {
      const target = new URL(destination, gatewayOrigin);
      const current = new URL(showingView.webContents.getURL());
      if (current.origin === target.origin && current.pathname === target.pathname && current.search === target.search) {
        await showingView.webContents.executeJavaScript(`location.hash = ${JSON.stringify(target.hash)}`);
      } else { await showingView.webContents.loadURL(target.toString()); }
    };
    if (terminal && showRequest === showGeneration && viewGeneration === lifecycleGeneration && view === showingView) {
      const handle = String(terminal.handle || "");
      if (!/^[\w:.-]{1,200}$/.test(handle)) throw new Error("A valid terminal handle is required");
      const query = new URLSearchParams({ handle, generation: String(terminal.generation || handle).slice(0, 200), title: String(terminal.title || "Terminal").slice(0, 80) });
      const current = new URL(showingView.webContents.getURL());
      if (!current.hash.startsWith("#/coding-tools-terminal") && !current.hash.startsWith("#/coding-tools-board")) originalPath = current.pathname + current.search + current.hash;
      const target = `/#/coding-tools-terminal?${query}`;
      if (current.pathname + current.search + current.hash !== target) await navigate(target);
      // A freshly opened terminal is ready to type into, like a terminal window.
      if (parent.isFocused() && !showingView.webContents.isDestroyed()) showingView.webContents.focus();
    } else if (projectBoard && showRequest === showGeneration && viewGeneration === lifecycleGeneration && view === showingView) {
      const current = new URL(showingView.webContents.getURL());
      const route = current.hash.startsWith("#/") ? new URL(current.hash.slice(1), gatewayOrigin) : current;
      if (route.pathname !== "/coding-tools-board") originalPath = current.pathname + current.search + current.hash;
      const project = route.pathname.match(/^\/projects\/([a-zA-Z0-9_-]+)(?:\/|$)/);
      const boardPath = binding
        ? `/#/coding-tools-board?workspaceId=${encodeURIComponent(binding.workspaceId)}`
        : project ? `/#/projects/${project[1]}` : "/#/sessions/";
      if (current.pathname + current.search + current.hash !== boardPath) await navigate(boardPath);
    } else if (!projectBoard && showRequest === showGeneration && view === showingView
      && /^#\/coding-tools-(board|terminal)/.test(new URL(showingView.webContents.getURL()).hash)) {
      await navigate(originalPath);
    }
    // Bounds and visibility belong to the request before loadURL, never its completion.
    return snapshot();
  }

  async function call(operation, args = {}) {
    if (operation === "upstream_status") return snapshot();
    if (operation === "upstream_start") return start();
    if (operation === "upstream_stop") {
      if (!await confirm({ message: "Stop Agent Orchestrator?", detail: "Active upstream sessions may be interrupted. Coding Tools missions remain saved." })) return { ok: true, cancelled: true };
      return stop();
    }
    if (operation === "upstream_bind_workspace") {
      if (!workspaceBoard) throw new Error("Coding Tools mission service is unavailable");
      return { ok: true, ...await workspaceBoard.bind(args.workspaceId) };
    }
    // "Reuse installed Node packages" (`enabled`, default on) and "Share the Python environment"
    // (`python`, default off).
    if (operation === "upstream_dependency_links") return { ok: true, ...dependencyLinks.settings() };
    if (operation === "upstream_set_dependency_links") {
      const given = ["enabled", "python"].filter(name => args[name] !== undefined);
      if (!given.length || given.some(name => typeof args[name] !== "boolean")) throw new Error("enabled or python must be true or false");
      return { ok: true, ...dependencyLinks.set({ enabled: args.enabled, python: args.python }) };
    }
    // The folders new worktrees of this workspace's AO project share with it or get as hard-link
    // farms, for the approval card. Read-only: it neither registers a project nor starts AO.
    if (operation === "dependency_link_info") {
      if (!workspaceBoard) throw new Error("Coding Tools mission service is unavailable");
      // With AO stopped no session runs, so nothing is in effect.
      if (state !== "ready") return { ok: true, shared: [], farmed: [] };
      const { projectId } = await workspaceBoard.project(args.workspaceId);
      if (!projectId) return { ok: true, shared: [], farmed: [] };
      return { ok: true, ...await dependencyLinks.inEffect(projectId) };
    }
    // A chat's Terminal and Preview panes: the user's view of each card's agent session, through
    // the agent tools server that started its commands and owns its preview (chat-agent-tools.cjs).
    if (operation.startsWith("chat_process") || operation.startsWith("chat_preview_")) {
      if (!agentTools?.processes) throw new Error("The chat agent tools are unavailable");
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter((id) => typeof id === "string").slice(0, 32) : [];
      switch (operation) {
        case "chat_processes": return { ok: true, sessions: await agentTools.processes(ids) };
        case "chat_process_output": return { ok: true, ...await agentTools.processOutput(args) };
        case "chat_process_stop": return agentTools.processStop(args);
        case "chat_process_input": return agentTools.processInput(args);
        case "chat_preview_state": return { ok: true, previews: agentTools.previewState(ids) };
        case "chat_preview_show": {
          const bounds = args.bounds;
          if (!bounds || !["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]))) throw new Error("bounds must be finite numbers");
          return { ok: agentTools.previewShow(args.sessionId, bounds, Number(args.zoom) || 1) };
        }
        case "chat_preview_hide": agentTools.previewHide(); return { ok: true };
        case "chat_preview_navigate": return agentTools.previewNavigate(args.sessionId, {
          ...(typeof args.url === "string" ? { url: args.url } : {}), ...(typeof args.action === "string" ? { action: args.action } : {}),
        });
        default: throw new Error("Unsupported chat pane operation");
      }
    }
    if (operation === "upstream_show") return show(args.bounds, args.projectBoard === true, args.workspaceId, args.terminal || null);
    if (operation === "upstream_hide") return hide();
    if (operation === "upstream_bounds") return setBounds(args.bounds);
    const spec = API_OPERATIONS[operation];
    if (!spec) throw new Error("Unsupported upstream AO operation");
    if (state !== "ready") throw new Error("Start the source-integrated AO runtime first");
    let endpoint = spec.endpoint;
    if (endpoint.includes(":id")) {
      if (typeof args.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.id)) throw new Error("A valid AO session ID is required");
      endpoint = endpoint.replace(":id", args.id);
    }
    const body = spec.method === "GET" ? undefined : JSON.stringify(args.body || {});
    if (body?.length > 65536) throw new Error("AO API request exceeds 64 KiB");
    if (body && !await confirm({ message: "Allow this Agent Orchestrator operation?", detail: `${operation}\n${body}` })) return { ok: true, cancelled: true };
    return requestApi(spec.method, endpoint, body);
  }

  return { call, start, stop, show, hide, snapshot, harness };
}

module.exports = { agentCatalog, createAgentOrchestratorUpstream, createAgentInventory, API_OPERATIONS };

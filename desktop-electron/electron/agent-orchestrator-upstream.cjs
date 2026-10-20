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
const { readContextBreakdown } = require("./ao-context-breakdown.cjs");
const { withAgentShellCommands, CONVERSATION_LIMITS: AGENT_SHELL_CONVERSATION_LIMITS } = require("./chat-agent-shell.cjs");
const { windowsChildEnvironment, systemEnvironment } = require("./chat-sandbox.cjs");

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

// How much of an edit's diff a chat timeline item carries (it is polled with every working card).
const EDIT_DIFF_BYTES = 6000;
// How much of a message or a thought a timeline item carries. At 4 KB a long answer stopped
// mid-word, and a cut inside a code span or fence broke how the rest of it rendered.
const TIMELINE_TEXT_BYTES = 64 * 1024;
// The most items a turn's timeline carries: a finished turn's read-back pages in up to 6 × 60.
const TIMELINE_ITEMS = 400;
const DAEMON_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Lines one text change added and removed, as a "+56 −26" count and a short diff: the lines the
 * two versions share at the start and end are trimmed, and what is left on each side is the
 * change. Linear in the text, which a poll can afford; a full diff could not be.
 *
 * With `whole` (both texts are the whole file, as an ACP edit carries them) the diff is one
 * unified hunk with DIFF_CONTEXT unchanged lines on each side and an "@@ -a,b +c,d @@" header, so
 * the chat can number its lines as Claude Code does. A snippet edit (Edit's old_string) has no
 * place in the file to number from, so its diff stays bare.
 */
const DIFF_CONTEXT = 3;
function lineChange(before, after, whole = false) {
  const old = before === "" ? [] : String(before).split(/\r?\n/);
  const next = after === "" ? [] : String(after).split(/\r?\n/);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  const removed = old.slice(start, old.length - end);
  const added = next.slice(start, next.length - end);
  const changed = [...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)];
  if (!whole || !changed.length) return { additions: added.length, deletions: removed.length, diff: changed.join("\n") };
  const from = Math.max(0, start - DIFF_CONTEXT);
  const before_ = old.slice(from, start);
  const after_ = old.slice(old.length - end, old.length - end + DIFF_CONTEXT);
  // A side with no lines starts at 0, as git writes "-0,0" for a new file.
  const range = (count) => `${count ? from + 1 : from},${count}`;
  const oldCount = before_.length + removed.length + after_.length;
  const newCount = before_.length + added.length + after_.length;
  return { additions: added.length, deletions: removed.length, diff: [`@@ -${range(oldCount)} +${range(newCount)} @@`,
    ...before_.map(line => ` ${line}`), ...changed, ...after_.map(line => ` ${line}`)].join("\n") };
}

// Where a single-repo project's chats work (AO's ProjectConfig.workspaceMode).
const WORKSPACE_MODES = new Set(["worktree", "shared", "folder"]);

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

function createAgentOrchestratorUpstream({ resourceRoot, dataRoot, confirm, getWindow, WebContentsView, dialog, shell, openAuth, getWorkspaces, missionCall, getCpaPricesPath = () => null, extraPath = () => null, extraEnv = () => ({}), agentTools = null, cpaQuota = null, cpaUsage = null, logger = console }) {
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
  /**
   * AO's output on disk, beside its data. Only ao.db outlived a daemon before, and it records that
   * a controller ended, not why, so a turn lost across a restart could not be traced. Rotates once
   * at DAEMON_LOG_BYTES; a log that cannot be written never stops AO.
   */
  function openDaemonLog(pid) {
    const file = path.join(dataRoot, "logs", "ao-daemon.log");
    let stream = null;
    let written = 0;
    const open = () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { written = fs.statSync(file).size; } catch { written = 0; }
        if (written >= DAEMON_LOG_BYTES) { fs.renameSync(file, `${file}.1`); written = 0; }
        stream = fs.createWriteStream(file, { flags: "a" });
        stream.on("error", () => { stream = null; });
      } catch { stream = null; }
    };
    const write = (data) => {
      if (!stream) return;
      written += Buffer.byteLength(data);
      stream.write(data);
      if (written >= DAEMON_LOG_BYTES) { stream.end(); open(); }
    };
    open();
    write(`--- ao-daemon pid ${pid} started at ${new Date().toISOString()}\n`);
    return { write, close: () => { stream?.end(); stream = null; } };
  }
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
  // Chats work in the project folder, on the branch it has checked out, unless the project chose
  // otherwise in Edit project: AO's own default, a worktree per chat, left one ao/<project>-<n>/root
  // branch behind for every question. An explicit choice (including "worktree") is kept.
  const folderModeChecked = new Set();
  async function defaultToFolderMode(project) {
    if (folderModeChecked.has(project.id)) return;
    const endpoint = `/api/v1/projects/${encodeURIComponent(project.id)}`;
    // On the dependency-link sync's queue: both rewrite the whole config.
    await dependencyLinks.exclusive(project.id, async () => {
      const current = (await internalApi("GET", endpoint))?.project;
      if (!current || (current.kind && current.kind !== "single_repo")) return;
      const config = current.config && typeof current.config === "object" ? current.config : {};
      if (config.workspaceMode) return;
      await internalApi("PUT", `${endpoint}/config`, { config: { ...config, workspaceMode: "folder" } });
    });
    folderModeChecked.add(project.id);
  }
  /** The project folder a folder-mode session works in, when it is this chat workspace's own; else null. */
  async function folderModeRoot(session, root, workspaceId) {
    if (!workspaceBoard || typeof workspaceId !== "string" || !workspaceId || typeof session?.projectId !== "string") return null;
    const { projectId } = await workspaceBoard.project(workspaceId);
    if (!projectId || projectId !== session.projectId) return null;
    const project = (await internalApi("GET", `/api/v1/projects/${encodeURIComponent(projectId)}`))?.project;
    if (!project || (project.kind && project.kind !== "single_repo") || project.config?.workspaceMode !== "folder") return null;
    if (typeof project.path !== "string" || !path.isAbsolute(project.path)) return null;
    const normal = (value) => {
      const resolved = path.resolve(value).replace(/[\\/]+$/, "");
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normal(project.path) === normal(root) ? project.path : null;
  }
  /**
   * The chat workspace's own folder, when AO reports exactly it (by real path) as the session's
   * root; else null. A session AO runs in the project's folder works there whatever led AO to put
   * it there (the project's folder mode, or a binding the check above could not confirm just then:
   * several AO projects on the folder, a project kind other than single_repo, AO slow to answer):
   * its tools may use that folder, which is the very folder the user opened as this workspace.
   */
  async function workspaceFolderRoot(root, workspaceId) {
    if (typeof getWorkspaces !== "function" || typeof workspaceId !== "string" || !workspaceId) return null;
    const item = (await getWorkspaces()).find(candidate => candidate?.id === workspaceId);
    if (typeof item?.path !== "string" || !item.path) return null;
    const folder = process.platform === "win32" ? item.path.replace(/^\\\\\?\\/, "") : item.path;
    if (!path.isAbsolute(folder)) return null;
    const real = (value) => {
      let resolved;
      try { resolved = fs.realpathSync.native(value); } catch { resolved = path.resolve(value); }
      resolved = resolved.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return real(folder) === real(root) ? folder : null;
  }
  const workspaceBoard = typeof getWorkspaces === "function" && typeof missionCall === "function"
    ? createAoWorkspaceBoard({
      listWorkspaces: getWorkspaces, missionCall,
      syncProject: (project, folder) => dependencyLinks.sync(project.id, folder),
      defaultWorkspaceMode: defaultToFolderMode,
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
   * How many chat hosts outlived the last app run: their recorded loopback address still accepts
   * a connection. Their agents keep working while AO is down, but a permission request or a turn
   * end waits for AO to reattach, and AO otherwise starts only when its panel is first shown.
   */
  async function survivingChatHosts() {
    let ids;
    try { ids = fs.readdirSync(path.join(dataRoot, "chat-hosts")); } catch { return 0; }
    const answers = await Promise.all(ids.map(id => {
      let address;
      try { address = JSON.parse(fs.readFileSync(path.join(dataRoot, "chat-hosts", id, "host.json"), "utf8")).address; }
      catch { return false; }
      const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(String(address));
      if (!match) return false;
      return new Promise(resolve => {
        const socket = net.connect({ host: "127.0.0.1", port: Number(match[1]) });
        const settle = alive => { socket.destroy(); resolve(alive); };
        socket.setTimeout(1500, () => settle(false));
        socket.once("connect", () => settle(true));
        socket.once("error", () => settle(false));
      });
    }));
    return answers.filter(Boolean).length;
  }
  // continuable() checks in flight, by session (see there).
  const continuing = new Map();
  /**
   * The newest items of a session's conversation. AO counts messages and tool activities alike,
   * and a tool's output can be tens of KB (an MCP browser tool's page dumps), so 100 items reached
   * 1 MB and every poll failed on the response limit. A response that is too big is read again
   * with fewer items; the chat shows only the newest 40 anyway.
   */
  async function conversationTail(id, limits = [100, 40, 10]) {
    for (let at = 0; ; at += 1) {
      try {
        // includePending: a request still waiting on an answer is always in the page, however much
        // came after it; one that fell out of the newest items never showed and sat until it timed out.
        return await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=${limits[at]}&includePending=1`);
      } catch (error) {
        if (at === limits.length - 1 || !/exceeds the handler limit/.test(String(error?.message))) throw error;
      }
    }
  }
  /**
   * The current turn as a Codex-style transcript: assistant messages, reasoning and tool calls
   * in AO sequence order. A live poll reads only the session's newest items (conversationTail) and
   * the chat keeps the earlier ones it saw; a finished turn read back here keeps every item AO
   * paged in. The prompt (user message) is left out because the chat already shows it.
   */
  function turnTimeline(conversation, turnId, turnOver = false) {
    if (typeof turnId !== "string") return [];
    const items = [
      ...(Array.isArray(conversation?.messages) ? conversation.messages : [])
        .filter(message => message.turnId === turnId && message.role === "assistant" && typeof message.text === "string" && message.text.trim())
        .map(message => ({ id: String(message.id), sequence: Number(message.sequence) || 0, kind: "message",
          // Streaming or finished, a message keeps up to TIMELINE_TEXT_BYTES: a 4 KB cut froze the
          // live answer until the turn ended, and cut a finished one mid-word.
          status: message.streaming && !turnOver ? "running" : "completed", text: utf8Prefix(message.text.trim(), TIMELINE_TEXT_BYTES) })),
      ...(Array.isArray(conversation?.activities) ? conversation.activities : [])
        .filter(activity => activity.turnId === turnId && typeof activity.activityKind === "string")
        .map(activity => activity.activityKind === "system" && activity.detail?.event === "steer" && typeof activity.detail.text === "string"
          // AO records a steer as a system row tagged event "steer"; it is the user's own words.
          ? { id: String(activity.id), sequence: Number(activity.sequence) || 0, kind: "steer", status: "completed",
            text: utf8Prefix(activity.detail.text.trim(), TIMELINE_TEXT_BYTES) }
          : timelineActivity(activity)),
    ];
    return items.sort((a, b) => a.sequence - b.sequence).slice(-TIMELINE_ITEMS);
  }
  /**
   * A finished turn's transcript, read back from AO for the chat's folded "Worked" row. AO keeps
   * the whole conversation; an earlier turn is found by paging back (beforeSequence) a few pages,
   * stopping once a page reaches a turn before it.
   */
  async function pastTurnTimeline(id, turnId, pages = 6) {
    let conversation = await conversationTail(id, [60, 20]);
    const merged = { messages: [], activities: [] };
    for (let page = 0; conversation && page < pages; page += 1) {
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const activities = Array.isArray(conversation.activities) ? conversation.activities : [];
      merged.messages.push(...messages);
      merged.activities.push(...activities);
      const oldest = [...messages, ...activities].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))[0];
      const seen = merged.messages.some(entry => entry.turnId === turnId) || merged.activities.some(entry => entry.turnId === turnId);
      if (seen && oldest && oldest.turnId !== turnId) break;
      if (!conversation.hasMoreBefore || !(Number(conversation.oldestSequence) > 0)) break;
      conversation = await internalApi("GET",
        `/api/v1/sessions/${sessionId(id)}/conversation?limit=60&beforeSequence=${Number(conversation.oldestSequence)}`).catch(() => null);
    }
    // An earlier turn has ended; a message AO left flagged as streaming is its final text.
    return turnTimeline(merged, turnId, true);
  }
  // claude-agent-acp reports every tool call, its own Read/Grep/PowerShell included, as AO's
  // "mcp_tool"; the ACP tool kind says what it did. A real MCP server's tool is named mcp__<server>__.
  const TOOL_LABELS = { read: "Read", search: "Search", edit: "Edit", delete: "Delete", move: "Move", fetch: "Fetch",
    think: "Thought", switch_mode: "Plan", execute: "Command", other: "Tool" };
  function toolLabel(detail, summary) {
    // AO's ACP activities name the tool providerToolName.
    const name = String(detail?.toolName || detail?.providerToolName || "");
    if (/^mcp__(?!acp__)/.test(name) || /^mcp__(?!acp__)/.test(summary)) return "MCP";
    return TOOL_LABELS[detail?.toolKind] || "Tool";
  }
  /** How long AO's chat drivers wait for a tool approval before giving up on it (approvalWait). */
  const APPROVAL_WAIT_MS = 30 * 60_000;
  /**
   * What a tool call did, for the row that opens on it (as Claude Code's do): the agent's own
   * one-line description, its arguments as JSON (without the command and description, which the row
   * shows already) and what came back. Capped: every working card's timeline is polled.
   */
  function toolDetails(detail, input) {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    const { command: _command, description: _description, ...rest } = input;
    const args = Object.keys(rest).length ? utf8Prefix(JSON.stringify(rest, null, 2), 1000) : "";
    const output = typeof detail.output === "string" && detail.output.trim() ? detail.output
      : (Array.isArray(detail.content) ? detail.content : [])
        .map(entry => entry?.content?.text).filter(text => typeof text === "string").join("\n");
    return {
      ...(description ? { description: utf8Prefix(description, 200) } : {}),
      ...(args ? { input: args } : {}),
      ...(output.trim() ? { output: utf8Prefix(output.trim(), 2000) } : {}),
    };
  }
  /**
   * The files a timeline activity edited, with lines added and removed and a short diff, or null
   * when it edited none. Codex reports a file_change with per-file counts and a patch; Claude Code
   * over ACP reports an Edit/MultiEdit/Write tool call whose content carries {path, oldText,
   * newText} diffs, or only its input (file_path with old_string/new_string, edits[] or content).
   */
  function editedFiles(activity, detail, input) {
    if (activity.activityKind === "file_change") {
      const files = (Array.isArray(detail.files) ? detail.files : []).filter(file => typeof file?.path === "string").slice(0, 50)
        .map(file => {
          // An ACP edit's file carries the whole file before and after, and AO's patch from them
          // marked every line removed and re-added, so a two-line change opened onto the whole
          // file in red. The changed lines come from the two texts instead; AO's patch is the
          // fallback (Codex's real git diff has no texts).
          // A new file has no oldText: all of it is added, numbered from line 1.
          const diff = typeof file.newText === "string" && (typeof file.oldText === "string" || file.oldText == null)
            ? lineChange(file.oldText ?? "", file.newText, true).diff : typeof file.patch === "string" ? file.patch : "";
          return { path: utf8Prefix(file.path, 500), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0,
            ...(diff ? { diff: utf8Prefix(diff, EDIT_DIFF_BYTES) } : {}) };
        });
      return files.length ? { label: "Edited", files } : null;
    }
    if (activity.activityKind !== "mcp_tool") return null;
    const toolName = String(detail.toolName || "").replace(/^mcp__[\w-]+__/, "");
    const diffs = (Array.isArray(detail.content) ? detail.content : [])
      .map(entry => entry?.type === "diff" ? entry : entry?.diff && typeof entry.diff === "object" ? entry.diff : null)
      .filter(entry => entry && typeof entry.path === "string" && typeof entry.newText === "string");
    // ACP's diff content is the whole file before and after; the input fallbacks below are snippets.
    let changes = diffs.map(entry => ({ path: entry.path, before: typeof entry.oldText === "string" ? entry.oldText : null, after: entry.newText, whole: true }));
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
    if (!changes.length && path && (/^(Edit|MultiEdit|Write|NotebookEdit|str_replace_based_edit_tool)$/i.test(toolName) || detail.toolKind === "edit")) {
      if (typeof input.old_string === "string" && typeof input.new_string === "string") changes = [{ path, before: input.old_string, after: input.new_string }];
      else if (Array.isArray(input.edits)) changes = input.edits.filter(item => typeof item?.old_string === "string" && typeof item?.new_string === "string")
        .map(item => ({ path, before: item.old_string, after: item.new_string }));
      else if (typeof input.content === "string") changes = [{ path, before: null, after: input.content }];
    }
    if (!changes.length) return null;
    const byPath = new Map();
    for (const change of changes.slice(0, 50)) {
      const counted = lineChange(change.before ?? "", change.after, change.whole === true);
      const file = byPath.get(change.path) ?? { path: utf8Prefix(change.path, 500), additions: 0, deletions: 0, diff: "" };
      file.additions += counted.additions;
      file.deletions += counted.deletions;
      if (Buffer.byteLength(file.diff) < EDIT_DIFF_BYTES) file.diff = utf8Prefix(file.diff ? `${file.diff}\n${counted.diff}` : counted.diff, EDIT_DIFF_BYTES);
      byPath.set(change.path, file);
    }
    const created = changes.every(change => change.before === null);
    return { label: created ? "Created" : "Edited", files: [...byPath.values()].map(file => file.diff ? file : { path: file.path, additions: file.additions, deletions: file.deletions }) };
  }
  function timelineActivity(activity) {
    const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
    const input = detail.input && typeof detail.input === "object" ? detail.input : {};
    const base = { id: String(activity.id), sequence: Number(activity.sequence) || 0, status: String(activity.status || "").slice(0, 32) };
    const summary = String(activity.summary || "");
    // A file edit shows as Claude Code shows one: "Edited <file> +12 −3", opening on the diff.
    const edit = editedFiles(activity, detail, input);
    if (edit) return { ...base, kind: "edit", label: edit.label, text: utf8Prefix(edit.files.map(file => file.path).join(", "), 400), files: edit.files };
    // A shell call (Bash, PowerShell) shows as the command it ran, like Codex.
    if (activity.activityKind === "mcp_tool" && typeof input.command === "string" && input.command.trim()) {
      return { ...base, kind: "command", text: utf8Prefix(input.command.trim(), 400), ...toolDetails(detail, input) };
    }
    if (activity.activityKind === "mcp_tool") {
      return { ...base, kind: "tool", label: toolLabel(detail, summary), text: utf8Prefix(summary || detail.toolKind || "tool", 400),
        ...toolDetails(detail, input) };
    }
    // The model's reasoning summary: AO streams it into the activity's text (detail.text); its
    // summary is only the word "Reasoning".
    if (activity.activityKind === "reasoning") {
      const text = typeof detail.text === "string" ? detail.text.trim() : "";
      // While the model thinks, its newest thought is the progress to show; once done, all of it.
      return { ...base, kind: "reasoning", text: base.status === "running" ? utf8Suffix(text, 4096) : utf8Prefix(text, TIMELINE_TEXT_BYTES) };
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
    // A provider failure's summary is only "Retrying Claude, attempt 2 of 10."; why it retries
    // ("API error 429. Trying again in 1s.") is its detail text, and a rate limit needs saying.
    if (activity.activityKind === "system" && detail.event === "provider.failure" && typeof detail.text === "string" && detail.text.trim()) {
      return { ...base, kind: "system", text: utf8Prefix(`${summary ? `${summary} ` : ""}${detail.text.trim()}`, 400) };
    }
    // An answered request keeps AO's request id: the workflow knows whether its reviewer (or "Approve
    // for me") answered it, and the chat shows that on the tool call it let run.
    const request = activity.activityKind === "approval" && typeof activity.requestId === "string" ? { requestId: activity.requestId.slice(0, 200) } : {};
    return { ...base, kind: activity.activityKind.slice(0, 32), text: utf8Prefix(summary || activity.activityKind, 400), ...request };
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
        // AO's ACP approvals for an MCP tool carry no toolName, only the name as the activity's
        // summary (seen live: subjectKind "mcp_tool", toolKind "other"). Without it the input was
        // dropped, so the reviewer saw an exec_command with no command and answered "ask".
        const toolName = String(detail.toolName || activity.summary || "");
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
  /**
   * What the agent asked the person and is waiting on (Claude Code's AskUserQuestion, or any ACP
   * form or URL request): AO parks it as a pending "user_input" activity with the form's schema.
   * Each becomes a "question" the chat shows and answers through resolveInput. A field is a choice
   * (oneOf/enum), a multiple choice (an array of them), free text, a yes/no or a number; Claude
   * Code's "<field>_custom" text is that field's "Other" answer.
   */
  function pendingInputs(conversation) {
    const text = (value, max) => (typeof value === "string" ? utf8Prefix(value, max) : "");
    const options = (list) => (Array.isArray(list) ? list : []).slice(0, 40)
      .map((option) => (option && typeof option === "object"
        ? { value: option.const ?? option.title, label: text(String(option.title ?? option.const ?? ""), 200), description: text(option.description, 500) }
        : { value: option, label: text(String(option), 200), description: "" }))
      .filter((option) => typeof option.value === "string" && option.value);
    return (Array.isArray(conversation?.activities) ? conversation.activities : [])
      .filter((activity) => activity.activityKind === "user_input" && activity.status === "pending" && typeof activity.requestId === "string")
      .map((activity) => {
        const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
        const properties = detail.schema && typeof detail.schema === "object" && detail.schema.properties && typeof detail.schema.properties === "object"
          ? detail.schema.properties : {};
        const required = new Set(Array.isArray(detail.schema?.required) ? detail.schema.required : []);
        const fields = Object.entries(properties).slice(0, 20)
          .filter(([key, schema]) => schema && typeof schema === "object" && !(key.endsWith("_custom") && properties[key.slice(0, -"_custom".length)]))
          .map(([key, schema]) => {
            const many = schema.type === "array";
            const choices = options(many ? schema.items?.anyOf ?? schema.items?.oneOf ?? schema.items?.enum : schema.oneOf ?? schema.anyOf ?? schema.enum);
            const type = choices.length ? (many ? "multi" : "choice") : schema.type === "boolean" ? "boolean"
              : schema.type === "number" || schema.type === "integer" ? "number" : "text";
            return { key: key.slice(0, 80), type, title: text(schema.title, 200), description: text(schema.description, 2000), options: choices,
              ...(properties[`${key}_custom`] ? { customKey: `${key}_custom`.slice(0, 90) } : {}), ...(required.has(key) ? { required: true } : {}) };
          });
        return {
          approval_id: activity.requestId.slice(0, 200), source: "ao", kind: "question",
          mode: detail.inputMode === "url" ? "url" : "form", message: text(detail.message || activity.summary, 4000),
          ...(detail.inputMode === "url" && typeof detail.url === "string" && /^https?:\/\//i.test(detail.url) ? { url: utf8Prefix(detail.url, 2000) } : {}),
          fields, tool: "AskUserQuestion", summary: text(activity.summary, 500),
          ...(typeof activity.createdAt === "string" ? { since: activity.createdAt } : {}),
          turn_id: typeof activity.turnId === "string" ? activity.turnId : undefined, decisions: [],
        };
      });
  }
  /** A chat start that failed only for time (the persistent host's startup window, a deadline). */
  const TRANSIENT_CHAT_START = /persistent (ACP )?host|timed out|timeout|deadline exceeded|context canceled/i;
  // Sessions whose failed background start was resumed once: id -> { resumed: Promise<boolean>,
  // after: the observe() read count when AO answered the resume }.
  const provisionRetried = new Map();
  let observeReads = 0;
  // One session read in flight serves every observe() of that session that asks meanwhile. The run
  // loop, the chat's activity poll and the approvals poll each observed the same session, several
  // times a second while a fast model streamed, and each read pulled up to 900 KB of conversation
  // and parsed it on the main thread; the chat lagged behind the model. A read is shared only while
  // in flight (a landed one is never reused), and any write this module sends drops it (see
  // internalApi), so an observe after a send, steer or interrupt reads what followed it.
  const sharedReads = new Map(); // session id -> { read, promise }
  /**
   * The session record and conversation tail observe() reads, fetched once per session while in
   * flight. `read` is the observe count when the fetch began, so a read taken before a resume
   * answered still counts as earlier than it (see provisionRetried), whichever observe picks it up.
   */
  function sharedObserveRead(id) {
    const hit = sharedReads.get(id);
    if (hit) return hit;
    const entry = { read: ++observeReads, promise: null };
    const forget = () => { if (sharedReads.get(id) === entry) sharedReads.delete(id); };
    entry.promise = (async () => {
      const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`);
      if (record?.session?.mode === "tui") return { record, conversation: null };
      return { record, conversation: await conversationTail(id) };
    })().finally(forget);
    sharedReads.set(id, entry);
    return entry;
  }
  const CHAT_RETRY_PAUSE_MS = 2000;
  /** The longest prefix of `text` that is at most `maxBytes` of UTF-8 (AO limits prompts in bytes). */
  function utf8Prefix(text, maxBytes) {
    const value = String(text);
    if (value.length <= maxBytes / 3 || Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    // Cut the bytes, then step back off any continuation byte so no character is split (a
    // surrogate pair is one 4-byte sequence in UTF-8, so it is never halved either). The earlier
    // character-by-character search measured a growing slice per character: with 64 KB of
    // Chinese text that was thousands of scans per field on every poll.
    const bytes = Buffer.from(value, "utf8");
    let cut = Math.max(0, maxBytes);
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
    return bytes.toString("utf8", 0, cut);
  }
  /** The longest suffix of `text` that is at most `maxBytes` of UTF-8: the newest part of live text. */
  function utf8Suffix(text, maxBytes) {
    const value = String(text);
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    let start = Math.max(0, value.length - maxBytes);
    while (start < value.length && Buffer.byteLength(value.slice(start), "utf8") > maxBytes) start += Math.max(1, Math.floor((value.length - start) * 0.05));
    while (start > 0 && Buffer.byteLength(value.slice(start - 1), "utf8") <= maxBytes) start -= 1;
    // Never start on the second half of a surrogate pair.
    const first = value.charCodeAt(start);
    if (start < value.length && first >= 0xdc00 && first <= 0xdfff) start += 1;
    return value.slice(start);
  }

  // Mission-owned AO calls. The run grant already covers them, so no extra dialog.
  async function internalApi(method, endpoint, body) {
    // A write may change what a session read in flight is about to return (sharedObserveRead).
    if (method !== "GET") sharedReads.clear();
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
  // The window each session was launched with, including a blank card's resolved full limit
  // (defaultContextWindow), which no route records and AO does not read back. The context meter
  // shows it over the agent's own report (Claude Code over ACP says 200K for any unknown model).
  // In memory and bounded: after a restart the meter falls back to the card's explicit window.
  const launchWindows = new Map();
  // Each session's last good context reading (steadyContext), bounded like launchWindows. Kept on
  // disk too: after an app restart (an update) the first steer's zero snapshot had nothing to fall
  // back on, and the meter showed an empty context for a long chat.
  // Loaded on the meter's first read.
  let contextReadings = null;
  let readingsSaved = "";
  let readingsTimer = null;
  const readingsFile = () => path.join(dataRoot, "coding-tools-context-readings.json");
  const readings = () => {
    if (contextReadings) return contextReadings;
    let saved = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(readingsFile(), "utf8"));
      if (Array.isArray(parsed)) saved = parsed.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string"
        && entry[1] && typeof entry[1] === "object" && entry[1].usage && typeof entry[1].usage === "object").slice(-64);
    } catch { /* no readings yet */ }
    contextReadings = new Map(saved);
    readingsSaved = JSON.stringify(saved);
    return contextReadings;
  };
  const saveReadings = () => {
    if (readingsTimer) return;
    readingsTimer = setTimeout(() => {
      readingsTimer = null;
      const next = JSON.stringify([...readings()]);
      if (next === readingsSaved) return;
      readingsSaved = next;
      fs.promises.mkdir(dataRoot, { recursive: true, mode: 0o700 })
        .then(() => fs.promises.writeFile(readingsFile(), next, { mode: 0o600 })).catch(() => undefined);
    }, 5_000);
    readingsTimer.unref?.();
  };
  function rememberLaunchWindow(id, tokens) {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
    launchWindows.delete(id);
    launchWindows.set(id, tokens);
    if (launchWindows.size > 500) launchWindows.delete(launchWindows.keys().next().value);
  }
  async function projectFor(workspaceId) {
    if (!workspaceBoard) throw new Error("Coding Tools mission service is unavailable");
    const at = Date.now();
    const kept = projectBindings.get(workspaceId);
    if (kept && at - kept.at < PROJECT_BINDING_TTL_MS) return kept.promise;
    const entry = { at, promise: workspaceBoard.bind(workspaceId).then(binding => {
      if (!binding.projectId) throw new Error("AO harness workers need this workspace to be a git repository registered in AO");
      return binding.projectId;
    }) };
    entry.promise.catch(() => forgetProject(workspaceId, entry));
    projectBindings.set(workspaceId, entry);
    return entry.promise;
  }
  // One send bound its workspace up to four times (model checks, the default window, the launch):
  // each listed AO's projects, ran git and synced dependency links for up to 3 s. A binding is kept
  // for a minute, so the launch reuses the sync its own model check just did. A failed binding is
  // not kept, and a failed start, a new daemon or a dependency-link setting change binds afresh.
  const PROJECT_BINDING_TTL_MS = 60_000;
  const projectBindings = new Map(); // workspaceId -> { at, promise }
  function forgetProject(workspaceId, entry = null) {
    if (workspaceId === undefined) { projectBindings.clear(); return; }
    if (!entry || projectBindings.get(workspaceId) === entry) projectBindings.delete(workspaceId);
  }
  /**
   * The app's own tools for one chat session about to be spawned (its own credential, rooted at
   * the worktree AO creates for it), or null. Never fails a launch: without them the agent starts
   * without them.
   */
  async function chatTools(agent, workspaceId, approvalMode, autoReview = false, subagent = false) {
    if (!agentTools) return null;
    try {
      // The session's permission mode goes with its credential: only a session launched to
      // bypass permissions runs every terminal command without the user confirming each one, and
      // one set to "Approve for me" (autoReview) its routine project commands.
      const lease = await agentTools.lease({ agent, workspaceId, ...(approvalMode ? { approvalMode } : {}), ...(autoReview ? { autoReview: true } : {}),
        // A subagent (subagents.cjs) gets the app's tools but no subagents of its own.
        ...(subagent ? { subagent: true } : {}) });
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
        .slice(0, 500).map(model => ({ id: model.id, label: String(model.label || model.id).slice(0, 128), isDefault: model.isDefault === true,
          efforts: Array.isArray(model.efforts) ? model.efforts.filter(value => typeof value === "string" && value.length <= 32).slice(0, 16) : [] }));
    },
    async spawn({ workspaceId, agent, model, prompt, name, gateway = null, effort = null, contextWindow = null, approvalMode = null, autoReview = false, plain = false, warm = false, subagent = false }) {
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
        const tools = mode === "chat" ? await chatTools(agent, workspaceId, approvalMode, autoReview === true, subagent === true) : null;
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
        // A chat answers as soon as AO has recorded it; its worktree and agent start behind it and
        // the prompt is sent once the agent is up (provisionState; observe() reads it). Waiting for
        // the whole start took 20 s before the chat showed anything. A pre-warmed one stays
        // synchronous: it is "ready" only once its agent is.
        ...(mode === "chat" && !warm ? { async: true } : {}),
        displayName: String(name || "AO worker").slice(0, 100),
      });
      let data;
      try {
        data = await launch(chat ? "chat" : "tui");
      } catch (error) {
        // The project may be gone or changed in AO; the next start binds the workspace again.
        forgetProject(workspaceId);
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
      const created = sessionId(data?.session?.id);
      rememberLaunchWindow(created, contextWindow);
      return created;
    },
    async observe(id, expectedTurn) {
      const shared = sharedObserveRead(id);
      const read = shared.read;
      const { record, conversation } = await shared.promise;
      if (record?.session?.mode === "tui") return observeTui(id, record.session.status, record.session.activity);
      const session = record;
      const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
      // A follow-up sent into a live session is pinned to its own turn: until AO shows it, the
      // previous, completed turn must not be read as this card's answer.
      const turn = typeof expectedTurn === "string" && expectedTurn ? turns.find(entry => entry.id === expectedTurn) : turns[turns.length - 1];
      if (typeof expectedTurn === "string" && expectedTurn && !turn) {
        return { status: session?.session?.status, turnId: expectedTurn, turnState: "queued", needsInput: false, exited: false,
          answer: "", liveOutput: "", timeline: [], approvals: [] };
      }
      // A turn that has ended can leave its last message flagged as streaming (a provider error
      // ended it mid-stream). That text is final: counting only settled messages left the answer
      // empty, so the chat showed no reply although AO had stored one.
      const turnOver = TERMINAL_TURN_STATES.has(turn?.state);
      const answer = (Array.isArray(conversation?.messages) ? conversation.messages : [])
        .filter(message => message.role === "assistant" && message.turnId === turn?.id && (!message.streaming || turnOver))
        .map(message => message.text).join("\n\n").trim();
      // Streaming is display-only evidence for this owned session's current turn.
      const liveOutput = (Array.isArray(conversation?.messages) && typeof turn?.id === "string" ? conversation.messages : [])
        .filter(message => message.role === "assistant" && message.turnId === turn.id && typeof message.text === "string")
        .map(message => message.text).join("\n\n").trim();
      const status = session?.session?.status;
      const timeline = turnTimeline(conversation, turn?.id, turnOver);
      // A chat started in the background (spawn's async) whose agent failed to come up: one that
      // failed only for time is resumed once (AO keeps the queued prompt, so it is never sent twice);
      // otherwise the turn fails with AO's reason.
      if (session?.session?.provisionState === "failed") {
        const reason = String(session.session.provisionError || "The agent could not start").slice(0, 500);
        let retry = provisionRetried.get(id);
        if (!retry && TRANSIENT_CHAT_START.test(reason)) {
          retry = { after: Infinity };
          retry.resumed = internalApi("POST", `/api/v1/sessions/${sessionId(id)}/resume-agent`, {}).then(() => true, () => false)
            .then((resumed) => { retry.after = observeReads; return resumed; });
          provisionRetried.set(id, retry);
          if (provisionRetried.size > 500) provisionRetried.delete(provisionRetried.keys().next().value);
        }
        // The run loop and the chat's activity poll observe the same card: a read taken before AO
        // answered the resume saw the failure being resumed, not the resumed start failing again,
        // and failed the card while its agent was coming up.
        if (retry && read <= retry.after && await retry.resumed) {
          return { status, turnId: turn?.id, turnState: "queued", needsInput: false, exited: false, answer: "", liveOutput: "", timeline, approvals: [] };
        }
        return { status, turnId: turn?.id, turnState: "failed", error: `The agent could not start: ${reason}`,
          needsInput: false, exited: false, answer: "", liveOutput: "", timeline, approvals: [] };
      }
      // A chat turn whose host process is gone (e.g. killed with the app during an update) stays
      // "running" in AO forever. Settle it through AO's own interrupt path so the card can retry.
      // The reason is reported again for a turn already settled that way (a display-only read may
      // have sent the interrupt), so the card's saved failure says why; a turn the user stopped
      // keeps its live host and stays a plain interruption.
      const settling = turn && !TERMINAL_TURN_STATES.has(turn.state);
      const settled = turn?.state === "interrupted" && !turn.errorMessage;
      // AO's daemon closes with the app too (an update does): starting again, it fails every turn
      // its old controller left running. Nothing about the step itself failed, so it is reported
      // the same way and the card can be resumed. (AO's wording: storage/sqlite/queries/
      // conversations.sql, SettleOrphanedConversationTurns.)
      const reconciled = turn?.state === "failed" && turn.errorMessage === "controller ended before the turn completed";
      if (reconciled || ((settling || settled) && await chatHostGone(id))) {
        if (settling) await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/interrupt`, {}).catch(() => undefined);
        return {
          status, turnId: turn.id, turnState: "interrupted",
          error: "The agent's process ended before it finished (the app restarted); retry this card.",
          needsInput: false, exited: false, answer: "", liveOutput: utf8Prefix(liveOutput, 4096), timeline,
        };
      }
      // When the turn last showed any sign of life (a message, a tool step): a turn whose agent hung
      // (a model request that never returns) keeps "running" with nothing new. A provider retry
      // notice ("Retrying Claude, attempt 7 of 10") is not one: a turn stuck on 503s posts one every
      // few seconds and does nothing else, and counting them hid the hang from chat_steer. Nor is
      // the turn's own updatedAt, which AO may touch with any activity, retries included.
      const retryNotice = item => item.activityKind === "system" && item.detail?.event === "provider.failure";
      const stamps = [turn?.startedAt, turn?.createdAt,
        ...(Array.isArray(conversation?.activities) ? conversation.activities : []).filter(item => item.turnId === turn?.id && !retryNotice(item))
          .map(item => item.updatedAt || item.createdAt),
        ...(Array.isArray(conversation?.messages) ? conversation.messages : []).filter(item => item.turnId === turn?.id).map(item => item.updatedAt || item.createdAt)]
        .map(value => Date.parse(value ?? "")).filter(Number.isFinite);
      return {
        status, turnId: turn?.id, turnState: turn?.state, error: turn?.errorMessage,
        ...(stamps.length ? { lastActivityAt: Math.max(...stamps) } : {}),
        needsInput: status === "needs_input", exited: ["exited", "terminated"].includes(status),
        answer: answer.slice(0, 12000), liveOutput: utf8Prefix(liveOutput, 4096), timeline,
        // A question the agent asked waits like an approval: the chat shows it and the card needs you.
        approvals: [...pendingApprovals(conversation), ...pendingInputs(conversation)],
      };
    },
    /**
     * Whether a chat session can take another turn: it exists, runs as a chat, and its host is up.
     * A follow-up then continues it instead of starting a new session and worktree.
     */
    async continuable(id) {
      // One check per session at a time: reopening a chat pre-warms it (chat_prewarm) and a message
      // sent right after asks again while a released agent is still being resumed. The second
      // check resumed it again (AO refuses that) or read its old chat host as gone, and the message
      // started a fresh session beside the agent coming back. Callers share the first check.
      const key = sessionId(id);
      if (!continuing.has(key)) continuing.set(key, (async () => {
        const record = await internalApi("GET", `/api/v1/sessions/${key}`).catch(() => null);
        const status = record?.session?.status;
        if (!record?.session || record.session.mode === "tui" || record.session.isTerminated || ["terminated", "killed", "errored"].includes(status)) return false;
        if (status === "exited") {
          // An agent released while idle (exitAgent) keeps its session, worktree and conversation:
          // bring it back (a few seconds) rather than start over and replay the whole chat.
          // AO holds a chat's tool servers only while its daemon runs: one resumed after a restart
          // came back without the app's tools. Fresh ones for the session go with the resume.
          const renewed = await Promise.resolve().then(() => agentTools?.renew?.(key)).catch(() => null);
          const resume = body => internalApi("POST", `/api/v1/sessions/${key}/resume-agent`, body).catch(() => null);
          let resumed = await resume(renewed?.servers?.length ? { mcpServers: renewed.servers } : {});
          // An AO from before resume took servers refuses the field; resume as before then.
          if (resumed?.ok !== true && renewed?.servers?.length) resumed = await resume({});
          if (resumed?.ok !== true) return false;
        }
        return !(await chatHostGone(key));
      })().finally(() => continuing.delete(key)));
      return continuing.get(key);
    },
    /**
     * Stops a session's agent (its chat host and model process) but keeps the session, worktree and
     * provider conversation; continuable() resumes it on the next message.
     */
    async exitAgent(id) {
      agentTools?.cancelSessionCalls?.(id);
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
      agentTools?.cancelSessionCalls?.(id);
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/kill`, {});
      agentTools?.forgetSession?.(id);
      return { ok: true };
    },
    /**
     * Where a chat session's app tools may act: its own worktree once AO has made it, `ready:
     * false` before that, `ended` once the session is gone. Never starts AO; the path stays in
     * the main process.
     */
    async sessionWorkspace(id, workspaceId = null) {
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
      if (typeof root !== "string" || !path.isAbsolute(root)) return { ready: false };
      // A project whose chats work in its own folder (workspaceMode "folder") runs its sessions
      // there, not in a worktree. The chat's tools may use that folder only when the session is
      // this chat workspace's own AO project, the project chose the folder, and AO reports exactly
      // the project's path; any other session stays worktree-only.
      const projectFolder = await folderModeRoot(session, root, workspaceId).catch(() => null)
        ?? await workspaceFolderRoot(root, workspaceId).catch(() => null);
      return projectFolder ? { root, projectFolder } : { root };
    },
    /** Whether any live session's agent is mid-turn: restarting the app now would cut it off. */
    async anySessionWorking() {
      const list = await internalApi("GET", "/api/v1/sessions");
      const sessions = [...(Array.isArray(list?.sessions) ? list.sessions : []), ...(Array.isArray(list?.items) ? list.items : [])];
      return sessions.some(session => session?.status === "working" && !session.isTerminated);
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
    /**
     * Answers a question the agent asked (a parked "user_input"): `accept` with the form's
     * `content`, or `decline` / `cancel` without. AO checks the content against the form.
     */
    async resolveInput(id, requestId, action, content = undefined) {
      if (typeof requestId !== "string" || !requestId) throw new Error("A question to answer is required");
      if (!["accept", "decline", "cancel"].includes(action)) throw new Error("Answer, decline or cancel the question");
      const body = action === "accept" && content && typeof content === "object" && !Array.isArray(content) ? { action, content } : { action };
      if (JSON.stringify(body).length > 65536) throw new Error("The answer is too long");
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/inputs/${encodeURIComponent(requestId)}/resolve`, body);
      return { ok: true };
    },
    /** Answers one parked tool request with one of the decisions AO offered for it. */
    async resolveApproval(id, requestId, decisionId) {
      if (typeof requestId !== "string" || !requestId || typeof decisionId !== "string" || !decisionId) throw new Error("Choose an offered decision");
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/approvals/${encodeURIComponent(requestId)}/resolve`, { decisionId });
      return { ok: true };
    },
    /** A finished turn's reasoning, tool calls and messages (the chat's "Worked" row, opened). */
    async timeline(id, turnId) {
      if (typeof turnId !== "string" || !turnId) return [];
      return pastTurnTimeline(id, turnId);
    },
    async interrupt(id) {
      agentTools?.cancelSessionCalls?.(id);
      const interrupt = () => internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/interrupt`, {}).catch(error => {
        if (!/CHAT_NO_ACTIVE_TURN/.test(String(error?.message))) throw error;
      });
      await interrupt().catch(async (error) => {
        // A chat created in the background (spawn's async) whose agent is still starting has no
        // controller, so nothing to interrupt; AO would send its queued prompt once the agent is up,
        // and the stopped card would leave it working unseen. Its start is cancelled instead. One
        // that came up meanwhile is interrupted.
        if (!/CHAT_CONTROLLER_NOT_READY/.test(String(error?.message))) throw error;
        const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`);
        if (record?.session?.provisionState === "provisioning") {
          await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/kill`, {});
          agentTools?.forgetSession?.(id);
        } else await interrupt();
      });
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
        // AO hands this environment on to every chat agent and through it to the Git Bash its Bash
        // tool runs: on Windows it carries SystemRoot, TEMP and the rest a process needs to start,
        // and a de-duplicated PATH of bounded length (forks failed with 0xC0000142 without them).
        const daemonEnvironment = windowsChildEnvironment(environment, { system: systemEnvironment() });
          // The AO CLI build answers the daemon command and the internal commands the daemon
          // relaunches itself with (pty-host, chat-host, agent-process); a daemon-only build cannot.
          child = spawn(executable, ["daemon"], {
          cwd: resourceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...daemonEnvironment, AO_PORT: String(daemonPort), AO_DATA_DIR: dataRoot, AO_RUN_FILE: path.join(dataRoot, "running.json"), AO_ALLOWED_ORIGINS: gatewayOrigin, AO_TELEMETRY_EVENTS: "off", AO_TELEMETRY_METRICS: "off", AO_TELEMETRY_REMOTE: "off", AO_SENTRY_DSN: "",
            // AO bounds every request at 60 s, and starting a chat agent (worktree, agent process,
            // its handshake) took longer on a busy machine: the chat failed with SPAWN_TIMEOUT
            // while the agent came up seconds later. Just under this app's own 180 s for a POST,
            // so AO answers with its error before the app stops waiting.
            AO_REQUEST_TIMEOUT: "170s" },
        });
        const currentChild = child;
        logTail = "";
        // A new daemon may know its projects differently; workspaces bind again.
        forgetProject();
        const daemonLog = openDaemonLog(currentChild.pid);
        for (const output of [child.stdout, child.stderr]) output.on("data", (chunk) => {
          logTail = (logTail + chunk.toString()).slice(-16384);
          daemonLog.write(chunk);
        });
        child.once("error", (cause) => { if (child === currentChild && startupGeneration === lifecycleGeneration) { error = cause.message; state = "error"; } });
        child.once("exit", (code) => {
          daemonLog.write(`--- ao-daemon pid ${currentChild.pid} exited (${code}) at ${new Date().toISOString()}\n`);
          daemonLog.close();
          if (child === currentChild && startupGeneration === lifecycleGeneration) { state = "error"; error = `AO exited (${code})`; }
        });
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
      forgetProject(args.workspaceId);
      return { ok: true, ...await workspaceBoard.bind(args.workspaceId) };
    }
    // "Reuse installed Node packages" (`enabled`, default on) and "Share the Python environment"
    // (`python`, default off).
    if (operation === "upstream_dependency_links") return { ok: true, ...dependencyLinks.settings() };
    if (operation === "upstream_set_dependency_links") {
      const given = ["enabled", "python"].filter(name => args[name] !== undefined);
      if (!given.length || given.some(name => typeof args[name] !== "boolean")) throw new Error("enabled or python must be true or false");
      forgetProject();
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
    // The composer's branch bar: the project's branches and the one this chat works on (its own
    // worktree's, once AO has made it). Read-only; with AO stopped it still lists the folder's.
    if (operation === "chat_branches") {
      if (!workspaceBoard?.branches) throw new Error("Coding Tools mission service is unavailable");
      let chatRoot = null;
      if (state === "ready" && typeof args.sessionId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(args.sessionId)) {
        const location = await requestApi("GET", `/api/v1/desktop/sessions/${sessionId(args.sessionId)}/workspace`).catch(() => null);
        const root = location?.ok ? location.data?.workspacePath : null;
        if (typeof root === "string" && path.isAbsolute(root)) chatRoot = root;
      }
      return { ok: true, ...await workspaceBoard.branches(args.workspaceId, chatRoot) };
    }
    // The branch bar's choice: checks out an existing branch in the project folder, which is where
    // chats work. Nothing is created; uncommitted changes and branches held by another worktree are
    // refused with the reason.
    if (operation === "chat_switch_branch") {
      if (!workspaceBoard?.switchBranch) throw new Error("Coding Tools mission service is unavailable");
      return { ok: true, ...await workspaceBoard.switchBranch(args.workspaceId, args.branch) };
    }
    // Where a project's chats work (the Edit project dialog): each in its own git worktree (the
    // default), all in one shared worktree, or in the project folder itself. AO keeps it in the
    // project's config (workspaceMode) and never removes a shared worktree or the folder. Without
    // `mode` it reads the setting; with one it saves it and reads it back, so an AO too old to
    // know the setting is reported rather than silently ignored.
    if (operation === "workspace_mode") {
      if (!workspaceBoard) throw new Error("Coding Tools mission service is unavailable");
      if (state !== "ready") return { ok: true, available: false, reason: "Agent Orchestrator is not running" };
      const { projectId } = await workspaceBoard.project(args.workspaceId);
      if (!projectId) return { ok: true, available: false, reason: "This project's first chat sets it up; choose after that" };
      if (args.mode !== undefined && !WORKSPACE_MODES.has(args.mode)) throw new Error("Choose worktree, shared or folder");
      const endpoint = `/api/v1/projects/${encodeURIComponent(projectId)}`;
      const read = async () => {
        const record = await internalApi("GET", endpoint);
        const project = record?.project;
        return { project, config: project?.config && typeof project.config === "object" ? project.config : {} };
      };
      // On the dependency-link sync's queue: both rewrite the whole config, and interleaved they
      // would drop each other's fields (this mode, or the links a spawn just added).
      return dependencyLinks.exclusive(projectId, async () => {
        const { project, config } = await read();
        if (!project || (project.kind && project.kind !== "single_repo")) {
          return { ok: true, available: false, reason: "Only a single-folder project can choose where its chats work" };
        }
        // A project that never chose is moved to the folder before its next chat starts.
        const current = WORKSPACE_MODES.has(config.workspaceMode) ? config.workspaceMode : "folder";
        if (args.mode === undefined) return { ok: true, available: true, mode: current };
        if (args.mode !== config.workspaceMode) {
          // AO replaces the whole config, so every other setting is sent back as it was. The mode
          // is always written, "worktree" too, so the folder default never overrides a choice.
          await internalApi("PUT", `${endpoint}/config`, { config: { ...config, workspaceMode: args.mode } });
          const saved = (await read()).config.workspaceMode;
          if (saved !== args.mode) throw new Error("This Agent Orchestrator does not support choosing where chats work yet; update the app");
        }
        return { ok: true, available: true, mode: args.mode };
      });
    }
    // The chat composer's context meter: how full each agent session's context is, what it has
    // spent, its account's rate limits and tool servers, as AO keeps them on the conversation
    // snapshot (absent until the agent reports). Read-only; a stopped AO answers with nothing.
    if (operation === "chat_context") {
      const ids = Array.isArray(args.sessionIds) ? [...new Set(args.sessionIds.filter((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))].slice(0, 8) : [];
      if (state !== "ready" || !ids.length) return { ok: true, sessions: {} };
      const number = (value) => (Number.isFinite(value) ? value : null);
      const sessions = {};
      await Promise.all(ids.map(async (id) => {
        const conversation = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=1`).catch(() => null);
        if (!conversation || typeof conversation !== "object") return;
        const reported = conversation.usage && typeof conversation.usage === "object" ? conversation.usage : null;
        const compactedAt = typeof conversation.compactedAt === "string" ? conversation.compactedAt : null;
        const usage = steadyContext(readings(), id, reported, compactedAt);
        saveReadings();
        const limits = conversation.rateLimits && typeof conversation.rateLimits === "object" ? conversation.rateLimits : null;
        sessions[id] = {
          controller: typeof conversation.controller === "string" ? conversation.controller : null,
          usage: usage ? {
            contextUsed: number(usage.contextUsed), contextWindow: number(usage.contextWindow),
            inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens),
            cachedTokens: number(usage.cachedTokens), totalTokens: number(usage.totalTokens),
            cost: number(usage.cost), currency: typeof usage.currency === "string" ? usage.currency.slice(0, 8) : null,
          } : null,
          rateLimits: limits ? {
            primaryUsedPercent: number(limits.primaryUsedPercent), secondaryUsedPercent: number(limits.secondaryUsedPercent),
            primaryResetsInSeconds: number(limits.primaryResetsInSeconds), secondaryResetsInSeconds: number(limits.secondaryResetsInSeconds),
            planLabel: typeof limits.planLabel === "string" ? limits.planLabel.slice(0, 80) : null,
          } : null,
          compactedAt,
          launchedWindow: launchWindows.get(id) ?? null,
          planLabel: typeof conversation.account?.planLabel === "string" ? conversation.account.planLabel.slice(0, 80) : null,
          mcpServers: (Array.isArray(conversation.mcpServers) ? conversation.mcpServers : []).slice(0, 40)
            .filter((server) => typeof server?.name === "string")
            .map((server) => ({ name: server.name.slice(0, 80), status: String(server.status ?? "").slice(0, 40) })),
        };
        // The open panel's category split reads the timeline back to the last compaction, so
        // only on request and for one session; the 4-second ring poll stays one small read.
        if (args.detail === true && ids.length === 1) {
          sessions[id].breakdown = await readContextBreakdown(
            (query) => internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?${query}`),
            sessions[id].usage,
          ).catch(() => null);
        }
      }));
      return { ok: true, sessions };
    }
    // The context meter's plan usage limits for chats on CPA's Codex accounts: each account's
    // 5-hour and weekly use, from CPA Helper (cpa-quota.cjs). Read-only; works with AO stopped.
    if (operation === "cpa_quota") {
      if (!cpaQuota) return { ok: true, available: false, reason: "CPA is not set up in this app" };
      return cpaQuota.read();
    }
    // Each CPA account's tokens, requests and estimated cost over a range, with its quota where
    // one is known (cpa-usage.cjs): the CPA accounts view and the context meter. Read-only.
    if (operation === "cpa_usage") {
      if (!cpaUsage) return { ok: true, available: false, reason: "CPA is not set up in this app" };
      return cpaUsage.read({ range: typeof args.range === "string" ? args.range : undefined });
    }
    // The line under the chat box: the latest turn's model requests through CPA (cpa-usage.cjs).
    if (operation === "chat_turn_stats") {
      if (!cpaUsage?.turnStats) return { ok: true, available: false };
      return cpaUsage.turnStats({ model: typeof args.model === "string" ? args.model : "",
        models: Array.isArray(args.models) ? args.models.filter((value) => typeof value === "string").slice(0, 4) : [], from: Number(args.from) });
    }
    // A chat's Terminal and Preview panes: the user's view of each card's agent session, through
    // the agent tools server that started its commands and owns its preview (chat-agent-tools.cjs).
    if (operation === "chat_processes") {
      // The commands the app started (exec_command) and the ones the agent ran with its own shell
      // tool, which AO records in the conversation. That read only happens while AO is up (a poll
      // must not start it) and never fails the app's listing.
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter((id) => typeof id === "string").slice(0, 32) : [];
      const app = agentTools?.processes ? await agentTools.processes(ids, typeof args.workspaceId === "string" ? args.workspaceId : null) : [];
      const readConversation = state === "ready" ? (id) => conversationTail(id, AGENT_SHELL_CONVERSATION_LIMITS) : null;
      return { ok: true, sessions: await withAgentShellCommands(app, ids, readConversation, logger) };
    }
    if (operation.startsWith("chat_process") || operation.startsWith("chat_preview_")
      || ["chat_terminal_start", "chat_changes", "chat_files", "chat_file"].includes(operation)) {
      if (!agentTools?.processes) throw new Error("The chat agent tools are unavailable");
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter((id) => typeof id === "string").slice(0, 32) : [];
      const pathArgument = (value) => (typeof value === "string" && value.length <= 1024 && !value.includes("\0") ? value : ".");
      switch (operation) {
        case "chat_terminal_start": return agentTools.terminalStart({ sessionId: args.sessionId, workspaceId: args.workspaceId });
        case "chat_changes": return agentTools.changes({ sessionId: args.sessionId, workspaceId: args.workspaceId });
        case "chat_files": return agentTools.files({ sessionId: args.sessionId, workspaceId: args.workspaceId, path: pathArgument(args.path) });
        case "chat_file": {
          if (typeof args.path !== "string" || !args.path || args.path.length > 1024) throw new Error("Choose a file");
          return agentTools.file({ sessionId: args.sessionId, workspaceId: args.workspaceId, path: args.path });
        }
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

  /**
   * The folder AO keeps `ao` in for its own sessions (agentlaunch/pin.go: runtime/ao-path/ and the
   * first 16 bytes of the daemon path's SHA-256). The app's exec_command runs outside those
   * sessions, so `ao` was "not recognized" there; the sandbox puts this folder on its PATH. Null
   * until AO has made it.
   */
  function aoShimFolder() {
    const executable = path.resolve(resourceRoot, process.platform === "win32" ? "ao-daemon.exe" : "ao-daemon");
    const folder = path.join(dataRoot, "runtime", "ao-path", crypto.createHash("sha256").update(executable).digest("hex").slice(0, 32));
    return fs.existsSync(path.join(folder, process.platform === "win32" ? "ao.cmd" : "ao")) ? folder : null;
  }

  return { call, start, stop, show, hide, snapshot, harness, survivingChatHosts, aoShimFolder };
}

/**
 * The context reading the meter shows for a session. A steer interrupts the model's request before
 * its final usage arrives, and Claude Code then reports the request's opening snapshot, which a
 * translated (non-Anthropic) CPA stream gives as zero input: the meter dropped to nothing after
 * every steer, and briefly at the start of each request. A reading that falls below a quarter of
 * the last one with no compaction in between is that snapshot, so the last reading stands; a
 * compaction (compactedAt moved) is a real drop. readings: id -> { usage, compactedAt }.
 */
function steadyContext(readings, id, usage, compactedAt) {
  const previous = readings.get(id);
  const used = Number(usage?.contextUsed), before = Number(previous?.usage?.contextUsed);
  if (usage && previous && previous.compactedAt === compactedAt && Number.isFinite(before) && before > 0
    && (!Number.isFinite(used) || used < before / 4)) {
    const held = { ...usage, contextUsed: before, contextWindow: usage.contextWindow || previous.usage.contextWindow };
    // The same snapshot zeroes the token counts too (the meter read In 0 · Out 0 · Total 0 beside a
    // $6.40 cost): a count it reports as nothing keeps the last reading's.
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "totalTokens"]) {
      if (!(Number(held[key]) > 0) && Number(previous.usage[key]) > 0) held[key] = previous.usage[key];
    }
    return held;
  }
  // The token counts are the session's running totals, which never go down. An older AO replaced
  // them with each ACP prompt's own (zero for one that reported none) while the context reading
  // stayed put, so the meter showed 43% beside In 0 · Out 0 · Total 0 and saved that as the last
  // good reading. A count lower than the last one is kept at the last one.
  let steady = usage;
  if (usage && previous) {
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "totalTokens"]) {
      if (Number(previous.usage[key]) > (Number(steady[key]) || 0)) steady = { ...steady, [key]: previous.usage[key] };
    }
  }
  if (steady && Number.isFinite(used) && used > 0) {
    readings.delete(id);
    readings.set(id, { usage: steady, compactedAt });
    if (readings.size > 64) readings.delete(readings.keys().next().value);
  }
  return steady;
}

module.exports = { steadyContext, agentCatalog, createAgentOrchestratorUpstream, createAgentInventory, API_OPERATIONS };

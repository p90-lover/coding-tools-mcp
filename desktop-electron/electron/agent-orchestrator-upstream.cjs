"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { createAgentOrchestratorGateway } = require("./agent-orchestrator-gateway.cjs");
const { createAoWorkspaceBoard } = require("./agent-orchestrator-workspace.cjs");
const { MAX_RESPONSE_BYTES } = require("./ipc-schema.cjs");
const { readCpaCatalog, collectMissionAccounting } = require("./agent-orchestrator-accounting.cjs");
const { createAoSessionEvents } = require("./ao-session-events.cjs");
const { createAoDependencyLinks } = require("./ao-dependency-links.cjs");
const { createDaemonLogFilter } = require("./ao-daemon-log.cjs");
const { compactAoDatabase } = require("./ao-db-maintenance.cjs");
const { readContextBreakdown } = require("./ao-context-breakdown.cjs");
const { withAgentShellCommands, utf8Suffix, CONVERSATION_LIMITS: AGENT_SHELL_CONVERSATION_LIMITS } = require("./chat-agent-shell.cjs");
const { windowsChildEnvironment, systemEnvironment } = require("./chat-sandbox.cjs");
const { terminateOwnedProcessTreeAsync } = require("./process-tree.cjs");
const { warmProgram } = require("./off-thread-run.cjs");

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
// How much of a tool call's arguments and of what came back its row carries (toolDetails). At 1 KB
// and 2 KB a file's contents or a search's matches stopped a few lines in.
const TOOL_INPUT_BYTES = 4 * 1024;
const TOOL_OUTPUT_BYTES = 16 * 1024;
// How much of AO's recent meaningful output stays in memory.
const DAEMON_LINES_CHARS = 64 * 1024;
// The largest AO reply the main process reads. At 900 KB two screenshot reads (~1 MB each, the
// image kept twice as base64) among a chat's newest items failed every conversation read, so a
// pending approval behind them never showed and a long task sat "may be stuck" for hours. Replies
// stay in the main process: what reaches the window is the trimmed timeline, under IPC's own cap.
const AO_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const INLINE_BLOB_MIN = 16 * 1024;
/**
 * Replaces inline base64 blobs (a screenshot a tool returned) in a conversation reply with a short
 * note, including ones inside a JSON-encoded output string. Nothing in the app shows them, and
 * older AO builds stored them whole; newer ones drop them before storing.
 */
function dropInlineBlobs(value) {
  const blob = text => text.length >= INLINE_BLOB_MIN
    && /^(data:[\w.+/-]+;base64,)?[A-Za-z0-9+/_=-]+$/.test(text.slice(0, 4096)) && /^[A-Za-z0-9+/_=-]*$/.test(text.slice(-4096));
  const shrink = text => {
    if (text.length < INLINE_BLOB_MIN) return text;
    if (blob(text)) return `[${text.length >> 10} KB of inline binary data not shown]`;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const nested = JSON.parse(text);
        if (walk(nested)) return JSON.stringify(nested);
      } catch {}
    }
    return text;
  };
  const walk = node => {
    let changed = false;
    if (!node || typeof node !== "object") return false;
    for (const key of Object.keys(node)) {
      const item = node[key];
      if (typeof item === "string") {
        const next = shrink(item);
        if (next !== item) { node[key] = next; changed = true; }
      } else if (item && typeof item === "object" && walk(item)) changed = true;
    }
    return changed;
  };
  walk(value);
  return value;
}

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
// How long a started AO daemon that is still running may take to answer /readyz (see start).
const AO_READY_TIMEOUT_MS = 90_000;
// To profile AO's CPU on a user's machine: a one-line "pprof-addr" file in AO's data folder holding
// a loopback host:port turns on AO's pprof listener (AO_PPROF_ADDR) at its next start. Without it AO
// starts as before; the app clears AO_* from its own environment, so this is the only switch.
const PROFILER_FILE = "pprof-addr";
async function profilerAddress(dataRoot) {
  let text = "";
  try { text = (await fs.promises.readFile(path.join(dataRoot, PROFILER_FILE), "utf8")).trim(); } catch { return ""; }
  return /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(text) ? text : "";
}

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

/** A Windows command line split into its arguments (double quotes group, as the C runtime reads it). */
function commandLineArgs(line) {
  const args = [];
  let current = "", quoted = false, started = false;
  for (const character of String(line ?? "")) {
    if (character === "\"") { quoted = !quoted; started = true; }
    else if (!quoted && /\s/.test(character)) { if (started) args.push(current); current = ""; started = false; }
    else { current += character; started = true; }
  }
  if (started) args.push(current);
  return args;
}

/**
 * The session a process serves when it is a chat host of this data root (`ao-daemon chat-host
 * <session> <dataRoot> ...`), else null. Only these are ended at quit: the data root in the
 * command line keeps another install's or a development AO's hosts out.
 */
function chatHostSession(commandLine, dataRoot) {
  const [, mode, session, root] = commandLineArgs(commandLine);
  if (mode !== "chat-host" || !session || !root) return null;
  const same = (left, right) => {
    const plain = (value) => path.resolve(value).toLowerCase();
    if (plain(left) === plain(right)) return true;
    try { return plain(fs.realpathSync.native(left)) === plain(fs.realpathSync.native(right)); } catch { return false; }
  };
  return same(root, dataRoot) ? session : null;
}

/**
 * AO's chat hosts for a data root, as { pid, session }. Windows only (elsewhere none). One
 * PowerShell call, run as a child process the main thread does not wait on.
 */
function chatHostProcesses(dataRoot) {
  if (process.platform !== "win32") return Promise.resolve([]);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "@(Get-CimInstance Win32_Process -Filter \"Name='ao-daemon.exe'\" | ForEach-Object { "
    + "[pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } }) | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 8 << 20 }, (error, stdout) => {
        let rows = [];
        try { if (!error && String(stdout).trim()) rows = [].concat(JSON.parse(String(stdout).trim())); } catch {}
        resolve(rows.flatMap((row) => {
          const session = chatHostSession(row?.commandLine, dataRoot);
          return session && Number.isInteger(row.pid) && row.pid > 0 ? [{ pid: row.pid, session }] : [];
        }));
      });
  });
}

function createAgentOrchestratorUpstream({ resourceRoot, dataRoot, confirm, getWindow, WebContentsView, dialog, shell, openAuth, getWorkspaces, missionCall, getCpaPricesPath = () => null, extraPath = () => null, extraEnv = () => ({}), agentTools = null, userMcpServers = null, cpaQuota = null, cpaUsage = null, logger = console,
  readySlowMs = 30000, readyLimitMs = AO_READY_TIMEOUT_MS }) {
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
  let databaseCompacted = false;
  // Starts in a row that ran out of time getting ready. Each next start waits twice as long (up to
  // four times the limit): on 2026-10-24, after a reboot, AO's first database cleanup read a cold
  // HDD for over a minute while it started. Every start was killed at 90 s, which threw that work
  // away, and the next start began it again, so AO stayed down (five starts in eight minutes).
  let readyTimeouts = 0;
  /**
   * AO's recent meaningful output (no debug lines or quick polls, see ao-daemon-log.cjs), in memory
   * only. AO's output never goes to disk: logs/ao-daemon.log took about 65 MB a day, nearly all of
   * it the chat's conversation polls. When AO exits, the error carries the last of these lines.
   */
  let daemonLines = "";
  const keepDaemonLines = (text) => { daemonLines = (daemonLines + text).slice(-DAEMON_LINES_CHARS); };
  /** Removes the log files an older build wrote. */
  function removeOldDaemonLogs() {
    for (const name of ["ao-daemon.log", "ao-daemon.log.1"]) {
      try { fs.rmSync(path.join(dataRoot, "logs", name), { force: true }); } catch {}
    }
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
    const settled = current => !current || (current.kind && current.kind !== "single_repo") || Boolean(current.config?.workspaceMode);
    // Only a write waits its turn. Seen live: the first launch in a project after the app started
    // waited 19 s behind its dependency-link sync just to read a mode that was already "folder".
    if (settled(project) && project.config || settled((await internalApi("GET", endpoint))?.project)) {
      folderModeChecked.add(project.id);
      return;
    }
    // On the dependency-link sync's queue: both rewrite the whole config.
    await dependencyLinks.exclusive(project.id, async () => {
      const current = (await internalApi("GET", endpoint))?.project;
      if (settled(current)) return;
      const config = current.config && typeof current.config === "object" ? current.config : {};
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

  async function requestApi(method, endpoint, body, { maxBytes, timeoutMs, preserveInlineBlobs = false } = {}) {
    if (state !== "ready") throw new Error("Start the source-integrated AO runtime first");
    if (body?.length > 65536) throw new Error("AO API request exceeds 64 KiB");
    const waitMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : method === "GET" ? 30000 : 180000;
    const response = await fetch(`http://127.0.0.1:${daemonPort}${endpoint}`, { method, headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(waitMs) });
    const text = await response.text();
    // A conversation read is trimmed below before anything uses it, so it may arrive larger; every
    // other AO call keeps the 900 KB limit.
    const conversation = /\/conversation(\?|$)/.test(endpoint);
    const limit = maxBytes ?? (conversation ? AO_RESPONSE_MAX_BYTES : 900000);
    if (Buffer.byteLength(text) > limit) throw new Error(`AO response exceeds the handler limit (${method} ${endpoint.split("?")[0]})`);
    // AO answers some failures with an empty or non-JSON body; keep the status instead of
    // failing on JSON.parse and losing it.
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = response.ok ? {} : { error: { message: text.slice(0, 300) } }; }
    }
    if (conversation && !preserveInlineBlobs) dropInlineBlobs(data);
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
    try { address = JSON.parse(await fs.promises.readFile(path.join(dataRoot, "chat-hosts", sessionId(id), "host.json"), "utf8")).address; }
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
   * Whether the chat host recorded for an AO session is known to be up: its record is there and its
   * loopback address accepts a connection. A host deletes its record when its agent exits, so a
   * missing record is not alive (unlike chatHostGone, which asks the opposite question). A probe
   * that times out on a busy machine counts as alive: the card is checked again on the next read.
   */
  async function chatHostAlive(id) {
    let address;
    try { address = JSON.parse(await fs.promises.readFile(path.join(dataRoot, "chat-hosts", sessionId(id), "host.json"), "utf8")).address; }
    catch { return false; }
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(String(address));
    if (!match) return false;
    return new Promise(resolve => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(match[1]) });
      const settle = alive => { socket.destroy(); resolve(alive); };
      socket.setTimeout(1500, () => settle(true));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
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
  /**
   * Ends every chat host of this data root, each with its agent (the ACP runtime and the model
   * CLI). Hosts outlive AO by design, for a restart to reattach, so quitting the app left every
   * chat's agent running: three from earlier runs, the oldest four days old, on 2026-10-28.
   */
  async function endChatHosts() {
    const hosts = (await chatHostProcesses(dataRoot)).filter(host => host.pid !== child?.pid);
    const outcomes = await Promise.allSettled(hosts.map(host =>
      terminateOwnedProcessTreeAsync({ pid: host.pid, exitCode: null, signalCode: null })));
    const ended = outcomes.filter(outcome => outcome.status === "fulfilled").length;
    if (hosts.length) logger?.info?.("ao.chat_hosts_ended", { ended, failed: hosts.length - ended });
    return ended;
  }
  // continuable() checks in flight, by session (see there).
  const continuing = new Map();
  // "exited" chat sessions already exited again this run to stop a leftover host (idleChatSessions).
  const exitedReleased = new Set();
  /**
   * The newest items of a session's conversation. AO counts messages and tool activities alike,
   * and a tool's output can be tens of KB (an MCP browser tool's page dumps), so 100 items reached
   * 1 MB and every poll failed on the response limit. A response that is too big is read again
   * with fewer items; the chat shows only the newest 40 anyway.
   */
  // One read serves every caller for a moment. The chat (every second), the mission controller and
  // the approval screen each read the same session's tail; with a busy chat that was 2 reads a
  // second of ~500-700 KB each (58 MB a minute through the main process). Concurrent callers share
  // the read in flight, and a result serves callers for TAIL_FRESH_MS; `maxAgeMs` lets a caller
  // that knows the session is idle take an older one.
  const TAIL_FRESH_MS = 900;
  // A slow read stays fresh three times as long as it took, up to this. Seen live on 0.8.5: one
  // working session's 507 KB tail took ~620 ms to serve; counted from when the read began, a result
  // served only ~280 ms after it landed, so that session was read back to back and kept AO at
  // 30-110% of a core. Light sessions (25 ms) keep their one-second updates.
  const SLOW_TAIL_FRESH_MAX_MS = 3000;
  const SLOW_TAIL_MS = 150; // a read slower than this is a slow one
  const IDLE_TAIL_MS = 30_000;
  const tailReads = new Map(); // `${id}|${limits}` -> { read, landedAt (null in flight), fresh }
  // A read in flight is always shared; a landed one serves for the caller's age or its own `fresh`.
  const servesFor = (entry, maxAgeMs) => entry.landedAt === null
    || Date.now() - entry.landedAt < Math.max(maxAgeMs, entry.fresh);
  function conversationTail(id, limits = [100, 40, 10], { maxAgeMs = TAIL_FRESH_MS } = {}) {
    const key = `${id}|${limits.join(",")}`;
    const known = tailReads.get(key);
    if (known && servesFor(known, maxAgeMs)) return known.read;
    // A fresh read of more items serves a smaller ask too: a working chat's run loop reads 100
    // items each second and its Terminal pane 60 every two, the same session's tail twice over.
    for (const [other, entry] of tailReads) {
      if (other.startsWith(`${id}|`) && Number(other.slice(id.length + 1).split(",")[0]) >= limits[0]
        && servesFor(entry, maxAgeMs)) return entry.read;
    }
    const startedAt = Date.now();
    const read = readConversationTail(id, limits);
    const entry = { read, landedAt: null, fresh: 0 };
    tailReads.set(key, entry);
    read.then(() => {
      entry.landedAt = Date.now();
      const took = entry.landedAt - startedAt;
      entry.fresh = took > SLOW_TAIL_MS ? Math.min(SLOW_TAIL_FRESH_MAX_MS, 3 * took) : 0;
    }, () => { if (tailReads.get(key)?.read === read) tailReads.delete(key); });
    if (tailReads.size > 128) tailReads.delete(tailReads.keys().next().value);
    return read;
  }
  /** After the app changes a session (a message, an answer, a stop), its next read is a fresh one. */
  function forgetTail(id) {
    for (const key of tailReads.keys()) if (key.startsWith(`${id}|`)) tailReads.delete(key);
  }
  async function readConversationTail(id, limits) {
    const tooLarge = error => /exceeds the handler limit/.test(String(error?.message));
    // Down to 3 items and then 1 past the caller's own sizes: one item can be over the limit by
    // itself. Seen live: a 1.3 MB MCP page dump among the newest 10 failed every read, so a pending
    // approval behind it never showed, nobody answered it, and the chat sat "may be stuck" for 3 hours.
    const smallest = limits[limits.length - 1];
    const tiny = [3, 1].filter(size => size < smallest);
    // includePending: a request still waiting on an answer is always in the page, however much
    // came after it; one that fell out of the newest items never showed and sat until it timed out.
    // trimLargeFields: AO cuts any detail string over 64 KB to its first 2 KB and last 16 KB, all
    // the chat (2 KB of a tool's output) and Terminal pane (16 KB of a command's) show. Screenshot
    // data made one poll of a chat 3.5 MB; ten recent chats' pages went from 8.8 MB to 2.9 MB.
    // Edit sources and prose are never cut. An AO without it ignores the parameter.
    const pending = async (size, options) => internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=${size}&includePending=1&trimLargeFields=1`, undefined, options);
    for (const size of limits) {
      try { return await pending(size); } catch (error) { if (!tooLarge(error)) throw error; }
    }
    // Over the limit at every size the caller asked for: a finished tool call's stored result can be
    // megabytes on its own (screenshot data: two 1.3 MB calls among a chat's newest 20 items, seen
    // live), and the chat showed none of its work for hours. The page is read once with room for
    // them and their big fields are cut (compactConversation), so the chat keeps its recent work
    // rather than only the newest item or three; the chat never shows those bytes.
    try {
      return compactConversation(await pending(smallest, { maxBytes: CONVERSATION_COMPACT_READ_BYTES }));
    } catch (error) { if (!tooLarge(error)) throw error; }
    for (const size of tiny) {
      try { return await pending(size); } catch (error) { if (!tooLarge(error)) throw error; }
    }
    // A pending item is in every page, so one that is itself over the limit (a stuck 1 MB screenshot
    // call, seen live) failed every read: the chat stopped updating and Stop could not be confirmed.
    // The newest items alone are read instead.
    let failure;
    for (const size of [smallest, ...[3, 1].filter(size => size < smallest)]) {
      try { return await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=${size}`); }
      catch (error) { if (!tooLarge(error)) throw error; failure = error; }
    }
    throw failure;
  }
  /**
   * A conversation page with every string over COMPACT_FIELD_CHARS inside an activity's detail
   * replaced by a short note of its size. The chat reads an activity's text output (toolDetails
   * keeps 2,000 characters of it) and never its image data.
   */
  const CONVERSATION_COMPACT_READ_BYTES = 32 * 1024 * 1024;
  const COMPACT_FIELD_CHARS = 64 * 1024;
  // An edit's diff and its added/removed counts are computed from these (editedFiles): cut, an
  // edit to a large file past its first 2,000 characters read as no change at all.
  const EDIT_SOURCE_FIELDS = new Set(["oldText", "newText", "old_string", "new_string", "patch", "diff"]);
  function compactConversation(conversation) {
    const cut = (value, depth = 0, key = "") => {
      if (typeof value === "string") {
        return value.length > COMPACT_FIELD_CHARS && !EDIT_SOURCE_FIELDS.has(key)
          ? `${value.slice(0, 2000)}… [${value.length - 2000} characters omitted]` : value;
      }
      if (!value || typeof value !== "object" || depth > 12) return value;
      if (Array.isArray(value)) return value.map((item) => cut(item, depth + 1));
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, cut(item, depth + 1, field)]));
    };
    if (!conversation || !Array.isArray(conversation.activities)) return conversation;
    return { ...conversation, activities: conversation.activities.map((activity) => (activity && typeof activity === "object"
      ? { ...activity, ...(activity.detail !== undefined ? { detail: cut(activity.detail) } : {}),
        ...(typeof activity.commandOutput === "string" ? { commandOutput: cut(activity.commandOutput) } : {}),
        ...(typeof activity.streamedText === "string" ? { streamedText: cut(activity.streamedText) } : {}) }
      : activity)) };
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
  // Callers of a working chat's observe() (the run loop, the chat's activity poll and its follow-ups,
  // the approval screen, the panel's status poll) share one tail read, but each built its timeline
  // again: ~13 ms of main-thread work per call on a 100-item tail, several calls a second for each
  // chat on screen. Seen 2026-10-22: the main process at 70-100% of a core with two working chats
  // open, 7% once the window was hidden. A page is never changed once read, so its timeline is
  // built once per turn; each caller gets its own array of the shared (read-only) items.
  const builtTimelines = new WeakMap(); // conversation page -> Map(`${turnId}|${turnOver}` -> items)
  function sharedTurnTimeline(conversation, turnId, turnOver) {
    if (!conversation || typeof conversation !== "object") return turnTimeline(conversation, turnId, turnOver);
    let built = builtTimelines.get(conversation);
    if (!built) builtTimelines.set(conversation, built = new Map());
    const key = `${turnId}|${turnOver}`;
    if (!built.has(key)) built.set(key, turnTimeline(conversation, turnId, turnOver));
    return built.get(key).slice();
  }
  /**
   * The page of a session's conversation before `beforeSequence`. A page over the handler limit
   * (a command's long output, a screenshot) is read again smaller; one item over it on its own is
   * stepped past. Those failures used to end the read, and a finished turn lost every tool call
   * before its last page: its work showed only its final thought.
   */
  async function conversationPageBefore(id, beforeSequence) {
    for (const limit of [60, 20, 5, 1]) {
      try {
        return await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=${limit}&beforeSequence=${beforeSequence}`);
      } catch (error) {
        if (!/exceeds the handler limit/.test(String(error?.message))) return null;
      }
    }
    return { messages: [], activities: [], hasMoreBefore: beforeSequence > 1, oldestSequence: beforeSequence - 1 };
  }
  /**
   * A finished turn's transcript, read back from AO for the chat's folded "Worked" row. AO keeps
   * the whole conversation; an earlier turn is found by paging back (beforeSequence), stopping once
   * a page reaches a turn before it or enough of this turn is in hand (the chat keeps its newest
   * TIMELINE_ITEMS). A long turn spans many pages: six were too few for one of twenty minutes.
   */
  async function pastTurnTimeline(id, turnId, pages = 80) {
    let conversation = await conversationTail(id, [60, 20]);
    const merged = { messages: [], activities: [] };
    let mine = 0;
    for (let page = 0; conversation && page < pages; page += 1) {
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const activities = Array.isArray(conversation.activities) ? conversation.activities : [];
      merged.messages.push(...messages);
      merged.activities.push(...activities);
      mine += [...messages, ...activities].filter(entry => entry.turnId === turnId).length;
      const oldest = [...messages, ...activities].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))[0];
      if (mine && oldest && oldest.turnId !== turnId) break;
      if (mine >= TIMELINE_ITEMS) break;
      if (!conversation.hasMoreBefore || !(Number(conversation.oldestSequence) > 0)) break;
      conversation = await conversationPageBefore(id, Number(conversation.oldestSequence));
    }
    // An earlier turn has ended; a message AO left flagged as streaming is its final text.
    return turnTimeline(merged, turnId, true);
  }
  // Finished turns are read back PAST_TURN_READS at a time, and a turn asked again while its read is
  // in flight shares it. Opening a chat opens every finished card's work at once, and each read
  // pages back through AO one request after another: a burst of them took all 16 of the headless
  // service's request slots, and every chat poll in that moment failed "HEADLESS_CAPACITY: request
  // admission is full" (seen live on 0.8.29, 12 failures in two seconds).
  const PAST_TURN_READS = 3;
  const pastTurnReads = new Map(); // `${id}|${turnId}` -> read in flight
  const pastTurnWaiting = [];
  let pastTurnActive = 0;
  const pastTurnSlot = () => {
    if (pastTurnActive < PAST_TURN_READS) { pastTurnActive += 1; return Promise.resolve(); }
    return new Promise(resolve => pastTurnWaiting.push(resolve));
  };
  // A freed slot passes straight to the next read waiting, oldest first.
  const releasePastTurnSlot = () => {
    const next = pastTurnWaiting.shift();
    if (next) next(); else pastTurnActive -= 1;
  };
  // A full service is waited out, keeping the slot. On 0.8.30's first start (2026-10-28) the chat
  // polls filled the headless service, one chat's shared tail read was turned away, and all 23 of
  // its queued cards failed with it inside 10 ms; the chat never asks again, so their Worked rows
  // stayed empty.
  const PAST_TURN_RETRY_MS = [1000, 2000, 4000];
  const serviceFull = error => error?.status === 503
    || /HEADLESS_CAPACITY|SERVICE_UNAVAILABLE/.test(String(error?.message));
  async function patientPastTurnTimeline(id, turnId) {
    for (const wait of [...PAST_TURN_RETRY_MS, null]) {
      try { return await pastTurnTimeline(id, turnId); }
      catch (error) {
        if (wait === null || !serviceFull(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  function queuedPastTurnTimeline(id, turnId) {
    const key = `${id}|${turnId}`;
    const known = pastTurnReads.get(key);
    if (known) return known;
    const read = pastTurnSlot().then(() => patientPastTurnTimeline(id, turnId).finally(releasePastTurnSlot));
    pastTurnReads.set(key, read);
    read.finally(() => pastTurnReads.delete(key)).catch(() => undefined);
    return read;
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
   * shows already), what came back, and any images it returned. Capped: every working card's
   * timeline is polled, so an image goes by the path Claude Code saved it to, and the chat reads it
   * only when its row is opened.
   *
   * An image result (preview_screenshot, Read of a picture) left the row empty: AO's `output` for it
   * is the provider's JSON with the picture as base64, and that was shown before the readable text
   * (the page's url and title) that the call's content carries.
   */
  function toolDetails(detail, input) {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    const { command: _command, description: _description, ...rest } = input;
    const args = Object.keys(rest).length ? utf8Prefix(JSON.stringify(rest, null, 2), TOOL_INPUT_BYTES) : "";
    const texts = [], images = [];
    let unsaved = 0;
    for (const entry of Array.isArray(detail.content) ? detail.content : []) {
      const part = entry?.content && typeof entry.content === "object" ? entry.content : entry;
      if (part?.type === "image") { unsaved += 1; continue; }
      if (typeof part?.text !== "string") continue;
      // Claude Code saves each image a tool returns and says where; that line becomes the picture.
      const kept = part.text.replace(/^\[Image: source: (.+?)\]\s*$/gm, (_line, file) => {
        if (images.length < 4 && file.length <= 1000) images.push(file.trim());
        return "";
      });
      if (kept.trim()) texts.push(kept.trim());
    }
    unsaved = Math.max(0, unsaved - images.length);
    const fromContent = texts.join("\n");
    const raw = typeof detail.output === "string" ? detail.output.trim() : "";
    // An image result's own `output` can be the provider's JSON around the picture (its data cut to a
    // note by dropInlineBlobs); its readable text is then the content's. A plain-text output (a tool
    // saying what it captured) is kept.
    const pictureJson = /^[[{]/.test(raw) && /"(source|data|mimeType)"\s*:/.test(raw);
    const output = (unsaved || images.length) ? fromContent || (pictureJson ? "" : raw) : raw || fromContent;
    const shown = output || (unsaved ? `[${unsaved === 1 ? "An image" : `${unsaved} images`} came back that the agent's tool did not save]` : "");
    return {
      ...(description ? { description: utf8Prefix(description, 200) } : {}),
      ...(args ? { input: args } : {}),
      ...(shown ? { output: utf8Prefix(shown, TOOL_OUTPUT_BYTES) } : {}),
      ...(images.length ? { images } : {}),
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
  // redact_message's arguments are the secrets it hides: its row shows the label and how many,
  // never the strings, or the key the message no longer shows stayed readable under Worked (Codex
  // review of #653). Live polls and finished-turn reads both build their rows here.
  const REDACT_TOOL = /(^|__)redact_message$/;
  function hiddenSecretsInput(input) {
    const count = Array.isArray(input.secrets) ? input.secrets.length : 0;
    return { ...(typeof input.label === "string" ? { label: input.label.slice(0, 40) } : {}),
      secrets: `${count} hidden (not shown)` };
  }
  function timelineActivity(activity) {
    const given = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
    const redacting = activity.activityKind === "mcp_tool" && REDACT_TOOL.test(String(given.toolName || ""));
    const givenInput = given.input && typeof given.input === "object" ? given.input : {};
    const input = redacting ? hiddenSecretsInput(givenInput) : givenInput;
    const detail = redacting ? { ...given, input } : given;
    const base = { id: String(activity.id), sequence: Number(activity.sequence) || 0, status: String(activity.status || "").slice(0, 32) };
    const summary = redacting ? "Hide secrets in the user's messages" : String(activity.summary || "");
    // The timeout a tool call states for itself (Claude Code's Bash/PowerShell `timeout`), so the run
    // loop can tell a long call still within it from one whose result never came back.
    const stated = Number(input.timeout);
    const timeout = Number.isFinite(stated) && stated > 0 ? { timeoutMs: Math.min(stated, 24 * 3600_000) } : {};
    // A file edit shows as Claude Code shows one: "Edited <file> +12 −3", opening on the diff.
    const edit = editedFiles(activity, detail, input);
    if (edit) return { ...base, kind: "edit", label: edit.label, text: utf8Prefix(edit.files.map(file => file.path).join(", "), 400), files: edit.files };
    // A shell call (Bash, PowerShell) shows as the command it ran, like Codex.
    if (activity.activityKind === "mcp_tool" && typeof input.command === "string" && input.command.trim()) {
      return { ...base, kind: "command", text: utf8Prefix(input.command.trim(), 400), ...toolDetails(detail, input), ...timeout };
    }
    if (activity.activityKind === "mcp_tool") {
      return { ...base, kind: "tool", label: toolLabel(detail, summary), text: utf8Prefix(summary || detail.toolKind || "tool", 400),
        ...toolDetails(detail, input), ...timeout };
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
    // An answered request or question keeps AO's request id: the workflow knows who answered it (its
    // reviewer, "Approve for me" or the person, and what they chose), and the chat shows that.
    const request = (activity.activityKind === "approval" || activity.activityKind === "user_input") && typeof activity.requestId === "string"
      ? { requestId: activity.requestId.slice(0, 200) } : {};
    return { ...base, kind: activity.activityKind.slice(0, 32), text: utf8Prefix(summary || activity.activityKind, 400), ...request };
  }
  /**
   * The session's tool requests waiting on an answer (Claude Code's ACP permission requests, parked
   * by AO). Each keeps AO's request id and the provider's own offered decisions, so an answer is
   * always one of those; a Bash call is a "command", other tools a "permission".
   */
  async function pendingApprovals(id, conversation) {
    return (await Promise.all((Array.isArray(conversation?.activities) ? conversation.activities : [])
      .filter(activity => activity.activityKind === "approval" && activity.status === "pending" && typeof activity.requestId === "string")
      .map(async activity => {
        const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
        let input = detail.input && typeof detail.input === "object" ? detail.input : {};
        // Polls keep tool history small. A permission prompt needs the exact input, including the
        // middle AO omitted or inline data the shared read replaced. Read only this one activity,
        // never an untrimmed chat tail, and never offer an approval based on a partial request.
        if (/(?:… \[\d+ (?:bytes|characters) omitted\]|\[\d+ KB of inline binary data not shown\])/.test(JSON.stringify(input))) {
          try {
            if (!Number.isSafeInteger(activity.sequence) || activity.sequence < 1 || !Number.isSafeInteger(activity.sequence + 1)
              || typeof activity.id !== "string") throw new Error("The approval has no exact activity cursor");
            const raw = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=1&beforeSequence=${activity.sequence + 1}`,
              undefined, { maxBytes: CONVERSATION_COMPACT_READ_BYTES, preserveInlineBlobs: true });
            const original = (Array.isArray(raw?.activities) ? raw.activities : []).find(item => item.id === activity.id
              && item.requestId === activity.requestId && item.sequence === activity.sequence && item.turnId === activity.turnId
              && item.activityKind === "approval" && item.status === "pending");
            if (!original?.detail?.input || typeof original.detail.input !== "object") throw new Error("The exact pending approval was not returned");
            input = original.detail.input;
          } catch (cause) {
            throw new Error("The full approval input is unavailable. Refresh the chat before reviewing this request.", { cause });
          }
        }
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
        // Its card and the reviewer get the label and a count, never the secrets it hides.
        if (REDACT_TOOL.test(toolName)) input = hiddenSecretsInput(input);
        const arguments_ = Object.keys(input).length ? JSON.stringify(input) : "";
        const rawToolInput = /^mcp__/.test(toolName) ? arguments_ : "";
        // The harness's own tools (Claude Code's Monitor, WebFetch, Skill, and each one it adds later)
        // reached the reviewer as a bare name with nothing to judge, so a new one was answered blind.
        // Their arguments go along whole, including an edit's source beside its file path. A command
        // or plan is still shown by that; the old reviewer bounds remain below, independently of
        // the full text the person can inspect.
        const nativeInput = !rawToolInput && !command && !plan ? arguments_ : "";
        const toolInput = rawToolInput || nativeInput;
        const reviewTruncated = Buffer.byteLength(command, "utf8") > 4000 || Buffer.byteLength(rawToolInput, "utf8") > 1500
          || Buffer.byteLength(nativeInput, "utf8") > 1500
          || Buffer.byteLength(path, "utf8") > 1000 || Buffer.byteLength(String(input.description ?? ""), "utf8") > 500;
        const approval = {
          approval_id: activity.requestId.slice(0, 200), source: "ao", kind: plan ? "plan" : command ? "command" : "permission",
          ...(plan ? { plan } : {}),
          ...(toolInput ? { toolInput } : {}),
          ...(reviewTruncated ? { reviewTruncated: true } : {}),
          ...(typeof activity.createdAt === "string" ? { since: activity.createdAt } : {}),
          ...(command ? { command } : {}), ...(path ? { path: utf8Prefix(path, 1000) } : {}),
          ...(typeof input.description === "string" ? { reason: utf8Prefix(input.description, 500) } : {}),
          // The tool's own name when AO has it; otherwise its summary ("PowerShell") rather than ACP's "other".
          tool: String(detail.toolName || (detail.toolKind && detail.toolKind !== "other" ? detail.toolKind : activity.summary) || "tool").slice(0, 80),
          // An approval AO holds outside a turn has no turnId: the key is left out, since the IPC
          // response schema refuses an undefined value ("pending_approvals[0].turn_id must be a JSON
          // value") and the whole status read failed with it.
          summary: utf8Prefix(String(activity.summary || ""), 500), ...(typeof activity.turnId === "string" ? { turn_id: activity.turnId } : {}),
          decisions,
        };
        if (Buffer.byteLength(JSON.stringify(approval), "utf8") > MAX_RESPONSE_BYTES) {
          throw new Error("The full approval input exceeds the app's response limit and cannot be reviewed here.");
        }
        return approval;
      })))
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
          ...(typeof activity.turnId === "string" ? { turn_id: activity.turnId } : {}), decisions: [],
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

  /**
   * The person's own MCP servers (Plugins > MCPs) for one chat session, after the `taken` ones the
   * app adds itself. Never fails a launch or a resume: without them the agent starts without them.
   */
  function userServers(agent, taken = []) {
    if (!userMcpServers || typeof agent !== "string") return [];
    try { return userMcpServers.forSession(agent, taken); } catch (cause) {
      logger.warn?.("ao.user_mcp_servers_unavailable", { agent, message: String(cause?.message || cause).slice(0, 200) });
      return [];
    }
  }
  // Mission-owned AO calls. The run grant already covers them, so no extra dialog.
  async function internalApi(method, endpoint, body, options) {
    // A write may change what a session read in flight is about to return (sharedObserveRead).
    if (method !== "GET") sharedReads.clear();
    await start();
    const result = await requestApi(method, endpoint, body === undefined ? undefined : JSON.stringify(body), options);
    if (!result.ok) {
      const error = new Error(aoErrorMessage(result));
      error.status = result.status;
      const code = result.data?.code ?? result.data?.error?.code;
      if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)) error.code = code;
      throw error;
    }
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
    if (kept && at - kept.at < PROJECT_BINDING_TTL_MS) return kept.projectId ?? kept.promise;
    // A workspace bound before keeps its project while the binding (git, the dependency-link sync,
    // up to 3 s) is refreshed behind the launch: every send more than a minute after the last one
    // waited for it. A failed refresh or start forgets the binding, so the next one binds afresh.
    const entry = { at, projectId: kept?.projectId ?? null, promise: workspaceBoard.bind(workspaceId).then(binding => {
      if (!binding.projectId) throw new Error("AO harness workers need this workspace to be a git repository registered in AO");
      return binding.projectId;
    }) };
    entry.promise.then(projectId => { entry.projectId = projectId; }, () => forgetProject(workspaceId, entry));
    projectBindings.set(workspaceId, entry);
    return entry.projectId ?? entry.promise;
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
          const servers = tools?.servers ?? [];
          created = await launchSession(mode, mode === "chat" ? [...servers, ...userServers(agent, servers)] : []);
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
        // Through CPA too: the agent sends it in the request body (the workflow's aoLaunchArgs).
        ...(effort ? { effort: String(effort).slice(0, 32) } : {}),
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
      const timeline = sharedTurnTimeline(conversation, turn?.id, turnOver);
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
      // AO drops a session's controller when its agent process exits (seen live 2026-10-22: a
      // MiMo turn whose requests kept failing with 429), but leaves the turn "running" until the
      // daemon restarts. The chat then read "may be stuck" for half an hour, and every steer or
      // Stop hit "the agent controller for this session is not running". The snapshot says so
      // itself (controller "stopped" while nothing is provisioning): the turn is over.
      const agentGone = conversation?.controller === "stopped" && session?.session?.provisionState !== "provisioning";
      const lastFailure = (Array.isArray(conversation?.activities) ? conversation.activities : [])
        .filter(item => item.turnId === turn?.id && item.activityKind === "system" && item.detail?.event === "provider.failure"
          && typeof item.detail.text === "string" && item.detail.text.trim()).at(-1)?.detail.text.trim();
      // A stopped controller alone is not proof: AO drops every controller when it shuts down (an
      // app quit or update), while the chat hosts keep their agents and turns going for the next AO
      // to reattach. Seen live 2026-10-31: three cards read "stopped mid-turn" at a quit and were
      // retried, while two of the turns ran on, so each chat got a needless "you were interrupted"
      // turn queued behind its own. An agent that really exited took its host with it.
      const deadAgent = agentGone && turn?.state === "running" && !(await chatHostAlive(id));
      if (reconciled || deadAgent || ((settling || settled) && await chatHostGone(id))) {
        if (settling) await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/interrupt`, {}).catch(() => undefined);
        return {
          status, turnId: turn.id, turnState: "interrupted",
          error: deadAgent
            ? `The agent's process stopped mid-turn${lastFailure ? ` after: ${utf8Prefix(lastFailure, 160)}` : ""}. Retry or send a message to continue.`
            : "The agent's process ended before it finished (the app restarted); retry this card.",
          needsInput: false, exited: false, agentGone: deadAgent || undefined, answer: "", liveOutput: utf8Prefix(liveOutput, 4096), timeline,
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
      // When the oldest tool call still running began: the model reads a steer only once that call
      // returns, so chat_steer stops one that has run long (a verification run) instead of waiting.
      const toolStarts = (Array.isArray(conversation?.activities) ? conversation.activities : [])
        .filter(item => item.turnId === turn?.id && item.status === "running" && ["command", "file_change", "mcp_tool"].includes(item.activityKind))
        .map(item => Date.parse(item.createdAt ?? "")).filter(Number.isFinite);
      // The same, for the whole session: a message queued behind a long turn (a restart's resume, a
      // goal round) has no activity of its own until that turn ends. Judged alone it read as hung
      // after 10 minutes, and the stall stop interrupted the session, killing the turn doing the
      // work: "AO turn interrupted", then retries (2026-10-31, three Clash chats). The stop judges
      // the session by these instead: its last sign of life and its tool calls in flight, any turn.
      const sessionActivities = Array.isArray(conversation?.activities) ? conversation.activities : [];
      const sessionStamps = [...turns.map(entry => entry?.startedAt),
        ...sessionActivities.filter(item => !retryNotice(item)).map(item => item.updatedAt || item.createdAt),
        ...(Array.isArray(conversation?.messages) ? conversation.messages : []).map(item => item.updatedAt || item.createdAt)]
        .map(value => Date.parse(value ?? "")).filter(Number.isFinite);
      const sessionTools = sessionActivities
        .filter(item => ["running", "pending"].includes(item.status) && ["command", "file_change", "mcp_tool"].includes(item.activityKind))
        .map(item => { const stated = Number(item.detail?.input?.timeout); return Number.isFinite(stated) && stated > 0 ? { timeoutMs: Math.min(stated, 24 * 3600_000) } : {}; });
      return {
        status, turnId: turn?.id, turnState: turn?.state, error: turn?.errorMessage,
        ...(stamps.length ? { lastActivityAt: Math.max(...stamps) } : {}),
        ...(sessionStamps.length ? { sessionActivityAt: Math.max(...sessionStamps) } : {}),
        sessionTools,
        ...(toolStarts.length ? { toolSince: Math.min(...toolStarts) } : {}),
        needsInput: status === "needs_input", exited: ["exited", "terminated"].includes(status),
        // No agent process behind this session (released while idle, or it exited): nothing runs,
        // so a stop has nothing to wait for and a steer nothing to reach.
        ...(agentGone ? { agentGone: true } : {}),
        answer: answer.slice(0, 12000), liveOutput: utf8Prefix(liveOutput, 4096), timeline,
        // A question the agent asked waits like an approval: the chat shows it and the card needs you.
        // With no agent behind the session nothing can take an answer: AO may still list its last
        // request as pending (seen live 2026-10-23: Allow failed twice with "the agent controller
        // for this session is not running"), so no card is shown for it.
        approvals: agentGone ? [] : [...await pendingApprovals(id, conversation), ...pendingInputs(conversation)],
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
        const uncertain = cause => Object.assign(new Error("Couldn't confirm the agent was restored. Retry this chat. No new agent was started."),
          { code: "AO_SESSION_RESTORE_UNCONFIRMED", cause });
        // AO answers 503 SERVICE_UNAVAILABLE while its database is momentarily busy (its one writer),
        // and asks to be retried. Read as "not confirmed", it stopped the agent, resumed it again and
        // then started a fresh one with a summary of the chat (seen live 2026-10-28: a follow-up after a
        // finished chat sat on "reconnecting to the chat's agent" for minutes). It is retried instead.
        const busy = error => error?.status === 503 && error?.code === "SERVICE_UNAVAILABLE";
        const patiently = async call => {
          for (const wait of [500, 1000, 2000, 4000, 8000, null]) {
            try { return await call(); }
            catch (error) { if (!busy(error) || wait === null) throw error; await new Promise(resolve => setTimeout(resolve, wait)); }
          }
        };
        const read = async () => {
          try {
            const record = await patiently(() => internalApi("GET", `/api/v1/sessions/${key}`));
            if (!record?.session) throw uncertain();
            return record.session;
          } catch (error) { if (error.status === 404 && error.code === "SESSION_NOT_FOUND") return null; throw uncertain(error); }
        };
        const invalid = session => !session || session.mode === "tui" || session.isTerminated
          || ["terminated", "killed", "errored"].includes(session.status) || session.provisionState === "failed";
        // Why a chat's follow-up could not continue its agent (and started a fresh one, without what
        // it knew): only "ao.continuation_lost" was logged, which named neither the session nor why.
        const refuse = (why, session, extra = {}) => {
          logger?.info?.("ao.continuable_refused", { session: key, why, ...(session ? { status: session.status ?? null,
            provisionState: session.provisionState ?? null, terminated: session.isTerminated === true } : {}), ...extra });
          return false;
        };
        let session = await read();
        if (invalid(session)) return refuse(session ? "invalid" : "not_found", session);
        if (session.id !== key) throw uncertain();
        // A live chat AO could not reconnect when it started ("unavailable") has no controller, so a
        // message to it fails CHAT_CONTROLLER_NOT_READY. Seen live 2026-10-31: an update restarted AO
        // while the old one still held two chats' agents; the retries went to fresh agents and the old
        // ones ran on, unreachable. Resuming it asks AO to reconnect it, as for an exited one.
        if (session.status !== "exited" && session.statusReadiness !== "unavailable") {
          return (await chatHostGone(key)) ? refuse("host_gone", session) : true;
        }
        const restore = async () => {
          // Startup may already own restoration. A conflict is not readiness: wait for this
          // exact session's observable live state, without issuing a second resume or new launch.
          const renewed = await Promise.resolve().then(() => agentTools?.renew?.(key)).catch(() => null);
          // AO keeps a session's servers only while its daemon runs, so the person's own go in again too.
          const servers = [...(renewed?.servers ?? [])];
          servers.push(...userServers(session.harness, servers));
          let body = servers.length ? { mcpServers: servers } : {};
          // AO answers only once the agent is up. On a busy disk that took 150-180 s (seen live
          // 2026-10-27), and two attempts at the 180 s POST default kept a message "starting" for
          // up to 6 min; past 90 s a fresh agent is quicker.
          const resumeWait = { timeoutMs: 90_000 };
          try {
            let resumed;
            try { resumed = await patiently(() => internalApi("POST", `/api/v1/sessions/${key}/resume-agent`, body, resumeWait)); }
            catch (error) {
              // Only the known old-schema rejection may retry without the optional servers.
              if (!body.mcpServers || !/unknown field [\\"']?mcpServers/.test(String(error?.message))) throw error;
              resumed = await patiently(() => internalApi("POST", `/api/v1/sessions/${key}/resume-agent`, {}, resumeWait));
            }
            if (resumed?.ok !== true) throw uncertain();
          } catch (error) {
            if (["SESSION_NOT_RESTORABLE", "SESSION_TERMINATED", "SESSION_NOT_FOUND"].includes(error.code)) {
              return refuse("restore_refused", session, { code: error.code, message: String(error?.message ?? "").slice(0, 200) });
            }
            if (error.status !== 409 || error.code !== "AGENT_RESUME_IN_PROGRESS") throw uncertain(error);
          }
          const deadline = Date.now() + 30000;
          for (let attempt = 0; attempt < 150 && Date.now() < deadline; attempt++) {
            session = await read();
            if (invalid(session)) return refuse(session ? "invalid_after_restore" : "not_found_after_restore", session);
            if (session.id !== key) throw uncertain();
            // Status is a display value: an idle live agent may show its pull request state.
            const activity = session.activity?.state;
            const live = activity == null
              ? ["idle", "working", "needs_input", "pr_open", "draft", "ci_failed", "review_pending", "changes_requested", "approved", "mergeable", "merged"].includes(session.status)
              : ["idle", "active", "waiting_input", "blocked"].includes(activity);
            if (live && (!session.statusReadiness || session.statusReadiness === "ready") && session.provisionState !== "provisioning"
              && !(await chatHostGone(key))) return true;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw uncertain();
        };
        // An agent that cannot be confirmed back is stopped, not left half-restored: the chat used
        // to fail with "Couldn't confirm the agent was restored" while the agent stayed wherever it
        // got to (seen live 2026-10-24, several chats stuck "Starting"). Stopped, it is resumed once
        // more from a clean exit, keeping the conversation; if that cannot be confirmed either, it
        // is stopped again and the message starts a fresh agent instead of failing.
        for (let attempt = 1; ; attempt++) {
          try { return await restore(); }
          catch (error) {
            if (error?.code !== "AO_SESSION_RESTORE_UNCONFIRMED") throw error;
            const stopped = await this.exitAgent(key).then(() => true, () => false);
            logger?.info?.("ao.restore_unconfirmed", { session: key, attempt, stopped,
              cause: String(error.cause?.message ?? "").slice(0, 200) });
            // One that could not be stopped may still come back: a second agent beside it would
            // split the chat, so the message fails as before.
            if (!stopped) throw error;
            // A resume that ran out of time would only run out again: start the fresh agent now.
            if (error.cause?.name === "TimeoutError") return refuse("restore_timed_out", null, { attempts: attempt });
            if (attempt >= 2) return refuse("restore_unconfirmed_stopped", null, { attempts: attempt });
            session = await read();
            if (invalid(session)) return refuse(session ? "invalid_after_stop" : "not_found_after_stop", session);
            if (session.id !== key || session.status !== "exited") throw uncertain();
          }
        }
      })().finally(() => continuing.delete(key)));
      return continuing.get(key);
    },
    /**
     * Stops a session's agent (its chat host and model process) but keeps the session, worktree and
     * provider conversation; continuable() resumes it on the next message.
     */
    async exitAgent(id) {
      agentTools?.cancelSessionCalls?.(id);
      let outcome;
      // A stop or start already under way holds the agent for a moment. Failing on the first
      // "already exiting" failed the launch that asked, and its retries hit the same lock: 23
      // launches in a row, seen live 2026-10-30. That stop ends in AGENT_EXITED, so wait it out.
      for (let busy = 0; ; busy++) {
        try { outcome = await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/exit-agent`, {}); break; }
        catch (error) {
          if (error?.status === 409 && ["AGENT_EXIT_IN_PROGRESS", "AGENT_RESUME_IN_PROGRESS"].includes(error.code) && busy < 20) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          if (!/\bAGENT_EXITED\b/.test(String(error?.message))) throw error;
          // AO stopped any host the exited session still had; the idle sweep need not ask again.
          exitedReleased.add(String(id));
          if (exitedReleased.size > 2000) exitedReleased.delete(exitedReleased.values().next().value);
          outcome = { ok: true, ...await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`) };
          break;
        }
      }
      if (outcome?.ok !== true || outcome.session?.id !== id || outcome.session?.status !== "exited") {
        throw new Error(`Agent ${id} shutdown is unconfirmed`);
      }
      return { ok: true };
    },
    /**
     * Chat sessions whose agent is up but idle, with their last turn finished at least `idleMs`
     * ago. Sessions that never ran a turn (pre-warmed ones) and terminal sessions are left out.
     */
    async idleChatSessions(idleMs, now = Date.now()) {
      const list = await internalApi("GET", "/api/v1/sessions");
      const sessions = [...(Array.isArray(list?.sessions) ? list.sessions : []), ...(Array.isArray(list?.items) ? list.items : [])];
      // An "exited" chat can still have its agent running: AO marks it exited when the daemon
      // restarts, but its chat host lives on for a reattach that never comes (five such agents held
      // 1.4 GB on 2026-10-21). Exiting it again stops that host (AO's ExitAgent), once per app run.
      const candidates = sessions.filter(session => session?.mode === "chat" && !session.isTerminated
        && (session.status === "idle" || (session.status === "exited" && !exitedReleased.has(String(session.id)))));
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
    /**
     * Chat sessions AO still calls "working" whose agent has done nothing for `quietMs`. A turn that
     * dies with an app or daemon restart leaves its session "working" for good, and its chat host
     * waits for a controller that never comes: neither the idle sweep (idle and exited only) nor AO's
     * reaper (exited only) stopped it. Seen 2026-10-22: two hosts and their agents, quiet 8 hours and
     * a day, while their chats had moved on to new sessions. A working agent reports activity with
     * every tool call; AO's activity time restarts with the host, which only makes it look newer.
     * A chat AO could not reconnect when it started ("unavailable") reaches no one whatever its
     * status, so it is released after the shorter `unavailableMs`; its next message resumes it.
     */
    async quietWorkingChatSessions(quietMs, now = Date.now(), unavailableMs = quietMs) {
      const list = await internalApi("GET", "/api/v1/sessions");
      const sessions = [...(Array.isArray(list?.sessions) ? list.sessions : []), ...(Array.isArray(list?.items) ? list.items : [])];
      return sessions.filter(session => session?.mode === "chat" && !session.isTerminated
        && (session.status === "working" || session.statusReadiness === "unavailable"))
        .filter(session => {
          const at = Date.parse(session.activity?.lastActivityAt ?? "");
          const limit = session.statusReadiness === "unavailable" ? unavailableMs : quietMs;
          return Number.isFinite(at) && now - at >= limit;
        })
        .map(session => String(session.id));
    },
    /**
     * Sessions of these workspaces' AO projects that nobody has used for at least `idleMs`: live
     * (not terminated), not working, not pinned, with no message to them since, or since they were
     * made. AO's board keeps every exited session, so old workers, subagents and replaced chats
     * piled up there (35 over a week old on 2026-10-22). The activity time is no measure of use:
     * it restarts with the daemon.
     */
    async staleSessions(workspaceIds, idleMs, now = Date.now()) {
      const projects = new Set((await Promise.all(workspaceIds.map(id => projectFor(id).catch(() => null)))).filter(Boolean));
      if (!projects.size) return [];
      const list = await internalApi("GET", "/api/v1/sessions");
      const sessions = [...(Array.isArray(list?.sessions) ? list.sessions : []), ...(Array.isArray(list?.items) ? list.items : [])];
      const lastUse = session => Math.max(...[session.lastUserMessageAt, session.createdAt].map(stamp => Date.parse(stamp ?? "")).filter(Number.isFinite));
      return sessions.filter(session => session && projects.has(session.projectId) && !session.isTerminated && session.isPinned !== true
        && !["working", "spawning", "starting"].includes(session.status) && Number.isFinite(lastUse(session)) && now - lastUse(session) >= idleMs)
        .map(session => String(session.id));
    },
    /** Sends a follow-up as a new turn of the same session; AO de-duplicates by client message id. */
    async send(id, text, clientMessageId, { timeoutMs } = {}) {
      forgetTail(id);
      const data = await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/messages`,
        { text: utf8Prefix(String(text), 64 * 1024), ...(clientMessageId ? { clientMessageId: String(clientMessageId).slice(0, 200) } : {}) },
        timeoutMs ? { timeoutMs } : undefined);
      if (typeof data?.turnId !== "string" || !data.turnId) throw new Error("AO did not start a turn for the follow-up");
      return { turnId: data.turnId, state: data.state };
    },
    /**
     * Hands guidance to the running turn at once (ACP steering). If the turn already ended, AO
     * returns the text instead of starting a detached turn, and this reports `steered: false`.
     */
    async steer(id, text, clientMessageId) {
      forgetTail(id);
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
      forgetTail(id);
      const body = action === "accept" && content && typeof content === "object" && !Array.isArray(content) ? { action, content } : { action };
      if (JSON.stringify(body).length > 65536) throw new Error("The answer is too long");
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/inputs/${encodeURIComponent(requestId)}/resolve`, body);
      return { ok: true };
    },
    /** Answers one parked tool request with one of the decisions AO offered for it. */
    async resolveApproval(id, requestId, decisionId) {
      if (typeof requestId !== "string" || !requestId || typeof decisionId !== "string" || !decisionId) throw new Error("Choose an offered decision");
      await internalApi("POST", `/api/v1/sessions/${sessionId(id)}/conversation/approvals/${encodeURIComponent(requestId)}/resolve`, { decisionId });
      forgetTail(id);
      return { ok: true };
    },
    /** A finished turn's reasoning, tool calls and messages (the chat's "Worked" row, opened). */
    async timeline(id, turnId) {
      if (typeof turnId !== "string" || !turnId) return [];
      return queuedPastTurnTimeline(id, turnId);
    },
    async interrupt(id) {
      agentTools?.cancelSessionCalls?.(id);
      forgetTail(id);
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
          return;
        }
        // Not starting and no controller: the agent's process has exited, so nothing is running
        // to interrupt. Asking again threw the same refusal into the chat ("the agent controller
        // for this session is not running") and Stop never finished. One that came up meanwhile
        // is interrupted.
        await interrupt().catch((again) => { if (!/CHAT_CONTROLLER_NOT_READY/.test(String(again?.message))) throw again; });
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
        error: `The terminal agent stopped reporting. It has been idle since ${new Date(lostSince).toISOString()} with no ${TUI_RESULT_FILE}, so send a follow-up to continue in a new session.` };
    }
    if (ended) return { status, turnId: `tui-${id}`, turnState: "failed", error: `The agent's session ended with no ${TUI_RESULT_FILE}`, answer: "", exited: true };
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
      // Asked as a project opens; waiting on git synchronously froze every window for as long as it took.
      const stdout = await new Promise(resolve => execFile("git", ["-C", args.directory, "rev-parse", operation === "check_repository" ? "--is-inside-work-tree" : "--abbrev-ref", ...(operation === "repository_branch" ? ["HEAD"] : [])],
        { encoding: "utf8", timeout: 5000, windowsHide: true }, (failure, output) => resolve(failure ? null : String(output))));
      return operation === "check_repository" ? stdout !== null && stdout.trim() === "true" : stdout === null ? null : stdout.trim();
    }
    if (operation === "open_external") {
      const url = new URL(args.url);
      if (url.protocol !== "https:" || !["github.com", "docs.aoagents.dev"].includes(url.hostname) || url.username || url.password) throw new Error("External destination is not allowed");
      if (await confirm({ message: "Open this external page?", detail: url.toString() })) await shell.openExternal(url.toString());
      return null;
    }
    throw new Error("This desktop operation is unavailable; manage runtime lifecycle from the Coding Tools host bar");
  }

  // { file, size, mtimeMs, digest } of the daemon last hashed. It is kept in dataRoot too, so a
  // launch of the same install does not read the 41 MB file again; an update or a swapped daemon
  // changes its size or time and is hashed anew.
  let verifiedDaemon = null;
  const verifiedDaemonFile = path.join(dataRoot, "daemon-verified.json");
  async function daemonDigest(file) {
    const stat = await fs.promises.stat(file);
    if (!verifiedDaemon) {
      try { verifiedDaemon = JSON.parse(await fs.promises.readFile(verifiedDaemonFile, "utf8")); } catch { /* none yet */ }
    }
    if (verifiedDaemon && verifiedDaemon.file === file && verifiedDaemon.size === stat.size && verifiedDaemon.mtimeMs === stat.mtimeMs
      && typeof verifiedDaemon.digest === "string") {
      return verifiedDaemon.digest;
    }
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      fs.createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
    });
    verifiedDaemon = { file, size: stat.size, mtimeMs: stat.mtimeMs, digest };
    fs.promises.mkdir(dataRoot, { recursive: true, mode: 0o700 })
      .then(() => fs.promises.writeFile(verifiedDaemonFile, JSON.stringify(verifiedDaemon)))
      .catch(() => { /* hashed again next launch */ });
    return digest;
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
        // Read in chunks off the main thread: the 41 MB daemon read in one readFileSync on a busy
        // hard disk froze the whole app for 17-28 s while AO started. A file unchanged since it was
        // verified is not read again.
        const digest = await daemonDigest(executable);
        checkStartup();
        if (digest !== manifest.daemonSha256) throw new Error("AO daemon does not match its build manifest");
        fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
        // Once per app session, before AO opens it: a database that is mostly empty pages gives the
        // space back (ao-db-maintenance.cjs). It runs in a worker, and anything it cannot do is skipped.
        if (!databaseCompacted) {
          databaseCompacted = true;
          // Logged before it runs: a run that hung once left no trace while AO waited on it.
          logger.info?.("ao.database_compaction_started", {});
          const compacted = await compactAoDatabase(dataRoot);
          if (compacted.action !== "none") logger.info?.("ao.database_compacted", compacted);
          checkStartup();
        }
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
        // It may wait briefly (rtk's automatic install), so the start is checked again after it.
        Object.assign(environment, await extraEnv());
        checkStartup();
        const toolBin = extraPath();
        if (toolBin) {
          const pathKey = Object.keys(environment).find(key => key.toUpperCase() === "PATH") || "PATH";
          environment[pathKey] = [toolBin, environment[pathKey]].filter(Boolean).join(path.delimiter);
        }
        // AO hands this environment on to every chat agent and through it to the Git Bash its Bash
        // tool runs: on Windows it carries SystemRoot, TEMP and the rest a process needs to start,
        // and a de-duplicated PATH of bounded length (forks failed with 0xC0000142 without them).
        const daemonEnvironment = windowsChildEnvironment(environment, { system: systemEnvironment() });
        const profiler = await profilerAddress(dataRoot);
        checkStartup();
        if (profiler) logger.info?.("ao.profiler_enabled", { address: profiler });
        // spawn() holds this thread, every window's, until Windows has loaded the program and the
        // antivirus has scanned it: 4.8 s once after a reboot (launcher.main_blocked, 2026-10-30).
        // The daemon's pipes and exit must live here, so its program is run once from a worker
        // first (--help exits at once) and the start below finds it loaded and scanned.
        await warmProgram(executable, ["--help"]);
        checkStartup();
          // The AO CLI build answers the daemon command and the internal commands the daemon
          // relaunches itself with (pty-host, chat-host, agent-process); a daemon-only build cannot.
          child = spawn(executable, ["daemon"], {
          cwd: resourceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...daemonEnvironment, ...(profiler ? { AO_PPROF_ADDR: profiler } : {}), AO_PORT: String(daemonPort), AO_DATA_DIR: dataRoot, AO_RUN_FILE: path.join(dataRoot, "running.json"), AO_ALLOWED_ORIGINS: gatewayOrigin, AO_TELEMETRY_EVENTS: "off", AO_TELEMETRY_METRICS: "off", AO_TELEMETRY_REMOTE: "off", AO_SENTRY_DSN: "",
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
        daemonLines = "";
        removeOldDaemonLogs();
        const daemonOutput = [child.stdout, child.stderr].map((output) => {
          const filter = createDaemonLogFilter(keepDaemonLines);
          output.on("data", (chunk) => {
            logTail = (logTail + chunk.toString()).slice(-16384);
            filter.push(chunk);
          });
          return filter;
        });
        child.once("error", (cause) => { if (child === currentChild && startupGeneration === lifecycleGeneration) { error = cause.message; state = "error"; } });
        child.once("exit", (code) => {
          for (const filter of daemonOutput) filter.flush();
          if (child === currentChild && startupGeneration === lifecycleGeneration) {
            state = "error";
            error = `AO exited (${code})${daemonLines ? `: ${daemonLines.trimEnd().slice(-600)}` : ""}`;
          }
        });
        // A daemon that exits fails at once (checkStartup); one still starting is waited for. 30 s
        // was too short on this machine's HDD: on 2026-10-22, right after an update (with the
        // database compaction running), the first start was given up as "AO readiness timed out",
        // its daemon killed and a new one started from nothing, and the chats that outlived the
        // update were not reattached. Earlier that day AO stayed down 12 minutes (16 such starts).
        // ao.start_slow records how long a slow start really takes, to tell whether the limit fits.
        const startedAt = Date.now();
        const limitMs = readyLimitMs * 2 ** Math.min(readyTimeouts, 2);
        let slowLogged = false;
        while (Date.now() - startedAt < limitMs) {
          checkStartup();
          if (!slowLogged && Date.now() - startedAt >= readySlowMs) {
            slowLogged = true;
            logger.warn?.("ao.start_slow", { waitedMs: Date.now() - startedAt, output: logTail.slice(-300) });
          }
          try {
            const response = await fetch(`http://127.0.0.1:${daemonPort}/readyz`, { redirect: "error", signal: AbortSignal.timeout(1000) });
            checkStartup();
            const ready = await response.json();
            checkStartup();
            if (response.ok && ready.pid === currentChild.pid && ready.status === "ready") { state = "ready"; readyTimeouts = 0; return snapshot(); }
          } catch { checkStartup(); }
          await new Promise((resolve) => setTimeout(resolve, 200));
          checkStartup();
        }
        readyTimeouts += 1;
        // "timed out" keeps TRANSIENT_CHAT_START treating it as a start to retry, not a failure.
        throw new Error(`Agent Orchestrator timed out getting ready. ${logTail.slice(-1500)}`);
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
      if (!await confirm({ message: "Stop Agent Orchestrator?", detail: "Running agent sessions may stop. Your chats stay saved." })) return { ok: true, cancelled: true };
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
      if (!projectId) return { ok: true, available: false, reason: "This project's first chat sets this up. Choose after that." };
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
          if (saved !== args.mode) throw new Error("This Agent Orchestrator can't choose where chats work yet. Update the app.");
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
    // The line under the chat box (the latest turn) and each ended turn's foot (`to`: when it
    // ended): its model requests through CPA (cpa-usage.cjs).
    if (operation === "chat_turn_stats") {
      if (!cpaUsage?.turnStats) return { ok: true, available: false };
      return cpaUsage.turnStats({ model: typeof args.model === "string" ? args.model : "",
        models: Array.isArray(args.models) ? args.models.filter((value) => typeof value === "string").slice(0, 4) : [], from: Number(args.from),
        ...(args.to === undefined ? {} : { to: Number(args.to) }) });
    }
    // A chat's Terminal and Preview panes: the user's view of each card's agent session, through
    // the agent tools server that started its commands and owns its preview (chat-agent-tools.cjs).
    if (operation === "chat_processes") {
      // The commands the app started (exec_command) and the ones the agent ran with its own shell
      // tool, which AO records in the conversation. That read only happens while AO is up (a poll
      // must not start it) and never fails the app's listing.
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter((id) => typeof id === "string").slice(0, 32) : [];
      const app = agentTools?.processes ? await agentTools.processes(ids, typeof args.workspaceId === "string" ? args.workspaceId : null) : [];
      // A chat lists every session it ever had, and the Terminal polls every 2 s: each finished
      // session's whole tail was read again each time. One that is not working cannot change, so a
      // copy up to IDLE_TAIL_MS old serves it; the session record that says so is a 1 KB read.
      const readConversation = state === "ready" ? async (id) => {
        const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`).catch(() => null);
        const working = record?.session?.status === "working";
        return conversationTail(id, AGENT_SHELL_CONVERSATION_LIMITS, { maxAgeMs: working ? TAIL_FRESH_MS : IDLE_TAIL_MS });
      } : null;
      return { ok: true, sessions: await withAgentShellCommands(app, ids, readConversation, logger) };
    }
    if (operation.startsWith("chat_process") || operation.startsWith("chat_preview_")
      || ["chat_terminal_start", "chat_changes", "chat_files", "chat_file"].includes(operation)) {
      if (!agentTools?.processes) throw new Error("The chat agent tools are unavailable");
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter((id) => typeof id === "string").slice(0, 32) : [];
      const pathArgument = (value) => (typeof value === "string" && value.length <= 1024 && !value.includes("\0") ? value : ".");
      switch (operation) {
        case "chat_terminal_start": return agentTools.terminalStart({ sessionId: args.sessionId, workspaceId: args.workspaceId });
        case "chat_changes": return agentTools.changes({ sessionId: args.sessionId, workspaceId: args.workspaceId, summary: args.summary === true });
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
        case "chat_preview_hide": return { ok: true, hidden: agentTools.previewHide(typeof args.sessionId === "string" ? args.sessionId : undefined) !== false };
        // A still of the shown page, drawn in its place while Clawd passes over the pane.
        case "chat_preview_snapshot": return { ok: true, url: await agentTools.previewSnapshot?.(args.sessionId) ?? null };
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

  return { call, start, stop, show, hide, snapshot, harness, survivingChatHosts, endChatHosts, aoShimFolder };
}

/**
 * The context reading the meter shows for a session. A steer interrupts the model's request before
 * its final usage arrives, and Claude Code then reports the request's opening snapshot, which a
 * translated (non-Anthropic) CPA stream gives as zero input: the meter dropped to nothing after
 * every steer, and briefly at the start of each request. A reading that falls below a quarter of
 * the last one with no compaction in between is that snapshot, so the last reading stands; a
 * compaction (compactedAt moved) is a real drop. readings: id -> { usage, compactedAt }.
 */
// The largest context reading still taken for the zero-input opening snapshot below.
const SNAPSHOT_CONTEXT_TOKENS = 32_768;
function steadyContext(readings, id, usage, compactedAt) {
  const previous = readings.get(id);
  const used = Number(usage?.contextUsed), before = Number(previous?.usage?.contextUsed);
  // The snapshot reads as next to nothing; a real smaller context does not. Seen live: a session at
  // 362.9k that really went down to 90.2k (just under a quarter) was held at 362.9k for good.
  if (usage && previous && previous.compactedAt === compactedAt && Number.isFinite(before) && before > 0
    && (!Number.isFinite(used) || used < Math.min(before / 4, SNAPSHOT_CONTEXT_TOKENS))) {
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

module.exports = { steadyContext, agentCatalog, createAgentOrchestratorUpstream, createAgentInventory, API_OPERATIONS, dropInlineBlobs, chatHostSession, chatHostProcesses };

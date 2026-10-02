"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createAgentOrchestratorGateway } = require("./agent-orchestrator-gateway.cjs");
const { createAoWorkspaceBoard } = require("./agent-orchestrator-workspace.cjs");

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

const TUI_RESULT_FILE = "AO_RESULT.md";
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

function createAgentOrchestratorUpstream({ resourceRoot, dataRoot, confirm, getWindow, WebContentsView, dialog, shell, getWorkspaces, missionCall, extraPath = () => null, extraEnv = () => ({}), logger = console }) {
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
  // always denies the new window; this decides whether the URL goes to the system browser.
  async function openTerminalLink(rawUrl) {
    let url;
    try { url = new URL(String(rawUrl || "")); } catch { return false; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
    // Terminal output is untrusted: only the sign-in hosts agy prints open without asking.
    const trusted = url.protocol === "https:" && TRUSTED_TERMINAL_LINK_HOSTS.has(url.hostname);
    if (!trusted && !(await confirm({ message: "Open this link from the terminal?", detail: url.toString() }))) return false;
    await shell.openExternal(url.toString());
    return true;
  }
  const workspaceBoard = typeof getWorkspaces === "function" && typeof missionCall === "function"
    ? createAoWorkspaceBoard({
      listWorkspaces: getWorkspaces, missionCall,
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
    if (Buffer.byteLength(text) > 900000) throw new Error("AO response exceeds the handler limit");
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
  const agentInventory = createAgentInventory(internalApi);
  const harness = Object.freeze({
    async catalog() {
      const [inventory, settings] = await Promise.all([agentInventory(), internalApi("GET", "/api/v1/settings")]);
      const chat = new Set(Array.isArray(settings?.chatHarnesses) ? settings.chatHarnesses : []);
      const installed = new Map((inventory?.installed ?? []).map(item => [item.id, item]));
      return (inventory?.supported ?? []).filter(item => typeof item?.id === "string" && /^[a-z0-9-]{1,40}$/.test(item.id)).map(item => ({
        id: item.id, label: String(item.label || item.id).slice(0, 80),
        installed: installed.has(item.id), authStatus: installed.get(item.id)?.authStatus || "unknown", chat: chat.has(item.id),
      }));
    },
    async models(agent, workspaceId) {
      const projectId = workspaceId ? await projectFor(workspaceId).catch(() => "") : "";
      const catalog = await internalApi("GET", `/api/v1/agents/${agentId(agent)}/models${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
      return (Array.isArray(catalog?.models) ? catalog.models : []).filter(model => typeof model?.id === "string" && model.id.length <= 128)
        .slice(0, 100).map(model => ({ id: model.id, label: String(model.label || model.id).slice(0, 128), isDefault: model.isDefault === true }));
    },
    async spawn({ workspaceId, agent, model, prompt, name, gateway = null }) {
      const projectId = await projectFor(workspaceId);
      const settings = await internalApi("GET", "/api/v1/settings");
      // Chat-capable agents return their answer as a conversation turn. Every other
      // installed agent runs in its own terminal UI and hands back a result file.
      const chat = Array.isArray(settings?.chatHarnesses) && settings.chatHarnesses.includes(agentId(agent));
      // AO caps prompts at 16 KiB of UTF-8; leave room for the TUI result instruction.
      const brief = utf8Prefix(prompt, 16384 - Buffer.byteLength(TUI_RESULT_INSTRUCTION, "utf8") - 2);
      const launch = (mode) => internalApi("POST", "/api/v1/sessions", {
        projectId, kind: "worker", harness: agentId(agent), mode,
        prompt: mode === "chat" ? brief : `${brief}\n\n${TUI_RESULT_INSTRUCTION}`,
        ...(model && model !== "default" ? { model: String(model).slice(0, 256) } : {}),
        // A CPA model runs through the local gateway; AO adds the key from its own environment.
        ...(gateway?.provider === "cpa" && typeof gateway.model === "string" ? { gateway: { provider: "cpa", model: gateway.model.slice(0, 256) } } : {}),
        displayName: String(name || "AO worker").slice(0, 100),
      });
      let data;
      try {
        data = await launch(chat ? "chat" : "tui");
      } catch (error) {
        // Chat mode needs AO's packaged ACP runtime (Claude's chat driver). Without it the agent
        // still runs in its own terminal and hands back a result file.
        if (!chat || !/CHAT_DRIVER_UNAVAILABLE/.test(String(error?.message))) throw error;
        data = await launch("tui");
      }
      return sessionId(data?.session?.id);
    },
    async observe(id) {
      const record = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}`);
      if (record?.session?.mode === "tui") return observeTui(id, record.session.status);
      const [session, conversation] = [record, await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/conversation?limit=100`)];
      const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
      const turn = turns[turns.length - 1];
      const answer = (Array.isArray(conversation?.messages) ? conversation.messages : [])
        .filter(message => message.role === "assistant" && message.turnId === turn?.id && !message.streaming)
        .map(message => message.text).join("\n\n").trim();
      const status = session?.session?.status;
      return {
        status, turnId: turn?.id, turnState: turn?.state, error: turn?.errorMessage,
        needsInput: status === "needs_input", exited: ["exited", "terminated"].includes(status),
        answer: answer.slice(0, 12000),
      };
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

  async function observeTui(id, status) {
    const waiting = ["idle", "needs_input"].includes(status);
    const ended = ["exited", "terminated"].includes(status);
    if (!waiting && !ended) return { status, needsInput: false, exited: false, answer: "" };
    let answer = "";
    try {
      const file = await internalApi("GET", `/api/v1/sessions/${sessionId(id)}/workspace/file?path=${encodeURIComponent(TUI_RESULT_FILE)}`);
      if (!file?.deleted && !file?.binary) answer = String(file?.content || "").trim().slice(0, 12000);
    } catch { /* The agent has not written its report yet. */ }
    if (answer) return { status, turnId: `tui-${id}`, turnState: "completed", answer, needsInput: false, exited: ended };
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
    if (operation === "mission_open") {
      if (!workspaceBoard || !["open", "start", "resume", "restart"].includes(args.intent)) throw new Error("Invalid mission navigation request");
      const board = await workspaceBoard.readWorkspace(args.workspaceId, args.runId);
      if (!board.runs.some(run => run.id === args.runId)) throw new Error("Mission is outside this workspace");
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

module.exports = { createAgentOrchestratorUpstream, createAgentInventory, API_OPERATIONS };

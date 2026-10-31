"use strict";
// Computer control for chat agents (Settings > "Let chat agents see and control the screen").
// As in Codex's Computer Use, the agent names the window it needs (computer_select_window) and the
// person is asked once per app, on a card in the asking chat: "Allow <agent> to use <app>?" with
// Always allow, Allow this conversation, or Deny. "Always allow" is kept on disk (Settings >
// Computer use > Always-allowed apps), a conversation's approval for that chat's session. Control
// then acts only on that window, and only while this app's control bar is on screen: headless
// refuses input 3 s after the bar's last heartbeat, and only the app may start control (the local
// UI token). It asked for a window and a duration on the card until 2026-10-31.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HEARTBEAT_MS = 1_000;
// A session's approvals are kept for this many sessions, newest last.
const MAX_CONVERSATIONS = 200;

// Codex's own names for the programs it shows by name; any other is its executable's, capitalised.
const APP_NAMES = Object.freeze({
  "chrome.exe": "Google Chrome", "msedge.exe": "Microsoft Edge", "firefox.exe": "Firefox", "winword.exe": "Microsoft Word",
  "excel.exe": "Microsoft Excel", "powerpnt.exe": "Microsoft PowerPoint", "outlook.exe": "Microsoft Outlook",
  "notepad.exe": "Notepad", "explorer.exe": "File Explorer", "code.exe": "Visual Studio Code", "mspaint.exe": "Paint",
  "calc.exe": "Calculator", "calculatorapp.exe": "Calculator", "windowsterminal.exe": "Windows Terminal",
});

/** The key an app's approval is kept under: its executable's file name, in lower case. */
const appKey = (app) => String(app ?? "").trim().toLowerCase();

/** The name the card shows for an app ("chrome.exe" → "Google Chrome", "blender.exe" → "Blender"). */
function appName(app, title = "") {
  const key = appKey(app);
  if (APP_NAMES[key]) return APP_NAMES[key];
  const base = key.replace(/\.exe$/, "");
  if (!base) return String(title || "this app").slice(0, 80);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * The apps the person allowed: `always` (kept until removed in Settings) and per session (Allow this
 * conversation), and whether any app was ever allowed (Codex shows its first-use notice until then).
 * Kept in a small JSON file so it survives restarts; without one (tests) it lives in memory.
 */
function createAppApprovals({ file = null, now = Date.now } = {}) {
  let state = { always: {}, conversations: {}, approvedOnce: false };
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
        state = { always: object(saved.always), conversations: object(saved.conversations), approvedOnce: saved.approvedOnce === true };
      }
    } catch { /* Nothing allowed yet. */ }
  }
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, file);
  };
  return {
    approvedOnce: () => state.approvedOnce,
    /** Whether `app` may be used by the chat whose session is `conversation`. */
    allowed(app, conversation) {
      const key = appKey(app);
      return Boolean(key) && (Boolean(state.always[key]) || (state.conversations[conversation] ?? []).includes(key));
    },
    allow(app, conversation, mode = "conversation") {
      const key = appKey(app);
      if (!key) throw new Error("This window's program is not known, so it cannot be allowed");
      if (mode === "always") state.always[key] = { name: appName(key), at: now() };
      else {
        const list = state.conversations[conversation] ?? [];
        if (!list.includes(key)) list.push(key);
        delete state.conversations[conversation];
        state.conversations[conversation] = list;
        const keys = Object.keys(state.conversations);
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CONVERSATIONS))) delete state.conversations[old];
      }
      state.approvedOnce = true;
      persist();
    },
    /** Settings > Computer use > Always-allowed apps. */
    list: () => Object.entries(state.always).map(([key, entry]) => ({ app: key, name: String(entry?.name || appName(key)), at: Number(entry?.at) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    remove(app) {
      const key = appKey(app);
      if (!(key in state.always)) return false;
      delete state.always[key];
      persist();
      return true;
    },
  };
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pageUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const STYLE = `body{font:13px system-ui,"Segoe UI",sans-serif;margin:0;color:#1f1f1f;background:#fff}
@media(prefers-color-scheme:dark){body{color:#ececec;background:#1e1e1e}.row:hover{background:#2a2a2a!important}}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #8884;background:transparent;color:inherit;cursor:pointer}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}button:disabled{opacity:.5;cursor:default}`;

// The bar's Stop tells the app by renaming its page: a data: page never navigates in-page, so a
// hash change there never fired did-navigate-in-page and Stop did nothing (the 0.8.39 picker's
// Start was dead the same way, 2026-10-31). page-title-updated fires for any page, with no preload.
const STOP_TITLE = "stop-computer-control";

/** The bar shown while control is on: what is controlled, time left, and Stop. */
function barPage({ title }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Computer control is on</title><style>${STYLE}
body{display:flex;align-items:center;gap:10px;padding:0 10px;height:100vh;box-sizing:border-box;-webkit-app-region:drag;
border:2px solid #dc2626;border-radius:8px}b{color:#dc2626}span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{-webkit-app-region:no-drag;background:#dc2626;border-color:#dc2626;color:#fff}</style></head>
<body><b>●</b><span>A chat controls “${escapeHtml(title)}” <small id="left"></small></span><button id="stop">Stop</button>
<script>document.getElementById("stop").onclick = () => { document.title = ${JSON.stringify(STOP_TITLE)}; };
window.showLeft = (text) => { document.getElementById("left").textContent = text; };</script></body></html>`;
}

function createComputerControl({ request, BrowserWindow, screen, logger = null, ownPids = () => [process.pid], onRequests = () => undefined,
  approvalsFile = null, now = Date.now }) {
  const approvals = createAppApprovals({ file: approvalsFile, now });
  let bar = null;
  let heartbeat = null;
  // The window control was last started on, by this app ({ window_id, pid, title, app }).
  let controlled = null;
  // The requests waiting for the person: { public, finish, workspace, captureOff, target, conversation }.
  const pending = [];
  // What the chats show: every waiting request (each shows in the chat that asked).
  const requests = () => pending.map((item) => item.public);
  const publish = () => { try { onRequests(requests()); } catch { /* a closed window shows none */ } };

  const status = async () => (await request("/api/v1/computer/status", null, { method: "GET" }))?.status ?? { state: "stopped" };

  function closeBar() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    const open = bar;
    bar = null;
    if (open && !open.isDestroyed()) open.destroy();
  }

  async function stop(reason = "stopped") {
    closeBar();
    controlled = null;
    try { await request("/api/v1/computer/stop", {}); } catch (error) {
      logger?.warn?.("computer.stop_failed", { message: String(error?.message || error).slice(0, 200) });
    }
    logger?.info?.("computer.stopped", { reason });
  }

  // A page of ours that never navigates: every navigation and popup is refused.
  function lockDown(window) {
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  function openBar(title) {
    closeBar();
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(520, area.width);
    bar = new BrowserWindow({
      width, height: 44, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8,
      frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    bar.setAlwaysOnTop(true, "screen-saver");
    lockDown(bar);
    const own = bar;
    own.on("closed", () => { if (bar === own) void stop("control bar closed"); });
    own.webContents.on("page-title-updated", (event, pageTitle) => {
      if (pageTitle !== STOP_TITLE) return;
      event.preventDefault?.();
      if (bar === own) void stop("Stop pressed");
    });
    void own.loadURL(pageUrl(barPage({ title }))).then(() => { if (!own.isDestroyed()) own.showInactive(); });
    // The bar's heartbeat keeps input allowed; a bar hidden or gone sends none, and input stops.
    heartbeat = setInterval(async () => {
      if (bar !== own || own.isDestroyed()) return;
      if (!own.isVisible()) return;
      try {
        const current = (await request("/api/v1/computer/status?heartbeat=true", null, { method: "GET", localConfirmation: true }))?.status;
        if (bar !== own || own.isDestroyed()) return;
        if (!current || current.state === "stopped") { closeBar(); controlled = null; return; }
        const left = Number.isInteger(current.remaining_seconds)
          ? `· ${Math.floor(current.remaining_seconds / 60)}:${String(current.remaining_seconds % 60).padStart(2, "0")} left` : "· until you stop it";
        void own.webContents.executeJavaScript(`window.showLeft(${JSON.stringify(left)})`).catch(() => undefined);
      } catch { /* a missed beat only pauses input; the next one restores it */ }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  /** The windows a chat may ask for, with the program each belongs to; never this app's own. */
  async function targets() {
    const own = new Set(ownPids());
    return ((await request("/api/v1/computer/targets", null, { method: "GET" }))?.targets ?? [])
      .filter((target) => !own.has(target.pid))
      .map((target) => ({ window_id: Number(target.window_id), pid: Number(target.pid), title: String(target.title || "(untitled)"),
        app: appKey(target.app), appName: appName(target.app, target.title) }));
  }

  /**
   * Asks the person whether the chat may use `target`'s app, on a card in that chat (requests(),
   * onRequests) answered with answer(): Codex's "Allow <agent> to use <app>?". Resolves
   * { allowed: true } at once when it already is, else with their answer, or { allowed: false,
   * reason }. A chat asking again for the same app while its card waits shares that card.
   */
  async function askApp({ workspaceId, aoSession = null, agent = "The agent", target, signal = null, risk = "" }) {
    const conversation = `${workspaceId}:${aoSession ?? ""}`;
    if (approvals.allowed(target.app, conversation)) return { allowed: true };
    const joined = pending.find((item) => item.conversation === conversation && item.target.app === appKey(target.app));
    if (joined) return joined.answered;
    const workspaces = (await request("/api/v1/workspaces", null, { method: "GET" }))?.workspaces ?? [];
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { allowed: false, reason: "the chat's project is not registered" };
    const project = workspace.name || workspace.path || workspace.id;
    const captureOff = workspace.screen_capture_enabled !== true && workspace.screenCaptureEnabled !== true;
    let finish;
    const answered = new Promise((resolve) => { finish = resolve; });
    const item = {
      workspace, captureOff, target: { ...target, app: appKey(target.app) }, conversation, answered, starting: false,
      // Plain data only: the chat shows every name and title as text.
      public: Object.freeze({
        id: crypto.randomUUID(), workspaceId, sessions: Object.freeze(aoSession ? [aoSession] : []), agent: String(agent),
        app: appName(target.app, target.title), window: String(target.title || ""), project: String(project), captureOff,
        firstUse: !approvals.approvedOnce(), elevated: risk === "high" || risk === "critical",
        persistModes: Object.freeze(["always", "conversation"]),
      }),
    };
    let done = false;
    item.finish = (answer) => {
      if (done) return;
      done = true;
      signal?.removeEventListener?.("abort", aborted);
      const at = pending.indexOf(item);
      if (at >= 0) { pending.splice(at, 1); publish(); }
      finish(answer);
    };
    const aborted = () => item.finish({ allowed: false, reason: "the chat stopped" });
    signal?.addEventListener?.("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return answered; }
    pending.push(item);
    publish();
    return answered;
  }

  /**
   * The person's answer on a card: { id, decision: "always" | "conversation" | "deny" }. Allowing
   * an app in a project whose screen capture is off turns capture on (the card says so). Resolves
   * { ok: true }, or { ok: false, error } for the card to show while it stays open.
   */
  async function answer(input) {
    const current = pending.find((item) => item.public.id === input?.id);
    if (!current) return { ok: false, error: "This request is no longer waiting" };
    if (input.decision === "deny" || input.cancel === true) { current.finish({ allowed: false, reason: "the user denied it" }); return { ok: true }; }
    if (!["always", "conversation"].includes(input.decision)) return { ok: false, error: "Choose how long to allow it" };
    if (current.starting) return { ok: false, error: "Already allowing it" };
    current.starting = true;
    try {
      if (current.captureOff) {
        const { workspace } = current;
        await request("/api/v1/workspaces/policy", {
          workspace_id: workspace.id, permission_mode: workspace.permission_mode, approval_mode: workspace.approval_mode,
          tool_profile: workspace.tool_profile, screen_capture_enabled: true, confirm: true,
        });
      }
      approvals.allow(current.target.app, current.conversation, input.decision);
      logger?.info?.("computer.app_allowed", { app: current.target.app, persist: input.decision });
      current.finish({ allowed: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 300) };
    } finally {
      current.starting = false;
    }
  }

  /**
   * Starts control of `target` (a window whose app the chat may use) for the project, until the
   * person stops it on the control bar, and resolves headless's status (its session_id). Control
   * already on another window moves to this one.
   */
  async function start({ workspaceId, target }) {
    const started = await request("/api/v1/computer/start", { workspace_id: workspaceId, window_id: target.window_id, pid: target.pid,
      duration_seconds: 0, always_enabled: true }, { localConfirmation: true });
    controlled = { window_id: target.window_id, pid: target.pid, title: target.title, app: appKey(target.app) };
    logger?.info?.("computer.started", { pid: target.pid, app: controlled.app });
    openBar(`${appName(target.app, target.title)} · ${target.title}`);
    return started?.status ?? await status();
  }

  function dispose() {
    for (const item of [...pending]) item.finish({ allowed: false, reason: "the app quit" });
    if (bar) void stop("app quit");
  }

  return Object.freeze({
    status, targets, askApp, answer, start, requests, stop, dispose, controlled: () => controlled, appName,
    allowedApps: () => approvals.list(), forgetApp: (app) => approvals.remove(app),
    appAllowed: (app, workspaceId, aoSession) => approvals.allowed(app, `${workspaceId}:${aoSession ?? ""}`),
  });
}

module.exports = { createComputerControl, createAppApprovals, barPage, appName, appKey };

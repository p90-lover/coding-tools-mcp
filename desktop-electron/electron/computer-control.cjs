"use strict";
// Computer control for chat agents (Settings > "Let chat agents see and control the screen").
// A chat's computer_* tools act only on the one window the person picks on the chat's request card
// (it was a window of its own until 2026-10-31, which took the focus), and only while this
// app's control bar is on screen: headless refuses input 3 s after the bar's last heartbeat, and
// only the app may start control (the local UI token). The Tauri app had its own picker and
// monitor; the Electron app had neither, so every chat's computer_status read "stopped".

const crypto = require("node:crypto");

const HEARTBEAT_MS = 1_000;
const DURATIONS = Object.freeze([
  { id: "900", label: "15 minutes", seconds: 900 },
  { id: "300", label: "5 minutes", seconds: 300 },
  { id: "always", label: "Until I stop it", seconds: 0 },
]);

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pageUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const STYLE = `body{font:13px system-ui,"Segoe UI",sans-serif;margin:0;color:#1f1f1f;background:#fff}
@media(prefers-color-scheme:dark){body{color:#ececec;background:#1e1e1e}.row:hover{background:#2a2a2a!important}}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #8884;background:transparent;color:inherit;cursor:pointer}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}button:disabled{opacity:.5;cursor:default}`;

/** The bar shown while control is on: what is controlled, time left, and Stop. */
function barPage({ title }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Computer control is on</title><style>${STYLE}
body{display:flex;align-items:center;gap:10px;padding:0 10px;height:100vh;box-sizing:border-box;-webkit-app-region:drag;
border:2px solid #dc2626;border-radius:8px}b{color:#dc2626}span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{-webkit-app-region:no-drag;background:#dc2626;border-color:#dc2626;color:#fff}</style></head>
<body><b>●</b><span>A chat controls “${escapeHtml(title)}” <small id="left"></small></span><button id="stop">Stop</button>
<script>document.getElementById("stop").onclick = () => { location.hash = "stop"; };
window.showLeft = (text) => { document.getElementById("left").textContent = text; };</script></body></html>`;
}

function createComputerControl({ request, BrowserWindow, screen, logger = null, ownPids = () => [process.pid], onRequests = () => undefined }) {
  let bar = null;
  let heartbeat = null;
  let picking = null;
  // The one request waiting for the person: { public, workspace, targets, captureOff, finish }.
  let pending = null;
  // What the chats show: the request (several chats asking at once share it), or none.
  const requests = () => pending ? [pending.public] : [];
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
    try { await request("/api/v1/computer/stop", {}); } catch (error) {
      logger?.warn?.("computer.stop_failed", { message: String(error?.message || error).slice(0, 200) });
    }
    logger?.info?.("computer.stopped", { reason });
  }

  // A page of ours that only ever changes its hash: every other navigation and popup is refused.
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
    own.webContents.on("did-navigate-in-page", (_event, url) => { if (url.endsWith("#stop")) void stop("Stop pressed"); });
    void own.loadURL(pageUrl(barPage({ title }))).then(() => { if (!own.isDestroyed()) own.showInactive(); });
    // The bar's heartbeat keeps input allowed; a bar hidden or gone sends none, and input stops.
    heartbeat = setInterval(async () => {
      if (bar !== own || own.isDestroyed()) return;
      if (!own.isVisible()) return;
      try {
        const current = (await request("/api/v1/computer/status?heartbeat=true", null, { method: "GET", localConfirmation: true }))?.status;
        if (bar !== own || own.isDestroyed()) return;
        if (!current || current.state === "stopped") { closeBar(); return; }
        const left = Number.isInteger(current.remaining_seconds)
          ? `· ${Math.floor(current.remaining_seconds / 60)}:${String(current.remaining_seconds % 60).padStart(2, "0")} left` : "· until you stop it";
        void own.webContents.executeJavaScript(`window.showLeft(${JSON.stringify(left)})`).catch(() => undefined);
      } catch { /* a missed beat only pauses input; the next one restores it */ }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  /**
   * Asks for control in the chat that wants it: a card there (requests(), onRequests) the person
   * answers with answer(), never a window of its own that would take the focus from whatever they
   * are doing. Resolves { started: true } once control of the chosen window is on, else
   * { started: false, reason }. One request at a time: a chat asking meanwhile joins it (its card
   * shows there too) and shares its answer.
   */
  function pick({ workspaceId, aoSession = null, chat = "A chat", signal = null }) {
    if (picking) {
      if (pending && aoSession && !pending.public.sessions.includes(aoSession)) {
        pending.public = Object.freeze({ ...pending.public, sessions: Object.freeze([...pending.public.sessions, aoSession]) });
        publish();
      }
      return picking;
    }
    picking = choose({ workspaceId, aoSession, chat, signal }).finally(() => { picking = null; });
    return picking;
  }

  async function choose({ workspaceId, aoSession, chat, signal }) {
    const own = new Set(ownPids());
    const targets = ((await request("/api/v1/computer/targets", null, { method: "GET" }))?.targets ?? [])
      .filter((target) => !own.has(target.pid));
    const workspaces = (await request("/api/v1/workspaces", null, { method: "GET" }))?.workspaces ?? [];
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { started: false, reason: "the chat's project is not registered" };
    const project = workspace.name || workspace.path || workspace.id;
    const captureOff = workspace.screen_capture_enabled !== true && workspace.screenCaptureEnabled !== true;
    return new Promise((resolve) => {
      let done = false;
      const finish = (answer) => {
        if (done) return;
        done = true;
        signal?.removeEventListener?.("abort", aborted);
        if (pending?.finish === finish) { pending = null; publish(); }
        resolve(answer);
      };
      const aborted = () => finish({ started: false, reason: "the chat stopped" });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      pending = {
        workspace, targets, captureOff, finish, starting: false,
        // Plain data only: the chat shows every title as text.
        public: Object.freeze({
          id: crypto.randomUUID(), workspaceId, sessions: Object.freeze(aoSession ? [aoSession] : []), chat: String(chat), project: String(project),
          captureOff, windows: Object.freeze(targets.map((target) => Object.freeze({ title: String(target.title || "(untitled)"), pid: Number(target.pid) }))),
          durations: Object.freeze(DURATIONS.map(({ id, label }) => Object.freeze({ id, label }))),
        }),
      };
      publish();
    });
  }

  /**
   * The person's answer on a request's card: { id, window, duration, capture } starts control of
   * that window (its index in the request's windows); { id, cancel: true } turns the request down.
   * Resolves { ok: true }, or { ok: false, error } for the card to show while it stays open.
   */
  async function answer(input) {
    const current = pending;
    if (!current || input?.id !== current.public.id) return { ok: false, error: "This request is no longer waiting" };
    if (input.cancel === true) { current.finish({ started: false, reason: "the user cancelled" }); return { ok: true }; }
    const target = Number.isInteger(input.window) ? current.targets[input.window] : undefined;
    if (!target) return { ok: false, error: "Pick the window it may control" };
    if (current.starting) return { ok: false, error: "Control is already starting" };
    const duration = DURATIONS.find((d) => d.id === input.duration) ?? DURATIONS[0];
    current.starting = true;
    try {
      if (current.captureOff) {
        if (input.capture !== true) throw new Error("Control needs screen capture for this project");
        const { workspace } = current;
        await request("/api/v1/workspaces/policy", {
          workspace_id: workspace.id, permission_mode: workspace.permission_mode, approval_mode: workspace.approval_mode,
          tool_profile: workspace.tool_profile, screen_capture_enabled: true, confirm: true,
        });
      }
      await request("/api/v1/computer/start", { workspace_id: current.workspace.id, window_id: target.window_id, pid: target.pid,
        duration_seconds: duration.seconds, always_enabled: duration.seconds === 0 }, { localConfirmation: true });
      logger?.info?.("computer.started", { pid: target.pid, duration: duration.id });
      openBar(target.title || `process ${target.pid}`);
      current.finish({ started: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 300) };
    } finally {
      current.starting = false;
    }
  }

  function dispose() {
    pending?.finish({ started: false, reason: "the app quit" });
    if (bar) void stop("app quit");
  }

  return Object.freeze({ status, pick, answer, requests, stop, dispose });
}

module.exports = { createComputerControl, barPage, DURATIONS };

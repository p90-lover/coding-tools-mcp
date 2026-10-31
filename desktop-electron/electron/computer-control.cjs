"use strict";
// Computer control for chat agents (Settings > "Let chat agents see and control the screen").
// A chat's computer_* tools act only on the one window the person picks here, and only while this
// app's control bar is on screen: headless refuses input 3 s after the bar's last heartbeat, and
// only the app may start control (the local UI token). The Tauri app had its own picker and
// monitor; the Electron app had neither, so every chat's computer_status read "stopped".

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

/** The picker: the chat asking, every window that can be controlled, how long, and Start. */
function pickerPage({ chat, project, targets, captureOff }) {
  const rows = targets.map((target, index) => `<label class="row"><input type="radio" name="w" value="${index}">`
    + `<span>${escapeHtml(target.title || "(untitled)")}</span><small>pid ${target.pid}</small></label>`).join("");
  const durations = DURATIONS.map((d) => `<option value="${d.id}">${escapeHtml(d.label)}</option>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Computer control</title><style>${STYLE}
main{padding:16px;display:flex;flex-direction:column;gap:10px;height:100vh;box-sizing:border-box}
h1{font-size:15px;margin:0}p{margin:0;opacity:.8}#list{flex:1;overflow:auto;border:1px solid #8884;border-radius:6px}
.row{display:flex;gap:8px;align-items:center;padding:6px 8px;cursor:pointer}.row:hover{background:#f2f2f2}
.row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{opacity:.6}
footer{display:flex;gap:8px;align-items:center}footer select{flex:1}#error{color:#dc2626;min-height:1em}</style></head>
<body><main><h1>Let a chat control a window</h1>
<p>${escapeHtml(chat)} asked to control your screen in ${escapeHtml(project)}. Pick the one window it may click and type in.
A bar stays on screen while control is on; Stop there or Ctrl+Alt+Escape ends it.</p>
<div id="list">${rows || "<p style=\"padding:8px\">No window can be controlled right now.</p>"}</div>
${captureOff ? `<label><input type="checkbox" id="capture"> Turn on screen capture for ${escapeHtml(project)} (control needs it)</label>` : ""}
<div id="error"></div>
<footer><select id="duration">${durations}</select><button id="cancel">Cancel</button><button id="start" class="primary" disabled>Start</button></footer></main>
<script>
const start = document.getElementById("start"), capture = document.getElementById("capture");
const ready = () => { start.disabled = !document.querySelector("input[name=w]:checked") || (capture && !capture.checked); };
document.addEventListener("change", ready);
start.onclick = () => { start.disabled = true; location.hash = "start:" + encodeURIComponent(JSON.stringify({
  window: Number(document.querySelector("input[name=w]:checked").value), duration: document.getElementById("duration").value,
  capture: Boolean(capture && capture.checked) })); };
document.getElementById("cancel").onclick = () => { location.hash = "cancel"; };
window.showError = (text) => { document.getElementById("error").textContent = text; location.hash = ""; ready(); };
</script></body></html>`;
}

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

function createComputerControl({ request, BrowserWindow, screen, logger = null, ownPids = () => [process.pid] }) {
  let bar = null;
  let heartbeat = null;
  let picking = null;

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
   * Shows the picker for a chat that asked for control; resolves { started: true } once control of
   * the chosen window is on, else { started: false, reason }. One picker at a time: a second chat
   * asking meanwhile shares its answer.
   */
  function pick({ workspaceId, chat = "A chat", signal = null }) {
    if (picking) return picking;
    picking = choose({ workspaceId, chat, signal }).finally(() => { picking = null; });
    return picking;
  }

  async function choose({ workspaceId, chat, signal }) {
    const own = new Set(ownPids());
    const targets = ((await request("/api/v1/computer/targets", null, { method: "GET" }))?.targets ?? [])
      .filter((target) => !own.has(target.pid));
    const workspaces = (await request("/api/v1/workspaces", null, { method: "GET" }))?.workspaces ?? [];
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { started: false, reason: "the chat's project is not registered" };
    const project = workspace.name || workspace.path || workspace.id;
    const captureOff = workspace.screen_capture_enabled !== true && workspace.screenCaptureEnabled !== true;
    const picker = new BrowserWindow({
      width: 560, height: 520, title: "Computer control", autoHideMenuBar: true, alwaysOnTop: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    lockDown(picker);
    return new Promise((resolve) => {
      let done = false;
      const finish = (answer) => {
        if (done) return;
        done = true;
        signal?.removeEventListener?.("abort", aborted);
        if (!picker.isDestroyed()) picker.destroy();
        resolve(answer);
      };
      const aborted = () => finish({ started: false, reason: "the chat stopped" });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      picker.on("closed", () => finish({ started: false, reason: "the picker was closed" }));
      picker.webContents.on("did-navigate-in-page", async (_event, url) => {
        const hash = decodeURIComponent(new URL(url).hash.slice(1));
        if (hash === "cancel") { finish({ started: false, reason: "the user cancelled" }); return; }
        if (!hash.startsWith("start:")) return;
        let choice;
        try { choice = JSON.parse(hash.slice("start:".length)); } catch { return; }
        const target = targets[choice.window];
        const duration = DURATIONS.find((d) => d.id === choice.duration) ?? DURATIONS[0];
        if (!target) return;
        try {
          if (captureOff) {
            if (!choice.capture) throw new Error("Control needs screen capture for this project");
            await request("/api/v1/workspaces/policy", {
              workspace_id: workspaceId, permission_mode: workspace.permission_mode, approval_mode: workspace.approval_mode,
              tool_profile: workspace.tool_profile, screen_capture_enabled: true, confirm: true,
            });
          }
          await request("/api/v1/computer/start", { workspace_id: workspaceId, window_id: target.window_id, pid: target.pid,
            duration_seconds: duration.seconds, always_enabled: duration.seconds === 0 }, { localConfirmation: true });
          logger?.info?.("computer.started", { pid: target.pid, duration: duration.id });
          openBar(target.title || `process ${target.pid}`);
          finish({ started: true });
        } catch (error) {
          const message = String(error?.message || error).slice(0, 300);
          if (!picker.isDestroyed()) void picker.webContents.executeJavaScript(`window.showError(${JSON.stringify(message)})`).catch(() => undefined);
        }
      });
      void picker.loadURL(pageUrl(pickerPage({ chat, project, targets, captureOff })))
        .then(() => { if (!picker.isDestroyed()) { picker.show(); picker.focus(); } })
        .catch((error) => finish({ started: false, reason: String(error?.message || error).slice(0, 200) }));
    });
  }

  function dispose() {
    if (bar) void stop("app quit");
  }

  return Object.freeze({ status, pick, stop, dispose });
}

module.exports = { createComputerControl, pickerPage, barPage, DURATIONS };

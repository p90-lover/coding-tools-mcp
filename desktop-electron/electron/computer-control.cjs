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

// The bar's Stop tells the app by renaming its page: a data: page never navigates in-page, so a
// hash change there never fired did-navigate-in-page and Stop did nothing (the 0.8.39 picker's
// Start was dead the same way, 2026-10-31). page-title-updated fires for any page, with no preload.
const STOP_TITLE = "stop-computer-control";

// The pill's history button opens and closes its list the same way (page-title-updated).
const HISTORY_TITLE = "computer-control-history:";

// The pill's size, in DIPs: one row, wide enough for agent and model, the step, the app and the
// buttons. With its history open the window grows down by HISTORY_HEIGHT, and only then.
const PILL_WIDTH = 620;
const PILL_HEIGHT = 40;
const HISTORY_HEIGHT = 268;
// Steps the history keeps, newest first.
const HISTORY_LIMIT = 50;
// After a step the pill keeps naming it this long, so a run of quick steps reads as one line, not a flicker.
const IDLE_LINGER_MS = 1_200;
const IDLE_TEXT = "waiting for its next step";

/** Untrusted text (a control's name) as a short quoted phrase, or "" when there is none. */
function quoted(value, max = 40) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
}

const KEY_NAMES = Object.freeze({ pageup: "Page Up", pagedown: "Page Down", backspace: "Backspace", escape: "Esc", ctrl: "Ctrl" });
/** "ctrl+s" → "Ctrl+S", "pageup" → "Page Up". */
const keyName = (key) => String(key ?? "").split("+").map((part) => part.trim().toLowerCase()).filter(Boolean)
  .map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))).join("+") || "a key";

/** One computer_action step in words. Typed text is never shown, only its length: the pill is on screen for anyone to see. */
function stepLabel(step) {
  const control = quoted(step?.selector?.name || step?.selector?.automation_id);
  const at = control || (Number.isInteger(step?.x) && Number.isInteger(step?.y) ? `at ${step.x}, ${step.y}` : "");
  const on = (verb) => (at ? `${verb} ${at}` : verb);
  switch (step?.action) {
    case "click": return on(step.button === "double" ? "Double-clicking" : step.button === "right" ? "Right-clicking" : "Clicking");
    case "move": return on("Pointing");
    case "type": {
      const count = [...String(step.text ?? "")].length;
      return `Typing ${count} character${count === 1 ? "" : "s"}${control ? ` into ${control}` : ""}`;
    }
    case "key": return `Pressing ${keyName(step.key)}`;
    case "scroll": return `Scrolling ${Number(step.amount) < 0 ? "down" : "up"}${control ? ` in ${control}` : ""}`;
    case "wait": return control ? `Waiting for ${control}` : "Waiting";
    case "verify": return control ? `Checking ${control}` : "Checking the window";
    case "find": return control ? `Looking for ${control}` : "Looking for a control";
    default: return "Working in the window";
  }
}

/** What a computer_* call is doing, for the pill; null for one that does nothing on screen (status, route, stop). */
function describeAction(tool, args = {}) {
  switch (tool) {
    case "computer_action": return stepLabel(args?.step);
    case "computer_sequence": {
      const steps = Array.isArray(args?.steps) ? args.steps : [];
      if (!steps.length) return "Continuing its steps";
      const more = steps.length - 1;
      return `${stepLabel(steps[0])}${more ? ` (+${more} more step${more === 1 ? "" : "s"})` : ""}`;
    }
    case "computer_snapshot": return "Looking at the window";
    case "computer_find_control": return `Looking for ${quoted(args?.selector?.name || args?.selector?.automation_id) || "a control"}`;
    case "computer_wait": return `Waiting for ${quoted(args?.selector?.name || args?.selector?.automation_id) || "a control"}`;
    case "computer_select_window": return args?.activate ? "Bringing the window forward" : null;
    default: return null;
  }
}

/** Calls that send pointer input: the pill lets clicks through while one runs (see activity). */
const POINTER_TOOLS = new Set(["computer_action", "computer_sequence"]);

/** A model's route id as people know it: "cpa/gpt-6.1-sol" → "gpt-6.1-sol", "opencode-go/deepseek-v4.1-flash" → "deepseek-v4.1-flash". */
function modelLabel(model) {
  const text = String(model ?? "").trim();
  return text ? text.split("/").filter(Boolean).at(-1).slice(0, 48) : "";
}

/**
 * The pill shown while control is on: the agent and its model, the step it is on, the app it
 * controls (a bright chip, never cut short), its history (▾) and Stop. Static: no animation or
 * transition, so it draws only when its text changes (window.show, window.showHistory).
 */
function barPage({ title = "", agent = "A chat", app = "", model = "" } = {}) {
  const where = app || title;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Computer control is on</title><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
body{font:13px system-ui,"Segoe UI",sans-serif;color:#f4f4f5;user-select:none;cursor:default}
.pill{box-sizing:border-box;height:${PILL_HEIGHT}px;display:flex;align-items:center;gap:8px;padding:0 4px 0 12px;border-radius:999px;
background:#18181b;border:1px solid #52525b;-webkit-app-region:drag}
.dot{flex:none;width:9px;height:9px;border-radius:50%;background:#f97316;opacity:.45}
.pill[data-busy] .dot{opacity:1}
.who{flex:none;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model{color:#fdba74;font-weight:600}
.what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e4e4e7}
.pill:not([data-busy]) .what{color:#a1a1aa}
.app{flex:none;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:13px;
color:#111827;background:#fde68a;border-radius:999px;padding:3px 10px}
.app:empty{display:none}
button{-webkit-app-region:no-drag;flex:none;font:inherit;font-weight:600;border:0;border-radius:999px;padding:5px 12px;cursor:pointer}
#toggle{background:#3f3f46;color:#f4f4f5;padding:5px 9px}#toggle:hover{background:#52525b}
#stop{background:#dc2626;color:#fff}#stop:hover{background:#b91c1c}
.panel{display:none;box-sizing:border-box;margin-top:6px;height:${HISTORY_HEIGHT - 6}px;overflow-y:auto;border-radius:14px;
background:#18181b;border:1px solid #52525b;padding:4px 0}
body[data-open] .panel{display:block}
.row{display:grid;grid-template-columns:62px 1fr auto 18px;gap:8px;align-items:center;padding:5px 12px;border-bottom:1px solid #27272a}
.row:last-child{border-bottom:0}.time{color:#a1a1aa;font-variant-numeric:tabular-nums;font-size:12px}
.act{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.act small{color:#a1a1aa}
.row .app{font-size:11.5px;padding:1px 8px;max-width:150px}
.mark{text-align:center;font-weight:700}.done{color:#4ade80}.failed{color:#f87171}.running{color:#fdba74}
.empty{color:#a1a1aa;padding:10px 12px}</style></head>
<body><div class="pill" id="pill"><span class="dot"></span>
<span class="who"><b id="who">${escapeHtml(agent)}</b><span class="model" id="model">${model ? ` · ${escapeHtml(model)}` : ""}</span></span>
<span class="what" id="what">${escapeHtml(IDLE_TEXT)}</span><span class="app" id="app">${escapeHtml(where)}</span>
<button id="toggle" title="Show what it did">▾</button><button id="stop" title="Stop computer control">Stop</button></div>
<div class="panel" id="panel"><div class="empty">Nothing done yet.</div></div>
<script>const $ = (id) => document.getElementById(id);
let flips = 0;
$("stop").onclick = () => { document.title = ${JSON.stringify(STOP_TITLE)}; };
$("toggle").onclick = () => {
  const open = !document.body.hasAttribute("data-open");
  document.body.toggleAttribute("data-open", open);
  $("toggle").textContent = open ? "▴" : "▾";
  document.title = ${JSON.stringify(HISTORY_TITLE)} + (open ? "open:" : "closed:") + (++flips);
};
window.show = (state) => {
  $("who").textContent = String(state.agent || "A chat");
  $("model").textContent = state.model ? " · " + String(state.model) : "";
  $("what").textContent = String(state.action || ${JSON.stringify(IDLE_TEXT)});
  $("app").textContent = String(state.app || "");
  $("pill").toggleAttribute("data-busy", Boolean(state.action));
};
const cell = (tag, className, text) => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
window.showHistory = (entries) => {
  const panel = $("panel");
  panel.replaceChildren();
  if (!entries.length) { panel.append(cell("div", "empty", "Nothing done yet.")); return; }
  for (const entry of entries) {
    const row = cell("div", "row", "");
    const act = cell("span", "act", String(entry.action));
    act.append(cell("small", "", "  " + String(entry.agent) + (entry.model ? " · " + String(entry.model) : "")));
    row.append(cell("span", "time", String(entry.time)), act, cell("span", "app", String(entry.app || "")),
      cell("span", "mark " + String(entry.outcome), entry.outcome === "done" ? "✓" : entry.outcome === "failed" ? "✕" : "…"));
    row.title = String(entry.action);
    panel.append(row);
  }
};</script></body></html>`;
}

function createComputerControl({ request, BrowserWindow, screen, logger = null, ownPids = () => [process.pid], onRequests = () => undefined,
  approvalsFile = null, now = Date.now }) {
  const approvals = createAppApprovals({ file: approvalsFile, now });
  let bar = null;
  let heartbeat = null;
  // What the pill shows, the text last sent to it, the calls running (pointer ones apart), and the
  // timer that clears the last step's name.
  let shown = { agent: "A chat", model: "", action: null, app: "" };
  let painted = null;
  let running = 0;
  let pointing = 0;
  let idleTimer = null;
  // The steps it took, newest first ({ time, agent, model, action, app, outcome }), kept while the
  // app runs; sent to the pill only while its history is open.
  const history = [];
  let historyOpen = false;
  const clock = (at) => new Date(at).toTimeString().slice(0, 8);
  // The window control was last started on, by this app ({ window_id, pid, title, app }).
  let controlled = null;
  // The requests waiting for the person: { public, finish, workspace, captureOff, target, conversation }.
  const pending = [];
  // What the chats show: every waiting request (each shows in the chat that asked).
  const requests = () => pending.map((item) => item.public);
  const publish = () => { try { onRequests(requests()); } catch { /* a closed window shows none */ } };

  const status = async () => (await request("/api/v1/computer/status", null, { method: "GET" }))?.status ?? { state: "stopped" };

  /** Sends the pill its text, only when it changed: an unchanged pill is never redrawn. */
  function paint() {
    if (!bar || bar.isDestroyed()) return;
    const state = JSON.stringify(shown);
    if (state === painted) return;
    painted = state;
    void bar.webContents.executeJavaScript(`window.show(${state})`).catch(() => { painted = null; });
  }

  /** The history list, sent only while it is open: a closed pill gets nothing more to draw. */
  function paintHistory() {
    if (!historyOpen || !bar || bar.isDestroyed()) return;
    void bar.webContents.executeJavaScript(`window.showHistory(${JSON.stringify(history)})`).catch(() => undefined);
  }

  /** The person opened or closed the history: the window grows down to hold it, or back to the pill alone. */
  function toggleHistory(own, open) {
    if (bar !== own || own.isDestroyed()) return;
    historyOpen = open;
    try {
      const bounds = own.getBounds();
      own.setBounds({ ...bounds, height: PILL_HEIGHT + (open ? HISTORY_HEIGHT : 0) });
    } catch { /* stays its size */ }
    paintHistory();
  }

  function closeBar() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    running = 0;
    pointing = 0;
    painted = null;
    historyOpen = false;
    for (const entry of history) if (entry.outcome === "running") entry.outcome = "failed";
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

  function openBar({ title, agent = "A chat", app = "", model = "" }) {
    closeBar();
    shown = { agent, model: modelLabel(model), action: null, app: app || title };
    // On the screen the person is looking at (the pointer's), at its top centre.
    let display = null;
    try { display = screen.getDisplayNearestPoint?.(screen.getCursorScreenPoint()) ?? null; } catch { display = null; }
    const area = (display ?? screen.getPrimaryDisplay()).workArea;
    const width = Math.min(PILL_WIDTH, area.width);
    bar = new BrowserWindow({
      width, height: PILL_HEIGHT, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8,
      frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      // A pill: a transparent window around a rounded page. It never takes the focus (focusable:
      // false, showInactive), so Stop does not pull the controlled app out of the foreground, and
      // as a tool window it stays out of Alt+Tab.
      transparent: true, backgroundColor: "#00000000", hasShadow: false, focusable: false, type: "toolbar", fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    // "screen-saver" is the highest band: above other always-on-top windows and borderless full-screen apps.
    bar.setAlwaysOnTop(true, "screen-saver");
    lockDown(bar);
    const own = bar;
    own.on("closed", () => { if (bar === own) void stop("control bar closed"); });
    own.webContents.on("page-title-updated", (event, pageTitle) => {
      if (pageTitle === STOP_TITLE) {
        event.preventDefault?.();
        if (bar === own) void stop("Stop pressed");
      } else if (String(pageTitle).startsWith(HISTORY_TITLE)) {
        event.preventDefault?.();
        toggleHistory(own, String(pageTitle).slice(HISTORY_TITLE.length).startsWith("open:"));
      }
    });
    void own.loadURL(pageUrl(barPage({ title, agent: shown.agent, app: shown.app, model: shown.model }))).then(() => {
      if (own.isDestroyed() || bar !== own) return;
      own.showInactive();
      // A step that started while the page loaded.
      painted = JSON.stringify({ ...shown, action: null });
      paint();
    });
    // The bar's heartbeat keeps input allowed; a bar hidden or gone sends none, and input stops.
    // Control is on until the person stops it, so there is no time left to redraw each second.
    heartbeat = setInterval(async () => {
      if (bar !== own || own.isDestroyed()) return;
      if (!own.isVisible()) return;
      // Back on top of a window that took the top of the always-on-top band since (a full-screen
      // player, another app's overlay). No activation, so the focus stays where it is.
      try { own.moveTop?.(); } catch { /* stays where it is */ }
      try {
        const current = (await request("/api/v1/computer/status?heartbeat=true", null, { method: "GET", localConfirmation: true }))?.status;
        if (bar !== own || own.isDestroyed()) return;
        if (!current || current.state === "stopped") { closeBar(); controlled = null; return; }
      } catch { /* a missed beat only pauses input; the next one restores it */ }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  /**
   * A chat's computer_* call is about to run: the pill names it (describeAction) until it ends,
   * then a moment longer. Returns the function to call when it ends. While a call that sends
   * pointer input runs, the pill lets clicks through: headless refuses a click on a point another
   * window covers (TARGET_OCCLUDED), and the pill is always on top. This uses no mouse hook, which
   * would slow every mouse move on the computer whenever this app is busy.
   */
  function activity({ agent = null, model = null, tool, args } = {}) {
    const action = describeAction(tool, args);
    const own = bar;
    if (!action || !own || own.isDestroyed()) return () => undefined;
    const pointer = POINTER_TOOLS.has(tool);
    running += 1;
    if (pointer && pointing++ === 0) own.setIgnoreMouseEvents?.(true);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    shown = { ...shown, agent: agent || shown.agent, model: model ? modelLabel(model) : shown.model, action };
    paint();
    const step = { time: clock(now()), agent: shown.agent, model: shown.model, action, app: shown.app, outcome: "running" };
    history.unshift(step);
    history.length = Math.min(history.length, HISTORY_LIMIT);
    paintHistory();
    let ended = false;
    /** `outcome`: "done", or "failed" when the call came back as an error. */
    return (outcome = "done") => {
      if (ended) return;
      ended = true;
      step.outcome = outcome === "failed" ? "failed" : "done";
      if (bar !== own || own.isDestroyed()) return;
      paintHistory();
      running = Math.max(0, running - 1);
      if (pointer && --pointing <= 0) { pointing = 0; own.setIgnoreMouseEvents?.(false); }
      if (running) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (bar !== own || running) return;
        shown = { ...shown, action: null };
        paint();
      }, IDLE_LINGER_MS);
      idleTimer.unref?.();
    };
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
  async function start({ workspaceId, target, agent = "A chat", model = "" }) {
    const started = await request("/api/v1/computer/start", { workspace_id: workspaceId, window_id: target.window_id, pid: target.pid,
      duration_seconds: 0, always_enabled: true }, { localConfirmation: true });
    controlled = { window_id: target.window_id, pid: target.pid, title: target.title, app: appKey(target.app) };
    logger?.info?.("computer.started", { pid: target.pid, app: controlled.app });
    openBar({ title: target.title, agent, model, app: appName(target.app, target.title) });
    return started?.status ?? await status();
  }

  function dispose() {
    for (const item of [...pending]) item.finish({ allowed: false, reason: "the app quit" });
    if (bar) void stop("app quit");
  }

  return Object.freeze({
    status, targets, askApp, answer, start, requests, stop, dispose, activity, history: () => history.map((entry) => ({ ...entry })),
    controlled: () => controlled, appName,
    allowedApps: () => approvals.list(), forgetApp: (app) => approvals.remove(app),
    appAllowed: (app, workspaceId, aoSession) => approvals.allowed(app, `${workspaceId}:${aoSession ?? ""}`),
  });
}

module.exports = { createComputerControl, createAppApprovals, barPage, describeAction, modelLabel, appName, appKey };

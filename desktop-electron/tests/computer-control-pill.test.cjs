"use strict";
// The pill shown while a chat controls a window (computer-control.cjs): it names the agent and its
// model, the step it takes and the app it controls, keeps a history the person can open, stays above
// full-screen apps, never takes the focus, lets the agent's own clicks through, and draws only when
// its text changes, so it costs nothing while nothing happens.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createComputerControl, barPage, describeAction, modelLabel } = require("../electron/computer-control.cjs");

test("each computer_* call is named in words, and typed text never appears on screen", () => {
  const step = (value) => describeAction("computer_action", { step: value });
  assert.equal(step({ action: "click", selector: { name: "Save" } }), "Clicking “Save”");
  assert.equal(step({ action: "click", button: "double", x: 10, y: 20 }), "Double-clicking at 10, 20");
  assert.equal(step({ action: "click", button: "right" }), "Right-clicking");
  assert.equal(step({ action: "move", x: 1, y: 2 }), "Pointing at 1, 2");
  assert.equal(step({ action: "type", text: "hunter2 secret", selector: { name: "Password" } }), "Typing 14 characters into “Password”");
  assert.equal(step({ action: "type", text: "a" }), "Typing 1 character");
  assert.equal(step({ action: "key", key: "ctrl+s" }), "Pressing Ctrl+S");
  assert.equal(step({ action: "key", key: "pageup" }), "Pressing Page Up");
  assert.equal(step({ action: "scroll", amount: -3 }), "Scrolling down");
  assert.equal(step({ action: "scroll", amount: 2, selector: { automation_id: "list" } }), "Scrolling up in “list”");
  assert.equal(step({ action: "wait", selector: { name: "Done" } }), "Waiting for “Done”");
  assert.equal(step({ action: "verify" }), "Checking the window");
  assert.equal(step({ action: "find", selector: { name: "x".repeat(80) } }), `Looking for “${"x".repeat(39)}…”`);
  assert.equal(describeAction("computer_sequence", { steps: [{ action: "click", selector: { name: "File" } }, { action: "key", key: "enter" }, { action: "type", text: "x" }] }),
    "Clicking “File” (+2 more steps)");
  assert.equal(describeAction("computer_sequence", { resume_from_step: 2 }), "Continuing its steps");
  assert.equal(describeAction("computer_snapshot", {}), "Looking at the window");
  assert.equal(describeAction("computer_wait", { selector: { name: "OK" } }), "Waiting for “OK”");
  assert.equal(describeAction("computer_select_window", { activate: true }), "Bringing the window forward");
  assert.equal(describeAction("computer_select_window", {}), "Choosing a window");
  assert.equal(describeAction("computer_list_windows", {}), "Looking at the open windows");
  for (const quiet of ["computer_status", "computer_route", "computer_stop"]) {
    assert.equal(describeAction(quiet, {}), null, `${quiet} does nothing on screen, so the pill keeps its line`);
  }
  assert.doesNotMatch(step({ action: "type", text: "hunter2" }), /hunter2/);
});

test("models are named as people know them", () => {
  assert.equal(modelLabel("cpa/gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(modelLabel("opencode-go/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(modelLabel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelLabel(null), "");
});

/** A control whose pill is a stand-in window recording what the app did to it. */
function pill({ cursor = { x: 2500, y: 10 }, now = () => Date.UTC(2026, 10, 7, 3, 4, 5), fileIcon = undefined } = {}) {
  const made = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.scripts = [];
      this.ignoring = [];
      this.tops = [];
      this.raised = 0;
      this.handlers = {};
      this.webContents = { on: (name, handler) => { this.handlers[name] = handler; }, setWindowOpenHandler() {},
        executeJavaScript: async (code) => { this.scripts.push(code); } };
      made.push(this);
    }
    setAlwaysOnTop(on, level) { this.tops.push([on, level]); }
    setIgnoreMouseEvents(value) { this.ignoring.push(value); }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    moveTop() { this.raised += 1; }
    on() {} showInactive() { this.shownInactive = true; } destroy() { this.destroyed = true; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return Boolean(this.destroyed); }
    isVisible() { return true; }
    /** The page renamed itself, as its buttons do. */
    retitle(title) { let prevented = false; this.handlers["page-title-updated"]({ preventDefault: () => { prevented = true; } }, title); return prevented; }
  }
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { workArea: { x: 1920, y: 0, width: 1280, height: 1000 } }];
  const screen = {
    getPrimaryDisplay: () => displays[0],
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: (point) => displays.find((item) => point.x >= item.workArea.x && point.x < item.workArea.x + item.workArea.width) ?? displays[0],
  };
  const requests = [];
  // Headless as the pill sees it: control on after a start, off after a stop, and the agent's last
  // frame (`agent.frame`) reported by the heartbeat and served by /computer/frame.
  const agent = { armed: false, frame: null, frameFails: false };
  const request = async (endpoint, body, options = {}) => {
    requests.push(endpoint);
    if (endpoint === "/api/v1/computer/start") { agent.armed = true; return { status: { state: "active", session_id: "lease" } }; }
    if (endpoint === "/api/v1/computer/stop") { agent.armed = false; return {}; }
    if (endpoint.startsWith("/api/v1/computer/status")) {
      return { status: agent.armed ? { state: "active", last_snapshot_id: agent.frame?.snapshot_id ?? null } : { state: "stopped" } };
    }
    if (endpoint.startsWith("/api/v1/computer/frame")) {
      assert.equal(options.localConfirmation, true, "only the app's own UI reads the agent's frame");
      if (agent.frameFails) throw new Error("COMPUTER_FRAME_FAILED");
      const after = new URL(endpoint, "http://x").searchParams.get("after");
      return { frame: agent.frame && agent.frame.snapshot_id !== after ? agent.frame : null };
    }
    return {};
  };
  const control = createComputerControl({ request, BrowserWindow: FakeWindow, screen, ownPids: () => [1], now, ...(fileIcon ? { fileIcon } : {}) });
  return { control, made, requests, agent };
}

/** Each call of window.<name>(...) the app made on the pill's page: its arguments. */
const argumentsOf = (window, name) => window.scripts.filter((code) => code.startsWith(`window.${name}(`)).map((code) => JSON.parse(`[${code.slice(name.length + 8, -1)}]`));
const calls = (window, name) => argumentsOf(window, name).map(([first]) => first);
const settle = () => new Promise(setImmediate);

test("the pill sits on the screen the person is using, above full-screen apps, names agent, model and app, and never takes the focus", async () => {
  const { control, made } = pill();
  try {
    await control.start({ workspaceId: "ws", agent: "Claude Code", model: "cpa/gpt-6.1-sol", target: { window_id: 7, pid: 70, title: "Inbox - Google Chrome", app: "chrome.exe" } });
    await settle();
    const [window] = made;
    assert.equal(made.length, 1);
    const { options } = window;
    assert.deepEqual([options.x, options.y, options.width, options.height], [1920 + (1280 - 680) / 2, 8, 680, 40], "top centre of the pointer's screen");
    assert.equal(options.focusable, false, "clicking Stop leaves the controlled app in front");
    assert.equal(options.transparent, true);
    assert.equal(options.type, "toolbar", "out of Alt+Tab");
    assert.equal(options.skipTaskbar, true);
    assert.deepEqual(window.tops, [[true, "screen-saver"]], "the highest always-on-top band");
    assert.equal(window.shownInactive, true);
    const page = decodeURIComponent(window.url.slice(window.url.indexOf(",") + 1));
    assert.match(page, /Claude Code/);
    assert.match(page, /gpt-6\.1-sol/);
    assert.doesNotMatch(page, /cpa\/gpt/);
    assert.match(page, /<span class="app" id="app"><img class="ico" id="appicon" alt="" hidden><span class="name" id="appname">Google Chrome<\/span><\/span>/,
      "the app on its own bright chip, with room for its icon left of its name");
    assert.match(page, /\.app\{flex:none;[^}]*font-weight:700[^}]*background:#fde68a/, "never cut short, bold, high contrast");
    assert.doesNotMatch(page, /@keyframes|animation|transition/, "nothing animates: an idle pill is never redrawn");
  } finally { control.dispose(); }
});

test("the pill names each step while it runs, lets the agent's clicks through, and draws only on a change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { control, made } = pill();
  try {
    await control.start({ workspaceId: "ws", agent: "Codex", model: "cpa/gpt-6.1-sol", target: { window_id: 7, pid: 70, title: "Untitled - Notepad", app: "notepad.exe" } });
    await settle();
    const [window] = made;
    const click = control.activity({ agent: "Codex", model: "cpa/gpt-6.2-luna", tool: "computer_action", args: { step: { action: "click", selector: { name: "File" } } } });
    assert.deepEqual(window.ignoring, [true], "a click under the pill reaches the window it controls (no TARGET_OCCLUDED)");
    assert.deepEqual(calls(window, "show").at(-1), { agent: "Codex", model: "gpt-6.2-luna", action: "Clicking “File”", app: "Notepad", icon: "" },
      "a model switched mid-chat shows");
    click();
    assert.deepEqual(window.ignoring, [true, false], "and Stop is clickable again once the click was sent");
    assert.equal(calls(window, "show").length, 1, "the finished step stays named for a moment");

    const look = control.activity({ agent: "Codex", tool: "computer_snapshot", args: {} });
    assert.deepEqual(window.ignoring, [true, false], "a snapshot sends no input, so the pill stays clickable");
    assert.equal(calls(window, "show").at(-1).action, "Looking at the window");
    assert.equal(calls(window, "show").at(-1).model, "gpt-6.2-luna", "no model given: the last one known stays");
    look();
    const again = control.activity({ agent: "Codex", tool: "computer_snapshot", args: {} });
    again();
    assert.equal(calls(window, "show").length, 2, "the same line is not sent twice");

    t.mock.timers.tick(1_200);
    assert.deepEqual(calls(window, "show").at(-1), { agent: "Codex", model: "gpt-6.2-luna", action: null, app: "Notepad", icon: "" }, "between steps it waits for the next");
    const scripts = window.scripts.length;
    t.mock.timers.tick(5_000);
    await settle();
    assert.equal(window.scripts.length, scripts, "the heartbeat redraws nothing");
    assert.ok(window.raised >= 5, "but puts the pill back on top each beat");
    assert.equal(calls(window, "showHistory").length, 0, "a closed history is never sent");

    assert.equal(typeof control.activity({ tool: "computer_status", args: {} }), "function", "a quiet call changes nothing");
    assert.equal(window.scripts.length, scripts);
  } finally { control.dispose(); }
});

test("the history drops down under the pill with each step, its model and how it ended, and folds back up", async () => {
  const { control, made } = pill();
  try {
    await control.start({ workspaceId: "ws", agent: "Claude Code", model: "cpa/claude-opus-5-5", target: { window_id: 7, pid: 70, title: "Paint", app: "mspaint.exe" } });
    await settle();
    const [window] = made;
    control.activity({ tool: "computer_snapshot", args: {} })("done");
    const typed = control.activity({ tool: "computer_action", args: { step: { action: "type", text: "secret" } } });
    assert.equal(calls(window, "showHistory").length, 0);

    assert.equal(window.retitle("computer-control-history:open:1"), true, "the page's ▾ asks for its history");
    assert.equal(window.bounds.height, 40 + 268, "the window grows down to hold the list");
    assert.equal(window.bounds.y, 8, "and stays where it was");
    let [shown] = calls(window, "showHistory").slice(-1);
    assert.deepEqual(shown.map((entry) => [entry.action, entry.outcome, entry.model, entry.app]), [
      ["Typing 6 characters", "running", "claude-opus-5-5", "Paint"],
      ["Looking at the window", "done", "claude-opus-5-5", "Paint"],
    ], "newest first, the running step marked as running");
    assert.match(shown[0].time, /^\d\d:\d\d:\d\d$/);
    assert.ok(!JSON.stringify(shown).includes("secret"), "typed text is not in the history either");

    typed("failed");
    [shown] = calls(window, "showHistory").slice(-1);
    assert.equal(shown[0].outcome, "failed", "an open list follows each step as it ends");

    assert.equal(window.retitle("computer-control-history:closed:2"), true);
    assert.equal(window.bounds.height, 40, "folded back to the pill");
    const sent = calls(window, "showHistory").length;
    control.activity({ tool: "computer_snapshot", args: {} })();
    assert.equal(calls(window, "showHistory").length, sent, "nothing is sent to a closed list");

    for (let index = 0; index < 60; index += 1) control.activity({ tool: "computer_snapshot", args: {} })();
    assert.equal(control.history().length, 50, "the last 50 steps are kept");
  } finally { control.dispose(); }
});

test("overlapping pointer calls keep clicks passing through until the last one ends; no pill, no effect", async () => {
  const { control, made } = pill();
  const nothing = control.activity({ tool: "computer_action", args: { step: { action: "click" } } });
  nothing();
  assert.equal(made.length, 0, "control is off: no window comes up");
  assert.deepEqual(control.history(), [], "and nothing is recorded");
  try {
    await control.start({ workspaceId: "ws", target: { window_id: 7, pid: 70, title: "Calculator", app: "calc.exe" } });
    await settle();
    const [window] = made;
    const first = control.activity({ tool: "computer_sequence", args: { steps: [{ action: "click" }] } });
    const second = control.activity({ tool: "computer_action", args: { step: { action: "move", x: 1, y: 1 } } });
    first();
    first();
    assert.deepEqual(window.ignoring, [true], "still passing through while the second runs");
    second();
    assert.deepEqual(window.ignoring, [true, false]);
  } finally { control.dispose(); }
});

test("the pill shows the controlled app's own icon left of its name, read once per program", async () => {
  const asked = [];
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  const { control, made } = pill({ fileIcon: async (file) => { asked.push(file); return file.endsWith("chrome.exe") ? icon : "javascript:alert(1)"; } });
  try {
    const chrome = { window_id: 7, pid: 70, title: "Inbox - Google Chrome", app: "chrome.exe", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" };
    await control.start({ workspaceId: "ws", agent: "Codex", target: chrome });
    await settle(); await settle();
    const [window] = made;
    assert.deepEqual(asked, [chrome.path], "read from the program itself");
    assert.equal(calls(window, "show").at(-1).icon, icon, "on the pill, left of the app's name");
    const step = control.activity({ tool: "computer_snapshot", args: {} });
    step("done");
    window.retitle("computer-control-history:open:1");
    await settle();
    assert.deepEqual(argumentsOf(window, "showHistory").at(-1)[1], { "Google Chrome": icon }, "and on each of its rows in the history");

    await control.start({ workspaceId: "ws", agent: "Codex", target: { ...chrome } });
    await settle(); await settle();
    assert.deepEqual(asked, [chrome.path], "a program's icon is read once");

    await control.start({ workspaceId: "ws", agent: "Codex", target: { window_id: 8, pid: 80, title: "x", app: "evil.exe", path: "C:\\evil.exe" } });
    await settle(); await settle();
    assert.equal(calls(made.at(-1), "show").at(-1)?.icon ?? "", "", "anything but a PNG data URL is not shown");

    await control.start({ workspaceId: "ws", agent: "Codex", target: { window_id: 9, pid: 90, title: "y", app: "notepad.exe" } });
    await settle(); await settle();
    assert.equal(asked.length, 2, "a window without a known path is shown without an icon");
  } finally { control.dispose(); }
});

test("the pill's page shows untrusted names as text, opens its history, and still stops control", () => {
  const page = barPage({ agent: "<b>x</b>", app: "<img src=x onerror=alert(1)>", title: "t", model: "<i>m</i>" });
  assert.ok(!page.includes("<img src=x"));
  assert.ok(!page.includes("<b>x</b>"));
  assert.ok(!page.includes("<i>m</i>"));
  const made = [];
  const node = (id) => ({ id, children: [], textContent: "", attributes: {}, className: "",
    toggleAttribute(name, on) { this.attributes[name] = on; }, hasAttribute(name) { return Boolean(this.attributes[name]); },
    setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return name === "src" ? this.src ?? null : this.attributes[name] ?? null; },
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); } });
  const elements = Object.fromEntries(["stop", "toggle", "who", "model", "what", "app", "appname", "appicon", "pill", "panel", "list", "thumb", "thumbimg", "shot", "cap"]
    .map((id) => [id, node(id)]));
  const document = { title: "Computer control is on", body: node("body"), getElementById: (id) => elements[id],
    createElement: (tag) => { const item = node(tag); made.push(item); return item; } };
  const window = {};
  vm.runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], { document, window, String, Boolean, Object });
  window.show({ agent: "Claude Code", model: "gpt-6.1-sol", action: "Clicking “<script>”", app: "Paint" });
  assert.deepEqual([elements.who.textContent, elements.model.textContent, elements.what.textContent, elements.appname.textContent, elements.pill.attributes["data-busy"]],
    ["Claude Code", " · gpt-6.1-sol", "Clicking “<script>”", "Paint", true], "set as text, never as markup");
  assert.equal(elements.appicon.hidden, true, "no icon until the app has one");
  window.show({ agent: "Claude Code", model: "", action: null, app: "Paint", icon: "data:image/png;base64,QUJD" });
  assert.deepEqual([elements.appicon.src, elements.appicon.hidden], ["data:image/png;base64,QUJD", false], "the app's icon, left of its name");
  window.show({ agent: "Claude Code", model: "", action: null, app: "" });
  assert.deepEqual([elements.model.textContent, elements.what.textContent, elements.appname.textContent, elements.app.attributes["data-empty"], elements.pill.attributes["data-busy"]],
    ["", "waiting for its next step", "", true, false]);
  assert.equal(elements.appicon.hidden, true);

  elements.toggle.onclick();
  assert.equal(document.body.attributes["data-open"], true);
  assert.match(document.title, /^computer-control-history:open:1$/);
  window.showHistory([{ time: "11:04:05", agent: "Codex", model: "gpt-6.1-sol", action: "<b>Clicking</b>", app: "Paint", outcome: "failed" },
    { time: "11:04:06", agent: "Codex", model: "", action: "Typing", app: "__proto__", outcome: "done" }], { Paint: "data:image/png;base64,QUJD" });
  const [row, odd] = elements.list.children;
  assert.deepEqual(row.children.map((cell) => cell.textContent), ["11:04:05", "<b>Clicking</b>", "", "✕"], "history rows are text too");
  assert.deepEqual(row.children[2].children.map((cell) => [cell.id, cell.src ?? cell.textContent]), [["img", "data:image/png;base64,QUJD"], ["span", "Paint"]],
    "each row's app with its icon on the left");
  assert.deepEqual(odd.children[2].children.map((cell) => cell.id), ["span"], "a name that is no app of the map gets no icon");
  elements.toggle.onclick();
  assert.match(document.title, /^computer-control-history:closed:2$/, "each change is a new title, so the app hears every one");
  window.showHistory([]);
  assert.equal(elements.list.children[0].textContent, "Nothing done yet.");

  window.showFrame({ src: "data:image/jpeg;base64,AAAA", time: "11:04:06", viewOnly: true });
  assert.equal(elements.thumbimg.src, "data:image/jpeg;base64,AAAA", "the small preview on the pill");
  assert.equal(elements.shot.src, "data:image/jpeg;base64,AAAA", "and the large one in the panel");
  assert.equal(elements.thumb.hidden, false);
  assert.equal(document.body.attributes["data-frame"], true);
  assert.match(elements.cap.textContent, /^What it saw at 11:04:06 · view only/);
  elements.thumb.onclick();
  assert.match(document.title, /^computer-control-history:open:3$/, "the preview opens the panel too");

  elements.stop.onclick();
  assert.equal(document.title, "stop-computer-control");
});

test("a call waiting for its review says so, lets no click through, and drops it once it runs", async () => {
  const { control, made } = pill();
  try {
    await control.start({ workspaceId: "ws", agent: "Codex", target: { window_id: 7, pid: 70, title: "Paint", app: "mspaint.exe" } });
    await settle();
    const [window] = made;
    const click = control.activity({ tool: "computer_action", args: { step: { action: "click", selector: { name: "Save" } } }, waiting: true });
    assert.equal(calls(window, "show").at(-1).action, "Clicking “Save” · waiting for approval");
    assert.deepEqual(window.ignoring, [], "Stop stays clickable while nothing can act yet");
    click.proceed();
    assert.equal(calls(window, "show").at(-1).action, "Clicking “Save”");
    assert.deepEqual(window.ignoring, [true], "now its click passes under the pill");
    click.proceed();
    assert.deepEqual(window.ignoring, [true], "proceeding twice changes nothing");
    click("done");
    assert.deepEqual(window.ignoring, [true, false]);
    assert.equal(control.history()[0].action, "Clicking “Save”");

    const denied = control.activity({ tool: "computer_snapshot", args: {}, waiting: true });
    denied("failed");
    assert.deepEqual([control.history()[0].action, control.history()[0].outcome], ["Looking at the window", "failed"],
      "a call the review refused is in the history by its step, marked failed");
    assert.equal(typeof control.activity({ tool: "computer_status", args: {} }).proceed, "function", "a quiet call can be proceeded too");
  } finally { control.dispose(); }
});

test("the pill previews what the agent saw: fetched once per new frame, shown small and large, never re-asked when it fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { control, made, requests, agent } = pill();
  const beat = async () => { t.mock.timers.tick(1_000); for (let i = 0; i < 5; i += 1) await settle(); };
  const frames = () => requests.filter((endpoint) => endpoint.startsWith("/api/v1/computer/frame"));
  try {
    await control.start({ workspaceId: "ws", agent: "Codex", target: { window_id: 7, pid: 70, title: "Paint", app: "mspaint.exe" } });
    await settle();
    const [window] = made;
    await beat();
    assert.equal(frames().length, 0, "no frame yet: nothing is fetched");
    assert.equal(calls(window, "showFrame").length, 0);

    agent.frame = { snapshot_id: "s1", captured_at_unix_ms: Date.UTC(2026, 10, 9, 3, 4, 5), data_url: "data:image/jpeg;base64,QUJD", input_available: true };
    await beat();
    assert.deepEqual(frames(), ["/api/v1/computer/frame"]);
    const [shown] = calls(window, "showFrame");
    assert.equal(shown.src, "data:image/jpeg;base64,QUJD");
    assert.match(shown.time, /^\d\d:\d\d:\d\d$/);
    assert.equal(shown.viewOnly, false);
    await beat();
    assert.equal(frames().length, 1, "the frame it shows is not fetched again");

    assert.equal(window.retitle("computer-control-history:open:1"), true);
    assert.equal(window.bounds.height, 40 + 268 + 320, "an open panel holds the preview over the history");

    agent.frame = { snapshot_id: "s2", captured_at_unix_ms: 0, data_url: "data:image/jpeg;base64,REVG", input_available: false };
    await beat();
    assert.deepEqual(frames().at(-1), "/api/v1/computer/frame?after=s1", "only a frame newer than the one shown");
    assert.equal(calls(window, "showFrame").at(-1).viewOnly, true, "a window the engine cannot act in is marked view only");

    agent.frame = { snapshot_id: "s3", data_url: "javascript:alert(1)" };
    await beat();
    assert.equal(calls(window, "showFrame").length, 2, "anything but a JPEG data URL is never shown");
    agent.frame = { snapshot_id: "s4", data_url: "data:image/jpeg;base64,R0hJ" };
    agent.frameFails = true;
    await beat();
    await beat();
    await beat();
    assert.equal(frames().filter((endpoint) => endpoint.endsWith("s2")).length, 2, "a failed frame is asked for once, not every second");
  } finally { control.dispose(); }
});

test("asking for another window moves control there instead of failing on the one already controlled", async () => {
  const { control, made, requests } = pill();
  try {
    await control.start({ workspaceId: "ws", agent: "Codex", target: { window_id: 7, pid: 70, title: "Paint", app: "mspaint.exe" } });
    await settle();
    assert.equal(requests.includes("/api/v1/computer/stop"), false, "nothing to stop the first time");
    await control.start({ workspaceId: "ws", agent: "Codex", target: { window_id: 8, pid: 80, title: "Notepad", app: "notepad.exe" } });
    await settle();
    const order = requests.filter((endpoint) => /computer\/(stop|start)$/.test(endpoint));
    assert.deepEqual(order, ["/api/v1/computer/start", "/api/v1/computer/stop", "/api/v1/computer/start"], "the old control ends before the new one starts");
    assert.equal(made[0].destroyed, true, "the old pill goes");
    assert.equal(made.length, 2);
    assert.equal(control.controlled().app, "notepad.exe");
    const page = decodeURIComponent(made[1].url.slice(made[1].url.indexOf(",") + 1));
    assert.match(page, /<span class="name" id="appname">Notepad<\/span>/);
  } finally { control.dispose(); }
});

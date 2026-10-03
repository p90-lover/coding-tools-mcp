"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const vm = require("node:vm");

const sourcePath = path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs");
const firstBounds = { x: 0, y: 0, width: 500, height: 400 };
const latestBounds = { x: 30, y: 40, width: 700, height: 600 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(hooks = {}) {
  const children = [];
  const gateways = [];
  const reservations = [];
  const views = [];
  const requests = [];
  const events = [];
  const warnings = [];
  const opened = [];
  const binary = Buffer.from("fake source-built Go daemon");
  const resourceRoot = path.resolve("ao-lifecycle-fixture/resources");
  const dataRoot = path.resolve("ao-lifecycle-fixture/data");
  const manifest = { localOnly: true, standaloneInstall: false, daemonSha256: crypto.createHash("sha256").update(binary).digest("hex"), ...hooks.manifest };
  const parent = {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: { focus: () => hooks.focusMain?.() },
    getContentBounds: () => ({ width: 1000, height: 800 }),
    contentView: {
      children: [],
      addChildView(view) {
        assert.equal(view.closed, false, "a closed view cannot be attached");
        assert.equal(this.children.includes(view), false, "a view is attached only once");
        this.children.push(view);
        view.attachments += 1;
      },
      removeChildView(view) {
        assert.ok(this.children.includes(view));
        this.children.splice(this.children.indexOf(view), 1);
      },
    },
  };

  class FakeView {
    constructor(options) {
      this.options = options;
      this.closed = false;
      this.attachments = 0;
      this.boundsHistory = [];
      this.webContents = new EventEmitter();
      this.webContents.session = {
        setPermissionRequestHandler: (handler) => { this.permissionRequest = handler; },
        setPermissionCheckHandler: (handler) => { this.permissionCheck = handler; },
      };
      this.webContents.setWindowOpenHandler = (handler) => { this.windowOpen = handler; };
      this.focusCalls = 0;
      this.webContents.isDestroyed = () => this.closed;
      this.webContents.isFocused = () => false;
      this.webContents.focus = () => { this.focusCalls += 1; };
      this.webContents.close = () => {
        assert.equal(this.closed, false);
        this.closed = true;
        events.push("view closed");
      };
      this.webContents.loadURL = async (url) => {
        this.url = url;
        await hooks.loadURL?.(this);
      };
      this.webContents.getURL = () => this.url;
      this.webContents.executeJavaScript = async (script) => {
        const location = new URL(this.url);
        vm.runInNewContext(script, { location });
        this.url = location.toString();
      };
      views.push(this);
    }
    setBounds(bounds) {
      assert.equal(this.closed, false, "a closed view cannot be resized");
      this.bounds = { ...bounds };
      this.boundsHistory.push(this.bounds);
    }
    setVisible(visible) {
      assert.equal(this.closed, false);
      this.visible = visible;
    }
  }

  const dependencies = {
    "./agent-orchestrator-workspace.cjs": require("../electron/agent-orchestrator-workspace.cjs"),
    "node:crypto": crypto,
    "node:path": path,
    "node:fs": {
      readFileSync(filename) {
        if (filename === path.join(resourceRoot, "manifest.json")) return JSON.stringify(manifest);
        assert.equal(filename, path.join(resourceRoot, process.platform === "win32" ? "ao-daemon.exe" : "ao-daemon"));
        return binary;
      },
      mkdirSync(directory) { assert.equal(directory, dataRoot); },
    },
    "node:net": {
      createServer() {
        const reservation = new EventEmitter();
        const port = 41000 + reservations.length;
        reservation.closed = false;
        reservation.address = () => ({ port });
        reservation.listen = (requestedPort, host, callback) => {
          assert.equal(requestedPort, 0);
          assert.equal(host, "127.0.0.1");
          Promise.resolve(hooks.portListen?.()).then(callback, (error) => reservation.emit("error", error));
        };
        reservation.close = (callback) => {
          Promise.resolve(hooks.portClose?.()).then(() => { reservation.closed = true; callback(); });
        };
        reservations.push(reservation);
        return reservation;
      },
    },
    "node:child_process": {
      spawn(executable, args, options) {
        const child = new EventEmitter();
        Object.assign(child, { pid: 51000 + children.length, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), executable, args, options, kills: 0 });
        child.exit = (code = 0, signal = null) => {
          child.exitCode = code;
          child.signalCode = signal;
          child.emit("exit", code, signal);
        };
        child.kill = () => { child.kills += 1; child.exit(null, "SIGTERM"); };
        children.push(child);
        events.push(`spawn ${child.pid}`);
        return child;
      },
      spawnSync() { throw new Error("Git is outside these lifecycle tests"); },
    },
    "./agent-orchestrator-gateway.cjs": {
      createAgentOrchestratorGateway(options) {
        const origin = `http://127.0.0.1:${42000 + gateways.length}`;
        const gateway = {
          options, origin, openUrl: `${origin}/open/fake-token`, closed: false, closeCalls: 0,
          async listen() { await hooks.gatewayListen?.(); return { origin, openUrl: this.openUrl }; },
          async close() {
            this.closeCalls += 1;
            await hooks.gatewayClose?.();
            this.closed = true;
            events.push(`gateway closed ${origin}`);
          },
        };
        gateways.push(gateway);
        return gateway;
      },
    },
  };
  const loadedModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    module: loadedModule,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`); return dependencies[name]; },
    process: { platform: process.platform, env: { PATH: "fixture", AO_PORT: "1", AO_REMOTE: "inherited-value" } },
    Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    async fetch(url, options) {
      const endpoint = new URL(url);
      assert.equal(endpoint.hostname, "127.0.0.1");
      assert.equal(options.redirect, "error");
      requests.push({ url, options });
      const child = children.find((candidate) => candidate.options.env.AO_PORT === endpoint.port);
      assert.ok(child, "requests target an owned daemon");
      if (endpoint.pathname === "/shutdown") {
        await hooks.shutdown?.(child);
        child.exit(0);
        return { ok: true };
      }
      if (endpoint.pathname === "/api/v1/projects") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ projects: [] }) };
      }
      assert.equal(endpoint.pathname, "/readyz");
      await hooks.readyFetch?.(child);
      return { ok: true, json: async () => { await hooks.readyBody?.(child); return { pid: child.pid, status: "ready" }; } };
    },
  }, { filename: sourcePath });
  const controller = loadedModule.exports.createAgentOrchestratorUpstream({
    resourceRoot, dataRoot, WebContentsView: FakeView, getWindow: () => parent,
    getWorkspaces: hooks.getWorkspaces, missionCall: hooks.missionCall,
    confirm: async (request) => hooks.confirm?.(request) ?? true,
    shell: { openExternal: async (url) => { opened.push(url); } },
    openAuth: hooks.openAuth,
    logger: { warn: (...entry) => warnings.push(entry) },
  });
  return { controller, children, gateways, reservations, views, requests, events, warnings, parent, opened };
}

test("Runtime opens the original AO board and keeps the selected project", async () => {
  const { controller, views, gateways } = createHarness();
  try {
    await controller.show(firstBounds, true);
    assert.equal(views[0].url, `${gateways[0].origin}/#/sessions/`);
    await views[0].webContents.loadURL(`${gateways[0].origin}/#/projects/project-a/sessions/worker-a`);
    await controller.show(latestBounds, true);
    assert.equal(views[0].url, `${gateways[0].origin}/#/projects/project-a`);
    await views[0].webContents.loadURL(`${gateways[0].origin}/#/coding-tools-board?workspaceId=qa`);
    await controller.show(latestBounds, false);
    assert.equal(views[0].url, `${gateways[0].origin}/#/projects/project-a/sessions/worker-a`);
  } finally { await controller.stop(); }
});

test("the AO view may use the clipboard from its gateway origin and nothing else", async () => {
  const { controller, views, gateways } = createHarness();
  try {
    await controller.show(firstBounds);
    const [view] = views;
    const origin = gateways[0].origin;
    const request = (permission, requestingUrl) => new Promise((resolve) => view.permissionRequest(null, permission, resolve, { requestingUrl }));
    assert.equal(await request("clipboard-read", `${origin}/#/coding-tools-terminal`), true);
    assert.equal(await request("clipboard-sanitized-write", `${origin}/`), true);
    assert.equal(await request("clipboard-read", "https://example.com/"), false);
    assert.equal(await request("media", `${origin}/`), false);
    assert.equal(await request("clipboard-read", undefined), false);
    assert.equal(view.permissionCheck(null, "clipboard-read", origin), true);
    assert.equal(view.permissionCheck(null, "clipboard-read", "https://example.com"), false);
    assert.equal(view.permissionCheck(null, "notifications", origin), false);
  } finally { await controller.stop(); }
});

test("terminal sign-in links stay in the managed browser, while other links require confirmation", async () => {
  let answer = false;
  const asked = [];
  const auth = [];
  const { controller, views, opened } = createHarness({ openAuth: async url => auth.push(url), confirm: (request) => { if (request?.detail) { asked.push(request.detail); return answer; } return true; } });
  try {
    await controller.show(firstBounds);
    const click = async (url) => {
      assert.equal(views[0].windowOpen({ url }).action, "deny");
      await nextTurn(); await nextTurn();
    };
    await click("https://accounts.google.com/o/oauth2/auth?client_id=x");
    await click("https://example.com/docs");
    answer = true;
    await click("https://example.com/readme");
    await click("https://user:secret@accounts.google.com/");
    await click("file:///C:/Windows/System32/calc.exe");
    await click("javascript:alert(1)");
    assert.deepEqual(auth, ["https://accounts.google.com/o/oauth2/auth?client_id=x"]);
    assert.deepEqual(opened, ["https://example.com/readme"]);
    assert.deepEqual(asked, ["https://example.com/docs", "https://example.com/readme"]);
  } finally { await controller.stop(); }
});

for (const stage of ["portListen", "portClose", "gatewayListen", "readyFetch", "readyBody"]) {
  test(`stop waits for cancellation during ${stage} and never leaves a daemon running`, async (context) => {
    const entered = deferred();
    const release = deferred();
    const harness = createHarness({ [stage]: () => { entered.resolve(); return release.promise; } });
    const { controller } = harness;
    context.after(async () => { release.resolve(); await controller.stop(); });
    const startup = controller.start().then((value) => ({ value }), (error) => ({ error }));
    await entered.promise;
    let stopFinished = false;
    const stopping = controller.stop().then((value) => { stopFinished = true; return value; });
    const repeatedStop = controller.stop();
    await nextTurn();
    const finishedBeforeCancellation = stopFinished;
    release.resolve();
    const [startupResult, stopped, stoppedAgain] = await Promise.all([startup, stopping, repeatedStop]);
    assert.equal(finishedBeforeCancellation, false, "stop must wait for the pending startup continuation");
    assert.match(startupResult.error?.message || "", /cancelled/i);
    assert.equal(stopped.state, "stopped");
    assert.equal(stoppedAgain.state, "stopped");
    assert.equal(controller.snapshot().state, "stopped");
    assert.equal(controller.snapshot().pid, null);
    assert.equal(controller.snapshot().port, null);
    assert.equal(harness.children.length, stage.startsWith("ready") ? 1 : 0);
    assert.ok(harness.children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.ok(harness.gateways.every((gateway) => gateway.closed && gateway.closeCalls === 1));
    assert.ok(harness.reservations.every((reservation) => reservation.closed));
    assert.deepEqual(harness.warnings, [], "intentional cancellation is not a startup failure");
  });
}

test("concurrent stops share cleanup and a new start waits for the old gateway", async (context) => {
  const closing = deferred();
  const release = deferred();
  const harness = createHarness({ gatewayClose: () => { closing.resolve(); return release.promise; } });
  const { controller } = harness;
  context.after(async () => { release.resolve(); await controller.stop(); });
  await controller.start();
  const stopping = controller.stop();
  await closing.promise;
  const repeatedStop = controller.stop();
  let restarted = false;
  const restarting = controller.start().then((value) => { restarted = true; return value; });
  await nextTurn();
  const restartedBeforeCleanup = restarted;
  release.resolve();
  const [, , ready] = await Promise.all([stopping, repeatedStop, restarting]);
  assert.equal(restartedBeforeCleanup, false);
  assert.equal(harness.gateways[0].closeCalls, 1);
  assert.equal(harness.children.length, 2);
  assert.equal(ready.state, "ready");
  assert.equal(ready.pid, harness.children[1].pid);
  assert.equal(harness.requests.filter(({ url }) => url.endsWith("/shutdown")).length, 1);
  assert.ok(harness.events.indexOf(`gateway closed ${harness.gateways[0].origin}`) < harness.events.indexOf(`spawn ${harness.children[1].pid}`));
});

test("recovery after daemon exit closes the old gateway and loads a fresh view URL", async (context) => {
  const harness = createHarness();
  const { controller } = harness;
  context.after(() => controller.stop());
  await controller.show(firstBounds);
  const oldView = harness.views[0];
  harness.children[0].exit(7);
  assert.equal(controller.snapshot().state, "error");
  await controller.show(latestBounds);
  assert.equal(harness.gateways[0].closed, true);
  assert.equal(harness.gateways[0].closeCalls, 1);
  assert.equal(oldView.closed, true);
  assert.equal(harness.views.length, 2);
  assert.equal(harness.views[1].url, harness.gateways[1].openUrl);
  assert.notEqual(harness.views[1].url, oldView.url);
  assert.deepEqual(harness.views[1].bounds, latestBounds);
  assert.deepEqual(harness.parent.contentView.children, [harness.views[1]]);
  assert.equal(harness.requests.filter(({ url }) => url.endsWith("/shutdown")).length, 0, "an exited daemon needs no shutdown request");
});

test("stop during recovery waits for old resources and cancels the replacement startup", async (context) => {
  const closing = deferred();
  const release = deferred();
  const harness = createHarness({ gatewayClose: () => { closing.resolve(); return release.promise; } });
  const { controller } = harness;
  context.after(async () => { release.resolve(); await controller.stop(); });
  await controller.show(firstBounds);
  harness.children[0].exit(7);
  const restarting = assert.rejects(controller.start(), /cancelled/i);
  await closing.promise;
  let stopFinished = false;
  const stopping = controller.stop().then((value) => { stopFinished = true; return value; });
  await nextTurn();
  const finishedBeforeCleanup = stopFinished;
  release.resolve();
  await restarting;
  assert.equal((await stopping).state, "stopped");
  assert.equal(finishedBeforeCleanup, false);
  assert.equal(harness.children.length, 1);
  assert.equal(harness.reservations.length, 1);
  assert.equal(harness.gateways[0].closeCalls, 1);
  assert.equal(harness.gateways[0].closed, true);
  assert.equal(harness.views[0].closed, true);
  assert.equal(harness.parent.contentView.children.length, 0);
});

for (const update of ["show", "hide then show", "bounds", "hide"]) {
  test(`pending loadURL cannot overwrite a later ${update} request`, async (context) => {
    const loading = deferred();
    const release = deferred();
    const harness = createHarness({ loadURL: () => { loading.resolve(); return release.promise; } });
    const { controller } = harness;
    context.after(async () => { release.resolve(); await controller.stop(); });
    const showing = controller.show(firstBounds);
    await loading.promise;
    if (update.startsWith("hide")) controller.hide();
    if (update.endsWith("show")) await controller.show(latestBounds);
    if (update === "bounds") await controller.call("upstream_bounds", { bounds: latestBounds });
    const changesBeforeCompletion = harness.views[0].boundsHistory.length;
    release.resolve();
    await showing;
    assert.equal(harness.views[0].boundsHistory.length, changesBeforeCompletion, "load completion must not reapply old bounds");
    assert.deepEqual(harness.views[0].bounds, update === "hide" ? firstBounds : latestBounds);
    assert.equal(harness.views[0].visible, update !== "hide");
    assert.equal(harness.parent.contentView.children.length, update === "hide" ? 0 : 1);
  });
}

for (const completion of ["resolve", "reject"]) {
  test(`an old view load that ${completion}s after stop and restart cannot change the replacement view`, async (context) => {
    const loading = deferred();
    const release = deferred();
    let loadCount = 0;
    const harness = createHarness({ loadURL: () => { if (++loadCount === 1) { loading.resolve(); return release.promise; } } });
    const { controller } = harness;
    context.after(async () => { release.resolve(); await controller.stop(); });
    const oldShow = controller.show(firstBounds);
    await loading.promise;
    await controller.stop();
    await controller.show(latestBounds);
    const replacement = harness.views[1];
    const changesBeforeCompletion = replacement.boundsHistory.length;
    if (completion === "reject") release.reject(new Error("ERR_ABORTED: closed view"));
    else release.resolve();
    await oldShow;
    assert.equal(harness.views[0].closed, true);
    assert.equal(replacement.boundsHistory.length, changesBeforeCompletion);
    assert.deepEqual(replacement.bounds, latestBounds);
    assert.deepEqual(harness.parent.contentView.children, [replacement]);
  });
}

test("only the latest show can attach after shared startup completes", async (context) => {
  const listening = deferred();
  const release = deferred();
  const harness = createHarness({ gatewayListen: () => { listening.resolve(); return release.promise; } });
  const { controller } = harness;
  context.after(async () => { release.resolve(); await controller.stop(); });
  const firstShow = controller.show(firstBounds);
  await listening.promise;
  controller.hide();
  const latestShow = controller.show(latestBounds);
  release.resolve();
  await Promise.all([firstShow, latestShow]);
  assert.equal(harness.views.length, 1);
  assert.equal(harness.views[0].attachments, 1);
  assert.ok(harness.views[0].boundsHistory.every((bounds) => JSON.stringify(bounds) === JSON.stringify(latestBounds)));
});

test("daemon exit during a readiness response cannot publish ready and startup failure is recoverable", async (context) => {
  let exitDuringReadiness = true;
  const harness = createHarness({ readyBody: (child) => { if (exitDuringReadiness) child.exit(9); } });
  const { controller } = harness;
  context.after(() => controller.stop());
  await assert.rejects(controller.start(), /AO exited \(9\)/);
  assert.equal(controller.snapshot().state, "error");
  assert.equal(harness.gateways[0].closed, true);
  exitDuringReadiness = false;
  assert.equal((await controller.start()).state, "ready");
});

test("lifecycle changes preserve manifest validation, daemon environment, and stop confirmation", async (context) => {
  for (const manifest of [{ daemonSha256: "invalid" }, { localOnly: false }, { standaloneInstall: true }]) {
    const invalid = createHarness({ manifest });
    await assert.rejects(invalid.controller.start(), /manifest|local-only/);
    assert.equal(invalid.children.length, 0);
    assert.equal(invalid.reservations.length, 0);
  }
  let allowStop = false;
  const harness = createHarness({ confirm: () => allowStop });
  const { controller } = harness;
  context.after(() => controller.stop());
  await controller.start();
  const environment = harness.children[0].options.env;
  assert.equal(environment.AO_PORT, String(controller.snapshot().port));
  assert.equal(environment.AO_ALLOWED_ORIGINS, harness.gateways[0].origin);
  assert.equal(environment.AO_REMOTE, undefined);
  assert.equal(environment.AO_TELEMETRY_REMOTE, "off");
  assert.equal(harness.children[0].options.windowsHide, true);
  // The AO CLI binary must be told to run the daemon; it answers pty-host itself when relaunched.
  assert.deepEqual([...harness.children[0].args], ["daemon"]);
  assert.equal((await controller.call("upstream_stop")).cancelled, true);
  assert.equal(controller.snapshot().state, "ready");
  allowStop = true;
  assert.equal((await controller.call("upstream_stop")).state, "stopped");
  assert.equal(harness.children[0].kills, 0, "the daemon uses its HTTP shutdown endpoint first");
});

test("an AO terminal takes keyboard focus when it opens and whenever it is clicked", async () => {
  const { controller, views } = createHarness();
  try {
    await controller.show(firstBounds, false, undefined, { handle: "shellterm-1", generation: "g1", title: "agy" });
    const view = views[0];
    assert.match(new URL(view.url).hash, /^#\/coding-tools-terminal\?handle=shellterm-1/);
    assert.equal(view.focusCalls, 1, "a freshly opened terminal is focused");
    view.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 5, y: 5 });
    assert.equal(view.focusCalls, 1, "moving the pointer does not move focus");
    view.webContents.emit("before-mouse-event", {}, { type: "mouseDown", x: 5, y: 5, button: "left" });
    assert.equal(view.focusCalls, 2, "clicking the AO view gives it keyboard focus");
  } finally { await controller.stop(); }
});

test("mission launch intents hand focus back to the main controller before publishing", async () => {
  let mainFocused = false;
  let childFocused = true;
  let selectionAtFocus;
  const harness = createHarness({
    getWorkspaces: async () => [{ id: "qa", path: path.resolve(__dirname, "../..") }],
    missionCall: async operation => operation === "board"
      ? { ok: true, revision: 1, tasks: [] } : { ok: true, runs: [{ id: "mission-qa" }] },
    focusMain: () => {
      selectionAtFocus = harness.controller.snapshot().missionSelection;
      mainFocused = true;
      childFocused = false;
    },
  });
  try {
    await harness.controller.show(firstBounds);
    const view = harness.views[0];
    view.webContents.isFocused = () => childFocused;
    for (const intent of ["start", "resume", "restart"]) {
      mainFocused = false;
      childFocused = true;
      const previous = harness.controller.snapshot().missionSelection;
      await harness.gateways[0].options.desktopRequest("mission_open", { workspaceId: "qa", runId: "mission-qa", intent });
      assert.equal(mainFocused, true, `${intent} gives the guarded main controller keyboard focus`);
      assert.equal(childFocused, false);
      assert.equal(selectionAtFocus, previous, "focus is transferred before a launch intent becomes visible to the poller");
      assert.equal(harness.controller.snapshot().missionSelection.intent, intent);
    }
  } finally { await harness.controller.stop(); }
});

test("mission navigation never steals focus from background or unavailable views", async () => {
  let mainFocused = false;
  let childFocused = true;
  const harness = createHarness({
    getWorkspaces: async () => [{ id: "qa", path: path.resolve(__dirname, "../..") }],
    missionCall: async operation => operation === "board"
      ? { ok: true, revision: 1, tasks: [] } : { ok: true, runs: [{ id: "mission-qa" }] },
    focusMain: () => { mainFocused = true; childFocused = false; },
  });
  try {
    await harness.controller.show(firstBounds);
    const view = harness.views[0];
    for (const state of [
      { intent: "open" }, { focused: false }, { visible: false },
      { minimized: true }, { destroyed: true }, { childFocused: false },
      { childDestroyed: true }, { detached: true },
    ]) {
      if (state.detached) harness.controller.hide();
      mainFocused = false;
      childFocused = state.childFocused !== false;
      harness.parent.isFocused = () => state.focused !== false;
      harness.parent.isVisible = () => state.visible !== false;
      harness.parent.isMinimized = () => state.minimized === true;
      harness.parent.isDestroyed = () => state.destroyed === true;
      view.webContents.isFocused = () => childFocused;
      view.webContents.isDestroyed = () => state.childDestroyed === true;
      await harness.gateways[0].options.desktopRequest("mission_open", {
        workspaceId: "qa", runId: "mission-qa", intent: state.intent || "start",
      });
      assert.equal(mainFocused, false, JSON.stringify(state));
    }
  } finally { await harness.controller.stop(); }
});

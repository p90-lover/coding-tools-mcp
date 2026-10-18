"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PREVIEW_TOOL_DEFS, createChatPreviews, previewTarget } = require("../electron/chat-preview.cjs");
const { createChatAgentTools, instructionsFor, previewOriginDecision } = require("../electron/chat-agent-tools.cjs");

/** A WebContentsView stand-in: records bounds, protocol commands and the session's handlers. */
function fakeView({ page = {} } = {}) {
  const handlers = {};
  const session = { handlers: {} };
  const sent = [];
  const contents = {
    url: "about:blank", title: "", destroyed: false,
    isDestroyed() { return this.destroyed; },
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    emit(event, ...args) { for (const fn of handlers[event] ?? []) fn(...args); },
    setWindowOpenHandler(fn) { this.openHandler = fn; },
    async loadURL(url) {
      if (page.refused?.(url)) throw new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}'`);
      (this.loads ??= []).push(url);
      const failed = page.fail?.(url);
      if (failed) throw new Error(`${failed} (-101) loading '${url}'`);
      this.url = url;
      this.title = page.title ?? "Page";
    },
    getURL() { return this.url; },
    getTitle() { return this.title; },
    enableDeviceEmulation() { this.emulated = true; },
    disableDeviceEmulation() { this.emulated = false; },
    reload() { sent.push(["reload"]); },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    close() { this.destroyed = true; },
    setWebRTCIPHandlingPolicy(policy) { this.webrtc = policy; },
    debugger: {
      attached: false,
      isAttached() { return this.attached; },
      attach() { this.attached = true; },
      on() {},
      async sendCommand(method, params) {
        sent.push([method, params]);
        if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
        if (method === "Runtime.evaluate") return { result: { value: page.evaluate ? page.evaluate(params.expression) : null } };
        return {};
      },
    },
    session: {
      setPermissionRequestHandler(fn) { session.handlers.permission = fn; },
      setPermissionCheckHandler(fn) { session.handlers.check = fn; },
      on(event, fn) { session.handlers[event] = fn; },
      async setProxy(config) { session.proxy = config; },
      async clearStorageData() { session.cleared = true; },
      async clearCache() {},
      webRequest: {
        onBeforeRequest(_filter, fn) { session.handlers.before = fn; },
        onCompleted(_filter, fn) { session.handlers.completed = fn; },
        onErrorOccurred(_filter, fn) { session.handlers.error = fn; },
      },
    },
  };
  return { webContents: contents, bounds: null, setBounds(bounds) { this.bounds = bounds; }, setVisible() {}, sent, session };
}

function previews({ page, blocked = [4000] } = {}) {
  const views = [];
  const attached = new Set();
  const service = createChatPreviews({
    createView: () => { const view = fakeView({ page }); views.push(view); return view; },
    attachView: (view) => attached.add(view), detachView: (view) => attached.delete(view),
    contentSize: () => [1600, 1000], blockedPorts: () => blocked, logger: { warn() {} },
  });
  return { service, views, attached };
}

test("a preview opens only http(s) pages on this machine, never the app's own service ports", () => {
  assert.deepEqual(previewTarget("http://localhost:5173/app"), { url: "http://localhost:5173/app", origin: "http://localhost:5173" });
  for (const ok of ["http://127.0.0.1:3000", "https://localhost:8443/", "http://[::1]:8080/", "http://app.localhost:5173/", "http://127.1.2.3:9000"]) {
    assert.ok(previewTarget(ok).url, ok);
  }
  for (const refused of ["https://example.com/", "http://192.168.1.10:3000", "file:///C:/secret.txt", "javascript:alert(1)", "data:text/html,hi",
    "http://user:pass@localhost:3000", "http://localhost.example.com:3000", "not a url", ""]) {
    assert.ok(previewTarget(refused).refused, refused);
  }
  assert.match(previewTarget("http://localhost:4000/", { blockedPorts: [4000] }).refused, /belongs to Coding Tools/);
  assert.match(previewTarget("http://localhost/", { blockedPorts: [80] }).refused, /Port 80/, "a default port counts");
});

test("the agent opens its page once allowed, and reads, screenshots, clicks and types in it through the page's own protocol", async () => {
  const { service, views, attached } = previews({ page: {
    evaluate: (expression) => (expression.includes("data-ct-ref=\"7\"") ? { x: 40, y: 50 }
      : expression.includes("querySelectorAll") ? { url: "http://localhost:5173/", title: "App", text: "Hello", elements: [{ ref: "7", role: "button", name: "Save" }] } : null),
  } });
  const asked = [];
  const permit = async (origin) => { asked.push(origin); return true; };
  const opened = await service.call("s1", "preview_open", { url: "http://localhost:5173/" }, { permit });
  assert.equal(opened.isError, false);
  assert.equal(opened.structuredContent.url, "http://localhost:5173/");
  assert.deepEqual(asked, ["http://localhost:5173"]);
  assert.equal(views.length, 1);
  assert.ok(attached.has(views[0]), "the view lives in the window");
  assert.ok(views[0].bounds.x < -1280 && views[0].bounds.y < -800 && views[0].webContents.emulated,
    "but above and left of it, with a real viewport, while the pane does not show it: no resize can bring it into view");
  await service.call("s1", "preview_open", { url: "http://localhost:5173/other" }, { permit });
  assert.deepEqual(asked, ["http://localhost:5173"], "an origin already opened is not asked about again");

  const read = await service.call("s1", "preview_read", {});
  assert.equal(read.structuredContent.elements[0].ref, "7");
  const shot = await service.call("s1", "preview_screenshot", {});
  assert.deepEqual(shot.content[0], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });

  await service.call("s1", "preview_click", { ref: "7" });
  const mouse = views[0].sent.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => `${params.type}@${params.x},${params.y}`);
  assert.deepEqual(mouse, ["mouseMoved@40,50", "mousePressed@40,50", "mouseReleased@40,50"]);
  await service.call("s1", "preview_type", { text: "hi", submit: true });
  assert.ok(views[0].sent.some(([method, params]) => method === "Input.insertText" && params.text === "hi"));
  assert.ok(views[0].sent.some(([method, params]) => method === "Input.dispatchKeyEvent" && params.key === "Enter" && params.type === "keyDown"));
  assert.match((await service.call("s1", "preview_click", { ref: "x'); alert(1); ('" })).content[0].text, /ref must be/, "a ref is only digits, never script");
  assert.match((await service.call("s1", "preview_press", { key: "F13" })).content[0].text, /Unknown key/);
});

test("a localhost page whose connection is reset opens over 127.0.0.1, where the dev server listens", async () => {
  // Seen live: preview_open of a running app on :8000 failed with a reset while its health check
  // (to 127.0.0.1) passed: "localhost" reached another listener on [::1].
  const { service, views } = previews({ page: { fail: (url) => (url.includes("localhost:8000") ? "ERR_CONNECTION_RESET" : null) } });
  const opened = await service.call("s1", "preview_open", { url: "http://localhost:8000/admin" }, { permit: async () => true });
  assert.equal(opened.isError, false, opened.content[0].text);
  assert.equal(opened.structuredContent.url, "http://127.0.0.1:8000/admin");
  assert.deepEqual(views[0].webContents.loads, ["http://localhost:8000/admin", "http://127.0.0.1:8000/admin"]);
  // Its requests to both spellings of the same address stay allowed; another port does not.
  const before = views[0].session.handlers.before;
  for (const [url, cancel] of [["http://127.0.0.1:8000/api", false], ["http://localhost:8000/api", false], ["http://127.0.0.1:8001/", true]]) {
    let verdict;
    before({ url }, (answer) => { verdict = answer; });
    assert.equal(verdict.cancel, cancel, url);
  }
});

test("a dev server that keeps resetting the connection gets a message naming the server, not the preview", async () => {
  const { service, views } = previews({ page: { fail: () => "ERR_CONNECTION_RESET" } });
  const failed = await service.call("s1", "preview_open", { url: "http://localhost:8000/" }, { permit: async () => true });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /dev server at http:\/\/localhost:8000\/ closed the connection \(ERR_CONNECTION_RESET\), over 127\.0\.0\.1:8000 too/);
  assert.match(failed.content[0].text, /not the preview/);
  assert.equal(views[0].webContents.loads.length, 3, "localhost, then 127.0.0.1, then 127.0.0.1 once more after a moment");
  let calls = 0;
  const flaky = previews({ page: { fail: () => (calls++ === 0 ? "ERR_CONNECTION_RESET" : null) } });
  const retried = await flaky.service.call("s1", "preview_open", { url: "http://[::1]:5173/" }, { permit: async () => true });
  assert.equal(retried.isError, false, "a single reset (a reloading dev server) is retried");
});

test("refusals: other hosts, the app's ports, a declined origin, nothing listening, and calls before any page", async () => {
  const { service, views } = previews({ page: { refused: (url) => url.includes(":9999") } });
  assert.match((await service.call("s1", "preview_read", {})).content[0].text, /no page open yet/);
  assert.match((await service.call("s1", "preview_open", { url: "https://example.com" })).content[0].text, /served on this machine only/);
  assert.match((await service.call("s1", "preview_open", { url: "http://127.0.0.1:4000" })).content[0].text, /belongs to Coding Tools/);
  const declined = { content: [{ type: "text", text: "The user did not allow it" }], isError: true };
  assert.equal(await service.call("s1", "preview_open", { url: "http://localhost:3000" }, { permit: async () => declined }), declined);
  assert.equal(views.length, 0, "nothing opened before the user allowed it");
  const refused = await service.call("s1", "preview_open", { url: "http://localhost:9999" });
  assert.match(refused.content[0].text, /Nothing is listening.*start the dev server first/);
});

test("the page stays away from the app's services and anything of the user's, and its console and failures are kept for the agent", async () => {
  const { service, views } = previews();
  await service.call("s1", "preview_open", { url: "http://localhost:5173/" });
  const [{ webContents: contents, session }] = views;
  let cancel;
  session.handlers.before({ url: "http://127.0.0.1:4000/api/v1/tools/call" }, (answer) => { cancel = answer.cancel; });
  assert.equal(cancel, true, "a request to an app port is cancelled");
  session.handlers.before({ url: "ws://localhost:4000/socket" }, (answer) => { cancel = answer.cancel; });
  assert.equal(cancel, true, "a websocket too");
  for (const rebound of ["http://localtest.me:4000/", "http://0.0.0.0:4000/", "http://[::ffff:127.0.0.1]:4000/", "http://2130706433:4000/"]) {
    session.handlers.before({ url: rebound }, (answer) => { cancel = answer.cancel; });
    assert.equal(cancel, true, `${rebound}: any name for this machine reaches the same listener`);
  }
  session.handlers.before({ url: "http://localhost:5173/src/main.ts" }, (answer) => { cancel = answer.cancel; });
  assert.equal(cancel, false, "the page's own origin loads");
  session.handlers.before({ url: "ws://localhost:5173/?token=hmr" }, (answer) => { cancel = answer.cancel; });
  assert.equal(cancel, false, "and its own websocket (a dev server's hot reload)");
  for (const outside of ["https://attacker.example/x?d=c2VjcmV0", "https://fonts.googleapis.com/css", "http://192.168.1.1/admin",
    "http://localhost:11434/api/generate", "ws://127.0.0.1:8888/api/kernels", "ftp://localhost:5173/x"]) {
    session.handlers.before({ url: outside }, (answer) => { cancel = answer.cancel; });
    assert.equal(cancel, true, `${outside}: only origins this chat opened, nothing else on the internet, the LAN or this machine`);
  }
  // A redirect is a new request to the filter (Electron runs onBeforeRequest for each hop): an
  // allowed page's 302 to an app port or another loopback service is cancelled at the next hop.
  for (const hop of ["http://127.0.0.1:4000/api/v1/tools/call", "http://localhost:11434/api/tags"]) {
    session.handlers.before({ url: hop, redirectedFrom: "http://localhost:5173/go" }, (answer) => { cancel = answer.cancel; });
    assert.equal(cancel, true, `the redirect to ${hop} is cancelled`);
  }
  assert.equal(session.proxy.proxyRules, "127.0.0.1:9", "a dead proxy: whatever the filter missed goes nowhere, with no outside DNS lookup");
  assert.equal(contents.webrtc, "disable_non_proxied_udp", "WebRTC sends no UDP around it");
  let framed = false;
  contents.emit("will-frame-navigate", { isMainFrame: false, url: "https://attacker.example/frame", preventDefault() { framed = true; } });
  assert.ok(framed, "a frame stays within the opened origins too");
  let granted;
  session.handlers.permission(contents, "media", (answer) => { granted = answer; });
  assert.equal(granted, false, "no permission is ever granted");
  let cancelled = false;
  session.handlers["will-download"]({ preventDefault() {} }, { cancel() { cancelled = true; } });
  assert.ok(cancelled, "downloads are cancelled");
  assert.deepEqual(contents.openHandler({ url: "https://example.com" }), { action: "deny" }, "no popups");

  let prevented = false;
  contents.emit("will-navigate", { preventDefault() { prevented = true; } }, "http://localhost:6006/");
  assert.ok(prevented, "a link to an origin the chat has not opened is stopped");
  prevented = false;
  contents.emit("will-navigate", { preventDefault() { prevented = true; } }, "http://localhost:5173/next");
  assert.equal(prevented, false, "the page's own origin navigates freely");

  contents.emit("console-message", { level: "error", message: "Uncaught TypeError: x is undefined", lineNumber: 3, sourceId: "http://localhost:5173/src/main.ts" });
  session.handlers.completed({ url: "http://localhost:5173/api/items", statusCode: 500, method: "GET" });
  const log = (await service.call("s1", "preview_console", {})).structuredContent;
  assert.equal(log.messages.at(-1).level, "error");
  assert.match(log.messages.at(-1).text, /TypeError/);
  assert.equal(log.failed_requests.at(-1).status, 500);
  const later = (await service.call("s1", "preview_console", { after: log.next_after })).structuredContent;
  assert.deepEqual([later.messages.length, later.failed_requests.length], [0, 0], "`after` returns only what is new");
});

test("the pane draws one agent's preview at its slot, scaled by the page zoom, and puts it back outside the window after", async () => {
  const { service, views, attached } = previews();
  await service.call("a", "preview_open", { url: "http://localhost:3000/" });
  await service.call("b", "preview_open", { url: "http://localhost:3001/" });
  assert.equal(service.show("a", { x: 100, y: 50, width: 400, height: 300 }, 1.25), true);
  assert.deepEqual(views[0].bounds, { x: 125, y: 63, width: 500, height: 375 });
  assert.equal(views[0].webContents.emulated, false, "drawn for real while shown");
  assert.ok(views[1].bounds.x < 0, "the other agent's stays outside");
  assert.equal(service.state("a").shown, true);
  service.hide();
  assert.ok(views[0].bounds.x < 0);
  assert.equal(service.show("nobody", { x: 0, y: 0, width: 1, height: 1 }), false);
  const closedSession = views[0].session;
  service.close("a");
  assert.equal(closedSession.cleared, true, "a closed preview's partition keeps nothing");
  assert.equal(closedSession.handlers.before, undefined, "and no handler holds the closed preview");
  assert.equal(attached.has(views[0]), false);
  assert.equal(views[0].webContents.destroyed, true);
  assert.equal(service.state("a"), null);
});

test("no page opens when the preview's network guard cannot be set up", async () => {
  const service = createChatPreviews({
    createView: () => {
      const view = fakeView();
      view.webContents.session.setProxy = async () => { throw new Error("proxy failed"); };
      return view;
    },
    logger: { warn() {} },
  });
  const answer = await service.call("s1", "preview_open", { url: "http://localhost:5173/" });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /network guard could not be set up/);
  assert.equal((await service.navigate("s1", { url: "http://localhost:5173/" })).ok, false, "nor from the pane");
});

test("a full-page screenshot is scaled to 1280 wide and cut at 6000 tall", async () => {
  const { service, views } = previews();
  await service.call("s1", "preview_open", { url: "http://localhost:5173/" });
  const send = views[0].webContents.debugger.sendCommand.bind(views[0].webContents.debugger);
  views[0].webContents.debugger.sendCommand = async (method, params) => (method === "Page.getLayoutMetrics"
    ? { cssContentSize: { width: 2560, height: 40_000 } } : send(method, params));
  await service.call("s1", "preview_screenshot", { full_page: true });
  const [, params] = views[0].sent.filter(([method]) => method === "Page.captureScreenshot").at(-1);
  assert.deepEqual(params.clip, { x: 0, y: 0, width: 2560, height: 12_000, scale: 0.5 });
  assert.ok(params.clip.width * params.clip.scale <= 1280 && params.clip.height * params.clip.scale <= 6000);
});

// --- The agent tools server's preview group and the Terminal pane ---------------------------------

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",
      headers: { "content-type": "application/json", ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function server({ confirm = async () => true, preview = () => true, results = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-preview-"));
  const root = path.join(base, "worktrees", "p1");
  fs.mkdirSync(root, { recursive: true });
  const previewCalls = [];
  const closed = [];
  const fakePreviews = {
    async call(key, name, args, { permit }) {
      previewCalls.push([key, name, args]);
      if (name === "preview_open") {
        const answer = await permit(new URL(args.url).origin);
        if (answer !== true) return answer;
      }
      return { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true }, isError: false };
    },
    state: (key) => (key === "ao-1" ? { url: "http://localhost:5173/", title: "App" } : null),
    show: () => true, hide() {}, navigate: async () => ({ ok: true }), close: (key) => closed.push(key),
  };
  const headless = [];
  const confirmations = [];
  const tools = createChatAgentTools({
    previews: fakePreviews, previewEnabled: preview, terminalEnabled: () => true, minAnswerMs: 0, logger: { info() {}, warn() {} },
    confirm: async (request) => { confirmations.push(request); return confirm(request); },
    sessionWorkspace: async () => ({ root }),
    requestHeadless: async (endpoint, body) => {
      if (endpoint.startsWith("/api/v1/tools/catalog?")) return { tools: ["read_file", "exec_command", "read_output", "kill_command"].map((name) => ({ name, inputSchema: { type: "object" } })) };
      headless.push(body);
      const given = results[body.tool];
      const result = typeof given === "function" ? given(body) : given ?? { ok: true };
      return { ok: true, operation: { state: "completed", result } };
    },
  });
  return { tools, root, previewCalls, closed, headless, confirmations, cleanup: async () => { await tools.close(); fs.rmSync(base, { recursive: true, force: true }); } };
}

let id = 1;
async function leased(tools, options = {}) {
  const lease = await tools.lease({ agent: "claude-code", workspaceId: "ws1", ...options });
  lease.bind("ao-1");
  const [{ url, headers }] = lease.servers;
  const call = (name, args = {}) => post(url, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, { authorization: headers.Authorization }).then((reply) => reply.result);
  const list = () => post(url, { jsonrpc: "2.0", id: id++, method: "tools/list" }, { authorization: headers.Authorization }).then((reply) => reply.result.tools.map((tool) => tool.name));
  return { lease, call, list };
}

test("chat agents get the preview tools (on by default, off with the setting) and the user allows each new address once", async (t) => {
  let on = true;
  const env = server({ preview: () => on });
  t.after(env.cleanup);
  const { call, list } = await leased(env.tools);
  const names = await list();
  for (const tool of PREVIEW_TOOL_DEFS) assert.ok(names.includes(tool.name), tool.name);
  await call("preview_open", { url: "http://localhost:5173/" });
  assert.equal(env.confirmations.length, 1, "a new address is the user's call");
  assert.match(env.confirmations[0].detail, /http:\/\/localhost:5173/);
  await call("preview_open", { url: "http://localhost:5173/next" });
  assert.equal(env.confirmations.length, 1, "and once allowed it stays allowed for the chat");
  assert.deepEqual(env.previewCalls.map(([key]) => key), ["ao-1", "ao-1"], "each session has its own preview");
  on = false;
  assert.equal((await list()).some((name) => name.startsWith("preview_")), false);
  assert.match((await call("preview_read")).content[0].text, /Unknown tool/);
});

test("a session whose calls are already reviewed (Approve for me) or that bypasses permissions opens a new address without a second prompt", async (t) => {
  // Seen live: under "Approve for me" the first preview_open waited on a dialog for the 20 s
  // auto-answer although the call, with its address, had already been reviewed on the chat card.
  const env = server();
  t.after(env.cleanup);
  const reviewed = await leased(env.tools, { approvalMode: "accept-edits", autoReview: true });
  assert.equal((await reviewed.call("preview_open", { url: "http://localhost:8000/" })).isError, false);
  assert.equal(env.confirmations.length, 0, "no dialog for a reviewed call");
  const bypass = await leased(env.tools, { approvalMode: "bypass-permissions" });
  assert.equal((await bypass.call("preview_open", { url: "http://127.0.0.1:9000/" })).isError, false);
  assert.equal(env.confirmations.length, 0, "nor for a session that bypasses permissions");
  const plain = await leased(env.tools, { approvalMode: "accept-edits" });
  await plain.call("preview_open", { url: "http://localhost:7000/" });
  assert.equal(env.confirmations.length, 1, "an unreviewed session still asks");
  assert.equal(previewOriginDecision({ origin: "http://localhost:1", bypass: false, servedHere: true }), "ask", "a printed address alone is not enough");
});

test("the tools server closes each connection after answering, so an agent never reuses one Node has dropped", async (t) => {
  // Seen live: "Preview open failed (ECONNRESET)": the agent's MCP client sent preview_open on a
  // pooled keep-alive connection that the server's 5 s idle timeout had just closed.
  const env = server();
  t.after(env.cleanup);
  const lease = await env.tools.lease({ agent: "claude-code", workspaceId: "ws1" });
  lease.bind("ao-1");
  const [{ url, headers }] = lease.servers;
  const answer = await new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",
      agent: new http.Agent({ keepAlive: true }),
      headers: { "content-type": "application/json", authorization: headers.Authorization } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.headers));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
  assert.equal(answer.connection, "close");
});

test("the agent is told first to check any GUI in the Preview pane with preview_open and preview_screenshot", () => {
  const text = instructionsFor(["files", "terminal", "preview"], { autoReview: true });
  assert.ok(text.indexOf("preview_open") > -1 && text.indexOf("preview_open") < 600, "the preview rule leads the instructions");
  assert.match(text, /preview_screenshot/);
  assert.match(text, /curl/);
  assert.match(text, /search_text/);
  assert.doesNotMatch(instructionsFor(["files"], {}), /preview_open/);
  const open = PREVIEW_TOOL_DEFS.find((tool) => tool.name === "preview_open");
  assert.match(open.description, /frontend or GUI/);
  assert.match(open.description, /Preview pane/);
});

test("a declined address is not opened", async (t) => {
  const env = server({ confirm: async () => false });
  t.after(env.cleanup);
  const { call } = await leased(env.tools);
  const answer = await call("preview_open", { url: "http://localhost:5173/" });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /did not allow/);
});

test("the Terminal pane lists the chat's commands, follows their output, and stops one for the user", async (t) => {
  const env = server({ results: {
    exec_command: { ok: true, command_id: "cmd-1", status: "running" },
    read_output: (body) => ({ ok: true, content: body.arguments.offset === 0 ? "VITE ready on http://localhost:5173/\n" : "", next_read_offset: 37, status: "running", exit_code: null }),
    kill_command: { ok: true, status: "killed", killed: true },
  } });
  t.after(env.cleanup);
  const { call } = await leased(env.tools, { approvalMode: "bypass-permissions" });
  await call("exec_command", { cmd: "npm run dev", yield_time_ms: 1000 });
  const [listing] = await env.tools.processes(["ao-1", "ao-1", "../x"]);
  assert.equal(listing.sessionId, "ao-1");
  assert.deepEqual(listing.commands.map(({ id: commandId, cmd, status }) => [commandId, cmd, status]), [["cmd-1", "npm run dev", "running"]]);
  const first = await env.tools.processOutput({ sessionId: "ao-1", commandId: "cmd-1", stream: "stdout", offset: 0 });
  assert.equal(first.content, "VITE ready on http://localhost:5173/\n");
  assert.equal(first.nextOffset, 37);
  await assert.rejects(env.tools.processOutput({ sessionId: "ao-1", commandId: "someone-elses" }), /not one of this chat's/);
  await assert.rejects(env.tools.processOutput({ sessionId: "ao-2", commandId: "cmd-1" }), /session has ended/);

  // The chat's own dev server printed this address, which previewOriginDecision may take into account.
  const stop = await env.tools.processStop({ sessionId: "ao-1", commandId: "cmd-1" });
  assert.equal(stop.status, "killed");
  assert.deepEqual(env.headless.at(-1).tool, "kill_command");
  assert.equal(env.headless.at(-1).arguments.command_id, "cmd-1");
});

test("a user's stop the workspace wants approved is granted for that one call: their click is the consent", async (t) => {
  let killed = 0;
  const env = server({ results: {
    exec_command: { ok: true, command_id: "cmd-9", status: "running" },
    kill_command: (body) => {
      killed += 1;
      return body.arguments.approval_token === "grant-1" ? { ok: true, status: "killed" }
        : { ok: false, error: { code: "APPROVAL_REQUIRED", message: "approve", details: { request_id: "req-1", risk: "routine_mutation" } } };
    },
    request_permissions: { ok: true, approval_token: "grant-1" },
  } });
  t.after(env.cleanup);
  const { call } = await leased(env.tools, { approvalMode: "bypass-permissions" });
  await call("exec_command", { cmd: "npm start" });
  const before = env.confirmations.length;
  assert.equal((await env.tools.processStop({ sessionId: "ao-1", commandId: "cmd-9" })).ok, true);
  assert.equal(killed, 2);
  assert.equal(env.confirmations.length, before, "no dialog: the user clicked Stop");
});

test("a session that ends closes its preview; a credential retired for a newer one keeps it", async (t) => {
  const env = server();
  t.after(env.cleanup);
  await leased(env.tools);
  await leased(env.tools);
  assert.deepEqual(env.closed, [], "the older credential of ao-1 is retired, the session goes on");
  env.tools.forgetSession("ao-1");
  assert.deepEqual(env.closed, ["ao-1"]);
});

test("a session set to Approve for me runs routine commands through the app's terminal without a dialog; others still ask", async (t) => {
  const routine = (cmd) => (/^npm (ci|run dev)$/.test(cmd) ? "routine" : null);
  const env = server({ results: { exec_command: { ok: true, command_id: "c1", status: "running" } } });
  t.after(env.cleanup);
  // The fixture's server has no routine rule; one with it, for an Approve-for-me lease:
  const withRule = createChatAgentTools({
    terminalEnabled: () => true, minAnswerMs: 0, logger: { info() {}, warn() {} }, routineCommand: routine,
    confirm: async (request) => { env.confirmations.push(request); return true; },
    sessionWorkspace: async () => ({ root: env.root }),
    requestHeadless: async (endpoint, body) => (endpoint.startsWith("/api/v1/tools/catalog?")
      ? { tools: [{ name: "exec_command", inputSchema: { type: "object" } }] }
      : { ok: true, operation: { state: "completed", result: { ok: true, command_id: "c1", status: "running", ran: body.arguments.cmd } } }),
  });
  t.after(() => withRule.close());
  const lease = await withRule.lease({ agent: "claude-code", workspaceId: "ws1", approvalMode: "accept-edits", autoReview: true });
  lease.bind("ao-9");
  const [{ url, headers }] = lease.servers;
  const call = (args) => post(url, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "exec_command", arguments: args } },
    { authorization: headers.Authorization }).then((reply) => reply.result);
  const before = env.confirmations.length;
  assert.equal((await call({ cmd: "npm ci" })).isError, false);
  assert.equal((await call({ cmd: "npm run dev" })).isError, false);
  assert.equal(env.confirmations.length, before, "routine commands ran without a dialog");
  // Claude Code asks for every MCP call on the chat card, where the reviewer (or the person) answers it.
  await call({ cmd: "npm install left-pad" });
  assert.equal(env.confirmations.length, before, "a Claude Code command was already reviewed on its card");
  const codex = await withRule.lease({ agent: "codex", workspaceId: "ws1", approvalMode: "accept-edits", autoReview: true });
  codex.bind("ao-11");
  await post(codex.servers[0].url, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "exec_command", arguments: { cmd: "npm install left-pad" } } },
    { authorization: codex.servers[0].headers.Authorization });
  assert.equal(env.confirmations.length, before + 1, "anything else is still the person's call where nothing reviewed it");
  const plain = await withRule.lease({ agent: "claude-code", workspaceId: "ws1", approvalMode: "accept-edits" });
  plain.bind("ao-10");
  await post(plain.servers[0].url, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "exec_command", arguments: { cmd: "npm ci" } } },
    { authorization: plain.servers[0].headers.Authorization });
  assert.equal(env.confirmations.length, before + 2, "without Approve for me every command asks");
});
test("the side panel reads the agent's worktree: its changes, folders and files, and opens the user's own terminal there", async (t) => {
  const env = server({ results: {
    git_status: { ok: true, branch: "ao/reg-machine-31", entries: [{ path: "api/new.py", index_status: "?", worktree_status: "?" }] },
    git_diff: { ok: true, diff: "diff --git a/api/x.py b/api/x.py\n@@ -1 +1 @@\n-a\n+b\n", truncated: false },
    list_dir: (body) => ({ ok: true, entries: [{ name: "api", path: "api", type: "directory" }], echoed: body.arguments.path }),
    read_file: (body) => ({ ok: true, content: `content of ${body.arguments.path}`, truncated: false }),
    exec_command: (body) => ({ ok: true, command_id: "shell-1", status: "running", echoed: body.arguments }),
  } });
  t.after(env.cleanup);
  await leased(env.tools);
  const changes = await env.tools.changes({ sessionId: "ao-1" });
  assert.equal(changes.branch, "ao/reg-machine-31");
  assert.match(changes.diff, /\+b/);
  assert.equal(changes.entries[0].path, "api/new.py");
  assert.equal((await env.tools.files({ sessionId: "ao-1", path: "." })).entries[0].type, "directory");
  assert.equal((await env.tools.file({ sessionId: "ao-1", path: "api/x.py" })).content, "content of api/x.py");
  await assert.rejects(env.tools.file({ sessionId: "ao-1", path: "../../outside.txt" }), /outside this chat's worktree/, "only inside the worktree");
  await assert.rejects(env.tools.files({ sessionId: "ao-1", path: "C:/Windows" }), /refused/);
  const before = env.confirmations.length;
  const shell = await env.tools.terminalStart({ sessionId: "ao-1" });
  assert.equal(shell.commandId, "shell-1");
  const exec = env.headless.find((body) => body.tool === "exec_command");
  assert.equal(exec.arguments.tty, true, "a terminal, so it reads what the user types");
  assert.equal(exec.arguments.workdir, ".", "in the worktree");
  assert.equal(env.confirmations.length, before, "the user opened it themselves: no dialog");
  const [listing] = await env.tools.processes(["ao-1"]);
  assert.deepEqual(listing.commands.map((command) => [command.id, command.user]), [["shell-1", true]]);
  await assert.rejects(env.tools.changes({ sessionId: "ao-2" }), /session has ended/);
});
function leasedServer(statePath, root) {
  return createChatAgentTools({
    statePath, minAnswerMs: 0, logger: { info() {}, warn() {} }, confirm: async () => true,
    sessionWorkspace: async () => ({ root }),
    requestHeadless: async (endpoint, body) => (endpoint.startsWith("/api/v1/tools/catalog?")
      ? { tools: [{ name: "read_file", inputSchema: { type: "object" } }] }
      : { ok: true, operation: { state: "completed", result: { ok: true, tool: body.tool, entries: [] } } }),
  });
}

test("a running agent keeps its tools across an app restart: same port, its credential honoured (only its hash is kept)", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-leases-"));
  const root = path.join(base, "worktrees", "p1");
  fs.mkdirSync(root, { recursive: true });
  const statePath = path.join(base, "chat-agent-tools.json");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const first = leasedServer(statePath, root);
  const lease = await first.lease({ agent: "claude-code", workspaceId: "ws1" });
  lease.bind("ao-7");
  const [{ url, headers }] = lease.servers;
  await first.close();
  const kept = fs.readFileSync(statePath, "utf8");
  assert.equal(kept.includes(headers.Authorization.slice("Bearer ".length)), false, "the credential itself is never written");
  assert.match(kept, /"aoSession":"ao-7"/);
  const second = leasedServer(statePath, root);
  t.after(() => second.close());
  await second.listen();
  const list = await post(url, { jsonrpc: "2.0", id: id++, method: "tools/list" }, { authorization: headers.Authorization });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["read_file"], "the old address and credential still work");
  const forged = await new Promise((resolve) => {
    const request = http.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer forged" } },
      (response) => { response.resume(); resolve(response.statusCode); });
    request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
  assert.equal(forged, 401);
});

test("when another program holds the old port the saved leases are dropped, not honoured on a new one", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-leases-"));
  const root = path.join(base, "worktrees", "p1");
  fs.mkdirSync(root, { recursive: true });
  const statePath = path.join(base, "chat-agent-tools.json");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const first = leasedServer(statePath, root);
  const lease = await first.lease({ agent: "claude-code", workspaceId: "ws1" });
  lease.bind("ao-8");
  const oldPort = Number(new URL(lease.servers[0].url).port);
  const auth = lease.servers[0].headers.Authorization;
  const key = lease.servers[0].url.split("/").pop();
  await first.close();
  const squatter = http.createServer((request, response) => response.end());
  await new Promise((resolve) => squatter.listen(oldPort, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  const second = leasedServer(statePath, root);
  t.after(() => second.close());
  const port = await second.listen();
  assert.notEqual(port, oldPort);
  const moved = await post(`http://127.0.0.1:${port}/mcp/ws1/${key}`, { jsonrpc: "2.0", id: id++, method: "tools/list" }, { authorization: auth });
  assert.equal(moved?.error?.code, -32001, "a credential that may have reached the squatter is not honoured");
});

test("the side panel reaches a session the app holds no lease for through the chat's workspace", async (t) => {
  const env = server({ results: { git_status: { ok: true, branch: "b", entries: [] }, git_diff: { ok: true, diff: "" } } });
  t.after(env.cleanup);
  await assert.rejects(env.tools.changes({ sessionId: "ao-old" }), /session has ended/, "without the workspace there is nothing to reach it by");
  const changes = await env.tools.changes({ sessionId: "ao-old", workspaceId: "ws1" });
  assert.equal(changes.branch, "b");
  assert.equal(env.headless.at(-1).workspace_id, "ws1");
  const [listing] = await env.tools.processes(["ao-old"], "ws1");
  assert.deepEqual(listing.commands, []);
});
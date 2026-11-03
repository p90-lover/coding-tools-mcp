"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

const { createLocalChatGpt, normalizeLocalMessage, MAX_MESSAGE_CHARS } = require("../electron/chatgpt-desktop-local.cjs");
const { createWin32Helper, requestLine } = require("../electron/chatgpt-desktop-win32.cjs");
const { createChatGptDesktopHost, slotPaths } = require("../electron/chatgpt-desktop.cjs");

// A helper double: answers each op from `answers` (a value or a function of args) and records calls.
function fakeHelper(answers = {}) {
  const calls = [];
  return {
    calls,
    disposed: 0,
    async call(op, args = {}, timeoutMs) {
      calls.push({ op, args, timeoutMs });
      const answer = answers[op];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(args, calls) : answer;
    },
    dispose() { this.disposed += 1; },
  };
}

function bridge(helper, extra = {}) {
  const logs = [];
  const logger = { info: (name, data) => logs.push(["info", name, data]), warn: (name, data) => logs.push(["warn", name, data]) };
  const local = createLocalChatGpt({
    logger, platform: "win32", ownedMarker: "C:\\ct\\chatgpt-desktop\\slots\\", ownedPids: () => [77, 0, -1, 1.5],
    createHelper: () => helper, now: () => 1234, ...extra,
  });
  return { local, logs };
}

test("a message keeps its line breaks, loses tabs and edge whitespace, and refuses anything else", () => {
  assert.equal(normalizeLocalMessage("  hi\r\nthere\rnow\tok  "), "hi\nthere\nnow    ok");
  assert.equal(normalizeLocalMessage("你好 😀"), "你好 😀");
  for (const [value, pattern] of [
    [undefined, /must be text/], [42, /must be text/], ["   \n\t ", /Type a message/],
    ["x".repeat(MAX_MESSAGE_CHARS + 1), /limited/], ["bell\u0007", /control characters/], ["esc\u001b[2J", /control characters/],
  ]) {
    assert.throws(() => normalizeLocalMessage(value), pattern, JSON.stringify(value));
  }
  assert.equal(normalizeLocalMessage("x".repeat(MAX_MESSAGE_CHARS)).length, MAX_MESSAGE_CHARS);
});

test("helper requests are pure ASCII so PowerShell's console code page cannot mangle a message", () => {
  const request = { id: 1, op: "local-send", args: { text: "café 你好 😀\nline" } };
  const line = requestLine(request);
  assert.match(line, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(line), request);
});

test("the preview captures the user's own window and never one of Coding Tools' copies", async () => {
  const helper = fakeHelper({
    "local-find": { pid: 900, hwnd: 4242, state: "visible", title: "ChatGPT" },
    "local-capture": { state: "ok", title: "ChatGPT", width: 640, height: 400, data: "QUJD" },
  });
  const { local } = bridge(helper);
  const first = await local.preview();
  assert.deepEqual(first, { state: "ok", title: "ChatGPT", image: "data:image/jpeg;base64,QUJD", width: 640, height: 400, capturedAt: 1234 });
  assert.deepEqual(helper.calls[0].args, { exclude: "C:\\ct\\chatgpt-desktop\\slots\\", ownedPids: [77] });
  assert.deepEqual(helper.calls[1].args, { hwnd: 4242, pid: 900, maxWidth: 1280 });
  // The window found once is reused while it lives.
  await local.preview();
  assert.deepEqual(helper.calls.map((call) => call.op), ["local-find", "local-capture", "local-capture"]);
});

test("a vanished window is looked up again once; no ChatGPT reports not-running", async () => {
  let captures = 0;
  const helper = fakeHelper({
    "local-find": (_args, calls) => calls.filter((call) => call.op === "local-find").length === 1 ? { pid: 1, hwnd: 2 } : { pid: null, hwnd: 0 },
    "local-capture": () => { captures += 1; return { state: "gone" }; },
  });
  const { local } = bridge(helper);
  const result = await local.preview();
  assert.equal(result.state, "not-running");
  assert.equal(result.image, null);
  assert.equal(captures, 1);
  assert.deepEqual(helper.calls.map((call) => call.op), ["local-find", "local-capture", "local-find"]);
});

test("a minimized, hidden or empty capture carries no image", async () => {
  for (const shot of [{ state: "minimized" }, { state: "hidden" }, { state: "blank" }, { state: "ok", data: "" }, { state: "weird" }]) {
    const helper = fakeHelper({ "local-find": { pid: 1, hwnd: 2 }, "local-capture": shot });
    const result = await bridge(helper).local.preview();
    assert.equal(result.image, null, JSON.stringify(shot));
    assert.equal(result.state, ["minimized", "hidden"].includes(shot.state) ? shot.state : "blank");
  }
});

test("off Windows the preview and send never start a helper", async () => {
  let created = 0;
  const local = createLocalChatGpt({ platform: "linux", ownedMarker: "/x/", createHelper: () => { created += 1; return fakeHelper(); } });
  assert.equal((await local.preview()).state, "unsupported");
  await assert.rejects(local.send("hello"), /Windows only/);
  assert.equal(created, 0);
});

test("send validates first, finds the window fresh, hands focus back, and logs no message text", async () => {
  const helper = fakeHelper({ "local-find": { pid: 900, hwnd: 4242 }, "local-send": true });
  const { local, logs } = bridge(helper);
  await assert.rejects(local.send("   "), /Type a message/);
  assert.equal(helper.calls.length, 0);

  assert.deepEqual(await local.send(" secret plan\r\n ", { returnTo: 5150 }), { ok: true, sentAt: 1234 });
  assert.deepEqual(helper.calls.map((call) => call.op), ["local-find", "local-send"]);
  assert.deepEqual(helper.calls[1].args, { hwnd: 4242, pid: 900, text: "secret plan", returnTo: 5150 });
  assert.equal(helper.calls[1].timeoutMs, 60_000);
  assert.ok(!JSON.stringify(logs).includes("secret"));
  assert.deepEqual(logs.at(-1), ["info", "chatgpt_desktop.local_message_sent", { characters: 11 }]);

  // A bogus focus target is dropped rather than passed on.
  await local.send("again", { returnTo: -3 });
  assert.equal(helper.calls.at(-1).args.returnTo, 0);
  assert.deepEqual(helper.calls.filter((call) => call.op === "local-find").length, 2);
});

test("send refuses when ChatGPT is not open and allows one message at a time", async () => {
  const closed = fakeHelper({ "local-find": { pid: null, hwnd: 0 } });
  await assert.rejects(bridge(closed).local.send("hello"), /not open/);
  assert.ok(!closed.calls.some((call) => call.op === "local-send"));

  let release;
  const slow = fakeHelper({
    "local-find": { pid: 1, hwnd: 2 },
    "local-send": (_args, calls) => calls.filter((call) => call.op === "local-send").length > 1 ? true : new Promise((resolve) => { release = resolve; }),
  });
  const { local } = bridge(slow);
  const first = local.send("one");
  await assert.rejects(local.send("two"), /already being sent/);
  await new Promise((resolve) => setImmediate(resolve));
  release(true);
  await first;
  await local.send("three");
  assert.equal(slow.calls.filter((call) => call.op === "local-send").length, 2);

  const failing = fakeHelper({ "local-find": { pid: 1, hwnd: 2 }, "local-send": new Error("Could not find ChatGPT's message box") });
  const failed = bridge(failing);
  await assert.rejects(failed.local.send("x"), /message box/);
  assert.equal(failed.logs.at(-1)[1], "chatgpt_desktop.local_send_failed");
  // The lock is released after a failure.
  await assert.rejects(failed.local.send("y"), /message box/);
});

// --- the Win32 helper process -------------------------------------------------------------

function fakeSpawn() {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.requests = [];
    child.failInit = false;
    child.stdin = {
      write(line) {
        const request = JSON.parse(line);
        child.requests.push(request);
        const ok = !(request.op === "local-init" && child.failInit);
        setImmediate(() => child.stdout.emit("data", `${JSON.stringify(ok ? { id: request.id, ok, result: true } : { id: request.id, ok, error: "Add-Type failed" })}\n`));
      },
      end() {},
    };
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

test("the local PowerShell is loaded once per helper process, before the first local request only", async () => {
  const { children, spawnProcess } = fakeSpawn();
  const helper = createWin32Helper({ spawnProcess });
  await helper.call("alive", { hwnd: 1 });
  assert.deepEqual(children[0].requests.map((request) => request.op), ["alive"]);
  await Promise.all([helper.call("local-find", {}), helper.call("local-capture", { hwnd: 1 })]);
  await helper.call("local-send", { text: "hi" });
  assert.deepEqual(children[0].requests.map((request) => request.op), ["alive", "local-init", "local-find", "local-capture", "local-send"]);
  const init = children[0].requests[1].args.script;
  assert.match(init, /public static class CgdLocal/);
  assert.match(init, /function script:Send-Local/);
  helper.dispose();
});

test("a failed local load is retried by the next local request", async () => {
  const { children, spawnProcess } = fakeSpawn();
  const helper = createWin32Helper({ spawnProcess });
  helper.call("alive", {}).catch(() => {});
  children[0].failInit = true;
  await assert.rejects(helper.call("local-find", {}), /Add-Type failed/);
  children[0].failInit = false;
  await helper.call("local-find", {});
  assert.deepEqual(children[0].requests.map((request) => request.op), ["alive", "local-init", "local-init", "local-find"]);
  helper.dispose();
});

test("the helper's start command stays under Windows' command-line limit", () => {
  const { spawnProcess } = fakeSpawn();
  let argv = null;
  const helper = createWin32Helper({ spawnProcess: (command, args, options) => { argv = [command, ...args]; return spawnProcess(command, args, options); } });
  helper.call("alive", {}).catch(() => {});
  assert.ok(argv.join(" ").length < 32_000, `command line is ${argv.join(" ").length} characters`);
  helper.dispose();
});

// --- the host and main-process wiring -----------------------------------------------------

test("the host previews and sends through its local bridge, excludes its own copies, and disposes it on shutdown", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgd-local-"));
  let options = null;
  const calls = [];
  const local = {
    preview: async () => { calls.push(["preview"]); return { state: "not-running" }; },
    send: async (text, opts) => { calls.push(["send", text, opts]); return { ok: true, sentAt: 1 }; },
    dispose: () => calls.push(["dispose"]),
  };
  const host = createChatGptDesktopHost({
    dataRoot, resolveCpaAuthDir: () => path.join(dataRoot, "none"), helper: fakeHelper(), platform: "linux", autoStart: false,
    createLocal: (value) => { options = value; return local; },
  });
  assert.equal(options.ownedMarker, `${path.join(dataRoot, "slots")}${path.sep}`);
  assert.deepEqual(options.ownedPids(), []);
  assert.deepEqual(await host.localPreview(), { state: "not-running" });
  assert.deepEqual(await host.localSend("hello", { returnTo: 9 }), { ok: true, sentAt: 1 });
  await host.shutdown();
  assert.deepEqual(calls, [["preview"], ["send", "hello", { returnTo: 9 }], ["dispose"]]);
});

test("sending needs the focused main window and only a text field; the preview needs the visible one", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  const handler = (channel) => {
    const start = main.indexOf(`handle("${channel}"`);
    assert.ok(start >= 0, channel);
    return main.slice(start, main.indexOf("\n  });", start));
  };
  const send = handler("launcher:chatgpt-desktop-local-send");
  assert.match(send, /assertFocusedMainWindow\(event, true\)/);
  assert.match(send, /Object\.keys\(input\)\.some\(\(key\) => key !== "text"\)/);
  assert.match(send, /localSend\(input\.text, \{ returnTo \}\)/);
  const preview = handler("launcher:chatgpt-desktop-local-preview");
  assert.match(preview, /assertFocusedMainWindow\(event, false\)/);
  assert.match(preview, /localPreview\(\)/);
});

test("the preload exposes preview, send and targeted Clear on their own channels", async () => {
  const invocations = [];
  const exposed = {};
  const electronMock = {
    contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } },
    ipcRenderer: { async invoke(channel, payload) { invocations.push({ channel, payload }); return null; }, on() {}, removeListener() {}, send() {} },
    webUtils: {},
  };
  const preloadPath = path.resolve(__dirname, "../electron/preload.cjs");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  await exposed.codexWebLauncher.chatGptLocalPreview();
  await exposed.codexWebLauncher.sendChatGptLocalMessage("hi there");
  await exposed.codexWebLauncher.clearChatGptDesktopAccount("local-aaaaaa");
  assert.deepEqual(invocations, [
    { channel: "launcher:chatgpt-desktop-local-preview", payload: undefined },
    { channel: "launcher:chatgpt-desktop-local-send", payload: { text: "hi there" } },
    { channel: "launcher:chatgpt-desktop-clear", payload: "local-aaaaaa" },
  ]);
});

// Execute the real queue, switch and clear bodies; all native/account/filesystem effects are fake.
function clearFixture() {
  const source = fs.readFileSync(path.resolve(__dirname, "../electron/chatgpt-desktop.cjs"), "utf8");
  const ast = ts.createSourceFile("host.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const extract = (name, kind) => {
    const matches = [];
    const visit = (node) => {
      if (node.kind === kind && node.name?.getText(ast) === name) matches.push(node.getText(ast));
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.equal(matches.length, 1, name);
    return matches[0];
  };
  const state = { active: "local-aaaaaa", local: [{ id: "local-aaaaaa" }, { id: "local-bbbbbb" }] };
  const instances = new Map(state.local.map(({ id }, i) => [id, { slotId: id, hwnd: i + 1 }]));
  const effects = [];
  const context = { state, instances, path, slotPaths, Error, queue: Promise.resolve(), busy: null, lastError: null,
    dataRoot: path.join(__dirname, "virtual-only-never-created"), platform: "win32", packageInfo: { version: "fixture" },
    crypto: require("node:crypto"), logger: {}, emit() {},
    activeInstance: () => instances.get(state.active),
    accountList: () => state.local.map(({ id }) => ({ slotId: id, disabled: false })),
    persist: () => record("persist", state.active), placeNow: async () => {}, makeRoom: async () => {},
    launchInstance: async (slotId) => { record("launch", slotId); return { slotId, hwnd: 3 }; },
    adopt: async (entry) => instances.set(entry.slotId, entry),
    stopInstance: async (slotId) => { record("stop", slotId); instances.delete(slotId); },
    finalSync: (slotId) => record("sync", slotId),
    fs: { existsSync: () => true, mkdirSync: () => record("mkdir"),
      renameSync: (from) => record("trash", path.basename(from)) },
  };
  const record = (kind, target) => effects.push({ operation: context.busy, kind, target });
  const functions = ["exclusive", "status", "openSlot", "newLocalSlot", "trashSlot", "knownSlot"]
    .map((name) => extract(name, ts.SyntaxKind.FunctionDeclaration)).join("\n");
  const methods = ["open", "clearActive"].map((name) => extract(name, ts.SyntaxKind.MethodDeclaration)).join(",");
  vm.runInNewContext(`${functions}\nglobalThis.host = {${methods}, status};`, context);
  return { ...context, effects, clearingEffects: () => effects.filter(({ operation }) => operation === "clearing") };
}

test("Clear targets the confirmed active slot, even when its CPA account file is gone", async () => {
  for (const missingAccount of [false, true]) {
    const fixture = clearFixture();
    const expectedSlotId = missingAccount ? "cpa-aaaaaa" : "local-aaaaaa";
    if (missingAccount) {
      fixture.state.local = [];
      fixture.state.active = expectedSlotId;
      fixture.instances.set(expectedSlotId, { slotId: expectedSlotId, hwnd: 3 });
    }
    await fixture.host.clearActive(expectedSlotId);
    assert.deepEqual(fixture.clearingEffects().filter(({ kind }) => kind === "trash").map(({ target }) => target), [expectedSlotId]);
    assert.ok(fixture.clearingEffects().some(({ kind }) => kind === "launch"), "fresh sign-in still opens");
  }
});

test("Clear rejects omitted, invalid and wrong target IDs before any destructive effect", async () => {
  for (const id of [undefined, null, "", " ", 42, {}, "local-bbbbbb"]) {
    const fixture = clearFixture();
    await assert.rejects(fixture.host.clearActive(id), /confirm|changed/i);
    assert.deepEqual(fixture.clearingEffects(), [], String(id));
    assert.equal(fixture.state.active, "local-aaaaaa");
  }
});

test("Clear rejects a completed switch and a switch queued ahead of confirmation", async () => {
  for (const completed of [true, false]) {
    const fixture = clearFixture();
    const switching = fixture.host.open("local-bbbbbb");
    if (completed) await switching;
    assert.equal(fixture.state.active, completed ? "local-bbbbbb" : "local-aaaaaa");
    const rejected = assert.rejects(fixture.host.clearActive("local-aaaaaa"), /confirm|changed/i);
    await switching;
    await rejected;
    assert.equal(fixture.state.active, "local-bbbbbb");
    assert.deepEqual(fixture.clearingEffects(), [], "guard runs inside the queue before stop/sync/trash/persist/new slot");
    await fixture.host.clearActive("local-bbbbbb");
    assert.deepEqual(fixture.clearingEffects().filter(({ kind }) => kind === "trash").map(({ target }) => target), ["local-bbbbbb"], "reconfirmation succeeds");
  }
});

test("the Clear IPC requires a captured ID and forwards it unchanged after readiness", async () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  const start = main.indexOf('handle("launcher:chatgpt-desktop-clear"');
  assert.ok(start >= 0);
  const registration = main.slice(start, main.indexOf("\n  });", start) + 6);
  const calls = [];
  let handler;
  vm.runInNewContext(registration, { Error, logger: {},
    handle: (_, callback) => { handler = callback; },
    assertFocusedMainWindow: (event, focused) => { assert.equal(event, "owner"); assert.equal(focused, true); },
    getChatGptDesktop: () => ({ ready: Promise.resolve(), clearActive: async (id) => calls.push(id) }),
  });
  for (const id of [undefined, null, "", " ", 42, {}]) {
    await assert.rejects(handler("owner", id), /confirm|account/i);
  }
  assert.deepEqual(calls, []);
  await handler("owner", "local-aaaaaa");
  assert.deepEqual(calls, ["local-aaaaaa"]);
});

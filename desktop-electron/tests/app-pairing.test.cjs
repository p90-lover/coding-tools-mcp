"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppPairing, requesterPid } = require("../electron/app-pairing.cjs");

const NETSTAT = [
  "Active Connections",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012",
  "  TCP    127.0.0.1:56303        127.0.0.1:61001        ESTABLISHED     4242",
  "  TCP    127.0.0.1:61001        127.0.0.1:56303        ESTABLISHED     5150",
  "  TCP    127.0.0.1:61002        127.0.0.1:9999         ESTABLISHED     6000",
].join("\r\n");

function fakeWindow() {
  const calls = [];
  return { calls, isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") };
}

function pairing({ response = 0, program = "H:\\Apps\\sha 0.2.0\\sha.exe", projects = [{ id: "ws1", name: "Project one", path: "G:\\Projects\\one" }, { id: "ws2", name: "Two", path: "G:\\Projects\\two" }], window = fakeWindow() } = {}) {
  const shown = [];
  const service = createAppPairing({
    dialog: { showMessageBox: async (owner, options) => { shown.push({ owner, options }); return { response: typeof response === "function" ? response(options) : response }; } },
    getWindow: () => window,
    listProjects: async () => projects,
    processInfo: async (pid) => (pid === 5150 ? { executablePath: program } : null),
    netstat: async () => NETSTAT,
  });
  return { service, shown, window };
}

test("the program that asked is found from the connection's own client end", () => {
  assert.equal(requesterPid(NETSTAT, 61001, 56303), 5150);
  assert.equal(requesterPid(NETSTAT, 61002, 56303), null, "a connection to another server is not it");
  assert.equal(requesterPid(NETSTAT, 1, 56303), null);
  assert.equal(requesterPid("", 61001, 56303), null);
});

test("pairing asks in Coding Tools' window, naming the program and offering the projects, and the person chooses", async () => {
  const { service, shown, window } = pairing({ response: 1 });
  const decision = await service.pair({ id: "sha", name: "SHA", peerPort: 61001, serverPort: 56303 });
  assert.deepEqual(decision, { workspaceId: "ws2", root: "G:\\Projects\\two", project: "Two", program: "H:\\Apps\\sha 0.2.0\\sha.exe" });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].owner, window);
  assert.match(shown[0].options.message, /^Connect SHA to Coding Tools\?$/);
  assert.match(shown[0].options.detail, /Program: H:\\Apps\\sha 0\.2\.0\\sha\.exe/);
  assert.deepEqual(shown[0].options.buttons, ["Project one", "Two", "Don't allow"]);
  assert.equal(shown[0].options.cancelId, 2);
  assert.equal(shown[0].options.defaultId, 2, "Enter never allows by default");
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
});

test("pairing gives nothing without a yes, a known program and a project", async () => {
  assert.equal(await pairing({ response: 2 }).service.pair({ id: "sha", name: "SHA", peerPort: 61001, serverPort: 56303 }), null, "Don't allow");
  const unknownPeer = pairing();
  assert.equal(await unknownPeer.service.pair({ id: "sha", name: "SHA", peerPort: 61002, serverPort: 56303 }), null);
  assert.equal(unknownPeer.shown.length, 0, "no question about a program it couldn't identify");
  assert.equal(await pairing({ program: "" }).service.pair({ id: "sha", name: "SHA", peerPort: 61001, serverPort: 56303 }), null);
  assert.equal(await pairing({ projects: [] }).service.pair({ id: "sha", name: "SHA", peerPort: 61001, serverPort: 56303 }), null);
  const closed = pairing({ window: null });
  assert.equal(await closed.service.pair({ id: "sha", name: "SHA", peerPort: 61001, serverPort: 56303 }), null);
});

test("pairing names are shown on one line, and at most six projects are offered", async () => {
  const projects = Array.from({ length: 9 }, (_, index) => ({ id: `ws${index}`, name: `P${index}`, path: `G:\\P${index}` }));
  const { service, shown } = pairing({ projects, response: 6 });
  assert.equal(await service.pair({ id: "sha", name: "Evil\nName", peerPort: 61001, serverPort: 56303 }), null, "the seventh button is Don't allow");
  assert.equal(shown[0].options.buttons.length, 7);
  assert.equal(shown[0].options.message, "Connect Evil Name to Coding Tools?");
});

test("computer use for a connected app is asked in Coding Tools' window, never answered for the person", async () => {
  const answers = [0, 1, 2];
  const { service, shown } = pairing({ response: () => answers.shift() });
  const ask = () => service.promptComputer({ agent: "SHA", app: "Notepad", window: "notes.txt", project: "Two", captureOff: true });
  assert.equal(await ask(), "always");
  assert.equal(await ask(), "conversation");
  assert.equal(await ask(), "deny");
  assert.match(shown[0].options.message, /^Allow SHA to use Notepad\?$/);
  assert.match(shown[0].options.detail, /Screen capture turns on for this project/);
  assert.equal(shown[0].options.defaultId, 2);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await service.promptComputer({ agent: "SHA", app: "Notepad", window: "", project: "Two", captureOff: false, signal: stopped.signal }), "deny");
});

test("two questions never stack: the second waits for the first", async () => {
  let release;
  const order = [];
  const service = createAppPairing({
    dialog: { showMessageBox: (owner, options) => { order.push(options.message); return order.length === 1 ? new Promise((resolve) => { release = () => resolve({ response: 2 }); }) : Promise.resolve({ response: 2 }); } },
    getWindow: () => fakeWindow(), listProjects: async () => [], processInfo: async () => null, netstat: async () => "",
  });
  const first = service.promptComputer({ agent: "SHA", app: "A", project: "P" });
  const second = service.promptComputer({ agent: "Shadow SHA", app: "B", project: "P" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["Allow SHA to use A?"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["Allow SHA to use A?", "Allow Shadow SHA to use B?"]);
});

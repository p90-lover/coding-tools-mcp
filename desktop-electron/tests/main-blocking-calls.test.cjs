"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { installBlockingCallWatch, callerOf } = require("../electron/main-blocking-calls.cjs");
const { createMainStallMonitor } = require("../electron/main-stall-monitor.cjs");

// A clock that moves 300 ms per reading: every watched call looks slow.
const slowClock = () => { let t = 0; return () => (t += 300); };

test("a slow synchronous file call is named with what it touched and who called it", (t) => {
  const watch = installBlockingCallWatch({ now: slowClock() });
  t.after(() => watch.uninstall());
  const sent = [];
  watch.attach((entry) => sent.push(entry));
  function readSettings() { return fs.existsSync(path.join(__dirname, "settings-that-is-missing.json")); }
  readSettings();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "existsSync");
  assert.equal(sent[0].target, "settings-that-is-missing.json", "the file's name only, never its folder");
  assert.equal(sent[0].ms, 300);
  assert.match(sent[0].caller, /^readSettings main-blocking-calls\.test\.cjs:\d+/u);
});

test("starting a process is watched, since Windows creates it on the calling thread", async (t) => {
  const watch = installBlockingCallWatch({ now: slowClock() });
  t.after(() => watch.uninstall());
  const sent = [];
  watch.attach((entry) => sent.push(entry));
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(sent[0].op, "spawn");
  assert.equal(sent[0].target, path.basename(process.execPath));
});

test("reports wait for the logger, repeat at most every 10 s per caller, and never measure themselves", (t) => {
  let wall = 1_000_000;
  const watch = installBlockingCallWatch({ now: slowClock(), clock: () => wall });
  t.after(() => watch.uninstall());
  const probe = () => fs.existsSync(__filename);
  probe();
  const all = [];
  // Only this test's probe: the injected clock makes any other synchronous call look slow too.
  const sent = { get length() { return all.filter((entry) => entry.caller.startsWith("probe ")).length; } };
  // The report writes synchronously, as the logger's exit flush does: no report of the report.
  watch.attach((entry) => { all.push(entry); fs.existsSync(__filename); });
  assert.equal(sent.length, 1, "the call made before the logger existed is sent on attach");
  probe();
  assert.equal(sent.length, 1, "the same caller within 10 s is not repeated");
  wall += 10_001;
  probe();
  assert.equal(sent.length, 2);
  assert.ok(watch.latestSince(wall - 1), "the latest call is still known for the stall event");
});

test("a fast call is not reported, and uninstall gives back the original functions", () => {
  const original = fs.readFileSync;
  const watch = installBlockingCallWatch();
  const sent = [];
  watch.attach((entry) => sent.push(entry));
  fs.readFileSync(__filename);
  assert.equal(sent.length, 0);
  assert.notEqual(fs.readFileSync, original);
  assert.equal(typeof fs.realpathSync.native, "function", "realpathSync.native keeps working");
  assert.equal(fs.realpathSync.native(__dirname), fs.realpathSync(__dirname));
  watch.uninstall();
  assert.equal(fs.readFileSync, original);
});

test("a stall names the blocking call that held main during it", () => {
  const events = [];
  let at = 0;
  let wall = 50_000;
  const blockingCalls = { latestSince: (since) => (since <= wall ? { op: "spawn", target: "powershell.exe", ms: 9000 } : null) };
  const monitor = createMainStallMonitor({
    logger: { warn: (event, detail) => events.push([event, detail]) },
    now: () => at, clock: () => wall, cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0 }),
    setRepeat: () => null, clearRepeat: () => {}, blockingCalls,
  });
  monitor.start();
  at += 9500;
  monitor.tick();
  assert.equal(events[0][0], "launcher.main_stalled");
  assert.deepEqual(events[0][1].blockedBy, { op: "spawn", target: "powershell.exe", ms: 9000 });
});

/** A loopback server that answers every HTTP request with "ok". */
async function httpServer() {
  const server = http.createServer((request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a socket call that holds main is named by its endpoint, since Node's own code made it", async (t) => {
  // On 2026-11-03 main sat 70 s in a native write and 122 s in a close, and the stall probe saw only
  // Node's frames: these entries carry the address (and an HTTP request's method and path).
  const server = await httpServer();
  const watch = installBlockingCallWatch({ now: slowClock() });
  t.after(async () => { watch.uninstall(); await server.close(); });
  const sent = [];
  watch.attach((entry) => sent.push(entry));
  const body = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.port, path: "/api/v1/ao/read?token=secret", method: "POST", agent: false }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(body, "ok", "the watched calls still do their work");
  await new Promise((resolve) => setImmediate(resolve));
  const of = (op) => sent.find((entry) => entry.op === op && entry.target.includes(`:${server.port}`));
  assert.equal(of("socket.connect")?.target, `127.0.0.1:${server.port}`);
  assert.equal(of("socket.write")?.target, `127.0.0.1:${server.port} POST /api/v1/ao/read`, "the path, never its query");
  assert.equal(of("handle.close")?.target, `127.0.0.1:${server.port}`);
});

test("socket calls from Node's code alone repeat per endpoint, not as one site", async (t) => {
  const watch = installBlockingCallWatch({ now: slowClock() });
  t.after(() => watch.uninstall());
  const sent = [];
  watch.attach((entry) => sent.push(entry));
  // Two sockets without a connection: each write fails at once (ERR_SOCKET_CLOSED), still measured.
  // Called from the tick queue, as fetch's and an HTTP flush's writes are: no frame of ours.
  for (const host of ["first.example", "second.example"]) {
    const socket = new net.Socket();
    socket._host = host;
    process.nextTick(socket._writeGeneric.bind(socket), false, "x", "utf8", () => socket.destroy());
  }
  await new Promise((resolve) => setImmediate(resolve));
  const writes = sent.filter((entry) => entry.op === "socket.write");
  assert.deepEqual(writes.map((entry) => [entry.target, entry.caller]), [["first.example", ""], ["second.example", ""]]);
});

test("uninstall gives back the socket methods", () => {
  const write = net.Socket.prototype._writeGeneric;
  const close = Object.getPrototypeOf(Object.getPrototypeOf(process.binding("tcp_wrap").TCP.prototype)).close;
  const watch = installBlockingCallWatch();
  assert.notEqual(net.Socket.prototype._writeGeneric, write);
  watch.uninstall();
  assert.equal(net.Socket.prototype._writeGeneric, write);
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(process.binding("tcp_wrap").TCP.prototype)).close, close);
});

test("callers are file:line, without folders", () => {
  const stack = "Error\n    at wrapped (G:\\x\\electron\\main-blocking-calls.cjs:60:20)\n    at readThing (G:\\x\\electron\\store.cjs:12:3)\n    at G:\\x\\electron\\main.cjs:400:9";
  assert.equal(callerOf(stack).split(" < ")[0].replace(/main-blocking-calls\.cjs:\d+ < /u, ""), callerOf(stack).split(" < ")[0]);
  assert.match(callerOf(stack), /readThing store\.cjs:12/u);
  assert.doesNotMatch(callerOf(stack), /G:/u);
});

test("a caller keeps six frames, enough to reach past a helper many paths share", () => {
  // Three frames ended a 26 s statSync at RuntimeHost.runtimeConfigSnapshot, which 13 paths call (2026-10-31).
  const frames = ["readConfigJson supervisor.cjs:540", "readSetupConfig supervisor.cjs:590", "runtimeConfigSnapshot runtime.cjs:449",
    "mcpCredentialsConfigured runtime.cjs:471", "autoConnect main.cjs:634", "monitor main.cjs:713", "timer main.cjs:900"];
  const stack = ["Error", ...frames.map((frame) => {
    const [name, place] = frame.split(" ");
    return `    at ${name} (G:\\x\\electron\\${place}:1)`;
  })].join("\n");
  assert.equal(callerOf(stack), frames.slice(0, 6).join(" < "));
});

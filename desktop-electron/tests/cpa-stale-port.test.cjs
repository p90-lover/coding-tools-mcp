"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { cpaOnPort, endStaleCpa } = require("../electron/cpa-managed.cjs");

const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200",
  "  TCP    127.0.0.1:8317         0.0.0.0:0              LISTENING       33052",
  "  TCP    127.0.0.1:8317         127.0.0.1:63579        ESTABLISHED     33052",
  "  TCP    127.0.0.1:83170        0.0.0.0:0              LISTENING       4444",
].join("\r\n");

// sockets: what Get-NetTCPConnection reports as the port's owners, one pid per line; null when
// PowerShell is unavailable (netstat alone then). kill: taskkill's result.
function fakeSystem({
  netstat = NETSTAT, sockets = null, images = { 33052: "cli-proxy-api.exe" }, freedAfterKill = true, kill = { status: 0 },
  bound = null,
} = {}) {
  const calls = [];
  let killed = false;
  const runSync = (file, args) => {
    const name = path.basename(file).toLowerCase();
    calls.push([name, ...args]);
    if (file === process.execPath) {
      // The bind probe: the port is taken while either source lists a local socket on it, or while
      // `bound` says so (a listener neither source shows).
      const freed = killed && freedAfterKill;
      const listed = bound ?? (/^\s*TCP\s+\S+:8317\s/mu.test(netstat) || /^\s*[1-9]\d*\s*$/mu.test(sockets ?? ""));
      return { status: !freed && listed ? 3 : 0 };
    }
    if (name === "powershell.exe") {
      if (sockets === null) return { status: 1, stdout: "", stderr: "Get-NetTCPConnection is not recognized" };
      return { status: 0, stdout: killed && freedAfterKill ? "" : sockets };
    }
    if (name === "netstat.exe") return { status: 0, stdout: killed && freedAfterKill ? "" : netstat };
    if (name === "tasklist.exe") {
      const pid = Number(args[1].replace("PID eq ", ""));
      return { status: 0, stdout: images[pid] ? `"${images[pid]}","${pid}","Console","1","120,000 K"\r\n` : "INFO: No tasks are running" };
    }
    if (name === "taskkill.exe") { killed = kill.status === 0; return kill; }
    throw new Error(`unexpected ${file}`);
  };
  return { runSync, calls };
}

test("a CPA left listening on the port is found by its pid; other programs and ports are not", () => {
  assert.equal(cpaOnPort(8317, { ...fakeSystem(), platform: "win32" }), 33052);
  // A different program on the port is never treated as CPA.
  assert.equal(cpaOnPort(8317, { ...fakeSystem({ images: { 33052: "node.exe" } }), platform: "win32" }), null);
  // A CPA that lost its listener but still serves kept-alive clients is found too.
  const listenerGone = NETSTAT.replace(/.*:8317 +0\.0\.0\.0:0 .*\r\n/u, "");
  assert.doesNotMatch(listenerGone, /:8317 +0\.0\.0\.0:0/u);
  assert.equal(cpaOnPort(8317, { ...fakeSystem({ netstat: listenerGone }), platform: "win32" }), 33052);
  // A client's own socket to the port (local port elsewhere) is not the port's owner; 83170 is not
  // 8317; a free port has no owner.
  const clientOnly = "  TCP    127.0.0.1:51328        127.0.0.1:8317         ESTABLISHED     9999\r\n  TCP    127.0.0.1:83170        0.0.0.0:0              LISTENING       4444";
  assert.equal(cpaOnPort(8317, { ...fakeSystem({ netstat: clientOnly, images: { 9999: "cli-proxy-api.exe" } }), platform: "win32" }), null);
  assert.equal(cpaOnPort(8317, { ...fakeSystem(), platform: "linux" }), null);
});

test("starting CPA ends an earlier CPA that still holds the port, and waits for it to let go", () => {
  const system = fakeSystem();
  assert.equal(endStaleCpa(8317, { ...system, platform: "win32", waitMs: 1_000 }), 33052);
  const kill = system.calls.find(([name]) => name === "taskkill.exe");
  assert.deepEqual(kill, ["taskkill.exe", "/PID", "33052", "/T", "/F"]);
  assert.equal(system.calls.at(-1)[0], path.basename(process.execPath).toLowerCase(), "the port is probed again after the kill");

  const free = fakeSystem({ netstat: "", sockets: "" });
  assert.equal(endStaleCpa(8317, { ...free, platform: "win32" }), null);
  assert.equal(free.calls.some(([name]) => name === "taskkill.exe"), false, "nothing is ended when the port is free");
  // A free port costs one bind probe: PowerShell and netstat (seconds on a busy disk) are not run.
  assert.deepEqual(free.calls.map(([name]) => name), [path.basename(process.execPath).toLowerCase()]);
});

test("a CPA whose listener netstat leaves out, with no clients connected, is still found and ended", () => {
  // 2026-10-29, 0.8.34's first start: netstat listed no socket on 8317 at all (CPA's listener is one
  // it leaves out, and the old app had quit), so the 0.8.31 CPA was missed and the new one exited.
  // Get-NetTCPConnection lists the listener (state 0) and its owner.
  const unseen = "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200";
  assert.equal(cpaOnPort(8317, { ...fakeSystem({ netstat: unseen, bound: true }), platform: "win32" }), null, "netstat alone misses it");
  const system = fakeSystem({ netstat: unseen, sockets: "33052\r\n0\r\n", bound: true });
  assert.equal(endStaleCpa(8317, { ...system, platform: "win32", waitMs: 1_000 }), 33052);
  assert.deepEqual(system.calls.find(([name]) => name === "taskkill.exe"), ["taskkill.exe", "/PID", "33052", "/T", "/F"]);
  // Another program owning the port is still never ended.
  const other = fakeSystem({ netstat: unseen, sockets: "4444\r\n", images: { 4444: "node.exe" }, bound: true });
  assert.equal(endStaleCpa(8317, { ...other, platform: "win32" }), null);
  assert.equal(other.calls.some(([name]) => name === "taskkill.exe"), false);
});

test("a CPA that cannot be ended is reported, not waited on", (t) => {
  const said = [];
  t.mock.method(console, "error", (line) => said.push(line));
  const system = fakeSystem({ kill: { status: 1, stderr: "ERROR: Access is denied.\r\n" } });
  assert.equal(endStaleCpa(8317, { ...system, platform: "win32", waitMs: 1_000 }), null);
  assert.deepEqual(said, ["Could not end the earlier CPA (pid 33052) on port 8317: ERROR: Access is denied."]);
  assert.equal(system.calls.at(-1)[0], "taskkill.exe", "the port is not polled after a failed kill");
});

test("the CPA archive is unpacked with Windows' own tar, never the first tar on PATH", () => {
  // Git's GNU tar reads "G:\...\cpa.zip" as host "G" ("Cannot connect to G: resolve failed").
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "cpa-managed.cjs"), "utf8");
  assert.match(source, /path\.join\(process\.env\.SystemRoot \|\| "C:\\\\Windows", "System32", "tar\.exe"\)/u);
  assert.doesNotMatch(source, /runChecked\("tar"/u);
});

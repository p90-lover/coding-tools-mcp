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

function fakeSystem({ netstat = NETSTAT, images = { 33052: "cli-proxy-api.exe" }, freedAfterKill = true } = {}) {
  const calls = [];
  let killed = false;
  const runSync = (file, args) => {
    const name = path.basename(file).toLowerCase();
    calls.push([name, ...args]);
    if (name === "netstat.exe") return { status: 0, stdout: killed && freedAfterKill ? "" : netstat };
    if (name === "tasklist.exe") {
      const pid = Number(args[1].replace("PID eq ", ""));
      return { status: 0, stdout: images[pid] ? `"${images[pid]}","${pid}","Console","1","120,000 K"\r\n` : "INFO: No tasks are running" };
    }
    if (name === "taskkill.exe") { killed = true; return { status: 0 }; }
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
  assert.equal(system.calls.at(-1)[0], "netstat.exe", "the port is checked again after the kill");

  const free = fakeSystem({ netstat: "" });
  assert.equal(endStaleCpa(8317, { ...free, platform: "win32" }), null);
  assert.equal(free.calls.some(([name]) => name === "taskkill.exe"), false, "nothing is ended when the port is free");
});

test("the CPA archive is unpacked with Windows' own tar, never the first tar on PATH", () => {
  // Git's GNU tar reads "G:\...\cpa.zip" as host "G" ("Cannot connect to G: resolve failed").
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "cpa-managed.cjs"), "utf8");
  assert.match(source, /path\.join\(process\.env\.SystemRoot \|\| "C:\\\\Windows", "System32", "tar\.exe"\)/u);
  assert.doesNotMatch(source, /runChecked\("tar"/u);
});

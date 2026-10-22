"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listAppProcesses, selectOwn, roleOf, uptime } = require("../electron/app-processes.cjs");

const T0 = Date.parse("2026-10-22T00:00:00Z");
const row = (pid, ppid, name, extra = {}) => ({ pid, ppid, name, exe: `C:\\Other\\${name}`, createdMs: T0 + pid, cpuMs: 0,
  ws: 100 * 1048576, priv: 80 * 1048576, threads: 4, handles: 50, ...extra });
// The machine: the app (pid 100) with a window (101), its bridge from the runtime folder (300), the
// AO daemon by name (400) with a Claude Code agent (401) running a shell (402), a second AO daemon
// left behind (500), the headless service (600), and the user's own programs (900, 901).
const machine = [
  row(100, 1, "Coding Tools.exe", { exe: "H:\\Apps\\Coding Tools\\Coding Tools.exe", cpuMs: 200 }),
  row(101, 100, "Coding Tools.exe", { exe: "H:\\Apps\\Coding Tools\\Coding Tools.exe", cpuMs: 50 }),
  row(300, 1, "bun.exe", { exe: "G:\\AppData\\.coding-tools\\runtime\\bun.exe" }),
  row(400, 1, "ao-daemon.exe", { exe: "H:\\Apps\\Coding Tools\\resources\\agent-orchestrator\\ao-daemon.exe", cpuMs: 4000, ws: 1300 * 1048576 }),
  row(401, 400, "claude.exe", { cpuMs: 100 }),
  row(402, 401, "powershell.exe"),
  row(500, 1, "ao-daemon.exe", { exe: "D:\\old\\ao-daemon.exe" }),
  row(600, 1, "coding-tools-headless.exe"),
  row(900, 1, "chrome.exe", { cpuMs: 9000 }),
  row(901, 900, "chrome.exe"),
  // A pid reused by a program started before its "parent": not the app's child.
  row(403, 400, "notepad.exe", { createdMs: T0 - 1 }),
];
const snapshot = async () => ({ elapsedMs: 1000, rows: machine });

test("the app's processes are its folders', its services', Electron's, and everything they started; nothing else", () => {
  const picked = selectOwn(machine, { roots: ["H:\\Apps\\Coding Tools", "G:/AppData/.coding-tools/"], own: [100] });
  assert.deepEqual(picked.map((entry) => entry.pid).sort((a, b) => a - b), [100, 101, 300, 400, 401, 402, 500, 600]);
});

test("each process says what it is, its CPU over the sample on all cores, memory and uptime; doubles and busy ones are noted", async () => {
  const listed = await listAppProcesses({ snapshot, cores: 4, now: T0 + 3_725_000, roots: ["H:\\Apps\\Coding Tools", "G:\\AppData\\.coding-tools"],
    own: [100], electron: [{ pid: 100, type: "Browser" }, { pid: 101, type: "Tab" }] });
  const byPid = Object.fromEntries(listed.processes.map((entry) => [entry.pid, entry]));
  assert.equal(byPid[100].role, "app (main)");
  assert.equal(byPid[101].role, "app (window)");
  assert.equal(byPid[300].role, "runtime bridge");
  assert.equal(byPid[401].role, "Claude Code");
  assert.equal(byPid[402].role, "shell");
  assert.equal(byPid[402].parent_pid, 401, "what started it, when that is the app's too");
  assert.equal(byPid[400].parent_pid, null, "a parent outside the app is not named");
  // 4,000 ms of CPU in a 1,000 ms sample on 4 cores: all of them.
  assert.equal(byPid[400].cpu_percent, 100);
  assert.equal(byPid[100].cpu_percent, 5);
  assert.equal(byPid[400].memory_mb, 1300);
  assert.equal(byPid[100].uptime, "1h 2m");
  assert.equal(listed.processes[0].pid, 400, "busiest first");
  assert.equal(listed.total.processes, 8);
  assert.match(listed.notes.join("\n"), /2 separate AO daemon processes \(pids 400, 500\)/);
  assert.match(listed.notes.join("\n"), /ao-daemon\.exe \(AO daemon, pid 400\) used 100% of all cores/);
  assert.doesNotMatch(JSON.stringify(listed), /C:\\\\Other|chrome|notepad|H:\\\\Apps/i, "the user's own programs, and paths, are not listed");
});

test("the list is sorted and cut as asked, and says how many were left out", async () => {
  const listed = await listAppProcesses({ snapshot, cores: 4, roots: ["H:\\Apps\\Coding Tools"], own: [100], sort: "name", limit: 3 });
  assert.equal(listed.processes.length, 3);
  assert.equal(listed.shown, 3);
  assert.match(listed.note, /4 more not shown/, "7 are the app's here (no runtime folder given), 3 shown");
  assert.deepEqual(listed.processes.map((entry) => entry.role), ["AO daemon", "AO daemon", "app"]);
});

test("names map to roles, and uptimes read short", () => {
  assert.equal(roleOf("cli-proxy-api.exe"), "CPA");
  assert.equal(roleOf("codex.exe"), "Codex");
  assert.equal(roleOf("tunnel-client-v0.0.12.exe"), "tunnel");
  assert.equal(roleOf("whatever.exe"), "");
  assert.equal(uptime(42_000), "42s");
  assert.equal(uptime(3 * 86_400_000 + 7_200_000), "3d 2h");
});

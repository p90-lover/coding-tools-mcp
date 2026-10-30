"use strict";

// Coding Tools' own processes, for the chat tool app_processes: the app's windows (Electron's main,
// renderer and GPU processes), its runtime bridge, CPA, the AO daemon, the headless service, and
// everything they started (chat agents, Codex, the commands those run). Each with how much CPU it
// used over a short sample, its memory, threads, handles and how long it has run.
//
// Read-only and private by design: a process's command line can carry a token or a key, so it is
// never read; only names, ids and counters. Nothing is stopped or changed. On Windows the counters
// come from one PowerShell call (CIM's Win32_Process, sampled twice), run off the main thread.

const { execFile } = require("node:child_process");
const os = require("node:os");
const { runOffThread } = require("./off-thread-run.cjs");
const path = require("node:path");

// What a process is, by its executable's name; the app's own names first.
const ROLES = Object.freeze([
  [/^coding tools( helper.*)?\.exe$|^coding-tools(\.exe)?$/i, "app"],
  [/^ao-daemon(\.exe)?$/i, "AO daemon"],
  [/^coding-tools-headless(\.exe)?$/i, "headless service"],
  [/^cli-?proxy-?api.*|^cpa(\.exe)?$|^cpa-helper.*$/i, "CPA"],
  [/^bun(\.exe)?$/i, "runtime bridge"],
  [/^tunnel-client.*$/i, "tunnel"],
  [/^codex(-.+)?(\.exe)?$/i, "Codex"],
  [/^claude(\.exe)?$/i, "Claude Code"],
  [/^opencode(\.exe)?$/i, "opencode"],
  [/^node(\.exe)?$/i, "Node"],
  [/^rtk(\.exe)?$/i, "rtk"],
  [/^(cmd|powershell|pwsh|conhost|bash|sh)(\.exe)?$/i, "shell"],
  [/^git(\.exe)?$/i, "git"],
  [/^python\d*(\.exe)?$/i, "Python"],
]);
// Background services: more than one of each usually means one was left behind. Not tunnels: each
// MCP tunnel (one per ChatGPT account) runs its own tunnel client.
const SINGLETONS = Object.freeze(["AO daemon", "headless service", "runtime bridge", "CPA"]);
const ELECTRON_TYPES = Object.freeze({ Browser: "app (main)", Tab: "app (window)", GPU: "app (GPU)", Utility: "app (utility)" });

const SAMPLE_MS = Object.freeze({ min: 250, default: 1000, max: 5000 });
const LIMIT = Object.freeze({ default: 40, max: 200 });

function roleOf(name) {
  for (const [pattern, role] of ROLES) if (pattern.test(name)) return role;
  return "";
}

/** "3h 12m", "42s": how long a process has run. */
function uptime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// One PowerShell call: every process's counters twice, `sampleMs` apart (command lines never read).
const WINDOWS_SCRIPT = (sampleMs) => `
$ErrorActionPreference = 'SilentlyContinue'
$props = 'ProcessId','ParentProcessId','Name','ExecutablePath','CreationDate','KernelModeTime','UserModeTime','WorkingSetSize','PrivatePageCount','ThreadCount','HandleCount'
$first = @{}
foreach ($p in (Get-CimInstance Win32_Process -Property $props)) { $first[[int]$p.ProcessId] = [double]$p.KernelModeTime + [double]$p.UserModeTime }
$at = [DateTime]::UtcNow
Start-Sleep -Milliseconds ${sampleMs}
$rows = foreach ($p in (Get-CimInstance Win32_Process -Property $props)) {
  # This sampler itself (and its console host) is not one of the app's processes.
  if ($p.ProcessId -eq $PID -or $p.ParentProcessId -eq $PID) { continue }
  [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; exe = [string]$p.ExecutablePath
    created = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }
    cpu0 = $first[[int]$p.ProcessId]; cpu1 = [double]$p.KernelModeTime + [double]$p.UserModeTime
    ws = [double]$p.WorkingSetSize; priv = [double]$p.PrivatePageCount * 1; threads = [int]$p.ThreadCount; handles = [int]$p.HandleCount }
}
[pscustomobject]@{ elapsed = ([DateTime]::UtcNow - $at).TotalMilliseconds; rows = @($rows) } | ConvertTo-Json -Depth 3 -Compress
`;

// Started from a worker thread: starting PowerShell from the main thread held every window 1.6 s
// while Windows loaded it (2026-10-30, the Processes view).
async function runPowerShell(script, timeoutMs) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const reply = await runOffThread({ file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    timeoutMs, maxBytes: 32 * 1024 * 1024 });
  if (reply.timedOut) throw new Error(`PowerShell timed out after ${timeoutMs} ms`);
  if (reply.error) throw new Error(reply.error);
  if (reply.code !== 0) throw new Error(`PowerShell exited with ${reply.code}: ${String(reply.stderr).trim().slice(0, 300)}`);
  return reply.stdout;
}

/** Every process's counters on Windows: { elapsedMs, rows: [{ pid, ppid, name, exe, createdMs, cpuMs, ws, priv, threads, handles }] }. */
async function windowsSnapshot(sampleMs, run = runPowerShell) {
  const parsed = JSON.parse(String(await run(WINDOWS_SCRIPT(sampleMs), sampleMs + 30_000)).trim() || "{}");
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : parsed.rows ? [parsed.rows] : []).map((row) => ({
    pid: row.pid, ppid: row.ppid, name: row.name || "", exe: row.exe || "",
    createdMs: row.created ? Date.parse(row.created) : NaN,
    // Win32_Process times are in 100 ns units.
    cpuMs: row.cpu0 === null || row.cpu0 === undefined ? null : (row.cpu1 - row.cpu0) / 10_000,
    ws: row.ws, priv: row.priv, threads: row.threads, handles: row.handles,
  }));
  return { elapsedMs: Number(parsed.elapsed) || sampleMs, rows };
}

/** The same on macOS/Linux from ps (its %CPU is already an average, so no second sample). */
async function posixSnapshot(sampleMs, run) {
  const output = await (run ?? ((args) => new Promise((resolve, reject) => execFile("ps", args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => (error ? reject(error) : resolve(stdout))))))(["-axo", "pid=,ppid=,pcpu=,rss=,etimes=,comm="]);
  const now = Date.now();
  const rows = String(output).split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map(([, pid, ppid, pcpu, rss, etimes, comm]) => ({ pid: Number(pid), ppid: Number(ppid), name: path.basename(comm), exe: comm,
      createdMs: now - Number(etimes) * 1000, cpuPercent: Number(pcpu), ws: Number(rss) * 1024, priv: null, threads: null, handles: null }));
  return { elapsedMs: sampleMs, rows };
}

/**
 * The app's processes: those whose executable lies under one of `roots` (the app's install and
 * runtime folders) or is one of the app's own services by name, the `own` pids (Electron's own
 * processes), and every process any of those started.
 */
function selectOwn(rows, { roots = [], own = [] } = {}) {
  const norm = (value) => String(value || "").replace(/\//g, "\\").toLowerCase();
  const prefixes = roots.filter(Boolean).map((root) => norm(root).replace(/\\+$/, "") + "\\");
  const children = new Map();
  for (const row of rows) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row); }
  const picked = new Map();
  const seeds = rows.filter((row) => own.includes(row.pid)
    || (row.exe && prefixes.some((prefix) => norm(row.exe).startsWith(prefix)))
    || SINGLETONS.includes(roleOf(row.name)) && roleOf(row.name) !== "runtime bridge");
  const queue = [...seeds];
  while (queue.length) {
    const row = queue.shift();
    if (picked.has(row.pid)) continue;
    picked.set(row.pid, row);
    // A pid can be reused by an unrelated process started after its parent died: only a child
    // created after its parent counts.
    for (const child of children.get(row.pid) ?? []) {
      if (child.pid !== row.pid && !(child.createdMs < row.createdMs)) queue.push(child);
    }
  }
  return [...picked.values()];
}

/**
 * Coding Tools' processes with their CPU, memory and uptime.
 * @param {{ sampleMs?: number, sort?: "cpu"|"memory"|"name", limit?: number, roots?: string[], own?: number[],
 *   electron?: { pid: number, type?: string }[], snapshot?: Function, now?: number }} options
 */
async function listAppProcesses({ sampleMs = SAMPLE_MS.default, sort = "cpu", limit = LIMIT.default, roots = [], own = [],
  electron = [], snapshot, now = Date.now(), platform = process.platform, cores = os.cpus().length || 1 } = {}) {
  const sample = Math.min(SAMPLE_MS.max, Math.max(SAMPLE_MS.min, Math.round(Number(sampleMs) || SAMPLE_MS.default)));
  const taken = await (snapshot ?? (platform === "win32" ? windowsSnapshot : posixSnapshot))(sample);
  const electronType = new Map(electron.map((entry) => [entry.pid, entry.type]));
  const rows = selectOwn(taken.rows, { roots, own: [...own, ...electron.map((entry) => entry.pid)] });
  const pids = new Set(rows.map((row) => row.pid));
  const processes = rows.map((row) => {
    const type = electronType.get(row.pid);
    const cpuPercent = row.cpuPercent ?? (row.cpuMs === null || row.cpuMs === undefined ? null : row.cpuMs / taken.elapsedMs / cores * 100);
    return {
      pid: row.pid, parent_pid: pids.has(row.ppid) ? row.ppid : null, name: row.name,
      role: (type && ELECTRON_TYPES[type]) || roleOf(row.name) || "started by the app",
      cpu_percent: cpuPercent === null ? null : Math.max(0, Math.round(cpuPercent * 10) / 10),
      memory_mb: Number.isFinite(row.ws) ? Math.round(row.ws / 1048576) : null,
      private_mb: Number.isFinite(row.priv) && row.priv !== null ? Math.round(row.priv / 1048576) : null,
      threads: row.threads ?? null, handles: row.handles ?? null,
      started_at: Number.isFinite(row.createdMs) ? new Date(row.createdMs).toISOString() : null,
      uptime: Number.isFinite(row.createdMs) ? uptime(now - row.createdMs) : null,
    };
  });
  const by = {
    cpu: (a, b) => (b.cpu_percent ?? -1) - (a.cpu_percent ?? -1) || (b.memory_mb ?? 0) - (a.memory_mb ?? 0),
    memory: (a, b) => (b.memory_mb ?? -1) - (a.memory_mb ?? -1),
    name: (a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name) || a.pid - b.pid,
  }[sort] ?? ((a, b) => (b.cpu_percent ?? -1) - (a.cpu_percent ?? -1));
  processes.sort(by);
  const shown = Math.min(LIMIT.max, Math.max(1, Math.round(Number(limit) || LIMIT.default)));
  const notes = [];
  for (const role of SINGLETONS) {
    const same = processes.filter((entry) => entry.role === role && !pids.has(entry.parent_pid ?? -1));
    if (same.length > 1) notes.push(`${same.length} separate ${role} processes (pids ${same.map((entry) => entry.pid).join(", ")}): usually one; the others may have been left behind by an earlier start or update.`);
  }
  const busy = processes.filter((entry) => (entry.cpu_percent ?? 0) >= 50);
  for (const entry of busy) notes.push(`${entry.name} (${entry.role}, pid ${entry.pid}) used ${entry.cpu_percent}% of all cores over the sample.`);
  const sum = (key) => Math.round(processes.reduce((total, entry) => total + (entry[key] ?? 0), 0) * 10) / 10;
  return {
    sampled_ms: Math.round(taken.elapsedMs), cores,
    total: { processes: processes.length, cpu_percent: sum("cpu_percent"), memory_mb: sum("memory_mb") },
    ...(processes.length > shown ? { shown: shown, note: `${processes.length - shown} more not shown; raise limit to see them` } : {}),
    notes,
    processes: processes.slice(0, shown),
  };
}

module.exports = { listAppProcesses, selectOwn, roleOf, uptime, windowsSnapshot, posixSnapshot, SAMPLE_MS, LIMIT };

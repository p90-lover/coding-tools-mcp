"use strict";

// Chat agents' commands in a sandbox, as Codex runs its own: each command runs under Codex's
// Windows sandbox (`codex sandbox`, its unelevated restricted-token mode, the one the app already
// uses for Codex mission cards), with the agent's worktree writable, the package managers' caches
// writable, everything else read-only, and the network on (installs need it; a dev server it
// starts is reachable on this machine's loopback for the chat's preview). The sandbox limits what
// a command can change; whether it runs at all is still reviewed (chat-agent-tools.cjs).
//
// - Never Codex's elevated mode, whose setup creates local Windows accounts: only "unelevated".
// - The command reaches cmd.exe through a script file outside the worktree (readable by the
//   sandbox, never writable by it), so its quotes and operators arrive exactly as written:
//   arguments passed through `codex sandbox` to cmd.exe lose their quoting.
// - Each command keeps its output (the latest STREAM_LIMIT bytes of each stream, with absolute
//   offsets, as headless keeps exec_command's) for the agent's read_output and the chat's Terminal
//   pane; its process tree is killed with it (taskkill /T).

const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STREAM_LIMIT = 4 * 1024 * 1024;
const MAX_KEPT = 64;
const LOCATE_TTL_MS = 60_000;
// Environment the sandboxed command never sees: the app's own credentials and runtime switches.
const PRIVATE_ENV = /^(?:CODING_TOOLS_|ELECTRON_|NODE_OPTIONS$|.*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)S?$)/i;

// Variables a Windows process needs to start at all. Without SystemRoot/windir system DLLs fail to
// initialise (STATUS_DLL_INIT_FAILED, 0xC0000142); without TEMP/TMP and USERPROFILE MSYS2 and Node
// have nowhere for their temporary and home files; ComSpec/PATHEXT are how shells find cmd.exe and
// programs. Git Bash, which chat agents' shell tools run, needs all of them in every process it forks.
const WINDOWS_ESSENTIALS = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData"];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
// PATH grows with every launcher that prepends its own folder; MSYS2 converts it in every fork.
const MAX_WINDOWS_PATH = 16 * 1024;

/** PATH without empty or repeated entries (no case, no trailing separator), cut before `limit` characters. */
function compactWindowsPath(value, limit = MAX_WINDOWS_PATH) {
  const seen = new Set();
  const kept = [];
  let size = 0;
  for (const raw of String(value ?? "").split(";")) {
    const entry = raw.trim();
    if (!entry) continue;
    const key = entry.replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    const grow = entry.length + (kept.length ? 1 : 0);
    if (kept.length && size + grow > limit) break;
    seen.add(key);
    kept.push(entry);
    size += grow;
  }
  return kept.join(";");
}

/**
 * A child environment that can start processes on Windows: each essential variable that is missing
 * or empty is filled from the others or from `system` (this process's view of the machine), and PATH
 * is de-duplicated and capped. Values already set are kept, under their own spelling. Elsewhere the
 * environment is returned as it is.
 */
function windowsChildEnvironment(env, { platform = process.platform, system = {} } = {}) {
  const out = { ...env };
  if (platform !== "win32") return out;
  const keyOf = (name) => Object.keys(out).find((key) => key.toUpperCase() === name.toUpperCase());
  const get = (name) => { const key = keyOf(name); return key && typeof out[key] === "string" ? out[key] : ""; };
  const fromSystem = (name) => {
    const key = Object.keys(system).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    return key && typeof system[key] === "string" ? system[key] : "";
  };
  const first = (...values) => values.find((value) => typeof value === "string" && value.trim()) ?? "";
  for (const name of WINDOWS_ESSENTIALS) {
    if (get(name).trim()) continue;
    const root = get("SystemRoot");
    const value = {
      SYSTEMROOT: () => first(get("windir"), fromSystem("SystemRoot"), fromSystem("windir"), "C:\\Windows"),
      WINDIR: () => first(root, fromSystem("windir")),
      SYSTEMDRIVE: () => first(/^[A-Za-z]:/.exec(root)?.[0], fromSystem("SystemDrive")),
      COMSPEC: () => first(root ? `${root.replace(/[\\/]+$/, "")}\\System32\\cmd.exe` : "", fromSystem("ComSpec")),
      PATHEXT: () => first(fromSystem("PATHEXT"), DEFAULT_PATHEXT),
      TEMP: () => first(get("TMP"), fromSystem("TEMP"), fromSystem("TMP")),
      TMP: () => first(get("TEMP"), fromSystem("TMP"), fromSystem("TEMP")),
    }[name.toUpperCase()]?.() ?? fromSystem(name);
    if (value) out[keyOf(name) ?? name] = value;
  }
  const pathKey = keyOf("PATH");
  if (pathKey) out[pathKey] = compactWindowsPath(out[pathKey]);
  return out;
}

/** What this machine says the essential Windows variables are, for windowsChildEnvironment. */
function systemEnvironment() {
  const system = { TEMP: os.tmpdir(), TMP: os.tmpdir(), USERPROFILE: os.homedir() };
  for (const name of WINDOWS_ESSENTIALS) {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) system[name] = process.env[key];
  }
  return system;
}

/** Codex's sandbox: a folder holding codex.exe and its Windows sandbox helper, newest first. */
function findCodexSandbox({ localAppData = process.env.LOCALAPPDATA, home = os.homedir(), platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  const folders = [];
  const binRoot = localAppData ? path.join(localAppData, "OpenAI", "Codex", "bin") : null;
  try {
    for (const name of fs.readdirSync(binRoot)) {
      const folder = path.join(binRoot, name);
      try { folders.push({ folder, at: fs.statSync(folder).mtimeMs }); } catch { /* gone */ }
    }
  } catch { /* the Codex desktop app is not installed */ }
  folders.sort((left, right) => right.at - left.at);
  if (home) folders.push({ folder: path.join(home, ".codex", "plugins", ".plugin-appserver"), at: 0 });
  for (const { folder } of folders) {
    const codex = path.join(folder, "codex.exe");
    if (fs.existsSync(codex) && fs.existsSync(path.join(folder, "codex-windows-sandbox-setup.exe"))) return { codex, folder };
  }
  return null;
}

/** Package managers' caches the sandbox may write (those that exist), so installs work. */
function cacheRoots({ localAppData = process.env.LOCALAPPDATA, env = process.env } = {}) {
  const candidates = [
    env.npm_config_cache, localAppData && path.join(localAppData, "npm-cache"),
    localAppData && path.join(localAppData, "pip", "Cache"), localAppData && path.join(localAppData, "uv", "cache"),
    localAppData && path.join(localAppData, "pnpm"), localAppData && path.join(localAppData, "Yarn", "Cache"),
  ].filter((value) => typeof value === "string" && value);
  return [...new Set(candidates.filter((folder) => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } }))];
}

/** A TOML literal string (single quotes; a path never holds one) for a `-c` override. */
const tomlPath = (value) => `'${String(value).replace(/\\/g, "/").replace(/'/g, "")}'`;

function createSandboxRunner({
  // Where command scripts go: a folder on the app data drive. No default: the system temp folder is
  // on C:, which holds no app storage (AGENTS.md).
  locate = findCodexSandbox, roots = cacheRoots, scriptDir,
  env = process.env, spawnProcess = spawn, logger = console, now = Date.now, platform = process.platform,
  // Folders put first on a command's PATH, e.g. the one AO keeps `ao` in for its own sessions.
  extraPath = () => [],
} = {}) {
  if (typeof scriptDir !== "string" || !path.isAbsolute(scriptDir)) throw new Error("The chat sandbox needs an absolute scriptDir");
  const processes = new Map(); // id -> record
  let located = { at: 0, value: null };
  const sandbox = () => {
    if (now() - located.at > LOCATE_TTL_MS) {
      let value = null;
      try { value = locate() ?? null; } catch { value = null; }
      located = { at: now(), value };
    }
    return located.value;
  };

  function childEnv() {
    const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !PRIVATE_ENV.test(key)));
    let extra = [];
    try { extra = (extraPath() ?? []).filter((folder) => typeof folder === "string" && path.isAbsolute(folder)); } catch {}
    if (extra.length) {
      const pathKey = Object.keys(kept).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      kept[pathKey] = [...extra, kept[pathKey]].filter(Boolean).join(platform === "win32" ? ";" : ":");
    }
    return windowsChildEnvironment(kept, { platform, system: systemEnvironment() });
  }

  function keep(record, stream, chunk) {
    const buffer = record.streams[stream];
    buffer.chunks.push(chunk);
    buffer.size += chunk.length;
    buffer.total += chunk.length;
    while (buffer.size > STREAM_LIMIT && buffer.chunks.length > 1) {
      const dropped = buffer.chunks.shift();
      buffer.size -= dropped.length;
    }
  }

  function prune() {
    if (processes.size <= MAX_KEPT) return;
    const finished = [...processes.values()].filter((record) => record.status !== "running").sort((left, right) => left.startedAt - right.startedAt);
    for (const record of finished) {
      if (processes.size <= MAX_KEPT) break;
      processes.delete(record.id);
    }
  }

  /**
   * Starts `cmd` in `cwd` under the sandbox; `writable` is the worktree. Resolves to the command's id.
   * The script is written without blocking: on the app's busy hard disk, writing it synchronously
   * held every window for 0.5 s on an agent's command (2026-10-31).
   */
  async function start({ cmd, cwd, writable, stdin = "" }) {
    const found = sandbox();
    if (!found) throw new Error("Codex's Windows sandbox is not installed");
    if (typeof cmd !== "string" || !cmd.trim() || cmd.includes("\0")) throw new Error("A command is required");
    const id = `sbx-${crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
    await fs.promises.mkdir(scriptDir, { recursive: true });
    const script = path.join(scriptDir, `${id}.cmd`);
    // Codex's unelevated sandbox never starts a command whose working folder is not exactly one of
    // its writable roots (even `echo` hangs), so it starts in the worktree and the script moves to
    // `cwd`. `%` is doubled because cmd expands it inside a script, even within quotes.
    const home = writable || cwd;
    const enter = cwd && path.resolve(cwd) !== path.resolve(home)
      ? `cd /d "${path.resolve(cwd).replace(/%/g, "%%")}" || exit /b 1\r\n` : "";
    // UTF-8 code page, so non-ASCII paths and output survive; the command exactly as written.
    await fs.promises.writeFile(script, `@echo off\r\nchcp 65001 >nul\r\n${enter}${cmd.replace(/\r?\n/g, "\r\n")}\r\n`, "utf8");
    const writableRoots = [...new Set([writable, ...roots()].filter(Boolean))];
    const args = [
      "sandbox",
      "-c", "windows.sandbox='unelevated'",
      "-c", "sandbox_mode='workspace-write'",
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", `sandbox_workspace_write.writable_roots=[${writableRoots.map(tomlPath).join(",")}]`,
      "--", "cmd.exe", "/d", "/c", script,
    ];
    const child = spawnProcess(found.codex, args, { cwd: home, env: childEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const record = {
      id, cmd, cwd, startedAt: now(), status: "running", exitCode: null, child, script, stdinOpen: true,
      streams: { stdout: { chunks: [], size: 0, total: 0 }, stderr: { chunks: [], size: 0, total: 0 } },
      exited: null,
    };
    record.exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        if (record.status === "running") record.status = "exited";
        record.exitCode = Number.isInteger(code) ? code : record.exitCode;
        record.signal = signal ?? null;
        record.stdinOpen = false;
        fs.rm(script, { force: true }, () => undefined);
        resolve();
      });
    });
    child.on("error", (error) => {
      record.status = "spawn_failed";
      keep(record, "stderr", Buffer.from(`The sandbox could not start: ${error.message}\n`));
    });
    child.stdout.on("data", (chunk) => keep(record, "stdout", chunk));
    child.stderr.on("data", (chunk) => keep(record, "stderr", chunk));
    child.stdin.on("error", () => { record.stdinOpen = false; });
    if (stdin) child.stdin.write(stdin);
    processes.set(id, record);
    prune();
    logger.info?.("chat_sandbox.started", { id, cwd });
    return id;
  }

  const get = (id) => {
    const record = processes.get(id);
    if (!record) throw new Error("No such sandboxed command");
    return record;
  };

  /** Waits up to `ms` for the command to end; resolves either way. */
  async function wait(id, ms) {
    const record = get(id);
    let timer;
    await Promise.race([record.exited, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); })]);
    clearTimeout(timer);
  }

  const text = (buffer) => Buffer.concat(buffer.chunks).toString("utf8");
  const tail = (buffer, max) => {
    const all = Buffer.concat(buffer.chunks);
    return all.length > max ? all.subarray(all.length - max).toString("utf8") : all.toString("utf8");
  };

  /** What the command did so far, shaped like headless's exec_command result. */
  function snapshot(id, maxOutputBytes = 65_536) {
    const record = get(id);
    const max = Math.max(0, Math.min(Number(maxOutputBytes) || 0, 1_048_576));
    return {
      ok: true, command_id: id, session_id: id, status: record.status === "running" ? "running" : "exited",
      termination_reason: record.status, exit_code: record.exitCode,
      command_ok: record.status === "running" ? null : record.exitCode === 0,
      stdin_open: record.stdinOpen, stdout: tail(record.streams.stdout, max), stderr: tail(record.streams.stderr, max),
      stdout_total_bytes: record.streams.stdout.total, stderr_total_bytes: record.streams.stderr.total,
      elapsed_ms: now() - record.startedAt,
      output_refs: { stdout: `command:${id}:stdout`, stderr: `command:${id}:stderr` },
      sandbox: "codex-windows-unelevated", sandbox_enforced: true, writable: "worktree and package caches", network: true,
    };
  }

  /** A read of one stream from an absolute offset, shaped like headless's read_output. */
  function read(id, stream, offset = 0, limit = 65_536) {
    const record = get(id);
    if (stream !== "stdout" && stream !== "stderr") throw new Error("stream must be stdout or stderr");
    const buffer = record.streams[stream];
    const all = Buffer.concat(buffer.chunks);
    const retainedStart = buffer.total - all.length;
    const requested = Math.max(0, Number(offset) || 0);
    const start = Math.min(Math.max(requested, retainedStart), buffer.total);
    const size = Math.max(1, Math.min(Number(limit) || 65_536, 1_048_576));
    const chunk = all.subarray(start - retainedStart, Math.min(all.length, start - retainedStart + size));
    return {
      ok: true, command_id: id, session_id: id, stream, offset: start, next_read_offset: start + chunk.length,
      retained_start_offset: retainedStart, output_gap: requested < retainedStart, content: chunk.toString("utf8"),
      total_stream_bytes: buffer.total, truncated: start + chunk.length < buffer.total,
      status: record.status === "running" ? "running" : "exited", exit_code: record.exitCode, termination_reason: record.status,
    };
  }

  function write(id, chars) {
    const record = get(id);
    if (record.status !== "running" || !record.stdinOpen) throw new Error("The command is not running");
    record.child.stdin.write(String(chars));
  }

  /** Ends the command and every process it started. */
  async function kill(id) {
    const record = get(id);
    if (record.status !== "running") return snapshot(id, 0);
    record.status = "killed";
    const pid = record.child.pid;
    await new Promise((resolve) => {
      if (!Number.isInteger(pid)) { try { record.child.kill(); } catch { /* gone */ } resolve(); return; }
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
    });
    await wait(id, 3000);
    return snapshot(id, 0);
  }

  function owns(id) { return processes.has(id); }

  function killAll() {
    for (const record of processes.values()) {
      if (record.status === "running" && Number.isInteger(record.child.pid)) {
        try { execFile("taskkill", ["/T", "/F", "/PID", String(record.child.pid)], { windowsHide: true }, () => undefined); } catch { /* gone */ }
      }
    }
  }

  return Object.freeze({
    /** Whether commands can run sandboxed here (Codex's sandbox is installed). */
    available: () => Boolean(sandbox()),
    describe: () => { const found = sandbox(); return found ? { codex: found.codex, writableCaches: roots() } : null; },
    start, wait, snapshot, read, write, kill, owns, killAll,
    text: (id, stream) => text(get(id).streams[stream]),
  });
}

module.exports = Object.freeze({
  createSandboxRunner, findCodexSandbox, cacheRoots, PRIVATE_ENV, windowsChildEnvironment, systemEnvironment, compactWindowsPath,
  MAX_WINDOWS_PATH,
});

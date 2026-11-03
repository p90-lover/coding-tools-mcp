"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { windowsChildEnvironment, systemEnvironment } = require("./chat-sandbox.cjs");
const { warmProgram, fetchOffThread } = require("./off-thread-run.cjs");

const CONTROL_SCHEMA = 1;
const CONTROL_PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Waits before sending a request again that the headless service turned away as full.
const CAPACITY_RETRY_MS = [100, 250, 600];
// The launcher's own requests in flight at once, below the service's 32 request slots
// (coding-tools-headless ServiceConfig). The rest wait their turn here instead of being turned away:
// after each restart since 0.8.30, chats restoring at once sent more than 16 and the service
// refused 15-39 in a burst (turn_timeline, runs, observe, chat_prewarm, board), each a failed call
// that left a chat's Worked rows or the board empty. A slot held by a slow read on the HDD outlasted
// the retries above (under a second in all). 12 was too few for eight split-view chats: on
// 2026-11-03 their refresh (harness_status, chat_recover, chat_branches, runs) waited out the queue
// and 25 calls failed in three seconds.
const MAX_IN_FLIGHT = 24;
// A queued request fails as the service would have only when no turn has finished for this long:
// a queue that is moving, however long, is not full.
const QUEUE_WAIT_MS = 15_000;
// And in any case after this long in the queue.
const MAX_QUEUE_WAIT_MS = 60_000;
const CONTROL_SLOTS = 2;
const MAX_QUEUED = 128;
const MAX_CONTROL_QUEUED = 16;
const READ_PATHS = new Set(["/api/v1/ao/read", "/api/v1/ao/harness/status", "/api/v1/ao/harness/permission-profiles"]);
const CONTROL_PATHS = new Set(["/api/v1/ao/control", "/api/v1/ao/harness/approval", "/api/v1/ao/harness/disconnect", "/api/v1/native-codex/approval"]);

function admissionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function abortedRequest() {
  return Object.assign(new Error("Headless request cancelled"), { name: "AbortError", code: "ABORT_ERR" });
}

function requestScope(pathname, body, options) {
  const id = value => typeof value === "string" && /^[\w-]{1,128}$/.test(value) ? value : "";
  const owner = JSON.stringify([id(body?.workspace_id), id(body?.run_id)]);
  const control = CONTROL_PATHS.has(pathname) || (pathname === "/api/v1/ao/read" && options.admissionControl === true);
  return { owner, category: control ? "control" : READ_PATHS.has(pathname) ? "read" : "other" };
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_STARTUP_STDERR_BYTES = 4096;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function regularFile(pathname, label) {
  const metadata = fs.lstatSync(pathname);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-linked file`);
  }
  return metadata;
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Deletes the control token's file once the app holds the token (or headless did not start). */
function removeTokenFile(tokenPath, logger) {
  try {
    fs.rmSync(tokenPath, { force: true });
  } catch (error) {
    logger?.warn?.("headless.token_file_not_removed", { message: safeErrorMessage(error) });
  }
}

// The control token files headless writes (see start); anything else in their folder is left alone.
const TOKEN_FILE_NAME = /^token-.+\.txt$/;

/**
 * Deletes control token files that earlier runs left in `directory` (the app crashed or was killed
 * before it could delete its own): only regular files named token-*.txt, never `keep` (the one
 * about to be used), and only those last written before `before` (epoch ms). Quiet: a file that
 * cannot be read or removed is left for the next start.
 */
function removeStaleTokenFiles(directory, { keep = null, before }) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(directory, name);
    if (!TOKEN_FILE_NAME.test(name) || (keep && path.resolve(file) === path.resolve(keep))) continue;
    try {
      const metadata = fs.lstatSync(file);
      if (metadata.isFile() && metadata.mtimeMs < before) fs.rmSync(file, { force: true });
    } catch {
      // Left for the next start.
    }
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").slice(0, 500);
}

// From a worker (fetchOffThread): made here, the chat's AO reads (11 a second with two chats
// working) were each a socket write on main, where one a network filter held froze every window.
async function requestJson({ endpoint, token, localUiToken = null, pathname, method = "POST", body = null, timeout = REQUEST_TIMEOUT_MS, signal,
  fetchImpl = fetchOffThread }) {
  const url = new URL(pathname, endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("Refusing a non-loopback headless control endpoint");
  }
  const deadline = AbortSignal.timeout(timeout);
  let status;
  let text;
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(localUiToken ? { "x-coding-tools-local-ui": localUiToken } : {}),
        accept: "application/json",
        ...(body === null ? {} : { "content-type": "application/json" }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      maxBytes: MAX_RESPONSE_BYTES,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    status = response.status || 500;
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw abortedRequest();
    if (deadline.aborted) throw new Error("Headless request timed out");
    if (error?.code === "ERR_RESPONSE_TOO_LARGE") throw new Error("Headless response exceeded the local size limit");
    // fetch says only "fetch failed"; the socket's own error says what (connect ECONNREFUSED ...).
    throw new Error(safeErrorMessage(error?.cause ?? error));
  }
  let value = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    // A refused request body (e.g. an unknown field) comes back as plain text: say so with
    // the status and the service's own words instead of only "invalid JSON".
    const said = text.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(status >= 200 && status < 300 ? "Headless service returned invalid JSON"
      : safeErrorMessage(`Headless service rejected the request (HTTP ${status})${said ? `: ${said}` : ""}`));
  }
  if (status < 200 || status >= 300) {
    // Keep the service's own reason, whichever error shape it used, so the UI is not left
    // with a generic message; fall back to the HTTP status.
    const message = value?.error?.message
      || (typeof value?.error === "string" && value.error)
      || (typeof value?.message === "string" && value.message)
      || `Headless service rejected the request (HTTP ${status})`;
    const error = new Error(safeErrorMessage(message));
    error.status = status;
    const code = value?.error?.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)) error.code = code;
    throw error;
  }
  return value;
}

class HeadlessHost {
  constructor({ app, logger, sourceRoot, binaryRoot = null, aoWorktreesRoot = null, warm = warmProgram, fetchImpl = fetchOffThread }) {
    this.warm = warm;
    this.fetchImpl = fetchImpl;
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    // A swappable backend bundle carries its own headless executable under coding-tools/.
    this.binaryRoot = binaryRoot;
    // AO's session worktrees: a tool call rooted at a chat session must be rooted inside it.
    this.aoWorktreesRoot = typeof aoWorktreesRoot === "string" && path.isAbsolute(aoWorktreesRoot) ? aoWorktreesRoot : null;
    this.child = null;
    this.control = null;
    this.starting = null;
    this.stopping = false;
  }

  /**
   * The headless executable to run, and where it came from. An installed app runs the one it
   * shipped with (its installed backend bundle's, else its resources'). CODING_TOOLS_HEADLESS_BINARY
   * and the source tree's builds are a developer's: honoured only by an unpackaged app or a dev
   * profile (CODING_TOOLS_DEV_HOME). Otherwise a variable left in the shell that launched the
   * installed app tied it to a build folder, whose executable it then held locked against rebuilds.
   */
  binarySelection() {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const name = `coding-tools-headless${suffix}`;
    const developer = !this.app.isPackaged || Boolean(process.env.CODING_TOOLS_DEV_HOME);
    const override = process.env.CODING_TOOLS_HEADLESS_BINARY;
    const candidates = [
      developer && override ? { source: "override", file: override } : null,
      this.binaryRoot ? { source: "bundle", file: path.join(this.binaryRoot, "coding-tools", name) } : null,
      this.app.isPackaged ? { source: "packaged", file: path.join(process.resourcesPath, "coding-tools", name) } : null,
      developer ? { source: "source", file: path.join(this.sourceRoot, "rust-core", "target", "debug", name) } : null,
      developer ? { source: "source", file: path.join(this.sourceRoot, "rust-core", "target", "release", name) } : null,
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        regularFile(candidate.file, "Headless executable");
        return { source: candidate.source, file: path.resolve(candidate.file), ignoredOverride: Boolean(override) && !developer };
      } catch {
        // Continue through deterministic local candidates.
      }
    }
    throw new Error("Packaged Paseo/Anneal headless executable is unavailable");
  }

  binaryPath() {
    return this.binarySelection().file;
  }

  async ensureStarted() {
    if (this.control && this.child && this.child.exitCode === null) return this.control;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async start() {
    if (this.stopping) throw new Error("Local execution service is stopping");
    const selection = this.binarySelection();
    const executable = selection.file;
    this.logger?.info?.("headless.binary_selected", { source: selection.source, file: executable });
    if (selection.ignoredOverride) {
      this.logger?.warn?.("headless.binary_override_ignored", { reason: "packaged app without CODING_TOOLS_DEV_HOME" });
    }
    // spawn() holds every window until Windows has loaded the program and the antivirus has
    // scanned it: 1.85 s for this start (launcher.main_blocked, 2026-10-31). The service's pipes
    // and exit must live here, so the program is first run from a worker with an argument it
    // refuses at once, and the start below finds it loaded and scanned.
    await this.warm(executable, ["--version"]);
    if (this.stopping) throw new Error("Local execution service is stopping");
    const requestedAppDataDir = path.join(this.app.getPath("userData"), "headless");
    fs.mkdirSync(requestedAppDataDir, { recursive: true, mode: 0o700 });
    const appDataDir = fs.realpathSync.native(requestedAppDataDir);
    const id = `${process.pid}-${crypto.randomUUID()}`;
    const uiToken = crypto.randomBytes(32).toString("base64url");
    const descriptorPath = path.join(appDataDir, "runtime", `control-${id}.json`);
    const tokenPath = path.join(appDataDir, "aiTemp", "headless-control", `token-${id}.txt`);
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    // A token file from an earlier run is a secret nobody will read; one written within the startup
    // window may still be another instance's (dev and packaged builds can share this folder).
    removeStaleTokenFiles(path.dirname(tokenPath), { keep: tokenPath, before: Date.now() - START_TIMEOUT_MS });

    let startupStderr = Buffer.alloc(0), captureStartup = true;
    const startupError = (message) => {
      captureStartup = false;
      const detail = safeErrorMessage(startupStderr.toString("utf8")
        .split(uiToken).join("[redacted]")
        .replace(/(\b(?:[\w-]*token|api[_-]?key|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim());
      startupStderr = Buffer.alloc(0);
      return new Error(message + (detail ? ": " + detail : ""));
    };
    const child = spawn(executable, ["serve"], {
      cwd: path.dirname(executable),
      env: {
        // The commands headless starts for exec_command (Git Bash among them) inherit this: on
        // Windows it carries what a process needs to start and a bounded PATH.
        ...windowsChildEnvironment(process.env, { system: systemEnvironment() }),
        CODING_TOOLS_APP_DATA_DIR: appDataDir,
        ...(process.env.CODING_TOOLS_DEV_HOME ? { CODING_TOOLS_STATE_DIR: process.env.CODING_TOOLS_STATE_DIR || path.join(appDataDir, "state") } : {}),
        // Read once at startup; headless never passes them (or any other CODING_TOOLS_* secret) on
        // to the commands and git processes it starts for tool calls.
        CODING_TOOLS_CONTROL_DESCRIPTOR_FILE: descriptorPath,
        CODING_TOOLS_CONTROL_TOKEN_FILE: tokenPath,
        CODING_TOOLS_LOCAL_UI_STDIN: "1",
        ...(this.aoWorktreesRoot ? { CODING_TOOLS_AO_WORKTREES_DIR: this.aoWorktreesRoot } : {}),
      },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const childClosed = new Promise(resolve => child.once("close", resolve));
    child.stderr?.on("data", chunk => {
      if (!captureStartup) return; // Keep draining after readiness without retaining service logs.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      startupStderr = Buffer.concat([startupStderr, bytes.subarray(-MAX_STARTUP_STDERR_BYTES)]).subarray(-MAX_STARTUP_STDERR_BYTES);
    });
    this.child = child;
    if (!child.stdin) {
      child.kill();
      throw new Error("Headless local UI channel unavailable");
    }
    child.stdin.on("error", (error) => {
      this.logger.warn("headless.local_ui_channel_failed", { message: safeErrorMessage(error) });
    });
    child.stdin.end(uiToken + "\n");
    child.once("exit", (code, signal) => {
      const expected = this.stopping;
      this.control = null;
      if (this.child === child) this.child = null;
      if (!expected) {
        this.logger.warn("headless.unexpected_exit", {
          code: Number.isInteger(code) ? code : null,
          signal: signal || null,
        });
      }
    });
    child.once("error", (error) => {
      this.logger.error("headless.spawn_failed", { message: safeErrorMessage(error) });
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        await Promise.race([childClosed, sleep(100)]);
        removeTokenFile(tokenPath, this.logger);
        throw startupError(`Local execution service exited during startup (${child.exitCode})`);
      }
      if (fs.existsSync(descriptorPath) && fs.existsSync(tokenPath)) {
        try {
          const descriptor = this.readDescriptor(descriptorPath, appDataDir, child.pid);
          const token = this.readToken(descriptor, tokenPath, appDataDir);
          const health = await requestJson({
            fetchImpl: this.fetchImpl,
            endpoint: descriptor.endpoint,
            token,
            pathname: "/control/v1/health",
            method: "GET",
            timeout: 2_000,
          });
          if (health.ready !== true || health.protocol_version !== CONTROL_PROTOCOL_VERSION) {
            throw new Error("Headless health contract is not ready");
          }
          // The token lives on in memory only: headless never reads its file back, and a file
          // left at a known path could be read by any command the service runs for a tool call.
          removeTokenFile(tokenPath, this.logger);
          captureStartup = false;
          startupStderr = Buffer.alloc(0);
          this.control = Object.freeze({
            endpoint: descriptor.endpoint,
            token,
            uiToken,
            descriptorPath,
            tokenPath,
          });
          this.logger.info("headless.ready", {
            pid: child.pid,
            protocolVersion: descriptor.protocol_version,
            version: descriptor.version,
          });
          return this.control;
        } catch (error) {
          if (Date.now() + 100 >= deadline) {
            removeTokenFile(tokenPath, this.logger);
            throw error;
          }
        }
      }
      await sleep(100);
    }
    child.kill();
    removeTokenFile(tokenPath, this.logger);
    throw startupError("Local execution service did not become ready");
  }

  readDescriptor(descriptorPath, appDataDir, pid) {
    const metadata = regularFile(descriptorPath, "Headless descriptor");
    if (metadata.size > 64 * 1024) throw new Error("Headless descriptor is too large");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (descriptor.schema !== CONTROL_SCHEMA
      || descriptor.protocol_version !== CONTROL_PROTOCOL_VERSION
      || descriptor.status !== "ready"
      || descriptor.pid !== pid
      || descriptor.app_data_dir !== appDataDir) {
      throw new Error("Headless descriptor identity check failed");
    }
    const endpoint = new URL(descriptor.endpoint);
    if (endpoint.protocol !== "http:"
      || endpoint.hostname !== "127.0.0.1"
      || endpoint.username
      || endpoint.password
      || endpoint.pathname !== "/") {
      throw new Error("Headless descriptor endpoint is not a private loopback listener");
    }
    if (!Number.isInteger(Number(endpoint.port)) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
      throw new Error("Headless descriptor port is invalid");
    }
    return descriptor;
  }

  readToken(descriptor, expectedTokenPath, appDataDir) {
    const tokenFile = path.resolve(descriptor.token_file);
    if (tokenFile !== path.resolve(expectedTokenPath) || !within(appDataDir, tokenFile)) {
      throw new Error("Headless token file escaped the private application directory");
    }
    const metadata = regularFile(tokenFile, "Headless token");
    if (metadata.size < 32 || metadata.size > 1024) throw new Error("Headless token length is invalid");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const digest = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(descriptor.token_sha256))) {
      throw new Error("Headless token digest check failed");
    }
    return token;
  }

  /** Bounded admission: ordinary work cannot borrow the slots reserved for controls. */
  takeTurn({ owner = "", category = "other", signal } = {}) {
    this.turns ??= { active: 0, waiting: [] };
    this.activeTurns ??= new Set();
    this.lastOwner ??= {};
    this.recentTurns ??= [];
    if (signal?.aborted) return Promise.reject(abortedRequest());
    if (this.stopping) return Promise.reject(new Error("Local execution service is stopping"));
    const lane = category === "control" ? "control" : "ordinary";
    const queued = this.turns.waiting.filter(entry => entry.lane === lane).length;
    if (queued >= (lane === "control" ? MAX_CONTROL_QUEUED : this.maxQueued ?? MAX_QUEUED)) {
      return Promise.reject(admissionError("HEADLESS_QUEUE_FULL", "Headless launcher queue is full; wait for pending work to finish"));
    }
    return new Promise((resolve, reject) => {
      const entry = { owner, category, lane, queuedAt: performance.now(), startedAt: null, outcome: "completed", resolve, reject };
      const remove = error => {
        const index = this.turns.waiting.indexOf(entry);
        if (index < 0) return;
        this.turns.waiting.splice(index, 1);
        entry.cleanup();
        this.recordTurn(entry, error.code === "ABORT_ERR" ? "cancelled" : "queue-timeout");
        reject(error);
      };
      const abort = () => remove(abortedRequest());
      const idleLimit = this.queueWaitMs ?? QUEUE_WAIT_MS;
      const totalLimit = Math.max(idleLimit, this.maxQueueWaitMs ?? MAX_QUEUE_WAIT_MS);
      let timer = null;
      // Re-checked when it fires, not reset on every finished turn: the queue may hold 128 entries.
      const expire = () => {
        const now = performance.now();
        const idle = now - Math.max(entry.queuedAt, this.lastTurnReleasedAt ?? 0);
        const left = Math.min(idleLimit - idle, totalLimit - (now - entry.queuedAt));
        if (left > 0) { timer = setTimeout(expire, left); return; }
        remove(admissionError("HEADLESS_QUEUE_TIMEOUT", "HEADLESS_CAPACITY: request admission is full (the launcher's queue did not clear in time)"));
      };
      timer = setTimeout(expire, idleLimit);
      entry.cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      this.turns.waiting.push(entry);
      this.drainTurns();
    });
  }

  drainTurns() {
    if (this.stopping) return;
    const maximum = this.maxInFlight ?? MAX_IN_FLIGHT;
    const ordinaryLimit = maximum - Math.min(CONTROL_SLOTS, maximum - 1);
    while (this.turns.active < maximum) {
      const ordinaryActive = [...this.activeTurns].filter(entry => entry.lane === "ordinary").length;
      const lane = this.turns.waiting.some(entry => entry.lane === "control") ? "control" : "ordinary";
      if (lane === "ordinary" && ordinaryActive >= ordinaryLimit) break;
      // Preserve each chat's order, but give a different owner the next turn when one is waiting.
      let index = this.turns.waiting.findIndex(entry => entry.lane === lane && entry.owner !== this.lastOwner[lane]);
      if (index < 0) index = this.turns.waiting.findIndex(entry => entry.lane === lane);
      if (index < 0) break;
      const [entry] = this.turns.waiting.splice(index, 1);
      const sameOwner = this.turns.waiting.filter(next => next.lane === lane && next.owner === entry.owner);
      this.turns.waiting = this.turns.waiting.filter(next => next.lane !== lane || next.owner !== entry.owner).concat(sameOwner);
      entry.cleanup();
      entry.startedAt = performance.now();
      this.lastOwner[lane] = entry.owner;
      this.activeTurns.add(entry);
      this.turns.active += 1;
      entry.resolve(entry);
    }
  }

  recordTurn(entry, outcome) {
    const now = performance.now();
    this.recentTurns.push({ category: entry.category, owner: entry.owner,
      queueWaitMs: (entry.startedAt ?? now) - entry.queuedAt,
      executionMs: entry.startedAt === null ? 0 : now - entry.startedAt, outcome });
    if (this.recentTurns.length > 64) this.recentTurns.shift();
  }

  releaseTurn(entry) {
    if (!this.activeTurns.delete(entry)) return;
    this.turns.active -= 1;
    this.lastTurnReleasedAt = performance.now();
    this.recordTurn(entry, entry.outcome);
    this.drainTurns();
  }

  /** Memory only: no payloads, arbitrary URLs, credentials, or error text. */
  admissionStatus() {
    const now = performance.now();
    const describe = entry => ({ category: entry.category, owner: entry.owner,
      queueWaitMs: (entry.startedAt ?? now) - entry.queuedAt,
      executionMs: entry.startedAt === null ? 0 : now - entry.startedAt });
    return { active: this.turns?.active ?? 0, queued: this.turns?.waiting.length ?? 0,
      coalesced: this.coalescedReads ?? 0,
      running: [...(this.activeTurns ?? [])].map(describe),
      waiting: (this.turns?.waiting ?? []).map(describe),
      recent: (this.recentTurns ?? []).map(entry => ({ ...entry })) };
  }

  async request(pathname, body = null, options = {}) {
    const method = options.method || (body == null ? "GET" : "POST");
    const scope = requestScope(pathname, body, options);
    const readOnly = READ_PATHS.has(pathname) && ["GET", "POST"].includes(method);
    this.pendingReads ??= new Map();
    // Only known pure reads share in-flight work. A write invalidates sharing both before and
    // after it settles, so a post-write refresh cannot inherit an older read's snapshot.
    if (!readOnly) this.pendingReads.clear();
    const key = readOnly && !options.signal ? crypto.createHash("sha256")
      .update(JSON.stringify([pathname, method, body, options.timeout ?? REQUEST_TIMEOUT_MS, options.localConfirmation === true, scope.category])).digest("hex") : null;
    if (key && this.pendingReads.has(key)) {
      this.coalescedReads = (this.coalescedReads ?? 0) + 1;
      return structuredClone(await this.pendingReads.get(key));
    }
    const pending = this.sendRequest(pathname, body, { ...options, method }, scope);
    if (key) this.pendingReads.set(key, pending);
    try {
      return await pending;
    } finally {
      if (!readOnly) this.pendingReads.clear();
      else if (key && this.pendingReads.get(key) === pending) this.pendingReads.delete(key);
    }
  }

  async sendRequest(pathname, body, options, scope) {
    if (options.signal?.aborted) throw abortedRequest();
    const control = await this.ensureStarted();
    const turn = await this.takeTurn({ ...scope, signal: options.signal });
    try {
      // Only explicit pre-execution service capacity refusals may be retried, never timeouts or
      // transport failures after a mutation may already have been accepted.
      for (const wait of [...CAPACITY_RETRY_MS, null]) {
        if (options.signal?.aborted) throw abortedRequest();
        try {
          return await requestJson({
            fetchImpl: this.fetchImpl,
            endpoint: control.endpoint,
            token: control.token,
            localUiToken: options.localConfirmation === true ? control.uiToken : null,
            pathname,
            method: options.method,
            body,
            timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
            signal: options.signal,
          });
        } catch (error) {
          if (options.signal?.aborted) throw abortedRequest();
          const message = safeErrorMessage(error);
          if (wait === null || !message.includes("HEADLESS_CAPACITY")) {
            const failure = new Error(message);
            if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) failure.status = error.status;
            if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)) failure.code = error.code;
            throw failure;
          }
          await sleep(wait);
        }
      }
    } catch (error) {
      turn.outcome = error.code === "ABORT_ERR" ? "cancelled" : /HEADLESS_CAPACITY/.test(error.message) ? "service-capacity"
        : /timed out/.test(error.message) ? "request-timeout" : "request-error";
      throw error;
    } finally {
      this.releaseTurn(turn);
    }
  }

  async shutdown(reason = "launcher-quit") {
    this.stopping = true;
    const child = this.child;
    const control = this.control;
    if (!child) return { ok: true, stopped: false };
    if (control && child.exitCode === null) {
      try {
        await requestJson({
          fetchImpl: this.fetchImpl,
          endpoint: control.endpoint,
          token: control.token,
          pathname: "/control/v1/shutdown",
          body: { reason },
          timeout: 5_000,
        });
      } catch (error) {
        this.logger.warn("headless.shutdown_request_failed", {
          message: safeErrorMessage(error),
        });
      }
    }
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      sleep(5_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) child.kill();
    this.control = null;
    this.child = null;
    return { ok: true, stopped: true };
  }
}

module.exports = Object.freeze({
  HeadlessHost,
  removeStaleTokenFiles,
  requestJson,
});

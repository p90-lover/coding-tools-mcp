"use strict";

const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const MAX_AUTH_BYTES = 128 * 1024;
const MAX_RPC_BYTES = 1024 * 1024;
// One review's own work, from the moment it has a slot.
const WORK_LIMIT_MS = 40_000;
// A burst of requests (many chats under "Approve for me") waits in line for a slot, and the wait is
// not part of a review's 40 s. Until 2026-11-23 it was: with four slots and 10-25 s reviews, every
// request past the fourth or so timed out in line and was left for the person, so chats sat waiting.
const QUEUE_LIMIT_MS = 5 * 60_000;
const MAX_WAITING = 1000;
// Long-lived isolated Codex app-servers, each running several reviews at once on their own ephemeral
// threads. Until 2026-11-23 every review started and signed in its own server, four at a time.
// Measured that day on one Plus account: eight at once on one server, all correct in 10-25 s; 300
// at 32 at once ran about 1.3 a second until OpenAI slowed them, 0.77 a second overall, with the
// slowest tenth taking 2.5-3 minutes. Past about 16 at once, more only lengthens the wait at
// OpenAI, where it counts against a review's 40 s; here it waits in line instead.
const MAX_SERVERS = 2;
const REVIEWS_PER_SERVER = 8;
const IDLE_CLOSE_MS = 2 * 60_000;
const USAGE_LIMIT_COOLDOWN_MS = 10 * 60_000;
// Codex's own auto-review model, the one Codex Desktop's Guardian sessions run on. Codex 0.171 runs
// Guardian on the model of the thread under review, so the review thread starts on it. Until
// 2026-11-23 it started on Codex's default chat model (gpt-6.2-sol), and 400 reviews moved a Plus
// account's 5-hour window by 2%. A Codex that refuses the name gets its default model instead.
const REVIEW_MODEL = "codex-auto-review";
const SHELLS = new Map([["Bash", "bash"], ["PowerShell", "powershell"]]);

async function readNativeAccount(authFile, now = Date.now()) {
  let file;
  try {
    file = await fs.open(authFile, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTH_BYTES) return null;
    const data = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(data, 0, stat.size, 0);
    const { auth_mode: mode, tokens } = JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
    const accessToken = tokens?.access_token, chatgptAccountId = tokens?.account_id;
    if (mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length > 24_000
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(accessToken)
      || typeof chatgptAccountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(chatgptAccountId)) return null;
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now + WORK_LIMIT_MS) return null;
    return { accessToken, chatgptAccountId };
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

function serverEnvironment(root, env) {
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|(?:http|https|all|no)_proxy)$/iu.test(key)));
  const tmp = path.join(root, "tmp");
  return { ...kept, CODEX_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: tmp, TMP: tmp };
}

/**
 * One isolated Codex app-server. `onStop` runs once when it stops for any reason (its process
 * ended, it broke the protocol, or it asked to run something). A request can be given its own
 * abort signal: one server carries several reviews, and a review's time limit must not stop the
 * others. A reply that arrives after its request was abandoned is dropped, not read as a
 * protocol break.
 */
function openReviewServer(executable, root, env, signal, spawnProcess, onStop = () => {}) {
  if (signal.aborted) throw signal.reason;
  const child = spawnProcess(executable, ["app-server", "--stdio", "-c", "features.codex_hooks=false", "-c", "features.plugins=false"], {
    cwd: root, env: serverEnvironment(root, env), windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const decoder = new StringDecoder("utf8");
  let buffer = "", next = 1, stopped = false, protocolBreak = false;
  const pending = new Map();
  const abandoned = new Set();
  let onClosed;
  const closed = new Promise(resolve => { onClosed = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", stop);
    for (const reply of pending.values()) reply.reject(new Error("The native reviewer did not complete the request"));
    pending.clear();
    child.stdin.destroy();
    child.kill();
    try { onStop(protocolBreak); } catch { /* the pool's own bookkeeping */ }
  };
  child.once("close", () => { stop(); onClosed(); });
  child.once("error", () => { stop(); onClosed(); });
  child.stdin.on("error", stop);
  child.stdout.on("error", stop);
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk) => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_RPC_BYTES) { protocolBreak = true; stop(); return; }
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { protocolBreak = true; stop(); return; }
      if (!message || typeof message !== "object") { protocolBreak = true; stop(); return; }
      if (typeof message.method === "string") {
        // The isolated reviewer never receives consent to execute a tool, answer an approval, or refresh the source login.
        if (message.id !== undefined) { protocolBreak = true; stop(); return; }
        continue;
      }
      const reply = pending.get(message.id);
      if (!reply && abandoned.delete(message.id)) continue;
      if (!reply) { protocolBreak = true; stop(); return; }
      pending.delete(message.id);
      if (message.error || !Object.hasOwn(message, "result")) {
        const error = new Error("Codex refused the review-only request");
        if (Number.isSafeInteger(message.error?.code)) error.rpcCode = message.error.code;
        if (typeof message.error?.message === "string" && /UsageLimitExceeded|usage_limit_reached|hit your usage limit/iu.test(message.error.message)) {
          error.usageLimit = true;
        }
        error.rpcMethod = reply.method;
        reply.reject(error);
      } else reply.resolve(message.result);
    }
  });
  function send(message) {
    if (stopped || signal.aborted) throw new Error("The isolated Codex reviewer is closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params = {}, abort = null) {
    return new Promise((resolve, reject) => {
      if (abort?.aborted) { reject(abort.reason ?? new Error("The review was stopped")); return; }
      const id = next++;
      const onAbort = () => {
        if (!pending.delete(id)) return;
        abandoned.add(id);
        reject(abort.reason ?? new Error("The review was stopped"));
      };
      const settle = (done) => (value) => { abort?.removeEventListener("abort", onAbort); done(value); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      abort?.addEventListener("abort", onAbort, { once: true });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); abort?.removeEventListener("abort", onAbort); reject(error); }
    });
  }
  return { request, notify: (method) => send({ method }), async close() {
    stop();
    const timer = AbortSignal.timeout(1500);
    await Promise.race([closed, new Promise(resolve => { timer.addEventListener("abort", resolve, { once: true }); })]);
  } };
}

async function exactShellAction(approval, folder) {
  const shell = SHELLS.get(approval?.tool), { command, cwd } = approval || {};
  if (!shell || approval.source !== "ao" || approval.kind !== "command" || approval.reviewTruncated || approval.guardianUnsupported
    || approval.toolInput || approval.permissions || !path.isAbsolute(folder || "") || !path.isAbsolute(cwd || "") || cwd.includes("\0")
    || typeof command !== "string" || !command.trim() || command.includes("\0") || Buffer.byteLength(command) > 4000) return null;
  try {
    const [root, actual] = await Promise.all([fs.realpath(folder), fs.realpath(cwd)]);
    const rel = path.relative(root, actual);
    if (path.isAbsolute(rel) || rel.split(path.sep)[0] === ".." || !(await fs.stat(actual)).isDirectory()) return null;
    return { cmd: command, workdir: cwd, shell, login: false, sandbox_permissions: "require_escalated" };
  } catch { return null; }
}

const pending = (reason) => ({ action: "ask", reason });
const unavailable = (reason, timedOut = false) => ({ ...pending(reason), guardianUnavailable: true, ...(timedOut ? { guardianTimedOut: true } : {}) });

function usage(result) {
  const limits = result?.rateLimits;
  const percent = (window) => Number.isFinite(window?.usedPercent) ? window.usedPercent : null;
  return { primary: percent(limits?.primary), secondary: percent(limits?.secondary) };
}

const ALLOWED_AUTHORIZATION = new Set(["high", "medium", "unknown"]);

function verdict(result, callId) {
  const assessment = result?.assessment;
  if (result?.callId !== callId || !assessment) return pending("Guardian gave no verdict for this exact action. Check it yourself.");
  const reason = String(assessment.rationale || "Native Codex Guardian verdict").slice(0, 300);
  if (assessment.outcome === "deny") return { action: "deny", reason, actor: "guardian", reason_code: "native_guardian" };
  // A low-risk allow goes through, as it does in Codex itself, whose policy has Guardian answer a
  // low-risk action with the outcome alone and so often leave the authorization "unknown" (16% of
  // benign reviews when measured). An authorization Guardian rated "low" (signs the user did not ask
  // for it), or one it did not rate at all, still waits for the user.
  if (assessment.outcome === "allow" && assessment.riskLevel === "low" && ALLOWED_AUTHORIZATION.has(assessment.userAuthorization)) {
    return { action: "allow", reason, actor: "guardian", reason_code: "native_guardian" };
  }
  const unresolved = pending("Guardian did not confirm low risk with no sign the user did not ask for it. Check this request yourself.");
  if (assessment.outcome === "allow" || assessment.outcome === "ask") {
    const risk = assessment.riskLevel;
    return { ...unresolved, guardianAssessment: risk === "low" ? "low-risk"
      : risk === "high" || risk === "critical" ? "high-risk" : "risk-unconfirmed" };
  }
  return unresolved;
}

/**
 * Native Codex Guardian for shell requests, as a pool. Up to `maxServers` long-lived isolated Codex
 * app-servers (each in its own private profile under `stateDir`, signed in with the Codex CLI's
 * ChatGPT sign-in) run up to `perServer` reviews at once, each on its own ephemeral read-only
 * thread. Requests past that wait in line (at most `maxWaiting`, for at most `queueMs`); a review's
 * `workMs` starts only once it has its slot. A server that fails mid-review is replaced and the
 * review tried once more on a fresh one. The sign-in is read before every review, and servers
 * signed in with an older one are closed. An idle server closes after `idleMs`, its profile with it.
 * `close()` ends the pool (the app quitting).
 */
function createGuardianReview({ stateDir, authFile, executable, env = process.env, spawnProcess = spawn,
  prepareAccount = () => readNativeAccount(authFile), platform = process.platform, now = Date.now, limits = {} }) {
  if (!path.isAbsolute(stateDir || "")) throw new Error("Native Guardian needs an absolute app data path");
  const { workMs = WORK_LIMIT_MS, queueMs = QUEUE_LIMIT_MS, maxServers = MAX_SERVERS, perServer = REVIEWS_PER_SERVER,
    idleMs = IDLE_CLOSE_MS, maxWaiting = MAX_WAITING, usageLimitCooldownMs = USAGE_LIMIT_COOLDOWN_MS } = limits;
  const capacity = maxServers * perServer;
  let active = 0, closed = false;
  const waiting = [];
  const servers = new Set();
  const usageLimitedUntil = new Map();

  /** A review slot: resolves true once it has one, false if the caller gave up, the wait ran out or the line is full. */
  function acquireSlot(signal) {
    if (signal.aborted || closed) return Promise.resolve(false);
    if (active < capacity) { active++; return Promise.resolve(true); }
    if (waiting.length >= maxWaiting) return Promise.resolve(false);
    return new Promise(resolve => {
      const entry = { enter: () => { signal.removeEventListener("abort", leave); resolve(true); }, leave: () => resolve(false) };
      const leave = () => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); resolve(false); };
      waiting.push(entry);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
  function releaseSlot() {
    const next = waiting.shift();
    if (next && !closed) next.enter(); else active--;
  }

  const fingerprint = account => createHash("sha256").update(`${account.chatgptAccountId}\n${account.accessToken}`).digest("hex");

  async function retire(entry) {
    if (entry.retired) return entry.gone;
    entry.retired = true;
    servers.delete(entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.gone = (async () => {
      try { await entry.ready?.catch(() => {}); await entry.server?.close(); }
      finally { if (entry.root) await fs.rm(entry.root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {}); }
    })();
    return entry.gone;
  }

  /** A new server, registered at once so that concurrent reviews share it while it signs in. */
  function newServer(binary, account, key) {
    const entry = { key, active: 0, dead: false, protocolBreak: false, retired: false, stale: false, idleTimer: null, root: null, server: null, ready: null, gone: null, reviewModel: REVIEW_MODEL };
    servers.add(entry);
    entry.ready = (async () => {
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      entry.root = await fs.mkdtemp(path.join(stateDir, "review-"));
      await fs.mkdir(path.join(entry.root, "tmp"), { recursive: true, mode: 0o700 });
      if (entry.retired) throw new Error("The native reviewer pool is closed");
      entry.server = openReviewServer(binary, entry.root, env, new AbortController().signal, spawnProcess, (brokeProtocol) => {
        entry.dead = true;
        if (brokeProtocol) entry.protocolBreak = true;
        if (!entry.active) void retire(entry);
      });
      const opening = AbortSignal.timeout(workMs);
      await entry.server.request("initialize", { clientInfo: { name: "coding_tools_guardian", version: "1.0.0" }, capabilities: { experimentalApi: true } }, opening);
      entry.server.notify("initialized");
      await entry.server.request("account/login/start", { type: "chatgptAuthTokens", ...account }, opening);
      const identity = await entry.server.request("account/read", { refreshToken: false }, opening);
      if (identity?.account?.type !== "chatgpt") throw Object.assign(new Error("Codex did not confirm a direct ChatGPT sign-in."), { notChatgpt: true });
    })();
    entry.ready.catch(() => { entry.dead = true; });
    return entry;
  }

  /** The least busy server signed in with this account that has room, or a new one. */
  function take(binary, account) {
    const key = fingerprint(account);
    let best = null;
    for (const entry of servers) {
      if (entry.dead || entry.retired) continue;
      if (entry.key !== key) { entry.stale = true; if (!entry.active) void retire(entry); continue; }
      if (entry.active < perServer && (!best || entry.active < best.active)) best = entry;
    }
    const entry = best ?? newServer(binary, account, key);
    entry.active++;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    return entry;
  }
  function done(entry) {
    entry.active--;
    if (entry.retired) return entry.gone;
    if (entry.active) return undefined;
    if (entry.dead || entry.stale || closed || idleMs <= 0) return retire(entry);
    entry.idleTimer = setTimeout(() => { if (!entry.active) void retire(entry); }, idleMs);
    entry.idleTimer.unref?.();
    return undefined;
  }

  async function runReview(entry, action, task, signal, probeUsage) {
    await entry.ready;
    const server = entry.server;
    const thread = { cwd: entry.root, modelProvider: "openai", sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "auto_review", ephemeral: true };
    let started = null;
    if (entry.reviewModel) {
      try { started = await server.request("thread/start", { ...thread, model: entry.reviewModel }, signal); }
      catch (error) {
        // Only Codex refusing the model falls back, once per server; anything else fails the review.
        if (signal.aborted || entry.dead || !Number.isSafeInteger(error?.rpcCode)) throw error;
        entry.reviewModel = null;
      }
    }
    started ??= await server.request("thread/start", thread, signal);
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || !threadId || started?.modelProvider !== "openai") {
      throw Object.assign(new Error("Codex did not confirm an isolated thread on its direct provider."), { notIsolated: true });
    }
    const callId = randomUUID();
    await server.request("thread/inject_items", { threadId, items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: task.slice(0, 2000) }] },
      { type: "function_call", name: "exec_command", call_id: callId,
        arguments: JSON.stringify({ ...action, justification: "The originating harness requires a review of this proposed action before it can run it." }) },
    ] }, signal);
    const before = probeUsage ? usage(await server.request("account/rateLimits/read", {}, signal)) : null;
    const result = await server.request("thread/guardianReview", { threadId }, signal);
    const after = probeUsage ? usage(await server.request("account/rateLimits/read", {}, signal)) : null;
    return { result, callId, before, after };
  }

  async function reviewGuardian({ approval, folder, task, signal, probeUsage = false }) {
    if (!task || signal?.aborted) return pending("Native Guardian cannot review this request.");
    if (platform !== "win32") return unavailable("Native Guardian is not available on this platform.");
    const action = await exactShellAction(approval, folder);
    if (!action) return pending("Native Guardian needs a complete shell command and working directory from this harness.");
    const binary = executable();
    if (!path.isAbsolute(binary || "")) return unavailable("Install the stable Codex CLI in App Plugins to use native Guardian.");
    const queueLimit = AbortSignal.timeout(queueMs);
    if (!await acquireSlot(signal ? AbortSignal.any([signal, queueLimit]) : queueLimit)) {
      return signal?.aborted || closed ? pending("Native Guardian cannot review this request.")
        : unavailable("Native Guardian was busy and this request waited too long for a review. Check it yourself.", true);
    }
    try {
      for (let tries = 0; ; tries++) {
        const timeout = AbortSignal.timeout(workMs);
        const workSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const account = await prepareAccount();
        if (workSignal.aborted) {
          return !signal?.aborted && timeout.aborted
            ? unavailable("Native Codex Guardian is unavailable.", true)
            : pending("Native Guardian did not return a valid decision. Check this request yourself.");
        }
        if (!account) return unavailable("Native Guardian needs a current ChatGPT sign-in in the Codex CLI.");
        const accountKey = fingerprint(account);
        if ((usageLimitedUntil.get(accountKey) ?? 0) > now()) {
          return unavailable("Native Codex Guardian hit the ChatGPT usage limit for the Codex CLI sign-in.");
        }
        if (closed) return pending("Native Guardian cannot review this request.");
        const entry = take(binary, account);
        try {
          const { result, callId, before, after } = await runReview(entry, action, task, workSignal, probeUsage);
          const assessment = verdict(result, callId);
          if (!probeUsage) return assessment;
          const { outcome, riskLevel, userAuthorization } = result?.assessment || {};
          return { ...assessment, probeAssessment: { outcome, riskLevel, userAuthorization }, usage: { before, after } };
        } catch (error) {
          if (error?.notChatgpt) return pending("Codex did not confirm a direct ChatGPT sign-in.");
          if (error?.notIsolated) return pending("Codex did not confirm an isolated thread on its direct provider.");
          if (error?.usageLimit) {
            if (usageLimitCooldownMs > 0) usageLimitedUntil.set(accountKey, now() + usageLimitCooldownMs);
            return unavailable("Native Codex Guardian hit the ChatGPT usage limit for the Codex CLI sign-in.");
          }
          // Once more when the server failed under the review (its process ended, it broke the
          // protocol or it asked to run something: then on a fresh server) or Codex answered an
          // internal error (-32603: 2 of 300 reviews on 2026-11-23); never after the caller or the
          // time limit stopped it.
          if (tries === 0 && (entry.dead || error?.rpcCode === -32603) && !workSignal.aborted && !closed) continue;
          const timedOut = !signal?.aborted && !entry.protocolBreak && (timeout.aborted || error?.name === "TimeoutError" || error?.rpcCode === -32603 || entry.dead);
          const outcome = !signal?.aborted && !entry.protocolBreak && (timedOut || error?.rpcCode === -32601 || error?.code === "ENOENT")
            ? unavailable("Native Codex Guardian is unavailable.", timedOut)
            : pending("Native Guardian did not return a valid decision. Check this request yourself.");
          return probeUsage ? { ...outcome, diagnostics: { method: error?.rpcMethod ?? null, code: error?.rpcCode ?? null } } : outcome;
        } finally {
          await done(entry);
        }
      }
    } finally {
      releaseSlot();
    }
  }
  reviewGuardian.close = async () => {
    closed = true;
    for (const entry of waiting.splice(0)) entry.leave();
    await Promise.all([...servers].map(retire));
  };
  return reviewGuardian;
}

module.exports = { createGuardianReview };

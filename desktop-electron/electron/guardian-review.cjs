"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const MAX_AUTH_BYTES = 128 * 1024;
const MAX_RPC_BYTES = 1024 * 1024;
const WORK_LIMIT_MS = 40_000;
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
  return { ...kept, CODEX_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
}

function openReviewServer(executable, root, env, signal, spawnProcess) {
  if (signal.aborted) throw signal.reason;
  const child = spawnProcess(executable, ["app-server", "--stdio", "-c", "features.codex_hooks=false", "-c", "features.plugins=false"], {
    cwd: root, env: serverEnvironment(root, env), windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const decoder = new StringDecoder("utf8");
  let buffer = "", next = 1, stopped = false;
  const pending = new Map();
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
  };
  child.once("close", () => { stop(); onClosed(); });
  child.once("error", () => { stop(); onClosed(); });
  child.stdin.on("error", stop);
  child.stdout.on("error", stop);
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk) => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_RPC_BYTES) { stop(); return; }
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { stop(); return; }
      if (!message || typeof message !== "object") { stop(); return; }
      if (typeof message.method === "string") {
        // The isolated reviewer never receives consent to execute a tool, answer an approval, or refresh the source login.
        if (message.id !== undefined) { stop(); return; }
        continue;
      }
      const reply = pending.get(message.id);
      if (!reply) { stop(); return; }
      pending.delete(message.id);
      if (message.error || !Object.hasOwn(message, "result")) {
        const error = new Error("Codex refused the review-only request");
        if (Number.isSafeInteger(message.error?.code)) error.rpcCode = message.error.code;
        error.rpcMethod = reply.method;
        reply.reject(error);
      } else reply.resolve(message.result);
    }
  });
  function send(message) {
    if (stopped || signal.aborted) throw new Error("The isolated Codex reviewer is closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject, method });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
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

function usage(result) {
  const limits = result?.rateLimits;
  const percent = (window) => Number.isFinite(window?.usedPercent) ? window.usedPercent : null;
  return { primary: percent(limits?.primary), secondary: percent(limits?.secondary) };
}

function verdict(result, callId) {
  const assessment = result?.assessment;
  if (result?.callId !== callId || !assessment) return pending("Guardian gave no verdict for this exact action. Check it yourself.");
  const reason = String(assessment.rationale || "Native Codex Guardian verdict").slice(0, 300);
  if (assessment.outcome === "deny") return { action: "deny", reason, actor: "guardian", reason_code: "native_guardian" };
  if (assessment.outcome === "allow" && assessment.riskLevel === "low" && assessment.userAuthorization === "high") {
    return { action: "allow", reason, actor: "guardian", reason_code: "native_guardian" };
  }
  return pending("Guardian did not confirm low risk and clear user authorization. Check this request yourself.");
}

function createGuardianReview({ stateDir, authFile, executable, env = process.env, spawnProcess = spawn,
  prepareAccount = () => readNativeAccount(authFile), platform = process.platform }) {
  if (!path.isAbsolute(stateDir || "")) throw new Error("Native Guardian needs an absolute app data path");
  let reviewing = false;
  return async function reviewGuardian({ approval, folder, task, signal, probeUsage = false }) {
    if (platform !== "win32" || !task || signal?.aborted) return pending("Native Guardian cannot review this request.");
    const action = await exactShellAction(approval, folder);
    if (!action) return pending("Native Guardian needs a complete shell command and working directory from this harness.");
    const binary = executable();
    if (!path.isAbsolute(binary || "")) return pending("Install the stable Codex CLI in App Plugins to use native Guardian.");
    if (reviewing) return pending("Native Guardian is reviewing another request. Check this one yourself.");
    reviewing = true;
    let root, server;
    try {
      const account = await prepareAccount();
      if (!account) return pending("Native Guardian needs a current ChatGPT sign-in in the Codex CLI.");
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      root = await fs.mkdtemp(path.join(stateDir, "review-"));
      const timeout = AbortSignal.timeout(WORK_LIMIT_MS);
      server = openReviewServer(binary, root, env, signal ? AbortSignal.any([signal, timeout]) : timeout, spawnProcess);
      await server.request("initialize", { clientInfo: { name: "coding_tools_guardian", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      server.notify("initialized");
      await server.request("account/login/start", { type: "chatgptAuthTokens", ...account });
      const identity = await server.request("account/read", { refreshToken: false });
      if (identity?.account?.type !== "chatgpt") return pending("Codex did not confirm a direct ChatGPT sign-in.");
      const started = await server.request("thread/start", { cwd: root, modelProvider: "openai", sandbox: "read-only",
        approvalPolicy: "on-request", approvalsReviewer: "auto_review", ephemeral: true });
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string" || !threadId || started?.modelProvider !== "openai") {
        return pending("Codex did not confirm an isolated thread on its direct provider.");
      }
      const callId = randomUUID();
      await server.request("thread/inject_items", { threadId, items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: task.slice(0, 2000) }] },
        { type: "function_call", name: "exec_command", call_id: callId,
          arguments: JSON.stringify({ ...action, justification: "The originating harness requires a review of this proposed action before it can run it." }) },
      ] });
      const before = probeUsage ? usage(await server.request("account/rateLimits/read")) : null;
      const result = await server.request("thread/guardianReview", { threadId });
      const assessment = verdict(result, callId);
      if (!probeUsage) return assessment;
      const { outcome, riskLevel, userAuthorization } = result?.assessment || {};
      return { ...assessment, probeAssessment: { outcome, riskLevel, userAuthorization }, usage: { before, after: usage(await server.request("account/rateLimits/read")) } };
    } catch (error) {
      const unavailable = pending("Native Codex Guardian did not answer. Check this request yourself; it was not sent to CPA.");
      return probeUsage ? { ...unavailable, diagnostics: { method: error?.rpcMethod ?? null, code: error?.rpcCode ?? null } } : unavailable;
    } finally {
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      reviewing = false;
    }
  };
}

module.exports = { createGuardianReview };

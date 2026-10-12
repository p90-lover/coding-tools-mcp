"use strict";

// The app's own tools for chat agents. Every AO chat session (Claude Code, Codex, opencode) gets
// one MCP server, "coding-tools", reached through the local headless service the app always runs,
// under the workspace's own tool profile and approval policy.
//
// Each session has its own server path and credential (/mcp/<workspaceId>/<key>, a bearer token
// minted at spawn and sent to AO only in the spawn request's headers; never logged), and its tools
// are rooted at that session's own git worktree, the isolation that keeps its changes reviewable
// and discardable in the chat's diff and approval card:
// - The root is learned from AO once the session exists: the spawn binds the credential to its
//   AO session, and the first call asks AO for the session's worktree (re-checked every
//   ROOT_RECHECK_MS). Until AO has made it, calls are refused ("not ready yet"); once the
//   session has ended, its credential is forgotten (also on kill, after a sweep, or unused).
// - Headless runs each call in a context rooted at that worktree (the `root` of
//   /api/v1/tools/call), so paths, the command directory, terminal sessions, approvals and plans
//   all belong to it. This endpoint is the outer guard: every path argument and patch target must
//   resolve inside the worktree (after `..`, drive letters, UNC and device paths, and symlinks or
//   junctions via realpath), and exec_command always starts in it.
// - Not a sandbox: a shell command can still `cd` anywhere the user can, exactly as the agent's
//   own built-in shell can. What stays in the worktree are the defaults and the file tools.
//
// Tool groups, both under Settings: "agent" (files, search, patches, git, terminal, images, plan;
// on by default) and "desktop" (screen capture and computer control; off unless the user opts
// in). Anything else (the default cwd, the native Codex bridge, ChatGPT history, the operation
// store, the task board, sandbox and harness tools) is never offered. A tool outside the enabled
// groups is absent from tools/list and refused on tools/call; turning a group off also refuses it
// in sessions already running. Desktop tools run in the workspace's own context: computer_*
// control needs the user to enable it in the app (its existing local lease, bound to the
// workspace), and a screen or window observation is confirmed by the user in the app every time.
//
// Transport: MCP Streamable HTTP (JSON responses, no SSE stream) on 127.0.0.1 at an ephemeral port.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const SERVER_NAME = "coding-tools";
const PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_BODY_BYTES = 1024 * 1024;
const TOOL_CALL_TIMEOUT_MS = 120_000;
// Agents whose AO chat driver takes an HTTP MCP server: Claude Code and opencode over ACP,
// Codex through app-server's mcp_servers config. Other ACP agents may lack the HTTP
// capability, which would fail the whole session, so they launch without these tools.
const MCP_HTTP_AGENTS = new Set(["claude-code", "codex", "opencode"]);
const WORKSPACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_TOOLS = new Set(["view_image", "capture_screenshot", "capture_window"]);

// Default on: everything stays inside the session's worktree.
const AGENT_TOOLS = new Set([
  "read_file", "list_dir", "list_files", "search_text", "grep_text",
  "apply_patch", "patch_check",
  "git_status", "git_diff", "git_log", "git_show", "git_blame",
  "exec_command", "write_stdin", "read_output", "kill_command", "kill_session",
  "view_image", "image_info", "compare_images",
  "update_plan", "get_plan", "get_current_time", "tool_search", "server_info", "request_permissions",
  "check_exec_environment",
]);
// Opt-in: these see the screen and drive the mouse and keyboard, outside any worktree.
const DESKTOP_TOOLS = new Set([
  "computer_status", "computer_route", "computer_snapshot", "computer_list_windows", "computer_select_window",
  "computer_find_control", "computer_wait", "computer_action", "computer_sequence", "computer_stop",
  "capture_screenshot", "capture_window", "list_windows", "list_displays", "vision_status",
]);
// Desktop tools that observe the screen with no consent of their own (computer_* control has the
// user's local lease): the user confirms each call in the app.
const CONFIRMED_TOOLS = new Map([
  ["capture_screenshot", "take a screenshot of your screen"],
  ["capture_window", "capture a window on your screen"],
  ["list_windows", "list the windows open on your desktop"],
  ["list_displays", "list your displays"],
  ["computer_list_windows", "list the windows open on your desktop"],
]);
const GROUPS = Object.freeze(["agent", "desktop"]);
const groupOf = (name) => (AGENT_TOOLS.has(name) ? "agent" : DESKTOP_TOOLS.has(name) ? "desktop" : null);

// Path arguments per tool, taken from the tool schemas (registry_definitions.rs) and the headless
// dispatch's own default-cwd rewriting (dispatch.rs apply_default_cwd).
const PATH_ARGUMENTS = Object.freeze({
  read_file: ["path"], list_dir: ["path"], list_files: ["path"], search_text: ["path"], grep_text: ["path"],
  git_status: ["path"], git_diff: ["path"], git_log: ["path"], git_show: ["path"], git_blame: ["path"],
  view_image: ["path"], image_info: ["path"], compare_images: ["before_path", "after_path"],
  exec_command: ["workdir", "cwd"],
});
const PATH_LIST_ARGUMENTS = Object.freeze({ git_diff: ["paths"], git_show: ["paths"] });
const PATCH_TOOLS = new Set(["apply_patch", "patch_check"]);

const ROOT_RECHECK_MS = 30_000;
const UNBOUND_TTL_MS = 10 * 60_000;
const SWEEP_MS = 10 * 60_000;
const MAX_SESSIONS = 512;

class ScopeError extends Error {}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}

/** The MCP CallToolResult for a workspace tool's structured result, as the workspace listener shapes it. */
function toolResult(name, args, structured) {
  const value = structured && typeof structured === "object" && !Array.isArray(structured)
    ? { ...structured } : { value: structured ?? null };
  const isError = value.ok === false;
  const wantsImage = name.startsWith("computer_")
    ? typeof value.base64 === "string"
    : IMAGE_TOOLS.has(name) && !isError && (args?.output ?? "mcp_image") === "mcp_image";
  if (wantsImage && typeof value.base64 === "string" && value.base64 && IMAGE_TYPES.has(value.mime_type)) {
    const data = value.base64;
    delete value.base64;
    delete value.data_url;
    return {
      content: [{ type: "image", data, mimeType: value.mime_type }, { type: "text", text: JSON.stringify(value) }],
      structuredContent: value, isError,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}

function failedCall(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The real location of a path that may not exist yet: its deepest existing ancestor, resolved. */
function realLocation(target) {
  const rest = [];
  let cursor = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...[...rest].reverse());
    } catch (error) {
      let dangling = false;
      try { fs.lstatSync(cursor); dangling = true; } catch { /* the entry does not exist */ }
      // A link whose target is missing could point anywhere once it appears.
      if (dangling) throw new ScopeError("a link inside it points to a missing target");
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw new ScopeError("it cannot be resolved");
      const parent = path.dirname(cursor);
      if (parent === cursor) return target;
      rest.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

// \\?\C:\..., \\.\pipe\...: verbatim and device paths skip normalization; never accepted.
const DEVICE_PATH = /^[\\/]{2}[?.](?:[\\/]|$)/;
// C:foo is relative to that drive's current directory, not to the worktree.
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

/**
 * A path argument, scoped to the session's worktree: relative to its root, refused if it resolves
 * anywhere else, and forwarded relative (headless resolves it against the same root).
 */
function scopePath(root, raw, label) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) throw new ScopeError(`${label} must be a non-empty path`);
  const outside = (why = "it is outside this chat's worktree") => new ScopeError(`${label} "${raw.slice(0, 200)}" is refused: ${why}`);
  if (raw.startsWith("@")) throw outside("linked projects (@alias) are outside this chat's worktree");
  if (DEVICE_PATH.test(raw) || DRIVE_RELATIVE.test(raw)) throw outside();
  const candidate = path.resolve(root.path, raw);
  if (!inside(root.path, candidate)) throw outside();
  let real;
  try { real = realLocation(candidate); } catch (error) { throw outside(error instanceof ScopeError ? error.message : undefined); }
  if (!inside(root.real, real)) throw outside("it leads outside this chat's worktree through a link");
  return path.relative(root.path, candidate).split(path.sep).join("/") || ".";
}

/** Every file a patch names, in the formats headless applies (patch.rs): Codex envelopes or unified diffs. */
function patchTargets(text) {
  const lines = String(text).split(/\r?\n/);
  const strip = (raw) => {
    const value = raw.trim();
    const target = value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
    return target === "/dev/null" ? "" : target;
  };
  const targets = [];
  if (lines.some((line) => line.trimEnd() === "*** Begin Patch")) {
    for (const line of lines) {
      const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/.exec(line.trimEnd());
      if (match) targets.push(strip(match[1]));
    }
  } else {
    // A header is `--- ` directly followed by `+++ `; any other `+++ ` line is checked too, so a
    // target is never missed (a hunk adding a line that starts with "++ " is checked needlessly).
    lines.forEach((line, index) => {
      if (line.startsWith("+++ ")) targets.push(strip(line.slice(4)));
      else if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) targets.push(strip(line.slice(4)));
    });
  }
  return targets.filter(Boolean);
}

/** The call's arguments with every path scoped to the worktree; throws ScopeError on any escape. */
function scopeArguments(name, args, root) {
  const scoped = { ...args };
  if (Object.hasOwn(scoped, "project_root")) scoped.project_root = scopePath(root, scoped.project_root, "project_root");
  for (const key of PATH_ARGUMENTS[name] ?? []) {
    if (scoped[key] !== undefined && scoped[key] !== null) scoped[key] = scopePath(root, scoped[key], key);
  }
  for (const key of PATH_LIST_ARGUMENTS[name] ?? []) {
    if (scoped[key] === undefined || scoped[key] === null) continue;
    if (!Array.isArray(scoped[key])) throw new ScopeError(`${key} must be a list of paths`);
    scoped[key] = scoped[key].map((value) => scopePath(root, value, key));
  }
  if (PATCH_TOOLS.has(name) && typeof scoped.patch === "string") {
    for (const target of patchTargets(scoped.patch)) scopePath(root, target, "patch target");
  }
  // Commands start in the worktree unless they name a directory inside it.
  if (name === "exec_command" && scoped.workdir === undefined && scoped.cwd === undefined) scoped.workdir = ".";
  return scoped;
}

function instructionsFor(groups) {
  return "Coding Tools tools for this chat's own git worktree: read_file, list_dir, search_text and apply_patch "
    + "for files; exec_command, write_stdin, read_output and kill_command for terminal sessions; git_* for history. "
    + "Paths are relative to the worktree root and paths outside it are refused; commands start in it. "
    + (groups.includes("desktop")
      ? "capture_screenshot, list_windows and computer_* see and drive the desktop: the user confirms each screen "
        + "capture, and computer control works only while the user has enabled it in the app. "
      : "")
    + "Large results are paged; ask for less per call.";
}

function createChatAgentTools({
  requestHeadless, sessionWorkspace = null, confirm = null,
  enabled = () => true, desktopEnabled = () => false,
  logger = console, version = "1", now = Date.now,
} = {}) {
  if (typeof requestHeadless !== "function") throw new Error("The headless tool service is required");
  // Identifies this server's lifetime in warm-session keys without exposing any credential.
  const instance = crypto.randomUUID();
  const sessions = new Map(); // key -> session entry (see mint)
  let server = null;
  let listening = null;
  let port = 0;
  let sweeper = null;

  const setting = (read) => {
    try { return read() === true; } catch { return false; }
  };
  const isEnabled = () => {
    try { return enabled() !== false; } catch { return false; }
  };
  /** The groups a new session gets now: agent tools when the setting is on, plus desktop when opted in. */
  const currentGroups = () => (isEnabled() ? GROUPS.filter((group) => group === "agent" || setting(desktopEnabled)) : []);
  // A group is usable only if the session got it and the setting still allows it.
  const allowed = (entry, group) => entry.groups.includes(group) && currentGroups().includes(group);

  function forget(key) {
    const entry = sessions.get(key);
    if (!entry) return;
    sessions.delete(key);
    entry.expected = null;
  }

  function mint({ agent, workspaceId }) {
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((left, right) => left.usedAt - right.usedAt)[0];
      forget(oldest.key);
    }
    const key = crypto.randomBytes(18).toString("base64url");
    const token = crypto.randomBytes(32).toString("base64url");
    const entry = {
      key, agent, workspaceId, groups: currentGroups(), expected: Buffer.from(`Bearer ${token}`),
      aoSession: null, root: null, checkedAt: 0, createdAt: now(), usedAt: now(),
    };
    sessions.set(key, entry);
    return { entry, token };
  }

  function authorized(request, entry) {
    const given = Buffer.from(String(request.headers.authorization || ""));
    const expected = entry?.expected ?? Buffer.from(`Bearer ${crypto.randomBytes(32).toString("base64url")}`);
    const match = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    return match && Boolean(entry?.expected);
  }

  /** The session's worktree, as AO reports it; throws a message for the agent when it is not usable. */
  async function rootOf(entry) {
    if (!entry.aoSession) throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    if (entry.root && now() - entry.checkedAt < ROOT_RECHECK_MS) return entry.root;
    if (typeof sessionWorkspace !== "function") throw new ScopeError("This chat's session workspace is unavailable.");
    let found;
    try {
      found = await sessionWorkspace(entry.aoSession);
    } catch (error) {
      // AO did not answer; a worktree it reported before is still this session's.
      if (entry.root) return entry.root;
      logger.warn?.("chat_agent_tools.workspace_unavailable", { message: errorMessage(error) });
      throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    }
    if (found?.ended) {
      forget(entry.key);
      throw new ScopeError("This chat's session has ended; its tools are no longer available.");
    }
    const reported = typeof found?.root === "string" && path.isAbsolute(found.root) ? path.resolve(found.root) : null;
    if (!reported) throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    let real;
    try {
      if (!fs.statSync(reported).isDirectory()) throw new Error("not a directory");
      real = fs.realpathSync.native(reported);
    } catch {
      throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    }
    if (entry.root && path.relative(entry.root.path, reported) !== "") {
      // A session never moves to another tree; refuse rather than follow it.
      forget(entry.key);
      throw new ScopeError("This chat's session workspace changed; its tools are no longer available.");
    }
    entry.root = { path: reported, real };
    entry.checkedAt = now();
    return entry.root;
  }

  async function listTools(entry) {
    const catalog = await requestHeadless(`/api/v1/tools/catalog?workspace_id=${encodeURIComponent(entry.workspaceId)}`, null, { method: "GET" });
    return (Array.isArray(catalog?.tools) ? catalog.tools : [])
      .filter((tool) => typeof tool?.name === "string" && groupOf(tool.name) && allowed(entry, groupOf(tool.name)))
      // outputSchema is left out: clients would validate structuredContent against it, and the
      // agent gains nothing from it.
      .map(({ name, title, description, inputSchema, annotations }) => ({
        name, ...(title ? { title } : {}), ...(description ? { description } : {}),
        inputSchema: inputSchema && typeof inputSchema === "object" ? inputSchema : { type: "object" },
        ...(annotations ? { annotations } : {}),
      }));
  }

  async function callTool(entry, params) {
    const name = params?.name;
    if (typeof name !== "string" || !name || name.length > 128) return failedCall("A tool name is required");
    if (!isEnabled()) return failedCall("The app's tools for chat agents are turned off in Settings.");
    const group = groupOf(name);
    if (!group || !allowed(entry, group)) return failedCall(`Unknown tool: ${name}`);
    let args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    let root;
    try {
      root = await rootOf(entry);
      if (group === "agent") args = scopeArguments(name, args, root);
    } catch (error) {
      if (error instanceof ScopeError) return failedCall(error.message);
      throw error;
    }
    if (CONFIRMED_TOOLS.has(name)) {
      let approved = false;
      try {
        approved = typeof confirm === "function" && await confirm({
          message: `A chat agent wants to ${CONFIRMED_TOOLS.get(name)}`,
          detail: `Agent: ${entry.agent}\nTool: ${name}\nAO session: ${entry.aoSession}\n\nAllow this once?`,
        }) === true;
      } catch (error) {
        return failedCall(`The user could not be asked: ${errorMessage(error)}`);
      }
      if (!approved) return failedCall(`The user declined ${name}.`);
    }
    let response;
    try {
      response = await requestHeadless("/api/v1/tools/call", {
        request_id: crypto.randomUUID(), workspace_id: entry.workspaceId, tool: name, arguments: args,
        // Desktop tools act on the screen, not on files, and computer control is leased to the
        // workspace itself; everything else runs in the session's worktree.
        ...(group === "agent" ? { root: root.path } : {}),
      }, { timeout: TOOL_CALL_TIMEOUT_MS });
    } catch (error) {
      return failedCall(errorMessage(error));
    }
    const operation = response?.operation;
    if (operation?.state !== "completed") {
      return failedCall(typeof operation?.error === "string" && operation.error
        ? operation.error.slice(0, 2000) : "The tool call did not complete; its outcome is unknown.");
    }
    return toolResult(name, args, operation.result);
  }

  async function dispatch(entry, message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id ?? null, -32600, "Invalid request");
    }
    const notification = !Object.hasOwn(message, "id");
    if (notification) return null;
    const { id, method, params } = message;
    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          return { jsonrpc: "2.0", id, result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: "Coding Tools", version: String(version) },
            instructions: instructionsFor(entry.groups.filter((group) => allowed(entry, group))),
          } };
        }
        case "ping": return { jsonrpc: "2.0", id, result: {} };
        case "tools/list": return { jsonrpc: "2.0", id, result: { tools: await listTools(entry) } };
        case "tools/call": return { jsonrpc: "2.0", id, result: await callTool(entry, params) };
        default: return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return rpcError(id, -32603, errorMessage(error));
    }
  }

  function send(response, status, body, headers = {}) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, {
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      "cache-control": "no-store", ...headers,
    });
    response.end(payload);
  }

  function handle(request, response) {
    const host = String(request.headers.host || "");
    const match = /^\/mcp\/([^/?#]+)\/([^/?#]+)$/.exec(String(request.url || "").split("?")[0]);
    let workspaceId = null;
    try { workspaceId = match ? decodeURIComponent(match[1]) : null; } catch { workspaceId = null; }
    const key = match?.[2] ?? "";
    // Loopback clients only: a browser page (Origin) or a rebinding host name is refused.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || request.headers.origin) {
      send(response, 403, rpcError(null, -32000, "Forbidden"));
      return;
    }
    if (!workspaceId || !WORKSPACE_ID.test(workspaceId) || !SESSION_KEY.test(key)) {
      send(response, 404, rpcError(null, -32000, "Unknown session path"));
      return;
    }
    // A credential opens only its own session's path, and only in the workspace it was minted for.
    const entry = sessions.get(key);
    if (!authorized(request, entry) || entry.workspaceId !== workspaceId) {
      send(response, 401, rpcError(null, -32001, "Unauthorized"), { "www-authenticate": "Bearer" });
      return;
    }
    entry.usedAt = now();
    if (request.method !== "POST") {
      // No server-initiated stream and no session to delete.
      send(response, 405, undefined, { allow: "POST" });
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      if (size > MAX_BODY_BYTES) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        response.once("finish", () => request.destroy());
        send(response, 413, rpcError(null, -32600, "Request too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", async () => {
      if (size > MAX_BODY_BYTES) return;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(response, 400, rpcError(null, -32700, "Parse error")); return; }
      const batch = Array.isArray(parsed);
      const messages = batch ? parsed : [parsed];
      if (!messages.length || messages.length > 32) { send(response, 400, rpcError(null, -32600, "Invalid request")); return; }
      const answers = (await Promise.all(messages.map((message) => dispatch(entry, message)))).filter(Boolean);
      if (!answers.length) send(response, 202, undefined);
      else send(response, 200, batch ? answers : answers[0]);
    });
  }

  /** Forgets credentials never bound to a session, and those whose session AO reports ended. */
  async function sweep() {
    for (const entry of [...sessions.values()]) {
      if (!entry.aoSession) {
        if (now() - entry.createdAt >= UNBOUND_TTL_MS) forget(entry.key);
        continue;
      }
      if (typeof sessionWorkspace !== "function") continue;
      const found = await Promise.resolve().then(() => sessionWorkspace(entry.aoSession)).catch(() => null);
      if (found?.ended) forget(entry.key);
    }
  }

  function listen() {
    listening ??= new Promise((resolve, reject) => {
      const created = http.createServer(handle);
      created.on("error", (error) => {
        if (listening && !port) { listening = null; reject(error); }
        else logger.warn?.("chat_agent_tools.server_error", { message: errorMessage(error) });
      });
      created.listen(0, "127.0.0.1", () => {
        server = created;
        port = created.address().port;
        created.unref();
        sweeper ??= setInterval(() => { void sweep().catch(() => undefined); }, SWEEP_MS);
        sweeper.unref?.();
        logger.info?.("chat_agent_tools.listening", { port });
        resolve(port);
      });
    });
    return listening;
  }

  return Object.freeze({
    /**
     * Tools for one AO chat session about to be spawned, or null when the setting is off, the
     * agent's driver cannot take an HTTP server, or the workspace id is unusable. `servers` go into
     * the spawn's mcpServers; `bind(sessionId)` ties the credential to the session AO created (its
     * worktree becomes the root), and `release()` forgets it when the spawn failed.
     */
    async lease({ agent, workspaceId } = {}) {
      if (!isEnabled() || !MCP_HTTP_AGENTS.has(agent) || typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return null;
      await listen();
      const { entry, token } = mint({ agent, workspaceId });
      const url = `http://127.0.0.1:${port}/mcp/${encodeURIComponent(workspaceId)}/${entry.key}`;
      return Object.freeze({
        servers: [{ name: SERVER_NAME, type: "http", url, headers: { Authorization: `Bearer ${token}` } }],
        bind(sessionId) {
          if (sessions.get(entry.key) !== entry) return false;
          if (typeof sessionId !== "string" || !sessionId || (entry.aoSession && entry.aoSession !== sessionId)) {
            forget(entry.key);
            return false;
          }
          // One credential per session: an older one for the same session is retired.
          for (const other of [...sessions.values()]) if (other !== entry && other.aoSession === sessionId) forget(other.key);
          entry.aoSession = sessionId;
          return true;
        },
        release() { forget(entry.key); },
      });
    },
    /** Forgets the credential of an AO session that has ended (it was killed or deleted). */
    forgetSession(sessionId) {
      for (const entry of [...sessions.values()]) if (entry.aoSession === sessionId) forget(entry.key);
    },
    /**
     * What a launch would attach now: the tool groups and this server's lifetime, never a
     * credential or anything per session. "pending" until the server listens.
     */
    identity() {
      const groups = currentGroups();
      if (!groups.length) return "off";
      return port ? `on|${groups.join("+")}|${instance}` : "pending";
    },
    listen,
    sweep,
    async close() {
      const current = server;
      server = null; listening = null; port = 0;
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      for (const key of [...sessions.keys()]) forget(key);
      if (current) await new Promise((resolve) => current.close(() => resolve()));
    },
  });
}

module.exports = Object.freeze({
  AGENT_TOOLS,
  DESKTOP_TOOLS,
  MCP_HTTP_AGENTS,
  SERVER_NAME,
  createChatAgentTools,
  patchTargets,
  scopePath,
  toolResult,
});

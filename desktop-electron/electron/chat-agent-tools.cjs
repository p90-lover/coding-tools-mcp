"use strict";

// The app's own tools for chat agents. An AO chat session (Claude Code, Codex, opencode) gets
// one MCP server, "coding-tools", that serves the session's Coding Tools workspace: files,
// search, patches, terminal sessions, git, screenshots and computer control. It is the same
// tool set and policy as the workspace's MCP listener, reached through the local headless
// service that the app always runs, so nothing has to be started or configured first.
//
// Transport: MCP Streamable HTTP (JSON responses, no SSE stream) on 127.0.0.1 at an ephemeral
// port, one path per workspace (/mcp/<workspaceId>). Each app run mints its own bearer token;
// it travels to AO only in the spawn request's headers and is never logged.

const crypto = require("node:crypto");
const http = require("node:http");

const SERVER_NAME = "coding-tools";
const PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_BODY_BYTES = 1024 * 1024;
const TOOL_CALL_TIMEOUT_MS = 120_000;
// Agents whose AO chat driver takes an HTTP MCP server: Claude Code and opencode over ACP,
// Codex through app-server's mcp_servers config. Other ACP agents may lack the HTTP
// capability, which would fail the whole session, so they launch without these tools.
const MCP_HTTP_AGENTS = new Set(["claude-code", "codex", "opencode"]);
// Tools that drive the app's own surfaces rather than a workspace: the native Codex bridge,
// ChatGPT session history, the listener's operation store, and the task board itself.
const HIDDEN_TOOL = /^(?:codex_|history_session_|workflow_)|^mcp_operation_status$/;
const WORKSPACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_TOOLS = new Set(["view_image", "capture_screenshot", "capture_window"]);
const INSTRUCTIONS = "Coding Tools workspace tools: read_file, list_dir, search_text and apply_patch for files; "
  + "exec_command, write_stdin, read_output and kill_command for terminal sessions; git_* for history; "
  + "capture_screenshot, list_windows and computer_* to see and drive the desktop. "
  + "Relative paths resolve against the workspace root. Large results are paged; ask for less per call.";

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

function createChatAgentTools({ requestHeadless, enabled = () => true, logger = console, version = "1" } = {}) {
  if (typeof requestHeadless !== "function") throw new Error("The headless tool service is required");
  const token = crypto.randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  // Identifies this server's lifetime in warm-session keys without exposing the token.
  const instance = crypto.randomUUID();
  let server = null;
  let listening = null;
  let port = 0;

  const isEnabled = () => {
    try { return enabled() !== false; } catch { return false; }
  };
  const urlFor = (workspaceId) => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(workspaceId)}`;

  function authorized(request) {
    const given = Buffer.from(String(request.headers.authorization || ""));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function listTools(workspaceId) {
    const catalog = await requestHeadless(`/api/v1/tools/catalog?workspace_id=${encodeURIComponent(workspaceId)}`, null, { method: "GET" });
    return (Array.isArray(catalog?.tools) ? catalog.tools : [])
      .filter((tool) => typeof tool?.name === "string" && !HIDDEN_TOOL.test(tool.name))
      // outputSchema is left out: clients would validate structuredContent against it, and the
      // agent gains nothing from it.
      .map(({ name, title, description, inputSchema, annotations }) => ({
        name, ...(title ? { title } : {}), ...(description ? { description } : {}),
        inputSchema: inputSchema && typeof inputSchema === "object" ? inputSchema : { type: "object" },
        ...(annotations ? { annotations } : {}),
      }));
  }

  async function callTool(workspaceId, params) {
    const name = params?.name;
    if (typeof name !== "string" || !name || name.length > 128) return failedCall("A tool name is required");
    if (HIDDEN_TOOL.test(name)) return failedCall(`Unknown tool: ${name}`);
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    let response;
    try {
      response = await requestHeadless("/api/v1/tools/call", {
        request_id: crypto.randomUUID(), workspace_id: workspaceId, tool: name, arguments: args,
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

  async function dispatch(workspaceId, message) {
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
            instructions: INSTRUCTIONS,
          } };
        }
        case "ping": return { jsonrpc: "2.0", id, result: {} };
        case "tools/list": return { jsonrpc: "2.0", id, result: { tools: await listTools(workspaceId) } };
        case "tools/call": return { jsonrpc: "2.0", id, result: await callTool(workspaceId, params) };
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
    const match = /^\/mcp\/([^/?#]+)$/.exec(String(request.url || "").split("?")[0]);
    let workspaceId = null;
    try { workspaceId = match ? decodeURIComponent(match[1]) : null; } catch { workspaceId = null; }
    // Loopback clients only: a browser page (Origin) or a rebinding host name is refused.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || request.headers.origin) {
      send(response, 403, rpcError(null, -32000, "Forbidden"));
      return;
    }
    if (!authorized(request)) {
      send(response, 401, rpcError(null, -32001, "Unauthorized"), { "www-authenticate": "Bearer" });
      return;
    }
    if (!workspaceId || !WORKSPACE_ID.test(workspaceId)) {
      send(response, 404, rpcError(null, -32000, "Unknown workspace path"));
      return;
    }
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
      const answers = (await Promise.all(messages.map((message) => dispatch(workspaceId, message)))).filter(Boolean);
      if (!answers.length) send(response, 202, undefined);
      else send(response, 200, batch ? answers : answers[0]);
    });
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
        logger.info?.("chat_agent_tools.listening", { port });
        resolve(port);
      });
    });
    return listening;
  }

  return Object.freeze({
    /**
     * The MCP servers to give an AO chat session, or [] when the setting is off, the agent's
     * driver cannot take an HTTP server, or the workspace id is unusable.
     */
    async servers({ agent, workspaceId } = {}) {
      if (!isEnabled() || !MCP_HTTP_AGENTS.has(agent) || typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return [];
      await listen();
      return [{ name: SERVER_NAME, type: "http", url: urlFor(workspaceId), headers: { Authorization: `Bearer ${token}` } }];
    },
    /** What a launch for this workspace would attach (setting, URL and server lifetime); never the token. */
    identity(workspaceId) {
      if (!isEnabled()) return "off";
      return port && typeof workspaceId === "string" ? `on|${urlFor(workspaceId)}|${instance}` : "on|pending";
    },
    listen,
    async close() {
      const current = server;
      server = null; listening = null; port = 0;
      if (current) await new Promise((resolve) => current.close(() => resolve()));
    },
  });
}

module.exports = Object.freeze({
  MCP_HTTP_AGENTS,
  SERVER_NAME,
  createChatAgentTools,
  toolResult,
});

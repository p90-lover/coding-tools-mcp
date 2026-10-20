"use strict";

// The app's chat tools for an agent whose ACP driver takes only stdio MCP servers (every ACP agent
// must; HTTP is an optional capability, which only Claude Code, Codex and opencode are known to
// have). The agent runs this script as its "coding-tools" server; it relays each JSON-RPC message
// it reads on stdin, one per line, to the session's own path on the app's tools server
// (chat-agent-tools.cjs) and writes each answer back as one line. The server does all the
// checking: this holds no state but the session's address and credential, given in its
// environment by the app at spawn (CODING_TOOLS_MCP_URL, CODING_TOOLS_MCP_TOKEN).
//
// Run with the app's own executable as Node (ELECTRON_RUN_AS_NODE=1): nothing else is installed.

const http = require("node:http");
const readline = require("node:readline");

const REQUEST_TIMEOUT_MS = 15 * 60_000;
const MAX_LINE_BYTES = 1024 * 1024;

const address = process.env.CODING_TOOLS_MCP_URL || "";
const token = process.env.CODING_TOOLS_MCP_TOKEN || "";
// The agent's own commands never see the credential (they inherit this process's environment only
// if it starts them, which it does not, but its copy is dropped all the same).
delete process.env.CODING_TOOLS_MCP_TOKEN;

let target = null;
try { target = new URL(address); } catch { target = null; }
const loopback = target && target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname);

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const error = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One POST to the session's path: the parsed answer, null for none (202), or a thrown error. */
function post(body) {
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: "POST", timeout: REQUEST_TIMEOUT_MS,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode === 202 || !text) return resolve(null);
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`The app's tools answered HTTP ${response.statusCode}`)); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("The app's tools did not answer in time")));
    request.on("error", reject);
    request.end(body);
  });
}

// Calls are relayed in the order they came, one at a time, as the server answers them anyway (a
// confirmation the user is asked for holds the ones after it).
let queue = Promise.resolve();
function relay(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { write(error(null, -32700, "Parse error")); return; }
  const id = Array.isArray(message) ? null : message?.id;
  queue = queue.then(async () => {
    if (!loopback || !token) {
      if (id !== undefined) write(error(id, -32000, "The app's tools are not configured for this agent"));
      return;
    }
    try {
      const answer = await post(JSON.stringify(message));
      if (answer) write(answer);
    } catch (cause) {
      // A notification has no answer to carry the failure.
      if (id !== undefined) write(error(id, -32000, String(cause?.message || cause).slice(0, 300)));
    }
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) { write(error(null, -32600, "Request too large")); return; }
  relay(line);
});
input.on("close", () => { void queue.finally(() => process.exit(0)); });

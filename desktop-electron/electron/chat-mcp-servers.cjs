"use strict";

// The person's own MCP servers for chat agents (Plugins > MCPs): added in the app, kept in one
// private file, and handed to each chat session AO starts or resumes, next to the app's own
// coding-tools server. The rules are AO's (ports/chat_mcp.go ValidateChatMCPServers), checked
// here first so a bad entry is refused when it is saved, not when a chat starts.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

// AO takes at most 8 servers per session; the app's own server is one of them.
const MAX_SESSION_SERVERS = 8;
const MAX_SAVED_SERVERS = 32;
const RESERVED_NAMES = new Set(["coding-tools"]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ID = /^[a-f0-9]{16}$/;
// Codex's "Add MCP server" offers STDIO and Streamable HTTP; AO's SSE is the older transport.
const TYPES = new Set(["stdio", "http"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(message) {
  const error = new Error(message);
  error.code = "MCP_SERVER_INVALID";
  return error;
}

function stringMap(value, label, pattern, max) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw fail(`${label} must be a list of names and values`);
  const entries = Object.entries(value);
  if (entries.length > max) throw fail(`At most ${max} ${label} entries are allowed`);
  const out = {};
  for (const [key, item] of entries) {
    if (!pattern.test(key)) throw fail(`${label} name "${String(key).slice(0, 40)}" isn't allowed`);
    // Values are never quoted back: env and header values routinely carry tokens.
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > 8192 || CONTROL.test(item)) throw fail(`${label} ${key}'s value is too long or has control characters`);
    out[key] = item;
  }
  return out;
}

function checkUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 2048 || CONTROL.test(raw)) throw fail("URL is required (at most 2048 characters)");
  let parsed;
  try { parsed = new URL(raw); } catch { throw fail("URL must be an absolute http or https address"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw fail("URL must be an absolute http or https address");
  if (parsed.username || parsed.password) throw fail("Put credentials in a header, not in the URL");
  return raw;
}

/** One server as the person entered it, checked against AO's rules; throws a message they can act on. */
function normalizeServer(input, existing = []) {
  if (!input || typeof input !== "object") throw fail("Server details are missing");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME.test(name)) throw fail("Name: 1-64 letters, digits, '_' or '-'");
  if (RESERVED_NAMES.has(name.toLowerCase())) throw fail(`"${name}" is the app's own server`);
  const id = input.id === undefined ? null : String(input.id);
  if (id !== null && !ID.test(id)) throw fail("Unknown server");
  if (existing.some((server) => server.id !== id && server.name.toLowerCase() === name.toLowerCase())) throw fail(`A server named "${name}" already exists`);
  const type = String(input.type ?? "stdio");
  if (!TYPES.has(type)) throw fail("Type must be STDIO or Streamable HTTP");
  const base = { id: id ?? crypto.randomBytes(8).toString("hex"), name, type, enabled: input.enabled !== false };
  if (type === "stdio") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command || Buffer.byteLength(command, "utf8") > 1024 || CONTROL.test(command)) throw fail("Command to launch is required (one line)");
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 64) throw fail("At most 64 arguments are allowed");
    for (const arg of args) if (typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 4096 || arg.includes("\u0000")) throw fail("An argument is too long");
    return { ...base, command, args: [...args], env: stringMap(input.env, "Environment variable", ENV_NAME, 64) };
  }
  return { ...base, url: checkUrl(typeof input.url === "string" ? input.url.trim() : ""), headers: stringMap(input.headers, "Header", HEADER_NAME, 32) };
}

// GitHub's hosted MCP server (github/github-mcp-server, "Remote GitHub MCP Server"): the only host
// the GitHub CLI's sign-in is ever attached to, whatever the page asks for.
const GITHUB_MCP_HOST = "api.githubcopilot.com";
const GITHUB_TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** The GitHub CLI's token (`gh auth token`), read without a console window; never logged. */
function readGithubCliToken({ execFile = require("node:child_process").execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 15_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      const token = String(stdout ?? "").trim();
      // Neither the output nor gh's own error text is quoted back: either can hold the token.
      if (error || !GITHUB_TOKEN.test(token)) {
        reject(fail(error?.code === "ENOENT" ? "GitHub CLI (gh) isn't installed. Install it, or paste a token instead"
          : "GitHub CLI isn't signed in. Run `gh auth login`, or paste a token instead"));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * A GitHub MCP server with the GitHub CLI's sign-in as its Authorization header, so one click adds
 * it without a token to create and paste. Refused for any other host: the token is the person's
 * whole GitHub CLI login and goes only to GitHub.
 */
async function withGithubCliToken(input, readToken = readGithubCliToken) {
  let host = "";
  try { host = new URL(String(input?.url ?? "")).hostname.toLowerCase(); } catch { /* checked below */ }
  if (input?.type !== "http" || host !== GITHUB_MCP_HOST) throw fail("The GitHub CLI sign-in is used only for GitHub's MCP server");
  const token = await readToken();
  return { ...input, headers: { ...(input.headers ?? {}), Authorization: `Bearer ${token}` } };
}

/** The AO session config for one saved server (POST /sessions and /resume-agent mcpServers). */
function sessionConfig(server) {
  return server.type === "stdio"
    ? { name: server.name, type: "stdio", command: server.command, ...(server.args.length ? { args: server.args } : {}),
      ...(Object.keys(server.env).length ? { env: server.env } : {}) }
    : { name: server.name, type: "http", url: server.url, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) };
}

function createChatMcpServers({ filePath, logger = null }) {
  let servers = null;
  // The saved list from `readText()`: the file's text, or the error reading it threw.
  const fromSaved = (readText) => {
    const list = [];
    let saved = null;
    try { saved = JSON.parse(readText()); } catch (error) {
      // Never the message: JSON.parse quotes the text around a syntax error, which can be a token.
      if (error?.code !== "ENOENT") logger?.warn?.("chat_mcp_servers.unreadable", {
        reason: error instanceof SyntaxError ? "invalid_json" : typeof error?.code === "string" ? error.code : "read_failed" });
    }
    for (const item of Array.isArray(saved?.servers) ? saved.servers.slice(0, MAX_SAVED_SERVERS) : []) {
      // A saved entry that no longer passes (edited by hand, or the rules changed) is dropped, not sent to AO.
      try { list.push(normalizeServer(item, list)); } catch { logger?.warn?.("chat_mcp_servers.dropped", { name: String(item?.name ?? "").slice(0, 64) }); }
    }
    return list;
  };
  // preload() normally reads the file first, off the main thread; this read is for a call before it.
  const load = () => {
    if (!servers) servers = fromSaved(() => fs.readFileSync(filePath, "utf8"));
    return servers;
  };
  // Read soon after start, off the main thread, so a chat's first launch finds the list in memory:
  // reading it then held every window 0.5 s on the hard disk (0.8.104, 2026-11-10).
  async function preload() {
    if (servers) return;
    let text = null;
    let failure = null;
    try { text = await fs.promises.readFile(filePath, "utf8"); } catch (error) { failure = error; }
    if (!servers) servers = fromSaved(() => { if (failure) throw failure; return text; });
  }
  // Saves run off the main thread: written synchronously, one save held every window for 0.5 s on
  // the busy hard disk. The list changes at once; a burst of changes is one write plus at most one
  // more with the latest list, and saved() reports a failed write (the next change writes it all).
  let saving = null;
  let saveAgain = false;
  let saveFailure = null;
  const persist = () => {
    if (saving) { saveAgain = true; return; }
    saving = writePrivateFileAtomicAsync(filePath, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`)
      .then(() => { saveFailure = null; }, (error) => { saveFailure = error; })
      .finally(() => {
        saving = null;
        if (saveAgain) { saveAgain = false; persist(); }
      });
  };
  const store = (next) => {
    servers = next;
    persist();
    return list();
  };
  const list = () => load().map((server) => structuredClone(server));
  return Object.freeze({
    list,
    preload,
    /** Resolves once every change so far is on disk; rejects when the last write failed. */
    async saved() {
      while (saving) await saving;
      if (saveFailure) throw saveFailure;
    },
    /** Adds a server, or replaces the one with the same id; returns the new list. */
    save(input) {
      const current = load();
      const server = normalizeServer(input, current);
      const at = current.findIndex((item) => item.id === server.id);
      if (at < 0 && input?.id !== undefined) throw fail("Unknown server");
      if (at < 0 && current.length >= MAX_SAVED_SERVERS) throw fail(`At most ${MAX_SAVED_SERVERS} servers can be saved`);
      return store(at < 0 ? [...current, server] : current.map((item, index) => index === at ? server : item));
    },
    remove(id) {
      const current = load();
      if (!current.some((item) => item.id === id)) throw fail("Unknown server");
      return store(current.filter((item) => item.id !== id));
    },
    setEnabled(id, enabled) {
      const current = load();
      if (!current.some((item) => item.id === id)) throw fail("Unknown server");
      return store(current.map((item) => item.id === id ? { ...item, enabled: enabled === true } : item));
    },
    /**
     * The enabled servers one chat session gets, as AO session configs, after the `taken` servers
     * the app adds itself. An HTTP server goes only to `httpAgents`, whose drivers take one (AO fails
     * the whole session otherwise); the rest are skipped once AO's limit is reached.
     */
    forSession(agent, taken = [], httpAgents = new Set()) {
      const names = new Set(taken.map((server) => String(server?.name ?? "").toLowerCase()));
      const room = Math.max(0, MAX_SESSION_SERVERS - taken.length);
      return load().filter((server) => server.enabled && !names.has(server.name.toLowerCase())
        && (server.type === "stdio" || httpAgents.has(agent))).slice(0, room).map(sessionConfig);
    },
  });
}

module.exports = Object.freeze({ MAX_SESSION_SERVERS, createChatMcpServers, normalizeServer, readGithubCliToken, sessionConfig, withGithubCliToken });

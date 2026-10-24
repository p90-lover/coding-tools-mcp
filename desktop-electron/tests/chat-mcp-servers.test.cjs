"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MAX_SESSION_SERVERS, createChatMcpServers } = require("../electron/chat-mcp-servers.cjs");

const HTTP_AGENTS = new Set(["claude-code", "codex", "opencode"]);
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-mcp-servers-"));
  const filePath = path.join(dir, "chat-mcp-servers.json");
  return { filePath, servers: createChatMcpServers({ filePath }), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a saved server is kept on disk and comes back after a restart", (t) => {
  const { filePath, servers, done } = store();
  t.after(done);
  const [saved] = servers.save({ name: "notes", type: "stdio", command: " notes-mcp ", args: ["--root", "C:\\notes"], env: { NOTES_TOKEN: "secret" } });
  assert.match(saved.id, /^[a-f0-9]{16}$/);
  assert.deepEqual({ ...saved, id: "x" }, { id: "x", name: "notes", type: "stdio", enabled: true, command: "notes-mcp", args: ["--root", "C:\\notes"], env: { NOTES_TOKEN: "secret" } });
  const again = createChatMcpServers({ filePath });
  assert.deepEqual(again.list(), servers.list());
  servers.save({ ...saved, name: "notebook" });
  assert.deepEqual(servers.list().map((server) => server.name), ["notebook"], "saving with its id edits it in place");
  servers.setEnabled(saved.id, false);
  assert.equal(servers.list()[0].enabled, false);
  assert.deepEqual(servers.remove(saved.id), []);
  assert.throws(() => servers.remove(saved.id), /Unknown server/);
});

test("AO's rules are checked when a server is saved, and errors never quote a value", (t) => {
  const { servers, done } = store();
  t.after(done);
  const refused = (input, pattern) => assert.throws(() => servers.save(input), (error) => error.code === "MCP_SERVER_INVALID" && pattern.test(error.message));
  refused({ name: "bad name", command: "x" }, /Name/);
  refused({ name: "Coding-Tools", command: "x" }, /app's own server/);
  refused({ name: "a", type: "stdio" }, /Command/);
  refused({ name: "a", type: "sse", url: "https://x" }, /STDIO or Streamable HTTP/);
  refused({ name: "a", type: "http", url: "ftp://x" }, /http or https/);
  refused({ name: "a", type: "http", url: "https://me:pw@example.com/mcp" }, /credentials in a header/);
  refused({ name: "a", command: "x", env: { "1BAD": "v" } }, /isn't allowed/);
  refused({ name: "a", type: "http", url: "https://x", headers: { Authorization: "Bearer hunter2\n" } }, /control characters/);
  assert.throws(() => servers.save({ name: "a", type: "http", url: "https://x", headers: { Authorization: "Bearer hunter2\n" } }),
    (error) => !error.message.includes("hunter2"));
  servers.save({ name: "dup", command: "x" });
  refused({ name: "DUP", command: "y" }, /already exists/);
  refused({ id: "0123456789abcdef", name: "ghost", command: "x" }, /Unknown server/);
});

test("a session gets the enabled servers its agent can take, after the app's own, up to AO's limit", (t) => {
  const { servers, done } = store();
  t.after(done);
  servers.save({ name: "local", command: "local-mcp" });
  servers.save({ name: "remote", type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } });
  const off = servers.save({ name: "off", command: "off-mcp" }).at(-1);
  servers.setEnabled(off.id, false);
  const app = [{ name: "coding-tools", type: "http", url: "http://127.0.0.1:1/mcp" }];
  assert.deepEqual(servers.forSession("claude-code", app, HTTP_AGENTS), [
    { name: "local", type: "stdio", command: "local-mcp" },
    { name: "remote", type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
  ]);
  assert.deepEqual(servers.forSession("kimi", [], HTTP_AGENTS).map((server) => server.name), ["local"],
    "an agent whose driver can't take HTTP gets the STDIO ones only (AO would fail the whole session)");
  for (let index = 0; index < 10; index++) servers.save({ name: `more-${index}`, command: "x" });
  assert.equal(servers.forSession("codex", app, HTTP_AGENTS).length, MAX_SESSION_SERVERS - 1, "AO takes 8 per session, the app's own included");
});

test("a hand-edited entry that no longer passes is dropped, not sent to AO", (t) => {
  const { filePath, done } = store();
  t.after(done);
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, servers: [
    { id: "0123456789abcdef", name: "ok", type: "stdio", command: "ok-mcp", args: [], env: {}, enabled: true },
    { id: "fedcba9876543210", name: "broken", type: "http", url: "not a url", headers: {}, enabled: true },
  ] }));
  assert.deepEqual(createChatMcpServers({ filePath }).list().map((server) => server.name), ["ok"]);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/mcp-catalog.ts"), "utf8");
const catalog = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: catalog, require: () => ({}) });
// Objects made inside the sandbox compare by value once copied out.
const plain = (value) => JSON.parse(JSON.stringify(value));
const entry = (id) => catalog.MCP_CATALOG.find((item) => item.id === id);

test("GitHub is ready to add: its hosted server with a Bearer token, read-only on request, or the GitHub CLI's sign-in", () => {
  const github = entry("github");
  assert.deepEqual(plain(catalog.catalogServer(github, { Authorization: " github_pat_abc " })),
    { name: "github", type: "http", enabled: true, url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer github_pat_abc" } });
  assert.equal(catalog.catalogServer(github, { Authorization: "t" }, { readOnly: true }).url, "https://api.githubcopilot.com/mcp/readonly");
  assert.throws(() => catalog.catalogServer(github, {}), /GitHub token is required/);
  // The CLI's token is added by the main process, so the page sends none.
  assert.deepEqual(plain(catalog.catalogServer(github, {}, { githubCli: true }).headers), {});
});

test("a local catalog server runs through cmd /c on Windows, where npx is a .cmd script", () => {
  assert.deepEqual(plain(catalog.catalogServer(entry("playwright"), {}, { windows: true })),
    { name: "playwright", type: "stdio", enabled: true, command: "cmd", args: ["/c", "npx", "-y", "@playwright/mcp@latest"], env: {} });
  assert.equal(catalog.catalogServer(entry("playwright"), {}).command, "npx");
  // An optional key is left out when empty.
  assert.deepEqual(plain(catalog.catalogServer(entry("context7"), {}).headers), {});
  assert.deepEqual(plain(catalog.launchFor("node", ["server.js"], true)), { command: "node", args: ["server.js"] });
});

test("a README's JSON reads as servers, in Claude's, VS Code's and a bare form, with its placeholders listed", () => {
  const claude = catalog.parseMcpPaste(`{
    // Claude Desktop
    "mcpServers": {
      "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/work"], "env": { "DEBUG": "1" } },
      "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer YOUR_TOKEN" } },
    }
  }`, { windows: true });
  assert.deepEqual(plain(claude.servers), [
    { name: "fs", type: "stdio", enabled: true, command: "cmd", args: ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/work"], env: { DEBUG: "1" } },
    { name: "remote", type: "http", enabled: true, url: "https://example.com/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" } },
  ]);
  assert.deepEqual(plain(claude.placeholders), ["YOUR_TOKEN"]);
  const vscode = catalog.parseMcpPaste('{"servers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${input:github_mcp_pat}"}}}}');
  assert.equal(vscode.servers[0].name, "github");
  assert.deepEqual(plain(vscode.placeholders), ["${input:github_mcp_pat}"]);
  const bare = catalog.parseMcpPaste('{"name":"My Docs","command":"uvx mcp-server-docs --port 0"}');
  assert.deepEqual(plain(bare.servers[0]), { name: "My-Docs", type: "stdio", enabled: true, command: "uvx", args: ["mcp-server-docs", "--port", "0"], env: {} });
  assert.throws(() => catalog.parseMcpPaste('{"mcpServers":{"old":{"type":"sse","url":"https://x.dev/sse"}}}'), /SSE/);
  assert.throws(() => catalog.parseMcpPaste("{nope"), /isn't valid JSON/);
});

test("claude mcp add and codex mcp add lines read as their CLIs read them", () => {
  const http = catalog.parseMcpPaste('claude mcp add --transport http github https://api.githubcopilot.com/mcp -H "Authorization: Bearer ghp_x"');
  assert.deepEqual(plain(http.servers), [{ name: "github", type: "http", enabled: true, url: "https://api.githubcopilot.com/mcp", headers: { Authorization: "Bearer ghp_x" } }]);
  const stdio = catalog.parseMcpPaste("claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PAT -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server");
  assert.deepEqual(plain(stdio.servers[0]), { name: "github", type: "stdio", enabled: true, command: "docker",
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_PAT" } });
  const codex = catalog.parseMcpPaste("codex mcp add context7 --env KEY=v -- npx -y @upstash/context7-mcp", { windows: true });
  assert.deepEqual(plain(codex.servers[0]), { name: "context7", type: "stdio", enabled: true, command: "cmd", args: ["/c", "npx", "-y", "@upstash/context7-mcp"], env: { KEY: "v" } });
  assert.throws(() => catalog.parseMcpPaste("npm install something"), /claude mcp add/);
  assert.throws(() => catalog.parseMcpPaste('claude mcp add x -- "unclosed'), /quote/);
});

test("every catalog link opens: the main process allowlists each page and token page", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  const allowed = main.slice(main.indexOf("const MCP_CATALOG_URLS"), main.indexOf("const ALLOWED_EXTERNAL_URLS"));
  for (const item of catalog.MCP_CATALOG) {
    for (const url of [item.homepage, ...(item.secrets ?? []).map((secret) => secret.createUrl).filter(Boolean)]) {
      assert.ok(allowed.includes(`"${url}"`), `${url} is allowlisted`);
    }
  }
  assert.ok(main.includes("...MCP_CATALOG_URLS]"), "and the list joins the allowlist");
});

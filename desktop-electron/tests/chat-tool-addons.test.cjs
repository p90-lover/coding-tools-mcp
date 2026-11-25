"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createChatToolRegistry, collectChatAddonTools, createChatAddonConflictReporter } = require("../electron/chat-tool-addons.cjs");
const { createChatMcpServers } = require("../electron/chat-mcp-servers.cjs");
const { createChatAgentTools } = require("../electron/chat-agent-tools.cjs");
const { createLogger } = require("../electron/logging.cjs");

const fixtureDir = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-tool-addons-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test("chat add-ons fail closed for an ambiguous permission group without disabling other tools", () => {
  const registry = createChatToolRegistry({ agent: new Set(["read_file", "shared"]), terminal: new Set(["shared", "exec_command"]) });
  assert.deepEqual(registry.groups, ["agent", "terminal"]);
  assert.equal(registry.groupOf("shared"), null);
  assert.equal(registry.groupOf("unknown"), null);
  assert.equal(registry.groupOf("read_file"), "agent");
  assert.deepEqual(registry.conflicts, [{ kind: "tool_group", addon: "terminal", existing: "agent", capability: "shared" }]);
  const found = collectChatAddonTools({ registry, headless: [{ name: "shared" }, { name: "read_file" }, { name: "exec_command" }],
    local: [], reserved: new Set(), allowed: (_name, group) => group === "agent", report: assert.fail });
  assert.deepEqual(found.map(tool => tool.name), ["read_file"]);
});

test("chat add-ons report duplicate runtime tool definitions and keep intentional overrides quiet", async (t) => {
  let clock = 10_000;
  const warnings = [];
  const tools = createChatAgentTools({ now: () => clock, logger: { warnInMemory: (...entry) => warnings.push(entry) },
    requestHeadless: async () => ({ tools: [
      { name: "git_status", title: "First" }, { name: "git_status", title: "Duplicate", description: "private catalog note" },
      { name: "sleep" }, { name: "preview_open" }, { name: "read_file" },
    ] }),
  });
  t.after(() => tools.close());
  const lease = await tools.lease({ agent: "codex", workspaceId: "test-workspace" });
  assert.equal(lease.bind("test-session"), true);
  const [server] = lease.servers;
  const list = async () => {
    const response = await fetch(server.url, { method: "POST", headers: { ...server.headers,
      "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(response.status, 200);
    return (await response.json()).result.tools;
  };
  const catalog = await list();
  assert.deepEqual(catalog.filter(tool => tool.name === "git_status").map(tool => tool.title), ["First"]);
  assert.ok(!catalog.some(tool => tool.name === "sleep" || tool.name === "preview_open"), "disabled groups cannot fall back to headless definitions");
  await list();
  assert.deepEqual(warnings, [["chat_addons.conflict", { kind: "tool_definition", addon: "agent", existing: "headless-catalog", capability: "git_status" }]]);
  clock += 60_000;
  await list();
  assert.equal(warnings.length, 2);
});

test("chat add-on name conflicts skip only the competing MCP server and stay in memory", async (t) => {
  const root = fixtureDir(t);
  const logPath = path.join(root, "activity.jsonl");
  const published = [];
  const logger = createLogger({ filePath: logPath, persist: true, publish: record => published.push(record) });
  await logger.restored;
  const servers = createChatMcpServers({ filePath: path.join(root, "configs.json"), logger, npmCacheRoots: [] });
  const [competing] = servers.save({ name: "Unified-Agent-Tools", type: "http", url: "https://example.invalid/private-address",
    headers: { Authorization: "Bearer synthetic-fixture-secret" } });
  servers.save({ name: "docs", type: "stdio", command: "fixture-tool" });
  await servers.saved();
  const taken = [{ name: "unified-agent-tools" }];
  const http = new Set(["codex"]);
  assert.deepEqual(servers.forSession("codex", taken, http).map(server => server.name), ["docs"]);
  servers.forSession("codex", taken, http);
  await logger.flush();
  assert.equal(fs.existsSync(logPath), false);
  assert.deepEqual(logger.notable(), published);
  assert.deepEqual(published.map(({ event, detail }) => [event, detail]), [["chat_addons.conflict", {
    kind: "server_name", addon: `mcp:${competing.id}`, existing: "builtin:unified-agent-tools", capability: "mcp.namespace",
  }]]);
  assert.deepEqual(servers.forSession("codex", [], http).map(server => server.name), ["Unified-Agent-Tools", "docs"],
    "the user entry is available again when the namespace is free");
  assert.doesNotMatch(JSON.stringify(published), /fixtures?-secret|private-address|Authorization|Bearer/i);
});

test("chat add-on diagnostics are bounded and a failed logger cannot interrupt a chat", () => {
  const rows = [];
  const report = createChatAddonConflictReporter({ warnInMemory: (event, entry) => rows.push(entry) }, () => 0);
  const collision = (n) => ({ kind: "tool_group", addon: "agent", existing: "chats", capability: `tool-${n}` });
  for (let n = 0; n < 129; n++) report(collision(n));
  report(collision(128));
  assert.equal(rows.length, 129);
  report(collision(0));
  assert.equal(rows.length, 130, "the oldest dedup entry is evicted");
  const sink = createChatAddonConflictReporter({ warnInMemory() { throw new Error("sink unavailable"); } });
  assert.doesNotThrow(() => sink(collision(1)));
});

function feature(name, imports = {}) {
  const ts = require("typescript");
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "../src/features", `${name}.tsx`), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { exports, require: key => imports[key] ?? require(key) });
  return exports;
}

const elements = value => {
  if (Array.isArray(value)) return value.flatMap(elements);
  return value?.props ? [value, ...elements(value.props.children)] : [];
};

test("chat add-ons picker shows only available panels and opens the chosen add-on", () => {
  const { ChatAddonPicker } = feature("ChatAddonPicker");
  const opened = [];
  const render = (hasSession, hasPlan) => elements(ChatAddonPicker({ hasSession, hasPlan, onOpen: (id) => opened.push(id) }));
  assert.equal(render(false, false).some(element => element.type === "button"), false);
  const planOnly = render(false, true).filter(element => element.type === "button");
  assert.equal(planOnly.length, 1);
  planOnly[0].props.onClick();
  render(true, false).find(el => el.type === "button" && elements(el).some(child => child.type === "span" && child.props.children === "Preview")).props.onClick();
  assert.deepEqual(opened, ["plan", "preview"]);
});

test("chat add-ons settings reuse saved preferences and show names for conflicts without configs", () => {
  const warning = { at: new Date(0).toISOString(), event: "chat_addons.conflict", level: "warning",
    detail: { kind: "server_name", addon: "mcp:0123456789abcdef", existing: "builtin:unified-agent-tools", capability: "mcp.namespace" } };
  const { ChatAddonSettings } = feature("ChatAddonSettings", { "../log-store": { useLogs: () => [warning], logKey: () => 1 } });
  const { renderToStaticMarkup } = require("react-dom/server");
  const React = require("react");
  const servers = [{ id: "0123456789abcdef", name: "My Tools", url: "https://example.invalid/private-url" }];
  const render = state => {
    const toggles = [];
    const markup = renderToStaticMarkup(React.createElement(ChatAddonSettings, {
      servers, copy: {}, snapshot: { state, chatAgentSandbox: true }, redactionDetails: "REDACTION-FIELDS",
      renderToggle: row => { toggles.push(row); return null; },
    }));
    return { markup, toggles };
  };
  const active = render({ chatAgentRedactSecrets: true });
  assert.equal(active.toggles.find(row => row.key === "chatAgentTerminalTools").checked, true);
  assert.equal(active.toggles.find(row => row.key === "chatAgentDesktopTools").checked, false);
  assert.match(active.markup, /Privacy.*REDACTION-FIELDS/);
  assert.match(active.markup, /My Tools was skipped\. Unified Agent Tools already uses that server name/);
  assert.doesNotMatch(active.markup, /private-url|0123456789abcdef/);
  const off = render({ chatAgentTools: false, chatAgentRedactSecrets: true });
  assert.ok(off.toggles.filter(row => row.key !== "chatAgentTools").every(row => row.disabled && !row.checked));
  assert.doesNotMatch(off.markup, /REDACTION-FIELDS/);
});

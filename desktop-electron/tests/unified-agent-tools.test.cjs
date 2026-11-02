"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { FILE_TOOLS, SERVER_NAME, createUnifiedAgentTools, defaultServerPath, findRipgrep, isGptModel } = require("../electron/unified-agent-tools.cjs");
const { validateUnifiedAgentTools } = require("../scripts/verify-package.cjs");

const VENDOR = path.join(__dirname, "..", "vendor", "unified-agent-tools");
const SERVER = path.join(VENDOR, "mcp", "server.mjs");

function logger() {
  const warnings = [];
  return { warnings, warn: (code, detail) => warnings.push([code, detail]), info() {} };
}

test("a GPT model is told from the others whichever harness runs it", () => {
  for (const [agent, model] of [["codex", "gpt-5.6"], ["codex", "gpt-5.6-terra"], ["claude-code", "gpt-5.5"], ["claude-code", "gpt-5.5(high)"],
    ["codex", "default"], ["codex", ""], ["codex", null], ["opencode", "openai/gpt-5.5"], ["codex", "cpa/gpt-5.5"], ["codex", "GPT-5.6"],
    ["claude-code", "gpt-oss-120b-medium"], ["codex", "o4-mini"], ["codex", "codex-mini-latest"], ["codex", "chatgpt-web/high"]]) {
    assert.equal(isGptModel(agent, model), true, `${agent} ${model}`);
  }
  for (const [agent, model] of [["claude-code", "claude-opus-4-7"], ["codex", "claude-opus-4-7"], ["codex", "deepseek-v4.1-flash"], ["claude-code", "default"],
    ["opencode", "default"], ["opencode", "anthropic/claude-opus-4-7"], ["codex", "glm-5.3-flash(low)"], ["codex", "mimo-v2.6-pro"]]) {
    assert.equal(isGptModel(agent, model), false, `${agent} ${model}`);
  }
});

test("a GPT chat gets the vendored server pinned to its worktree, files profile only, run by the app as Node", () => {
  const tools = createUnifiedAgentTools({ serverPath: SERVER, nodePath: "C:/App/Coding Tools.exe", ripgrep: () => "C:/rg/rg.exe" });
  assert.equal(tools.forSession("claude-code", "claude-opus-4-7"), null, "another model gets nothing");
  assert.deepEqual(tools.forSession("codex", "gpt-5.6"), {
    name: SERVER_NAME, type: "stdio", command: "C:/App/Coding Tools.exe", args: [SERVER, "--stdio"],
    env: { ELECTRON_RUN_AS_NODE: "1", UNIFIED_AGENT_TOOLS_ROOT: "cwd", UNIFIED_AGENT_TOOLS_PROFILE: "files", UNIFIED_AGENT_TOOLS_RG: "C:/rg/rg.exe" },
  });
});

test("turned off, not installed or unreadable, a GPT chat starts without the server, and ripgrep is looked up once", () => {
  let on = true, lookups = 0;
  const log = logger();
  const tools = createUnifiedAgentTools({ serverPath: path.join(os.tmpdir(), "missing-unified-agent-tools", "server.mjs"), enabled: () => on, logger: log,
    ripgrep: () => { lookups += 1; return null; } });
  on = false;
  assert.equal(tools.forSession("codex", "gpt-5.6"), null, "the setting is off");
  on = true;
  assert.equal(tools.forSession("codex", "gpt-5.6"), null);
  assert.equal(tools.forSession("codex", "gpt-5.6"), null);
  assert.deepEqual(log.warnings.map(([code]) => code), ["unified_agent_tools.missing"], "a missing server is logged once");

  const found = createUnifiedAgentTools({ serverPath: SERVER, ripgrep: () => { lookups += 1; throw new Error("no PATH"); } });
  lookups = 0;
  const first = found.forSession("codex", "gpt-5.6");
  assert.equal(Object.hasOwn(first.env, "UNIFIED_AGENT_TOOLS_RG"), false, "without ripgrep the server uses git's index or a walk");
  found.forSession("codex", "gpt-5.6");
  assert.equal(lookups, 1);

  const broken = createUnifiedAgentTools({ serverPath: SERVER, enabled: () => { throw new Error("settings unreadable"); }, logger: log });
  assert.equal(broken.forSession("codex", "gpt-5.6"), null, "never fails a launch");
  assert.equal(log.warnings.at(-1)[0], "unified_agent_tools.unavailable");
});

test("ripgrep is found on PATH's absolute entries, else in Codex's own install", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "unified-agent-tools-rg-"));
  const onPath = path.join(base, "bin");
  const codex = path.join(base, "AppData", "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
    "vendor", "x86_64-pc-windows-msvc", "codex-path");
  for (const directory of [onPath, codex]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(codex, "rg.exe"), "");
  assert.equal(findRipgrep({ PATH: ["bin", onPath].join(path.delimiter), APPDATA: path.join(base, "AppData") }, "win32"), path.join(codex, "rg.exe"),
    "a relative PATH entry is never searched");
  fs.writeFileSync(path.join(onPath, "rg.exe"), "");
  assert.equal(findRipgrep({ PATH: onPath, APPDATA: path.join(base, "AppData") }, "win32"), path.join(onPath, "rg.exe"));
  assert.equal(findRipgrep({ PATH: "" }, "linux"), null);
});

test("the server ships next to the app's resources once packaged, from the source tree before", () => {
  assert.equal(defaultServerPath({ packaged: true, resourcesPath: path.join("R:", "resources") }),
    path.join("R:", "resources", "unified-agent-tools", "mcp", "server.mjs"));
  assert.equal(defaultServerPath(), SERVER);
});

test("the vendored server is the one BUNDLE.json pins, and the package check refuses another", () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(VENDOR, "BUNDLE.json"), "utf8"));
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(SERVER)).digest("hex"), bundle.files["mcp/server.mjs"],
    "update BUNDLE.json whenever vendor/unified-agent-tools/mcp/server.mjs changes");
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "unified-agent-tools-package-"));
  fs.mkdirSync(path.join(resources, "unified-agent-tools", "mcp"), { recursive: true });
  fs.copyFileSync(path.join(VENDOR, "BUNDLE.json"), path.join(resources, "unified-agent-tools", "BUNDLE.json"));
  fs.copyFileSync(SERVER, path.join(resources, "unified-agent-tools", "mcp", "server.mjs"));
  assert.deepEqual(validateUnifiedAgentTools(resources), ["mcp/server.mjs"]);
  fs.appendFileSync(path.join(resources, "unified-agent-tools", "mcp", "server.mjs"), "\n// changed\n");
  assert.throws(() => validateUnifiedAgentTools(resources), /PACKAGE_UNIFIED_AGENT_TOOLS_CHECKSUM_MISMATCH/);
  fs.rmSync(path.join(resources, "unified-agent-tools", "mcp", "server.mjs"));
  assert.throws(() => validateUnifiedAgentTools(resources), /PACKAGE_UNIFIED_AGENT_TOOLS_MISSING/);
});

test("started the way a chat starts it, the server lists only the file tools and searches its own folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unified-agent-tools-session-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const needle = 1;\n");
  const config = createUnifiedAgentTools({ serverPath: SERVER, nodePath: process.execPath, ripgrep: () => null }).forSession("codex", "gpt-5.6");
  const child = spawn(config.command, config.args, { cwd: root, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line) { const message = JSON.parse(line); replies.get(message.id)?.(message); }
    }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} did not answer`)), 20_000);
    replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const listed = (await request(2, "tools/list")).result.tools.map((entry) => entry.name);
    assert.deepEqual([...listed].sort(), [...FILE_TOOLS].sort(), "no shell, web fetch or desktop capture");
    const found = (await request(3, "tools/call", { name: "Grep", arguments: { pattern: "needle" } })).result;
    assert.equal(found.isError, undefined);
    assert.match(found.content[0].text, /a\.ts/);
    const outside = (await request(4, "tools/call", { name: "Read", arguments: { path: path.join(os.tmpdir(), "elsewhere.txt") } })).result;
    assert.equal(outside.isError, true, "pinned to the session's folder");
  } finally { child.kill(); }
});

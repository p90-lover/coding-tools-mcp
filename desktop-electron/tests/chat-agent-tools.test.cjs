"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createChatAgentTools, patchTargets, toolResult } = require("../electron/chat-agent-tools.cjs");

const WINDOWS = process.platform === "win32";
const tool = (name) => ({ name, description: name, inputSchema: { type: "object" } });
const CATALOG = {
  ok: true, workspace_id: "ws1", tool_profile: "core",
  tools: [
    { name: "read_file", title: "Read file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } },
      annotations: { readOnlyHint: true }, outputSchema: { type: "object" } },
    ...["exec_command", "apply_patch", "git_status", "view_image", "update_plan", "request_permissions"].map(tool),
    ...["capture_screenshot", "list_windows", "computer_snapshot", "computer_action", "vision_status"].map(tool),
    ...["get_default_cwd", "set_default_cwd", "workflow_update", "codex_command_exec", "history_session_read", "mcp_operation_status",
      "sandbox_exec", "start_task"].map(tool),
  ],
};

/** A worktree (the session's root) beside the user's main checkout and another directory, in temp. */
function tempTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-tools-"));
  const root = path.join(base, "worktrees", "project-1");
  const checkout = path.join(base, "checkout");
  const elsewhere = path.join(base, "elsewhere");
  for (const directory of [path.join(root, "src", "deep"), checkout, elsewhere]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.txt"), "a");
  return { base, root, checkout, elsewhere, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function fixture({ enabled = () => true, desktop = () => false, results = {}, workspaces = null, confirm = async () => true, root = null } = {}) {
  const calls = [];
  const asked = [];
  const confirmations = [];
  const tools = createChatAgentTools({
    enabled, desktopEnabled: desktop, version: "9.9.9", logger: { info() {}, warn() {} },
    confirm: async (request) => { confirmations.push(request); return confirm(request); },
    sessionWorkspace: async (id) => {
      asked.push(id);
      if (workspaces) return workspaces(id);
      return root ? { root } : { ready: false };
    },
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint.startsWith("/api/v1/tools/catalog?")) return CATALOG;
      if (endpoint === "/api/v1/tools/call") {
        const outcome = results[body.tool];
        if (outcome instanceof Error) throw outcome;
        return { ok: true, operation: outcome ?? { state: "completed", result: { ok: true, tool: body.tool, echo: body.arguments } } };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  return { tools, calls, asked, confirmations };
}

/** A leased, bound session: its URL and auth header. */
async function session(tools, { agent = "codex", workspaceId = "ws1", id = "ao-1" } = {}) {
  const lease = await tools.lease({ agent, workspaceId });
  assert.ok(lease, "leased");
  if (id) assert.equal(lease.bind(id), true);
  const [{ url, headers }] = lease.servers;
  return { lease, url, auth: { authorization: headers.Authorization } };
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const request = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: headers[":method"] || "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith(":"))) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    if (headers[":method"] !== "GET") request.end(payload); else request.end();
  });
}

let nextId = 100;
const callTool = (url, auth, name, args = {}) =>
  post(url, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, auth).then((reply) => reply.body.result);
const listed = (url, auth) => post(url, { jsonrpc: "2.0", id: nextId++, method: "tools/list" }, auth).then((reply) => reply.body.result.tools.map((entry) => entry.name));

test("each chat session gets its own server path and credential, for agents whose driver takes it", async () => {
  let on = true;
  const { tools } = fixture({ enabled: () => on });
  try {
    const first = await tools.lease({ agent: "codex", workspaceId: "ws1" });
    const second = await tools.lease({ agent: "codex", workspaceId: "ws1" });
    const [server, ...rest] = first.servers;
    assert.equal(rest.length, 0);
    assert.equal(server.name, "coding-tools");
    assert.equal(server.type, "http");
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/ws1\/[A-Za-z0-9_-]{16,64}$/);
    assert.match(server.headers.Authorization, /^Bearer [A-Za-z0-9_-]{40,}$/);
    assert.notEqual(second.servers[0].url, server.url, "a session's path is its own");
    assert.notEqual(second.servers[0].headers.Authorization, server.headers.Authorization, "and so is its credential");
    for (const agent of ["claude-code", "opencode"]) assert.ok(await tools.lease({ agent, workspaceId: "ws1" }), agent);
    for (const agent of ["agy", "gemini", "aider", undefined]) assert.equal(await tools.lease({ agent, workspaceId: "ws1" }), null, String(agent));
    assert.equal(await tools.lease({ agent: "codex", workspaceId: "../etc" }), null);
    assert.equal(await tools.lease({ agent: "codex" }), null);
    on = false;
    assert.equal(await tools.lease({ agent: "codex", workspaceId: "ws1" }), null, "the setting turns it off");
  } finally { await tools.close(); }
});

test("the warm-session identity names the tool groups, never a credential or a session, and is pending until the server listens", async () => {
  let on = true;
  let desktop = false;
  const { tools } = fixture({ enabled: () => on, desktop: () => desktop });
  try {
    assert.equal(tools.identity("ws1"), "pending");
    const lease = await tools.lease({ agent: "codex", workspaceId: "ws1" });
    const identity = tools.identity("ws1");
    assert.match(identity, /^on\|agent\|[0-9a-f-]{36}$/);
    assert.ok(!identity.includes(lease.servers[0].headers.Authorization.slice(7)), "never the token");
    assert.ok(!identity.includes(lease.servers[0].url.split("/").at(-1)), "never the session's path");
    await tools.lease({ agent: "codex", workspaceId: "ws1" });
    assert.equal(tools.identity("ws1"), identity, "a new session changes nothing a warm key holds");
    assert.equal(tools.identity("ws2"), identity, "the workspace is already part of the warm key");
    desktop = true;
    assert.match(tools.identity("ws1"), /^on\|agent\+desktop\|/, "the desktop group is part of it");
    on = false;
    assert.equal(tools.identity("ws1"), "off");
  } finally { await tools.close(); }
});

test("the MCP endpoint answers initialize, lists the agent tools and calls them in the session's worktree", async () => {
  const tree = tempTree();
  const { tools, calls } = fixture({ root: tree.root });
  try {
    const { url, auth } = await session(tools, { agent: "claude-code" });
    const init = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, auth);
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.body.result.serverInfo, { name: "coding-tools", title: "Coding Tools", version: "9.9.9" });
    assert.ok(init.body.result.capabilities.tools);
    assert.match(init.body.result.instructions, /worktree/);
    assert.doesNotMatch(init.body.result.instructions, /computer_/, "desktop tools are not mentioned while they are off");
    const unknownVersion = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, auth);
    assert.equal(unknownVersion.body.result.protocolVersion, "2025-06-18");

    const notified = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
    assert.equal(notified.status, 202);
    assert.equal(notified.body, null);

    const reply = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
    assert.deepEqual(reply.body.result.tools.map((entry) => entry.name),
      ["read_file", "exec_command", "apply_patch", "git_status", "view_image", "update_plan", "request_permissions"],
      "desktop tools are off by default; the default cwd, task board, native Codex, history, operation store, sandbox and harness tools are never offered");
    assert.equal(Object.hasOwn(reply.body.result.tools[0], "outputSchema"), false);
    assert.deepEqual(reply.body.result.tools[0].annotations, { readOnlyHint: true });
    assert.equal(calls[0].endpoint, "/api/v1/tools/catalog?workspace_id=ws1");
    assert.equal(calls[0].options.method, "GET");

    const called = await callTool(url, auth, "read_file", { path: "src/a.txt" });
    const call = calls.at(-1);
    assert.equal(call.endpoint, "/api/v1/tools/call");
    assert.equal(call.body.workspace_id, "ws1");
    assert.equal(call.body.tool, "read_file");
    assert.equal(call.body.root, path.resolve(tree.root), "headless runs the call rooted at the worktree");
    assert.deepEqual(call.body.arguments, { path: "src/a.txt" });
    assert.match(call.body.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(called.isError, false);
    assert.deepEqual(called.structuredContent, { ok: true, tool: "read_file", echo: { path: "src/a.txt" } });
    assert.deepEqual(JSON.parse(called.content[0].text), called.structuredContent);

    const before = calls.length;
    for (const hidden of ["workflow_update", "set_default_cwd", "get_default_cwd", "codex_command_exec", "capture_screenshot", "computer_action", "sandbox_exec", "no_such_tool"]) {
      const refused = await callTool(url, auth, hidden);
      assert.equal(refused.isError, true, hidden);
      assert.match(refused.content[0].text, /Unknown tool/, hidden);
    }
    assert.equal(calls.length, before, "a hidden tool never reaches the service");

    const batch = await post(url, [{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "resources/list" }], auth);
    assert.deepEqual(batch.body[0], { jsonrpc: "2.0", id: 5, result: {} });
    assert.equal(batch.body[1].error.code, -32601);
  } finally { await tools.close(); tree.cleanup(); }
});

test("calls are refused until the session exists and AO has made its worktree", async () => {
  const tree = tempTree();
  let ready = false;
  const { tools, calls } = fixture({ workspaces: () => (ready ? { root: tree.root } : { ready: false }) });
  try {
    const { lease, url, auth } = await session(tools, { id: null });
    const unbound = await callTool(url, auth, "read_file", { path: "src/a.txt" });
    assert.equal(unbound.isError, true);
    assert.match(unbound.content[0].text, /not ready yet/);
    assert.ok(lease.bind("ao-7"));
    const provisioning = await callTool(url, auth, "read_file", { path: "src/a.txt" });
    assert.match(provisioning.content[0].text, /not ready yet/);
    assert.equal(calls.filter((call) => call.endpoint === "/api/v1/tools/call").length, 0, "nothing ran before the root was known");
    ready = true;
    assert.equal((await callTool(url, auth, "read_file", { path: "src/a.txt" })).isError, false);
    assert.equal(lease.bind("ao-8"), false, "a credential is never rebound to another session");
    assert.equal((await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, auth)).status, 401, "and the attempt retires it");
  } finally { await tools.close(); tree.cleanup(); }
});

test("path arguments outside the worktree are refused, whatever their spelling", async () => {
  const tree = tempTree();
  const { tools, calls } = fixture({ root: tree.root });
  try {
    const { url, auth } = await session(tools);
    const escapes = [
      "../checkout/secret.txt",
      "src/../../checkout",
      "..",
      path.join(tree.checkout, "secret.txt"),
      path.join(tree.root, "..", "checkout"),
      "@linked/file.txt",
      "\\\\?\\" + path.join(tree.root, "src"),
      ...(WINDOWS ? [
        `${tree.root[0] === "Z" ? "Y" : "Z"}:\\elsewhere\\file.txt`,
        `${tree.root.slice(0, 2)}foo.txt`,
        "\\\\server\\share\\file.txt",
        "//server/share/file.txt",
        "\\Windows\\win.ini",
      ] : ["/etc/passwd"]),
    ];
    const before = calls.length;
    for (const escape of escapes) {
      const refused = await callTool(url, auth, "read_file", { path: escape });
      assert.equal(refused.isError, true, escape);
      assert.match(refused.content[0].text, /refused/, escape);
    }
    for (const [name, args] of [
      ["list_dir", { path: ".." }], ["git_status", { path: tree.checkout }], ["view_image", { path: "../x.png" }],
      ["compare_images", { before_path: "src/a.png", after_path: "../b.png" }], ["git_diff", { paths: ["src/a.txt", "../x"] }],
      ["read_file", { path: "src/a.txt", project_root: tree.checkout }],
    ]) {
      const refused = await callTool(url, auth, name, args);
      // A tool outside the listed catalog is still in the agent group, and still scoped.
      assert.equal(refused.isError, true, name);
    }
    assert.equal(calls.length, before, "no escape reached the service");

    // Inside the worktree: relative, nested, `..` that stays inside, and absolute spellings.
    for (const [given, forwarded] of [
      ["src/a.txt", "src/a.txt"], ["./src/deep/../a.txt", "src/a.txt"], [path.join(tree.root, "src", "a.txt"), "src/a.txt"],
      ["src/new/file.txt", "src/new/file.txt"], [".", "."],
    ]) {
      const allowed = await callTool(url, auth, "read_file", { path: given });
      assert.equal(allowed.isError, false, given);
      assert.equal(calls.at(-1).body.arguments.path, forwarded, given);
    }
  } finally { await tools.close(); tree.cleanup(); }
});

test("a symlink or junction inside the worktree cannot lead out of it", async (t) => {
  const tree = tempTree();
  fs.writeFileSync(path.join(tree.elsewhere, "secret.txt"), "secret");
  try {
    fs.symlinkSync(tree.elsewhere, path.join(tree.root, "escape"), WINDOWS ? "junction" : "dir");
  } catch (error) {
    tree.cleanup();
    t.skip(`cannot create a link here: ${error.code}`);
    return;
  }
  fs.symlinkSync(path.join(tree.root, "src"), path.join(tree.root, "inner"), WINDOWS ? "junction" : "dir");
  const { tools, calls } = fixture({ root: tree.root });
  try {
    const { url, auth } = await session(tools);
    for (const escape of ["escape/secret.txt", "escape", "escape/new.txt", path.join(tree.root, "escape", "secret.txt")]) {
      const refused = await callTool(url, auth, "read_file", { path: escape });
      assert.equal(refused.isError, true, escape);
      assert.match(refused.content[0].text, /through a link|outside/, escape);
    }
    const patched = await callTool(url, auth, "apply_patch", { patch: "*** Begin Patch\n*** Add File: escape/planted.txt\n+x\n*** End Patch\n" });
    assert.equal(patched.isError, true);
    assert.equal(fs.existsSync(path.join(tree.elsewhere, "planted.txt")), false);
    const before = calls.length;
    assert.equal((await callTool(url, auth, "read_file", { path: "inner/a.txt" })).isError, false, "a link that stays inside is fine");
    assert.equal(calls.length, before + 1);
  } finally { await tools.close(); tree.cleanup(); }
});

test("apply_patch is refused when any file it names is outside the worktree", async () => {
  const tree = tempTree();
  const { tools, calls } = fixture({ root: tree.root });
  try {
    const { url, auth } = await session(tools);
    const outside = path.join(tree.checkout, "main.rs").replace(/\\/g, "/");
    const before = calls.length;
    for (const patch of [
      "*** Begin Patch\n*** Update File: src/a.txt\n@@\n-a\n+b\n*** Add File: ../checkout/planted.txt\n+x\n*** End Patch\n",
      `*** Begin Patch\n*** Delete File: ${outside}\n*** End Patch\n`,
      "*** Begin Patch\r\n*** Update File: @linked/x.txt\r\n@@\r\n-a\r\n+b\r\n*** End Patch\r\n",
      "--- a/src/a.txt\n+++ b/../checkout/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
      `--- /dev/null\n+++ ${outside}\n@@ -0,0 +1 @@\n+x\n`,
      "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-a\n+b\n--- a/../../x\n+++ b/../../x\n@@ -1 +1 @@\n-a\n+b\n",
    ]) {
      const refused = await callTool(url, auth, "apply_patch", { patch });
      assert.equal(refused.isError, true, patch);
      assert.match(refused.content[0].text, /patch target .* refused/, patch);
      assert.equal((await callTool(url, auth, "patch_check", { patch })).isError, true, patch);
    }
    assert.equal(calls.length, before);
    for (const patch of [
      "*** Begin Patch\n*** Update File: src/a.txt\n@@\n-a\n+b\n*** Add File: src/new.txt\n+x\n*** End Patch\n",
      "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,2 +1,2 @@\n-a\n--- not a header, a removed SQL comment\n+b\n",
      "--- /dev/null\n+++ b/src/created.txt\n@@ -0,0 +1 @@\n+x\n",
    ]) {
      const allowed = await callTool(url, auth, "apply_patch", { patch });
      assert.equal(allowed.isError, false, patch);
      assert.equal(calls.at(-1).body.arguments.patch, patch, "the patch is forwarded unchanged");
      assert.equal(calls.at(-1).body.root, path.resolve(tree.root));
    }
  } finally { await tools.close(); tree.cleanup(); }
});

test("patchTargets names every file a patch touches, in both formats headless applies", () => {
  assert.deepEqual(patchTargets("*** Begin Patch\n*** Add File: a\n+x\n*** Update File: b/c\n*** Delete File: d\n*** Move to: e\n*** End Patch"),
    ["a", "c", "d", "e"]);
  assert.deepEqual(patchTargets("--- a/x\n+++ b/y\n@@\n-1\n+2\n--- /dev/null\n+++ b/z\n"), ["x", "y", "z"]);
});

test("exec_command always starts in the worktree", async () => {
  const tree = tempTree();
  const { tools, calls } = fixture({ root: tree.root });
  try {
    const { url, auth } = await session(tools);
    assert.equal((await callTool(url, auth, "exec_command", { cmd: "git status" })).isError, false);
    assert.equal(calls.at(-1).body.arguments.workdir, ".", "no directory given: the worktree root");
    assert.equal(calls.at(-1).body.root, path.resolve(tree.root));
    await callTool(url, auth, "exec_command", { cmd: "dir", workdir: path.join(tree.root, "src") });
    assert.equal(calls.at(-1).body.arguments.workdir, "src");
    await callTool(url, auth, "exec_command", { cmd: "dir", cwd: "src/deep" });
    assert.equal(calls.at(-1).body.arguments.cwd, "src/deep");
    assert.equal(Object.hasOwn(calls.at(-1).body.arguments, "workdir"), false);
    const before = calls.length;
    for (const args of [{ workdir: tree.checkout }, { workdir: ".." }, { cwd: tree.elsewhere }, { workdir: "src", cwd: ".." }]) {
      const refused = await callTool(url, auth, "exec_command", { cmd: "dir", ...args });
      assert.equal(refused.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
  } finally { await tools.close(); tree.cleanup(); }
});

test("a session's credential reaches only its own session, and is forgotten when the session ends", async () => {
  const tree = tempTree();
  const other = tempTree();
  const ended = new Set();
  const roots = { "ao-1": tree.root, "ao-2": other.root };
  const { tools, calls } = fixture({ workspaces: (id) => (ended.has(id) ? { ended: true } : { root: roots[id] }) });
  try {
    const one = await session(tools, { id: "ao-1" });
    const two = await session(tools, { id: "ao-2" });
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post(two.url, message, one.auth)).status, 401, "one session's token does not open another's path");
    assert.equal((await post(one.url.replace("/mcp/ws1/", "/mcp/ws2/"), message, one.auth)).status, 401, "nor its own key in another workspace");
    await callTool(two.url, two.auth, "read_file", { path: "src/a.txt" });
    assert.equal(calls.at(-1).body.root, path.resolve(other.root));
    await callTool(one.url, one.auth, "read_file", { path: "src/a.txt" });
    assert.equal(calls.at(-1).body.root, path.resolve(tree.root));
    const crossing = await callTool(one.url, one.auth, "read_file", { path: path.join(other.root, "src", "a.txt") });
    assert.equal(crossing.isError, true, "another session's worktree is outside this one");

    ended.add("ao-2");
    tools.forgetSession("ao-1");
    assert.equal((await post(one.url, message, one.auth)).status, 401, "a killed session's credential is gone");
    const gone = await post(two.url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "src/a.txt" } } }, two.auth);
    // Within the recheck window the known root still answers; the sweep and the next recheck end it.
    assert.equal(gone.status, 200);
    await tools.sweep();
    assert.equal((await post(two.url, message, two.auth)).status, 401, "an ended session's credential is forgotten");

    const released = await tools.lease({ agent: "codex", workspaceId: "ws1" });
    released.release();
    const [{ url, headers }] = released.servers;
    assert.equal((await post(url, message, { authorization: headers.Authorization })).status, 401, "a failed spawn's credential is gone");
  } finally { await tools.close(); tree.cleanup(); other.cleanup(); }
});

test("an ended session or a moved worktree is refused on the next check", async () => {
  const tree = tempTree();
  const other = tempTree();
  let clock = 1_000_000;
  let answer = { root: tree.root };
  const calls = [];
  const tools = createChatAgentTools({
    now: () => clock, logger: { info() {}, warn() {} },
    sessionWorkspace: async () => answer,
    requestHeadless: async (endpoint, body) => { calls.push(body); return { ok: true, operation: { state: "completed", result: { ok: true } } }; },
  });
  try {
    const { url, auth } = await session(tools);
    assert.equal((await callTool(url, auth, "read_file", { path: "src/a.txt" })).isError, false);
    answer = { root: other.root };
    clock += 60_000;
    const moved = await callTool(url, auth, "read_file", { path: "src/a.txt" });
    assert.match(moved.content[0].text, /changed/);
    assert.equal((await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, auth)).status, 401);

    const next = await session(tools, { id: "ao-9" });
    answer = { root: tree.root };
    assert.equal((await callTool(next.url, next.auth, "read_file", { path: "src/a.txt" })).isError, false);
    answer = { ended: true };
    clock += 60_000;
    const ended = await callTool(next.url, next.auth, "read_file", { path: "src/a.txt" });
    assert.match(ended.content[0].text, /ended/);
    assert.equal(calls.length, 2);
  } finally { await tools.close(); tree.cleanup(); other.cleanup(); }
});

test("desktop tools are hidden and refused unless the user opts in, and every screen observation is confirmed", async () => {
  const tree = tempTree();
  let desktop = false;
  let approve = true;
  const { tools, calls, confirmations } = fixture({ root: tree.root, desktop: () => desktop, confirm: async () => approve });
  try {
    const before = await session(tools, { id: "ao-1" });
    assert.ok(!(await listed(before.url, before.auth)).some((name) => name.startsWith("computer_") || name === "capture_screenshot"));
    const count = calls.length;
    assert.match((await callTool(before.url, before.auth, "capture_screenshot")).content[0].text, /Unknown tool/);
    assert.equal(calls.length, count);

    desktop = true;
    assert.match((await callTool(before.url, before.auth, "capture_screenshot")).content[0].text, /Unknown tool/,
      "a session started without the desktop group does not gain it");
    const opted = await session(tools, { id: "ao-2" });
    assert.deepEqual((await listed(opted.url, opted.auth)).filter((name) => !["read_file", "exec_command", "apply_patch", "git_status", "view_image", "update_plan", "request_permissions"].includes(name)),
      ["capture_screenshot", "list_windows", "computer_snapshot", "computer_action", "vision_status"]);
    const init = await post(opted.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, opted.auth);
    assert.match(init.body.result.instructions, /confirms each screen capture/);

    const shot = await callTool(opted.url, opted.auth, "capture_screenshot", { max_bytes: 4096 });
    assert.equal(shot.isError, false);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].message, /screenshot/);
    assert.match(confirmations[0].detail, /capture_screenshot/);
    assert.equal(Object.hasOwn(calls.at(-1).body, "root"), false, "desktop tools run in the workspace's own context");
    approve = false;
    const declined = await callTool(opted.url, opted.auth, "list_windows");
    assert.match(declined.content[0].text, /declined/);
    assert.equal(calls.at(-1).body.tool, "capture_screenshot", "a declined call never reaches the service");
    // Computer control is gated by the user's own local enable (its lease), not a dialog per action.
    await callTool(opted.url, opted.auth, "computer_snapshot", { session_id: "lease" });
    assert.equal(calls.at(-1).body.tool, "computer_snapshot");
    assert.equal(confirmations.length, 2);

    desktop = false;
    assert.match((await callTool(opted.url, opted.auth, "computer_action", {})).content[0].text, /Unknown tool/,
      "turning the setting off refuses it in running sessions too");
    assert.ok(!(await listed(opted.url, opted.auth)).includes("computer_action"));
  } finally { await tools.close(); tree.cleanup(); }
});

test("turning the app's tools off refuses calls in running sessions", async () => {
  const tree = tempTree();
  let on = true;
  const { tools } = fixture({ root: tree.root, enabled: () => on });
  try {
    const { url, auth } = await session(tools);
    on = false;
    assert.match((await callTool(url, auth, "read_file", { path: "src/a.txt" })).content[0].text, /turned off/);
    assert.deepEqual(await listed(url, auth), []);
  } finally { await tools.close(); tree.cleanup(); }
});

test("tool failures come back as tool errors, not transport errors", async () => {
  const tree = tempTree();
  const { tools } = fixture({ root: tree.root, results: {
    exec_command: { state: "failed", error: "RESULT_TOO_LARGE: exec_command ran" },
    read_file: new Error("Headless service rejected the request (HTTP 400)"),
    git_status: { state: "completed", result: { ok: false, error: { code: "APPROVAL_REQUIRED" } } },
  } });
  try {
    const { url, auth } = await session(tools);
    const failed = await callTool(url, auth, "exec_command", { cmd: "dir" });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /RESULT_TOO_LARGE/);
    const rejected = await callTool(url, auth, "read_file", { path: "src/a.txt" });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /HTTP 400/);
    const refused = await callTool(url, auth, "git_status");
    assert.equal(refused.isError, true, "ok:false from the workspace policy is an error result");
    assert.equal(refused.structuredContent.error.code, "APPROVAL_REQUIRED");
  } finally { await tools.close(); tree.cleanup(); }
});

test("the endpoint refuses callers without the token, from a browser origin, or for another host", async () => {
  const { tools, calls } = fixture();
  try {
    const { url, auth } = await session(tools);
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post(url, message)).status, 401);
    assert.equal((await post(url, message, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(url, message, { ...auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await post(url, message, { ...auth, host: "evil.example" })).status, 403);
    assert.equal((await post(url.replace(/\/mcp\/ws1\//, "/mcp/..%2Fetc/"), message, auth)).status, 404);
    assert.equal((await post(url.replace(/\/[^/]+$/, "/short"), message, auth)).status, 404);
    assert.equal((await post(url.replace(/\/[^/]+$/, ""), message, auth)).status, 404, "the old per-workspace path is gone");
    assert.equal((await post(url, "", { ...auth, ":method": "GET" })).status, 405);
    assert.equal((await post(url, "{not json", auth)).status, 400);
    assert.equal(calls.length, 0, "nothing reached the workspace service");
  } finally { await tools.close(); }
});

test("image results become MCP image content, as the workspace listener shapes them", () => {
  const shot = toolResult("capture_screenshot", {}, { ok: true, mime_type: "image/png", base64: "iVBORw0K", data_url: "data:image/png;base64,iVBORw0K", width: 10 });
  assert.deepEqual(shot.content[0], { type: "image", data: "iVBORw0K", mimeType: "image/png" });
  assert.deepEqual(shot.structuredContent, { ok: true, mime_type: "image/png", width: 10 });
  assert.equal(shot.isError, false);
  const saved = toolResult("capture_screenshot", { output: "file" }, { ok: true, mime_type: "image/png", base64: "abc", path: "C:/shot.png" });
  assert.equal(saved.content.length, 1, "a screenshot written to a file stays text");
  const computer = toolResult("computer_snapshot", {}, { ok: true, mime_type: "image/jpeg", base64: "abc" });
  assert.equal(computer.content[0].type, "image");
  const plain = toolResult("list_dir", {}, ["a", "b"]);
  assert.deepEqual(plain.structuredContent, { value: ["a", "b"] });
});

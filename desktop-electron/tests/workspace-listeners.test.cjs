const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeListeners, rememberListener, restoreWorkspaceListeners } = require("../electron/workspace-listeners.cjs");
const { createStateStore } = require("../electron/state.cjs");

const WS = "779e28948db048cd85ba5402b68a7167";

test("a confirmed start remembers the listener, a stop forgets it, a status read changes nothing", () => {
  let list = rememberListener(undefined, WS, "mcp", "start");
  assert.deepEqual(list, [`${WS}:mcp`]);
  list = rememberListener(list, WS, "mcp", "restart");
  assert.deepEqual(list, [`${WS}:mcp`], "a restart keeps it once");
  list = rememberListener(list, WS, "actions", "start");
  assert.deepEqual(list, [`${WS}:mcp`, `${WS}:actions`]);
  assert.deepEqual(rememberListener(list, WS, "mcp", "status"), list);
  assert.deepEqual(rememberListener(list, WS, "mcp", "stop"), [`${WS}:actions`]);
  assert.deepEqual(rememberListener(list, "../bad", "mcp", "start"), list, "an invalid workspace id is never stored");
  assert.deepEqual(rememberListener(list, WS, "shell", "start"), list, "only mcp and actions listeners");
});

test("the remembered list keeps only valid, unique entries, at most 64", () => {
  assert.deepEqual(normalizeListeners([`${WS}:mcp`, `${WS}:mcp`, "x:y", 42, `${WS}:mcp:extra`, "a:actions"]),
    [`${WS}:mcp`, "a:actions"]);
  assert.deepEqual(normalizeListeners("nope"), []);
  const many = Array.from({ length: 80 }, (_, index) => `w${index}:mcp`);
  assert.equal(normalizeListeners(many).length, 64);
});

test("restart restores a stopped remembered listener with confirm, and leaves a running one alone", async () => {
  // Live 2026-11-20 after the 0.8.140 update: all four workspaces' MCP listeners were stopped, so
  // ChatGPT's native Codex requests were refused until each was started again by hand.
  const calls = [];
  const states = { [`${WS}:mcp`]: "stopped", "running1:mcp": "running" };
  const request = async (pathname, body) => {
    calls.push({ pathname, ...body });
    const key = `${body.workspace_id}:${body.service}`;
    if (body.operation === "start") states[key] = "running";
    return { ok: true, service: body.service, status: { state: states[key] } };
  };
  const logs = [];
  const logger = { info: (event, detail) => logs.push([event, detail]), warn: (event, detail) => logs.push([event, detail]) };
  const { kept, restored } = await restoreWorkspaceListeners({ entries: [`${WS}:mcp`, "running1:mcp", "gone:mcp"],
    workspaceIds: [WS, "running1"], request, logger });
  assert.deepEqual(restored, [`${WS}:mcp`]);
  assert.deepEqual(kept, [`${WS}:mcp`, "running1:mcp"], "a removed workspace is forgotten");
  const starts = calls.filter((call) => call.operation === "start");
  assert.deepEqual(starts, [{ pathname: "/api/v1/workspaces/service", workspace_id: WS, service: "mcp", operation: "start", confirm: true }]);
  assert.ok(calls.every((call) => call.operation !== "start" || call.workspace_id !== "running1"), "a running listener is not restarted");
  assert.deepEqual(logs.map(([event]) => event).sort(), ["workspace.listener_forgotten", "workspace.listener_restored"]);
});

test("a listener that fails to start stays remembered for the next launch", async () => {
  const request = async (_pathname, body) => {
    if (body.operation === "start") throw new Error("Port 28767 is already in use");
    return { ok: true, status: { state: "stopped" } };
  };
  const warnings = [];
  const { kept, restored } = await restoreWorkspaceListeners({ entries: [`${WS}:mcp`], workspaceIds: [WS], request,
    logger: { warn: (event, detail) => warnings.push([event, detail.message]) } });
  assert.deepEqual(kept, [`${WS}:mcp`]);
  assert.deepEqual(restored, []);
  assert.deepEqual(warnings, [["workspace.listener_restore_failed", "Port 28767 is already in use"]]);
});

test("launcher state keeps valid remembered listeners and drops a damaged list", () => {
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, "..", "..", "aiTemp"), "workspace-listeners-state-"));
  try {
    const file = path.join(dir, "launcher-state.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceListeners: [`${WS}:mcp`, "bad entry", `${WS}:mcp`] }));
    assert.deepEqual(createStateStore(file).read().workspaceListeners, [`${WS}:mcp`]);
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceListeners: "corrupt" }));
    assert.equal(Object.hasOwn(createStateStore(file).read(), "workspaceListeners"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

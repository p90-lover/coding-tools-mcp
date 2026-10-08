"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

function webRole(role, readiness, connected = false) {
  const calls = [];
  const node = { id: "card", role, parents: [], state: "pending",
    route: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
      model: "chatgpt-web/high", permission_profile: ":read-only" } };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [
        { id: "run", workspace_id: "ws", revision: 1, nodes: [node] }] };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true,
        status: { connected, model: node.route.model, permission_profile: ":read-only" } };
      calls.push({ endpoint, body });
      return { ok: true, status: { connected: true, model: node.route.model } };
    },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: readiness,
    webModelCatalog: async () => ({ models: [{ slug: node.route.model }] }),
    resolveHarness: async () => ({ executable: "C:/codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:/ao-home", model: node.route.model, permission_profile: ":read-only",
      allow_model_usage: true, allow_command_execution: false, request_limit: 3, lifetime_seconds: 120 }),
    confirm: async () => true,
  });
  return { workflow, calls, input: { workspaceId: "ws", runId: "run", nodeId: "card", executable: "C:/codex.exe" } };
}

for (const role of ["planner", "worker", "reviewer", "approver", "review_split", "sub_reviewer"]) {
  test("signed-out WebGPT " + role + " cannot connect or dispatch", async () => {
    for (const connected of [false, true]) {
      const world = webRole(role, async () => ({ authenticated: false, ready: true }), connected);
      await assert.rejects(world.workflow.call(connected ? "advance" : "connect_harness", world.input), /sign in.*ChatGPT/i);
      assert.equal(world.calls.length, 0, "no model connection or execute may be submitted");
    }
  });
}
test("WebGPT readiness fails closed when missing, unknown or unavailable", async () => {
  for (const readiness of [undefined, async () => ({}), async () => ({ authenticated: true, ready: false }),
    async () => { throw new Error("Host unavailable"); }]) {
    const world = webRole("planner", readiness, true);
    await assert.rejects(world.workflow.call("advance", world.input), /browser.*ready|readiness|unavailable/i);
    assert.equal(world.calls.length, 0);
  }
});
test("authenticated WebGPT admission is checked fresh on each dispatch", async () => {
  let authenticated = true, checks = 0;
  const world = webRole("worker", async () => { checks++; return { authenticated, ready: true }; }, true);
  await world.workflow.call("advance", world.input);
  assert.equal(world.calls.length, 1);
  authenticated = false;
  await assert.rejects(world.workflow.call("advance", world.input), /sign in.*ChatGPT/i);
  assert.equal(world.calls.length, 1);
  assert.equal(checks, 2);
});

test("signed-out browser blocks background start before a run grant", async () => {
  const endpoints = [];
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    webBridgeReadiness: async () => ({ authenticated: false, ready: true }),
    requestHeadless: async endpoint => {
      endpoints.push(endpoint);
      return { ok: true, runs: [{ id: "run", workspace_id: "ws", revision: 1, nodes: [
        { id: "worker", role: "worker", parents: [], state: "pending",
          route: { harness_id: "codex-native", provider_id: "chatgpt-web", model: "chatgpt-web/high" } }] }] };
    },
  });
  // Returned, not thrown, so the reason survives IPC (a thrown error arrives as a transport failure).
  const blocked = await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /sign in.*ChatGPT/i);
  assert.deepEqual(endpoints, ["/api/v1/ao/read"]);
});

test("background dispatch detects logout after initial admission and holds without execution", async () => {
  const endpoints = [];
  let authenticated = true;
  const mission = { id: "run", workspace_id: "ws", revision: 1, nodes: [
    { id: "worker", role: "worker", parents: [], state: "pending",
      route: { harness_id: "codex-native", provider_id: "chatgpt-web", model: "chatgpt-web/high" } }] };
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    webBridgeReadiness: async () => ({ authenticated, ready: true }),
    requestHeadless: async endpoint => {
      endpoints.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint === "/api/v1/ao/grant") {
        authenticated = false;
        return { ok: true, run: mission, grant: { executable_sha256: "a".repeat(64) } };
      }
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: true, model: "chatgpt-web/high" } };
      throw new Error("Unexpected endpoint " + endpoint);
    },
  });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  let status;
  for (let tries = 0; tries < 20; tries++) {
    status = await workflow.call("run_status", { workspaceId: "ws", runId: "run" });
    if (status.status === "held") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.status, "held");
  assert.match(status.detail, /sign in.*ChatGPT/i);
  assert.equal(endpoints.some(endpoint => /connect|execute|reserve$/.test(endpoint)), false);
});

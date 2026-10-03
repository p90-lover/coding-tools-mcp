"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAgentOrchestratorWorkflow, resolveAoNativeConnection } = require("../electron/agent-orchestrator-workflow.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");

test("team settings use their local UI operation and cannot be changed through mission graph tools", async () => {
  const requests = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: async (endpoint, body, options) => {
    requests.push({ endpoint, body, options });
    return { ok: true, team: { id: "team", workspace_id: "ws-1", revision: 1 } };
  } });
  await assert.rejects(workflow.call("update_run", { workspaceId: "ws-1", change: { operation: "set_limits", max_workers: 24 } }), /supported AO graph/);
  const result = await workflow.call("team_update", { workspaceId: "ws-1", change: { operation: "save_team", expected_revision: 0, team: { id: "team", workspace_id: "ws-1" } } });
  assert.equal(result.team.revision, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endpoint, "/api/v1/ao/update");
  assert.deepEqual(requests[0].options, { localConfirmation: true });
  assert.equal(requests[0].body.workspace_id, "ws-1");
});

test("AO board list and detail responses remain valid across the renderer IPC boundary", async () => {
  const task = { id: "task-1", title: "Read-only task", state: "backlog", step: 0, clauses: [] };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (_endpoint, body) => ({ ok: true, operation: { state: "completed", result: {
      ok: true, revision: 1, workspace_id: "ws-1", steps: ["Plan"],
      ...(body.arguments.task_id ? { task } : { tasks: [task] }),
    } } }),
  });
  const host = createCodingToolsAppsHost({ services: {
    agentOrchestrator: (operation, args) => workflow.call(operation, args),
  } });
  const ipc = { invoke: (_channel, payload) => host.call(payload.moduleId, payload.operation, payload.arguments) };
  const list = await invokeContract(ipc, "apps.call", {
    moduleId: "agent-orchestrator", operation: "board", arguments: { workspaceId: "ws-1" },
  });
  assert.equal(list.result.tasks.length, 1);
  assert.equal(list.result.task, null);
  const detail = await invokeContract(ipc, "apps.call", {
    moduleId: "agent-orchestrator", operation: "board", arguments: { workspaceId: "ws-1", taskId: "task-1" },
  });
  assert.deepEqual(detail.result.tasks, []);
  assert.equal(detail.result.task.id, "task-1");
});

test("AO keeps manual clauses and applies revisioned mission edits without a second dialog", async () => {
  const task = { id: "old", title: "Improve workflow", state: "in_progress", step: 1, clauses: [] };
  let revision = 4;
  let grants = 0;
  let aoUpdates = 0;
  const confirmations = [];
  const requestHeadless = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/read") {
      assert.equal(body.workspace_id, "ws-1");
      return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [] }], board_revision: revision };
    }
    if (endpoint === "/api/v1/ao/update") {
      assert.deepEqual(options, { localConfirmation: true });
      assert.equal(body.workspace_id, "ws-1");
      assert.equal(body.change.operation, "cancel");
      aoUpdates += 1;
      return { ok: true, run: { id: "run-1", workspace_id: "ws-1", cancelled: true } };
    }
    assert.equal(endpoint, "/api/v1/tools/call");
    const args = body.arguments;
    let result;
    if (body.tool === "workflow_list") {
      result = { ok: true, revision, workspace_id: "ws-1", steps: ["Specification", "Plan"],
        ...(args.task_id ? { task } : { tasks: [task] }) };
    } else if (body.tool === "request_permissions") {
      grants += 1;
      result = { ok: true, approval_token: "local-grant" };
    } else if (body.tool === "workflow_update" && !args.approval_token) {
      result = { ok: false, error: { code: "APPROVAL_REQUIRED", details: { request_id: "scoped-request" } } };
    } else if (body.tool === "workflow_update") {
      assert.equal(args.expected_revision, 4);
      assert.equal(args.approval_token, "local-grant");
      assert.equal(args.change.operation, "append_clauses");
      task.clauses = args.change.clauses.map((clause, index) => ({
        id: `clause-${index}`, ...clause, state: "backlog",
      }));
      revision += 1;
      result = { ok: true };
    } else {
      throw new Error("Unexpected tool");
    }
    return { ok: true, operation: { state: "completed", result } };
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless,
    cpaConnection: () => { throw new Error("CPA is not an AO planner"); },
    confirm: async (prompt) => { confirmations.push(prompt.message); return true; },
    fetchImpl: () => { throw new Error("AO board must not call a model"); },
  });
  const host = createCodingToolsAppsHost({
    services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) },
  });
  assert.ok(host.list().modules.some((module) => module.id === "agent-orchestrator"));
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.some((operation) => operation.name === "plan"), false);
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.find((operation) => operation.name === "run_status")?.readOnly, true);
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.find((operation) => operation.name === "start_run")?.readOnly, false);
  const saved = (await host.call("agent-orchestrator", "append", {
    workspaceId: "ws-1", taskId: "old", expectedRevision: 4,
    clauses: [{ title: "Plan boundaries", detail: "List scopes" }],
  })).result;
  assert.equal(saved.revision, 5);
  assert.equal(task.clauses.length, 1);
  assert.equal(grants, 1);
  const runs = (await host.call("agent-orchestrator", "runs", { workspaceId: "ws-1" })).result;
  assert.equal(runs.runs[0].id, "run-1");
  const changed = (await host.call("agent-orchestrator", "update_run", {
    workspaceId: "ws-1",
    change: { operation: "cancel", run_id: "run-1", expected_revision: 1 },
  })).result;
  assert.equal(changed.run.cancelled, true);
  assert.equal(aoUpdates, 1);
  assert.deepEqual(confirmations, ["Add clauses to this Coding Tools plan?"]);
});

test("AO readiness requires both the task and its clauses to be complete", () => {
  const { presentTask } = require("../../app-handler/agent-orchestrator/kanban.cjs");
  const task = { state: "done", step: 7, clauses: [{ state: "backlog" }] };
  assert.equal(presentTask(task).lane, "needs_review");
  task.state = "in_progress";
  task.clauses[0].state = "done";
  assert.equal(presentTask(task).lane, "needs_review");
  task.state = "done";
  assert.equal(presentTask(task).lane, "ready");
});

test("AO worker passes the managed CPA key to its child only after exact-model and local approval", async () => {
  const sentinel = "SENTINEL_KEY_DO_NOT_LOG_1234567890";
  const calls = [];
  const confirmations = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", nodes: [{
          id: "worker", role: "worker", state: "pending",
          route: { harness_id: "codex-native", provider_id: "cliproxyapi-antigravity",
            account_id: "shared-cpa-pool", model: "gemini-3.8-flash-high",
            permission_profile: ":read-only" },
        }],
      }] };
      assert.equal(endpoint, "/api/v1/ao/harness/connect");
      calls.push({ body, options });
      return { ok: true, owned: true, route_verified: false,
        status: { connected: true, model: "gemini-3.8-flash-high" } };
    },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: sentinel }),
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:\\ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only",
      request_limit: 2, lifetime_seconds: 120 }),
    confirm: async (details) => { confirmations.push(details); return true; },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8317/v1/models");
      assert.equal(options.headers.Authorization, `Bearer ${sentinel}`);
      return { ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }] }) };
    },
  });
  await assert.rejects(workflow.call("connect_harness", {
    workspaceId: "ws-1", runId: "run-1", nodeId: "worker", executable: "C:\\codex.exe",
    proxyApiKey: sentinel,
  }), /renderer credential/i);
  assert.equal(calls.length, 0);
  const result = await workflow.call("connect_harness", {
    workspaceId: "ws-1", runId: "run-1", nodeId: "worker", executable: "C:\\codex.exe",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { localConfirmation: true });
  assert.equal(calls[0].body.private_proxy_api_key, sentinel);
  assert.equal(calls[0].body.connection.model, "gemini-3.8-flash-high");
  assert.equal(result.status.model, "gemini-3.8-flash-high");
  assert.equal(JSON.stringify({ result, confirmations }).includes(sentinel), false);
});

test("AO WebGPT connect uses the selected Codex bundled catalog without a CPA key", async () => {
  const calls = [];
  let confirmed = false;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", nodes: [{ id: "planner", role: "planner", state: "pending",
          route: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
            model: "chatgpt-web/high", permission_profile: ":read-only" } }],
      }] };
      calls.push(body);
      return { ok: true, owned: true, status: { model: "chatgpt-web/high" } };
    },
    cpaConnection: () => { throw new Error("WebGPT must not request a CPA key"); },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webModelCatalog: async ({ executable, model }) => {
      assert.equal(confirmed, true, "do not launch a selected executable before local approval");
      assert.equal(executable, "C:\\codex.exe");
      assert.equal(model, "chatgpt-web/high");
      return { models: [{ slug: "chatgpt-web/high", visibility: "list" }] };
    },
    resolveHarness: async () => ({ executable: "C:\\codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:\\ao-home", model: "chatgpt-web/high", allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only", request_limit: 2, lifetime_seconds: 120 }),
    confirm: async () => { confirmed = true; return true; },
    fetchImpl: async () => { throw new Error("AO WebGPT catalog must not require a bearer token"); },
  });
  await workflow.call("connect_harness", {
    workspaceId: "ws-1", runId: "run-1", nodeId: "planner", executable: "C:\\codex.exe",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].web_bridge_base_url, "http://127.0.0.1:17841/v1");
  assert.deepEqual(calls[0].web_model_catalog, { models: [{ slug: "chatgpt-web/high", visibility: "list" }] });
  assert.equal(calls[0].private_proxy_api_key, undefined);
});

test("AO WebGPT catalog serves Luna from a Luna-only account's template and renames any tier", () => {
  const { aoWebCatalogForModel } = require("../electron/agent-orchestrator-workflow.cjs");
  // A Free/Go (Luna-only) account's runtime has no High row; its Luna row is the template.
  const luna = { slug: "chatgpt-web/luna", display_name: "ChatGPT Web — Luna", context_window: 1050000 };
  assert.deepEqual(aoWebCatalogForModel({ models: [luna] }, "chatgpt-web/luna"), { models: [luna] });
  assert.deepEqual(aoWebCatalogForModel({ models: [luna] }, "chatgpt-web/think").models[0],
    { ...luna, slug: "chatgpt-web/think", display_name: "ChatGPT Web — Think" });
  const high = { slug: "chatgpt-web/high", display_name: "ChatGPT Web — High" };
  assert.deepEqual(aoWebCatalogForModel({ models: [high] }, "chatgpt-web/luna").models[0],
    { ...high, slug: "chatgpt-web/luna", display_name: "ChatGPT Web — Luna" });
  assert.deepEqual(aoWebCatalogForModel({ models: [high] }, "chatgpt-web/extra-high").models[0].display_name, "ChatGPT Web — Extra High");
  assert.throws(() => aoWebCatalogForModel({ models: [high] }, "gpt-5.5"), /invalid/);
  assert.throws(() => aoWebCatalogForModel({ models: [{ slug: "gpt-5.5" }] }, "chatgpt-web/luna"), /unavailable/);
  assert.throws(() => aoWebCatalogForModel({ models: [high, luna] }, "chatgpt-web/luna"), /unavailable/);
});

test("the desktop main process builds the AO WebGPT catalog through the shared tier helper", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  assert.match(main, /aoWebCatalogForModel\(JSON\.parse\(result\.stdout\), model\)/);
  assert.doesNotMatch(main, /catalog\.models\[0\]\?\.slug !== "chatgpt-web\/high"/);
  const cli = fs.readFileSync(path.join(__dirname, "../../runtime-web/src/cli.ts"), "utf8");
  assert.match(cli, /"chatgpt-web\/luna"/, "a Luna-only account still yields an AO WebGPT template");
});

test("a Luna orchestrator card connects on the Luna tier", async () => {
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", nodes: [{ id: "planner", role: "planner", state: "pending",
          route: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
            model: "chatgpt-web/luna", permission_profile: ":read-only" } }],
      }] };
      calls.push(body);
      return { ok: true, owned: true, status: { model: "chatgpt-web/luna" } };
    },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webModelCatalog: async ({ model }) => ({ models: [{ slug: model }] }),
    resolveHarness: async ({ model, permissionProfile }) => ({ executable: "C:\\codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:\\ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: permissionProfile, request_limit: 2, lifetime_seconds: 120 }),
    confirm: async () => true,
  });
  const result = await workflow.call("connect_harness", { workspaceId: "ws-1", runId: "run-1", nodeId: "planner", executable: "C:\\codex.exe" });
  assert.equal(result.status.model, "chatgpt-web/luna");
  assert.equal(calls[0].connection.model, "chatgpt-web/luna");
  assert.deepEqual(calls[0].web_model_catalog, { models: [{ slug: "chatgpt-web/luna" }] });
});

test("the role inspector lets every role choose any harness and model", () => {
  const editor = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8");
  assert.doesNotMatch(editor, /<span className="ao-chip">WebGPT High<\/span>/, "no fixed WebGPT High chip for non-workers");
  assert.match(editor, /<HarnessPicker route=\{role\.route\} harnesses=\{harnesses\}/, "orchestrator and reviewer see every harness");
  assert.doesNotMatch(editor, /item\.id === NATIVE_HARNESS\)/, "no role is limited to Native Codex");
  const team = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorTeam.tsx"), "utf8");
  assert.doesNotMatch(team, /nativeOnly/, "the team editor offers every harness too");
  const surface = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  assert.doesNotMatch(surface, /node\.route\.model === "chatgpt-web\/high" \? "WebGPT High"/, "cards name the chosen tier");
});

test("AO native resolver pins an executable and a distinct unopened home per node", async () => {
  const root = path.resolve(__dirname, "../../aiTemp/ao-native-resolver-tests", `${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const executable = path.join(root, "codex.exe");
  fs.writeFileSync(executable, "MZ fixture");
  const userData = path.join(root, "user-data");
  const input = { workspaceId: "qa", runId: "run-1", nodeId: "worker-a", executable,
    model: "gemini-3.8-flash-high", userData };
  const first = await resolveAoNativeConnection(input);
  const second = await resolveAoNativeConnection({ ...input, nodeId: "worker-b" });
  assert.equal(first.executable, fs.realpathSync.native(executable));
  assert.equal(first.expected_sha256, crypto.createHash("sha256").update("MZ fixture").digest("hex"));
  assert.equal(path.dirname(first.codex_home), path.join(userData, "headless", "ao-homes"));
  assert.match(path.basename(first.codex_home), /^[a-f0-9]{64}$/);
  assert.notEqual(first.codex_home, second.codex_home);
  assert.equal(fs.existsSync(first.codex_home), false, "inspection must not create an AO home before approval");
  assert.equal(first.permission_profile, ":read-only");
  assert.equal(first.allow_command_execution, false);
  // A card saved with Codex's workspace profile connects with it; nothing wider is accepted.
  const writable = await resolveAoNativeConnection({ ...input, permissionProfile: ":workspace" });
  assert.equal(writable.permission_profile, ":workspace");
  assert.equal(writable.allow_command_execution, false);
  await assert.rejects(resolveAoNativeConnection({ ...input, permissionProfile: ":danger-full-access" }), /read-only or workspace/);
  await assert.rejects(resolveAoNativeConnection({ ...input, executable: "relative-codex.exe" }), /absolute/i);
});

test("AO advances only a ready card and observes an existing reservation without replay", async () => {
  const calls = [];
  let state = "pending";
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", revision: 3, cancelled: false, nodes: [
          { id: "planner", role: "planner", task_id: "task-1", parents: [], state,
            route: { provider_id: "chatgpt-web", model: "chatgpt-web/high" } },
          { id: "worker", role: "worker", task_id: "task-1", parents: ["planner"], state: "pending",
            route: { provider_id: "cliproxyapi-antigravity", model: "gemini-3.8-flash-high" } },
        ],
      }] };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, owned: true,
        status: { connected: true, model: "chatgpt-web/high" } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        assert.deepEqual(options, { localConfirmation: true });
        assert.equal(body.expected_revision, 3);
        assert.equal(body.node_id, "planner");
        state = "reserved";
        return { ok: true, receipt: { status: "submitted" } };
      }
      if (endpoint === "/api/v1/ao/harness/observe") return { ok: true,
        receipt: { status: "submitted" } };
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    cpaConnection: () => { throw new Error("Planner must not use CPA"); },
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  const host = createCodingToolsAppsHost({
    services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) },
  });
  assert.equal((await host.call("agent-orchestrator", "advance", input)).result.receipt.status, "submitted");
  assert.equal((await workflow.call("advance", input)).receipt.status, "submitted");
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/execute").length, 1);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/observe").length, 1);
});

test("a held sibling does not block an independent ready AO worker", async () => {
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", revision: 8, cancelled: false, nodes: [
          { id: "planner", state: "finished", parents: [] },
          { id: "held", state: "held", parents: ["planner"] },
          { id: "ready", role: "worker", state: "pending", parents: ["planner"],
            route: { model: "gemini-3.8-flash-high" } },
        ],
      }] };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true,
        status: { connected: true, model: "gemini-3.8-flash-high" } };
      if (endpoint === "/api/v1/ao/harness/execute") return { ok: true,
        receipt: { status: "submitted" } };
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    confirm: async () => true,
  });
  await workflow.call("advance", { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" });
  assert.equal(calls.some((call) => call.endpoint === "/api/v1/ao/harness/observe"), false);
  assert.equal(calls.find((call) => call.endpoint === "/api/v1/ao/harness/execute")?.body.node_id, "ready");
});

test("AO tool approval is scoped to a visible pending request and needs local confirmation", async () => {
  const calls = [];
  const prompts = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: {
        pending_approvals: [{ approval_id: "approval-1", kind: "command", command: "Get-Content tool-check.txt", cwd: "C:\\project", reason: "Read file", permissions: { additionalPermissions: null, networkApprovalContext: null } }],
      } };
      if (endpoint === "/api/v1/ao/harness/approval") return { ok: true,
        result: { ok: true, approved: false, scope: "once" } };
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    confirm: async prompt => { prompts.push(prompt); return true; },
  });
  const input = { workspaceId: "ws-1", runId: "run-1", nodeId: "planner", approvalId: "approval-1", allow: false };
  await assert.rejects(workflow.call("approve_harness", { ...input, approvalId: "forged" }), /pending/i);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/approval").length, 0);
  const result = await workflow.call("approve_harness", input);
  assert.equal(result.result.approved, false);
  const approved = calls.find((item) => item.endpoint === "/api/v1/ao/harness/approval");
  assert.deepEqual(approved.options, { localConfirmation: true });
  assert.equal(approved.body.allow, false);
  assert.equal(approved.body.approval_id, "approval-1");
  assert.match(prompts[0].detail, /Get-Content tool-check\.txt/);
  assert.match(prompts[0].detail, /C:\\project/);
  assert.doesNotMatch(JSON.stringify(approved.body), /acceptForSession|execpolicy/);
});

test("AO granted run dispatches parallel workers after focus loss and finishes each saved stage once", async () => {
  const roles = ["planner", "worker", "reviewer"];
  const nodes = roles.map((role, index) => ({
    id: role, role, state: "pending", parents: index ? [roles[index - 1]] : [],
    route: role === "worker"
      ? { harness_id: "codex-native", provider_id: "cliproxyapi-antigravity", account_id: "shared-cpa-pool", model: "gemini-3.8-flash-high", permission_profile: ":read-only" }
      : { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" },
  }));
  const run = { id: "run-1", workspace_id: "ws-1", project_id: "project-1", revision: 3, cancelled: false, nodes };
  nodes.splice(2, 0, { ...structuredClone(nodes[1]), id: "worker-two" });
  nodes[3].parents = ["worker", "worker-two"];
  let workersLaunched = 0;
  let peakWorkers = 0;
  const calls = [];
  let focused = true;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 2 - nodes.filter(node => node.role === "worker" && node.state === "running").length } };
      if (endpoint === "/api/v1/ao/grant") {
        assert.equal(focused, true);
        assert.deepEqual(options, { localConfirmation: true });
        assert.equal(body.expected_revision, 3);
        assert.equal(body.executable_sha256, "a".repeat(64));
        focused = false;
        return { ok: true, run: structuredClone(run), grant: { executable_sha256: "a".repeat(64) } };
      }
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
      if (endpoint === "/api/v1/ao/harness/connect") {
        assert.equal(focused, false);
        assert.equal(body.confirm, false);
        assert.equal(options?.localConfirmation, undefined);
        return { ok: true, owned: true, status: { connected: true, model: body.connection.model } };
      }
      if (endpoint === "/api/v1/ao/harness/execute") {
        assert.equal(focused, false);
        assert.equal(body.confirm, false);
        assert.equal(options?.localConfirmation, undefined);
        const node = nodes.find((entry) => entry.id === body.node_id);
        assert.equal(node.state, "pending");
        node.state = "running";
        if (node.role === "worker") { workersLaunched++; peakWorkers = Math.max(peakWorkers, nodes.filter(node => node.role === "worker" && node.state === "running").length); }
        node.receipt = { status: "submitted" };
        run.revision += 1;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        const node = nodes.find((entry) => entry.id === body.node_id);
        if (node.role === "worker" && workersLaunched < 2) return { ok: true, run: structuredClone(run), receipt: node.receipt };
        node.state = "finished";
        node.receipt = { status: "completed", answer: "READY" };
        run.revision += 1;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "SENTINEL_PRIVATE_KEY_12345678901234567890" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64),
      codex_home: "C:\\ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only", request_limit: 3, lifetime_seconds: 900 }),
    confirm: async () => { throw new Error("Start mission must not open a second confirmation dialog"); },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }] }) }),
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  await assert.rejects(workflow.call("start_run", { ...input, proxyApiKey: "SENTINEL_PRIVATE_KEY" }), /renderer credential/i);
  assert.equal(calls.length, 0);
  assert.deepEqual(await workflow.call("start_run", input), { ok: true, started: true, status: "running" });
  assert.equal((await workflow.call("start_run", input)).started, false, "duplicate clicks do not create a second loop");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.deepEqual(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/execute").map((item) => item.body.node_id), ["planner", "worker", "worker-two", "reviewer"]);
  assert.equal(peakWorkers, 2);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/grant").length, 1);
  assert.equal(JSON.stringify(await workflow.call("run_status", input)).includes("SENTINEL_PRIVATE_KEY"), false);
});

test("AO restart sees a reserved turn as held and never resubmits it", async () => {
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", revision: 5, cancelled: false,
        nodes: [{ id: "planner", role: "planner", state: "reserved", parents: [],
          receipt: { request_key: "ao-first-send", status: "reserved" } }],
      }] };
      throw new Error("A reserved turn must not be sent again");
    },
    confirm: async () => { throw new Error("Do not request another grant for a reserved turn"); },
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  assert.deepEqual(await workflow.call("run_status", input), { ok: true, status: "held" });
  await assert.rejects(workflow.call("start_run", input), /active or unresolved card/i);
  assert.deepEqual(calls, ["/api/v1/ao/read", "/api/v1/ao/read"]);
});

test("AO explicit resume observes an existing granted turn without a new grant or send", async () => {
  const route = { model: "chatgpt-web/high" };
  const nodes = [
    { id: "planner", state: "finished", parents: [], route },
    { id: "worker", state: "finished", parents: ["planner"], route },
    { id: "reviewer", role: "reviewer", state: "running", parents: ["worker"],
      route, receipt: { request_key: "ao-original-send", status: "submitted" } },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", revision: 8, nodes,
    grant: { executable_sha256: "a".repeat(64) } };
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 3 } };
      if (endpoint === "/api/v1/ao/harness/observe") {
        nodes[2].state = "finished";
        return { ok: true, run: structuredClone(run), receipt: { status: "completed" } };
      }
      throw new Error("Resume must observe the original turn only");
    },
    resolveHarness: async () => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64) }),
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  assert.equal((await workflow.call("start_run", input)).started, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.deepEqual(calls.filter((endpoint) => endpoint !== "/api/v1/ao/read"), ["/api/v1/ao/harness/observe"]);
});

test("AO background waits for an explicit tool decision without approving it", async () => {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":read-only" };
  const nodes = [
    { id: "planner", role: "planner", state: "finished", parents: [], route },
    { id: "worker", role: "worker", state: "finished", parents: ["planner"], route },
    { id: "reviewer", role: "reviewer", state: "pending", parents: ["worker"], route },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", revision: 5, nodes };
  let toolAnswered = false;
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 3 } };
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: structuredClone(run),
        grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
      if (endpoint === "/api/v1/ao/harness/connect") return { ok: true, status: { model: route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        nodes[2].state = "running";
        run.revision += 1;
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        if (toolAnswered) nodes[2].state = "finished";
        return { ok: true, run: structuredClone(run),
          pending_approvals: toolAnswered ? [] : [{ approval_id: "approval-1" }] };
      }
      throw new Error(`Unexpected ${endpoint} ${body.node_id}`);
    },
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64),
      model, allow_model_usage: true, allow_command_execution: false, permission_profile: ":read-only" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  await workflow.call("start_run", input);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await workflow.call("run_status", input)).detail === "Waiting for your tool approval") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).detail, "Waiting for your tool approval");
  assert.equal(calls.includes("/api/v1/ao/harness/approval"), false);
  toolAnswered = true;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.equal(calls.filter((endpoint) => endpoint === "/api/v1/ao/harness/execute").length, 1);
});

test("AO background runs report progress, approval waits and errors to the MCP event observer", async () => {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":read-only" };
  const nodes = [
    { id: "planner", role: "planner", state: "finished", parents: [], route },
    { id: "reviewer", role: "reviewer", state: "pending", parents: ["planner"], route },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", revision: 5, nodes };
  let toolAnswered = false;
  const reports = [];
  const make = (overrides = {}) => createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 3 }, ...overrides.read };
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: structuredClone(run), grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
      if (endpoint === "/api/v1/ao/harness/connect") return { ok: true, status: { model: route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") { nodes[1].state = "running"; run.revision += 1; return { ok: true, run: structuredClone(run) }; }
      if (endpoint === "/api/v1/ao/harness/observe") {
        if (toolAnswered) nodes[1].state = "finished";
        return { ok: true, run: structuredClone(run), pending_approvals: toolAnswered ? [] : [{ approval_id: "approval-1" }] };
      }
      throw new Error(`Unexpected ${endpoint}`);
    },
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64),
      model, allow_model_usage: true, allow_command_execution: false, permission_profile: ":read-only" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    confirm: async () => true,
    onRunState: (update) => {
      reports.push(update);
      throw new Error("observer failures never affect the run");
    },
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  const workflow = make();
  await workflow.call("start_run", input);
  for (let attempt = 0; attempt < 40 && !reports.some((r) => r.attention === "pending_approval"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const waiting = reports.find((r) => r.attention === "pending_approval");
  assert.equal(waiting.workspaceId, "ws-1");
  assert.equal(waiting.runId, "run-1");
  assert.equal(waiting.status, "running");
  assert.equal(waiting.fingerprint, "planner:finished,reviewer:running");
  toolAnswered = true;
  for (let attempt = 0; attempt < 70 && reports.at(-1)?.status !== "finished"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reports.at(-1).status, "finished");
  assert.equal(reports.at(-1).attention, null);

  reports.length = 0;
  nodes[1].state = "pending";
  const broken = make({ read: { worker_capacity: undefined } });
  await broken.call("start_run", input);
  for (let attempt = 0; attempt < 40 && !reports.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reports[0].attention, "error");
  assert.equal(reports[0].status, "held");
  assert.match(reports[0].detail, /worker capacity/);
});

test("AO harness workers run as AO sessions and return their answer as the card receipt", async () => {
  const calls = [];
  const spawned = [];
  let worker = { id: "worker", role: "worker", task_id: "task-1", parents: ["planner"], state: "pending",
    route: { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "default", permission_profile: ":ao-default" } };
  let turn = { turnId: "turn-1", turnState: "running", answer: "" };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", revision: 4, cancelled: false, nodes: [
        { id: "planner", role: "planner", task_id: "task-1", parents: [], state: "finished", route: { provider_id: "chatgpt-web", model: "chatgpt-web/high" } },
        worker,
      ] }] };
      if (endpoint === "/api/v1/ao/external/reserve") {
        assert.deepEqual(options, { localConfirmation: true });
        assert.equal(body.confirm, true);
        worker = { ...worker, state: "reserved", receipt: { request_key: "ao-key", status: "reserved" } };
        return { ok: true, request_key: "ao-key", prompt: "Do the task" };
      }
      if (endpoint === "/api/v1/ao/external/submitted") {
        assert.equal(body.request_key, "ao-key");
        worker = { ...worker, state: "running", receipt: { request_key: "ao-key", status: "submitted", thread_id: body.session_id } };
        return { ok: true, run: { id: "run-1" } };
      }
      if (endpoint === "/api/v1/ao/external/terminal") {
        assert.deepEqual({ ...body }, { workspace_id: "ws-1", run_id: "run-1", node_id: "worker", session_id: "sess-1",
          turn_id: "turn-1", answer: "Done with evidence", completed: true });
        worker = { ...worker, state: "finished" };
        return { ok: true, receipt: { status: "completed" } };
      }
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    aoHarness: {
      spawn: async (input) => { spawned.push(input); return "sess-1"; },
      observe: async () => turn,
      catalog: async () => [{ id: "claude-code", label: "Claude Code", installed: true, chat: true, authStatus: "authorized" },
        { id: "aider", label: "Aider", installed: true, chat: false }],
      models: async () => [{ id: "sonnet" }],
      interrupt: async () => undefined,
    },
    cpaConnection: () => { throw new Error("AO harness workers must not use CPA"); },
    confirm: async () => true,
  });
  const catalog = await workflow.call("harnesses");
  // Any installed AO agent is selectable; agents without chat mode run in their terminal UI.
  assert.deepEqual(catalog.harnesses.map((item) => [item.id, item.runnable, item.chat]),
    [["codex-native", true, undefined], ["ao:claude-code", true, true], ["ao:aider", true, false]]);
  assert.deepEqual((await workflow.call("models", { harness: "ao:claude-code", workspaceId: "ws-1" })).models, ["sonnet"], "\"default\" is never offered");
  await workflow.call("advance", { workspaceId: "ws-1", runId: "run-1", executable: "C:\codex.exe" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].agent, "claude-code");
  assert.equal(spawned[0].prompt, "Do the task");
  assert.equal((await workflow.call("observe", { workspaceId: "ws-1", runId: "run-1", nodeId: "worker" })).pending_approvals.length, 0);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/external/terminal").length, 0);
  turn = { turnId: "turn-1", turnState: "completed", answer: "Done with evidence" };
  assert.equal((await workflow.call("observe", { workspaceId: "ws-1", runId: "run-1", nodeId: "worker" })).receipt.status, "completed");
  assert.equal(calls.filter((item) => item.endpoint.startsWith("/api/v1/ao/harness/")).length, 0);
});

test("Native Codex offers only WebGPT, every tier with Luna included; CPA models run on AO harnesses", async () => {
  const WEB = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro",
    "chatgpt-web/luna", "chatgpt-web/think"];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }, { id: "claude-sonnet-4-6" }, { id: "gpt-5.5" }] }) }),
    confirm: async () => true,
  });
  assert.deepEqual((await workflow.call("models", { harness: "codex-native" })).models, WEB,
    "CPA pool models run on an AO harness through the gateway, never on Native Codex");
  const offline = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => null, confirm: async () => true,
  });
  assert.deepEqual((await offline.call("models", { harness: "codex-native" })).models, WEB);
});

test("WebGPT is offered only on Native Codex; AO harnesses get every other CPA model", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }, { id: "chatgpt-web/high" }, { id: "chatgpt-web/luna" }] }) }),
    // AO's Codex agent reports WebGPT from the user's Codex config, but cannot run it.
    aoHarness: { catalog: async () => [{ id: "codex", label: "Codex", installed: true, chat: true }], models: async () => [{ id: "gpt-5.5" }, { id: "chatgpt-web/high" }] },
    confirm: async () => true,
  });
  assert.deepEqual((await workflow.call("harnesses")).harnesses.map((item) => [item.id, item.label]),
    [["codex-native", "Native Codex"], ["ao:codex", "Codex"]]);
  assert.deepEqual((await workflow.call("models", { harness: "ao:codex", workspaceId: "ws-1" })).models,
    ["gpt-5.5", "cpa/gemini-3.8-flash-high"]);
  assert.ok((await workflow.call("models", { harness: "codex-native" })).models.includes("chatgpt-web/high"));
});

test("CPA models go only to agents that can use them through the gateway", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gpt-5.5" }, { id: "gemini-3.8-flash-high" }, { id: "gemini-3.1-pro-low" }] }) }),
    aoHarness: { catalog: async () => [], models: async () => [{ id: "own-model" }] },
    confirm: async () => true,
  });
  // Aider has no gateway launch support: its own models only.
  assert.deepEqual((await workflow.call("models", { harness: "ao:aider" })).models, ["own-model"]);
  // agy's gateway mode sends no tools for CPA's model names, so it keeps its own models.
  assert.deepEqual((await workflow.call("models", { harness: "ao:agy" })).models, ["own-model"]);
  assert.deepEqual((await workflow.call("models", { harness: "ao:claude-code" })).models,
    ["own-model", "cpa/gpt-5.5", "cpa/gemini-3.8-flash-high", "cpa/gemini-3.1-pro-low"]);
});

// A fake headless service holding one workspace's board, runs and team.
function chatWorld({ runs = [], tasks = [] } = {}) {
  const state = { revision: 3, tasks: tasks.map((task) => ({ ...task })), runs, updates: [], edits: [] };
  const requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/tools/call") {
      const args = body.arguments;
      if (body.tool === "workflow_list") {
        const listed = state.tasks.map(({ description, ...rest }) => rest);
        return { operation: { state: "completed", result: { ok: true, revision: state.revision, workspace_id: "ws-1", steps: [],
          ...(args.task_id ? { task: state.tasks.find((task) => task.id === args.task_id) ?? null } : { tasks: listed }) } } };
      }
      assert.equal(args.expected_revision, state.revision);
      if (args.change.operation === "create") state.tasks.push({ id: `task-${state.tasks.length + 1}`, title: args.change.title, description: args.change.description, state: "backlog", clauses: [] });
      if (args.change.operation === "edit") { state.edits.push(args.change); Object.assign(state.tasks.find((task) => task.id === args.change.id), { title: args.change.title, description: args.change.description }); }
      state.revision += 1;
      return { operation: { state: "completed", result: { ok: true } } };
    }
    if (endpoint === "/api/v1/ao/read") {
      const pending = body.run_id ? [{ id: body.run_id, workspace_id: "ws-1", revision: 1, nodes: [{ id: "lead", state: "pending", route: { model: "chatgpt-web/high" } }] }] : state.runs;
      return { ok: true, runs: pending, team: { id: "team-1", revision: 7, worker_limit: 2 } };
    }
    if (endpoint === "/api/v1/ao/update") {
      state.updates.push(body.change);
      return { ok: true, run: { id: body.change.run_id, workspace_id: "ws-1" } };
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  return state.requestHeadless = requestHeadless, state;
}

test("a first chat message creates 'New task' and starts a team run on it with the installed Codex", async () => {
  const world = chatWorld();
  const seen = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless,
    findCodexExecutable: () => "C:\Codex\codex.exe",
    resolveHarness: async (input) => { seen.push(input.executable); throw new Error("stop before the background loop"); },
  });
  const sent = await workflow.call("chat_send", { workspaceId: "ws-1", message: "fix the email dots" });
  // A failed start still returns the chat, so the UI can open it and show why.
  assert.equal(sent.taskId, "task-1");
  assert.equal(sent.status, "failed");
  assert.match(sent.detail, /stop before the background loop/);
  assert.deepEqual(world.tasks.map((task) => [task.title, task.description]), [["New task", "fix the email dots"]]);
  assert.equal(world.updates.length, 1);
  assert.equal(world.updates[0].operation, "create_from_team");
  assert.equal(world.updates[0].task_id, "task-1");
  assert.equal(world.updates[0].expected_board_revision, 4);
  assert.equal(world.updates[0].team_revision, 7);
  assert.equal(world.updates[0].worker_limit, 2);
  assert.deepEqual(seen, ["C:\Codex\codex.exe"]);
});

test("a follow-up waits for the chat's run, then extends the same task and starts a new run", async () => {
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const busy = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", cancelled: false, nodes: [{ state: "running" }] }] });
  const blocked = createAgentOrchestratorWorkflow({ requestHeadless: busy.requestHeadless, findCodexExecutable: () => "C:\c.exe" });
  await assert.rejects(blocked.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "also add tests" }), /still running/);
  assert.equal(busy.edits.length, 0);

  const done = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", cancelled: false, nodes: [{ state: "finished" }] }] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: done.requestHeadless, findCodexExecutable: () => "C:\c.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); } });
  assert.equal((await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "also add tests" })).status, "failed");
  assert.equal(done.edits.length, 1);
  assert.equal(done.edits[0].title, "Fix auth");
  assert.match(done.edits[0].description, /^first ask\n\nFollow-up \([0-9-]+ [0-9:]+ UTC\):\nalso add tests$/);
  assert.equal(done.updates[0].task_id, "task-1");
});

test("without an installed Codex a chat send explains what to set", async () => {
  const world = chatWorld();
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => null });
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", message: "hi" }), /Codex CLI was not found; install it with npm install -g @openai\/codex/);
  assert.equal(world.tasks.length, 0, "nothing is created when the run could not start");
});

test("a saved codex.exe removed by a Codex update falls back to the installed one", async () => {
  const world = chatWorld();
  const seen = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless,
    findCodexExecutable: () => "C:/Codex/bin/new/codex.exe",
    exists: (file) => !file.includes("old"),
    resolveHarness: async (input) => { seen.push(input.executable); throw new Error("stop"); },
  });
  await workflow.call("chat_send", { workspaceId: "ws-1", message: "hi", executable: "C:/Codex/bin/old/codex.exe" });
  assert.deepEqual(seen, ["C:/Codex/bin/new/codex.exe"]);
  const kept = [];
  const chosen = createAgentOrchestratorWorkflow({ requestHeadless: chatWorld().requestHeadless, findCodexExecutable: () => "C:/x.exe",
    exists: () => true, resolveHarness: async (input) => { kept.push(input.executable); throw new Error("stop"); } });
  await chosen.call("chat_send", { workspaceId: "ws-1", message: "hi", executable: "D:/tools/codex.exe" });
  assert.deepEqual(kept, ["D:/tools/codex.exe"], "an existing chosen executable is kept");
});

function startableChatWorld() {
  const world = chatWorld();
  const base = world.requestHeadless;
  world.controls = [];
  world.requestHeadless = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: { id: body.run_id, workspace_id: "ws-1" }, grant: { executable_sha256: "a".repeat(64) } };
    if (endpoint === "/api/v1/ao/control") { world.controls.push(body.action); return { ok: true, run: { id: body.run_id, workspace_id: "ws-1", nodes: [] } }; }
    return base(endpoint, body, options);
  };
  return world;
}

async function until(check) {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("once its run starts, a 'New task' chat is renamed after what was asked", async () => {
  const world = startableChatWorld();
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless,
    findCodexExecutable: () => "C:/Codex/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    fetchImpl: async (url) => ({ ok: true, json: async () => (String(url).endsWith("/v1/models")
      ? { data: [{ id: "gpt-6-luna" }] }
      : { choices: [{ message: { content: "\"Fix unread email dots\"\n" } }] }) }),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }),
  });
  const sent = await workflow.call("chat_send", { workspaceId: "ws-1", message: "the unread dots in email are wrong" });
  assert.equal(sent.status, "running");
  await until(() => world.edits.length > 0);
  assert.deepEqual(world.edits.map((edit) => [edit.title, edit.description]), [["Fix unread email dots", "the unread dots in email are wrong"]]);
});

test("a chat the user named keeps its name, and without CPA the message names it", async () => {
  const named = startableChatWorld();
  const options = (world) => ({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await createAgentOrchestratorWorkflow(options(named)).call("chat_send", { workspaceId: "ws-1", title: "Mine", message: "do it" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(named.edits, []);

  const plain = startableChatWorld();
  await createAgentOrchestratorWorkflow(options(plain)).call("chat_send", { workspaceId: "ws-1", message: "add   dark mode to the settings page please now" });
  await until(() => plain.edits.length > 0);
  assert.equal(plain.edits[0].title, "add dark mode to the settings page please", "first 8 words");
});

test("starting a mission whose card is held retries that card first", async () => {
  let held = true;
  const controls = [];
  const requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/ao/read") return { ok: true, team: null, runs: [{ id: "r1", workspace_id: "ws-1", revision: 2, cancelled: false,
      nodes: [{ id: "lead", state: held ? "held" : "pending", route: { model: "chatgpt-web/high" }, receipt: held ? { error: "did not confirm" } : null }] }] };
    if (endpoint === "/api/v1/ao/control") { controls.push(body.action); held = false; return { ok: true, run: { id: "r1", workspace_id: "ws-1", nodes: [] } }; }
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: { id: "r1", workspace_id: "ws-1" }, grant: { executable_sha256: "a".repeat(64) } };
    throw new Error(`unexpected ${endpoint}`);
  };
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  const started = await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  assert.equal(started.status, "running");
  assert.deepEqual(controls, ["retry"]);
  await assert.rejects(workflow.call("control_run", { workspaceId: "ws-1", runId: "r1", action: "rewind" }), /Choose a mission control/);
});

function heldMissionWorld({ history = [], error = "ChatGPT did not confirm that the prompt was sent" } = {}) {
  const world = { reads: 0, controls: [], grants: 0, held: false };
  world.requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/ao/read") {
      world.reads += 1;
      // The first start sees a pending card; the loop then finds it held until a retry re-queues it.
      if (world.reads === 2 && !world.controls.length) world.held = true;
      return { ok: true, team: null, worker_capacity: { r1: 1 }, runs: [{ id: "r1", workspace_id: "ws-1", project_id: "task-1", revision: 2, cancelled: false,
        nodes: [{ id: "lead", role: "planner", state: world.held ? "held" : "pending", route: { model: "chatgpt-web/high", provider_id: "chatgpt-web" },
          history, receipt: world.held ? { error } : null }] }] };
    }
    if (endpoint === "/api/v1/ao/control") { world.controls.push(body.action); world.held = false; return { ok: true, run: { id: "r1", workspace_id: "ws-1", nodes: [] } }; }
    if (endpoint === "/api/v1/ao/grant") { world.grants += 1; return { ok: true, run: { id: "r1", workspace_id: "ws-1" }, grant: { executable_sha256: "a".repeat(64) } }; }
    if (endpoint === "/api/v1/tools/call") return { operation: { state: "completed", result: { ok: true, revision: 1, workspace_id: "ws-1", steps: [], task: { id: "task-1", title: "T", description: "d" } } } };
    throw new Error(`stop at ${endpoint}`);
  };
  return world;
}

test("a held card is handed to the recovery helper, which retries it and restarts the mission", async () => {
  const world = heldMissionWorld();
  const asked = [];
  const states = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/v1/models")) return { ok: true, json: async () => ({ data: [{ id: "gpt-6-luna" }] }) };
      asked.push(JSON.parse(init.body).messages[0].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"retry","reason":"The send timed out"}' } }] }) };
    },
    onRunState: (update) => states.push(update?.detail),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  await until(() => world.grants >= 2);
  assert.deepEqual(world.controls, ["retry"]);
  assert.equal(world.grants, 2, "the mission was started again after the retry");
  assert.match(asked[0], /did not confirm that the prompt was sent/);
});

test("the helper stops retrying a card that already failed three times", async () => {
  const world = heldMissionWorld({ history: [{}, {}] });
  let asked = 0;
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    fetchImpl: async () => { asked += 1; throw new Error("no"); },
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  await until(() => world.reads >= 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await workflow.call("run_status", { workspaceId: "ws-1", runId: "r1" });
  assert.deepEqual(world.controls, []);
  assert.equal(asked, 0);
  assert.match(JSON.stringify(status), /failed 3 times/);
});

test("missions run on the Codex CLI; the desktop app's bundled codex is only a fallback", () => {
  const { findInstalledCodexExecutable } = require("../electron/agent-orchestrator-workflow.cjs");
  const root = path.resolve(__dirname, "../../aiTemp/codex-cli-discovery", `${process.pid}-${crypto.randomUUID()}`);
  const env = { APPDATA: path.join(root, "Roaming"), LOCALAPPDATA: path.join(root, "Local") };
  const desktop = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "build1", "codex.exe");
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, "MZ desktop");
  if (process.platform === "win32") assert.equal(findInstalledCodexExecutable(env), desktop, "desktop copy only when no CLI");
  const arch = process.arch === "arm64" ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
  const cli = path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", arch[0], "vendor", arch[1], "bin", "codex.exe");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "MZ cli");
  if (process.platform === "win32") assert.equal(findInstalledCodexExecutable(env), cli, "the CLI wins once installed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a saved desktop-app codex.exe gives way to the Codex CLI, but another chosen codex.exe is kept", async () => {
  const local = process.env.LOCALAPPDATA || "C:/Users/test/AppData/Local";
  const desktop = path.join(local, "OpenAI", "Codex", "bin", "build1", "codex.exe");
  const cli = "C:/Users/test/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.exe";
  const seen = [];
  const make = () => createAgentOrchestratorWorkflow({ requestHeadless: chatWorld().requestHeadless,
    findCodexExecutable: () => cli, exists: () => true,
    resolveHarness: async (input) => { seen.push(input.executable); throw new Error("stop"); } });
  await make().call("chat_send", { workspaceId: "ws-1", message: "hi", executable: desktop });
  await make().call("chat_send", { workspaceId: "ws-1", message: "hi", executable: "D:/tools/codex.exe" });
  assert.deepEqual(seen, [cli, "D:/tools/codex.exe"]);
});

test("a follow-up to a chat whose last run is stuck stops that run and starts a new one", async () => {
  for (const state of ["pending", "held"]) {
    const world = chatWorld({
      tasks: [{ id: "task-1", title: "Fix dots", description: "fix the email dots", state: "backlog", clauses: [] }],
      runs: [{ id: "old-run", project_id: "task-1", workspace_id: "ws-1", revision: 4, cancelled: false,
        nodes: [{ id: "lead", state }, { id: "w1", state: "pending" }] }],
    });
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: world.requestHeadless,
      findCodexExecutable: () => "C:/Codex/codex.exe",
      resolveHarness: async () => { throw new Error("stop before the background loop"); },
    });
    const sent = await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "and the other dots" });
    assert.equal(sent.taskId, "task-1", state);
    assert.deepEqual(world.updates.map((change) => change.operation), ["cancel", "create_from_team"], state);
    assert.deepEqual(world.updates[0], { operation: "cancel", run_id: "old-run", expected_revision: 4 }, state);
    assert.match(world.tasks[0].description, /Follow-up \(.* UTC\):\nand the other dots$/, state);
  }
});

test("a follow-up still waits while the chat's last run has a card working", async () => {
  const world = chatWorld({
    tasks: [{ id: "task-1", title: "Fix dots", description: "fix the email dots", state: "backlog", clauses: [] }],
    runs: [{ id: "busy-run", project_id: "task-1", workspace_id: "ws-1", revision: 2, cancelled: false,
      nodes: [{ id: "lead", state: "finished" }, { id: "w1", state: "running" }] }],
  });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe" });
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "more" }), /still running/);
  assert.deepEqual(world.updates, []);
});

test("restart runs the same task again with the current team, stopping a stuck run first", async () => {
  for (const [state, cancelsFirst] of [["finished", false], ["held", true]]) {
    const world = chatWorld({
      tasks: [{ id: "task-1", title: "Fix dots", description: "fix the email dots", state: "backlog", clauses: [] }],
      runs: [{ id: "old-run", project_id: "task-1", workspace_id: "ws-1", revision: 5, cancelled: false,
        nodes: [{ id: "lead", state: "finished" }, { id: "w1", state }] }],
    });
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: world.requestHeadless,
      findCodexExecutable: () => "C:/Codex/codex.exe",
      resolveHarness: async () => { throw new Error("stop before the background loop"); },
    });
    const restarted = await workflow.call("restart_run", { workspaceId: "ws-1", runId: "old-run" });
    const expected = cancelsFirst ? ["cancel", "create_from_team"] : ["create_from_team"];
    assert.deepEqual(world.updates.map((change) => change.operation), expected, state);
    const created = world.updates.at(-1);
    assert.equal(created.task_id, "task-1", state);
    assert.equal(restarted.runId, created.run_id, state);
    assert.notEqual(restarted.runId, "old-run", state);
    assert.equal(restarted.status, "failed", "a failed start is reported, not thrown");
  }
});

test("restart refuses while the mission has a card working", async () => {
  const world = chatWorld({
    tasks: [{ id: "task-1", title: "Fix dots", description: "x", state: "backlog", clauses: [] }],
    runs: [{ id: "busy-run", project_id: "task-1", workspace_id: "ws-1", revision: 2, cancelled: false,
      nodes: [{ id: "lead", state: "finished" }, { id: "w1", state: "running" }] }],
  });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe" });
  await assert.rejects(workflow.call("restart_run", { workspaceId: "ws-1", runId: "busy-run" }), /still running/);
  assert.deepEqual(world.updates, []);
});

test("relinking or removing a working card stops its turn; an idle card is just relinked", async () => {
  for (const [state, stops] of [["running", true], ["pending", false]]) {
    const calls = [];
    const route = { harness_id: "codex-native", model: "gemini-3.8-flash-high" };
    const requestHeadless = async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [{ id: "w2", state, route }] }] };
      if (endpoint === "/api/v1/ao/update") return { ok: true, run: { id: "run-1", workspace_id: "ws-1", nodes: [{ id: "w2", state: "pending", route }] } };
      if (endpoint === "/api/v1/ao/harness/disconnect") { assert.equal(body.node_id, "w2"); return { ok: true }; }
      throw new Error(`unexpected ${endpoint}`);
    };
    const workflow = createAgentOrchestratorWorkflow({ requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe" });
    await workflow.call("update_run", { workspaceId: "ws-1", change: { operation: "graph", run_id: "run-1",
      expected_revision: 3, change: { operation: "set_parents", node_id: "w2", parents: ["planner"] } } });
    assert.equal(calls.includes("/api/v1/ao/harness/disconnect"), stops, state);
  }
});

test("activity reports each working card's runtime and current step without advancing the run", async () => {
  const calls = [];
  const native = { id: "w1", role: "worker", state: "running", route: { harness_id: "codex-native", provider_id: "chatgpt-web", model: "chatgpt-web/high" },
    receipt: { status: "submitted", thread_id: "thread-1", started_at_ms: 1_000 } };
  const stuck = { id: "w2", role: "worker", state: "running", route: { harness_id: "codex-native", provider_id: "chatgpt-web", model: "chatgpt-web/high" },
    receipt: { status: "submitted", thread_id: "thread-2", started_at_ms: 2_000 } };
  const agent = { id: "w3", role: "worker", state: "running", route: { harness_id: "ao:codex", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-6-luna", permission_profile: ":ao-default" },
    receipt: { status: "submitted", thread_id: "sess-3" } };
  const done = { id: "p", role: "planner", state: "finished", route: native.route, receipt: { status: "completed" } };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [done, native, stuck, agent] }] };
      if (endpoint === "/api/v1/ao/harness/status") {
        return { ok: true, status: { connected: true, threads: body.node_id === "w1"
          ? [{ id: "thread-1", turn_id: "turn-1", activity: "running a command", activity_at_ms: 5_000, last_event_at_ms: 6_000 }]
          : [{ id: "thread-2", turn_id: null, activity: null, started_at_ms: 2_000 }] } };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
    aoHarness: { observe: async () => ({ turnState: "running", turnId: "t-3" }) },
    confirm: async () => true,
  });
  const result = await workflow.call("activity", { workspaceId: "ws-1", runId: "run-1" });
  assert.deepEqual(Object.keys(result.nodes).sort(), ["w1", "w2", "w3"], "only working cards");
  assert.equal(result.nodes.w1.activity, "running a command");
  assert.equal(result.nodes.w1.last_event_at_ms, 6_000);
  assert.equal(result.nodes.w1.started_at_ms, 1_000);
  assert.equal(result.nodes.w2.activity, "waiting for the turn to start");
  assert.equal(result.nodes.w2.turn_started, false);
  assert.equal(result.nodes.w3.activity, "running");
  assert.ok(calls.every((endpoint) => endpoint === "/api/v1/ao/read" || endpoint === "/api/v1/ao/harness/status"), "read-only calls only");
});

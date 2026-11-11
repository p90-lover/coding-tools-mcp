"use strict";

// A permission mode (Ask / Approve for me / Full access) goes only to a harness that can honor it.
// 2026-11-10: a chat moved from Claude Code to Pi kept "Approve for me", the engine refused every
// launch ("This adapter cannot honor the saved permission tuple"), and Pi's permission menu offered
// no mode to pick instead, so the chat could never start.

require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8");
const editor = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { exports: editor, require: () => ({}), structuredClone });
const plain = (value) => JSON.parse(JSON.stringify(value));
const MODE_FIELDS = ["native_permission_profile", "approval_policy", "approvals_reviewer"];
const approveForMe = { native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
const claude = { ...editor.workerRoute("ao:claude-code", "cpa/gpt-6.1-sol"), ...approveForMe };

test("the renderer's permission harnesses are the engine's PERMISSION_AGENTS", () => {
  const engine = fs.readFileSync(path.resolve(__dirname, "../electron/agent-orchestrator-workflow.cjs"), "utf8");
  const agents = engine.match(/const PERMISSION_AGENTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(agents, "PERMISSION_AGENTS is still a literal list");
  const names = [...agents[1].matchAll(/"([^"]+)"/g)].map((match) => `ao:${match[1]}`).sort();
  assert.deepEqual([...editor.PERMISSION_HARNESSES].sort(), names, "a new agent that takes the modes is added to both lists");
});

test("a mode carried to Pi, opencode or Unreal is dropped; Claude Code, Codex, agy and Native Codex keep it", () => {
  for (const harness of ["ao:pi", "ao:opencode", "ao:unreal-agent"]) {
    const next = editor.withTuning(editor.workerRoute(harness, "cpa/gpt-6.1-sol"), claude);
    for (const field of MODE_FIELDS) assert.equal(Object.hasOwn(next, field), false, `${harness} gets no ${field}`);
    assert.equal(next.permission_profile, ":ao-default");
  }
  for (const harness of ["ao:codex", "ao:agy"]) {
    const next = editor.withTuning(editor.workerRoute(harness, "cpa/gpt-6.1-sol"), claude);
    for (const field of MODE_FIELDS) assert.equal(next[field], approveForMe[field], `${harness} keeps ${field}`);
  }
  const native = editor.withTuning(editor.workerRoute("codex-native", "gpt-6.1-sol"), claude);
  assert.equal(native.permission_profile, ":workspace");
  assert.equal(native.approval_policy, "on-request");
  assert.equal(native.approvals_reviewer, "auto_review");
});

test("permissionsFitted leaves a route alone unless it must drop a mode", () => {
  assert.equal(editor.permissionsFitted(claude), claude, "a harness that takes the modes keeps the same route");
  const bare = editor.workerRoute("ao:pi", "cpa/gpt-6.1-sol");
  assert.equal(editor.permissionsFitted(bare), bare, "a Pi route without a mode is already fitted");
  const stale = { ...bare, ...approveForMe, effort: "xhigh", context_window: 872000 };
  assert.deepEqual(plain(editor.permissionsFitted(stale)), { ...bare, effort: "xhigh", context_window: 872000 },
    "the remembered Pi route keeps its model and tuning, only the mode goes");
  assert.equal(stale.approval_policy, "on-request", "the caller's route is not changed");
});

const { createAgentOrchestratorWorkflow, ROUTE_REFUSED } = require("../electron/agent-orchestrator-workflow.cjs");
const TUPLE_REFUSAL = "Launch failed: This adapter cannot honor the saved permission tuple; choose a supported mode explicitly.";

test("a launch the app refused is a route refusal; a failure a later try can get past is not", () => {
  // Each refusal aoLaunchArgs throws, as the card's error shows it.
  const engine = fs.readFileSync(path.resolve(__dirname, "../electron/agent-orchestrator-workflow.cjs"), "utf8");
  const agyAsk = engine.match(/const AGY_ASK_REASON = "([^"]+)"/)?.[1];
  assert.ok(agyAsk, "AGY_ASK_REASON is still a literal");
  for (const refusal of [TUPLE_REFUSAL, `Launch failed: ${agyAsk}`,
    "Launch failed: Single assistant: pi can't use the CPA model cpa/opencode-go/glm-5.3-flash. Choose one of its own models.",
    "Launch failed: Choose a supported CPA reasoning level"]) assert.match(refusal, ROUTE_REFUSED, refusal);
  // A refusal reworded in aoLaunchArgs must be reworded here too: each throw there is one of these.
  const launch = engine.slice(engine.indexOf("function aoLaunchArgs"), engine.indexOf("function aoLaunchArgs") + 6000);
  assert.equal((launch.match(/throw new Error\(/g) ?? []).length, 4, "a new launch refusal is added to ROUTE_REFUSED and this list");
  for (const transient of [
    "Launch failed: timed out waiting for the agent to start",
    "proxyconnect tcp: dial tcp 127.0.0.1:17891: connectex: No connection could be made",
    "API Error: 429 rate limited, retry in 20s",
    "API Error: 529 overloaded",
    "The agent stopped answering",
  ]) assert.doesNotMatch(transient, ROUTE_REFUSED, transient);
});

test("\"Retry automatically\" leaves a refused launch for the person instead of eight one-second failures", async () => {
  const route = { harness_id: "ao:pi", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-6.1-sol", permission_profile: ":ao-default", ...approveForMe };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", cancelled: false,
    grant: { executable_sha256: "a".repeat(64), expires_at_ms: Date.now() + 3_600_000 },
    nodes: [{ id: "one", role: "planner", state: "running", parents: [], route, history: [], receipt: { thread_id: "session-1", request_key: "k" } }] };
  const controls = [];
  let clock = 1_000_000;
  const workflow = createAgentOrchestratorWorkflow({
    now: () => clock,
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    requestHeadless: async (endpoint, body) => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint === "/api/v1/ao/control") controls.push(body.action);
      return { ok: true, run: mission };
    },
    aoHarness: { observe: async () => ({ status: "working", turnId: "t", turnState: "running", approvals: [] }) },
    confirm: async () => true,
  });
  await workflow.call("chat_auto_retry", { enabled: true });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  const status = () => workflow.call("run_status", { workspaceId: "ws", runId: "run" });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    mission.nodes[0] = { ...mission.nodes[0], state: "held", receipt: { ...mission.nodes[0].receipt, error: TUPLE_REFUSAL } };
    let detail = "";
    for (let tries = 0; tries < 100 && !/won't fix/.test(detail); tries++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      detail = String((await status()).detail ?? "");
    }
    assert.match(detail, /can't start on its agent as it is set up\. Change the model or permissions and send a follow-up, since retrying won't fix it\./);
    clock += 60 * 60_000;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(controls, [], "never retried, however long it waits");
  } finally {
    mission.nodes[0].state = "finished";
    for (let tries = 0; tries < 100 && (await status()).status === "running"; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  }
});

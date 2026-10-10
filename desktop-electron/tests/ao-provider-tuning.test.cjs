"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("../node_modules/typescript");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

test("AO model catalogs retain native efforts and CPA's advertised levels/context without changing stored IDs", async () => {
  const requests = [];
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => [{ id: "own-model", efforts: ["low", "high"] }] },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async url => {
      requests.push(new URL(url));
      return { ok: true, json: async () => ({ models: [
        { slug: "gemini-3.8-flash-high", context_window: 1048576, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
        { slug: "claude-sonnet-4-6", context_window: 200000, supported_reasoning_levels: [] },
        { slug: "hidden-model", visibility: "hide" },
      ] }) };
    },
  });
  const result = await workflow.call("models", { harness: "ao:codex" });
  assert.deepEqual(result.models, ["own-model", "cpa/gemini-3.8-flash-high", "cpa/claude-sonnet-4-6"]);
  assert.equal(requests[0].searchParams.get("client_version"), "pi");
  assert.deepEqual(result.capabilities["own-model"].efforts, ["low", "high"]);
  assert.deepEqual(result.capabilities["cpa/gemini-3.8-flash-high"].efforts, ["low", "medium", "high"]);
  assert.equal(result.capabilities["cpa/gemini-3.8-flash-high"].contextLimit, 1048576);
  assert.equal(result.capabilities["cpa/gemini-3.8-flash-high"].contextWindow.max, 1048576);
  assert.deepEqual(result.capabilities["cpa/claude-sonnet-4-6"].efforts, []);
});

test("classic CPA catalog remains usable but absent capabilities are not invented", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => [] },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "plain-model" }] }) }),
  });
  const result = await workflow.call("models", { harness: "ao:codex" });
  assert.deepEqual(result.models, ["cpa/plain-model"]);
  assert.ok(result.capabilities, "catalog exposes capabilities");
  assert.deepEqual(result.capabilities["cpa/plain-model"].efforts, []);
  assert.equal(result.capabilities["cpa/plain-model"].contextLimit, undefined);
  assert.match(result.capabilities["cpa/plain-model"].effortReason, /advertis|report|unknown/i);
});

test("all AO harnesses receive truthful tuning outcomes; unsupported transport and recognized Claude context stay unavailable", async () => {
  const ids = ["aider", "grok", "droid", "agy", "crush", "cursor", "qwen", "copilot", "goose", "auggie", "continue",
    "devin", "cline", "kimi", "muse", "kiro", "kilocode", "vibe", "kimchi", "prime-agent", "autohand", "omp", "amp", "pi", "unreal-agent"];
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => [{ id: "own-model", efforts: ["high"] }] },
    cpaConnection: () => null,
  });
  for (const id of ids) {
    const result = await workflow.call("models", { harness: "ao:" + id });
    assert.deepEqual(result.models, ["own-model"]);
    assert.ok(result.capabilities, "every AO catalog exposes a truthful capability outcome");
    assert.deepEqual(result.capabilities["own-model"].efforts, [], id);
    assert.equal(result.capabilities["own-model"].contextWindow, undefined, id);
    assert.match(result.capabilities["own-model"].contextReason, /support|verified|setter/i, id);
  }
  // Claude Code lists only CPA models; a recognized Claude model through CPA keeps CPA's advertised
  // efforts but no context override (Claude Code would lose compaction).
  const claude = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => { throw Error("Claude Code's own aliases are not listed"); } },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ slug: "claude-sonnet-4-6", context_window: 200000,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] }) }),
  });
  const caps = (await claude.call("models", { harness: "ao:claude-code" })).capabilities["cpa/claude-sonnet-4-6"];
  assert.deepEqual(caps.efforts, ["low", "high"]);
  assert.equal(caps.contextWindow, undefined);
  assert.match(caps.contextReason, /compaction|recognized/i);
});

test("Native Codex lists WebGPT even without CPA and never reads AO catalogs", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: () => { throw Error("must not read AO"); } },
    cpaConnection: () => { throw Error("must not read CPA"); },
  });
  const result = await workflow.call("models", { harness: "codex-native" });
  assert.equal(result.harness, "codex-native");
  assert.equal(result.models.length, 7);
  assert.ok(result.models.every(id => id.startsWith("chatgpt-web/")));
  assert.deepEqual({ ...result.capabilities }, {}, "no CPA, so no pool models or capabilities");
});

async function dispatched(agent, model, tuning) {
  const spawned = [];
  const route = { harness_id: "ao:" + agent, provider_id: "agent-orchestrator", account_id: "ao-local", model,
    permission_profile: ":ao-default", ...tuning };
  const worker = { id: "worker", role: "worker", task_id: "task", parents: ["planner"], state: "pending", route };
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => [{ id: "own-model", efforts: ["high"] }], spawn: async input => { spawned.push(input); return "session-1"; } },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ slug: "gpt-5.5", context_window: 262144, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] }) }),
    confirm: async () => true,
    requestHeadless: async endpoint => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run", workspace_id: "ws", revision: 1, cancelled: false,
        nodes: [{ id: "planner", role: "planner", parents: [], state: "finished", route: { model: "chatgpt-web/high" } }, worker] }] };
      if (endpoint === "/api/v1/ao/external/reserve") return { ok: true, request_key: "key", prompt: "Fixture task" };
      if (endpoint === "/api/v1/ao/external/submitted") return { ok: true, run: { id: "run" } };
      throw Error("Unexpected endpoint " + endpoint);
    },
  });
  await workflow.call("advance", { workspaceId: "ws", runId: "run" });
  assert.equal(spawned.length, 1);
  assert.equal(route.model, model, "saved model/account identity is not mutated");
  return spawned[0];
}

test("CPA effort becomes exactly one session-local wire suffix and context is forwarded separately for each supported client", async () => {
  for (const agent of ["codex", "claude-code", "opencode"]) {
    const input = await dispatched(agent, "cpa/gpt-5.5(low)", { effort: "high", context_window: 262144 });
    assert.equal(input.model, (agent === "opencode" ? "openai/" : "") + "gpt-5.5(high)");
    assert.deepEqual(input.gateway, { provider: "cpa", model: "gpt-5.5(high)" });
    assert.equal(input.contextWindow, 262144);
    assert.equal(input.effort, undefined, "foreign model is not checked as native-agent effort");
    const untuned = await dispatched(agent, "cpa/gpt-5.5", {});
    assert.equal(untuned.gateway.model, "gpt-5.5");
    assert.equal(Object.hasOwn(untuned, "contextWindow"), false);
  }
  const own = await dispatched("codex", "own-model", { effort: "high", context_window: 131072 });
  assert.equal(own.model, "own-model");
  assert.equal(own.effort, "high");
  assert.equal(own.contextWindow, 131072);
  assert.equal(Object.hasOwn(own, "gateway"), false);
});

test("a launch that fails before returning a session saves the launcher's reason on the held card", async () => {
  const submitted = [];
  const worker = { id: "worker", role: "worker", task_id: "task", parents: ["planner"], state: "pending",
    route: { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-5.5", permission_profile: ":ao-default" } };
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => [], spawn: async () => { throw new Error("unsupported contextWindow: Claude Code only"); } },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
    confirm: async () => true,
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run", workspace_id: "ws", revision: 1, cancelled: false,
        nodes: [{ id: "planner", role: "planner", parents: [], state: "finished", route: { model: "chatgpt-web/high" } }, worker] }] };
      if (endpoint === "/api/v1/ao/external/reserve") return { ok: true, request_key: "key", prompt: "Fixture task" };
      if (endpoint === "/api/v1/ao/external/submitted") { submitted.push({ ...body }); return { ok: true, run: { id: "run" } }; }
      throw Error("Unexpected endpoint " + endpoint);
    },
  });
  await assert.rejects(workflow.call("advance", { workspaceId: "ws", runId: "run" }), /unsupported contextWindow/);
  assert.equal(submitted.length, 1);
  assert.equal(Object.hasOwn(submitted[0], "session_id"), false);
  assert.equal(submitted[0].error, "unsupported contextWindow: Claude Code only");
});

test("persisted CPA tuning is checked against the current model capabilities before dispatch", async () => {
  await assert.rejects(dispatched("codex", "cpa/gpt-5.5", { effort: "xhigh" }), /reasoning.*not.*support|unsupported.*effort/i);
  await assert.rejects(dispatched("codex", "cpa/gpt-5.5", { context_window: 1048576 }), /context.*262144|context.*limit/i);
});

test("upstream spawn preserves context on Chat/TUI fallback without adding native effort to a CPA session", async () => {
  const file = path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let method;
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "spawn") method = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(method);
  const bodies = [];
  const spawn = vm.runInNewContext("({" + method.getText(ast) + "}).spawn", {
    Buffer,
    projectFor: async () => "project",
    agentId: id => id,
    sessionId: id => id,
    utf8Prefix: text => text,
    TUI_RESULT_INSTRUCTION: "Write fixture result",
    internalApi: async (verb, endpoint, body) => {
      if (verb === "GET") return { chatHarnesses: ["codex"] };
      bodies.push(body);
      if (body.mode === "chat") throw Error("CHAT_DRIVER_UNAVAILABLE");
      return { session: { id: "session" } };
    },
  });
  assert.equal(await spawn({ workspaceId: "ws", agent: "codex", model: "gpt-5.5(high)", prompt: "task",
    gateway: { provider: "cpa", model: "gpt-5.5(high)" }, effort: "high", contextWindow: 262144 }), "session");
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.contextWindow, 262144);
    assert.equal(body.effort, undefined);
    assert.equal(body.gateway.model, "gpt-5.5(high)");
  }
});

test("a CPA model's ceiling is its max context window and its own efforts, up to ultra", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [
      { slug: "gpt-6-luna", context_window: 272000, max_context_window: 1000000,
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort })) },
      { slug: "gpt-6-sol", context_window: 272000, max_context_window: 1000000,
        supported_reasoning_levels: ["low", "xhigh", "max", "ultra"].map(effort => ({ effort })) },
      { slug: "gpt-5.5", context_window: 272000, supported_reasoning_levels: [{ effort: "high" }] },
    ] }) }),
  });
  const { capabilities } = await workflow.call("models", { harness: "codex-native" });
  assert.equal(capabilities["gpt-6-luna"].contextLimit, 1000000, "Luna goes past its 272K default to 1M");
  assert.deepEqual([...capabilities["gpt-6-luna"].efforts], ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual([...capabilities["gpt-6-sol"].efforts], ["low", "xhigh", "max", "ultra"]);
  assert.equal(capabilities["gpt-5.5"].contextLimit, 272000, "without a max, the reported window is the limit");
});

test("a single-model run starts its AO session plain; a team card keeps AO's worker prompt", async () => {
  const spawnFor = async (executionMode) => {
    const spawned = [];
    const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-5.5", permission_profile: ":ao-default" };
    const node = { id: "single", role: "planner", task_id: "task", parents: [], state: "pending", route, settings: { name: "Single assistant" } };
    const workflow = createAgentOrchestratorWorkflow({
      aoHarness: { models: async () => [], spawn: async input => { spawned.push(input); return "session-1"; } },
      cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ slug: "gpt-5.5" }] }) }),
      confirm: async () => true,
      requestHeadless: async endpoint => {
        if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run", workspace_id: "ws", revision: 1, cancelled: false,
          ...(executionMode ? { execution_mode: executionMode } : {}), nodes: [node] }] };
        if (endpoint === "/api/v1/ao/external/reserve") return { ok: true, request_key: "key", prompt: "Fixture task" };
        if (endpoint === "/api/v1/ao/external/submitted") return { ok: true, run: { id: "run" } };
        throw Error("Unexpected endpoint " + endpoint);
      },
    });
    await workflow.call("advance", { workspaceId: "ws", runId: "run" });
    assert.equal(spawned.length, 1);
    return spawned[0];
  };
  assert.equal((await spawnFor("single")).plain, true);
  assert.equal(Object.hasOwn(await spawnFor(undefined), "plain"), false);
});

test("the CPA catalog's provider for each model reaches the model capabilities", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
      { id: "gemini-3.8-flash-high", owned_by: "antigravity" }, { id: "gpt-5.5", owned_by: "codex" }, { id: "plain-model" },
    ] }) }),
  });
  const { capabilities } = await workflow.call("models", { harness: "codex-native" });
  assert.equal(capabilities["gemini-3.8-flash-high"].provider, "antigravity");
  assert.equal(capabilities["gpt-5.5"].provider, "codex");
  assert.equal(capabilities["plain-model"]?.provider, undefined);
});

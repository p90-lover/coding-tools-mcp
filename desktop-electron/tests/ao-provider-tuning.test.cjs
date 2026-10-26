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
  // The one exception to inventing nothing: CPA lists Claude with no levels, but its suffix still
  // turns thinking on (tried 2026-10-21: "claude-sonnet-4-6(low|medium|high|max)" answered with a
  // thinking block, the bare name without one).
  assert.deepEqual(result.capabilities["cpa/claude-sonnet-4-6"].efforts, ["low", "medium", "high", "max"]);
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

test("all AO harnesses receive truthful tuning outcomes; unsupported transport stays unavailable and Claude models take a window", async () => {
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
  // Claude Code lists only CPA models; a Claude model through CPA keeps CPA's advertised efforts and
  // takes a window up to its reported limit (its picker was off). A CPA alias with no reported limit
  // ("Claude Opus 5.5") offers the client's 2M ceiling, said to be unverified.
  const claude = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => { throw Error("Claude Code's own aliases are not listed"); } },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ slug: "claude-sonnet-4-6", context_window: 200000,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }, { slug: "Claude Opus 5.5" }] }) }),
  });
  const catalog = (await claude.call("models", { harness: "ao:claude-code" })).capabilities;
  const caps = catalog["cpa/claude-sonnet-4-6"];
  assert.deepEqual(caps.efforts, ["low", "high"]);
  assert.deepEqual(caps.contextWindow, { min: 4096, max: 200000, kind: "context" });
  assert.deepEqual(catalog["cpa/Claude Opus 5.5"].contextWindow, { min: 4096, max: 2000000, kind: "context" });
  assert.match(catalog["cpa/Claude Opus 5.5"].contextReason, /unverified/);
});

test("Native Codex lists WebGPT even without CPA and never reads AO catalogs", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: () => { throw Error("must not read AO"); } },
    cpaConnection: () => { throw Error("must not read CPA"); },
  });
  const result = await workflow.call("models", { harness: "codex-native" });
  assert.equal(result.harness, "codex-native");
  assert.equal(result.models.length, 5, "ChatGPT's five effort tiers; Luna and Think are not offered");
  assert.ok(result.models.every(id => id.startsWith("chatgpt-web/")));
  assert.deepEqual({ ...result.capabilities }, {}, "no CPA, so no pool models or capabilities");
});

const DISPATCH_CATALOG = [{ slug: "gpt-5.5", context_window: 262144, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  { slug: "cline-pass/deepseek-v4.1-flash", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }];
async function dispatched(agent, model, tuning, catalog = DISPATCH_CATALOG) {
  const spawned = [];
  const route = { harness_id: "ao:" + agent, provider_id: "agent-orchestrator", account_id: "ao-local", model,
    permission_profile: ":ao-default", ...tuning };
  const worker = { id: "worker", role: "worker", task_id: "task", parents: ["planner"], state: "pending", route };
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { models: async () => [{ id: "own-model", efforts: ["high"] }], spawn: async input => { spawned.push(input); return "session-1"; } },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: catalog }) }),
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

test("CPA effort goes once, in the request body (Claude Code, Codex) or as a session-local suffix (opencode), and context is forwarded for each client", async () => {
  for (const agent of ["codex", "claude-code", "opencode"]) {
    // Claude Code and Codex send the bare model and the effort in the body (output_config.effort,
    // reasoning.effort); opencode has no body transport in AO and keeps CPA's "(level)" suffix.
    const body = agent !== "opencode";
    const input = await dispatched(agent, "cpa/gpt-5.5(low)", { effort: "high", context_window: 262144 });
    assert.equal(input.model, body ? "gpt-5.5" : "openai/gpt-5.5(high)");
    assert.deepEqual(input.gateway, { provider: "cpa", model: body ? "gpt-5.5" : "gpt-5.5(high)" });
    assert.equal(input.contextWindow, 262144);
    assert.equal(input.effort, body ? "high" : undefined, "the effort goes once: in the body or in the name");
    // A card left blank on a model without "auto" starts on a real effort (High: there is no
    // Medium), so a send made before the composer's list loaded still names one.
    const untuned = await dispatched(agent, "cpa/gpt-5.5", {});
    assert.deepEqual([untuned.gateway.model, untuned.effort], body ? ["gpt-5.5", "high"] : ["gpt-5.5(high)", undefined]);
    assert.equal(untuned.contextWindow, 262144, "a card left blank starts with the model's full known window");
  }
  const own = await dispatched("codex", "own-model", { effort: "high", context_window: 131072 });
  assert.equal(own.model, "own-model");
  assert.equal(own.effort, "high");
  assert.equal(own.contextWindow, 131072);
  assert.equal(Object.hasOwn(own, "gateway"), false);
});

test("Cline DeepSeek V4.1 Flash lists native efforts and forwards them unchanged", async () => {
  const id = "cline-pass/deepseek-v4.1-flash";
  const catalog = [{ slug: id, supported_reasoning_levels: ["low", "medium", "high", "xhigh"] }];
  for (const agent of ["codex", "claude-code", "opencode"]) {
    const workflow = createAgentOrchestratorWorkflow({
      cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ models: catalog }) }),
      aoHarness: { models: async () => [] },
    });
    const result = await workflow.call("models", { harness: "ao:" + agent });
    assert.deepEqual(result.capabilities["cpa/" + id].efforts, ["none", "low", "high", "max"], agent);
    // Claude Code and Codex carry the effort in the body, opencode in the model's name.
    const body = agent !== "opencode";
    for (const effort of ["none", "low", "high", "max"]) {
      const input = await dispatched(agent, "cpa/" + id + "(high)", { effort }, catalog);
      assert.equal(input.model, body ? id : "openai/" + id + "(" + effort + ")");
      assert.deepEqual(input.gateway, { provider: "cpa", model: body ? id : id + "(" + effort + ")" });
      assert.equal(input.effort, body ? effort : undefined);
    }
    await assert.rejects(dispatched(agent, "cpa/" + id, { effort: "xhigh" }, catalog), /doesn't support the chosen reasoning effort/i);
    const blank = await dispatched(agent, "cpa/" + id, {}, catalog);
    assert.deepEqual([blank.gateway.model, blank.effort], body ? [id, "high"] : [id + "(high)", undefined],
      "None/Low/High/Max has no Auto: a blank card starts on High, not on no effort CPA cannot serve");
  }
});

test("agy gets the bare model name and runs unattended only with Full access", async () => {
  // agy sends its tools only for a model it recognizes; "gemini-3-flash(medium)" is not one ("not
  // recognized as a known model"), so the model printed its tool calls as text.
  const catalog = [{ slug: "gemini-3-flash", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] }];
  const blank = await dispatched("agy", "cpa/gemini-3-flash", {}, catalog);
  assert.deepEqual([blank.model, blank.gateway.model], ["gemini-3-flash", "gemini-3-flash"], "no start effort suffix");
  assert.equal((await dispatched("agy", "cpa/gemini-3-flash(low)", { effort: "low" }, catalog)).model, "gemini-3-flash", "a picked or saved suffix is dropped");
  const other = await dispatched("claude-code", "cpa/gemini-3-flash", {}, catalog);
  assert.deepEqual([other.model, other.effort], ["gemini-3-flash", "medium"], "other harnesses keep the start effort (Claude Code's in the body)");
  const full = await dispatched("agy", "cpa/gemini-3-flash", { native_permission_profile: ":danger-full-access", approval_policy: "never", approvals_reviewer: "user" }, catalog);
  assert.equal(full.approvalMode, "bypass-permissions");
  // Ask stays at an approval in agy's terminal, which nobody sees, and Approve for me (--mode auto)
  // is "not available for this account" through the gateway, so it falls back to asking: refused.
  for (const reviewer of ["user", "auto_review"]) {
    await assert.rejects(dispatched("agy", "cpa/gemini-3-flash", { native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: reviewer }, catalog),
      /asks for approval in its own terminal/, reviewer);
  }
});

test("a blank CPA card's start effort follows the effort rank, and Auto or a model's own effort is left alone", async () => {
  const levels = (...efforts) => efforts.map(effort => ({ effort }));
  const catalog = [{ slug: "rank-a", supported_reasoning_levels: levels("max", "low") },
    { slug: "rank-b", supported_reasoning_levels: levels("low", "medium", "high") },
    { slug: "takes-auto", supported_reasoning_levels: levels("low", "high", "auto") },
    { slug: "gemini-3.8-flash-high", supported_reasoning_levels: levels("low", "high") }];
  // opencode still names the effort in the model ("(level)"), which shows the start effort picked.
  const wire = async (model, tuning = {}) => (await dispatched("opencode", "cpa/" + model, tuning, catalog)).gateway.model;
  assert.equal(await wire("rank-a"), "rank-a(low)", "the lowest by rank, not the catalog's first");
  assert.equal(await wire("rank-b"), "rank-b(medium)");
  assert.equal(await wire("rank-b", { effort: "high" }), "rank-b(high)", "a picked effort is kept");
  assert.equal(await wire("takes-auto"), "takes-auto");
  assert.equal(await wire("gemini-3.8-flash-high"), "gemini-3.8-flash-high", "the id names its own effort");
});

test("every provider plugin's model reaches CPA by its bare name, by namespace or by the provider CPA names", async () => {
  // Seen live: "commandcode-go/…(high)" came back 503 auth_unavailable ("model not found").
  const levels = [{ effort: "low" }, { effort: "high" }];
  const catalog = [...DISPATCH_CATALOG, { slug: "commandcode-go/deepseek-v4.1-flash", supported_reasoning_levels: levels },
    { slug: "kimi-k3", owned_by: "kimi", supported_reasoning_levels: levels }];
  // Command Code's plugin 1.0.0-codingtools.2 reads the suffix as the request's reasoning level;
  // Claude Code sends the bare model and the picked level in the body instead.
  for (const model of ["cpa/commandcode-go/deepseek-v4.1-flash", "cpa/commandcode-go/deepseek-v4.1-flash(low)"]) {
    const input = await dispatched("claude-code", model, { effort: "high" }, catalog);
    assert.deepEqual([input.gateway, input.effort], [{ provider: "cpa", model: "commandcode-go/deepseek-v4.1-flash" }, "high"], "the picked level, in the body");
    const named = await dispatched("opencode", model, { effort: "high" }, catalog);
    assert.deepEqual(named.gateway, { provider: "cpa", model: "commandcode-go/deepseek-v4.1-flash(high)" }, "opencode's is its suffix");
  }
  const owned = await dispatched("opencode", "cpa/kimi-k3", { effort: "high" }, catalog);
  assert.equal(owned.model, "openai/kimi-k3", "a plugin model without a namespace is known by its owner");
  assert.deepEqual(owned.gateway, { provider: "cpa", model: "kimi-k3" });
  const plain = await dispatched("opencode", "cpa/gpt-5.5", { effort: "high" }, catalog);
  assert.equal(plain.gateway.model, "gpt-5.5(high)", "CPA's own providers still get the suffix where it is the transport");
  const workflow = createAgentOrchestratorWorkflow({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: catalog }) }),
    aoHarness: { models: async () => [] },
  });
  const { capabilities } = await workflow.call("models", { harness: "ao:claude-code", workspaceId: "ws" });
  assert.deepEqual(capabilities["cpa/commandcode-go/deepseek-v4.1-flash"].efforts, ["none", "low", "medium", "high", "max"],
    "Command Code's plugin reads the suffix");
  assert.deepEqual(capabilities["cpa/kimi-k3"].efforts, [], "cpa/kimi-k3");
  assert.match(capabilities["cpa/kimi-k3"].effortReason, /provider plugin/, "cpa/kimi-k3 says why it takes no level");
  assert.deepEqual(capabilities["cpa/gpt-5.5"].efforts, ["low", "high"]);
});

test("a blank card on a model whose limit CPA did not report launches at the agent's own window", async () => {
  // CPA's stock 272K for a plugin model is no limit; a known one still fills the card (above).
  const input = await dispatched("claude-code", "cpa/commandcode-go/glm-5", {},
    [...DISPATCH_CATALOG, { slug: "commandcode-go/glm-5", context_window: 272000, max_context_window: 272000 }]);
  assert.equal(Object.hasOwn(input, "contextWindow"), false);
});

test("the permission menu reuses the agent catalog instead of probing every CLI on each open", async () => {
  let reads = 0, fail = true;
  const workflow = createAgentOrchestratorWorkflow({
    aoHarness: { catalog: async () => { reads++; if (fail) { fail = false; throw new Error("AO busy"); } return [{ id: "claude-code", label: "Claude Code", installed: true, chat: true }]; } },
    requestHeadless: async () => { throw Error("must not reach headless"); },
  });
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-5.5", permission_profile: ":ao-default" };
  await assert.rejects(workflow.call("permission_profiles", { workspaceId: "ws", route }), /AO busy/);
  for (let i = 0; i < 3; i++) {
    const { capability } = await workflow.call("permission_profiles", { workspaceId: "ws", route });
    assert.equal(capability.supported, true);
  }
  assert.equal(reads, 2, "a failed read is not kept; a good one serves the next opens");
  await workflow.call("harnesses", {});
  assert.equal(reads, 2, "the harness list shares the same answer");
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
  await assert.rejects(dispatched("codex", "cpa/gpt-5.5", { effort: "xhigh" }), /doesn't support the chosen reasoning effort/i);
  await assert.rejects(dispatched("codex", "cpa/gpt-5.5", { context_window: 1048576 }), /context.*262144|context.*limit/i);
});

test("upstream spawn preserves context and the effort on Chat/TUI fallback, the effort going in a CPA session's body", async () => {
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
    forgetProject: () => {},
    agentId: id => id,
    sessionId: id => id,
    utf8Prefix: text => text,
    TUI_RESULT_INSTRUCTION: "Write fixture result",
    TRANSIENT_CHAT_START: /persistent (ACP )?host|timed out|timeout|deadline exceeded|context canceled/i, CHAT_RETRY_PAUSE_MS: 0, setTimeout,
    // spawn records each session's launch window for the context meter (chat_context launchedWindow).
    rememberLaunchWindow: () => {},
    chatTools: async () => null,

    // The person's own MCP servers (Plugins > MCPs): none here.

    userServers: () => [],
    internalApi: async (verb, endpoint, body) => {
      if (verb === "GET") return { chatHarnesses: ["codex"] };
      bodies.push(body);
      if (body.mode === "chat") throw Error("CHAT_DRIVER_UNAVAILABLE");
      return { session: { id: "session" } };
    },
  });
  assert.equal(await spawn({ workspaceId: "ws", agent: "codex", model: "gpt-5.5", prompt: "task",
    gateway: { provider: "cpa", model: "gpt-5.5" }, effort: "high", contextWindow: 262144 }), "session");
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.contextWindow, 262144);
    assert.equal(body.effort, "high", "through CPA too: the agent sends it in the request body");
    assert.equal(body.gateway.model, "gpt-5.5");
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

test("a chat host that was only slow to start is retried as chat, not turned into a terminal session", async () => {
  const file = path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let method;
  const visit = node => { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "spawn") method = node; ts.forEachChild(node, visit); };
  visit(ast);
  const transient = source.match(/const TRANSIENT_CHAT_START = (\/.*\/i);/)[1];
  const run = async (failures) => {
    const modes = [];
    const spawn = vm.runInNewContext("({" + method.getText(ast) + "}).spawn", {
      Buffer, projectFor: async () => "project", forgetProject: () => {}, agentId: id => id, sessionId: id => id, utf8Prefix: text => text,
      TUI_RESULT_INSTRUCTION: "Write fixture result", TRANSIENT_CHAT_START: vm.runInNewContext(transient), CHAT_RETRY_PAUSE_MS: 0, setTimeout,
      rememberLaunchWindow: () => {},
      chatTools: async () => null,

      // The person's own MCP servers (Plugins > MCPs): none here.

      userServers: () => [],
      internalApi: async (verb, _endpoint, body) => {
        if (verb === "GET") return { chatHarnesses: ["claude-code"] };
        modes.push(body.mode);
        const failure = failures.shift();
        if (failure) throw Error(failure);
        return { session: { id: "session-" + modes.length } };
      },
    });
    const outcome = await spawn({ workspaceId: "ws", agent: "claude-code", model: "cpa/m", prompt: "task" }).catch(error => "error: " + error.message);
    return { modes, outcome };
  };
  const slow = await run(["persistent ACP host: startup timed out (CHAT_DRIVER_UNAVAILABLE)"]);
  assert.deepEqual(slow.modes, ["chat", "chat"], "a slow start is retried as chat");
  assert.equal(slow.outcome, "session-2");
  const stillSlow = await run(["persistent ACP host: startup timed out (CHAT_DRIVER_UNAVAILABLE)", "persistent ACP host: startup timed out (CHAT_DRIVER_UNAVAILABLE)"]);
  assert.deepEqual(stillSlow.modes, ["chat", "chat"], "never silently becomes a terminal session");
  assert.match(stillSlow.outcome, /^error: .*persistent ACP host/, "the card is held with the real reason");
  const missing = await run(["AO ACP runtime is not installed (CHAT_DRIVER_UNAVAILABLE)"]);
  assert.deepEqual(missing.modes, ["chat", "tui"], "without a chat runtime the agent still runs in its terminal");
});

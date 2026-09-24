"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const moduleCache = new Map();

function resolveTypeScriptModule(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${fromFile}`);
}

function loadTypeScriptModule(relativePath) {
  const absolute = path.join(__dirname, "..", relativePath);
  return loadAbsolute(absolute);
}

function loadAbsolute(filename) {
  if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const module = { exports: {} };
  moduleCache.set(filename, module);
  const localRequire = (specifier) => specifier.startsWith(".")
    ? loadAbsolute(resolveTypeScriptModule(filename, specifier))
    : require(specifier);
  Function("require", "module", "exports", compiled.outputText)(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}

function modelAgent(overrides = {}) {
  return {
    id: "coder",
    name: "Coder",
    kind: "model",
    providerId: "codex-oauth",
    model: "gpt-5.6-codex",
    role: "coder",
    enabled: true,
    capabilities: ["text", "reasoning", "tools"],
    tools: ["filesystem", "terminal", "github"],
    permissionMode: "restricted",
    budget: { maxTurns: 20, timeoutMs: 300_000, maxRetries: 2 },
    ...overrides,
  };
}

test("execution bindings never substitute another provider or selected model", () => {
  const { selectBinding } = loadTypeScriptModule("src/features/execution-surface-utils.ts");
  const ready = {
    id: "web", engine: "paseo", provider: "chatgpt-web", model: "chatgpt-web/high",
    endpoint: "ws://127.0.0.1:6768/ws", enabled: true, connected: true, current_scope_valid: true,
  };
  const view = (...bindings) => ({ execution: { bindings } });
  assert.equal(selectBinding(view(ready), "paseo", ready.provider, ready.model).id, "web");
  assert.equal(selectBinding(view(ready), "paseo", ready.provider, null), undefined);
  assert.equal(selectBinding(view({ ...ready, model: "native-only" }), "paseo", ready.provider, ready.model), undefined);
  assert.equal(selectBinding(view({ ...ready, provider: "codex-oauth" }), "paseo", ready.provider, ready.model), undefined);
  assert.equal(selectBinding(view({ ...ready, connected: false }), "paseo", ready.provider, ready.model), undefined);
});

test("agent registry validates profiles, preserves archived agents, and rejects duplicates", () => {
  const { AgentRegistry } = loadTypeScriptModule("src/agents/agent-registry.ts");
  const registry = new AgentRegistry();
  registry.register(modelAgent());

  assert.throws(() => registry.register(modelAgent()), /already registered/);
  assert.throws(() => registry.register(modelAgent({
    id: "broken-workflow",
    kind: "orchestrator",
    orchestratorId: "release-flow",
  })), /must not define providerId or model/);

  registry.archive("coder");
  assert.equal(registry.get("coder").enabled, false);
  assert.equal(registry.list().length, 0);
  assert.equal(registry.list({ includeDisabled: true }).length, 1);
});

test("agent/provider resolution enforces provider capabilities", () => {
  const { resolveAgentProvider } = loadTypeScriptModule("src/agents/agent-provider-adapter.ts");
  const { DEFAULT_PROVIDERS } = loadTypeScriptModule("src/providers/provider-types.ts");

  const compatible = resolveAgentProvider(modelAgent(), DEFAULT_PROVIDERS);
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.provider.id, "codex-oauth");

  const incompatible = resolveAgentProvider(modelAgent({
    id: "image-agent",
    capabilities: ["image_generation"],
  }), DEFAULT_PROVIDERS);
  assert.equal(incompatible.compatible, false);
  assert.match(incompatible.errors.join(" "), /image_generation/);
});

test("custom orchestrators can act as subagents but recursive delegation fails closed", () => {
  const { AgentRegistry } = loadTypeScriptModule("src/agents/agent-registry.ts");
  const { resolveOrchestratorAgent } = loadTypeScriptModule("src/orchestrator/orchestrator-router.ts");
  const registry = new AgentRegistry([
    modelAgent(),
    {
      id: "release-supervisor",
      name: "Release supervisor",
      kind: "orchestrator",
      orchestratorId: "release-flow",
      role: "supervisor",
      enabled: true,
      capabilities: ["text", "reasoning", "tools"],
      tools: ["github"],
      permissionMode: "restricted",
      budget: { maxTurns: 30, timeoutMs: 600_000, maxRetries: 1 },
    },
  ]);

  assert.equal(
    resolveOrchestratorAgent(registry, "release-supervisor", []).orchestratorId,
    "release-flow",
  );
  assert.throws(
    () => resolveOrchestratorAgent(registry, "release-supervisor", ["release-flow"]),
    /recursive orchestrator delegation/,
  );
});

test("Paseo routing and resolved workflow plans use enabled compatible agents", () => {
  const { AgentRegistry } = loadTypeScriptModule("src/agents/agent-registry.ts");
  const { AgentRouter } = loadTypeScriptModule("src/paseo/agent-router.ts");
  const { WorkflowEngine } = loadTypeScriptModule("src/orchestrator/workflow-engine.ts");
  const { DEFAULT_PROVIDERS } = loadTypeScriptModule("src/providers/provider-types.ts");
  const registry = new AgentRegistry([modelAgent()]);
  const router = new AgentRouter(registry, DEFAULT_PROVIDERS);

  const routed = router.route({
    role: "coder",
    requiredCapabilities: ["tools"],
    workflowAncestry: [],
  });
  assert.equal(routed.agent.id, "coder");
  assert.equal(routed.provider.id, "codex-oauth");

  const engine = new WorkflowEngine(registry);
  const plan = engine.buildPlan({
    id: "release-flow",
    name: "Release flow",
    enabled: true,
    entryStageId: "code",
    stages: [{
      id: "code",
      name: "Code",
      agentId: "coder",
      maxRetries: 1,
      approvalMode: "inherit",
      timeoutMs: 60_000,
      completionRules: ["tests-passed"],
    }],
  });
  assert.equal(plan.workflowId, "release-flow");
  assert.equal(plan.stages[0].target.kind, "agent");
  assert.equal(plan.stages[0].target.agentId, "coder");
});

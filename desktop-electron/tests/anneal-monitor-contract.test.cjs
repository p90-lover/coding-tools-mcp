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
  const filename = path.join(__dirname, "..", relativePath);
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
    ? loadTypeScriptModule(path.relative(path.join(__dirname, ".."), resolveTypeScriptModule(filename, specifier)))
    : require(specifier);
  Function("require", "module", "exports", compiled.outputText)(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}

function observation(id, source, key, success, terminal = false) {
  return { id, source, key, success, terminal, message: key, timestamp: Date.now() };
}

test("Anneal completion requires every declared evidence rule", () => {
  const { CompletionDetector } = loadTypeScriptModule("src/anneal/completion-detector.ts");
  const detector = new CompletionDetector();
  const rules = [
    { id: "chat", source: "chat", key: "task-done" },
    { id: "build", source: "build", key: "build-passed" },
  ];

  const verifying = detector.evaluate(rules, [
    observation("1", "chat", "task-done", true),
  ]);
  assert.equal(verifying.state, "verifying");
  assert.deepEqual(verifying.missingRuleIds, ["build"]);

  const completed = detector.evaluate(rules, [
    observation("1", "chat", "task-done", true),
    observation("2", "build", "build-passed", true),
  ]);
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.missingRuleIds, []);
});

test("terminal failure evidence prevents false completion", () => {
  const { CompletionDetector } = loadTypeScriptModule("src/anneal/completion-detector.ts");
  const detector = new CompletionDetector();
  const result = detector.evaluate(
    [{ id: "release", source: "github", key: "release-created" }],
    [observation("failure", "build", "build-failed", false, true)],
  );
  assert.equal(result.state, "failed");
  assert.equal(result.failureObservationIds[0], "failure");
});

test("task monitor deduplicates observations and exposes evidence-backed state", () => {
  const { TaskMonitor } = loadTypeScriptModule("src/anneal/task-monitor.ts");
  const monitor = new TaskMonitor({
    taskId: "release-task",
    title: "Release task",
    completionRules: [{ id: "build", source: "build", key: "build-passed" }],
  });
  monitor.start();
  monitor.observe(observation("build-1", "build", "build-passed", true));
  monitor.observe(observation("build-1", "build", "build-passed", true));
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.observations.length, 1);
});

test("web tasks enforce origin, approval, timeout, and step bounds", async () => {
  const { WebTaskRunner } = loadTypeScriptModule("src/anneal/web-task-runner.ts");
  const executed = [];
  const runner = new WebTaskRunner({
    async execute(step) {
      executed.push(step.id);
      return { stepId: step.id, ok: true, evidence: step.type };
    },
  });

  await assert.rejects(() => runner.run({
    id: "blocked-origin",
    name: "Blocked origin",
    enabled: true,
    allowedOrigins: ["https://github.com"],
    permission: "approved",
    maxSteps: 5,
    timeoutMs: 5_000,
    steps: [{ id: "navigate", type: "navigate", url: "https://example.invalid" }],
  }), /origin is not allowed/);

  const result = await runner.run({
    id: "github-check",
    name: "GitHub check",
    enabled: true,
    allowedOrigins: ["https://github.com"],
    permission: "approved",
    maxSteps: 5,
    timeoutMs: 5_000,
    steps: [
      { id: "navigate", type: "navigate", url: "https://github.com/p90-lover/coding-tools-mcp" },
      { id: "assert", type: "assert", expression: "release-visible" },
    ],
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(executed, ["navigate", "assert"]);
});

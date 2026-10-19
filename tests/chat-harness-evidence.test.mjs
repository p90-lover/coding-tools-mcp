import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../desktop-electron/src/features/AgentOrchestratorRunEvidence.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
const element = (type, props) => ({ type, props });
vm.runInNewContext(compiled, { exports, require(name) {
  assert.equal(name, "react/jsx-runtime");
  return { jsx: element, jsxs: element, Fragment: Symbol("fragment") };
} });
const render = (props) => {
  const text = (value) => value == null || typeof value === "boolean" ? "" : Array.isArray(value)
    ? value.map(text).join(" ") : typeof value === "object" ? text(value.props?.children) : String(value);
  return text(exports.AgentOrchestratorRunEvidence(props));
};
const run = () => ({ nodes: [
  { id: "one", settings: { name: "Worker one" }, receipt: { request_key: "worker-attempt", acceptance_evidence: [
    { path: "result.txt", expected_sha256: "a".repeat(64), planner_request_key: "plan-attempt", worker_request_key: "worker-attempt", passed: true },
  ] } },
  { id: "two", settings: { name: "Worker two" } },
], assignments: {
  one: { planner_request_key: "plan-attempt", checks: [{ path: "result.txt", sha256: "a".repeat(64) }] },
  two: { skip_reason: "No independent work needed" },
} });

test("run evidence distinguishes observed timing, explicit skips and host snapshot checks", () => {
  const output = render({ run: run(), metrics: { version: 1, observed_wall_ms: 1500, startup_wait_ms: 200, node_active_ms: 3000, approval_wait_ms: 100, counts: { retained_attempts: 2, retained_retries: 1 } } });
  for (const expected of ["1.5 s", "3.0 s", "Simultaneous agents", "skipped", "No independent work needed", "Verified snapshot", "do not prove tests passed", "provider latency are unavailable"]) assert.ok(output.includes(expected), expected);
});

test("run evidence does not present missing or stale checks as verified", () => {
  const current = run();
  current.nodes[0].receipt.acceptance_evidence[0].worker_request_key = "old-worker";
  assert.ok(render({ run: current, metrics: null }).includes("Outdated evidence"));
  current.nodes[0].receipt.acceptance_evidence[0].worker_request_key = "worker-attempt";
  current.nodes[0].receipt.acceptance_evidence[0].planner_request_key = "old-plan";
  assert.ok(render({ run: current, metrics: null }).includes("Outdated evidence"));
  current.nodes[0].receipt.acceptance_evidence[0].planner_request_key = "plan-attempt";
  current.nodes[0].receipt.acceptance_evidence[0].passed = false;
  assert.ok(render({ run: current, metrics: null }).includes("Verification failed"));
  current.nodes[0].receipt.acceptance_evidence = [];
  const output = render({ run: current, metrics: null });
  assert.ok(output.includes("Not verified"));
  assert.ok(output.includes("No timing observations"));
  assert.ok(!output.includes("Verified snapshot"));
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const typescript = require("typescript");

const filename = path.join(__dirname, "../src/features/execution-surface-utils.ts");
const compiled = typescript.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText;
const utilities = { exports: {} };
vm.runInNewContext(compiled, { exports: utilities.exports }, { filename });

test("task normalization accepts original Anneal name/status fields", () => {
  const tasks = utilities.exports.taskOptions({ tasks: [
    { id: "anneal-1", name: "Fix browser delivery", status: "IN_PROGRESS" },
    { id: "local-1", title: "Review", state: "REVIEW" },
  ] });
  assert.equal(tasks[0].title, "Fix browser delivery");
  assert.equal(tasks[0].state, "IN_PROGRESS");
  assert.equal(tasks[1].title, "Review");
  assert.equal(tasks[1].state, "REVIEW");
});

test("execution bindings never silently substitute a different provider or model", () => {
  const validBinding = {
    id: "web-binding", engine: "paseo", provider: "chatgpt-web", model: "chatgpt-web/high",
    endpoint: "http://127.0.0.1:17841/v1", enabled: true, connected: true, current_scope_valid: true,
  };
  const view = { execution: { bindings: [
    { ...validBinding, id: "foreign-binding", provider: "gemini-api" },
    { ...validBinding, id: "different-model", model: "chatgpt-web/medium" },
    { ...validBinding, id: "stale-binding", current_scope_valid: false },
  ] } };
  assert.equal(utilities.exports.selectBinding(view, "paseo", "chatgpt-web", "chatgpt-web/high"), undefined);
  view.execution.bindings.push(validBinding);
  assert.equal(utilities.exports.selectBinding(view, "paseo", "chatgpt-web", "chatgpt-web/high").id, "web-binding");
});

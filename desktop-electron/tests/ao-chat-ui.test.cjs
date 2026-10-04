const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { randomUUID } = require("node:crypto");

function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, structuredClone, crypto: { randomUUID },
    require: name => name === "react" || name === "react/jsx-runtime" ? require(name) : imports[name] ?? {} });
  return exports;
}
const chat = load("ao-chat.ts");
const roles = load("AgentOrchestratorRoleEditor.tsx", { "./ao-chat": chat });
const ui = load("AgentOrchestratorChat.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null } });

test("opening a working role shows live step and output, not a final-result placeholder", () => {
  const team = roles.defaultTeam("workspace", roles.workerRoute(roles.DEFAULT_WORKER_HARNESS, roles.DEFAULT_WORKER_MODEL));
  const node = { ...team.nodes[1], state: "running" };
  const mission = { id: "run", project_id: "task", nodes: [node], team };
  const html = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, {
    node, mission, draft: team, harnesses: [], loadModels: async () => [], busy: false,
    change() {}, apply() {}, discard() {}, taskName: () => "Task",
    activity: { "run:worker": { activity: "Reading parser files", output: "Found two affected call sites", started_at_ms: Date.now() - 4000, last_event_at_ms: Date.now() } },
  }));
  assert.ok(html.includes("Reading parser files"));
  assert.ok(html.includes("Found two affected call sites"));
  assert.ok(html.includes('aria-selected="true">output'));
});

test("sending a new chat displays its task title and user message before startup completes", () => {
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [], tasks: [], selectedTaskId: "", busy: true, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
    pendingMessage: "Find the real parser failure", pendingTitle: "New task", pendingCreation: true,
  }));
  assert.ok(html.includes("Find the real parser failure"));
  assert.ok(html.includes("<h2>New task</h2>"));
  assert.ok(html.includes("Starting"));
});

test("normal asynchronous startup detail is not shown as a failed launch", () => {
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "pending" }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const starting = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, working: true, notice: "Awaiting local approval" }));
  assert.equal(starting.includes("The run could not start"), false);
  const failed = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, working: false, notice: "Codex CLI unavailable" }));
  assert.ok(failed.includes("The run could not start"));
});

test("terminal failed work never becomes a successful chat just because review finished", () => {
  const status = chat.chatRunStatus({ id: "run", project_id: "task", cancelled: false, nodes: [
    { id: "lead", role: "planner", state: "finished" },
    { id: "worker", role: "worker", state: "failed", receipt: { error: "account pool unavailable", answer: "Partial trace" } },
    { id: "retry", role: "retry", state: "pending" },
    { id: "review", role: "reviewer", state: "finished" },
  ] });
  assert.equal(status, "attention");
  const messages = chat.chatTranscript([{ id: "run", project_id: "task", cancelled: false, nodes: [
    { id: "worker", role: "worker", state: "failed", receipt: { error: "account pool unavailable", answer: "Partial trace" } },
  ] }], "Investigate it");
  assert.ok(messages.some(message => message.text.includes("Partial trace") && message.text.includes("account pool unavailable")));
});

test("mission inspectors keep Retry structural changes in saved team templates", () => {
  const team = roles.defaultTeam("workspace", roles.workerRoute(roles.DEFAULT_WORKER_HARNESS, roles.DEFAULT_WORKER_MODEL));
  const node = team.nodes[1];
  const props = { node, mission: { id: "run", project_id: "task", nodes: [node], team }, draft: team,
    harnesses: [{ id: roles.DEFAULT_WORKER_HARNESS, label: "Claude Code", runnable: true, installed: true }],
    loadModels: async () => [], busy: false, change() {}, apply() {}, discard() {}, taskName: () => "Task" };
  const mission = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, props));
  assert.match(mission.match(/<option[^>]*value="retry"[^>]*>/)[0], /disabled/);
  assert.ok(mission.includes("Configure Retry roles in Runtime"));
  const template = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, { ...props, template: true }));
  assert.doesNotMatch(template.match(/<option[^>]*value="retry"[^>]*>/)[0], /disabled/);
  const retry = { ...node, role: "retry" };
  const locked = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, {
    ...props, node: retry, mission: { ...props.mission, nodes: [retry] },
    draft: { ...team, nodes: team.nodes.map(role => role.id === node.id ? retry : role) },
  }));
  assert.match(locked, /<label>Role<select[^>]*disabled/);
});

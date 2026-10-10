const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");

function load(file, imports = {}) {
  const exports = {};
  const absolute = path.resolve(__dirname, "../src/features", file);
  if (!fs.existsSync(absolute)) return exports;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, crypto: { randomUUID }, structuredClone, require: name => imports[name] ?? {} });
  return exports;
}
const roles = load("AgentOrchestratorRoleEditor.tsx");
const teamEditor = load("AgentOrchestratorTeam.tsx", { "./AgentOrchestratorRoleEditor": roles });
const teams = load("AgentOrchestratorTeamsSurface.tsx", { "./AgentOrchestratorRoleEditor": roles, "./AgentOrchestratorTeam": teamEditor });
const fixture = () => roles.defaultTeam("workspace-a", roles.workerRoute(roles.DEFAULT_WORKER_HARNESS, roles.DEFAULT_WORKER_MODEL));

test("a mission editor never replaces its own snapshot with an unrelated default team", () => {
  const original = fixture(), other = fixture();
  original.name = "Original";
  other.name = "Other default";
  const mission = { id: "run", workspace_id: "workspace-a", nodes: [], team: original };
  const draft = roles.teamForMission(mission, other);
  assert.equal(draft.id, original.id);
  draft.nodes[0].settings.name = "Changed draft";
  assert.notEqual(mission.team.nodes[0].settings.name, "Changed draft");
});

test("duplicating a team keeps role configuration and layout, not default status or revisions", () => {
  assert.equal(typeof teams.duplicateTeam, "function");
  const original = fixture();
  original.revision = 4; original.is_default = true;
  original.nodes[1].positioned = true; original.nodes[1].x = 190; original.nodes[1].y = 215;
  original.nodes[1].settings.role_name = "Security auditor";
  const before = structuredClone(original);
  const copy = teams.duplicateTeam(original);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.workspace_id, original.workspace_id);
  assert.equal(copy.revision, 0);
  assert.equal(copy.is_default, false);
  assert.equal(copy.nodes[1].x, 190);
  assert.equal(copy.nodes[1].settings.role_name, "Security auditor");
  assert.equal(JSON.stringify(original), JSON.stringify(before));
});

test("team graph helper roles preserve explicit worker chains and add the review split only when needed", () => {
  assert.equal(typeof teams.prepareTeamGraph, "function");
  const original = fixture();
  const next = structuredClone(original);
  next.nodes.push({ ...structuredClone(next.nodes[1]), id: "worker-2", parents: ["worker"] });
  let prepared = teams.prepareTeamGraph(next, original);
  assert.deepEqual(Array.from(prepared.nodes.find(n => n.id === "worker-2").parents), ["worker"]);
  assert.equal(prepared.editable_graph, true);
  const before = structuredClone(prepared);
  prepared.nodes.push({ ...structuredClone(prepared.nodes[2]), id: "sub", role: "sub_reviewer", parents: ["lead"] });
  prepared = teams.prepareTeamGraph(prepared, before);
  const split = prepared.nodes.find(n => n.role === "review_split");
  assert.ok(split);
  assert.ok(prepared.nodes.find(n => n.id === "sub").parents.includes(split.id));
  assert.ok(prepared.nodes.find(n => n.role === "reviewer").parents.includes("sub"));
  assert.deepEqual(Array.from(prepared.nodes.find(n => n.id === "worker-2").parents), ["worker"]);
});

test("the Runtime team manager reuses the overview canvas and hides execution tabs in template mode", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  assert.match(app, /label="Orchestrator Team"/);
  assert.match(app, /surface === "agent-orchestrator-teams"/);
  const absolute = path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx");
  assert.ok(fs.existsSync(absolute));
  const source = fs.readFileSync(absolute, "utf8");
  assert.match(source, /<AgentOrchestratorCanvas/);
  assert.match(source, /<AgentOrchestratorRoleEditor/);
  assert.match(source, /template/);
});

test("the team page has a left palette of roles and preset workers, and an explicit save beside auto-save", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx"), "utf8");
  assert.match(source, /<aside className="ao-teams-palette" aria-label="Add roles">/);
  for (const role of ["worker", "approver", "sub_reviewer", "retry"]) assert.ok(source.includes(`add("${role}")`), role);
  for (const preset of ["Frontend", "Backend", "Tester", "Researcher", "Security auditor", "Docs writer", "DevOps"]) assert.match(source, new RegExp(`roleName: "${preset}"`));
  assert.match(source, /role_name: preset\.roleName, specialty: preset\.specialty/, "a preset worker carries its role name and specialty");
  assert.match(source, /\{saving \? "Saving…" : dirty \? "Save team" : "Saved"\}/);
});

test("a saved team can be deleted from the team page; the last team stays and chats keep their copy", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx"), "utf8");
  assert.ok(source.includes('operation: "delete_team", team_id: saved.id, expected_revision: saved.revision'));
  assert.ok(source.includes("teams.length < 2"), "the last team cannot be deleted");
  assert.ok(source.includes("Existing chats keep their own copy of it."), "deletion is confirmed");
  const workflow = fs.readFileSync(path.resolve(__dirname, "../electron/agent-orchestrator-workflow.cjs"), "utf8");
  assert.ok(workflow.includes('["save_team", "delete_team", "apply_team", "set_limits"]'));
});

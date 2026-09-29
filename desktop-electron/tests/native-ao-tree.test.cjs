const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const surfaceExports = {};
vm.runInNewContext(compiled, {
  exports: surfaceExports,
  require: (name) => name === "react" ? {} : name === "react/jsx-runtime" ? {} : {},
});

const node = (id, role, parents = [], state = "pending") => ({ id, role, parents, state, x: 0, y: 0 });

test("AO tree keeps each run separate and stacks joins below both parents", () => {
  const run = { id: "one", nodes: [
    node("plan", "planner"), node("a", "worker", ["plan"]),
    node("b", "worker", ["plan", "a"]), node("review", "reviewer", ["a", "b"]),
  ] };
  assert.deepEqual(Array.from(surfaceExports.aoLevels(run), (level) => Array.from(level, (item) => item.id)),
    [["plan"], ["a"], ["b"], ["review"]]);
  assert.deepEqual(Array.from(surfaceExports.aoLevels({ id: "two", nodes: [node("other", "planner")] })[0], (item) => item.id), ["other"]);
});

test("AO dependency edit preserves parents and refuses active/cyclic cards", () => {
  const run = { id: "one", nodes: [
    node("plan", "planner"), node("a", "worker", ["plan"]),
    node("b", "worker", ["plan"]), node("review", "reviewer", ["a", "b"]),
  ] };
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoDependencyChange(run, "b", "a"))),
    { operation: "set_parents", node_id: "b", parents: ["plan", "a"] });
  assert.equal(surfaceExports.aoDependencyChange(run, "a", "review"), null);
  assert.equal(surfaceExports.aoDependencyChange(run, "a", "plan"), null);
  assert.equal(surfaceExports.aoDependencyChange({ ...run, nodes: run.nodes.map((entry) => entry.id === "b" ? { ...entry, state: "running" } : entry) }, "b", "a"), null);
});

test("preview is scoped to the selected run and waits for all parents", () => {
  const tasks = [{ id: "a", title: "Repair app" }, { id: "b", title: "Verify connector" }];
  const run = { id: "only-b", nodes: [
    { ...node("plan", "planner", [], "finished"), task_id: "b" },
    { ...node("work", "worker", ["plan"], "pending"), task_id: "b" },
    { ...node("review", "reviewer", ["work"], "pending"), task_id: "b" },
  ] };
  assert.match(surfaceExports.aoPreviewText(run, tasks), /Verify connector/);
  assert.doesNotMatch(surfaceExports.aoPreviewText(run, tasks), /Repair app/);
  assert.match(surfaceExports.aoPreviewText({ ...run, nodes: run.nodes.map((item) => item.id === "plan" ? { ...item, state: "held" } : item) }, tasks), /No ready card/);
});

test("the original AO board projects the same mission IDs and does not hide a sent turn after cancellation", () => {
  const boardSource = fs.readFileSync(path.resolve(__dirname, "../../module/agent-orchestrator/frontend/src/renderer/components/CodingToolsMissionBoard.tsx"), "utf8");
  const boardExports = {};
  vm.runInNewContext(ts.transpileModule(boardSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: boardExports, require: () => ({}) });
  const mission = { id: "mission-1", project_id: "task-1", nodes: [node("p", "planner", [], "finished"), node("w", "worker", ["p"], "running"), node("r", "reviewer", ["w"])] };
  const card = boardExports.missionCard({ ...mission, cancelled: true }, { id: "task-1", title: "Real mission" });
  assert.equal(card.id, "mission-1");
  assert.equal(card.title, "Real mission");
  assert.equal(card.state, "running");
  assert.equal(card.kanbanColumn, "validating");
  assert.equal(boardExports.missionCard({ ...mission, nodes: [] }).state, "pending");
  assert.equal(boardExports.missionCard({ ...mission, nodes: mission.nodes.map(item => ({ ...item, state: "finished" })) }).state, "finished");
});

test("canvas defaults flow downward and saved free positions do not reorder neighbouring blocks", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  const canvas = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: canvas, require: () => ({}) });
  const nodes = [node("p", "planner"), node("a", "worker", ["p"]), node("b", "worker", ["p"]), node("r", "reviewer", ["a", "b"])];
  const before = canvas.canvasLayout(nodes, surfaceExports.aoLevels({ nodes }));
  assert.ok(before.get("p").y < before.get("a").y && before.get("a").y < before.get("r").y);
  const moved = nodes.map(item => item.id === "a" ? { ...item, positioned: true, x: -420, y: 712 } : item);
  const after = canvas.canvasLayout(moved, surfaceExports.aoLevels({ nodes: moved }));
  assert.deepEqual(JSON.parse(JSON.stringify(after.get("a"))), { x: -420, y: 712 });
  assert.deepEqual(after.get("b"), before.get("b"));
  const selection = new Map([["a", { x: 9480, y: 10 }], ["b", { x: 9400, y: 90 }]]);
  const translated = canvas.moveCanvasSelection(selection, 100, -20);
  assert.deepEqual(JSON.parse(JSON.stringify([...translated])), [["a", { x: 9500, y: -10 }], ["b", { x: 9420, y: 70 }]]);
  assert.equal(selection.get("a").x, 9480);
});

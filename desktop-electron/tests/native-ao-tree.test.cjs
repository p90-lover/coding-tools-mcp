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

test("AO dependency edit preserves parents, allows any card but the orchestrator, refuses cycles", () => {
  const run = { id: "one", nodes: [
    node("plan", "planner"), node("a", "worker", ["plan"]),
    node("b", "worker", ["plan"]), node("review", "reviewer", ["a", "b"]),
  ] };
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoDependencyChange(run, "b", "a"))),
    { operation: "set_parents", node_id: "b", parents: ["plan", "a"] });
  assert.equal(surfaceExports.aoDependencyChange(run, "a", "review"), null);
  assert.equal(surfaceExports.aoDependencyChange(run, "a", "plan"), null);
  // A working card can be relinked now (the engine stops and reruns it); the orchestrator never takes links.
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoDependencyChange({ ...run, nodes: run.nodes.map((entry) => entry.id === "b" ? { ...entry, state: "running" } : entry) }, "b", "a"))),
    { operation: "set_parents", node_id: "b", parents: ["plan", "a"] });
  assert.equal(surfaceExports.aoDependencyChange(run, "plan", "a"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoDependencyChange(run, "review", "plan"))),
    { operation: "set_parents", node_id: "review", parents: ["a", "b", "plan"] });
});

test("AO links can be removed and any card but the orchestrator can be removed", () => {
  const run = { id: "one", nodes: [
    node("plan", "planner"), node("a", "worker", ["plan"]),
    node("b", "worker", ["plan", "a"]), node("review", "reviewer", ["a", "b"]),
  ] };
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoUnlinkChange(run, "b", "a"))),
    { operation: "set_parents", node_id: "b", parents: ["plan"] });
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoUnlinkChange(run, "a", "plan"))),
    { operation: "set_parents", node_id: "a", parents: [] }, "the engine links a card left without links to the orchestrator");
  assert.equal(surfaceExports.aoUnlinkChange(run, "b", "review"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(surfaceExports.aoRemoveChange(run, "a"))), { operation: "remove_node", node_id: "a" });
  assert.equal(surfaceExports.aoRemoveChange(run, "plan"), null);
  assert.equal(surfaceExports.aoNodeWorking({ state: "running" }), true);
  assert.equal(surfaceExports.aoNodeWorking({ state: "pending" }), false);
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

const boardSource = fs.readFileSync(path.resolve(__dirname, "../../module/agent-orchestrator/frontend/src/renderer/components/CodingToolsMissionBoard.tsx"), "utf8");
const costSource = fs.readFileSync(path.resolve(__dirname, "../../module/agent-orchestrator/frontend/src/renderer/lib/format-cost.ts"), "utf8");
const costExports = {};
vm.runInNewContext(ts.transpileModule(costSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: costExports });
const boardExports = {};
vm.runInNewContext(ts.transpileModule(boardSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: boardExports, require: name => name === "../lib/format-cost" ? costExports : {} });

const route = (harness_id, model) => ({ harness_id, model });
const receipt = (harness, model, thread_id, started_at_ms = 1000) => ({
  status: "finished", route: route(harness, model), thread_id, started_at_ms,
});
const usage = (sessionId, totalNanos, coverage = "complete", incomplete = false) => ({
  sessionId, incomplete, processedTokens: 10, totalTokens: 10,
  estimatedCost: totalNanos === null ? null : { totalNanos, coverage, inputNanos: totalNanos, cachedInputNanos: null, outputNanos: 0, providerAttribution: "observed" },
});

test("the original AO board projects the same mission IDs and does not hide a sent turn after cancellation", () => {
  const mission = { id: "mission-1", project_id: "task-1", nodes: [node("p", "planner", [], "finished"), node("w", "worker", ["p"], "running"), node("r", "reviewer", ["w"])] };
  const card = boardExports.missionCard({ ...mission, cancelled: true }, { id: "task-1", title: "Real mission" });
  assert.equal(card.id, "mission-1");
  assert.equal(card.title, "Real mission");
  assert.equal(card.state, "running");
  assert.equal(card.kanbanColumn, "validating");
  assert.equal(boardExports.missionCard({ ...mission, nodes: [] }).state, "pending");
  assert.equal(boardExports.missionCard({ ...mission, nodes: mission.nodes.map(item => ({ ...item, state: "finished" })) }).state, "finished");
});

test("mission timestamps use task Unix seconds without inventing absent receipt start times", () => {
  // Shape and units captured from the board/usage read APIs; identifiers and title are fixture-only.
  const task = { id: "task", title: "Timestamp fixture", created_at: 1790939383, updated_at: 1790940481 };
  const attempt = { status: "finished", thread_id: "workspace-2", route: route("ao:codex", "cpa/gpt-5.5") };
  const mission = { id: "mission", project_id: task.id, nodes: [{ ...node("w", "worker", [], "finished"), receipt: attempt }] };
  const summaries = new Map([["workspace-2", usage("workspace-2", 126241000)]]);
  const card = boardExports.missionCard(mission, task, summaries);
  assert.equal(card.updatedAt, "2026-10-02T11:28:01.000Z");
  assert.equal(card.startedAt, null, "legacy receipt start cannot be inferred from the task update time");
  assert.equal(card.elapsedLabel, null);
  assert.equal(card.usage.compactLabel, "Est. $0.13");
  const current = { ...mission, nodes: [{ ...mission.nodes[0], receipt: { ...attempt, started_at_ms: 1790940481123 } }] };
  assert.equal(boardExports.missionCard(current, task, summaries).startedAt, "2026-10-02T11:28:01.123Z", "receipt times are already milliseconds");
});

test("mission metadata names each receipt route, not a changed configuration or one false provider", () => {
  const card = boardExports.missionCard({ id: "routes", nodes: [
    { ...node("worker", "worker", [], "finished"), route: route("ao:codex", "configured-new"), receipt: receipt("ao:claude-code", "claude-actual", "s1"), history: [receipt("ao:codex", "gpt-old", "s0")] },
    { ...node("review", "reviewer"), route: route("codex-native", "chatgpt-web/high") },
  ] });
  assert.ok(Array.isArray(card.routes), "actual and configured route metadata must be present");
  assert.deepEqual(Array.from(card.routes, item => [item.harness, item.model, item.configured]), [
    ["ao:codex", "gpt-old", false], ["ao:claude-code", "claude-actual", false], ["codex-native", "chatgpt-web/high", true],
  ]);
  assert.equal(card.provider, "mixed");
  assert.doesNotMatch(card.routes.map(item => item.model).join(" "), /configured-new/);
  const unknown = boardExports.missionCard({ id: "legacy", nodes: [{ ...node("w", "worker", [], "finished"), route: route("ao:codex", "changed"), receipt: { status: "finished", thread_id: "old" } }] });
  assert.equal(unknown.routes[0].harness, "unknown");
  assert.equal(unknown.routes[0].configured, false, "missing historic route must not be silently replaced by current configuration");
});

test("mission cost deduplicates AO session IDs across receipts and histories and exposes missing coverage", () => {
  const old = receipt("ao:codex", "gpt", "s1");
  const current = receipt("ao:claude-code", "claude", "s2", 3000);
  const mission = { id: "cost", nodes: [
    { ...node("a", "worker", [], "finished"), receipt: current, history: [old, current] },
    { ...node("b", "reviewer", [], "finished"), receipt: old },
    { ...node("c", "worker", [], "finished"), receipt: receipt("ao:codex", "gpt", "missing") },
  ] };
  const summaries = new Map([["s1", usage("s1", 100_000_000)], ["s2", usage("s2", 200_000_000)]]);
  const card = boardExports.missionCard(mission, undefined, summaries);
  assert.ok(Array.isArray(card.sessionIds), "usage must be keyed by real AO session IDs");
  assert.deepEqual(Array.from(card.sessionIds).sort(), ["missing", "s1", "s2"]);
  assert.equal(card.usage.compactLabel, "Est. $0.30 · partial");
  assert.match(card.usage.accessibleLabel, /2\/3 AO sessions priced/);
  assert.match(card.costCoverage, /2\/3 AO sessions priced/);
  summaries.set("missing", usage("missing", 0));
  assert.equal(boardExports.missionCard(mission, undefined, summaries).usage.compactLabel, "Est. $0.30");
  summaries.set("s1", usage("s1", 100_000_000, "partial"));
  assert.match(boardExports.missionCard(mission, undefined, summaries).usage.compactLabel, /partial/);
  summaries.set("s1", usage("s1", 100_000_000, "complete", true));
  assert.match(boardExports.missionCard(mission, undefined, summaries).usage.compactLabel, /partial/);
});

test("mission cost distinguishes unavailable from measured zero and never prices native WebGPT as zero", () => {
  const mission = { id: "zero", nodes: [{ ...node("w", "worker", [], "finished"), receipt: receipt("ao:codex", "gpt", "s1") }] };
  for (const total of [null, undefined, NaN, -1]) {
    const card = boardExports.missionCard(mission, undefined, new Map([["s1", usage("s1", total)]]));
    assert.equal(card.usage?.compactLabel, "Cost unavailable");
  }
  assert.equal(boardExports.missionCard(mission, undefined, new Map([["s1", usage("s1", 0)]])).usage.compactLabel, "Est. $0.00");
  const native = { id: "native", nodes: [{ ...node("p", "planner", [], "finished"), receipt: receipt("codex-native", "chatgpt-web/high", "native-thread") }] };
  const nativeCard = boardExports.missionCard(native, undefined, new Map([["native-thread", usage("native-thread", 0)]]));
  assert.equal(nativeCard.usage.compactLabel, "Cost unavailable");
  assert.match(nativeCard.costCoverage, /Native WebGPT cost unavailable/);
  const mixed = boardExports.missionCard({ ...mission, nodes: [...mission.nodes, ...native.nodes] }, undefined, new Map([["s1", usage("s1", 0)]]));
  assert.equal(mixed.usage.compactLabel, "Est. $0.00 · partial");
});

test("mission timing uses the reservation of active attempts only and does not grow a finished duration", () => {
  const mission = { id: "clock", cancelled: true, nodes: [{
    ...node("w", "worker", [], "running"), receipt: receipt("ao:codex", "gpt", "s1", 61_000),
    history: [receipt("ao:codex", "gpt", "old", 1000)],
  }] };
  const running = boardExports.missionCard(mission, undefined, undefined, 126_000);
  assert.equal(running.state, "running");
  assert.equal(running.startedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(running.elapsedLabel, "1m 5s");
  assert.equal(boardExports.missionCard(mission, undefined, undefined, 127_000).elapsedLabel, "1m 6s");
  for (const state of ["finished", "held", "archived", "cancelled", "pending"]) {
    const settled = { ...mission, cancelled: false, nodes: mission.nodes.map(item => ({ ...item, state })) };
    const earlier = boardExports.missionCard(settled, undefined, undefined, 126_000);
    const later = boardExports.missionCard(settled, undefined, undefined, 186_000);
    assert.equal(earlier.elapsedLabel, null);
    assert.equal(later.elapsedLabel, null);
    assert.equal(earlier.startedAt, later.startedAt);
  }
  const missing = boardExports.missionCard({ id: "old", nodes: [node("w", "worker", [], "running")] }, undefined, undefined, 126_000);
  assert.equal(missing.startedAt, null);
  assert.equal(missing.elapsedLabel, null);
});

test("mission board scopes usage to the AO project, never the task ID or all projects while unresolved", () => {
  const hookSource = fs.readFileSync(path.resolve(__dirname, "../../module/agent-orchestrator/frontend/src/renderer/hooks/useSessionUsageSummaries.ts"), "utf8");
  const hookExports = {};
  vm.runInNewContext(ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: hookExports, require: () => ({}) });
  const mission = { id: "mission", project_id: "task-not-project", nodes: [{ ...node("w", "worker", [], "finished"), receipt: receipt("ao:codex", "gpt", "real-session") }] };
  for (const projectId of ["ao-project", null, undefined]) {
    const queries = [];
    const view = {};
    const jsx = (type, props) => ({ type, props });
    vm.runInNewContext(ts.transpileModule(boardSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      exports: view,
      require: name => {
        if (name === "react") return { useState: initial => [typeof initial === "function" ? initial() : initial, () => {}], useEffect: () => {} };
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
        if (name === "@tanstack/react-query") return { useQuery: options => {
          queries.push(options);
          return options.queryKey[0] === "coding-tools-missions"
            ? { data: projectId === undefined ? undefined : { projectId, runs: [mission], tasks: [] }, isSuccess: projectId !== undefined }
            : { data: new Map([["real-session", usage("real-session", 200_000_000)]]) };
        } };
        if (name === "../hooks/useSessionUsageSummaries") return hookExports;
        if (name === "../lib/format-cost") return costExports;
        if (name === "../lib/session-presentation") return { boardKanbanColumnOrder: [] };
        if (name === "@aoagents/product-ui") return { SessionsBoardGridView: "mission-grid" };
        return {};
      },
    });
    const rendered = view.CodingToolsMissionBoard({ workspaceId: "workspace" });
    const query = queries.find(item => item.queryKey[0] === "session-usage");
    assert.ok(query, "the real AO session usage query must be wired into the mission board");
    assert.equal(query.enabled, Boolean(projectId));
    if (projectId) assert.deepEqual(Array.from(query.queryKey), ["session-usage", "ao-project"]);
    const grid = rendered.props.children.at(-1).props.children;
    if (projectId !== undefined) assert.equal(grid.props.sessions[0].usage.compactLabel, projectId ? "Est. $0.20" : "Cost unavailable");
  }
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

test("shift-click links or unlinks relative to the active card under free links", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  const canvas = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: canvas, require: () => ({}) });
  const decide = (run, starter, target) => JSON.parse(JSON.stringify(canvas.shiftLinkAction(starter, target,
    (id, parentId) => Boolean(surfaceExports.aoDependencyChange(run, id, parentId)),
    (id, parentId) => Boolean(surfaceExports.aoUnlinkChange(run, id, parentId)))));
  const open = { nodes: [node("plan", "planner"), node("a", "worker", ["plan"]), node("b", "worker", ["plan"]), node("review", "reviewer", ["a", "b"])] };
  assert.deepEqual(decide(open, "a", "b"), { kind: "connect", id: "b", parentId: "a" }, "the clicked card goes below the starter");
  assert.deepEqual(decide(open, "b", "a"), { kind: "connect", id: "a", parentId: "b" });
  const linked = { nodes: open.nodes.map((entry) => entry.id === "b" ? { ...entry, parents: ["plan", "a"] } : entry) };
  assert.deepEqual(decide(linked, "a", "b"), { kind: "disconnect", id: "b", parentId: "a" });
  assert.deepEqual(decide(linked, "b", "a"), { kind: "disconnect", id: "b", parentId: "a" }, "either click order unlinks");
  // Free links: any link can be removed; a card left unlinked waits on the orchestrator.
  assert.deepEqual(decide(linked, "plan", "a"), { kind: "disconnect", id: "a", parentId: "plan" });
  assert.deepEqual(decide(linked, "a", "review"), { kind: "disconnect", id: "review", parentId: "a" });
  assert.equal(decide(linked, "a", "a"), null);
});

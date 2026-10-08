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

const repoRoot=path.resolve(__dirname,"../..");
const nativeRoot=process.env.CODING_TOOLS_AO_TEST_SOURCE_ROOT || path.join(repoRoot,"module/agent-orchestrator");
const {execFileSync}=require("node:child_process");
const stageRoot=fs.mkdtempSync(path.join(repoRoot,"aiTemp/native-board-unit-"));
const pin=execFileSync("git",["rev-parse","HEAD:module/agent-orchestrator"],{cwd:repoRoot,encoding:"utf8"}).trim();
const sourceFiles=["frontend/src/renderer/components/CodingToolsMissionBoard.tsx","frontend/src/renderer/lib/coding-tools-bridge.ts"];
for(const file of sourceFiles){
  const destination=path.join(stageRoot,file);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,execFileSync("git",["show",pin+":"+file],{cwd:nativeRoot,encoding:"utf8"}));
}
const patch=path.join(repoRoot,"desktop-electron/patches/agent-orchestrator/mission-live-config-usage.patch");
if(fs.statSync(patch).size) execFileSync("git",["apply","--directory="+path.relative(repoRoot,stageRoot).split(path.sep).join("/"),patch],{cwd:repoRoot,windowsHide:true});
test.after(()=>fs.rmSync(stageRoot,{recursive:true,force:true}));
const boardSource = fs.readFileSync(path.join(stageRoot,sourceFiles[0]),"utf8");
const costSource = fs.readFileSync(path.join(nativeRoot, "frontend/src/renderer/lib/format-cost.ts"), "utf8");
const costExports = {};
vm.runInNewContext(ts.transpileModule(costSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: costExports });
const tokenSource = fs.readFileSync(path.join(nativeRoot, "packages/product-ui/src/formatting.ts"), "utf8");
const tokenExports = {};
vm.runInNewContext(ts.transpileModule(tokenSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: tokenExports });
const boardExports = {};
vm.runInNewContext(ts.transpileModule(boardSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: boardExports, require: name => name === "../lib/format-cost" ? costExports : name === "../lib/format-token-count" ? tokenExports : {} });

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
  assert.equal(card.state, "cancelled");
  assert.equal(card.kanbanColumn, "ready");
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
  assert.equal(card.usage.compactLabel, "10 tok", "AO vendor pricing is not CPA authority");
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

test("mission CPA cost consumes scoped host accounting, deduplicates receipt identities and rejects vendor pricing authority",()=>{
  const old=receipt("ao:codex","gpt","s1"),current=receipt("ao:claude-code","claude","s2",3000);
  const mission={id:"cost",nodes:[
    {...node("a","worker",[],"finished"),receipt:current,history:[old,current]},
    {...node("b","reviewer",[],"finished"),receipt:old},
    {...node("c","worker",[],"finished"),receipt:receipt("ao:codex","gpt","missing")}]};
  const summaries=new Map([["s1",usage("s1",999000000)],["s2",usage("s2",888000000)]]);
  const accounting={processedTokens:20,coverage:"partial",measuredSessions:2,requestedSessions:3,
    cost:{source:"CPA Helper",totalNanos:300000000,coverage:"partial"}};
  const card=boardExports.missionCard(mission,undefined,summaries,10000,accounting);
  assert.deepEqual(Array.from(card.sessionIds).sort(),["missing","s1","s2"]);
  assert.equal(card.usage.compactLabel,"CPA Est. $0.30 · partial");
  assert.match(card.costCoverage,/CPA Helper/);assert.match(card.costCoverage,/2\/3 sessions measured/);
  assert.equal(boardExports.missionCard(mission,undefined,summaries).usage.compactLabel,"20 tok · partial");
  accounting.cost.coverage="complete";accounting.coverage="complete";
  assert.equal(boardExports.missionCard(mission,undefined,summaries,10000,accounting).usage.compactLabel,"CPA Est. $0.30");
});

test("missing CPA price keeps tokens; measured CPA zero is distinct from unreported native usage",()=>{
  const mission={id:"zero",nodes:[{...node("w","worker",[],"finished"),receipt:receipt("ao:codex","gpt","s1")}]};
  for(const total of [null,undefined,NaN,-1,0]){
    const card=boardExports.missionCard(mission,undefined,new Map([["s1",usage("s1",total)]]));
    assert.equal(card.usage.compactLabel,"10 tok");assert.match(card.usage.accessibleLabel,/USD estimate not reported/);
  }
  const accounting={processedTokens:0,coverage:"complete",measuredSessions:1,requestedSessions:1,
    cost:{source:"CPA Helper",totalNanos:0,coverage:"complete"}};
  assert.equal(boardExports.missionCard(mission,undefined,undefined,1000,accounting).usage.compactLabel,"CPA Est. $0.00");
  const native={id:"native",nodes:[{...node("p","planner",[],"finished"),receipt:receipt("codex-native","chatgpt-web/high","n")}]};
  assert.equal(boardExports.missionCard(native,undefined,new Map([["n",usage("n",0)]])).usage.compactLabel,"Usage not reported");
  accounting.cost.totalNanos=null;
  assert.equal(boardExports.missionCard(mission,undefined,undefined,1000,accounting).usage.compactLabel,"0 tok");
});

test("scheduled, paused and hidden mission status outranks stale running nodes",()=>{
  const mission={id:"r",project_id:"t",nodes:[node("p","planner",[],"running")]};
  assert.equal(boardExports.missionCard({...mission,paused:true}).state,"paused");
  assert.equal(boardExports.missionCard(mission,undefined,undefined,1000,undefined,
    {task_id:"t",visibility:"active",schedule:{run_id:"r",state:"scheduled",due_at_ms:2000}}).state,"scheduled");
  assert.equal(boardExports.missionCard(mission,undefined,undefined,1000,undefined,
    {task_id:"t",visibility:"deleted"}).state,"deleted");
});

test("mission usage keeps observed tokens when a CPA dollar estimate is absent", () => {
  const first = receipt("ao:codex", "cpa/gpt-6.1-sol", "session-a");
  const second = receipt("ao:claude-code", "cpa/gpt-5.5", "session-b");
  const mission = { id: "unpriced", nodes: [
    { ...node("a", "worker", [], "finished"), receipt: first, history: [first] },
    { ...node("b", "reviewer", [], "finished"), receipt: second },
  ] };
  const summaries = new Map([
    ["session-a", { ...usage("session-a", null), processedTokens: 243032 }],
    ["session-b", { ...usage("session-b", null), processedTokens: 43129 }],
  ]);
  const card = boardExports.missionCard(mission, undefined, summaries);
  assert.equal(card.usage.compactLabel, "286.2K tok", "sessions repeated in history are counted once");
  assert.match(card.usage.accessibleLabel, /286,161 recorded tokens/);
  assert.match(card.usage.accessibleLabel, /USD estimate not reported/);
  assert.doesNotMatch(card.usage.compactLabel, /\$/);
  summaries.delete("session-b");
  assert.equal(boardExports.missionCard(mission, undefined, summaries).usage.compactLabel, "243K tok · partial");
  summaries.set("session-a", { ...usage("session-a", null), processedTokens: 0 });
  assert.equal(boardExports.missionCard({ ...mission, nodes: [mission.nodes[0]] }, undefined, summaries).usage.compactLabel, "0 tok");
  summaries.clear();
  assert.equal(boardExports.missionCard(mission, undefined, summaries).usage.compactLabel, "Usage not reported");
});

test("mission timing uses the reservation of active attempts only and does not grow a finished duration", () => {
  const mission = { id: "clock", cancelled: false, nodes: [{
    ...node("w", "worker", [], "running"), receipt: receipt("ao:codex", "gpt", "s1", 61_000),
    history: [receipt("ao:codex", "gpt", "old", 1000)],
  }] };
  const running = boardExports.missionCard(mission, undefined, undefined, 126_000);
  assert.equal(running.state, "running");
  assert.equal(running.startedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(running.elapsedLabel, "1m 5s");
  assert.equal(boardExports.missionCard({...mission,cancelled:true},undefined,undefined,127_000).elapsedLabel,null);
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
  const hookSource = fs.readFileSync(path.join(nativeRoot,"frontend/src/renderer/hooks/useSessionUsageSummaries.ts"), "utf8");
  const hookExports = {};
  vm.runInNewContext(ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: hookExports, require: () => ({}) });
  const mission = { id: "mission", project_id: "task-not-project", nodes: [{ ...node("w", "worker", [], "finished"), receipt: receipt("ao:codex", "gpt", "real-session") }] };
  for (const projectId of ["ao-project", null, undefined]) {
    const queries = [], navigation=[], actions=[];
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
        if (name === "../lib/coding-tools-bridge") return {openCodingToolsMission:async(...args)=>navigation.push(args),actionCodingToolsMission:async(...args)=>actions.push(args)};
        if (name === "../lib/format-cost") return costExports;
        if (name === "../lib/format-time") return {formatTimeCompact:value=>String(value)};
        if (name === "../lib/format-token-count") return tokenExports;
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
    if (projectId !== undefined) {
      assert.equal(grid.props.sessions[0].usage.compactLabel,projectId ? "10 tok" : "Usage not reported");
      const renderedCard=grid.props.renderSessionCard(grid.props.sessions[0]);
      const walk=e=>!e || typeof e!=="object" ? [] : Array.isArray(e) ? e.flatMap(walk) : [e,...walk(e.props?.children)];
      const group=renderedCard.props.children.props.action;
      assert.equal(group.props.className,"ct-mission-actions");
      const controls=walk(group).filter(e=>e.props?.["aria-label"]);
      for(const label of ["Mission","Overview","Schedule","Archive","Delete"]){
        const button=controls.find(e=>e.props["aria-label"]===label+" mission");
        assert.ok(button,label+" is available on hover/focus");
        button.props.onClick({stopPropagation(){}});
      }
      assert.deepEqual(navigation.map(args=>args.slice(0,2)),[["workspace","mission"],["workspace","mission"],["workspace","mission"]]);
      assert.deepEqual(actions,[["workspace","mission","archive"],["workspace","mission","delete"]]);
    }
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

test("overview resize keeps the native mission board mounted while collapsing its hit-test area", () => {
  const file = ts.createSourceFile("AgentOrchestratorSurface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let board;
  const visit = item => {
    if (ts.isJsxElement(item) && item.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "className"
      && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "ao-workspace-board")) board = item;
    ts.forEachChild(item, visit);
  };
  visit(file);
  assert.ok(board, "exercise the actual overview board render branch");
  const nativeBoard = () => {};
  const jsx = (type, props, key) => ({ type, props, key });
  const rendered = {};
  vm.runInNewContext(ts.transpileModule(`export function renderBoard({ overviewResizing, view = "overview", sheet = "", workspaceReady = true, workspaceId = "workspace" }) {
    return (${board.getText(file)});
  }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: rendered, AgentOrchestratorOriginalSurface: nativeBoard, setView: () => {},
    require: () => ({ jsx, jsxs: jsx }),
  });
  const before = rendered.renderBoard({ overviewResizing: false });
  const during = rendered.renderBoard({ overviewResizing: true });
  const after = rendered.renderBoard({ overviewResizing: false });
  assert.equal(before.props.children.type, nativeBoard);
  assert.equal(during.props.children?.type, nativeBoard, "dragging must not unmount and reopen the mission board");
  assert.equal(after.props.children.type, before.props.children.type);
  assert.equal(after.props.children.key, before.props.children.key, "release keeps the same React identity");
  assert.equal(during.props.style?.display, "none", "the mounted viewport collapses so its ResizeObserver suppresses native pointer interception");
  assert.notEqual(after.props.style?.display, "none", "release restores the board's measurable bounds");
  assert.equal(rendered.renderBoard({ overviewResizing: true, view: "chat" }).props.children, null);
  assert.equal(rendered.renderBoard({ overviewResizing: false, workspaceReady: false }).props.children, null);
  assert.equal(rendered.renderBoard({ overviewResizing: false, workspaceId: "" }).props.children, null);
  assert.equal(rendered.renderBoard({ overviewResizing: false, sheet: "settings" }).props.children.props.className, "ao-empty-state");
});

function mountResizableCanvas() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  const callbacks = [], observers = [], frames = new Map(), handlers = new Map();
  let nextFrame = 1;
  const box = { width: 1600, height: 1000, left: 0, top: 0 };
  const surface = { clientWidth: box.width, clientHeight: box.height, getBoundingClientRect: () => box,
    addEventListener: (name, callback) => handlers.set(name, callback), removeEventListener() {} };
  const scene = { style: {} }, cards = new Map();
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require: name => name === "react" ? {
      useRef: value => ({ current: value }), useState: value => [typeof value === "function" ? value() : value, () => {}],
      useLayoutEffect: effect => callbacks.push(effect),
    } : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : { ROLE_TITLE: {} },
    window: { clearTimeout() {}, setTimeout() {} },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} },
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const nodes = [node("p", "planner"), node("a", "worker", ["p"]), node("b", "worker", ["a"]), node("r", "reviewer", ["b"])];
  const tree = exports.AgentOrchestratorCanvas({ nodes, levels: surfaceExports.aoLevels({ nodes }), selectedId: "", busy: false,
    describe: () => "route", onSelect() {}, onMove: async () => {}, onConnect() {}, canConnect: () => false });
  const bind = element => {
    if (!element || typeof element !== "object") return;
    if (Array.isArray(element)) return element.forEach(bind);
    const ref = element.props?.ref;
    if (ref) {
      let target = { style: {}, offsetHeight: 76, setAttribute() {} };
      if (element.props.className === "ao-canvas") target = surface;
      if (element.props.className === "ao-canvas-scene") target = scene;
      if (element.props["data-ao-node"]) cards.set(element.props["data-ao-node"], target);
      if (typeof ref === "function") ref(target); else ref.current = target;
    }
    bind(element.props?.children);
  };
  bind(tree);
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  callbacks.forEach(effect => effect()); observers.forEach(callback => callback()); flush();
  const camera = () => {
    const match = scene.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
    return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
  };
  const rectangles = () => [...cards.values()].map(card => {
    const point = card.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    const view = camera();
    return { x: Number(point[1]) * view.scale + view.x, y: Number(point[2]) * view.scale + view.y,
      width: 212 * view.scale, height: 76 * view.scale };
  });
  return { camera, rectangles, box,
    resize(width, height) { Object.assign(box, { width, height }); Object.assign(surface, { clientWidth: width, clientHeight: height }); observers.forEach(callback => callback()); flush(); },
    pan(dx, dy) { handlers.get("wheel")({ deltaX: dx, deltaY: dy, preventDefault() {} }); flush(); },
    zoom() { handlers.get("wheel")({ ctrlKey: true, deltaY: -100, clientX: box.width / 2, clientY: box.height / 2, preventDefault() {} }); flush(); },
  };
}

test("canvas refits its automatic camera when the visible pane shrinks instead of retaining wide-screen zoom", () => {
  const canvas = mountResizableCanvas();
  assert.equal(canvas.camera().scale, 1.25);
  canvas.resize(880, 430);
  assert.ok(canvas.camera().scale < 1, "a real ResizeObserver callback reduces the former 125% camera");
  assert.ok(canvas.rectangles().every(card => card.x >= 0 && card.y >= 0 && card.x + card.width <= 880 && card.y + card.height <= 430),
    "all structure cards remain in the compact viewport");
  const compact = canvas.camera();
  canvas.resize(880, 430);
  assert.deepEqual(canvas.camera(), compact, "same-size observer events do not change camera intent");
});

test("canvas resize keeps a manually panned world centre, but recovers if all cards would be offscreen", () => {
  const canvas = mountResizableCanvas();
  canvas.pan(180, 40);
  canvas.zoom();
  const before = canvas.camera();
  const centre = { x: (canvas.box.width / 2 - before.x) / before.scale, y: (canvas.box.height / 2 - before.y) / before.scale };
  canvas.resize(1200, 800);
  const after = canvas.camera();
  assert.equal(after.scale, before.scale, "manual zoom is not reset on ordinary resize");
  assert.equal((600 - after.x) / after.scale, centre.x);
  assert.equal((400 - after.y) / after.scale, centre.y);
  canvas.pan(20_000, 20_000);
  canvas.resize(880, 430);
  assert.ok(canvas.rectangles().some(card => card.x + card.width > 0 && card.y + card.height > 0 && card.x < 880 && card.y < 430),
    "resize cannot leave only an empty canvas after manual navigation");
});

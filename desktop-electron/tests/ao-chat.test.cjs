const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
const chat = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: chat });
const plain = (value) => JSON.parse(JSON.stringify(value));

const node = (id, role, state, extra = {}) => ({ id, role, state, x: 0, ...extra });
const run = (id, taskId, nodes, extra = {}) => ({ id, project_id: taskId, cancelled: false, nodes, ...extra });

test("archived and deleted task metadata hides chats without losing explicit history or scheduled status", () => {
  const runs=[run("r1","a",[node("p","planner","pending")]),run("r2","b",[]),run("r3","c",[])];
  const tasks=[{id:"a",title:"A"},{id:"b",title:"B",state:"archived"},{id:"c",title:"C"}];
  const lifecycle=[{task_id:"a",visibility:"active",schedule:{run_id:"r1",state:"scheduled",due_at_ms:10000}},
    {task_id:"c",visibility:"deleted"}];
  const entries=plain(chat.chatList(runs,tasks,lifecycle));
  assert.equal(entries.length,1);
  assert.equal(entries[0].status,"scheduled");
  assert.equal(plain(chat.chatList(runs,tasks,lifecycle,true)).length,3);
});

test("a cancelled mission never presents its stale running node as still working", () => {
  const transcript=plain(chat.chatTranscript([run("r","a",[node("p","planner","running")],{cancelled:true})],"go"));
  assert.ok(!transcript.some(message=>message.kind==="status" && ["running","reserved"].includes(message.state)));
  assert.equal(transcript.at(-1).text,"Stopped");
});

test("configuration replacements keep the user's message index rather than consuming a follow-up", () => {
  const runs=[run("r1","a",[]),run("r2","a",[],{replaces_run_id:"r1"}),
    run("r3","a",[])];
  const transcript=plain(chat.chatTranscript(runs,"Original input\n\nFollow-up (2026-10-04 12:00 UTC):\nNew request"));
  assert.deepEqual(transcript.filter(message=>message.kind==="user").map(message=>[message.key,message.text]),
    [["r1:user","Original input"],["r3:user","New request"]]);
  assert.ok(transcript.some(message=>message.key==="r2:reconfigured"));
});


test("the task description splits into the first message and timestamped follow-ups", () => {
  const description = "fix the email dots\n\nFollow-up (2026-09-30 04:10 UTC):\nalso the time zone\n\nFollow-up (2026-09-30 05:00 UTC):\nand tests";
  assert.deepEqual(plain(chat.chatMessagesFromDescription(description)), [
    { text: "fix the email dots" },
    { stamp: "2026-09-30 04:10", text: "also the time zone" },
    { stamp: "2026-09-30 05:00", text: "and tests" },
  ]);
  assert.deepEqual(plain(chat.chatMessagesFromDescription("")), []);
});

test("chats group runs by task, newest first, titled 'New task' when the task is unnamed", () => {
  const runs = [
    run("r1", "a", [node("p", "planner", "finished")]),
    run("r2", "b", [node("p", "planner", "running")]),
    run("r3", "a", [node("p", "planner", "pending")]),
  ];
  const list = plain(chat.chatList(runs, [{ id: "b", title: "Fix auth" }]));
  assert.deepEqual(list.map((entry) => [entry.taskId, entry.title, entry.latestRunId, entry.status]), [
    ["a", "New task", "r3", "queued"],
    ["b", "Fix auth", "r2", "running"],
  ]);
  assert.deepEqual(list[0].runIds, ["r1", "r3"]);
});

test("chat status and whether a follow-up can be sent", () => {
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "held")])), "attention");
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "finished")], { paused: true })), "paused");
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "running")], { cancelled: true })), "stopped");
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "finished"), node("w", "worker", "cancelled")])), "done");
  assert.equal(chat.chatAcceptsMessage("done"), true);
  assert.equal(chat.chatAcceptsMessage("stopped"), true);
  assert.equal(chat.chatAcceptsMessage("running"), false);
  assert.equal(chat.chatAcceptsMessage(undefined), true, "a new chat accepts its first message");
  // A stuck run (never started, held, paused) no longer locks an old chat; only real work does.
  for (const status of ["queued", "attention", "paused"]) {
    assert.equal(chat.chatAcceptsMessage(status), true, status);
    assert.equal(chat.chatAcceptsMessage(status, true), false, `${status} while working`);
    assert.equal(chat.chatRunOpen(status), true, `${status} can be stopped`);
  }
  assert.equal(chat.chatRunOpen("done"), false);
  assert.equal(chat.chatRunOpen("stopped"), false);
});

test("the transcript pairs each message with that run's replies in orchestration order", () => {
  const runs = [
    run("r1", "t", [
      node("rev", "reviewer", "finished", { receipt: { answer: "APPROVED — looks good", verdict: "APPROVED" } }),
      node("w2", "worker", "finished", { x: 2, settings: { name: "Tests" }, receipt: { answer: "added tests" } }),
      node("w1", "worker", "finished", { x: 1, receipt: { answer: "fixed it" } }),
      node("p", "planner", "finished", { receipt: { answer: "two steps" } }),
    ]),
    run("r2", "t", [node("p", "planner", "running"), node("w", "worker", "pending")]),
  ];
  const description = "fix it\n\nFollow-up (2026-09-30 04:10 UTC):\nnow docs";
  const transcript = plain(chat.chatTranscript(runs, description));
  assert.deepEqual(transcript.map((message) => [message.kind, message.name ?? "", message.text]), [
    ["user", "", "fix it"],
    ["agent", "Orchestrator", "two steps"],
    ["agent", "Worker", "fixed it"],
    ["agent", "Tests", "added tests"],
    ["agent", "Main reviewer", "APPROVED — looks good"],
    ["user", "", "now docs"],
    ["status", "", "Orchestrator is working…"],
  ]);
  assert.equal(transcript[4].tone, "verdict");
  assert.equal(transcript[4].verdict, "APPROVED");
  assert.equal(transcript[5].stamp, "2026-09-30 04:10");
});

test("errors, holds, stops and a just-sent message all show in the transcript", () => {
  const runs = [run("r1", "t", [
    node("p", "planner", "finished", { receipt: { error: "model unavailable" } }),
    node("w", "worker", "held"),
  ], { cancelled: true })];
  const transcript = plain(chat.chatTranscript(runs, "go\n\nFollow-up (2026-09-30 06:00 UTC):\nretry"));
  assert.deepEqual(transcript.map((message) => [message.kind, message.text]), [
    ["user", "go"],
    ["agent", "model unavailable"],
    ["status", "Worker needs your attention"],
    ["status", "Stopped"],
    ["user", "retry"],
  ]);
  assert.equal(transcript[1].tone, "error");
});

test("a simple mission answered by the orchestrator alone shows one clean answer and a note", () => {
  const solo = run("r", "t", [
    node("p", "planner", "finished", { receipt: { answer: "It has 3 files.\n```solo\n{\"difficulty\":\"simple\"}\n```" } }),
    node("w", "worker", "finished"),
    node("v", "reviewer", "finished"),
  ], { solo: true });
  const transcript = plain(chat.chatTranscript([solo], "how many files?"));
  assert.deepEqual(transcript.map((item) => item.kind), ["user", "agent", "status"]);
  assert.equal(transcript[1].text, "It has 3 files.");
  assert.match(transcript[2].text, /orchestrator answered alone/);
});

test("the flattened solo marker from the web bridge is hidden too", () => {
  const live = "391\n\n17 multiplied by 23 equals 391.\n\nsolo\n\n`{\"difficulty\":\"simple\"}`";
  assert.equal(chat.withoutSoloBlock(live), "391\n\n17 multiplied by 23 equals 391.");
  assert.equal(chat.withoutSoloBlock("I went solo here.\nDone."), "I went solo here.\nDone.");
});

test("every message names how its card runs; a working card shows runtime, step and when it was last heard", () => {
  const now = 10 * 3_600_000;
  const describe = (entry) => `${entry.route.model} · ${entry.settings?.role_name || entry.role}`;
  const runs = [run("r1", "t", [
    node("p", "planner", "finished", { route: { harness_id: "codex-native", model: "chatgpt-web/high" }, receipt: { answer: "plan" } }),
    node("w", "worker", "running", { route: { harness_id: "ao:codex", model: "cpa/gpt-6-luna" }, settings: { role_name: "Auditor" },
      receipt: { started_at_ms: now - 2 * 3_600_000 - 58 * 60_000 } }),
  ])];
  const live = { "r1:w": { activity: "running a command", last_event_at_ms: now - 30_000, turn_started: true } };
  const transcript = plain(chat.chatTranscript(runs, "go", { describe, activity: live, now }));
  assert.equal(transcript[1].detail, "chatgpt-web/high · planner", "finished answers carry their card's description");
  assert.equal(transcript[2].detail, "cpa/gpt-6-luna · Auditor · running 2h 58m · running a command (last heard 30s ago)");
  assert.equal(transcript[2].stalled, false);
  assert.equal(transcript[2].text, "Worker is working…");
});

test("a card that is silent, or whose turn never started, for ten minutes is shown as possibly stuck", () => {
  const now = 10 * 3_600_000;
  const working = (receipt) => [run("r1", "t", [node("w", "worker", "running", { receipt })])];
  const silent = plain(chat.chatTranscript(working({ started_at_ms: now - 3 * 3_600_000 }), "go",
    { activity: { "r1:w": { activity: "thinking", last_event_at_ms: now - 2 * 3_600_000, turn_started: true } }, now }));
  assert.equal(silent[1].stalled, true);
  assert.match(silent[1].text, /may be stuck/);
  const neverStarted = plain(chat.chatTranscript(working({ started_at_ms: now - 3 * 3_600_000 }), "go",
    { activity: { "r1:w": { activity: "waiting for the turn to start", turn_started: false } }, now }));
  assert.equal(neverStarted[1].stalled, true, "the 3-hour Gemini case: submitted, no turn");
  const fresh = plain(chat.chatTranscript(working({ started_at_ms: now - 60_000 }), "go",
    { activity: { "r1:w": { turn_started: false } }, now }));
  assert.equal(fresh[1].stalled, false, "a minute in is not stuck");
  assert.equal(chat.chatDuration(42_000), "42s");
  assert.equal(chat.chatDuration(3 * 3_600_000), "3h");
});


test("a new chat's prompt is Codex's \"Do anything\" in either mode; follow-up and running prompts stay unchanged", () => {
  const component = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = { useMemo: calculate => calculate(), useEffect() {}, useRef: initial => ({ current: initial }), memo: component => component,
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}] };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: component, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "./ao-chat" ? chat
      : name === "./ChatWorkbench" ? { useWorkbenchAutoOpen() {} } : {},
  });
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const base = { runs: [], tasks: [], selectedTaskId: "", busy: false, loadDescription: async () => "", send: async () => {}, openStructure() {}, approvals: [], approve() {}, describeRoute: () => "", retryStart() {} };
  const placeholder = extra => walk(component.AgentOrchestratorChat({ ...base, ...extra })).find(item => item.type === "textarea").props.placeholder;
  assert.equal(placeholder({ composer: { mode: "single" } }), "Do anything");
  assert.equal(placeholder({ composer: { mode: "team" } }), "Do anything");
  assert.equal(placeholder({ composer: { mode: "single" }, selectedTaskId: "task" }), "Send a follow-up…");
  assert.equal(placeholder({ composer: { mode: "single" }, selectedTaskId: "task", working: true,
    runs: [run("active", "task", [node("worker", "worker", "running")])] }), "Running — a message now is sent when it finishes");
});

test("mission drafts retain actual role routes and instructions rather than another task's newer global template",()=>{
  const text=fs.readFileSync(path.resolve(__dirname,"../src/features/AgentOrchestratorRoleEditor.tsx"),"utf8");
  const roles={};
  vm.runInNewContext(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports:roles,require:()=>({}),structuredClone,crypto});
  const saved={id:"team",workspace_id:"ws",revision:5,name:"Shared",worker_limit:3,nodes:[
    node("role","planner","pending",{route:{model:"global-new"},settings:{instructions:"Other task"}})]};
  const mission={id:"old",workspace_id:"ws",worker_limit:2,team:{...saved,revision:2,nodes:[
    node("role","planner","pending",{route:{model:"mission-old"},settings:{instructions:"Original task"}})]},
    nodes:[node("current","planner","running",{template_role_id:"role",route:{model:"actual-model"},settings:{instructions:"Actual instructions"}})]};
  const draft=roles.teamForMission(mission,saved);
  assert.equal(draft.id,"team");assert.equal(draft.revision,5);
  assert.equal(draft.nodes[0].route.model,"actual-model");
  assert.equal(draft.nodes[0].settings.instructions,"Actual instructions");
  assert.equal(saved.nodes[0].route.model,"global-new");
});

// The header Team control (#252) opens this chat's own mission graph, whose role inspector edits
// that mission's captured draft (#256). It must never open another task's shared template or write.
test("toolbar Team opens this chat's own mission instead of another task's shared template",()=>{
  const text=fs.readFileSync(path.resolve(__dirname,"../src/features/AgentOrchestratorSurface.tsx"),"utf8");
  const ast=ts.createSourceFile("surface.tsx",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let initializer;
  const visit=node=>{if(ts.isVariableDeclaration(node) && node.name.getText(ast)==="openTeam")initializer=node.initializer.getText(ast);ts.forEachChild(node,visit);};
  visit(ast);assert.ok(initializer);
  const exports={}, selected=[], drafts=[];
  vm.runInNewContext(ts.transpileModule("exports.openTeam = "+initializer,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
    exports,chatMission:{id:"a",project_id:"task-a"},
    setSheet:()=>{},setInspectedId:()=>{},setView:()=>{},setSelectedRunId:id=>selected.push(id),setDraftTeam:value=>drafts.push(value),
    moduleCall:()=>{throw Error("Opening Team must not write")},
  });
  exports.openTeam();
  assert.deepEqual(selected,["a"],"the chat's own mission is selected");
  assert.deepEqual(drafts,[null],"no shared template is loaded as the draft");
});

test("delayed-start labels show a local deadline and a live seconds/minutes countdown",()=>{
  assert.match(chat.scheduledStartLabel(61000,1000),/1m 0s/);
  assert.match(chat.scheduledStartLabel(61000,2000),/59s/);
  assert.match(chat.scheduledStartLabel(1000,2000),/due now/i);
  assert.match(chat.scheduledStartLabel(61000,1000),/Starts at/);
});

test("declining a delayed start restores the previously valid pending configuration edit",async()=>{
  const {createLatestConfigQueue}=await import("../src/features/ao-config.ts");
  const text=fs.readFileSync(path.resolve(__dirname,"../src/features/AgentOrchestratorSurface.tsx"),"utf8");
  const ast=ts.createSourceFile("surface.tsx",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let initializer;const visit=node=>{if(ts.isVariableDeclaration(node) && node.name.getText(ast)==="submitSchedule")initializer=node.initializer.getText(ast);ts.forEachChild(node,visit);};visit(ast);
  const scope={workspaceId:"ws",taskId:"task",runId:"r"},draft={id:"team",nodes:[]},timers=new Map(),applied=[];
  const queue=createLatestConfigQueue({apply:async(_scope,value)=>applied.push(value),onState:()=>{},
    setTimer:fn=>{timers.set(1,fn);return 1},clearTimer:id=>timers.delete(id)});
  queue.enqueue(scope,draft);const exports={};let operation;
  vm.runInNewContext(ts.transpileModule("exports.submit = "+initializer,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
    exports,run:(_name,fn)=>{operation=fn();return operation},scheduleTarget:scope,
    draftScopes:{current:new Map([[JSON.stringify(["ws","task"]),scope]])},
    latestDrafts:{current:new Map([[JSON.stringify(["ws","task"]),draft]])},configuration:{current:queue},
    startDelay:1,delayUnit:"minutes",moduleCall:async()=>({ok:true,cancelled:true}),
    selection:{current:scope},setSheet:()=>{},loadMissions:async()=>{},setSelectedRunId:()=>{},
  });
  exports.submit();await operation;await queue.flush(scope);
  assert.equal(applied.length,1);queue.dispose();
});

function loadSurface(react = {}, globals = {}, imports = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const surface = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: surface, require: name => name === "react" ? react : name === "react/jsx-runtime"
      ? imports.jsx || require(require.resolve(name, { paths: [path.resolve(__dirname, "..")] })) : imports[name] || {}, ...globals });
  return surface;
}

function surfaceComposer(seed = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8").split("export function AgentOrchestratorSurface")[1];
  const names = [...source.matchAll(/const \[([A-Za-z_]+),[^\]]+\] = useState/g)].map(match => match[1]);
  const state = { workspaceReady: true, workspaceId: "w", chatTaskId: "", board: { revision: 1, tasks: [] }, ...seed };
  const refs = []; let cursor = 0, refCursor = 0;
  const react = {
    useState(initial) {
      const name = names[cursor++]; assert.ok(name, "each Surface state is named");
      if (!(name in state)) state[name] = typeof initial === "function" ? initial() : initial;
      return [state[name], value => { state[name] = typeof value === "function" ? value(state[name]) : value; }];
    },
    useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
    useCallback: callback => callback, useEffect() {}, useLayoutEffect() {},
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const featureCache = {};
  const feature = file => {
    if (featureCache[file]) return featureCache[file];
    const exports = featureCache[file] = {};
    const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { exports, structuredClone, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
        : name === "./AgentOrchestratorRoleEditor" ? feature("AgentOrchestratorRoleEditor.tsx") : {} });
    return exports;
  };
  const calls = [];
  const result = { runs: seed.missions || [], teams: seed.savedTeams || [], team: seed.team || null };
  const api = { apps: { call: async input => {
    calls.push(plain(input));
    if (input.operation === "chat_send") return { ok: true, result: { ok: true, taskId: "new-task", runId: "new-run", status: "running" } };
    if (input.operation === "runs") return { ok: true, result };
    if (input.operation === "board") return { ok: true, result: { revision: 1, tasks: [] } };
    if (input.operation === "permission_profiles") return { ok: true, result: { capability: { supported: true, profiles: [] } } };
    if (input.operation === "team_update") return { ok: true, result: { ok: true } };
    throw new Error("Unexpected operation " + input.operation);
  } } };
  const imports = {
    jsx: { jsx, jsxs: jsx }, "../api/client": { getCodingToolsClient: () => api },
    "./AgentOrchestratorRoleEditor": feature("AgentOrchestratorRoleEditor.tsx"),
    "./AgentOrchestratorPermissions": { ...feature("AgentOrchestratorPermissions.tsx"), AgentOrchestratorPermissions: "Permissions" },
    "./AgentOrchestratorChat": { AgentOrchestratorChat: "Chat", ChatListPane: "ChatList" },
    "./AgentOrchestratorCanvas": { AgentOrchestratorCanvas: "Canvas" },
    "./AgentOrchestratorOriginalSurface": { AgentOrchestratorOriginalSurface: "OriginalBoard" },
    "./ao-chat": chat,
  };
  const surface = loadSurface(react, { localStorage: { getItem: () => "w", setItem() {} }, structuredClone }, imports);
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const render = () => { cursor = 0; refCursor = 0; return surface.AgentOrchestratorSurface({ language: "en", setError() {} }); };
  const currentChat = () => walk(render()).find(item => item.type === "Chat");
  return { state, calls, render, walk, currentChat };
}

test("Surface defaults to red Single and sends only one explicit route without saving a reusable team", async () => {
  const fixture = surfaceComposer();
  const chat = fixture.currentChat();
  assert.equal(chat.props.composer.mode, "single");
  assert.equal(chat.props.composer.route.harness_id, "ao:claude-code");
  assert.equal(chat.props.composer.route.native_permission_profile, ":workspace");
  await chat.props.send({ message: "One selected model only" });
  const sent = fixture.calls.find(call => call.operation === "chat_send").arguments;
  assert.equal(sent.executionMode, "single"); assert.equal(sent.singleRoute.harness_id, "ao:claude-code");
  assert.equal("teamId" in sent, false); assert.equal("teamRevision" in sent, false);
  assert.equal(fixture.calls.some(call => call.operation === "team_update"), false);
});

test("a team saved from another project drives Team mode's permission menu and send here", async () => {
  const lead = { id: "lead", role: "planner", parents: [], x: 0, y: 0, state: "pending", settings: {},
    route: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" } };
  const team = { id: "shared", workspace_id: "other-project", revision: 3, name: "Shared team", nodes: [lead] };
  const fixture = surfaceComposer({ savedTeams: [team], composerMode: "team", composerTeamId: "shared" });
  const permissions = fixture.currentChat().props.permissions;
  assert.equal(permissions.props.team?.id, "shared", "the permission menu gets the selected team's roles");
  const capability = await permissions.props.loadProfiles("lead");
  assert.equal(capability.supported, true, "a role that hasn't run yet can still choose a mode");
  await fixture.currentChat().props.send({ message: "Use the shared team" });
  const sent = fixture.calls.find(call => call.operation === "chat_send").arguments;
  assert.equal(sent.teamId, "shared"); assert.equal(sent.teamRevision, 3);
});

test("Surface Team selection passes actual identity/revision and rejects missing setups before sending", async () => {
  const team = { id: "actual", workspace_id: "w", revision: 9, name: "Actual setup", nodes: [] };
  const fixture = surfaceComposer({ savedTeams: [team], composerTeamId: "actual" });
  fixture.currentChat().props.composer.onModeChange("team");
  const chat = fixture.currentChat();
  assert.equal(chat.props.composer.mode, "team");
  await chat.props.send({ message: "Use selected team" });
  const sent = fixture.calls.find(call => call.operation === "chat_send").arguments;
  assert.equal(sent.executionMode, "team"); assert.equal(sent.teamId, "actual"); assert.equal(sent.teamRevision, 9);
  assert.equal("singleRoute" in sent, false);
  const stale = surfaceComposer({ savedTeams: [team], composerMode: "team", composerTeamId: "deleted" });
  await assert.rejects(stale.currentChat().props.send({ message: "Do not substitute defaults" }), /saved team/i);
  assert.equal(stale.calls.some(call => call.operation === "chat_send"), false);
});

test("draft Single permission selection mutates only the future route and never creates or saves a team", async () => {
  const fixture = surfaceComposer();
  const permissions = fixture.currentChat().props.permissions;
  const snapshot = plain(permissions.props.team);
  const id = snapshot.nodes[0].id;
  snapshot.nodes[0].route.native_permission_profile = ":danger-full-access";
  snapshot.nodes[0].route.approval_policy = "never"; snapshot.nodes[0].route.approvals_reviewer = "user";
  await permissions.props.save(snapshot, undefined, [id], { profile: ":danger-full-access", policy: "never", reviewer: "user" });
  assert.equal(fixture.currentChat().props.composer.route.permission_profile, ":ao-default");
  assert.equal(fixture.currentChat().props.composer.route.native_permission_profile, ":danger-full-access");
  assert.equal(fixture.calls.length, 0, "no reusable team or native session mutation on a draft selection");
});

test("existing Single policy apply carries only exact run/role revision scope and leaves current receipt route unchanged", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gemini-flash", permission_profile: ":ao-default" };
  const node = { id: "real-single-node", task_id: "task", role: "planner", state: "running", parents: [], x: 0, y: 0, route, settings: {} };
  const mission = { id: "single-run", project_id: "task", workspace_id: "w", execution_mode: "single", revision: 7, cancelled: false, nodes: [node] };
  const fixture = surfaceComposer({ chatTaskId: "task", missions: [mission], selectedRunId: mission.id, composerMode: "single", singleRoute: route });
  const permissions = fixture.currentChat().props.permissions;
  const snapshot = plain(permissions.props.team);
  snapshot.nodes[0].route.native_permission_profile = ":workspace"; snapshot.nodes[0].route.approval_policy = "on-request"; snapshot.nodes[0].route.approvals_reviewer = "auto_review";
  await permissions.props.save(snapshot, 7, [node.id], { profile: ":workspace", policy: "on-request", reviewer: "auto_review" });
  const applied = fixture.calls.find(call => call.operation === "team_update").arguments.change;
  assert.equal(applied.operation, "apply_team"); assert.equal(applied.run_id, mission.id); assert.equal(applied.expected_revision, 7);
  assert.deepEqual(applied.selected_role_ids, [node.id]);
  assert.equal("team_id" in applied, false); assert.equal("team_revision" in applied, false);
  assert.equal(node.route.native_permission_profile, undefined, "active route/receipt is not mutated by the renderer");
});

test("draft permission capability lookup is a read-only route query and never connects Native", async () => {
  const fixture = surfaceComposer();
  let permissions = fixture.currentChat().props.permissions;
  await permissions.props.loadProfiles(permissions.props.team.nodes[0].id);
  assert.equal(fixture.calls[0].operation, "permission_profiles");
  assert.equal(fixture.calls[0].arguments.route.harness_id, "ao:claude-code");
  assert.equal("runId" in fixture.calls[0].arguments, false);
  fixture.currentChat().props.composer.onRouteChange({ harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":workspace" });
  permissions = fixture.currentChat().props.permissions;
  const native = await permissions.props.loadProfiles(permissions.props.team.nodes[0].id);
  assert.equal(native.supported, true, "a native draft can still choose a mode; the connection checks it at launch");
  assert.equal(fixture.calls.length, 1, "opening the native draft menu neither connects nor asks the runtime");
});

test("Team and Mission Board header callbacks open the existing graph/board separately without writes", () => {
  const fixture = surfaceComposer();
  const original = fixture.currentChat();
  original.props.onOpenMissionBoard(); assert.equal(fixture.state.view, "board");
  assert.equal(fixture.walk(fixture.render()).filter(item => item.type === "OriginalBoard").length, 1);
  original.props.onOpenTeam(); assert.equal(fixture.state.view, "overview");
  assert.equal(fixture.state.sheet, "");
  assert.equal(fixture.calls.length, 0, "navigation does not create a saved team or run");
});

test("composer execution binds only the explicit single route or a real saved-team revision", () => {
  const surface = loadSurface();
  const route = { harness_id: "ao:claude-code", model: "cpa/gemini-flash", permission_profile: ":ao-default" };
  const teams = [{ id: "saved", workspace_id: "w", revision: 8, nodes: [] }, { id: "elsewhere", workspace_id: "other", revision: 2, nodes: [] }];
  assert.deepEqual(plain(surface.aoChatExecution("single", route, teams, "saved")), { executionMode: "single", singleRoute: route });
  assert.deepEqual(plain(surface.aoChatExecution("team", route, teams, "saved")), { executionMode: "team", teamId: "saved", teamRevision: 8 });
  assert.deepEqual(plain(surface.aoChatExecution("team", route, teams, "elsewhere")), { executionMode: "team", teamId: "elsewhere", teamRevision: 2 },
    "a team saved from another project runs here too");
  assert.throws(() => surface.aoChatExecution("team", route, teams, "deleted"), /saved team/i);
});

test("saved team list accepts authoritative teams and legacy team without manufactured presets", () => {
  const surface = loadSurface();
  const team = { id: "real", workspace_id: "w", revision: 3, nodes: [] };
  const shared = { id: "shared", workspace_id: "other", revision: 1, nodes: [] };
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [team] })), [team]);
  assert.deepEqual(plain(surface.aoSavedTeams({ team })), [team]);
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [], team })), [], "explicit empty catalog is not replaced");
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [team, shared] })), [team, shared], "every project sees every saved team");
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [{ id: "broken", nodes: [] }] })), [], "malformed entries are still dropped");
});

test("the composer keeps the chosen team, else the project's default, else the first", () => {
  const surface = loadSurface();
  const teams = [{ id: "a", revision: 1, nodes: [] }, { id: "b", revision: 1, nodes: [] }];
  assert.equal(surface.aoComposerTeam("b", teams, teams[0]), "b");
  assert.equal(surface.aoComposerTeam("gone", teams, teams[1]), "b");
  assert.equal(surface.aoComposerTeam("", teams, null), "a");
  assert.equal(surface.aoComposerTeam("", [], null), "");
});

test("overview defaults to 70/30 and clamps both panes to usable sizes on short screens", () => {
  const surface = loadSurface();
  assert.equal(typeof surface.aoOverviewSplit, "function");
  assert.deepEqual(plain(surface.aoOverviewSplit(0.7, 808)), { ratio: 0.7, min: 0.2, max: 0.85, graph: 560 });
  assert.equal(surface.aoOverviewSplit(0.99, 808).graph, 680, "board keeps 120px minimum");
  assert.equal(surface.aoOverviewSplit(0.01, 808).graph, 160, "graph keeps 160px minimum");
  const short = surface.aoOverviewSplit(0.7, 208);
  assert.ok(Math.abs(short.graph - 200 * 160 / 280) < 1e-9, "short screens scale minimums rather than overflow");
  assert.equal(short.min, short.max);
  for (const invalid of [NaN, Infinity, -1, 0, 1]) assert.equal(surface.aoOverviewSplit(invalid, 808).ratio, 0.7);
});

test("overview divider remembers its ratio, supports keyboard/reset and releases native board protection on pointer cancel", () => {
  let states = [], refs = [], stateIndex = 0, refIndex = 0, layouts = [];
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
    useLayoutEffect(effect) { layouts.push(effect); }, useEffect() {},
  };
  const saved = new Map([["coding-tools:ao:overview-ratio:v1", "0.6"]]);
  const resizing = [], listeners = new Map(), captured = [];
  const surface = loadSurface(react, {
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    window: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  assert.equal(typeof surface.OverviewSplit, "function");
  const render = () => {
    stateIndex = 0; refIndex = 0; layouts = [];
    return surface.OverviewSplit({ hidden: false, onResize: value => resizing.push(value), children: ["graph", "board"] });
  };
  let tree = render();
  // React 19 keeps ref in props; older installed React exposes it on the element.
  (tree.props.ref || tree.ref).current = { getBoundingClientRect: () => ({ top: 10, height: 808 }) };
  layouts.forEach(effect => effect());
  tree = render();
  let divider = tree.props.children[1];
  assert.equal(divider.props.role, "separator");
  assert.equal(divider.props.tabIndex, 0);
  assert.equal(divider.props["aria-orientation"], "horizontal");
  assert.equal(divider.props["aria-valuenow"], 60, "valid saved ratio restored");
  divider.props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
  tree = render();
  assert.equal(tree.props.children[1].props["aria-valuenow"], 63);
  assert.equal(saved.get("coding-tools:ao:overview-ratio:v1"), "0.63");
  tree.props.children[1].props.onDoubleClick();
  tree = render();
  assert.equal(tree.props.children[1].props["aria-valuenow"], 70, "double-click resets 70/30");
  const handle = {
    setPointerCapture: id => captured.push(id), releasePointerCapture: id => captured.push(-id), hasPointerCapture: () => true,
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name),
  };
  tree.props.children[1].props.onPointerDown({ button: 0, pointerId: 4, currentTarget: handle, preventDefault() {} });
  assert.deepEqual(resizing, [true], "native board is suspended before drag");
  listeners.get("pointermove")({ pointerId: 4, clientY: 410 });
  tree = render();
  assert.equal(tree.props.children[1].props["aria-valuenow"], 50);
  listeners.get("pointermove")({ pointerId: 99, clientY: 10_000 });
  assert.equal(render().props.children[1].props["aria-valuenow"], 50, "other pointers do not move the divider");
  listeners.get("pointermove")({ pointerId: 4, clientY: 10_000 });
  assert.equal(render().props.children[1].props["aria-valuenow"], 85, "dragging below the panel clamps rather than resets");
  listeners.get("pointermove")({ pointerId: 4, clientY: -10_000 });
  assert.equal(render().props.children[1].props["aria-valuenow"], 20, "dragging above the panel clamps");
  listeners.get("pointercancel")();
  assert.deepEqual(resizing, [true, false], "native board resumes even on cancel");
  assert.deepEqual(captured, [4, -4]); assert.equal(listeners.size, 0, "drag listeners removed");
  tree.props.children[1].props.onKeyDown({ key: "End", preventDefault() {} });
  tree = render();
  assert.equal(tree.props.children[1].props["aria-valuenow"], 85);
  const noStorage = loadSurface(react, { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  states = []; refs = []; stateIndex = 0; refIndex = 0;
  const fallback = noStorage.OverviewSplit({ hidden: false, onResize() {}, children: ["graph", "board"] });
  assert.equal(fallback.props.children[1].props["aria-valuenow"], 70);
  assert.doesNotThrow(() => fallback.props.children[1].props.onDoubleClick());
  for (const corrupt of ["", "NaN", "Infinity", "-4", "2"]) {
    const invalidStorage = loadSurface(react, { localStorage: { getItem: () => corrupt } });
    states = []; refs = []; stateIndex = 0; refIndex = 0;
    assert.equal(invalidStorage.OverviewSplit({ hidden: false, onResize() {}, children: ["graph", "board"] }).props.children[1].props["aria-valuenow"], 70,
      `invalid saved ratio ${corrupt} falls back safely`);
  }
});

test("movable role popups stay inside their graph instead of covering the native mission board", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const surface = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: surface, require: () => ({}) });
  assert.equal(typeof surface.clampPopupPosition, "function");
  const area = { width: 900, height: 360 };
  const popup = { width: 340, height: 320 };
  assert.deepEqual(plain(surface.clampPopupPosition(area, popup, { x: 870, y: 350 })), { x: 552, y: 32 });
  assert.deepEqual(plain(surface.clampPopupPosition(area, popup, { x: -100, y: -30 })), { x: 8, y: 8 });
  assert.deepEqual(plain(surface.clampPopupPosition(area, popup, { x: 270, y: 20 })), { x: 270, y: 20 });
});


test("a selected historical mission still exposes its graph when every card is inactive", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const surface = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: surface, require: () => ({}) });
  assert.equal(typeof surface.aoVisibleNodes, "function");
  const stopped = [node("planner", "planner", "cancelled"), node("worker", "worker", "archived")];
  assert.deepEqual(plain(surface.aoVisibleNodes(stopped, false)).map(item => item.id), ["planner", "worker"],
    "filtering cannot erase the entire selected historical mission");
  const mixed = [...stopped, node("reviewer", "reviewer", "running")];
  assert.deepEqual(plain(surface.aoVisibleNodes(mixed, false)).map(item => item.id), ["reviewer"],
    "inactive-card filtering remains effective for a mission with active cards");
  assert.deepEqual(plain(surface.aoVisibleNodes(mixed, true)).map(item => item.id), ["planner", "worker", "reviewer"]);
  assert.deepEqual(plain(surface.aoVisibleNodes([], false)), []);
  assert.equal(stopped[0].state, "cancelled", "inspection never revives or edits a saved card");
});

test("a single-model chat passes its run to describe, so its one card shows no orchestrator role", () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/gemini-3.8-flash-high" };
  const node = { id: "single", role: "planner", state: "running", parents: [], route, settings: { name: "Single assistant" }, receipt: { status: "submitted" } };
  const seen = [];
  const describe = (card, run) => { seen.push(run?.execution_mode ?? "none"); return run?.execution_mode === "single" ? "Claude Code · gemini" : "Claude Code · gemini · Orchestrator"; };
  const single = chat.chatTurns([{ id: "r1", project_id: "t", cancelled: false, execution_mode: "single", nodes: [node] }], "hello", { describe, now: 1 });
  const team = chat.chatTurns([{ id: "r2", project_id: "t", cancelled: false, nodes: [node] }], "hello", { describe, now: 1 });
  assert.doesNotMatch(JSON.stringify(single), /Orchestrator/);
  assert.match(JSON.stringify(team), /Orchestrator/);
  assert.ok(seen.includes("single") && seen.includes("none"));
});

test("a steer saved under a message is its own message, and a fork keeps it", () => {
  const description = "first ask\n\n↳ Steer (2026-10-11 05:30 UTC): use pnpm\n\nFollow-up (2026-10-11 05:40 UTC):\nnow tests\n\n↳ Steer (2026-10-11 05:41 UTC): only unit tests";
  assert.deepEqual(plain(chat.chatMessagesFromDescription(description)), [
    { text: "first ask", steers: [{ stamp: "2026-10-11 05:30", text: "use pnpm" }] },
    { stamp: "2026-10-11 05:40", text: "now tests", steers: [{ stamp: "2026-10-11 05:41", text: "only unit tests" }] },
  ]);
  assert.equal(chat.chatDescriptionUpTo(description, 1), description, "a fork reproduces the steers it contains");
});

test("an install command's approval says what it does to the project's own packages", () => {
  const links = { shared: [".venv"], farmed: ["frontend/node_modules", "node_modules"] };
  assert.equal(chat.dependencyInstallNote("pip install requests", links).tone, "warn", "a shared Python environment changes for the project");
  assert.equal(chat.dependencyInstallNote("python -m pip install -r requirements.txt", links).tone, "warn");
  assert.equal(chat.dependencyInstallNote("uv sync", links).tone, "warn");
  assert.equal(chat.dependencyInstallNote("npm ci --prefix frontend", links).tone, "info", "a farmed node_modules installs privately");
  assert.match(chat.dependencyInstallNote("pnpm add zod", links).text, /privately/);
  assert.equal(chat.dependencyInstallNote("npm ci", { shared: ["node_modules"], farmed: [] }).tone, "warn", "a user's own node_modules link is shared");
  assert.equal(chat.dependencyInstallNote("pip install requests", { shared: [], farmed: ["node_modules"] }), null, "no shared venv, nothing to say");
  assert.equal(chat.dependencyInstallNote("npm run dev", links), null, "not an install");
  assert.equal(chat.dependencyInstallNote("Get-ChildItem frontend", links), null);
  assert.equal(chat.dependencyInstallNote("npm install", null), null, "unknown links: no note");
});

test("the chat's details panel counts its agents by state and names its approval mode", () => {
  const summary = chat.chatAgentSummary([{ state: "finished" }, { state: "finished" }, { state: "running" }, { state: "held" }, { state: "pending" }]);
  assert.deepEqual([...summary.dots], ["done", "done", "working", "waiting", "queued"]);
  assert.equal(summary.text, "1 working · 1 waiting · 2 done · 1 queued");
  assert.equal(chat.chatAgentSummary([]).text, "No agents yet");
  assert.equal(chat.chatApprovalMode({ approval_policy: "on-request", approvals_reviewer: "auto_review" }), "Approve for me");
  assert.equal(chat.chatApprovalMode({ approval_policy: "on-request", approvals_reviewer: "user" }), "Ask me");
  assert.equal(chat.chatApprovalMode({ approval_policy: "never" }), "Full access, no prompts");
  assert.equal(chat.chatApprovalMode(null), "Default");
});

test("a chat's AO agent sessions for its Preview and Terminal panes: newest first, each once, repeats told apart", () => {
  const card = (id, session, extra = {}) => node(id, "planner", "finished", { route: { harness_id: "ao:claude-code", model: "cpa/gpt-6-luna" }, receipt: { thread_id: session }, ...extra });
  const sessions = chat.chatAgentSessions([
    run("r1", "t", [card("a", "s1")]),
    run("r2", "t", [card("a", "s2")]),
    run("r3", "t", [card("a", "s2")]),
    run("r4", "t", [card("a", "s3"), node("n", "worker", "finished", { route: { harness_id: "native-codex", model: "m" }, receipt: { thread_id: "codex-thread" } })]),
  ]);
  assert.deepEqual(plain(sessions), [
    { id: "s3", label: "planner · cpa/gpt-6-luna · current", model: "cpa/gpt-6-luna" },
    { id: "s2", label: "planner · cpa/gpt-6-luna · earlier 1", model: "cpa/gpt-6-luna" },
    { id: "s1", label: "planner · cpa/gpt-6-luna · earlier 2", model: "cpa/gpt-6-luna" },
  ], "a native Codex thread is not an AO session");
  assert.deepEqual(plain(chat.chatAgentSessions([run("r1", "t", [card("a", "s1", { settings: { name: "Builder" } })])])),
    [{ id: "s1", label: "Builder · cpa/gpt-6-luna", model: "cpa/gpt-6-luna" }], "a single session keeps its plain name");
});

test("the context meter's numbers: short token counts, and fullness only when the agent gives its window", () => {
  assert.equal(chat.tokensShort(537523), "537.5k");
  assert.equal(chat.tokensShort(1_000_000), "1M");
  assert.equal(chat.tokensShort(1_250_000), "1.25M");
  assert.equal(chat.tokensShort(950), "950");
  assert.equal(chat.tokensShort(null), "—");
  assert.equal(chat.contextFraction({ contextUsed: 537_500, contextWindow: 1_000_000 }), 0.5375);
  assert.equal(chat.contextFraction({ contextUsed: 2_000, contextWindow: 0 }), null, "no window: tokens without a fullness claim");
  assert.equal(chat.contextFraction({ contextUsed: 1_200_000, contextWindow: 1_000_000 }), 1, "never more than full");
  assert.equal(chat.contextFraction(null), null);
});
// Native Codex cards (WebGPT and the CPA pool) report only the reply streamed so far. The chat used
// to drop it, so a working reply showed nothing but "working · Xm" until the turn ended.
test("a working card's streamed reply shows as its running message", () => {
  assert.deepEqual(plain(chat.liveTimeline("r1:w", { activity: "working", output: "  I'll run the three checks…  " })),
    [{ id: "r1:w:live", kind: "message", status: "running", text: "I'll run the three checks…" }]);
  const timeline = [{ id: "t1", kind: "command", status: "running", text: "dir" }];
  assert.deepEqual(plain(chat.liveTimeline("r1:w", { output: "partial", timeline })).map((item) => item.kind), ["command", "message"],
    "the text follows what the card already did");
  const own = [{ id: "m1", kind: "message", status: "running", text: "from the timeline" }];
  assert.deepEqual(plain(chat.liveTimeline("r1:w", { output: "partial", timeline: own })), own, "an AO timeline's own message is not repeated");
  assert.deepEqual(plain(chat.liveTimeline("r1:w", { output: "   " })), []);
  assert.deepEqual(plain(chat.liveTimeline("r1:w", undefined)), []);
});

test("a retried card shows its earlier reply until the new attempt writes, and a held card's reply is copied with its error", () => {
  const retried = node("p", "planner", "running", { receipt: { started_at_ms: 1 }, history: [{ answer: "First try's reply" }] });
  const [turn] = plain(chat.chatTurns([run("r1", "t", [retried], { execution_mode: "single" })], "go", { now: 2 }));
  assert.equal(turn.steps[0].text, "Earlier attempt:\n\nFirst try's reply");
  const [writing] = plain(chat.chatTurns([run("r1", "t", [retried], { execution_mode: "single" })], "go",
    { now: 2, activity: { "r1:p": { output: "New reply so far" } } }));
  assert.equal(writing.steps[0].text, undefined, "the new attempt's own output replaces it");
  const held = node("p", "planner", "held", { receipt: { error: "Native turn returned no verifiable final answer", answer: "The reply" } });
  const turns = plain(chat.chatTurns([run("r1", "t", [held], { execution_mode: "single" })], "go"));
  assert.equal(turns[0].steps[0].text, "The reply");
  assert.ok(chat.chatMarkdown("Chat", turns).includes("Error: Native turn returned no verifiable final answer\n\nThe reply"));
});


// Replay the real async callback bodies with delayed replies so navigation and cleanup can race them.
function rendererCallback(file, name, globals) {
  const text = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) body ??= node.initializer;
    if (name.startsWith("effect:") && ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
      && node.arguments[0]?.getText(tree).includes(name.slice(7))) body ??= node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(body, name);
  const exports = {};
  vm.runInNewContext(ts.transpileModule("exports.callback = " + body.getText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, ...globals });
  return exports.callback;
}
const delayedReply = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function workspaceRecovery({ hidden = false, selected = "p3" } = {}) {
  let isHidden = hidden, timerId = 0;
  const focus = new Set(), visibility = new Set(), timers = new Map(), replies = [];
  const state = { workspaces: [], workspaceId: selected, ready: false, sheet: "", errors: [] };
  const set = key => value => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:listAllWorkspaces", {
    Error, listAllWorkspaces: () => { const reply = delayedReply(); replies.push(reply); return reply.promise; },
    pageHidden: () => isHidden, setWorkspaces: set("workspaces"), setWorkspaceId: set("workspaceId"),
    setWorkspaceReady: set("ready"), setSheet: set("sheet"), setError: error => state.errors.push(error),
    window: { addEventListener: (name, handler) => { assert.equal(name, "focus"); focus.add(handler); },
      removeEventListener: (name, handler) => { assert.equal(name, "focus"); focus.delete(handler); } },
    document: { addEventListener: (name, handler) => { assert.equal(name, "visibilitychange"); visibility.add(handler); },
      removeEventListener: (name, handler) => { assert.equal(name, "visibilitychange"); visibility.delete(handler); } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { state, replies, timers, focus, visibility, cleanup: effect(), hide: value => { isHidden = value; },
    onFocus: () => { for (const handler of [...focus]) handler(); },
    onVisible: () => { for (const handler of [...visibility]) handler(); },
    tick: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } } };
}
const workspaceProjects = Array.from({ length: 4 }, (_, index) => ({ id: "p" + (index + 1), name: "Project " + (index + 1) }));

test("the project effect retries a visible startup failure after an in-flight focus and preserves selection", async () => {
  const w = workspaceRecovery();
  try {
    assert.equal(w.replies.length, 1);
    w.onFocus(); w.onVisible();
    assert.equal(w.replies.length, 1, "focus while the first read is pending never overlaps it");
    w.replies[0].reject(new Error("backend unavailable"));
    await new Promise(setImmediate);
    assert.equal(w.state.ready, false);
    assert.equal(w.timers.size, 1, "the failed initial visible attempt gets one bounded retry");
    const [timer] = w.timers.values();
    assert.ok(timer.delay > 0 && timer.delay <= 1000);
    w.tick();
    assert.equal(w.replies.length, 2);
    w.onFocus(); w.onVisible();
    assert.equal(w.replies.length, 2);
    w.state.workspaceId = "p4";
    w.replies[1].resolve(workspaceProjects);
    await new Promise(setImmediate);
    assert.equal(w.state.workspaces.length, 4);
    assert.equal(w.state.ready, true);
    assert.equal(w.state.workspaceId, "p4", "the current selected project survives a delayed refresh");
    assert.equal(w.timers.size, 0);
    assert.deepEqual(w.state.errors, ["backend unavailable"], "recovery does not clear unrelated global errors");
  } finally { w.cleanup(); }
});

test("workspace retries are bounded until another legitimate visible return", async () => {
  const w = workspaceRecovery();
  try {
    w.replies[0].reject(new Error("offline")); await new Promise(setImmediate);
    assert.equal(w.timers.size, 1); w.tick();
    assert.equal(w.replies.length, 2);
    w.replies[1].reject(new Error("still offline")); await new Promise(setImmediate);
    assert.equal(w.timers.size, 0, "an automatic retry failure never creates an error polling loop");
    w.tick(); assert.equal(w.replies.length, 2);
    w.onFocus(); assert.equal(w.replies.length, 3, "a real return can recover without remounting the tab");
    w.replies[2].reject(new Error("reconnecting")); await new Promise(setImmediate);
    assert.equal(w.timers.size, 1);
    w.tick(); w.replies[3].resolve(workspaceProjects); await new Promise(setImmediate);
    assert.equal(w.state.ready, true);
  } finally { w.cleanup(); }
});

test("workspace loading skips hidden startup, events, and retries without overlapping visible reads", async (t) => {
  for (const phase of ["startup", "retry"]) await t.test(phase, async () => {
    const w = workspaceRecovery({ hidden: phase === "startup" });
    try {
      if (phase === "retry") {
        w.replies[0].reject(new Error("offline")); await new Promise(setImmediate);
        assert.equal(w.timers.size, 1); w.hide(true); w.tick();
      }
      const count = phase === "startup" ? 0 : 1;
      w.onFocus(); w.onVisible();
      assert.equal(w.replies.length, count, "no native request starts while the page is hidden");
      w.hide(false); w.onVisible(); w.onFocus(); w.onVisible();
      assert.equal(w.replies.length, count + 1, "visible events share one in-flight read");
      w.replies.at(-1).resolve(workspaceProjects); await new Promise(setImmediate);
      assert.equal(w.state.ready, true);
    } finally { w.cleanup(); }
  });
});

test("workspace effect cleanup removes recovery listeners, cancels retry, and ignores late replies", async (t) => {
  for (const result of ["resolve", "reject", "retry"]) await t.test(result, async () => {
    const w = workspaceRecovery();
    let staleTimer;
    if (result === "retry") {
      w.replies[0].reject(new Error("offline")); await new Promise(setImmediate);
      assert.equal(w.timers.size, 1); staleTimer = [...w.timers.values()][0].callback;
    }
    w.cleanup();
    assert.equal(w.focus.size, 0); assert.equal(w.visibility.size, 0); assert.equal(w.timers.size, 0);
    if (result === "resolve") w.replies[0].resolve(workspaceProjects);
    if (result === "reject") w.replies[0].reject(new Error("late failure"));
    staleTimer?.(); w.onFocus(); w.onVisible(); await new Promise(setImmediate);
    assert.equal(w.replies.length, 1);
    assert.equal(w.state.workspaces.length, 0); assert.equal(w.state.ready, false);
    assert.equal(w.state.errors.length, result === "retry" ? 1 : 0);
  });
});


test("late chat creation never overwrites another project, another chat, or an unmounted surface", async () => {
  for (const stage of ["start", "refresh", "unmount"]) {
    const started = delayedReply(), refreshed = delayedReply();
    const selection = { current: { workspaceId: "a", taskId: "", runId: "" } }, mounted = { current: true };
    const state = { missions: [], board: { tasks: [] }, chatTaskId: "", selectedRunId: "", notices: {}, autoStatus: "idle" };
    const set = key => value => { state[key] = typeof value === "function" ? value(state[key]) : value; };
    const send = rendererCallback("AgentOrchestratorSurface.tsx", "sendChat", {
      busy: "", workspaceId: "a", selection, mounted, boardWorkspace: { current: "a" }, board: { tasks: [] },
      composerMode: "single", singleRoute: { model: "fixture" }, savedTeams: [], composerTeamId: "",
      run: async (_name, action) => action(), aoChatExecution: () => ({}), executableArg: () => ({}),
      moduleCall: async () => started.promise, rememberChatRoute() {}, startNotice: () => "",
      loadBoard: async () => stage === "refresh" ? refreshed.promise : undefined, loadMissions: async () => {},
      setMissions: set("missions"), setBoard: set("board"), setPendingChat: set("pendingChat"),
      setChatTaskId: set("chatTaskId"), setSelectedRunId: set("selectedRunId"),
      setChatNotices: set("notices"), setAutoStatus: set("autoStatus"), setError() {},
    });
    const sending = send({ message: "Project A request" });
    const result = { taskId: "task-a", runId: "run-a", run: { id: "run-a", workspace_id: "a", project_id: "task-a" } };
    if (stage === "refresh") { started.resolve(result); await new Promise(setImmediate); }
    selection.current = { workspaceId: "b", taskId: "task-b", runId: "run-b" };
    if (stage === "unmount") mounted.current = false;
    state.missions = [{ id: "run-b", workspace_id: "b" }]; state.board = { tasks: [{ id: "task-b" }] };
    state.chatTaskId = "task-b"; state.selectedRunId = "run-b";
    if (stage !== "refresh") started.resolve(result); else refreshed.resolve();
    await sending;
    assert.equal(state.chatTaskId, "task-b", stage); assert.equal(state.selectedRunId, "run-b", stage);
    assert.deepEqual(state.board.tasks, [{ id: "task-b" }], stage);
    assert.deepEqual(state.missions, [{ id: "run-b", workspace_id: "b" }], stage);
  }
});

test("send completion preserves the next chat's draft and edits typed during the pending send", async () => {
  for (const taskId of ["task-b", "task-a"]) {
    const reply = delayedReply(), attachments = [], composing = { current: { taskId: "task-a", draft: "sent text", attachments } };
    const state = { draft: "sent text" }, set = key => value => { state[key] = value; };
    const deliver = rendererCallback("AgentOrchestratorChat.tsx", "deliver", {
      selectedTaskId: "task-a", draft: "sent text", attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(),
      setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: () => reply.promise,
      setDraft: set("draft"), setTitle() {}, setAttachments() {}, setAttachNote() {}, setAtBottom() {}, setCarried() {},
    });
    const sending = deliver("sent text");
    state.draft = "new unsent text"; composing.current = { taskId, draft: state.draft, attachments };
    reply.resolve(); assert.equal(await sending, true);
    assert.equal(state.draft, "new unsent text", taskId);
  }
});

test("approval callbacks refuse a request displayed by a previous run and still send the current request", async () => {
  const calls = [], approval = { nodeId: "planner", approval_id: "req" };
  const selection = { current: { workspaceId: "b", taskId: "task-b", runId: "run-b" } };
  const approvalScope = { current: { workspaceId: "a", runId: "run-a" } };
  const approve = rendererCallback("AgentOrchestratorSurface.tsx", "approve", {
    workspaceId: "b", selectedRun: { id: "run-b" }, selection, approvalScope, mounted: { current: true },
    shownApprovals: [approval], pendingApprovals: [approval],
    run: async (_name, action) => action(), moduleCall: async (_operation, args) => { calls.push(args); return { cancelled: true }; }, setPendingApprovals() {},
  });
  approve(approval, true); await new Promise(setImmediate); assert.equal(calls.length, 0, "old run is not dispatched");
  approvalScope.current = { workspaceId: "b", runId: "run-b" };
  approve(approval, true); await new Promise(setImmediate); assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, "run-b"); assert.equal(calls[0].approvalId, "req");
});

test("a temporary status failure does not permanently suppress orphan-run recovery", async () => {
  const calls = [], settledRuns = { current: new Set() };
  const settle = rendererCallback("AgentOrchestratorSurface.tsx", "effect:settledRuns.current.add(key)", {
    workspaceId: "a", mounted: { current: true }, missions: [{ id: "r", workspace_id: "a", nodes: [{ id: "n", state: "running" }] }],
    settledRuns, selection: { current: { workspaceId: "a" } },
    moduleCall: async operation => { calls.push(operation); if (calls.length === 1) throw new Error("temporary failure"); return { driven: true }; },
    loadMissions: async () => {}, setTimeout,
  });
  settle(); await new Promise(setImmediate); settle(); await new Promise(setImmediate);
  assert.deepEqual(calls, ["run_status", "run_status"]);
});

test("an old terminal read cannot advance a newly selected command's output cursor", async () => {
  const old = delayedReply(), offsets = { current: { stdout: 0, stderr: 0 } };
  const read = rendererCallback("ChatWorkbench.tsx", "effect:offsets.current = { stdout: 0", {
    selected: "old", sessionId: "session", workspaceId: "a", selectedAgentShell: false, offsets,
    pinned: { current: false }, setOutput() {}, TAIL_BYTES: 1000, MAX_OUTPUT_CHARS: 10000, OUTPUT_POLL_MS: 1000,
    window: { setInterval: () => 1, clearInterval() {} }, plain: value => value,
    paneCall: async (_operation, args) => args.stream === "stdout" && args.offset === Number.MAX_SAFE_INTEGER
      ? old.promise : { nextOffset: 10000, content: "" },
  });
  const cleanup = read(); cleanup(); offsets.current = { stdout: 0, stderr: 0 };
  old.resolve({ nextOffset: 10000 }); await new Promise(setImmediate);
  assert.deepEqual(offsets.current, { stdout: 0, stderr: 0 });
});

test("late start, restart, retry and pause replies cannot change another selected run", async () => {
  for (const name of ["startRun", "restartRun", "controlRun", "restartChatRun", "retryChatStart"]) {
    for (const keepSelection of [false, true]) {
      const reply = delayedReply(), done = delayedReply(), calls = [], state = { selected: "run-a", status: "idle" };
      let matching = true;
      const callback = rendererCallback("AgentOrchestratorSurface.tsx", name, {
        selectedRun: { id: "run-a" }, workspaceId: "a", currentRun: () => matching,
        run: async (_name, action) => { await action(); done.resolve(); },
        moduleCall: async (operation, args) => { calls.push([operation, args]); return reply.promise; }, executableArg: () => ({}), loadMissions: async () => {},
        composerMode: "single", singleRoute: { model: "default" }, missions: [], routeIdentity: value => value,
        setSelectedRunId: value => { state.selected = value; }, setAutoStatus: value => { state.status = value; },
        setAdvanceNotice() {}, setError() {}, setChatNotices() {}, startNotice: () => "",
      });
      callback(name === "controlRun" ? "pause" : "run-a");
      matching = keepSelection; if (!matching) state.selected = "run-b";
      reply.resolve({ runId: "replacement-a", status: "running" }); await done.promise;
      assert.equal(calls.length, 1); assert.equal(calls[0][1].runId, "run-a", "the authorized original request still runs");
      assert.deepEqual(state, keepSelection
        ? { selected: name === "restartRun" || name === "restartChatRun" ? "replacement-a" : "run-a", status: name === "controlRun" ? "paused" : "running" }
        : { selected: "run-b", status: "idle" }, name);
    }
  }
});

test("a queued message survives an unmount while its delivery fails", async () => {
  const reply = delayedReply(), next = { what: "Message", message: "queued text" }, queues = new Map([["task-a", [next]]]);
  const alive = { current: true }, attachments = [];
  const flush = rendererCallback("AgentOrchestratorChat.tsx", "effect:void deliver(next.message", {
    selectedTaskId: "task-a", queueOf: task => queues.get(task) || [], setQueue: (task, value) => queues.set(task, value),
    accepts: true, busy: false, sending: false, sentWhileFree: { current: false }, windowFocused: true, alive,
    composing: { current: { taskId: "task-a", draft: "", attachments } }, deliver: () => reply.promise,
    setCard() {}, setDraft() { throw new Error("unmounted composer"); }, say() {},
  });
  flush(); alive.current = false; reply.resolve(false); await new Promise(setImmediate);
  assert.deepEqual(plain(queues.get("task-a")), [next]);
});

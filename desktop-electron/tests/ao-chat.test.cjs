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


test("Chat new Single prompt is Ask anything while Team, follow-up and running prompts stay unchanged", () => {
  const component = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = { useMemo: calculate => calculate(), useEffect() {}, useRef: initial => ({ current: initial }),
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}] };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: component, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "./ao-chat" ? chat : {},
  });
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const base = { runs: [], tasks: [], selectedTaskId: "", busy: false, loadDescription: async () => "", send: async () => {}, openStructure() {}, approvals: [], approve() {}, describeRoute: () => "", retryStart() {} };
  const placeholder = extra => walk(component.AgentOrchestratorChat({ ...base, ...extra })).find(item => item.type === "textarea").props.placeholder;
  assert.equal(placeholder({ composer: { mode: "single" } }), "Ask anything…");
  assert.equal(placeholder({ composer: { mode: "team" } }), "What should the team do?");
  assert.equal(placeholder({ composer: { mode: "single" }, selectedTaskId: "task" }), "Send a follow-up…");
  assert.equal(placeholder({ composer: { mode: "single" }, selectedTaskId: "task", working: true,
    runs: [run("active", "task", [node("worker", "worker", "running")])] }), "Running — you can send a follow-up when it finishes");
});

test("each task has always-visible Mission and Overview icons that select that task, without project text tabs", () => {
  const componentSource = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const component = {};
  vm.runInNewContext(ts.transpileModule(componentSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: component,
    require: name => name === "./ao-chat" ? chat : name === "../icons" ? { Icon: () => null } : name === "./AgentOrchestratorApproval" ? { AgentOrchestratorApproval: () => null } : name === "./AgentOrchestratorComposerControls" ? { AgentOrchestratorComposerControls: () => null }
      : require(require.resolve(name, { paths: [path.resolve(__dirname, "..")] })),
  });
  const selected = [];
  const pane = component.ChatListPane({
    chats: [{ taskId: "task-a", title: "Fix app", status: "running" }, { taskId: "task-b", title: "Older task", status: "done" }],
    selectedTaskId: "task-a", onSelect: (id, view) => selected.push([id, view]), onNew: () => selected.push(["new"]),
    tree: { workspaces: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], workspaceId: "a",
      onWorkspace: id => selected.push(["workspace", id]), view: "overview",
      labels: { chat: "Mission tab", overview: "Overview board" } },
  });
  const walk = element => !element || typeof element !== "object" ? [] : Array.isArray(element)
    ? element.flatMap(walk) : [element, ...walk(element.props?.children)];
  const elements = walk(pane);
  assert.equal(elements.filter(element => element.type === "nav").length, 0, "project-level text tabs are removed");
  const rows = elements.filter(element => element.type === "li" && element.props.className === "ao-chat-row");
  assert.equal(rows.length, 2, "each task, including an unselected historical task, gets its own controls");
  const buttons = walk(rows[1]).filter(element => element.type === "button");
  assert.equal(buttons.length, 3, "title plus two compact icon buttons");
  assert.equal(buttons[0].props.title, "Older task", "truncated task titles remain readable");
  assert.deepEqual(buttons.slice(1).map(button => button.props["aria-label"]), ["Mission tab · Older task", "Overview board · Older task"]);
  assert.deepEqual(buttons.slice(1).map(button => button.props.title), ["Mission tab · Older task", "Overview board · Older task"]);
  assert.deepEqual(buttons.slice(1).map(button => button.props.children.props.name), ["mail", "orchestrator"], "reuse existing icons");
  assert.ok(buttons.slice(1).every(button => !button.props.hidden && button.props.type === "button"));
  assert.ok(buttons.every(button => walk(button.props.children).every(child => child.type !== "button")), "no nested buttons");
  buttons[2].props.onClick(); buttons[1].props.onClick(); buttons[0].props.onClick();
  assert.deepEqual(selected, [["task-b", "overview"], ["task-b", "chat"], ["task-b", "chat"]], "icons select their task, title defaults to Mission");
  const currentButtons = walk(rows[0]).filter(element => element.type === "button");
  assert.equal(currentButtons[2].props["aria-pressed"], true);
  assert.equal(currentButtons[1].props["aria-pressed"], false);
  elements.find(element => element.props?.className === "ao-chat-new").props.onClick();
  elements.find(element => element.props?.className === "ao-chat-workspace" && element.props.title === "Beta").props.onClick();
  assert.deepEqual(selected.slice(-2), [["new"], ["workspace", "b"]], "new chat and project grouping remain");
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
  assert.equal(native.supported, false);
  assert.equal(fixture.calls.length, 1, "opening the native draft menu neither connects nor requests fabricated metadata");
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

test("composer execution binds only the explicit single route or a real scoped saved-team revision", () => {
  const surface = loadSurface();
  const route = { harness_id: "ao:claude-code", model: "cpa/gemini-flash", permission_profile: ":ao-default" };
  const teams = [{ id: "saved", workspace_id: "w", revision: 8, nodes: [] }];
  assert.deepEqual(plain(surface.aoChatExecution("single", route, teams, "saved", "w")), { executionMode: "single", singleRoute: route });
  assert.deepEqual(plain(surface.aoChatExecution("team", route, teams, "saved", "w")), { executionMode: "team", teamId: "saved", teamRevision: 8 });
  assert.throws(() => surface.aoChatExecution("team", route, teams, "deleted", "w"), /saved team/i);
  assert.throws(() => surface.aoChatExecution("team", route, teams, "saved", "wrong-workspace"), /saved team/i);
});

test("saved team list accepts authoritative teams and legacy team without manufactured presets", () => {
  const surface = loadSurface();
  const team = { id: "real", workspace_id: "w", revision: 3, nodes: [] };
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [team] }, "w")), [team]);
  assert.deepEqual(plain(surface.aoSavedTeams({ team }, "w")), [team]);
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [], team }, "w")), [], "explicit empty catalog is not replaced");
  assert.deepEqual(plain(surface.aoSavedTeams({ teams: [team] }, "wrong")), []);
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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { randomUUID } = require("node:crypto");

function load(file, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, structuredClone, crypto: { randomUUID },
    require: name => name === "react" || name === "react/jsx-runtime" ? require(name) : imports[name] ?? {}, ...globals });
  return exports;
}
const chat = load("ao-chat.ts");
// The model picker draws logos; markup tests stand them in.
const roles = load("AgentOrchestratorRoleEditor.tsx", { "./ao-chat": chat, "./model-scores": load("model-scores.ts"),
  "./HarnessLogo": { GroupLogo: () => null, HarnessLogo: () => null, ModelLogo: () => null } });
const markdown = load("ChatMarkdown.tsx", { "./chat-markdown": load("chat-markdown.ts") });

test("visualize references are inert Markdown unless a completed answer supplies its Preview action", () => {
  const reference = 'visualize{"path":"G:/task/counter_panel.html","title":"Counter"}';
  const render = (text, onVisualize) => renderToStaticMarkup(React.createElement(markdown.ChatMarkdown, { text, onVisualize }));
  assert.match(render(reference), /visualize/);
  const final = render(reference, () => {});
  assert.match(final, /button[^>]*>Counter/);
  assert.doesNotMatch(final, /G:\/task|visualize/);
  for (const inert of ['```text\n' + reference + '\n```', '> ' + reference, reference.slice(0, -1)]) {
    assert.doesNotMatch(render(inert, () => {}), /class="cx-chip"/);
  }
});
const menu = load("ChatMenu.tsx");
const client = { getCodingToolsClient: () => ({ apps: { call: async () => ({ result: { sessions: {} } }) } }) };
const visibility = load("page-visibility.ts");
const meter = load("ChatContextMeter.tsx", { "./ao-chat": chat, "./ChatMenu": menu, "./AgentOrchestratorRoleEditor": roles,
  "../api/client": client, "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }), "./page-visibility": visibility });
const toolParts = load("ChatToolParts.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown });
const dsh = load("DshTranscript.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown, "./ChatToolParts": toolParts });
const clawd = load("Clawd.tsx");
const petHome = load("chat-pet-home.ts");
const house = load("chat-pet-house.tsx", { "./Clawd": clawd });
const pet = load("ChatPet.tsx", { "./ao-chat": chat, "./Clawd": clawd, "./chat-pet-stage": load("chat-pet-stage.ts"), "./chat-pet-home": petHome,
  "./chat-pet-motion": load("chat-pet-motion.ts"), "./chat-pet-house": house, "./ChatMenu": menu, "./page-visibility": visibility });
const judges = load("ModelJudgesToggle.tsx", { "../api/client": client });
// Settings › Chat's mission switch, as this computer keeps it: on unless `saved` is "off".
const viewSettings = (saved = null) => load("chat-view-settings.ts", {}, { localStorage: { getItem: () => saved, setItem() {} } });
const uiImports = { "./ao-chat": chat, "./chat-transcript": load("chat-transcript.ts", { "./ao-chat": chat }), "./chat-view-settings": viewSettings(), "./ModelJudgesToggle": judges, "../icons": { Icon: () => null, Caret: () => null }, "./ChatMarkdown": markdown, "./ChatMenu": menu,
  "./ChatContextMeter": meter, "./DshTranscript": dsh, "./ChatToolParts": toolParts,
  "./image-markup": load("image-markup.ts"),
  "./ChatPet": pet, "../PartErrorBoundary": load("../PartErrorBoundary.tsx"), "./ChatScrollToBottom": load("ChatScrollToBottom.tsx"),
  "./ChatTurnStats": load("ChatTurnStats.tsx", { "./ao-chat": chat, "../api/client": client, "./page-visibility": visibility }),
  "./codex-prompts": load("codex-prompts.ts"),
  // The branch bar reads git asynchronously and renders nothing until then, as here; composer
  // controls and approval cards render only when a composer or an approval is passed.
  "./ChatBranchBar": { ChatBranchBar: () => null },
  "./HarnessLogo": { ModelLogo: () => null },
  "./AgentOrchestratorRoleEditor": roles,
  "./ChatReplyHead": load("ChatReplyHead.tsx", { "./ao-chat": chat, "./HarnessLogo": { ModelLogo: () => null }, "./ChatChangedFiles": load("ChatChangedFiles.tsx"), "./ChatTurnStats": { useTurnRequests: () => ({ ref: { current: null }, summary: "" }) } }),
  "./ChatReplyPlan": load("ChatReplyPlan.tsx"),
  "./chat-reply-plan": load("chat-reply-plan.ts", { "./ao-chat": chat }),
  // Annotations are the real module: with no transcript mounted (server render) the selection bar draws nothing.
  "./ChatAnnotations": load("ChatAnnotations.tsx", { "./ao-chat": chat, "./page-visibility": visibility, "./ChatMenu": menu, "./annotation-layout": load("annotation-layout.ts") }),
  "./AgentOrchestratorComposerControls": { AgentOrchestratorComposerControls: () => null },
  "./AgentOrchestratorApproval": { AgentOrchestratorApproval: () => null },
  // The side panel opens on demand; the chat only needs its auto-open hook to exist here.
  "./ChatWorkbench": { ChatWorkbench: () => null, useWorkbenchAutoOpen: () => {}, useChatSubagents: () => [], useChatSummaryFacts: () => ({ changes: null, pullRequest: null }), useChatProcesses: () => [], chatProcessRows: () => [] },
  "./ComputerControlCard": { ComputerControlCard: () => null, useComputerRequests: () => [], chatComputerRequests: () => [] },
  "./ChatThreadList": load("ChatThreadList.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMenu": menu, "./chat-list-settings": load("chat-list-settings.ts") }) };
const ui = load("AgentOrchestratorChat.tsx", uiImports);

test("visualize controls appear only in successful native WebGPT final answers", () => {
  const answer = 'visualize{"path":"G:/task/counter.html","title":"Counter"}';
  const props = { tasks: [{ id: "task", title: "Task", description: "User" }], selectedTaskId: "task", projectId: "ws", busy: false, approvals: [],
    loadDescription: async () => "User", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  for (const variant of ["native", "cpa", "running", "failed"]) {
    const node = { id: "lead", role: "planner", parents: [], x: 0, settings: {}, state: variant === "running" ? "running" : variant === "failed" ? "held" : "finished",
      route: { harness_id: "codex-native", model: variant === "cpa" ? "gemini-flash" : "chatgpt-web/high" },
      receipt: { answer, thread_id: "thread", started_at_ms: 1, finished_at_ms: 2, ...(variant === "failed" ? { error: "Failed" } : {}) } };
    const runs = [{ id: "run", workspace_id: "ws", project_id: "task", execution_mode: "single", nodes: [node] }];
    const rendered = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, runs }));
    assert.equal(/class="cx-chip"[^>]*>Counter/.test(rendered), variant === "native", variant);
  }
});

test("a card's assigned-turn activity reaches the ordinary and DeepSeek renderer before completion", async () => {
  const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
  for (const model of ["cpa/gpt-6.1-sol", "cpa/deepseek-v4.1-flash"]) {
    const run = { id: `scoped:${model}`, workspace_id: "ws", project_id: "task", execution_mode: "single", nodes: [
      { id: "lead", role: "planner", state: "running", route: { harness_id: "ao:claude-code", model },
        receipt: { thread_id: "session", turn_id: "assigned", started_at_ms: 1000 } },
    ] };
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: async () => ({ ok: true, runs: [run] }),
      aoHarness: { observe: async (_session, turn) => turn === "assigned"
        ? { turnId: turn, turnState: "running", timeline: [
          { id: "message", kind: "message", status: "running", text: "This live response belongs to the assigned turn." },
        ] }
        : { turnId: "queued", turnState: "queued", timeline: [] } },
    });
    try {
      const args = { workspaceId: "ws", runId: run.id };
      await workflow.call("activity", args);
      await new Promise(resolve => setImmediate(resolve));
      const frame = await workflow.call("activity", args);
      const props = { runs: [run], tasks: [{ id: "task", title: "Task", description: "Read the assigned response" }],
        selectedTaskId: "task", projectId: "ws", busy: false, approvals: [],
        activity: Object.fromEntries(Object.entries(frame.nodes).map(([id, value]) => [`${run.id}:${id}`, value])),
        send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
      const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
      assert.match(html, /This live response belongs to the assigned turn\./, model);
      const finished = { ...run, nodes: run.nodes.map(node => ({ ...node, state: "finished",
        receipt: { ...node.receipt, answer: "The completed response remains readable.", finished_at_ms: 2000 } })) };
      const reloaded = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, runs: [finished], activity: {} }));
      assert.match(reloaded, /The completed response remains readable\./, `${model} after reload`);
    } finally { workflow.dispose(); }
  }
});

test("a project switch keeps its chat pane readable while loading and offers Retry after a failed read", () => {
  const props = { runs: [], tasks: [], selectedTaskId: "", deciding: true, busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
    onRetryProject() {} };
  const loading = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
  assert.match(loading, /Opening project/);
  assert.match(loading, /Loading project chats/);
  assert.doesNotMatch(loading, /Retry loading/);
  const failed = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, projectLoadError: "Request failed" }));
  assert.match(failed, /Couldn&#x27;t load project/);
  assert.match(failed, /Couldn&#x27;t load chats: Request failed/);
  assert.match(failed, /Retry loading/);
});

test("a turn waiting for you has a button beside its time: Answer with a request shown, Continue once none has been for two minutes", () => {
  // Seen live 2026-11-02: "Deep diving for 1h 11m · waiting for you for 57m" in a split pane, with
  // no request anywhere to answer (its agent's link to AO had gone).
  const now = Date.now();
  const turnAt = (quietMs) => ({ key: "k", runId: "run", status: "running", solo: false, startedAtMs: now - 3_600_000,
    steps: [{ key: "s", nodeId: "n", role: "planner", name: "DeepSeek V4.1 Flash", detail: "", state: "running", startedAtMs: now - 3_600_000,
      working: { detail: "", stalled: false, activity: "waiting for approval", heardAtMs: now - quietMs, timeline: [] } }] });
  const render = (value, quietMs) => renderToStaticMarkup(React.createElement(toolParts.TurnRestart.Provider, { value },
    React.createElement(dsh.DshTurnWork, { turn: turnAt(quietMs), live: true, expanded: false, useWork: () => null })));
  const button = (html) => html.match(/<button[^>]*class="cx-turn-restart cx-turn-answer"[^>]*>([^<]*)<\/button>/)?.[1] ?? null;
  const both = { restarting: false, onAnswer() {}, onContinue() {} };
  const waiting = render(both, 30 * 60_000);
  assert.match(waiting, /waiting for you for 30m 0s/);
  assert.equal(button(waiting), "Answer", "a request shown in the chat is one click away");
  assert.equal(button(render({ restarting: false, onContinue() {} }, 30 * 60_000)), "Continue", "with none shown, the agent can be restarted to ask again");
  assert.equal(button(render({ restarting: false, onContinue() {} }, 90_000)), null, "not while the request poll may still bring it");
  assert.equal(button(render({ restarting: false }, 30 * 60_000)), null, "a chat that cannot send offers nothing");
  assert.equal(button(renderToStaticMarkup(React.createElement(toolParts.TurnRestart.Provider, { value: both },
    React.createElement(dsh.DshTurnWork, { turn: { ...turnAt(30 * 60_000), steps: [{ ...turnAt(0).steps[0], working: { detail: "", stalled: false, activity: "running npm test", heardAtMs: now, timeline: [] } }] },
      live: true, expanded: false, useWork: () => null })))), null, "a turn at work has no Answer");
});

test("a DeepSeek turn renders as DeepSeek Desktop's Standard view: a live group heading and Deep diving while it runs, Completed once it ends", () => {
  const timeline = [
    { id: "r1", kind: "reasoning", status: "completed", text: "**Let me check health.**\nThen the configs." },
    { id: "c1", kind: "command", status: "completed", text: "curl /healthz", description: "Check backend health", output: "ok" },
    { id: "e1", kind: "edit", status: "completed", text: "", files: [{ path: "src/_recovery_state.py", additions: 28, deletions: 0, diff: "+a" }] },
    { id: "t1", kind: "tool", status: "running", text: "mcp__coding-tools__read_file", input: JSON.stringify({ path: "README.md" }) },
  ];
  const step = { key: "s", nodeId: "n", role: "planner", name: "DeepSeek V4.1 Flash", detail: "", state: "running", startedAtMs: Date.now() - 64_000,
    working: { detail: "", stalled: false, timeline } };
  const turn = { key: "k", runId: "run", steps: [step], status: "running", solo: false, startedAtMs: Date.now() - 64_000 };
  const useWork = (item) => item.working?.timeline ?? null;
  const running = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn, live: true, expanded: false, useWork }));
  assert.match(running, /data-process-activity="read"[^>]*>.*dsh-group-label dsh-shimmer">Reading files · README\.md</, "the running group reads what its newest call does, and shimmers");
  assert.doesNotMatch(running, /dsh-title">Think</, "its rows stay folded under the heading (group bodies start collapsed)");
  assert.match(running, /Deep diving for 1m [45]s ···/, "the running status, with its clock");
  assert.doesNotMatch(running, /dsh-turn-process/, "no Completed header while it runs");
  // A steer on its way sits above "Deep diving", which stays the turn's last row (it showed under it).
  const steer = React.createElement("div", { className: "cx-user cx-steer" }, "its a resource monster");
  const steering = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn, live: true, expanded: false, useWork, beforeStatus: steer }));
  assert.match(steering, /its a resource monster<\/div><div class="dsh-running"/, "the steer, then the running line");
  const starting = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: { ...turn, steps: [] }, live: true, expanded: false, useWork, beforeStatus: steer }));
  assert.match(starting, /its a resource monster<\/div><div class="dsh-running"/, "before its first step too");
  const ended = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: { ...turn, status: "done" }, live: false, expanded: false, useWork, beforeStatus: steer }));
  assert.doesNotMatch(ended, /resource monster/, "an ended turn leaves its steers to the chat, under its work");
  // A reply closes the group before it: that one reads what it did, the one after it what it is doing.
  const replied = [timeline[0], timeline[1], { id: "m1", kind: "message", status: "completed", text: "Health is fine." }, timeline[3]];
  const split = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: { ...turn, steps: [{ ...step, working: { ...step.working, timeline: replied } }] }, live: true, expanded: false, useWork }));
  assert.match(split, /data-process-activity="commands"[^>]*>.*dsh-group-label">Ran commands<\/span>.*Health is fine\..*dsh-group-label dsh-shimmer">Reading files · README\.md</);
  // The same turn, seen ending: it took 1m 4s. A turn ended before the chat saw it says only "Completed".
  const settled = (key) => ({ ...turn, key, status: "done", steps: [{ ...step, state: "finished", working: undefined, hasWork: true }] });
  const doneWork = () => timeline.map((item) => ({ ...item, status: "completed" }));
  const done = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: settled("k"), live: false, expanded: true, useWork: doneWork }));
  assert.match(done, /dsh-turn-process-label">Completed in <span class="dsh-num">1m [45]s<\/span>/, "a turn seen ending is headed with its time");
  assert.match(done, /dsh-group-label">Ran commands, edited files, read files</, "its work grouped under the kinds it did");
  assert.doesNotMatch(done, /Deep diving|dsh-shimmer/);
  const earlier = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: settled("older"), live: false, expanded: false, useWork: doneWork }));
  assert.match(earlier, /dsh-turn-process-label">Completed<\/span>/, "an earlier turn says Completed");
  assert.doesNotMatch(earlier, /dsh-group/, "and stays folded until opened");
  // On a mission, the running group and its Think row start open; an ended round of a goal being
  // pursued opens its work under "Completed" the same way.
  const onMission = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn, live: true, expanded: false, useWork, mission: true }));
  assert.match(onMission, /class="dsh-group" data-open="true"/);
  assert.match(onMission, /dsh-title">Think<\/span><\/span><\/div><div class="dsh-think-body">/, "the thought is open, its words below");
  assert.match(onMission, /dsh-group-label dsh-shimmer">Reading files · README\.md</, "the live heading still reads what it does now");
  const round = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: settled("round"), live: false, expanded: false, useWork: doneWork, mission: true }));
  assert.match(round, /dsh-turn-process" data-open="true"/);
  assert.match(round, /class="dsh-group" data-open="true"/);
});

test("the default transcript shows real task progress for both ordinary and DeepSeek models", () => {
  const timeline = [{ id: "todo", kind: "tool", status: "completed", label: "TodoWrite", text: "TodoWrite",
    input: JSON.stringify({ todos: [{ content: "Inspect the failure", status: "completed" },
      { content: "Fix the renderer", status: "in_progress" }, { content: "Verify the result", status: "pending" }] }) }];
  for (const model of ["cpa/gpt-6.1-sol", "cpa/deepseek-v4.1-flash"]) {
    const runId = `tasks:${model}`;
    const props = { runs: [{ id: runId, project_id: "task", execution_mode: "single", nodes: [
      { id: "lead", role: "planner", state: "running", route: { harness_id: "ao:codex", model } }] }],
      tasks: [{ id: "task", title: "Task", description: "Make responses clearer" }], selectedTaskId: "task", busy: false, approvals: [],
      activity: { [`${runId}:lead`]: { timeline, activity: "Fixing the renderer", started_at_ms: Date.now() } },
      loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
    const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
    assert.match(html, /aria-label="Tasks"/, model);
    assert.match(html, /cx-rplan-count">1 of 3 done</);
    assert.match(html, /is-done.*Inspect the failure.*is-running.*Fix the renderer.*is-pending.*Verify the result/);
  }
});

test("transcript tasks fold when finished and never invent a checklist from ordinary tool calls", () => {
  const plans = load("chat-reply-plan.ts", { "./ao-chat": chat });
  const view = load("ChatReplyPlan.tsx");
  const tool = { id: "p", kind: "tool", status: "completed", label: "update_plan", text: "update_plan",
    input: JSON.stringify({ plan: [{ step: "Inspect the parser", status: "completed" }, { step: "Run tests", status: "completed" }] }) };
  const plan = plans.replyPlan([tool], false);
  const render = (plan, live) => renderToStaticMarkup(React.createElement(view.ReplyPlanView, { plan, style: "transcript", live }));
  const done = render(plan, false);
  assert.match(done, /aria-label="Tasks".*aria-expanded="false".*2 of 2 done/);
  assert.doesNotMatch(done, /cx-rplan-steps/, "finished tasks are not mounted until opened");
  assert.match(render(plan, true), /aria-expanded="true".*Inspect the parser.*Run tests/);
  assert.equal(render(plans.replyPlan([{ id: "c", kind: "command", status: "completed", text: "npm test" }], false), false), "");
});

test("ordinary model activity uses specific DeepSeek headings rather than unexplained Working", () => {
  const runId = "clear:activity";
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [{ id: runId, project_id: "task", execution_mode: "single", nodes: [
      { id: "lead", role: "planner", state: "running", route: { harness_id: "ao:codex", model: "cpa/gpt-6.1-sol" } }] }],
    tasks: [{ id: "task", title: "Task", description: "Check the project" }], selectedTaskId: "task", busy: false, approvals: [],
    activity: { [`${runId}:lead`]: { timeline: [{ id: "read", kind: "tool", status: "running", text: "Read",
      input: JSON.stringify({ path: "README.md" }) }], started_at_ms: Date.now() } },
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
  }));
  assert.match(html, /cx-group-verb cx-shimmer">Reading files · README\.md</);
  assert.doesNotMatch(html, /cx-group-verb[^>]*>Working</);
  assert.doesNotMatch(html, /cx-group-now|cx-tool-io/, "the active tool's card is drawn only once its row is opened");
});

test("a chat on a mission draws its thoughts and steps expanded, for every model's transcript; Settings › Chat turns it off", () => {
  const props = (model) => ({ runs: [{ id: `mission:${model}`, project_id: "task", execution_mode: "single", nodes: [
    { id: "lead", role: "planner", state: "running", route: { harness_id: "ao:codex", model } }] }],
  tasks: [{ id: "task", title: "Task", description: "Check the routes" }], selectedTaskId: "task", busy: false, approvals: [],
  activity: { [`mission:${model}:lead`]: { started_at_ms: Date.now(), timeline: [
    { id: "r1", kind: "reasoning", status: "completed", text: "**Reading the router**\n\nThe routes live in app.ts." },
    { id: "c1", kind: "command", status: "running", text: "npm test", description: "Run the tests" }] } },
  loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} });
  const render = (chat, model) => renderToStaticMarkup(React.createElement(chat.AgentOrchestratorChat, props(model)));
  const html = render(ui, "cpa/gpt-6.1-sol");
  assert.match(html, /class="cx-activity-head" aria-expanded="true"/, "the step group lists its steps with no click");
  assert.match(html, /<details class="cx-reasoning" data-family="think" open="">/, "the thought is open");
  assert.match(html, /The routes live in app\.ts\./);
  assert.equal(html.split("Reading the router").length - 1, 1, "its title is said once, on its row");
  assert.match(html, /<details class="cx-tool tone-running" data-family="command"><summary>/, "the command's row is listed, its card folded");
  assert.doesNotMatch(html, /cx-step-card|cx-tool-io/, "no step's card is drawn before its row is opened");
  // A DeepSeek turn's groups and Think rows open the same way.
  const deepseek = render(ui, "cpa/deepseek-v4.1-flash");
  assert.match(deepseek, /class="dsh-group" data-open="true"/);
  assert.match(deepseek, /dsh-think-body/, "its thought is open");
  // Off: as before, one line per run of steps.
  const off = load("AgentOrchestratorChat.tsx", { ...uiImports, "./chat-view-settings": viewSettings("off") });
  const folded = render(off, "cpa/gpt-6.1-sol");
  assert.match(folded, /class="cx-activity-head" aria-expanded="false"/);
  assert.doesNotMatch(folded, /cx-reasoning/);
  assert.doesNotMatch(render(off, "cpa/deepseek-v4.1-flash"), /data-open="true"|dsh-think-body/);
});

test("a long turn on a mission draws its newest steps under Show earlier steps, in both transcripts", () => {
  assert.equal(chat.WORK_WINDOW, 40);
  assert.equal(chat.workWindowStart([1, 1, 1]), 0, "a short list draws whole");
  assert.equal(chat.workWindowStart(Array(100).fill(1)), 60, "a long one its newest 40");
  assert.equal(chat.workWindowStart([1, 50]), 1, "an open group past the budget still draws (it windows itself)");
  assert.equal(chat.workWindowStart([50]), 0);
  assert.equal(chat.workWindowStart([10, 10, 10, 10, 10]), 1);
  assert.equal(chat.workGroupRows(Array(90).fill({}), true), 41, "an open group: its head and newest 40");
  assert.equal(chat.workGroupRows(Array(90).fill({}), false), 1, "a folded one: its head");
  const command = (n, status = "completed") => ({ id: `c${n}`, kind: "command", status, text: `run-${n}-end` });
  // 300 steps: nine commands, then a message, thirty times; and one group of 100 commands.
  const mixed = Array.from({ length: 300 }, (_, i) => (i + 1) % 10 ? command(i + 1) : { id: `m${i + 1}`, kind: "message", status: "completed", text: `Note ${i + 1}.` });
  const oneGroup = Array.from({ length: 100 }, (_, i) => command(i + 1, i === 99 ? "running" : "completed"));
  const props = (model, timeline) => ({ runs: [{ id: `long:${model}`, project_id: "task", execution_mode: "single", nodes: [
    { id: "lead", role: "planner", state: "running", route: { harness_id: "ao:codex", model } }] }],
  tasks: [{ id: "task", title: "Task", description: "Do the long job" }], selectedTaskId: "task", busy: false, approvals: [],
  activity: { [`long:${model}:lead`]: { started_at_ms: Date.now(), timeline } },
  loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} });
  const drawn = (html) => new Set((html.match(/run-\d+-end/g) ?? []));
  for (const model of ["cpa/gpt-6.1-sol", "cpa/deepseek-v4.1-flash"]) {
    const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props(model, mixed)));
    const shown = drawn(html);
    assert.ok(shown.has("run-299-end"), `${model}: the newest step is drawn`);
    assert.ok(!shown.has("run-1-end"), `${model}: the oldest is not`);
    assert.ok(shown.size <= 40, `${model}: ${shown.size} commands drawn`);
    const hidden = Number(/Show earlier steps · (\d+) not shown/.exec(html)?.[1]);
    assert.ok(hidden > 250, `${model}: the control counts the steps left out (${hidden})`);
    // One group of 100: its newest 40 rows, its own control above them.
    const group = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props(model, oneGroup)));
    assert.equal(drawn(group).size, 40, model);
    assert.ok(drawn(group).has("run-100-end") && drawn(group).has("run-61-end") && !drawn(group).has("run-60-end"), model);
    assert.match(group, /Show earlier steps · 60 not shown/, model);
  }
});

test("a reply's head says who answered, how it stands, why it failed, a team's cards and the files it changed", () => {
  const head = load("ChatReplyHead.tsx", { "./ao-chat": chat, "./HarnessLogo": { ModelLogo: () => null }, "./ChatChangedFiles": load("ChatChangedFiles.tsx"), "./ChatTurnStats": { useTurnRequests: () => ({ ref: { current: null }, summary: "" }) } });
  const edit = (path, additions, deletions) => ({ id: `${path}${additions}`, kind: "edit", status: "completed", text: "", files: [{ path, additions, deletions }] });
  // Seven one-line edits of one file read as that file once, with their lines summed.
  const changes = head.turnChanges([edit("src/aistudio.js", 1, 1), { id: "c", kind: "command", status: "completed", text: "npm test" },
    edit("src/aistudio.js", 4, 2), edit("tests/aistudio.test.cjs", 2, 0)]);
  assert.equal(JSON.stringify(changes.map((file) => [file.path, file.additions, file.deletions]).sort()),
    JSON.stringify([["src/aistudio.js", 5, 3], ["tests/aistudio.test.cjs", 2, 0]]));
  const single = renderToStaticMarkup(React.createElement(head.ReplyHead, { team: false, name: "GPT-6.1 Sol", tone: "failed",
    startedAtMs: 1_000, endedAtMs: 155_000, members: [], changes }));
  assert.match(single, /^<footer class="cx-reply-head is-quiet">/, "a single chat's summary is one quiet line under the answer");
  assert.match(single, /cx-reply-who-name">GPT-6\.1 Sol</);
  assert.match(single, /cx-reply-status is-failed">Failed</);
  assert.match(single, /cx-reply-time[^>]*>2m 34s</, "how long it ran");
  assert.doesNotMatch(single, /role="alert"/, "the error is not in the summary");
  const error = renderToStaticMarkup(React.createElement(head.ReplyError, { team: false, error: { step: "GPT-6.1 Sol", message: "API Error: 400 unknown provider" } }));
  assert.match(error, /role="alert".*Failed.*API Error: 400 unknown provider/, "the error leads the reply on its own");
  assert.match(single, /aria-label="2 files changed, 7 lines added, 3 lines removed"/, "the turn's total change");
  assert.match(single, /cx-reply-time[^>]*>2m 34s<\/span><span class="cx-changed-files"/, "the file count sits immediately beside runtime");
  assert.doesNotMatch(single, /cx-reply-files|cx-reply-total/, "no duplicate files box or raw path tooltip");
  // The chat draws a reply as: the failure, the work and answer, then the summary.
  const chatSource = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const [failure, answer, summary] = ["<ReplyError ", "className={`cx-answer", "<ReplyHead "].map((mark) => chatSource.indexOf(mark));
  assert.ok(failure > 0 && failure < answer && answer < summary, "the summary sits under the answer");
  assert.doesNotMatch(single, /cx-reply-roster|cx-reply-mode/, "a single chat has no team");
  const step = (key, name, extra) => ({ key, nodeId: key, role: "worker", name, detail: "", state: "finished", ...extra });
  const members = [step("p", "Planner"), step("w", "Worker", { working: { detail: "", stalled: false, activity: "Running npm test" }, state: "running" }),
    step("r", "Reviewer", { state: "pending" })].map((card) => ({ key: card.key, name: card.name, modelName: "GPT-6.1 Sol", tone: head.cardTone(card),
    state: card.working?.activity ?? card.state }));
  const team = renderToStaticMarkup(React.createElement(head.ReplyHead, { team: true, name: "Team", tone: "working", startedAtMs: Date.now() - 5_000,
    members, changes: [] }));
  assert.match(team, /cx-reply-mode">Team · 3</);
  assert.match(team, /cx-reply-member is-done.*Planner.*cx-reply-member is-working.*Running npm test.*cx-reply-member is-queued.*Reviewer/, "each card, in order, with how it stands");
  assert.doesNotMatch(team, /Changed files/, "no files strip before any edit");
  // A live turn reads stuck as soon as one card is; an ended one by its failure first, then how the run ended.
  const turn = (status, steps) => ({ key: "t", runId: "r", status, solo: false, steps });
  assert.equal(head.replyTone(turn("running", [step("a", "A", { working: { detail: "", stalled: true } })]), true), "stalled");
  assert.equal(head.replyTone(turn("stopped", [step("a", "A", { error: "boom" })]), false), "failed");
  assert.equal(head.replyTone(turn("stopped", [step("a", "A")]), false), "stopped");
  assert.equal(head.replyTone(turn("done", [step("a", "A")]), false), "done");
});

test("a DeepSeek group's rows read as DeepSeek Harness's: Think, Bash, Edit, and a failed command's exit capsule", () => {
  const row = (item) => renderToStaticMarkup(React.createElement(dsh.DshItem, { item }));
  assert.match(row({ id: "r1", kind: "reasoning", status: "completed", text: "**Let me check health.**\nThen the configs." }),
    /dsh-title">Think<\/span><span class="dsh-sep"[^>]*><\/span><span class="dsh-summary">Let me check health\.<\/span>/, "a Think row with its first line, ** dropped");
  assert.match(row({ id: "r2", kind: "reasoning", status: "running", text: "Checking.\n\nStill" }), /data-state="running"/, "a streaming thought fades at its right edge (data-state running)");
  assert.match(row({ id: "c1", kind: "command", status: "completed", text: "curl /healthz", description: "Check backend health", output: "ok" }),
    />Bash<\/span><span class="dsh-sep"[^>]*><\/span><span class="dsh-summary">Check backend health</, "a Bash row with the agent's words");
  assert.match(row({ id: "e1", kind: "edit", status: "completed", text: "", files: [{ path: "src/_recovery_state.py", additions: 28, deletions: 0, diff: "+a" }] }),
    />Edit<\/span>.*src\/_recovery_state\.py.*\+28<\/span> <span class="is-del">-0</, "an Edit row with its path and totals");
  assert.match(row({ id: "t1", kind: "tool", status: "running", text: "mcp__coding-tools__read_file", input: JSON.stringify({ path: "README.md" }) }),
    /dsh-row-text dsh-shimmer"><span class="dsh-title">Read<\/span>.*README\.md/, "the running call shimmers");
  // bash-sample.tsx: a failed command with an exit status keeps its own words and adds the neutral capsule.
  const failed = row({ id: "c2", kind: "command", status: "failed", text: "npm test", description: "Run the tests", output: "Exit code 1\nnpm ERR! Test failed." });
  assert.match(failed, /dsh-summary">Run the tests<\/span><span class="dsh-exit"><span class="dsh-exit-dot" aria-hidden="true"><\/span>exit code 1<\/span>/);
  assert.match(failed, /data-state="error"/, "the row is still a failure");
  const unnumbered = row({ id: "c3", kind: "command", status: "failed", text: "npm test", description: "Run the tests", output: "spawn npm ENOENT" });
  assert.match(unnumbered, /dsh-summary is-error">spawn npm ENOENT</, "a failure with no exit status keeps its red error line");
  assert.doesNotMatch(unnumbered, /dsh-exit/, "and no code is invented");
  assert.match(row({ id: "c4", kind: "command", status: "cancelled", text: "npm test", description: "Run the tests" }), /dsh-summary is-stopped">Stopped</, "a stopped command says Stopped");
});

test("a finished turn's rows stop shimmering even when their stored status still says running", () => {
  // Reasoning items whose completion never arrived kept the shimmer forever: 106 of them repainting
  // every frame in a long chat kept the GPU process near a full core.
  const stale = [
    { id: "r1", kind: "reasoning", status: "running", text: "Workers 7411 are down.\nRestarting them." },
    { id: "t1", kind: "tool", status: "running", text: "mcp__coding-tools__read_file", input: JSON.stringify({ path: "README.md" }) },
  ];
  const step = { key: "s", nodeId: "n", role: "planner", name: "Agent", detail: "", state: "finished", startedAtMs: Date.now() - 60_000, hasWork: true };
  const turn = { key: "done", runId: "run", steps: [step], status: "done", solo: true, startedAtMs: Date.now() - 60_000 };
  const html = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn, live: false, expanded: true, useWork: () => stale }));
  assert.doesNotMatch(html, /dsh-shimmer|data-state="running"/, "nothing in the finished turn shimmers or reads as running");
  // Its groups render folded here; opened (as they were live), each row decides for itself.
  const row = (item, live) => renderToStaticMarkup(React.createElement(dsh.DshItem, { item, live }));
  for (const item of stale) {
    assert.match(row(item, true), /data-state="running"/, `a live turn's running ${item.kind} row still reads as running`);
    assert.doesNotMatch(row(item, false), /dsh-shimmer|data-state="running"/, `the same ${item.kind} row in a finished turn is settled`);
  }
  assert.match(row(stale[0], false), /dsh-title">Think</, "and the thought is still there to open");
});

test("a running card's thoughts that the model moved on from stop shimmering; the current one and tools keep theirs", () => {
  // 146 such Think rows across four running missions were stepped 30 times a second by the shimmer
  // ticker and kept the window's main thread busy (0.8.104, 2026-11-09).
  const items = [
    { id: "r1", kind: "reasoning", status: "running", text: "First thought." },
    { id: "t1", kind: "tool", status: "running", text: "mcp__coding-tools__read_file", input: JSON.stringify({ path: "a.md" }) },
    { id: "r2", kind: "reasoning", status: "running", text: "Second thought." },
    { id: "s1", kind: "steer", status: "completed", text: "also check b.md" },
  ];
  const settled = dsh.settleFollowedThoughts(items);
  assert.deepEqual(settled.map((item) => item.status), ["completed", "running", "running", "completed"],
    "a followed thought settles; a tool and the newest thought (a steer is not the model moving on) keep running");
  assert.equal(items[0].status, "running", "the stored items are not changed");
  const quiet = [{ id: "r", kind: "reasoning", status: "running", text: "Only thought." }];
  assert.equal(dsh.settleFollowedThoughts(quiet), quiet, "nothing to settle gives back the same list");

  // Drawn on a mission (groups open): only the newest thought shimmers among the rows.
  const many = [];
  for (let index = 0; index < 6; index += 1) {
    many.push({ id: `r${index}`, kind: "reasoning", status: "running", text: `Thought ${index}.` });
    many.push({ id: `c${index}`, kind: "command", status: "completed", text: "npm test", description: "Run the tests" });
  }
  many.push({ id: "r-now", kind: "reasoning", status: "running", text: "Thinking now." });
  const step = { key: "s", nodeId: "n", role: "planner", name: "Agent", detail: "", state: "running", startedAtMs: Date.now() - 60_000, hasWork: true,
    working: { detail: "", stalled: false, timeline: many } };
  const turn = { key: "live", runId: "run", steps: [step], status: "running", solo: true, startedAtMs: Date.now() - 60_000 };
  const html = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn, live: true, expanded: true, mission: true, useWork: () => many }));
  const shimmeringRows = (html.match(/dsh-row-text dsh-shimmer/g) || []).length;
  assert.equal(shimmeringRows, 1, "one Think row shimmers, not seven");
  assert.equal((html.match(/dsh-title">Think</g) || []).length, 7, "every thought is still there to open");
});

test("a retried single DeepSeek card shows its earlier attempt above the attempt now", () => {
  const timeline = [{ id: "c1", kind: "command", status: "running", text: "npm test", description: "Run the tests" }];
  const step = { key: "s", nodeId: "n", role: "planner", name: "MiMo V2.6 Pro", detail: "", state: "running", startedAtMs: Date.now() - 5_000,
    working: { detail: "", stalled: false, timeline }, earlier: [{ label: "Attempt 1", verdict: "failed", text: "The agent's process ended." }] };
  const turn = { key: "retried", runId: "run", steps: [step], status: "running", solo: false, startedAtMs: Date.now() - 5_000 };
  const html = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn, live: true, expanded: false, useWork: (item) => item.working?.timeline ?? null }));
  const attempt = html.indexOf("Attempt 1"), work = html.indexOf("Run the tests");
  assert.ok(attempt >= 0, "the earlier attempt is shown");
  assert.ok(work > attempt, "and comes before the new attempt's work");
});

test("every new card starts with instructions and an expected output for its role", () => {
  const team = roles.defaultTeam("workspace", roles.workerRoute(roles.DEFAULT_WORKER_HARNESS, roles.DEFAULT_WORKER_MODEL));
  for (const node of team.nodes) {
    assert.ok(node.settings.instructions.length > 40, `${node.role} has instructions`);
    assert.ok(node.settings.expected_output.length > 20, `${node.role} has an expected output`);
  }
  // The reviewer's verdict goes first in its final message, which is where the controller reads it.
  assert.match(team.nodes.find(node => node.role === "reviewer").settings.expected_output, /^APPROVED or CHANGES_REQUIRED as the first word of your final message/);
  for (const role of ["planner", "approver", "worker", "retry", "review_split", "sub_reviewer", "reviewer"]) {
    const settings = roles.starterSettings(role, "Card");
    assert.ok(settings.instructions && settings.expected_output, role);
    assert.ok(settings.instructions.length <= 4096 && settings.expected_output.length <= 2048, `${role} fits the saved limits`);
  }
  // A quick preset adds its focus's rules and keeps its custom role name.
  const tester = roles.starterSettings("worker", "Tester", "testing", "Tester");
  assert.equal(tester.role_name, "Tester");
  assert.match(tester.instructions, /pass\/fail counts/);
  assert.equal(roles.starterSettings("worker", "Worker").role_name, undefined);
});

test("a session with no usage yet shows the chat's previous session's last reading, marked as such", () => {
  // Seen live: a chat resumed after a restart read "Waiting for the agent's first reply" for a
  // half-hour first request; Claude Code over ACP reports usage only when a model request ends.
  const usage = { contextUsed: 203_393, contextWindow: 400_000, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 13.3, currency: "USD" };
  const blank = { controller: "busy", usage: null, rateLimits: null, compactedAt: null, planLabel: null, mcpServers: [] };
  const sessions = { new: blank, old: { ...blank, controller: "stopped", usage }, other: { ...blank, usage: { ...usage, contextUsed: 5 } } };
  const carried = meter.currentContext(sessions, "new", ["old", "other"]);
  assert.equal(carried.controller, "busy", "the current session's own state");
  assert.equal(carried.usage.contextUsed, 203_393, "the newest earlier session with a reading");
  assert.equal(carried.carriedFrom, "old");
  const own = meter.currentContext({ ...sessions, new: { ...blank, usage: { ...usage, contextUsed: 1_000 } } }, "new", ["old"]);
  assert.equal(own.usage.contextUsed, 1_000, "once it reports, its own reading");
  assert.equal(own.carriedFrom, undefined);
  assert.equal(meter.currentContext({ new: blank }, "new", []).usage, null, "nothing to carry: still waiting");
  assert.equal(meter.currentContext({}, "new", ["old"]), undefined, "a failed read stays a failed read");
});

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

test("the first prompt and its attachments stay inside the agent reply, exactly once", () => {
  const prompt = "Keep this first request with its agent";
  const description = `${prompt}\n\nAttached image: G:\\task\\first-request.png`;
  for (const model of ["cpa/gpt-6.1", "cpa/deepseek-flash"]) {
    for (const mode of ["single", "team"]) {
      for (const state of ["pending", "running", "finished", "held"]) {
        const node = { id: "lead", role: "planner", state, route: { harness_id: "ao:claude-code", model },
          receipt: { thread_id: "first-request", started_at_ms: 1, ...(state === "finished" ? { answer: "Finished checking" } : {}) } };
        const props = { runs: [{ id: "run", project_id: "task", execution_mode: mode, nodes: [node] }],
          tasks: [{ id: "task", title: "Task" }], pendingMessage: description, selectedTaskId: "task", busy: false, approvals: [],
          loadDescription: async () => description, send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
        const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
        const reply = html.match(/<section class="cx-reply\b[^>]*>[\s\S]*?<\/section>/)?.[0];
        assert.ok(reply?.includes(prompt), `${model} ${mode} ${state}: the prompt belongs to the reply card`);
        assert.match(reply, /cx-sent-attachments/, "its attachment stays with it");
        assert.equal(html.split(prompt).length - 1, 1, "no duplicate outside bubble");
        assert.doesNotMatch(reply, /Attached image:/, "the attachment is rendered, not printed as a raw path");
        // A running single chat has no summary yet: its running line says who works and for how long.
        if (reply.includes("cx-reply-head")) assert.ok(reply.indexOf(prompt) < reply.indexOf("cx-reply-head"), "the request precedes the agent summary");
        else assert.ok(mode === "single" && state !== "finished", `${model} ${mode} ${state}: only a running single chat leaves the summary out`);
        assert.match(reply, /Copy message/, "message actions stay inside the card");
      }
    }
  }
});

test("saved steers stay with the initial message, including when no reply card exists", () => {
  const prompt = "First saved request", steer = "Also check the saved follow-up";
  const description = `${prompt}\n\n↳ Steer (2026-11-02 07:12 UTC): ${steer}`;
  for (const cancelled of [false, true]) {
    const node = { id: "lead", role: "planner", state: cancelled ? "pending" : "finished",
      route: { harness_id: "ao:claude-code", model: "cpa/gpt-6.1" },
      ...(!cancelled ? { receipt: { thread_id: "saved", answer: "Checked both requests" } } : {}) };
    const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
      runs: [{ id: "run", project_id: "task", cancelled, execution_mode: "single", nodes: [node] }],
      tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", pendingMessage: description, busy: false, approvals: [],
      loadDescription: async () => description, send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
    }));
    assert.equal(html.split(prompt).length - 1, 1);
    assert.equal(html.split(steer).length - 1, 1, "a saved steer must not disappear or duplicate");
    assert.ok(html.indexOf(prompt) < html.indexOf(steer));
    const reply = html.match(/<section class="cx-reply\b[^>]*>[\s\S]*?<\/section>/)?.[0];
    if (!cancelled) assert.ok(reply?.includes(prompt) && reply.includes(steer), "both requests belong to the agent card");
    else assert.equal(reply, undefined, "the cancelled run has no agent work to wrap");
  }
});

test("a message with no agent reply remains visible outside a nonexistent card", () => {
  const prompt = "This message still needs an agent";
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [], tasks: [{ id: "task", title: "Task" }], pendingMessage: prompt, selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => prompt, send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
  }));
  assert.ok(html.includes(prompt));
  assert.equal(html.split(prompt).length - 1, 1);
  assert.doesNotMatch(html, /<section class="cx-reply\b/, "no invented agent reply for an unsent message");
});

test("sending a new chat displays its task title and user message before startup completes", () => {
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [], tasks: [], selectedTaskId: "", busy: true, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
    pendingMessage: "Find the real parser failure", pendingTitle: "New task", pendingCreation: true,
  }));
  assert.ok(html.includes("Find the real parser failure"));
  assert.match(html, /<h2[^>]*>New task<\/h2>/);
  assert.ok(html.includes("Starting"));
});

test("normal asynchronous startup detail is not shown as a failed launch", () => {
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "pending" }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const starting = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, working: true, notice: "Awaiting local approval" }));
  assert.equal(starting.includes("start the run"), false);
  const failed = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, working: false, notice: "Codex CLI unavailable" }));
  assert.ok(failed.includes("start the run"));
});

test("recoverable tool timeouts do not add warning text to the chat", () => {
  const props = { tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  for (const state of ["running", "finished"]) {
    for (const model of ["cpa/gpt-6.1-sol", "cpa/deepseek-v4.1-flash"]) {
      for (const count of ["", ", 4 times"]) {
        const warning = `A tool call timed out (Headless request timed out)${count}. The chat keeps going by itself.`;
        const runs = [{ id: "run", project_id: "task", cancelled: false, execution_mode: "single",
          nodes: [{ id: "lead", role: "planner", state, route: { harness_id: "ao:codex", model },
            receipt: { answer: "The useful response remains visible.", started_at_ms: 1, ...(state === "finished" ? { finished_at_ms: 2 } : {}) } }] }];
        const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, runs, working: state === "running", warning }));
        assert.doesNotMatch(html, /A tool call timed out|The chat keeps going by itself|cx-timeout-line/);
        assert.equal(html.includes("Step failed"), false, "a recovered timeout does not require a click");
        if (state === "finished") assert.ok(html.includes("The useful response remains visible."));
      }
    }
  }
});

test("hiding recoverable timeout text does not hide an actual failed-step message", () => {
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [{ id: "run", project_id: "task", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "held", receipt: { error: "Authorization required" } }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [], working: false,
    warning: "A tool call timed out (Headless request timed out). The chat keeps going by itself.",
    notice: "Authorization required", loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
  }));
  assert.match(html, /Authorization required/);
  assert.doesNotMatch(html, /A tool call timed out|cx-timeout-line/);
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

test("a held card shows its error and still shows the reply it gave", () => {
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [{ id: "run", project_id: "task", cancelled: false, execution_mode: "single", nodes: [{ id: "lead", role: "planner", state: "held",
      route: { harness_id: "codex-native", model: "chatgpt-web/high" },
      receipt: { error: "Native turn returned no verifiable final answer", answer: "WebGPT's long reply" } }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {},
  }));
  const error = html.indexOf("Native turn returned no verifiable final answer");
  const reply = html.indexOf("WebGPT&#x27;s long reply");
  assert.ok(error >= 0 && reply > error, "the error is shown first, then the reply");
});

test("mission inspectors keep Retry structural changes in saved team templates", () => {
  const team = roles.defaultTeam("workspace", roles.workerRoute(roles.DEFAULT_WORKER_HARNESS, roles.DEFAULT_WORKER_MODEL));
  const node = team.nodes[1];
  const props = { node, mission: { id: "run", project_id: "task", nodes: [node], team }, draft: team,
    harnesses: [{ id: roles.DEFAULT_WORKER_HARNESS, label: "Claude Code", runnable: true, installed: true }],
    loadModels: async () => [], busy: false, change() {}, apply() {}, discard() {}, taskName: () => "Task" };
  const mission = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, props));
  assert.match(mission.match(/<option[^>]*value="retry"[^>]*>/)[0], /disabled/);
  assert.ok(mission.includes("Set up Retry roles on the Orchestrator Team page"));
  const template = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, { ...props, template: true }));
  assert.doesNotMatch(template.match(/<option[^>]*value="retry"[^>]*>/)[0], /disabled/);
  const retry = { ...node, role: "retry" };
  const locked = renderToStaticMarkup(React.createElement(roles.AgentOrchestratorRoleEditor, {
    ...props, node: retry, mission: { ...props.mission, nodes: [retry] },
    draft: { ...team, nodes: team.nodes.map(role => role.id === node.id ? retry : role) },
  }));
  assert.match(locked, /<label>Role<select[^>]*disabled/);
});


test("a retried step shows its failed attempt above the attempt now running, not under it", () => {
  // Seen live: "Attempt 1 failed · The agent's process ended before it finished" sat under the new
  // attempt's thinking, as if it had come after it.
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, execution_mode: "single", nodes: [{ id: "lead", role: "planner", state: "running",
    route: { harness_id: "ao:claude-code", model: "m" }, receipt: { thread_id: "sess-2", started_at_ms: Date.now() - 57_000 },
    history: [{ error: "The agent's process ended before it finished (the app restarted); retry this card." }] }] }],
    activity: { "run:lead": { activity: "working", timeline: [{ id: "m1", kind: "message", status: "running", text: "Opening the preview again." }] } },
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
  const earlier = html.indexOf("Attempt 1"), now = html.indexOf("Opening the preview again.");
  assert.ok(earlier >= 0 && now >= 0, "both show");
  assert.ok(earlier < now, "the failed attempt comes first");
});

test("a folded edit draws its numbered lines only once it is opened", () => {
  // Seen live: 298 folded edits held 51k of a long chat's 83k elements, every one restyled with the page.
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, execution_mode: "single", nodes: [{ id: "lead", role: "planner", state: "running",
    route: { harness_id: "ao:claude-code", model: "m" }, receipt: { thread_id: "sess-4", started_at_ms: Date.now() - 5_000 } }] }],
    activity: { "run:lead": { activity: "working", timeline: [{ id: "e1", kind: "edit", status: "completed", text: "",
      files: [{ path: "src/app.ts", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-old line\n+new line" }] }] } },
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
  assert.match(html, /cx-group-verb[^>]*>Edited a file</, "the edit is summarized in its compact activity group");
  assert.match(html, /1 file changed, 1 lines added, 1 lines removed/, "the file totals remain available outside the tool body");
  assert.equal(html.includes("cx-edit-num"), false, "no numbered lines until it opens");
  assert.equal(html.includes("new line"), false, "nor the changed text");
});

test("an image steered into a running turn shows as the image, not as its path", () => {
  // Seen live (before #457 reached the app): "Attached image: G:\AppData\Coding Tools\chat-attachments\…png"
  // printed as text in the steer's bubble inside the turn's work.
  const steer = "switch number ,if met the number is unable to verify on text\n\nAttached image: G:\\AppData\\Coding Tools\\chat-attachments\\2026-10-21\\image-df19f6fe.png";
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, execution_mode: "single", nodes: [{ id: "lead", role: "planner", state: "running",
    route: { harness_id: "ao:claude-code", model: "m" }, receipt: { thread_id: "sess-3", started_at_ms: Date.now() - 5_000 } }] }],
    activity: { "run:lead": { activity: "working", timeline: [{ id: "s1", kind: "steer", status: "completed", text: steer }] } },
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
  assert.match(html, /cx-user cx-steer"><div class="cx-sent-attachments">/, "the steer's image is drawn as an attachment");
  assert.equal(html.includes("Attached image:"), false, "its path line is not printed");
  assert.match(html, /<p>switch number ,if met the number is unable to verify on text<\/p>/, "the typed words stay in the bubble");
});

test("a steer carries Claude Code's read receipt: Unread while the agent holds it, Read by its model once read", () => {
  const render = (timeline) => renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, {
    runs: [{ id: "run", project_id: "task", cancelled: false, execution_mode: "single", nodes: [{ id: "lead", role: "planner", state: "running",
      route: { harness_id: "ao:claude-code", model: "cpa/gpt-5.5" }, receipt: { thread_id: "sess-4", started_at_ms: Date.now() - 5_000 } }] }],
    activity: { "run:lead": { activity: "working", timeline } },
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [], modelName: () => "GPT-5.5",
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "Claude Code · m", retryStart() {} }));
  const item = (id, kind) => ({ id, kind, status: "completed", text: kind === "steer" ? "check the logs too" : "x" });
  const unread = render([item("m1", "message"), item("s1", "steer")]);
  assert.match(unread, /class="cx-receipt" data-receipt="unread" role="img" aria-label="Unread"/, "a faded check, Unread");
  const read = render([item("m1", "message"), item("s1", "steer"), item("t1", "tool"), item("m2", "message")]);
  // Claude Code here runs GPT-5.5, so GPT-5.5 read it, not Claude.
  assert.match(read, /data-receipt="read" role="img" aria-label="Read by GPT-5.5"/, "a double check, Read by its model");
  assert.ok(read.indexOf("cx-receipt") < read.indexOf("Copy message"), "the receipt leads the row, before Copy");
});

test("an open chat's composer carries the context meter; a new chat's does not", () => {
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "finished",
    route: { harness_id: "ao:claude-code", model: "m" }, receipt: { thread_id: "sess-1", answer: "ok" } }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const open = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
  assert.match(open, /class="cx-icon-button cx-context-meter is-unknown"[^>]*aria-label="Context not reported yet"/);
  const fresh = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, runs: [], selectedTaskId: "" }));
  assert.equal(fresh.includes("cx-context-meter"), false);
});

test("CPA's Codex accounts' limits apply only to a model CPA serves from Codex, and read as Claude Code's", () => {
  roles.rememberCpaProviders({ "cpa/gpt-5.5": { provider: "codex" }, "cpa/deepseek-v4.1-flash": { provider: "cline-pass" } });
  assert.equal(roles.cpaProviderOf("cpa/gpt-5.5"), "codex");
  assert.equal(roles.cpaProviderOf("cpa/deepseek-v4.1-flash"), "cline-pass", "a Cline Pass model has no 5-hour or weekly window");
  assert.equal(roles.cpaProviderOf("cpa/codex/gpt-unknown"), "codex", "an unlisted model falls back to its id's prefix");
  assert.equal(roles.cpaProviderOf("gpt-5.5"), null, "not a CPA route");
  assert.equal(roles.cpaProviderOf(undefined), null);

  const now = new Date(2026, 9, 14, 13, 0).getTime();
  const later = new Date(2026, 9, 14, 19, 5).getTime();
  const nextWeek = new Date(2026, 9, 21, 10, 0).getTime();
  assert.match(meter.resetLabel(later, now), /^Resets 7:05\s?PM$/i, "today: the time only");
  assert.match(meter.resetLabel(nextWeek, now), /^Resets Oct 21, 10:00\s?AM$/i, "another day: the date and time");
  assert.equal(meter.resetLabel(now - 1, now), "", "a reset already past says nothing");
  assert.equal(meter.resetLabel(null, now), "");
  const chats = chat.chatAgentSessions([{ nodes: [{ role: "planner", route: { harness_id: "ao:claude-code", model: "cpa/gpt-5.5" }, receipt: { thread_id: "s1" } }] }]);
  assert.equal(chats[0].model, "cpa/gpt-5.5", "the chat passes the session's model to the meter");
});

test("a finished turn's work is skipped on re-render unless it changed; a live turn always re-renders", () => {
  const step = (over = {}) => ({ key: "r:a", nodeId: "a", role: "worker", name: "Builder", detail: "m", state: "finished", text: "done", hasWork: true, ...over });
  const turn = (over = {}) => ({ key: "r", runId: "r", steps: [step()], status: "done", solo: false, startedAtMs: 1, ...over });
  const props = (over = {}) => ({ turn: turn(), idle: false, expanded: false, loadWork: undefined, ...over });
  // The chat rebuilds each turn object on every update: an equal finished turn is the same work.
  assert.equal(ui.sameWork(props(), props()), true);
  assert.equal(ui.sameWork(props(), props({ turn: turn({ steps: [step({ text: "done, edited" })] }) })), false, "its text changed");
  assert.equal(ui.sameWork(props(), props({ turn: turn({ steps: [step(), step({ key: "r:b" })] }) })), false, "a step was added");
  assert.equal(ui.sameWork(props(), props({ turn: turn({ steps: [step({ verdict: "APPROVED" })] }) })), false, "a verdict arrived");
  assert.equal(ui.sameWork(props(), props({ expanded: true })), false, "details shown");
  assert.equal(ui.sameWork(props(), props({ mission: true })), false, "the turn went on a mission (a goal's round)");
  assert.equal(ui.sameWork(props({ mission: false }), props()), true, "no mission either way");
  assert.equal(ui.sameWork(props(), props({ loadWork: async () => [] })), false);
  const live = props({ turn: turn({ status: "running", steps: [step({ state: "running", working: { detail: "running 3s", stalled: false } })] }) });
  assert.equal(ui.sameWork(live, { ...live, turn: { ...live.turn } }), false, "a live turn re-renders on every update");
  const same = props();
  assert.equal(ui.sameWork(same, same), true);
});

test("an answer's Markdown is parsed once per text, not on every chat re-render", () => {
  let parses = 0;
  const real = load("chat-markdown.ts");
  const counted = load("ChatMarkdown.tsx", { "./chat-markdown": { ...real, parseMarkdown: (text) => { parses += 1; return real.parseMarkdown(text); } } });
  assert.equal(counted.ChatMarkdown.$$typeof, Symbol.for("react.memo"), "skips re-rendering while its text is unchanged");
  const text = "## Done\n\n- one `a`\n- two\n\n```js\nconst x = 1;\n```";
  const html = renderToStaticMarkup(React.createElement(counted.ChatMarkdown, { text }));
  assert.equal(html, renderToStaticMarkup(React.createElement(markdown.ChatMarkdown, { text })));
  assert.match(html, /<h4><span>Done<\/span><\/h4>/);
  assert.match(html, /<code>a<\/code>/);
  assert.match(html, /const x = 1;/);
  assert.equal(parses, 1);
});

test("an approval card that arrives while the window is hidden takes focus only once it is shown", () => {
  const { focusWhenShown } = load("AgentOrchestratorApproval.tsx", { "./ChatMarkdown": markdown, "./ModelJudgesToggle": judges });
  const page = (visibilityState) => {
    const listeners = new Set();
    return { visibilityState, listeners, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn),
      show(state = "visible") { this.visibilityState = state; for (const fn of [...listeners]) fn(); } };
  };
  let focused = 0;
  focusWhenShown(page("visible"), () => focused++);
  assert.equal(focused, 1, "a shown window focuses at once");

  focused = 0;
  const hidden = page("hidden");
  focusWhenShown(hidden, () => focused++);
  assert.equal(focused, 0, "no restyle of a page nobody sees");
  hidden.show("hidden");
  assert.equal(focused, 0);
  hidden.show();
  hidden.show();
  assert.equal(focused, 1, "focused once when shown");
  assert.equal(hidden.listeners.size, 0);

  const gone = page("hidden");
  const cleanup = focusWhenShown(gone, () => focused++);
  cleanup();
  gone.show();
  assert.equal(focused, 1, "a card answered or removed while hidden never takes focus");
});

test("an AO agent's question and tool request show as Codex's cards: numbered options; a tool request's answer is one click", () => {
  const approvalUi = load("AgentOrchestratorApproval.tsx", { "./ChatMarkdown": markdown, "./ModelJudgesToggle": judges });
  const question = { nodeId: "one", approval_id: "ask", source: "ao", kind: "question", message: "Please answer the following questions.",
    fields: [
      { key: "question_0", type: "choice", title: "Lockfile", description: "Rewrite the lockfile hosts or regenerate it?", customKey: "question_0_custom",
        options: [{ value: "Rewrite hosts", label: "Rewrite hosts", description: "Keep every pinned version" }, { value: "Regenerate", label: "Regenerate", description: "" }] },
      { key: "question_1", type: "multi", title: "Backend", description: "", options: [{ value: "fastapi", label: "fastapi", description: "" }] },
    ] };
  const html = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, { approval: question, busy: false, approve() {} }));
  assert.match(html, /class="cdx-title">Rewrite the lockfile hosts or regenerate it\?</, "the question is the card's title");
  assert.match(html, /1 of 2/, "one question at a time, as Codex asks them");
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /class="cdx-option-mark"[^>]*>1<\/span><span class="cdx-option-label">Rewrite hosts/, "numbered options");
  assert.match(html, /Keep every pinned version/);
  assert.match(html, /placeholder="Type here"/);
  assert.match(html, />Skip<\/button>/, "Skip while nothing is entered");
  assert.match(html, />Dismiss <kbd class="cdx-kbd">ESC<\/kbd><\/button>/);

  // A tool request the reviewer left at "ask": Codex's approval card, titled with the card's model.
  const request = { nodeId: "one", approval_id: "req", source: "ao", kind: "command", tool: "PowerShell", summary: "Parse recent refresh and recovery task results",
    command: "$env:PYTHONUTF8='1'\npython -c \"print(1)\"", recommendation: { action: "ask", reason: "Inspect the complete native command yourself" },
    decisions: [{ id: "yes", kind: "allow_once", label: "Allow" }, { id: "always", kind: "allow_always", label: "Always allow" }, { id: "no", kind: "reject_once", label: "Reject" }] };
  const ask = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, { approval: request, busy: false, approve() {}, actor: "DeepSeek V4.1 Flash" }));
  assert.match(ask, /class="cdx-kind">Terminal</);
  assert.match(ask, /Allow DeepSeek V4\.1 Flash to run this command\?/);
  assert.match(ask, /<pre[^>]*>\$env:PYTHONUTF8=&#x27;1&#x27;/);
  assert.match(ask, /<span>Reason<\/span><p>Parse recent refresh and recovery task results/);
  assert.match(ask, /<span>Reviewer<\/span><p>Inspect the complete native command yourself/);
  assert.deepEqual([...ask.matchAll(/class="cdx-option-label">([^<]+)</g)].map((match) => match[1]), ["Allow once", "Allow this conversation", "Deny"], "Codex's words");
  // Clicking an option answers at once, as Claude Code's prompt does: no Submit or Deny button.
  assert.doesNotMatch(ask, />Submit </);
  assert.doesNotMatch(ask, /cdx-foot/);
});

test("AO and native approval commands share directly scrollable cards without extra viewer controls", () => {
  const approvalUi = load("AgentOrchestratorApproval.tsx", { "./ChatMarkdown": markdown, "./ModelJudgesToggle": judges });
  const command = [...Array.from({ length: 30 }, (_, index) => `echo command-line-${index}`), "echo FULL_COMMAND_TAIL"].join("\n");
  const base = { nodeId: "one", approval_id: "req", kind: "command" };
  const cases = [
    { ...base, source: "ao", tool: "Bash", command },
    { ...base, command },
    { ...base, method: "item/commandExecution/requestApproval", thread_id: "thread", turn_id: "turn", request: { command } },
  ];
  for (const approval of cases) {
    const html = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, { approval, busy: false, approve() {} }));
    assert.match(html, /class="cdx-card"[^>]*><div class="cdx-body">/, "native and AO commands share the same card and body structure");
    assert.doesNotMatch(html, /ao-msg-approval|cdx-native-command/, "legacy native command styling cannot override the shared card");
    assert.match(html, /class="cdx-kind">Terminal</);
    assert.match(html, /Allow the agent to run this command\?/);
    assert.match(html, /<pre[^>]*tabindex="0"[^>]*aria-label="Command"[^>]*>/, "the command can receive keyboard scrolling focus");
    assert.ok(html.includes(command), "the entire multiline command, including its tail, is rendered");
    assert.doesNotMatch(html, /<dialog|>Copy<|>Open full |is-collapsed|>Expand<|>Collapse</, "the complete command is available directly");
  }
  const short = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, {
    approval: { ...base, source: "ao", command: "pwd" }, busy: false, approve() {},
  }));
  assert.match(short, /<pre[^>]*aria-label="Command"[^>]*>pwd<\/pre>/);
  assert.doesNotMatch(short, /<dialog|>Copy<|>Open full /, "short commands have no extra viewer controls either");
  const permissions = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, {
    approval: { ...base, kind: "permissions", method: "item/permissions/requestApproval", thread_id: "thread", turn_id: "turn", request: { permissions: {} } }, busy: false, approve() {},
  }));
  assert.match(permissions, /class="ao-msg ao-msg-approval"/);
  assert.doesNotMatch(permissions, /cdx-card/, "other native request types keep their existing layout");
});

test("approval tool input uses the complete original text in the same viewer", () => {
  const approvalUi = load("AgentOrchestratorApproval.tsx", { "./ChatMarkdown": markdown, "./ModelJudgesToggle": judges });
  const toolInput = '{  "path": "src/example.ts",\n "content": "FULL_TOOL_INPUT_TAIL" }';
  for (const source of ["ao", undefined]) {
    const html = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, {
      approval: { nodeId: "one", approval_id: "req", source, tool: "read_file", toolInput }, busy: false, approve() {},
    }));
    assert.match(html, /<pre[^>]*aria-label="Tool input"/);
    assert.ok(html.includes(toolInput.replaceAll('"', "&quot;")), "JSON spacing and every field are preserved");
    assert.doesNotMatch(html, /<dialog|>Copy<|>Open full |is-collapsed/);
  }
  const edit = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, {
    approval: { nodeId: "one", approval_id: "edit", source: "ao", tool: "Edit", path: "src/example.ts", toolInput }, busy: false, approve() {},
  }));
  assert.match(edit, /FULL_TOOL_INPUT_TAIL/, "an edit's file path must not hide its requested content");
});

test("a question the person answered shows as Claude Code shows one: the question, then the answer", () => {
  const parts = load("ChatToolParts.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown });
  const html = renderToStaticMarkup(React.createElement(parts.AnsweredRecord, { question: "Allow DeepSeek to run this command?", answer: "Allow once" }));
  assert.match(html, /class="cx-answered-question">Allow DeepSeek to run this command\?<\/p><p class="cx-answered-answer">Allow once</);
  const tidy = chat.tidyTimeline([{ id: "a", kind: "approval", status: "completed", text: "PowerShell", approval: "Allowed",
    answered: { question: "Parse results", answer: "Allow once" } }]);
  assert.equal(tidy.length, 1, "the answered request keeps its own row");
});

test("the side panel opens on an Overview of the chat: environment, context, changes, background tasks and usage", () => {
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null }, "./ao-chat": chat,
    "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }), "./page-visibility": visibility });
  const html = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, {
    sessions: [{ id: "ao-1", label: "Claude Code", model: "cpa/cline-pass/glm-5.3-flash", contextWindow: 400000 }],
    tab: "overview", onTab: () => {}, onClose: () => {}, workspaceId: "ws" }));
  for (const heading of ["Environment", "Context", "Changes", "Background tasks", "Usage"]) assert.match(html, new RegExp(`<h4>${heading}`), heading);
  assert.match(html, /glm-5\.3-flash/, "the model by its own name");
  assert.match(html, /Today<\/button>/, "usage can switch between today, 7 and 30 days");
});

test("a chat shows the subagents its own agents started, as Codex's panel does: who works, on what, a click from their work", () => {
  // Seen live: an agent's subagent_start showed only as the call; nothing said a subagent was working.
  const run = (id, parent, state, extra = {}) => ({ subagent_id: id, agent: "explorer", name: "Explorer", state, task: `Find the autoplay gate ${id}`,
    elapsed_seconds: 75, parent, started_at: Number(id.slice(1)), ...extra });
  const all = [run("s1", "ao-1", "completed", { report: "Found it", ended_at: Date.now() - 5 * 60_000 }), run("s2", "ao-other", "running"), run("s3", "ao-1", "running"),
    run("s4", "ao-2", "starting", { name: "Reviewer" })];
  const own = chat.chatSubagents(all, ["ao-1", "ao-2"]);
  assert.deepEqual(own.map((item) => item.subagent_id), ["s4", "s3", "s1"], "another chat's are left out; working ones first, newest first");
  assert.equal(chat.subagentTitle(own[1]), "Explorer · Find the autoplay gate s3", "named by its job");
  assert.equal(chat.subagentTitle({ name: "Explorer", task: "x".repeat(80) }).length, "Explorer · ".length + 48, "a long task is shortened");
  assert.equal(chat.subagentsSummary(own), "2 subagents working: Reviewer and Explorer");
  assert.equal(chat.subagentsSummary([own[2]]), "1 subagent finished");
  assert.equal(chat.subagentsSummary([]), null);

  const subagentsView = load("chat-subagents.tsx", { "./ao-chat": chat, "./AgentOrchestratorRoleEditor": roles });
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null }, "./ao-chat": chat,
    "./ChatMarkdown": markdown, "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }), "./page-visibility": visibility,
    "./chat-subagents": subagentsView });
  const props = { sessions: [{ id: "ao-1", label: "Claude Code" }], onTab: () => {}, onClose: () => {}, workspaceId: "ws", subagents: own };
  const overview = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, { ...props, tab: "overview" }));
  assert.match(overview, /<h4>Subagents<small>2 working<\/small>/, "the Overview lists them");
  const tab = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, { ...props, tab: "subagents" }));
  assert.match(tab, />Subagents<\/button>/, "a Subagents tab");
  // The user, 2026-11-12: "make the subagent panel preview exact the same as codex": "Active · N" and
  // "Done · N", each row an avatar, the job, and on the right how long it has worked or when it ended.
  assert.match(tab, /<span>Active · 2<\/span>.*<span>Done · 1<\/span>/, "Codex's two sections, with counts");
  assert.match(tab, /class="cx-sa-row has-preview is-starting".*class="cx-sa-avatar".*Find the autoplay gate s4<\/span><span class="cx-sa-row-trailing">1m<\/span>.*Reviewer<\/span>/,
    "an active one: its job, how long it has worked, and who works on it");
  assert.match(tab, /class="cx-sa-row is-completed".*Find the autoplay gate s1<\/span><span class="cx-sa-row-trailing">5m ago<\/span>/, "a finished one: when it ended");
  const none = renderToStaticMarkup(React.createElement(subagentsView.SubagentList, { subagents: [own[2]], onSelect: () => {} }));
  assert.match(none, /Active · 0.*No active subagents.*Done · 1/, "Codex's empty line when nothing works");
  const many = Array.from({ length: 13 }, (_, index) => run(`d${index}`, "ao-1", "completed", { ended_at: Date.now() }));
  assert.match(renderToStaticMarkup(React.createElement(subagentsView.SubagentList, { subagents: many, onSelect: () => {} })), />Show 3 more<\/button>/,
    "ten finished ones, then Show 3 more");
});

test("a subagent's page is headed like Codex's: back, its avatar, its job, and the model and effort it runs on", () => {
  // The user, 2026-11-12: "inside its subagent chat sessions preview panel ... its missing model name effort".
  const view = load("chat-subagents.tsx", { "./ao-chat": chat, "./AgentOrchestratorRoleEditor": roles });
  assert.equal(view.subagentModelLine({ model: "cpa/gpt-6.1-sol", effort: "xhigh" }), "GPT-6.1 Sol · Extra High", "Codex's own effort words");
  assert.equal(view.subagentModelLine({ model: "claude-opus-5-5", effort: "low" }), "Opus 5.5 · Light");
  assert.equal(view.subagentModelLine({ model: "glm-5.3-flash" }), "GLM 5.3 Flash", "no effort, just the model");
  assert.equal(view.subagentModelLine({}), "");
  assert.equal(view.subagentJob({ name: "Explorer", task: "\n  Find the gate\nthen report" }), "Find the gate", "the task's first line");
  assert.equal(view.subagentJob({ name: "Explorer", task: "" }), "Explorer");
  assert.equal(view.subagentJob({ name: "Explorer", task: "y".repeat(90) }).length, 60);
  assert.equal(view.workedFor(42), "42s");
  assert.equal(view.workedFor(5400), "1h 30m");
  assert.equal(view.endedAgo(0, 3 * 3600_000), "3h ago");
  assert.equal(view.avatarIndex("s1"), view.avatarIndex("s1"), "one subagent keeps its avatar");
  assert.ok(view.avatarIndex("anything") < 28);
  const html = renderToStaticMarkup(React.createElement(view.SubagentHeader, {
    run: { subagent_id: "s1", name: "Explorer", task: "Find the gate", state: "running", elapsed_seconds: 3, model: "cpa/gpt-6.1-sol", effort: "xhigh" },
    onBack: () => {}, trailing: React.createElement("button", { className: "cx-subagent-stop" }, "Stop") }));
  assert.match(html, /aria-label="Back to subagents".*class="cx-sa-avatar".*class="cx-sa-head-label"[^>]*>Find the gate<.*class="cx-sa-head-model"[^>]*>GPT-6.1 Sol · Extra High<.*>Stop</);
});

test("the chat details read as Codex's pinned summary: Changes +N −M, the PR, the subagents' avatars, lists of five then View all", () => {
  // The user, 2026-11-12: "remake the session details panel to exact codex one".
  const view = load("chat-subagents.tsx", { "./ao-chat": chat, "./AgentOrchestratorRoleEditor": roles });
  const summary = load("chat-summary-panel.tsx", { "./ao-chat": chat, "./chat-subagents": view });
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null }, "./ao-chat": chat, "./ChatMarkdown": markdown,
    "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }), "./page-visibility": visibility, "./chat-subagents": view });
  // A removed line that starts with dashes, or an added one with pluses, is still a line; file headers are not.
  const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n--- dashes\n+new\n+++ pluses\n same\n"
    + "diff --git a/y b/y\nnew file mode 100644\n--- /dev/null\n+++ b/y\n@@ -0,0 +1 @@\n+y\n";
  assert.deepEqual({ ...workbench.diffLineCounts(diff) }, { additions: 3, deletions: 2 });
  assert.deepEqual({ ...workbench.diffLineCounts("") }, { additions: 0, deletions: 0 });

  const render = (type, props) => renderToStaticMarkup(React.createElement(type, props));
  const changes = (value) => render(summary.SummaryRow, { icon: "i", label: "Changes", meta: React.createElement(summary.ChangesMeta, { changes: value }), onClick: () => {} });
  assert.match(changes({ additions: 12, deletions: 3, files: 2 }),
    /^<button type="button" class="cx-sum-row"><span class="cx-sum-icon" aria-hidden="true">i<\/span><span class="cx-sum-label">Changes<\/span><span class="cx-sum-meta"><span class="cx-sum-diff"><span class="is-add">\+12<\/span><span class="is-del">−3<\/span>/,
    "an icon, the label, and +/− on the right");
  assert.match(changes({ additions: 0, deletions: 0, files: 1 }), /cx-sum-meta">1 file</, "only new files: how many");
  assert.match(changes({ additions: 0, deletions: 0, files: 0 }), /cx-sum-meta">None</);
  assert.match(changes(null), /cx-sum-pending">…</, "still reading");
  assert.match(render(summary.SummaryRow, { icon: "i", label: "PR #42", meta: summary.pullRequestState("merged"), href: "https://github.com/o/r/pull/42" }),
    /^<a class="cx-sum-row" href="https:\/\/github.com\/o\/r\/pull\/42" target="_blank" rel="noreferrer noopener">.*PR #42<.*cx-sum-meta">Merged</, "a PR opens in the browser");
  assert.equal(summary.pullRequestState("draft"), "Draft");
  assert.equal(summary.pullRequestState("unknown"), "Open");
  assert.match(render(summary.SummaryRow, { icon: "i", label: "context7" }), /^<div class="cx-sum-row is-static">/, "an MCP server only names what was called");

  const runs = Array.from({ length: 6 }, (_, index) => ({ subagent_id: `s${index}`, name: "Explorer", task: "t", state: index ? "completed" : "running", elapsed_seconds: 1 }));
  assert.equal(render(summary.SubagentStack, { subagents: runs }).match(/class="cx-sa-avatar"/g).length, 4, "four avatars at most, as Codex shows");
  assert.equal(summary.subagentsMeta(runs), "1 working");
  assert.equal(summary.subagentsMeta(runs.slice(1)), "5 done");

  const items = Array.from({ length: 7 }, (_, index) => `item ${index}`);
  const list = render(summary.SummaryList, { items, render: (item) => React.createElement("p", { key: item }, item) });
  assert.equal(list.match(/<p>item/g).length, 5, "five, then");
  assert.match(list, /<button type="button" class="cx-sum-more" aria-expanded="false">View all<\/button>$/);
  assert.equal(render(summary.SummaryList, { items: [], render: () => null, empty: "Web pages show here." }), '<p class="cx-sum-empty">Web pages show here.</p>');
  assert.equal(render(summary.SummaryList, { items: [], render: () => null }), "", "a section with nothing to list is left out");
  const section = render(summary.SummarySection, { title: "Sources", children: "x" });
  assert.equal(section, '<section class="cx-sum-section"><h3 class="cx-sum-heading"><span>Sources</span></h3>x</section>');

  // The chat reads them only while the details are open, never on a timer, and stops at nothing else.
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  assert.match(source, /useChatSummaryFacts\(selectedTaskId \? agentSessionIds\[0\] : undefined, projectId, detailsOpen,/);
  assert.doesNotMatch(source, /cx-details-label|Approvals: \{chatApprovalMode/, "the old list of labels and the Setup lines are gone");
  const hook = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatWorkbench.tsx"), "utf8").split("export function useChatSummaryFacts")[1].split(/\r?\n\}\r?\n/)[0];
  assert.doesNotMatch(hook, /setInterval|startWorkbenchPoll/, "a git diff walks the worktree: never on a timer");
});

test("the Terminal pane opens for a server or the project's app launcher, never for a one-off tool call", () => {
  // Seen live: every `git status` and `ls` the agent ran opened the pane beside the chat.
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  const now = 1_000_000;
  const command = (cmd, extra = {}) => ({ id: "c", cmd, workdir: ".", startedAt: now - 2000, status: "running", exitCode: null, source: "agent", ...extra });
  assert.equal(workbench.opensTerminal(command("git status --short | head -80"), now), false, "a one-off call does not");
  assert.equal(workbench.opensTerminal(command("aiTemp\\run_app.cmd"), now), true, "the user's app launcher does");
  assert.equal(workbench.opensTerminal(command("npm run dev"), now), true, "a dev server does");
  assert.equal(workbench.opensTerminal(command("pytest -q", { status: "background", background: true }), now), true, "one left in the background does");
  assert.equal(workbench.opensTerminal(command("pytest -q", { startedAt: now - 61_000 }), now), false, "a long test run does not");
  assert.equal(workbench.opensTerminal(command("scripts/start-server.ps1"), now), true, "nor does it miss a start-server script");
  assert.equal(workbench.opensTerminal(command("npm run dev", { status: "exited", exitCode: 0 }), now), false, "an ended command never does");
});

test("the details' Processes list the app page and running commands green, ended servers and shells red", () => {
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  const command = (id, cmd, startedAt, extra = {}) => ({ id, cmd, workdir: "G:/p", startedAt, status: "running", exitCode: null, source: "agent", ...extra });
  const rows = workbench.chatProcessRows([
    command("a", "git status", 1, { status: "exited", exitCode: 0 }),
    command("b", "npm run dev", 2, { status: "exited", exitCode: 1 }),
    command("c", "npm run dev", 3),
    command("d", "pytest -q", 4),
    command("e", "pwsh", 5, { user: true, status: "exited", exitCode: 0 }),
    command("f", "scripts/run_app.cmd", 6, { status: "exited", exitCode: 1 }),
  ], { sessionId: "ao-1", url: "http://localhost:5173/", title: "" });
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => [row.label, row.kind, row.running]))), [
    ["localhost:5173", "app", true],
    ["pytest -q", "terminal", true],
    ["npm run dev", "terminal", true],
    ["scripts/run_app.cmd", "terminal", false],
    ["Your terminal", "terminal", false],
  ], "a one-off that ended is left out, and a server that runs again shows once");
});

test("the side panel opens only when the agent is asked to show something (show_in_chat), never by itself", () => {
  // The user, 2026-11-12: "make the tools stop opening tabs when like subagent used, tools call,
  // terminal etc, only when i tell the model to open then it should open for me".
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000"], false), null, "a page the agent loads leaves a closed panel closed");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "cmd:c1"], true), null, "and an open one as it is");
  assert.equal(workbench.autoOpenTab(["page:ao-1:null"], false), null, "as does a live panel or visualization it renders");
  assert.equal(workbench.autoOpenTab(["cmd:c1"], false), null, "a command never opens it");
  assert.equal(workbench.autoOpenTab([], false), null);
  assert.equal(workbench.autoOpenTab(["show:show-1:terminal"], false), "terminal", "show_in_chat on a command opens the Terminal");
  assert.equal(workbench.autoOpenTab(["show:show-3:preview"], false), "preview", "and on its page the Preview");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "show:show-2:terminal", "show:show-4:preview"], true), "preview",
    "the newest request wins");
  assert.equal(workbench.autoOpenTab(["show:show-5:window"], false), null, "a pane it does not know opens nothing");
  // Only a server process opens it: the agent's one-off commands (a status poll, a build, a test)
  // put the Terminal over the chat while it worked.
  const server = (cmd, extra = {}) => workbench.isServerProcess({ cmd, status: "running", ...extra });
  for (const cmd of ["npm run dev", "pnpm dev", "yarn start", "npx vite", "next dev -p 3000", "python -m http.server 8000",
    "uvicorn app:app --reload", "flask run", "python manage.py runserver", "docker compose up"]) assert.equal(server(cmd), true, cmd);
  for (const cmd of ['$body = \'{}\'; Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:8000/api/actions"', "npm test", "npm run build",
    "cargo test", "git status", "dir /b", "python tools/poll.py"]) assert.equal(server(cmd), false, cmd);
  assert.equal(server("python tools/poll.py", { status: "background" }), true, "anything the agent left running in the background");
  const polled = new Set(["ao-1"]);
  assert.equal(workbench.startsNewChat(["ao-2"], polled), true, "another chat starts over");
  assert.equal(workbench.startsNewChat(["ao-1", "ao-3"], polled), false, "an agent joining the same chat does not");
});

test("the Subagents page's model picker lists the AO agent's own models, never WebGPT (Native Codex only)", async () => {
  const read = [];
  const loadModels = async (harness) => {
    read.push(harness);
    return harness === roles.NATIVE_HARNESS ? ["chatgpt-web/high", "gpt-pool"] : { models: ["cpa/m1", "cpa/chatgpt-web/pro"], capabilities: { "cpa/m1": { efforts: ["high"] } } };
  };
  const card = await roles.pickerModels("ao:claude-code", loadModels);
  assert.deepEqual([...card.models], ["cpa/m1", "cpa/chatgpt-web/pro", "chatgpt-web/high"], "a card's picker still offers WebGPT (it moves the card to Native Codex)");
  read.length = 0;
  const subagent = await roles.pickerModels("ao:claude-code", loadModels, true);
  assert.deepEqual([...subagent.models], ["cpa/m1"], "a subagent saved on one would be refused on Save");
  assert.deepEqual([...subagent.capabilities["cpa/m1"].efforts], ["high"]);
  assert.deepEqual(read, ["ao:claude-code"], "Native Codex's catalog is not read for it");
  const page = fs.readFileSync(path.resolve(__dirname, "../src/features/SubagentsSurface.tsx"), "utf8");
  assert.match(page, /pickerModels\(harness, loadModels, true\)/, "the page reads each agent's own models, never WebGPT");
});

test("the Subagents page lists every agent's models once, and a model runs on an agent that lists it", () => {
  // Reported 2026-11-03: with Claude Code as the page's agent, Gemini 3.8 Flash was missing (Claude
  // Code's list leaves out Antigravity's models, which refuse it) and the saved default read "no longer listed".
  const page = load("SubagentsSurface.tsx", { "./AgentOrchestratorSurface": {}, "./AgentOrchestratorRoleEditor": roles });
  const plainOf = (value) => JSON.parse(JSON.stringify(value));
  const choices = page.modelChoices([
    { harness: "ao:codex", catalog: { models: ["cpa/gemini-3.8-flash-high", "cpa/gpt-6.1-sol"], capabilities: { "cpa/gemini-3.8-flash-high": { efforts: ["low", "high"] } } } },
    { harness: "ao:claude-code", catalog: { models: ["cpa/gpt-6.1-sol", "default"] } },
  ]);
  assert.deepEqual(plainOf(choices.map((choice) => [choice.model, choice.harnesses])),
    [["cpa/gpt-6.1-sol", ["ao:claude-code", "ao:codex"]], ["cpa/gemini-3.8-flash-high", ["ao:codex"]]], "each model once, Claude Code first; no bare \"default\"");
  assert.deepEqual(plainOf(page.routeForModel("cpa/gemini-3.8-flash-high", choices, "ao:claude-code")),
    { harness_id: "ao:codex", model: "cpa/gemini-3.8-flash-high", provider_id: "agent-orchestrator" }, "Gemini goes to the agent that runs it");
  assert.equal(page.routeForModel("cpa/gpt-6.1-sol", choices, "ao:codex").harness_id, "ao:codex", "a model keeps an agent that runs it");
  assert.equal(page.routeForModel("cpa/gone", choices), null);
  const saved = { harness_id: "ao:claude-code", model: "cpa/gemini-3.8-flash-high", effort: "high" };
  assert.deepEqual(plainOf(page.runnableRoute(saved, choices)),
    { harness_id: "ao:codex", model: "cpa/gemini-3.8-flash-high", provider_id: "agent-orchestrator", effort: "high" }, "a saved default Claude Code can't run moves, keeping an effort its new agent offers");
  assert.equal(page.runnableRoute({ ...saved, effort: "max" }, choices).effort, undefined, "an effort the new agent doesn't offer goes");
  const listed = { harness_id: "ao:claude-code", model: "cpa/gpt-6.1-sol" };
  assert.equal(page.runnableRoute(listed, choices), listed, "a route its agent runs stays as it is");
  assert.equal(page.runnableRoute(null, choices), null);
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/SubagentsSurface.tsx"), "utf8");
  assert.doesNotMatch(source, /HarnessPicker|Clear default model|On for new chats|All changes saved/, "no harness field, default buttons, status pills or idle save text");
});

test("the Subagents page picks a model by its provider, and keeps the list of providers the user allows", () => {
  // Asked 2026-11-10: "let user to choose which provider they want … and allowed providers … i dont
  // want to use on some provider to cost my limit too much".
  const page = load("SubagentsSurface.tsx", { "./AgentOrchestratorSurface": {}, "./AgentOrchestratorRoleEditor": roles });
  const plainOf = (value) => JSON.parse(JSON.stringify(value));
  const choices = page.modelChoices([
    { harness: "ao:codex", catalog: { models: ["gpt-6", "cpa/gemini-3.8-flash", "cpa/cline-pass/deepseek-v4.1-flash", "cpa/glm-5"],
      capabilities: { "cpa/gemini-3.8-flash": { efforts: ["high"], provider: "Antigravity" } } } },
  ]);
  assert.deepEqual(plainOf(choices.map((choice) => [choice.model, choice.provider])), [["gpt-6", "ao:codex"], ["cpa/gemini-3.8-flash", "antigravity"],
    ["cpa/cline-pass/deepseek-v4.1-flash", "cline-pass"], ["cpa/glm-5", "cpa"]], "CPA's reported provider, else the id's prefix; Codex's own models are its own account, not CPA's codex");
  assert.deepEqual(plainOf(page.providerChoices(choices).map((item) => [item.key, item.label, item.models])),
    [["antigravity", "Antigravity", 1], ["cline-pass", "Cline Pass", 1], ["ao:codex", "Codex (own account)", 1], ["cpa", "Other", 1]], "by name, Other last");
  const known = ["antigravity", "cline-pass", "ao:codex", "cpa"];
  assert.deepEqual(plainOf(page.toggleProvider(null, "cline-pass", false, known)), ["antigravity", "ao:codex", "cpa"], "turning one off keeps the rest");
  assert.deepEqual(plainOf(page.toggleProvider(["antigravity"], "cpa", true, known)), ["antigravity", "cpa"]);
  assert.equal(page.toggleProvider(["antigravity", "ao:codex", "cpa"], "cline-pass", true, known), null, "every one on again allows new providers too");
  assert.equal(page.providerOn(null, "zhipu"), true);
  assert.equal(page.providerOn(["antigravity"], "zhipu"), false);
  assert.equal(page.modelProvider("cpa/gone", ["ao:claude-code"]), "cpa", "a saved model no longer listed still has a provider to show");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/SubagentsSurface.tsx"), "utf8");
  assert.match(source, /aria-label=\{`\$\{label\} provider`\}/, "each model field starts with its provider");
  assert.match(source, /providers\.filter\(item => providerOn\(allowed, item\.key\)\)|known\.filter\(item => providerOn\(allowed, item\.key\)\)/, "a provider that is off is not offered");
  assert.match(source, /allowedProviders: toggleProvider\(allowed, item\.key, on, /, "the switches save the allowed list");
});

test("edits on the Subagents page survive leaving the page and coming back before saving", () => {
  // The page stays mounted and reloads the saved config on every visit; that reload replaced the
  // draft, so a renamed subagent or a changed limit was silently dropped by visiting another page.
  const page = load("SubagentsSurface.tsx", { "./AgentOrchestratorSurface": {}, "./AgentOrchestratorRoleEditor": roles });
  const saved = { settings: { enabled: true, maxConcurrent: 3, maxPerChat: 3, timeoutMinutes: 30, permission: "auto", releaseWhenDone: true, defaultRoute: null },
    agents: [{ id: "explorer", name: "Explorer", enabled: true, description: "", instructions: "", route: null }] };
  const edited = { ...saved, agents: [{ ...saved.agents[0], name: "Scout", route: { harness_id: "ao:codex", model: "cpa/m1" } }] };
  assert.equal(page.keptDraft(edited, saved, structuredClone(saved)), edited, "unsaved edits are kept");
  const changed = { ...saved, settings: { ...saved.settings, maxConcurrent: 5 } };
  const untouched = page.keptDraft(structuredClone(saved), saved, changed);
  assert.deepEqual(untouched, changed, "an untouched draft follows what was loaded");
  assert.notEqual(untouched, changed, "as its own copy");
  assert.deepEqual(page.keptDraft(null, null, saved), saved, "the first load");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/SubagentsSurface.tsx"), "utf8");
  assert.match(source, /setDraft\(current => keptDraft\(current, previous, config\)\)/, "the page's reload goes through it");
});

test("the Subagents page saves each change by itself, and keeps edits made while a save was on its way", () => {
  // Reported 2026-10-22: a change made without pressing Save was not saved.
  const page = load("SubagentsSurface.tsx", { "./AgentOrchestratorSurface": {}, "./AgentOrchestratorRoleEditor": roles });
  const sent = { settings: { enabled: true, maxConcurrent: 50, maxPerChat: 3, timeoutMinutes: 30, permission: "auto", releaseWhenDone: true, defaultRoute: null },
    agents: [{ id: "explorer", name: "Explorer", enabled: true, description: "", instructions: "", route: null }] };
  const kept = { ...sent, settings: { ...sent.settings, maxConcurrent: 50 } };
  const after = page.draftAfterSave(structuredClone(sent), sent, kept);
  assert.deepEqual(after, kept, "nothing edited meanwhile: the draft is what was saved");
  assert.notEqual(after, kept, "as its own copy");
  const typedOn = { ...sent, agents: [{ ...sent.agents[0], name: "Explorer 2" }] };
  assert.equal(page.draftAfterSave(typedOn, sent, kept), typedOn, "an edit made while saving is kept for the next save");
  assert.ok(page.AUTOSAVE_MS > 0 && page.AUTOSAVE_MS <= 1500, "a moment after the last edit");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/SubagentsSurface.tsx"), "utf8");
  assert.match(source, /window\.setTimeout\(\(\) => void save\(sent\), AUTOSAVE_MS\)/, "a change schedules its own save");
  assert.match(source, /failedDraft\.current === JSON\.stringify\(draft\)/, "a draft that failed to save is not resent in a loop");
  assert.doesNotMatch(source, />\{busy \? "Saving…" : "Save"\}</, "no Save button to forget");
  // The banner and the save bar line up with the page's column.
  const css = fs.readFileSync(path.resolve(__dirname, "../src/features/subagents.css"), "utf8");
  assert.doesNotMatch(css, /\.sa-notice, \.sa-warning \{ margin: /, "a shorthand margin reset the column's auto side margins");
  assert.match(css, /\.sa-savebar \{[^}]*padding: 12px max\(32px, calc\(\(100% - 820px\) \/ 2\)\)/);
});

test("an answer citing an annotation (Codex's :codex-annotation directive) shows its number as a badge, never the raw directive", () => {
  const html = renderToStaticMarkup(React.createElement(markdown.ChatMarkdown, { text: 'Both gates matter :codex-annotation{index="1"} and the installer waits :codex-annotation{index="2"}.' }));
  assert.match(html, /<span class="cx-annotation-ref" title="Your annotation 1">1<\/span>/);
  assert.match(html, /<span class="cx-annotation-ref" title="Your annotation 2">2<\/span>/);
  assert.doesNotMatch(html, /codex-annotation\{/);
});
test("archived chats sit in a folder per project, in the list's order, and chats with no project folder under Chats", () => {
  const list = load("ChatThreadList.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMenu": menu, "./chat-list-settings": load("chat-list-settings.ts") });
  const workspaces = [{ id: "macro", name: "clash of clan macro", path: "F:\\clash of clan macro" }, { id: "scratch", name: "Scratch" },
    { id: "tools", name: "coding-tools-mcp", path: "G:\\Projects\\coding-tools-mcp" }];
  const chats = [
    { workspaceId: "tools", taskId: "a", title: "Fix update bugs", visibility: "archived" },
    { workspaceId: "scratch", taskId: "b", title: "Quick question", visibility: "archived" },
    { workspaceId: "macro", taskId: "c", title: "Eros account", visibility: "archived" },
    { workspaceId: "gone", taskId: "d", title: "From a removed project", visibility: "archived" },
  ];
  const groups = JSON.parse(JSON.stringify(list.archivedGroups(chats, workspaces)));
  assert.deepEqual(groups.map((group) => [group.name, group.project, group.chats.map((item) => item.taskId)]), [
    ["clash of clan macro", true, ["c"]],
    ["coding-tools-mcp", true, ["a"]],
    ["Chats", false, ["b", "d"]],
  ], "a project with no folder, or one no longer listed, has its chats under Chats");
});

test("the pet is Claude Code's Clawd: the CLI's glyphs, poses and frame-by-frame animations", () => {
  // The banner pose: " ▐▛███▛█", "▝▜██████▀", " ▝▝   ▝▝ " with the eyes the quadrants the "▛"s leave open.
  const cells = clawd.clawdCells("default");
  const row = (r) => cells.filter((cell) => cell.row === r).map((cell) => cell.glyph).join("");
  assert.equal(row(0), "▐▛███▛█");
  assert.equal(row(1), "▝▜██████▀");
  assert.equal(row(2), "▝▝▝▝");
  const eyes = cells.filter((cell) => cell.row === 0 && cell.glyph === "▛");
  assert.deepEqual(JSON.parse(JSON.stringify(eyes.map((cell) => [cell.col, cell.background]))), [[2, "#000000"], [6, "#000000"]], "the eyes show the CLI's clawd_background");
  assert.ok(cells.every((cell) => cell.color === "#d77757" || cell.color === "#000000"), "the CLI's clawd_body orange");
  // Closed eyes are lids: the background drawn as a lower-quarter bar over the body colour.
  const lids = clawd.clawdCells({ eyes: "closed", arms: "down", feet: "both" }).filter((cell) => cell.glyph === "▂");
  assert.deepEqual(JSON.parse(JSON.stringify(lids.map((cell) => [cell.col, cell.color, cell.background]))), [[2, "#000000", "#d77757"], [6, "#000000", "#d77757"]]);
  // The CLI's animation lengths at 60 ms a frame, and a click picks only those that start in place.
  const lengths = Object.fromEntries(Object.entries(clawd.ANIMATIONS).map(([name, frames]) => [name, frames.length]));
  assert.deepEqual(lengths, { jump: 12, look: 11, celebrate: 15, skip: 14, spin: 10, peekaboo: 21, drop: 13, waddle: 19, peek: 20,
    wink: 6, boop: 11, tap: 14, sneeze: 12, turn: 19, "coin-hop": 14,
    // Its own extras (2026-11-12), built from the CLI's parts; the CLI's set above is unchanged.
    wave: 11, stretch: 14, yawn: 15, dance: 21, dizzy: 15, sad: 17, peer: 16 });
  assert.equal(clawd.FRAME_MS, 60);
  assert.deepEqual(JSON.parse(JSON.stringify(clawd.CLICKABLE)), ["jump", "look", "spin", "peekaboo", "drop", "wink", "boop", "tap", "sneeze", "turn", "coin-hop"]);
  // The pet draws it in its 72×48 clipping box.
  const html = renderToStaticMarkup(React.createElement(pet.ChatPet, { mood: "idle", context: null, onHide: () => {} }));
  assert.match(html, /class="cx-clawd" style="width:72px;height:48px"/);
  assert.match(html, /<svg class="cx-clawd-glyphs" viewBox="0 0 18 12" width="72" height="48"/);
});

test("Clawd holds its tool up in the hand on the tool's side, never an empty raised arm or a tool by its feet", () => {
  // The user (2026-10-30): one Clawd "watching its watch", one "playing fireworks". The right arm went
  // up whatever side the tool was on while the tool stood by its feet, with no tool it "typed" in the
  // air, and the mug's steam and a ✦ rising from every hammer blow looked like fireworks.
  const stand = { look: 0, arms: "down", walking: false, sit: false };
  const frame = (job, toolSide, step = false, mood = "working") => pet.restFrame({ mood, asleep: false, step, pose: stand, blink: false, job, toolSide });
  for (const job of ["search", "build", "coffee", "read", "cook", "snack"]) {
    for (const step of [false, true]) {
      assert.equal(frame(job, "right", step).pose.arms, "one-up", `${job}: the right hand, on the tool's side`);
      assert.equal(frame(job, "left", step).pose.arms, "left-up", `${job}: the left hand, on the tool's side`);
    }
  }
  for (const step of [false, true]) assert.equal(frame("none", "right", step).pose.arms, "down", "working with no tool: no air typing");
  assert.ok("facing" in frame("laptop", "left").pose, "at the laptop it turns to face it");
  // The left arm raised as the CLI raises it: "▗▟" in the top row, its right arm down.
  const left = clawd.clawdCells({ eyes: "open", arms: "left-up", feet: "both" });
  assert.equal(left.filter((cell) => cell.row === 0 && cell.col < 2).map((cell) => cell.glyph).join(""), "▗▟");
  assert.equal(left.filter((cell) => cell.row === 1 && cell.col >= 7).map((cell) => cell.glyph).join(""), "█▀");
  assert.equal(frame("serve", "left").pose.arms, "up", "its plate is carried up in both hands");
  // Each held tool fills the cell its hand is in: column 0, row 2 of the prop's grid.
  for (const job of ["search", "build", "coffee", "read", "cook", "snack"]) {
    for (const step of [false, true]) {
      const svg = renderToStaticMarkup(React.createElement(pet.Prop, { job, step, tick: 1 }));
      const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
      assert.ok(rects.some(([x, y, w, h]) => x === 0 && y <= 2 && y + h > 2 && w >= 1), `${job}${step ? " (step)" : ""} is in its hand`);
      assert.ok(rects.every(([, y]) => y <= 6), `${job} stays inside the prop's grid`);
    }
  }
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  assert.doesNotMatch(source, /float\("✦"/, "no star rises from each hammer blow");
});

test("at home Clawd climbs into bed, cooks and eats, bathes and works, using the furniture where it stands", () => {
  // The user (2026-10-30): "the bed clawd can move/jump to it and sleep with it, cooking furniture that
  // let clawd to cook with eat". Full size Clawd was as tall as a storey and twice as wide as its bed.
  const { pathBeats, choreBeats, exitBeats, pickChore, ENTRY, LADDER_X, SPOTS, CHORES } = petHome;
  const bed = { ...SPOTS.sleep };
  // From bed to the tub upstairs: down off the bed, along to the ladder, up it, along to the tub.
  const toTub = pathBeats(bed, SPOTS.bath);
  assert.equal(toTub.map((beat) => beat.doing).join(), "hop,walk,climb,walk");
  assert.equal(toTub[0].lift, 0);
  assert.deepEqual([toTub[2].x, toTub[2].storey], [LADDER_X, "up"]);
  assert.equal(toTub.at(-1).x, SPOTS.bath.x);
  // Bedtime ends tucked into bed, lifted onto the mattress; a nap is never left standing.
  const sleep = choreBeats("sleep", ENTRY);
  assert.equal(sleep.at(-1).doing, "sleep");
  assert.deepEqual([sleep.at(-1).x, sleep.at(-1).lift], [bed.x, bed.lift]);
  assert.equal(sleep.at(-2).doing, "hop", "it hops up into bed");
  // Cooking: at the stove, then the plate to the table, three bites, and down off the chair.
  const cook = choreBeats("cook", ENTRY);
  const doing = cook.map((beat) => beat.doing);
  assert.ok(doing.indexOf("cook") < doing.indexOf("serve") && doing.indexOf("serve") < doing.indexOf("eat"));
  assert.equal(cook.filter((beat) => beat.doing === "eat").map((beat) => beat.bites).join(), "3,2,1,0");
  assert.equal(cook.find((beat) => beat.doing === "cook").look, 1, "it faces the stove");
  // Every chore but sleep ends standing on a floor, ready for the next; leaving ends at the entry.
  for (const chore of CHORES.filter((name) => name !== "sleep")) {
    for (const from of [ENTRY, bed, { ...SPOTS.work }]) {
      const beats = choreBeats(chore, from);
      assert.equal(beats.at(-1).lift, 0, `${chore} from ${from.x}: back on the floor`);
      assert.ok(beats.every((beat) => beat.ms > 0), `${chore}: every beat takes time`);
      const out = exitBeats(beats.at(-1));
      const last = out.at(-1) ?? beats.at(-1);
      assert.deepEqual([last.x, last.storey, last.lift], [ENTRY.x, ENTRY.storey, 0], `${chore}: out by the entry`);
    }
  }
  // It picks its own chores while home, never bed (that is the nap's, or a click on the bed).
  for (let roll = 0; roll < 50; roll += 1) {
    const memory = { last: CHORES[roll % CHORES.length], sinceMeal: roll % 7, hour: roll % 24 };
    const next = pickChore(memory, () => (roll * 0.137) % 1);
    assert.ok(CHORES.includes(next) && next !== "sleep", `picked ${next}`);
  }
});

test("Clawd's cottage shows what it is doing inside, and in the peek every piece of furniture is a button that sends it there", () => {
  // The user (2026-11-10): "its house blocking the screen". The house is an 88 x 64 cottage beside the
  // box now; its rooms show only in the peek you open by clicking it.
  const cottage = (props) => renderToStaticMarkup(React.createElement(house.Cottage, { home: false, asleep: false, doing: null, open: false, peeking: false, onClick() {}, ...props }));
  assert.match(cottage({}), /<svg viewBox="0 0 22 8" width="88" height="64"/, "never taller than the box beside it");
  assert.match(cottage({}), /aria-label="Clawd&#x27;s house"/);
  assert.doesNotMatch(cottage({}), /cx-pet-cottage-smoke|cx-pet-house-z/);
  assert.match(cottage({ home: true, asleep: true }), /cx-pet-cottage-z/, "z's over the roof while it sleeps");
  assert.match(cottage({ home: true, doing: "cook" }), /cx-pet-cottage-smoke/, "smoke from the chimney while it cooks");
  assert.match(cottage({ open: true }), /fill="#2a1f18"/, "the dark doorway while it goes in or out");
  assert.match(cottage({ peeking: true }), /aria-expanded="true"/);
  const used = [];
  const front = renderToStaticMarkup(React.createElement(house.HouseFront, { home: true, asleep: false, doing: null, tick: 0, step: false, bites: 3, onUse: (chore) => used.push(chore) }));
  for (const piece of ["bed", "table", "stove", "fridge", "tub", "bookshelf", "desk", "window"]) {
    assert.match(front, new RegExp(`<button[^>]*aria-label="the ${piece}: Clawd`), `${piece} is clickable`);
  }
  const houseSource = fs.readFileSync(path.join(__dirname, "../src/features/chat-pet-house.tsx"), "utf8");
  assert.match(houseSource, /onClick=\{\(\) => onUse\(piece\.chore\)\}/);
  // Woken in bed by a click elsewhere, it gets up then and there (homeLife reads the ref right away).
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  const toFurniture = source.slice(source.indexOf("const toFurniture ="), source.indexOf("// Nothing running for a while"));
  assert.match(toFurniture, /asleepNow\.current = false; setAsleep\(false\)/);
  const css = fs.readFileSync(path.join(__dirname, "../src/features/codex-chat.css"), "utf8");
  assert.match(css, /\.cx-pet-peek-sprite \{[^}]*transform: scale\(\.5\);/, "half size inside, as big as its furniture");
  assert.match(css, /\.cx-pet-peek \{ position: fixed; z-index: 70;/, "the peek floats over the page, opened on demand");
});

test("the pet stays where it stands while the chat box grows and shrinks a line at a time", () => {
  // Its spot is how far along the box's top edge it stands: the box growing from its top as you type
  // carries it up with the edge. Only a narrower box moves it, to stay clear of the ends.
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  const measure = source.slice(source.indexOf("const measure = () =>"), source.indexOf("measure();"));
  assert.match(measure, /feet\.current\.x = clamp\(feet\.current\.x, WIDTH \/ 2, width - WIDTH \/ 2\);/);
  assert.doesNotMatch(measure, /feet\.current\.y/, "its feet stay on the top edge");
  // Where it was left is remembered as a share of the width, so a resized window keeps its place.
  assert.match(source, /localStorage\.setItem\(POSITION_KEY, \(feet\.current\.x \/ current\.width\)\.toFixed\(4\)\)/);
});

test("in split view the pet keeps to its box's top edge and leaps to another pane only when called", () => {
  // Seen 2026-10-24: in a pane the box's sides and bottom are a few px from the pane's edge, and
  // Clawd walked there sideways, half cut off; it also leapt off to visit so often it never napped.
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  const act = source.slice(source.indexOf("const act = () =>"), source.indexOf("const wander = () =>"));
  assert.doesNotMatch(act, /hop\(/, "no leap to another pane on a whim");
  assert.doesNotMatch(source, /\bonTop\(|\breanchor\(|\blaps?\b/, "no laps round the box: it lives on its top edge");
  const nextSpot = source.slice(source.indexOf("const nextSpot ="), source.indexOf("const act = () =>"));
  assert.match(nextSpot, /pickClear\(clearSpans\(length, blocked, width\)/, "its strolls go only where nothing is under it");
  assert.match(nextSpot, /\?\? leastCovered\(length, blocked, width, feet\.current\.x\)/, "or, with nowhere clear, where it covers least");
});

test("a reviewer keeps every earlier cycle, oldest first and folded, not only the last review", () => {
  const reviewer = { id: "rev", role: "reviewer", state: "pending", x: 0, history: [
    { answer: "Worker 1's listing is truncated.", verdict: "CHANGES_REQUIRED" },
    { error: "Browser is not ready; open Browser and check the ChatGPT session" },
    { answer: "Still truncated near the static directory.", verdict: "CHANGES_REQUIRED" }] };
  const all = JSON.parse(JSON.stringify(chat.earlierRounds(reviewer)));
  assert.deepEqual(all.map((round) => [round.label, round.verdict]),
    [["Cycle 1", "CHANGES_REQUIRED"], ["Cycle 2", "failed"], ["Cycle 3", "CHANGES_REQUIRED"]]);
  // The step's own text already shows the newest answered cycle ("Last review:"): it is not repeated.
  assert.deepEqual(chat.earlierRounds(reviewer, true).map((round) => round.label), ["Cycle 1", "Cycle 2"]);
  // A worker's retries are attempts.
  assert.equal(chat.earlierRounds({ ...reviewer, role: "worker" })[0].label, "Attempt 1");
  // A round that answered and then failed still shows as failed.
  assert.equal(chat.earlierRounds({ ...reviewer, history: [{ answer: "Half a review", error: "fetch failed" }] })[0].verdict, "failed");
  // A pending card whose only earlier rounds failed still shows, with them.
  const failedOnly = { ...reviewer, history: [{ error: "Browser is not ready" }] };
  const turn = chat.chatTurns([{ id: "r1", execution_mode: "team", nodes: [failedOnly] }], "Review it")[0];
  assert.equal(turn?.steps?.[0]?.earlier?.[0]?.verdict, "failed");
  // Each round is folded under its label and verdict.
  const html = renderToStaticMarkup(React.createElement(toolParts.EarlierRounds, { rounds: all }));
  assert.equal((html.match(/<details class="cx-step-round">/g) || []).length, 3);
  assert.doesNotMatch(html, /<details[^>]* open/, "folded by default");
  assert.match(html, /<summary><span>Cycle 1<\/span><span class="cx-step-round-verdict is-changes_required">CHANGES REQUIRED<\/span><\/summary>/);
});

test("a CPA model's spend comes from the accounts that served it: its exact id, else its name, else its provider", () => {
  const { servingAccounts } = load("cpa-usage.ts", { "../api/client": client });
  const account = (id, provider, models, requests = 5) => ({ id, label: id, provider, requests, models: models.map(model => ({ model })) });
  const key = account("anthropic-key", "claude", ["claude-opus-5-5", "claude-haiku-5-5"]);
  const opencode = account("opencode", "provider-manager", ["opencode-go/claude-haiku-5-5", "opencode-go/kimi-k3"]);
  const quiet = account("quiet-claude", "claude", ["claude-opus-5-5"], 0);
  const accounts = [key, opencode, quiet];
  // OpenCode Go reselling Haiku bills OpenCode Go, not the Anthropic key.
  assert.deepEqual(servingAccounts(accounts, "cpa/opencode-go/claude-haiku-5-5", "opencode-go").map(row => row.id), ["opencode"]);
  assert.deepEqual(servingAccounts(accounts, "cpa/claude-opus-5-5", "claude").map(row => row.id), ["anthropic-key"]);
  // CPA's own provider prefix on the chat's id still finds the key by the model's name.
  assert.deepEqual(servingAccounts(accounts, "cpa/claude/claude-opus-5-5", "claude").map(row => row.id), ["anthropic-key"]);
  // Too quiet to be among the busiest models: the provider's accounts that sent anything.
  assert.deepEqual(servingAccounts(accounts, "cpa/claude-sonnet-5-5", "claude").map(row => row.id), ["anthropic-key"]);
  assert.equal(servingAccounts(accounts, "cpa/step-5-preview", null).length, 0);
});

test("two subagent avatars never share a gradient id, so one on a hidden chat page can't blank another", () => {
  // #1252 named each avatar's gradient sa-0..27 by its look, so subagents with the same look shared an id. url(#sa-N)
  // finds the FIRST element with that id, and ChatPages keeps visited pages mounted in <section hidden>: in Electron 41
  // (2026-11-13) an avatar on chat page 2 drew blank when page 1's hidden one with the same look came first.
  const view = load("chat-subagents.tsx", { "./ao-chat": chat, "./AgentOrchestratorRoleEditor": roles });
  const avatar = (size) => React.createElement(view.SubagentAvatar, { seed: "sub-1", size });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement("section", { hidden: true }, avatar(24)), avatar(24), avatar(16)));
  const svgs = html.match(/<svg[\s\S]*?<\/svg>/g);
  assert.equal(svgs.length, 3);
  const ids = svgs.map((svg) => svg.match(/<linearGradient id="([^"]+)"/)[1]);
  assert.equal(new Set(ids).size, 3, `each avatar's gradient has its own id: ${ids.join(", ")}`);
  svgs.forEach((svg, index) => {
    const fills = [...svg.matchAll(/fill="url\(#([^)]+)\)"/g)].map((match) => match[1]);
    assert.ok(fills.length > 0 && fills.every((fill) => fill === ids[index]), `avatar ${index + 1} paints with its own gradient`);
    assert.match(ids[index], /^[\w-]+$/, "an id that url(#...) finds as written");
  });
  // The look still comes from the seed alone: one subagent keeps its avatar everywhere.
  const look = (svg) => svg.replace(/id="[^"]+"|url\(#[^)]+\)|width="\d+" height="\d+"/g, "");
  assert.equal(new Set(svgs.map(look)).size, 1, "same tints and petals at every size");
});
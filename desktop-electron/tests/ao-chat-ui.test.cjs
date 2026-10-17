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
const markdown = load("ChatMarkdown.tsx", { "./chat-markdown": load("chat-markdown.ts") });
const menu = load("ChatMenu.tsx");
const meter = load("ChatContextMeter.tsx", { "./ao-chat": chat, "./ChatMenu": menu, "./AgentOrchestratorRoleEditor": roles,
  "../api/client": { getCodingToolsClient: () => ({ apps: { call: async () => ({ result: { sessions: {} } }) } }) } });
const ui = load("AgentOrchestratorChat.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMarkdown": markdown, "./ChatMenu": menu,
  "./ChatContextMeter": meter,
  "./codex-prompts": load("codex-prompts.ts"),
  // The branch bar reads git asynchronously and renders nothing until then, as here; composer
  // controls and approval cards render only when a composer or an approval is passed.
  "./ChatBranchBar": { ChatBranchBar: () => null },
  "./AgentOrchestratorComposerControls": { AgentOrchestratorComposerControls: () => null },
  "./AgentOrchestratorApproval": { AgentOrchestratorApproval: () => null },
  // The side panel opens on demand; the chat only needs its auto-open hook to exist here.
  "./ChatWorkbench": { ChatWorkbench: () => null, useWorkbenchAutoOpen: () => {} },
  "./ChatThreadList": load("ChatThreadList.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMenu": menu }) });

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
  assert.match(html, /<h2[^>]*>New task<\/h2>/);
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


test("an open chat's composer carries the context meter; a new chat's does not", () => {
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "finished",
    route: { harness_id: "ao:claude-code", model: "m" }, receipt: { thread_id: "sess-1", answer: "ok" } }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [],
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const open = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props));
  assert.match(open, /class="cx-icon-button cx-context-meter is-unknown"[^>]*aria-label="The agent has not reported its context yet"/);
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

test("an AO agent's question shows as a card with its options, an Other box, and Send / Skip", () => {
  const approvalUi = load("AgentOrchestratorApproval.tsx", { "./ChatMarkdown": markdown });
  const question = { nodeId: "one", approval_id: "ask", source: "ao", kind: "question", message: "Please answer the following questions.",
    fields: [
      { key: "question_0", type: "choice", title: "Lockfile", description: "Rewrite the lockfile hosts or regenerate it?", customKey: "question_0_custom",
        options: [{ value: "Rewrite hosts", label: "Rewrite hosts", description: "Keep every pinned version" }, { value: "Regenerate", label: "Regenerate", description: "" }] },
      { key: "question_1", type: "multi", title: "Backend", description: "", options: [{ value: "fastapi", label: "fastapi", description: "" }] },
    ] };
  const html = renderToStaticMarkup(React.createElement(approvalUi.AgentOrchestratorApproval, { approval: question, busy: false, approve() {} }));
  assert.match(html, /Question from the agent/);
  assert.match(html, /Rewrite the lockfile hosts or regenerate it\?/);
  assert.match(html, /type="radio"[^>]*name="ask-question_0"/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /Keep every pinned version/);
  assert.match(html, /placeholder="Other: type your own answer"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Send answer<\/button>/, "nothing chosen yet");
  assert.match(html, />Skip<\/button>/);
});
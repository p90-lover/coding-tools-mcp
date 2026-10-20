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
const client = { getCodingToolsClient: () => ({ apps: { call: async () => ({ result: { sessions: {} } }) } }) };
const meter = load("ChatContextMeter.tsx", { "./ao-chat": chat, "./ChatMenu": menu, "./AgentOrchestratorRoleEditor": roles,
  "../api/client": client, "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }) });
const ui = load("AgentOrchestratorChat.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null, Caret: () => null }, "./ChatMarkdown": markdown, "./ChatMenu": menu,
  "./ChatContextMeter": meter,
  "./ChatPet": load("ChatPet.tsx", { "./ao-chat": chat }),
  "./ChatTurnStats": load("ChatTurnStats.tsx", { "./ao-chat": chat, "../api/client": client }),
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

test("the side panel opens on an Overview of the chat: environment, context, changes, background tasks and usage", () => {
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null }, "./ao-chat": chat,
    "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }) });
  const html = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, {
    sessions: [{ id: "ao-1", label: "Claude Code", model: "cpa/cline-pass/glm-5.3-flash", contextWindow: 400000 }],
    tab: "overview", onTab: () => {}, onClose: () => {}, workspaceId: "ws" }));
  for (const heading of ["Environment", "Context", "Changes", "Background tasks", "Usage"]) assert.match(html, new RegExp(`<h4>${heading}`), heading);
  assert.match(html, /glm-5\.3-flash/, "the model by its own name");
  assert.match(html, /Today<\/button>/, "usage can switch between today, 7 and 30 days");
});

test("the Terminal pane opens for a server or a long run, never for a one-off tool call", () => {
  // Seen live: every `git status` and `ls` the agent ran opened the pane beside the chat.
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  const now = 1_000_000;
  const command = (cmd, extra = {}) => ({ id: "c", cmd, workdir: ".", startedAt: now - 2000, status: "running", exitCode: null, source: "agent", ...extra });
  assert.equal(workbench.opensTerminal(command("git status --short | head -80"), now), false, "a one-off call does not");
  assert.equal(workbench.opensTerminal(command("aiTemp\\run_app.cmd"), now), true, "the user's app launcher does");
  assert.equal(workbench.opensTerminal(command("npm run dev"), now), true, "a dev server does");
  assert.equal(workbench.opensTerminal(command("pytest -q", { status: "background", background: true }), now), true, "one left in the background does");
  assert.equal(workbench.opensTerminal(command("pytest -q", { startedAt: now - 61_000 }), now), true, "anything still running after a minute does");
  assert.equal(workbench.opensTerminal(command("npm run dev", { status: "exited", exitCode: 0 }), now), false, "an ended command never does");
});

test("an agent's new page brings the Preview pane forward, even over the Terminal its dev server opened", () => {
  // Seen live: the agent started its dev server (the Terminal opened), then preview_open'd the page,
  // and the panel stayed on the Terminal: the user never saw the browser.
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000"], false), "preview", "a closed panel opens on the page");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "cmd:c1"], true), "preview", "an open one switches to it");
  assert.equal(workbench.autoOpenTab(["cmd:c1"], false), "terminal", "a command opens a closed panel on the Terminal");
  assert.equal(workbench.autoOpenTab(["cmd:c1"], true), null, "but never takes the place of what the user looks at");
  assert.equal(workbench.autoOpenTab([], false), null);
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
  assert.equal(page.match(/<HarnessPicker\b[^>]*\bagentsOnly\b/g)?.length, 2, "both pickers on the page (default model and each subagent's)");
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
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
const toolParts = load("ChatToolParts.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown });
const dsh = load("DshTranscript.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown, "./ChatToolParts": toolParts });
const ui = load("AgentOrchestratorChat.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null, Caret: () => null }, "./ChatMarkdown": markdown, "./ChatMenu": menu,
  "./ChatContextMeter": meter, "./DshTranscript": dsh, "./ChatToolParts": toolParts,
  "./ChatPet": load("ChatPet.tsx", { "./ao-chat": chat }),
  "./ChatTurnStats": load("ChatTurnStats.tsx", { "./ao-chat": chat, "../api/client": client }),
  "./codex-prompts": load("codex-prompts.ts"),
  // The branch bar reads git asynchronously and renders nothing until then, as here; composer
  // controls and approval cards render only when a composer or an approval is passed.
  "./ChatBranchBar": { ChatBranchBar: () => null },
  // Annotations are the real module: with no transcript mounted (server render) the selection bar draws nothing.
  "./ChatAnnotations": load("ChatAnnotations.tsx", { "./ao-chat": chat }),
  "./AgentOrchestratorComposerControls": { AgentOrchestratorComposerControls: () => null },
  "./AgentOrchestratorApproval": { AgentOrchestratorApproval: () => null },
  // The side panel opens on demand; the chat only needs its auto-open hook to exist here.
  "./ChatWorkbench": { ChatWorkbench: () => null, useWorkbenchAutoOpen: () => {} },
  "./ChatThreadList": load("ChatThreadList.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMenu": menu }) });

test("a DeepSeek turn renders as DeepSeek Harness's: flat rows and Deep diving while it runs, Completed once it ends", () => {
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
  assert.match(running, /dsh-title">Think<\/span><span class="dsh-sep"[^>]*><\/span><span class="dsh-summary">Let me check health\.<\/span>/, "a Think row with its first line, ** dropped");
  assert.match(running, />Bash<\/span><span class="dsh-sep"[^>]*><\/span><span class="dsh-summary">Check backend health</, "a Bash row with the agent's words");
  assert.match(running, />Edit<\/span>.*src\/_recovery_state\.py.*\+28<\/span> <span class="is-del">-0</, "an Edit row with its path and totals");
  assert.match(running, /dsh-row-text dsh-shimmer"><span class="dsh-title">Read<\/span>.*README\.md/, "the running call shimmers");
  assert.match(running, /Deep diving for 1m [45]s ···/, "the running status, with its clock");
  assert.doesNotMatch(running, /dsh-group-title|dsh-turn-process/, "a running turn stays flat, without a Completed header");
  // The same turn, seen ending: it took 1m 4s. A turn ended before the chat saw it says only "Completed".
  const settled = (key) => ({ ...turn, key, status: "done", steps: [{ ...step, state: "finished", working: undefined, hasWork: true }] });
  const doneWork = () => timeline.map((item) => ({ ...item, status: "completed" }));
  const done = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: settled("k"), live: false, expanded: true, useWork: doneWork }));
  assert.match(done, /dsh-turn-process-label">Completed in <span class="dsh-num">1m [45]s<\/span>/, "a turn seen ending is headed with its time");
  assert.match(done, /dsh-group-label">Ran commands, edited files, read files</, "its work grouped under the kinds it did");
  assert.doesNotMatch(done, /Deep diving/);
  const earlier = renderToStaticMarkup(React.createElement(dsh.DshTurnWork, { turn: settled("older"), live: false, expanded: false, useWork: doneWork }));
  assert.match(earlier, /dsh-turn-process-label">Completed<\/span>/, "an earlier turn says Completed");
  assert.doesNotMatch(earlier, /dsh-group/, "and stays folded until opened");
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

test("an AO agent's question and tool request show as Codex's cards: numbered options to pick, then Submit", () => {
  const approvalUi = load("AgentOrchestratorApproval.tsx", { "./ChatMarkdown": markdown });
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
  assert.match(ask, /<pre>\$env:PYTHONUTF8=&#x27;1&#x27;/);
  assert.match(ask, /<span>Reason<\/span><p>Parse recent refresh and recovery task results/);
  assert.match(ask, /<span>Reviewer<\/span><p>Inspect the complete native command yourself/);
  assert.deepEqual([...ask.matchAll(/class="cdx-option-label">([^<]+)</g)].map((match) => match[1]), ["Allow once", "Allow this conversation", "Deny"], "Codex's words");
  assert.match(ask, /<button[^>]*disabled=""[^>]*>Submit <kbd class="cdx-kbd">Enter<\/kbd><\/button>/, "nothing picked yet");
  assert.match(ask, />Deny <kbd class="cdx-kbd">Esc<\/kbd><\/button>/);
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
    "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }) });
  const html = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, {
    sessions: [{ id: "ao-1", label: "Claude Code", model: "cpa/cline-pass/glm-5.3-flash", contextWindow: 400000 }],
    tab: "overview", onTab: () => {}, onClose: () => {}, workspaceId: "ws" }));
  for (const heading of ["Environment", "Context", "Changes", "Background tasks", "Usage"]) assert.match(html, new RegExp(`<h4>${heading}`), heading);
  assert.match(html, /glm-5\.3-flash/, "the model by its own name");
  assert.match(html, /Today<\/button>/, "usage can switch between today, 7 and 30 days");
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

test("an agent's new page brings the Preview pane forward, even over the Terminal its dev server opened", () => {
  // Seen live: the agent started its dev server (the Terminal opened), then preview_open'd the page,
  // and the panel stayed on the Terminal: the user never saw the browser.
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000"], false), "preview", "a closed panel opens on the page");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "cmd:c1"], true), "preview", "an open one switches to it");
  assert.equal(workbench.autoOpenTab(["cmd:c1"], false), "terminal", "a command opens a closed panel on the Terminal");
  assert.equal(workbench.autoOpenTab(["cmd:c1"], true), null, "but never takes the place of what the user looks at");
  assert.equal(workbench.autoOpenTab([], false), null);
  // The agent asked to show a pane (show_in_chat): that pane, even over what the user looks at.
  assert.equal(workbench.autoOpenTab(["show:show-1:terminal"], true), "terminal");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "show:show-2:terminal"], false), "terminal", "an explicit request wins");
  assert.equal(workbench.autoOpenTab(["show:show-3:preview"], true), "preview");
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

test("an answer citing an annotation (Codex's :codex-annotation directive) shows its number as a badge, never the raw directive", () => {
  const html = renderToStaticMarkup(React.createElement(markdown.ChatMarkdown, { text: 'Both gates matter :codex-annotation{index="1"} and the installer waits :codex-annotation{index="2"}.' }));
  assert.match(html, /<span class="cx-annotation-ref" title="Your annotation 1">1<\/span>/);
  assert.match(html, /<span class="cx-annotation-ref" title="Your annotation 2">2<\/span>/);
  assert.doesNotMatch(html, /codex-annotation\{/);
});
test("archived chats sit in a folder per project, in the list's order, and chats with no project folder under Chats", () => {
  const list = load("ChatThreadList.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMenu": menu });
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

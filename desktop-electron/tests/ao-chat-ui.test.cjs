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
const roles = load("AgentOrchestratorRoleEditor.tsx", { "./ao-chat": chat, "./model-scores": load("model-scores.ts") });
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
const meter = load("ChatContextMeter.tsx", { "./ao-chat": chat, "./ChatMenu": menu, "./AgentOrchestratorRoleEditor": roles,
  "../api/client": client, "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }) });
const toolParts = load("ChatToolParts.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown });
const dsh = load("DshTranscript.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown, "./ChatToolParts": toolParts });
const clawd = load("Clawd.tsx");
const petHome = load("chat-pet-home.ts");
const pet = load("ChatPet.tsx", { "./ao-chat": chat, "./Clawd": clawd, "./chat-pet-stage": load("chat-pet-stage.ts"), "./chat-pet-home": petHome });
const judges = load("ModelJudgesToggle.tsx", { "../api/client": client });
const ui = load("AgentOrchestratorChat.tsx", { "./ao-chat": chat, "./ModelJudgesToggle": judges, "../icons": { Icon: () => null, Caret: () => null }, "./ChatMarkdown": markdown, "./ChatMenu": menu,
  "./ChatContextMeter": meter, "./DshTranscript": dsh, "./ChatToolParts": toolParts,
  "./ChatPet": pet, "../PartErrorBoundary": load("../PartErrorBoundary.tsx"),
  "./ChatTurnStats": load("ChatTurnStats.tsx", { "./ao-chat": chat, "../api/client": client }),
  "./codex-prompts": load("codex-prompts.ts"),
  // The branch bar reads git asynchronously and renders nothing until then, as here; composer
  // controls and approval cards render only when a composer or an approval is passed.
  "./ChatBranchBar": { ChatBranchBar: () => null },
  "./HarnessLogo": { ModelLogo: () => null },
  "./AgentOrchestratorRoleEditor": roles,
  "./ChatReplyHead": load("ChatReplyHead.tsx", { "./ao-chat": chat, "./HarnessLogo": { ModelLogo: () => null } }),
  "./ChatReplyPlan": load("ChatReplyPlan.tsx"),
  "./chat-reply-plan": load("chat-reply-plan.ts", { "./ao-chat": chat }),
  // Annotations are the real module: with no transcript mounted (server render) the selection bar draws nothing.
  "./ChatAnnotations": load("ChatAnnotations.tsx", { "./ao-chat": chat }),
  "./AgentOrchestratorComposerControls": { AgentOrchestratorComposerControls: () => null },
  "./AgentOrchestratorApproval": { AgentOrchestratorApproval: () => null },
  // The side panel opens on demand; the chat only needs its auto-open hook to exist here.
  "./ChatWorkbench": { ChatWorkbench: () => null, useWorkbenchAutoOpen: () => {}, useChatSubagents: () => [], useChatProcesses: () => [], chatProcessRows: () => [] },
  "./ComputerControlCard": { ComputerControlCard: () => null, useComputerRequests: () => [], chatComputerRequests: () => [] },
  "./ChatThreadList": load("ChatThreadList.tsx", { "./ao-chat": chat, "../icons": { Icon: () => null }, "./ChatMenu": menu }) });

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
});

test("a reply's head says who answered, how it stands, why it failed, a team's cards and the files it changed", () => {
  const head = load("ChatReplyHead.tsx", { "./ao-chat": chat, "./HarnessLogo": { ModelLogo: () => null } });
  const edit = (path, additions, deletions) => ({ id: `${path}${additions}`, kind: "edit", status: "completed", text: "", files: [{ path, additions, deletions }] });
  // Seven one-line edits of one file read as that file once, with their lines summed.
  const changes = head.turnChanges([edit("src/aistudio.js", 1, 1), { id: "c", kind: "command", status: "completed", text: "npm test" },
    edit("src/aistudio.js", 4, 2), edit("tests/aistudio.test.cjs", 2, 0)]);
  assert.equal(JSON.stringify(changes.map((file) => [file.path, file.additions, file.deletions]).sort()),
    JSON.stringify([["src/aistudio.js", 5, 3], ["tests/aistudio.test.cjs", 2, 0]]));
  const single = renderToStaticMarkup(React.createElement(head.ReplyHead, { team: false, name: "GPT-6.1 Sol", tone: "failed",
    startedAtMs: 1_000, endedAtMs: 155_000, error: { step: "GPT-6.1 Sol", message: "API Error: 400 unknown provider" }, members: [], changes }));
  assert.match(single, /cx-reply-who-name">GPT-6\.1 Sol</);
  assert.match(single, /cx-reply-status is-failed">Failed</);
  assert.match(single, /cx-reply-time[^>]*>2m 34s</, "how long it ran");
  assert.match(single, /role="alert".*API Error: 400 unknown provider/, "the error leads the reply");
  assert.match(single, /2 files <span class="cx-reply-diff"><span class="is-add">\+7<\/span> <span class="is-del">−3<\/span>/, "the turn's total change");
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

test("a tool call that timed out is a red line in a running chat, not the failed-step card", () => {
  const props = { runs: [{ id: "run", project_id: "task", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "running" }] }],
    tasks: [{ id: "task", title: "Task" }], selectedTaskId: "task", busy: false, approvals: [], working: true,
    loadDescription: async () => "", send: async () => {}, openStructure() {}, approve() {}, describeRoute: () => "", retryStart() {} };
  const warning = "A tool call timed out (Headless request timed out). The chat keeps going by itself.";
  const html = renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, { ...props, warning }));
  assert.match(html, /<p class="cx-step-error cx-timeout-line" role="status">A tool call timed out \(Headless request timed out\)\. The chat keeps going by itself\.<\/p>/);
  assert.equal(html.includes("Step failed"), false, "nothing waits for a click");
  assert.equal(renderToStaticMarkup(React.createElement(ui.AgentOrchestratorChat, props)).includes("cx-timeout-line"), false);
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
  assert.match(html, /<details class="cx-tool cx-edit tone-ok"><summary>.*app\.ts.*<\/summary><\/details>/, "the row and its counts show, folded");
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
    "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }) });
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
  const all = [run("s1", "ao-1", "completed", { report: "Found it" }), run("s2", "ao-other", "running"), run("s3", "ao-1", "running"),
    run("s4", "ao-2", "starting", { name: "Reviewer" })];
  const own = chat.chatSubagents(all, ["ao-1", "ao-2"]);
  assert.deepEqual(own.map((item) => item.subagent_id), ["s4", "s3", "s1"], "another chat's are left out; working ones first, newest first");
  assert.equal(chat.subagentTitle(own[1]), "Explorer · Find the autoplay gate s3", "named by its job");
  assert.equal(chat.subagentTitle({ name: "Explorer", task: "x".repeat(80) }).length, "Explorer · ".length + 48, "a long task is shortened");
  assert.equal(chat.subagentsSummary(own), "2 subagents working: Reviewer and Explorer");
  assert.equal(chat.subagentsSummary([own[2]]), "1 subagent finished");
  assert.equal(chat.subagentsSummary([]), null);

  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null }, "./ao-chat": chat,
    "./ChatMarkdown": markdown, "./cpa-usage": load("cpa-usage.ts", { "../api/client": client }) });
  const props = { sessions: [{ id: "ao-1", label: "Claude Code" }], onTab: () => {}, onClose: () => {}, workspaceId: "ws", subagents: own };
  const overview = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, { ...props, tab: "overview" }));
  assert.match(overview, /<h4>Subagents<small>2 working<\/small>/, "the Overview lists them");
  const tab = renderToStaticMarkup(React.createElement(workbench.ChatWorkbench, { ...props, tab: "subagents" }));
  assert.match(tab, />Subagents<\/button>/, "a Subagents tab");
  assert.match(tab, /class="is-starting".*Reviewer · Find the autoplay gate s4.*Starting · 1m/, "each with its state and how long it has run");
  assert.match(tab, /class="is-completed".*Done · 1m/);
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

test("an agent's new page brings the Preview pane forward, even over the Terminal its dev server opened", () => {
  // Seen live: the agent started its dev server (the Terminal opened), then preview_open'd the page,
  // and the panel stayed on the Terminal: the user never saw the browser.
  const workbench = load("ChatWorkbench.tsx", { "../api/client": client, "../icons": { Icon: () => null } });
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000"], false), "preview", "a closed panel opens on the page");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "cmd:c1"], true), "preview", "an open one switches to it");
  // The Terminal never pops up by itself: running commands are listed in the chat details' Processes.
  assert.equal(workbench.autoOpenTab(["cmd:c1"], false), null, "a command leaves a closed panel closed");
  assert.equal(workbench.autoOpenTab(["cmd:c1"], true), null, "and an open one as it is");
  assert.equal(workbench.autoOpenTab([], false), null);
  assert.equal(workbench.autoOpenTab(["show:show-1:terminal"], true), null, "not even on the agent's show_in_chat");
  assert.equal(workbench.autoOpenTab(["page:ao-1:http://localhost:8000", "show:show-2:terminal"], false), "preview", "its page still shows");
  assert.equal(workbench.autoOpenTab(["show:show-3:preview"], true), "preview", "as does a preview it asks to show");
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
    wink: 6, boop: 11, tap: 14, sneeze: 12, turn: 19, "coin-hop": 14 });
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

test("the house shows what Clawd is doing in it, and every piece of furniture is a button that sends it there", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  for (const piece of ["bed", "table", "stove", "fridge", "tub", "bookshelf", "desk", "window"]) {
    assert.match(source, new RegExp(`label: "the ${piece}: Clawd`), `${piece} is clickable`);
  }
  assert.match(source, /onClick=\{\(\) => onUse\(piece\.chore\)\}/);
  // Woken in bed by a click elsewhere, it gets up then and there (homeLife reads the ref right away).
  const toFurniture = source.slice(source.indexOf("const toFurniture ="), source.indexOf("// Nothing running for a while"));
  assert.match(toFurniture, /asleepNow\.current = false; setAsleep\(false\)/);
  const css = fs.readFileSync(path.join(__dirname, "../src/features/codex-chat.css"), "utf8");
  assert.match(css, /\.cx-pet\.is-home \.cx-pet-body \{ transform: scale\(\.5\);/, "half size at home, as big as its furniture");
});

test("the pet stays where it stands while the chat box grows and shrinks a line at a time", () => {
  const box = (width, height) => ({ width, height, length: 2 * (width + height), beside: true });
  const short = box(740, 87), tall = box(740, 159);
  // Four laps backwards round (it never wraps), on the right side 30 px above the bottom: the box
  // growing from its top keeps it 30 px above the bottom, on the right side, on the same lap.
  const right = -4 * short.length + 740 + 57;
  const grown = pet.reanchor(short, tall, right);
  assert.equal(Math.floor(grown / tall.length), -4, "same lap, so it never spins round");
  assert.equal(grown - -4 * tall.length, 740 + 129, "right side, 30 px above the bottom");
  // On the top edge it keeps its distance from the left corner and rides the edge up.
  assert.equal(pet.reanchor(short, tall, 2 * short.length + 500), 2 * tall.length + 500);
  // On the bottom it keeps its distance from the left; on the left side, its height above the bottom.
  assert.equal(pet.reanchor(short, tall, 740 + 87 + 100), 740 + 159 + 100);
  assert.equal(pet.reanchor(short, tall, 2 * 740 + 87 + 20), 2 * 740 + 159 + 20);
  // Shrinking back puts it where it was.
  assert.equal(pet.reanchor(tall, short, grown), right);
});

test("in split view the pet keeps to its box's top edge and leaps to another pane only when called", () => {
  // Seen 2026-10-24: in a pane the box's sides and bottom are a few px from the pane's edge, and
  // Clawd walked there sideways, half cut off; it also leapt off to visit so often it never napped.
  const box = { width: 500, height: 60, length: 1120, beside: false };
  assert.equal(pet.onTop(box, 200), 200, "on the top edge it stays put");
  assert.equal(pet.onTop(box, 10), 36, "clear of the left end (half its 72 px width)");
  assert.equal(pet.onTop(box, 495), 464, "clear of the right end");
  assert.equal(pet.onTop(box, 520), 464, "off the right side: up to its top corner");
  assert.equal(pet.onTop(box, 500 + 60 + 100), 464, "underneath, right half: the right corner");
  assert.equal(pet.onTop(box, 2 * 500 + 60 + 30), 1120 + 36, "off the left side: on to the next lap's left end");
  assert.equal(pet.onTop(box, -1120 + 200), -920, "on the lap it is on, so it never spins round");
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  const act = source.slice(source.indexOf("const act = () =>"), source.indexOf("const wander = () =>"));
  assert.doesNotMatch(act, /hop\(/, "no leap to another pane on a whim");
  assert.match(source, /const spot = split \|\| working \? onTop\(current, target\) : target;/, "its strolls stay on the top edge");
});

test("a walking pet reads no layout per frame and is redrawn at most 60 times a second", () => {
  // Seen 2026-10-23 on a 165 Hz screen: each walk step set the pet's spot and then read the box's
  // rect, a forced layout every frame (1,917 layouts and 3,933 style recalcs in 20 s).
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  const walk = source.slice(source.indexOf("const walkTo ="), source.indexOf("const nextSpot ="));
  const step = walk.slice(walk.indexOf("const frame = (now: number)"));
  assert.match(walk, /const box = composer\.current\?\.getBoundingClientRect\(\);[\s\S]*const frame = \(now: number\)/, "the box is read once, before the walk");
  assert.doesNotMatch(step, /getBoundingClientRect|obstacles\(\)/, "no layout read inside a step");
  assert.match(step, /blocked\(atNow\.current, rects, box\)/);
  assert.match(step, /if \(arrived \|\| now - shown >= 1000 \/ WALK_FPS\) \{ shown = now; setAt\(atNow\.current\); \}/);
  assert.match(source, /const WALK_FPS = 60;/);
  // Asking for a frame every refresh costs one even when nothing draws: the step waits out its interval.
  assert.match(step, /const wait = shown \+ 1000 \/ WALK_FPS - now;[\s\S]*walkTimer\.current = window\.setTimeout\(/);
  assert.match(source, /const stopWalking = \(\) => \{[\s\S]*?window\.clearTimeout\(walkTimer\.current\);/, "stopping cancels a waiting step too");
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

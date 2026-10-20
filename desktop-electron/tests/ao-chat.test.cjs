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

test("a DeepSeek model's work is grouped and worded as DeepSeek Harness does it", () => {
  const item = (kind, extra = {}) => ({ id: `${kind}${Math.random()}`, kind, status: "completed", text: "", ...extra });
  assert.equal(chat.isDeepSeekModel("cpa/cline-pass/deepseek-v4.1-flash"), true);
  assert.equal(chat.isDeepSeekModel("cpa/cline-pass/glm-5.3-flash"), false);
  // step-process.ts: the top three kinds by number of calls, ties by first appearance, no counts.
  const read = item("tool", { text: "mcp__coding-tools__read_file" });
  assert.equal(chat.dshProcessTitle([read, item("command"), item("command"), item("reasoning")]), "Ran commands and read files", "most calls first, thinking left out");
  assert.equal(chat.dshProcessTitle([read, item("tool", { label: "Grep" }), item("command")]), "Read files, searched code, ran commands", "a tie keeps first appearance");
  assert.equal(chat.dshProcessTitle([read, item("tool", { label: "Grep" }), item("command"), item("edit")]), "Read files, searched code, ran commands, etc.", "past three kinds");
  assert.equal(chat.dshProcessTitle([item("reasoning")]), "Analysis completed", "thinking alone");
  assert.equal(chat.dshProcessTitle([item("command"), item("command"), item("command"), read, read]), "Ran commands and read files",
    "a repeated call counts each time (each call is its own row now)");
  // process-activity.ts: the app's MCP tools land in DeepSeek Harness's own kinds.
  assert.equal(chat.dshActivity(item("tool", { text: "mcp__coding-tools__exec_command" })), "commands");
  assert.equal(chat.dshActivity(item("tool", { text: "mcp__coding-tools__list_dir" })), "search");
  assert.equal(chat.dshActivity(item("tool", { text: "mcp__coding-tools__apply_patch" })), "edit");
  assert.equal(chat.dshActivity(item("tool", { text: "mcp__coding-tools__browser_open" })), "tools");
  // ui-tool's row titles.
  assert.equal(chat.dshToolTitle(item("command", { text: "npm test" })), "Bash");
  assert.equal(chat.dshToolTitle(read), "Read");
  assert.equal(chat.dshToolTitle(item("tool", { text: "mcp__coding-tools__exec_command" })), "Bash");
  assert.equal(chat.dshToolTitle(item("tool", { text: "web_fetch" })), "Fetch");
  assert.equal(chat.dshToolTitle(item("tool", { text: "mcp__coding-tools__browser_open" })), "Tool call");
  // A row's detail: the agent's own words, else the command, path or query from its arguments.
  assert.equal(chat.dshItemDetail(item("command", { text: "npm test", description: "Check backend health" })), "Check backend health");
  assert.equal(chat.dshItemDetail(item("tool", { text: "read_file", input: JSON.stringify({ path: "src/app.ts" }) })), "src/app.ts");
  assert.equal(chat.dshItemDetail(item("command", { text: "x".repeat(400) })).length, 160, "bounded to 160 characters");
});

test("a sent message splits back into its text and its attachments, for cards and thumbnails", () => {
  const sent = chat.chatMessageWithAttachments("look at this", [
    { name: "image-de5e4a0a.png", image: true, path: "G:\\AppData\\Coding Tools\\chat-attachments\\2026-10-20\\image-de5e4a0a.png" },
    { name: "notes.txt", text: "a\n```\nb" },
    { name: "spec.pdf", path: "C:/docs/spec.pdf" },
  ]);
  const parts = chat.chatMessageParts(sent);
  assert.equal(parts.text, "look at this");
  // Inline text files come first (read before the path lines), then the files sent by path, in order.
  assert.deepEqual(plain(parts.attachments), [
    { image: false, name: "notes.txt" },
    { image: true, name: "image-de5e4a0a.png", path: "G:\\AppData\\Coding Tools\\chat-attachments\\2026-10-20\\image-de5e4a0a.png" },
    { image: false, name: "spec.pdf", path: "C:/docs/spec.pdf" },
  ]);
  assert.deepEqual(plain(chat.chatMessageParts("Attached image: C:\\a.png")), { text: "", attachments: [{ image: true, name: "a.png", path: "C:\\a.png" }] });
  assert.deepEqual(plain(chat.chatMessageParts("I said Attached image: inline")), { text: "I said Attached image: inline", attachments: [] }, "only a line of its own");
});

test("annotations go out in Codex's format and come back as a chip, with the message and attachments intact", () => {
  const annotations = [{ text: "checking the overlap and merge gates", comment: "why both gates?" }, { text: "rebuild the installer", comment: "" }];
  const sent = chat.chatMessageWithAnnotations(chat.chatMessageWithAttachments("look at these", [{ name: "a.png", image: true, path: "C:\\a.png" }]), annotations);
  assert.match(sent, /^# Response annotations:\n/, "Codex's heading leads, as its prompt builder writes it");
  assert.match(sent, /`:codex-annotation\{index="N"\}`/, "the agent is asked to cite each one by number");
  const block = /<response-annotations>\n(.*)\n<\/response-annotations>/.exec(sent);
  assert.deepEqual(JSON.parse(block[1]), [
    { text: "checking the overlap and merge gates", annotation: "why both gates?", source: "chat-response" },
    { text: "rebuild the installer", annotation: "", source: "chat-response" },
  ]);
  const parts = plain(chat.chatMessageParts(sent));
  assert.equal(parts.text, "look at these");
  assert.deepEqual(parts.annotations, annotations);
  assert.deepEqual(parts.attachments, [{ image: true, name: "a.png", path: "C:\\a.png" }]);
  assert.equal(chat.chatMessageWithAnnotations("plain", []), "plain", "no annotations, no block");
  assert.equal(chat.chatMessageParts("# Response annotations:\nnot ours").text, "# Response annotations:\nnot ours", "text that only looks like one stays as written");
});

test("copying, exporting or rewinding an annotated message gives readable quotes, not the agent's block", () => {
  const sent = chat.chatMessageWithAnnotations("look at these", [{ text: "merge   gates", comment: "why both?" }, { text: "the installer", comment: "" }]);
  assert.equal(chat.chatMessageReadable(sent), 'Annotations:\n1. "merge gates" — why both?\n2. "the installer"\n\nlook at these');
  assert.equal(chat.chatMessageReadable("plain"), "plain");
  const turns = [{ user: { text: sent }, steps: [], final: null }];
  assert.doesNotMatch(chat.chatMarkdown("Chat", turns), /response-annotations|codex-annotation/, "the exported conversation reads as the person wrote it");
});

test("queued annotated messages join into one block numbered across both, and a join past the limit stays two messages", () => {
  const first = chat.chatMessageWithAnnotations("first", [{ text: "a", comment: "one" }]);
  const second = chat.chatMessageWithAnnotations("second", [{ text: "b", comment: "" }, { text: "c", comment: "three" }]);
  const queue = chat.chatQueueAdd([{ what: "Message", message: first }], { what: "Message", message: second });
  assert.equal(queue.length, 1);
  assert.equal((queue[0].message.match(/# Response annotations:/g) ?? []).length, 1, "one block, not two each counting from 1");
  const parts = plain(chat.chatMessageParts(queue[0].message));
  assert.deepEqual(parts.annotations, [{ text: "a", comment: "one" }, { text: "b", comment: "" }, { text: "c", comment: "three" }]);
  assert.equal(parts.text, "first\n\nsecond");
  const big = "x".repeat(6000);
  const apart = chat.chatQueueAdd([{ what: "Message", message: big }], { what: "Message", message: big });
  assert.equal(apart.length, 2, "two messages that together pass 8,192 characters are sent one after the other");
});

test("a DeepSeek turn's live heading, Think line and durations read as DeepSeek Harness's", () => {
  const item = (kind, extra = {}) => ({ id: `${kind}${Math.random()}`, kind, status: "completed", text: "", ...extra });
  assert.equal(chat.dshLiveTitle([item("reasoning", { text: "x" }), item("command", { status: "running", text: "npm test" })]).label, "Running commands · npm test");
  assert.equal(chat.dshLiveTitle([item("command"), item("reasoning", { text: "First idea.\n\n**Second** idea" })]).label,
    "Analyzing the request · Second idea", "no call running: the latest thought's last paragraph, ** dropped");
  // ReasoningRow.tsx: settled, the first line; streaming, the newest completed paragraph's first line.
  assert.equal(chat.dshThinkSummary("**Checking health**\nmore", false), "Checking health");
  assert.equal(chat.dshThinkSummary("Let me check health.\nok\n\nNow the configs\nstill typing", true), "Now the configs");
  assert.equal(chat.dshThinkSummary("Still on the first line", true), "", "nothing until a line completes");
  // formatRunDuration: "4s", "1m 4s", "1h 0m 4s", never under a second.
  assert.equal(chat.dshDuration(400), "1s");
  assert.equal(chat.dshDuration(64_000), "1m 4s");
  assert.equal(chat.dshDuration(3_604_000), "1h 0m 4s");
  // process-groups.ts: thinking and calls run together; a reply or a steered message stands alone.
  const segments = chat.dshSegments([item("reasoning"), item("command"), item("message"), item("edit"), item("steer"), item("tool")]);
  assert.deepEqual(plain(segments.map((segment) => segment.kind === "group" ? `group:${segment.items.length}` : segment.item.kind)),
    ["group:2", "message", "group:1", "steer", "group:1"]);
});

test("the stats line counts the latest turn and the failed or stopped attempts right before it, on every model they used", () => {
  // Seen live: a message stopped on deepseek-v4.1-flash and sent again on -1017 showed only the new run's time.
  const card = (state, model, started) => node("p", "planner", state, { route: { harness_id: "ao:claude-code", model }, receipt: { started_at_ms: started } });
  const runs = [
    run("r1", "t", [card("finished", "cpa/glm", 100)], { execution_mode: "single" }),
    run("r2", "t", [card("failed", "cpa/cline-pass/deepseek-v4.1-flash", 200)], { execution_mode: "single" }),
    run("r3", "t", [card("running", "cpa/cline-pass/deepseek-v4.1-flash-1017", 300)], { execution_mode: "single" }),
  ];
  const turns = chat.chatTurns(runs, "first\n\nFollow-up (x):\nsecond\n\nFollow-up (y):\nthird");
  const span = plain(chat.chatStatsSpan(turns, runs));
  assert.equal(span.from, 200, "counted from the failed attempt, not the finished turn before it");
  assert.deepEqual(span.models.sort(), ["cpa/cline-pass/deepseek-v4.1-flash", "cpa/cline-pass/deepseek-v4.1-flash-1017"]);
  const settled = [runs[0], run("r4", "t", [card("running", "cpa/glm", 400)], { execution_mode: "single" })];
  assert.equal(chat.chatStatsSpan(chat.chatTurns(settled, "a\n\nFollow-up (x):\nb"), settled).from, 400, "after a finished turn, only the new one");
  assert.deepEqual(plain(chat.chatStatsSpan([], [])), { models: [] });
});

test("a chat the app restart left behind resumes when its project opens, single or team, within its budget", () => {
  const restarted = { error: "The agent's process ended before it finished (the app restarted); retry this card." };
  const single = (card, extra = {}) => run("r", "t", [card], { execution_mode: "single", ...extra });
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted }))), "retry");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: { error: "API Error: 503" } }))), null, "a real failure waits");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted }), { cancelled: true })), null, "a stopped chat stays stopped");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted }), { paused: true })), null);
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted, history: [{}, {}] }))), null, "attempts used up");
  assert.equal(chat.restartResume(single(node("p", "planner", "finished"))), null, "a finished chat stays finished");
  assert.equal(chat.restartResume(single(node("p", "planner", "pending"))), "continue", "a chat whose step never started");
  // Seen live: after a restart a team's workers finished on hosts that outlived the app, and its
  // reviewer never started. Teams now resume too; their own loop recovers interrupted workers.
  const team = (cards) => run("r", "t", cards, { execution_mode: "team" });
  assert.equal(chat.restartResume(team([node("p", "planner", "finished"), node("w", "worker", "finished"), node("v", "reviewer", "pending")])), "continue");
  assert.equal(chat.restartResume(team([node("p", "planner", "finished"), node("w", "worker", "running"), node("v", "reviewer", "pending")])), "continue");
  assert.equal(chat.restartResume(team([node("p", "planner", "finished"), node("w", "worker", "held", { receipt: restarted })])), "retry");
  assert.equal(chat.restartResume(team([node("p", "planner", "finished"), node("v", "reviewer", "held", { receipt: { error: "needs you" } }), node("w", "worker", "pending")])), null,
    "a card held for the person keeps the team waiting");
  assert.equal(chat.restartResume(team([node("p", "planner", "reserved"), node("w", "worker", "pending")])), null, "a card mid-launch");
});

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
    createContext: value => ({ Provider: ({ children }) => children, value }), useContext: context => context.value,
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
      selectedTaskId: "task-a", draft: "sent text", attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
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

test("opening a project resumes a team whose loop died with the app, once per session", async () => {
  // Seen live: after a restart the team's workers had finished but its reviewer never started,
  // and re-entering the project did not rerun the chat.
  const mission = { id: "r", workspace_id: "a", execution_mode: "team", cancelled: false, nodes: [
    { id: "p", role: "planner", state: "finished" }, { id: "w", role: "worker", state: "finished" }, { id: "v", role: "reviewer", state: "pending" }] };
  const calls = [];
  const context = {
    workspaceId: "a", mounted: { current: true }, missions: [mission], settledRuns: { current: new Set() }, resumedRuns: { current: new Set() },
    selection: { current: { workspaceId: "a" } }, restartResume: chat.restartResume, executableArg: () => ({}),
    moduleCall: async (operation, args) => {
      calls.push(operation);
      if (operation === "run_status") return { driven: false, status: "idle" };
      if (operation === "runs") return { runs: [mission] };
      return { ok: true };
    },
    loadMissions: async () => {}, setTimeout,
  };
  const settle = rendererCallback("AgentOrchestratorSurface.tsx", "effect:settledRuns.current.add(key)", context);
  settle(); for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
  assert.deepEqual(calls, ["run_status", "runs", "start_run"]);
  context.settledRuns.current.clear();
  settle(); for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
  assert.equal(calls.filter((call) => call === "start_run").length, 1, "resumed once per app session");
  // A loop in this session already starting it is left alone.
  const fresh = { ...context, settledRuns: { current: new Set() }, resumedRuns: { current: new Set() }, moduleCall: async (operation) => {
    calls.push(`fresh:${operation}`); return operation === "run_status" ? { driven: false, status: "starting" } : { runs: [mission] };
  } };
  rendererCallback("AgentOrchestratorSurface.tsx", "effect:settledRuns.current.add(key)", fresh)();
  for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
  assert.deepEqual(calls.filter((call) => call.startsWith("fresh:")), ["fresh:run_status"]);
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

test("a turn's activity drops answered approvals, keeps every tool call, and folds runs of calls and thinking", () => {
  const items = [
    { id: "1", kind: "reasoning", status: "completed", text: "Let me wait for the tests" },
    { id: "2", kind: "tool", status: "completed", label: "MCP", text: "mcp__coding-tools__read_output" },
    { id: "3", kind: "approval", status: "completed", text: "mcp__coding-tools__read_output" },
    { id: "4", kind: "tool", status: "completed", label: "MCP", text: "mcp__coding-tools__read_output" },
    { id: "5", kind: "approval", status: "completed", text: "mcp__coding-tools__read_output" },
    { id: "6", kind: "tool", status: "running", label: "MCP", text: "mcp__coding-tools__read_output" },
    { id: "7", kind: "approval", status: "rejected", text: "git push" },
    { id: "8", kind: "approval", status: "completed", label: "Approval timed out", text: "Nobody answered" },
    { id: "9", kind: "command", status: "completed", text: "npm test" },
    { id: "10", kind: "message", status: "completed", text: "Tests pass." },
    { id: "11", kind: "edit", status: "completed", text: "a.ts", files: [] },
  ];
  const tidy = chat.tidyTimeline(items);
  assert.deepEqual([...tidy.map((item) => item.id)], ["1", "2", "4", "6", "7", "8", "9", "10", "11"],
    "answered approvals drop; a denied or timed-out one stays; each read_output call keeps its own row");
  const segments = chat.groupTimeline(tidy);
  assert.deepEqual([...segments.map((segment) => segment.kind === "group" ? `group:${segment.items.length}` : segment.item.id)],
    ["group:4", "7", "8", "group:1", "10", "11"]);
  assert.equal(chat.activitySummary(segments[0].items), "read_output ×3 · 1 thought", "the folded line still tallies them");
  const ls = { id: "c", kind: "command", status: "completed", text: "ls" };
  assert.equal(chat.activitySummary([ls, { ...ls, id: "d" }]), "Ran 2 commands");
});

test("an answered request is no row of its own: its answer shows on the call it let run", () => {
  const tidy = chat.tidyTimeline([
    { id: "1", kind: "command", status: "completed", text: "python diag.py" },
    { id: "2", kind: "approval", status: "completed", text: "PowerShell", approval: "Allowed by the reviewer: reads the project's own database" },
    { id: "3", kind: "tool", status: "completed", label: "MCP", text: "exec_command" },
    { id: "4", kind: "approval", status: "completed", text: "exec_command", approval: "Allowed by Approve for me" },
    { id: "5", kind: "approval", status: "rejected", text: "git push", approval: "Denied by the reviewer: pushes" },
    { id: "6", kind: "approval", status: "pending", text: "rm -rf", approval: "Allowed" },
  ]);
  assert.deepEqual([...tidy.map((item) => [item.id, item.approval ?? null])], [
    ["1", "Allowed by the reviewer: reads the project's own database"], ["3", "Allowed by Approve for me"],
    ["5", "Denied by the reviewer: pushes"]], "allowed answers fold into their calls; a denial keeps its row; a pending one waits");
});

test("an edit's diff is numbered from its hunk header, old lines on the left and new on the right", () => {
  const rows = (diff) => [...chat.numberedDiff(diff).map((line) => [line.kind, line.old ?? null, line.new ?? null, line.text])];
  assert.deepEqual(rows("@@ -98,4 +98,4 @@\n line 97\n-line 98\n+changed 98\n line 99\n line 100"), [
    ["ctx", 98, 98, "line 97"], ["del", 99, null, "line 98"], ["add", null, 99, "changed 98"], ["ctx", 100, 100, "line 99"], ["ctx", 101, 101, "line 100"]]);
  assert.deepEqual(rows("--- a.py\n+++ a.py\n@@ -0,0 +1,2 @@\n+one\n+two"), [["add", null, 1, "one"], ["add", null, 2, "two"]],
    "a new file counts from line 1 and its file header is left out");
  assert.deepEqual(rows("-old\n+new"), [["del", null, null, "old"], ["add", null, null, "new"]], "a snippet edit has no place to number from");
  assert.deepEqual(rows("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d").map((row) => row[0]), ["del", "add", "hunk", "del", "add"],
    "a later hunk shows as a separator");
});

test("Approve for me keeps a command's card off the screen while it is answered, never a question's", () => {
  const auto = { approval_policy: "on-request", approvals_reviewer: "auto_review" };
  assert.equal(chat.approvalAnsweredForYou({ kind: "command" }, auto, 1000), true);
  assert.equal(chat.approvalAnsweredForYou({ kind: "permission" }, { approval_policy: "never" }, 1000), true, "full access too");
  assert.equal(chat.approvalAnsweredForYou({ kind: "question" }, auto, 1000), false, "a question is the person's");
  assert.equal(chat.approvalAnsweredForYou({ kind: "plan" }, auto, 1000), false, "so is a plan");
  assert.equal(chat.approvalAnsweredForYou({ kind: "command" }, auto, chat.SELF_ANSWER_GRACE_MS), false, "one still waiting after the grace shows");
  assert.equal(chat.approvalAnsweredForYou({ kind: "command" }, { approval_policy: "on-request" }, 1000), false, "Ask me always shows");
  assert.equal(chat.approvalAnsweredForYou({ kind: "command" }, auto, 1000, true), false, "a team's Command approver decides, so its card shows");
  assert.equal(chat.approvalAnsweredForYou({ kind: "command", recommendation: { action: "ask" } }, auto, 1000), false,
    "a request the reviewer left at ask is the person's and shows at once");
});

test("a refresh that found nothing new keeps the runs and activity objects already held", () => {
  const run = (id, revision, state = "running") => ({ id, revision, cancelled: false, nodes: [{ id: "n", state }] });
  const held = [run("a", 3), run("b", 7)];
  assert.equal(chat.keepRevisions(held, [run("a", 3), run("b", 7)]), held, "same revisions and states: the same array");
  const moved = chat.keepRevisions(held, [run("a", 4), run("b", 7)]);
  assert.notEqual(moved, held);
  assert.equal(moved[1], held[1], "an unchanged run keeps its object");
  assert.equal(moved[0].revision, 4, "a new revision comes through");
  assert.notEqual(chat.keepRevisions(held, [run("a", 3, "finished"), run("b", 7)])[0], held[0], "a card that moved without a new revision still shows");

  const item = (id, text, status = "completed") => ({ id, kind: "message", status, text });
  const frames = { "r:n": { activity: "working", timeline: [item("1", "hello"), item("2", "wor", "running")] } };
  const copy = JSON.parse(JSON.stringify(frames));
  assert.equal(chat.mergeActivityFrames(frames, copy), frames, "an IPC copy of the same frame keeps the held map");
  const grown = chat.mergeActivityFrames(frames, { "r:n": { activity: "working", timeline: [item("1", "hello"), item("2", "world", "running")] } });
  assert.notEqual(grown, frames);
  assert.equal(grown["r:n"].timeline[0], frames["r:n"].timeline[0], "the unchanged item keeps its object, so its row skips");
  assert.equal(grown["r:n"].timeline[1].text, "world", "the growing message comes through");
  assert.equal(chat.mergeActivityFrames(frames, {})["r:n"], undefined, "a card that stopped working drops out");
});

test("a card's timeline keeps the steps that fell out of the newest poll, and a new attempt starts over", () => {
  const item = (id) => ({ id, kind: "tool", status: "completed", text: `call ${id}` });
  const seen = [item("1"), item("2"), item("3")];
  const ids = (items) => [...items.map((entry) => entry.id)];
  assert.deepEqual(ids(chat.mergeTimeline(null, seen)), ["1", "2", "3"]);
  // The poll window moved on: 1 and 2 are no longer in it, 3 changed state and 4 is new.
  const later = chat.mergeTimeline(seen, [{ ...item("3"), status: "running" }, item("4")]);
  assert.deepEqual(ids(later), ["1", "2", "3", "4"]);
  assert.equal(later[2].status, "running", "an item still in the window takes its latest state");
  // A retry reuses the card's key; its first poll shares nothing with the old attempt.
  assert.deepEqual(ids(chat.mergeTimeline(later, [item("9")])), ["9"]);
});

test("a single-model chat's card is named by its model, a team's by its role", () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/cline-pass/deepseek-v4.1-flash" };
  const node = { id: "one", role: "planner", state: "running", x: 0, route, settings: { name: "Single assistant" } };
  const name = (mode) => chat.chatTurns([{ id: "r", project_id: "t", cancelled: false, execution_mode: mode, nodes: [node] }], "hi",
    { modelName: (model) => `Model<${model}>` })[0].steps[0].name;
  assert.equal(name("single"), "Model<cpa/cline-pass/deepseek-v4.1-flash>");
  assert.equal(name("team"), "Single assistant");
});

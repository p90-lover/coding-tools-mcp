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
  // process-activity.ts LIVE_TOOL_DETAIL_KEYS: title and description before the command or path.
  assert.equal(chat.dshItemDetail(item("tool", { text: "Task", input: JSON.stringify({ prompt: "Look around", description: "Survey the repo" }) })), "Survey the repo");
  assert.equal(chat.dshItemDetail(item("tool", { text: "update_goal", input: JSON.stringify({ objective: "Ship 0.9", status: "active" }) })), "Ship 0.9");
  assert.equal(chat.dshItemDetail(item("tool", { text: "web_search", input: JSON.stringify({ queries: ["dsh releases", "dsh changelog"] }) })), "dsh releases, dsh changelog", "a list of strings joined");
  assert.equal(chat.dshItemDetail(item("tool", { text: "ask_user_question", input: JSON.stringify({ questions: [{ header: "x" }, { question: "Which branch?" }] }) })), "Which branch?",
    "the first question asked");
  assert.equal(chat.dshItemDetail(item("tool", { text: "mcp__coding-tools__browser_open", input: JSON.stringify({ wait: true }) })), "browser_open", "no detail field: the tool's name");
  assert.equal(chat.dshCommandText(item("command", { text: "npm test", description: "Check tests" })), "npm test");
  assert.equal(chat.dshCommandText(item("tool", { text: "exec_command", input: JSON.stringify({ cmd: "npm test", description: "Check tests" }) })), "npm test");
  assert.equal(chat.dshCommandText(item("tool", { input: JSON.stringify({ command: "x".repeat(400), description: "Long command" }) })).length, 400);
  assert.equal(chat.dshCommandText(item("tool", { input: "raw command" })), "raw command");
  assert.equal(chat.dshCommandText(item("tool", { text: "exec_command", input: "null" })), "null");
  // terminalExitLabel: only a settled, failed command with a status it can read.
  assert.equal(chat.dshExitLabel(item("command", { status: "failed", output: "Exit code 2\nboom" })), "exit code 2", "Claude Code's status line");
  assert.equal(chat.dshExitLabel(item("tool", { status: "failed", text: "exec_command", output: "Exit code: 127\nWall time: 0.1 seconds" })), "exit code 127", "Codex's");
  assert.equal(chat.dshExitLabel(item("tool", { status: "failed", text: "exec_command", output: "Process exited with code 1" })), "exit code 1");
  assert.equal(chat.dshExitLabel(item("command", { status: "failed", output: "out\n[killed by signal: SIGTERM]" })), "signal SIGTERM");
  assert.equal(chat.dshExitLabel(item("command", { status: "failed", output: "out\n[exit code: null]" })), "no exit code");
  assert.equal(chat.dshExitLabel(item("command", { status: "failed", output: "spawn ENOENT" })), null, "no code invented");
  assert.equal(chat.dshExitLabel(item("command", { status: "completed", output: "Exit code 1" })), null, "only a failure");
  assert.equal(chat.dshExitLabel(item("tool", { status: "failed", text: "read_file", output: "Exit code 1" })), null, "only a command");
  // A closed group's icon is its most-called kind of work.
  assert.equal(chat.dshGroupActivity([read, item("command"), item("command")]), "commands");
  assert.equal(chat.dshGroupActivity([item("reasoning")]), "thinking");
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
  assert.equal(chat.dshLiveTitle([item("command"), item("reasoning", { status: "running", text: "First idea.\n\n**Second** idea" })]).label,
    "Analyzing the request · Second idea", "no call running: the streaming thought's last paragraph, ** dropped");
  assert.equal(chat.dshLiveTitle([item("command"), item("reasoning", { text: "A settled thought" })]).label, "Analyzing the request",
    "a settled thought adds nothing (liveReasoningDetail reads running reasoning only)");
  // A request nobody answered holds the turn; it said "Running commands" for 85 minutes.
  const waiting = chat.dshLiveTitle([item("command", { status: "running", text: "Invoke-RestMethod :7411" }), item("approval", { status: "pending", text: "PowerShell" })]);
  assert.deepEqual(plain(waiting), { activity: "questions", label: "Waiting for approval · Invoke-RestMethod :7411" });
  assert.equal(chat.dshLiveTitle([item("approval", { status: "resolved" }), item("command", { status: "running", text: "ls" })]).label, "Running commands · ls",
    "an answered request no longer holds it");
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

test("an ended turn keeps when its last card ended and the CPA models it ran on; a running one has no end", () => {
  const card = (id, state, model, started, finished) => node(id, id === "p" ? "planner" : "worker", state,
    { route: { harness_id: "ao:claude-code", model }, receipt: { started_at_ms: started, ...(finished ? { finished_at_ms: finished } : {}) } });
  const runs = [
    run("r1", "t", [card("p", "finished", "cpa/glm", 100, 400), card("w", "finished", "codex/gpt", 150, 900)]),
    run("r2", "t", [card("p", "finished", "cpa/glm", 1000, 1200), card("w", "running", "cpa/glm", 1300)]),
    run("r3", "t", [card("p", "finished", "cpa/glm", 2000)], { execution_mode: "single" }),
  ];
  const [done, working, older] = plain(chat.chatTurns(runs, "a\n\nFollow-up (x):\nb\n\nFollow-up (y):\nc"));
  assert.equal(done.endedAtMs, 900, "the last card's end, whichever card it was");
  assert.deepEqual(done.cpaModels, ["cpa/glm"], "only models that go through CPA");
  assert.equal(working.endedAtMs, undefined, "a card still running: the turn has not ended");
  assert.equal(older.endedAtMs, undefined, "saved before cards kept their end");
  assert.equal(older.steps.length + (older.final ? 1 : 0), 1);
});

test("a message no run answered shows as not sent, and every later run stays under its own message", () => {
  // Seen live 2026-10-23: the 07:41 "keep going" was saved, then its send timed out with no run. Paired
  // by place, each later reply sat under the message before its own and the newest read "Starting…".
  const at = (stamp) => Date.parse(`${stamp.replace(" ", "T")}:00Z`);
  const answered = (id, started, extra = {}) => run(id, "t", [node("p", "planner", "finished", { receipt: { started_at_ms: started, answer: id } })],
    { execution_mode: "single", ...extra });
  const description = ["open the browser", "\n\nFollow-up (2026-10-23 07:41 UTC):\nkeep going",
    "\n\nFollow-up (2026-10-23 07:53 UTC):\nkeep going again", "\n\nFollow-up (2026-10-23 10:11 UTC):\nkeep going to monitor it"].join("");
  const runs = [
    answered("first", at("2026-10-23 04:06")),
    answered("again", at("2026-10-23 07:53") + 57_000),
    answered("monitor", at("2026-10-23 10:11") + 39_000),
    // A restart answers its run's message again, whenever it started.
    run("retry", "t", [node("p", "planner", "running", { receipt: { started_at_ms: at("2026-10-23 23:14") }, history: [{ started_at_ms: at("2026-10-23 10:21") }] })],
      { execution_mode: "single", restarts_run_id: "monitor" }),
  ];
  const turns = plain(chat.chatTurns(runs, description));
  assert.deepEqual(turns.map(turn => [turn.runId, turn.user?.text ?? null, turn.unsent ?? false]), [
    ["first", "open the browser", false],
    ["", "keep going", true],
    ["again", "keep going again", false],
    ["monitor", "keep going to monitor it", false],
    ["retry", null, false],
  ]);
  assert.equal(turns.some(turn => turn.key.startsWith("pending:")), false, "no message is left waiting for a run");
  // Messages saved in the same minute stay paired by place: the stamps cannot tell them apart. Nor is
  // the first message (it has no stamp) ever skipped, even while the next one waits for its run.
  const sameMinute = plain(chat.chatTurns([answered("a", at("2026-10-23 10:10") + 5_000), answered("b", at("2026-10-23 10:11") + 2_000)],
    "a\n\nFollow-up (2026-10-23 10:11 UTC):\nb\n\nFollow-up (2026-10-23 10:11 UTC):\nc"));
  assert.deepEqual(sameMinute.map(turn => [turn.key, turn.user.text]), [["a", "a"], ["b", "b"], ["pending:2", "c"]]);
  const firstWaiting = plain(chat.chatTurns([answered("a", at("2026-10-23 10:11") + 5_000)], "a\n\nFollow-up (2026-10-23 10:11 UTC):\nb"));
  assert.deepEqual(firstWaiting.map(turn => [turn.key, turn.user.text]), [["a", "a"], ["pending:1", "b"]]);
  // Across a minute: B saved at 10:10:59, its run started at 10:11:01, C sent at 10:11:15 waits for its
  // run. C's stamp (10:11) is before B's start, but B's reply stays B's (review of #560).
  const boundary = plain(chat.chatTurns([answered("a", at("2026-10-23 10:00") + 5_000), answered("b", at("2026-10-23 10:11") + 1_000)],
    "a\n\nFollow-up (2026-10-23 10:10 UTC):\nb\n\nFollow-up (2026-10-23 10:11 UTC):\nc"));
  assert.deepEqual(boundary.map(turn => [turn.key, turn.user.text]), [["a", "a"], ["b", "b"], ["pending:2", "c"]]);
  // Yet a run that started after the next message's whole minute passed does skip, a minute apart or not.
  const late = plain(chat.chatTurns([answered("a", at("2026-10-23 10:00") + 5_000), answered("c", at("2026-10-23 10:12") + 1_000)],
    "a\n\nFollow-up (2026-10-23 10:10 UTC):\nb\n\nFollow-up (2026-10-23 10:11 UTC):\nc"));
  assert.deepEqual(late.map(turn => [turn.key, turn.user.text]), [["a", "a"], ["unsent:1", "b"], ["c", "c"]]);
  // A just-sent message waits for its run as before.
  const sent = plain(chat.chatTurns([answered("first", at("2026-10-23 04:06"))], "open the browser\n\nFollow-up (2026-10-23 04:30 UTC):\nnext"));
  assert.deepEqual(sent.map(turn => [turn.key, turn.status]), [["first", "done"], ["pending:1", "queued"]]);
});

test("a compacted chat pairs its newest messages with its newest runs", () => {
  // Seen live: a goal chat with 17 runs kept 4 messages after compacting; the person's new message
  // showed beside the 4th run, far up the chat, and the turn answering it showed none ("the message
  // doesnt sent to chat" while the goal was paused).
  const at = (stamp) => Date.parse(`${stamp.replace(" ", "T")}:00Z`);
  const answered = (id, started) => run(id, "t", [node("p", "planner", "finished", { receipt: { started_at_ms: started, answer: id } })], { execution_mode: "single" });
  const runs = ["r1", "r2", "r3", "r4"].map((id, index) => answered(id, at("2026-10-31 01:00") + index * 60_000));
  runs.push(answered("r5", at("2026-10-31 03:31") + 2_000));
  const description = "Summary of the earlier conversation (compacted 2026-10-31 03:30 UTC):\nwhat happened so far"
    + "\n\nFollow-up (2026-10-31 03:31 UTC):\none more thing";
  const turns = plain(chat.chatTurns(runs, description));
  assert.deepEqual(turns.map(turn => [turn.runId, turn.user?.text ?? null]), [
    ["r1", null], ["r2", null], ["r3", null],
    ["r4", "Summary of the earlier conversation (compacted 2026-10-31 03:30 UTC):\nwhat happened so far"],
    ["r5", "one more thing"],
  ]);
  assert.equal(turns.at(-1).messageIndex, 1, "the newest turn answers the newest message");
  // A restart still answers its run's message again, after the summarized runs.
  const restarted = plain(chat.chatTurns([...runs, run("again", "t", [node("p", "planner", "running")], { execution_mode: "single", restarts_run_id: "r5" })], description));
  assert.deepEqual(restarted.slice(-2).map(turn => [turn.runId, turn.user?.text ?? null]), [["r5", "one more thing"], ["again", null]]);
});

test("a chat the app restart left behind resumes when its project opens, single or team, within its budget", () => {
  const restarted = { error: "The agent's process ended before it finished (the app restarted); retry this card." };
  const single = (card, extra = {}) => run("r", "t", [card], { execution_mode: "single", ...extra });
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted }))), "retry");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: { error: "API Error: 503" } }))), null, "a real failure waits");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted }), { cancelled: true })), null, "a stopped chat stays stopped");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted }), { paused: true })), null);
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted, history: [{}, {}, {}] }))), "retry",
    "restarts are not the step's fault: within the main process's budget of eight attempts");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: restarted, history: Array.from({ length: 8 }, () => ({})) }))), null, "attempts used up");
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

test("with Retry automatically on, a single chat's failed step that nothing retried resumes, within the retry budget", () => {
  // Seen live: "Launch failed: The operation was aborted due to timeout" held a single chat for hours
  // with the switch on; its loop had ended and only a restart-interrupted step was ever resumed.
  const failed = (extra = {}) => node("p", "planner", "held", { receipt: { error: "Launch failed: The operation was aborted due to timeout" }, ...extra });
  const single = (card) => run("r", "t", [card], { execution_mode: "single" });
  const on = { autoRetry: true };
  assert.equal(chat.restartResume(single(failed()), Date.now()), null, "switch off: it waits for the person, as before");
  assert.equal(chat.restartResume(single(failed()), Date.now(), on), "retry");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: { error: "API Error: 400 This Go model requires Global regions" } })), Date.now(), on), null,
    "a request the provider refuses is refused again: it waits for the person");
  assert.equal(chat.restartResume(single(failed({ history: [{}, {}] })), Date.now(), on), "retry", "a third attempt");
  assert.equal(chat.restartResume(single(failed({ history: [{}, {}, {}] })), Date.now(), on), "retry", "a fourth attempt: three quick tries are not the end");
  assert.equal(chat.restartResume(single(failed({ history: Array.from({ length: 8 }, () => ({})) })), Date.now(), on), null, "eight attempts: the person decides");
  assert.equal(chat.restartResume(single(node("p", "planner", "held", { receipt: { error: "API error 401: auth_unavailable" } })), Date.now(), on), null,
    "a sign-in or account-pool failure is never retried by itself");
  assert.equal(chat.restartResume(run("r", "t", [failed()], { execution_mode: "single", paused: true }), Date.now(), on), null, "a paused chat stays paused");
  // A team's failed steps are its own loop's (and its helper's) call; a blanket retry would requeue
  // every card a review set aside.
  assert.equal(chat.restartResume(run("r", "t", [node("p", "planner", "finished"), node("w", "worker", "held", { receipt: { error: "timeout" } })],
    { execution_mode: "team" }), Date.now(), on), null);
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

test("a run being stopped reads as stopped at once; its working cards end, its finished ones keep their work", () => {
  const receipt = { thread_id: "s1", answer: "partial" };
  const live = run("r", "t", [node("p", "planner", "finished", { receipt }), node("w", "worker", "running", { receipt }),
    node("v", "reviewer", "pending"), node("h", "worker", "held")]);
  const stopping = chat.chatRunStopping(live);
  assert.equal(chat.chatRunStatus(stopping), "stopped");
  assert.deepEqual(stopping.nodes.map((item) => item.state), ["finished", "cancelled", "cancelled", "held"]);
  assert.deepEqual(stopping.nodes[1].receipt, receipt, "a stopped card keeps its receipt, so its work can still be opened");
  assert.equal(live.cancelled, false, "the run it was given is left as it was");
  assert.equal(live.nodes[1].state, "running");
});

test("a chat whose earlier run still works reads Running, though its newest run was stopped", () => {
  const stopped = run("r2", "a", [node("p", "planner", "failed")]);
  stopped.cancelled = true;
  const list = plain(chat.chatList([run("r1", "a", [node("p", "planner", "running")]), stopped], []));
  assert.equal(list[0].status, "running", "the green dot stays while the agent works");
  const done = run("r1", "a", [node("p", "planner", "finished")]);
  assert.equal(plain(chat.chatList([done, stopped], []))[0].status, "stopped", "nothing working: the newest run's state");
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
  assert.equal(transcript[2].detail, "cpa/gpt-6-luna · Auditor · running 2h 58m · running a command · last heard 30s ago");
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
  const replyHead = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ChatReplyHead.tsx"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { exports: replyHead, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "./ao-chat" ? chat : {} });
  const replyPlan = {};
  const replyPlanView = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/chat-reply-plan.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: replyPlan, require: name => name === "./ao-chat" ? chat : {} });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ChatReplyPlan.tsx"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { exports: replyPlanView, require: name => name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "Fragment" } : {} });
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: component, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "./ao-chat" ? chat
      : name === "./ChatReplyHead" ? replyHead
      : name === "./chat-reply-plan" ? replyPlan : name === "./ChatReplyPlan" ? replyPlanView
      : name === "./ChatWorkbench" ? { useWorkbenchAutoOpen() {}, useChatSubagents: () => [], useChatProcesses: () => [], chatProcessRows: () => [] }
      : name === "./ComputerControlCard" ? { ComputerControlCard: () => null, useComputerRequests: () => [], chatComputerRequests: () => [] }
      : name === "./ChatToolParts" ? { SentMessageView: react.createContext(null), Attachments: react.createContext({}),
        TurnRestart: react.createContext({ restarting: false }) } : {},
  });
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const base = { runs: [], tasks: [], selectedTaskId: "", busy: false, loadDescription: async () => "", send: async () => {}, openStructure() {}, approvals: [], approve() {}, describeRoute: () => "", retryStart() {} };
  const placeholder = extra => walk(component.AgentOrchestratorChat({ ...base, ...extra })).find(item => item.type === "textarea").props.placeholder;
  assert.equal(placeholder({ composer: { mode: "single" } }), "Do anything");
  assert.equal(placeholder({ composer: { mode: "team" } }), "Do anything");
  assert.equal(placeholder({ composer: { mode: "single" }, selectedTaskId: "task" }), "Send a follow-up…");
  assert.equal(placeholder({ composer: { mode: "single" }, selectedTaskId: "task", working: true,
    runs: [run("active", "task", [node("worker", "worker", "running")])] }), "Running. New messages send when it finishes");
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
    useCallback: callback => callback, useMemo: calculate => calculate(), useEffect() {}, useLayoutEffect() {},
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
    "./chat-split": feature("chat-split.ts"),
    "./page-visibility": { useSurfaceHidden: () => () => false, pageHidden: () => false, onAoPush: () => () => {} },
  };
  const surface = loadSurface(react,{ localStorage: { getItem: () => "w", setItem() {} }, structuredClone, crypto: globalThis.crypto }, imports);
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const render = () => { cursor = 0; refCursor = 0; return surface.AgentOrchestratorSurface({ language: "en", setError() {} }); };
  const currentChat = () => walk(render()).find(item => item.type === "Chat");
  return { state, calls, render, walk, currentChat };
}

test("split view: Split view adds a pane, New chat opens in the focused pane, the sidebar fills it, and closing the window's chat promotes the next", () => {
  const fixture = surfaceComposer({ chatTaskId: "t1" });
  const list = () => fixture.walk(fixture.render()).find(item => item.props?.actions?.openSplit);
  const panes = () => plain(fixture.state.splitPanes.map(item => [item.taskId, item.col, item.row]));
  assert.equal(fixture.currentChat().props.onClosePane, undefined, "one chat alone has no Close split view");

  list().props.actions.openSplit("w", "t2");
  assert.deepEqual(panes(), [["t2", 1, 0]], "Open in ▸ Split view: a column to the right");
  assert.equal(fixture.state.focusedPane, fixture.state.splitPanes[0].id, "and it is focused");
  list().props.actions.openSplit("w", "t1");
  assert.equal(fixture.state.focusedPane, "main", "a chat already open is focused, never opened twice");
  assert.deepEqual(plain(list().props.openTaskIds), ["t1", "t2"], "the sidebar offers no Split view for them");

  // The user's rule (2026-10-31, replacing "New chat opens one more pane"): New chat opens in the
  // focused pane, in place of its chat; it never adds a screen.
  fixture.state.focusedPane = fixture.state.splitPanes[0].id;
  list().props.actions.newChat();
  assert.deepEqual(panes(), [["", 1, 0]], "the focused pane shows a new chat; no pane is added");
  assert.equal(fixture.state.chatTaskId, "t1", "the window's own chat stays");
  const draft = fixture.state.splitPanes[0];
  assert.equal(fixture.state.focusedPane, draft.id);
  const host0 = fixture.walk(fixture.render()).find(item => Array.isArray(item.props?.panes));
  host0.props.panes[0].content.props.pane.onNewChat("w");
  assert.equal(fixture.state.splitPanes.length, 1, "a pane's own New chat stays in that pane");
  list().props.actions.select("t2");
  fixture.state.focusedPane = "main";
  list().props.actions.newChat();
  assert.equal(fixture.state.chatTaskId, "", "with the window's chat focused, New chat replaces that one");
  assert.deepEqual(panes(), [["t2", 1, 0]], "and the panes stay as they were");
  list().props.actions.select("t1");
  fixture.state.focusedPane = fixture.state.splitPanes[0].id;
  list().props.actions.newChat();

  // A sidebar click goes to the focused pane.
  list().props.actions.select("t3");
  assert.deepEqual(panes(), [["t3", 1, 0]]);
  assert.equal(list().props.selectedTaskId, "t3", "the sidebar marks the focused pane's chat");

  const host = fixture.walk(fixture.render()).find(item => Array.isArray(item.props?.panes));
  assert.deepEqual(plain(host.props.panes.map(item => [item.content.props.pane.workspaceId, item.content.props.pane.taskId])), [["w", "t3"]],
    "each pane is a Surface of its own, told which chat to show");
  assert.equal(typeof fixture.currentChat().props.onClosePane, "function", "while split the window's chat has Close split view too");

  // Closing the window's chat: the first pane with a chat, by column then row, takes its place.
  fixture.currentChat().props.onClosePane();
  assert.equal(fixture.state.chatTaskId, "t3");
  assert.deepEqual(panes(), []);
  list().props.actions.openSplit("w", "t2");
  fixture.walk(fixture.render()).find(item => Array.isArray(item.props?.panes)).props.panes[0].content.props.pane.onClose();
  assert.deepEqual(panes(), [], "closing the last pane leaves one chat");
});

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
  assert.match(chat.dependencyInstallNote("pnpm add zod", links).text, /only in this worktree/);
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

test("the details panel lists what the agents made as outputs and what they used as sources", () => {
  const { outputs, sources } = chat.chatDetailLinks([
    { id: "1", kind: "edit", status: "done", text: "src/app.ts", files: [{ path: "src/app.ts", additions: 3, deletions: 1 }] },
    { id: "2", kind: "tool", status: "done", label: "Fetch", text: "Fetch https://github.com/PastKing/tgbot-verify.", input: "{\"url\":\"https://github.com/PastKing/tgbot-verify\"}" },
    { id: "3", kind: "tool", status: "done", label: "MCP", text: "mcp__unified-agent-tools__search_web" },
    { id: "4", kind: "tool", status: "done", label: "Read", text: "mcp__acp__Read" },
    { id: "5", kind: "command", status: "done", text: "npm run dev", output: "  Local: http://127.0.0.1:8766/\n  docs: https://vite.dev/guide" },
    { id: "6", kind: "edit", status: "done", text: "out/hero.png", files: [{ path: "out\\hero.png", additions: 0, deletions: 0 }] },
    { id: "7", kind: "edit", status: "done", text: "src/app.ts", files: [{ path: "src/app.ts", additions: 1, deletions: 0 }] },
  ]);
  assert.deepEqual(plain(outputs.map((link) => [link.kind, link.label])), [["file", "app.ts"], ["image", "hero.png"], ["page", "127.0.0.1:8766"]],
    "newest first, a file edited twice once; a dev server's address is an output");
  assert.deepEqual(plain(sources.map((link) => [link.kind, link.label])), [["tool", "unified-agent-tools"], ["link", "github.com/PastKing/tgbot-verify"]],
    "the agent's own mcp__acp__ tools and a URL only printed in a command's output are not sources");
  assert.equal(sources[1].title, "https://github.com/PastKing/tgbot-verify", "trailing punctuation is not part of the link");
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
  // The chat splits these labels while rendering; a card saved with no name, role name or role
  // must still give a string, or the whole window unmounts.
  const nameless = chat.chatAgentSessions([{ nodes: [{ id: "x", route: { harness_id: "ao:claude-code" }, receipt: { thread_id: "s9" } }] }, { id: "r", nodes: undefined }]);
  assert.deepEqual(plain(nameless), [{ id: "s9", label: "Agent" }]);
  assert.equal(nameless[0].label.split(" · ")[0], "Agent");
});

test("native chat previews keep one owner across follow-ups and remain separate from AO workspaces", () => {
  const runs = ["first", "followup"].map(id => ({ id, execution_mode: "single", nodes: [{
    id: `node-${id}`, role: "worker", route: { harness_id: "codex-native", model: "chatgpt-web/high" },
    receipt: { thread_id: `thread-${id}` },
  }] }));
  assert.deepEqual(plain(chat.chatAgentSessions(runs)), [], "native threads do not become AO file/terminal sessions");
  const first = plain(chat.chatAgentSessions(runs, { workspaceId: "ws1", taskId: "task" }));
  assert.deepEqual(first, [{ id: "native:ws1:task:single", label: "worker · chatgpt-web/high", model: "chatgpt-web/high", previewOnly: true }]);
  assert.notEqual(chat.chatAgentSessions(runs, { workspaceId: "ws2", taskId: "task" })[0].id, first[0].id);
  assert.notEqual(chat.chatAgentSessions(runs, { workspaceId: "ws1", taskId: "other" })[0].id, first[0].id);
  const { nativeChatPreviewSessionId } = require("../electron/chat-agent-tools.cjs");
  const team = [{ execution_mode: "team", nodes: ["role:one", "role:two"].map(template_role_id => ({
    ...runs[0].nodes[0], template_role_id,
  })) }];
  const owners = chat.chatAgentSessions(team, { workspaceId: "ws:one", taskId: "task:one" }).map(item => item.id);
  assert.deepEqual(plain(owners), ["role:two", "role:one"].map(role => nativeChatPreviewSessionId("ws:one", "task:one", role)), "frontend and native launch use the same escaped role owner");
  const cpa = [{ ...runs[0], nodes: [{ ...runs[0].nodes[0], route: { harness_id: "codex-native", model: "gemini-3.8-flash-high" } }] }];
  assert.deepEqual(plain(chat.chatAgentSessions(cpa, { workspaceId: "ws1", taskId: "task" })), [], "unsupported CPA native previews keep their previous behavior");
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

test("an unsent split chat can switch projects and finish choosing its new chat", () => {
  const paneWanted = { current: { workspaceId: "old-project", taskId: "" } };
  const state = { workspaceId: "old-project", taskId: null };
  const pendingSelect = { current: null };
  const choose = rendererCallback("AgentOrchestratorSurface.tsx", "chooseWorkspace", {
    pane: { workspaceId: "old-project", taskId: "" }, paneWanted, pendingSelect,
    switchTarget: { current: "" },
    switchToWorkspace: id => { state.workspaceId = id; state.taskId = null; },
  });
  choose("new-project");
  const decide = rendererCallback("AgentOrchestratorSurface.tsx", "effect:const wanted = paneWanted.current", {
    chatTaskId: null, workspaceId: state.workspaceId, loadedWorkspace: "new-project",
    board: { tasks: [] }, boardWorkspace: { current: "new-project" }, paneWanted, pendingSelect,
    missions: [], taskLifecycle: [], chatSeed: { workspaceId: "new-project", text: "Keep my draft" },
    chatList: chat.chatList, setChatTaskId: id => { state.taskId = id; }, setView() {}, setSelectedRunId() {},
  });
  decide();
  assert.equal(state.taskId, "", "the pane resolves its new chat so it can accept input and notify its parent");
  assert.equal(paneWanted.current.workspaceId, "new-project");
});

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
    const reply = delayedReply(), attachments = [], annotations = [], composing = { current: { taskId: "task-a", draft: "sent text", attachments, annotations } };
    const state = { draft: "sent text" }, set = key => value => { state[key] = value; };
    const deliver = rendererCallback("AgentOrchestratorChat.tsx", "deliver", {
      selectedTaskId: "task-a", draft: "sent text", attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
      setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: () => reply.promise,
      setDraft: set("draft"), setTitle() {}, setAttachments() {}, setAttachNote() {}, setAtBottom() {}, setCarried() {},
      // The message shows in the chat at once (setOutgoing) and leaves the composer before it is sent.
      setOutgoing() {}, setAnnotations() {},
    });
    const sending = deliver("sent text");
    assert.equal(state.draft, "", "the sent text leaves the composer at once, not when the send returns");
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
    selection: { current: { workspaceId: "a" } }, restartResume: chat.restartResume, executableArg: () => ({}), document: { hasFocus: () => true },
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

test("a restart's resume waits for the window's focus, then starts only a chat nothing else picked up", async () => {
  // Activity log 2026-10-24 06:47: five resumes' start_run refused with "Click into the Coding Tools
  // window" (the app had opened behind other windows), and none was tried again.
  const mission = { id: "r", workspace_id: "a", execution_mode: "team", cancelled: false, nodes: [
    { id: "p", role: "planner", state: "finished" }, { id: "w", role: "worker", state: "finished" }, { id: "v", role: "reviewer", state: "pending" }] };
  for (const [picked, expected] of [[false, ["run_status", "runs", "run_status", "start_run"]], [true, ["run_status", "runs", "run_status"]]]) {
    const calls = [], focus = [];
    let statuses = 0;
    const context = {
      workspaceId: "a", mounted: { current: true }, missions: [mission], settledRuns: { current: new Set() }, resumedRuns: { current: new Set() },
      selection: { current: { workspaceId: "a" } }, restartResume: chat.restartResume, executableArg: () => ({}),
      document: { hasFocus: () => false }, window: { addEventListener: (name, listener) => { if (name === "focus") focus.push(listener); } },
      moduleCall: async (operation) => {
        calls.push(operation);
        if (operation === "run_status") return (statuses += 1) > 1 && picked ? { driven: true, status: "running" } : { driven: false, status: "idle" };
        if (operation === "runs") return { runs: [mission] };
        return { ok: true };
      },
      loadMissions: async () => {}, setTimeout,
    };
    rendererCallback("AgentOrchestratorSurface.tsx", "effect:settledRuns.current.add(key)", context)();
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    assert.deepEqual(calls, ["run_status", "runs"], "nothing is started while the window is not focused");
    assert.equal(focus.length, 1);
    focus[0]();
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    assert.deepEqual(calls, expected, picked ? "a chat picked up meanwhile is left alone" : "resumed once the person is back");
  }
});

test("with Retry automatically on, opening a project retries a single chat's failed step that no loop is driving", async () => {
  // Seen live: "Launch failed: The operation was aborted due to timeout", held for hours, driven: false.
  const mission = { id: "r", workspace_id: "a", execution_mode: "single", cancelled: false, nodes: [
    { id: "p", role: "planner", state: "held", history: [], receipt: { error: "Launch failed: The operation was aborted due to timeout", started_at_ms: Date.now() - 3_600_000 } }] };
  for (const [autoRetry, expected] of [[true, ["run_status", "chat_auto_retry", "runs", "control_run", "start_run"]], [false, ["run_status", "chat_auto_retry", "runs"]]]) {
    const calls = [];
    const context = {
      workspaceId: "a", mounted: { current: true }, missions: [mission], settledRuns: { current: new Set() }, resumedRuns: { current: new Set() },
      selection: { current: { workspaceId: "a" } }, restartResume: chat.restartResume, executableArg: () => ({}), document: { hasFocus: () => true },
      moduleCall: async (operation, args) => {
        calls.push(operation);
        if (operation === "run_status") return { driven: false, status: "held" };
        if (operation === "chat_auto_retry") return { ok: true, autoRetry };
        if (operation === "runs") return { runs: [mission] };
        if (operation === "control_run") assert.equal(args.action, "retry");
        return { ok: true };
      },
      loadMissions: async () => {}, setTimeout,
    };
    rendererCallback("AgentOrchestratorSurface.tsx", "effect:settledRuns.current.add(key)", context)();
    for (let i = 0; i < 6; i += 1) await new Promise(setImmediate);
    assert.deepEqual(calls, expected, autoRetry ? "retried and started" : "switch off: left for the person");
  }
  // While a loop of this session holds it (waiting out its retry pause), it is looked at again later.
  const settledRuns = { current: new Set() };
  rendererCallback("AgentOrchestratorSurface.tsx", "effect:settledRuns.current.add(key)", {
    workspaceId: "a", mounted: { current: true }, missions: [mission], settledRuns, resumedRuns: { current: new Set() },
    selection: { current: { workspaceId: "a" } }, restartResume: chat.restartResume, executableArg: () => ({}), document: { hasFocus: () => true },
    moduleCall: async () => ({ driven: true, status: "held" }), loadMissions: async () => {}, setTimeout,
  })();
  for (let i = 0; i < 3; i += 1) await new Promise(setImmediate);
  assert.equal(settledRuns.current.size, 0);
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
      const globals = {
        selectedRun: { id: "run-a" }, workspaceId: "a", currentRun: () => matching,
        run: async (_name, action) => { await action(); done.resolve(); },
        // Retry is guarded per chat (chatRun), and its work is retryRun.
        chatRun: async (_task, action) => { await action(); done.resolve(); },
        moduleCall: async (operation, args) => { calls.push([operation, args]); return reply.promise; }, executableArg: () => ({}), loadMissions: async () => {},
        composerMode: "single", singleRoute: { model: "default" }, missions: [], routeIdentity: value => value,
        setSelectedRunId: value => { state.selected = value; }, setAutoStatus: value => { state.status = value; },
        setAdvanceNotice() {}, setError() {}, setChatNotices() {}, startNotice: () => "",
      };
      if (name === "retryChatStart") globals.retryRun = rendererCallback("AgentOrchestratorSurface.tsx", "retryRun", globals);
      const callback = rendererCallback("AgentOrchestratorSurface.tsx", name, globals);
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

test("a tool title with a path reads by its file name in the folded line, never cut mid-word", () => {
  // Seen live on a team card: "Read C:/Users/simon/.ao/coding-tools/ski" (a 40-character cut).
  assert.equal(chat.shortToolTitle("Read C:/Users/simon/.ao/coding-tools/skills/using-ao/commands/report.md"), "Read report.md");
  assert.equal(chat.shortToolTitle("Read C:\\Users\\simon\\.ao\\coding-tools\\skills"), "Read skills");
  assert.equal(chat.shortToolTitle("mcp__coding-tools__read_output"), "read_output");
  // Relative paths read by their file too, never glued to their first folder (review: "Read srcao-chat.ts").
  assert.equal(chat.shortToolTitle("Read src/features/ao-chat.ts"), "Read ao-chat.ts");
  assert.equal(chat.shortToolTitle("Read frontend\\vite.config.ts"), "Read vite.config.ts");
  assert.equal(chat.shortToolTitle("Edit \"desktop-electron/src/App.tsx\""), "Edit \"App.tsx\"");
  assert.equal(chat.shortToolTitle("Fetch https://example.com/docs"), "Fetch https://example.com/docs", "a URL keeps its address");
  assert.equal(chat.shortToolTitle("Search for every place the context meter reads its session usage"),
    "Search for every place the context meter…");
  const read = (id, path) => ({ id, kind: "tool", status: "completed", text: `Read ${path}` });
  assert.equal(chat.activitySummary([read("a", "C:/x/skills/a.md"), read("b", "C:/y/b.md")]), "Read a.md, Read b.md");
});

test("a steer reads as Claude Code's receipt: unread until the model's next request, read after", () => {
  const at = (kind, id = kind) => ({ id, kind, status: "completed", text: kind === "steer" ? "use the other API" : "" });
  const receipt = (items, finished = false) => chat.steerReceipts(items, finished).find((item) => item.kind === "steer").receipt;
  // Mid-reply: the response in flight was written without it, its tool call too; what follows that call has it.
  assert.equal(receipt([at("message"), at("steer")]), "unread", "just delivered");
  assert.equal(receipt([at("message"), at("steer"), at("tool")]), "unread", "a call the response in flight made");
  assert.equal(receipt([at("message"), at("steer"), at("tool"), at("reasoning")]), "read", "the next request had it");
  // Waiting on a tool call: its result and the steer go back together, so the next output read it.
  assert.equal(receipt([at("command"), at("steer")]), "unread");
  assert.equal(receipt([at("command"), at("approval"), at("steer"), at("message")]), "read", "an approval row is no model output");
  // A finished turn read every steer in it.
  assert.equal(receipt([at("message"), at("steer")], true), "read");
  // Items that did not change come back as they were (a poll rebuilds the list every second).
  const items = [at("message"), at("steer"), at("tool"), at("message", "m2")];
  const marked = chat.steerReceipts(items, false);
  assert.equal(chat.steerReceipts(marked, false), marked, "already marked: the same list");
  assert.equal(marked[0], items[0]);
  // Its reader is the card's model; a step without one falls back to the harness, then Claude.
  assert.equal(chat.steerReader({ reader: "DeepSeek V4.1 Flash", detail: "Claude Code · deepseek-v4.1-flash · high" }), "DeepSeek V4.1 Flash");
  assert.equal(chat.steerReader({ detail: "Claude Code · deepseek-v4.1-flash · high" }), "Claude");
  assert.equal(chat.steerReader({ detail: "Codex · gpt-5.5" }), "Codex");
  assert.equal(chat.steerReader(undefined), "Claude");
});

test("a steer is read by the card's model, not by Claude when Claude Code runs another provider's model", () => {
  const reader = (model, modelName) => chat.chatTurns([{ id: "r", project_id: "t", cancelled: false, execution_mode: "single",
    nodes: [{ id: "one", role: "planner", state: "running", x: 0, route: { harness_id: "ao:claude-code", model } }] }], "hi",
    modelName ? { modelName } : {})[0].steps[0].reader;
  assert.equal(reader("cpa/cline-pass/deepseek-v4.1-flash", () => "DeepSeek V4.1 Flash"), "DeepSeek V4.1 Flash");
  assert.equal(reader("cpa/claude-opus-4-7", () => "Opus 4.7"), "Claude Opus 4.7", "a Claude model keeps its maker's name");
  assert.equal(reader("cpa/cline-pass/deepseek-v4.1-flash(high)"), "deepseek-v4.1-flash", "without a namer: the bare id, no effort");
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

test("a call the reviewer denied shows its verdict, not the adapter's stock refusal", () => {
  const refused = "User refused permission to run tool";
  const tidy = chat.tidyTimeline([
    { id: "1", kind: "command", status: "failed", text: "$txt=[IO.File]::ReadAllText($p)", output: refused },
    { id: "2", kind: "approval", status: "completed", text: "PowerShell", approval: "Denied by the reviewer: reads a file outside the project" },
    { id: "3", kind: "command", status: "failed", text: "git push", output: `Error: ${refused}` },
    { id: "4", kind: "approval", status: "rejected", text: "git push", approval: "Denied by Approve for me's safety rules" },
    { id: "5", kind: "command", status: "failed", text: "rm -rf build", output: refused },
    { id: "6", kind: "approval", status: "completed", text: "PowerShell", approval: "Denied" },
  ]);
  assert.deepEqual([...tidy.map((item) => [item.id, item.output ?? null])], [
    ["1", "Denied by the reviewer: reads a file outside the project"],
    ["3", "Denied by Approve for me's safety rules"], ["4", null],
    ["5", refused]], "a folded or kept denial replaces the stock line; the person's own deny keeps it");
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
  // A poll sharing nothing with what is kept is the same turn moving fast (more items than a poll's
  // window between two polls): everything already seen stays. A retry is kept apart by its start.
  assert.deepEqual(ids(chat.mergeTimeline(later, [item("9")])), ["1", "2", "3", "4", "9"]);
});

test("a live turn keeps at most its newest steps, so a long run stays light to redraw", () => {
  const item = (id) => ({ id: String(id), kind: "tool", status: "completed", text: `call ${id}` });
  const cap = chat.LIVE_TIMELINE_ITEMS;
  // Hours of work: every poll's window moved on, and the kept list grew past the cap.
  let kept = Array.from({ length: cap }, (_, index) => item(index));
  kept = chat.mergeTimeline(kept, [item(cap - 1), item(cap), item(cap + 1)]);
  assert.equal(kept.length, cap);
  assert.equal(kept[0].id, "2", "the oldest steps fall out first");
  assert.equal(kept.at(-1).id, String(cap + 1));
  // A finished turn read back whole is not capped: its earliest commands stay readable.
  const whole = Array.from({ length: cap + 50 }, (_, index) => item(index));
  assert.equal(chat.mergeTimeline(null, whole, { cap: Infinity }).length, cap + 50);
  assert.equal(chat.mergeTimeline(kept, whole, { cap: Infinity })[0].id, "0");
});

test("a single-model chat's card is named by its model, a team's by its role", () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/cline-pass/deepseek-v4.1-flash" };
  const node = { id: "one", role: "planner", state: "running", x: 0, route, settings: { name: "Single assistant" } };
  const name = (mode) => chat.chatTurns([{ id: "r", project_id: "t", cancelled: false, execution_mode: mode, nodes: [node] }], "hi",
    { modelName: (model) => `Model<${model}>` })[0].steps[0].name;
  assert.equal(name("single"), "Model<cpa/cline-pass/deepseek-v4.1-flash>");
  assert.equal(name("team"), "Single assistant");
});

test("a quiet running turn says how long it has been quiet, and that it may be stuck past the stall time", () => {
  const now = 10_000_000;
  assert.equal(chat.dshQuietNote(undefined, now), "", "no sign of life yet: nothing added");
  assert.equal(chat.dshQuietNote(now - 30_000, now), "", "the first minute stays plain");
  assert.equal(chat.dshQuietNote(now - 182_000, now), " · quiet for 3m 2s");
  assert.equal(chat.dshQuietNote(now - chat.STALL_MS, now), ` · nothing new for ${chat.dshDuration(chat.STALL_MS)}, may be stuck`);
});

test("a turn waiting on the person's answer is never called stuck, so it offers no Restart", () => {
  const now = 10_000_000;
  // Seen live 2026-10-23: 17 minutes on an approval read "may be stuck", and Restart only waited on it.
  assert.equal(chat.dshQuietNote(now - 17 * 60_000, now, true), ` · waiting for you for ${chat.dshDuration(17 * 60_000)}`);
  assert.equal(chat.dshQuietNote(now - 30_000, now, true), "", "the first minute stays plain");
  assert.equal(chat.waitsForPerson("waiting for approval"), true);
  assert.equal(chat.waitsForPerson("waiting for approval: npm test"), true);
  assert.equal(chat.waitsForPerson("waiting for your answer"), true);
  assert.equal(chat.waitsForPerson("waiting for you to review its plan"), true);
  assert.equal(chat.waitsForPerson("waiting for the model"), false, "a slow model can still be stuck");
  assert.equal(chat.waitsForPerson(undefined), false);
});

test("an open chat follows its live run once the selected one has settled", () => {
  const working = run("old", "t", [node("a", "planner", "running")]);
  const stopped = run("new", "t", [node("a", "planner", "cancelled")], { cancelled: true, paused: true });
  // Seen live 2026-10-23: the newer of two rounds was stopped, the older retried and worked on.
  assert.equal(chat.chatLiveRun([working, stopped], "t", "new"), "old", "the stopped run gives way to the working one");
  assert.equal(chat.chatLiveRun([working, stopped], "t", ""), "old", "nothing selected yet");
  const finished = run("r1", "t", [node("a", "planner", "finished")]);
  const round = run("r2", "t", [node("a", "planner", "pending")]);
  assert.equal(chat.chatLiveRun([finished, round], "t", "r1"), "r2", "a round the goal or a wakeup started is followed");
  assert.equal(chat.chatLiveRun([finished, round], "t", "r2"), "r2", "an open run stays selected");
  assert.equal(chat.chatLiveRun([finished], "t", "r1"), "r1", "a settled chat stays on its newest run");
  assert.equal(chat.chatLiveRun([finished], "t", "sent"), "sent", "a send's run not loaded yet is kept");
  const held = run("h", "t", [node("a", "planner", "held")]);
  assert.equal(chat.chatLiveRun([working, held], "t", "h"), "h", "a held run needs the person: it stays selected");
  assert.equal(chat.chatLiveRun([working], "other", "x"), "x", "another chat's runs are not this chat's");
});

test("a goal's later round shows as its Stop hook feedback, not as the person's message", () => {
  assert.deepEqual(plain(chat.goalFeedback("Stop hook feedback:\n[play auto play on eros]: The condition is not met yet; continue from where the last round left off.")),
    { objective: "play auto play on eros", reason: "The condition is not met yet; continue from where the last round left off." });
  assert.deepEqual(plain(chat.goalFeedback("Stop hook feedback:\n[fix [the] tests]: two still fail")), { objective: "fix [the] tests", reason: "two still fail" });
  assert.equal(chat.goalFeedback("make village attack first"), null);
  assert.equal(chat.goalFeedback("Stop hook feedback: typed by hand"), null);
});

test("a working AO card's last sign of life comes from its activity time, for last heard and the quiet note", () => {
  const card = node("w", "planner", "running", { receipt: { started_at_ms: 1_000 } });
  const quiet = chat.chatWorkingDetail(card, { activity: "running", activity_at_ms: 600_000 }, 900_000);
  assert.equal(quiet.heardAtMs, 600_000);
  assert.match(quiet.detail, /last heard 5m ago/);
  assert.equal(quiet.stalled, false);
  assert.equal(chat.chatWorkingDetail(card, { activity: "running", activity_at_ms: 1_000 }, 1_000 + chat.STALL_MS).stalled, true,
    "quiet as long as a stuck card");
  assert.equal(chat.chatWorkingDetail(card, { activity: "running" }, 900_000).heardAtMs, undefined, "never heard: nothing to show");
});
test("a restart resumes recent work only: an 11-day-old mission with a pending card stays put", () => {
  const now = Date.parse("2026-10-20T14:30:00Z");
  const oct9 = Date.parse("2026-10-09T14:22:31Z");
  const team = (nodes) => ({ cancelled: false, execution_mode: "team", nodes });
  // The revived mission: planner finished and reviewer pending since Oct 9.
  const old = team([node("p", "planner", "finished", { receipt: { started_at_ms: oct9 } }),
    node("r", "reviewer", "pending", { history: [{ started_at_ms: oct9 + 3_600_000 }] })]);
  assert.equal(chat.restartResume(old, now), null, "abandoned long ago, not interrupted");
  const recent = team([node("p", "planner", "finished", { receipt: { started_at_ms: now - 3_600_000 } }), node("r", "reviewer", "pending")]);
  assert.equal(chat.restartResume(recent, now), "continue", "an hour-old mission still picks up");
  const longRun = team([node("w", "worker", "running", { receipt: { started_at_ms: now - 20 * 3_600_000 } })]);
  assert.equal(chat.restartResume(longRun, now), "continue", "a long mission inside the window still resumes");
  assert.equal(chat.restartResume(team([node("q", "planner", "pending")]), now), "continue", "never started: no age to judge, still resumes");
});

test("a reviewer reset to pending by its own rework still shows its last review", () => {
  const verdict = "CHANGES_REQUIRED: both workers must redo their evidence.";
  const reviewer = node("r", "reviewer", "pending", { history: [{ answer: "older review" }, { answer: verdict }] });
  const turns = chat.chatTurns([run("run1", "t1", [node("p", "planner", "finished", { receipt: { answer: "plan" } }), reviewer], { execution_mode: "team" })], "do it", { now: 0 });
  const step = turns[0].steps.find((item) => item.role === "reviewer");
  assert.ok(step, "the pending reviewer is not dropped from the turn");
  assert.equal(step.text, `Last review:\n\n${verdict}`, "its newest verdict, labelled as a review");
  const worker = node("w", "worker", "held", { history: [{ answer: "first try" }] });
  const held = plain(chat.chatTurns([run("run2", "t1", [worker])], "x", { now: 0 })[0].steps[0]);
  assert.equal(held.text, undefined, "a team worker's earlier report is not copied up");
  assert.deepEqual(held.earlier, [{ label: "Attempt 1", text: "first try" }], "it stays folded under its attempt");
});

test("a failed team worker opens on its error with every attempt folded, not on a whole earlier report", () => {
  // Seen live (clash of clan macro, 2026-10-21): a worker failed on its seventh try (the proxy
  // refused), opened by itself, and showed attempt 6's whole report under "Earlier attempt:", left
  // out of the attempts list, so it read as a message from nowhere.
  const worker = node("w", "worker", "failed", {
    receipt: { error: "API Error: 500 proxyconnect tcp: dial tcp 127.0.0.1:17891: connection refused" },
    history: [{ error: "500" }, { error: "500" }, { error: "500" },
      { answer: "Report 4", error: "500" }, { answer: "Report 5", error: "500" }, { answer: "Report 6", error: "500" }],
  });
  const [turn] = plain(chat.chatTurns([run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "plan" } }), worker],
    { execution_mode: "team" })], "go", { now: 0 }));
  const step = turn.steps.find((item) => item.role === "worker");
  assert.equal(step.text, undefined);
  assert.match(step.error, /17891/);
  assert.deepEqual(step.earlier.map((round) => `${round.label}:${round.verdict}`),
    ["Attempt 1:failed", "Attempt 2:failed", "Attempt 3:failed", "Attempt 4:failed", "Attempt 5:failed", "Attempt 6:failed"]);
  assert.equal(step.earlier[5].text, "Report 6", "the newest report is the last attempt, folded");
  const running = node("w", "worker", "running", { receipt: { started_at_ms: 1 }, history: [{ answer: "Report 1" }] });
  const live = plain(chat.chatTurns([run("r1", "t", [running], { execution_mode: "team" })], "go", { now: 2 })[0].steps[0]);
  assert.equal(live.text, undefined, "a retrying worker shows its new attempt, the old report folded");
  assert.deepEqual(live.earlier, [{ label: "Attempt 1", text: "Report 1" }]);
});

test("Claude Code's auto-mode billing notice is left out of replies, folded attempts and live messages", () => {
  const notice = "**Warning:** We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through 127.0.0.1:8317, which isn't compatible with this update. Nothing breaks: auto mode keeps working, and its classifier requests are billed as before. To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing";
  assert.equal(chat.withoutHarnessNotices(`${notice}\n\nWorker Report: Part 1`), "Worker Report: Part 1");
  assert.equal(chat.withoutHarnessNotices(`Plan below.\n\n${notice}\n\nDone.`), "Plan below.\n\nDone.");
  assert.equal(chat.withoutHarnessNotices(notice.replace(/\*\*/g, "")), "", "the plain form too");
  const untouched = "Warning: the tests are slow.\n\nDone.";
  assert.equal(chat.withoutHarnessNotices(untouched), untouched, "the agent's own warnings stay");
  const planner = node("p", "planner", "finished", { receipt: { answer: `${notice}\n\nThe plan.` } });
  const worker = node("w", "worker", "failed", { receipt: { error: "500" }, history: [{ answer: `${notice}\n\nReport 1` }] });
  const [turn] = plain(chat.chatTurns([run("r1", "t", [planner, worker], { execution_mode: "team" })], "go", { now: 0 }));
  assert.equal(turn.steps[0].text, "The plan.");
  assert.equal(turn.steps[1].earlier[0].text, "Report 1");
  const tidy = plain(chat.tidyTimeline([
    { id: "a", kind: "message", status: "completed", text: notice },
    { id: "b", kind: "message", status: "completed", text: `${notice}\n\nReading the files.` },
    { id: "c", kind: "command", status: "completed", text: "ls" },
  ]));
  assert.deepEqual(tidy.map((item) => `${item.id}:${item.text}`), ["b:Reading the files.", "c:ls"]);
});

test("a single model's messages show once: in its reply, not again in its work above it", () => {
  // Seen live (MiMo V2.6 Pro, 2026-10-21): Claude Code's reply is the turn's messages joined, and the
  // chat showed "埠 8000 已有服務在跑…" between the tool calls and again in the answer.
  const message = (id, text) => ({ id, kind: "message", status: "completed", text });
  const items = [
    message("m1", "我先核實現況。"), { id: "c1", kind: "command", status: "completed", text: "netstat -ano" },
    message("m2", "埠 8000 已有服務在跑,\n直接開預覽。"), { id: "t1", kind: "tool", status: "completed", text: "preview_open" },
    message("m3", "預覽已開好。"), message("m4", "A note the reply does not repeat."),
  ];
  const reply = "我先核實現況。\n\n埠 8000 已有服務在跑, 直接開預覽。\n\n預覽已開好。";
  assert.deepEqual(chat.withoutReplied(items, reply).map((item) => item.id), ["c1", "t1", "m4"]);
  assert.deepEqual(chat.withoutReplied(items, undefined).map((item) => item.id), items.map((item) => item.id), "no reply, nothing hidden");
  assert.deepEqual(chat.withoutReplied(items, "   ").length, items.length);
});

test("a review's rework block (the card ids the engine reads) is not shown", () => {
  // Seen live: a review ended with "rework" and `["7394f7d6-3cb1-491d-a715-f1dd90bc79e2"]`.
  const review = "CHANGES_REQUIRED: Worker 1 must list all 316 entries.";
  assert.equal(chat.withoutReworkBlock(`${review}\n\nrework\n\`["7394f7d6-3cb1-491d-a715-f1dd90bc79e2"]\``), review);
  assert.equal(chat.withoutReworkBlock(`${review}\n\`\`\`rework\n["w1"]\n\`\`\``), review);
  assert.equal(chat.withoutReworkBlock(`${review}\nrework\n["w1", "w2"]`), review);
  assert.equal(chat.withoutReworkBlock("We should rework the parser.\nDone."), "We should rework the parser.\nDone.", "the word in prose stays");
  const reviewer = node("r", "reviewer", "finished", { receipt: { answer: `${review}\n\`\`\`rework\n["w1"]\n\`\`\``, verdict: "CHANGES_REQUIRED" },
    history: [{ answer: `older\nrework\n\`["w1"]\``, verdict: "CHANGES_REQUIRED" }] });
  const [turn] = plain(chat.chatTurns([run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "plan" } }), reviewer],
    { execution_mode: "team" })], "go", { now: 0 }));
  assert.equal(turn.final.text, review);
  assert.equal(turn.final.verdict, "CHANGES_REQUIRED", "the verdict still shows");
  assert.equal(turn.final.earlier[0].text, "older");
  const worker = node("w", "worker", "finished", { receipt: { answer: "Report\nrework\n[\"x\"]" } });
  assert.equal(plain(chat.chatTurns([run("r1", "t", [worker], { execution_mode: "team" })], "go", { now: 0 })[0].steps[0].text),
    "Report\nrework\n[\"x\"]", "only a review's block is the engine's");
});
test("a turn whose agent is waiting out a model error says so, instead of \"may be stuck\"", () => {
  // Seen live: a chat rate-limited by its model (Claude Code backing off from 429s for 20 minutes)
  // said only "nothing new for 10m 38s, may be stuck".
  const retrying = (text, status = "running") => ({ key: "s", working: { timeline: [
    { id: "a", kind: "command", status: "completed", text: "ls" },
    { id: "r", kind: "system", status, text } ] } });
  assert.equal(chat.dshRetryNote([retrying("Retrying Claude, attempt 8 of 10. API error 429. Trying again in 38.6s.")]),
    " · rate limited (429), retrying 8 of 10");
  assert.equal(chat.dshRetryNote([retrying("Retrying Claude, attempt 2 of 10. API error 503. Trying again in 2s.")]),
    " · model service error (503), retrying 2 of 10");
  assert.equal(chat.dshRetryNote([retrying("Retrying Claude, attempt 2 of 10.", "completed")]), "", "a retry that is over says nothing");
  assert.equal(chat.dshRetryNote([{ key: "s", working: { timeline: [{ id: "a", kind: "command", status: "running", text: "npm test" }] } }]), "",
    "a card busy with a tool is not retrying");
});
test("a quiet turn whose model CPA keeps refusing says so, with what the refusal means", () => {
  const now = 1_000_000_000;
  assert.equal(chat.cpaRefusalNote({ streak: 6, status: 429, since: now - 300_000, lastAt: now - 125_000 }, now),
    " · CPA refused the last 6 requests: rate limited (429), latest 2m 5s ago");
  assert.equal(chat.cpaRefusalNote({ streak: 2, status: 503, since: now - 20_000, lastAt: now - 5_000 }, now),
    " · CPA refused the last 2 requests: model service error (503), just now");
  assert.equal(chat.cpaRefusalNote({ streak: 3, status: 401, since: null, lastAt: null }, now), " · CPA refused the last 3 requests: sign-in refused (401)");
  assert.equal(chat.cpaRefusalNote({ streak: 1, status: 429, since: now, lastAt: now }, now), "", "one failure is usually retried at once");
  assert.equal(chat.cpaRefusalNote(null, now), "");
});
test("the approvals poll skips a card whose attempt changed mid-read instead of raising an error", async () => {
  const state = { approvals: null, policies: null, errors: [] };
  const calls = [];
  const timers = [];
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:approvalScope.current", {
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["old", "live"]),
    // #463: the poll asks only for a run of this project (selectedRunHere).
    workspaceId: "w1", selectedRunId: "run1", selectedRunHere: true, autoStatus: "idle", surfaceHidden: () => false,
    approvalScope: { current: null }, selection: { current: { workspaceId: "w1", runId: "run1" } },
    setPendingApprovals: value => { state.approvals = value; }, setRuntimePolicies: value => { state.policies = value; },
    setMissions: () => {}, setError: error => state.errors.push(error),
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval: () => {},
    moduleCall: async (op, args) => {
      calls.push(op + ":" + args.nodeId);
      if (args.nodeId === "old") throw new Error("IPC_TRANSPORT_FAILED: apps.call failed: AO receipt changed; refresh before retrying");
      return { ok: true, pending_approvals: [{ approval_id: "a1", tool: "shell" }] };
    },
  });
  const cleanup = effect();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["observe:old", "observe:live"]);
  assert.deepEqual(state.errors, [], "a stale observe is not shown as 'Something went wrong'");
  assert.deepEqual(plain(state.approvals), [{ approval_id: "a1", tool: "shell", nodeId: "live" }],
    "the other card's request still shows on the same tick");
  cleanup();
});

test("the approvals poll still reports an observe failure that is not a changed attempt", async () => {
  const errors = [];
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:approvalScope.current", {
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["n1"]),
    workspaceId: "w1", selectedRunId: "run1", selectedRunHere: true, autoStatus: "idle", surfaceHidden: () => false,
    approvalScope: { current: null }, selection: { current: { workspaceId: "w1", runId: "run1" } },
    setPendingApprovals: () => {}, setRuntimePolicies: () => {}, setMissions: () => {}, setError: error => errors.push(error),
    setInterval: () => 1, clearInterval: () => {},
    moduleCall: async () => { throw new Error("AO result is unavailable; inspect the run before retrying"); },
  });
  const cleanup = effect();
  await new Promise(setImmediate);
  assert.deepEqual(errors, ["AO result is unavailable; inspect the run before retrying"]);
  cleanup();
});

test("the approvals poll asks nothing for a run the open project does not have yet (#463)", async () => {
  // Right after a project switch the selected run still belongs to the previous project: asking the
  // new one for it failed ("AO run not found in this workspace") and showed an error toast.
  const calls = [], errors = [];
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:approvalScope.current", {
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["n1"]),
    workspaceId: "w2", selectedRunId: "run-from-w1", selectedRunHere: false, autoStatus: "idle", surfaceHidden: () => false,
    approvalScope: { current: null }, selection: { current: { workspaceId: "w2", runId: "run-from-w1" } },
    setPendingApprovals: () => {}, setRuntimePolicies: () => {}, setMissions: () => {}, setError: error => errors.push(error),
    setInterval: () => 1, clearInterval: () => {},
    moduleCall: async (op) => { calls.push(op); throw new Error("AO run not found in this workspace"); },
  });
  const cleanup = effect();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [], "no observe for a run of another project");
  assert.deepEqual(errors, []);
  cleanup?.();
});
test("the approvals poll asks nothing about a run still selected from the previous project", async () => {
  // Seen in the launcher log: 25 observe and 35 harness_status failures "AO run not found in this workspace".
  const calls = [];
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:approvalScope.current", {
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["n1"]),
    workspaceId: "w2", selectedRunId: "run-from-w1", selectedRunHere: false, autoStatus: "running", surfaceHidden: () => false,
    approvalScope: { current: null }, selection: { current: { workspaceId: "w2", runId: "run-from-w1" } },
    setPendingApprovals: () => {}, setRuntimePolicies: () => {}, setMissions: () => {}, setError: () => {},
    setInterval: () => { calls.push("timer"); return 1; }, clearInterval: () => {},
    moduleCall: async (op) => { calls.push(op); return {}; },
  });
  effect();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [], "no poll starts until the run belongs to this project");
});
test("the chat list's clock stops while the window is hidden and ticks as soon as it is shown", () => {
  // Seen in the launcher log: minimized, each minute's tick re-read other open projects' chats and
  // was refused, "Open the Coding Tools window (not minimized)" (9 board + runs pairs).
  let hidden = true, interval = null, cleared = false;
  const listeners = new Map(), ticks = [];
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:setListNow(Date.now())", {
    Date, pageHidden: () => hidden, setListNow: value => ticks.push(value),
    window: { setInterval: (callback, ms) => { interval = { callback, ms }; return 7; }, clearInterval: id => { cleared = id === 7; } },
    document: { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); } },
  });
  const cleanup = effect();
  assert.equal(interval.ms, 60_000);
  interval.callback();
  assert.equal(ticks.length, 0, "no tick, so no reads, while minimized");
  hidden = false;
  listeners.get("visibilitychange")();
  assert.equal(ticks.length, 1, "shown again, it ticks at once");
  interval.callback();
  assert.equal(ticks.length, 2, "and every minute while shown");
  cleanup();
  assert.ok(cleared && !listeners.has("visibilitychange"), "unmounting stops both");
});

test("a message stamp saved in UTC shows in this computer's own time zone", () => {
  const two = (value) => String(value).padStart(2, "0");
  const at = new Date(Date.UTC(2026, 9, 23, 7, 53));
  const local = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
  assert.equal(chat.localChatStamp("2026-10-23 07:53"), local);
  // Hong Kong (UTC+8) reads 15:53 the same day; a stamp near midnight UTC moves to the next day.
  if (at.getTimezoneOffset() === -480) {
    assert.equal(chat.localChatStamp("2026-10-23 07:53"), "2026-10-23 15:53");
    assert.equal(chat.localChatStamp("2026-10-23 20:10"), "2026-10-24 04:10");
  }
  assert.equal(chat.localChatStamp("earlier"), "earlier", "a stamp in any other form is shown as saved");
});

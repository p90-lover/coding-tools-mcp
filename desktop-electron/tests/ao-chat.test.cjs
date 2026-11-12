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
  // In bytes too: two Chinese messages under the character limit joined past the bridge's byte budget.
  const cjk = "字".repeat(1500);
  assert.equal(chat.chatQueueAdd([{ what: "Message", message: cjk }], { what: "Message", message: cjk }).length, 2, "4,500 + 4,500 bytes stay two messages");
});

test("the composer counts a message in UTF-8 bytes against the bridge's budget, not only in characters", () => {
  assert.equal(chat.CHAT_MESSAGE_BYTES, 7936);
  for (const [text, bytes] of [["a", 1], ["é", 2], ["字", 3], ["😀", 4], ["a字😀", 8]]) {
    assert.equal(chat.chatMessageBytes(text), bytes, text);
    assert.equal(chat.chatMessageBytes(text), Buffer.byteLength(text, "utf8"), `${text} as Node counts it`);
  }
  assert.equal(chat.chatMessageFits("a".repeat(7936)), true);
  assert.equal(chat.chatMessageFits("a".repeat(7937)), false, "one byte over the budget");
  assert.equal(chat.chatMessageFits("字".repeat(2700)), false, "2,700 characters, 8,100 bytes: refused before it is sent");
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

test("a chat's runs the project's newest-100 read dropped come back from the chat's own read", () => {
  // Seen live (2026-11-02): a goal chat on round 69 had 63 runs saved, but the project's read held
  // only its newest 26, so its earlier replies were gone; chats with none left in it showed no replies.
  const ids = (runs) => Array.from(runs, (item) => item.id);
  const mine = (id) => run(id, "chat", []);
  const theirs = (id) => run(id, "other", []);
  const recent = [theirs("o1"), mine("c3"), theirs("o2"), mine("c4")];
  const history = [mine("c1"), mine("c2"), mine("c3"), mine("c4")];
  assert.deepEqual(ids(chat.chatRunsWithHistory(recent, history)), ["c1", "c2", "o1", "c3", "o2", "c4"],
    "older runs go first, the read's own order is kept");
  assert.equal(chat.chatRunsWithHistory(recent, []), recent, "no history: the same list");
  assert.equal(chat.chatRunsWithHistory(recent, [mine("c3"), mine("c4")]), recent, "nothing older: the same list");
  // A chat with no run left in the project's read gets all of its own.
  assert.deepEqual(ids(chat.chatRunsWithHistory([theirs("o1")], [mine("c1"), mine("c2")])), ["c1", "c2", "o1"]);
  // A run the read leaves out on purpose (a deleted message's, newer than the chat's oldest run in it) stays out.
  assert.deepEqual(ids(chat.chatRunsWithHistory([mine("c3"), mine("c5")], [mine("c1"), mine("c3"), mine("c4"), mine("c5")])), ["c1", "c3", "c5"]);
  // The turns then pair every reply again: the compacted chat's summary stays with its own run.
  const answered = (id) => run(id, "chat", [node("p", "planner", "finished", { receipt: { answer: id } })], { execution_mode: "single" });
  const all = chat.chatRunsWithHistory([answered("r3"), answered("r4")], ["r1", "r2", "r3", "r4"].map(answered));
  const description = "Summary of the earlier conversation (compacted 2026-11-02 07:08 UTC):\nwhat happened so far\n\nFollow-up (2026-11-02 07:08 UTC):\ngo on";
  assert.deepEqual(plain(chat.chatTurns(all, description)).map((turn) => [turn.runId, turn.final?.text ?? null, turn.messageIndex ?? null]),
    [["r1", "r1", null], ["r2", "r2", null], ["r3", "r3", 0], ["r4", "r4", 1]]);
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

test("a chat with no run in the project read's newest 100 stays listed from its lifecycle's newest run", () => {
  // 2026-11-09: the project read holds its newest 100 runs, shared by all chats; busy goal chats
  // filled it, and "clash of clan macro" listed 4 of its 49 chats. The workflow puts a chat's newest
  // run on its lifecycle entry when none of its runs is in the read (withChatIndex).
  const runs = [run("r9", "goal", [node("p", "planner", "finished")]), run("r10", "goal", [node("p", "planner", "running")])];
  const lifecycle = [
    { task_id: "goal", visibility: "active" },
    { task_id: "old", title: "Old chat", visibility: "active", latest_run: { id: "r2", nodes: [{ role: "planner", state: "finished" }], run_count: 7, at: 2_000 } },
    { task_id: "newer", title: "Newer chat", visibility: "active", latest_run: { id: "r5", nodes: [{ role: "planner", state: "failed" }], run_count: 1, at: 5_000 } },
    { task_id: "gone", title: "Archived chat", visibility: "archived", latest_run: { id: "r1", nodes: [{ role: "planner", state: "finished" }], at: 9_000 } },
    { task_id: "draft", title: "New task", visibility: "active" },
  ];
  const list = plain(chat.chatList(runs, [], lifecycle));
  assert.deepEqual(list.map((entry) => [entry.taskId, entry.title, entry.latestRunId, entry.status, entry.runCount]), [
    ["goal", "New task", "r10", "running", undefined],
    ["newer", "Newer chat", "r5", "attention", 1],
    ["old", "Old chat", "r2", "done", 7],
  ], "after the chats in the read, newest work first; a draft with no runs stays off, an archived one stays archived");
  assert.deepEqual(plain(chat.chatArchived(runs, [], lifecycle)).map((entry) => entry.taskId), ["gone"]);
  // Once its runs are in the read again (a new message, or the chat's own read), those are what it shows.
  const back = plain(chat.chatList([...runs, run("r11", "old", [node("p", "planner", "running")])], [], lifecycle));
  assert.deepEqual(back.map((entry) => [entry.taskId, entry.latestRunId, entry.status]).slice(0, 2), [["old", "r11", "running"], ["goal", "r10", "running"]]);
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
  const react = { useMemo: calculate => calculate(), useCallback: callback => callback, useEffect() {}, useRef: initial => ({ current: initial }), memo: component => component,
    createContext: value => ({ Provider: ({ children }) => children, value }), useContext: context => context.value,
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}] };
  const replyHead = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ChatReplyHead.tsx"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { exports: replyHead, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "./ao-chat" ? chat : name === "./ChatTurnStats" ? { useTurnRequests: () => ({ ref: { current: null }, summary: "" }) } : {} });
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
      : name === "./ImagePreview" ? { ImagePreviewDialog: "ImagePreview" } : name === "./image-markup" ? { markupReadable: text => text }
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

const pageHelpers = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/chat-pages.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: pageHelpers, require: name => require(require.resolve(name, { paths: [path.resolve(__dirname, "..")] })) });

function loadSurface(react = {}, globals = {}, imports = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const surface = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: surface, require: name => name === "react" ? { useContext: () => null, ...react } : name === "react/jsx-runtime"
      ? imports.jsx || require(require.resolve(name, { paths: [path.resolve(__dirname, "..")] })) : imports[name] || (name === "./chat-pages" ? pageHelpers : {}), ...globals });
  return surface;
}

function surfaceComposer(seed = {}, globals = {}, pageRegistry = null) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8").split("export function AgentOrchestratorSurface")[1];
  const names = [...source.matchAll(/const \[([A-Za-z_]+)(?:,[^\]]+)?\] = useState/g)].map(match => match[1]);
  const state = { workspaceReady: true, workspaceId: "w", chatTaskId: "", board: { revision: 1, tasks: [] }, ...seed };
  const refs = [], callbacks = [], effects = []; let cursor = 0, refCursor = 0, callbackCursor = 0;
  const react = {
    useState(initial) {
      const name = names[cursor++]; assert.ok(name, "each Surface state is named");
      if (!(name in state)) state[name] = typeof initial === "function" ? initial() : initial;
      return [state[name], value => { state[name] = typeof value === "function" ? value(state[name]) : value; }];
    },
    useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
    useCallback(callback, deps) {
      const index = callbackCursor++, previous = callbacks[index];
      if (deps && previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.callback;
      callbacks[index] = { callback, deps: deps ? [...deps] : [] }; return callback;
    },
    useMemo: calculate => calculate(), useEffect: effect => effects.push(effect), useLayoutEffect() {},
    useContext: () => pageRegistry,
  };
  let permissionKey;
  const jsx = (type, props, key) => { if (type === "Permissions") permissionKey = key; return { type, props: props || {} }; };
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
  const calls = [], errors = [];
  const result = { runs: seed.missions || [], teams: seed.savedTeams || [], team: seed.team || null };
  const api = { apps: { call: async input => {
    calls.push(plain(input));
    if (input.operation === "chat_send") return { ok: true, result: { ok: true, taskId: "new-task", runId: "new-run", status: "running" } };
    if (input.operation === "runs") return { ok: true, result };
    if (input.operation === "board") return { ok: true, result: { revision: 1, tasks: [] } };
    if (input.operation === "permission_profiles") return { ok: true, result: { capability: { supported: true, profiles: [] } } };
    if (input.operation === "team_update" || input.operation === "update_run") return { ok: true, result: { ok: true } };
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
  const surface = loadSurface(react,{ localStorage: { getItem: () => "w", setItem() {} }, structuredClone, crypto: globalThis.crypto, ...globals }, imports);
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const render = () => { effects.length = 0; cursor = 0; refCursor = 0; callbackCursor = 0; return surface.AgentOrchestratorSurface({ language: "en", setError: error => { if (error) errors.push(error); } }); };
  const currentChat = () => walk(render()).find(item => item.type === "Chat");
  return { state, calls, errors, render, walk, currentChat, api, effects, permissionKey: () => permissionKey };
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

// Ten screens: the window's chat at 0,0 and nine panes over five columns of two.
const tenScreens = () => [[0, 1], ...[1, 2, 3, 4].flatMap(col => [[col, 0], [col, 1]])]
  .map(([col, row], index) => ({ id: `p${index}`, workspaceId: "w", taskId: `t${index + 1}`, col, row }));
function fakePages(handOn = true) {
  const asked = [];
  return { asked, waiting: null, has: () => false, reveal: () => false, releaseChat: () => true, register: () => () => {},
    openElsewhere(from, open) { asked.push(plain({ from, ...open })); return handOn; },
    takeOpen() { const open = this.waiting; this.waiting = null; return open; } };
}

test("chat pages: on a full page New chat, Ctrl+Alt+\\ and Open in split view start on another page, never in a chat's place", () => {
  const pages = fakePages();
  const fixture = surfaceComposer({ chatTaskId: "t0", splitMaxCols: 5, splitPanes: tenScreens(), focusedPane: "p3" }, {}, pages);
  const list = () => fixture.walk(fixture.render()).find(item => item.props?.actions?.openSplit);
  const before = plain(fixture.state.splitPanes);
  list().props.actions.newChat();
  assert.deepEqual(pages.asked, [{ from: 1, workspaceId: "w", taskId: "", maxColumns: 5 }], "New chat: to another page");
  assert.deepEqual(plain(fixture.state.splitPanes), before, "no chat on this page made way");
  assert.equal(fixture.state.chatTaskId, "t0");
  list().props.actions.openSplit("w", "t99");
  assert.deepEqual(pages.asked.at(-1), { from: 1, workspaceId: "w", taskId: "t99", maxColumns: 5 }, "Open in split view: the chat goes too");
  assert.deepEqual(plain(fixture.state.splitPanes), before);

  // Below ten screens New chat keeps the user's 2026-10-31 rule: it opens in the focused pane.
  const room = surfaceComposer({ chatTaskId: "t0", splitMaxCols: 5, splitPanes: tenScreens().slice(0, 8), focusedPane: "p3" }, {}, fakePages());
  room.walk(room.render()).find(item => item.props?.actions?.openSplit).props.actions.newChat();
  assert.equal(room.state.splitPanes.find(item => item.id === "p3").taskId, "", "the focused pane shows the new chat");

  // Every page full (or tabs off): it opens here as before.
  const nowhere = surfaceComposer({ chatTaskId: "t0", splitMaxCols: 5, splitPanes: tenScreens(), focusedPane: "p3" }, {}, fakePages(false));
  nowhere.walk(nowhere.render()).find(item => item.props?.actions?.openSplit).props.actions.newChat();
  assert.equal(nowhere.state.splitPanes.find(item => item.id === "p3").taskId, "");
});

test("chat pages: a page takes a handed-on chat once loaded: an unsent screen first, else a free cell, else it passes it on", () => {
  const run = (seed, open, handOn = true) => {
    const pages = fakePages(handOn);
    pages.waiting = open;
    const fixture = surfaceComposer({ loadedWorkspace: "w", splitReady: true, splitMaxCols: 1, ...seed }, {}, pages);
    fixture.render();
    const take = fixture.effects.filter(effect => String(effect).includes("takeOpen"));
    assert.equal(take.length, 1, "one effect takes the waiting chat");
    take[0]();
    return { fixture, pages, panes: () => plain(fixture.state.splitPanes.map(item => [item.taskId, item.col, item.row])) };
  };
  const ask = { workspaceId: "w", taskId: "", maxColumns: 5, tried: [1] };
  const fresh = run({ chatTaskId: "" }, ask);
  assert.equal(fresh.fixture.state.chatTaskId, "", "a new page: its own chat is the new one");
  assert.equal(fresh.fixture.state.focusedPane, "main");
  assert.deepEqual(fresh.pages.asked, []);

  const roomy = run({ chatTaskId: "t0", splitPanes: tenScreens().slice(0, 2) }, ask);
  assert.deepEqual(roomy.panes().at(-1), ["", 2, 0], "a new column, by the sending page's five columns, not this hidden page's one");
  assert.equal(roomy.fixture.state.focusedPane, roomy.fixture.state.splitPanes.at(-1).id);

  const unsent = run({ chatTaskId: "t0", splitPanes: tenScreens().map(item => item.id === "p4" ? { ...item, taskId: "" } : item) },
    { ...ask, taskId: "t99" });
  assert.equal(unsent.fixture.state.splitPanes.find(item => item.id === "p4").taskId, "t99", "the unsent screen shows it");
  assert.equal(unsent.fixture.state.splitPanes.length, 9);

  const full = run({ chatTaskId: "t0", splitPanes: tenScreens() }, ask);
  assert.deepEqual(full.pages.asked, [{ from: 1, ...ask }], "full here too: on to the next page, with the pages tried");
  const last = run({ chatTaskId: "t0", splitPanes: tenScreens() }, ask, false);
  assert.deepEqual(last.panes().at(-1), ["", 4, 1], "nowhere left: the last chat makes way, as before pages");
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

test("mission and chat dropdowns submit the team they display", async t => {
  const teams = ["a", "b"].map((id, index) => ({ id, workspace_id: "w", revision: index ? 9 : 3, name: "Team " + id,
    worker_limit: index ? 2 : 1, nodes: [{ id: id + "-lead", role: "planner", parents: [], settings: {},
      route: { harness_id: "ao:claude-code", model: "cpa/model-" + id } }] }));
  const seed = { team: teams[0], savedTeams: teams, composerTeamId: "a", missionTeamId: "a",
    board: { revision: 1, tasks: [{ id: "existing-task", title: "Existing task" }] } };
  const select = (f, label, root = f.render()) => f.walk(root).find(item => item.type === "select" && item.props["aria-label"] === label);
  const openMission = f => {
    f.currentChat().props.onOpenMissionBoard();
    const open = f.walk(f.render()).find(item => item.type === "button" && item.props.children === "New mission");
    assert.ok(open, "the real New mission button is available"); open.props.onClick();
    select(f, "Mission task").props.onChange({ target: { value: "existing-task" } });
  };
  const submitMission = async f => {
    const form = f.walk(f.render()).find(item => item.type === "form" && item.props["aria-label"] === "New mission");
    let prevented = false; form.props.onSubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); await new Promise(setImmediate);
    return f.calls.find(call => call.operation === "update_run")?.arguments.change;
  };
  for (const mode of ["team", "single"]) await t.test("mission selection is independent of chat " + mode + " mode", async () => {
    const f = surfaceComposer({ ...seed, composerMode: mode }); openMission(f);
    select(f, "Mission team").props.onChange({ target: { value: "b" } });
    assert.equal(select(f, "Mission team").props.value, "b");
    assert.equal(f.state.composerTeamId, "a", "a mission choice leaves the chat choice alone");
    const change = await submitMission(f);
    assert.equal(change.execution_mode, "team"); assert.equal(change.team_id, "b"); assert.equal(change.team_revision, 9);
    assert.equal(change.worker_limit, 2); assert.equal("single_route" in change, false); assert.deepEqual(f.errors, []);
  });
  await t.test("mission defaults to its displayed team and keeps an explicit worker limit", async () => {
    const f = surfaceComposer({ ...seed, composerMode: "single", composerTeamId: "b" }); openMission(f);
    assert.equal(select(f, "Mission team").props.value, "a");
    f.walk(f.render()).find(item => item.type === "input" && item.props.type === "number" && item.props.max === 24)
      .props.onChange({ target: { value: "4" } });
    const change = await submitMission(f);
    assert.equal(change.execution_mode, "team"); assert.equal(change.team_id, "a"); assert.equal(change.team_revision, 3);
    assert.equal(change.worker_limit, 4); assert.equal(f.state.composerTeamId, "b"); assert.deepEqual(f.errors, []);
  });
  await t.test("mission without saved teams follows its visible Single route", async () => {
    const f = surfaceComposer({ ...seed, team: null, savedTeams: [], composerMode: "team" }); openMission(f);
    assert.equal(select(f, "Mission team"), undefined);
    const route = { ...f.state.workerRouteDraft, model: "cpa/picked-fallback" };
    f.walk(f.render()).find(item => item.props.route === f.state.workerRouteDraft && item.props.onChange).props.onChange(route);
    const change = await submitMission(f);
    assert.equal(change.execution_mode, "single"); assert.deepEqual(change.single_route, route); assert.equal(change.worker_limit, 1);
    assert.equal("team_id" in change, false); assert.deepEqual(f.errors, []);
  });
  for (const remaining of [[teams[0]], []]) await t.test("a vanished mission team fails closed with " + remaining.length + " teams left", async () => {
    const f = surfaceComposer({ ...seed, composerMode: "single" }); openMission(f);
    select(f, "Mission team").props.onChange({ target: { value: "b" } }); f.state.savedTeams = remaining;
    assert.equal(await submitMission(f), undefined); assert.match(f.errors.at(-1), /saved team/i);
    assert.equal(f.state.sheet, "mission", "the failed selection remains reviewable");
  });
  await t.test("new chat header and composer share Team selection and intent", async () => {
    const f = surfaceComposer({ ...seed, composerMode: "team" });
    const header = () => select(f, "New chat team", f.currentChat().props.headerExtra);
    header().props.onChange({ target: { value: "b" } });
    let current = f.currentChat(); assert.equal(current.props.composer.teamId, "b"); assert.equal(header().props.value, "b");
    assert.equal(f.state.missionTeamId, "a", "a chat choice leaves the mission choice alone");
    await current.props.send({ message: "Use displayed B" });
    const sent = f.calls.find(call => call.operation === "chat_send").arguments;
    assert.equal(sent.teamId, "b"); assert.equal(sent.teamRevision, 9); assert.equal(sent.executionMode, "team");
    f.state.chatTaskId = ""; current = f.currentChat(); current.props.composer.onTeamChange("a");
    assert.equal(header().props.value, "a", "the canonical picker also updates the header");
    const before = JSON.parse(f.permissionKey()).at(-1); header().props.onChange({ target: { value: "a" } });
    f.currentChat(); assert.equal(JSON.parse(f.permissionKey()).at(-1), before + 1, "even a repeated pick retains the permission intent fence");
  });
  await t.test("Single mode offers no ignored header team choice", async () => {
    const f = surfaceComposer({ ...seed, composerMode: "single" });
    assert.equal(f.currentChat().props.headerExtra, undefined);
    await f.currentChat().props.send({ message: "Keep Single" });
    const sent = f.calls.find(call => call.operation === "chat_send").arguments;
    assert.equal(sent.executionMode, "single"); assert.equal("teamId" in sent, false);
    f.state.chatTaskId = ""; f.currentChat().props.composer.onModeChange("team");
    assert.equal(select(f, "New chat team", f.currentChat().props.headerExtra).props.value, "a");
  });
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
  // The real route helpers: a single route is fitted to its harness on the way out (permissionsFitted).
  const editor = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports: editor, require: () => ({}), structuredClone });
  const surface = loadSurface({}, {}, { "./AgentOrchestratorRoleEditor": editor });
  const route = { harness_id: "ao:claude-code", model: "cpa/gemini-flash", permission_profile: ":ao-default" };
  const teams = [{ id: "saved", workspace_id: "w", revision: 8, nodes: [] }, { id: "elsewhere", workspace_id: "other", revision: 2, nodes: [] }];
  assert.deepEqual(plain(surface.aoChatExecution("single", route, teams, "saved")), { executionMode: "single", singleRoute: route });
  assert.deepEqual(plain(surface.aoChatExecution("team", route, teams, "saved")), { executionMode: "team", teamId: "saved", teamRevision: 8 });
  assert.deepEqual(plain(surface.aoChatExecution("team", route, teams, "elsewhere")), { executionMode: "team", teamId: "elsewhere", teamRevision: 2 },
    "a team saved from another project runs here too");
  assert.throws(() => surface.aoChatExecution("team", route, teams, "deleted"), /saved team/i);
  // 2026-11-10: a Pi chat carried Claude Code's "Approve for me" and every launch and pre-warm was
  // refused ("cannot honor the saved permission tuple"). Pi and opencode take no mode, so none is sent.
  const carried = { native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  for (const harness of ["ao:pi", "ao:opencode"]) {
    assert.deepEqual(plain(surface.aoChatExecution("single", { ...route, harness_id: harness, ...carried }, teams, "")).singleRoute,
      { ...route, harness_id: harness }, `${harness} is sent without a mode it can't honor`);
  }
  assert.deepEqual(plain(surface.aoChatExecution("single", { ...route, ...carried }, teams, "")).singleRoute, { ...route, ...carried },
    "Claude Code keeps its mode");
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
  const jsx = /^jsx:([^.]+)\.(.+)$/.exec(name);
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) body ??= node.initializer;
    if (jsx && ts.isJsxAttribute(node) && node.name.getText(tree) === jsx[2]
      && node.parent.parent.tagName?.getText(tree) === jsx[1]) body ??= node.initializer?.expression;
    const hook = name.startsWith("layout:") ? "useLayoutEffect" : "useEffect";
    if ((name.startsWith("effect:") || name.startsWith("layout:")) && ts.isCallExpression(node) && node.expression.getText(tree) === hook
      && node.arguments[0]?.getText(tree).includes(name.slice(7))) body ??= node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(body, name);
  const exports = {};
  const context = { exports, pane: undefined, paneWanted: { current: null }, pageRegistry: null, pageNumber: 1, initialPageSelection: null, ...globals };
  if (file === "AgentOrchestratorSurface.tsx" && name !== "takeChatHere" && !("takeChatHere" in globals)) {
    context.takeChatHere = rendererCallback(file, "takeChatHere", globals);
  }
  vm.runInNewContext(ts.transpileModule("exports.callback = " + body.getText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return exports.callback;
}
const delayedReply = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

for (const changedWhileSaving of [false, true]) test(`markup replacement preserves eight attachments${changedWhileSaving ? " after another attachment changes during saving" : ""}`, async () => {
  const initial = Array.from({ length: 8 }, (_, index) => ({ name: `image-${index}.png`, path: `G:/fixtures/image-${index}.png`, image: true, preview: `blob:image-${index}` }));
  const source = initial[3], saved = delayedReply(), updates = [], saves = [];
  const result = { bytes: new Uint8Array([1]), preview: "blob:marked-image", prompt: "Marked instructions" };
  let current = initial;
  const composing = { current: { taskId: "task", cacheKey: "draft", attachments: current } };
  const setAttachments = update => { updates.push(update); current = update(current); composing.current.attachments = current; };
  const addMarkup = rendererCallback("AgentOrchestratorChat.tsx", "addMarkup", {
    useCallback: callback => callback, setAttachments, saver: { current: input => { saves.push(input); return saved.promise; } },
    draftKey: "draft", selectedTaskId: "task",
    flushSync: callback => callback(), composing, alive: { current: true }, CHAT_DRAFTS: new Map([["draft", { attaching: false }]]),
  });
  const onMarkup = rendererCallback("AgentOrchestratorChat.tsx", "jsx:ImagePreviewDialog.onMarkup", {
    saveAttachment: true, attachments: initial, previewing: 3, addMarkup, setAttachments,
  });
  const submitting = onMarkup(result);
  try {
    assert.equal(saves.length, 1);
    assert.equal(saves[0].bytes, result.bytes);
    assert.equal(updates.length, 0, "saving must succeed before changing the attachment list");
    if (changedWhileSaving) {
      current = [...initial.slice(1), { name: "new-file.txt", path: "G:/fixtures/new-file.txt" }];
      composing.current.attachments = current;
    }
    const others = current.filter(item => item !== source);
    saved.resolve({ path: "G:/fixtures/markup.png" });
    await submitting;
    assert.equal(current.length, 8, "replace the original before applying the eight-attachment limit");
    assert.equal(updates.length, 1, "replacement is one atomic functional state update");
    assert.equal(current.includes(source), false);
    for (const item of others) assert.equal(current.filter(value => value === item).length, 1, "every other attachment stays exactly once");
    assert.deepEqual(plain(current.filter(item => item.name === "Markup")), [{ name: "Markup", path: "G:/fixtures/markup.png", image: true, preview: result.preview, markup: result.prompt }]);
  } finally { saved.resolve({ path: "G:/fixtures/markup.png" }); await Promise.allSettled([submitting]); }
});

// The image preview's tools (Codex's Remove BG, Erase, Resize) land in the chat box under their own
// names with Codex's instruction; Erase's mask follows its image as the second one, as Codex sends it.
test("an image tool's result lands under its own name, and Erase's mask follows as a second image", async () => {
  const saves = [];
  let current = [{ name: "shot.png", path: "G:/fixtures/shot.png", image: true, preview: "blob:shot" }];
  const composing = { current: { taskId: "task", cacheKey: "draft", attachments: current } };
  const addMarkup = rendererCallback("AgentOrchestratorChat.tsx", "addMarkup", {
    useCallback: callback => callback, setAttachments: update => { current = update(current); composing.current.attachments = current; },
    draftKey: "draft", selectedTaskId: "task",
    saver: { current: async input => { saves.push(input.name); return { path: `G:/fixtures/${input.name}` }; } },
    flushSync: callback => callback(), composing, alive: { current: true }, CHAT_DRAFTS: new Map([["draft", { attaching: false }]]),
  });
  await addMarkup({ bytes: new Uint8Array([1]), preview: "blob:image", prompt: "Remove the area marked in the second image from the first image",
    label: "Erase", mask: { bytes: new Uint8Array([2]), preview: "blob:mask" } }, current[0]);
  assert.deepEqual(saves, ["markup.png", "mask.png"]);
  assert.deepEqual(plain(current), [
    { name: "Erase", path: "G:/fixtures/markup.png", image: true, preview: "blob:image", markup: "Remove the area marked in the second image from the first image" },
    { name: "Mask", path: "G:/fixtures/mask.png", image: true, preview: "blob:mask" },
  ], "the image it was opened from is replaced; the mask carries no instruction of its own");
});

for (const [label, count, sourceIndex, allowed] of [
  ["eight pending attachments", 8, 3, false],
  ["seven pending attachments without a source", 7, null, false],
  ["seven pending attachments replacing one", 7, 3, true],
  ["another image before its source", 2, 1, true],
]) test(`image tools admit the Erase pair atomically: ${label}`, async () => {
  const initial = Array.from({ length: count }, (_, index) => ({ name: `image-${index}.png`, path: `G:/fixtures/image-${index}.png`, image: true }));
  let current = initial;
  const source = sourceIndex === null ? undefined : initial[sourceIndex], saves = [];
  const composing = { current: { taskId: "task", cacheKey: "draft", attachments: current } };
  const addMarkup = rendererCallback("AgentOrchestratorChat.tsx", "addMarkup", {
    useCallback: callback => callback, flushSync: callback => callback(), composing, alive: { current: true },
    draftKey: "draft", selectedTaskId: "task",
    CHAT_DRAFTS: new Map([["draft", { attaching: false }]]),
    setAttachments: update => { current = update(current); composing.current.attachments = current; },
    saver: { current: async input => { saves.push(input.name); return { path: `G:/fixtures/${input.name}` }; } },
  });
  const submitting = addMarkup({ bytes: new Uint8Array([1]), preview: "blob:erase", prompt: "Erase instructions", label: "Erase",
    mask: { bytes: new Uint8Array([2]), preview: "blob:mask" } }, source);
  if (!allowed) {
    await assert.rejects(submitting, /8 attachments/i);
    assert.deepEqual(saves, [], "capacity is checked before saving either image");
    assert.equal(current, initial, "the draft retains every original attachment");
    return;
  }
  await submitting;
  const others = initial.filter(item => item !== source);
  assert.deepEqual(plain(current), [
    { name: "Erase", path: "G:/fixtures/markup.png", image: true, preview: "blob:erase", markup: "Erase instructions" },
    { name: "Mask", path: "G:/fixtures/mask.png", image: true, preview: "blob:mask" },
    ...others,
  ], "the instructed first and second images stay together before all unrelated attachments");
  for (const item of others) assert.equal(current.filter(value => value === item).length, 1);
});

for (const change of ["capacity", "upload before saving", "upload during saving", "task", "cache", "source", "unmount"]) {
  test(`image tools reject a stale or busy draft: ${change}`, async () => {
    const initial = Array.from({ length: change === "capacity" ? 7 : 1 }, (_, index) => ({ name: `image-${index}.png`, path: `G:/fixtures/image-${index}.png`, image: true }));
    let current = initial;
    const source = initial[0], saved = delayedReply(), saves = [];
    const composing = { current: { taskId: "task", cacheKey: "draft", attachments: current } };
    const alive = { current: true }, draft = { attaching: change === "upload before saving" };
    const addMarkup = rendererCallback("AgentOrchestratorChat.tsx", "addMarkup", {
      useCallback: callback => callback, flushSync: callback => callback(), composing, alive, CHAT_DRAFTS: new Map([["draft", draft]]),
      draftKey: "draft", selectedTaskId: "task",
      setAttachments: update => { current = update(current); composing.current.attachments = current; },
      saver: { current: input => {
        saves.push(input.name);
        return saves.length === 1 && change !== "upload before saving" ? saved.promise : Promise.resolve({ path: `G:/fixtures/${input.name}` });
      } },
    });
    const submitting = addMarkup({ bytes: new Uint8Array([1]), preview: "blob:erase", prompt: "Erase instructions", label: "Erase",
      mask: { bytes: new Uint8Array([2]), preview: "blob:mask" } }, source);
    try {
      if (change !== "upload before saving") assert.equal(saves.length, 1);
      if (change === "capacity") {
        current = [...current, { name: "new-file.txt", path: "G:/fixtures/new-file.txt" }];
        composing.current.attachments = current;
      } else if (change === "upload during saving") draft.attaching = true;
      else if (change === "task" || change === "cache") {
        current = [{ name: "other-chat.txt", path: "G:/fixtures/other-chat.txt" }];
        composing.current = { ...composing.current, [change === "task" ? "taskId" : "cacheKey"]: "other", attachments: current };
      } else if (change === "source") {
        current = [];
        composing.current.attachments = current;
      } else if (change === "unmount") alive.current = false;
      const latest = current;
      saved.resolve({ path: "G:/fixtures/markup.png" });
      await assert.rejects(submitting, change === "capacity" ? /8 attachments/i : change.startsWith("upload") ? /files.*finish/i : /chat.*changed/i);
      assert.equal(current, latest, "the latest draft is never truncated or given this image pair");
      if (change === "upload before saving") assert.deepEqual(saves, [], "an upload already in progress is refused before saving");
    } finally { saved.resolve({ path: "G:/fixtures/markup.png" }); await Promise.allSettled([submitting]); }
  });
}

for (const change of ["taskId", "cacheKey", "source"]) test(`image tools reject stale preview ownership before saving: ${change}`, async () => {
  const source = { name: "source.png", path: "G:/fixtures/source.png", image: true }, initial = [], saves = [];
  let current = initial;
  const composing = { current: { taskId: "task", cacheKey: "draft", attachments: current, ...(change === "source" ? {} : { [change]: "other" }) } };
  const addMarkup = rendererCallback("AgentOrchestratorChat.tsx", "addMarkup", {
    useCallback: callback => callback, flushSync: callback => callback(), composing, alive: { current: true },
    draftKey: "draft", selectedTaskId: "task", CHAT_DRAFTS: new Map([["draft", { attaching: false }]]),
    setAttachments: update => { current = update(current); },
    saver: { current: async input => { saves.push(input.name); return { path: `G:/fixtures/${input.name}` }; } },
  });
  await assert.rejects(addMarkup({ bytes: new Uint8Array([1]), preview: "blob:marked", prompt: "Instructions" }, change === "source" ? source : undefined), /chat.*changed/i);
  assert.deepEqual(saves, []);
  assert.equal(current, initial, "a preview's old callback never adopts its image into this draft");
});

test("a split pane acknowledges parent selection before reporting its own chat, then reports its first send", () => {
  for (const requested of [{ workspaceId: "ws", taskId: "" }, { workspaceId: "ws", taskId: "task-b" }, { workspaceId: "other", taskId: "task-b" }]) {
    let parent = { ...requested };
    const reports = [];
    const state = { workspaceId: "ws", chatTaskId: "old-task", loadedWorkspace: "ws" };
    const paneWanted = { current: { workspaceId: "ws", taskId: "old-task" } };
    const paneSelectionPending = { current: false };
    const effects = () => {
      const globals = { ...state, paneWanted, paneSelectionPending,
        pane: { ...parent, onChat: (workspaceId, taskId) => { reports.push([workspaceId, taskId]); parent = { workspaceId, taskId }; } },
        switchToWorkspace: workspaceId => { state.workspaceId = workspaceId; state.chatTaskId = null; },
        selectChat: taskId => { state.chatTaskId = taskId; }, startNewChat: () => { state.chatTaskId = ""; },
      };
      return {
        apply: rendererCallback("AgentOrchestratorSurface.tsx", "effect:paneWanted.current = { workspaceId: pane.workspaceId", globals),
        report: rendererCallback("AgentOrchestratorSurface.tsx", "effect:pane.onChat(workspaceId, chatTaskId)", globals),
      };
    };
    // A parent selection and a completed workspace read can share a commit. Both effects still
    // see the old child selection, even after the first effect schedules its state update.
    const first = effects();
    first.apply(); first.report();
    assert.deepEqual(parent, requested, "the old child cannot overwrite the parent request");
    assert.deepEqual(reports, []);
    assert.deepEqual(plain(paneWanted.current), requested);

    state.workspaceId = requested.workspaceId; state.loadedWorkspace = requested.workspaceId;
    state.chatTaskId = requested.taskId;
    effects().report();
    assert.deepEqual(parent, requested, "an applied new draft or existing chat stays selected");
    assert.deepEqual(reports, []);

    state.chatTaskId = "first-send";
    effects().report();
    assert.deepEqual(parent, { workspaceId: requested.workspaceId, taskId: "first-send" });
    assert.deepEqual(reports, [[requested.workspaceId, "first-send"]], "the child's own new chat still reaches the parent");
    effects().apply(); // The parent's acknowledgement already matches the child; it must not wait again.
    state.chatTaskId = "second-send";
    effects().report();
    assert.deepEqual(parent, { workspaceId: requested.workspaceId, taskId: "second-send" });
  }
});

test("blank chat drafts and files stay with their pane and project across Board roundtrips", () => {
  const maps = { CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(), CHAT_ANNOTATIONS: new Map() };
  const scopes = [["project-a", "main"], ["project-a", "right"], ["project-b", "main"]];
  const keys = scopes.map(([projectId, draftScope]) => rendererCallback("AgentOrchestratorChat.tsx", "draftKey", { selectedTaskId: "", projectId, draftScope }));
  assert.equal(rendererCallback("AgentOrchestratorChat.tsx", "draftKey", { selectedTaskId: "saved-task", projectId: "project-b", draftScope: "right" }), "saved-task");
  const files = scopes.map((_, index) => [{ path: `G:/fixture-${index}.png`, preview: `blob:fixture-${index}` }]);
  for (const [index, key] of keys.entries()) {
    const ui = queuedComposer([], maps, { taskId: "", blankKey: key }); ui.mount();
    assert.equal(ui.state.draft, "", "another new composer starts empty");
    ui.state.attachments = files[index]; ui.type(`Draft ${index}`); ui.unmount();
  }
  for (const [index, key] of keys.entries()) {
    const ui = queuedComposer([], maps, { taskId: "", blankKey: key }); ui.mount();
    assert.equal(ui.state.draft, `Draft ${index}`); assert.equal(ui.state.attachments, files[index]); ui.unmount();
  }
  const ui = queuedComposer([], maps, { taskId: "", blankKey: keys[0] }); ui.mount(); ui.type("Updated first draft"); ui.moveTo("", keys[2]);
  assert.equal(ui.state.draft, "Draft 2"); assert.equal(ui.state.attachments, files[2]);
  assert.equal(maps.CHAT_DRAFTS.get(keys[0]).snapshot.text, "Updated first draft"); assert.equal(maps.CHAT_DRAFTS.has(""), false); ui.unmount();
});

test("unsent chat text, attachments and annotations survive unmount and remount", () => {
  const selectedTaskId = "draft-navigation", attachments = [{ path: "G:/fixture.png", preview: "blob:fixture" }], annotations = [{ id: 1, text: "Selected words" }];
  const maps = { CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(), CHAT_ANNOTATIONS: new Map() };
  const ui = queuedComposer([], maps, { taskId: selectedTaskId }); ui.mount(); ui.state.attachments = attachments; ui.state.annotations = annotations; ui.type("Unfinished message"); ui.unmount();
  assert.equal(maps.CHAT_DRAFTS.get(selectedTaskId).snapshot.text, "Unfinished message");
  assert.equal(maps.CHAT_ATTACHMENTS.get(selectedTaskId), attachments);
  const fresh = queuedComposer([], maps, { taskId: selectedTaskId }); fresh.mount();
  assert.equal(fresh.state.draft, "Unfinished message"); assert.equal(fresh.state.attachments, attachments); assert.equal(fresh.state.annotations, annotations);
  fresh.state.attachments = []; fresh.state.annotations = []; fresh.type(""); fresh.unmount();
  assert.equal(maps.CHAT_DRAFTS.has(selectedTaskId), false, "an empty composer cannot resurrect old text");
  assert.equal(maps.CHAT_ATTACHMENTS.has(selectedTaskId), false);
  assert.equal(maps.CHAT_ANNOTATIONS.has(selectedTaskId), false);
});

test("a chat switch preserves its restored draft if unmount wins the queued state render", () => {
  for (const taskId of ["task-b", ""]) {
    const previousKey = taskId ? "task-a" : JSON.stringify(["new", "project-a", "main"]);
    const draftKey = taskId || JSON.stringify(["new", "project-b", "main"]);
    const oldFiles = [{ path: "G:/old.png" }], files = [{ path: "G:/restored.png" }], annotations = [{ id: 1, text: "Restored quote" }];
    const maps = { CHAT_DRAFTS: new Map([[draftKey, { snapshot: { text: "Restored draft" }, pending: [] }]]), CHAT_ATTACHMENTS: new Map([[draftKey, files]]), CHAT_ANNOTATIONS: new Map([[draftKey, annotations]]) };
    const ui = queuedComposer([], maps, { taskId: taskId ? previousKey : "", blankKey: previousKey }); ui.mount(); ui.state.attachments = oldFiles; ui.type("Previous draft");
    // The real handoff schedules restored state, but cleanup runs before any of it commits.
    ui.deferDraft(true); ui.moveTo(taskId, draftKey); assert.equal(ui.state.draft, "Previous draft"); ui.unmount();
    assert.equal(maps.CHAT_DRAFTS.get(previousKey).snapshot.text, "Previous draft");
    assert.equal(maps.CHAT_DRAFTS.get(draftKey).snapshot.text, "Restored draft", "unmount keeps the newly restored draft");
    assert.equal(maps.CHAT_ATTACHMENTS.get(draftKey), files);
    assert.equal(maps.CHAT_ANNOTATIONS.get(draftKey), annotations);
    assert.equal(ui.composing.current.taskId, taskId); assert.equal(ui.composing.current.cacheKey, draftKey);
  }
});

test("chat attachment previews stay alive while another draft keeps them", () => {
  const freed = [], shownPreviews = { current: new Set(["blob:kept", "blob:pending", "blob:removed"]) };
  rendererCallback("AgentOrchestratorChat.tsx", "effect:const now = new Set([...attachments", {
    attachments: [], preparing: [], shownPreviews, CHAT_DRAFTS: new Map([["saving-chat", { preparing: [{ preview: "blob:pending" }] }]]),
    CHAT_ATTACHMENTS: new Map([["other-chat", [{ preview: "blob:kept" }]]]), freePreview: value => freed.push(value),
  })();
  assert.deepEqual(freed, ["blob:removed"]);
});

test("an unsent split chat can switch projects and finish choosing its new chat", () => {
  const paneWanted = { current: { workspaceId: "old-project", taskId: "" } };
  const paneSelectionPending = { current: true };
  const state = { workspaceId: "old-project", taskId: null };
  const pendingSelect = { current: null };
  const choose = rendererCallback("AgentOrchestratorSurface.tsx", "chooseWorkspace", {
    pane: { workspaceId: "old-project", taskId: "" }, paneWanted, pendingSelect,
    switchTarget: { current: "" },
    switchToWorkspace: id => { state.workspaceId = id; state.taskId = null; },
  });
  choose("new-project");
  const decide = rendererCallback("AgentOrchestratorSurface.tsx", "effect:const wanted = paneWanted.current", {
    pane: { workspaceId: "new-project", taskId: "" },
    chatTaskId: null, workspaceId: state.workspaceId, loadedWorkspace: "new-project",
    board: { tasks: [] }, boardWorkspace: { current: "new-project" }, paneWanted, paneSelectionPending, pendingSelect,
    missions: [], taskLifecycle: [], chatSeed: { workspaceId: "new-project", text: "Keep my draft" },
    chatList: chat.chatList, setChatTaskId: id => { state.taskId = id; }, setView() {}, setSelectedRunId() {},
  });
  decide();
  assert.equal(state.taskId, "", "the pane resolves its new chat so it can accept input and notify its parent");
  assert.equal(paneWanted.current.workspaceId, "new-project");
  const reports = [];
  rendererCallback("AgentOrchestratorSurface.tsx", "effect:pane.onChat(workspaceId, chatTaskId)", {
    pane: { workspaceId: "old-project", taskId: "", onChat: (...selection) => reports.push(selection) },
    workspaceId: state.workspaceId, chatTaskId: state.taskId, loadedWorkspace: "new-project", paneWanted, paneSelectionPending,
  })();
  assert.deepEqual(reports, [["new-project", ""]], "the resolved project choice is still reported to the parent");
});

function workspaceRecovery({ hidden = false, selected = "p3" } = {}) {
  let isHidden = hidden, timerId = 0;
  const focus = new Set(), visibility = new Set(), timers = new Map(), replies = [];
  const state = { workspaces: [], workspaceId: selected, ready: false, sheet: "", errors: [] };
  const set = key => value => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:listAllWorkspaces", {
    Error, listAllWorkspaces: () => { const reply = delayedReply(); replies.push(reply); return reply.promise; },
    surfaceHidden: () => isHidden, setWorkspaces: set("workspaces"), setWorkspaceId: set("workspaceId"),
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
      chatRun: async (_task, action) => action(), aoChatExecution: () => ({}), executableArg: () => ({}),
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

test("sendChat bypasses unrelated surface work but rejects a duplicate while its chat owns the send", async () => {
  const pending = delayedReply(), calls = [];
  const chatBusyIds = { current: new Set(["other-chat"]) };
  const chatRun = rendererCallback("AgentOrchestratorSurface.tsx", "chatRun", { chatBusyIds, setChatBusy() {}, setError() {} });
  const send = rendererCallback("AgentOrchestratorSurface.tsx", "sendChat", {
    busy: "refresh", workspaceId: "ws", selection: { current: { workspaceId: "ws", taskId: "mine" } }, mounted: { current: true },
    boardWorkspace: { current: "ws" }, board: { tasks: [{ id: "mine" }] }, chatRun,
    composerMode: "single", singleRoute: { model: "fixture" }, savedTeams: [], composerTeamId: "",
    aoChatExecution: () => ({}), executableArg: () => ({}),
    moduleCall: (operation, args) => { calls.push({ operation, args }); return pending.promise; },
    startNotice: () => "", loadBoard: async () => {}, loadMissions: async () => {},
    setMissions() {}, setBoard() {}, setPendingChat() {}, setChatTaskId() {}, setSelectedRunId() {}, setChatNotices() {}, setAutoStatus() {}, setError() {},
    sendRefusedForNow: () => false,
  });
  const sending = send({ taskId: "mine", message: "no refresh wait" });
  assert.equal(calls.length, 1, "an unrelated action never delays the chat_send call");
  assert.equal(calls[0].operation, "chat_send");
  assert.equal(calls[0].args.deferStart, true, "run startup still happens behind normal backend authorization");
  await assert.rejects(send({ taskId: "mine", message: "duplicate" }), /still updating/);
  assert.equal(calls.length, 1, "the synchronous per-chat guard prevents a duplicate dispatch");
  pending.resolve({ ok: true, taskId: "mine", runId: "mine-run", status: "starting" });
  await sending;
  await new Promise(setImmediate);
  assert.equal(chatBusyIds.current.has("mine"), false);
  assert.equal(chatBusyIds.current.has("other-chat"), true, "another chat's ownership is not released");
});

function outgoingSend() {
  const attachments = [], annotations = [], composing = { current: null }, state = { outgoing: null, draft: "", recovered: [] };
  const set = key => next => { state[key] = typeof next === "function" ? next(state[key]) : next; };
  const scope = projectId => rendererCallback("AgentOrchestratorChat.tsx", "draftKey", { selectedTaskId: "", projectId, draftScope: "main" });
  return { state, composing, scope,
    shown(projectId) { return rendererCallback("AgentOrchestratorChat.tsx", "shownDescription", {
      useMemo: read => read(), outgoing: state.outgoing, selectedTaskId: "", savedDescription: undefined, draftKey: scope(projectId),
    }); },
    start(projectId, message) {
      const reply = delayedReply(); state.draft = message;
      composing.current = { taskId: "", cacheKey: scope(projectId), draft: message, snapshot: { text: message }, attachments, annotations };
      const deliver = rendererCallback("AgentOrchestratorChat.tsx", "deliver", {
        selectedTaskId: "", draft: message, attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
        setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: () => reply.promise,
        setDraft: set("draft"), setTitle() {}, setAttachments() {}, setAttachNote() {}, setAtBottom() {}, followBottom() {}, setCarried() {},
        setOutgoing: set("outgoing"), setAnnotations() {},
        // A failed send the composer did not take back goes back to its own draft (recoverMessage).
        recoverMessage: (cacheKey, text, error) => { state.recovered.push({ cacheKey, text, error: String(error?.message ?? error) }); },
      });
      return { ...reply, done: deliver(message) };
    },
  };
}

test("the real project picker cannot carry a pending message into another blank project's scoped composer", async () => {
  const ui = outgoingSend(), sending = ui.start("project-a", "A's pending message");
  assert.equal(ui.shown("project-a"), "A's pending message");
  const callback = (file, property, contains, globals) => {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression;
    const visit = node => { if (ts.isJsxAttribute(node) && node.name.getText(tree) === property && node.initializer?.getText(tree).includes(contains)) expression ??= node.initializer.expression; ts.forEachChild(node, visit); };
    visit(tree); assert.ok(expression); const exports = {};
    vm.runInNewContext(ts.transpileModule("exports.callback = " + expression.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, ...globals });
    return exports.callback;
  };
  const parent = { workspaceId: "project-a", taskId: "", seed: null };
  const switchToWorkspace = rendererCallback("AgentOrchestratorSurface.tsx", "switchToWorkspace", {
    composerIntent: { current: 0 }, setWorkspaceId: id => { parent.workspaceId = id; }, setChatTaskId: id => { parent.taskId = id; }, pane: undefined, localStorage: { setItem() {} },
  });
  const chooseWorkspace = rendererCallback("AgentOrchestratorSurface.tsx", "chooseWorkspace", {
    switchTarget: { current: "" }, pendingSelect: { current: null }, pane: undefined, switchToWorkspace,
  });
  const onPickProject = callback("AgentOrchestratorSurface.tsx", "onPickProject", "setChatSeed", {
    crypto: { randomUUID: () => "seed" }, chooseWorkspace, setChatSeed: seed => { parent.seed = seed; },
  });
  callback("AgentOrchestratorChat.tsx", "onClick", "onPickProject?.(item.id", {
    item: { id: "project-b" }, projectId: "project-a", title: "", draft: ui.state.draft, setProjectPicker() {}, onPickProject,
  })();
  assert.equal(parent.workspaceId, "project-b"); assert.equal(parent.seed.workspaceId, "project-b"); assert.equal(parent.taskId, null);
  assert.notEqual(ui.scope(parent.workspaceId), ui.scope("project-a"));
  assert.equal(ui.shown(parent.workspaceId), undefined, "the old send belongs only to its original project and pane");
  sending.resolve(); assert.equal(await sending.done, true);
});

test("overlapping deliver callbacks change only their own optimistic message", async t => {
  // A lower-level ownership invariant: ordinary submit/queue/busy gates still prevent a second send.
  for (const outcome of ["resolve", "reject"]) await t.test(outcome, async () => {
    const ui = outgoingSend(), first = ui.start("project-a", "A"), second = ui.start("project-b", "B"), ownB = ui.state.outgoing;
    first[outcome](outcome === "reject" ? new Error("A failed") : undefined); const completed = await first.done;
    if (outcome === "resolve") assert.equal(completed, true);
    // A's failed send, made while B's composer was open, goes back to A's own draft with why (it was lost).
    assert.deepEqual(ui.state.recovered.map(entry => ({ ...entry })), outcome === "reject"
      ? [{ cacheKey: ui.scope("project-a"), text: "A", error: "A failed" }] : []);
    assert.equal(ui.state.outgoing, ownB); assert.equal(ui.state.outgoing.sent, false);
    second.resolve(); assert.equal(await second.done, true); assert.equal(ui.state.outgoing.message, "B"); assert.equal(ui.state.outgoing.sent, true);
  });
});

// 2026-11-09: ten split chats polling a saturated disk turned a follow-up away before it was sent
// ("HEADLESS_CAPACITY: request admission is full"), shown as a "Something went wrong" toast.
test("a message the local service had no room for waits in its chat's queue; a new chat's comes back to the composer", async () => {
  const FULL = "IPC_TRANSPORT_FAILED: apps.call failed: HEADLESS_CAPACITY: request admission is full (the launcher's queue did not clear in time)";
  assert.equal(chat.sendRefusedForNow(new Error(FULL)), "full");
  assert.equal(chat.sendRefusedForNow(new Error("Headless launcher queue is full; wait for pending work to finish")), "full");
  assert.equal(chat.sendRefusedForNow(new Error("This chat is still running; wait for it to finish or stop it first")), "busy");
  assert.equal(chat.sendRefusedForNow("Messages are sent only from the focused app window"), "unfocused");
  assert.equal(chat.sendRefusedForNow(new Error("IPC_TRANSPORT_FAILED: apps.call failed: Headless request timed out")), "",
    "a request that timed out once sent may have gone through: it is never sent again by itself");
  for (const taskId of ["task-1", ""]) {
    const attachments = [], annotations = [], queued = [], state = { outgoing: null, draft: "also add tests" };
    const composing = { current: { taskId, cacheKey: `scope-${taskId}`, draft: "also add tests", snapshot: { text: "also add tests" }, attachments, annotations } };
    const deliver = rendererCallback("AgentOrchestratorChat.tsx", "deliver", {
      selectedTaskId: taskId, draft: state.draft, attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
      setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: async () => { throw new Error(FULL); },
      sendRefusedForNow: chat.sendRefusedForNow, enqueue: async (task, item, front) => { queued.push([task, item.message, front]); },
      // The composer's own copy follows what is typed, as the component's effect keeps it.
      setDraft: next => { state.draft = next; composing.current = { ...composing.current, draft: next }; },
      setOutgoing: next => { state.outgoing = typeof next === "function" ? next(state.outgoing) : next; },
      setTitle() {}, setAttachments() {}, setAttachNote() {}, setAtBottom() {}, followBottom() {}, setCarried() {}, setAnnotations() {},
    });
    const sent = await deliver("also add tests");
    assert.equal(state.outgoing, null, taskId);
    if (taskId) {
      assert.equal(sent, true);
      assert.deepEqual(queued, [["task-1", "also add tests", true]], "it waits at the front of the chat's queue");
      assert.equal(state.draft, "", "it left the composer for the queue");
    } else {
      assert.equal(sent, false);
      assert.deepEqual(queued, [], "a new chat has no queue");
      assert.equal(state.draft, "also add tests", "it comes back to be sent again");
    }
  }
});

test("retiring an earlier optimistic message preserves its replacement", () => {
  const outgoing = { taskId: "", cacheKey: "old", message: "A", sent: true }, replacement = { taskId: "", cacheKey: "new", message: "B", sent: false };
  let current = replacement;
  const retire = rendererCallback("AgentOrchestratorChat.tsx", "effect:if (!outgoing?.sent)", {
    outgoing, descriptions: {}, setOutgoing: next => { current = typeof next === "function" ? next(current) : next; },
  });
  retire(); assert.equal(current, replacement);
});

test("send completion preserves the next chat's draft and edits typed during the pending send", async () => {
  for (const taskId of ["task-b", "task-a"]) {
    const reply = delayedReply(), attachments = [], annotations = [], composing = { current: { taskId: "task-a", draft: "sent text", snapshot: { text: "sent text" }, attachments, annotations } };
    const state = { draft: "sent text" }, set = key => value => { state[key] = value; };
    const deliver = rendererCallback("AgentOrchestratorChat.tsx", "deliver", {
      selectedTaskId: "task-a", draft: "sent text", attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
      setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: () => reply.promise,
      setDraft: set("draft"), setTitle() {}, setAttachments() {}, setAttachNote() {}, setAtBottom() {}, followBottom() {}, setCarried() {},
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

test("a pending new-chat send keeps its real API identity and leaves the next project's composer alone", async () => {
  const reply = delayedReply(), attachments = [], annotations = [], calls = [];
  const composing = { current: { taskId: "", cacheKey: "project-a/main", draft: "sent text", snapshot: { text: "sent text" }, attachments, annotations } };
  const state = { draft: "sent text", title: "First project" };
  const deliver = rendererCallback("AgentOrchestratorChat.tsx", "deliver", {
    selectedTaskId: "", draft: "sent text", attachments, composing, alive: { current: true }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
    setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: input => { calls.push(input); return reply.promise; },
    setDraft: value => { state.draft = value; }, setTitle: value => { state.title = value; }, setAttachments() {}, setAttachNote() {}, setAtBottom() {}, followBottom() {}, setCarried() {},
    setOutgoing() {}, setAnnotations() {},
  });
  const sending = deliver("sent text");
  state.draft = "Next project's draft"; state.title = "Next project";
  composing.current = { taskId: "", cacheKey: "project-b/main", draft: state.draft, attachments, annotations };
  reply.resolve(); assert.equal(await sending, true);
  assert.equal(state.draft, "Next project's draft");
  assert.equal(state.title, "Next project");
  assert.equal(calls[0].taskId, undefined, "a new chat is sent without a synthetic cache identity");
  assert.equal(calls[0].message, "sent text");
});

function queuedComposer(attachments = [], sharedMaps, options = {}) {
  const maps = sharedMaps ?? { CHAT_DRAFTS: new Map([["task-b", { snapshot: { text: "B private draft" }, pending: [] }]]), CHAT_ATTACHMENTS: new Map([["task-b", [{ path: "G:/b.txt" }]]]), CHAT_ANNOTATIONS: new Map([["task-b", [{ text: "B annotation" }]]]) };
  let blankKey = options.blankKey, taskId = options.taskId ?? "task-a";
  const key = () => state.taskId || blankKey;
  const initial = name => rendererCallback("AgentOrchestratorChat.tsx", name, { ...maps, draftKey: taskId || blankKey, useState: value => [typeof value === "function" ? value() : value, () => {}] })[0];
  const state = { taskId, draft: sharedMaps ? initial("[draft, setDraft]") : "A queued message", attachments: sharedMaps ? initial("[attachments, setAttachments]") : attachments, annotations: sharedMaps ? initial("[annotations, setAnnotations]") : [], card: null }, calls = [], waiting = [];
  const alive = { current: true }, draftOwner = { current: key() }, draftRegistration = { current: null }, composing = { current: { taskId, cacheKey: key(), draft: state.draft, snapshot: maps.CHAT_DRAFTS.get(key())?.snapshot ?? { text: state.draft }, attachments: state.attachments, annotations: state.annotations, queuedRecovery: [] } };
  let defer = false, deferDraft = false, replayUpdaters = false, lateSetters = 0, releaseDraft;
  const set = key => next => { if (!alive.current) lateSetters++; const apply = () => { if (replayUpdaters && typeof next === "function") next(state[key]); state[key] = typeof next === "function" ? next(state[key]) : next; }; if (defer || (deferDraft && key !== "taskId")) waiting.push(apply); else apply(); };
  const helpers = { draftEntry: rendererCallback("AgentOrchestratorChat.tsx", "draftEntry", maps), trimDraftEntry: rendererCallback("AgentOrchestratorChat.tsx", "trimDraftEntry", maps) };
  const globals = () => ({ ...maps, ...helpers, releaseDraft, composing, draftOwner, draftRegistration, alive, queueRecoveries: composing.current.queuedRecovery ?? [], selectedTaskId: state.taskId, draftKey: key(), draft: state.draft, attachments: state.attachments, annotations: state.annotations,
    setDraft: set("draft"), setAttachments: set("attachments"), setAnnotations: set("annotations"), setAttachmentWork() {}, setAttachNote() {}, setCard: set("card") });
  releaseDraft = rendererCallback("AgentOrchestratorChat.tsx", "releaseDraft", globals());
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8"), tree = ts.createSourceFile("Chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let assignment; const find = node => { if (ts.isExpressionStatement(node) && node.getText(tree).startsWith("composing.current =") && node.getText(tree).includes("draftOwner.current")) assignment ??= node; ts.forEachChild(node, find); }; find(tree);
  const renderSnapshot = () => {
    vm.runInNewContext(ts.transpileModule(assignment.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, globals());
    rendererCallback("AgentOrchestratorChat.tsx", "effect:registration.entry.snapshot", globals())();
  };
  const selectChat = rendererCallback("AgentOrchestratorSurface.tsx", "selectChat", { switchTarget: { current: "" }, pendingSelect: { current: null }, pendingChat: null,
    workspaceId: "project", composerIntent: { current: 0 },
    setPendingChat() {}, setSheet() {}, setInspectedId() {}, setDraftTeam() {}, setConfigStatus() {}, setView() {}, setChatTaskId: set("taskId"), chatUnread: [],
    chatList: chat.chatList, missions: [], board: { tasks: [] }, taskLifecycle: [], setSelectedRunId() {} });
  const showChat = rendererCallback("AgentOrchestratorSurface.tsx", "showChat", { paneShowing: () => undefined, focusedSplit: null, workspaceId: "project", selectChat });
  const rowSource = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatThreadList.tsx"), "utf8"), rowTree = ts.createSourceFile("List.tsx", rowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let click; const findClick = node => { if (ts.isJsxAttribute(node) && node.name.getText(rowTree) === "onClick" && node.initializer?.getText(rowTree).includes("actions.select(chat.taskId)")) click ??= node.initializer.expression; ts.forEachChild(node, findClick); }; findClick(rowTree);
  const moveTo = (taskId, nextBlankKey) => {
    if (nextBlankKey) blankKey = nextBlankKey;
    const exports = {}; vm.runInNewContext(ts.transpileModule("exports.click = " + click.getText(rowTree), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { exports, chat: { taskId }, workspaceId: "project", actions: { select: id => showChat("project", id) } }); exports.click({});
    renderSnapshot(); rendererCallback("AgentOrchestratorChat.tsx", "effect:draftOwner.current !== draftKey", globals())();
  };
  const ui = { state, maps, composing, alive, calls, moveTo, renderSnapshot,
    mount() { renderSnapshot(); rendererCallback("AgentOrchestratorChat.tsx", "effect:draftOwner.current !== draftKey", globals())(); renderSnapshot(); },
    defer: value => { defer = value; }, flush: (count = waiting.length) => { for (const apply of waiting.splice(0, count)) apply(); }, lateSetters: () => lateSetters,
    deferDraft: value => { deferDraft = value; },
    replayUpdaters: value => { replayUpdaters = value; },
    type(value) { state.draft = value; renderSnapshot(); }, input(value) { set("draft")(value); },
    unmount() { rendererCallback("AgentOrchestratorChat.tsx", "effect:releaseDraft", globals())()(); alive.current = false; },
    send() {
      const reply = delayedReply();
      const result = rendererCallback("AgentOrchestratorChat.tsx", "deliver", { ...globals(), selectedTaskId: state.taskId,
        setSending() {}, steering: false, steer: undefined, carried: null, title: "", send: () => reply.promise,
        setTitle() {}, setAtBottom() {}, followBottom() {}, setCarried() {}, setOutgoing() {} })(state.draft);
      return { finish: () => { reply.resolve(); return result; } };
    },
    async submit() {
      const reply = delayedReply(), queuedTask = state.taskId;
      const queueCall = rendererCallback("AgentOrchestratorSurface.tsx", "queueCall", { workspaceId: "project", moduleCall: (operation, args) => { calls.push({ operation, args }); return reply.promise; } });
      const queue = rendererCallback("AgentOrchestratorSurface.tsx", "chatQueue", { queueCall, aoChatExecution: () => ({ executionMode: "single" }), composerMode: "single", singleRoute: {}, savedTeams: [], composerTeamId: "", executableArg: () => ({}) });
      const enqueue = rendererCallback("AgentOrchestratorChat.tsx", "enqueue", { queue, steerOn: false, queueOf: () => [], chatQueueAdd: chat.chatQueueAdd });
      const text = chat.chatMessageWithAnnotations(chat.chatMessageWithAttachments(state.draft, state.attachments), state.annotations);
      const submit = rendererCallback("AgentOrchestratorChat.tsx", "submit", { ...globals(), commands: undefined, chatSlashParse: chat.chatSlashParse, chatMessageWithAttachments: chat.chatMessageWithAttachments,
        chatMessageWithAnnotations: chat.chatMessageWithAnnotations, canSend: true, queueing: true, queueWhileSending: false, CHAT_MESSAGE_LIMIT: 8192, enqueue,
        CHAT_MESSAGE_BYTES: chat.CHAT_MESSAGE_BYTES, chatMessageBytes: chat.chatMessageBytes, chatMessageFits: chat.chatMessageFits,
        say: rendererCallback("AgentOrchestratorChat.tsx", "say", { setCard: set("card") }) });
      await submit(); renderSnapshot();
      return { text, queuedTask, fail: async () => { reply.reject(new Error("queue unavailable")); await new Promise(setImmediate); } };
    },
  };
  if (!sharedMaps) ui.mount();
  return ui;
}

test("a queue rejection after real sidebar navigation preserves B and restores the serialized draft to A", async () => {
  const ui = queuedComposer([{ name: "note.txt", path: "G:/note.txt", image: false }]), sent = await ui.submit(); ui.moveTo("task-b");
  const files = ui.state.attachments, annotations = ui.state.annotations; await sent.fail();
  assert.equal(ui.calls[0].operation, "chat_queue"); assert.equal(ui.calls[0].args.taskId, "task-a"); assert.equal(ui.calls[0].args.workspaceId, "project");
  assert.equal(ui.state.draft, "B private draft"); assert.equal(ui.state.card, null); assert.equal(ui.state.attachments, files); assert.equal(ui.state.annotations, annotations);
  ui.moveTo("task-a"); assert.equal(ui.state.draft, sent.text);
});

test("queue recovery prepends to the same chat's newer text and respects an explicit later clear", async () => {
  const ui = queuedComposer(), sent = await ui.submit(); ui.type("newer A draft"); await sent.fail();
  assert.equal(ui.state.draft, sent.text + "\n\nnewer A draft"); assert.match(ui.state.card.text, /queue unavailable/);
  ui.renderSnapshot(); ui.type(""); ui.unmount(); assert.equal(ui.maps.CHAT_DRAFTS.has("task-a"), false);
});

test("a same-batch edit or clear after queue recovery stays authoritative on switch or unmount", async t => {
  for (const value of ["", "latest A edit"]) for (const leave of ["switch", "unmount"]) await t.test(`${value ? "edit" : "clear"}: ${leave}`, async () => {
    const ui = queuedComposer(), sent = await ui.submit(); ui.defer(true); await sent.fail();
    ui.input(value); ui.flush(); ui.renderSnapshot(); ui.defer(false);
    if (leave === "switch") ui.moveTo("task-b"); else ui.unmount();
    assert.equal(ui.maps.CHAT_DRAFTS.get("task-a")?.snapshot.text ?? "", value);
    if (leave === "switch") { ui.moveTo("task-a"); assert.equal(ui.state.draft, value); }
  });
});

test("deferred queue recovery cannot overwrite the next chat and remains recoverable on switch-back", async () => {
  const ui = queuedComposer(), sent = await ui.submit(); ui.defer(true); await sent.fail(); ui.defer(false);
  ui.moveTo("task-b"); ui.flush(); assert.equal(ui.state.draft, "B private draft"); assert.equal(ui.state.card, null);
  ui.moveTo("task-a"); assert.equal(ui.state.draft, sent.text);
});

test("a switch-back before the deferred queue recovery applies does not restore it twice", async () => {
  const ui = queuedComposer(), sent = await ui.submit(); ui.defer(true); await sent.fail(); ui.defer(false);
  ui.moveTo("task-b"); ui.moveTo("task-a"); ui.flush(); ui.renderSnapshot();
  assert.equal(ui.state.draft, sent.text);
});

test("an applied recovery survives unmount before the next state render", async () => {
  const ui = queuedComposer(), sent = await ui.submit(); ui.type("newer A draft"); ui.defer(true); await sent.fail();
  ui.flush(1); ui.unmount();
  assert.equal(ui.maps.CHAT_DRAFTS.get("task-a").snapshot.text, sent.text + "\n\nnewer A draft");
});

test("typing the same text before deferred recovery still preserves both messages", async () => {
  const ui = queuedComposer(), sent = await ui.submit(); ui.defer(true); await sent.fail();
  ui.type(sent.text); ui.defer(false); ui.moveTo("task-b"); ui.flush(); ui.moveTo("task-a");
  assert.equal(ui.state.draft, sent.text + "\n\n" + sent.text);
});

test("partly applied queue recoveries preserve every failed payload once across navigation", async () => {
  const ui = queuedComposer(), first = await ui.submit(); ui.type("A second message"); const second = await ui.submit(); ui.type("newer A draft");
  ui.defer(true); await first.fail(); await second.fail(); ui.defer(false); ui.flush(2); ui.renderSnapshot();
  ui.moveTo("task-b"); ui.flush(); ui.moveTo("task-a");
  assert.equal(ui.state.draft, second.text + "\n\n" + first.text + "\n\nnewer A draft");
});

test("queue recovery survives unmount before a deferred state commit or before rejection", async t => {
  for (const timing of ["before commit", "before failure"]) await t.test(timing, async () => {
    const ui = queuedComposer(), sent = await ui.submit(); ui.type("newer A draft");
    if (timing === "before commit") { ui.defer(true); await sent.fail(); }
    ui.unmount(); if (timing === "before failure") await sent.fail(); ui.flush();
    const fresh = queuedComposer([], ui.maps); fresh.mount();
    assert.equal(fresh.state.draft, sent.text + "\n\nnewer A draft"); assert.equal(ui.lateSetters(), 0); fresh.unmount();
  });
});

test("a late queue failure reaches a new same-chat instance before or after its draft adoption", async t => {
  for (const timing of ["before adoption", "after adoption"]) for (const typed of ["", "new instance draft", "A queued message"]) await t.test(`${timing}: ${typed || "blank"}`, async () => {
    const old = queuedComposer(), sent = await old.submit(); old.unmount();
    const fresh = queuedComposer([], old.maps); if (timing === "after adoption") fresh.mount(); fresh.type(typed);
    await sent.fail(); if (timing === "before adoption") fresh.mount();
    assert.equal(fresh.state.draft, sent.text + (typed ? "\n\n" + typed : ""));
    fresh.unmount(); const again = queuedComposer([], old.maps); again.mount();
    assert.equal(again.state.draft, sent.text + (typed ? "\n\n" + typed : "")); assert.equal(old.lateSetters(), 0); again.unmount();
  });
});

test("multiple late recoveries survive a new owner's deferred updater and later cleanup", async () => {
  const old = queuedComposer(), first = await old.submit(); old.type("second payload"); const second = await old.submit(); old.unmount();
  const fresh = queuedComposer([], old.maps); fresh.mount(); fresh.type(first.text); fresh.defer(true);
  await first.fail(); await second.fail(); fresh.unmount(); fresh.flush();
  const again = queuedComposer([], old.maps); again.mount();
  assert.equal(again.state.draft, second.text + "\n\n" + first.text + "\n\n" + first.text); again.unmount();
});

test("a deferred new-owner recovery cannot change B or be detached by stale cleanup", async () => {
  const old = queuedComposer(), sent = await old.submit(); old.unmount();
  const fresh = queuedComposer([], old.maps); fresh.mount(); fresh.type("new A text");
  const entry = fresh.maps.CHAT_DRAFTS.get("task-a"); old.unmount(); assert.equal(fresh.maps.CHAT_DRAFTS.get("task-a"), entry);
  fresh.defer(true); await sent.fail(); fresh.defer(false); fresh.moveTo("task-b"); fresh.flush();
  assert.equal(fresh.state.draft, "B private draft"); assert.equal(fresh.state.card, null); fresh.moveTo("task-a");
  assert.equal(fresh.state.draft, sent.text + "\n\nnew A text"); fresh.type(""); fresh.unmount(); assert.equal(fresh.maps.CHAT_DRAFTS.has("task-a"), false);
});

test("successful sends retire only their exact cached snapshot, including identical later text", async t => {
  for (const edit of ["unchanged", "edited", "identical"]) await t.test(edit, async () => {
    const ui = queuedComposer(); ui.type("sent text"); const sending = ui.send();
    if (edit !== "unchanged") { ui.renderSnapshot(); ui.type(edit === "edited" ? "new text" : "sent text"); }
    ui.unmount(); assert.equal(await sending.finish(), true);
    if (edit === "unchanged") assert.equal(ui.maps.CHAT_DRAFTS.has("task-a"), false);
    else { const fresh = queuedComposer([], ui.maps); fresh.mount(); assert.equal(fresh.state.draft, edit === "edited" ? "new text" : "sent text"); fresh.unmount(); }
  });
});

test("successful-send cache cleanup retains a separate failed queue receipt", async () => {
  const ui = queuedComposer(), queued = await ui.submit(); ui.type("later sent text"); const sending = ui.send(); ui.unmount();
  await queued.fail(); assert.equal(await sending.finish(), true);
  const fresh = queuedComposer([], ui.maps); fresh.mount(); assert.equal(fresh.state.draft, queued.text); fresh.unmount();
});

test("a recovery updater tolerates React's ignored first invocation", async () => {
  const ui = queuedComposer(), sent = await ui.submit(); ui.replayUpdaters(true); await sent.fail();
  assert.equal(ui.state.draft, sent.text); ui.unmount();
});

test("adopted queue receipts retire even when a same-batch clear leaves the draft unchanged", async () => {
  const ui = queuedComposer();
  for (let i = 0; i < 3; i++) {
    ui.type("payload " + i); const sent = await ui.submit(); ui.defer(true); await sent.fail(); ui.input(""); ui.flush(); ui.defer(false); ui.renderSnapshot();
    assert.equal(ui.state.draft, ""); assert.equal(ui.maps.CHAT_DRAFTS.get("task-a").pending.length, 0);
  }
  ui.unmount(); assert.equal(ui.maps.CHAT_DRAFTS.has("task-a"), false);
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

function childPoll(file, selector, options = {}) {
  const { hidden: initiallyHidden = true, statsReply = () => ({ available: true, steps: 1 }), ...overrides } = options;
  let surfaceHidden = initiallyHidden, away = false, timerId = 0;
  const latest = { current: surfaceHidden }, timers = new Map(), focus = new Set(), clicks = new Set(), calls = [];
  // A timeout sits with the intervals until it fires once (ChatTurnStats schedules each next read).
  const window = { setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id),
    setTimeout: fn => { const id = ++timerId; timers.set(id, () => { timers.delete(id); fn(); }); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener: (_event, fn) => focus.add(fn), removeEventListener: (_event, fn) => focus.delete(fn) };
  const document = { visibilityState: "visible", hasFocus: () => true, documentElement: { hasAttribute: () => away } };
  const visibility = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/page-visibility.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: visibility, window, document, require: () => ({ createContext: value => ({ value }),
    useContext: () => surfaceHidden, useRef: () => latest, useCallback: fn => fn }) });
  const hidden = visibility.useSurfaceHidden();
  const request = async operation => {
    calls.push(operation);
    if (operation === "chat_processes") return { sessions: [] };
    if (operation === "chat_context") return { sessions: { session: { usage: null } } };
    if (operation === "chat_turn_stats") return statsReply();
    return { previews: {}, runs: [], timeline: [], entries: [], nextOffset: 0, content: "" };
  };
  const noop = () => {};
  const globals = { hidden, window, document, onWindowFocus: visibility.onWindowFocus, windowUnfocused: visibility.windowUnfocused,
    getCodingToolsClient: () => ({ apps: { call: async input => ({ result: await request(input.operation) }) } }), paneCall: request,
    readCpaUsage: async range => { calls.push(`usage:${range}`); return { available: false }; },
    sessionId: "session", sessionIds: ["session"], workspaceId: "workspace", earlierKey: "", currentContext: (sessions, id) => sessions?.[id],
    wanted: true, key: "cpa/model", from: 1, running: true, active: true, isOpen: true, run: { subagent_id: "subagent" }, range: "24h",
    onCpaCodex: true, onCpaCline: false, onCpaOther: false, USAGE_RANGE: "7d", session: {},
    POLL_MS: 4000, QUOTA_POLL_MS: 60000, DETAIL_POLL_MS: 10000, PROCESSES_POLL_MS: 4000, SUBAGENTS_POLL_MS: 3000,
    OVERVIEW_POLL_MS: 5000, SUBAGENT_WORK_POLL_MS: 2000, PREVIEW_POLL_MS: 1500, COMMANDS_POLL_MS: 2000, OUTPUT_POLL_MS: 1000,
    button: { current: { addEventListener: (_event, fn) => clicks.add(fn), removeEventListener: (_event, fn) => clicks.delete(fn) } },
    seen: { current: null }, polled: { current: new Set() }, openNow: { current: false }, onOpenNow: { current: noop }, onStartedNow: { current: noop },
    startsNewChat: () => true, chatSubagents: chat.chatSubagents, subagentActive: chat.subagentActive, isLive: () => true,
    selected: "command", selectedAgentShell: false, offsets: { current: {} }, pinned: { current: false }, shownRequest: { current: "" },
    plain: value => value, TAIL_BYTES: 1024, MAX_OUTPUT_CHARS: 10000,
    ...overrides,
  };
  for (const name of ["Snapshot", "Quota", "UsageReport", "DaySpend", "MonthSpend", "Breakdown", "Stats", "Commands", "LivePage", "Runs", "Context", "Changes", "Tasks", "Usage", "Items", "Error", "State", "Now", "Selected", "ShowHistory", "Output"])
    if (!(`set${name}` in overrides)) globals[`set${name}`] = noop;
  if (file === "ChatWorkbench.tsx") {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatWorkbench.tsx"), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const scheduler = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "startWorkbenchPoll");
    assert.ok(scheduler, "the workbench's real polling scheduler");
    const exports = {};
    vm.runInNewContext(ts.transpileModule(scheduler.getText(tree), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, window, onWindowFocus: visibility.onWindowFocus });
    globals.startWorkbenchPoll = exports.startWorkbenchPoll;
  }
  const cleanup = rendererCallback(file, selector, globals)();
  return { calls, timers, focus, clicks, cleanup,
    hide(value) { surfaceHidden = value; visibility.useSurfaceHidden(); },
    away(value) { away = value; }, page(value) { document.visibilityState = value; },
    pulse() { for (const callback of [...timers.values(), ...focus, ...clicks]) callback(); } };
}

test("chat child refreshes skip hidden surfaces, minimized windows and hidden pages, then resume", async t => {
  for (const [file, selector, expected] of [
    ["ChatContextMeter.tsx", "effect:const earlier = earlierKey", ["chat_context"]],
    ["ChatContextMeter.tsx", "effect:setQuota(null)", ["cpa_quota", "usage:7d"]],
    ["ChatContextMeter.tsx", "effect:let pending = false", ["chat_context"]],
    ["ChatTurnStats.tsx", "effect:const [first, ...rest]", ["chat_turn_stats"]],
    ["ChatWorkbench.tsx", "effect:!wanted", ["chat_processes"]],
    ["ChatWorkbench.tsx", "effect:setLivePage(null)", ["chat_preview_state", "chat_processes"]],
    ["ChatWorkbench.tsx", "effect:seen.current = null", ["subagents_runs"]],
    ["ChatWorkbench.tsx", "effect:countChanges", ["chat_context", "chat_changes", "chat_processes"]],
    ["ChatWorkbench.tsx", "effect:readCpaUsage(range)", ["usage:24h"]],
    ["ChatWorkbench.tsx", "effect:subagent_transcript", ["subagent_transcript"]],
    ["ChatWorkbench.tsx", "effect:rememberPage(sessionId", ["chat_preview_state"]],
    ["ChatWorkbench.tsx", "effect:shownRequest.current", ["chat_processes"]],
    ["ChatWorkbench.tsx", "effect:offsets.current = { stdout: 0", ["chat_process_output"]],
  ]) await t.test(`${file} ${selector}`, async () => {
    const f = childPoll(file, selector);
    try {
      f.pulse(); await new Promise(setImmediate);
      assert.deepEqual(f.calls, [], "automatic initial reads, timers, focus and panel clicks wait while hidden");
      f.hide(false); f.pulse(); await new Promise(setImmediate);
      for (const operation of expected) assert.ok(f.calls.includes(operation), `${operation} resumes without remounting`);
      f.calls.length = 0;
      for (const reason of ["surface", "minimized", "page"]) {
        f.hide(reason === "surface"); f.away(reason === "minimized"); f.page(reason === "page" ? "hidden" : "visible");
        f.pulse(); await new Promise(setImmediate);
        assert.deepEqual(f.calls, [], reason);
      }
      f.hide(false); f.away(false); f.page("visible"); f.pulse(); await new Promise(setImmediate);
      for (const operation of expected) assert.ok(f.calls.includes(operation), `${operation} resumes after the window returns`);
    } finally { f.cleanup?.(); }
    assert.equal(f.timers.size, 0); assert.equal(f.focus.size, 0); assert.equal(f.clicks.size, 0);
  });
});

test("ended turn and subagent reads defer while hidden, issue once when shown and retire their timer", async t => {
  for (const [file, selector, options] of [
    ["ChatTurnStats.tsx", "effect:const [first, ...rest]", { running: false }],
    ["ChatWorkbench.tsx", "effect:subagent_transcript", { active: false }],
  ]) for (const hidden of [true, false]) await t.test(`${file} hidden=${hidden}`, async () => {
    const f = childPoll(file, selector, { ...options, hidden });
    try {
      await new Promise(setImmediate);
      assert.equal(f.calls.length, hidden ? 0 : 1);
      assert.equal(f.timers.size, hidden ? 1 : 0);
      if (hidden) {
        const abandoned = childPoll(file, selector, { ...options, hidden: true });
        abandoned.cleanup(); abandoned.hide(false); abandoned.pulse(); await new Promise(setImmediate);
        assert.equal(abandoned.timers.size, 0); assert.equal(abandoned.calls.length, 0, "unmount cancels the deferred final read");
      }
      f.hide(false); f.pulse(); await new Promise(setImmediate);
      assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
      f.pulse(); await new Promise(setImmediate); assert.equal(f.calls.length, 1);
    } finally { f.cleanup?.(); }
    assert.equal(f.timers.size, 0);
  });
});

// 2026-11-03: chats opened before CPA was up showed "6 rounds" and no details until reopened.
test("the stats line asks again until CPA has the numbers, and a missed read keeps the numbers shown", async () => {
  let reply = { available: false, reason: "CPA is not running" }, shown = null;
  const setStats = next => { shown = typeof next === "function" ? next(shown) : next; };
  const ended = childPoll("ChatTurnStats.tsx", "effect:const [first, ...rest]", { running: false, hidden: false, statsReply: () => reply, setStats });
  try {
    await new Promise(setImmediate);
    assert.equal(ended.calls.length, 1); assert.equal(ended.timers.size, 1, "an ended chat books another read");
    reply = { available: true, steps: 4 };
    ended.pulse(); await new Promise(setImmediate);
    assert.equal(ended.calls.length, 2); assert.equal(ended.timers.size, 0, "it retires once it has the numbers");
    assert.equal(shown.steps, 4);
  } finally { ended.cleanup?.(); }
  const running = childPoll("ChatTurnStats.tsx", "effect:const [first, ...rest]", { running: true, hidden: false, statsReply: () => reply, setStats });
  try {
    await new Promise(setImmediate);
    reply = { available: false };
    running.pulse(); await new Promise(setImmediate);
    assert.equal(running.calls.length, 2); assert.equal(shown.steps, 4, "a missed read keeps the numbers");
  } finally { running.cleanup?.(); }
  assert.equal(running.timers.size, 0);
});

test("the stats line waits for records after a successful empty read", async () => {
  let reply = { available: true, steps: 0 }, shown = null;
  const ended = childPoll("ChatTurnStats.tsx", "effect:const [first, ...rest]", {
    running: false, hidden: false, statsReply: () => reply,
    setStats: next => { shown = typeof next === "function" ? next(shown) : next; },
  });
  try {
    await new Promise(setImmediate);
    assert.equal(ended.calls.length, 1);
    assert.equal(ended.timers.size, 1, "CPA answered, but its request records have not arrived yet");
    reply = { available: true, steps: 4 };
    ended.pulse(); await new Promise(setImmediate);
    assert.equal(shown.steps, 4);
    assert.equal(ended.calls.length, 2);
    assert.equal(ended.timers.size, 0, "the ended turn retires once records arrive");
  } finally { ended.cleanup?.(); }
  assert.equal(ended.timers.size, 0);
});

test("the stats line keeps shown numbers when CPA returns a successful empty read", async () => {
  let reply = { available: true, steps: 4 }, shown = null;
  const running = childPoll("ChatTurnStats.tsx", "effect:const [first, ...rest]", {
    running: true, hidden: false, statsReply: () => reply,
    setStats: next => { shown = typeof next === "function" ? next(shown) : next; },
  });
  try {
    await new Promise(setImmediate);
    assert.equal(shown.steps, 4);
    reply = { available: true, steps: 0 };
    running.pulse(); await new Promise(setImmediate);
    assert.equal(running.calls.length, 2);
    assert.equal(shown.steps, 4, "an empty records page never erases known request totals");
  } finally { running.cleanup?.(); }
  assert.equal(running.timers.size, 0);
});

test("a hidden preview still hides its native view and disposes its observer on cleanup", () => {
  const calls = [], remeasure = { current: null }; let disconnected = 0;
  const cleanup = rendererCallback("ChatWorkbench.tsx", "layout:const measure = () =>", {
    hidden: () => true, sessionId: "session", hasPage: true, coveredNow: { current: false }, remeasure,
    slot: { current: { getBoundingClientRect: () => ({ width: 0, height: 0 }) } },
    paneCall: async operation => { calls.push(operation); }, requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() { disconnected += 1; } }, window: { addEventListener() {}, removeEventListener() {} },
  })();
  assert.deepEqual(calls, ["chat_preview_hide"]);
  cleanup(); assert.deepEqual(calls, ["chat_preview_hide", "chat_preview_hide"]);
  assert.equal(disconnected, 1); assert.equal(remeasure.current, null);
});

test("an old terminal read cannot advance a newly selected command's output cursor", async () => {
  const old = delayedReply(), offsets = { current: { stdout: 0, stderr: 0 } };
  const read = rendererCallback("ChatWorkbench.tsx", "effect:offsets.current = { stdout: 0", {
    selected: "old", sessionId: "session", workspaceId: "a", selectedAgentShell: false, offsets, hidden: () => false,
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

function sentImagePreviews() {
  const PREVIEWS = rendererCallback("ChatToolParts.tsx", "PREVIEWS", {});
  const mount = (preview, path, state = { url: null, missing: false }) => {
    const cleanup = rendererCallback("ChatToolParts.tsx", "effect:PREVIEWS", {
      PREVIEWS, preview, item: { path }, setUrl: value => { state.url = value; }, setMissing: value => { state.missing = value; },
    })();
    return { state, cleanup: cleanup || (() => {}) };
  };
  return { mount, pending: preview => (typeof PREVIEWS.size === "number" ? PREVIEWS : PREVIEWS.get(preview))?.size || 0 };
}

test("sent image previews release settled reads after 100 images unmount", async () => {
  const fixture = sentImagePreviews(); let reads = 0;
  const preview = async file => { reads++; return "data:image/png;base64," + file; };
  const images = Array.from({ length: 100 }, (_, i) => fixture.mount(preview, "image-" + i));
  await new Promise(setImmediate);
  for (const image of images) { assert.ok(image.state.url); image.cleanup(); }
  assert.equal(reads, 100);
  assert.equal(fixture.pending(preview), 0, "completed full-size data URLs are owned only by mounted images");
});

test("sent image previews reread a remounted path after its file changes", async () => {
  const fixture = sentImagePreviews(); let content = "v1", reads = 0;
  const preview = async () => { reads++; return content; };
  const first = fixture.mount(preview, "same.png");
  await new Promise(setImmediate); assert.equal(first.state.url, "v1"); first.cleanup();
  content = "v2";
  const second = fixture.mount(preview, "same.png");
  await new Promise(setImmediate);
  assert.equal(second.state.url, "v2"); assert.equal(reads, 2); second.cleanup();
});

test("sent image previews share pending reads without canceling another mounted consumer", async () => {
  const fixture = sentImagePreviews(), reply = delayedReply(); let reads = 0;
  const preview = () => { reads++; return reply.promise; };
  const first = fixture.mount(preview, "same.png"), second = fixture.mount(preview, "same.png");
  first.cleanup(); await new Promise(setImmediate);
  assert.equal(reads, 1); assert.equal(fixture.pending(preview), 1);
  reply.resolve("shared"); await new Promise(setImmediate);
  assert.equal(first.state.url, null); assert.equal(second.state.url, "shared");
  assert.equal(fixture.pending(preview), 0); second.cleanup();
});

test("sent image previews isolate providers and an old failed read cannot evict another provider", async () => {
  const fixture = sentImagePreviews(), oldReply = delayedReply(), currentReply = delayedReply(); let currentReads = 0;
  const oldProvider = () => oldReply.promise;
  const currentProvider = () => { currentReads++; return currentReply.promise; };
  const oldImage = fixture.mount(oldProvider, "same.png"); oldImage.cleanup();
  const currentImage = fixture.mount(currentProvider, "same.png");
  await new Promise(setImmediate);
  oldReply.reject(new Error("old provider unavailable")); await new Promise(setImmediate);
  const sibling = fixture.mount(currentProvider, "same.png"); await new Promise(setImmediate);
  assert.equal(currentReads, 1); assert.equal(fixture.pending(currentProvider), 1);
  currentReply.resolve("current"); await new Promise(setImmediate);
  assert.equal(currentImage.state.url, "current"); assert.equal(sibling.state.url, "current");
  assert.equal(oldImage.state.missing, false); currentImage.cleanup(); sibling.cleanup();
});

test("sent image previews clear failed reads so a remount can retry", async () => {
  const fixture = sentImagePreviews(); let reads = 0;
  const preview = async () => { if (++reads === 1) throw new Error("missing"); return "recovered"; };
  const first = fixture.mount(preview, "same.png");
  await new Promise(setImmediate); assert.equal(first.state.missing, true); first.cleanup();
  assert.equal(fixture.pending(preview), 0);
  const second = fixture.mount(preview, "same.png");
  await new Promise(setImmediate);
  assert.equal(second.state.url, "recovered"); assert.equal(second.state.missing, false); assert.equal(reads, 2); second.cleanup();
});

test("sent image previews reset a changed path or provider and fence late replies", async () => {
  const fixture = sentImagePreviews(), oldReply = delayedReply(), nextReply = delayedReply();
  const state = { url: "previous", missing: true };
  const first = fixture.mount(() => oldReply.promise, "old.png", state);
  assert.equal(state.url, null); assert.equal(state.missing, false); first.cleanup();
  const next = fixture.mount(() => nextReply.promise, "next.png", state);
  nextReply.resolve("next"); await new Promise(setImmediate);
  oldReply.resolve("old"); await new Promise(setImmediate); assert.equal(state.url, "next"); next.cleanup();
  const unavailable = fixture.mount(undefined, "next.png", state);
  assert.equal(state.url, null); assert.equal(state.missing, false); unavailable.cleanup();
});

test("the Surface keeps its attachment preview provider stable across unrelated polls", async () => {
  const paths = [], launcher = { attachmentPreview: async file => { paths.push(file); return "first"; } };
  const fixture = surfaceComposer({}, { window: { codexWebLauncher: launcher } });
  const first = fixture.currentChat().props.attachmentPreview;
  fixture.state.board = { revision: 2, tasks: [] };
  const second = fixture.currentChat().props.attachmentPreview;
  assert.equal(second, first, "polling does not restart every mounted thumbnail read");
  assert.equal(await second("one.png"), "first");
  launcher.attachmentPreview = async file => { paths.push(file); return "current"; };
  assert.equal(await first("two.png"), "current", "the stable provider still uses the current desktop bridge");
  assert.deepEqual(paths, ["one.png", "two.png"]);
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
    ["group:4", "7", "8", "group:1", "10", "group:1"]);
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

test("a turn's own message gets a receipt: sending until an agent takes it, then unread, then read", () => {
  const now = 10 * 3_600_000;
  const card = (state, extra = {}, runExtra = {}) => [run("r1", "t", [node("w", "worker", state, { route: { harness_id: "ao:claude-code", model: "cpa/gpt-6.1-sol" }, ...extra })],
    { execution_mode: "single", ...runExtra })];
  const receipt = (runs, live, frame) => {
    const turn = chat.chatTurns(runs, "keep going", { activity: frame ? { "r1:w": frame } : {}, now }).at(-1);
    return chat.turnReceipt(turn, turn.steps.flatMap((step) => step.working?.timeline ?? []), live);
  };
  // Seen live 2026-11-02: AO held the turn queued for 7 minutes while a fresh agent came up.
  assert.equal(receipt(card("running", { receipt: { thread_id: "s" } }), true, { activity: "waiting for the agent to take the message", turn_started: false }), "sending");
  assert.equal(receipt(card("reserved"), true, { activity: "launching" }), "sending", "no agent session yet");
  assert.equal(receipt(card("running", { receipt: { thread_id: "s" } }), true, { activity: "waiting for the model", turn_started: true }), "unread");
  const wrote = { activity: "thinking", turn_started: true, timeline: [{ id: "r", kind: "reasoning", status: "running", text: "" }] };
  assert.equal(receipt(card("running", { receipt: { thread_id: "s" } }), true, wrote), "read");
  assert.equal(receipt(card("finished", { receipt: { answer: "Opened the PR." } }), false), "read");
  // A retried card shows its earlier reply until the new attempt writes: that reply never read this message.
  const retried = card("running", { receipt: { thread_id: "s2" }, history: [{ receipt: { answer: "Earlier answer" } }] });
  assert.equal(receipt(retried, true, { activity: "waiting for the model", turn_started: true }), "unread");
  // A turn stopped before its model wrote anything may never have been read.
  assert.equal(receipt(card("running", { receipt: { thread_id: "s" } }, { cancelled: true }), false), undefined);
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

test("a request the reviewer is judging, or has just answered while AO still lists it, is not \"waiting for approval\"", () => {
  // Seen live 2026-11-09: "waiting for approval · waiting for you for 8m 22s" with Continue, a second
  // after "Let the model judge" allowed the request, while AO had not yet dropped it.
  const working = [run("r1", "t", [node("w", "planner", "running", { receipt: { started_at_ms: 1_000 } })])];
  const shown = (activity) => chat.chatTurns(working, "go", { activity: { "r1:w": { activity, turn_started: true,
    timeline: [{ id: "a", kind: "approval", status: "pending", text: "git push" }] } }, now: 60_000 })[0].steps
    .find((step) => step.working)?.working.activity;
  assert.equal(shown("the reviewer allowed: git push origin feat"), "the reviewer allowed: git push origin feat");
  assert.equal(shown("the reviewer denied: git push origin main"), "the reviewer denied: git push origin main");
  assert.equal(shown("the reviewer is checking: git push origin feat"), "the reviewer is checking: git push origin feat");
  assert.equal(shown("running git status"), "waiting for approval", "a request nobody has answered holds the card");
  assert.equal(chat.waitsForPerson("the reviewer allowed: git push"), false, "so no Continue is offered for it");
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
  // Seen live 2026-11-06: AO stopped listing the run a goal chat was opened on; the pane polled it
  // for good and never showed the live round's request.
  assert.equal(chat.chatLiveRun([working], "t", "pruned", true), "old", "a run gone past its grace gives way to the working one");
  assert.equal(chat.chatLiveRun([finished], "t", "pruned", true), "r1", "else to the chat's newest");
  assert.equal(chat.chatLiveRun([working], "t", "pruned"), "pruned", "within the grace it is still waited for");
  assert.equal(chat.chatLiveRun([working], "other", "x", true), "x", "a chat with no runs listed keeps its selection");
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
// The poll helpers from AgentOrchestratorSurface.tsx, with a fixed spread so a test can see it.
const pollHelpers = {
  isCapacityError: cause => /HEADLESS_CAPACITY|HEADLESS_QUEUE_FULL|launcher queue is full/.test(cause instanceof Error ? cause.message : String(cause)),
  spreadInterval: ms => ms + 300,
};

test("the approvals poll skips a card whose attempt changed mid-read instead of raising an error", async () => {
  const state = { approvals: null, policies: null, errors: [] };
  const calls = [];
  const timers = [];
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:approvalScope.current", {
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["old", "live"]), ...pollHelpers,
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
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["n1"]), ...pollHelpers,
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

// 2026-11-03: eight split-view chats refreshing together filled the service's queue, and each
// refused poll showed as "Something went wrong". The next tick reads again, so it shows nothing.
test("the approvals poll shows nothing when the service had no room for it", async () => {
  const errors = [];
  let period = null;
  const effect = rendererCallback("AgentOrchestratorSurface.tsx", "effect:approvalScope.current", {
    Error, STALE_OBSERVE: /AO receipt changed/, activeNodeIds: JSON.stringify(["n1"]), ...pollHelpers,
    workspaceId: "w1", selectedRunId: "run1", selectedRunHere: true, autoStatus: "running", surfaceHidden: () => false,
    approvalScope: { current: null }, selection: { current: { workspaceId: "w1", runId: "run1" } },
    setPendingApprovals: () => {}, setRuntimePolicies: () => {}, setMissions: () => {}, setError: error => errors.push(error),
    setInterval: (callback, ms) => { period = ms; return 1; }, clearInterval: () => {},
    moduleCall: async () => { throw new Error("IPC_TRANSPORT_FAILED: apps.call failed: HEADLESS_CAPACITY: request admission is full (the launcher's queue did not clear in time)"); },
  });
  const cleanup = effect();
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.equal(period, 3300, "its period is spread (spreadInterval)");
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
    Date, surfaceHidden: () => hidden, setListNow: value => ticks.push(value),
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

function filePane(name) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatWorkbench.tsx"), "utf8");
  const file = ts.createSourceFile("ChatWorkbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const code = file.statements.filter(node => ts.isFunctionDeclaration(node) && [name, "parseDiff", "changeTargetPath"].includes(node.name?.text))
    .map(node => node.getText(file)).join("\n") + `\nexports.Pane = ${name};`;
  const states = [], refs = [], effects = [], memos = [], queued = [], requests = [], afterUnmount = [];
  let stateIndex, refIndex, effectIndex, memoIndex, dirty, mounted = true;
  const props = { sessionId: "agent", workspaceId: "project" }, exports = {};
  const changed = (before, after) => !before || before.length !== after.length || after.some((value, i) => !Object.is(value, before[i]));
  const effect = (work, deps, phase) => { const index = effectIndex++, previous = effects[index];
    if (changed(previous?.deps, deps)) queued.push({ phase, work: () => { previous?.cleanup?.(); effects[index] = { deps, cleanup: work() }; } }); };
  const jsx = (type, props) => ({ type, props: props || {} });
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, Error, Icon: "Icon", paneCall: (operation, input) => { const reply = delayedReply(); requests.push({ operation, input, ...reply }); return reply.promise; },
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], next => { if (!mounted) afterUnmount.push(index); const value = typeof next === "function" ? next(states[index]) : next;
        if (!Object.is(states[index], value)) { states[index] = value; dirty = true; } }]; },
    useRef: initial => refs[refIndex++] ??= { current: initial },
    useEffect: (work, deps) => effect(work, deps, 1), useLayoutEffect: (work, deps) => effect(work, deps, 0),
    useMemo(work, deps) { const index = memoIndex++; if (changed(memos[index]?.deps, deps)) memos[index] = { deps, value: work() }; return memos[index].value; },
    require: () => ({ jsx, jsxs: jsx }),
  });
  const nodes = tree => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
  const render = (next = {}) => {
    Object.assign(props, next);
    for (let pass = 0; pass < 10; pass++) {
      dirty = false; stateIndex = refIndex = effectIndex = memoIndex = 0; const tree = exports.Pane(props);
      for (const item of queued.splice(0).sort((a, b) => a.phase - b.phase)) item.work();
      if (!dirty) return tree;
    }
    throw new Error("file pane hooks did not settle");
  };
  const findEntry = path => nodes(render()).find(node => node.type === "button" && (node.props.title === path || node.props.children?.includes?.(path)));
  return { requests, nodes, render, findEntry, afterUnmount,
    select(path) { const button = findEntry(path); assert.ok(button, path); button.props.onClick(); return render(); },
    displayed: () => nodes(render()).find(node => node.type === "code")?.props.children,
    errors: () => nodes(render()).filter(node => node.props.role === "alert").map(node => node.props.children),
    refresh: () => nodes(render()).find(node => node.props["aria-label"] === "Refresh changes"),
    unmount() { for (const item of effects) item?.cleanup?.(); mounted = false; },
    async list() { render(); requests[0].resolve(name === "FilesPane" ? { entries: ["a.txt", "b.txt"].map(path => ({ path, name: path, type: "file" })) }
      : { entries: ["a.txt", "b.txt"].map(path => ({ path, worktree_status: "?" })), diff: "" }); await new Promise(setImmediate); render(); },
  };
}

test("file viewers keep the newest selection after older success or failure", async t => {
  for (const pane of ["FilesPane", "ChangesPane"]) for (const outcome of ["resolve", "reject"]) await t.test(pane + " " + outcome, async () => {
    const ui = filePane(pane); await ui.list(); ui.select("a.txt"); ui.select("b.txt");
    const reads = ui.requests.filter(item => item.operation === "chat_file"); assert.equal(reads.length, 2);
    reads[1].resolve({ content: "newest B" }); await new Promise(setImmediate); assert.equal(ui.displayed(), "b.txt");
    reads[0][outcome](outcome === "resolve" ? { content: "late A" } : new Error("old A failed")); await new Promise(setImmediate);
    assert.equal(ui.displayed(), "b.txt"); assert.deepEqual(ui.errors(), []); ui.unmount();
  });
});

test("Files rereads the same path and reports only the current file error", async () => {
  const ui = filePane("FilesPane"); await ui.list(); ui.select("a.txt");
  ui.requests.at(-1).resolve({ content: "v1" }); await new Promise(setImmediate); assert.equal(ui.displayed(), "a.txt");
  ui.select("a.txt"); const same = ui.requests.at(-1); assert.equal(same.operation, "chat_file"); same.resolve({ content: "v2" }); await new Promise(setImmediate);
  assert.ok(ui.nodes(ui.render()).some(node => node.props.className === "cx-diff-text" && node.props.children === "v2"));
  ui.select("b.txt"); ui.requests.at(-1).reject(new Error("current B failed")); await new Promise(setImmediate);
  assert.deepEqual(ui.errors(), ["current B failed"]); ui.unmount();
});

test("file viewers reset ownership and cached rows on workspace/session change and unmount", async t => {
  for (const pane of ["FilesPane", "ChangesPane"]) for (const boundary of ["workspaceId", "sessionId", "unmount"]) await t.test(pane + " " + boundary, async () => {
    const ui = filePane(pane); await ui.list(); const oldButton = ui.findEntry("a.txt"); ui.select("a.txt"); const oldRead = ui.requests.at(-1);
    if (boundary === "unmount") ui.unmount();
    else {
      ui.render({ [boundary]: "other" }); assert.equal(ui.displayed(), undefined); assert.equal(ui.findEntry("a.txt"), undefined);
      const listing = ui.requests.at(-1); assert.equal(listing.input[boundary], "other");
      listing.resolve(pane === "FilesPane" ? { entries: [{ name: "b.txt", path: "b.txt", type: "file" }] }
        : { entries: [{ path: "b.txt", worktree_status: "?" }], diff: "" }); await new Promise(setImmediate);
      const count = ui.requests.length; oldButton.props.onClick(); ui.render(); assert.equal(ui.requests.length, count, "a retained old-scope callback cannot read in either workspace");
      ui.select("b.txt"); ui.requests.at(-1).resolve({ content: "current scope B" }); await new Promise(setImmediate); assert.equal(ui.displayed(), "b.txt");
    }
    oldRead.resolve({ content: "old scope A" }); await new Promise(setImmediate);
    if (boundary === "unmount") assert.deepEqual(ui.afterUnmount, []);
    else { assert.equal(ui.displayed(), "b.txt"); ui.unmount(); }
  });
});

test("file/folder/list replies after unmount cannot update either file viewer", async t => {
  for (const pane of ["FilesPane", "ChangesPane"]) for (const outcome of ["resolve", "reject"]) await t.test(pane + " " + outcome, async () => {
    const ui = filePane(pane); ui.render(); ui.unmount();
    ui.requests[0][outcome](outcome === "resolve" ? { entries: [], diff: "" } : new Error("late listing failure")); await new Promise(setImmediate);
    assert.deepEqual(ui.afterUnmount, []);
  });
});

test("Refresh rereads a selected untracked file even when the diff stays empty", async () => {
  const ui = filePane("ChangesPane"); await ui.list(); ui.select("a.txt"); ui.requests.at(-1).resolve({ content: "v1" }); await new Promise(setImmediate);
  ui.refresh().props.onClick(); ui.render(); ui.requests.at(-1).resolve({ entries: [{ path: "a.txt", worktree_status: "?" }], diff: "" }); await new Promise(setImmediate); ui.render();
  const reads = ui.requests.filter(item => item.operation === "chat_file"); assert.equal(reads.length, 2);
  reads[1].resolve({ content: "v2" }); await new Promise(setImmediate);
  assert.ok(ui.nodes(ui.render()).some(node => node.props.className === "cx-diff-text" && node.props.children.includes("v2"))); ui.unmount();
});

test("a reply's changed file is the one the Changes tab shows, once its diff loads, until the person picks another", async () => {
  const diff = ["a.txt", "b.txt"].map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new ${file}`).join("\n");
  const changes = { entries: [{ path: "new.txt", worktree_status: "?" }], diff };
  const ui = filePane("ChangesPane");
  ui.render({ target: { sessionId: "agent", path: "G:\\worktree\\b.txt", requestId: 1 } });
  assert.equal(ui.displayed(), undefined, "nothing is picked before the diff is read");
  ui.requests[0].resolve(changes); await new Promise(setImmediate);
  assert.equal(ui.displayed(), "b.txt", "the edit's absolute path finds its diff file, not the first one");
  ui.select("a.txt"); ui.refresh().props.onClick(); ui.render();
  ui.requests.filter(item => item.operation === "chat_changes").at(-1).resolve(changes); await new Promise(setImmediate);
  assert.equal(ui.displayed(), "a.txt", "a Refresh keeps the person's own choice");
  ui.unmount();

  // A new file has no diff: it is read whole, as clicking it in the list does.
  const fresh = filePane("ChangesPane");
  fresh.render({ target: { sessionId: "agent", path: "G:\\worktree\\new.txt", requestId: 2 } });
  fresh.requests[0].resolve(changes); await new Promise(setImmediate); fresh.render();
  const read = fresh.requests.find(item => item.operation === "chat_file");
  assert.equal(read?.input.path, "new.txt");
  read.resolve({ content: "brand new" }); await new Promise(setImmediate);
  assert.equal(fresh.displayed(), "new.txt");
  fresh.unmount();

  // A file the worktree no longer lists (committed since) leaves the tab on its first file.
  const gone = filePane("ChangesPane");
  gone.render({ target: { sessionId: "agent", path: "G:\\worktree\\gone.txt", requestId: 3 } });
  gone.requests[0].resolve(changes); await new Promise(setImmediate);
  assert.equal(gone.displayed(), "a.txt");
  assert.equal(gone.requests.some(item => item.operation === "chat_file"), false, "no read is sent for a path the worktree doesn't have");
  gone.unmount();
});

test("only the latest Changes refresh can replace data, report errors or finish loading", async t => {
  for (const outcome of ["resolve", "reject"]) await t.test(outcome, async () => {
    const ui = filePane("ChangesPane"); await ui.list(); const refresh = ui.refresh(); refresh.props.onClick(); refresh.props.onClick(); ui.render();
    const reads = ui.requests.filter(item => item.operation === "chat_changes"); assert.equal(reads.length, 3);
    reads[1][outcome](outcome === "resolve" ? { branch: "old", entries: [], diff: "" } : new Error("old refresh failed")); await new Promise(setImmediate);
    assert.equal(ui.refresh().props.disabled, true); assert.deepEqual(ui.errors(), []);
    reads[2].resolve({ branch: "current", entries: [{ path: "b.txt", worktree_status: "?" }], diff: "" }); await new Promise(setImmediate);
    assert.equal(ui.refresh().props.disabled, false); assert.ok(ui.nodes(ui.render()).some(node => node.props.className === "cx-changes-branch" && node.props.children === "current")); ui.unmount();
  });
});

test("only the latest folder read can replace its rows or report its error", async t => {
  for (const outcome of ["resolve", "reject"]) await t.test(outcome, async () => {
    const ui = filePane("FilesPane"); ui.render(); ui.requests[0].resolve({ entries: [{ name: "folder", path: "folder", type: "directory" }] }); await new Promise(setImmediate);
    ui.select("folder"); ui.select("folder"); ui.select("folder");
    const reads = ui.requests.filter(item => item.input.path === "folder"); assert.equal(reads.length, 2);
    reads[1].resolve({ entries: [{ name: "b.txt", path: "folder/b.txt", type: "file" }] }); await new Promise(setImmediate); ui.render();
    reads[0][outcome](outcome === "resolve" ? { entries: [{ name: "a.txt", path: "folder/a.txt", type: "file" }] } : new Error("old folder failed")); await new Promise(setImmediate);
    assert.ok(ui.findEntry("b.txt")); assert.equal(ui.findEntry("a.txt"), undefined); assert.deepEqual(ui.errors(), []); ui.unmount();
  });
});

// Replay the production recovery hook block, including its render-time ownership fence. No IPC,
// provider, React DOM, or browser is used by this fixture.
function recoveryControls() {
  const file = "AgentOrchestratorChat.tsx", text = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let first, last; const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "recoveryNode") first = node.parent.parent.getStart(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "restartTurn") last = node.parent.parent.end;
    ts.forEachChild(node, visit);
  }; visit(tree); assert.ok(first && last > first);
  const code = ts.transpileModule(text.slice(first, last) + "\nexports.value = { restartTurn, restarting, recoveryMessage };",
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = [], refs = [], requests = [], calls = [], timers = new Map(), alive = { current: true };
  let stateIndex, refIndex, cleanup, timerId = 0, lateWrites = 0;
  const props = { projectId: "workspace-a", selectedTaskId: "chat-a" };
  const latest = taskId => ({ id: "run-" + taskId, project_id: taskId, execution_mode: "single", nodes: [
    { id: "lead", role: "planner", route: { harness_id: "codex-native", model: "same-model" }, receipt: {
      request_key: "request-" + taskId, thread_id: "thread-" + taskId, turn_id: "accepted-" + taskId } },
  ] }); props.latest = latest(props.selectedTaskId);
  const render = () => {
    stateIndex = 0; refIndex = 0; const exports = {};
    vm.runInNewContext(code, { exports, ...props, alive, deliver: () => { calls.push("deliver"); return Promise.resolve(); },
      steer: () => { calls.push("steer"); return Promise.resolve("restart"); },
      recover: input => { const reply = delayedReply(); requests.push({ ...reply, input: plain(input) }); return reply.promise; },
      useRef: initial => refs[refIndex++] ??= { current: initial },
      useState: initial => { const index = stateIndex++; if (!(index in state)) state[index] = initial;
        return [state[index], value => { if (!alive.current) lateWrites++; state[index] = typeof value === "function" ? value(state[index]) : value; }]; },
      useEffect: effect => { if (!cleanup) cleanup = effect(); },
      window: { setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) },
    }); return exports.value;
  };
  return { render, requests, calls, timers, props, lateWrites: () => lateWrites,
    select: taskId => { props.selectedTaskId = taskId; props.latest = latest(taskId); return render(); },
    unmount: () => { alive.current = false; cleanup?.(); },
  };
}

test("Recover checks the exact accepted turn without a message and both running footers use it", async t => {
  for (const [file, name] of [["AgentOrchestratorChat.tsx", "TurnRunning"], ["DshTranscript.tsx", "DshRunning"]]) await t.test(name, async () => {
    const ui = recoveryControls(), text = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let fn; const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node.getText(tree); ts.forEachChild(node, visit); }; visit(tree);
    const jsx = (type, props) => ({ type, props: props || {} }), exports = {};
    const context = { exports, useContext: () => ({ onRestart: ui.render().restartTurn, restarting: ui.render().restarting }), TurnRestart: {},
      useState: initial => [typeof initial === "function" ? initial() : initial, () => {}], useEffect() {}, useNow: () => 100,
      dshQuietNote: () => " · nothing new for 28m · may be stuck", dshRetryNote: () => "", cpaRefusalNote: () => "", waitsForPerson: () => false,
      dshDuration: () => "28m", WHALE: "", require: () => ({ jsx, jsxs: jsx, Fragment: "fragment" }) };
    vm.runInNewContext(ts.transpileModule("exports.render = " + fn, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
    const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
    const footer = () => exports.render({ turn: { steps: [{ name: "Agent", working: { stalled: true } }] }, divider: false });
    const button = () => walk(footer()).find(item => item.type === "button");
    assert.equal(button().props.children, "Recover"); button().props.onClick(); await new Promise(setImmediate);
    assert.equal(button().props.children, "Checking…"); assert.equal(button().props.disabled, true);
    assert.deepEqual(ui.requests[0].input, { taskId: "chat-a", runId: "run-chat-a", nodeId: "lead", requestKey: "request-chat-a", threadId: "thread-chat-a" });
    assert.deepEqual(ui.calls, []); assert.equal(ui.requests.length, 1); assert.equal("message" in ui.requests[0].input, false);
    ui.requests[0].resolve({ message: "Original turn observed; no message sent." }); await new Promise(setImmediate);
    assert.equal(button().props.children, "Recover"); assert.match(ui.render().recoveryMessage, /Original turn observed/); assert.equal(ui.timers.size, 0); ui.unmount();
  });
});

test("recovery status is bounded and belongs to its chat, request, and mounted owner", async t => {
  for (const change of ["navigate", "round trip", "new receipt", "unmount"]) await t.test(change, async () => {
    const ui = recoveryControls(); ui.render().restartTurn(); await new Promise(setImmediate);
    if (change === "navigate" || change === "round trip") ui.select("chat-b");
    if (change === "round trip") ui.select("chat-a");
    if (change === "new receipt") { ui.props.latest.nodes[0].receipt.request_key = "new-request"; ui.render(); }
    if (change === "unmount") ui.unmount();
    ui.requests[0].resolve({ message: "A's old result" }); await new Promise(setImmediate);
    if (change !== "unmount") { assert.equal(ui.render().restarting, false); assert.equal(ui.render().recoveryMessage, ""); ui.unmount(); }
    assert.equal(ui.lateWrites(), 0); assert.equal(ui.timers.size, 0); assert.deepEqual(ui.calls, []);
  });
  await t.test("timeout permits an explicit new check without old completion overwriting it", async () => {
    const ui = recoveryControls(); ui.render().restartTurn(); await new Promise(setImmediate);
    const timer = [...ui.timers.values()][0]; assert.ok(timer.delay >= 30_000 && timer.delay <= 60_000); timer.callback(); await new Promise(setImmediate);
    assert.equal(ui.render().restarting, false); assert.match(ui.render().recoveryMessage, /timed out/); assert.equal(ui.requests.length, 1, "no automatic repeat");
    ui.render().restartTurn(); await new Promise(setImmediate); assert.equal(ui.requests.length, 2);
    ui.requests[0].resolve({ message: "old result" }); await new Promise(setImmediate); assert.equal(ui.render().restarting, true); assert.equal(ui.render().recoveryMessage, "");
    ui.requests[1].resolve({ message: "new result" }); await new Promise(setImmediate); assert.equal(ui.render().restarting, false); assert.equal(ui.render().recoveryMessage, "new result");
    assert.equal(ui.timers.size, 0); ui.unmount();
  });
});

test("the Surface recovery callback only calls the contentless operation for the captured project", async () => {
  const calls = [], recover = rendererCallback("AgentOrchestratorSurface.tsx", "recoverChat", { workspaceId: "captured-project",
    moduleCall: async (operation, args) => { calls.push({ operation, args: plain(args) }); return { ok: true, recovery: "observed", message: "Original work kept" }; } });
  const input = { taskId: "chat-a", runId: "run-a", nodeId: "lead", requestKey: "accepted", threadId: "original" };
  assert.deepEqual(plain(await recover(input)), { message: "Original work kept" });
  assert.deepEqual(calls, [{ operation: "chat_recover", args: { workspaceId: "captured-project", ...input } }]);
});
function permissionWidgetRenderer() {
  // Reuse the existing permission-menu hook fixture, including its actual apply/notice lifecycle.
  const file = path.resolve(__dirname, "ao-permissions-renderer.test.cjs");
  const tree = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "renderer");
  assert.ok(declaration);
  const context = { fs, path, vm, ts, __dirname, view: undefined };
  vm.runInNewContext(declaration.getText(tree) + '\nview = renderer("AgentOrchestratorPermissions.tsx");', context);
  return context.view;
}

function permissionSaveFixture({ mode = "single", gateAt = "apply_team", cancel = false, missionOnly = false } = {}) {
  const route = label => ({ harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local",
    model: label + "-model", permission_profile: ":ao-default", native_permission_profile: ":workspace",
    approval_policy: "on-request", approvals_reviewer: "user" });
  const node = (label, id = "lead") => ({ id, template_role_id: "lead", task_id: "task-" + label, role: "planner",
    state: "finished", parents: [], x: 0, y: 0, settings: { name: "Assistant" }, route: route(label) });
  const team = label => ({ id: "team-" + label, workspace_id: "w", revision: 1, name: "Team " + label,
    worker_limit: 1, nodes: [node(label)] });
  const a = team("a"), b = team("b");
  const missions = ["a", "b"].map(label => ({ id: "run-" + label, workspace_id: "w", project_id: "task-" + label,
    revision: 7, execution_mode: mode, cancelled: false, worker_limit: 1, team: label === "a" ? a : b,
    nodes: [node(label, "node-" + label)] }));
  const savedA = missionOnly ? { ...a, revision: 2, nodes: [node("a", "new-role")] } : a;
  const backend = { runs: missions, teams: [savedA, b], team: savedA };
  const foreign = structuredClone(missions[1]); foreign.workspace_id = "other"; foreign.team.workspace_id = "other";
  const defaults = [], gate = delayedReply(), entered = delayedReply(), navigation = delayedReply();
  const f = surfaceComposer({ workspaceReady: true, workspaceId: "w", loadedWorkspace: "w",
    workspaces: [{ id: "w", name: "Fixture" }, { id: "other", name: "Other project" }], board: { revision: 1, tasks: [{ id: "task-a", title: "A" }, { id: "task-b", title: "B" }] },
    view: "chat", chatTaskId: "task-a", selectedRunId: "run-a", missions, savedTeams: backend.teams, team: savedA,
    composerMode: mode, composerTeamId: "team-a", singleRoute: route("a") }, {
    localStorage: { getItem: () => "w", setItem: (key, value) => { if (key !== "coding-tools:ao:workspace") defaults.push(JSON.parse(value)); } }, window: {}, setTimeout, clearTimeout,
  });
  const call = f.api.apps.call;
  let gated = false, operation, widget, unmounted = false;
  f.api.apps.call = async input => {
    const original = await call(input), change = input.arguments?.change;
    if (input.arguments?.workspaceId !== "w") {
      await navigation.promise;
      return { ok: true, result: input.operation === "board" ? { revision: 1, tasks: [{ id: "task-b", title: "Other B" }] }
        : plain({ runs: [foreign], teams: [foreign.team], team: foreign.team }) };
    }
    let response = original;
    if (input.operation === "permission_profiles") response = { ok: true, result: { capability: {
      supported: true, profiles: [{ id: ":workspace", allowed: true }], approval_policies: ["on-request"],
      approvals_reviewers: ["user", "auto_review"],
    } } };
    if (input.operation === "runs") response = { ok: true, result: plain(backend) };
    if (input.operation === "team_update" && change.operation === "save_team") {
      const next = { ...plain(change.team), revision: 2 };
      backend.teams = backend.teams.map(item => item.id === next.id ? next : item); backend.team = next;
      response = { ok: true, result: { team: next } };
    }
    if (input.operation === "team_update" && change.operation === "apply_team") response = { ok: true, result: { cancelled: cancel } };
    if (!gated && (input.operation === "team_update" && change.operation === gateAt || input.operation === "runs" && gateAt === "runs")) {
      gated = true; entered.resolve(); await gate.promise;
    }
    return response;
  };
  const commit = () => {
    f.render();
    const effect = f.effects.find(effect => String(effect).includes("hydratedComposer.current"));
    assert.ok(effect); effect(); return f.render();
  };
  const widgetTree = () => {
    const chat = unmounted ? undefined : f.currentChat();
    if (!chat) { widget = undefined; return; }
    const element = chat.props.permissions, key = f.permissionKey();
    const fresh = !widget || widget.key !== key;
    if (fresh) widget = { key, view: permissionWidgetRenderer() };
    const props = { ...element.props, save: (...args) => { operation = element.props.save(...args); return operation; } };
    let tree = widget.view.render("AgentOrchestratorPermissions", props);
    const owner = JSON.stringify([props.mission?.id, props.team?.id]);
    if (fresh || widget.owner !== owner) {
      widget.owner = owner;
      const effect = widget.view.effects.find(effect => String(effect).includes("popup.setOpen(false)"));
      assert.ok(effect); effect(); tree = widget.view.render("AgentOrchestratorPermissions", props);
    }
    return tree;
  };
  const chip = tree => f.walk(tree).find(item => item.type === "button" && item.props.className === "ao-composer-chip");
  const notice = () => f.walk(widgetTree()).filter(item => ["status", "alert"].includes(item.props?.role)).map(item => item.props.children).join(" ");
  return Object.assign(f, {
    backend, defaults, commit, widgetTree, notice,
    pending: () => chip(widgetTree()).props.disabled,
    async start() {
      commit(); chip(widgetTree()).props.onClick(); widgetTree();
      const load = widget.view.effects.find(effect => String(effect).includes("loadProfiles"));
      assert.ok(load); load(); await new Promise(setImmediate);
      const choices = f.walk(widgetTree()).filter(item => item.type === "button" && item.props.role === "menuitemradio");
      assert.equal(choices[1].props.disabled, false); choices[1].props.onClick();
      let timer;
      try { await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Save did not reach " + gateAt)), 5000); })]); }
      finally { clearTimeout(timer); }
      const close = f.walk(widgetTree()).find(item => item.props?.["aria-label"] === "Close permissions");
      assert.equal(close.props.disabled, undefined); close.props.onClick();
    },
    select(taskId, commitNow = true) {
      f.walk(f.render()).find(item => item.props?.actions?.select).props.actions.select(taskId);
      if (commitNow) { commit(); widgetTree(); }
    },
    preload() { f.walk(f.render()).find(item => item.props?.actions?.selectIn).props.actions.selectIn("other", "task-c"); },
    async workspace() {
      navigation.resolve(); f.walk(f.render()).find(item => item.props?.onWorkspace).props.onWorkspace("other"); f.render();
      const load = f.effects.find(effect => String(effect).includes("preloaded.current") && String(effect).includes("setBoard(null)"));
      assert.ok(load); const cleanup = load();
      try {
        await new Promise(setImmediate); f.render();
        const select = f.effects.find(effect => String(effect).includes("paneWanted.current") && String(effect).includes("pendingSelect.current"));
        assert.ok(select); select(); commit(); widgetTree();
        assert.equal(f.state.loadedWorkspace, "other"); assert.equal(f.state.chatTaskId, "task-b");
      } finally { cleanup(); }
    },
    inspect(taskId) {
      f.currentChat().props.onOpenTeam(); commit();
      f.walk(f.render()).find(item => item.type === "Canvas" && item.props.onSelect).props.onSelect("node-" + taskId);
      commit();
      return f.walk(f.render()).find(item => item.props?.draft && item.props.node?.id === "node-" + taskId);
    },
    unmount() {
      f.render(); const effect = f.effects.find(effect => String(effect).includes("mounted.current = true"));
      assert.ok(effect); effect()(); unmounted = true; widget = undefined;
    },
    async finish() {
      gate.resolve(); await operation.catch(() => {}); await new Promise(setImmediate); commit(); widgetTree();
      const applied = f.calls.find(call => call.operation === "team_update" && call.arguments.change.operation === "apply_team");
      assert.equal(applied.arguments.change.run_id, "run-a", "the accepted backend operation keeps its original chat");
      navigation.resolve(); await new Promise(setImmediate);
    },
  });
}

test("permission-save completion belongs to its chat and latest composer intent", async t => {
  for (const action of ["apply navigation", "refresh navigation", "new model", "model before commit", "new mode", "round trip", "preload", "cancelled navigation", "unmount", "unchanged"]) await t.test(action, async () => {
    const f = permissionSaveFixture({ gateAt: action === "refresh navigation" ? "runs" : "apply_team", cancel: action === "cancelled navigation" });
    await f.start();
    if (action.includes("navigation")) f.select("task-b");
    if (action === "round trip") { f.select("task-b", false); f.select("task-a", false); }
    if (action === "preload") f.preload();
    if (["new model", "model before commit"].includes(action)) {
      f.currentChat().props.composer.onRouteChange({ ...f.state.singleRoute, model: "newer-model", effort: "low" });
      if (action !== "model before commit") { f.commit(); f.widgetTree(); }
    }
    if (action === "new mode") { f.currentChat().props.composer.onModeChange("team"); f.commit(); f.widgetTree(); }
    if (action === "unmount") f.unmount();
    const pending = action !== "unmount" && f.pending();
    await f.finish();
    if (["apply navigation", "refresh navigation", "new model", "cancelled navigation", "round trip", "preload"].includes(action)) assert.equal(pending, false, "A's pending state cannot disable another owner");
    if (action.includes("navigation")) assert.equal(f.state.singleRoute.model, "b-model");
    else if (["new model", "model before commit"].includes(action)) assert.equal(f.state.singleRoute.model, "newer-model");
    if (action === "unchanged") {
      assert.equal(f.state.singleRoute.approvals_reviewer, "auto_review");
      assert.equal(f.defaults.at(-1).approvals_reviewer, "auto_review");
      assert.match(f.notice(), /Applies from the next turn/);
    } else {
      assert.equal(f.defaults.length, ["new model", "model before commit"].includes(action) ? 1 : 0, "an old save cannot rewrite remembered defaults");
      assert.equal(f.notice(), "", "old success/cancellation belongs to the retired permission widget");
      if (action === "round trip") assert.equal(f.state.singleRoute.approvals_reviewer, "user");
    }
  });
});

test("permission team saves update the shared catalog without replacing a newer role draft", async t => {
  for (const action of ["save navigation", "lookup navigation", "project navigation", "new role draft", "new team choice", "mission only", "unchanged"]) await t.test(action, async () => {
    const f = permissionSaveFixture({ mode: "team", gateAt: action === "lookup navigation" ? "runs" : action === "mission only" ? "apply_team" : "save_team", missionOnly: action === "mission only" });
    await f.start();
    if (action === "project navigation") await f.workspace();
    else if (action.includes("navigation") || action === "mission only") f.select("task-b");
    if (action.includes("navigation")) f.inspect("b");
    if (action === "new role draft") {
      const editor = f.inspect("a"), next = plain(f.state.draftTeam);
      next.nodes[0].route.model = "newer-role-model"; editor.props.change(next);
    }
    if (action === "new team choice") { f.currentChat().props.composer.onTeamChange("team-b"); f.commit(); f.widgetTree(); }
    await f.finish();
    if (action.includes("navigation")) {
      const editor = f.walk(f.render()).find(item => item.props?.draft && item.props.mission?.id === "run-b");
      assert.equal(editor.props.draft.id, "team-b");
    }
    if (action === "new role draft") assert.equal(f.state.draftTeam.nodes[0].route.model, "newer-role-model");
    if (action === "new team choice" || action === "mission only") { assert.equal(f.state.draftTeam, null); assert.equal(f.state.composerTeamId, "team-b"); }
    if (action === "project navigation") {
      assert.equal(f.state.team.id, "team-b");
      assert.deepEqual(plain(f.state.savedTeams.map(team => team.id)), ["team-b"]);
      assert.equal(f.backend.teams.find(team => team.id === "team-a").revision, 2, "A's backend save still completed in A's workspace");
    } else if (action !== "mission only") assert.equal(f.state.savedTeams.find(team => team.id === "team-a").revision, 2, "the shared A save remains valid");
    assert.equal(f.state.savedTeams.find(team => team.id === "team-b").nodes[0].route.model, "b-model");
    if (action === "unchanged") { assert.equal(f.state.draftTeam.id, "team-a"); assert.match(f.notice(), /Permissions saved/); }
  });
});

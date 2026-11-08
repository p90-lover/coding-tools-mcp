const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const load = (file, imports = {}) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => imports[name] ?? {} });
  return exports;
};
const chat = load("ao-chat.ts");
const transcript = load("chat-transcript.ts", { "./ao-chat": chat });
const item = (id, kind, text, extra = {}) => ({ id, kind, text, status: "completed", ...extra });
const message = (id, text) => item(id, "message", text);
const plain = value => JSON.parse(JSON.stringify(value));

test("a joined receipt leaves research and findings between their tools, with one final answer", () => {
  const items = [message("research", "I am checking the route."), item("read", "tool", "Read routes.ts"),
    message("finding", "## Bug found\nThe callback runs twice."), item("edit", "edit", "Edit routes.ts"), message("final", "Fixed and tested.")];
  const answer = items.filter(row => row.kind === "message").map(row => row.text).join("\n\n");
  const result = transcript.transcriptParts(items, answer);
  assert.equal(result.answer, "Fixed and tested.");
  assert.deepEqual(Array.from(result.items, row => row.id), ["research", "read", "finding", "edit"]);
  assert.deepEqual(Array.from(chat.groupTimeline(result.items), part => part.kind), ["item", "group", "item", "group"]);
});

test("a repeated phrase in the final report does not swallow an earlier finding", () => {
  const finding = message("finding", "The callback runs twice.");
  const answer = "Bug report: The callback runs twice. Reproduced with two events.";
  const result = transcript.transcriptParts([finding, item("tool", "tool", "Read"), message("final", answer)], answer);
  assert.deepEqual(Array.from(result.items, row => row.id), ["finding", "tool"]);
  assert.equal(result.answer, answer);
});

test("partial or absent work cannot silently replace the stored answer", () => {
  for (const items of [[], [message("partial", "Research so far.")]]) {
    assert.equal(transcript.transcriptParts(items, "Stored answer remains.").answer, "Stored answer remains.");
  }
  const items = [message("live", "Streaming commentary.")];
  assert.equal(transcript.transcriptParts(items).items, items);
});

test("whitespace-normalized receipt matching preserves the original Markdown", () => {
  const items = [message("a", "Research\n\n- detail"), message("b", "## Report\n\n**Fixed**")];
  const result = transcript.transcriptParts(items, "Research - detail ## Report **Fixed**");
  assert.equal(result.answer, "## Report\n\n**Fixed**");
  assert.equal(result.items[0].text, "Research\n\n- detail");
});

test("answered questions and steers are not treated as assistant answer duplicates", () => {
  const items = [message("question", "Yes", { answered: { question: "Proceed?", answer: "Yes" } }), item("steer", "steer", "Yes"), message("final", "Yes")];
  items[0].answered = { question: "Proceed?", answer: "Yes" };
  assert.deepEqual(Array.from(transcript.transcriptParts(items, "Yes").items, row => row.id), ["question", "steer"]);
});

test("completion summary counts invocations, not polls or approvals", () => {
  const read = item("read", "tool", "mcp__coding-tools__read_file source.ts");
  const summary = transcript.transcriptSummary([read, read, item("cmd", "tool", "exec_command git status"),
    item("output", "tool", "read_output"), item("search", "tool", "Grep"), item("approve", "approval", "Allowed")]);
  assert.equal(summary.text, "Ran a command, read a file, searched code, used a tool");
});

test("the one-line summary counts other tools instead of naming them, and says only how many failed", () => {
  const summary = transcript.transcriptSummary([item("list", "tool", "ListAgents"),
    ...[1, 2, 3, 4].map((n) => item(`send${n}`, "tool", "SendMessage", n === 4 ? { status: "failed" } : {})),
    item("denied", "command", "git push", { approval: "Denied by the reviewer" })]);
  assert.equal(summary.text, "Ran a command, used 5 tools · 2 failed");
  assert.doesNotMatch(summary.text, /listagents|sendmessage|×|denied/i, "no raw tool names, tallies or 'failed or denied'");
});

test("successful file metadata counts even on an MCP tool; failed edits do not", () => {
  const file = { path: "src/chat.ts", additions: 8, deletions: 3 };
  const edit = item("edit", "tool", "apply_patch", { files: [file] });
  const summary = transcript.transcriptSummary([edit, edit,
    item("denied", "edit", "Edit", { status: "completed", approval: "Denied by the reviewer", files: [file] }),
    item("failed", "edit", "Edit", { status: "failed", files: [file] }),
    item("running", "edit", "Edit", { status: "running", files: [file] })]);
  assert.deepEqual(plain(summary.files), [file]);
  assert.equal(summary.additions, 8);
  assert.equal(summary.deletions, 3);
  assert.equal(summary.failed, 2);
  assert.match(summary.text, /^Edited a file/);
});

test("repeated real edits sum line changes but count a file once", () => {
  const summary = transcript.transcriptSummary([item("one", "edit", "Edit", { files: [{ path: "src/a.ts", additions: 3, deletions: 1 }] }),
    item("two", "edit", "Edit", { files: [{ path: "src/a.ts", additions: 2, deletions: 0 }] })]);
  assert.equal(summary.files.length, 1);
  assert.equal(summary.additions, 5);
  assert.equal(summary.deletions, 1);
});

test("no tools and unverified edits do not invent changed files", () => {
  assert.equal(transcript.transcriptSummary([]).text, "No tool calls");
  const summary = transcript.transcriptSummary([item("edit", "tool", "Edit", { input: '{"file_path":"secret.ts"}' })]);
  assert.equal(summary.files.length, 0);
  assert.equal(summary.text, "Made an edit");
});

test("each work step gets the colour family of what it did, whatever label or harness named it", () => {
  const family = (kind, extra = {}) => transcript.stepFamily(item(`${kind}${JSON.stringify(extra)}`, kind, extra.text ?? "", extra));
  assert.equal(family("reasoning"), "think");
  assert.equal(family("command", { text: "npm test" }), "command");
  assert.equal(family("edit"), "edit");
  // ACP's tool kinds arrive as labels; an MCP tool by its own name, not its "MCP" label.
  assert.equal(family("tool", { label: "Read", text: "Read src/app.ts" }), "read");
  assert.equal(family("tool", { label: "Search", text: "Grep" }), "search");
  assert.equal(family("tool", { label: "Fetch", text: "WebFetch" }), "web");
  assert.equal(family("tool", { label: "Thought", text: "think" }), "think");
  assert.equal(family("tool", { label: "Command", text: "Bash" }), "command");
  assert.equal(family("tool", { label: "MCP", text: "mcp__coding-tools__read_file" }), "read");
  assert.equal(family("tool", { label: "MCP", text: "mcp__claude-artifacts__publish_version" }), "tool");
  assert.equal(family("tool", { label: "Tool", text: "update_plan" }), "plan");
  assert.equal(family("tool", { text: "subagent_start" }), "agent");
  // Native Codex steps carry only a label.
  assert.equal(family("tool", { label: "Edited", text: "app.ts" }), "edit");
  assert.equal(family("tool", { label: "Web search", text: "release notes" }), "web");
  assert.equal(family("approval", { label: "Approval timed out" }), "approval");
  assert.equal(family("system"), "note");
});

test("a fold's chips count each family once per step, failures apart, in reading order", () => {
  const items = [item("r1", "reasoning", "Plan"), item("c1", "command", "npm test", { status: "failed" }), item("c1", "command", "npm test", { status: "failed" }),
    item("t1", "tool", "Read a.ts", { label: "Read" }), item("r2", "reasoning", "Fix"), item("c2", "command", "npm test"), message("m", "Done."),
    item("e1", "edit", "a.ts", { files: [{ path: "a.ts", additions: 2, deletions: 1 }] })];
  assert.deepEqual(plain(transcript.stepFamilyCounts(items)), [
    { family: "think", count: 2, failed: 0 }, { family: "read", count: 1, failed: 0 },
    { family: "command", count: 2, failed: 1 }, { family: "edit", count: 1, failed: 0 },
  ], "a repeated id is one step, and a message is not a step");
  assert.equal(transcript.stepFamilyNoun("command", 1), "1 command");
  assert.equal(transcript.stepFamilyNoun("search", 3), "3 searches");
  assert.equal(transcript.stepFamilyNoun("web", 2), "2 web lookups");
});

test("a step's time reads in tenths under ten seconds, then as the turn's own durations", () => {
  assert.equal(transcript.stepDuration(undefined), "");
  assert.equal(transcript.stepDuration(0), "");
  assert.equal(transcript.stepDuration(40), "0.1s", "an instant call still shows it was timed");
  assert.equal(transcript.stepDuration(1840), "1.8s");
  assert.equal(transcript.stepDuration(9_960), "10s", "whole seconds from ten on, never \"10.0s\"");
  assert.equal(transcript.stepDuration(42_000), "42s");
  assert.equal(transcript.stepDuration(113_000), "1m 53s");
});

test("a turn's tone follows its completion words: failed, stopped, waiting, done", () => {
  const base = { steps: [], status: "done" };
  assert.equal(transcript.transcriptTone(base), "done");
  assert.equal(transcript.transcriptTone({ ...base, steps: [{ error: "Blocked" }] }), "failed");
  assert.equal(transcript.transcriptTone({ ...base, final: { error: "Blocked" } }), "failed");
  assert.equal(transcript.transcriptTone({ ...base, status: "stopped" }), "stopped");
  assert.equal(transcript.transcriptTone({ ...base, status: "attention" }), "waiting");
  assert.equal(transcript.transcriptTone({ ...base, status: "running" }), "working");
});

test("completed turn is distinct from achieved goal and preserves non-success states", () => {
  const base = { steps: [], status: "done", startedAtMs: 1000, endedAtMs: 4000 };
  // Codex's words for folded work.
  assert.equal(transcript.transcriptCompletion(base), "Worked for 3s");
  assert.equal(transcript.transcriptCompletion({ ...base, endedAtMs: undefined }), "Worked");
  for (const [status, expected] of [["stopped", "Stopped after 3s"], ["attention", "Waiting for input · 3s"], ["paused", "Waiting for input · 3s"], ["running", "Working"]]) {
    assert.equal(transcript.transcriptCompletion({ ...base, status }), expected);
  }
  assert.equal(transcript.transcriptCompletion({ ...base, steps: [{ error: "Blocked by quota" }] }), "Failed after 3s");
  assert.doesNotMatch(transcript.transcriptCompletion(base), /Goal completed|Task completed/);
});

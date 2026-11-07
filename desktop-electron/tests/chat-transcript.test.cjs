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

test("completion summary names MCP tools and counts invocations, not polls or approvals", () => {
  const read = item("read", "tool", "mcp__coding-tools__read_file source.ts");
  const summary = transcript.transcriptSummary([read, read, item("cmd", "tool", "exec_command git status"),
    item("output", "tool", "read_output"), item("search", "tool", "Grep"), item("approve", "approval", "Allowed")]);
  assert.equal(summary.text, "Ran a command, read a file, searched code, read_output");
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

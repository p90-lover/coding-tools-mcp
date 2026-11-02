const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => name === "react" || name === "react/jsx-runtime" ? require(name) : imports[name] ?? {} });
  return exports;
}
const chat = load("ao-chat.ts");
const markdown = load("ChatMarkdown.tsx", { "./chat-markdown": load("chat-markdown.ts") });
const parts = load("ChatToolParts.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown });
const { DshTurnWork } = load("DshTranscript.tsx", { "./ao-chat": chat, "./ChatMarkdown": markdown, "./ChatToolParts": parts });

function render({ state = "running", text, timeline = [], activity, hasWork, final = false, earlier } = {}) {
  const live = state === "running";
  const step = { key: "run:lead", nodeId: "lead", role: "planner", name: "DeepSeek V4.1 Flash", detail: "", state, text, hasWork, earlier,
    ...(live ? { working: { detail: "", stalled: false, activity, timeline } } : {}) };
  const turn = { key: "run", runId: "run", status: live ? "running" : state === "finished" ? "done" : "stopped", solo: false,
    steps: final ? [] : [step], ...(final ? { final: step } : {}) };
  return renderToStaticMarkup(React.createElement(DshTurnWork, { turn, live, expanded: true, useWork: () => timeline }));
}

for (const state of ["running", "held", "cancelled"]) {
  test(`a ${state} single DeepSeek card keeps its stored reply without a timeline`, () => {
    const html = render({ state, text: "The parser is fixed; validation is still pending." });
    assert.match(html, /The parser is fixed; validation is still pending\./);
    assert.doesNotMatch(html, /Loading…|Waiting for the model/);
  });
}

test("a stored reply shows once alongside the work, not once per timeline message", () => {
  const text = "I found the parser bug.\n\nI am checking its callers.";
  const html = render({ state: "held", text, timeline: [
    { id: "m1", kind: "message", status: "completed", text: "I found the parser bug." },
    { id: "read", kind: "tool", status: "completed", text: "Read", input: JSON.stringify({ path: "parser.ts" }) },
    { id: "m2", kind: "message", status: "completed", text: "I am checking its callers." },
  ] });
  assert.equal(html.split("I found the parser bug.").length - 1, 1);
  assert.equal(html.split("I am checking its callers.").length - 1, 1);
  assert.match(html, /read files/i, "the tool work remains available");
});

test("a final reply remains outside the work instead of being duplicated inside it", () => {
  const text = "All checks passed.";
  const html = render({ state: "finished", text, final: true, timeline: [{ id: "m", kind: "message", status: "completed", text }] });
  assert.doesNotMatch(html, /All checks passed\./);
});

test("a running timeline reply still streams when the card has no stored reply", () => {
  const html = render({ timeline: [{ id: "m", kind: "message", status: "running", text: "The new response is streaming." }] });
  assert.match(html, /The new response is streaming\./);
  assert.doesNotMatch(html, /Waiting for the model/);
});

test("a turn without visible output reports the backend activity rather than a blank body", () => {
  assert.match(render({ activity: "waiting for the model" }), /class="dsh-hint" role="status">waiting for the model</);
  assert.match(render(), /Waiting for the model&#x27;s first response…/);
});

test("a finished card without a reply still shows its work loading state", () => {
  assert.match(render({ state: "finished", hasWork: true }), /Loading…/);
});

test("a held reply remains readable even while its saved work is unavailable", () => {
  const html = render({ state: "held", text: "Partial response is recoverable.", hasWork: true });
  assert.match(html, /Partial response is recoverable\./);
  assert.doesNotMatch(html, /Loading…/);
});

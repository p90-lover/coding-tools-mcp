"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const chat = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: chat });
const plain = (value) => JSON.parse(JSON.stringify(value));
const annotations = [{ text: "OCR workers\n多个账号：每个窗口一个 worker", comment: "Keep this with my message" }];
const message = chat.chatMessageWithAnnotations(chat.chatMessageWithAttachments("Can OCR handle multiple accounts?", [
  { name: "ocr.png", path: "G:/fixtures/ocr.png", image: true },
]), annotations);

function world(timeline, state = "finished") {
  const node = { id: "p", role: "planner", state, route: { harness_id: "ao:claude-code", model: "cpa/test" },
    receipt: { status: "completed", thread_id: "s", turn_id: "t" } };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "r", workspace_id: "ws", nodes: [node] }] };
      throw new Error(`Unexpected ${endpoint}`);
    },
    aoHarness: {
      timeline: async () => timeline,
      observe: async () => ({ turnId: "t", turnState: "running", timeline }),
    },
    confirm: async () => true,
  });
  return workflow;
}
const steer = (text = message) => ({ id: "steer", kind: "steer", status: "completed", text });
const read = (workflow) => workflow.call("turn_timeline", { workspaceId: "ws", runId: "r", nodeId: "p" });

function assertComplete(item) {
  assert.equal(item.text, message, "the workflow must not cut the user's message into an annotation preamble");
  const parts = plain(chat.chatMessageParts(item.text));
  assert.equal(parts.text, "Can OCR handle multiple accounts?");
  assert.deepEqual(parts.annotations, annotations);
  assert.deepEqual(parts.attachments, [{ image: true, name: "ocr.png", path: "G:/fixtures/ocr.png" }]);
}

test("a saved annotated steer keeps its message, selections, comments and attachments together", async () => {
  const { timeline } = await read(world([steer()]));
  assert.equal(timeline.length, 1);
  assertComplete(timeline[0]);
});

test("a live annotated steer is identical to the sent message for pending-steer deduplication", async () => {
  const workflow = world([steer()], "running");
  await workflow.call("activity", { workspaceId: "ws", runId: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await workflow.call("activity", { workspaceId: "ws", runId: "r" });
  assertComplete(result.nodes.p.timeline[0]);
});

test("timeline response pressure never splits an annotation block, while tool previews stay bounded", async () => {
  const longMessage = chat.chatMessageWithAnnotations("the message ends here", [{ text: "选".repeat(4000), comment: "keep all of this" }]);
  const items = [steer(longMessage), ...Array.from({ length: 60 }, (_, index) => ({
    id: `thought-${index}`, kind: "reasoning", status: "completed", text: "x".repeat(60_000),
  })), { id: "command", kind: "command", status: "completed", text: "x".repeat(1000) }];
  const result = await read(world(items));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
  assert.equal(result.timeline.find((item) => item.kind === "steer").text, longMessage, "keep complete messages, not invalid JSON prefixes");
  assert.equal(result.timeline.find((item) => item.kind === "command").text.length, 400);
});

test("preserving steer text still redacts credentials beyond the old 400-character cutoff", async () => {
  const { timeline } = await read(world([steer(`${message}\nAuthorization: Bearer SECRET_TOKEN`)]));
  assert.doesNotMatch(timeline[0].text, /SECRET_TOKEN/);
  assert.match(timeline[0].text, /Can OCR handle multiple accounts\?/);
});

function mountAnnotations(component, props) {
  const states = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (next) => { states[at] = typeof next === "function" ? next(states[at]) : next; }];
    },
    useRef: (current) => ({ current }), useEffect() {},
  };
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ChatAnnotations.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, window: { clearTimeout() {}, setTimeout: () => 0 },
    require: (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : {} });
  return () => { cursor = 0; return exports[component](props); };
}
const walk = (item) => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
const text = (item) => item == null || typeof item === "boolean" ? "" : typeof item !== "object" ? String(item)
  : Array.isArray(item) ? item.map(text).join("") : text(item.props?.children);

test("sent annotations open Codex-style structured details with full selections and comments", () => {
  const render = mountAnnotations("SentAnnotations", { annotations });
  const all = () => walk(render());
  const button = () => all().find((item) => item.type === "button");
  assert.equal(text(button()), "1 annotation");
  assert.equal(button().props["aria-expanded"], false);
  button().props.onClick();
  assert.equal(button().props["aria-expanded"], true);
  const list = all().find((item) => item.type === "ol");
  assert.equal(text(list), `1.Selected text:${annotations[0].text}User comment:${annotations[0].comment}`);
  assert.equal(walk(list).filter((item) => item.type === "button" || item.type === "input").length, 0, "sent details are read-only");
  assert.equal(all().filter((item) => item.props.title).length, 0, "not the old truncated native tooltip");
  let prevented = false, stopped = false;
  render().props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(prevented && stopped);
  assert.equal(button().props["aria-expanded"], false);
});

test("editing an annotation saves only its comment, never submits the surrounding composer", () => {
  const comments = [], removed = [];
  const render = mountAnnotations("AnnotationTray", { annotations: [{ ...annotations[0], id: 42 }],
    onComment: (...args) => comments.push(args), onRemove: (id) => removed.push(id), onClear() {} });
  const all = () => walk(render());
  render().props.onMouseEnter();
  all().find((item) => item.props["aria-label"] === "Edit annotation 1").props.onClick();
  all().find((item) => item.type === "input").props.onChange({ target: { value: "keep both together" } });
  let prevented = false, stopped = false;
  all().find((item) => item.type === "input").props.onKeyDown({ key: "Enter",
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(prevented && stopped, "Enter belongs to the comment, not the message form");
  assert.deepEqual(comments, [[42, "keep both together"]]);
  all().find((item) => item.props["aria-label"] === "Remove annotation 1").props.onClick();
  assert.deepEqual(removed, [42]);
});

test("an open comment follows its annotation id, not its array position or another chat", () => {
  const comments = [];
  const props = { annotations: [{ ...annotations[0], id: 42 }], onComment: (...args) => comments.push(args), onRemove() {}, onClear() {} };
  const render = mountAnnotations("AnnotationTray", props);
  const all = () => walk(render());
  render().props.onMouseEnter();
  all().find((item) => item.props["aria-label"] === "Edit annotation 1").props.onClick();
  all().find((item) => item.type === "input").props.onChange({ target: { value: "this selection only" } });
  props.annotations = [{ text: "earlier note restored from the queue", comment: "", id: 41 }, ...props.annotations];
  const input = all().find((item) => item.type === "input");
  assert.equal(input.props["aria-label"], "Comment on annotation 2");
  input.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(comments, [[42, "this selection only"]]);
  all().find((item) => item.props["aria-label"] === "Edit annotation 2").props.onClick();
  const oldInput = all().find((item) => item.type === "input");
  props.annotations = [{ text: "another chat's selection", comment: "", id: 43 }];
  assert.equal(all().find((item) => item.type === "input"), undefined, "never edit the same position in a different chat");
  oldInput.props.onBlur();
  assert.ok(comments.every(([id]) => id === 42), "a stale blur cannot write to the other chat");
});

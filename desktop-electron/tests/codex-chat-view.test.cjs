"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const transpile = (file, require, globals = {}) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require, ...globals });
  return exports;
};
const chat = transpile("ao-chat.ts", () => ({}));
const walk = (item) => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
const text = (item) => item === null || item === undefined || typeof item === "boolean" ? "" : typeof item !== "object" ? String(item)
  : Array.isArray(item) ? item.map(text).join("") : text(item.props?.children);
const node = (id, role, state, extra = {}) => ({ id, role, state, x: 0, ...extra });
const run = (id, taskId, nodes, extra = {}) => ({ id, project_id: taskId, cancelled: false, nodes, ...extra });

function mount(props) {
  const states = []; let cursor = 0;
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (value) => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
    },
    useMemo: (calculate) => calculate(), useEffect() {}, useRef: (initial) => ({ current: initial }),
  };
  // Function components render inline, so their output (work lines, steps, actions) is visible.
  const jsx = (type, props) => typeof type === "function" ? type(props || {}) : ({ type, props: props || {} });
  const module = transpile("AgentOrchestratorChat.tsx", (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name === "./ao-chat" ? chat : name === "../icons" ? { Icon: "Icon" } : name === "./ChatMarkdown" ? { ChatMarkdown: "Markdown" }
      : name === "./ChatMenu" ? { ChatMenu: "ChatMenu" } : name === "./AgentOrchestratorComposerControls" ? { AgentOrchestratorComposerControls: "Controls" }
        : name === "./AgentOrchestratorApproval" ? { AgentOrchestratorApproval: "Approval" } : {},
  { window: { setTimeout: () => 0, setInterval: () => 0, clearInterval() {} }, document: { querySelector: () => null }, navigator: {} });
  return { render: (next = {}) => { cursor = 0; return module.AgentOrchestratorChat({ ...props, ...next }); } };
}

function base(extra = {}) {
  const calls = [];
  return {
    calls,
    props: {
      runs: [], tasks: [], selectedTaskId: "", busy: false, loadDescription: async () => "", openStructure() {}, approvals: [], approve() {},
      describeRoute: () => "", retryStart() {}, projectName: "Alpha",
      send: async (input) => { calls.push(["send", input]); }, stop: (id) => calls.push(["stop", id]), restart: (id) => calls.push(["restart", id]),
      ...extra,
    },
  };
}

test("a new chat greets with the project name, Codex-style", () => {
  const { props } = base({ composer: { mode: "team" } });
  const view = mount(props).render();
  const heading = walk(view).find((element) => element.type === "h1");
  assert.equal(text(heading), "What should we build in Alpha?");
  assert.equal(walk(view).find((element) => element.type === "textarea").props.placeholder, "Do anything");
});

test("a turn shows the user bubble, the live work line and a stop button; Esc stops", () => {
  const now = Date.now();
  const { props, calls } = base({
    selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "plan", started_at_ms: now - 65_000 } }),
      node("w", "worker", "running", { receipt: { started_at_ms: now - 30_000 } })])],
    activity: { "r1:w": { activity: "running a command", last_event_at_ms: now - 1_000, turn_started: true } },
  });
  const chatView = mount(props);
  const view = chatView.render();
  const work = walk(view).find((element) => element.props?.className === "cx-work-head");
  assert.match(text(work), /^Working for 1m · Worker — running a command$/);
  const stop = walk(view).find((element) => element.props?.["aria-label"] === "Stop (Esc)");
  assert.ok(stop, "a running chat shows Stop in place of Send");
  stop.props.onClick();
  walk(view).find((element) => element.type === "textarea").props.onKeyDown({ key: "Escape", shiftKey: false, preventDefault() {} });
  assert.deepEqual(calls, [["stop", "r1"], ["stop", "r1"]]);
});

test("the reviewer's answer closes the turn in full, with Retry on the latest settled run", () => {
  const { props, calls } = base({
    selectedTaskId: "t",
    runs: [run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "plan" } }),
      node("rev", "reviewer", "finished", { receipt: { answer: "APPROVED — **done**", verdict: "APPROVED" } })])],
  });
  const view = mount(props).render();
  const answer = walk(view).find((element) => element.props?.className === "cx-answer has-verdict");
  assert.ok(answer);
  assert.equal(walk(answer).find((element) => element.type === "Markdown").props.text, "APPROVED — **done**");
  assert.equal(text(walk(view).find((element) => element.props?.className === "cx-work-head")), "Worked · 1 step");
  walk(answer).find((element) => element.props?.["aria-label"] === "Retry this mission").props.onClick();
  assert.deepEqual(calls, [["restart", "r1"]]);
});

test("slash commands open a menu and run on Enter; attachments are sent with the message", async () => {
  const { props, calls } = base({ selectedTaskId: "t", runs: [run("r1", "t", [node("p", "planner", "running")])], working: false,
    filePath: (file) => file.path ?? "" });
  const chatView = mount(props);
  let view = chatView.render();
  walk(view).find((element) => element.type === "textarea").props.onChange({ target: { value: "/st" } });
  view = chatView.render();
  const options = walk(view).filter((element) => element.props?.role === "option");
  assert.deepEqual(options.map((option) => text(option)), ["/stopStop the running mission", "/structureShow or hide the cards panel"]);
  walk(view).find((element) => element.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
  assert.deepEqual(calls, [["stop", "r1"]]);

  const sending = mount({ ...props, runs: [run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "ok" } })])] });
  view = sending.render();
  await walk(view).find((element) => element.type === "input" && element.props.type === "file").props.onChange({
    target: { files: [{ name: "shot.png", type: "image/png", path: "C:\\shots\\shot.png", size: 10 }], value: "x" },
  });
  view = sending.render();
  walk(view).find((element) => element.type === "textarea").props.onChange({ target: { value: "look at this" } });
  view = sending.render();
  await walk(view).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["send", { taskId: "t", message: "look at this\n\nAttached image: C:\\shots\\shot.png" }]);
});

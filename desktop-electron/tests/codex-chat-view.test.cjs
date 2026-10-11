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
const prompts = transpile("codex-prompts.ts", () => ({}));
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
    : name === "./ao-chat" ? chat : name === "./codex-prompts" ? prompts : name === "../icons" ? { Icon: "Icon" } : name === "./ChatMarkdown" ? { ChatMarkdown: "Markdown" }
      : name === "./ChatMenu" ? { ChatMenu: "ChatMenu", ChatGlyph: "Glyph", FloatingLayer: "FloatingLayer" } : name === "./AgentOrchestratorComposerControls" ? { AgentOrchestratorComposerControls: "Controls" }
        : name === "./AgentOrchestratorApproval" ? { AgentOrchestratorApproval: "Approval" } : {},
  { window: { setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, confirm: () => true }, document: { querySelector: () => null }, navigator: {} });
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

test("the new chat's project chip opens Codex's project picker: search, projects, New project", () => {
  const picked = [];
  const { props } = base({ projectId: "a", onPickProject: (id, draft) => picked.push([id, draft]),
    projects: [{ id: "a", name: "Alpha", path: "C:\\alpha" }, { id: "b", name: "coding tools", path: "G:\\Projects\\coding-tools-mcp" }] });
  const view = mount(props);
  const chip = walk(view.render()).find((element) => element.type === "button" && element.props["aria-haspopup"] === "dialog");
  chip.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 500 }) } });
  const pickerOf = () => walk(view.render()).find((element) => element.type === "FloatingLayer" && element.props.className === "cx-project-picker");
  const options = walk(pickerOf()).filter((element) => element.props?.role === "option");
  assert.deepEqual(options.map((option) => [text(option).replace(/\s+/g, " ").trim(), option.props["aria-selected"]]),
    [["Alpha✓", true], ["coding toolscoding-tools-mcp", false]], "the folder name shows when it differs, and the open project is checked");
  options[1].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(picked)), [["b", { title: "", text: "" }]], "picking a project carries the typed draft");
  chip.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 500 }) } });
  const actions = walk(pickerOf()).filter((element) => element.type === "button" && String(element.props.className).includes("cx-picker-action"));
  assert.deepEqual(actions.map((action) => [text(action).trim(), Boolean(action.props.disabled)]),
    [["New project", true], ["✕Don't work in a project", true]], "New project needs onAddProject; a project is always required");
});

test("the new chat is Codex's: no subtitle, a mic, and the gear opens the environment popover with the branch", () => {
  const { props } = base({ composer: { mode: "single" }, projectBranch: "main", onSettings() {} });
  const view = mount(props);
  const empty = walk(view.render()).find((element) => element.props?.className === "cx-empty");
  assert.equal(walk(empty).filter((element) => element.type === "p").length, 0, "Codex has no subtitle under the question");
  assert.equal(walk(view.render()).find((element) => element.props?.["aria-label"] === "Voice input").props.disabled, true);
  const gear = { getBoundingClientRect: () => ({ right: 600, top: 500 }) };
  const pressGear = () => walk(view.render()).find((element) => element.props?.["aria-label"] === "Configure local environment").props.onClick({ currentTarget: gear });
  const menuOf = () => walk(view.render()).find((element) => element.type === "ChatMenu").props.menu;
  pressGear();
  const menu = menuOf();
  assert.equal(menu.owner, gear, "the menu knows its button, so ChatMenu leaves presses on it to the button");
  assert.deepEqual(JSON.parse(JSON.stringify(menu.items.map((item) => [item.label, item.detail ?? null, item.toggle ?? null]))),
    [["New worktree", null, false], ["Branch", "main", null], ["Environment", "No environment", null]],
    "orchestrator settings stay in the header's ⋯ menu, not the environment popover");
  pressGear();
  assert.equal(menuOf(), null, "pressing the gear again closes its menu rather than reopening it");
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
  assert.deepEqual(options.map((option) => text(option)), ["/statusShow chat ID, context usage, cards and goal", "/stopStop the running mission", "/structureShow or hide the cards panel"]);
  walk(view).find((element) => element.type === "textarea").props.onChange({ target: { value: "/sto" } });
  view = chatView.render();
  walk(view).find((element) => element.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
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

test("Codex slash commands run from the composer in a Single chat or a team, with their real actions", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const actions = [];
  let planMode = false, goal = null;
  const commands = () => ({
    goal, planMode,
    setPlanMode: (on) => { actions.push(["plan", on]); planMode = on; },
    goalAction: async (action) => { actions.push(["goal", action]); },
    goalEdit: async (objective) => { actions.push(["edit", objective]); },
    compact: async () => { actions.push(["compact"]); return "Compacted this chat's context from 7,000 to 900 characters (11% full)."; },
    diff: async () => ({ title: "Changes · 1 file", mono: true, text: "diff --git a/x b/x" }),
    mcp: async () => ({ title: "MCP", rows: [["Server", "running"]] }),
    status: () => ({ title: "Status", rows: [["Chat ID", "t"], ["Mode", "Team · Workspace team"]] }),
    recent: () => ({ title: "Resume a chat", items: [{ label: "Older chat", detail: "done", run: () => actions.push(["open", "older"]) }] }),
  });
  const type = (view, value) => walk(view.render({ commands: commands() })).find((element) => element.type === "textarea").props.onChange({ target: { value } });
  const enter = async (view) => {
    walk(view.render({ commands: commands() })).find((element) => element.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
    await settle(); await settle();
  };
  const cardOf = (view) => walk(view.render({ commands: commands() })).find((element) => String(element.props?.className).includes("cx-command-card"));

  // A new chat: /goal starts it with the goal; /review and /init send Codex's prompts.
  const fresh = base({});
  const newChat = mount(fresh.props);
  type(newChat, "/goal make every test pass"); await enter(newChat);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.calls.at(-1))), ["send", { message: "make every test pass", goal: "make every test pass" }]);
  type(newChat, "/review the auth changes"); await enter(newChat);
  assert.match(fresh.calls.at(-1)[1].message, /^Review the current code changes \(staged, unstaged, and untracked files\)\. Do not change any files\.\nFocus: the auth changes/);
  assert.match(fresh.calls.at(-1)[1].message, /\[P0\][\s\S]*patch is correct/);
  type(newChat, "/init"); await enter(newChat);
  assert.match(fresh.calls.at(-1)[1].message, /^Generate a file named AGENTS\.md that serves as a contributor guide for this repository\./);
  // /plan turns plan mode on; a message then asks for a plan instead of the change.
  type(newChat, "/plan"); await enter(newChat);
  assert.deepEqual(actions.at(-1), ["plan", true]);
  type(newChat, "add dark mode"); await enter(newChat);
  assert.match(fresh.calls.at(-1)[1].message, /^\[Plan mode\] Do not change anything[\s\S]*Request:\nadd dark mode$/);
  planMode = false;
  // The menu fills in a command that takes an argument instead of running it bare.
  type(newChat, "/go");
  const option = walk(newChat.render({ commands: commands() })).find((element) => element.props?.role === "option");
  walk(option).find((element) => element.type === "button").props.onClick();
  assert.equal(walk(newChat.render({ commands: commands() })).find((element) => element.type === "textarea").props.value, "/goal ");

  // A working team chat: /status, /goal pause and /compact's refusal still run; a goal shows its pill.
  goal = { objective: "ship the release", status: "active", round: 2, rounds: 6, startedAt: Date.now() - 5 * 60_000, updatedAt: Date.now(), note: "" };
  const busy = base({ selectedTaskId: "t", runs: [run("r1", "t", [node("p", "planner", "running")])], working: true });
  const teamChat = mount(busy.props);
  type(teamChat, "/status"); await enter(teamChat);
  assert.match(text(cardOf(teamChat)), /StatusChat IDtModeTeam · Workspace team/);
  type(teamChat, "/goal pause"); await enter(teamChat);
  assert.deepEqual(actions.at(-1), ["goal", "pause"]);
  type(teamChat, "/compact"); await enter(teamChat);
  assert.match(text(cardOf(teamChat)), /Compact is disabled while a chat is in progress/);
  type(teamChat, "/review"); await enter(teamChat);
  assert.match(text(cardOf(teamChat)), /Queued: it's sent when the current turn finishes/, "a command that sends queues behind the working turn");
  assert.equal(busy.calls.filter((call) => call[0] === "send").length, 0, "nothing is sent while the turn works");
  const pill = walk(teamChat.render({ commands: commands() })).find((element) => String(element.props?.className).startsWith("cx-goal "));
  assert.match(text(pill), /^Pursuing goalship the release5m \d+s$/, "Codex's goal bar: state, objective, running time");
  assert.deepEqual(walk(pill).filter((element) => element.type === "button").map((button) => button.props.title), ["Clear goal", "Pause goal", "Edit goal"]);
  walk(pill).find((element) => element.type === "button" && element.props.title === "Pause goal").props.onClick();
  await settle(); await settle();
  assert.deepEqual(actions.at(-1), ["goal", "pause"]);
  // Edit goal opens an editor; Save sends the new objective and closes it.
  walk(pill).find((element) => element.type === "button" && element.props.title === "Edit goal").props.onClick();
  await settle(); await settle();
  const editor = () => walk(teamChat.render({ commands: commands() })).find((element) => element.type === "section" && element.props?.["aria-label"] === "Edit goal");
  assert.equal(walk(editor()).find((element) => element.type === "textarea").props.value, "ship the release");
  walk(editor()).find((element) => element.type === "textarea").props.onChange({ target: { value: "ship the release with notes" } });
  walk(editor()).find((element) => element.type === "button" && text(element) === "Save").props.onClick();
  await settle(); await settle();
  assert.deepEqual(actions.at(-1), ["edit", "ship the release with notes"]);
  assert.equal(editor(), undefined, "the editor closes after saving");
  // A paused goal offers Resume instead of Pause.
  goal = { ...goal, status: "paused" };
  const pausedPill = walk(teamChat.render({ commands: commands() })).find((element) => String(element.props?.className).startsWith("cx-goal "));
  assert.match(text(pausedPill), /^Paused goal/);
  assert.ok(walk(pausedPill).some((element) => element.type === "button" && element.props.title === "Resume goal"));

  // A finished chat: /compact compacts, /resume lists other chats to open.
  const done = base({ selectedTaskId: "t", runs: [run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "ok" } })])] });
  const idle = mount(done.props);
  type(idle, "/compact"); await enter(idle);
  assert.deepEqual(actions.at(-1), ["compact"]);
  assert.match(text(cardOf(idle)), /from 7,000 to 900 characters/);
  type(idle, "/resume"); await enter(idle);
  walk(cardOf(idle)).find((element) => element.type === "button" && text(element).startsWith("Older chat")).props.onClick();
  assert.deepEqual(actions.at(-1), ["open", "older"]);
  type(idle, "/goal replace it with this"); await enter(idle);
  assert.deepEqual(JSON.parse(JSON.stringify(done.calls.at(-1))), ["send", { taskId: "t", message: "replace it with this", goal: "replace it with this" }],
    "a new objective replaces the chat's goal after confirmation");
});

test("while the agent works, a typed message steers it at once; Esc on an empty composer still stops", async () => {
  const steered = [];
  const { props, calls } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    steer: async (input) => { steered.push(input); return true; } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  assert.equal(textarea().props.placeholder, "Steer the agent — sent to it right away");
  textarea().props.onChange({ target: { value: "use pnpm" } });
  const button = walk(view.render()).find((element) => element.props?.["aria-label"] === "Steer the agent");
  assert.ok(button && !button.props.disabled, "with a message typed, Send steers instead of showing Stop");
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(steered)), [{ taskId: "t", message: "use pnpm" }]);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0, "a delivered steer is not also sent as a follow-up");
});

test("while the agent works, /review and /init steer it; a new goal waits for the turn; /rewind goes back to a message", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const steered = [], rewound = [];
  const { props, calls } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    steer: async (input) => { steered.push(input); return true; },
    pendingMessage: "fix the parser",
    thread: { newChat() {}, rename: async () => {}, archive() {}, fork() {}, rewind: (index) => rewound.push(index), copyConversation() {}, togglePin() {}, pinned: false } });
  const view = mount(props);
  const type = (value) => walk(view.render()).find((element) => element.type === "textarea").props.onChange({ target: { value } });
  const enter = async () => {
    walk(view.render()).find((element) => element.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
    await settle(); await settle();
  };
  const card = () => walk(view.render()).find((element) => String(element.props?.className).includes("cx-command-card"));
  type("/review the parser"); await enter();
  assert.equal(steered.length, 1);
  assert.match(steered[0].message, /^Review the current code changes[\s\S]*Focus: the parser/);
  assert.match(text(card()), /Sent to the working agent/);
  type("/init"); await enter();
  assert.match(steered.at(-1).message, /^Generate a file named AGENTS\.md/);
  type("/goal finish the migration"); await enter();
  assert.equal(steered.length, 2, "a goal is never steered");
  assert.match(text(card()), /Queued: it's sent when the current turn finishes/);
  type("/goal clear"); await enter();
  assert.match(text(card()), /The queued goal was dropped/);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0);

  // /rewind lists the messages (newest first) and opens the chosen one to edit; a number picks directly.
  type("/rewind"); await enter();
  const items = walk(card()).filter((element) => element.type === "button" && /^\d+\. /.test(text(element)));
  assert.ok(items.length >= 1, "each message is a rewind point");
  items.at(-1).props.onClick();
  assert.deepEqual(rewound, [0]);
  type("/rewind 1"); await enter();
  assert.deepEqual(rewound, [0, 0]);
  type("/rewind 99"); await enter();
  assert.match(text(card()), /Choose a message from 1 to \d+/);
  assert.ok(walk(view.render()).some((element) => element.props?.["aria-label"] === "Rewind to this message"), "each message offers Rewind");
});

test("a working chat on a non-AO model is not offered steering; a message typed meanwhile is queued, not refused", async () => {
  const { props, calls } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "codex-native", model: "chatgpt-web/high" } })], { execution_mode: "single" })],
    steer: async () => { throw new Error("not steerable"); } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  assert.equal(textarea().props.placeholder, "Running — a message now is sent when it finishes");
  textarea().props.onChange({ target: { value: "also check the logs" } });
  const button = walk(view.render()).find((element) => element.props?.["aria-label"] === "Queue message");
  assert.ok(button && !button.props.disabled, "Send queues instead of being replaced by Stop");
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0, "nothing is sent while the turn runs");
  assert.equal(textarea().props.value, "", "the composer is free for the next message");
  assert.match(text(walk(view.render()).find((element) => String(element.props?.className).includes("cx-command-card"))), /^QueuedIt's sent when the current turn finishes/);
});

test("after an app restart a running AO card is still steered, though the page isn't driving its run", async () => {
  const steered = [];
  // working is false: the page's run loop isn't attached to this chat's run, which goes on in AO.
  const { props } = base({ selectedTaskId: "t", working: false,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    steer: async (input) => { steered.push(input); return true; } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  assert.equal(textarea().props.placeholder, "Steer the agent — sent to it right away");
  textarea().props.onChange({ target: { value: "have you done it?" } });
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(steered)), [{ taskId: "t", message: "have you done it?" }]);
});

test("a queued message belongs to its chat: switching chats keeps it, and it's sent only into that chat", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const queue = source.slice(source.indexOf("const [queued, setQueued]"), source.indexOf("const dispatch = async"));
  assert.ok(queue.includes("queued.taskId !== selectedTaskId"), "it waits until its own chat is open and free");
  assert.ok(!queue.includes("setQueued(null); }, [selectedTaskId]"), "opening another chat no longer drops it");
  assert.ok(queue.includes("setDraft(next.message)"), "a queued message that can't be sent goes back into the composer");
  assert.ok(source.includes("setQueued({ what, message, goal, taskId: selectedTaskId })"), "commands queue for their chat too");
});

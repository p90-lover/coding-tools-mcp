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

// The page the agent's browser has open, as useWorkbenchAutoOpen reports it (null: none).
let openPage = null;
function mount(props) {
  const states = []; let cursor = 0;
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (value) => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
    },
    useMemo: (calculate) => calculate(), useEffect() {}, useRef: (initial) => ({ current: initial }),
    // Every render here is a fresh one, so a memoized component renders as itself.
    memo: (component) => component,
    // Context reads its default; a Provider renders its children.
    createContext: (value) => ({ Provider: ({ children }) => children, value }), useContext: (context) => context.value,
  };
  // Function components render inline, so their output (work lines, steps, actions) is visible.
  const jsx = (type, props, key) => typeof type === "function" ? type(props || {}) : ({ type, props: props || {}, key });
  const module = transpile("AgentOrchestratorChat.tsx", (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name === "./ao-chat" ? chat : name === "./codex-prompts" ? prompts : name === "../icons" ? { Icon: "Icon" } : name === "./ChatMarkdown" ? { ChatMarkdown: "Markdown" }
      : name === "./ChatMenu" ? { ChatMenu: "ChatMenu", ChatGlyph: "Glyph", FloatingLayer: "FloatingLayer" } : name === "./AgentOrchestratorComposerControls" ? { AgentOrchestratorComposerControls: "Controls" }
        : name === "./AgentOrchestratorApproval" ? { AgentOrchestratorApproval: "Approval" }
          : name === "./ChatWorkbench" ? { ChatWorkbench: "Workbench", useWorkbenchAutoOpen: () => openPage } : {},
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
  assert.match(text(walk(view.render()).find((element) => String(element.props?.className).includes("cx-command-card"))), /^Queuedalso check the logsIt's sent when the current turn finishes/, "the card quotes the queued message");
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

test("each chat has its own queue: queuing in another chat never replaces one, and the view closing keeps them", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  // The store lives at module level, outside the component, keyed by the chat's task id.
  assert.ok(source.includes("const CHAT_QUEUES = new Map<string, QueuedChatMessage[]>();"));
  assert.ok(source.indexOf("const CHAT_QUEUES") < source.indexOf("export function AgentOrchestratorChat"), "it outlives the chat view");
  const queue = source.slice(source.indexOf("const [queueVersion, setQueueVersion]"), source.indexOf("const dispatch = async"));
  assert.ok(queue.includes("queueOf(task)") && queue.includes("setQueue(task, rest)"), "a chat's queue is sent only into that chat, one item at a time");
  assert.ok(queue.includes("sentWhileFree.current"), "one item per finished turn, never two into the same free spell");
  assert.ok(queue.includes("setDraft((typed) => (typed.trim() ? `${typed}\\n\\n${next.message}` : next.message))"), "a queued message that can't be sent goes back into the composer, after what is typed");
  assert.ok(queue.includes("deliver(next.message, next.goal, false)") && queue.includes("deliver(next.message, undefined, false)"), "a background send leaves the composer alone");
  assert.ok(queue.includes("steerFailed.current = true") && queue.includes("|| steerFailed.current ||"), "a steer that fails is not retried in a loop");
  assert.ok(source.includes("setQueue(selectedTaskId, chatQueueAdd(queueOf(selectedTaskId), { what, message,"), "commands queue in their own chat too");
});

test("rewind puts only the chosen message in the composer, with the earlier ones as a droppable context chip; drafts stay with their chat", () => {
  const read = (name) => fs.readFileSync(path.resolve(__dirname, "../src/features", name), "utf8");
  const surface = read("AgentOrchestratorSurface.tsx");
  const rewind = surface.slice(surface.indexOf("const rewindChat = "), surface.indexOf("// Fork: a new chat starting"));
  assert.ok(rewind.includes("text: messages[upTo].text"), "the composer holds just the chosen message");
  assert.ok(rewind.includes("context: earlier"), "the messages before it go along as context");
  const chat = read("AgentOrchestratorChat.tsx");
  assert.ok(chat.includes("setCarried(seed.context?.length ? seed.context : null)"));
  assert.ok(chat.includes("[...carried, message].join"), "the first message of the rewound chat carries them ahead of it");
  assert.ok(chat.includes('aria-label="Drop the earlier messages"'), "the context chip can be dropped");
  // Opening another chat no longer carries this chat's draft along.
  assert.ok(chat.includes("const CHAT_DRAFTS = new Map<string, string>();"));
  assert.ok(chat.includes("setDraft(CHAT_DRAFTS.get(selectedTaskId) ?? \"\")"));
});

test("Delete on a message asks in the chat first, then removes it with its reply; a working chat or its only message can't", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const deleted = [], loaded = [];
  const done = (id) => run(id, "t", [node("p", "planner", "finished", { receipt: { answer: `answer ${id}` } })], { execution_mode: "single" });
  const description = "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask\n\n↳ Steer (2026-10-10 10:05 UTC): use pnpm";
  const { props } = base({ selectedTaskId: "t", runs: [done("r1"), done("r2")], pendingMessage: description,
    // This fake keeps the chat as it was, so it can be deleted from again below.
    loadDescription: async (taskId) => { loaded.push(taskId); return description; },
    thread: { newChat() {}, rename: async () => {}, archive() {}, fork() {}, rewind() {}, copyConversation() {}, togglePin() {}, pinned: false,
      deleteMessage: async (index, runIds) => { deleted.push([index, [...runIds]]); } } });
  const view = mount(props);
  const buttons = (next) => walk(view.render(next)).filter((element) => element.props?.["aria-label"] === "Delete this message");
  const confirm = () => walk(view.render()).find((element) => element.props?.role === "alertdialog");
  assert.equal(buttons().length, 2, "each message has Delete");
  const steer = walk(view.render()).find((element) => String(element.props?.className).includes("cx-steer"));
  assert.ok(steer, "the steer shows under its message");
  assert.equal(walk(steer).filter((element) => element.props?.["aria-label"] === "Delete this message").length, 0, "a steer goes with its message");
  assert.equal(buttons()[1].props.disabled, false);

  // The button only asks; Cancel leaves the chat as it is.
  buttons()[1].props.onClick();
  assert.equal(confirm().props["aria-label"], "Delete message");
  assert.match(text(confirm()), /Delete this message\? It and its reply are removed from this chat\. The agent's files are not changed\./);
  assert.deepEqual(deleted, []);
  walk(confirm()).find((element) => element.type === "button" && text(element) === "Cancel").props.onClick();
  assert.equal(confirm(), undefined);
  assert.deepEqual(deleted, []);

  // Confirming deletes that message with the run its turn showed, then reads the chat's messages again.
  buttons()[1].props.onClick();
  walk(confirm()).find((element) => element.type === "button" && text(element) === "Delete").props.onClick();
  await settle(); await settle();
  assert.deepEqual(deleted, [[1, ["r2"]]]);
  assert.deepEqual(loaded, ["t"]);
  assert.equal(confirm(), undefined);

  // /delete <n> opens the same confirmation.
  walk(view.render()).find((element) => element.type === "textarea").props.onChange({ target: { value: "/delete 1" } });
  walk(view.render()).find((element) => element.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
  await settle(); await settle();
  assert.ok(confirm(), "/delete asks too");
  assert.deepEqual(deleted, [[1, ["r2"]]]);
  walk(confirm()).find((element) => element.type === "button" && text(element) === "Delete").props.onClick();
  await settle(); await settle();
  assert.deepEqual(deleted, [[1, ["r2"]], [0, ["r1"]]]);
  assert.deepEqual(loaded, ["t", "t"]);

  // While the chat works the button is disabled and says why; so is a chat's only message.
  const working = buttons({ working: true });
  assert.ok(working.every((button) => button.props.disabled && /Stop the chat first/.test(button.props.title)));
  const alone = buttons({ working: false, selectedTaskId: "u", runs: [run("r9", "u", [node("p", "planner", "finished")])], pendingMessage: "only ask" });
  assert.equal(alone.length, 1);
  assert.equal(alone[0].props.disabled, true);
  assert.match(alone[0].props.title, /only message; archive or delete the chat instead/);
});

test("Delete names the runs its turn showed: a restarted message takes its restart along, and a message that hasn't run can't be deleted", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const deleted = [], forked = [];
  const description = "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask\n\nFollow-up (2026-10-10 11:00 UTC):\nthird ask";
  const done = (id, extra = {}) => run(id, "t", [node("p", "planner", "finished", { receipt: { answer: `answer ${id}` } })], { execution_mode: "single", ...extra });
  const { props } = base({ selectedTaskId: "t",
    // r1 answered the first message and was restarted (r1b); r2 answered the second; the third hasn't run.
    runs: [done("r1"), done("r1b", { restarts_run_id: "r1" }), done("r2")],
    pendingMessage: description,
    // This fake keeps the chat as it was, so each turn can be pressed in turn.
    loadDescription: async () => description,
    thread: { newChat() {}, rename: async () => {}, archive() {}, fork: (index) => forked.push(index), rewind() {}, copyConversation() {}, togglePin() {}, pinned: false,
      deleteMessage: async (index, runIds) => { deleted.push([index, [...runIds]]); } } });
  const view = mount(props);
  const turns = () => walk(view.render()).filter((element) => element.type === "article");
  assert.deepEqual(turns().map((turn) => text(walk(turn).find((element) => element.props?.className === "cx-bubble") ?? null)),
    ["first ask", "", "second ask", "third ask"], "the restart shows as its own turn, without taking the next message");
  const buttonIn = (turn, label) => walk(turn).find((element) => element.props?.["aria-label"] === label);
  const press = async (turn) => {
    buttonIn(turns()[turn], "Delete this message").props.onClick();
    walk(walk(view.render()).find((element) => element.props?.role === "alertdialog")).find((element) => element.type === "button" && text(element) === "Delete").props.onClick();
    await settle(); await settle();
  };
  await press(2);
  assert.deepEqual(deleted, [[1, ["r2"]]], "the second message goes with its own run, not the first message's restart");
  await press(0);
  assert.deepEqual(deleted.at(-1), [0, ["r1", "r1b"]], "the first message goes with its restart");
  const pending = buttonIn(turns()[3], "Delete this message");
  assert.equal(pending.props.disabled, true);
  assert.match(pending.props.title, /hasn't run yet/);
  // Fork from here counts messages, not turns.
  buttonIn(turns()[2], "Fork from this message").props.onClick();
  assert.deepEqual(forked, [1]);
});

test("while the agent waits on a request, a typed message is still steered: the steer waits for the answer instead of cancelling it", async () => {
  const steered = [];
  const pending = { nodeId: "w", approval_id: "req-1", source: "ao", kind: "plan", tool: "ExitPlanMode", plan: "1. Add the route",
    decisions: [{ id: "default", kind: "allow_once", label: "Yes, and manually approve edits" }, { id: "plan", kind: "reject_once", label: "No, keep planning" }] };
  const { props, calls } = base({ selectedTaskId: "t", working: true, approvals: [pending],
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    steer: async (input) => { steered.push(input); return true; } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  // With "Approve for me" every tool call waits a moment; a message typed then used to wait for the
  // whole turn. The steer now waits on the backend until the request is answered (chat_steer).
  assert.equal(textarea().props.placeholder, "Steer the agent — sent to it right away");
  textarea().props.onChange({ target: { value: "yes, go ahead" } });
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(steered.map((input) => input.message), ["yes, go ahead"]);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0, "never a send into the busy turn");
});

test("a single-model chat shows its finished work unfolded; a Team chat folds the workers but always shows the answer", () => {
  const cards = () => [node("p", "planner", "finished", { receipt: { answer: "plan" } }),
    node("rev", "reviewer", "finished", { receipt: { answer: "All done", verdict: "APPROVED" } })];
  const steps = (view) => walk(view).some((element) => element.type === "ol" && element.props?.className === "cx-steps");
  const answer = (view) => walk(view).some((element) => String(element.props?.className || "").startsWith("cx-answer"));
  const team = mount(base({ selectedTaskId: "t", runs: [run("r1", "t", cards())] }).props).render();
  assert.equal(steps(team), false, "a Team chat folds the workers' activity");
  assert.ok(answer(team), "the Team chat's answer still shows");
  const single = mount(base({ selectedTaskId: "t", runs: [run("r1", "t", cards(), { execution_mode: "single" })] }).props).render();
  assert.equal(steps(single), true, "a single-model chat shows its work");
  assert.ok(answer(single));
});

test("a single-model chat's reply shows as the turn's answer, never inside a folded step", () => {
  // The real single shape: one planner card, not solo, its reply in the receipt.
  const one = () => [node("one", "planner", "finished", { receipt: { answer: "Registered the account" } })];
  const view = mount(base({ selectedTaskId: "t", runs: [run("r1", "t", one(), { execution_mode: "single" })] }).props).render();
  const answers = walk(view).filter((element) => String(element.props?.className || "").startsWith("cx-answer"));
  assert.equal(answers.length > 0, true, "the reply is the turn's answer");
  assert.ok(walk(answers[0]).some((element) => element.props?.text === "Registered the account"), "and the answer carries the reply");
});
test("while a single-model turn runs on one model and the picker shows another, the composer says which each uses", () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/gpt-6-luna" };
  const { props } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route })], { execution_mode: "single" })],
    composer: { mode: "single", route: { harness_id: "ao:claude-code", model: "cpa/deepseek-v4" }, onModeChange() {}, onRouteChange() {} } });
  const view = mount(props).render();
  const note = walk(view).find((element) => element.props?.className === "cx-route-note");
  assert.ok(note, "the switch is never silent");
  assert.match(text(note), /running on cpa\/gpt-6-luna; your next message uses cpa\/deepseek-v4/);
  const same = mount(base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route })], { execution_mode: "single" })],
    composer: { mode: "single", route, onModeChange() {}, onRouteChange() {} } }).props).render();
  assert.equal(walk(same).some((element) => element.props?.className === "cx-route-note"), false, "nothing to say when they match");
});
test("a working card's reasoning shows Codex-style: its title as one line, the rest folded", () => {
  const { props } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/gpt-6-luna" } })], { execution_mode: "single" })],
    activity: { "r1:w": { activity: "thinking", last_event_at_ms: Date.now(), turn_started: true, timeline: [
      { id: "r", kind: "reasoning", status: "completed", text: "**Inspecting the register route**\n\nThe form posts to /api/register." }] } } });
  const view = mount(props).render();
  const reasoning = walk(view).find((element) => element.type === "details" && element.props?.className === "cx-reasoning");
  assert.ok(reasoning, "the reasoning is shown, not just the word Thought");
  assert.match(text(reasoning), /Thought\s*Inspecting the register route/);
});

test("a tool call opens on what it ran and what came back, with a dot for how it ended (Claude Code's tool rows)", () => {
  const { props } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    activity: { "r1:w": { activity: "running", last_event_at_ms: Date.now(), turn_started: true, timeline: [
      { id: "c", kind: "command", status: "failed", text: "npm config list", description: "Inspect npm registry configuration", output: "User refused permission to run tool" },
      { id: "m", kind: "tool", status: "completed", label: "MCP", text: "mcp__coding-tools__read_file", input: "{\"path\":\"main.py\"}", output: "from fastapi import FastAPI" },
      { id: "p", kind: "tool", status: "pending", label: "Read", text: "Read x" }] } } });
  // Compact activity folds the run of calls into one line; opening it shows every row.
  const view = mount(props);
  const group = walk(view.render()).find((element) => element.props?.className === "cx-activity-head");
  assert.match(text(group), /Ran a command/);
  group.props.onClick();
  const tools = walk(view.render()).filter((element) => /(^|\s)cx-tool(\s|$)/.test(element.props?.className ?? ""));
  const [command, mcp, waiting] = tools;
  assert.equal(command.type, "details");
  assert.match(command.props.className, /tone-failed/);
  assert.match(text(command), /Ran/);
  assert.match(text(command), /npm config list/);
  assert.match(text(command), /User refused permission to run tool/, "the output is in the opened row");
  assert.match(mcp.props.className, /tone-ok/);
  assert.match(text(mcp), /"path":"main\.py"/);
  assert.match(text(mcp), /from fastapi import FastAPI/);
  assert.equal(waiting.type, "div", "nothing to open on yet");
  assert.match(waiting.props.className, /tone-running/);
});

test("a single model's thinking and tool calls stay folded under its answer once it lands, and an older one loads when opened", () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/m" };
  const timeline = [{ id: "r", kind: "reasoning", status: "completed", text: "Checking the route" },
    { id: "c", kind: "command", status: "completed", text: "ls", output: "main.py" }];
  const { props } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route, receipt: { thread_id: "s1" } })], { execution_mode: "single" })],
    activity: { "r1:w": { activity: "running", last_event_at_ms: Date.now(), turn_started: true, timeline } } });
  const view = mount(props);
  view.render();
  const finished = view.render({ working: false, activity: {},
    runs: [run("r1", "t", [node("w", "planner", "finished", { route, receipt: { thread_id: "s1", answer: "All set." } })], { execution_mode: "single" })] });
  const head = walk(finished).find((element) => element.props?.className === "cx-work-head");
  assert.ok(head, "the work is still there after the answer");
  assert.match(text(head), /Ran a command/, "headed like Claude Code's work summary");
  assert.ok(walk(finished).some((element) => element.type === "Markdown" && element.props.text === "All set."), "and the answer below it");

  const older = mount(base({ selectedTaskId: "t",
    runs: [run("r0", "t", [node("w", "planner", "finished", { route, receipt: { thread_id: "s0", answer: "Done before." } })], { execution_mode: "single" })] }).props).render();
  assert.match(text(walk(older).find((element) => element.props?.className === "cx-work-head")), /^Worked/, "a card from before this session can still show its work");
});
test("approval cards from different team members retain separate React identities", () => {
  const { props } = base({ selectedTaskId: "t", approvals: [
    { nodeId: "planner", approval_id: "request-1" },
    { nodeId: "worker", approval_id: "request-1" },
  ] });
  const cards = walk(mount(props).render()).filter(item => item.type === "Approval");
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map(item => item.key)).size, 2);
});

test("a hidden agent browser is offered back from the chat header, and opens the side panel on it", () => {
  openPage = { sessionId: "s1", url: "http://127.0.0.1:8000/register", title: "Auto Register" };
  try {
    const { props } = base({ selectedTaskId: "t", working: true,
      runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" }, receipt: { thread_id: "s1" } })], { execution_mode: "single" })] });
    const view = mount(props);
    const chip = walk(view.render()).find((element) => element.props?.className === "cx-browser-chip");
    assert.ok(chip, "the chip shows while the browser is hidden");
    assert.match(text(chip), /Auto Register/);
    chip.props.onClick();
    const after = walk(view.render());
    assert.ok(after.some((element) => element.type === "Workbench" && element.props.tab === "preview"), "the panel opens on the browser");
    assert.ok(!after.some((element) => element.props?.className === "cx-browser-chip"), "no chip while it shows");
  } finally { openPage = null; }
});

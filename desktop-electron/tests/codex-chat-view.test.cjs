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
// A stuck turn's Restart: its Provider stays in the tree (so a test can read the value the chat
// gives it), and its value is what TurnRunning reads.
const turnRestart = { Provider: "TurnRestartProvider", value: { restarting: false } };
function mount(props) {
  // Hook state per component, as React keeps it: by the component's name and its place among
  // components of that name. One shared list shifted every later component's state whenever a
  // component appeared earlier in the tree (a steer's bubble turned the stuck footer's clock back).
  const frames = new Map(); let frame = "root", cursor = 0, seen = {};
  const react = {
    useState(initial) {
      const states = frames.get(frame) ?? frames.set(frame, []).get(frame);
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
  const jsx = (type, props, key) => {
    if (typeof type !== "function") return { type, props: props || {}, key };
    const name = type.name || "anonymous";
    seen[name] = (seen[name] ?? 0) + 1;
    const outer = [frame, cursor];
    frame = `${name}#${seen[name]}`; cursor = 0;
    try { return type(props || {}); } finally { [frame, cursor] = outer; }
  };
  const module = transpile("AgentOrchestratorChat.tsx", (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name === "./ao-chat" ? chat : name === "./codex-prompts" ? prompts : name === "../icons" ? { Icon: "Icon" } : name === "./ChatMarkdown" ? { ChatMarkdown: "Markdown" }
      : name === "./ChatMenu" ? { ChatMenu: "ChatMenu", ChatGlyph: "Glyph", FloatingLayer: "FloatingLayer" } : name === "./AgentOrchestratorComposerControls" ? { AgentOrchestratorComposerControls: "Controls" }
        : name === "./AgentOrchestratorApproval" ? { AgentOrchestratorApproval: "Approval" } : name === "./HarnessLogo" ? { ModelLogo: "ModelLogo" }
          // The picker's short name: the model id without its "cpa/<provider>/" prefix.
          : name === "./AgentOrchestratorRoleEditor" ? { modelShortLabel: (model) => ({ group: "", name: model.replace(/^cpa\/(?:[^/]+\/)?/, "") }) }
          : name === "./ChatWorkbench" ? { ChatWorkbench: "Workbench", useWorkbenchAutoOpen: () => openPage, useChatSubagents: () => [], useChatProcesses: () => [], chatProcessRows: () => [] }
          : name === "./ComputerControlCard" ? { ComputerControlCard: () => null, useComputerRequests: () => [], chatComputerRequests: () => [] }
            // The parts the chat shares with the DeepSeek view; its Providers wrap the chat.
            : name === "./ChatToolParts" ? { SentMessageView: react.createContext(null), Attachments: react.createContext({}),
              SentImage: "SentImage", ToolImages: "ToolImages", ImageLightbox: "ImageLightbox", SecretText: "SecretText",
              SteerReader: react.createContext("Claude"), SteerReceiptMark: "SteerReceiptMark", TurnRestart: turnRestart } : {},
  { window: { setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, confirm: () => true }, document: { querySelector: () => null }, navigator: {} });
  props.queue?.attach?.(module.syncChatQueues);
  return {
    render: (next = {}) => { frame = "root"; cursor = 0; seen = {}; return module.AgentOrchestratorChat({ ...props, ...next }); },
    // The queued-message bar alone, for a queue the chat itself rarely builds (two separate messages).
    bar: (barProps) => { frame = "bar"; cursor = 0; seen = {}; return module.QueuedMessageBar(barProps); },
  };
}

/**
 * The app's queue (chat-queue.cjs) as the chat reaches it through the surface's chat_queue calls:
 * kept per chat, with each change shown back through the chat's syncChatQueues.
 */
function appQueue() {
  const chats = new Map();
  let sync = () => {};
  let ids = 0;
  const show = (taskId) => sync("ws", { [taskId]: chats.get(taskId) ?? [] }, taskId);
  return {
    chats,
    attach(next) { sync = next; },
    add: async (taskId, item, front = false) => {
      const entry = { ...item, id: item.id ?? `queued-${++ids}` };
      const rest = (chats.get(taskId) ?? []).filter((queued) => queued.id !== entry.id);
      chats.set(taskId, front ? [entry, ...rest] : [...rest, entry]);
      show(taskId);
    },
    update: async (taskId, id, message) => {
      const list = chats.get(taskId) ?? [];
      if (!list.some((queued) => queued.id === id)) return false;
      chats.set(taskId, list.map((queued) => (queued.id === id ? { ...queued, message } : queued)));
      show(taskId);
      return true;
    },
    remove: async (taskId, removed) => {
      chats.set(taskId, removed === null ? [] : (chats.get(taskId) ?? []).filter((queued) => !removed.includes(queued.id)));
      show(taskId);
    },
  };
}

function base(extra = {}) {
  const calls = [];
  return {
    calls,
    props: {
      runs: [], tasks: [], selectedTaskId: "", busy: false, loadDescription: async () => "", openStructure() {}, approvals: [], approve() {},
      describeRoute: () => "", retryStart() {}, projectName: "Alpha", queue: appQueue(),
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
  // No head over live work: the steps start at their dots, and the turn's foot says what runs.
  assert.equal(walk(view).find((element) => element.props?.className === "cx-work-head"), undefined);
  const step = walk(view).find((element) => element.props?.className === "cx-step-head" && text(element).startsWith("Worker"));
  assert.ok(step, "the working card's line starts at its dot");
  assert.doesNotMatch(text(step), /running a command/, "its activity is not repeated on its line");
  const foot = walk(view).find((element) => String(element.props?.className).startsWith("cx-note cx-turn-running"));
  assert.match(text(foot), /Working for 1m · Worker — running a command/);
  // The shimmer repaints its box every frame, so it covers the verb only, not the whole line.
  assert.deepEqual(walk(foot).filter((element) => element.props?.className === "cx-shimmer").map(text), ["Working"]);
  const stop = walk(view).find((element) => element.props?.["aria-label"] === "Stop (Esc)");
  assert.ok(stop, "a running chat shows Stop in place of Send");
  stop.props.onClick();
  walk(view).find((element) => element.type === "textarea").props.onKeyDown({ key: "Escape", shiftKey: false, preventDefault() {} });
  assert.deepEqual(calls, [["stop", "r1"], ["stop", "r1"]]);
});

test("a chat waiting out an automatic retry still shows Stop, and Send once something is typed", () => {
  // 2026-10-29: a held step retried for half an hour; the chat took messages, so Send stood in
  // for Stop the whole time and nothing on screen could stop the retries.
  const { props, calls } = base({
    selectedTaskId: "t", working: false,
    runs: [run("r1", "t", [node("p", "planner", "held", { receipt: { error: "API Error: 503" } })], { execution_mode: "single" })],
  });
  const chatView = mount(props);
  const stop = walk(chatView.render()).find((element) => element.props?.["aria-label"] === "Stop (Esc)");
  assert.ok(stop, "a held run is still open: Stop shows while nothing is typed");
  stop.props.onClick();
  assert.deepEqual(calls, [["stop", "r1"]]);
  walk(chatView.render()).find((element) => element.type === "textarea").props.onChange({ target: { value: "try again" } });
  const view = chatView.render();
  assert.equal(walk(view).find((element) => element.props?.["aria-label"] === "Stop (Esc)"), undefined);
  assert.ok(walk(view).find((element) => element.props?.["aria-label"] === "Send message"), "a typed message is sent, which stops the held run");
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
  assert.equal(text(walk(view).find((element) => element.props?.className === "cx-work-head")), "Worked · 2 steps");
  walk(answer).find((element) => element.props?.["aria-label"] === "Retry this mission").props.onClick();
  assert.deepEqual(calls, [["restart", "r1"]]);
});

// Seen 2026-10-28: once a mission ended, the reviewer's row (its thinking and tool calls) left
// "Worked" when its reply became the answer, instead of folding with the other cards' rows.
test("the agent whose reply closes the turn keeps its row under Worked, without repeating the answer", () => {
  const { props } = base({
    selectedTaskId: "t",
    runs: [run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "plan" } }),
      node("w", "worker", "finished", { receipt: { answer: "built it" } }),
      node("rev", "reviewer", "finished", { route: { harness_id: "ao:codex" }, receipt: { answer: "APPROVED — shipped", verdict: "APPROVED", thread_id: "th" } })])],
  });
  const chatView = mount(props);
  let view = chatView.render();
  const head = walk(view).find((element) => element.props?.className === "cx-work-head");
  assert.equal(text(head), "Worked · 3 steps");
  head.props.onClick();
  view = chatView.render();
  const work = walk(view).find((element) => element.props?.className === "cx-work");
  const rows = walk(work).filter((element) => element.props?.className === "cx-step-name").map(text);
  assert.equal(rows.length, 3, "planner, worker and the reviewer that answered");
  const reviewer = walk(work).filter((element) => element.props?.className === "cx-step-head").at(-1);
  assert.ok(!reviewer.props.disabled, "its work opens from its row");
  assert.ok(!walk(work).some((element) => element.type === "Markdown" && /shipped/.test(element.props.text)), "the answer shows once, below");
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
  // A bare /goal with no goal set shows no usage card: it waits for the objective in the box, where
  // the line under it says how /goal is used.
  type(newChat, "/goal"); await enter(newChat);
  assert.doesNotMatch(text(cardOf(newChat)), /Usage|No goal/, "no card repeating the usage line");
  assert.equal(walk(newChat.render({ commands: commands() })).find((element) => element.type === "textarea").props.value, "/goal ");
  type(newChat, "");

  // A working team chat: /status, /goal pause and /compact's refusal still run; a goal shows its pill.
  goal = { objective: "ship the release", status: "active", round: 2, rounds: 6, startedAt: Date.now() - 5 * 60_000, updatedAt: Date.now(), note: "" };
  const busy = base({ selectedTaskId: "t", runs: [run("r1", "t", [node("p", "planner", "running")])], working: true });
  const teamChat = mount(busy.props);
  type(teamChat, "/status"); await enter(teamChat);
  assert.match(text(cardOf(teamChat)), /StatusChat IDtModeTeam · Workspace team/);
  type(teamChat, "/goal pause"); await enter(teamChat);
  assert.deepEqual(actions.at(-1), ["goal", "pause"]);
  type(teamChat, "/compact"); await enter(teamChat);
  assert.match(text(cardOf(teamChat)), /Can't compact while the chat is running/);
  type(teamChat, "/review"); await enter(teamChat);
  // Claude Code queues a command as it queues a message: in its queued-message bar, as typed. The
  // user: "remake the steer message panel exact the same as claude code" (the "Queued: it's sent
  // when the current turn finishes" card).
  const band = walk(teamChat.render({ commands: commands() })).find((element) => String(element.props?.className).startsWith("cx-queued-band"));
  assert.equal(text(band), "1 message queued/review", "a command that sends queues behind the working turn, shown as typed");
  assert.equal(cardOf(teamChat), undefined, "no card says it was queued");
  assert.equal(busy.calls.filter((call) => call[0] === "send").length, 0, "nothing is sent while the turn works");
  const pill = walk(teamChat.render({ commands: commands() })).find((element) => String(element.props?.className).startsWith("cx-goal "));
  assert.match(text(pill), /^Pursuing goalship the releaseRound \d+( of \d+)? · 5m \d+s$/, "Codex's goal bar: state, objective, round, running time");
  // While pursued, why the last check found the goal not met yet shows in a box of its own under
  // the bar (user: "separate ... as 2 box ... the model not yet box should always below goal box").
  const toldModes = walk(teamChat.render({ commands: { ...commands(), goal: { ...commands().goal, feedback: "Two tests still fail." } } }))
    .find((element) => element.props?.className === "cx-composer-modes");
  const toldBar = walk(toldModes).find((element) => String(element.props?.className).startsWith("cx-goal "));
  const verdict = walk(toldModes).find((element) => element.props?.className === "cx-goal-verdict");
  assert.equal(text(verdict), "Not met yet: Two tests still fail.");
  assert.doesNotMatch(text(toldBar), /Not met yet/, "the goal bar keeps only the goal");
  const modeKids = [toldModes.props.children].flat(Infinity).filter(Boolean);
  assert.ok(modeKids.indexOf(verdict) > modeKids.indexOf(toldBar), "the verdict comes after the goal bar");
  assert.match(fs.readFileSync(path.join(__dirname, "../src/features/codex-chat.css"), "utf8"), /\.cx-goal-verdict \{[^}]*flex: 1 0 100%; order: 1;/,
    "and wraps to the last row, under the bar and the plan chip");
  assert.deepEqual(walk(pill).filter((element) => element.type === "button").map((button) => button.props.title), ["Clear goal", "Pause goal", "Edit goal"]);
  // The bar's icons are buttons, not typed commands: what is typed in the box stays.
  type(teamChat, "half a message");
  const typed = () => walk(teamChat.render({ commands: commands() })).find((element) => element.type === "textarea" && element.props["aria-label"] !== "Goal").props.value;
  walk(pill).find((element) => element.type === "button" && element.props.title === "Pause goal").props.onClick();
  await settle(); await settle();
  assert.deepEqual(actions.at(-1), ["goal", "pause"]);
  assert.equal(typed(), "half a message", "Pause leaves the draft alone");
  // Edit goal opens an editor; Save sends the new objective and closes it.
  walk(pill).find((element) => element.type === "button" && element.props.title === "Edit goal").props.onClick();
  await settle(); await settle();
  const editor = () => walk(teamChat.render({ commands: commands() })).find((element) => element.type === "section" && element.props?.["aria-label"] === "Edit goal");
  assert.equal(walk(editor()).find((element) => element.type === "textarea").props.value, "ship the release");
  assert.equal(typed(), "half a message", "and so does Edit");
  walk(teamChat.render({ commands: commands() })).find((element) => element.type === "textarea" && element.props["aria-label"] !== "Goal").props.onChange({ target: { value: "" } });
  walk(editor()).find((element) => element.type === "textarea").props.onChange({ target: { value: "ship the release with notes" } });
  walk(editor()).find((element) => element.type === "button" && text(element) === "Save").props.onClick();
  await settle(); await settle();
  assert.deepEqual(actions.at(-1), ["edit", "ship the release with notes"]);
  assert.equal(editor(), undefined, "the editor closes after saving");
  // A bare /goal with a goal opens the same editor; Esc closes it unsaved.
  type(teamChat, "/goal"); await enter(teamChat);
  assert.equal(walk(editor()).find((element) => element.type === "textarea").props.value, "ship the release");
  walk(editor()).find((element) => element.type === "textarea").props.onKeyDown({ key: "Escape", preventDefault() {} });
  assert.equal(editor(), undefined);
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
  assert.equal(textarea().props.placeholder, "", "steering shows no hint");
  textarea().props.onChange({ target: { value: "use pnpm" } });
  const button = walk(view.render()).find((element) => element.props?.["aria-label"] === "Steer the agent");
  assert.ok(button && !button.props.disabled, "with a message typed, Send steers instead of showing Stop");
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(steered)), [{ taskId: "t", message: "use pnpm" }]);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0, "a delivered steer is not also sent as a follow-up");
});

test("a turn that may be stuck has a Restart button; it stops the turn and has the same agent continue", async () => {
  // Seen live 2026-10-22: "may be stuck 3h 39m" on a tool call that never returned, with nothing to press.
  const now = Date.now();
  const steered = [];
  const { props, calls } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" }, receipt: { started_at_ms: now - 4 * 3_600_000 } })], { execution_mode: "single" })],
    activity: { "r1:w": { activity: "running Find detection log files", last_event_at_ms: now - 11 * 60_000, turn_started: true } },
    steer: async (input) => { steered.push(input); return true; } });
  const view = mount(props);
  const provided = walk(view.render()).find((element) => element.type === "TurnRestartProvider").props.value;
  assert.equal(typeof provided.onRestart, "function", "a steerable chat offers Restart");
  try {
    turnRestart.value = { onRestart: provided.onRestart, restarting: false };
    const running = walk(view.render()).find((element) => String(element.props?.className).includes("cx-turn-running"));
    assert.match(text(running), /may be stuck/);
    const button = walk(running).find((element) => element.props?.className === "cx-turn-restart");
    assert.ok(button && !button.props.disabled, "the stuck footer has its own Restart");
    assert.equal(text(button), "Restart");
    button.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(steered.length, 1);
    assert.equal(steered[0].restart, true, "the turn is restarted whatever its quiet time");
    assert.match(steered[0].message, /^Your previous turn stopped responding and was restarted\. Continue the same task/);
    assert.equal(calls.filter(([kind]) => kind === "stop").length, 0, "the run is not stopped: the same agent continues");
    turnRestart.value = { onRestart: provided.onRestart, restarting: true };
    const pressed = walk(walk(view.render()).find((element) => String(element.props?.className).includes("cx-turn-running")))
      .find((element) => element.props?.className === "cx-turn-restart");
    assert.equal(pressed.props.disabled, true);
    assert.equal(text(pressed), "Restarting…");
  } finally { turnRestart.value = { restarting: false }; }
});

test("a chat that cannot be steered keeps the old hint on a stuck turn instead of a Restart", () => {
  const now = Date.now();
  const { props } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { receipt: { started_at_ms: now - 3_600_000 } })], { execution_mode: "single" })],
    activity: { "r1:w": { activity: "running a command", last_event_at_ms: now - 11 * 60_000, turn_started: true } } });
  const view = mount(props).render();
  assert.equal(walk(view).find((element) => element.type === "TurnRestartProvider").props.value.onRestart, undefined);
  const running = walk(view).find((element) => String(element.props?.className).includes("cx-turn-running"));
  assert.match(text(running), /may be stuck · send a message to restart it$/);
});

test("while the agent works, /review, /init and a new goal steer it; /rewind goes back to a message", async () => {
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
  // As in Claude Code, the goal steers in mid-turn (its first round) instead of waiting for the turn.
  assert.equal(steered.length, 3, "a goal steers in too");
  assert.deepEqual([steered[2].message, steered[2].goal], ["finish the migration", "finish the migration"]);
  assert.doesNotMatch(text(card() ?? { props: {} }), /Queued/);
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

test("a working WebGPT (Native Codex) chat steers its turn, as the Codex bridge does", async () => {
  // The user: "steering message into chat are not able to use on webgpt model". It queued every message.
  const steered = [];
  const { props, calls } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "codex-native", model: "chatgpt-web/high" } })], { execution_mode: "single" })],
    steer: async (input) => { steered.push(input.message); return true; } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  assert.notEqual(textarea().props.placeholder, "Running. New messages send when it finishes");
  textarea().props.onChange({ target: { value: "also check the logs" } });
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steered, ["also check the logs"], "the message joins the running turn");
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0);
});

test("a working chat on a model that can't be steered queues a message typed meanwhile, not refused", async () => {
  const { props, calls } = base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "codex", model: "gpt-5" } })], { execution_mode: "single" })],
    steer: async () => { throw new Error("not steerable"); } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  assert.equal(textarea().props.placeholder, "Running. New messages send when it finishes");
  textarea().props.onChange({ target: { value: "also check the logs" } });
  const button = walk(view.render()).find((element) => element.props?.["aria-label"] === "Queue message");
  assert.ok(button && !button.props.disabled, "Send queues instead of being replaced by Stop");
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0, "nothing is sent while the turn runs");
  assert.equal(textarea().props.value, "", "the composer is free for the next message");
  // As Claude Code shows it: in the queued-message bar above the composer, not in a notice card.
  const bar = walk(view.render()).find((element) => element.props?.["aria-label"] === "Queued messages");
  assert.ok(bar, "the queued-message bar shows");
  assert.match(text(bar), /also check the logs/, "the bar shows the queued message");
  assert.ok(!walk(view.render()).some((element) => String(element.props?.className).includes("cx-command-card")), "no notice card says it was queued");
});

test("Enter is never refused while another action holds the surface: the message waits in the queue, as in Claude Code", async () => {
  // The user: "when sending a message, it will stop then freeze, wait for like 2-5 seconds to able
  // to send". The surface's one-action lock (a refresh, an approval) left Send disabled meanwhile.
  const { props, calls } = base({ selectedTaskId: "t", busy: true,
    runs: [run("r1", "t", [node("w", "planner", "finished", { receipt: { answer: "done" } })], { execution_mode: "single" })] });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  textarea().props.onChange({ target: { value: "keep going" } });
  const button = walk(view.render()).find((element) => element.type === "button" && element.props?.type === "submit");
  assert.ok(button && !button.props.disabled, "Send stays live while the surface is busy");
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0, "it waits for the lock instead of being refused");
  assert.equal(textarea().props.value, "", "the composer is free at once");
  assert.match(text(walk(view.render()).find((element) => element.props?.["aria-label"] === "Queued messages")), /keep going/);
});

test("a queued message waits in Claude Code's queued bar: 1 message queued, its text greyed, Send now, Edit and Remove", async () => {
  const { props, calls } = base({ selectedTaskId: "t-bar", working: true,
    runs: [run("r1", "t-bar", [node("w", "planner", "running", { route: { harness_id: "codex", model: "gpt-5" } })], { execution_mode: "single" })],
    steer: async () => { throw new Error("not steerable"); } });
  const view = mount(props);
  const all = () => walk(view.render());
  const textarea = () => all().find((element) => element.type === "textarea");
  const queue = async (message) => {
    textarea().props.onChange({ target: { value: message } });
    await all().find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  };
  await queue("first   note\nsecond line");
  const band = () => all().find((element) => String(element.props?.className).startsWith("cx-queued-band"));
  assert.equal(band().props["data-state"], "queued");
  assert.deepEqual(walk(band()).filter((element) => element.type === "span").map((element) => [element.props.className, text(element)]),
    [["cx-queued-count", "1 message queued"], ["cx-queued-preview", "first note second line"]], "Claude Code's row: the count, then the message on one line");
  const action = (label) => walk(band()).find((element) => element.props?.["aria-label"] === label);
  assert.deepEqual(walk(band()).filter((element) => element.type === "button").map((element) => element.props["aria-label"]),
    ["Send now", "Edit in composer", "Remove from queue"], "then its ↵, pencil and X");
  // The agent can't be steered and the turn still runs: Send now waits, and says why.
  assert.equal(action("Send now").props.disabled, true);
  assert.equal(action("Send now").props["data-tip"], "Sent when the current turn finishes");
  // Edit in composer takes it out of the queue and back into the box, ahead of anything typed.
  textarea().props.onChange({ target: { value: "typed meanwhile" } });
  action("Edit in composer").props.onClick();
  assert.equal(band(), undefined, "it leaves the queue");
  assert.equal(textarea().props.value, "first   note\nsecond line\n\ntyped meanwhile");
  // Remove from queue drops it; nothing is sent.
  textarea().props.onChange({ target: { value: "" } });
  await queue("second note");
  action("Remove from queue").props.onClick();
  assert.equal(all().some((element) => element.props?.["aria-label"] === "Queued messages"), false, "an empty queue shows no bar");
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0);
});

test("a steer on its way stays in the chat while a message waiting for the next turn is in the queued bar", async () => {
  const { props, calls } = base({ selectedTaskId: "t-stack", working: false,
    runs: [run("r1", "t-stack", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    // The first steer is still on its way; the agent stops for the second, which waits as its next turn.
    steer: ({ message }) => message === "use the other API" ? new Promise(() => {}) : Promise.resolve("restart") });
  const view = mount(props);
  const all = () => walk(view.render());
  const type = (message) => {
    all().find((element) => element.type === "textarea").props.onChange({ target: { value: message } });
    return all().find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  };
  type("use the other API");
  type("then rerun the tests");
  await new Promise((resolve) => setImmediate(resolve));
  // The steer is in the chat, in its turn: it sat under the goal in the queued bar, then jumped up.
  const steer = all().find((element) => element.props?.className === "cx-user cx-steer");
  assert.equal(steer?.props["data-pending"], "sending");
  assert.match(text(steer), /use the other API/);
  assert.equal(walk(steer).find((element) => element.type === "SteerReceiptMark").props.receipt, "sending");
  // Only the message that waits for the next turn is in the bar, with its actions.
  const band = all().find((element) => element.props?.className === "cx-queued-band");
  assert.equal(text(band), "1 message queuedthen rerun the tests");
  assert.equal(calls.filter(([kind]) => kind === "send").length, 0);
});

test("two queued messages fold into Claude Code's stack: Next: …, then a list with ⋮ and Clear all", () => {
  const { props } = base();
  const view = mount(props);
  const done = [];
  const item = (text) => ({ key: text, text, state: "queued", onEdit: () => done.push(["edit", text]), onRemove: () => done.push(["remove", text]), onSendNow: () => done.push(["send", text]) });
  let menu = null, cleared = 0;
  const barProps = { items: [item("use the other API"), item("then rerun the tests")], onMenu: (_owner, items) => { menu = items; }, onClearAll: () => { cleared += 1; } };
  const stack = walk(view.bar(barProps)).find((element) => element.props?.className === "cx-queued-band cx-queued-stack");
  assert.equal(stack.props["aria-expanded"], false, "folded at first");
  assert.equal(text(stack), "2 messages queuedNext: use the other API", "the first message is the head");
  stack.props.onClick();
  const open = walk(view.bar(barProps));
  const rows = open.filter((element) => element.props?.className === "cx-queued-row");
  assert.deepEqual(rows.map((row) => [text(row), row.props["data-state"]]), [["use the other API", "queued"], ["then rerun the tests", "queued"]]);
  assert.ok(open.some((element) => element.props?.["aria-label"] === "Collapse queued messages"));
  // The ⋮ opens Claude Code's menu: Edit in composer, Send now (the head only), then Remove from queue.
  walk(rows[0]).find((element) => element.props?.["aria-label"] === "Queued message actions").props.onClick({ currentTarget: {} });
  const labels = (shape) => JSON.parse(JSON.stringify(menu.map(shape)));
  assert.deepEqual(labels((entry) => entry.kind === "separator" ? "-" : [entry.label, Boolean(entry.danger)]),
    [["Edit in composer", false], ["Send now", false], "-", ["Remove from queue", true]]);
  walk(rows[1]).find((element) => element.props?.["aria-label"] === "Queued message actions").props.onClick({ currentTarget: {} });
  assert.deepEqual(labels((entry) => entry.kind === "separator" ? "-" : entry.label), ["Edit in composer", "-", "Remove from queue"], "only the first can be sent now");
  open.find((element) => element.props?.className === "cx-queued-clear").props.onClick();
  assert.equal(cleared, 1);
});

test("Edit in composer gives a queued message's annotations back as the composer's own, not as the block the agent reads", async () => {
  const { props } = base({ selectedTaskId: "t-notes", working: true,
    runs: [run("r1", "t-notes", [node("w", "planner", "running", { route: { harness_id: "codex", model: "gpt-5" } })], { execution_mode: "single" })],
    steer: async () => { throw new Error("not steerable"); } });
  const view = mount(props);
  const all = () => walk(view.render());
  const annotator = () => all().find((element) => typeof element.props?.onAdd === "function");
  const tray = () => all().find((element) => Array.isArray(element.props?.annotations) && typeof element.props?.onRemove === "function");
  const id = annotator().props.onAdd("the parser drops tabs");
  annotator().props.onComment(id, "fix this too");
  all().find((element) => element.type === "textarea").props.onChange({ target: { value: "first note" } });
  await all().find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(tray().props.annotations.length, 0, "the annotation went with the queued message");
  // A new selection made meanwhile stays, after the queued message's own.
  annotator().props.onAdd("another line");
  const band = all().find((element) => element.props?.className === "cx-queued-band");
  walk(band).find((element) => element.props?.["aria-label"] === "Edit in composer").props.onClick();
  assert.equal(all().find((element) => element.type === "textarea").props.value, "first note", "only the text goes in the box");
  assert.deepEqual(JSON.parse(JSON.stringify(tray().props.annotations.map((item) => [item.text, item.comment]))),
    [["the parser drops tabs", "fix this too"], ["another line", ""]], "its annotations come back as chips, ahead of the new one");
});

test("a steer is in the chat from the moment it is sent: Sending…, then Unread once the agent has it", async () => {
  let release;
  const { props } = base({ selectedTaskId: "t-steer", working: false,
    runs: [run("r1", "t-steer", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    steer: () => new Promise((resolve) => { release = resolve; }) });
  const view = mount(props);
  const all = () => walk(view.render());
  all().find((element) => element.type === "textarea").props.onChange({ target: { value: "use the other API" } });
  const sending = all().find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  const bubble = () => all().find((element) => element.props?.className === "cx-user cx-steer");
  const receipt = () => walk(bubble()).find((element) => element.type === "SteerReceiptMark").props.receipt;
  assert.match(text(bubble()), /use the other API/, "in the chat at once");
  assert.equal(bubble().props["data-pending"], "sending");
  assert.equal(receipt(), "sending", "its check pulses, read as Sending…");
  // It sits after the turn's work, where the turn's own record of it will show: it does not move.
  const article = all().find((element) => element.type === "article");
  const order = walk(article).map((element) => element.props?.className);
  assert.ok(order.indexOf("cx-user cx-steer") > order.findIndex((name) => String(name).startsWith("cx-work")), "after the work");
  assert.ok(!all().some((element) => element.props?.["aria-label"] === "Queued messages"), "not in the queued bar under the goal");
  assert.ok(!text(all()).includes("Steering…"), "no Steering… bubble at the end of the chat");
  release(true);
  await sending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receipt(), "unread", "delivered: the agent has it");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  assert.ok(!source.includes("Steered · "), "a steered message shows its time as any sent message does");
  assert.match(source, /<SentMessage text=\{steer\.text\} \/>[\s\S]{0,400}?<MessageActions text=\{chatMessageReadable\(steer\.text\)\} \/>/, "and its Copy action");
  assert.match(source, /<SteerReceiptMark receipt=\{turn\.status === "done" \? "read"/, "and its read receipt: a finished turn read it");
});

test("a steer the agent has not read stays in the turn it was sent in when the next mission starts", async () => {
  // It showed in whichever turn was live, so it jumped from where it was sent to the new mission's turn.
  const route = { harness_id: "ao:claude-code", model: "cpa/m" };
  const { props } = base({ selectedTaskId: "t-steer", working: false,
    runs: [run("r1", "t-steer", [node("w", "planner", "running", { route })], { execution_mode: "single" })],
    steer: async () => true });
  const view = mount(props);
  const all = (next) => walk(view.render(next));
  all().find((element) => element.type === "textarea").props.onChange({ target: { value: "use the other API" } });
  await all().find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  const next = { runs: [run("r1", "t-steer", [node("w", "planner", "finished", { route, output: { text: "done" } })], { execution_mode: "single" }),
    run("r2", "t-steer", [node("w2", "planner", "running", { route })], { execution_mode: "single" })] };
  const articles = all(next).filter((element) => element.type === "article");
  assert.equal(articles.length, 2, "the new mission has a turn of its own");
  const steersIn = (article) => walk(article).filter((element) => element.props?.className === "cx-user cx-steer").map(text);
  assert.equal(steersIn(articles[0]).length, 1, "still where it was sent");
  assert.match(steersIn(articles[0])[0], /use the other API/);
  assert.deepEqual(steersIn(articles[1]), [], "not moved down into the new mission");
  // Its cleanup reads the open chat's turns only: another chat's "continue" never drops it.
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  assert.match(source, /const shown = \(entry: PendingSteer\) => entry\.taskId === selectedTaskId && \(seen\.has/);
});

test("after an app restart a running AO card is still steered, though the page isn't driving its run", async () => {
  const steered = [];
  // working is false: the page's run loop isn't attached to this chat's run, which goes on in AO.
  const { props } = base({ selectedTaskId: "t", working: false,
    runs: [run("r1", "t", [node("w", "planner", "running", { route: { harness_id: "ao:claude-code", model: "cpa/m" } })], { execution_mode: "single" })],
    steer: async (input) => { steered.push(input); return true; } });
  const view = mount(props);
  const textarea = () => walk(view.render()).find((element) => element.type === "textarea");
  assert.equal(textarea().props.placeholder, "", "steering shows no hint");
  textarea().props.onChange({ target: { value: "have you done it?" } });
  await walk(view.render()).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(steered)), [{ taskId: "t", message: "have you done it?" }]);
});

test("a failed step's card names the step and its error, and its turn leaves the error to the card", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const dsh = fs.readFileSync(path.resolve(__dirname, "../src/features/DshTranscript.tsx"), "utf8");
  const card = source.slice(source.indexOf("function FailedStepCard"), source.indexOf("/** An image attachment's thumbnail URL"));
  assert.ok(card.includes("notice || step?.error ||"), "the reason is the run's notice, else the step's own error");
  assert.ok(card.includes("<span className=\"cx-fail-step\">{step.name}</span>"), "the card names the step");
  assert.ok(source.includes("<FailedStepCard step={failedStep} notice={notice}"));
  assert.ok(source.includes("errorShownBelow={turn === failedTurn}") && source.includes("prev.errorShownBelow === next.errorShownBelow"),
    "the failed turn is told, and its memo sees the change");
  assert.ok(dsh.includes("{errorShownBelow ? null : steps.filter((step) => step.error)"), "the DeepSeek turn drops its own copy of the error");
  assert.ok(source.includes("<input type=\"checkbox\" role=\"switch\""), "automatic retry is a switch");
});

test("Retry waits only on its own chat, and goal actions leave no card in the chat", () => {
  // The user: "retry still not working". Retry ran through the surface-wide run(), which returns
  // at once while anything else is in flight, and the card's button was disabled by that same busy.
  const chat = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const surface = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  assert.ok(chat.includes("<FailedStepCard step={failedStep} notice={notice} busy={retrying}"), "the card's Retry is disabled only by this chat's retry");
  assert.ok(!chat.includes("disabled={busy} onClick={() => retryStart("), "nor is the Start/Retry button");
  const retry = surface.slice(surface.indexOf("const retryChatStart"), surface.indexOf("const retryRun"));
  assert.ok(retry.includes("chatRun(") && !retry.includes("run(\"start-run\""), "Retry is guarded per chat, not by run()");
  assert.ok(surface.includes("retrying={Boolean(chatTaskId && chatBusy.includes(chatTaskId))}"));
  // The user: "remove all goal box like goal resumed info", "keep the chat clean". The goal bar shows the state.
  for (const notice of ["Goal resumed.", "Goal cleared.", "Goal paused.", "The queued goal was dropped."]) {
    assert.ok(!chat.includes(notice), `no "${notice}" card`);
  }
});

test("each chat has its own queue, kept by the app: it is sent with the chat closed, and queuing in another chat never replaces one", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  // The view shows the app's queues (chat-queue.cjs), keyed by the chat's task id, outside the component.
  assert.ok(source.includes("const CHAT_QUEUES = new Map<string, QueuedChatMessage[]>();"));
  assert.ok(source.indexOf("const CHAT_QUEUES") < source.indexOf("export function AgentOrchestratorChat"), "it outlives the chat view");
  // The view no longer sends the queue itself: that ran only for the open chat with the window focused.
  assert.ok(!source.includes("deliver(next.message, next.goal, false)") && !source.includes("windowFocused"), "the app sends it, not the view");
  assert.ok(source.includes("await queue.add(taskId, entry, front)"), "a queued message goes to the app's queue");
  assert.ok(source.includes("await enqueue(selectedTaskId, { what, message,"), "commands queue in their own chat too");
  // Two chats queue side by side; switching chats keeps both.
  const app = appQueue();
  const busy = (task) => run(`r-${task}`, task, [node("w", "planner", "running", { route: { harness_id: "codex", model: "gpt-5" } })], { execution_mode: "single" });
  const { props } = base({ selectedTaskId: "t-a", working: true, runs: [busy("t-a"), busy("t-b")], queue: app, steer: async () => { throw new Error("not steerable"); } });
  const view = mount(props);
  const queueIn = async (task, message) => {
    walk(view.render({ selectedTaskId: task })).find((element) => element.type === "textarea").props.onChange({ target: { value: message } });
    await walk(view.render({ selectedTaskId: task })).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  };
  await queueIn("t-a", "check the logs");
  await queueIn("t-b", "run the tests");
  assert.deepEqual([...app.chats].map(([task, items]) => [task, items.map((item) => item.message)]), [["t-a", ["check the logs"]], ["t-b", ["run the tests"]]]);
  assert.equal(app.chats.get("t-a")[0].steer, true, "in steer mode the app steers it in once the agent can take it");
  assert.match(text(walk(view.render({ selectedTaskId: "t-a" })).find((element) => element.props?.["aria-label"] === "Queued messages")), /check the logs/);
});

test("rewind resends the selected message into the same chat without filling or switching the composer", async () => {
  const read = (name) => fs.readFileSync(path.resolve(__dirname, "../src/features", name), "utf8");
  const surface = read("AgentOrchestratorSurface.tsx");
  const rewind = surface.slice(surface.indexOf("const rewindChat = "), surface.indexOf("// Fork: a new chat starting"));
  const calls = [], errors = [];
  const description = "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask";
  const exported = {};
  vm.runInNewContext(ts.transpileModule(`${rewind}\nexports.rewind = rewindChat;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: exported, loadDescription: async () => description,
    chatMessagesFromDescription: transpile("ao-chat.ts", () => ({})).chatMessagesFromDescription,
    sendChat: async input => calls.push(JSON.parse(JSON.stringify(input))), setError: error => errors.push(error) });
  await exported.rewind("t", 1);
  assert.deepEqual(calls, [{ taskId: "t", message: "second ask", rewind: { index: 1, description } }]);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(rewind, /setChatSeed|setChatTaskId|setDraft\(/, "rewind keeps the selected chat and the unsent draft");
  await exported.rewind("t", 5);
  assert.equal(calls.length, 1, "an invalid point never sends");
  assert.equal(errors.length, 1, "a stale point is reported");
  const chat = read("AgentOrchestratorChat.tsx");
  assert.ok(chat.includes("setCarried(seed.context?.length ? seed.context : null)"));
  assert.ok(chat.includes("[...carried, message].join"), "the first message of the rewound chat carries them ahead of it");
  assert.ok(chat.includes('aria-label="Drop the earlier messages"'), "the context chip can be dropped");
  // Opening another chat no longer carries this chat's draft along.
  assert.ok(chat.includes("const CHAT_DRAFTS = new Map<string, string>();"));
  assert.ok(chat.includes("setDraft(CHAT_DRAFTS.get(selectedTaskId) ?? \"\")"));
});

test("message action icons have no selectable glyph text when copying multiple messages", () => {
  const done = (id) => run(id, "t", [node("p", "planner", "finished", { receipt: { answer: "done" } })], { execution_mode: "single" });
  const { props } = base({ selectedTaskId: "t", runs: [done("r1"), done("r2")],
    pendingMessage: "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask",
    thread: { newChat() {}, rename: async () => {}, archive() {}, fork() {}, rewind() {}, deleteMessage: async () => {},
      copyConversation() {}, togglePin() {}, pinned: false } });
  const view = mount(props).render();
  const actions = walk(view).filter(element => element.props?.className === "cx-msg-actions");
  assert.ok(actions.length >= 2);
  for (const action of actions) {
    assert.equal(text(action), "", "Copy, Fork, Rewind and Delete are drawn, not text in the selected transcript");
    assert.equal(action.props.style?.userSelect, "none");
    assert.ok(walk(action).some(element => element.props?.["aria-label"] === "Copy message"), "keyboard and screen-reader controls remain available");
  }
  const bubbles = walk(view).filter(element => element.props?.className === "cx-bubble");
  assert.deepEqual(bubbles.map(text), ["first ask", "second ask"], "message text remains selectable and unmodified");
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
  assert.match(text(confirm()), /Delete this message and its reply\? Files on disk don't change\./);
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
  assert.equal(textarea().props.placeholder, "", "steering shows no hint");
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
  assert.match(text(note), /This turn runs on gpt-6-luna\. Your next message uses deepseek-v4\./, "the models' names, not their ids");
  const same = mount(base({ selectedTaskId: "t", working: true,
    runs: [run("r1", "t", [node("w", "planner", "running", { route })], { execution_mode: "single" })],
    composer: { mode: "single", route, onModeChange() {}, onRouteChange() {} } }).props).render();
  assert.equal(walk(same).some((element) => element.props?.className === "cx-route-note"), false, "nothing to say when they match");
});
test("a finished single-model chat says a changed model or effort starts a new agent with only a summary", () => {
  // Seen live: DeepSeek switched from Max to High between messages; the follow-up started a fresh
  // agent with a handoff summary, and to the person the chat had forgotten everything.
  const route = { harness_id: "ao:claude-code", model: "cpa/cline-pass/deepseek-v4.1-flash-1017(max)" };
  const finished = () => [run("r1", "t", [node("w", "planner", "finished", { route, receipt: { answer: "Done" } })], { execution_mode: "single" })];
  const changed = mount(base({ selectedTaskId: "t", runs: finished(),
    composer: { mode: "single", route: { ...route, model: "cpa/cline-pass/deepseek-v4.1-flash-1017(high)" }, onModeChange() {}, onRouteChange() {} } }).props).render();
  const note = walk(changed).find((element) => element.props?.className === "cx-route-note");
  assert.ok(note, "the new agent is never a surprise");
  assert.match(text(note), /^deepseek-v4\.1-flash-1017\(high\) starts a new agent with only a summary of this chat\./, "it names what changed");
  assert.match(text(note), /Switch back to deepseek-v4\.1-flash-1017\(max\) to keep this one\./, "and what to switch back to");
  // Only the effort changed: the note names the effort, not the model that stayed the same.
  const effort = mount(base({ selectedTaskId: "t", runs: [run("r1", "t", [node("w", "planner", "finished", { route: { ...route, effort: "medium" }, receipt: { answer: "Done" } })], { execution_mode: "single" })],
    composer: { mode: "single", route: { ...route, effort: "max" }, onModeChange() {}, onRouteChange() {} } }).props).render();
  assert.match(text(walk(effort).find((element) => element.props?.className === "cx-route-note")),
    /^Max effort starts a new agent with only a summary of this chat\.\s*Switch back to Medium effort to keep this one\.$/);
  const same = mount(base({ selectedTaskId: "t", runs: finished(),
    composer: { mode: "single", route: { ...route }, onModeChange() {}, onRouteChange() {} } }).props).render();
  assert.equal(walk(same).some((element) => element.props?.className === "cx-route-note"), false, "the same route continues the same agent");
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

// Seen 2026-10-31 in a split pane: docked under the chat box, a command's approval took the whole
// pane and the conversation above it had no room left.
test("the agent's questions and requests end the conversation and scroll with it", () => {
  const { props } = base({ selectedTaskId: "t", approvals: [{ nodeId: "planner", approval_id: "request-1" }] });
  const tree = walk(mount(props).render());
  const column = tree.find((element) => element.props?.className === "cx-column");
  const box = tree.findIndex((element) => element.type === "form" && element.props?.className === "cx-composer");
  const dock = tree.findIndex((element) => String(element.props?.className).startsWith("cx-approval-dock"));
  assert.ok(walk(column.props.children).some((element) => String(element.props?.className).startsWith("cx-approval-dock")), "the requests are in the scrolling thread");
  assert.ok(box >= 0 && dock < box, "above the chat box");
  assert.equal(walk(tree[box].props.children).some((element) => element.type === "Approval"), false, "and not inside it");
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

test("the chat header has a Preview button that opens the chat's browser with no page open, and closes it again", () => {
  const { props } = base({ selectedTaskId: "t",
    runs: [run("r1", "t", [node("w", "planner", "finished", { route: { harness_id: "ao:claude-code", model: "cpa/m" }, receipt: { thread_id: "s1" } })], { execution_mode: "single" })] });
  const view = mount(props);
  const preview = () => walk(view.render()).find((element) => element.props?.["aria-label"] === "Preview");
  assert.ok(preview(), "one click away, not behind Side panel → Overview");
  assert.equal(preview().props["aria-pressed"], false);
  preview().props.onClick();
  assert.ok(walk(view.render()).some((element) => element.type === "Workbench" && element.props.tab === "preview"), "it opens the Preview tab");
  assert.equal(preview().props["aria-pressed"], true);
  preview().props.onClick();
  assert.ok(!walk(view.render()).some((element) => element.type === "Workbench"), "a second click closes it");
  openPage = { sessionId: "s1", url: "http://127.0.0.1:5173/", title: "App" };
  try {
    assert.ok(!preview(), "while a hidden page is open the browser chip takes its place");
  } finally { openPage = null; }
});

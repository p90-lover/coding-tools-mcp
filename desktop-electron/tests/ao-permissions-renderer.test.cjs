"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const plain = value => JSON.parse(JSON.stringify(value));
// persistentRefs: refs live across renders as React's do, for an effect that reads a later render's value.
function renderer(file, { persistentRefs = false } = {}) {
  let states = [], cursor = 0, refCursor = 0;
  const effects = [], refs = [];
  const react = { useState: initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  }, useEffect: effect => effects.push(effect), useRef: initial => {
    if (!persistentRefs) return { current: initial };
    const index = refCursor++;
    return refs[index] ??= { current: initial };
  } };
  const jsx = (type, props) => ({ type, props: props || {} });
  const cache = {};
  const load = name => {
    if (cache[name]) return cache[name];
    const exports = cache[name] = {};
    const source = fs.readFileSync(path.resolve(__dirname, "../src/features", name), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(compiled, { exports, window: { confirm: () => false }, document: { activeElement: null },
      require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
        : name === "../icons" ? { Icon: () => null } : name.startsWith("./AgentOrchestrator") ? load(name.slice(2) + ".tsx") : {} });
    return exports;
  };
  const exports = load(file);
  return { exports, effects, render(name, props, values) { if (values) states = values; cursor = 0; refCursor = 0; effects.length = 0; return exports[name](props); } };
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => elements(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}
const text = tree => typeof tree === "string" ? tree : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const node = (id, harness = "codex-native", profile = "managed/custom") => ({ id, role: "worker", route: { harness_id: harness, permission_profile: profile }, settings: {} });

// The composer's chips are ChipMenu elements; a menu's content is its children(close), and its
// options are Option elements (role="radio" once rendered).
const menuNamed = (tree, heading) => elements(tree, item => typeof item.type === "function" && item.type.name === "ChipMenu" && item.props.heading === heading)[0];
const optionsIn = (menu, close = () => {}) => elements(menu.props.children(close), item => typeof item.type === "function" && item.type.name === "Option");
// Composer state order: search, models, caps, error, contextDraft.
const composerState = (models, caps = {}, search = "") => [search, models, caps, "", ""];

test("composer mode clicks show only the corresponding real selector without sending", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const changes = [];
  const props = { mode: "single", onModeChange: mode => changes.push(mode), route: { harness_id: "ao:claude-code", model: "cpa/gemini-flash", permission_profile: ":ao-default" }, onRouteChange() {}, harnesses: [], loadModels: async () => [], teams: [{ id: "actual-team", name: "Saved setup", nodes: [] }], teamId: "actual-team", onTeamChange() {}, permissions: null, busy: false };
  let tree = view.render("AgentOrchestratorComposerControls", props);
  for (const heading of ["Harness", "Model", "Reasoning effort", "Context window"]) assert.ok(menuNamed(tree, heading), `${heading} has its own chip`);
  assert.equal(menuNamed(tree, "Orchestrator / Team"), undefined);
  const option = label => elements(tree, item => item.type === "button" && item.props["aria-pressed"] !== undefined && item.props.children === label)[0];
  assert.equal(option("Single").props["aria-pressed"], true, "the switch names both modes and marks the active one");
  option("Single").props.onClick();
  assert.deepEqual(changes, [], "choosing the active mode changes nothing");
  option("Team").props.onClick();
  assert.deepEqual(changes, ["team"]);
  tree = view.render("AgentOrchestratorComposerControls", { ...props, mode: "team" });
  assert.equal(menuNamed(tree, "Model"), undefined);
  assert.equal(menuNamed(tree, "Orchestrator / Team").props.ariaLabel, "Choose saved team");
});

test("saved-team menu uses only supplied setups, and Escape in a chip menu restores its trigger focus", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const selected = [];
  let closed = 0;
  const props = { mode: "team", onModeChange() {}, route: { model: "not rendered", harness_id: "ao:claude-code" }, onRouteChange() {}, harnesses: [], loadModels: async () => [], teams: [{ id: "real", name: "Runtime saved setup", nodes: [node("lead")] }], teamId: "real", onTeamChange: id => selected.push(id), permissions: null, busy: false };
  const tree = view.render("AgentOrchestratorComposerControls", props, composerState(null));
  const rows = optionsIn(menuNamed(tree, "Orchestrator / Team"), () => closed++);
  assert.equal(rows.length, 1); assert.match(text(rows[0].props.children), /Runtime saved setup/);
  rows[0].props.onPick(); assert.deepEqual(selected, ["real"]); assert.equal(closed, 1, "picking closes the menu");
  const popup = view.render("useComposerPopover", undefined, [true]);
  let focused = 0;
  popup.trigger.current = { focus: () => focused++ };
  popup.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(focused, 1);
});

test("model search filters real catalog choices and WebGPT selection preserves saved policy", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gemini-flash", permission_profile: ":ao-default", native_permission_profile: "managed/custom", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  let tree = view.render("AgentOrchestratorComposerControls", props, composerState(["cpa/gemini-flash", "chatgpt-web/high", "default"]));
  const model = menuNamed(tree, "Model");
  assert.equal(optionsIn(model).length, 2, "only actual catalog entries, no default/fake models");
  elements(model.props.children(() => {}), item => item.type === "input" && item.props.type === "search")[0].props.onChange({ target: { value: "chatgpt-web" } });
  tree = view.render("AgentOrchestratorComposerControls", props);
  const rows = optionsIn(menuNamed(tree, "Model"));
  assert.equal(rows.length, 1); rows[0].props.onPick();
  assert.equal(routes[0].harness_id, "codex-native");
  assert.equal(routes[0].permission_profile, "managed/custom");
  assert.equal(routes[0].approvals_reviewer, "auto_review");
});

test("WebGPT locks the harness; its model menu offers Native Codex's CPA models, which keep the native permission", async () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const calls = [], routes = [];
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: "managed/raw", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], loadModels: async harness => { calls.push(harness); return harness === "codex-native" ? ["chatgpt-web/high", "actual-local-model"] : ["cpa/other-agent-model"]; }, teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  view.render("AgentOrchestratorComposerControls", props, composerState(null));
  view.effects[view.effects.length - 1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["codex-native"], "Native Codex lists WebGPT and the CPA pool itself");
  const tree = view.render("AgentOrchestratorComposerControls", props);
  assert.equal(menuNamed(tree, "Harness").props.disabled, true, "a WebGPT model keeps the harness on Native Codex");
  const rows = optionsIn(menuNamed(tree, "Model"));
  assert.equal(rows.length, 2);
  // A pool row shows the tidied name; its tooltip keeps the exact id.
  const pool = rows.find(row => text(row.props.children).includes("Actual Local Model"));
  assert.match(pool.props.title, /actual-local-model/);
  assert.equal(routes[0].context_window, 400_000, "the loaded list starts the chat at a 400K window");
  pool.props.onPick();
  const picked = routes.at(-1);
  assert.equal(picked.harness_id, "codex-native");
  assert.equal(picked.provider_id, "cliproxyapi-antigravity");
  assert.equal(picked.model, "actual-local-model");
  assert.equal(picked.permission_profile, "managed/raw");
  assert.equal(picked.context_window, undefined, "a pool model whose limit CPA did not report keeps the agent's own window");
});

test("the effort and window chips show the pick and offer exactly what the model takes", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/deepseek", permission_profile: ":ao-default", effort: "high" };
  const caps = { "cpa/deepseek": { efforts: ["low", "high", "xhigh"], contextLimit: 1_000_000, contextWindow: { min: 4096, max: 1_000_000, kind: "context" } } };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [{ id: "ao:claude-code", label: "Claude Code", runnable: true, installed: true }], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  const tree = view.render("AgentOrchestratorComposerControls", props, composerState(["cpa/deepseek"], caps));
  const effort = menuNamed(tree, "Reasoning effort");
  assert.match(text(effort.props.label), /High/);
  const efforts = optionsIn(effort);
  assert.deepEqual(efforts.map(row => text(row.props.children)), ["Autothe model's own", "Low", "High", "Extra high"],
    "Auto first on every model, then exactly its levels; no Model default row");
  assert.equal(efforts.find(row => row.props.picked).props.children, "High");
  efforts[3].props.onPick();
  assert.equal(routes.at(-1).effort, "xhigh");
  // Auto is saved as "auto", so the model's start effort never replaces it and nothing is sent.
  efforts[0].props.onPick();
  assert.equal(routes.at(-1).effort, "auto");
  const auto = view.render("AgentOrchestratorComposerControls", { ...props, route: { ...route, effort: "auto" } }, composerState(["cpa/deepseek"], caps));
  const autoMenu = menuNamed(auto, "Reasoning effort");
  assert.equal(text(autoMenu.props.label), "Auto");
  assert.equal(text(optionsIn(autoMenu).find(row => row.props.picked).props.children), "Autothe model's own");
  assert.doesNotMatch(String(autoMenu.props.className), /is-warning/, "Auto is never an unsupported level");
  const window = menuNamed(tree, "Context window");
  assert.match(text(window.props.label), /400k/i, "an unpicked window reads as the 400K default");
  const sizes = optionsIn(window).map(row => text(row.props.children));
  assert.ok(!sizes.some(size => /default/i.test(size)), `no default row: ${sizes}`);
  assert.ok(sizes.includes("400k") && sizes.includes("1Mfull model limit") && !sizes.includes("2M"), `presets stay within the model's range: ${sizes}`);
  assert.equal(optionsIn(window).find(row => row.props.picked).props.children[0], "400k");
  optionsIn(window).find(row => text(row.props.children) === "1Mfull model limit").props.onPick();
  assert.equal(routes.at(-1).context_window, 1_000_000);
  const harness = menuNamed(tree, "Harness");
  assert.doesNotMatch(text(harness.props.label), /Claude Code/, "the harness chip shows only its logo");
  assert.match(harness.props.title, /Claude Code/);
  assert.match(harness.props.ariaLabel, /Claude Code/);
});

test("the harness menu is slim: no state words on rows, missing harnesses fold under +N, the pick stays in view", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const route = { harness_id: "ao:aider", model: "", permission_profile: ":ao-default" };
  const harnesses = [
    { id: "ao:claude-code", label: "Claude Code", runnable: true, installed: true, authStatus: "unauthorized" },
    { id: "ao:codex", label: "Codex", runnable: true, installed: true },
    { id: "ao:aider", label: "Aider", runnable: false, installed: false },
    { id: "ao:amp", label: "Amp", runnable: false, installed: false },
    { id: "ao:cline", label: "Cline", runnable: false, installed: false },
  ];
  const props = { mode: "single", onModeChange() {}, route, onRouteChange() {}, harnesses, loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  const menu = menuNamed(view.render("AgentOrchestratorComposerControls", props, composerState([])), "Harness");
  const list = menu.props.children(() => {});
  assert.doesNotMatch(text(list), /not installed|sign in/i, "no state words on the rows");
  const rows = optionsIn(menu);
  assert.deepEqual(rows.map(row => row.props.title), ["Claude Code", "Codex", "Aider · not installed", "Amp · not installed", "Cline · not installed"],
    "a missing harness says so on hover; one that needs a sign-in shows only its dot; the picked missing harness stays up top");
  assert.equal(menu.props.showHeading, false, "no Harness title over the list");
  assert.equal(elements(list, item => item.props?.className === "ao-harness-signin").length, 1, "a sign-in dot on the one harness that needs it");
  assert.equal(elements(list, item => item.props?.className === "ao-harness-missing").length, 3, "a red dot on each missing harness");
  const fold = elements(list, item => item.type === "details")[0];
  assert.equal(elements(fold, item => item.type === "summary")[0].props["aria-label"], "2 more, not installed", "the other two missing harnesses fold under +2");
  assert.equal(elements(fold, item => typeof item.type === "function" && item.type.name === "Option").length, 2);
});

test("unpicked, the effort chip names the model's own effort and the model chip shows no provider", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gemini-3.8-flash-high", permission_profile: ":ao-default", context_window: 400_000 };
  const caps = { "cpa/gemini-3.8-flash-high": { provider: "gemini", efforts: ["low", "medium", "high"], contextWindow: { min: 4096, max: 1_048_576 } } };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [{ id: "ao:claude-code", label: "Claude Code", runnable: true, installed: true }], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  const tree = view.render("AgentOrchestratorComposerControls", props, composerState(["cpa/gemini-3.8-flash-high"], caps));
  const effort = menuNamed(tree, "Reasoning effort");
  assert.equal(text(effort.props.label), "High", "the model's own effort, read from its id");
  const rows = optionsIn(effort);
  assert.equal(rows.find(row => row.props.picked).props.children, "High");
  rows.find(row => row.props.children === "High").props.onPick();
  assert.equal(routes.at(-1).effort, undefined, "picking the model's own effort keeps it the model's own");
  assert.doesNotMatch(text(menuNamed(tree, "Model").props.label), /·/, "no provider after the model name");
});

test("a WebGPT model is one ChatGPT effort: the effort chip picks the model and the model list sets the effort", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only", effort: "low" };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  const tree = view.render("AgentOrchestratorComposerControls", props, composerState(["chatgpt-web/light", "chatgpt-web/high", "chatgpt-web/pro"]));
  const effort = menuNamed(tree, "Reasoning effort");
  assert.match(text(effort.props.label), /^High$/, "the chip shows the model's tier, not a stray saved effort");
  const tiers = optionsIn(effort);
  assert.deepEqual(tiers.map(row => text(row.props.children)), ["Instant", "Medium", "High", "Extra High", "Pro"], "no Model default, no Luna");
  tiers.find(row => text(row.props.children) === "Pro").props.onPick();
  assert.deepEqual([routes.at(-1).model, routes.at(-1).effort], ["chatgpt-web/pro", "ultra"]);
  assert.match(text(menuNamed(tree, "Model").props.label), /^ChatGPT Web High/, "the model chip names the whole WebGPT model");
  // The list keeps WebGPT apart under "Web GPT Model", each row its tier alone beside the OpenAI mark.
  assert.deepEqual(optionsIn(menuNamed(tree, "Model")).map(row => text(row.props.children)), ["Instant", "High", "Pro"]);
  optionsIn(menuNamed(tree, "Model")).find(row => text(row.props.children) === "Instant").props.onPick();
  assert.deepEqual([routes.at(-1).model, routes.at(-1).effort], ["chatgpt-web/light", "low"]);
});

test("mixed unsupported capabilities disable all presets rather than silently skipping roles", () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  let saves = 0;
  const props = { team: { id: "team", nodes: [node("native"), node("unsupported", "ao:other", ":ao-default")] }, busy: false, loadProfiles: async () => ({}), save: async () => { saves++; } };
  const cap = { native: { supported: true, profiles: [{ id: ":workspace", allowed: true }], approval_policies: ["on-request"], approvals_reviewers: ["user"] },
    unsupported: { supported: false, profiles: [], reason: "No policy mapping for this adapter" } };
  const tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio");
  assert.ok(rows.every(row => row.props.disabled));
  rows[0].props.onClick(); assert.equal(saves, 0);
  assert.match(rows[0].props.title, /No policy mapping/);
});

test("supported external permission presets retain its sentinel and apply the exact real tuple", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const calls = [];
  const team = { id: "single", revision: 4, nodes: [node("single", "ao:claude-code", ":ao-default")] };
  const props = { team, busy: false, loadProfiles: async () => ({}), save: async (...args) => { calls.push(args); return "Saved for future turn"; } };
  const cap = { single: { supported: true, profiles: [{ id: ":workspace", allowed: true }], approval_policies: ["on-request"], approvals_reviewers: ["user", "auto_review"] } };
  const tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio");
  assert.equal(rows[1].props.disabled, false); rows[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(calls[0][3]), { profile: ":workspace", policy: "on-request", reviewer: "auto_review" });
  assert.equal(calls[0][0].nodes[0].route.permission_profile, ":ao-default");
  assert.equal(calls[0][0].nodes[0].route.native_permission_profile, ":workspace");
  assert.deepEqual(plain(calls[0][2]), ["single"]);
  assert.equal(rows[2].props.disabled, true, "unoffered full-access profile is not an alias fallback");
});

test("a mode the adapter excludes is disabled with its reason while the others stay selectable", () => {
  // agy lists each part of Ask (for Approve for me and Full access) but cannot bring its approvals to the chat.
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const props = { team: { id: "team", nodes: [node("agy", "ao:agy", ":ao-default")] }, busy: false, loadProfiles: async () => ({}), save: async () => "" };
  const cap = { agy: { supported: true, profiles: [{ id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true }],
    approval_policies: ["on-request", "never"], approvals_reviewers: ["user", "auto_review"],
    excluded_modes: [{ profile: ":workspace", policy: "on-request", reviewer: "user", reason: "Antigravity asks for approval in its own terminal" }] } };
  const tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio");
  assert.deepEqual(rows.map(row => row.props.disabled), [true, false, false], "Ask off; Approve for me and Full access on");
  assert.match(rows[0].props.title, /asks for approval in its own terminal/);
});

test("permission popup renders exactly three mode rows with no scope or shared grant controls", () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const props = { team: { id: "team", nodes: [node("lead")] }, busy: false, loadProfiles: async () => ({}), save: async () => "", shared: "SHARED MUST NOT RENDER" };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true }], approval_policies: ["on-request", "never"], approvals_reviewers: ["user", "auto_review"] } };
  const tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => text(row).replace(/^.*?(Ask for approval|Approve for me|Full access)/, "$1")), [
    "Ask for approvalAlways ask to edit external files and use the internet",
    "Approve for meOnly ask for actions detected as potentially unsafe",
    "Full accessUnrestricted access to the internet and any file on your computer"]);
  assert.deepEqual(rows.map(row => /is-danger/.test(row.props.className)), [false, false, true], "Full access is drawn as a warning, as in Codex");
  assert.equal(elements(tree, item => item.type === "select").length, 0);
  assert.ok(!text(tree).includes("SHARED MUST NOT RENDER"));
});

test("a role that hasn't connected yet can still choose Ask for approval or Approve for me", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const draft = view.exports.draftPermissionCapability();
  assert.equal(draft.supported, true);
  const modes = view.exports.PERMISSION_MODES;
  for (const profile of draft.profiles) assert.ok(modes.some(mode => mode.profile === profile.id), `draft offers only Codex's modes, not ${profile.id}`);
  const calls = [];
  const props = { team: { id: "single", revision: 0, nodes: [node("single-draft")] }, busy: false, loadProfiles: async () => draft, save: async (...args) => { calls.push(args); return "Saved for the first start"; } };
  const tree = view.render("AgentOrchestratorPermissions", props, [true, { "single-draft": draft }, "", false]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio");
  assert.equal(rows[0].props.disabled, false);
  assert.equal(rows[1].props.disabled, false);
  rows[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(calls[0][3]), { profile: ":workspace", policy: "on-request", reviewer: "auto_review" });
});

test("explicit all-role selection updates every native role only, preserving unrelated raw rights", () => {
  const api = renderer("AgentOrchestratorPermissions.tsx").exports;
  const team = { revision: 7, nodes: [node("planner"), node("reviewer"), node("helper"), node("external", "ao:codex", ":ao-default")] };
  const selected = api.selectPermissions(team, team.nodes.slice(0, 3).map(item => item.id), { profile: ":workspace", policy: "on-request", reviewer: "auto_review" });
  for (const item of selected.nodes.slice(0, 3)) assert.deepEqual(plain(item.route), { harness_id: "codex-native", permission_profile: ":workspace", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" });
  assert.equal(selected.nodes[3], team.nodes[3]);
  assert.equal(team.nodes[0].route.permission_profile, "managed/custom");
  assert.equal(api.permissionSummary(team.nodes), "Mixed");
  assert.match(api.permissionSummary([team.nodes[0]]), /managed\/custom/);
});

test("chat role list includes generated helpers but not unrelated future-team cards", () => {
  const api = renderer("AgentOrchestratorPermissions.tsx").exports;
  const mission = { team: { nodes: [node("lead")] }, nodes: [{ ...node("lead-job"), template_role_id: "lead" }, { ...node("recovery-job"), template_role_id: "recovery" }] };
  const roles = api.missionPermissionNodes(mission);
  assert.deepEqual(plain(roles.map(role => role.id)), ["lead", "recovery"]);
  assert.equal(roles[0].route.permission_profile, "managed/custom");
  assert.equal(mission.team.nodes.length, 1, "generated helper is not implicitly persisted");
});

test("historical single-role switches merge only explicit fields into the latest saved team", () => {
  const api = renderer("AgentOrchestratorPermissions.tsx").exports;
  const saved = { revision: 8, nodes: [
    { ...node("lead"), route: { harness_id: "codex-native", permission_profile: "newer/full", approval_policy: "never", approvals_reviewer: "user", effort: "xhigh" } },
    { ...node("review"), route: { harness_id: "codex-native", permission_profile: "newer/review", approval_policy: "never" } },
    { ...node("helper", "ao:codex", ":ao-default"), route: { harness_id: "ao:codex", permission_profile: ":ao-default", model: "new-model" } },
  ] };
  const next = api.mergeSavedPermissions(saved, ["lead"], { reviewer: "auto_review", policy: "on-request" });
  assert.equal(next.revision, 8);
  assert.equal(next.nodes[0].route.permission_profile, "newer/full", "reviewer selection is not a historical sandbox switch");
  assert.equal(next.nodes[0].route.effort, "xhigh");
  assert.equal(next.nodes[1], saved.nodes[1], "unselected reviewer remains exact raw saved object");
  const external = api.mergeSavedPermissions(saved, ["helper"], { profile: "selected/native" });
  assert.deepEqual(plain(external.nodes[2].route), { harness_id: "ao:codex", permission_profile: ":ao-default", native_permission_profile: "selected/native", model: "new-model" });
  assert.throws(() => api.mergeSavedPermissions(saved, ["removed-role"], { profile: ":workspace" }), /no longer exists/);
});

test("menu mounting never saves defaults and unavailable metadata cannot apply", () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  let saves = 0;
  const props = { team: { id: "team", nodes: [node("lead")] }, busy: false, loadProfiles: async () => ({ supported: false, profiles: [] }), save: async () => { saves++; }, shared: null };
  view.render("AgentOrchestratorPermissions", props);
  assert.equal(saves, 0);
  const tree = view.render("AgentOrchestratorPermissions", props, [true, {}, "", false]);
  const apply = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio")[0];
  assert.equal(apply.props.disabled, true);
  apply.props.onClick();
  assert.equal(saves, 0);
  assert.match(apply.props.title, /Checking permissions/);
});

test("menu sends captured revision and cancel/full-access refusal does not save", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const calls = [];
  const props = { team: { id: "team", revision: 7, nodes: [node("lead")] }, mission: { id: "chat", revision: 12, nodes: [] }, busy: false, loadProfiles: async () => ({}), save: async (...args) => { calls.push(args); return "Queued only"; }, shared: null };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true }], approval_policies: ["on-request", "never"], approvals_reviewers: ["user", "auto_review"] } };
  let tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  elements(tree, item => item.type === "button" && item.props.role === "menuitemradio")[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 12); assert.equal(calls[0][0].revision, 7);
  assert.deepEqual(plain(calls[0][2]), ["lead"]); assert.deepEqual(plain(calls[0][3]), { profile: ":workspace", policy: "on-request", reviewer: "user" });
  tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  elements(tree, item => item.type === "button" && item.props.role === "menuitemradio")[2].props.onClick();
  assert.equal(calls.length, 1);
  elements(tree, item => item.type === "button" && item.props["aria-label"] === "Close permissions")[0].props.onClick();
  assert.equal(calls.length, 1);
});

test("runtime policy is labelled effective only after actual acknowledgement", () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const lead = node("lead");
  const props = { team: { id: "team", nodes: [lead] }, mission: { id: "chat", nodes: [{ ...lead, id: "attempt", template_role_id: "lead", state: "running" }] }, busy: false, loadProfiles: async () => ({}), save: async () => "", shared: null };
  const cap = { lead: { supported: true, profiles: [] } };
  const effective = { permission_profile: "runtime/actual", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  let tree = view.render("AgentOrchestratorPermissions", { ...props, runtimePolicies: { "chat:attempt": { policy_acknowledged: false, effective_policy: effective } } }, [true, cap, "", false]);
  const tooltip = elements(tree, item => item.type === "button" && item.props["aria-haspopup"] === "menu")[0].props.title;
  assert.match(tooltip, /not confirmed/); assert.ok(!tooltip.includes("Active: runtime/actual"));
  tree = view.render("AgentOrchestratorPermissions", { ...props, runtimePolicies: { "chat:attempt": { policy_acknowledged: true, effective_policy: effective } } }, [true, cap, "", false]);
  assert.match(elements(tree, item => item.type === "button" && item.props["aria-haspopup"] === "menu")[0].props.title, /Active: runtime\/actual · on-request · auto_review/);
});

test("successful permission save announces exact scope without a visible footer; errors remain visible", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const message = "Selected for next attempt; shared grants unchanged; runtime acknowledgement required.";
  const props = { team: { id: "single", nodes: [node("lead")] }, busy: false, loadProfiles: async () => ({}), save: async () => message };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }], approval_policies: ["on-request"], approvals_reviewers: ["user"] } };
  let tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  elements(tree, item => item.type === "button" && item.props.role === "menuitemradio")[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = view.render("AgentOrchestratorPermissions", props);
  const status = elements(tree, item => item.props.role === "status")[0];
  assert.equal(text(status), message, "scope information remains exact for accessibility");
  assert.equal(status.props.style?.clipPath, "inset(50%)", "success does not create visible composer/footer clutter");
  assert.match(elements(tree, item => item.type === "button" && item.props["aria-haspopup"] === "menu")[0].props.title, /runtime acknowledgement required/);
  tree = view.render("AgentOrchestratorPermissions", { ...props, save: async () => { throw new Error("Retry: permission was not saved"); } }, [true, cap, "", false]);
  elements(tree, item => item.type === "button" && item.props.role === "menuitemradio")[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = view.render("AgentOrchestratorPermissions", props);
  const error = elements(tree, item => item.props.role === "alert")[0];
  assert.match(text(error), /Retry: permission was not saved/);
  assert.equal(error.props.style, undefined, "failure remains visibly actionable");
});

test("stale permission application remains an error notice, not success", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const props = { team: { id: "team", revision: 7, nodes: [node("lead")] }, mission: { id: "chat", revision: 12, nodes: [] }, busy: false, loadProfiles: async () => ({}), save: async () => { throw new Error("Stale revision; chat unchanged"); }, shared: null };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }], approval_policies: ["on-request"], approvals_reviewers: ["user"] } };
  let tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  elements(tree, item => item.type === "button" && item.props.role === "menuitemradio")[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = view.render("AgentOrchestratorPermissions", props);
  assert.match(text(tree), /Stale revision; chat unchanged/);
  assert.ok(!text(tree).includes("Queued only"));
});

test("questions and MCP form or URL replies use method-specific response shapes", () => {
  const view = renderer("AgentOrchestratorApproval.tsx");
  const replies = [];
  const base = { nodeId: "lead", approval_id: "typed", thread_id: "thread", turn_id: "turn" };
  const render = (approval, states) => view.render("AgentOrchestratorApproval", { approval: { ...base, ...approval }, busy: false, approve: (_, reply) => replies.push(plain(reply)) }, states);
  let tree = render({ kind: "questions", method: "item/tool/requestUserInput", request: { questions: [{ id: "q", question: "Which?", options: [{ label: "One" }] }] } }, [{ q: "One" }, "{}", "", "turn", {}]);
  elements(tree, item => item.type === "button" && text(item) === "Send answers")[0].props.onClick();
  assert.deepEqual(replies.pop(), { answers: { q: { answers: ["One"] } } });
  tree = render({ kind: "mcp_form", method: "mcpServer/elicitation/request", request: { requestedSchema: { properties: { choice: { type: "string" } } } } }, [{}, '{"choice":"yes"}', "", "turn", {}]);
  elements(tree, item => item.type === "button" && text(item) === "Submit form")[0].props.onClick();
  assert.deepEqual(replies.pop(), { action: "accept", content: { choice: "yes" } });
  tree = render({ kind: "mcp_url", method: "mcpServer/elicitation/request", request: { url: "https://example.com/authorization" } }, [{}, "{}", "", "turn", {}]);
  elements(tree, item => item.type === "button" && text(item) === "Authorization completed")[0].props.onClick();
  assert.deepEqual(replies.pop(), { action: "accept" });
  elements(tree, item => item.type === "button" && text(item) === "Cancel")[0].props.onClick();
  assert.deepEqual(replies.pop(), { action: "cancel" });
});

test("an AO agent's tool request is answered by clicking an option: no Submit or Deny button, and only once", () => {
  const view = renderer("AgentOrchestratorApproval.tsx");
  const replies = [];
  const approval = { nodeId: "lead", approval_id: "ask", source: "ao", kind: "command", tool: "PowerShell", command: "Get-ChildItem",
    decisions: [{ id: "yes", kind: "allow_once", label: "Allow" }, { id: "always", kind: "allow_always", label: "Always allow" }, { id: "no", kind: "reject_once", label: "Reject" }] };
  // The approval renders Codex's card (AoAsk), whose options are a CdxOptions element.
  const card = () => {
    const outer = view.render("AgentOrchestratorApproval", { approval, busy: false, approve: (_, reply) => replies.push(plain(reply)), actor: "DeepSeek" });
    return outer.type(outer.props);
  };
  let tree = card();
  assert.deepEqual(elements(tree, item => item.type === "button").map(text), [], "the card itself has no Submit or Deny button");
  const options = () => elements(tree, item => typeof item.type === "function" && item.type.name === "CdxOptions")[0];
  let buttons = elements(options().type(options().props), item => item.type === "button");
  assert.deepEqual(buttons.map(button => text(button.props.children[1])), ["Allow once", "Allow this conversation", "Deny"]);
  buttons[1].props.onClick();
  assert.deepEqual(replies, [{ decisionId: "always" }], "one click answers");
  tree = card();
  buttons = elements(options().type(options().props), item => item.type === "button");
  assert.ok(buttons.every(button => button.props.disabled), "the answered card takes no second answer");
  assert.equal(options().props.picked[0], "always", "and shows the answer picked");
  buttons[2].props.onClick();
  assert.equal(replies.length, 1);
});

test("native decision objects are forwarded unchanged and unscoped requests are disabled", () => {
  const view = renderer("AgentOrchestratorApproval.tsx");
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
  const approval = { nodeId: "lead", approval_id: "a", kind: "command", method: "item/commandExecution/requestApproval", thread_id: "thread", turn_id: "turn", request: { availableDecisions: [decision, "decline"] } };
  const replies = [];
  let tree = view.render("AgentOrchestratorApproval", { approval, busy: false, approve: (_, reply) => replies.push(reply) });
  const buttons = elements(tree, item => item.type === "button");
  assert.equal(buttons.length, 2); buttons[0].props.onClick();
  assert.deepEqual(plain(replies[0]), { decision });
  tree = view.render("AgentOrchestratorApproval", { approval: { ...approval, turn_id: undefined }, busy: false, approve() {} });
  assert.equal(elements(tree, item => item.type === "fieldset")[0].props.disabled, true);
  assert.match(text(tree), /this request has no live turn/);
});

test("command location uses the exact requested outside cwd, not the workspace root", () => {
  const view = renderer("AgentOrchestratorApproval.tsx");
  const base = { nodeId: "lead", approval_id: "outside", method: "item/commandExecution/requestApproval", kind: "command", thread_id: "t", turn_id: "u", path: "/workspace-root", cwd: "/fallback-cwd" };
  let tree = view.render("AgentOrchestratorApproval", { approval: { ...base, request: { cwd: "/outside/working-directory", availableDecisions: ["decline"] } }, busy: false, approve() {} });
  assert.equal(text(elements(tree, item => item.type === "p")[0]), "Tool request · /outside/working-directory");
  tree = view.render("AgentOrchestratorApproval", { approval: { ...base, request: {} }, busy: false, approve() {} });
  assert.equal(text(elements(tree, item => item.type === "p")[0]), "Tool request · /fallback-cwd");
});

test("secret questions use password inputs without echoing answers to visible text", () => {
  const view = renderer("AgentOrchestratorApproval.tsx");
  const secret = "SECRET_RESPONSE_VALUE";
  const replies = [];
  const approval = { nodeId: "lead", approval_id: "secret", method: "item/tool/requestUserInput", kind: "questions", thread_id: "t", turn_id: "u", request: { questions: [{ id: "secret", question: "Enter the secret", isSecret: true }, { id: "normal", question: "Name" }] } };
  const tree = view.render("AgentOrchestratorApproval", { approval, busy: false, approve: (_, reply) => replies.push(plain(reply)) }, [{ secret, normal: "One" }, "{}", "", "turn", {}]);
  const inputs = elements(tree, item => item.type === "input");
  assert.equal(inputs[0].props.type, "password");
  assert.equal(inputs[0].props.autoComplete, "off");
  assert.equal(inputs[1].props.type, "text");
  assert.ok(!text(tree).includes(secret), "answers are not dumped into status, request details or other visible text");
  elements(tree, item => item.type === "button" && text(item) === "Send answers")[0].props.onClick();
  assert.deepEqual(replies[0], { answers: { secret: { answers: [secret] }, normal: { answers: ["One"] } } });
});

test("reusable team persistence strips only the mission-only deferred selection map", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const statement = source.split(/\r?\n/).find(line => line.includes("const { permission_selections: _missionPermissionSelections, ...reusableTeam } = draft;"));
  assert.ok(statement, "save_team uses explicit named omission of mission-only selection intent");
  assert.match(source, /team: reusableTeam as unknown as JsonObject/);
  const draft = { id: "team", revision: 7, nodes: [node("lead")], permission_selections: { lead: { approval_policy: "on-request" } } };
  const result = {};
  vm.runInNewContext(statement + " exports.team = reusableTeam;", { draft, exports: result });
  assert.equal("permission_selections" in result.team, false);
  assert.equal(result.team.nodes, draft.nodes, "role routes and raw permissions are intact");
  assert.equal(draft.permission_selections.lead.approval_policy, "on-request", "mission intent remains recoverable in the original snapshot");
});

test("permissions start empty, send only selected requested entries and retain explicit turn scope", () => {
  const view = renderer("AgentOrchestratorApproval.tsx");
  const replies = [];
  const props = { approval: { nodeId: "lead", approval_id: "p", method: "item/permissions/requestApproval", kind: "permissions", thread_id: "t", turn_id: "u", request: { permissions: { filesystem: { read: ["/one", "/two"], write: ["/three"] }, network: { enabled: true } } } }, busy: false, approve: (_, reply) => replies.push(reply) };
  let tree = view.render("AgentOrchestratorApproval", props);
  const boxes = elements(tree, item => item.type === "input" && item.props.type === "checkbox");
  assert.equal(boxes.length, 4); assert.ok(boxes.every(box => !box.props.checked));
  boxes[0].props.onChange({ target: { checked: true } });
  tree = view.render("AgentOrchestratorApproval", props);
  elements(tree, item => item.type === "button" && text(item) === "Allow selected")[0].props.onClick();
  assert.deepEqual(plain(replies[0]), { permissions: { filesystem: { read: ["/one"] } }, scope: "turn" });
});

test("a picked model the harness no longer offers is marked not available", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/cline-pass/deepseek-v4.1-flash", permission_profile: ":ao-default" };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange() {}, harnesses: [], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  let model = menuNamed(view.render("AgentOrchestratorComposerControls", props, composerState(["cpa/cline-pass/deepseek-v4-flash"])), "Model");
  assert.equal(model.props.className, "is-warning");
  assert.match(text(model.props.label), /not available/);
  assert.match(model.props.title, /not offered right now/);
  model = menuNamed(view.render("AgentOrchestratorComposerControls", { ...props, route: { ...route, model: "cpa/cline-pass/deepseek-v4-flash(high)" } }, composerState(["cpa/cline-pass/deepseek-v4-flash"])), "Model");
  assert.equal(model.props.className, "", "an effort suffix still matches its listed model");
  model = menuNamed(view.render("AgentOrchestratorComposerControls", props, composerState(null)), "Model");
  assert.equal(model.props.className, "", "nothing is flagged before the list loads");
});

/** Renders the composer on `route`, lets its catalog load, and returns the route changes it made. */
async function composerLoad(route, capabilities, options) {
  const view = renderer("AgentOrchestratorComposerControls.tsx", options);
  const routes = [];
  let release = () => {};
  const gate = options?.gated ? new Promise(resolve => { release = resolve; }) : null;
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false,
    loadModels: async harness => { if (harness === "codex-native") return []; await gate; return { models: Object.keys(capabilities), capabilities }; } };
  view.render("AgentOrchestratorComposerControls", props, composerState(null));
  view.effects[view.effects.length - 1]();
  const settle = async () => { release(); await new Promise(resolve => setImmediate(resolve)); };
  if (!gate) await settle();
  return { routes, settle, render: next => view.render("AgentOrchestratorComposerControls", { ...props, ...next }) };
}

test("the composer starts a window only for a model whose limit is known, and drops one the model does not take", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/glm-5", permission_profile: ":ao-default" };
  const unknown = { "cpa/glm-5": { efforts: [], contextWindow: { min: 4096, max: 2_000_000 } } };
  const known = { "cpa/glm-5": { efforts: [], contextLimit: 262144, contextWindow: { min: 4096, max: 262144 } } };
  // Without a reported limit the range ends at the client's 2M, so 400K reached 128K-262K models.
  let view = await composerLoad(route, unknown);
  assert.deepEqual(view.routes, [], "the agent's own window is left");
  assert.equal(text(menuNamed(view.render(), "Context window").props.label), "Auto");
  view = await composerLoad(route, known);
  assert.equal(view.routes.at(-1).context_window, 262144, "a known limit starts the chat at it (under 400K)");
  // A window carried by the harness chip or an older pick is checked once the catalog is known.
  view = await composerLoad({ ...route, context_window: 1_000_000 }, known);
  assert.equal(view.routes.at(-1).context_window, 262144, "out of range: replaced by the model's start");
  view = await composerLoad({ ...route, context_window: 1_000_000 }, { "cpa/glm-5": { efforts: [], contextReason: "no setter" } });
  assert.equal(Object.hasOwn(view.routes.at(-1), "context_window"), false, "unsupported: dropped");
  view = await composerLoad({ ...route, context_window: 131072 }, known);
  assert.deepEqual(view.routes, [], "a window the model takes is kept");
});

test("a WebGPT chat's window is the Codex bridge's: shown, locked, and a carried 200K fitted to it", async () => {
  // The user: "on web gpt model, it should follow codexbridge max context window and lock it".
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-account", model: "chatgpt-web/high", permission_profile: ":workspace", effort: "high", context_window: 200_000 };
  const capabilities = { "chatgpt-web/high": { efforts: [], contextLimit: 111193, contextWindow: { min: 111193, max: 111193, kind: "context", fixed: true },
    contextReason: "WebGPT's window is the Codex bridge's: 111,193 tokens" } };
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false,
    loadModels: async () => ({ models: Object.keys(capabilities), capabilities }) };
  view.render("AgentOrchestratorComposerControls", props, composerState(null));
  view.effects[view.effects.length - 1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(routes.at(-1).context_window, 111193, "the 200K the chat carried becomes the bridge's window");
  const chip = menuNamed(view.render("AgentOrchestratorComposerControls", { ...props, route: routes.at(-1) }), "Context window");
  assert.equal(chip.props.disabled, true, "locked");
  assert.equal(text(chip.props.label), "111,193");
  assert.match(chip.props.title, /Codex bridge's: 111,193 tokens/);
});

test("a model that lists efforts but no Auto starts on one it takes, as an adjustment, not a pick", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/deepseek-v4.1-flash", permission_profile: ":ao-default" };
  const adjusted = [];
  const load = (capabilities, start = route) => composerLoad(start, capabilities);
  // DeepSeek V4.1 Flash on CPA lists None/Low/High/Max: no effort sent was no request CPA could serve.
  let view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["none", "low", "high", "max"] } });
  assert.equal(view.routes.at(-1).effort, "high", "high when there is no medium");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["low", "medium", "high"] } });
  assert.equal(view.routes.at(-1).effort, "medium");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["none", "low"] } });
  assert.equal(view.routes.at(-1).effort, "low", "never None unless it is all there is");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["max", "low"] } });
  assert.equal(view.routes.at(-1).effort, "low", "the lowest by rank, not the catalog's first");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["low", "minimal"] } });
  assert.equal(view.routes.at(-1).effort, "minimal");
  view = await load({ "gpt-5.5": { efforts: ["low", "high"] } }, { ...route, harness_id: "ao:codex", model: "gpt-5.5" });
  assert.deepEqual(view.routes, [], "a harness's own model runs at its own default");
  view = await load({ "cpa/gemini-3-flash": { efforts: ["low", "high"] } }, { ...route, harness_id: "ao:agy", model: "cpa/gemini-3-flash" });
  assert.deepEqual(view.routes, [], "agy gets the bare model name and picks its own thinking level");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["low", "high", "auto"] } });
  assert.deepEqual(view.routes, [], "a model that takes Auto stays on it");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: [] } });
  assert.deepEqual(view.routes, [], "a model that takes no effort gets none");
  view = await load({ "cpa/deepseek-v4.1-flash": { efforts: ["low", "high"] } }, { ...route, effort: "low" });
  assert.deepEqual(view.routes, [], "a picked effort is kept");
  view = await load({ "cpa/gemini-3.8-flash-high": { efforts: ["low", "medium", "high"] } }, { ...route, model: "cpa/gemini-3.8-flash-high" });
  assert.deepEqual(view.routes, [], "a model whose id names its effort keeps its own");
  // The start is the composer fitting the route to the model, so it is reported as an adjustment:
  // the next new chat (or a rewind) keeps the person's own last pick, not this chat's fit-up.
  const fit = renderer("AgentOrchestratorComposerControls.tsx");
  const caps = { "cpa/deepseek-v4.1-flash": { efforts: ["none", "low", "high", "max"] } };
  fit.render("AgentOrchestratorComposerControls", { mode: "single", onModeChange() {}, route, onRouteChange: (next, auto) => adjusted.push([plain(next).effort, auto]),
    harnesses: [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false,
    loadModels: async harness => harness === "codex-native" ? [] : { models: Object.keys(caps), capabilities: caps } }, composerState(null));
  fit.effects[fit.effects.length - 1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(adjusted, [["high", true]]);
});

test("picking a model that lists no Auto effort picks a real effort with it", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/glm-5", permission_profile: ":ao-default" };
  const caps = { "cpa/glm-5": { efforts: [] }, "cpa/deepseek-v4.1-flash": { efforts: ["none", "low", "high", "max"] } };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: (next, auto) => routes.push([plain(next), auto]), harnesses: [], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  const tree = view.render("AgentOrchestratorComposerControls", props, composerState(Object.keys(caps), caps));
  optionsIn(menuNamed(tree, "Model")).find(row => row.props.title.includes("deepseek")).props.onPick();
  const [picked, auto] = routes.at(-1);
  assert.equal(picked.effort, "high");
  assert.notEqual(auto, true, "a model the person picked is their pick, effort included");
});

test("a catalog that loads after the user picked another model does not put the old one back", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/first", permission_profile: ":ao-default" };
  const caps = { "cpa/first": { efforts: [], contextLimit: 262144, contextWindow: { min: 4096, max: 262144 } },
    "cpa/second": { efforts: [], contextLimit: 1_000_000, contextWindow: { min: 4096, max: 1_000_000 } } };
  const view = await composerLoad(route, caps, { persistentRefs: true, gated: true });
  const picked = { route: { ...route, model: "cpa/second", context_window: 400_000 } };
  view.render(picked);
  await view.settle();
  assert.equal(optionsIn(menuNamed(view.render(picked), "Model")).length, 2, "the catalog did load");
  assert.deepEqual(view.routes, [], "the late catalog leaves the newer pick alone");
});

test("picking a model fits the carried window to it", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/big", permission_profile: ":ao-default", context_window: 1_000_000 };
  const caps = { "cpa/big": { efforts: [], contextLimit: 1_000_000, contextWindow: { min: 4096, max: 1_000_000 } },
    "cpa/small": { efforts: [], contextLimit: 262144, contextWindow: { min: 4096, max: 262144 } },
    "cpa/unknown": { efforts: [], contextWindow: { min: 4096, max: 2_000_000 } } };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  const tree = view.render("AgentOrchestratorComposerControls", props, composerState(Object.keys(caps), caps));
  const pick = name => optionsIn(menuNamed(tree, "Model")).find(row => row.props.title.includes(name)).props.onPick();
  pick("cpa/small");
  assert.equal(routes.at(-1).context_window, 262144, "clamped to the new model's limit");
  pick("cpa/unknown");
  assert.equal(routes.at(-1).context_window, 1_000_000, "within an unreported range a picked window stays");
});

test("the selected run's polls ask only the project the run belongs to", () => {
  // Seen live: 25 "AO run not found in this workspace" observe failures in the launcher log, from the
  // approvals poll asking the newly opened project about a run still selected from the previous one.
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  assert.match(source, /const selectedRunHere = missions\.some\(\(mission\) => mission\.id === selectedRunId && mission\.workspace_id === workspaceId\);/);
  const statusPoll = source.slice(source.indexOf("const selectedRunHere"), source.indexOf("const activeNodeIds"));
  assert.match(statusPoll, /if \(!workspaceId \|\| !selectedRunId \|\| !selectedRunHere\)/, "the run-status poll waits for the run to be this project's");
  const approvalsPoll = source.slice(source.indexOf("approvalScope.current = { workspaceId, runId: selectedRunId };"), source.indexOf("const taskName = "));
  assert.match(approvalsPoll, /if \(!workspaceId \|\| !selectedRunId \|\| !selectedRunHere \|\| !ids\.length\) return;/, "so does the approvals poll");
  assert.match(approvalsPoll, /\}, \[workspaceId, selectedRunId, selectedRunHere, activeNodeIds, autoStatus, setError\]\);/, "and starts once it is");
});
test("a card clicked after its request was answered or withdrawn just goes, for every way approve_harness says so", () => {
  // Seen in the launcher log: "AO tool request is no longer pending" showed as an error on a card
  // clicked while its reviewer was still answering.
  const surface = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const quiet = new RegExp(surface.match(/if \(\/([^/]+)\/\.test\(cause instanceof Error/)[1]);
  const workflow = fs.readFileSync(path.resolve(__dirname, "../electron/agent-orchestrator-workflow.cjs"), "utf8");
  const gone = [...workflow.matchAll(/throw new Error\("([^"]*no longer (?:pending|waiting)[^"]*)"\)/g)].map(match => match[1]);
  assert.ok(gone.includes("AO tool request is no longer pending"), "the AO tool request's own wording is among them");
  for (const message of gone) assert.match(message, quiet, `"${message}" closes the card quietly`);
  assert.match("the agent controller for this session is not running (CHAT_CONTROLLER_NOT_READY)", quiet,
    "nor can a request be answered once its agent stopped");
  assert.doesNotMatch("AO result is unavailable; inspect the run before retrying", quiet, "a real failure is still reported");
});

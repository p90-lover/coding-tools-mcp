"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const plain = value => JSON.parse(JSON.stringify(value));
function renderer(file) {
  let states = [], cursor = 0;
  const effects = [];
  const react = { useState: initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  }, useEffect: effect => effects.push(effect), useRef: initial => ({ current: initial }) };
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
  return { exports, effects, render(name, props, values) { if (values) states = values; cursor = 0; effects.length = 0; return exports[name](props); } };
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => elements(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}
const text = tree => typeof tree === "string" ? tree : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const node = (id, harness = "codex-native", profile = "managed/custom") => ({ id, role: "worker", route: { harness_id: harness, permission_profile: profile }, settings: {} });

test("composer mode clicks show only the corresponding real selector without sending", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const changes = [];
  const props = { mode: "single", onModeChange: mode => changes.push(mode), route: { harness_id: "ao:claude-code", model: "cpa/gemini-flash", permission_profile: ":ao-default" }, onRouteChange() {}, harnesses: [], loadModels: async () => [], teams: [{ id: "actual-team", name: "Saved setup", nodes: [] }], teamId: "actual-team", onTeamChange() {}, permissions: null, busy: false };
  let tree = view.render("AgentOrchestratorComposerControls", props);
  assert.equal(elements(tree, item => item.type === "button" && item.props["aria-label"] === "Choose model").length, 1);
  assert.equal(elements(tree, item => item.type === "button" && item.props["aria-label"] === "Choose saved team").length, 0);
  elements(tree, item => item.type === "button" && item.props["aria-label"] === "Switch to Team mode")[0].props.onClick();
  assert.deepEqual(changes, ["team"]);
  tree = view.render("AgentOrchestratorComposerControls", { ...props, mode: "team" });
  assert.equal(elements(tree, item => item.type === "button" && item.props["aria-label"] === "Choose model").length, 0);
  assert.equal(elements(tree, item => item.type === "button" && item.props["aria-label"] === "Choose saved team").length, 1);
});

test("saved-team popup uses only supplied setups and Escape restores its trigger focus", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const selected = [];
  const props = { mode: "team", onModeChange() {}, route: { model: "not rendered", harness_id: "ao:claude-code" }, onRouteChange() {}, harnesses: [], loadModels: async () => [], teams: [{ id: "real", name: "Runtime saved setup", nodes: [node("lead")] }], teamId: "real", onTeamChange: id => selected.push(id), permissions: null, busy: false };
  let tree = view.render("AgentOrchestratorComposerControls", props, [true, "", null, ""]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "radio");
  assert.equal(rows.length, 1); assert.match(text(rows[0]), /Runtime saved setup/);
  rows[0].props.onClick(); assert.deepEqual(selected, ["real"]);
  tree = view.render("AgentOrchestratorComposerControls", props, [true, "", null, ""]);
  let focused = 0;
  const trigger = elements(tree, item => item.type === "button" && item.props["aria-label"] === "Choose saved team")[0];
  trigger.props.ref.current = { focus: () => focused++ };
  elements(tree, item => item.props.className === "ao-composer-picker")[0].props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(focused, 1);
  tree = view.render("AgentOrchestratorComposerControls", props);
  assert.equal(elements(tree, item => item.props.role === "dialog").length, 0);
});

test("model search filters real catalog choices and WebGPT selection preserves saved policy", () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const routes = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gemini-flash", permission_profile: ":ao-default", native_permission_profile: "managed/custom", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], loadModels: async () => [], teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  let tree = view.render("AgentOrchestratorComposerControls", props, [true, "", ["cpa/gemini-flash", "chatgpt-web/high", "default"], ""]);
  assert.equal(elements(tree, item => item.type === "button" && item.props.role === "radio").length, 2, "only actual catalog entries, no default/fake models");
  elements(tree, item => item.type === "input" && item.props.type === "search")[0].props.onChange({ target: { value: "chatgpt-web" } });
  tree = view.render("AgentOrchestratorComposerControls", props);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "radio");
  assert.equal(rows.length, 1); rows[0].props.onClick();
  assert.equal(routes[0].harness_id, "codex-native");
  assert.equal(routes[0].permission_profile, "managed/custom");
  assert.equal(routes[0].approvals_reviewer, "auto_review");
  const tuning = elements(tree, item => typeof item.type === "function" && item.type.name === "HarnessPicker")[0];
  assert.equal(tuning.props.hideModel, true); assert.equal(tuning.props.hidePermissionNote, true);
});

test("WebGPT locks the harness but its model popup reads real Claude catalog to leave Native", async () => {
  const view = renderer("AgentOrchestratorComposerControls.tsx");
  const calls = [], routes = [];
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: "managed/raw", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const props = { mode: "single", onModeChange() {}, route, onRouteChange: next => routes.push(plain(next)), harnesses: [], loadModels: async harness => { calls.push(harness); return harness === "codex-native" ? ["chatgpt-web/high"] : ["cpa/actual-local-model"]; }, teams: [], teamId: "", onTeamChange() {}, permissions: null, busy: false };
  view.render("AgentOrchestratorComposerControls", props, [true, "", null, ""]);
  view.effects[view.effects.length - 1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.sort(), ["ao:claude-code", "codex-native"]);
  const tree = view.render("AgentOrchestratorComposerControls", props);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "radio");
  assert.equal(rows.length, 2);
  rows.find(row => text(row).includes("actual-local-model")).props.onClick();
  assert.equal(routes[0].harness_id, "ao:claude-code");
  assert.equal(routes[0].model, "cpa/actual-local-model");
  assert.equal(routes[0].native_permission_profile, "managed/raw");
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

test("permission popup renders exactly three mode rows with no scope or shared grant controls", () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const props = { team: { id: "team", nodes: [node("lead")] }, busy: false, loadProfiles: async () => ({}), save: async () => "", shared: "SHARED MUST NOT RENDER" };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true }], approval_policies: ["on-request", "never"], approvals_reviewers: ["user", "auto_review"] } };
  const tree = view.render("AgentOrchestratorPermissions", props, [true, cap, "", false]);
  const rows = elements(tree, item => item.type === "button" && item.props.role === "menuitemradio");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => text(row).replace(/^.*?(Ask for approval|Approve for me|Full access)/, "$1")), ["Ask for approvalAsk before additional access", "Approve for meReview requests automatically", "Full accessUnrestricted file and network access"]);
  assert.equal(elements(tree, item => item.type === "select").length, 0);
  assert.ok(!text(tree).includes("SHARED MUST NOT RENDER"));
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
  assert.match(apply.props.title, /Reading runtime permission capabilities/);
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
  assert.match(tooltip, /not acknowledged/); assert.ok(!tooltip.includes("Effective native runtime: runtime/actual"));
  tree = view.render("AgentOrchestratorPermissions", { ...props, runtimePolicies: { "chat:attempt": { policy_acknowledged: true, effective_policy: effective } } }, [true, cap, "", false]);
  assert.match(elements(tree, item => item.type === "button" && item.props["aria-haspopup"] === "menu")[0].props.title, /Effective native runtime: runtime\/actual · on-request · auto_review/);
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
  assert.match(text(tree), /Missing live thread\/turn scope/);
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
  elements(tree, item => item.type === "button" && text(item) === "Send selected subset")[0].props.onClick();
  assert.deepEqual(plain(replies[0]), { permissions: { filesystem: { read: ["/one"] } }, scope: "turn" });
});

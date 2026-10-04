"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const plain = value => JSON.parse(JSON.stringify(value));
function renderer(file) {
  const exports = {};
  let states = [], cursor = 0;
  const react = { useState: initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  }, useEffect() {} };
  const jsx = (type, props) => ({ type, props: props || {} });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(compiled, { exports, window: { confirm: () => false }, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : { NATIVE_HARNESS: "codex-native", nativePermission: route => route.native_permission_profile ?? route.permission_profile, roleLabel: node => node.role } });
  return { exports, render(name, props, values) { if (values) states = values; cursor = 0; return exports[name](props); } };
}
function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => elements(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}
const text = tree => typeof tree === "string" ? tree : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const node = (id, harness = "codex-native", profile = "managed/custom") => ({ id, role: "worker", route: { harness_id: harness, permission_profile: profile }, settings: {} });

test("explicit all-role selection updates every native role only, preserving unrelated raw rights", () => {
  const api = renderer("AgentOrchestratorPermissions.tsx").exports;
  const team = { revision: 7, nodes: [node("planner"), node("reviewer"), node("helper"), node("external", "ao:codex", ":ao-default")] };
  const selected = api.selectPermissions(team, team.nodes.map(item => item.id), { profile: ":workspace", policy: "on-request", reviewer: "auto_review" });
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
  const tree = view.render("AgentOrchestratorPermissions", props, [true, "*", {}, { profile: ":workspace" }, "", false]);
  const apply = elements(tree, item => item.type === "button" && text(item).includes("Apply"))[0];
  assert.equal(apply.props.disabled, true);
  apply.props.onClick();
  assert.equal(saves, 0);
  assert.match(text(tree), /Saved is not effective runtime readback/);
});

test("menu sends captured revision and cancel/full-access refusal does not save", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const calls = [];
  const props = { team: { id: "team", revision: 7, nodes: [node("lead")] }, mission: { id: "chat", revision: 12, nodes: [] }, busy: false, loadProfiles: async () => ({}), save: async (...args) => { calls.push(args); return "Queued only"; }, shared: null };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }], approval_policies: ["on-request"], approvals_reviewers: ["user", "auto_review"] } };
  let tree = view.render("AgentOrchestratorPermissions", props, [true, "*", cap, { profile: ":workspace" }, "", false]);
  elements(tree, item => item.type === "button" && text(item).includes("Apply"))[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 12); assert.equal(calls[0][0].revision, 7);
  assert.deepEqual(plain(calls[0][2]), ["lead"]); assert.deepEqual(plain(calls[0][3]), { profile: ":workspace" });
  tree = view.render("AgentOrchestratorPermissions", props, [true, "*", cap, { profile: ":full-access" }, "", false]);
  elements(tree, item => item.type === "button" && text(item).includes("Apply"))[0].props.onClick();
  assert.equal(calls.length, 1);
  elements(tree, item => item.type === "button" && text(item) === "Cancel")[0].props.onClick();
  assert.equal(calls.length, 1);
});

test("runtime policy is labelled effective only after actual acknowledgement", () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const lead = node("lead");
  const props = { team: { id: "team", nodes: [lead] }, mission: { id: "chat", nodes: [{ ...lead, id: "attempt", template_role_id: "lead", state: "running" }] }, busy: false, loadProfiles: async () => ({}), save: async () => "", shared: null };
  const cap = { lead: { supported: true, profiles: [] } };
  const effective = { permission_profile: "runtime/actual", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  let tree = view.render("AgentOrchestratorPermissions", { ...props, runtimePolicies: { "chat:attempt": { policy_acknowledged: false, effective_policy: effective } } }, [true, "*", cap, {}, "", false]);
  assert.match(text(tree), /not acknowledged/); assert.ok(!text(tree).includes("Effective native runtime: runtime/actual"));
  tree = view.render("AgentOrchestratorPermissions", { ...props, runtimePolicies: { "chat:attempt": { policy_acknowledged: true, effective_policy: effective } } }, [true, "*", cap, {}, "", false]);
  assert.match(text(tree), /Effective native runtime: runtime\/actual · on-request · auto_review/);
});

test("stale permission application remains an error notice, not success", async () => {
  const view = renderer("AgentOrchestratorPermissions.tsx");
  const props = { team: { id: "team", revision: 7, nodes: [node("lead")] }, mission: { id: "chat", revision: 12, nodes: [] }, busy: false, loadProfiles: async () => ({}), save: async () => { throw new Error("Stale revision; chat unchanged"); }, shared: null };
  const cap = { lead: { supported: true, profiles: [{ id: ":workspace", allowed: true }] } };
  let tree = view.render("AgentOrchestratorPermissions", props, [true, "*", cap, { profile: ":workspace" }, "", false]);
  elements(tree, item => item.type === "button" && text(item).includes("Apply"))[0].props.onClick();
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

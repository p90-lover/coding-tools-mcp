"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { acceptsAutobot, createAutobotPermission, reviewAutobot } = require("../electron/chat-autobot-permission.cjs");

const cwd = process.cwd();
const request = { source: "ao", kind: "command", tool: "Bash", command: "pwd", cwd, thread_id: "session", turn_id: "turn" };
const no = () => assert.fail("a reviewer or folder lookup should not have run");
const nativeDeny = { action: "deny", reason: "Guardian found it unsafe" };
const unavailable = { action: "ask", guardianUnavailable: true };

test("Autobot is per chat, accepts only known command groups and clears on restart", () => {
  const plugin = createAutobotPermission();
  const ask = { harness_id: "ao:claude-code", permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" };
  assert.equal(acceptsAutobot(ask), true);
  assert.equal(acceptsAutobot({ ...ask, approval_policy: "never" }), false);
  assert.equal(acceptsAutobot({ ...ask, approvals_reviewer: "auto_review" }), false);
  assert.equal(acceptsAutobot({ ...ask, harness_id: "codex-native" }), false);
  assert.throws(() => plugin.enable("ws", "chat", ["pwd"]), /listed read-only/);
  assert.throws(() => plugin.enable("ws", "chat", ["location", "location"]), /listed read-only/);
  assert.equal(plugin.read("ws", "chat").enabled, false);
  assert.match(plugin.enable("ws", "chat", ["location"]).summary, /pwd; Get-Location/);
  assert.equal(plugin.get("other", "chat"), null);
  assert.equal(plugin.get("ws", "another"), null);
  assert.equal(createAutobotPermission().get("ws", "chat"), null);
  const revision = plugin.revision();
  assert.equal(plugin.disable("ws", "chat").enabled, false);
  assert.notEqual(plugin.revision(), revision);
});

test("Autobot allows only an exact local command with an attested owned working directory", async () => {
  const config = createAutobotPermission().describe(["location"]);
  const base = { config, approval: request, root: () => cwd, guardian: no, model: no, mayMeter: () => false };
  assert.equal((await reviewAutobot(base)).actor, "autobot");
  for (const edited of [{ command: "pwd; pwd" }, { command: "pwd " }, { cwd: path.dirname(cwd) }, { cwd: undefined },
    { tool: "mcp__coding-tools__exec_command" }, { permissions: { network: true } }, { toolInput: '{"command":"pwd"}' }]) {
    assert.equal(await reviewAutobot({ ...base, approval: { ...request, ...edited }, guardian: () => nativeDeny }), nativeDeny);
  }
  for (const edited of [{ guardianUnsupported: true }, { guardianRequiresHuman: true }, { kind: "plan" }, { source: "user" }, { turn_id: null }]) {
    assert.equal((await reviewAutobot({ ...base, approval: { ...request, ...edited }, root: no })).action, "ask");
  }
  assert.equal((await reviewAutobot({ ...base, incomplete: true, root: no })).action, "ask");
  assert.equal(await reviewAutobot({ ...base, hardDenial: nativeDeny, root: no }), nativeDeny);
});

test("Autobot tries Guardian first and uses Model Judge only for unavailable Guardian with consent", async () => {
  const config = createAutobotPermission().describe(["location"]);
  const order = [];
  let metered = true;
  const base = { config, approval: { ...request, command: "not-in-the-list" }, root: no,
    guardian: () => { order.push("guardian"); return unavailable; }, mayMeter: () => metered,
    model: () => { order.push("model"); return { action: "allow", reason: "confirmed scope" }; } };
  assert.equal((await reviewAutobot(base)).autobotMetered, true);
  assert.deepEqual(order, ["guardian", "model"]);
  assert.equal(await reviewAutobot({ ...base, guardian: () => nativeDeny, model: no }), nativeDeny);
  assert.equal((await reviewAutobot({ ...base, guardian: () => ({ action: "ask", reason: "Review manually" }), model: no })).reason, "Review manually");
  assert.equal((await reviewAutobot({ ...base, model: () => { metered = false; return { action: "allow" }; } })).action, "ask");
  assert.equal((await reviewAutobot({ ...base, model: no })).quotaBlocked, true);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { executionSettingsPayload } = require("../electron/execution-settings.cjs");

const settings = {
  id: "web-binding", engine: "paseo", endpoint: "ws://127.0.0.1:6768/ws",
  provider: "chatgpt-web", model: "chatgpt-web/high", mode: "full-access",
  projectId: null, repoId: null, assigneeId: null, maxDurationMin: 20,
  allowCodex: true, confirmExternalExecution: true,
  accountId: "caller-spoof", routeId: "caller-spoof",
};
const plan = {
  provider: { id: "chatgpt-web" }, account: { id: "web-account" },
  model: "chatgpt-web/high", fallbackUsed: false,
  proxy: { mode: "profile", profile: { id: "proxy-1" } },
};

test("execution settings persist the verified account and proxy route, not caller IDs", () => {
  const payload = executionSettingsPayload(settings, plan);
  assert.equal(payload.provider, "chatgpt-web");
  assert.equal(payload.model, "chatgpt-web/high");
  assert.equal(payload.account_id, "web-account");
  assert.equal(payload.route_id, "proxy-1");
  assert.equal(JSON.stringify(payload).includes("caller-spoof"), false);
  assert.equal(executionSettingsPayload(null, null), null);
});

test("execution settings refuse a missing, mismatched, or fallback route", () => {
  assert.throws(() => executionSettingsPayload(settings, null), /verified route/);
  assert.throws(() => executionSettingsPayload(settings, { ...plan, model: "native-only" }), /exact model/);
  assert.throws(() => executionSettingsPayload(settings, { ...plan, fallbackUsed: true }), /fallback/);
});

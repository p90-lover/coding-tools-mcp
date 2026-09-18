"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  COMMANDCODE_ALTERNATE_LISTEN,
  COMMANDCODE_DEFAULT_BASE_URL,
  applyCommandCodeProxyPlan,
  commandCodeProxyRegistrationPlan,
  renderCommandCodeProxyPlan,
} = require("../electron/commandcode-proxy-plan.cjs");

test("CommandCode packaged default is 9090 with 3050 as the alternate listen", () => {
  assert.equal(COMMANDCODE_DEFAULT_BASE_URL, "http://127.0.0.1:9090/v1");
  assert.equal(COMMANDCODE_ALTERNATE_LISTEN, "http://127.0.0.1:3050/");
});

test("CommandCode registration plan never collects a user_* key", () => {
  const plan = commandCodeProxyRegistrationPlan({
    baseUrl: "http://127.0.0.1:9090/v1",
    routerCli: "model-router",
    curateCli: "curate-models",
  });
  const text = renderCommandCodeProxyPlan(plan);
  assert.equal(plan.credentialPromptRequired, true);
  assert.equal(JSON.stringify(plan.commands).includes("user_*"), false);
  assert.match(text, /user_\*/);
  assert.match(text, /credential commandcode-proxy set/);
  assert.match(text, /--allow-private/);
  assert.equal(plan.commands.some((command) => command.includes("credential")), true);
});

test("Apply non-secret skips credential set and does not accept user_*", () => {
  const spawned = [];
  const result = applyCommandCodeProxyPlan(
    { baseUrl: "http://127.0.0.1:9090/v1" },
    {
      spawnSyncImpl: (executable, args) => {
        spawned.push([executable, ...args]);
        return { status: 0, stdout: "ok", stderr: "" };
      },
    },
  );
  assert.equal(result.credentialPromptRequired, true);
  assert.equal(spawned.some((command) => command.includes("credential")), false);
  assert.deepEqual(result.steps.map((step) => step.name), ["add", "enable", "curate"]);
  assert.equal(result.steps.every((step) => step.ok), true);
  assert.equal(JSON.stringify(result).includes("user_*") && result.steps.some((step) => step.name === "credential"), false);
});

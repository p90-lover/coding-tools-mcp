"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const guard = source.match(/function assertFocusedMainWindow\([^]*?\n\}/)?.[0];
assert.ok(guard);

function registration(channel) {
  const start = source.indexOf(`  handle("${channel}",`);
  assert.ok(start >= 0, channel);
  const end = source.indexOf("\n  });", start);
  assert.ok(end > start, channel);
  return source.slice(start, end + "\n  });".length);
}

function fixture(options = {}) {
  const state = { focused: false, rendererFocused: false, visible: true, minimized: false,
    destroyed: false, mode: "automatic", signedIn: true, partition: "persist:other", ...options };
  const mainFrame = {}, calls = [], handlers = new Map();
  const sender = { mainFrame, isFocused: () => state.rendererFocused };
  const mainWindow = { isDestroyed: () => state.destroyed, isVisible: () => state.visible,
    isMinimized: () => state.minimized, isFocused: () => state.focused };
  const context = {
    mainWindow,
    BrowserWindow: { fromWebContents: value => value === sender ? mainWindow : {} },
    handle: (channel, handler) => handlers.set(channel, handler),
    browserAccounts: { activeId: () => "main", partitionOf: id => {
      assert.equal(id, "other");
      if (state.removed) throw new Error("Unknown browser account");
      return state.partition;
    } },
    browserHost: {},
    stateStore: { read: () => ({ browserInteractionMode: state.mode }) },
    quitting: false,
    shutdownInProgress: false,
    session: { fromPartition: partition => ({ cookies: { get: async input => {
      calls.push(["cookies", partition, input.url]);
      await options.afterCookies?.(state, context);
      return [];
    } } }) },
    signedInFromCookies: () => state.signedIn,
    routeIdleAccountPartition: async partition => {
      calls.push(["route", partition]);
      await options.afterRoute?.(state, context);
    },
    logger: {},
    inspectChatGptAccount: async input => {
      input.assertCurrent();
      assert.equal(input.metadataOnly, true, "inspection cannot create, publish or consent to MCP");
      assert.equal(input.partition, "persist:other");
      calls.push(["inspect", input.partition]);
      await options.duringInspection?.(state, context);
      input.assertCurrent();
      return { planType: "team" };
    },
    recordBrowserWorkspaceContext: (partition, result) => calls.push(["record", partition, result.planType]),
    browserAccountsStatus: () => ({ activeId: "main" }),
  };
  vm.runInNewContext(guard + "\n" + registration("launcher:browser-account-inspect"), context);
  const event = { sender, senderFrame: mainFrame };
  return { state, context, calls, event, handlers,
    inspect: (input = event) => handlers.get("launcher:browser-account-inspect")(input, "other") };
}

for (const [name, options] of [
  ["another app has focus", {}],
  ["an embedded browser has focus", { focused: true }],
  ["launcher is minimized", { visible: false, minimized: true }],
  ["launcher is hidden", { visible: false }],
]) {
  test(`account metadata inspection works when ${name}`, async () => {
    const f = fixture(options);
    assert.equal((await f.inspect()).activeId, "main", "inspection does not switch the shown account");
    assert.deepEqual(f.calls, [["cookies", "persist:other", "https://chatgpt.com/"],
      ["route", "persist:other"], ["inspect", "persist:other"], ["record", "persist:other", "team"]]);
  });
}

for (const scenario of ["subframe", "foreign window", "missing frame", "destroyed launcher"]) {
  test(`background inspection rejects ${scenario} before accessing the account`, async () => {
    const f = fixture({ focused: true, rendererFocused: true });
    if (scenario === "subframe") f.event.senderFrame = {};
    if (scenario === "foreign window") f.event.sender = { mainFrame: f.event.senderFrame, isFocused: () => true };
    if (scenario === "missing frame") delete f.event.sender.mainFrame;
    if (scenario === "destroyed launcher") f.state.destroyed = true;
    await assert.rejects(f.inspect());
    assert.deepEqual(f.calls, []);
  });
}

test("background inspection still rejects manual mode and signed-out accounts", async () => {
  const manual = fixture({ mode: "manual" });
  await assert.rejects(manual.inspect(), /Zero Risk/);
  assert.deepEqual(manual.calls, []);
  const signedOut = fixture({ signedIn: false });
  await assert.rejects(signedOut.inspect(), /Sign in/);
  assert.deepEqual(signedOut.calls.map(call => call[0]), ["cookies"]);
});

for (const phase of ["afterCookies", "afterRoute", "duringInspection"]) {
  for (const change of ["manual mode", "account removed", "partition changed", "app closing"]) {
    test(`inspection rejects ${change} ${phase}`, async () => {
      const f = fixture({ [phase]: (state, context) => {
        if (change === "manual mode") state.mode = "manual";
        if (change === "account removed") state.removed = true;
        if (change === "partition changed") state.partition = "persist:replacement";
        if (change === "app closing") context.shutdownInProgress = true;
      } });
      await assert.rejects(f.inspect(), /Zero Risk|Unknown browser account|changed/);
      const stages = f.calls.map(call => call[0]);
      assert.equal(stages.includes("record"), false, "stale observations never become verified metadata");
      if (phase === "afterCookies") assert.equal(stages.includes("route"), false);
      if (phase === "afterRoute") assert.equal(stages.includes("inspect"), false);
    });
  }
}

for (const channel of ["launcher:browser-account-remove", "launcher:browser-accounts-remove",
  "launcher:browser-account-switch", "launcher:mcp-create-connector", "coding-tools:computer:answer",
  "coding-tools:computer:forget-app", "coding-tools:computer:allow-app", "coding-tools:computer:stop",
  "coding-tools:workspaces:policy-update", "coding-tools:workspaces:copy-secret"]) {
  test(`${channel} does not inherit metadata inspection's background access`, async () => {
    const f = fixture();
    vm.runInNewContext(registration(channel), f.context);
    await assert.rejects(async () => f.handlers.get(channel)(f.event, {}), /focused/);
    assert.deepEqual(f.calls, []);
  });
}

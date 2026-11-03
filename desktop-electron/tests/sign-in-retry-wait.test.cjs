"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { SIGN_IN_RETRY_WAIT_MS, createSignInRetryWait, neverReachedChatGpt } = require("../electron/sign-in-retry-wait.cjs");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map();
const handlers = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(file));
  if (ts.isCallExpression(node) && node.expression.getText(file) === "handle"
    && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    handlers.set(node.arguments[0].text, node.arguments[1].getText(file));
  }
  ts.forEachChild(node, visit);
})(file);

const navigationError = (code, errno) => Object.assign(new Error(`${code} (${errno}) loading 'https://chatgpt.com/'`), { code, errno });

test("a try that did not sign in holds automatic checks off ChatGPT for 10 minutes", () => {
  let clock = 1_000;
  const warnings = [];
  const wait = createSignInRetryWait({ now: () => clock });
  const logger = { warn: (event, detail) => warnings.push([event, detail]) };
  assert.equal(SIGN_IN_RETRY_WAIT_MS, 10 * 60_000);
  assert.equal(wait.remainingMs(), 0, "nothing to wait for before a try");

  wait.settle({ authenticated: false }, logger);
  assert.equal(wait.remainingMs(), SIGN_IN_RETRY_WAIT_MS);
  assert.deepEqual(warnings, [["browser.signin_retry_waiting", { minutes: 10 }]]);
  clock += SIGN_IN_RETRY_WAIT_MS - 1;
  assert.equal(wait.remainingMs(), 1);
  clock += 1;
  assert.equal(wait.remainingMs(), 0, "after 10 minutes the next check may run");

  wait.settle(navigationError("ERR_ABORTED", -3), logger);
  assert.equal(wait.remainingMs(), SIGN_IN_RETRY_WAIT_MS, "a page ChatGPT turned away is a try too");
  wait.settle({ authenticated: true }, logger);
  assert.equal(wait.remainingMs(), 0, "signing in ends the wait");
  wait.settle(navigationError("ERR_ABORTED", -3), logger);
  wait.clear();
  assert.equal(wait.remainingMs(), 0, "and so does the person's own sign-in");
});

test("a failure that never reached ChatGPT starts no wait", () => {
  const wait = createSignInRetryWait({ now: () => 0 });
  for (const error of [
    navigationError("ERR_SOCKS_CONNECTION_FAILED", -120),
    navigationError("ERR_PROXY_CONNECTION_FAILED", -130),
    navigationError("ERR_NAME_NOT_RESOLVED", -105),
    new Error("ERR_CONNECTION_RESET (-101) loading 'https://chatgpt.com/'"),
  ]) {
    assert.equal(neverReachedChatGpt(error), true, error.message);
    wait.settle(error);
    assert.equal(wait.remainingMs(), 0, error.message);
  }
  for (const error of [navigationError("ERR_ABORTED", -3), navigationError("ERR_HTTP_RESPONSE_CODE_FAILURE", -379), new Error("ChatGPT login was not completed before the timeout")]) {
    assert.equal(neverReachedChatGpt(error), false, error.message);
  }
});

function setupCheck(browserHost, wait) {
  const events = [];
  const handler = vm.runInNewContext(`(${handlers.get("launcher:browser-check-auth")})`, {
    browserHost,
    signInRetryWait: wait,
    stateStore: { read: () => ({ browserInteractionMode: "automatic" }), update: () => ({}) },
    nextSessionRefreshReminderAt: () => 1,
    send() {},
    scheduleCodexBridgeAutoConnect() {},
    logger: { info: (event) => events.push(event), warn: (event) => events.push(event) },
  });
  return { handler, events };
}

test("Setup's 10-second check stops reopening ChatGPT after a refresh that did not sign in", async () => {
  // Seen 2026-11-03: the saved cookies read as signed in, ChatGPT refused the page, and Setup
  // reopened it every 10 s until ChatGPT blocked the sign-in for too many tries.
  let clock = 0;
  const calls = [];
  const browserHost = {
    snapshot: () => ({ authenticated: false }),
    currentOperation: () => null,
    activeTraceId: null,
    authenticationReadiness: async () => { calls.push("session"); return { authenticated: true, ready: true }; },
    refreshAuthentication: async () => { calls.push("refresh"); return { authenticated: false }; },
  };
  const { handler, events } = setupCheck(browserHost, createSignInRetryWait({ now: () => clock }));

  await handler();
  assert.deepEqual(calls, ["session", "refresh"]);
  for (let tick = 0; tick < 59; tick++) {
    clock += 10_000;
    await handler();
  }
  assert.deepEqual(calls, ["session", "refresh"], "nothing reaches ChatGPT for the next 10 minutes, not even the session check");
  assert.equal(events.filter((event) => event === "browser.signin_retry_waiting").length, 1);
  clock += 10_000;
  await handler();
  assert.deepEqual(calls, ["session", "refresh", "session", "refresh"], "then it tries once more");

  // A refresh that threw is a try too, and the error still reaches Setup.
  clock += SIGN_IN_RETRY_WAIT_MS;
  browserHost.refreshAuthentication = async () => { calls.push("refresh"); throw navigationError("ERR_ABORTED", -3); };
  await assert.rejects(handler(), /ERR_ABORTED/);
  calls.length = 0;
  clock += 10_000;
  await handler();
  assert.deepEqual(calls, [], "it waits after a thrown refresh as well");
});

test("Setup's check keeps going when its refresh could not reach ChatGPT, and stops once signed in", async () => {
  let clock = 0;
  let signedIn = false;
  const calls = [];
  const browserHost = {
    snapshot: () => ({ authenticated: signedIn }),
    currentOperation: () => null,
    activeTraceId: null,
    authenticationReadiness: async () => { calls.push("session"); return { authenticated: true, ready: true }; },
    refreshAuthentication: async () => { calls.push("refresh"); throw navigationError("ERR_SOCKS_CONNECTION_FAILED", -120); },
  };
  const { handler } = setupCheck(browserHost, createSignInRetryWait({ now: () => clock }));
  await assert.rejects(handler(), /SOCKS/);
  clock += 10_000;
  await assert.rejects(handler(), /SOCKS/);
  assert.deepEqual(calls, ["session", "refresh", "session", "refresh"], "a proxy that is down is no try ChatGPT counts");
  browserHost.refreshAuthentication = async () => { calls.push("refresh"); signedIn = true; return { authenticated: true }; };
  clock += 10_000;
  assert.equal((await handler()).authenticated, true);
  calls.length = 0;
  await handler();
  assert.deepEqual(calls, [], "a signed-in browser is not checked again");
});

test("the launch retries wait out a sign-in wait instead of reopening ChatGPT on their own steps", async () => {
  let clock = 0;
  const timers = [];
  const calls = [];
  const wait = createSignInRetryWait({ now: () => clock });
  const context = vm.createContext({
    AUTHENTICATION_RETRY_DELAYS_MS: [30_000, 60_000, 120_000, 300_000],
    quitting: false, shutdownInProgress: false,
    signInRetryWait: wait,
    navigationErrorForLog: (error) => ({ errorCode: error?.code }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    browserHost: {
      snapshot: () => ({ authenticated: false }),
      currentOperation: () => null,
      activeTraceId: null,
      refreshAuthentication: async () => { calls.push("refresh"); throw navigationError("ERR_ABORTED", -3); },
    },
  });
  const schedule = vm.runInContext(`(${functions.get("scheduleAuthenticationRetry")})`, context);
  context.scheduleAuthenticationRetry = schedule;
  const logger = { info() {}, warn() {} };
  const fire = async () => {
    const { fn, ms } = timers.shift();
    clock += ms;
    fn();
    await new Promise((resolve) => setImmediate(resolve));
    return ms;
  };

  schedule(logger);
  assert.equal(await fire(), 30_000);
  assert.deepEqual(calls, ["refresh"], "the first retry runs 30 s after launch");
  assert.equal(await fire(), 60_000);
  assert.deepEqual(calls, ["refresh"], "the next step finds the wait and does not open ChatGPT");
  assert.equal(await fire(), SIGN_IN_RETRY_WAIT_MS - 60_000, "it sleeps out what is left of the 10 minutes");
  assert.deepEqual(calls, ["refresh", "refresh"]);
});

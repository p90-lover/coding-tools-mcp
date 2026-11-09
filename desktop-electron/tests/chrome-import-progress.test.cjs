"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeHost } = require("../electron/runtime.cjs");

function fixture(write = (_value, done) => done()) {
  const messages = [];
  const child = { exitCode: null, signalCode: null, stdin: { writable: true, write } };
  const host = Object.assign(Object.create(RuntimeHost.prototype), {
    platform: "win32", active: "passkey-login", activeChild: child,
    passkeyContinuationRequested: false, publishOperation: operation => messages.push(operation),
  });
  return { host, child, messages };
}

test("Windows Continue says it is waiting for Chrome, not already importing", async () => {
  const f = fixture();
  assert.equal(await f.host.continuePasskeyLogin(), true);
  assert.match(f.messages.at(-1).message, /Waiting for the dedicated Chrome window to close before importing/);
  assert.doesNotMatch(f.messages.at(-1).message, /^Capturing/);
  assert.throws(() => f.host.continuePasskeyLogin(), /No passkey sign-in is waiting/);
});

test("an asynchronous Continue write failure restores a retryable waiting state", async () => {
  const f = fixture((_value, done) => done(new Error("fixture pipe error")));
  await assert.rejects(f.host.continuePasskeyLogin(), /fixture pipe error/);
  assert.equal(f.host.passkeyContinuationRequested, false);
  assert.match(f.messages.at(-1).message, /choose Continue/);
  f.child.stdin.write = (_value, done) => done();
  assert.equal(await f.host.continuePasskeyLogin(), true);
});

test("a synchronous Continue write failure cannot leave the importing latch set", async () => {
  const f = fixture(() => { throw new Error("fixture sync error"); });
  await assert.rejects(f.host.continuePasskeyLogin(), /fixture sync error/);
  assert.equal(f.host.passkeyContinuationRequested, false);
  assert.match(f.messages.at(-1).message, /choose Continue/);
});

test("a late Continue failure cannot reset another login child's state", async () => {
  let fail;
  const f = fixture((_value, done) => { fail = done; });
  const pending = f.host.continuePasskeyLogin();
  const rejected = assert.rejects(pending, /old pipe/);
  f.host.activeChild = { ...f.child };
  f.host.passkeyContinuationRequested = true;
  const count = f.messages.length;
  fail(new Error("old pipe"));
  await rejected;
  assert.equal(f.host.passkeyContinuationRequested, true);
  assert.equal(f.messages.length, count);
});

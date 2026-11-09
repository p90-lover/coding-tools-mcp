"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnOffThread } = require("../electron/off-thread-run.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createSandboxRunner } = require("../electron/chat-sandbox.cjs");

function fixture(t, extra = {}) {
  const parent = path.join(__dirname, "../../aiTemp/chat-long-horizon-tests");
  fs.mkdirSync(parent, { recursive: true });
  const scriptDir = fs.mkdtempSync(path.join(parent, "run-"));
  const children = [];
  const runner = createSandboxRunner({
    scriptDir, locate: () => ({ codex: "fixture-codex" }), roots: () => [], logger: { info() {} },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { child.kills = (child.kills || 0) + 1; child.emit("close", 0, null); };
      children.push(child);
      return child;
    },
    ...extra,
  });
  t.after(() => { for (const child of children) child.emit("close", 0, null); fs.rmSync(scriptDir, { recursive: true, force: true }); });
  const start = (options = {}) => runner.start({ cmd: "fixture command", cwd: path.resolve(scriptDir), writable: path.resolve(scriptDir), ...options });
  return { runner, children, start, scriptDir };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test("sandbox honors only a caller-requested deadline and keeps timed-out output", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { runner, children, start } = fixture(t);
  const id = await start({ timeoutMs: 50 });
  children[0].stdout.write("partial build output");
  t.mock.timers.tick(49);
  assert.equal(runner.snapshot(id).status, "running");
  t.mock.timers.tick(1);
  await settled();
  const result = runner.snapshot(id);
  assert.equal(result.termination_reason, "timed_out");
  assert.equal(result.command_ok, false, "a wrapper's zero exit cannot turn timeout into success");
  assert.equal(result.max_runtime_ms, 50);
  assert.equal(result.safe_to_retry, false);
  assert.equal(runner.read(id, "stdout").content, "partial build output");
  assert.equal(children[0].kills, 1);
});

test("missing, null and zero timeout permit multi-day commands without a hidden deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { runner, children, start } = fixture(t);
  for (const timeoutMs of [undefined, null, 0]) {
    const id = await start({ timeoutMs });
    t.mock.timers.tick(8 * 24 * 60 * 60 * 1000);
    assert.equal(runner.snapshot(id).status, "running");
    assert.equal(runner.snapshot(id).max_runtime_ms, null);
    assert.equal(children.at(-1).kills, undefined);
    await runner.kill(id);
  }
});

test("long explicit deadlines cannot overflow Node's single-timer range", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { runner, children, start } = fixture(t);
  const deadline = 30 * 24 * 60 * 60 * 1000;
  const id = await start({ timeoutMs: deadline });
  t.mock.timers.tick(2_147_483_647);
  assert.equal(runner.snapshot(id).status, "running");
  assert.equal(children[0].kills, undefined);
  t.mock.timers.tick(deadline - 2_147_483_647);
  await settled();
  assert.equal(runner.snapshot(id).termination_reason, "timed_out");
});

test("invalid deadlines are rejected before scripts or child processes are created", async t => {
  const { children, start, scriptDir } = fixture(t);
  for (const timeoutMs of [-1, 0.5, "100", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(start({ timeoutMs }), /timeout/i);
  }
  assert.equal(children.length, 0);
  assert.deepEqual(fs.readdirSync(scriptDir), []);
});

test("one oversized output chunk cannot exceed the retained per-stream budget", async t => {
  const { runner, children, start } = fixture(t);
  const id = await start();
  const budget = 4 * 1024 * 1024;
  const payload = Buffer.alloc(budget * 2 + 7, 0x61);
  children[0].stdout.write(payload);
  const page = runner.read(id, "stdout", 0, 1024);
  assert.equal(page.retained_start_offset, payload.length - budget);
  assert.equal(page.output_gap, true);
  assert.equal(page.total_stream_bytes, payload.length);
  assert.equal(page.next_read_offset, payload.length - budget + 1024);
  const result = runner.snapshot(id, 100);
  assert.equal(result.stdout, "a".repeat(100));
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.output_refs.stdout, `command:${id}:stdout`);
});

test("bounded response tails preserve complete UTF-8 characters", async t => {
  const { runner, children, start } = fixture(t);
  const id = await start();
  children[0].stdout.write("prefix中end");
  const result = runner.snapshot(id, 5);
  assert.equal(result.stdout, "end");
  assert.equal(result.stdout_truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 5);
  assert.equal(runner.read(id, "stdout").content, "prefix中end");
});

test("explicit termination never reports success when the wrapper returns zero", async t => {
  const { runner, start } = fixture(t);
  const id = await start();
  const result = await runner.kill(id);
  assert.equal(result.termination_reason, "killed");
  assert.equal(result.command_ok, false);
});

test("failed stop preserves live ownership and allows an explicit retry", async t => {
  let attempts = 0;
  const setup = fixture(t, { execFileProcess: (_file, _args, _options, done) => {
    attempts++;
    if (attempts === 1) done(Object.assign(new Error("fixture stop refused"), { code: "EACCES" }));
    else { setup.children[0].emit("close", 0, null); done(null); }
  } });
  const id = await setup.start();
  setup.children[0].pid = 4_000_001;
  try {
    await assert.rejects(setup.runner.kill(id), /could not stop/i);
    assert.equal(setup.runner.snapshot(id).status, "running");
    assert.match(setup.runner.snapshot(id).stop_error, /could not stop/);
    assert.equal(setup.runner.owns(id), true);
    const result = await setup.runner.kill(id);
    assert.equal(result.termination_reason, "killed");
    assert.equal(result.command_ok, false);
    assert.equal(attempts, 2);
    assert.equal(result.stop_error, undefined);
  } finally { setup.children[0].pid = undefined; }
});

test("an unsuccessful deadline stop stays visible and never relaunches the child", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const setup = fixture(t, { execFileProcess: (_file, _args, _options, done) => done(new Error("fixture stop failed")) });
  const id = await setup.start({ timeoutMs: 50 });
  setup.children[0].pid = 4_000_001;
  try {
    t.mock.timers.tick(50);
    await settled();
    const result = setup.runner.snapshot(id);
    assert.equal(result.status, "running");
    assert.equal(result.command_ok, null);
    assert.match(result.stop_error, /could not stop/);
    assert.equal(setup.children.length, 1);
    assert.equal(setup.runner.owns(id), true);
  } finally { setup.children[0].pid = undefined; }
});

// Real processes, so real timing: in 0.8.103's third release build (two suites' worth of load on one
// HDD) taskkill /T plus the parent's close took over 7.5 s, and the 10 s wait ended with the command
// still finalizing (command_ok null); in its retry the folder cleanup hit EPERM while Windows was
// still releasing the killed processes. The wait ends as soon as the tree is gone, so a generous
// bound costs nothing when it works, and a tree that never stops still fails every assertion below.
test("an explicit deadline stops a real owned Windows process tree and keeps its output", { skip: process.platform !== "win32", timeout: 60_000 }, async t => {
  const parent = path.join(__dirname, "../../aiTemp/chat-long-horizon-tests");
  fs.mkdirSync(parent, { recursive: true });
  const scriptDir = fs.mkdtempSync(path.join(parent, "real-"));
  let child, descendant;
  t.after(() => {
    for (const pid of [child?.pid, descendant]) if (Number.isInteger(pid)) { try { process.kill(pid); } catch {} }
    // EPERM/EBUSY while a killed process or an antivirus scan still holds the folder: retried.
    fs.rmSync(scriptDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  // The app's own path end to end: the parent is started from the spawn worker and the deadline's
  // taskkill from the run worker (the runner's defaults), never on this thread.
  const runner = createSandboxRunner({
    scriptDir, locate: () => ({ codex: "fixture-only" }), roots: () => [], logger: { info() {} },
    spawnProcess: async () => {
      const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write('descendant:'+child.pid+'\\n');setInterval(()=>{},1000);";
      // Started outside scriptDir: a process's working folder cannot be deleted while it lives.
      child = await spawnOffThread(process.execPath, ["-e", script], { cwd: parent, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      return child;
    },
  });
  const id = await runner.start({ cmd: "fixture-only supervisor smoke", cwd: scriptDir, writable: scriptDir, timeoutMs: 2500 });
  await runner.wait(id, 45_000);
  const result = runner.snapshot(id);
  assert.equal(result.termination_reason, "timed_out");
  assert.equal(result.command_ok, false);
  assert.equal(result.finalization_pending, false);
  const output = runner.read(id, "stdout").content;
  descendant = Number(/descendant:(\d+)/.exec(output)?.[1]);
  assert.ok(Number.isInteger(descendant), "the local parent reached its child-spawn step");
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

test("completed commands clear their deadline and keep their original outcome", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { runner, children, start } = fixture(t);
  const id = await start({ timeoutMs: 50 });
  children[0].emit("close", 0, null);
  t.mock.timers.tick(51);
  await settled();
  assert.equal(runner.snapshot(id).termination_reason, "exited");
  assert.equal(runner.snapshot(id).command_ok, true);
  assert.equal(children[0].kills, undefined);
});

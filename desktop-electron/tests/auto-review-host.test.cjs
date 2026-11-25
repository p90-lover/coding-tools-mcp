"use strict";
require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAutoReviewHost, DEFAULT_PLUGIN_PATH } = require("../electron/auto-review-host.cjs");

/** A plugin folder whose AutoReview answers from `body` (the class's methods), like the real one's src/index.ts. */
function fakePlugin(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-auto-review-fake-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), `import { EventEmitter } from "node:events";
export class AutoReview extends EventEmitter {
  constructor(options) { super(); this.options = options; this.scheduler = { opts: { lowerPriority: true } }; this.calls = []; }
  getStats() { return { enabled: true, calls: this.calls.length, lowerPriority: this.scheduler.opts.lowerPriority, dataDir: this.options.dataDir ?? null }; }
  close() {}
  ${body}
}
`);
  return root;
}

test("with no plugin at the configured path nothing starts and every call answers null", async () => {
  let workers = 0;
  const host = createAutoReviewHost({ pluginPath: path.join(os.tmpdir(), "no-such-auto-review-plugin"), WorkerImpl: class { constructor() { workers++; } } });
  try {
    assert.equal(await host.available(), false);
    assert.equal(await host.review({ command: "git status" }), null);
    assert.equal(await host.answerQuestion({ question: "Continue?" }), null);
    assert.equal(await host.getStats(), null);
    assert.equal(workers, 0, "no worker thread for a missing plugin");
  } finally { await host.close(); }
});

test("the default plugin path is G:\\Projects\\auto-review-plugin, and CODING_TOOLS_AUTO_REVIEW_PATH overrides it", () => {
  assert.equal(DEFAULT_PLUGIN_PATH, "G:\\Projects\\auto-review-plugin");
  const before = process.env.CODING_TOOLS_AUTO_REVIEW_PATH;
  process.env.CODING_TOOLS_AUTO_REVIEW_PATH = path.join(os.tmpdir(), "elsewhere-auto-review");
  try {
    const host = createAutoReviewHost({ WorkerImpl: class {} });
    assert.equal(host.pluginPath, path.join(os.tmpdir(), "elsewhere-auto-review"));
    void host.close();
  } finally {
    if (before === undefined) delete process.env.CODING_TOOLS_AUTO_REVIEW_PATH; else process.env.CODING_TOOLS_AUTO_REVIEW_PATH = before;
  }
});

test("the plugin runs in a worker thread: review, outcome and override reach it, its stats event is forwarded, admin calls are not served", { timeout: 20_000 }, async () => {
  const root = fakePlugin(`
  review(input) { this.calls.push(["review", input]); this.emit("stats", 1); return { decisionId: "c1", verdict: "approve", settlement: "approved_by_rule", layer: "rule", reason: "fixture", patterns: [] }; }
  answerQuestion(input) { this.calls.push(["answerQuestion", input]); return { decisionId: "q1", verdict: "answer", answer: "yes", choiceIndex: 0, reason: "routine" }; }
  recordOutcome(input) { this.calls.push(["recordOutcome", input]); return { ok: true }; }
  recordOverride(input) { this.calls.push(["recordOverride", input]); return { ok: true, wrongDecision: true }; }
  reset() { throw new Error("reset must never be reachable"); }
  setEnabled() { throw new Error("setEnabled must never be reachable"); }`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-auto-review-data-"));
  const host = createAutoReviewHost({ pluginPath: root, dataDir, statsDebounceMs: 10 });
  const seen = [];
  const off = host.onStats((stats) => seen.push(stats));
  try {
    assert.equal(await host.available(), true);
    const verdict = await host.review({ command: "npm test", cwd: root, appId: "coding-tools" });
    assert.equal(verdict.verdict, "approve");
    assert.equal(verdict.decisionId, "c1");
    assert.equal((await host.answerQuestion({ question: "Continue?" })).answer, "yes");
    assert.deepEqual(await host.recordOutcome({ decisionId: "c1", exitCode: 0 }), { ok: true });
    assert.equal((await host.recordOverride({ decisionId: "c1", userVerdict: "decline" })).wrongDecision, true);
    const counted = () => seen.some((stats) => stats.calls >= 1);
    for (let i = 0; i < 50 && !counted(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(counted(), "the plugin's stats event after a decision reaches the app");
    const stats = await host.getStats();
    assert.equal(stats.calls, 4);
    assert.equal(stats.lowerPriority, false, "embedded, the plugin never lowers the app's process priority");
    assert.equal(stats.dataDir, dataDir);
    assert.equal(host.latestStats().calls >= 1, true);
    for (const admin of ["editBlocklist", "editRule", "reset", "setEnabled"]) assert.equal(host[admin], undefined, `${admin} is not offered`);
    assert.equal(await host.call("reset", { what: "all" }), null, "the worker refuses calls it does not serve");
  } finally { off(); await host.close(); }
});

test("a plugin that does not answer in time is treated as absent for that call", { timeout: 20_000 }, async () => {
  const root = fakePlugin(`
  review() { const end = Date.now() + 1500; while (Date.now() < end) {} return { verdict: "approve" }; }`);
  const host = createAutoReviewHost({ pluginPath: root, callTimeoutMs: 300 });
  try {
    const started = Date.now();
    assert.equal(await host.review({ command: "npm test" }), null);
    assert.ok(Date.now() - started < 1400, "the caller is not held for the plugin's whole delay");
  } finally { await host.close(); }
});

test("a plugin that fails to load leaves the app as it was", { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-auto-review-broken-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "throw new Error('broken plugin');\n");
  const warnings = [];
  const host = createAutoReviewHost({ pluginPath: root, logger: { warn: (event, detail) => warnings.push([event, detail]) } });
  try {
    assert.equal(await host.review({ command: "npm test" }), null);
    assert.equal(await host.review({ command: "npm test" }), null, "not retried at once");
    assert.ok(warnings.some(([event]) => event === "auto_review.unavailable"));
  } finally { await host.close(); }
});

const REAL_PLUGIN = process.env.CODING_TOOLS_AUTO_REVIEW_PATH || DEFAULT_PLUGIN_PATH;
test("the real plugin, when installed, approves read-only commands and declines blocklisted ones", {
  timeout: 30_000, skip: !fs.existsSync(path.join(REAL_PLUGIN, "src", "index.ts")) && "the auto-review plugin is not installed here",
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-auto-review-real-"));
  const host = createAutoReviewHost({ pluginPath: REAL_PLUGIN, dataDir });
  try {
    const read = await host.review({ command: "git status", cwd: dataDir, appId: "coding-tools" });
    assert.equal(read.verdict, "approve");
    const blocked = await host.review({ command: "rm -rf /", cwd: dataDir, appId: "coding-tools" });
    assert.equal(blocked.verdict, "decline");
    assert.equal(blocked.layer, "blocklist");
    const stats = await host.getStats();
    assert.equal(stats.commands.today.total, 2);
  } finally { await host.close(); }
});

test("the host never reads the disk synchronously: available() answers a promise and the worker's source is read once", { timeout: 20_000 }, async () => {
  const root = fakePlugin(`review() { return null; }`);
  const realStatSync = fs.statSync, realReadFileSync = fs.readFileSync;
  const sync = [];
  fs.statSync = (...args) => { sync.push(["statSync", String(args[0])]); return realStatSync(...args); };
  fs.readFileSync = (...args) => { sync.push(["readFileSync", String(args[0])]); return realReadFileSync(...args); };
  const reads = [];
  class FakeWorker {
    constructor(source) { reads.push(source.length); this.handlers = {}; setTimeout(() => this.handlers.message?.({ type: "ready", stats: null }), 0); }
    on(event, handler) { this.handlers[event] = handler; return this; }
    unref() {}
    postMessage(message) {
      if (message?.type === "close") setTimeout(() => this.handlers.message?.({ type: "closed" }), 0);
      else if (message?.id) queueMicrotask(() => this.handlers.message?.({ type: "reply", id: message.id, result: { ok: true } }));
    }
    terminate() {}
  }
  const host = createAutoReviewHost({ pluginPath: root, WorkerImpl: FakeWorker });
  try {
    const answer = host.available();
    assert.ok(answer instanceof Promise, "available() is asynchronous");
    assert.equal(await answer, true);
    assert.deepEqual(await host.review({ command: "git status" }), { ok: true });
    assert.deepEqual(await host.review({ command: "git diff" }), { ok: true });
    assert.equal(reads.length, 1, "one worker for two calls");
    const ours = sync.filter(([, file]) => file.includes("auto-review"));
    assert.deepEqual(ours, [], "no synchronous stat or read on Electron main");
  } finally {
    fs.statSync = realStatSync; fs.readFileSync = realReadFileSync;
    await host.close();
  }
});

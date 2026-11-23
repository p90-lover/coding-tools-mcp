"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createGuardianReview } = require("../electron/guardian-review.cjs");
const { recordGuardianContext, takeGuardianContext } = require("../scripts/claude-guardian-context.cjs");

test("the Claude hook supplies context once for the matching unchanged call, never for a required human decision", () => {
  const session = {}, other = {};
  const cwd = path.resolve(__dirname, "..");
  const tool_input = { command: "Write-Output fixture" };
  const event = { hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_use_id: "one", tool_input, cwd };
  recordGuardianContext(session, event, "one", 1000);
  assert.equal(takeGuardianContext(other, "one", "PowerShell", tool_input, false, 1000), undefined);
  assert.deepEqual(takeGuardianContext(session, "one", "PowerShell", tool_input, false, 2000), { cwd });
  assert.equal(takeGuardianContext(session, "one", "PowerShell", tool_input, false, 2000), undefined);
  recordGuardianContext(session, event, "one", 1000);
  assert.equal(takeGuardianContext(session, "one", "PowerShell", { command: "changed" }, false, 2000), undefined);
  recordGuardianContext(session, event, "one", 1000);
  assert.equal(takeGuardianContext(session, "one", "PowerShell", tool_input, false, 31001), undefined);
  recordGuardianContext(session, event, "one", 1000);
  assert.deepEqual(takeGuardianContext(session, "one", "PowerShell", tool_input, true, 2000), { requiresHuman: true });
});

async function fixture(t, { badCall = false, asksForTool = false, authKind = "chatgpt", assessment = { outcome: "allow", riskLevel: "low", userAuthorization: "high" },
  holdReview, onExecutable, limits, crashFirstReview = false, internalErrorOnce = false, accounts = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const spawned = [], logins = [];
  let childOptions, threads = 0, crashed = false;
  const review = createGuardianReview({ platform: "win32", stateDir: path.join(root, "state"), executable: () => {
    onExecutable?.();
    return path.join(root, "codex.exe");
  },
    env: { OPENAI_API_KEY: "unused", CODEX_HOME: "not-the-reviewer-home", ANTHROPIC_API_KEY: "unused" },
    prepareAccount: async () => (accounts ? accounts.length > 1 ? accounts.shift() : accounts[0] : { accessToken: "fixture", chatgptAccountId: "fixture-account" }),
    ...(limits ? { limits } : {}),
    spawnProcess(file, args, options) {
      assert.equal(file, path.join(root, "codex.exe"));
      assert.deepEqual(args.slice(0, 2), ["app-server", "--stdio"]);
      childOptions = options;
      spawned.push(options.cwd);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      const reader = createInterface({ input: child.stdin });
      child.kill = () => { reader.close(); child.emit("close"); };
      // One server carries several reviews: each thread keeps its own call.
      const calls = new Map();
      reader.on("line", (line) => {
        const message = JSON.parse(line);
        requests.push(message);
        const { id, method, params } = message;
        const deliver = value => child.stdout.write(JSON.stringify(value) + "\n");
        if (method === "initialized") return;
        let result = {};
        if (method === "account/login/start") logins.push({ token: params.accessToken, server: options.cwd });
        if (method === "account/read") result.account = { type: authKind };
        else if (method === "thread/start") result = { thread: { id: `review-thread-${++threads}` }, modelProvider: "openai" };
        else if (method === "thread/inject_items") calls.set(params.threadId, params.items.at(-1).call_id);
        else if (method === "thread/guardianReview") {
          if (asksForTool) return deliver({ id: 7654, method: "item/commandExecution/requestApproval", params: {} });
          if (crashFirstReview && !crashed) { crashed = true; child.kill(); return; }
          if (internalErrorOnce && !crashed) { crashed = true; return deliver({ id, error: { code: -32603, message: "internal" } }); }
          result = { callId: badCall ? "different-call" : calls.get(params.threadId), assessment };
          if (holdReview) return holdReview(options).then(() => deliver({ id, result }));
        }
        deliver({ id, result });
      });
      return child;
    },
  });
  const approval = { source: "ao", kind: "command", tool: "PowerShell", cwd: root, command: "Write-Output 'fixture'" };
  const request = { approval, folder: root, task: "The user asks to show the text fixture." };
  t.after(() => review.close());
  return { root, review, request, requests, spawned, logins, childOptions: () => childOptions };
}

test("native Guardian reviews the recorded command in an isolated thread and never runs a turn or tool", async (t) => {
  const { root, review, request, requests, childOptions } = await fixture(t);
  assert.equal((await review(request)).action, "allow");
  const options = childOptions();
  assert.ok(options.cwd.startsWith(path.join(root, "state") + path.sep));
  assert.equal(options.env.CODEX_HOME, options.cwd);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(requests.find(entry => entry.method === "account/login/start").params.type, "chatgptAuthTokens");
  assert.equal(requests.find(entry => entry.method === "thread/start").params.ephemeral, true);
  const items = requests.find(entry => entry.method === "thread/inject_items").params.items;
  assert.equal(items[0].role, "user");
  assert.equal(JSON.parse(items[1].arguments).cmd, request.approval.command);
  assert.deepEqual(requests.map(entry => entry.method), ["initialize", "initialized", "account/login/start", "account/read", "thread/start", "thread/inject_items", "thread/guardianReview"]);
  // The server stays for the next review; closing the pool (the app quitting) removes its profile.
  assert.equal((await fs.readdir(path.join(root, "state"))).length, 1);
  await review.close();
  assert.deepEqual(await fs.readdir(path.join(root, "state")), []);
});

test("a burst shares a few long-lived servers, several reviews each, and the rest wait without opening cancelled work", { timeout: 5000 }, async (t) => {
  // 2026-11-23: one server started per review, four at a time; a burst of requests timed out in line.
  const wave = Promise.withResolvers(), release = Promise.withResolvers(), validated = Promise.withResolvers();
  const held = [];
  let eligible = 0;
  const { review, request, requests, root, spawned } = await fixture(t, {
    limits: { maxServers: 2, perServer: 2, idleMs: 60_000 },
    onExecutable: () => { if (++eligible === 6) validated.resolve(); },
    holdReview: (opts) => {
      held.push(opts.cwd);
      if (held.length === 4) wave.resolve();
      return release.promise;
    },
  });
  const cancel = new AbortController();
  const ask = (i, signal) => review({ ...request, signal, approval: { ...request.approval, command: `Write-Output 'request ${i}'` } });
  const replies = Array.from({ length: 4 }, (_, i) => ask(i));
  try {
    await Promise.race([wave.promise, ...replies]);
    assert.equal(held.length, 4, "overlapping requests must not be dropped");
    assert.equal(spawned.length, 2, "four reviews share two servers");
    assert.deepEqual([...new Set(held)].sort(), [...spawned].sort(), "two reviews on each");
    replies.push(ask(4, cancel.signal), ask(5));
    await validated.promise;
    assert.equal(held.length, 4, "additional requests must wait until there is a slot");
    cancel.abort();
    assert.equal((await replies[4]).action, "ask");
  } finally { release.resolve(); await Promise.all(replies); }
  assert.deepEqual((await Promise.all(replies)).map(result => result.action), ["allow", "allow", "allow", "allow", "ask", "allow"]);
  assert.equal(spawned.length, 2, "the waiting request ran on a server already open");
  assert.deepEqual(requests.filter(entry => entry.method === "thread/inject_items").map(entry =>
    JSON.parse(entry.params.items.at(-1).arguments).cmd).sort(), [0, 1, 2, 3, 5].map(i => `Write-Output 'request ${i}'`));
  await review.close();
  assert.deepEqual(await fs.readdir(path.join(root, "state")), []);
});

test("waiting in line does not count against a review's own time limit", { timeout: 5000 }, async (t) => {
  // One slot, 300 ms per review, each review taking 200 ms: the third waits about 400 ms in line.
  const { review, request, spawned } = await fixture(t, {
    limits: { maxServers: 1, perServer: 1, workMs: 300, idleMs: 60_000 },
    holdReview: () => new Promise(resolve => setTimeout(resolve, 200)),
  });
  const replies = await Promise.all([0, 1, 2].map(i => review({ ...request, approval: { ...request.approval, command: `Write-Output 'queued ${i}'` } })));
  assert.deepEqual(replies.map(reply => reply.action), ["allow", "allow", "allow"], "a request is judged, not timed out while it waited");
  assert.equal(spawned.length, 1);
});

test("a server that ends under a review is replaced and the review tried once more", async (t) => {
  const { review, request, spawned } = await fixture(t, { crashFirstReview: true, limits: { idleMs: 60_000 } });
  assert.equal((await review(request)).action, "allow");
  assert.equal(spawned.length, 2, "a fresh server answered the second try");
});

test("an internal error from Codex is tried once more on the same server", async (t) => {
  // 2 of 300 live reviews on 2026-11-23 answered -32603 and were left for the person.
  const { review, request, spawned, requests } = await fixture(t, { internalErrorOnce: true, limits: { idleMs: 60_000 } });
  assert.equal((await review(request)).action, "allow");
  assert.equal(spawned.length, 1, "the server was still fine");
  assert.equal(requests.filter(entry => entry.method === "thread/guardianReview").length, 2);
});

test("a changed sign-in closes the old server, and the next review signs in afresh", async (t) => {
  const { review, request, spawned, logins, root } = await fixture(t, {
    limits: { idleMs: 60_000 },
    accounts: [{ accessToken: "first", chatgptAccountId: "account" }, { accessToken: "second", chatgptAccountId: "account" }],
  });
  assert.equal((await review(request)).action, "allow");
  assert.equal((await review(request)).action, "allow");
  assert.deepEqual(logins.map(login => login.token), ["first", "second"]);
  assert.equal(spawned.length, 2);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await fs.readdir(path.join(root, "state")), [path.basename(spawned[1])], "the first server's profile is gone");
});

test("closing the pool turns waiting requests away and removes every profile", { timeout: 5000 }, async (t) => {
  const release = Promise.withResolvers(), started = Promise.withResolvers();
  const { review, request, root } = await fixture(t, {
    limits: { maxServers: 1, perServer: 1, idleMs: 60_000 },
    holdReview: () => { started.resolve(); return release.promise; },
  });
  const first = review(request);
  await started.promise;
  const second = review({ ...request, approval: { ...request.approval, command: "Write-Output 'second'" } });
  const closing = review.close();
  assert.equal((await second).action, "ask", "a waiting request is not left hanging");
  release.resolve();
  await first;
  await closing;
  assert.deepEqual(await fs.readdir(path.join(root, "state")), []);
});

test("no valid approval when the identity or Guardian verdict is missing or the child requests execution", async (t) => {
  for (const options of [{ badCall: true }, { asksForTool: true }, { authKind: "apiKey" }, { assessment: null },
    { assessment: { outcome: "allow", riskLevel: "medium", userAuthorization: "high" } }]) {
    const { review, request, requests } = await fixture(t, options);
    const verdict = await review(request);
    assert.equal(verdict.action, "ask");
    assert.notEqual(verdict.guardianUnavailable, true, "an invalid review is not permission to use the fallback");
    assert.equal(requests.some(entry => !entry.method || entry.method === "turn/start" || entry.method === "command/exec"), false);
  }
});

test("uncertain cwd, non-shell and unavailable auth do not start a reviewer", async (t) => {
  const { review, request, requests } = await fixture(t);
  assert.equal((await review({ ...request, approval: { ...request.approval, cwd: path.dirname(request.folder) } })).action, "ask");
  assert.equal((await review({ ...request, approval: { ...request.approval, tool: "mcp__fixture__exec" } })).action, "ask");
  assert.deepEqual(requests, []);
  const noAuth = createGuardianReview({ platform: "win32", stateDir: request.folder, authFile: path.join(request.folder, "missing.json"),
    executable: () => path.join(request.folder, "codex.exe"), spawnProcess: () => assert.fail("no native sign-in") });
  const outcome = await noAuth(request);
  assert.match(outcome.reason, /ChatGPT sign-in/);
  assert.equal(outcome.guardianUnavailable, true);
});

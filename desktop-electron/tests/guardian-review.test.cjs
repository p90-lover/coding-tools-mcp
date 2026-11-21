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

async function fixture(t, { badCall = false, asksForTool = false, authKind = "chatgpt", assessment = { outcome: "allow", riskLevel: "low", userAuthorization: "high" } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  let childOptions;
  const review = createGuardianReview({ platform: "win32", stateDir: path.join(root, "state"), executable: () => path.join(root, "codex.exe"),
    env: { OPENAI_API_KEY: "unused", CODEX_HOME: "not-the-reviewer-home", ANTHROPIC_API_KEY: "unused" },
    prepareAccount: async () => ({ accessToken: "fixture", chatgptAccountId: "fixture-account" }),
    spawnProcess(file, args, options) {
      assert.equal(file, path.join(root, "codex.exe"));
      assert.deepEqual(args.slice(0, 2), ["app-server", "--stdio"]);
      childOptions = options;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      const reader = createInterface({ input: child.stdin });
      child.kill = () => { reader.close(); child.emit("close"); };
      let callId;
      reader.on("line", (line) => {
        const message = JSON.parse(line);
        requests.push(message);
        const { id, method, params } = message;
        const deliver = value => child.stdout.write(JSON.stringify(value) + "\n");
        if (method === "initialized") return;
        let result = {};
        if (method === "account/read") result.account = { type: authKind };
        else if (method === "thread/start") result = { thread: { id: "review-thread" }, modelProvider: "openai" };
        else if (method === "thread/inject_items") callId = params.items.at(-1).call_id;
        else if (method === "thread/guardianReview") {
          if (asksForTool) return deliver({ id: 7654, method: "item/commandExecution/requestApproval", params: {} });
          result = { callId: badCall ? "different-call" : callId, assessment };
        }
        deliver({ id, result });
      });
      return child;
    },
  });
  const approval = { source: "ao", kind: "command", tool: "PowerShell", cwd: root, command: "Write-Output 'fixture'" };
  const request = { approval, folder: root, task: "The user asks to show the text fixture." };
  return { root, review, request, requests, childOptions: () => childOptions };
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

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const { createChatQueueStore, steerReadIn } = require("../electron/chat-queue.cjs");
const { restartResume, RESTART_RESUME_WINDOW_MS } = require("../electron/chat-resume.cjs");

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function tempFile(t) {
  const root = path.join(__dirname, "..", "..", "aiTemp", "chat-queue-tests", crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "chat-queue.json");
}

test("a chat's queue keeps its order, takes a message at the front, and survives a restart", async (t) => {
  const file = tempFile(t);
  const store = createChatQueueStore({ file });
  const first = store.add("ws", "task", { what: "Message", message: "run the tests", selection: { executionMode: "single", singleRoute: { model: "m" } } });
  store.add("ws", "task", { what: "Goal", message: "ship it", goal: "ship it", typed: "/goal ship it" });
  store.add("ws", "task", { what: "Message", message: "refused for now" }, { front: true });
  assert.deepEqual(store.list("ws", "task").map(item => item.message), ["refused for now", "run the tests", "ship it"]);
  assert.equal(store.update("ws", "task", first.id, { message: "run the tests\n\nand lint" }).message, "run the tests\n\nand lint");
  assert.equal(store.update("ws", "task", "gone", { message: "x" }), null, "a message already sent is not brought back");
  assert.throws(() => store.add("ws", "task", { what: "Message", message: "   " }), /Type a message/);

  await store.saved();
  const reopened = createChatQueueStore({ file });
  assert.deepEqual(reopened.list("ws", "task").map(item => item.message), ["refused for now", "run the tests\n\nand lint", "ship it"]);
  assert.deepEqual(reopened.list("ws", "task")[1].selection, { executionMode: "single", singleRoute: { model: "m" } });
  assert.deepEqual(Object.keys(reopened.forWorkspace("ws")), ["task"]);
  assert.deepEqual(reopened.forWorkspace("other"), {});
  assert.deepEqual(reopened.chats(), [{ workspaceId: "ws", taskId: "task" }]);
  assert.equal(reopened.remove("ws", "task", [first.id]), 1);
  assert.equal(reopened.remove("ws", "task", null), 2);
  await reopened.saved();
  assert.deepEqual(createChatQueueStore({ file }).chats(), [], "an emptied queue leaves nothing behind");
});

test("a torn queue file is read back from its copy (power cut, failing disk)", async (t) => {
  const file = tempFile(t);
  const store = createChatQueueStore({ file });
  store.add("ws", "task", { what: "Message", message: "keep going" });
  await store.saved();
  fs.writeFileSync(file, Buffer.alloc(64));
  const warnings = [];
  const reopened = createChatQueueStore({ file, logger: { warn: (event) => warnings.push(event) } });
  assert.deepEqual(reopened.list("ws", "task").map(item => item.message), ["keep going"]);
  assert.deepEqual(warnings, ["chat_queue.restored_from_copy"]);
});

test("steers handed to a turn are kept by run until that turn shows whether they were read", () => {
  const store = createChatQueueStore();
  const one = store.delivered("ws", "task", { message: "use pnpm", runId: "r1" });
  store.delivered("ws", "task", { message: "/goal green CI", runId: "r2", goal: "green CI" });
  assert.deepEqual(store.deliveredTo("ws", "r1").map(steer => [steer.taskId, steer.message]), [["task", "use pnpm"]]);
  store.forgetDelivered("ws", "task", [one.id]);
  assert.deepEqual(store.deliveredTo("ws", "r1"), []);
  assert.equal(store.deliveredTo("ws", "r2")[0].goal, "green CI");
});

test("a steer reads as read only once the model went on past it, as the chat's receipt says", () => {
  const steer = { kind: "steer", text: "use pnpm" };
  assert.equal(steerReadIn([{ kind: "message" }], "use pnpm"), null, "not in the turn at all");
  assert.equal(steerReadIn([{ kind: "reasoning" }, steer], "use pnpm"), false, "nothing after it: the agent never answered");
  assert.equal(steerReadIn([{ kind: "reasoning" }, steer, { kind: "message" }], "use pnpm"), false, "the reply it was already writing");
  assert.equal(steerReadIn([{ kind: "reasoning" }, steer, { kind: "command" }, { kind: "message" }], "use pnpm"), true, "the request after the next tool call has it");
  assert.equal(steerReadIn([{ kind: "command" }, steer, { kind: "reasoning" }], "use pnpm"), true, "it waited on a tool call: its next output read it");
});

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
const chat = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: chat });

test("the app resumes a chat after a restart exactly as the chat view would", () => {
  const now = 10 * RESTART_RESUME_WINDOW_MS;
  const restarted = "the agent's process ended before it finished (the app restarted)";
  const node = (state, extra = {}) => ({ state, receipt: { started_at_ms: now - 60_000, ...extra.receipt }, history: extra.history ?? [] });
  const cases = [
    { cancelled: false, nodes: [node("running")] },
    { cancelled: false, nodes: [node("pending", { receipt: { started_at_ms: 0 } })] },
    { cancelled: false, nodes: [node("held", { receipt: { error: restarted } })] },
    { cancelled: false, nodes: [node("failed", { receipt: { error: restarted }, history: Array(8).fill({}) })] },
    { cancelled: false, execution_mode: "single", nodes: [node("held", { receipt: { error: "API Error: 500" } })] },
    { cancelled: false, execution_mode: "single", nodes: [node("held", { receipt: { error: "HTTP 401 sign in again" } })] },
    { cancelled: false, nodes: [node("reserved")] },
    { cancelled: false, nodes: [node("running", { receipt: { started_at_ms: now - 2 * RESTART_RESUME_WINDOW_MS } })] },
    { cancelled: true, nodes: [node("running")] },
    { cancelled: false, paused: true, nodes: [node("pending")] },
    { cancelled: false, nodes: [node("finished")] },
  ];
  for (const [index, mission] of cases.entries()) {
    for (const autoRetry of [false, true]) {
      assert.equal(restartResume(mission, now, { autoRetry }), chat.restartResume(mission, now, { autoRetry }), `case ${index}, autoRetry ${autoRetry}`);
    }
  }
  assert.equal(restartResume(cases[0], now), "continue");
  assert.equal(restartResume(cases[2], now), "retry");
  assert.equal(restartResume(cases[4], now, { autoRetry: true }), "retry");
  assert.equal(restartResume(cases[5], now, { autoRetry: true }), null, "a sign-in failure waits for the person");
});

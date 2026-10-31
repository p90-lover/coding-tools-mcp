"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatArchiveStore, DEFAULT_ARCHIVE_DAYS, DEFAULT_IDLE_DAYS } = require("../electron/chat-archive.cjs");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const DAY = 86_400_000;

test("an archived chat counts its days from when it was archived (or first seen) and is due once they are up", () => {
  let now = 1_000_000;
  const store = createChatArchiveStore({ now: () => now });
  assert.equal(store.days(), DEFAULT_ARCHIVE_DAYS, "5 days unless set");
  store.archived("ws", "a");
  assert.equal(store.due("ws", "a"), false);
  // Archived before the app kept times: it gets its full days from the first time it is seen.
  now += 10 * DAY;
  assert.equal(store.due("ws", "older"), false, "first seen now, not due at once");
  assert.equal(store.due("ws", "a"), true);
  store.setDays(0);
  assert.equal(store.due("ws", "a"), false, "0 keeps archived chats for good");
  assert.throws(() => store.setDays(-1), /0 to 365/);
  assert.throws(() => store.setDays(1.5), /0 to 365/);
  store.forget("ws", "a");
  store.setDays(1);
  assert.equal(store.due("ws", "a"), false, "a restored chat starts again if archived later");
});

test("the archive times and the days setting survive a restart", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "chat-archive-"));
  const file = path.join(folder, "chat-archive.json");
  let now = 5_000;
  const first = createChatArchiveStore({ file, now: () => now });
  assert.equal(first.idleDays(), DEFAULT_IDLE_DAYS, "open chats are archived after 7 days unless set");
  first.setDays(2);
  first.setIdleDays(30);
  first.archived("ws", "t");
  now += 3 * DAY;
  const second = createChatArchiveStore({ file, now: () => now });
  assert.equal(second.days(), 2);
  assert.equal(second.idleDays(), 30);
  assert.equal(second.since("ws", "t"), 5_000);
  assert.equal(second.due("ws", "t"), true);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("listing archived chats moves those past their days to recoverable deletion; younger ones stay and say when they go", async () => {
  let now = 1_000_000;
  const runs = ["old", "young", "live"].map((task, index) => ({ id: `r${index}`, workspace_id: "ws", project_id: task, revision: 1, cancelled: false, nodes: [] }));
  const lives = {
    old: { workspace_id: "ws", task_id: "old", revision: 2, visibility: "archived", title: "Old chat" },
    young: { workspace_id: "ws", task_id: "young", revision: 1, visibility: "active", title: "Young chat" },
    live: { workspace_id: "ws", task_id: "live", revision: 1, visibility: "active", title: "Live chat" },
    board: { workspace_id: "ws", task_id: "board", revision: 1, visibility: "archived", title: "A board task, never a chat" },
  };
  const updates = [];
  const workflow = createAgentOrchestratorWorkflow({ now: () => now, requestHeadless: async (endpoint, body) => {
    if (endpoint === "/api/v1/ao/read") return { ok: true, runs: structuredClone(runs), task_lifecycle: Object.values(lives).map((life) => structuredClone(life)) };
    if (endpoint === "/api/v1/ao/update") {
      const change = body.change.change;
      updates.push([change.task_id, change.operation, change.visibility]);
      const life = lives[change.task_id];
      assert.equal(change.expected_revision, life.revision, "the deletion is for the state that was read");
      life.visibility = change.visibility;
      life.revision += 1;
      return { ok: true, lifecycle: structuredClone(life) };
    }
    throw new Error(`Unexpected ${endpoint}`);
  } });
  await workflow.call("archive_settings", { idleDays: 0 }); // only the deleted clock here
  let listed = await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  assert.equal(listed.days, 5);
  assert.deepEqual(listed.chats.map((chat) => [chat.taskId, chat.visibility, chat.title]), [["old", "archived", "Old chat"]], "only chats; the board task is left out");
  assert.equal(listed.chats[0].archivedAt, 1_000_000);
  now += 4 * DAY;
  lives.young.visibility = "archived";
  listed = await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  assert.equal(updates.length, 0, "four days in, nothing goes");
  now += 2 * DAY;
  listed = await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  assert.deepEqual(updates, [["old", "set_visibility", "deleted"]], "six days in, only the older chat moves to deleted");
  assert.deepEqual(listed.chats.map((chat) => [chat.taskId, chat.visibility]), [["old", "deleted"], ["young", "archived"]]);
  assert.equal((await workflow.call("archive_settings", { days: 0 })).days, 0);
  now += 100 * DAY;
  await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  assert.equal(updates.length, 1, "0 days keeps archived chats for good");
});

test("old AO sessions no chat still has leave the board on the archive's clock, at most hourly", async () => {
  let now = 50 * DAY;
  const card = (session, history = []) => ({ id: "n", role: "planner", state: "finished", receipt: { thread_id: session }, history: history.map((thread_id) => ({ thread_id })) });
  const runs = [
    { id: "r1", workspace_id: "ws", project_id: "kept", revision: 1, nodes: [card("chat-live", ["chat-live-earlier"])] },
    { id: "r2", workspace_id: "ws", project_id: "shelved", revision: 1, nodes: [card("chat-archived")] },
    { id: "r3", workspace_id: "ws", project_id: "gone", revision: 1, nodes: [card("chat-deleted")] },
  ];
  const lives = [
    { workspace_id: "ws", task_id: "kept", revision: 1, visibility: "active" },
    { workspace_id: "ws", task_id: "shelved", revision: 1, visibility: "archived" },
    { workspace_id: "ws", task_id: "gone", revision: 1, visibility: "deleted" },
  ];
  const asked = [], killed = [];
  const workflow = createAgentOrchestratorWorkflow({ now: () => now,
    requestHeadless: async (endpoint) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: structuredClone(runs), task_lifecycle: structuredClone(lives) };
      throw new Error(`Unexpected ${endpoint}`);
    },
    aoHarness: {
      staleSessions: async (workspaceIds, idleMs) => {
        asked.push([workspaceIds, idleMs]);
        return ["chat-live", "chat-live-earlier", "chat-archived", "chat-deleted", "old-worker", "old-subagent"];
      },
      kill: async (session) => { killed.push(session); return { ok: true }; },
    },
  });
  await workflow.call("archive_settings", { days: 7, idleDays: 0 });
  await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [[["ws"], 7 * DAY]], "unused for the archive's days");
  assert.deepEqual(killed, ["chat-deleted", "old-worker", "old-subagent"],
    "a chat in the list or in Archived keeps every session it had; a deleted chat's and unowned ones end");
  await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, "not again within the hour");
  now += 61 * 60_000;
  await workflow.call("archive_settings", { days: 0 });
  await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, "0 days keeps them for good");
});

test("open chats with no activity for the idle days are archived when the list is read; working, scheduled and recent ones stay", async () => {
  let now = 100 * DAY;
  const card = (state, startedAgo, finishedAgo) => ({ id: "n", role: "planner", state,
    receipt: { thread_id: "t", started_at_ms: now - startedAgo, ...(finishedAgo === undefined ? {} : { finished_at_ms: now - finishedAgo }) } });
  const runs = [
    { id: "r1", workspace_id: "ws", project_id: "stale", revision: 1, cancelled: false, execution_mode: "single", nodes: [card("finished", 11 * DAY, 10 * DAY)] },
    { id: "r2", workspace_id: "ws", project_id: "recent", revision: 1, cancelled: false, execution_mode: "single", nodes: [card("finished", 3 * DAY, 2 * DAY)] },
    { id: "r3", workspace_id: "ws", project_id: "working", revision: 1, cancelled: false, execution_mode: "single", nodes: [card("running", 10 * DAY)] },
    { id: "r4", workspace_id: "ws", project_id: "scheduled", revision: 1, cancelled: false, execution_mode: "single", nodes: [card("finished", 11 * DAY, 10 * DAY)] },
  ];
  const lives = {
    stale: { workspace_id: "ws", task_id: "stale", revision: 1, visibility: "active", title: "Stale chat" },
    recent: { workspace_id: "ws", task_id: "recent", revision: 1, visibility: "active", title: "Recent chat" },
    working: { workspace_id: "ws", task_id: "working", revision: 1, visibility: "active", title: "Working chat" },
    scheduled: { workspace_id: "ws", task_id: "scheduled", revision: 1, visibility: "active", title: "Scheduled chat",
      schedule: { id: "s", run_id: "r4", due_at_ms: now + DAY, state: "scheduled", revision: 1 } },
  };
  const updates = [];
  const workflow = createAgentOrchestratorWorkflow({ now: () => now, requestHeadless: async (endpoint, body) => {
    if (endpoint === "/api/v1/ao/read") return { ok: true, runs: structuredClone(runs), task_lifecycle: Object.values(lives).map((life) => structuredClone(life)) };
    if (endpoint === "/api/v1/ao/update") {
      const change = body.change.change;
      updates.push([change.task_id, change.visibility]);
      const life = lives[change.task_id];
      assert.equal(change.expected_revision, life.revision);
      life.visibility = change.visibility;
      life.revision += 1;
      return { ok: true, lifecycle: structuredClone(life) };
    }
    throw new Error(`Unexpected ${endpoint}`);
  } });
  await workflow.call("archive_settings", { idleDays: 0 });
  assert.equal((await workflow.call("archived_chats", { workspaceIds: ["ws"] })).idleDays, 0);
  assert.equal(updates.length, 0, "0 never archives an open chat");
  assert.equal((await workflow.call("archive_settings", { idleDays: 7 })).idleDays, 7);
  const listed = await workflow.call("archived_chats", { workspaceIds: ["ws"] });
  assert.deepEqual(updates, [["stale", "archived"]], "only the chat idle for over 7 days, not working, not scheduled");
  assert.deepEqual(listed.chats.map((chat) => [chat.taskId, chat.visibility, chat.title]), [["stale", "archived", "Stale chat"]]);
  assert.equal(listed.chats[0].archivedAt, now, "its archive days count from now");
});

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createGoalStore, goalVerdict } = require("../electron/chat-goals.cjs");

test("goal completion follows the marker, not words in its explanation", () => {
  assert.equal(goalVerdict(["GOAL: CONTINUE — login achieved; tests still need fixing"]), "continue");
  assert.equal(goalVerdict(["**GOAL: CONTINUE** — achieved the first milestone only"]), "continue");
  assert.equal(goalVerdict(["GOAL: ACHIEVED\nGOAL: CONTINUE — not achieved yet"]), "continue", "the last marker in an answer wins");
  assert.equal(goalVerdict(["GOAL: ACHIEVED — no need to continue"]), "achieved");
});

test("rejecting an invalid goal update leaves the goal and its timestamp untouched", () => {
  let now = 1000;
  const store = createGoalStore({ now: () => now });
  store.set("workspace", "task", "Original goal");
  const before = structuredClone(store.get("workspace", "task"));
  now = 2000;
  assert.throws(() => store.update("workspace", "task", { status: "invalid", objective: "Lost original" }), /Unknown goal status/);
  assert.deepEqual(store.get("workspace", "task"), before);
});

test("failed goal writes do not replace, modify or clear the in-memory goal", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "live");
  const file = path.join(directory, "goals.json");
  let now = 1000;
  const store = createGoalStore({ file, now: () => now });
  store.set("workspace", "task", "Original goal");
  const before = structuredClone(store.get("workspace", "task"));
  fs.renameSync(directory, path.join(root, "saved"));
  fs.writeFileSync(directory, "This file blocks the persistence directory.");
  now = 2000;
  assert.throws(() => store.set("workspace", "task", "Not persisted"));
  assert.deepEqual(store.get("workspace", "task"), before);
  assert.throws(() => store.update("workspace", "task", { objective: "Not persisted", status: "paused" }));
  assert.deepEqual(store.get("workspace", "task"), before);
  assert.throws(() => store.clear("workspace", "task"));
  assert.deepEqual(store.get("workspace", "task"), before);
  const disk = createGoalStore({ file: path.join(root, "saved", "goals.json") });
  assert.deepEqual(disk.get("workspace", "task"), before);
});

test("successful goal transactions remain durable and preserve existing update references", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-transaction-success-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "goals.json");
  const store = createGoalStore({ file });
  const goal = store.set("workspace", "task", "Original goal");
  assert.equal(store.update("workspace", "task", { status: "paused" }), goal);
  assert.equal(goal.status, "paused");
  assert.deepEqual(createGoalStore({ file }).get("workspace", "task"), goal);
  assert.equal(store.clear("workspace", "task"), true);
  assert.equal(createGoalStore({ file }).get("workspace", "task"), null);
  assert.equal(store.clear("workspace", "task"), false);
});

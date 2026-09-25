"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parsePlannerTasks,
  parseReviewerVerdict,
} = require("../electron/orchestration-output.cjs");

test("planner accepts exactly one bounded task for each caller-selected role", () => {
  assert.deepEqual(
    parsePlannerTasks(JSON.stringify({ tasks: [
      { role: "researcher", brief: "Find the relevant protocol contract." },
      { role: "implementer", brief: "Implement the approved parser boundary." },
    ] }), ["researcher", "implementer"]),
    { tasks: [
      { role: "researcher", brief: "Find the relevant protocol contract." },
      { role: "implementer", brief: "Implement the approved parser boundary." },
    ] },
  );
  assert.deepEqual(
    parsePlannerTasks('```json\n{"tasks":[{"role":"worker","brief":"Do the bounded task."}]}\n```', ["worker"]),
    { tasks: [{ role: "worker", brief: "Do the bounded task." }] },
  );
});

test("planner rejects missing, duplicate, unselected, or empty roles", () => {
  assert.throws(() => parsePlannerTasks('{"tasks":[]}', []), /selected role/i);
  assert.throws(
    () => parsePlannerTasks('{"tasks":[{"role":"one","brief":"A"}]}', ["one", "two"]),
    /exactly one task/i,
  );
  assert.throws(
    () => parsePlannerTasks('{"tasks":[{"role":"one","brief":"A"},{"role":"one","brief":"B"}]}', ["one", "two"]),
    /exactly one task/i,
  );
  assert.throws(
    () => parsePlannerTasks('{"tasks":[{"role":"router","brief":"Choose a route"}]}', ["worker"]),
    /selected role/i,
  );
});

test("planner rejects extra routing, workspace, provider, account, credential, and permission fields", () => {
  for (const extra of ["route", "workspace", "provider", "account", "credential", "permission"]) {
    assert.throws(
      () => parsePlannerTasks(JSON.stringify({
        tasks: [{ role: "worker", brief: "Do the task", [extra]: "model-choice" }],
      }), ["worker"]),
      /keys/i,
    );
  }
  assert.throws(
    () => parsePlannerTasks('{"tasks":[{"role":"worker","brief":"Do it"}],"workspace":"C:/elsewhere"}', ["worker"]),
    /keys/i,
  );
});

test("planner rejects prose, malformed fences, empty briefs, and oversized briefs", () => {
  assert.throws(
    () => parsePlannerTasks('Here you go: {"tasks":[{"role":"worker","brief":"Do it"}]}', ["worker"]),
    /JSON/i,
  );
  assert.throws(
    () => parsePlannerTasks('```json\n{"tasks":[{"role":"worker","brief":"Do it"}]}\n```\nDone', ["worker"]),
    /JSON/i,
  );
  assert.throws(
    () => parsePlannerTasks('{"tasks":[{"role":"worker","brief":"   "}]}', ["worker"]),
    /brief/i,
  );
  assert.throws(
    () => parsePlannerTasks(JSON.stringify({ tasks: [{ role: "worker", brief: "x".repeat(4_001) }] }), ["worker"]),
    /brief/i,
  );
});

test("reviewer accepts pass and needs_changes verdicts as raw or fenced JSON", () => {
  assert.deepEqual(
    parseReviewerVerdict('{"verdict":"pass","findings":[]}'),
    { verdict: "pass", findings: [] },
  );
  assert.deepEqual(
    parseReviewerVerdict('```json\n{"verdict":"needs_changes","findings":[{"title":"Missing guard","detail":"Reject empty input."}]}\n```'),
    {
      verdict: "needs_changes",
      findings: [{ title: "Missing guard", detail: "Reject empty input." }],
    },
  );
});

test("reviewer rejects empty, invalid, or unbounded verdict output", () => {
  assert.throws(() => parseReviewerVerdict(""), /required/i);
  assert.throws(() => parseReviewerVerdict('{"verdict":"approve","findings":[]}'), /verdict/i);
  assert.throws(() => parseReviewerVerdict('{"verdict":"needs_changes","findings":[]}'), /finding/i);
  assert.throws(
    () => parseReviewerVerdict('{"verdict":"pass","findings":[{"title":"Missing guard","detail":"Fix it"}]}'),
    /pass verdict cannot include findings/i,
  );
  assert.throws(
    () => parseReviewerVerdict('{"verdict":"pass","findings":[],"route":"gemini"}'),
    /keys/i,
  );
  assert.throws(
    () => parseReviewerVerdict('{"verdict":"needs_changes","findings":[{"title":"Issue","detail":"Fix it","permission":"admin"}]}'),
    /keys/i,
  );
  assert.throws(
    () => parseReviewerVerdict(JSON.stringify({
      verdict: "needs_changes",
      findings: [{ title: "x".repeat(201), detail: "Fix it" }],
    })),
    /title/i,
  );
});

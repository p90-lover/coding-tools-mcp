require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createModelScoreStore, gradePrompt, keywordCategories, parseGrade, pickerHints, scoreRound, scoredCards, summarize,
} = require("../electron/model-scores.cjs");

const route = (model) => ({ harness_id: "ao:claude-code", model });
// The request in the user's screenshot: a broad UI pass over two systems.
const REQUEST = "帮我继续优化两个系统的可视化和显示系统，你需要全面的查看UI尤其是线上的环境进行深度的优化包括更美观";
const mission = (overrides = {}) => ({
  id: "run-1", workspace_id: "ws", project_id: "task-1", execution_mode: "team",
  nodes: [
    { id: "p", role: "planner", state: "finished", route: route("cpa/glm-5"), settings: { name: "Orchestrator" }, receipt: { answer: "Plan: audit both UIs" } },
    { id: "w", role: "worker", state: "finished", route: route("cpa/kimi-k3"), settings: { name: "Frontend" },
      history: [{ status: "failed" }], receipt: { answer: "Restyled the dashboard; screenshots attached" } },
    { id: "r", role: "reviewer", state: "finished", route: route("cpa/glm-5"), parents: ["w"],
      history: [{ verdict: "CHANGES_REQUIRED" }], receipt: { verdict: "APPROVED", answer: "APPROVED" } },
    { id: "a", role: "approver", state: "finished", route: route("cpa/mini"), receipt: { answer: "allow" } },
    { id: "q", role: "worker", state: "failed", route: route("cpa/out-of-quota"), receipt: { error: "insufficient_quota" } },
  ],
  ...overrides,
});
const excluded = (error) => /insufficient_quota/.test(error);

test("only model cards that settled count, never the approver or a step that failed on quota", () => {
  assert.deepEqual(scoredCards(mission(), excluded).map((node) => node.id), ["p", "w", "r"]);
  assert.deepEqual(scoredCards(mission()).map((node) => node.id), ["p", "w", "r", "q"]);
});

test("a graded round scores each card on understanding, command follow, handling and the round's categories", () => {
  const prompt = gradePrompt(REQUEST, mission(), scoredCards(mission(), excluded));
  assert.match(prompt, /Card 2\. Frontend \[worker\] — finished/);
  assert.match(prompt, /两个系统/);
  const grade = parseGrade('Sure: {"categories": ["frontend", "made-up"], "cards": ['
    + '{"card": 1, "understanding": 9, "command_follow": 8, "quality": 7, "note": "Read the vague ask well"},'
    + '{"card": 2, "understanding": 7, "command_follow": 6, "quality": 8},'
    + '{"card": 9, "understanding": 1}]}', 3);
  assert.deepEqual(grade.categories, ["frontend"]);
  assert.equal(grade.cards.size, 2);
  const record = scoreRound({ mission: mission(), message: REQUEST, outcome: "finished", grade, grader: "cpa/haiku", at: "2026-10-30T09:00:00.000Z", excluded });
  assert.equal(record.grader, "cpa/haiku");
  assert.deepEqual(record.categories, ["frontend"]);
  const [planner, worker, reviewer] = record.cards;
  assert.deepEqual(planner.scores, { handling: 8.5, understanding: 9, command_follow: 8, frontend: 7.9 });
  assert.equal(planner.note, "Read the vague ask well");
  // The worker took a second attempt and was sent back once: 10 - 1.5 - 1 = 7.5 from the run.
  assert.equal(worker.attempts, 2);
  assert.deepEqual(worker.scores, { handling: 7.8, understanding: 7, command_follow: 6, frontend: 7.9 });
  // Not graded: its points come from how it ran alone, and no understanding or command follow is made up.
  assert.deepEqual(reviewer.scores, { handling: 8.5, frontend: 8.5 });
  assert.throws(() => parseGrade("no json here", 3), /no scores/);
  assert.throws(() => parseGrade('{"cards": []}', 3), /no scores/);
});

test("without a grade the categories come from keywords, and a failed card scores low on handling", () => {
  assert.deepEqual(keywordCategories(REQUEST, mission()), ["frontend"]);
  assert.deepEqual(keywordCategories("Add a REST endpoint and a SQLite table", mission()), ["backend"]);
  assert.deepEqual(keywordCategories("Fix the Gradle build of the Android app", mission()), ["android"]);
  assert.deepEqual(keywordCategories("Rename a file", mission({ nodes: mission().nodes.slice(0, 1) })), ["simple_process"]);
  const failed = mission({ nodes: [{ id: "w", role: "worker", state: "failed", route: route("cpa/x"), receipt: { error: "tests failed" } }] });
  const record = scoreRound({ mission: failed, message: "Fix the API server", outcome: "failed", at: "t", excluded });
  assert.deepEqual(record.cards[0].scores, { handling: 2, backend: 2 });
  assert.equal(scoreRound({ mission: mission({ nodes: [] }), message: "", outcome: "finished", at: "t" }), null);
});

test("the summary gives each model's average, recent, best and last per category, best recent first", () => {
  const round = (id, model, value, role = "worker") => ({ id, at: `2026-10-${id}`, cards: [{ role, model, scores: { handling: value, frontend: value } }] });
  const records = [round("01", "a", 4), round("02", "a", 6), round("03", "a", 10), round("04", "b", 7), round("05", "b", 7, "reviewer")];
  const [first, second] = summarize(records, { window: 2 });
  assert.equal(first.model, "a");
  assert.deepEqual(first.categories.frontend, { count: 3, average: 6.7, recent: 8, best: 10, last: 10 });
  assert.equal(first.missions, 3);
  assert.equal(second.model, "b");
  assert.equal(summarize(records, { role: "reviewer" }).length, 1);
  assert.deepEqual(pickerHints(summarize(records)), {
    a: { overall: 6.7, recent: 6.7, missions: 3, strengths: [] },
    b: { overall: 7, recent: 7, missions: 2, strengths: ["frontend"] },
  });
});

test("the score log is saved, replaces a round scored again, keeps its newest records and survives a torn file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-scores-test-"));
  const file = path.join(root, "model-scores.json");
  const store = createModelScoreStore({ file, limit: 2 });
  store.add({ id: "1", cards: [] });
  store.add({ id: "2", cards: [] });
  store.add({ id: "2", cards: [{ model: "again" }] });
  store.add({ id: "3", cards: [] });
  assert.deepEqual(store.records().map((record) => record.id), ["2", "3"]);
  await store.saved();
  assert.equal(createModelScoreStore({ file }).has("3"), true);
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));
  const warnings = [];
  const recovered = createModelScoreStore({ file, logger: { warn: (event, detail) => warnings.push({ event, detail }) } });
  assert.deepEqual(recovered.records().map((record) => record.id), ["2", "3"]);
  assert.equal(warnings[0].detail.source, "backup");
  recovered.clear();
  await recovered.saved();
  assert.deepEqual(createModelScoreStore({ file }).records(), []);
});

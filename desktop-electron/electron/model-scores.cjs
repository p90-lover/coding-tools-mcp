"use strict";

// Scores the models a Team mission ran on, so the model picker can say which model suits a role.
// Only real work counts: a Team round that settled by itself (finished or failed), never one the
// person stopped, a Single chat, or a step that failed on quota or a refused request (that says
// nothing about the model). Each scored round is one record in a saved log; summaries (average,
// recent, best per category) are computed from the log when asked.
//
// Each card (one model in one role) gets 0-10 points per category:
// - understanding, command_follow: from a grading model reading the request and the cards' answers;
// - handling: how the card's run went (finished, attempts, review rounds), blended with the grade;
// - simple_process, frontend, backend, android: the card's work quality, only in the categories
//   the round touched (named by the grader, or by keywords when there was no grade).

const { readStateFile, writeStateFile } = require("./durable-state.cjs");

const CATEGORIES = Object.freeze(["simple_process", "frontend", "backend", "android", "understanding", "handling", "command_follow"]);
const DOMAINS = Object.freeze(["simple_process", "frontend", "backend", "android"]);
const CATEGORY_LABELS = Object.freeze({
  simple_process: "Simple process", frontend: "Frontend", backend: "Backend", android: "Android app",
  understanding: "Understanding", handling: "Handling", command_follow: "Command follow",
});
const SCORED_ROLES = new Set(["planner", "worker", "reviewer", "sub_reviewer", "review_split"]);
const RECORD_LIMIT = 1000;
const RECENT_WINDOW = 5;
const MESSAGE_LIMIT = 4000;
const ANSWER_LIMIT = 2500;

const clamp = (value) => Math.max(0, Math.min(10, value));
const round1 = (value) => Math.round(value * 10) / 10;
const text = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

/** The cards of a round that count: a model did the work, and it did not fail for a reason outside the model (`excluded(error)`). */
function scoredCards(mission, excluded = () => false) {
  return (mission?.nodes ?? []).filter((node) => SCORED_ROLES.has(node.role)
    && typeof node.route?.model === "string" && node.route.model && node.route.model !== "default"
    && ["finished", "failed"].includes(node.state)
    && !(node.state === "failed" && excluded(String(node.receipt?.error ?? ""))));
}

function cardLabel(node, index) {
  return `${index + 1}. ${text(node.settings?.name || node.title || node.role, 60)} [${node.role}]`;
}

/** How a card's run went, 0-10: finished first time scores 10; every extra attempt and every review that sent the work back costs points; failing scores 2. */
function handlingSignal(node, changesRequired) {
  const attempts = 1 + (Array.isArray(node.history) ? node.history.length : 0);
  if (node.state === "failed") return { score: 2, attempts };
  const reworked = node.role === "worker" ? changesRequired : 0;
  return { score: clamp(10 - 1.5 * (attempts - 1) - 1 * reworked), attempts };
}

/** How many times a reviewer sent the round's work back. */
function changesRequired(mission) {
  let count = 0;
  for (const node of mission?.nodes ?? []) {
    if (!["reviewer", "sub_reviewer"].includes(node.role)) continue;
    for (const receipt of [...(node.history ?? []), node.receipt]) if (receipt?.verdict === "CHANGES_REQUIRED") count += 1;
  }
  return count;
}

const KEYWORDS = {
  android: /\b(android|kotlin|gradle|apk|aab|jetpack|compose|adb|logcat)\b|安卓/i,
  frontend: /\b(ui|ux|css|scss|html|react|vue|svelte|tsx|jsx|frontend|front-end|layout|style|design|page|component|renderer)\b|前端|界面|页面|样式|美观|可视化|显示/i,
  backend: /\b(api|server|backend|back-end|database|sql|sqlite|postgres|endpoint|daemon|golang|rust|grpc|queue|auth)\b|后端|服务器|数据库|接口/i,
};

/** The categories a round touched when no grade named them: keywords in the request and answers; a round with one card that matches none is a simple process. */
function keywordCategories(message, mission) {
  const haystack = `${message}\n${(mission?.nodes ?? []).map((node) => node.receipt?.answer ?? "").join("\n")}`;
  const found = Object.keys(KEYWORDS).filter((key) => KEYWORDS[key].test(haystack));
  const cards = scoredCards(mission).length;
  if (mission?.solo || (!found.length && cards <= 2)) found.unshift("simple_process");
  return DOMAINS.filter((domain) => found.includes(domain));
}

/** The grading model's instructions: the request, then each card's answer by number; JSON back. */
function gradePrompt(message, mission, cards) {
  const parts = cards.map((node, index) => {
    const answer = String(node.receipt?.answer ?? "").trim();
    const shown = answer.length > ANSWER_LIMIT ? `…${answer.slice(-ANSWER_LIMIT)}` : answer;
    return `Card ${cardLabel(node, index)} — ${node.state}${node.receipt?.error ? ` (error: ${text(node.receipt.error, 200)})` : ""}:\n${shown || "(no answer)"}`;
  });
  return [
    "You grade the AI agents of one finished team mission, judging only from the request and the cards' answers below.",
    "Score each card 0-10 on:",
    "- understanding: did it grasp what the user actually wanted, including vague or implied parts?",
    "- command_follow: did it follow the user's explicit instructions and constraints, without doing unasked things?",
    "- quality: how good and complete its own work is, with evidence (checks run, results shown), for its role.",
    "Also name which categories the mission's work belongs to, any of: simple_process (a small, straightforward task), frontend, backend, android.",
    "Be strict: claims without evidence, partial work and ignored instructions score low. A card that failed scores at most 3 on quality.",
    'Answer with JSON only: {"categories": ["frontend"], "cards": [{"card": 1, "understanding": 0, "command_follow": 0, "quality": 0, "note": "<one short sentence>"}]}',
    "",
    `User request:\n${String(message || "(no message)").trim().slice(0, MESSAGE_LIMIT)}`,
    "",
    ...parts,
  ].join("\n");
}

/** The grading model's answer as { categories, cards: Map(cardNumber -> grade) }; anything unreadable throws. */
function parseGrade(raw, cardCount) {
  const value = String(raw ?? "");
  const start = value.indexOf("{"), end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The grader gave no scores");
  const parsed = JSON.parse(value.slice(start, end + 1));
  const score = (number) => (Number.isFinite(Number(number)) ? clamp(Number(number)) : null);
  const cards = new Map();
  for (const card of Array.isArray(parsed?.cards) ? parsed.cards : []) {
    const number = Number(card?.card);
    if (!Number.isInteger(number) || number < 1 || number > cardCount) continue;
    cards.set(number, { understanding: score(card.understanding), command_follow: score(card.command_follow), quality: score(card.quality), note: text(card.note, 200) });
  }
  if (!cards.size) throw new Error("The grader gave no scores");
  const categories = DOMAINS.filter((domain) => Array.isArray(parsed?.categories) && parsed.categories.includes(domain));
  return { categories, cards };
}

/**
 * One scored round: `{ id, workspaceId, taskId, at, outcome, categories, grader, message, cards }`,
 * each card `{ role, title, model, harness, scores: { category: 0-10 }, attempts, note? }`. `grade`
 * is parseGrade's result, or null when no grader answered (scores then come from the run alone).
 */
function scoreRound({ mission, message, outcome, grade = null, grader = null, at, excluded }) {
  const cards = scoredCards(mission, excluded);
  if (!cards.length) return null;
  const sentBack = changesRequired(mission);
  const categories = grade?.categories?.length ? grade.categories : keywordCategories(message, mission);
  return {
    id: mission.id,
    workspaceId: mission.workspace_id ?? null,
    taskId: mission.project_id ?? null,
    at,
    outcome,
    categories,
    grader: grader ?? null,
    message: text(message, 200),
    cards: cards.map((node, index) => {
      const signal = handlingSignal(node, sentBack);
      const graded = grade?.cards.get(index + 1) ?? null;
      const quality = graded?.quality ?? null;
      const work = quality === null ? signal.score : 0.7 * quality + 0.3 * signal.score;
      const scores = { handling: round1(quality === null ? signal.score : 0.5 * signal.score + 0.5 * quality) };
      if (graded?.understanding !== null && graded?.understanding !== undefined) scores.understanding = round1(graded.understanding);
      if (graded?.command_follow !== null && graded?.command_follow !== undefined) scores.command_follow = round1(graded.command_follow);
      for (const category of categories) scores[category] = round1(work);
      return {
        role: node.role,
        title: text(node.settings?.name || node.title || node.role, 80),
        model: node.route.model,
        harness: node.route.harness_id ?? null,
        scores,
        attempts: signal.attempts,
        ...(graded?.note ? { note: graded.note } : {}),
      };
    }),
  };
}

const average = (values) => (values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

/**
 * Per model, from the log (oldest first): for each category its `average`, `recent` (average of the
 * last `window` scores), `best`, `last` and `count`; `overall` is the same over every score; `role`
 * keeps it to one role. Also its missions' record, as a benchmark keeps one: how many it took part
 * in, `finished` and `failed`, and `passRate` (finished share, 0-1). Sorted best first by recent overall.
 */
function summarize(records, { window = RECENT_WINDOW, role = null } = {}) {
  const byModel = new Map();
  for (const record of records) {
    for (const card of record.cards ?? []) {
      if (role && card.role !== role) continue;
      const entry = byModel.get(card.model) ?? { model: card.model, missions: new Set(), finished: new Set(), lastAt: null, scores: {}, all: [] };
      entry.missions.add(record.id);
      if (record.outcome === "finished") entry.finished.add(record.id);
      entry.lastAt = record.at;
      const values = Object.values(card.scores ?? {});
      if (values.length) entry.all.push(values.reduce((sum, value) => sum + value, 0) / values.length);
      for (const [category, value] of Object.entries(card.scores ?? {})) (entry.scores[category] ??= []).push(value);
      byModel.set(card.model, entry);
    }
  }
  const stats = (values) => ({
    count: values.length,
    average: average(values),
    recent: average(values.slice(-window)),
    best: values.length ? Math.max(...values) : null,
    last: values.length ? values.at(-1) : null,
  });
  return [...byModel.values()].map((entry) => ({
    model: entry.model,
    missions: entry.missions.size,
    finished: entry.finished.size,
    failed: entry.missions.size - entry.finished.size,
    passRate: Math.round((entry.finished.size / entry.missions.size) * 100) / 100,
    lastAt: entry.lastAt,
    overall: stats(entry.all),
    categories: Object.fromEntries(CATEGORIES.filter((category) => entry.scores[category]).map((category) => [category, stats(entry.scores[category])])),
  })).sort((a, b) => (b.overall.recent ?? 0) - (a.overall.recent ?? 0) || b.missions - a.missions);
}

/**
 * One model's missions, newest first (at most `limit`): each scored round it worked in, with the
 * request, how the mission ended and only that model's cards (in `role` when given), for the scores
 * page's per-model history.
 */
function modelHistory(records, model, { role = null, limit = 100 } = {}) {
  const missions = [];
  for (let index = records.length - 1; index >= 0 && missions.length < limit; index -= 1) {
    const record = records[index];
    const cards = (record.cards ?? []).filter((card) => card.model === model && (!role || card.role === role));
    if (!cards.length) continue;
    const values = cards.flatMap((card) => Object.values(card.scores ?? {}));
    missions.push({
      id: record.id, workspaceId: record.workspaceId ?? null, taskId: record.taskId ?? null, at: record.at, outcome: record.outcome,
      categories: record.categories ?? [], grader: record.grader ?? null, message: record.message ?? "",
      score: average(values), cards,
    });
  }
  return missions;
}

/** The model picker's hint per model: `{ overall, recent, missions, strengths }` (its best categories by average, at most 2). */
function pickerHints(summary) {
  return Object.fromEntries(summary.map((entry) => [entry.model, {
    overall: entry.overall.average,
    recent: entry.overall.recent,
    missions: entry.missions,
    strengths: Object.entries(entry.categories)
      .filter(([category, stats]) => DOMAINS.includes(category) && stats.average >= 7)
      .sort((a, b) => b[1].average - a[1].average).slice(0, 2).map(([category]) => category),
  }]));
}

/** The saved log of scored rounds (`file`, written as durable-state.cjs state; memory only without one). */
function createModelScoreStore({ file = null, limit = RECORD_LIMIT, logger = null } = {}) {
  let records = [];
  if (file) {
    const read = readStateFile(file, (raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.records)) throw new Error("Not a model score log");
      return parsed.records;
    });
    if (read.value) records = read.value;
    if (read.source === "backup" || read.source === "unreadable") logger?.warn?.("ao.model_scores_recovered", { source: read.source, setAside: read.setAside });
  }
  const persist = () => {
    if (file) writeStateFile(file, `${JSON.stringify({ version: 1, records })}\n`, { protectDirectory: false });
  };
  return {
    has: (id) => records.some((record) => record.id === id),
    add(record) {
      records = [...records.filter((entry) => entry.id !== record.id), record].slice(-limit);
      persist();
    },
    records: () => structuredClone(records),
    clear() {
      records = [];
      persist();
    },
  };
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  DOMAINS,
  RECENT_WINDOW,
  createModelScoreStore,
  gradePrompt,
  keywordCategories,
  modelHistory,
  parseGrade,
  pickerHints,
  scoreRound,
  scoredCards,
  summarize,
};

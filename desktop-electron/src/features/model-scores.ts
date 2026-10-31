// Points per model from finished Team rounds (electron/model-scores.cjs): the model picker's
// badges and the Model scores page read them.

export const SCORE_CATEGORIES = ["simple_process", "frontend", "backend", "android", "understanding", "handling", "command_follow"] as const;
export type ScoreCategory = typeof SCORE_CATEGORIES[number];
export const SCORE_CATEGORY_LABELS: Record<ScoreCategory, string> = {
  simple_process: "Simple process", frontend: "Frontend", backend: "Backend", android: "Android app",
  understanding: "Understanding", handling: "Handling", command_follow: "Command follow",
};

/** What the picker shows for one model: 0-10 averages, how many missions, and its best work categories. */
export type ModelScoreHint = { overall: number | null; recent: number | null; missions: number; strengths: ScoreCategory[] };

export type ScoreStats = { count: number; average: number | null; recent: number | null; best: number | null; last: number | null };
export type ModelScoreSummary = {
  model: string; missions: number; lastAt: string | null; overall: ScoreStats;
  categories: Partial<Record<ScoreCategory, ScoreStats>>;
  /** Its missions' record: finished and failed, and the finished share (0-1). Missing from older backends. */
  finished?: number; failed?: number; passRate?: number;
};
export type ScoredCard = {
  role: string; title: string; model: string; harness: string | null; attempts: number; note?: string;
  scores: Partial<Record<ScoreCategory, number>>;
};
export type ScoredRound = {
  id: string; workspaceId: string | null; taskId: string | null; at: string; outcome: "finished" | "failed";
  categories: ScoreCategory[]; grader: string | null; message: string; cards: ScoredCard[];
};
/** One mission a model worked in, for its history: the round, and only that model's cards; `score` averages them. */
export type ModelMission = Omit<ScoredRound, "cards"> & { score: number | null; cards: ScoredCard[] };
export type ModelScoresResult = { ok: true; summary: ModelScoreSummary[]; recent: ScoredRound[]; total: number; history?: ModelMission[] };

/** The fewest missions a model needs to rank: below it, one lucky round would top the board. */
export const RANK_MIN_MISSIONS = 3;
export type RankView = "average" | "recent" | "best";
export type RankedModel = ModelScoreSummary & { rank: number | null };

/**
 * The leaderboard, as a benchmark ranks: by the chosen view's overall score, then the finished
 * share, then how many missions back it. Models under RANK_MIN_MISSIONS come after the ranked ones,
 * unranked (rank null), as provisional.
 */
export function rankModels(summary: readonly ModelScoreSummary[], view: RankView): RankedModel[] {
  const score = (entry: ModelScoreSummary) => entry.overall[view] ?? -1;
  const order = (a: ModelScoreSummary, b: ModelScoreSummary) =>
    score(b) - score(a) || (b.passRate ?? 0) - (a.passRate ?? 0) || b.missions - a.missions || a.model.localeCompare(b.model);
  const ranked = summary.filter((entry) => entry.missions >= RANK_MIN_MISSIONS).sort(order);
  const provisional = summary.filter((entry) => entry.missions < RANK_MIN_MISSIONS).sort(order);
  return [...ranked.map((entry, index) => ({ ...entry, rank: index + 1 })), ...provisional.map((entry) => ({ ...entry, rank: null }))];
}

/** "80% (4/5)", or "–" when the backend did not say. */
export const passText = (entry: Pick<ModelScoreSummary, "passRate" | "finished" | "missions">) =>
  typeof entry.passRate === "number" ? `${Math.round(entry.passRate * 100)}% (${entry.finished ?? 0}/${entry.missions})` : "–";

export const scoreText = (value: number | null | undefined) => (typeof value === "number" ? value.toFixed(1) : "–");

/** The picker row's suffix, e.g. "★ 8.2 · 12 missions"; empty for a model never scored. */
export function scoreBadge(hint: ModelScoreHint | undefined): string {
  if (!hint || hint.overall === null) return "";
  return `★ ${scoreText(hint.recent ?? hint.overall)} · ${hint.missions} mission${hint.missions === 1 ? "" : "s"}`;
}

/** The listed models with scores, best recent first, at most `limit`. */
export function bestScored(models: string[], scores: Record<string, ModelScoreHint> | undefined, limit = 3): { model: string; hint: ModelScoreHint }[] {
  if (!scores) return [];
  return models.flatMap(model => (scores[model]?.overall !== null && scores[model] ? [{ model, hint: scores[model] }] : []))
    .sort((a, b) => (b.hint.recent ?? b.hint.overall ?? 0) - (a.hint.recent ?? a.hint.overall ?? 0) || b.hint.missions - a.hint.missions)
    .slice(0, limit);
}

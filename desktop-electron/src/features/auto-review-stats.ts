// Settings › Chat › Local auto-review: the plugin's get_stats (auto-review-plugin, its README) as the
// panel shows it. Kept apart from the panel so it reads the same in a test.

type StatsWindow = { total?: number; autoRate?: number; wrongRate?: number; reachedUser?: number };
type Trend = { direction?: string; deltaPoints?: number; last7AutoRate?: number; prev7AutoRate?: number };
type TopCommand = { pattern?: string; count?: number; example?: string };
export type AutoReviewStats = {
  enabled?: boolean;
  commands?: { today?: StatsWindow; last7Days?: StatsWindow; allTime?: StatsWindow };
  trend?: Trend;
  topReachingUser?: TopCommand[];
};
export type AutoReviewSummary = {
  enabled: boolean;
  windows: { label: string; total: number; auto: string; wrong: string; reachedUser: number }[];
  trend: string;
  top: { pattern: string; count: number; example: string }[];
};

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** A share as the panel shows it: one decimal at most, "80%" rather than "80.0%". */
const percent = (value: unknown) => `${Number(number(value).toFixed(1))}%`;

export function summarizeAutoReview(raw: unknown): AutoReviewSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const stats = raw as AutoReviewStats;
  const commands = stats.commands ?? {};
  const windows = ([["Today", commands.today], ["7 days", commands.last7Days], ["All time", commands.allTime]] as const)
    .map(([label, window]) => ({ label, total: number(window?.total), auto: percent(window?.autoRate), wrong: percent(window?.wrongRate),
      reachedUser: number(window?.reachedUser) }));
  const trend = stats.trend ?? {};
  const delta = Math.abs(number(trend.deltaPoints));
  const text = trend.direction === "up" || trend.direction === "down"
    ? `${trend.direction === "up" ? "Up" : "Down"} ${Number(delta.toFixed(1))} points on the 7 days before (${percent(trend.prev7AutoRate)} to ${percent(trend.last7AutoRate)} settled by itself)`
    : "No change on the 7 days before";
  const top = (Array.isArray(stats.topReachingUser) ? stats.topReachingUser : []).slice(0, 5)
    .map((entry) => ({ pattern: String(entry?.pattern ?? ""), count: number(entry?.count), example: String(entry?.example ?? "") }));
  return { enabled: stats.enabled !== false, windows, trend: text, top };
}

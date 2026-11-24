import { useEffect, useState } from "react";
import { summarizeAutoReview } from "./auto-review-stats";

/**
 * Settings › Chat › Local auto-review: how much the plugin settles by itself and how often it was
 * wrong, today, over 7 days and all time, its trend, and the commands that still reach you. `initial`
 * is what chat_auto_review read when the page opened; after that main pushes the plugin's stats as
 * they change (its stats event), so nothing here polls.
 */
export function AutoReviewStatsPanel({ initial, available }: { initial: unknown; available: boolean }) {
  const [stats, setStats] = useState<unknown>(initial);
  useEffect(() => setStats(initial), [initial]);
  useEffect(() => window.codexWebLauncher?.onAutoReviewStats?.((next) => setStats(next)) ?? (() => {}), []);
  if (!available) return <div className="cxs-row-description">The auto-review plugin is not installed, so Approve for me works as before.</div>;
  const summary = summarizeAutoReview(stats);
  if (!summary) return <div className="cxs-row-description">No decisions yet.</div>;
  return <div className="cxs-auto-review-stats">
    {summary.enabled ? null : <div className="cxs-row-description">The plugin's own switch is off, so it hands every request on.</div>}
    <table className="cxs-auto-review-table">
      <thead><tr><th scope="col" /><th scope="col">Commands</th><th scope="col">Settled by itself</th><th scope="col">Wrong</th><th scope="col">Reached you</th></tr></thead>
      <tbody>{summary.windows.map((row) => <tr key={row.label}>
        <th scope="row">{row.label}</th><td>{row.total}</td><td>{row.auto}</td><td>{row.wrong}</td><td>{row.reachedUser}</td>
      </tr>)}</tbody>
    </table>
    <div className="cxs-row-description">{summary.trend}</div>
    {summary.top.length ? <>
      <div className="cxs-row-label">Still reaching you</div>
      <ol className="cxs-auto-review-top">{summary.top.map((entry) => <li key={entry.pattern} title={entry.example}>
        <code>{entry.pattern}</code> <span className="cxs-unit">×{entry.count}</span>
      </li>)}</ol>
    </> : null}
  </div>;
}

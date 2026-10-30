import { useCallback, useEffect, useState } from "react";
import { moduleCall } from "./AgentOrchestratorSurface";
import { modelLabel } from "./AgentOrchestratorRoleEditor";
import { SCORE_CATEGORIES, SCORE_CATEGORY_LABELS, scoreText, type ModelScoresResult, type ScoreCategory, type ScoreStats } from "./model-scores";

type View = "average" | "recent" | "best" | "log";
const VIEWS: { id: View; label: string; title: string }[] = [
  { id: "average", label: "Average", title: "Average of every scored mission" },
  { id: "recent", label: "Recent", title: "Average of each model's last 5 scores" },
  { id: "best", label: "Best", title: "Each model's best score" },
  { id: "log", label: "Log", title: "The latest scored missions" },
];
const ROLES = [["", "All roles"], ["planner", "Orchestrator"], ["worker", "Worker"], ["reviewer", "Reviewer"], ["sub_reviewer", "Sub-reviewer"]] as const;

const statOf = (stats: ScoreStats | undefined, view: Exclude<View, "log">) => (stats ? stats[view] : null);
/** A score's tone for its cell: good from 8, weak below 5. */
const tone = (value: number | null) => (value === null ? "none" : value >= 8 ? "good" : value < 5 ? "weak" : "fair");

/**
 * The Model scores page: each model's points from finished Team rounds (electron/model-scores.cjs)
 * by category, as an average, the recent average or the best, per role; and the log of scored
 * missions. Only real Team rounds that ended by themselves are scored.
 */
export function ModelScoresPanel({ setError }: { setError: (error: string | null) => void }) {
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem("coding-tools:ao:score-view") as View) || "average"; } catch { return "average"; }
  });
  const [role, setRole] = useState("");
  const [data, setData] = useState<ModelScoresResult | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    void moduleCall("model_scores", { role, limit: 50 })
      .then(result => setData(result as ModelScoresResult))
      .catch(cause => setError(String(cause instanceof Error ? cause.message : cause)))
      .finally(() => setLoading(false));
  }, [role, setError]);
  useEffect(load, [load]);
  const choose = (next: View) => {
    setView(next);
    try { localStorage.setItem("coding-tools:ao:score-view", next); } catch { /* remembered for this session only */ }
  };
  const clear = async () => {
    if (!window.confirm("Delete every saved model score?\n\nThe model picker's hints start again from the next finished Team mission.")) return;
    try { await moduleCall("model_scores_clear", {}); load(); } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
  };
  const summary = data?.summary ?? [];
  const columns = SCORE_CATEGORIES.filter(category => summary.some(entry => entry.categories[category]));

  return <div className="ao-scores" aria-label="Model scores">
    <div className="ao-scores-bar">
      <div className="ao-segmented" role="tablist" aria-label="Score view">
        {VIEWS.map(entry => <button key={entry.id} type="button" role="tab" aria-selected={view === entry.id} title={entry.title}
          onClick={() => choose(entry.id)}>{entry.label}</button>)}
      </div>
      {view !== "log" ? <label>Role<select aria-label="Score role" value={role} onChange={event => setRole(event.target.value)}>
        {ROLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label> : null}
      <button type="button" className="button-secondary" disabled={loading} onClick={load}>Refresh</button>
      <button type="button" className="button-secondary" disabled={loading || !data?.total} onClick={() => void clear()}>Clear scores</button>
      <span className="ao-hint">{data ? `${data.total} scored mission${data.total === 1 ? "" : "s"} · only finished Team missions count` : ""}</span>
    </div>
    {loading && !data ? <div className="ao-empty-state"><p>Loading scores…</p></div>
      : !data?.total ? <div className="ao-empty-state"><p>No scores yet.</p>
        <p className="ao-hint">Each Team mission that finishes on its own scores the models it ran on: simple process, frontend, backend, Android app, understanding, handling and command follow.</p></div>
      : view === "log" ? <ol className="ao-scores-log">
        {data.recent.map(round => <li key={round.id}>
          <div className="ao-scores-log-head">
            <time dateTime={round.at}>{new Date(round.at).toLocaleString()}</time>
            <span className={`ao-score-outcome ao-score-${round.outcome}`}>{round.outcome === "finished" ? "Finished" : "Failed"}</span>
            <span className="ao-hint">{round.categories.map(category => SCORE_CATEGORY_LABELS[category]).join(" · ") || "No category"}
              {round.grader ? ` · graded by ${modelLabel(round.grader)}` : " · not graded (run signals only)"}</span>
          </div>
          {round.message ? <p className="ao-scores-request">{round.message}</p> : null}
          <table className="ao-scores-table"><tbody>
            {round.cards.map((card, index) => <tr key={`${card.model}:${index}`}>
              <th scope="row" title={card.note || undefined}>{card.title}<small>{modelLabel(card.model)}</small></th>
              {(Object.entries(card.scores) as [ScoreCategory, number][]).map(([category, value]) =>
                <td key={category} className={`ao-score-${tone(value)}`} title={SCORE_CATEGORY_LABELS[category]}>
                  <small>{SCORE_CATEGORY_LABELS[category]}</small>{scoreText(value)}</td>)}
            </tr>)}
          </tbody></table>
        </li>)}
      </ol>
      : !summary.length ? <div className="ao-empty-state"><p>No scores for this role yet.</p></div>
      : <div className="ao-scores-scroll"><table className="ao-scores-table ao-scores-grid">
        <thead><tr><th scope="col">Model</th><th scope="col">Overall</th>
          {columns.map(category => <th key={category} scope="col">{SCORE_CATEGORY_LABELS[category]}</th>)}</tr></thead>
        <tbody>{summary.map(entry => <tr key={entry.model}>
          <th scope="row">{modelLabel(entry.model)}<small>{entry.missions} mission{entry.missions === 1 ? "" : "s"}
            {entry.lastAt ? ` · last ${new Date(entry.lastAt).toLocaleDateString()}` : ""}</small></th>
          <td className={`ao-score-${tone(statOf(entry.overall, view))}`}><strong>{scoreText(statOf(entry.overall, view))}</strong></td>
          {columns.map(category => {
            const stats = entry.categories[category];
            const value = statOf(stats, view);
            return <td key={category} className={`ao-score-${tone(value)}`}
              title={stats ? `Average ${scoreText(stats.average)} · recent ${scoreText(stats.recent)} · best ${scoreText(stats.best)} · last ${scoreText(stats.last)} · ${stats.count} score${stats.count === 1 ? "" : "s"}` : "Not scored"}>
              {scoreText(value)}{stats ? <small>×{stats.count}</small> : null}</td>;
          })}
        </tr>)}</tbody>
      </table></div>}
  </div>;
}

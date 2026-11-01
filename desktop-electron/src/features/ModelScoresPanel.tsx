import { useCallback, useEffect, useState } from "react";
import { moduleCall } from "./AgentOrchestratorSurface";
import { modelLabel } from "./AgentOrchestratorRoleEditor";
import {
  RANK_MIN_MISSIONS, SCORE_CATEGORIES, SCORE_CATEGORY_LABELS, passText, rankModels, scoreText,
  type ModelMission, type ModelScoresResult, type RankView, type ScoreCategory, type ScoreStats, type ScoredCard,
} from "./model-scores";

type View = RankView | "log";
const VIEWS: { id: View; label: string; title: string }[] = [
  { id: "average", label: "Average", title: "Ranked by the average of every scored mission" },
  { id: "recent", label: "Recent", title: "Ranked by the average of each model's last 5 scores" },
  { id: "best", label: "Best", title: "Ranked by each model's best score" },
  { id: "log", label: "Log", title: "The latest scored missions" },
];
const ROLES = [["", "All roles"], ["planner", "Orchestrator"], ["worker", "Worker"], ["reviewer", "Reviewer"], ["sub_reviewer", "Sub-reviewer"]] as const;

const statOf = (stats: ScoreStats | undefined, view: RankView) => (stats ? stats[view] : null);
/** A score's tone for its cell: good from 8, weak below 5. */
const tone = (value: number | null) => (value === null ? "none" : value >= 8 ? "good" : value < 5 ? "weak" : "fair");
const outcome = (value: "finished" | "failed") => <span className={`ao-score-outcome ao-score-${value}`}>{value === "finished" ? "Finished" : "Failed"}</span>;

/** A scored card's points in a row: one cell per category it was scored in. */
function CardScores({ card }: { card: ScoredCard }) {
  return <>{(Object.entries(card.scores) as [ScoreCategory, number][]).map(([category, value]) =>
    <td key={category} className={`ao-score-${tone(value)}`} title={SCORE_CATEGORY_LABELS[category]}>
      <small>{SCORE_CATEGORY_LABELS[category]}</small>{scoreText(value)}</td>)}</>;
}

/**
 * The Model scores page, a benchmark's leaderboard of the models from finished Team rounds
 * (electron/model-scores.cjs): ranked by the chosen view (average, recent or best overall), with
 * each model's finished share and its scores by category, per role; a model's row opens the
 * missions it worked in. The log lists the scored missions. Only real Team rounds that ended by
 * themselves are scored.
 */
export function ModelScoresPanel({ setError }: { setError: (error: string | null) => void }) {
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem("coding-tools:ao:score-view") as View) || "average"; } catch { return "average"; }
  });
  const [role, setRole] = useState("");
  const [data, setData] = useState<ModelScoresResult | null>(null);
  const [loading, setLoading] = useState(true);
  // The model whose missions are open, and its history once read.
  const [opened, setOpened] = useState<string | null>(null);
  const [history, setHistory] = useState<ModelMission[] | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    void moduleCall("model_scores", { role, limit: 50, ...(opened ? { model: opened } : {}) })
      .then(result => { setData(result as ModelScoresResult); setHistory((result as ModelScoresResult).history ?? null); })
      .catch(cause => setError(String(cause instanceof Error ? cause.message : cause)))
      .finally(() => setLoading(false));
  }, [role, opened, setError]);
  useEffect(load, [load]);
  const choose = (next: View) => {
    setView(next);
    setOpened(null);
    try { localStorage.setItem("coding-tools:ao:score-view", next); } catch { /* remembered for this session only */ }
  };
  const clear = async () => {
    if (!window.confirm("Delete every saved model score?\n\nThe model picker's hints start again from the next finished Team mission.")) return;
    try { await moduleCall("model_scores_clear", {}); setOpened(null); load(); } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
  };
  const rankView: RankView = view === "log" ? "average" : view;
  const board = rankModels(data?.summary ?? [], rankView);
  const columns = SCORE_CATEGORIES.filter(category => board.some(entry => entry.categories[category]));
  const openEntry = opened ? board.find(entry => entry.model === opened) : undefined;

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
            {outcome(round.outcome)}
            <span className="ao-hint">{round.categories.map(category => SCORE_CATEGORY_LABELS[category]).join(" · ") || "No category"}
              {round.grader ? ` · graded by ${modelLabel(round.grader)}` : " · not graded (run signals only)"}</span>
          </div>
          {round.message ? <p className="ao-scores-request">{round.message}</p> : null}
          <table className="ao-scores-table"><tbody>
            {round.cards.map((card, index) => <tr key={`${card.model}:${index}`}>
              <th scope="row" title={card.note || undefined}>{card.title}<small>{modelLabel(card.model)}</small></th>
              <CardScores card={card} />
            </tr>)}
          </tbody></table>
        </li>)}
      </ol>
      : opened ? <div className="ao-scores-model" aria-label={`${modelLabel(opened)} missions`}>
        <div className="ao-scores-model-head">
          <button type="button" className="button-secondary" onClick={() => setOpened(null)}>‹ Leaderboard</button>
          <strong>{modelLabel(opened)}</strong>
          {openEntry ? <span className="ao-hint">{openEntry.rank ? `#${openEntry.rank}` : "Provisional"}
            {` · ${scoreText(openEntry.overall[rankView])} ${rankView} · finished ${passText(openEntry)}`}</span> : null}
        </div>
        {loading && !history ? <div className="ao-empty-state"><p>Loading missions…</p></div>
          : !history?.length ? <div className="ao-empty-state"><p>No missions for this model{role ? " in this role" : ""}.</p></div>
          : <ol className="ao-scores-log">
            {history.map(mission => <li key={mission.id}>
              <div className="ao-scores-log-head">
                <time dateTime={mission.at}>{new Date(mission.at).toLocaleString()}</time>
                {outcome(mission.outcome)}
                <span className={`ao-score-pill ao-score-${tone(mission.score)}`} title="This model's average in the mission">{scoreText(mission.score)}</span>
                <span className="ao-hint">{mission.categories.map(category => SCORE_CATEGORY_LABELS[category]).join(" · ") || "No category"}</span>
              </div>
              {mission.message ? <p className="ao-scores-request">{mission.message}</p> : null}
              <table className="ao-scores-table"><tbody>
                {mission.cards.map((card, index) => <tr key={`${card.role}:${index}`}>
                  <th scope="row" title={card.note || undefined}>{card.title}<small>{card.role}{card.attempts > 1 ? ` · ${card.attempts} attempts` : ""}</small></th>
                  <CardScores card={card} />
                </tr>)}
              </tbody></table>
              {mission.cards.some(card => card.note) ? <p className="ao-hint">{mission.cards.map(card => card.note).filter(Boolean).join(" ")}</p> : null}
            </li>)}
          </ol>}
      </div>
      : !board.length ? <div className="ao-empty-state"><p>No scores for this role yet.</p></div>
      : <div className="ao-scores-scroll"><table className="ao-scores-table ao-scores-grid">
        <thead><tr><th scope="col" className="ao-score-rank-head" title={`Ranked with at least ${RANK_MIN_MISSIONS} missions`}>#</th>
          <th scope="col">Model</th><th scope="col">Overall</th><th scope="col" title="Missions that finished, of those it worked in">Finished</th>
          {columns.map(category => <th key={category} scope="col">{SCORE_CATEGORY_LABELS[category]}</th>)}</tr></thead>
        <tbody>{board.map(entry => <tr key={entry.model} className="ao-score-row" tabIndex={0} title="Show its missions"
          onClick={() => setOpened(entry.model)} onKeyDown={event => { if (event.key === "Enter") setOpened(entry.model); }}>
          <td className={`ao-score-rank${entry.rank !== null && entry.rank <= 3 ? ` is-top is-top-${entry.rank}` : ""}`}>
            {entry.rank ?? <small title={`Ranked from ${RANK_MIN_MISSIONS} missions`}>new</small>}</td>
          <th scope="row">{modelLabel(entry.model)}<small>{entry.missions} mission{entry.missions === 1 ? "" : "s"}
            {entry.rank === null ? " · provisional" : ""}{entry.lastAt ? ` · last ${new Date(entry.lastAt).toLocaleDateString()}` : ""}</small></th>
          <td className={`ao-score-${tone(statOf(entry.overall, rankView))}`}><strong>{scoreText(statOf(entry.overall, rankView))}</strong></td>
          <td>{passText(entry)}</td>
          {columns.map(category => {
            const stats = entry.categories[category];
            const value = statOf(stats, rankView);
            return <td key={category} className={`ao-score-${tone(value)}`}
              title={stats ? `Average ${scoreText(stats.average)} · recent ${scoreText(stats.recent)} · best ${scoreText(stats.best)} · last ${scoreText(stats.last)} · ${stats.count} score${stats.count === 1 ? "" : "s"}` : "Not scored"}>
              {scoreText(value)}{stats ? <small>×{stats.count}</small> : null}</td>;
          })}
        </tr>)}</tbody>
      </table></div>}
  </div>;
}

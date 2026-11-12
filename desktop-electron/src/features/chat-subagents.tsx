import { useState } from "react";
import type { ReactNode } from "react";
import { prettyModelName } from "./AgentOrchestratorRoleEditor";
import { subagentActive, type ChatSubagent } from "./ao-chat";

/*
 * The side panel's Subagents tab, laid out as Codex's (OpenAI.Codex 26.1016, subagent-panel and
 * local-conversation-subagents-panel-tab): an "Active · N" and a "Done · N" section, each row an
 * avatar, the subagent's job, what it works on and, on the right, how long it has run or how long ago
 * it finished; a subagent's own page is headed by its avatar, its job and "model · effort".
 * The avatars are this app's own drawings in Codex's manner (petals of tinted light), not its files.
 */

/** Codex's own words for a reasoning effort ("xhigh" is "Extra High"). */
const EFFORT_WORDS: Record<string, string> = {
  none: "None", minimal: "Minimal", low: "Light", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra",
};
export const effortWord = (effort?: string | null) => (effort ? EFFORT_WORDS[effort] ?? effort[0].toUpperCase() + effort.slice(1) : "");

/** "GPT-6.1 Sol · Extra High": the model by its product name, then the effort it ran at (either may be missing). */
export function subagentModelLine(run: Pick<ChatSubagent, "model" | "effort">): string {
  const model = run.model ? prettyModelName(run.model.slice(run.model.lastIndexOf("/") + 1)) : "";
  return [model, effortWord(run.effort)].filter(Boolean).join(" · ");
}

/** A subagent's job, as Codex names one: its task's first line, at most 60 characters, else its kind. */
export function subagentJob(run: Pick<ChatSubagent, "name" | "task">): string {
  const line = run.task.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  if (!line) return run.name;
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

/** 42 -> "42s", 300 -> "5m", 5400 -> "1h 30m": how long an active subagent has worked. */
export function workedFor(total: number): string {
  const value = Math.max(0, Math.round(total));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h${value % 3600 >= 60 ? ` ${Math.floor((value % 3600) / 60)}m` : ""}`;
}

/** "now", "5m ago", "3h ago", "2d ago": when a finished subagent ended. */
export function endedAgo(endedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - endedAt) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// Seven tints (a light and a deep stop) and four petal arrangements: 28 avatars, picked as Codex picks
// its (n = n * 31 + char, over the subagent's id), so one subagent keeps its avatar everywhere.
const TINTS: readonly [string, string][] = [
  ["#ffd29e", "#ff8f3f"], ["#ffc2e2", "#e8559f"], ["#bfe0ff", "#3f8cf0"], ["#ffc0b8", "#f0524a"],
  ["#c8f5c4", "#35b85a"], ["#ffeaa0", "#f2a91f"], ["#ddd0ff", "#8a63f0"],
];
const PETALS: readonly { count: number; reach: number; size: number }[] = [
  { count: 4, reach: 3.1, size: 3.9 }, { count: 5, reach: 3.4, size: 3.3 }, { count: 6, reach: 3.6, size: 2.9 }, { count: 8, reach: 4.4, size: 2.3 },
];

/** Which of the 28 avatars a seed gets. */
export function avatarIndex(seed: string): number {
  let n = 0;
  for (let index = 0; index < seed.length; index += 1) n = (n * 31 + seed.charCodeAt(index)) % 2147483647;
  return n % (TINTS.length * PETALS.length);
}

/** A subagent's avatar: tinted petals around a centre, 16 units square, drawn at `size` px. */
export function SubagentAvatar({ seed, size = 24, className }: { seed: string; size?: number; className?: string }) {
  const index = avatarIndex(seed);
  const [light, deep] = TINTS[index % TINTS.length];
  const shape = PETALS[Math.floor(index / TINTS.length)];
  const id = `sa-${index}`;
  return <svg className={`cx-sa-avatar${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={light} /><stop offset="1" stopColor={deep} /></linearGradient></defs>
    {Array.from({ length: shape.count }, (_, petal) => {
      const angle = (petal / shape.count) * Math.PI * 2 - Math.PI / 2;
      const cx = 8 + Math.cos(angle) * shape.reach, cy = 8 + Math.sin(angle) * shape.reach;
      return <circle key={petal} cx={cx.toFixed(2)} cy={cy.toFixed(2)} r={shape.size} fill={`url(#${id})`}
        opacity={petal % 2 ? 0.55 : 0.85} stroke="#fff" strokeOpacity="0.9" strokeWidth="0.5" />;
    })}
  </svg>;
}

/** The right side of a row: how long an active subagent has worked, or how long ago it finished. */
function rowTrailing(run: ChatSubagent, now: number): string {
  if (subagentActive(run)) return workedFor(run.elapsed_seconds);
  const ended = run.ended_at ?? (run.started_at !== undefined ? run.started_at + run.elapsed_seconds * 1000 : undefined);
  return ended === undefined ? "" : endedAgo(ended, now);
}

function SubagentRow({ run, now, onSelect }: { run: ChatSubagent; now: number; onSelect: (id: string) => void }) {
  const active = subagentActive(run);
  // Codex previews what an active subagent works on; a finished one is its job and when it ended.
  const preview = active ? (run.stopping ? "Stopping" : run.name || "Working") : null;
  return <li>
    <button type="button" className={`cx-sa-row${preview ? " has-preview" : ""} is-${run.state}`} title={run.task} onClick={() => onSelect(run.subagent_id)}>
      <SubagentAvatar seed={run.subagent_id} />
      <span className="cx-sa-row-text">
        <span className="cx-sa-row-line"><span className="cx-sa-row-label">{subagentJob(run)}</span>
          <span className="cx-sa-row-trailing">{rowTrailing(run, now)}</span></span>
        {preview ? <span className="cx-sa-row-preview">{preview}</span> : null}
      </span>
    </button>
  </li>;
}

/** One of the list's two sections; past `limit` rows, "Show N more" reveals the rest, as in Codex. */
function SubagentSection({ title, runs, empty, limit, now, onSelect, className }: {
  title: string; runs: ChatSubagent[]; empty?: string; limit: number; now: number; onSelect: (id: string) => void; className?: string;
}) {
  const [all, setAll] = useState(false);
  if (!runs.length && !empty) return null;
  const shown = all ? runs : runs.slice(0, limit);
  return <section className={`cx-sa-section${className ? ` ${className}` : ""}`}>
    <h2 className="cx-sa-section-title"><span>{title}</span></h2>
    {!runs.length ? <p className="cx-sa-empty">{empty}</p> : <ul className="cx-sa-list">
      {shown.map((run) => <SubagentRow key={run.subagent_id} run={run} now={now} onSelect={onSelect} />)}
    </ul>}
    {runs.length > shown.length ? <button type="button" className="cx-sa-more" onClick={() => setAll(true)}>Show {runs.length - shown.length} more</button>
      : all && runs.length > limit ? <button type="button" className="cx-sa-more" onClick={() => setAll(false)}>Show less</button> : null}
  </section>;
}

/** The Subagents tab's list: "Active · N" (up to 4 shown) and "Done · N" (up to 10), newest first. */
export function SubagentList({ subagents, onSelect, now = Date.now() }: { subagents: ChatSubagent[]; onSelect: (id: string) => void; now?: number }) {
  const active = subagents.filter(subagentActive);
  const done = subagents.filter((run) => !subagentActive(run));
  return <div className="cx-sa-panel">
    <div className="cx-sa-panel-inner">
      <SubagentSection title={`Active · ${active.length}`} runs={active} empty="No active subagents" limit={4} now={now} onSelect={onSelect} />
      <SubagentSection title={`Done · ${done.length}`} runs={done} limit={10} now={now} onSelect={onSelect} className="is-done" />
    </div>
  </div>;
}

/** A subagent's page header: back, its avatar, its job, and "model · effort" on the right. */
export function SubagentHeader({ run, onBack, trailing }: { run: ChatSubagent; onBack: () => void; trailing?: ReactNode }) {
  const modelLine = subagentModelLine(run);
  return <header className="cx-sa-head">
    <button type="button" className="cx-sa-back" aria-label="Back to subagents" title="Back to subagents" onClick={onBack}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    <SubagentAvatar seed={run.subagent_id} />
    <span className="cx-sa-head-label" title={run.task}>{subagentJob(run)}</span>
    {modelLine ? <span className="cx-sa-head-model" title={run.model}>{modelLine}</span> : null}
    {trailing}
  </header>;
}

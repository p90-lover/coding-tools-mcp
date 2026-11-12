import { useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { subagentActive, type ChatSubagent } from "./ao-chat";
import { SubagentAvatar } from "./chat-subagents";

/*
 * The chat details popover, laid out as Codex's pinned summary (OpenAI.Codex 26.1016,
 * thread-summary-panel-components): sections split by hairlines, 16 px above and below and 20 px
 * at the sides; each row an 18 px icon, its label and, on the right, its meta in the tertiary colour
 * ("Changes  +12 −3", "PR #42  Open", four subagent avatars then "2 done"); and lists that show
 * five, then "View all".
 */

/** One section of the summary; a heading only when it has one, with an action at its end. */
export function SummarySection({ title, action, className, children }: { title?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`cx-sum-section${className ? ` ${className}` : ""}`}>
    {title ? <h3 className="cx-sum-heading"><span>{title}</span>{action}</h3> : null}
    {children}
  </section>;
}

type RowProps = {
  icon: ReactNode; label: ReactNode; meta?: ReactNode; title?: string; className?: string;
  /** A web address opens in the browser; otherwise a click runs onClick; with neither the row is static. */
  href?: string; onClick?: () => void; disabled?: boolean;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  "aria-haspopup"?: "menu";
};

/** A summary row: its icon, its label (one ellipsised line) and its meta on the right. */
export function SummaryRow({ icon, label, meta, title, className, href, onClick, disabled, onContextMenu, onKeyDown, ...aria }: RowProps) {
  const body = <>
    <span className="cx-sum-icon" aria-hidden="true">{icon}</span>
    <span className="cx-sum-label">{label}</span>
    {meta === undefined || meta === null || meta === false ? null : <span className="cx-sum-meta">{meta}</span>}
  </>;
  const classes = `cx-sum-row${className ? ` ${className}` : ""}`;
  if (href) return <a className={classes} href={href} target="_blank" rel="noreferrer noopener" title={title}>{body}</a>;
  if (!onClick) return <div className={`${classes} is-static`} title={title}>{body}</div>;
  return <button type="button" className={classes} title={title} disabled={disabled} onClick={onClick}
    onContextMenu={onContextMenu} onKeyDown={onKeyDown} aria-haspopup={aria["aria-haspopup"]}>{body}</button>;
}

/** A section's list: its first `limit` rows, then "View all" for the rest and "Show less" back. */
export function SummaryList<T>({ items, render, limit = 5, empty }: { items: T[]; render: (item: T) => ReactNode; limit?: number; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return empty ? <p className="cx-sum-empty">{empty}</p> : null;
  return <>
    <div className="cx-sum-list">{(all ? items : items.slice(0, limit)).map(render)}</div>
    {items.length > limit ? <button type="button" className="cx-sum-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
      {all ? "Show less" : "View all"}</button> : null}
  </>;
}

/** Up to four subagents' avatars, overlapping, as Codex's Subagents row shows them (working ones first). */
export function SubagentStack({ subagents }: { subagents: ChatSubagent[] }) {
  return <span className="cx-sum-stack">
    {subagents.slice(0, 4).map((run) => <SubagentAvatar key={run.subagent_id} seed={run.subagent_id} size={16} />)}
  </span>;
}

/** The Subagents row's meta, in Codex's words: "2 working" while any works, else "3 done". */
export function subagentsMeta(subagents: ChatSubagent[]): string {
  const working = subagents.filter(subagentActive).length;
  return working ? `${working} working` : `${subagents.length} done`;
}

export type ChatPullRequest = { number: number; url: string; title: string; state: "open" | "draft" | "merged" | "closed" };
const PULL_REQUEST_STATES: Record<ChatPullRequest["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
export const pullRequestState = (state: string) => PULL_REQUEST_STATES[state as ChatPullRequest["state"]] ?? "Open";

/** The pull request glyph: two commits joined, the branch's arrow coming back to the base. */
export function PullRequestGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7" /><path d="M8.5 3 7 4.5 8.5 6" />
    </g>
  </svg>;
}

/** The Changes row's meta: "+12 −3" in Codex's green and red, the files when only new files changed, or "None". */
export function ChangesMeta({ changes }: { changes: { additions: number; deletions: number; files: number } | null }) {
  if (!changes) return <span className="cx-sum-pending">…</span>;
  if (changes.additions || changes.deletions) {
    return <span className="cx-sum-diff"><span className="is-add">+{changes.additions}</span><span className="is-del">−{changes.deletions}</span></span>;
  }
  return <>{changes.files ? `${changes.files} ${changes.files === 1 ? "file" : "files"}` : "None"}</>;
}

import { useEffect, useState } from "react";
import { ModelLogo } from "./HarnessLogo";
import { dshDuration, type ChatLiveItem, type ChatStep, type ChatTurn } from "./ao-chat";

/**
 * The head of a reply: what a turn came to, read before any of its work. Who answered (a single
 * chat's model, or the team and every card on it), how it stands and for how long, why it failed,
 * and which files it changed. Each of these sat somewhere else, in grey 12px text: the model's name
 * above the answer, the time at the foot, the error between tool rows, the files only as one
 * "Edited x.js +1 −1" row per edit, and a team's cards only once its work was opened.
 */

export type ReplyTone = "working" | "stalled" | "waiting" | "queued" | "done" | "failed" | "stopped";
export type ReplyMember = { key: string; name: string; model?: string; modelName?: string; tone: ReplyTone; state: string };
export type ChangedFile = { path: string; additions: number; deletions: number };

const TONE_LABEL: Record<ReplyTone, string> = {
  working: "Working", stalled: "May be stuck", waiting: "Needs you", queued: "Starting", done: "Done", failed: "Failed", stopped: "Stopped",
};

/** How one card stands, in the head's words. */
export function cardTone(step: ChatStep): ReplyTone {
  if (step.error) return "failed";
  if (step.working) return step.working.stalled ? "stalled" : "working";
  if (step.state === "finished") return "done";
  if (step.state === "cancelled") return "stopped";
  return "queued";
}

/**
 * How a whole turn stands: live work first (a stuck card is the turn's news), then a failure, then
 * how the run ended. A turn that failed and was answered anyway by a retry has no card left in error.
 */
export function replyTone(turn: ChatTurn, live: boolean): ReplyTone {
  const cards = [...turn.steps, ...(turn.final ? [turn.final] : [])];
  if (live) return cards.some((step) => step.working?.stalled) ? "stalled" : turn.status === "queued" && !cards.some((step) => step.working) ? "queued" : "working";
  if (cards.some((step) => step.error)) return "failed";
  if (turn.status === "stopped") return "stopped";
  if (turn.status === "attention" || turn.status === "paused") return "waiting";
  return turn.status === "done" ? "done" : "queued";
}

/** The files a turn's edits touched, each once with its lines added and removed summed, in the order first touched. */
export function turnChanges(items: ChatLiveItem[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const item of items) {
    if (item.kind !== "edit") continue;
    for (const file of item.files ?? []) {
      const known = byPath.get(file.path);
      if (known) { known.additions += file.additions; known.deletions += file.deletions; }
      else byPath.set(file.path, { path: file.path, additions: file.additions, deletions: file.deletions });
    }
  }
  return orderChanges([...byPath.values()]);
}

// Files nobody reads in a diff: lockfiles, build output, snapshots. They go last, whatever their size.
const NOISE_FILE = /(^|[\\/])(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|[^\\/]+\.snap|[^\\/]+\.min\.(js|css))$|(^|[\\/])(dist|build|out|node_modules)[\\/]/i;
/**
 * Which changed files the head lists first: it shows CHANGES_SHOWN of them, the rest behind "N more".
 * The biggest changes lead (most lines added and removed), ties keep the order first touched, and
 * lockfiles and build output sink to the end: a 900-line package-lock.json took the first slot.
 */
export function orderChanges(files: ChangedFile[]): ChangedFile[] {
  const rank = (file: ChangedFile) => (NOISE_FILE.test(file.path) ? 1 : 0);
  return files.map((file, index) => ({ file, index }))
    .sort((a, b) => rank(a.file) - rank(b.file) || (b.file.additions + b.file.deletions) - (a.file.additions + a.file.deletions) || a.index - b.index)
    .map(({ file }) => file);
}

const CHANGES_SHOWN = 4;
const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** A 1-second clock for the head's time only, so the turn under it never re-renders on a tick. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

function Diff({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="cx-reply-diff"><span className="is-add">+{additions}</span> <span className="is-del">−{deletions}</span></span>;
}

export type ReplyHeadProps = {
  team: boolean;
  /** A single chat's model as the picker names it; a team's head says "Team". */
  name: string;
  model?: string;
  tone: ReplyTone;
  startedAtMs?: number;
  endedAtMs?: number;
  verdict?: string;
  /** The answering card's attempt, from 2 when it was retried ("Attempt 3"). */
  attempt?: number;
  /** The failing card's error, unless the chat's failed-step card below already shows it. */
  error?: { step: string; message: string };
  /** A team's cards, in pipeline order; empty for a single chat. */
  members: ReplyMember[];
  changes: ChangedFile[];
};

export function ReplyHead({ team, name, model, tone, startedAtMs, endedAtMs, verdict, attempt = 1, error, members, changes }: ReplyHeadProps) {
  const live = tone === "working" || tone === "stalled" || tone === "queued";
  const now = useNow(live);
  const end = live ? now : endedAtMs;
  const time = startedAtMs && end && end > startedAtMs ? dshDuration(end - startedAtMs) : "";
  const added = changes.reduce((sum, file) => sum + file.additions, 0);
  const removed = changes.reduce((sum, file) => sum + file.deletions, 0);
  const shown = changes.slice(0, CHANGES_SHOWN);
  const rest = changes.slice(CHANGES_SHOWN);
  return <header className="cx-reply-head">
    <div className="cx-reply-top">
      <span className="cx-reply-who" title={team ? `${members.length} ${members.length === 1 ? "card" : "cards"}` : name}>
        {!team && model ? <ModelLogo model={model} label={name} size={15} /> : null}
        <span className="cx-reply-who-name">{name}</span>
      </span>
      {team ? <span className="cx-reply-mode">Team · {members.length}</span> : null}
      <span className={`cx-reply-status is-${tone}`} role={live ? "status" : undefined}>{TONE_LABEL[tone]}</span>
      {time ? <span className="cx-reply-time" title={startedAtMs ? `Started ${new Date(startedAtMs).toLocaleString()}` : undefined}>{time}</span> : null}
      {attempt > 1 ? <span className="cx-reply-attempt" title={`${attempt - 1} earlier ${attempt === 2 ? "attempt" : "attempts"} folded under the work`}>Attempt {attempt}</span> : null}
      {verdict ? <span className={`cx-verdict is-${verdict.toLowerCase()}`}>{verdict}</span> : null}
      <span className="cx-reply-spacer" />
      {changes.length ? <span className="cx-reply-total" title={changes.map((file) => file.path).join("\n")}>
        {changes.length === 1 ? "1 file" : `${changes.length} files`} <Diff additions={added} deletions={removed} />
      </span> : null}
    </div>
    {error ? <p className="cx-reply-error" role="alert">
      <span className="cx-reply-error-title">{team ? `${error.step} failed` : "Failed"}</span>
      <span className="cx-reply-error-text">{error.message}</span>
    </p> : null}
    {members.length ? <ul className="cx-reply-roster" aria-label="Team">
      {members.map((member) => <li key={member.key} className={`cx-reply-member is-${member.tone}`} title={member.model || undefined}>
        <span className="cx-reply-dot" aria-hidden="true" />
        <span className="cx-reply-member-name">{member.name}</span>
        {member.modelName && member.modelName !== member.name ? <span className="cx-reply-member-model">{member.modelName}</span> : null}
        <span className="cx-reply-member-state">{member.state}</span>
      </li>)}
    </ul> : null}
    {changes.length ? <ul className="cx-reply-files" aria-label="Changed files">
      {shown.map((file) => <li key={file.path} className="cx-reply-file" title={file.path}>
        <span className="cx-reply-file-name">{baseName(file.path)}</span><Diff additions={file.additions} deletions={file.deletions} />
      </li>)}
      {rest.length ? <li className="cx-reply-file is-more" title={rest.map((file) => file.path).join("\n")}>{rest.length} more</li> : null}
    </ul> : null}
  </header>;
}

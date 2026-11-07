import { useEffect, useState, type ReactNode } from "react";
import { ModelLogo } from "./HarnessLogo";
import { ChatChangedFiles } from "./ChatChangedFiles";
import { useTurnRequests } from "./ChatTurnStats";
import { dshDuration, type ChatLiveItem, type ChatStep, type ChatTurn } from "./ao-chat";

/**
 * A reply's summary: what a turn came to, under the answer, where the reading ends.
 * A single chat closes as Codex closes a reply: one quiet grey line, its model, how long it worked
 * and the files it changed, beside the answer's copy and retry. Its status is said only when it is
 * news (failed, stopped, needs you): a green "Done" pill on every reply was noise, and the turn's
 * model requests (steps, LLM time, tokens, cache) are the time's tooltip, not a second row.
 * A team keeps its roster of cards above that line. Only a failure (ReplyError) leads the reply.
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
 * Which changed files the hover lists first.
 * The biggest changes lead (most lines added and removed), ties keep the order first touched, and
 * lockfiles and build output sink to the end: a 900-line package-lock.json took the first slot.
 */
export function orderChanges(files: ChangedFile[]): ChangedFile[] {
  const rank = (file: ChangedFile) => (NOISE_FILE.test(file.path) ? 1 : 0);
  return files.map((file, index) => ({ file, index }))
    .sort((a, b) => rank(a.file) - rank(b.file) || (b.file.additions + b.file.deletions) - (a.file.additions + a.file.deletions) || a.index - b.index)
    .map(({ file }) => file);
}

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
  /** A team's cards, in pipeline order; empty for a single chat. */
  members: ReplyMember[];
  changes: ChangedFile[];
  onOpenChanges?: (path?: string) => void;
  /** The ended turn's CPA models, read for the time's tooltip (useTurnRequests). */
  requestModels?: string[];
  /** The answer's copy and retry, at the line's end. */
  actions?: ReactNode;
};

/** Why a turn failed, at the top of its reply: the one part of the summary read before the work. */
export function ReplyError({ team, error }: { team: boolean; error: { step: string; message: string } }) {
  return <p className="cx-reply-error" role="alert">
    <span className="cx-reply-error-title">{team ? `${error.step} failed` : "Failed"}</span>
    <span className="cx-reply-error-text">{error.message}</span>
  </p>;
}

export function ReplyHead({ team, name, model, tone, startedAtMs, endedAtMs, verdict, attempt = 1, members, changes, onOpenChanges, requestModels, actions }: ReplyHeadProps) {
  const live = tone === "working" || tone === "stalled" || tone === "queued";
  const now = useNow(live);
  const requests = useTurnRequests({ from: startedAtMs, to: live ? undefined : endedAtMs, models: requestModels });
  // A turn saved without its end time ends at its last model request, when the next turn bounds it.
  const end = live ? now : endedAtMs && endedAtMs > (startedAtMs ?? 0) ? endedAtMs : requests.lastAt;
  const time = startedAtMs && end && end > startedAtMs ? dshDuration(end - startedAtMs) : "";
  const timeTitle = [startedAtMs ? `Started ${new Date(startedAtMs).toLocaleString()}` : "", requests.summary].filter(Boolean).join("\n") || undefined;
  // "Done" is what a reply under an answer already says; any other state is news.
  const status = tone === "done" && !team ? null : tone;
  // A single chat's running turn says who works and for how long on its running line (TurnRunning);
  // here it keeps only the files changed so far, and nothing at all before the first edit.
  if (live && !team) return changes.length ? <footer className="cx-reply-head is-quiet">
    <div className="cx-reply-top"><ChatChangedFiles files={changes} onOpen={onOpenChanges} /></div>
  </footer> : null;
  return <footer ref={requests.ref} className={`cx-reply-head${team ? "" : " is-quiet"}`}>
    {members.length ? <ul className="cx-reply-roster" aria-label="Team">
      {members.map((member) => <li key={member.key} className={`cx-reply-member is-${member.tone}`} title={member.model || undefined}>
        <span className="cx-reply-dot" aria-hidden="true" />
        <span className="cx-reply-member-name">{member.name}</span>
        {member.modelName && member.modelName !== member.name ? <span className="cx-reply-member-model">{member.modelName}</span> : null}
        <span className="cx-reply-member-state">{member.state}</span>
      </li>)}
    </ul> : null}
    <div className="cx-reply-top">
      <span className="cx-reply-who" title={team ? `${members.length} ${members.length === 1 ? "card" : "cards"}` : model || name}>
        {team && model ? <ModelLogo model={model} label={name} size={15} /> : null}
        <span className="cx-reply-who-name">{name}</span>
      </span>
      {team ? <span className="cx-reply-mode">Team · {members.length}</span> : null}
      {status ? <span className={`cx-reply-status is-${status}`} role={live ? "status" : undefined}>{TONE_LABEL[status]}</span> : null}
      {time ? <span className="cx-reply-time" title={timeTitle}>{time}</span> : null}
      <ChatChangedFiles files={changes} onOpen={onOpenChanges} />
      {attempt > 1 ? <span className="cx-reply-attempt" title={`${attempt - 1} earlier ${attempt === 2 ? "attempt" : "attempts"} folded under the work`}>Attempt {attempt}</span> : null}
      {verdict ? <span className={`cx-verdict is-${verdict.toLowerCase()}`}>{verdict}</span> : null}
      {actions}
    </div>
  </footer>;
}

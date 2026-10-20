/**
 * A DeepSeek model's turn, laid out as DeepSeek Harness's web client lays one out
 * (deepseek-ai/deepseek-harness, packages/client/ui-chat and ui-tool; MIT License,
 * Copyright (c) 2026 DeepSeek). Its rows, groups, icons and words are ported as they are:
 * - every thought is its own "Think" row with its first line, opening on the whole thought;
 * - each tool call is a 24px row, "Bash · <what it does>", "Read · <path>", "Edit · <path> +3 -1";
 * - while the turn runs its rows stand flat, with "Deep diving for 1m 4s ···" under them;
 * - once it ends, "Completed in 1m 4s" heads it and folds its work, grouped as "Ran commands,
 *   read files" runs between the replies.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { AnsweredRecord, ApprovedMark, EditDiff, StreamingMarkdown } from "./ChatToolParts";
import {
  dshActivity, dshDuration, dshItemDetail, dshLiveTitle, dshProcessTitle, dshQuietNote, dshSegments, dshThinkSummary, dshToolTitle,
  tidyTimeline, type ChatLiveItem, type ChatStep, type ChatTurn, type DshActivity,
} from "./ao-chat";

// Icons: ui-primitives/src/icons, 1px strokes on a 16 box, drawn 14px inside a 16px leading box.
const glyph = (paths: ReactNode) => <svg width={14} height={14} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">{paths}</svg>;
const ICON = {
  think: glyph(<>
    <path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z" stroke="currentColor" />
    <path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z" stroke="currentColor" />
    <path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" fill="currentColor" />
  </>),
  api: glyph(<><path d="M3 4L7 8L3 12" stroke="currentColor" /><path d="M9 12H13" stroke="currentColor" /></>),
  browse: glyph(<>
    <path d="M4.9375 5.90295H11.0625" stroke="currentColor" /><path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z" fill="currentColor" />
  </>),
  edit: glyph(<>
    <path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" />
    <path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" />
  </>),
  search: glyph(<>
    <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor" />
    <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
  </>),
  code: glyph(<>
    <path d="M6.27612 1.5L4.52612 14.5" stroke="currentColor" /><path d="M11.4739 1.5L9.72388 14.5" stroke="currentColor" />
    <path d="M2.39868 5.5H14.0681" stroke="currentColor" /><path d="M1.93188 10.5H13.6013" stroke="currentColor" />
  </>),
  sparkle: glyph(<>
    <path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z" stroke="currentColor" />
    <path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z" stroke="currentColor" />
    <path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z" stroke="currentColor" />
  </>),
  down: glyph(<path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" />),
  up: glyph(<path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor" />),
};
const ACTIVITY_ICON: Record<DshActivity | "thinking", ReactNode> = {
  thinking: ICON.think, read: ICON.browse, readImage: ICON.browse, search: ICON.search, edit: ICON.edit, write: ICON.edit,
  commands: ICON.api, code: ICON.code, webSearch: ICON.search, webFetch: ICON.browse, subagents: ICON.sparkle,
  plan: ICON.sparkle, questions: ICON.sparkle, tools: ICON.sparkle,
};
/** The whale's tail at rest (RunningWhaleTail.tsx); the animated tail is a CSS mask over it. */
const WHALE = "M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742";

/** Reads a card's work (the chat's own cache and loader), only once the row showing it is open. */
export type UseStepWork = (step: ChatStep, wanted: boolean) => ChatLiveItem[] | null;
type Tone = "ok" | "running" | "error" | "stopped";

function toneOf(status: string): Tone {
  if (/cancel|interrupt|abort/i.test(status)) return "stopped";
  if (/fail|error|reject|denied/i.test(status)) return "error";
  return /complet|done|success/i.test(status) ? "ok" : "running";
}

/** A 1-second clock for the running label only, so the transcript around it never re-renders. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * DisclosureRow: [16px leading] 6 [title 13/24] 8 [2px dot] 8 [summary], tertiary text that turns
 * secondary on hover; hovering a row that opens swaps its icon for a chevron, and an open row
 * keeps the up chevron.
 */
function DshRow({ icon, title, summary, suffix, running, tone = "ok", open, expandable, onToggle, children, className }: {
  icon: ReactNode; title: string; summary?: string; suffix?: ReactNode; running?: boolean; tone?: Tone;
  open: boolean; expandable: boolean; onToggle: () => void; children?: ReactNode; className?: string;
}) {
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onToggle();
  };
  return <div className={`dsh-row-root${className ? ` ${className}` : ""}`} data-state={tone} data-open={open || undefined}>
    <div className="dsh-row" data-expandable={expandable || undefined} role={expandable ? "button" : undefined} tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? open : undefined} onClick={expandable ? onToggle : undefined} onKeyDown={key}>
      <span className="dsh-leading">
        {open ? ICON.up : expandable ? <><span className="dsh-icon-idle">{icon}</span><span className="dsh-chevron-hover">{ICON.down}</span></> : icon}
      </span>
      <span className={`dsh-row-text${running ? " dsh-shimmer" : ""}`}>
        <span className="dsh-title">{title}</span>
        {summary ? <><span className="dsh-sep" aria-hidden="true" />
          <span className={`dsh-summary${tone === "error" ? " is-error" : tone === "stopped" ? " is-stopped" : ""}`}>{summary}</span></> : null}
        {suffix}
      </span>
    </div>
    {open ? children : null}
  </div>;
}

/** ReasoningRow: "Think · <first line>", opening on the whole thought in secondary type. */
function DshThink({ item }: { item: ChatLiveItem }) {
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  const summary = open ? "" : dshThinkSummary(item.text, running);
  return <DshRow className="dsh-think" icon={ICON.think} title="Think" summary={summary} running={running}
    open={open} expandable={Boolean(item.text.trim())} onToggle={() => setOpen(!open)}>
    <div className="dsh-think-body"><ChatMarkdown text={item.text} /></div>
  </DshRow>;
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/**
 * ToolRow: its title ("Bash", "Read", "Edit", "Search", "Tool call") and one line, opening on a
 * terminal card for a command, the changed lines for an edit, or an IN/OUT card for anything else.
 * A failed call's line is its first error line, in red.
 */
function DshTool({ item }: { item: ChatLiveItem }) {
  const [open, setOpen] = useState(false);
  const tone = toneOf(item.status);
  const activity = item.kind === "edit" ? "edit" : dshActivity(item);
  const title = item.kind === "edit" ? "Edit" : dshToolTitle(item);
  const failure = tone === "error" ? (item.output ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() : undefined;
  const summary = failure || dshItemDetail(item);
  const files = item.files ?? [];
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const settled = tone === "error" || tone === "stopped";
  const suffix = <>
    {!settled && files.length ? <span className="dsh-suffix dsh-diff-stat"><span className="is-add">+{added}</span> <span className="is-del">-{removed}</span></span> : null}
    <ApprovedMark text={item.approval} />
  </>;
  const expandable = item.kind === "command" || activity === "commands" || Boolean(item.input || item.output) || files.some((file) => file.diff);
  return <DshRow className="dsh-tool" icon={ACTIVITY_ICON[activity]} title={title} summary={summary} suffix={suffix}
    running={tone === "running"} tone={tone} open={open} expandable={expandable} onToggle={() => setOpen(!open)}>
    <div className="dsh-body">
      {item.kind === "command" || activity === "commands"
        ? <div className="dsh-terminal">
          <div className="dsh-terminal-cmd"><span aria-hidden="true">$ </span>{item.kind === "command" ? item.text : dshItemDetail(item)}</div>
          {item.output ? <pre className="dsh-terminal-out">{item.output}</pre> : null}
        </div>
        : files.some((file) => file.diff)
          ? files.map((file) => <div key={file.path} className="dsh-diff">
            {files.length > 1 ? <div className="dsh-diff-path">{file.path}</div> : null}
            {/* Numbered as Claude Code numbers a change; dsh's tint and bar come from its CSS. */}
            {file.diff ? <EditDiff diff={file.diff} /> : null}
          </div>)
          : <div className="dsh-io">
            {item.input ? <div className="dsh-io-section"><span className="dsh-io-label">IN</span><span className="dsh-io-text">{prettyJson(item.input)}</span></div> : null}
            {item.input && item.output ? <span className="dsh-io-divider" aria-hidden="true" /> : null}
            {item.output ? <div className="dsh-io-section"><span className="dsh-io-label">OUT</span>
              <span className="dsh-io-text" data-error={tone === "error" || undefined}>{item.output}</span></div> : null}
          </div>}
    </div>
  </DshRow>;
}

function DshItem({ item }: { item: ChatLiveItem }) {
  if (item.answered) return <AnsweredRecord question={item.answered.question} answer={item.answered.answer} />;
  if (item.kind === "reasoning") return <DshThink item={item} />;
  if (item.kind === "message") return <div className="dsh-reply"><StreamingMarkdown text={item.text} live={item.status === "running"} /></div>;
  if (item.kind === "steer") return <div className="cx-user cx-steer"><div className="cx-bubble"><p>{item.text}</p></div></div>;
  return <DshTool item={item} />;
}

/**
 * ChatGroupSeat: a run of thinking and tool calls under one heading, its kind of work's icon
 * turning into a chevron on hover. Open, it scrolls inside min(400px, 50vh) with faded edges.
 */
function DshGroup({ items, live }: { items: ChatLiveItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [edges, setEdges] = useState({ up: false, down: false });
  const body = useRef<HTMLDivElement>(null);
  const measure = () => {
    const box = body.current;
    if (box) setEdges({ up: box.scrollTop > 0, down: box.scrollTop + box.clientHeight < box.scrollHeight - 1 });
  };
  useEffect(() => { if (open) measure(); }, [open, items.length]);
  const now = live ? dshLiveTitle(items) : null;
  const activity = now?.activity ?? (items.find((item) => item.kind !== "reasoning") ? dshActivity(items.find((item) => item.kind !== "reasoning")!) : "thinking");
  const label = now?.label ?? dshProcessTitle(items);
  return <div className="dsh-group">
    <button type="button" className="dsh-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="dsh-group-leading" aria-hidden="true">
        <span className="dsh-group-icon">{ACTIVITY_ICON[activity]}</span>
        <span className="dsh-group-chevron">{open ? ICON.up : ICON.down}</span>
      </span>
      <span className={`dsh-group-label${live ? " dsh-shimmer" : ""}`}>{label}</span>
    </button>
    {open ? <div ref={body} className={`dsh-group-body${edges.up ? " fade-top" : ""}${edges.down ? " fade-bottom" : ""}`} onScroll={measure}>
      <div className="dsh-flow">{items.map((item) => <DshItem key={item.id} item={item} />)}</div>
    </div> : null}
  </div>;
}

/** A card's work: flat while it runs (DeepSeek Harness keeps a running turn flat), grouped once done. */
function DshFlow({ items, grouped, hideReply }: { items: ChatLiveItem[]; grouped: boolean; hideReply?: string }) {
  const answer = hideReply?.trim();
  const tidy = tidyTimeline(items).filter((item) => !(answer && item.kind === "message" && item.text.trim() === answer));
  if (!grouped) return <div className="dsh-flow">{tidy.map((item) => <DshItem key={item.id} item={item} />)}</div>;
  return <div className="dsh-flow">{dshSegments(tidy).map((segment) => segment.kind === "item"
    ? <DshItem key={segment.item.id} item={segment.item} />
    : <DshGroup key={segment.key} items={segment.items} live={false} />)}</div>;
}

function DshStepWork({ step, useWork, answer }: { step: ChatStep; useWork: UseStepWork; answer?: string }) {
  const work = useWork(step, true) ?? [];
  if (!work.length) return step.hasWork && !step.working ? <p className="dsh-hint">Loading…</p> : null;
  return <DshFlow items={work} grouped={!step.working} hideReply={answer} />;
}

/** A team card as one row: its name and what it is doing or how it ended, opening on its own work. */
function DshAgent({ step, useWork, answer }: { step: ChatStep; useWork: UseStepWork; answer?: string }) {
  const live = Boolean(step.working);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (live || Boolean(step.error));
  const work = useWork(step, open);
  const tone: Tone = step.error ? "error" : live ? "running" : step.state === "cancelled" ? "stopped" : "ok";
  const summary = live ? (step.working!.activity || dshLiveTitle(work ?? []).label)
    : step.error ? step.error.split(/\r?\n/)[0] : step.verdict || (step.state === "finished" ? "Completed" : step.state);
  return <DshRow className="dsh-agent" icon={ICON.sparkle} title={step.name} summary={summary} running={live} tone={tone}
    open={open} expandable={Boolean(step.hasWork || work?.length || step.text)} onToggle={() => setChosen(!open)}>
    <div className="dsh-agent-body">
      {work?.length ? <DshFlow items={work} grouped={!live} hideReply={answer} /> : null}
      {step.text && step.text.trim() !== answer?.trim() ? <div className="dsh-reply"><ChatMarkdown text={step.text} /></div> : null}
    </div>
  </DshRow>;
}

/** RunningStatus: a hairline over the whale's tail and "Deep diving for 1m 4s ···", in DeepSeek blue. */
function DshRunning({ since, divider, heardAt }: { since?: number; divider: boolean; heardAt?: number }) {
  const now = useNow(true);
  // A long turn can go quiet for many minutes (a slow model request): say how long, so a quiet turn
  // does not look frozen, and say plainly when it has been quiet as long as a stuck one.
  const quietNote = dshQuietNote(heardAt, now);
  return <div className="dsh-running" role="status" aria-live="polite">
    {divider ? <span className="dsh-running-divider" aria-hidden="true" /> : null}
    <span className="dsh-running-content">
      <span className="dsh-whale" aria-hidden="true">
        <span className="dsh-whale-animated" />
        <svg className="dsh-whale-still" width="100%" height="100%" viewBox="0 0 16 16" fill="none"><path d={WHALE} stroke="currentColor" strokeWidth={1} /></svg>
      </span>
      <span className="dsh-shimmer is-deep">{since ? `Deep diving for ${dshDuration(now - since)}${quietNote} ···` : `Deep diving${quietNote}`}</span>
    </span>
  </div>;
}

/**
 * When each turn the chat saw end ended: AO keeps when a card started, not when it finished, so a
 * turn that ended while the chat was open says "Completed in 1m 4s" and an older one "Completed"
 * (DeepSeek Harness's own word when it has no time).
 */
const ENDED = new Map<string, number>();
/** Turns this chat watched running, so only a turn seen ending gets an end time. */
const WATCHED = new Set<string>();

/** `errorShownBelow`: the chat's failed-step card shows this turn's error, so the turn leaves it out. */
export type DshTurnWorkProps = { turn: ChatTurn; live: boolean; expanded: boolean; useWork: UseStepWork; errorShownBelow?: boolean };

/**
 * A DeepSeek turn's work. Running: its rows flat, "Deep diving" under them. Ended: "Completed in
 * 1m 4s" heads it, folded unless the chat shows work details; a failed or stopped turn stays open.
 * The chat memoizes it with its own check of what a turn shows.
 */
export function DshTurnWork({ turn, live, expanded, useWork, errorShownBelow = false }: DshTurnWorkProps) {
  const steps = [...turn.steps, ...(turn.final ? [turn.final] : [])];
  const failed = steps.some((step) => step.error);
  const stopped = turn.status === "stopped";
  const [chosen, setChosen] = useState<boolean | null>(null);
  if (live) ENDED.delete(turn.key);
  else if (turn.startedAtMs && !ENDED.has(turn.key) && WATCHED.has(turn.key)) ENDED.set(turn.key, Date.now());
  if (live) WATCHED.add(turn.key);
  // The newest sign of life across the turn's working cards.
  const heardAt = Math.max(0, ...steps.map((step) => step.working?.heardAtMs ?? 0)) || undefined;
  if (!steps.length) return live ? <DshRunning since={turn.startedAtMs} divider={false} /> : null;
  const alwaysOpen = live || failed || stopped;
  const open = alwaysOpen || (chosen ?? expanded);
  const answer = turn.final?.text;
  const single = steps.length === 1;
  const work = single
    ? <DshStepWork step={steps[0]} useWork={useWork} answer={answer} />
    : steps.map((step) => <DshAgent key={step.key} step={step} useWork={useWork} answer={step === turn.final ? answer : undefined} />);
  const ended = ENDED.get(turn.key);
  const label = stopped ? "Stopped" : failed ? "Failed" : ended && turn.startedAtMs ? "Completed in " : "Completed";
  return <div className="dsh-turn-work">
    {!live ? <button type="button" className="dsh-turn-process" data-open={open || undefined} disabled={alwaysOpen}
      aria-expanded={open} onClick={() => setChosen(!open)}>
      <span className="dsh-turn-process-label">{label}{label === "Completed in " ? <span className="dsh-num">{dshDuration(ended! - turn.startedAtMs!)}</span> : null}</span>
      {alwaysOpen ? null : <span className="dsh-turn-process-chevron">{ICON.down}</span>}
    </button> : null}
    {open ? <div className="dsh-process">{work}</div> : null}
    {errorShownBelow ? null : steps.filter((step) => step.error).map((step) => <div key={`error:${step.key}`} className="dsh-turn-error">
      <span className="dsh-turn-error-title">This turn failed</span><span className="dsh-turn-error-message">{step.error}</span>
    </div>)}
    {live ? <DshRunning since={turn.startedAtMs} divider heardAt={heardAt} /> : null}
  </div>;
}
